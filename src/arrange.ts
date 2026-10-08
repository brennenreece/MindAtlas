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
 * (its automatic position, root at 0,0). Radial mode gives each subtree an
 * angular sector and places depth rings far enough apart for their node boxes.
 */
export function arrange(root: MapNode, edges: Edge[], mode: LayoutMode, spacing: number, crossLinks: Edge[] = []) {
  const kids = childMap(edges);
  root.bx = 0;
  root.by = 0;
  if (mode === "tree") arrangeTree(root, kids, spacing);
  else arrangeRadial(root, kids, spacing, crossLinks);
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
const ROOT_ANGLE = -Math.PI / 2;
const TAU = Math.PI * 2;

function boxesTouch(a: Box, b: Box, pad: number) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + pad && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + pad;
}

function arrangeRadial(root: MapNode, kids: Map<MapNode, MapNode[]>, spacing: number, crossLinks: Edge[]) {
  const angle = new Map<MapNode, number>();
  const sector = new Map<MapNode, [number, number]>();
  const weight = new Map<MapNode, number>();
  const links = new Map<MapNode, number>();
  for (const edge of crossLinks) {
    links.set(edge.from, (links.get(edge.from) ?? 0) + 1);
    links.set(edge.to, (links.get(edge.to) ?? 0) + 1);
  }

  const measure = (n: MapNode): number => {
    const children = kids.get(n) ?? [];
    const own = Math.max(40, n.w, n.h);
    const childDemand = children.reduce((sum, child) => sum + measure(child), 0) + Math.max(0, children.length - 1) * spacing * 0.25;
    const linkDemand = (links.get(n) ?? 0) * Math.min(12, spacing * 0.25);
    const total = Math.max(own, childDemand) + linkDemand;
    weight.set(n, total);
    return total;
  };

  const assign = (n: MapNode, start: number, end: number) => {
    angle.set(n, (start + end) / 2);
    sector.set(n, [start, end]);
    const children = kids.get(n) ?? [];
    const total = children.reduce((sum, child) => sum + weight.get(child)!, 0) || 1;
    let cursor = start;
    for (const child of children) {
      const span = (end - start) * weight.get(child)! / total;
      assign(child, cursor, cursor + span);
      cursor += span;
    }
  };

  const rootKids = kids.get(root) ?? [];
  for (const child of rootKids) measure(child);
  const outgoing = rootKids.filter((n) => n.side !== -1);
  const incoming = rootKids.filter((n) => n.side === -1);
  const spread = (nodes: MapNode[], start: number, end: number) => {
    const total = nodes.reduce((sum, n) => sum + weight.get(n)!, 0) || 1;
    let cursor = start;
    for (const n of nodes) {
      const span = (end - start) * weight.get(n)! / total;
      assign(n, cursor, cursor + span);
      cursor += span;
    }
  };

  if (outgoing.length && incoming.length) {
    spread(outgoing, -Math.PI / 2, Math.PI / 2);
    spread(incoming, Math.PI / 2, Math.PI * 1.5);
  } else {
    spread(rootKids, ROOT_ANGLE, ROOT_ANGLE + Math.PI * 2);
  }

  sector.set(root, [ROOT_ANGLE, ROOT_ANGLE + TAU]);
  let level = rootKids;
  let radius = 0;
  let previousOuter = Math.hypot(root.w / 2, root.h / 2);
  const pad = Math.max(4, Math.min(16, spacing * 0.2));
  const step = Math.max(4, spacing * 0.1);
  const placedBoxes: Box[] = [{ x: 0, y: 0, w: root.w, h: root.h }];

  while (level.length) {
    const outer = Math.max(...level.map((n) => Math.hypot(n.w / 2, n.h / 2)));
    radius = Math.max(
      radius + previousOuter + outer + spacing,
      minimumRingRadius(level, angle, pad)
    );

    const positions = () => level.map((n) => {
      const a = angle.get(n)!;
      return { node: n, box: { x: Math.cos(a) * radius, y: Math.sin(a) * radius, w: n.w, h: n.h } };
    });
    let placed = positions();
    while (hasOverlaps([...placedBoxes, ...placed.map((p) => p.box)], pad)) {
      radius += step;
      placed = positions();
    }

    for (const { node, box } of placed) {
      node.bx = box.x;
      node.by = box.y;
      placedBoxes.push(box);
    }
    previousOuter = outer;
    level = level.flatMap((n) => kids.get(n) ?? []);
  }
  settleRadial(root, kids, sector, angle, spacing, crossLinks);
}

function hasOverlaps(boxes: Box[], pad: number) {
  const ordered = [...boxes].sort((a, b) => a.x - b.x || a.y - b.y);
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[j].x - ordered[i].x >= (ordered[i].w + ordered[j].w) / 2 + pad) break;
      if (boxesTouch(ordered[i], ordered[j], pad)) return true;
    }
  }
  return false;
}

function minimumRingRadius(nodes: MapNode[], angles: Map<MapNode, number>, pad: number) {
  if (nodes.length < 2) return 0;
  const ordered = [...nodes].sort((a, b) => angles.get(a)! - angles.get(b)!);
  let radius = 0;
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    const b = ordered[(i + 1) % ordered.length];
    const delta = i === ordered.length - 1
      ? angles.get(b)! + Math.PI * 2 - angles.get(a)!
      : angles.get(b)! - angles.get(a)!;
    const chord = 2 * Math.sin(delta / 2);
    if (chord > 1e-6) {
      const halfA = Math.hypot(a.w / 2, a.h / 2);
      const halfB = Math.hypot(b.w / 2, b.h / 2);
      radius = Math.max(radius, (halfA + halfB + pad) / chord);
    }
  }
  return radius;
}

function settleRadial(
  root: MapNode,
  kids: Map<MapNode, MapNode[]>,
  sectors: Map<MapNode, [number, number]>,
  angles: Map<MapNode, number>,
  spacing: number,
  crossLinks: Edge[]
) {
  const nodes: MapNode[] = [];
  const parent = new Map<MapNode, MapNode>();
  const visit = (n: MapNode) => {
    for (const child of kids.get(n) ?? []) {
      nodes.push(child);
      parent.set(child, n);
      visit(child);
    }
  };
  visit(root);
  if (!nodes.length) return;

  const velocities = new Map(nodes.map((n) => [n, { x: 0, y: 0 }]));
  const forces = new Map<MapNode, Pt>();
  const position = new Map<MapNode, Pt>(nodes.map((n) => [n, { x: n.bx, y: n.by }]));
  position.set(root, { x: 0, y: 0 });
  const clearance = Math.max(8, Math.min(28, spacing * 0.35));
  const cellSize = Math.max(...nodes.map((n) => Math.max(n.w, n.h))) + clearance;
  const index = new Map(nodes.map((n, i) => [n, i]));
  const treeLinks = nodes.map((n) => ({ from: parent.get(n)!, to: n }));
  const crossSprings = crossLinks.filter((e) => sectors.has(e.from) && sectors.has(e.to));
  const add = (n: MapNode, x: number, y: number) => {
    if (n === root) return;
    const f = forces.get(n)!;
    f.x += x;
    f.y += y;
  };
  const radius = (n: MapNode) => Math.hypot(n.w / 2, n.h / 2);

  const steps = nodes.length > 800 ? 100 : 160;
  for (let step = 0; step < steps; step++) {
    for (const n of nodes) forces.set(n, { x: 0, y: 0 });

    for (const { from, to } of treeLinks) {
      const a = position.get(from)!;
      const b = position.get(to)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const target = radius(from) + radius(to) + spacing * 0.55;
      const force = (length - target) * 0.028;
      add(to, -dx / length * force, -dy / length * force);
      if (from !== root) add(from, dx / length * force, dy / length * force);
    }

    for (const { from, to } of crossSprings) {
      const a = position.get(from)!;
      const b = position.get(to)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const target = (radius(from) + radius(to) + spacing) * 2;
      const force = Math.max(0, length - target) * 0.004;
      add(to, -dx / length * force, -dy / length * force);
      add(from, dx / length * force, dy / length * force);
    }

    const cells = new Map<string, MapNode[]>();
    for (const n of nodes) {
      const p = position.get(n)!;
      const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)}`;
      const cell = cells.get(key) ?? [];
      cell.push(n);
      cells.set(key, cell);
    }
    for (const a of nodes) {
      const pa = position.get(a)!;
      const cx = Math.floor(pa.x / cellSize);
      const cy = Math.floor(pa.y / cellSize);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (const b of cells.get(`${cx + ox},${cy + oy}`) ?? []) {
            if (index.get(b)! <= index.get(a)!) continue;
            const pb = position.get(b)!;
            const dx = pb.x - pa.x;
            const dy = pb.y - pa.y;
            const overlapX = (a.w + b.w) / 2 + clearance - Math.abs(dx);
            const overlapY = (a.h + b.h) / 2 + clearance - Math.abs(dy);
            if (overlapX <= 0 || overlapY <= 0) continue;
            const force = Math.max(overlapX, overlapY) * 20;
            const distance = Math.hypot(dx, dy) || 1;
            add(a, -dx / distance * force, -dy / distance * force);
            add(b, dx / distance * force, dy / distance * force);
          }
        }
      }
    }

    const cooling = 1 - step / steps;
    const maxMove = Math.max(1.5, spacing * (0.08 + cooling * 0.2));
    for (const n of nodes) {
      const p = position.get(n)!;
      const v = velocities.get(n)!;
      const f = forces.get(n)!;
      let vx = (v.x + f.x - p.x * 0.0012) * 0.72;
      let vy = (v.y + f.y - p.y * 0.0012) * 0.72;
      const speed = Math.hypot(vx, vy);
      if (speed > maxMove) {
        vx *= maxMove / speed;
        vy *= maxMove / speed;
      }

      let x = p.x + vx;
      let y = p.y + vy;
      const [start, end] = sectors.get(n)!;
      const center = angles.get(n)!;
      const angularSlack = (end - start) * 0.15;
      const theta = clampToSector(Math.atan2(y, x), center - angularSlack, center + angularSlack);
      let dist = Math.hypot(x, y);
      const parentNode = parent.get(n)!;
      const parentPos = position.get(parentNode)!;
      const minimumRadius = Math.hypot(parentPos.x, parentPos.y) + radius(parentNode) + radius(n) + clearance * 0.35;
      dist = Math.max(dist, minimumRadius);
      x = Math.cos(theta) * dist;
      y = Math.sin(theta) * dist;
      position.set(n, { x, y });
      velocities.set(n, { x: vx, y: vy });
    }
  }

  for (const n of nodes) {
    const p = position.get(n)!;
    n.bx = p.x;
    n.by = p.y;
  }
}

function clampToSector(angle: number, start: number, end: number) {
  if (end - start >= TAU - 1e-6) return angle;
  const relative = ((angle - start) % TAU + TAU) % TAU;
  if (relative <= end - start) return angle;
  const toStart = Math.abs(Math.atan2(Math.sin(angle - start), Math.cos(angle - start)));
  const toEnd = Math.abs(Math.atan2(Math.sin(angle - end), Math.cos(angle - end)));
  return toStart <= toEnd ? start : end;
}
