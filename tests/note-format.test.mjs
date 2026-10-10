import assert from "node:assert/strict";
import { build } from "esbuild";
import test from "node:test";

const bundle = await build({ entryPoints: ["src/note-format.ts"], bundle: true, format: "esm", platform: "node", write: false });
const { addEntry, restructure, legacyParentNames, hasSection, entryLabel, withLabel } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

test("creates the Map block at the end", () => {
  const out = addEntry("Intro text\n", "Children", "- [[A]]");
  assert.equal(out, "Intro text\n\n## Map\n### Children\n- [[A]]\n");
});

test("adds to existing sections and orders Children before Connections", () => {
  let t = addEntry("Body\n", "Connections", "- [[C]]");
  t = addEntry(t, "Children", "- [[A]]");
  t = addEntry(t, "Children", "- [[B]]");
  assert.equal(t, "Body\n\n## Map\n### Children\n- [[A]]\n- [[B]]\n### Connections\n- [[C]]\n");
});

test("migrates legacy sections to the fixed block and drops Parents", () => {
  const legacy = "---\ntitle: x\n---\n## Parents\n- [[P]]\n## Children\n- [[A]]\n## Notes\nprose\n## Connections\n- [[C]]\n";
  assert.deepEqual(legacyParentNames(legacy), ["P"]);
  const out = restructure(legacy);
  assert.equal(out, "---\ntitle: x\n---\n## Notes\nprose\n\n## Map\n### Children\n- [[A]]\n### Connections\n- [[C]]\n");
  assert.equal(restructure(out), out);
});

test("keeps remarks after links and ignores headings in frontmatter and code", () => {
  const t = "---\n# comment\n---\n```\n## Children\n```\n## Children\n- [[A]] because\n";
  const out = restructure(t);
  assert.ok(out.endsWith("## Map\n### Children\n- [[A]] because\n"));
  assert.ok(out.includes("```\n## Children\n```"));
  assert.ok(hasSection(out, "Children"));
});

test("labels parse and write", () => {
  assert.equal(entryLabel(" — because"), "because");
  assert.equal(entryLabel(""), "");
  assert.equal(withLabel("[[A]]", "why"), "[[A]] — why");
  assert.equal(withLabel("[[A]]", ""), "[[A]]");
});
