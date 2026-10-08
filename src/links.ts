import { App, normalizePath, TFile } from "obsidian";

const CHILDREN_HEADING = /^#{1,6}\s+children\s*$/i;
const PARENTS_HEADING = /^#{1,6}\s+parents\s*$/i;
const CONNECTIONS_HEADING = /^#{1,6}\s+connections\s*$/i;
const ANY_HEADING = /^#{1,6}\s+\S/;
const WIKILINK = /(!?)\[\[([^\]\n|#^]+)(?:[#^][^\]\n|]*)?(?:\|([^\]\n]*))?\]\]/g;
const MDLINK = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;

interface FoundLink {
  start: number;
  end: number;
  dest: TFile;
  display: string;
}

/** Character ranges inside fenced code blocks, which are ignored for links. */
function fencedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  let pos = 0;
  let open = -1;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (open < 0) open = pos;
      else {
        out.push([open, pos + line.length]);
        open = -1;
      }
    }
    pos += line.length + 1;
  }
  if (open >= 0) out.push([open, text.length]);
  return out;
}

/** Every wiki or markdown link in `text` that resolves to a note. */
function findLinks(app: App, text: string, source: TFile): FoundLink[] {
  const fences = fencedRanges(text);
  const inFence = (i: number) => fences.some(([a, b]) => i >= a && i <= b);
  const out: FoundLink[] = [];

  for (const m of text.matchAll(WIKILINK)) {
    const start = m.index ?? 0;
    if (m[1] || inFence(start)) continue;
    const dest = app.metadataCache.getFirstLinkpathDest(m[2].trim(), source.path);
    if (dest) {
      out.push({ start, end: start + m[0].length, dest, display: (m[3] ?? m[2]).trim() });
    }
  }
  for (const m of text.matchAll(MDLINK)) {
    const start = m.index ?? 0;
    if (m[1] || inFence(start)) continue;
    let target = m[3].trim().replace(/^<|>$/g, "").split("#")[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      /* keep as-is */
    }
    const dest = app.metadataCache.getFirstLinkpathDest(target, source.path);
    if (dest) out.push({ start, end: start + m[0].length, dest, display: m[2] });
  }
  return out;
}

export function sanitizeTitle(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
}

/** Create an empty note next to `near`, picking a free file name. */
export async function createNote(app: App, title: string, near: TFile): Promise<TFile> {
  const clean = sanitizeTitle(title);
  if (!clean) throw new Error("Empty note title");
  const folder = app.fileManager.getNewFileParent(near.path);
  const base = folder.isRoot() ? "" : folder.path + "/";
  let path = normalizePath(`${base}${clean}.md`);
  for (let i = 2; app.vault.getAbstractFileByPath(path); i++) {
    path = normalizePath(`${base}${clean} ${i}.md`);
  }
  return app.vault.create(path, "");
}

/** Character range of the body of the "## Children" section, or null if there is none. */
function childrenRange(text: string): [number, number] | null {
  let pos = 0;
  let fenced = false;
  let start = -1;
  for (const line of text.split("\n")) {
    const next = pos + line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced) {
      if (start < 0 && CHILDREN_HEADING.test(line)) start = next;
      else if (start >= 0 && ANY_HEADING.test(line)) return [start, pos];
    }
    pos = next;
  }
  return start >= 0 ? [start, text.length] : null;
}

function sectionRange(text: string, heading: RegExp): [number, number] | null {
  let pos = 0, start = -1, fenced = false;
  for (const line of text.split("\n")) {
    const next = pos + line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced) {
      if (start < 0 && heading.test(line)) start = next;
      else if (start >= 0 && ANY_HEADING.test(line)) return [start, pos];
    }
    pos = next;
  }
  return start < 0 ? null : [start, text.length];
}

async function addToSection(app: App, source: TFile, target: TFile, heading: "Children" | "Parents" | "Connections") {
  const matcher = heading === "Children" ? CHILDREN_HEADING : heading === "Parents" ? PARENTS_HEADING : CONNECTIONS_HEADING;
  const linktext = app.metadataCache.fileToLinktext(target, source.path, true);
  await app.vault.process(source, (text) => {
    const range = sectionRange(text, matcher);
    if (range && findLinks(app, text, source).some((l) => l.dest.path === target.path && l.start >= range[0] && l.start < range[1])) return text;
    const link = `- [[${linktext}]]`;
    if (!range) return `${text.replace(/\s+$/, "")}${text.trim() ? "\n\n" : ""}## ${heading}\n${link}\n`;
    const at = text.lastIndexOf("\n", range[1] - 1) + 1;
    return text.slice(0, at) + link + "\n" + text.slice(at);
  });
}

/**
 * Make explicit relationship headings reciprocal.  This never removes prose links:
 * it only adds the missing paired entry (Children <-> Parents) and gives an
 * unclassified note link a Connections entry.
 */
export async function normalizeRelationships(app: App) {
  type Relation = { kind: "child" | "parent" | "connection"; source: TFile; target: TFile };
  const relations: Relation[] = [];
  for (const source of app.vault.getMarkdownFiles()) {
    const text = await app.vault.cachedRead(source);
    const child = sectionRange(text, CHILDREN_HEADING);
    const parent = sectionRange(text, PARENTS_HEADING);
    const connection = sectionRange(text, CONNECTIONS_HEADING);
    const hasStructure = !!child || !!parent || !!connection;
    for (const link of findLinks(app, text, source)) {
      const kind = child && link.start >= child[0] && link.start < child[1] ? "child"
        : parent && link.start >= parent[0] && link.start < parent[1] ? "parent"
        : connection && link.start >= connection[0] && link.start < connection[1] ? "connection"
        // Preserve pre-heading maps: a note with no relationship headings used
        // every link as a child. Once structured, ordinary prose is a reference.
        : hasStructure ? "connection" : "child";
      relations.push({ kind, source, target: link.dest });
    }
  }
  for (const r of relations) {
    if (r.kind === "child") {
      await addToSection(app, r.source, r.target, "Children");
      await addToSection(app, r.target, r.source, "Parents");
    } else if (r.kind === "parent") {
      await addToSection(app, r.source, r.target, "Parents");
      await addToSection(app, r.target, r.source, "Children");
    } else {
      await addToSection(app, r.source, r.target, "Connections");
    }
  }
}

/** Add `target` to `source`'s "## Children" section. False if it is already listed there. */
export async function addLink(app: App, source: TFile, target: TFile): Promise<boolean> {
  const linktext = app.metadataCache.fileToLinktext(target, source.path, true);
  let added = false;
  await app.vault.process(source, (text) => {
    const range = childrenRange(text);
    const listed = findLinks(app, text, source).some(
      (l) => l.dest.path === target.path && (!range || (l.start >= range[0] && l.start < range[1]))
    );
    // Without a Children section, any existing link already makes it a child.
    if (listed) return text;
    added = true;
    const link = `- [[${linktext}]]`;
    const lines = text.split("\n");

    let heading = -1;
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
      if (!fenced && CHILDREN_HEADING.test(lines[i])) {
        heading = i;
        break;
      }
    }
    if (heading < 0) {
      const body = text.replace(/\s+$/, "");
      return (body ? body + "\n\n" : "") + `## Children\n${link}\n`;
    }
    let end = lines.length;
    for (let i = heading + 1; i < lines.length; i++) {
      if (ANY_HEADING.test(lines[i])) {
        end = i;
        break;
      }
    }
    let at = heading + 1;
    for (let i = end - 1; i > heading; i--) {
      if (lines[i].trim()) {
        at = i + 1;
        break;
      }
    }
    lines.splice(at, 0, link);
    return lines.join("\n");
  });
  if (added) await addToSection(app, target, source, "Parents");
  return added;
}

/**
 * Remove every link from `source` to `target` (or, with `onlyChildren`, only those in
 * its "## Children" section). A link that is the only content of a list item removes
 * the line; any other link becomes plain text.
 */
export async function removeLinks(app: App, source: TFile, target: TFile, onlyChildren = false): Promise<number> {
  let removed = 0;
  await app.vault.process(source, (text) => {
    const range = onlyChildren ? childrenRange(text) : null;
    if (onlyChildren && !range) return text;
    const hits = findLinks(app, text, source)
      .filter((l) => l.dest.path === target.path)
      .filter((l) => !range || (l.start >= range[0] && l.start < range[1]))
      .sort((a, b) => b.start - a.start);
    for (const l of hits) {
      removed++;
      const lineStart = text.lastIndexOf("\n", l.start - 1) + 1;
      const nl = text.indexOf("\n", l.end);
      const lineEnd = nl < 0 ? text.length : nl;
      const before = text.slice(lineStart, l.start);
      const after = text.slice(l.end, lineEnd);
      if (/^\s*(?:[-*+]|\d+[.)])\s+$/.test(before) && after.trim() === "") {
        text = text.slice(0, lineStart) + text.slice(Math.min(lineEnd + 1, text.length));
      } else {
        text = text.slice(0, l.start) + l.display + text.slice(l.end);
      }
    }
    return text;
  });
  return removed;
}

/** Detach `target` from `source`'s children: take it out of the Children section, or remove a plain link if there is no section. */
export async function removeChild(app: App, source: TFile, target: TFile): Promise<number> {
  const n = await removeLinks(app, source, target, true);
  return n || removeLinks(app, source, target);
}

/**
 * Add a connection: a link from `source` to `target` that is not a child. It goes under
 * "## Connections". A note without a "## Children" section treats every link as a child,
 * so its existing links are first gathered into a new "## Children" section.
 * Returns false if the two are already linked from `source`.
 */
export async function addConnection(app: App, source: TFile, target: TFile): Promise<boolean> {
  const linktext = app.metadataCache.fileToLinktext(target, source.path, true);
  let added = false;
  await app.vault.process(source, (text) => {
    const found = findLinks(app, text, source);
    if (found.some((l) => l.dest.path === target.path)) return text;
    added = true;
    const link = `- [[${linktext}]]`;
    let body = text.replace(/\s+$/, "");

    if (!childrenRange(text)) {
      const seen = new Set<string>();
      const kids: string[] = [];
      for (const l of found.sort((a, b) => a.start - b.start)) {
        if (l.dest.extension !== "md" || l.dest.path === source.path || seen.has(l.dest.path)) continue;
        seen.add(l.dest.path);
        kids.push(`- [[${app.metadataCache.fileToLinktext(l.dest, source.path, true)}]]`);
      }
      if (kids.length) body += `${body ? "\n\n" : ""}## Children\n${kids.join("\n")}`;
    }

    const lines = body.split("\n");
    let heading = -1;
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
      if (!fenced && CONNECTIONS_HEADING.test(lines[i])) {
        heading = i;
        break;
      }
    }
    if (heading < 0) return `${body}${body ? "\n\n" : ""}## Connections\n${link}\n`;
    let end = lines.length;
    for (let i = heading + 1; i < lines.length; i++) {
      if (ANY_HEADING.test(lines[i])) {
        end = i;
        break;
      }
    }
    let at = heading + 1;
    for (let i = end - 1; i > heading; i--) {
      if (lines[i].trim()) {
        at = i + 1;
        break;
      }
    }
    lines.splice(at, 0, link);
    return lines.join("\n") + "\n";
  });
  return added;
}
