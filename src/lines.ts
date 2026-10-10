export interface Pt {
  x: number;
  y: number;
}

export interface LineBox extends Pt {
  id?: string;
  w: number;
  h: number;
}

export interface LineShape {
  /** SVG path: a straight segment, one quadratic arc, or one cubic S-curve. */
  d: string;
  kind: "straight" | "arc" | "s";
  start: Pt;
  end: Pt;
  /** Unit direction of travel where the line enters the target. */
  endDir: Pt;
  /** Boxes still crossed by the chosen shape (empty when the line is clear). */
  blockers: LineBox[];
}

const CLEARANCE = 6;
const SAMPLES = 24;

/** Where the ray from a box's center toward `to` leaves the box. */
export function boxEdge(box: LineBox, to: Pt): Pt {
  const dx = to.x - box.x;
  const dy = to.y - box.y;
  if (dx === 0 && dy === 0) return { x: box.x, y: box.y };
  const t = Math.min(
    dx === 0 ? Infinity : box.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.h / 2 / Math.abs(dy)
  );
  return { x: box.x + dx * t, y: box.y + dy * t };
}

/** Does the segment pass through the box grown by `pad`? */
export function segmentHitsBox(a: Pt, b: Pt, box: LineBox, pad = CLEARANCE): boolean {
  const hx = box.w / 2 + pad;
  const hy = box.h / 2 + pad;
  let lo = 0;
  let hi = 1;
  for (const [p, d, min, max] of [
    [a.x, b.x - a.x, box.x - hx, box.x + hx],
    [a.y, b.y - a.y, box.y - hy, box.y + hy],
  ] as const) {
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

function unit(from: Pt, to: Pt): Pt {
  const l = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: (to.x - from.x) / l, y: (to.y - from.y) / l };
}

function quad(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
}

function cubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
}

function blockedBy(points: Pt[], boxes: LineBox[], a: LineBox, b: LineBox): LineBox[] {
  const hit: LineBox[] = [];
  for (const box of boxes) {
    if (box === a || box === b || (box.id !== undefined && (box.id === a.id || box.id === b.id))) continue;
    for (let i = 1; i < points.length; i++) {
      if (segmentHitsBox(points[i - 1], points[i], box)) {
        hit.push(box);
        break;
      }
    }
  }
  return hit;
}

/**
 * Draw the line between two notes: straight when the way is clear, otherwise
 * the gentlest single arc, otherwise one gentle S-curve. Never more than one bend.
 */
export function routeLine(a: LineBox, b: LineBox, boxes: LineBox[]): LineShape {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dir = unit(a, b);
  const normal = { x: -dir.y, y: dir.x };

  const straight = (): LineShape => {
    const start = boxEdge(a, b);
    const end = boxEdge(b, a);
    return {
      d: `M${start.x},${start.y} L${end.x},${end.y}`,
      kind: "straight",
      start,
      end,
      endDir: unit(start, end),
      blockers: blockedBy([start, end], boxes, a, b),
    };
  };

  const arc = (bow: number): LineShape => {
    const c = { x: (a.x + b.x) / 2 + normal.x * bow * 2, y: (a.y + b.y) / 2 + normal.y * bow * 2 };
    const start = boxEdge(a, c);
    const end = boxEdge(b, c);
    const points = Array.from({ length: SAMPLES + 1 }, (_, i) => quad(start, c, end, i / SAMPLES));
    return {
      d: `M${start.x},${start.y} Q${c.x},${c.y} ${end.x},${end.y}`,
      kind: "arc",
      start,
      end,
      endDir: unit(c, end),
      blockers: blockedBy(points, boxes, a, b),
    };
  };

  const sCurve = (off: number): LineShape => {
    const c1 = { x: a.x + (b.x - a.x) / 3 + normal.x * off, y: a.y + (b.y - a.y) / 3 + normal.y * off };
    const c2 = { x: a.x + ((b.x - a.x) * 2) / 3 - normal.x * off, y: a.y + ((b.y - a.y) * 2) / 3 - normal.y * off };
    const start = boxEdge(a, c1);
    const end = boxEdge(b, c2);
    const points = Array.from({ length: SAMPLES + 1 }, (_, i) => cubic(start, c1, c2, end, i / SAMPLES));
    return {
      d: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`,
      kind: "s",
      start,
      end,
      endDir: unit(c2, end),
      blockers: blockedBy(points, boxes, a, b),
    };
  };

  const candidates: (() => LineShape)[] = [straight];
  for (const f of [0.1, 0.18, 0.26]) {
    const bow = Math.min(80, Math.max(12, len * f)) * Math.min(1, len / 60);
    candidates.push(() => arc(bow), () => arc(-bow));
  }
  for (const f of [0.12, 0.2]) {
    const off = Math.min(70, Math.max(12, len * f)) * Math.min(1, len / 60);
    candidates.push(() => sCurve(off), () => sCurve(-off));
  }

  let best: LineShape | null = null;
  for (const make of candidates) {
    const shape = make();
    if (!shape.blockers.length) return shape;
    if (!best || shape.blockers.length < best.blockers.length) best = shape;
  }
  return best!;
}

/** Triangle with its tip at `tip`, pointing along `dir`. */
export function arrowHead(tip: Pt, dir: Pt, size: number): string {
  const bx = tip.x - dir.x * size;
  const by = tip.y - dir.y * size;
  const w = size * 0.45;
  const px = -dir.y * w;
  const py = dir.x * w;
  return `M${tip.x},${tip.y} L${bx + px},${by + py} L${bx - px},${by - py} Z`;
}
