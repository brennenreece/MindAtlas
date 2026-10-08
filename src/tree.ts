import { App, TFile } from "obsidian";

export interface MapNode {
  file: TFile;
  title: string;
  // Possibly shortened title shown on the map (set by the view).
  label: string;
  children: MapNode[];
  // +1 = outgoing side (right), -1 = backlink side (left), 0 = root.
  side: 1 | -1 | 0;
  // Generations from the root (root = 0); drives heading level in the map.
  depth: number;
  // Children exist but were not expanded because of the depth limit.
  truncated: boolean;
  // Center position and size; w/h are measured by the view from the text.
  x: number;
  y: number;
  w: number;
  h: number;
  // Height reserved above the box for the icon (included in h).
  iconH: number;
  // Floating connected note: placed beside this note until moved by hand.
  anchor?: MapNode;
  floating?: boolean;
  // Position from the automatic layout, and the goal position after manual offsets.
  bx: number;
  by: number;
  gx: number;
  gy: number;
  // Index of the top-level branch (outgoing side) this note belongs to; -1 otherwise.
  branch: number;
  // Children are hidden by the user; `hidden` counts the linked notes not shown.
  collapsed: boolean;
  hidden: number;
  // From frontmatter (mindmap-color / mindmap-icon / mindmap-status), color is inherited.
  color?: string;
  icon?: string;
  // Name of a Feather/Lucide icon shown as a badge on the node.
  iconName?: string;
}

export interface Edge {
  from: MapNode;
  to: MapNode;
  // Actual link directions: `fwd` = from links to `to`; `back` = `to` links to from.
  fwd: boolean;
  back: boolean;
}

export interface MapGraph {
  root: MapNode;
  nodes: MapNode[];
  treeEdges: Edge[];
  crossLinks: Edge[];
}

export interface GraphOptions {
  depth: number;
  backlinks: boolean;
  // Notes shown even though nothing links to them yet (newly added, unconnected).
  extras?: TFile[];
  // Paths whose children are hidden.
  collapsed?: Set<string>;
  maxNodes?: number;
  // Also show notes that visible notes connect to (not as children).
  connections?: boolean;
}

const CHILDREN_HEADING = /^#{1,6}\s+children\s*$/i;
const ANY_HEADING = /^#{1,6}\s+\S/;
const WIKILINK = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Links under a "## Children" heading, or null when the note has no such section. */
export function parseChildLinks(content: string): string[] | null {
  const out: string[] = [];
  let found = false;
  let inSection = false;
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (CHILDREN_HEADING.test(line)) {
      inSection = true;
      found = true;
      continue;
    }
    if (inSection && ANY_HEADING.test(line)) break;
    if (!inSection) continue;
    for (const m of line.matchAll(WIKILINK)) out.push(m[1].trim());
  }
  return found ? out : null;
}

function isIgnored(app: App, f: TFile): boolean {
  return app.metadataCache.getFileCache(f)?.frontmatter?.["mindmap-ignore"] === true;
}

function usable(app: App, f: TFile | null, self: TFile): f is TFile {
  return !!f && f.extension === "md" && f.path !== self.path && !isIgnored(app, f);
}

function resolveAll(app: App, file: TFile, raw: string[]): TFile[] {
  const seen = new Set<string>();
  const out: TFile[] = [];
  for (const r of raw) {
    const dest = app.metadataCache.getFirstLinkpathDest(r.trim(), file.path);
    if (!usable(app, dest, file) || seen.has(dest.path)) continue;
    seen.add(dest.path);
    out.push(dest);
  }
  return out;
}

/** Every note this one links to: "## Children" links first, then the rest in document order. */
async function outLinks(app: App, file: TFile): Promise<TFile[]> {
  const cache = app.metadataCache.getFileCache(file);
  const content = await app.vault.cachedRead(file);
  return resolveAll(app, file, [
    ...(parseChildLinks(content) ?? []),
    ...(cache?.links ?? []).map((l) => l.link.split("#")[0].split("^")[0]),
  ]);
}

/**
 * The note's children in the tree. A note with a "## Children" section has exactly
 * those children (in that order); its other links are only references, drawn as
 * cross-links. A note without one treats all of its links as children.
 */
async function childLinks(app: App, file: TFile): Promise<TFile[]> {
  const section = parseChildLinks(await app.vault.cachedRead(file));
  return section ? resolveAll(app, file, section) : outLinks(app, file);
}

function buildIncomingIndex(app: App): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  const resolved = app.metadataCache.resolvedLinks;
  for (const src of Object.keys(resolved)) {
    for (const dest of Object.keys(resolved[src])) {
      if (!idx.has(dest)) idx.set(dest, []);
      idx.get(dest)!.push(src);
    }
  }
  return idx;
}

export async function buildGraph(
  app: App,
  rootFile: TFile,
  opts: GraphOptions
): Promise<MapGraph> {
  const MAX_NODES = opts.maxNodes ?? 400;
  const collapsed = opts.collapsed ?? new Set<string>();
  const makeNode = (
    file: TFile,
    side: 1 | -1 | 0,
    depth: number,
    parent?: MapNode,
    branch = -1
  ): MapNode => {
    const meta = readMeta(app, file);
    return {
      file,
      title: file.basename,
      label: file.basename,
      children: [],
      side,
      depth,
      truncated: false,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      iconH: 0,
      bx: 0,
      by: 0,
      gx: 0,
      gy: 0,
      branch,
      collapsed: side !== 0 && collapsed.has(file.path),
      hidden: 0,
      color: meta.color ?? parent?.color,
      icon: meta.icon,
      iconName: meta.iconName,
    };
  };

  const root = makeNode(rootFile, 0, 0);
  const visited = new Map<string, MapNode>([[rootFile.path, root]]);
  const treeEdges: Edge[] = [];

  // Outgoing links, breadth-first; each note is placed once, nearest the root.
  let frontier: MapNode[] = [root];
  for (let d = 0; d < opts.depth && frontier.length; d++) {
    const next: MapNode[] = [];
    for (const n of frontier) {
      if (n.collapsed) continue;
      for (const f of await childLinks(app, n.file)) {
        if (visited.has(f.path) || visited.size >= MAX_NODES) continue;
        const c = makeNode(f, 1, d + 1, n, n === root ? root.children.length : n.branch);
        visited.set(f.path, c);
        n.children.push(c);
        treeEdges.push({ from: n, to: c, fwd: false, back: false });
        next.push(c);
      }
    }
    frontier = next;
  }

  // Backlinks, mirrored on the left.
  const backRoots: MapNode[] = [];
  if (opts.backlinks) {
    const incoming = buildIncomingIndex(app);
    const sources = (f: TFile): TFile[] =>
      (incoming.get(f.path) ?? [])
        .map((p) => app.vault.getAbstractFileByPath(p))
        .filter((x): x is TFile => x instanceof TFile && usable(app, x, f))
        .sort((a, b) => a.basename.localeCompare(b.basename));

    let front: MapNode[] = [root];
    for (let d = 0; d < opts.depth && front.length; d++) {
      const next: MapNode[] = [];
      for (const n of front) {
        if (n.collapsed) continue;
        for (const f of sources(n.file)) {
          if (visited.has(f.path) || visited.size >= MAX_NODES) continue;
          const c = makeNode(f, -1, d + 1, n);
          visited.set(f.path, c);
          (n === root ? backRoots : n.children).push(c);
          treeEdges.push({ from: n, to: c, fwd: false, back: false });
          next.push(c);
        }
      }
      front = next;
    }
  }

  // Floating notes that are not (yet) reachable from the root.
  for (const f of opts.extras ?? []) {
    if (!visited.has(f.path)) visited.set(f.path, makeNode(f, 1, 1));
  }

  // Linked notes that aren't children of anything float free: no tree edge, just a dashed line.
  if (opts.connections) {
    const incoming = buildIncomingIndex(app);
    for (const n of [...visited.values()]) {
      const kids = new Set((await childLinks(app, n.file)).map((f) => f.path));
      const around = [
        ...(await outLinks(app, n.file)),
        ...(incoming.get(n.file.path) ?? [])
          .map((p) => app.vault.getAbstractFileByPath(p))
          .filter((x): x is TFile => x instanceof TFile && usable(app, x, n.file)),
      ];
      for (const f of around) {
        if (kids.has(f.path) || visited.has(f.path) || visited.size >= MAX_NODES) continue;
        const c = makeNode(f, n.side === -1 ? -1 : 1, n.depth + 1);
        c.anchor = n;
        c.floating = true;
        visited.set(f.path, c);
      }
    }
  }

  // Truncation hints for nodes at the depth limit.
  const incomingIdx = opts.backlinks ? buildIncomingIndex(app) : null;
  for (const n of visited.values()) {
    if (n === root || n.children.length) continue;
    if (n.side === 1) {
      n.hidden = (await childLinks(app, n.file)).filter((f) => !visited.has(f.path)).length;
    } else if (incomingIdx) {
      n.hidden = new Set(
        (incomingIdx.get(n.file.path) ?? []).filter((p) => !visited.has(p) && p !== n.file.path)
      ).size;
    }
    n.truncated = n.hidden > 0 && !n.collapsed;
  }

  // Real link directions, so lines can show arrows (both ways when mutual).
  const linked = (a: MapNode, b: MapNode) =>
    (app.metadataCache.resolvedLinks[a.file.path]?.[b.file.path] ?? 0) > 0;
  const pairKey = (a: MapNode, b: MapNode) =>
    a.file.path < b.file.path ? `${a.file.path}\n${b.file.path}` : `${b.file.path}\n${a.file.path}`;
  const drawn = new Set<string>();
  for (const e of treeEdges) {
    e.fwd = linked(e.from, e.to);
    e.back = linked(e.to, e.from);
    drawn.add(pairKey(e.from, e.to));
  }

  // Every other connected pair of visible notes gets one cross-link line.
  const crossLinks: Edge[] = [];
  for (const n of visited.values()) {
    for (const f of await outLinks(app, n.file)) {
      const target = visited.get(f.path);
      if (!target) continue;
      const key = pairKey(n, target);
      if (drawn.has(key)) continue;
      drawn.add(key);
      crossLinks.push({ from: n, to: target, fwd: true, back: linked(target, n) });
    }
  }

  void backRoots;
  return { root, nodes: [...visited.values()], treeEdges, crossLinks };
}

const COLOR_NAMES = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|hsl)a?\([^)]*\))$/i;

/** Per-note presentation hints from frontmatter. */
function readMeta(app: App, f: TFile): { color?: string; icon?: string; iconName?: string } {
  const fm = app.metadataCache.getFileCache(f)?.frontmatter;
  if (!fm) return {};
  const out: ReturnType<typeof readMeta> = {};
  const c = fm["mindmap-color"];
  if (typeof c === "string" && COLOR_NAMES.test(c.trim())) out.color = c.trim();
  const i = fm["mindmap-icon"];
  if (typeof i === "string" && i.trim()) {
    const v = i.trim();
    // A plain word is an icon name; anything else (an emoji) is shown as a text prefix.
    if (/^[a-z][a-z0-9-]*$/.test(v)) out.iconName = v;
    else out.icon = Array.from(v).slice(0, 3).join("");
  }
  // Older maps stored a status; show it as an icon.
  const st = fm["mindmap-status"];
  if (!out.iconName && !out.icon) {
    if (st === "todo") out.iconName = "square";
    else if (st === "doing") out.iconName = "circle-dot";
    else if (st === "done") out.iconName = "check-square";
  }
  return out;
}
