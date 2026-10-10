/**
 * Pure text helpers for a note's relationship block. Relationships live in one
 * fixed place at the bottom of a note:
 *
 *   ## Map
 *   ### Children
 *   - [[Note]] optional remark
 *   ### Connections
 *   - [[Other]]
 *
 * Parents are never stored; they are derived from other notes' Children lists.
 */

export type Section = "Children" | "Connections";

interface Heading {
  i: number;
  level: number;
  kind: "children" | "connections" | "parents" | "map" | "other";
  end: number;
}

const HEADING = /^(#{1,6})\s+(\S.*?)\s*$/;
const WIKILINK = /!?\[\[([^\]\n|#^]+)(?:[#^][^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;

function scan(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (close > 0) i = close + 1;
  }
  let fenced = false;
  for (; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    const m = HEADING.exec(lines[i]);
    if (!m) continue;
    const t = m[2].toLowerCase();
    const kind = t === "children" || t === "connections" || t === "parents" || t === "map" ? t : "other";
    out.push({ i, level: m[1].length, kind, end: lines.length });
  }
  for (let k = 0; k < out.length - 1; k++) out[k].end = out[k + 1].i;
  return out;
}

const trimBlank = (lines: string[]) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

/** Names linked under a legacy `## Parents` heading. */
export function legacyParentNames(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const h of scan(lines)) {
    if (h.kind !== "parents") continue;
    for (const line of lines.slice(h.i + 1, h.end)) {
      for (const m of line.matchAll(WIKILINK)) out.push(m[1].trim());
    }
  }
  return out;
}

export function hasStructure(text: string): boolean {
  return scan(text.split("\n")).some((h) => h.kind === "children" || h.kind === "connections" || h.kind === "parents");
}

export function hasSection(text: string, section: Section): boolean {
  const kind = section.toLowerCase();
  return scan(text.split("\n")).some((h) => h.kind === kind);
}

function isCanonical(heads: Heading[]): boolean {
  const maps = heads.filter((h) => h.kind === "map");
  if (maps.length !== 1 || maps[0].level !== 2) return false;
  const at = heads.indexOf(maps[0]);
  if (heads.some((h, k) => (h.kind === "parents" || ((h.kind === "children" || h.kind === "connections") && k < at)))) return false;
  const after = heads.slice(at + 1);
  if (!after.every((h) => (h.kind === "children" || h.kind === "connections") && h.level === 3)) return false;
  const order = after.map((h) => h.kind);
  return order.length === new Set(order).size && !(order[0] === "connections" && order[1] === "children");
}

/** Move Children/Connections into the fixed `## Map` block at the end and drop any legacy Parents section. Idempotent. */
export function restructure(text: string): string {
  const lines = text.split("\n");
  const heads = scan(lines);
  if (!heads.some((h) => h.kind !== "other")) return text;
  if (isCanonical(heads)) return text;

  const drop = new Set<number>();
  const bodies: Record<"children" | "connections", string[] | null> = { children: null, connections: null };
  for (const h of heads) {
    if (h.kind === "map") drop.add(h.i);
    else if (h.kind === "parents") for (let k = h.i; k < h.end; k++) drop.add(k);
    else if (h.kind === "children" || h.kind === "connections") {
      for (let k = h.i; k < h.end; k++) drop.add(k);
      bodies[h.kind] = [...(bodies[h.kind] ?? []), ...trimBlank(lines.slice(h.i + 1, h.end))];
    }
  }
  const rest = trimBlank(lines.filter((_, k) => !drop.has(k)));
  const block: string[] = [];
  if (bodies.children || bodies.connections) {
    block.push("## Map");
    if (bodies.children) block.push("### Children", ...bodies.children);
    if (bodies.connections) block.push("### Connections", ...bodies.connections);
  }
  const head = rest.length ? [...rest, ...(block.length ? [""] : [])] : [];
  return [...head, ...block].join("\n") + "\n";
}

/** Add `link` (a full list item such as `- [[Note]]`) to a section, creating the Map block as needed. */
export function addEntry(text: string, section: Section, link: string): string {
  const lines = restructure(text).split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const heads = scan(lines);
  const kind = section.toLowerCase();
  const own = heads.find((h) => h.kind === kind);
  if (own) {
    let at = own.i + 1;
    for (let k = own.end - 1; k > own.i; k--) {
      if (lines[k].trim()) {
        at = k + 1;
        break;
      }
    }
    lines.splice(at, 0, link);
    return lines.join("\n") + "\n";
  }
  const map = heads.find((h) => h.kind === "map");
  if (!map) {
    return [...lines, ...(lines.length ? [""] : []), "## Map", `### ${section}`, link].join("\n") + "\n";
  }
  const connections = heads.find((h) => h.kind === "connections");
  if (section === "Children" && connections) lines.splice(connections.i, 0, "### Children", link);
  else lines.push(`### ${section}`, link);
  return lines.join("\n") + "\n";
}

/** The remark after a link on a list line (`- [[Note]] — why`), or "" when there is none. */
export function entryLabel(afterLink: string): string {
  return afterLink.replace(/^\s*[—–:|-]+\s*/, "").trim();
}

/** The list line's link followed by an optional remark. */
export function withLabel(linkPart: string, label: string): string {
  const clean = label.replace(/\s+/g, " ").trim();
  return clean ? `${linkPart} — ${clean}` : linkPart;
}
