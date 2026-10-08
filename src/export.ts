import { App, Notice } from "obsidian";
import type { MapNode } from "./tree";

const INLINE_PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "opacity",
  "font-size", "font-family", "font-weight", "text-anchor", "dominant-baseline", "display",
];

/** Serialize the map to a standalone SVG with computed styles inlined. */
export function mapToSvg(svg: SVGSVGElement, group: SVGGElement, nodes: MapNode[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.w / 2);
    x1 = Math.max(x1, n.x + n.w / 2);
    y0 = Math.min(y0, n.y - n.h / 2);
    y1 = Math.max(y1, n.y + n.h / 2);
  }
  const m = 30;
  x0 -= m; y0 -= m; x1 += m; y1 += m;
  const w = Math.ceil(x1 - x0);
  const h = Math.ceil(y1 - y0);

  const clone = svg.cloneNode(true) as SVGSVGElement;
  const cg = clone.querySelector("g")!;
  cg.setAttribute("transform", `translate(${-x0} ${-y0})`);
  const src = [group, ...Array.from(group.querySelectorAll("*"))];
  const dst = [cg, ...Array.from(cg.querySelectorAll("*"))];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const style = INLINE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";");
    dst[i].setAttribute("style", style);
  });
  dst.forEach((el) => {
    if (el.classList.contains("mind-atlas-hit") || el.classList.contains("mind-atlas-preview")) el.remove();
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
  clone.removeAttribute("class");
  clone.setAttribute("style", `background:${getComputedStyle(svg).backgroundColor || "#fff"}`);
  return { text: new XMLSerializer().serializeToString(clone), w, h };
}

export async function svgToPng(text: string, w: number, h: number): Promise<ArrayBuffer> {
  const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("could not render the map"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, w, h);
    const blob: Blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("PNG encoding failed"))), "image/png")
    );
    return await blob.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Save into the vault using the user's attachment-folder setting. */
export async function saveToVault(app: App, name: string, data: string | ArrayBuffer): Promise<string> {
  let path: string;
  try {
    path = await app.fileManager.getAvailablePathForAttachment(name);
  } catch {
    path = name;
  }
  if (typeof data === "string") await app.vault.create(path, data);
  else await app.vault.createBinary(path, data);
  new Notice(`Saved ${path}`);
  return path;
}

/** Indented markdown outline of the map, with [[links]]. */
export function toOutline(root: MapNode, kids: Map<MapNode, MapNode[]>): string {
  const lines: string[] = [];
  const walk = (n: MapNode, d: number) => {
    lines.push(`${"  ".repeat(d)}- [[${n.file.basename}]]`);
    for (const k of kids.get(n) ?? []) walk(k, d + 1);
  };
  walk(root, 0);
  return lines.join("\n") + "\n";
}

