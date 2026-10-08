import type { Edge, MapNode } from "./tree";

export type LayoutMode = "radial" | "tree";

export interface Pt {
  x: number;
  y: number;
}

export function childMap(edges: Edge[]): Map<MapNode, MapNode[]> {
  const m = new Map<MapNode, MapNode[]>();
  for (const e of edges) {
    if (!m.has(e.from)) m.set(e.from, []);
    m.get(e.from)!.push(e.to);
  }
  return m;
}

/**
 * Deterministic layout of the tree edges. Sets each node's `bx`/`by`
 * (its automatic position, root at 0,0). Notes with no parent are left alone.
 * Boxes never overlap and tree lines never run through other boxes.
 */
export function arrange(root: MapNode, edges: Edge[], mode: LayoutMode, spacing: number) {
  const kids = childMap(edges);
  root.bx = 0;
  root.by = 0;
  if (mode === "tree") arrangeTree(root, kids, spacing);
  else arrangeRadial(root, kids, spacing);
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
}

interface Box extends Pt {
  w: number;
  h: number;
}
interface Seg {
  a: Pt;
  b: Pt;
  from: MapNode;
  to: MapNode;
}

// ---------- two-sided tree ----------

function arrangeTree(root: MapNode, kids: Map<MapNode, MapNode[]>, spacing: number) {
  const gap = Math.max(6, spacing * 0.3);
  const height = new Map<MapNode, number>();
  const measure = (n: MapNode): number => {
    const ks = kids.get(n) ?? [];
    const block = ks.reduce((t, k) => t + measure(k), 0) + gap * Math.max(0, ks.length - 1);
    const h = Math.max(n.h, block);
    height.set(n, h);
    return h;
  };
  measure(root);
  const place = (n: MapNode, dir: 1 | -1, top: number): void => {
    const ks = kids.get(n) ?? [];
    const h = height.get(n)!;
    if (!ks.length) {
      n.by = top + h / 2;
      return;
    }
    const block = ks.reduce((t, k) => t + height.get(k)!, 0) + gap * (ks.length - 1);
    let y = top + (h - block) / 2;
    for (const k of ks) {
      k.bx = n.bx + dir * (n.w / 2 + spacing + k.w / 2);
      place(k, dir, y);
      y += height.get(k)! + gap;
    }
    n.by = (ks[0].by + ks[ks.length - 1].by) / 2;
  };
  for (const dir of [1, -1] as const) {
    const group = (kids.get(root) ?? []).filter((k) => (k.side === -1 ? -1 : 1) === dir);
    if (!group.length) continue;
    const total = group.reduce((t, k) => t + height.get(k)!, 0) + gap * (group.length - 1);
    let y = -total / 2;
    for (const k of group) {
      k.bx = dir * (root.w / 2 + spacing + k.w / 2);
      place(k, dir, y);
      y += height.get(k)! + gap;
    }
  }
}
const PAD = 6;
const STEP = 5;
const REACH = 900;
const SWING = [0, 2, -2, 4, -4, 7, -7, 10, -10, 14, -14];
function boxesTouch(a: Box, b: Box, pad: number) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + pad && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + pad;
}
function segmentHitsBox(p: Pt, q: Pt, b: Box, pad: number) {
  const hx = b.w / 2 + pad;
  const hy = b.h / 2 + pad;
  let t0 = 0;
  let t1 = 1;
  const d: number[] = [q.x - p.x, q.y - p.y];
  const lo: number[] = [b.x - hx - p.x, b.y - hy - p.y];
  const hi: number[] = [b.x + hx - p.x, b.y + hy - p.y];
  for (let i = 0; i < 2; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (lo[i] > 0 || hi[i] < 0) return false;
    } else {
      let a = lo[i] / d[i];
      let c = hi[i] / d[i];
      if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, c);
      if (t0 > t1) return false;
    }
  }
  return true;
}
const orient = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
}
function arrangeRadial(root: MapNode, kids: Map<MapNode, MapNode[]>, spacing: number) {
  const weight = new Map<MapNode, number>();
  const demand = (n: MapNode, th?: number) => th === void 0 ? 40 : Math.abs(Math.sin(th)) * n.w + Math.abs(Math.cos(th)) * n.h + 12;
  const weigh = (n: MapNode, angles: Map<MapNode, number>): number => {
    const ks = kids.get(n) ?? [];
    const own = demand(n, angles.get(n));
    const w = ks.length ? Math.max(own, ks.reduce((t, k) => t + weigh(k, angles), 0)) : own;
    weight.set(n, w);
    return w;
  };
  let angle = new Map<MapNode, number>();
  const assign = (n: MapNode, a0: number, a1: number): void => {
    angle.set(n, (a0 + a1) / 2);
    const ks = kids.get(n) ?? [];
    const total = ks.reduce((t, k) => t + weight.get(k)!, 0) || 1;
    let a = a0;
    for (const k of ks) {
      const span = (a1 - a0) * weight.get(k)! / total;
      assign(k, a, a + span);
      a += span;
    }
  };
  const rootKids = kids.get(root) ?? [];
  const outs = rootKids.filter((k) => k.side !== -1);
  const backs = rootKids.filter((k) => k.side === -1);
  const wOf = (g: MapNode[]) => g.reduce((t, k) => t + weight.get(k)!, 0);
  const top = -Math.PI / 2;
  const spread = (g: MapNode[], a0: number, a1: number) => {
    const total = wOf(g) || 1;
    let a = a0;
    for (const k of g) {
      const span = (a1 - a0) * weight.get(k)! / total;
      assign(k, a, a + span);
      a += span;
    }
  };
  for (let pass = 0; pass < 4; pass++) {
    for (const k of rootKids) weigh(k, angle);
    angle = new Map();
    if (outs.length && backs.length) {
      const share = Math.min(0.7, Math.max(0.3, wOf(outs) / (wOf(outs) + wOf(backs))));
      const so = Math.PI * 2 * share;
      const sb = Math.PI * 2 - so;
      spread(outs, -so / 2, so / 2);
      spread(backs, Math.PI + sb / 2, Math.PI - sb / 2);
    } else {
      spread(rootKids, top, top + Math.PI * 2);
    }
  }
  const boxes: Box[] = [{ x: 0, y: 0, w: root.w, h: root.h }];
  const segs: Seg[] = [];
  const at = new Map<MapNode, Pt>([[root, { x: 0, y: 0 }]]);
  const boxOf = new Map<MapNode, Box>([[root, boxes[0]]]);
  const parentOf = new Map<MapNode, MapNode>();
  for (const [p, ks] of kids) for (const k of ks) parentOf.set(k, p);
  let level = rootKids;
  while (level.length) {
    const next: MapNode[] = [];
    for (const n of level) {
      const parent = parentOf.get(n)!;
      const pp = at.get(parent)!;
      const pb = boxOf.get(parent)!;
      const th0 = angle.get(n)!;
      const cand = { x: 0, y: 0, w: n.w, h: n.h };
      const r0 = Math.hypot(pp.x, pp.y);
      let best: { x: number; y: number; cost: number } | null = null;
      for (const level2 of [2, 1, 0]) {
        for (const k of SWING) {
          const th = th0 + k * Math.PI / 180;
          const ux = Math.cos(th);
          const uy = Math.sin(th);
          const limit = best ? best.cost : Infinity;
          for (let rho = r0; rho < r0 + REACH && rho + Math.abs(k) * 6 < limit; rho += STEP) {
            cand.x = ux * rho;
            cand.y = uy * rho;
            const gapX = Math.abs(cand.x - pb.x) - (cand.w + pb.w) / 2;
            const gapY = Math.abs(cand.y - pb.y) - (cand.h + pb.h) / 2;
            if (Math.max(gapX, gapY) < spacing) continue;
            if (blocked(cand, pp, parent, boxes, boxOf, segs, level2)) continue;
            best = { x: cand.x, y: cand.y, cost: rho + Math.abs(k) * 6 };
            break;
          }
        }
        if (best) break;
      }
      if (!best) best = { x: cand.x, y: cand.y, cost: 0 };
      cand.x = best.x;
      cand.y = best.y;
      n.bx = cand.x;
      n.by = cand.y;
      const pt = { x: cand.x, y: cand.y };
      at.set(n, pt);
      const placed = { ...cand };
      boxes.push(placed);
      boxOf.set(n, placed);
      segs.push({ a: pp, b: pt, from: parent, to: n });
      next.push(...kids.get(n) ?? []);
    }
    level = next;
  }
}
function blocked(cand: Box, from: Pt, parent: MapNode, boxes: Box[], boxOf: Map<MapNode, Box>, segs: Seg[], level: number) {
  const to = { x: cand.x, y: cand.y };
  const pbox = boxOf.get(parent)!;
  const lx0 = Math.min(from.x, to.x) - 4;
  const lx1 = Math.max(from.x, to.x) + 4;
  const ly0 = Math.min(from.y, to.y) - 4;
  const ly1 = Math.max(from.y, to.y) + 4;
  for (const b of boxes) {
    if (boxesTouch(cand, b, PAD)) return true;
    if (level === 0 || b === pbox) continue;
    if (b.x + b.w / 2 < lx0 || b.x - b.w / 2 > lx1 || b.y + b.h / 2 < ly0 || b.y - b.h / 2 > ly1) continue;
    if (segmentHitsBox(from, to, b, 2)) return true;
  }
  if (level === 0) return false;
  const cx0 = cand.x - cand.w / 2 - 4;
  const cx1 = cand.x + cand.w / 2 + 4;
  const cy0 = cand.y - cand.h / 2 - 4;
  const cy1 = cand.y + cand.h / 2 + 4;
  for (const s of segs) {
    const sx0 = Math.min(s.a.x, s.b.x);
    const sx1 = Math.max(s.a.x, s.b.x);
    const sy0 = Math.min(s.a.y, s.b.y);
    const sy1 = Math.max(s.a.y, s.b.y);
    const incident = s.from === parent || s.to === parent;
    if (!(s.to === parent) && !(sx1 < cx0 || sx0 > cx1 || sy1 < cy0 || sy0 > cy1)) {
      if (segmentHitsBox(s.a, s.b, cand, 2)) return true;
    }
    if (level === 2 && !incident && !(sx1 < lx0 || sx0 > lx1 || sy1 < ly0 || sy0 > ly1)) {
      if (segmentsCross(from, to, s.a, s.b)) return true;
    }
  }
  return false;
}
