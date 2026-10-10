import assert from "node:assert/strict";
import { build } from "esbuild";
import test from "node:test";

const load = async (name) => {
  const bundle = await build({ entryPoints: [`src/${name}.ts`], bundle: true, format: "esm", platform: "node", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
};

const { arrange, relieveBlockers } = await load("layout");
const { routeLine, segmentHitsBox } = await load("lines");

const node = (path, w = 90, h = 30, side = 1) => ({ file: { path }, w, h, side, bx: 0, by: 0, gx: 0, gy: 0, x: 0, y: 0 });
const edge = (from, to) => ({ from, to, fwd: true, back: false, kind: "child" });

function tree(spec) {
  const nodes = [];
  const edges = [];
  const make = (name, kids = []) => {
    const n = node(name);
    nodes.push(n);
    for (const k of kids) edges.push(edge(n, make(...k)));
    return n;
  };
  const root = make(...spec);
  return { root, nodes, edges };
}

const sample = () =>
  tree(["root", [
    ["a", [["a1"], ["a2"], ["a3", [["a31"], ["a32"]]]]],
    ["b", [["b1"], ["b2"]]],
    ["c"],
    ["d", [["d1"], ["d2"], ["d3"], ["d4"]]],
  ]]);

const box = (n) => ({ id: n.file.path, x: n.bx, y: n.by, w: n.w, h: n.h });

test("no boxes overlap", () => {
  const { root, nodes, edges } = sample();
  arrange(root, edges, 50);
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      assert.ok(
        Math.abs(a.bx - b.bx) >= (a.w + b.w) / 2 || Math.abs(a.by - b.by) >= (a.h + b.h) / 2,
        `${a.file.path} overlaps ${b.file.path}`
      );
    }
});

test("each generation sits on its own ring, outward from its parent", () => {
  const { root, nodes, edges } = sample();
  arrange(root, edges, 50);
  const r = (n) => Math.hypot(n.bx, n.by);
  for (const e of edges) assert.ok(r(e.to) > r(e.from));
  const depth = (n) => (n === root ? 0 : 1 + depth(edges.find((e) => e.to === n).from));
  const byDepth = new Map();
  for (const n of nodes) byDepth.set(depth(n), [...(byDepth.get(depth(n)) ?? []), r(n)]);
  for (const radii of byDepth.values()) assert.ok(Math.max(...radii) - Math.min(...radii) < 1e-6);
});

test("a branch stays grouped around its own direction", () => {
  const { root, nodes, edges } = sample();
  arrange(root, edges, 50);
  const topChildren = edges.filter((e) => e.from === root).map((e) => e.to);
  const branchOf = (n) => (topChildren.includes(n) ? n : branchOf(edges.find((e) => e.to === n).from));
  for (const n of nodes) {
    if (n === root) continue;
    const b = branchOf(n);
    const a = Math.atan2(n.by, n.bx) - Math.atan2(b.by, b.bx);
    assert.ok(Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < Math.PI / 2, `${n.file.path} strays from ${b.file.path}`);
  }
});

test("an only child continues straight out from its parent", () => {
  const { root, nodes, edges } = tree(["root", [["a", [["a1"]]]]]);
  arrange(root, edges, 50);
  const [, a, a1] = nodes;
  assert.ok(Math.abs(a.bx * a1.by - a.by * a1.bx) < 1e-6);
});

test("lines are straight when clear and never bend more than once", () => {
  const a = { id: "a", x: 0, y: 0, w: 80, h: 30 };
  const b = { id: "b", x: 300, y: 40, w: 80, h: 30 };
  const clear = routeLine(a, b, [a, b]);
  assert.equal(clear.kind, "straight");
  assert.equal(clear.blockers.length, 0);

  const wall = { id: "w", x: 150, y: 20, w: 40, h: 30 };
  const bent = routeLine(a, b, [a, b, wall]);
  assert.notEqual(bent.kind, "straight");
  assert.equal(bent.blockers.length, 0);
  assert.equal((bent.d.match(/[QC]/g) ?? []).length, 1);
  assert.ok(!/L/.test(bent.d));
});

test("hierarchy lines clear every note", () => {
  const { root, nodes, edges } = sample();
  arrange(root, edges, 50);
  const boxes = nodes.map(box);
  for (const e of edges) {
    const shape = routeLine(box(e.from), box(e.to), boxes);
    assert.equal(shape.blockers.length, 0, `${e.from.file.path}->${e.to.file.path}`);
  }
});

test("relieveBlockers moves a note off a line, not the line's endpoints", () => {
  const { nodes } = tree(["root", [["a"], ["b"]]]);
  const [r, a, b] = nodes;
  r.gx = 0; r.gy = 0;
  a.gx = 400; a.gy = 0;
  b.gx = 200; b.gy = 6;
  b.w = 60; b.h = 30;
  relieveBlockers(r, [edge(r, a)], nodes, new Set());
  assert.equal(a.gx, 400);
  assert.ok(!segmentHitsBox({ x: r.gx, y: r.gy }, { x: a.gx, y: a.gy }, { x: b.gx, y: b.gy, w: b.w, h: b.h }, 0));
});

test("a note with two parents is placed once and its second line is clear", () => {
  const { root, nodes, edges } = tree(["root", [["p1", [["kid"]]], ["p2"]]]);
  const extra = edge(nodes.find((n) => n.file.path === "p2"), nodes.find((n) => n.file.path === "kid"));
  arrange(root, edges, 50, [extra]);
  assert.ok(nodes.every((n) => Number.isFinite(n.bx) && Number.isFinite(n.by)));
  const shape = routeLine(box(extra.from), box(extra.to), nodes.map(box));
  assert.equal(shape.blockers.length, 0);
});
