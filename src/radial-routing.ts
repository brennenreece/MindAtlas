import type { Pt } from "./arrange";

export interface RouteBox extends Pt {
  id?: string;
  w: number;
  h: number;
}

export interface RouteAnchor {
  p: Pt;
  dir: Pt;
}

export interface RouteLine {
  source: string;
  target: string;
  points: Pt[];
}

export interface CrossLinkInput extends Omit<RouteLine, "points"> {
  key: string;
  start: Pt;
  end: Pt;
  strict?: boolean;
}

export interface CrossLinkRoute {
  /** Kept for callers that want a representative bend; paths may have many bends. */
  control: Pt;
  points: Pt[];
}

const SAMPLE_COUNT = 10;

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface Segment {
  a: Pt;
  b: Pt;
  bounds: Bounds;
}

interface IndexedLine extends RouteLine {
  bounds: Bounds;
  segments: Segment[];
}

export function routeCrossLinks(
  links: CrossLinkInput[],
  boxes: RouteBox[],
  occupied: RouteLine[]
): Map<string, CrossLinkRoute> {
  const routes = new Map<string, CrossLinkRoute>();
  const lines = occupied.map(indexLine);
  const ordered = [...links].sort(
    (a, b) => distance(b.start, b.end) - distance(a.start, a.end) || a.key.localeCompare(b.key)
  );

  for (const link of ordered) {
    const candidates = [[link.start, link.end], ...legacyCandidates(link), ...detourCandidates(link, boxes)];
    let best: CrossLinkRoute | null = null;
    let bestCost = Infinity;

    for (const points of candidates) {
      const pathBounds = boundsOf(points);
      const collisions = boxCollisions(points, pathBounds, boxes, link.source, link.target);
      const conflicts = lineConflicts(points, pathBounds, lines, link.source, link.target);
      // A clear route always wins over a shorter clipping route. Strict tree
      // edges also prioritize avoiding already-routed structural edges.
      const cost =
        collisions * 100000000 +
        conflicts * (link.strict ? 100000 : 100) +
        routeLength(points) * 0.04;
      if (cost < bestCost) {
        bestCost = cost;
        best = { control: points[Math.floor(points.length / 2)], points };
      }
    }

    if (best) {
      routes.set(link.key, best);
      lines.push(indexLine({ source: link.source, target: link.target, points: best.points }));
    }
  }

  return routes;
}

function legacyCandidates(link: CrossLinkInput): Pt[][] {
  const len = distance(link.start, link.end) || 1;
  const bend = Math.max(24, Math.min(90, len * 0.18));
  return [...new Set([bend, -bend, bend * 2, -bend * 2])]
    .map((amount) => [link.start, controlPoint(link.start, link.end, amount), link.end]);
}

/**
 * Route a polyline around every note box. Each pass detours the first blocked
 * segment around a padded corner; subsequent passes can add further bends for
 * clusters of boxes, rather than trying to force every path into one curve.
 */
function detourCandidates(link: CrossLinkInput, boxes: RouteBox[]): Pt[][] {
  const direct = [link.start, link.end];
  const routes: Pt[][] = [direct];
  for (const bias of [-1, 1]) {
    const points = [link.start, link.end];
    for (let pass = 0; pass < 16; pass++) {
      let changed = false;
      for (let i = 1; i < points.length; i++) {
        const hit = firstHit(points[i - 1], points[i], boxes, link.source, link.target);
        if (!hit) continue;
        const corners = cornersToward(points[i - 1], points[i], hit, bias);
        points.splice(i, 0, ...corners);
        changed = true;
        break;
      }
      if (!changed) break;
    }
    routes.push(points);
  }
  return routes;
}

function firstHit(a: Pt, b: Pt, boxes: RouteBox[], source: string, target: string): RouteBox | null {
  let nearest: { box: RouteBox; t: number } | null = null;
  for (const box of boxes) {
    if (box.id === source || box.id === target) continue;
    const t = segmentBoxEntry(a, b, box, 8);
    if (t === null || (nearest && t >= nearest.t)) continue;
    nearest = { box, t };
  }
  return nearest?.box ?? null;
}

function cornersToward(a: Pt, b: Pt, box: RouteBox, bias: number): Pt[] {
  const pad = 10;
  const dx = b.x - a.x, dy = b.y - a.y;
  // Use both corners of a side. A single diagonal corner can cut back through a
  // wide note, whereas the pair creates a safe channel around its full edge.
  const side = Math.sign(dx * (box.y - a.y) - dy * (box.x - a.x)) || bias;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const y = box.y + (side > 0 ? box.h / 2 + pad : -box.h / 2 - pad);
    return dx >= 0 ? [{ x: box.x - box.w / 2 - pad, y }, { x: box.x + box.w / 2 + pad, y }]
      : [{ x: box.x + box.w / 2 + pad, y }, { x: box.x - box.w / 2 - pad, y }];
  }
  const x = box.x + (side > 0 ? box.w / 2 + pad : -box.w / 2 - pad);
  return dy >= 0 ? [{ x, y: box.y - box.h / 2 - pad }, { x, y: box.y + box.h / 2 + pad }]
    : [{ x, y: box.y + box.h / 2 + pad }, { x, y: box.y - box.h / 2 - pad }];
}

function segmentBoxEntry(a: Pt, b: Pt, box: RouteBox, pad: number): number | null {
  const hx = box.w / 2 + pad, hy = box.h / 2 + pad;
  let lo = 0, hi = 1;
  for (const [p, d, min, max] of [[a.x, b.x - a.x, box.x - hx, box.x + hx], [a.y, b.y - a.y, box.y - hy, box.y + hy]] as const) {
    if (Math.abs(d) < 1e-9) { if (p < min || p > max) return null; continue; }
    let x = (min - p) / d, y = (max - p) / d;
    if (x > y) [x, y] = [y, x];
    lo = Math.max(lo, x); hi = Math.min(hi, y);
    if (lo > hi) return null;
  }
  return lo;
}

export function sampleCubic(a: Pt, c1: Pt, c2: Pt, b: Pt, count = SAMPLE_COUNT): Pt[] {
  const points: Pt[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const u = 1 - t;
    points.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return points;
}

function controlPoint(a: Pt, b: Pt, bend: number): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: (a.x + b.x) / 2 - (dy / len) * bend, y: (a.y + b.y) / 2 + (dx / len) * bend };
}

export function radialBoundaryAnchor(n: RouteBox, other: Pt): RouteAnchor {
  const dx = other.x - n.x;
  const dy = other.y - n.y;
  const len = Math.hypot(dx, dy) || 1;
  const tx = Math.abs(dx) > 1e-6 ? (n.w / 2) / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > 1e-6 ? (n.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  const normal = tx <= ty ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) };
  const ux = dx / len;
  const uy = dy / len;
  const hx = normal.x * 0.55 + ux * 0.45;
  const hy = normal.y * 0.55 + uy * 0.45;
  const hl = Math.hypot(hx, hy) || 1;
  return { p: { x: n.x + dx * t, y: n.y + dy * t }, dir: { x: hx / hl, y: hy / hl } };
}

export function cubicControls(a: RouteAnchor, b: RouteAnchor, style: string): [Pt, Pt, Pt, Pt] | null {
  if (style === "straight") return null;
  const p1 = a.p;
  const p2 = b.p;
  const d1 = a.dir;
  const d2 = b.dir;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const direct = Math.hypot(dx, dy) || 1;
  const ux = dx / direct;
  const uy = dy / direct;
  // When both box exits already point along the direct route, a curve only adds
  // visual noise. Reserve curves for an actual turn around the node geometry.
  if (d1.x * ux + d1.y * uy > 0.92 && -d2.x * ux - d2.y * uy > 0.92) {
    // A degenerate cubic is geometrically a straight line, while retaining the
    // common cubic representation expected by the layout/routing pipeline.
    return [p1, p1, p2, p2];
  }
  const reach = (d: Pt) => Math.abs(d.x) * Math.abs(p2.x - p1.x) + Math.abs(d.y) * Math.abs(p2.y - p1.y);
  const organic = style === "organic";
  const base = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const k1 = organic ? 0.46 : 0.30;
  const k2 = organic ? 0.34 : 0.30;
  const off1 = Math.min(180, Math.max(18, reach(d1) * k1 + base * 0.05));
  const off2 = Math.min(180, Math.max(18, reach(d2) * k2 + base * 0.05));
  const bend = organic ? Math.max(-26, Math.min(26, (p2.y - p1.y) * 0.1 + (p2.x - p1.x) * 0.04)) : 0;
  const c1 = { x: p1.x + d1.x * off1 - d1.y * bend, y: p1.y + d1.y * off1 + d1.x * bend };
  const c2 = { x: p2.x + d2.x * off2 + d2.y * bend, y: p2.y + d2.y * off2 - d2.x * bend };
  return [p1, c1, c2, p2];
}

function sampleQuadratic(a: Pt, c: Pt, b: Pt): Pt[] {
  const points: Pt[] = [];
  for (let i = 0; i <= SAMPLE_COUNT; i++) {
    const t = i / SAMPLE_COUNT;
    const u = 1 - t;
    points.push({
      x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    });
  }
  return points;
}

function boxCollisions(points: Pt[], bounds: Bounds, boxes: RouteBox[], source: string, target: string) {
  let hits = 0;
  for (const box of boxes) {
    if (box.id === source || box.id === target) continue;
    if (
      box.x + box.w / 2 < bounds.minX - 4 ||
      box.x - box.w / 2 > bounds.maxX + 4 ||
      box.y + box.h / 2 < bounds.minY - 4 ||
      box.y - box.h / 2 > bounds.maxY + 4
    ) continue;
    for (let i = 1; i < points.length; i++) {
      if (segmentHitsBox(points[i - 1], points[i], box)) {
        hits++;
        break;
      }
    }
  }
  return hits;
}

function lineConflicts(points: Pt[], bounds: Bounds, lines: IndexedLine[], source: string, target: string) {
  let cost = 0;
  const segments = polylineSegments(points);
  for (const line of lines) {
    if (!boundsOverlap(bounds, line.bounds, 6)) continue;
    const shared: [0 | 1, 0 | 1][] = [];
    if (source === line.source) shared.push([0, 0]);
    if (source === line.target) shared.push([0, 1]);
    if (target === line.source) shared.push([1, 0]);
    if (target === line.target) shared.push([1, 1]);
    for (let i = 0; i < segments.length; i++) {
      const a = segments[i];
      for (let j = 0; j < line.segments.length; j++) {
        const b = line.segments[j];
        const atSharedEndpoint = shared.some(([candidateEnd, lineEnd]) =>
          (candidateEnd === 0 ? i < 2 : i >= segments.length - 2) &&
          (lineEnd === 0 ? j < 2 : j >= line.segments.length - 2)
        );
        if (atSharedEndpoint) continue;
        if (!boundsOverlap(a.bounds, b.bounds, 6)) continue;
        if (segmentsCross(a.a, a.b, b.a, b.b)) {
          cost += 500;
          continue;
        }
        const separation = segmentDistance(a.a, a.b, b.a, b.b);
        if (separation < 6) cost += (6 - separation) * 4;
      }
    }
  }
  return cost;
}

function segmentHitsBox(a: Pt, b: Pt, box: RouteBox) {
  const hx = box.w / 2 + 4;
  const hy = box.h / 2 + 4;
  let lo = 0;
  let hi = 1;
  for (const [p, d, min, max] of [
    [a.x, b.x - a.x, box.x - hx, box.x + hx],
    [a.y, b.y - a.y, box.y - hy, box.y + hy],
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (p < min || p > max) return false;
      continue;
    }
    let t0 = (min - p) / d;
    let t1 = (max - p) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    lo = Math.max(lo, t0);
    hi = Math.min(hi, t1);
    if (lo > hi) return false;
  }
  return true;
}

function boundsOf(points: Pt[]): Bounds {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

function indexLine(line: RouteLine): IndexedLine {
  return { ...line, bounds: boundsOf(line.points), segments: polylineSegments(line.points) };
}

function polylineSegments(points: Pt[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    out.push({
      a,
      b,
      bounds: { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) },
    });
  }
  return out;
}

function boundsOverlap(a: Bounds, b: Bounds, padding: number) {
  return !(
    a.maxX + padding < b.minX ||
    b.maxX + padding < a.minX ||
    a.maxY + padding < b.minY ||
    b.maxY + padding < a.minY
  );
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
  const orient = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
}

function segmentDistance(a: Pt, b: Pt, c: Pt, d: Pt) {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b)
  );
}

function pointSegmentDistance(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function routeLength(points: Pt[]) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
  return length;
}

function distance(a: Pt, b: Pt) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
