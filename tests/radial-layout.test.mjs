import assert from "node:assert/strict";
import { build } from "esbuild";
import test from "node:test";

const load = async (name) => {
  const bundle = await build({
    entryPoints: [`src/${name}.ts`],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const output = bundle.outputFiles[0];
  return import(`data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`);
};

const { arrange } = await load("arrange");
const { cubicControls, radialBoundaryAnchor, routeCrossLinks, sampleCubic } = await load("radial-routing");

function node(path, w = 90, h = 30, side = 1) {
  return { file: { path }, w, h, side, bx: 0, by: 0 };
}

function edge(from, to) {
  return { from, to, fwd: true, back: false };
}

function assertNoOverlaps(nodes, padding = 4) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      assert.ok(
        Math.abs(a.bx - b.bx) >= (a.w + b.w) / 2 + padding ||
          Math.abs(a.by - b.by) >= (a.h + b.h) / 2 + padding,
        `${a.file.path} overlaps ${b.file.path}`
      );
    }
  }
}

function segmentsCross(a, b, c, d) {
  const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
}

function countTreeCrossings(edges) {
  const curves = edges.map((edge) => {
    const from = { id: edge.from.file.path, x: edge.from.bx, y: edge.from.by, w: edge.from.w, h: edge.from.h };
    const to = { id: edge.to.file.path, x: edge.to.bx, y: edge.to.by, w: edge.to.w, h: edge.to.h };
    const a = radialBoundaryAnchor(from, to);
    const b = radialBoundaryAnchor(to, from);
    return sampleCubic(...cubicControls(a, b, "curved"));
  });
  let count = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i];
      const b = edges[j];
      if ([a.from, a.to].some((n) => n === b.from || n === b.to)) continue;
      for (let ai = 1; ai < curves[i].length; ai++) {
        for (let bi = 1; bi < curves[j].length; bi++) {
          if (segmentsCross(curves[i][ai - 1], curves[i][ai], curves[j][bi - 1], curves[j][bi])) count++;
        }
      }
    }
  }
  return count;
}

function treeEdgesHitOtherBoxes(edges, nodes) {
  const curves = edges.map((edge) => {
    const from = { id: edge.from.file.path, x: edge.from.bx, y: edge.from.by, w: edge.from.w, h: edge.from.h };
    const to = { id: edge.to.file.path, x: edge.to.bx, y: edge.to.by, w: edge.to.w, h: edge.to.h };
    return sampleCubic(...cubicControls(radialBoundaryAnchor(from, to), radialBoundaryAnchor(to, from), "curved"));
  });
  let hits = 0;
  for (let i = 0; i < edges.length; i++) {
    for (const node of nodes) {
      if (node === edges[i].from || node === edges[i].to) continue;
      const box = { x: node.bx, y: node.by, w: node.w, h: node.h };
      for (let j = 1; j < curves[i].length; j++) {
        if (segmentHitsBox(curves[i][j - 1], curves[i][j], box)) {
          hits++;
          break;
        }
      }
    }
  }
  return hits;
}

function segmentHitsBox(a, b, box) {
  let lo = 0;
  let hi = 1;
  const hx = box.w / 2 + 2;
  const hy = box.h / 2 + 2;
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

test("radial sectors produce deterministic, separated nodes and non-crossing tree edges", () => {
  const root = node("root", 160, 72, 0);
  const nodes = [root];
  const edges = [];
  const branches = [];
  for (let i = 0; i < 6; i++) {
    const branch = node(`branch-${i}`, 80 + i * 11, 34 + (i % 2) * 16);
    nodes.push(branch);
    branches.push(branch);
    edges.push(edge(root, branch));
    let parent = branch;
    for (let j = 0; j < 3; j++) {
      const child = node(`branch-${i}-${j}`, j === 1 ? 210 : 72, 32 + j * 5);
      nodes.push(child);
      edges.push(edge(parent, child));
      parent = child;
    }
  }
  const references = [edge(nodes[2], nodes[15]), edge(nodes[7], nodes[20]), edge(nodes[12], nodes[3])];

  arrange(root, edges, "radial", 50, references);
  const first = nodes.map((n) => [n.bx, n.by]);
  arrange(root, edges, "radial", 50, references);

  assert.deepEqual(nodes.map((n) => [n.bx, n.by]), first);
  assertNoOverlaps(nodes);
  assert.equal(countTreeCrossings(edges), 0);
  assert.equal(treeEdgesHitOtherBoxes(edges, nodes), 0);
});

test("radial layout keeps backlinks opposite outgoing root branches", () => {
  const root = node("root", 120, 50, 0);
  const right = node("outgoing", 100, 36, 1);
  const left = node("backlink", 100, 36, -1);
  const edges = [edge(root, right), edge(root, left)];

  arrange(root, edges, "radial", 50);

  assert.ok(right.bx > 0);
  assert.ok(left.bx < 0);
  assertNoOverlaps([root, right, left]);
});

test("radial star expands its ring enough to keep a large sibling set separate", () => {
  const root = node("root", 120, 48, 0);
  const children = Array.from({ length: 400 }, (_, i) => node(`child-${i}`, 70 + (i % 5) * 12, 30 + (i % 3) * 8));
  const edges = children.map((child) => edge(root, child));

  arrange(root, edges, "radial", 50);

  assertNoOverlaps([root, ...children]);
});

test("cross-link weights do not change the two-sided tree layout", () => {
  const makeTree = () => {
    const root = node("root", 120, 48, 0);
    const left = node("left", 90, 34, -1);
    const right = node("right", 100, 36, 1);
    const child = node("child", 80, 32, 1);
    const edges = [edge(root, left), edge(root, right), edge(right, child)];
    return { root, nodes: [root, left, right, child], edges, crossLinks: [edge(left, child)] };
  };
  const plain = makeTree();
  const withLinks = makeTree();
  arrange(plain.root, plain.edges, "tree", 50);
  arrange(withLinks.root, withLinks.edges, "tree", 50, withLinks.crossLinks);

  assert.deepEqual(
    withLinks.nodes.map((n) => [n.bx, n.by]),
    plain.nodes.map((n) => [n.bx, n.by])
  );
});

test("cross-link routing bends around nodes and existing connectors", () => {
  const boxes = [
    { id: "from", x: -140, y: 0, w: 40, h: 30 },
    { id: "to", x: 140, y: 0, w: 40, h: 30 },
    { id: "blocker", x: 0, y: 0, w: 58, h: 76 },
  ];
  const links = [{
    key: "from-to",
    source: "from",
    target: "to",
    start: { x: -120, y: 0 },
    end: { x: 120, y: 0 },
  }];
  const occupied = [{
    source: "other-a",
    target: "other-b",
    points: [{ x: -150, y: 95 }, { x: 150, y: 95 }],
  }];
  const route = routeCrossLinks(links, boxes, occupied).get("from-to");

  assert.ok(route);
  assert.ok(route.points.every((p) => Math.abs(p.x) > 34 || Math.abs(p.y) > 42));
  assert.ok(route.control.y < 0 || route.control.y > 0);
});

test("cross-link routing chooses the side that clears an existing edge", () => {
  const link = {
    key: "left-right",
    source: "left",
    target: "right",
    start: { x: -120, y: 0 },
    end: { x: 120, y: 0 },
  };
  const barrier = {
    source: "top",
    target: "bottom",
    points: [{ x: 0, y: -40 }, { x: 0, y: 40 }],
  };
  const route = routeCrossLinks([link], [], [barrier]).get(link.key);

  assert.ok(route);
  assert.ok(Math.abs(route.control.y) > 80);
});

test("cross-links do not reuse a crossing route when another bend is available", () => {
  const links = [
    { key: "one", source: "a", target: "b", start: { x: -100, y: -100 }, end: { x: 100, y: 100 } },
    { key: "two", source: "c", target: "d", start: { x: -100, y: 100 }, end: { x: 100, y: -100 } },
  ];
  const routes = routeCrossLinks(links, [], []);
  const first = routes.get("one").points;
  const second = routes.get("two").points;
  let crossings = 0;
  for (let i = 1; i < first.length; i++) {
    for (let j = 1; j < second.length; j++) {
      if (segmentsCross(first[i - 1], first[i], second[j - 1], second[j])) crossings++;
    }
  }

  assert.equal(crossings, 0);
});
