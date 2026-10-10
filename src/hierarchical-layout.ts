import type { Edge, MapNode } from "./tree";

/**
 * Tidy two-sided mind-map layout.
 *
 * Each subtree is assigned a vertical territory based on the measured boxes of
 * all of its descendants. Nodes are then placed in fixed depth columns, which
 * keeps branches together and makes the result stable when a title wraps.
 */
export function arrangeHierarchical(root: MapNode, edges: Edge[], spacing: number) {
  const children = new Map<MapNode, MapNode[]>();
  for (const edge of edges) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from)!.push(edge.to);
  }

  const pad = Math.max(10, Math.min(28, spacing * 0.35));
  const gap = Math.max(12, spacing * 0.55);
  const spans = new Map<MapNode, number>();
  const measure = (node: MapNode): number => {
    const kids = children.get(node) ?? [];
    const own = node.h + pad * 2;
    const childSpan = kids.reduce((sum, child) => sum + measure(child), 0) + gap * Math.max(0, kids.length - 1);
    const span = Math.max(own, childSpan);
    spans.set(node, span);
    return span;
  };
  measure(root);

  root.bx = 0;
  root.by = 0;

  for (const side of [-1, 1] as const) {
    const roots = (children.get(root) ?? []).filter((node) => (node.side === -1 ? -1 : 1) === side);
    if (!roots.length) continue;

    // Allocate a shared x column for each depth. This avoids zig-zagging
    // branches and ensures the gap is large enough for the widest box there.
    const widths = new Map<number, number>();
    const visitWidths = (node: MapNode, depth: number) => {
      widths.set(depth, Math.max(widths.get(depth) ?? 0, node.w + pad * 2));
      for (const child of children.get(node) ?? []) visitWidths(child, depth + 1);
    };
    roots.forEach((node) => visitWidths(node, 1));

    const columns = new Map<number, number>();
    let distance = root.w / 2 + spacing;
    for (let depth = 1; widths.has(depth); depth++) {
      const width = widths.get(depth)!;
      columns.set(depth, distance + width / 2);
      distance += width + spacing;
    }

    const total = roots.reduce((sum, node) => sum + spans.get(node)!, 0) + gap * (roots.length - 1);
    let cursor = -total / 2;
    const place = (node: MapNode, top: number, depth: number) => {
      const span = spans.get(node)!;
      node.bx = side * columns.get(depth)!;
      node.by = top + span / 2;
      const kids = children.get(node) ?? [];
      if (!kids.length) return;
      const block = kids.reduce((sum, child) => sum + spans.get(child)!, 0) + gap * (kids.length - 1);
      let childTop = node.by - block / 2;
      for (const child of kids) {
        place(child, childTop, depth + 1);
        childTop += spans.get(child)! + gap;
      }
    };
    for (const node of roots) {
      place(node, cursor, 1);
      cursor += spans.get(node)! + gap;
    }
  }
}
