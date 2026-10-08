import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")) },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
