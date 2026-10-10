import { App, normalizePath, TFile } from "obsidian";
import { addEntry, hasSection, hasStructure, legacyParentNames, restructure, withLabel } from "./note-format";

const CHILDREN_HEADING = /^#{1,6}\s+children\s*$/i;
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

/**
 * One-time migration to the fixed `## Map` block: a legacy `## Parents` entry becomes
 * an entry in that parent's Children, then Children/Connections move under `## Map`.
 * A note with no relationship headings gets its links as Children.
 */
export async function normalizeRelationships(app: App) {
  const files = app.vault.getMarkdownFiles();
  for (const source of files) {
    const names = legacyParentNames(await app.vault.cachedRead(source));
    for (const name of names) {
      const parent = app.metadataCache.getFirstLinkpathDest(name, source.path);
      if (parent && parent.extension === "md" && parent.path !== source.path) await addLink(app, parent, source);
    }
  }
  for (const source of files) {
    const before = await app.vault.cachedRead(source);
    const compute = (text: string) => {
      let out = restructure(text);
      if (!hasStructure(out)) {
        const seen = new Set<string>();
        for (const l of findLinks(app, out, source).sort((a, b) => a.start - b.start)) {
          if (l.dest.extension !== "md" || l.dest.path === source.path || seen.has(l.dest.path)) continue;
          seen.add(l.dest.path);
          out = addEntry(out, "Children", `- [[${app.metadataCache.fileToLinktext(l.dest, source.path, true)}]]`);
        }
      }
      return out;
    };
    if (compute(before) !== before) await app.vault.process(source, compute);
  }
}

/** Add `target` to `source`'s Children. False if it is already listed there. */
export async function addLink(app: App, source: TFile, target: TFile): Promise<boolean> {
  if (source.path === target.path) return false;
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
    return addEntry(text, "Children", `- [[${linktext}]]`);
  });
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
    const structural = [childrenRange(text), sectionRange(text, CONNECTIONS_HEADING)];
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
      const inBlock = structural.some((r) => r && l.start >= r[0] && l.start < r[1]);
      if (/^\s*(?:[-*+]|\d+[.)])\s+$/.test(before) && (after.trim() === "" || inBlock)) {
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
  if (source.path === target.path) return false;
  // A pair that already has a relationship in either direction needs no extra connection.
  const reverse = await app.vault.cachedRead(target);
  for (const heading of [CHILDREN_HEADING, CONNECTIONS_HEADING]) {
    const range = sectionRange(reverse, heading);
    if (range && findLinks(app, reverse, target).some((l) => l.dest.path === source.path && l.start >= range[0] && l.start < range[1])) {
      return false;
    }
  }
  const linktext = app.metadataCache.fileToLinktext(target, source.path, true);
  let added = false;
  await app.vault.process(source, (text) => {
    const found = findLinks(app, text, source);
    if (found.some((l) => l.dest.path === target.path)) return text;
    added = true;
    let out = restructure(text);
    // A note without a Children section treats every link as a child, so keep those as children first.
    if (!hasSection(out, "Children")) {
      const seen = new Set<string>();
      for (const l of found.sort((a, b) => a.start - b.start)) {
        if (l.dest.extension !== "md" || l.dest.path === source.path || seen.has(l.dest.path)) continue;
        seen.add(l.dest.path);
        out = addEntry(out, "Children", `- [[${app.metadataCache.fileToLinktext(l.dest, source.path, true)}]]`);
      }
    }
    return addEntry(out, "Connections", `- [[${linktext}]]`);
  });
  return added;
}

export type TidyHeading = "Children" | "Connections";

export interface TidyIssue {
  source: TFile;
  target: TFile;
  heading: TidyHeading;
  reason: string;
  // Remove only repeated entries, keeping the first.
  keepFirst?: boolean;
}

const HEADINGS: [TidyHeading, RegExp][] = [
  ["Children", CHILDREN_HEADING],
  ["Connections", CONNECTIONS_HEADING],
];

/**
 * Scan the given notes for relationship clutter: links to themselves, repeated
 * entries, connections that duplicate a parent/child or another connection, and
 * child links already implied through another child.
 */
export async function findTidyIssues(app: App, files: TFile[]): Promise<TidyIssue[]> {
  const issues: TidyIssue[] = [];
  const inMap = new Set(files.map((f) => f.path));
  const sections = new Map<string, Record<TidyHeading, TFile[]>>();

  for (const f of files) {
    const text = await app.vault.cachedRead(f);
    const rec: Record<TidyHeading, TFile[]> = { Children: [], Connections: [] };
    const links = findLinks(app, text, f).sort((a, b) => a.start - b.start);
    for (const [heading, re] of HEADINGS) {
      const range = sectionRange(text, re);
      if (!range) continue;
      const seen = new Set<string>();
      for (const l of links) {
        if (l.start < range[0] || l.start >= range[1]) continue;
        if (l.dest.path === f.path) {
          issues.push({ source: f, target: f, heading, reason: `Links to itself (${heading})` });
        } else if (seen.has(l.dest.path)) {
          issues.push({ source: f, target: l.dest, heading, keepFirst: true, reason: `Listed more than once under ${heading}` });
        } else {
          seen.add(l.dest.path);
          rec[heading].push(l.dest);
        }
      }
    }
    sections.set(f.path, rec);
  }

  const has = (a: string, b: string, h: TidyHeading) => sections.get(a)?.[h].some((t) => t.path === b) ?? false;
  const parentChild = (p: string, c: string) => has(p, c, "Children");

  for (const f of files) {
    for (const t of sections.get(f.path)!.Connections) {
      if (parentChild(f.path, t.path) || parentChild(t.path, f.path)) {
        issues.push({ source: f, target: t, heading: "Connections", reason: "Already a parent/child — connection is redundant" });
      } else if (has(t.path, f.path, "Connections") && f.path > t.path) {
        issues.push({ source: f, target: t, heading: "Connections", reason: "Connected in both directions — one is enough" });
      }
    }
  }

  const kids = new Map<string, Set<string>>();
  const edge = (p: string, c: string) => {
    if (p === c || !inMap.has(p) || !inMap.has(c)) return;
    if (!kids.has(p)) kids.set(p, new Set());
    kids.get(p)!.add(c);
  };
  for (const f of files) {
    for (const c of sections.get(f.path)!.Children) edge(f.path, c.path);
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const stack = [...(kids.get(from) ?? [])].filter((c) => c !== to);
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(kids.get(n) ?? []));
    }
    return false;
  };
  for (const f of files) {
    for (const c of sections.get(f.path)!.Children) {
      if (inMap.has(c.path) && c.path !== f.path && reaches(f.path, c.path)) {
        issues.push({ source: f, target: c, heading: "Children", reason: "Also reachable through another child" });
      }
    }
  }
  return issues;
}

async function removeFromSection(app: App, source: TFile, target: TFile, heading: TidyHeading, keepFirst: boolean) {
  const re = HEADINGS.find(([h]) => h === heading)![1];
  await app.vault.process(source, (text) => {
    const range = sectionRange(text, re);
    if (!range) return text;
    let hits = findLinks(app, text, source)
      .filter((l) => l.dest.path === target.path && l.start >= range[0] && l.start < range[1])
      .sort((a, b) => a.start - b.start);
    if (keepFirst) hits = hits.slice(1);
    for (const l of hits.reverse()) {
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
}

export async function fixTidyIssue(app: App, issue: TidyIssue) {
  await removeFromSection(app, issue.source, issue.target, issue.heading, !!issue.keepFirst);
}

/** Set (or clear, with an empty string) the remark after `target`'s entry in `owner`'s Children or Connections. */
export async function setLinkLabel(app: App, owner: TFile, target: TFile, section: "Children" | "Connections", label: string) {
  const re = section === "Children" ? CHILDREN_HEADING : CONNECTIONS_HEADING;
  await app.vault.process(owner, (text) => {
    const range = sectionRange(text, re);
    if (!range) return text;
    const hit = findLinks(app, text, owner)
      .filter((l) => l.dest.path === target.path && l.start >= range[0] && l.start < range[1])
      .sort((a, b) => a.start - b.start)[0];
    if (!hit) return text;
    const nl = text.indexOf("\n", hit.end);
    const lineEnd = nl < 0 ? text.length : nl;
    return text.slice(0, hit.start) + withLabel(text.slice(hit.start, hit.end), label) + text.slice(lineEnd);
  });
}
