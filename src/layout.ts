import type { Edge, MapNode } from "./tree";
import { Pt, segmentHitsBox } from "./lines";

export type { Pt };

export function childMap(edges: Edge[]): Map<MapNode, MapNode[]> {
  const m = new Map<MapNode, MapNode[]>();
  for (const e of edges) {
    if (!m.has(e.from)) m.set(e.from, []);
    m.get(e.from)!.push(e.to);
  }
  return m;
}

/** Widest fan a non-root note spreads its children over. */
const MAX_FAN = Math.PI;

const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
};

/** Half the box's extent along the direction `angle`. */
const halfExtent = (n: MapNode, angle: number) =>
  (n.w / 2) * Math.abs(Math.cos(angle)) + (n.h / 2) * Math.abs(Math.sin(angle));

/**
 * Radial layout of the hierarchy, in stages:
 *  1. every subtree gets an angular wedge sized by its leaf count, so a branch
 *     stays grouped; siblings are then ordered to keep extra-parent and
 *     connection lines short;
 *  2. each generation gets one ring, far enough out for its boxes to clear
 *     both the previous ring and each other.
 * Sets `bx`/`by` (root at 0,0).
 */
export function arrange(root: MapNode, edges: Edge[], spacing: number, crossLinks: Edge[] = [], minLine = 0) {
  const kids = childMap(edges);
  root.bx = 0;
  root.by = 0;

  const weight = new Map<MapNode, number>();
  const weigh = (n: MapNode): number => {
    const k = kids.get(n) ?? [];
    const w = k.length ? k.reduce((sum, c) => sum + weigh(c), 0) : 1;
    weight.set(n, w);
    return w;
  };
  weigh(root);

  // Outgoing notes first, then backlink notes, each group keeping its order.
  const order = new Map<MapNode, MapNode[]>();
  for (const [p, list] of kids) {
    order.set(p, p === root ? [...list.filter((c) => c.side !== -1), ...list.filter((c) => c.side === -1)] : [...list]);
  }

  const neighbours = new Map<MapNode, MapNode[]>();
  for (const e of crossLinks) {
    for (const [x, y] of [[e.from, e.to], [e.to, e.from]] as const) {
      if (!neighbours.has(x)) neighbours.set(x, []);
      neighbours.get(x)!.push(y);
    }
  }

  const angle = new Map<MapNode, number>();
  const level = new Map<MapNode, number>();
  const place = () => {
    angle.clear();
    level.clear();
    level.set(root, 0);
    const walk = (n: MapNode, start: number, span: number) => {
      const list = order.get(n) ?? [];
      if (!list.length) return;
      let fanStart = start;
      let fanSpan = span;
      if (span > MAX_FAN) {
        fanStart = start + (span - MAX_FAN) / 2;
        fanSpan = MAX_FAN;
      }
      sweep(n, list, fanStart, fanSpan);
    };
    const sweep = (n: MapNode, list: MapNode[], start: number, span: number) => {
      const total = list.reduce((sum, c) => sum + weight.get(c)!, 0);
      let a = start;
      for (const c of list) {
        const s = (span * weight.get(c)!) / total;
        angle.set(c, a + s / 2);
        level.set(c, level.get(n)! + 1);
        walk(c, a, s);
        a += s;
      }
    };
    // Backlinks get their own arc centred at the top; outgoing branches share the rest.
    const rootKids = order.get(root) ?? [];
    const out = rootKids.filter((c) => c.side !== -1);
    const back = rootKids.filter((c) => c.side === -1);
    const wOut = out.reduce((sum, c) => sum + weight.get(c)!, 0);
    const wBack = back.reduce((sum, c) => sum + weight.get(c)!, 0);
    let backSpan = 0;
    if (back.length) {
      backSpan = out.length ? (2 * Math.PI * wBack) / (wBack + wOut) : 1.1 * Math.PI;
      backSpan = Math.min(1.1 * Math.PI, Math.max(Math.PI / 3, backSpan));
    }
    const top = -Math.PI / 2;
    if (back.length) sweep(root, back, top - backSpan / 2, backSpan);
    if (out.length) sweep(root, out, top + backSpan / 2, 2 * Math.PI - backSpan);
  };

  place();
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const [p, list] of order) {
      if (p === root || list.length < 2 || !angle.has(p)) continue;
      const base = angle.get(p)!;
      const key = (c: MapNode) => {
        const near = (neighbours.get(c) ?? []).filter((o) => angle.has(o) && o !== p);
        const own = wrap(angle.get(c)! - base);
        if (!near.length) return own;
        const pull = near.reduce((sum, o) => sum + wrap(angle.get(o)! - base), 0) / near.length;
        return (own + pull) / 2;
      };
      const keys = new Map(list.map((c) => [c, key(c)] as const));
      const sorted = [...list].sort((x, y) => keys.get(x)! - keys.get(y)!);
      if (sorted.some((c, i) => c !== list[i])) {
        order.set(p, sorted);
        changed = true;
      }
    }
    if (!changed) break;
    place();
  }

  // One ring per generation.
  const maxLevel = Math.max(0, ...level.values());
  const byLevel: MapNode[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const [n, l] of level) byLevel[l].push(n);
  const parentOf = new Map<MapNode, MapNode>();
  for (const [p, list] of kids) for (const c of list) parentOf.set(c, p);
  // A labelled line must be long enough to carry its text.
  const labelLen = new Map<MapNode, number>();
  for (const e of edges) if (e.labelW) labelLen.set(e.to, e.labelW + 16);
  const gap = Math.max(2, spacing * 0.6);
  const sideGap = Math.max(4, gap * 0.4);
  const ringsFor = (inGroup: (n: MapNode) => boolean) => {
    const ring: number[] = [0];
    for (let l = 1; l <= maxLevel; l++) {
      let r = ring[l - 1];
      const members = byLevel[l].filter(inGroup);
      for (const n of members) {
        const p = parentOf.get(n)!;
        const a = angle.get(n)!;
        r = Math.max(r, ring[l - 1] + halfExtent(p, a) + halfExtent(n, a) + Math.max(gap, minLine, labelLen.get(n) ?? 0));
      }
      const siblings = [...members].sort((x, y) => angle.get(x)! - angle.get(y)!);
      for (let i = 0; i < siblings.length && siblings.length > 1; i++) {
        const u = siblings[i];
        const v = siblings[(i + 1) % siblings.length];
        const delta = Math.min(Math.PI, Math.abs(wrap(angle.get(v)! - angle.get(u)!)));
        if (delta < 1e-4) continue;
        const mid = angle.get(u)! + delta / 2 + Math.PI / 2;
        const need = halfExtent(u, mid) + halfExtent(v, mid) + sideGap;
        r = Math.max(r, need / (2 * Math.sin(delta / 2)));
      }
      ring.push(r);
    }
    return ring;
  };
  const isBack = new Map<MapNode, boolean>();
  const markBack = (n: MapNode, b: boolean) => {
    isBack.set(n, b);
    for (const c of kids.get(n) ?? []) markBack(c, b || c.side === -1);
  };
  markBack(root, false);
  const outRing = ringsFor((n) => !isBack.get(n));
  const backRing = ringsFor((n) => !!isBack.get(n));
  // Backlink notes sit farther out than the outgoing map.
  const BACK_PUSH = 1.3;
  for (const [n, a] of angle) {
    const l = level.get(n)!;
    const r = isBack.get(n) ? backRing[l] * BACK_PUSH + gap * 2 : outRing[l];
    n.bx = Math.cos(a) * r;
    n.by = Math.sin(a) * r;
  }
}

/** Final positions: automatic layout plus manual offsets (which carry whole branches). */
export function applyOffsets(
  root: MapNode,
  edges: Edge[],
  offsets: Map<string, Pt>,
  free: Map<string, Pt>,
  nodes: MapNode[]
) {
  const kids = childMap(edges);
  root.gx = 0;
  root.gy = 0;
  const walk = (p: MapNode) => {
    for (const c of kids.get(p) ?? []) {
      const o = offsets.get(c.file.path);
      c.gx = p.gx + (c.bx - p.bx) + (o?.x ?? 0);
      c.gy = p.gy + (c.by - p.by) + (o?.y ?? 0);
      walk(c);
    }
  };
  walk(root);
  const attached = new Set<MapNode>([root]);
  const mark = (n: MapNode) => {
    attached.add(n);
    (kids.get(n) ?? []).forEach(mark);
  };
  mark(root);
  let reach = 0;
  for (const n of attached) reach = Math.max(reach, Math.hypot(n.gx, n.gy) + Math.max(n.w, n.h) / 2);
  // Floating notes sit on a ring outside the map, at the angle of the note they link with.
  const floaters = nodes.filter((n) => !attached.has(n) && !free.has(n.file.path) && n.anchor);
  const ring = reach + 70;
  const angleOf = (n: MapNode) => Math.atan2(n.anchor!.gy, n.anchor!.gx || (n.anchor!.side === -1 ? -1 : 1));
  floaters.sort((a, b) => angleOf(a) - angleOf(b));
  let prev = -Infinity;
  for (const n of floaters) {
    const sep = (Math.max(n.w, n.h) + 24) / ring;
    const ang = Math.max(angleOf(n), prev + sep);
    prev = ang;
    n.gx = Math.cos(ang) * ring;
    n.gy = Math.sin(ang) * ring;
  }
  for (const n of nodes) {
    if (attached.has(n)) continue;
    const f = free.get(n.file.path);
    if (f) {
      n.gx = f.x;
      n.gy = f.y;
    }
  }
  // Saved offsets and floating notes are user-controlled, but never let them
  // leave unreadable overlapping boxes in the rendered map.
  resolveFinalOverlaps(root, nodes, 6);
}

export function resolveFinalOverlaps(root: MapNode, nodes: MapNode[], gap: number) {
  for (let pass = 0; pass < 100; pass++) {
    let changed = false;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const ox = (a.w + b.w) / 2 + gap - Math.abs(b.gx - a.gx);
      const oy = (a.h + b.h) / 2 + gap - Math.abs(b.gy - a.gy);
      if (ox <= 0 || oy <= 0) continue;
      changed = true;
      const horizontal = ox < oy;
      const amount = (horizontal ? ox : oy) / 2 + 0.5;
      const sign = horizontal ? Math.sign(b.gx - a.gx || 1) : Math.sign(b.gy - a.gy || 1);
      if (a !== root) {
        if (horizontal) a.gx -= sign * amount;
        else a.gy -= sign * amount;
      }
      if (b !== root) {
        if (horizontal) b.gx += sign * amount;
        else b.gy += sign * amount;
      }
    }
    if (!changed) break;
  }
}


/**
 * Layout and lines cooperate here: if a hierarchy line would pass through
 * another note, slide that note (and its branch) sideways, a little, out of the
 * way. Notes the user placed by hand are left alone.
 */
export function relieveBlockers(root: MapNode, edges: Edge[], nodes: MapNode[], locked: Set<MapNode>, passes = 3) {
  const kids = childMap(edges);
  const branch = (n: MapNode): MapNode[] => [n, ...(kids.get(n) ?? []).flatMap(branch)];
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const e of edges) {
      const A = { x: e.from.gx, y: e.from.gy };
      const B = { x: e.to.gx, y: e.to.gy };
      const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
      const nx = -(B.y - A.y) / len;
      const ny = (B.x - A.x) / len;
      for (const n of nodes) {
        if (n === e.from || n === e.to || n === root || locked.has(n)) continue;
        if (!segmentHitsBox(A, B, { x: n.gx, y: n.gy, w: n.w, h: n.h })) continue;
        const signed = (n.gx - A.x) * nx + (n.gy - A.y) * ny;
        const clear = (n.w / 2) * Math.abs(nx) + (n.h / 2) * Math.abs(ny) + 12;
        const shift = clear - Math.abs(signed);
        if (shift <= 0 || shift > 40) continue;
        const sign = signed >= 0 ? 1 : -1;
        for (const m of branch(n)) {
          m.gx += nx * sign * shift;
          m.gy += ny * sign * shift;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  resolveFinalOverlaps(root, nodes, 6);
}
