import { ItemView, Menu, Notice, Platform, TFile, WorkspaceLeaf } from "obsidian";
import type MindAtlasPlugin from "./main";
import { fi, iconCategories, iconSvg, resolveIcon, setFeather as setIcon } from "./icons";
import { NoteEditor } from "./editor";
import { addConnection, addLink, createNote, removeChild, removeLinks, sanitizeTitle } from "./links";
import { mapToSvg, saveToVault, svgToPng, toOutline } from "./export";
import { NoteFinder } from "./finder";
import { askChoice } from "./modals";
import { applyOffsets, arrange, childMap, Pt } from "./arrange";
import { UndoStack } from "./undo";
import { buildGraph, Edge, MapGraph, MapNode } from "./tree";

export const VIEW_TYPE_MINDATLAS = "mind-atlas-view";
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_TEXT_W = 320;

type Side = "L" | "R" | "T" | "B";
interface Anchor {
  p: Pt;
  // Unit vector pointing out of the node at this anchor.
  dir: Pt;
}
const SIDE_DIR: Record<Side, Pt> = {
  L: { x: -1, y: 0 },
  R: { x: 1, y: 0 },
  T: { x: 0, y: -1 },
  B: { x: 0, y: 1 },
};

// Kelly's 22 colors of maximum contrast.
const KELLY: [string, string][] = [
  ["#F2F3F4", "White"], ["#222222", "Black"], ["#FFB300", "Vivid yellow"], ["#803E75", "Strong purple"],
  ["#FF6800", "Vivid orange"], ["#A6BDD7", "Very light blue"], ["#C10020", "Vivid red"], ["#CEA262", "Grayish yellow"],
  ["#817066", "Medium gray"], ["#007D34", "Vivid green"], ["#F6768E", "Strong purplish pink"], ["#00538A", "Strong blue"],
  ["#FF7A5C", "Strong yellowish pink"], ["#53377A", "Strong violet"], ["#FF8E00", "Vivid orange yellow"],
  ["#B32851", "Strong purplish red"], ["#F4C800", "Vivid greenish yellow"], ["#7F180D", "Strong reddish brown"],
  ["#93AA00", "Vivid yellowish green"], ["#593315", "Deep yellowish brown"], ["#F13A13", "Vivid reddish orange"],
  ["#232C16", "Dark olive green"],
];
// Automatic branch colors skip white and black so they never vanish into the background.
const BRANCH_COLORS = KELLY.slice(2).map(([c]) => c);

type Tool = "select" | "add" | "link";

interface ViewState extends Record<string, unknown> {
  path?: string;
  depth?: number;
  backlinks?: boolean;
  extras?: string[];
  collapsed?: string[];
  editorHidden?: boolean;
  debug?: boolean;
}

const pairKey = (a: MapNode, b: MapNode) =>
  a.file.path < b.file.path ? `${a.file.path}\n${b.file.path}` : `${b.file.path}\n${a.file.path}`;

export class MindAtlasView extends ItemView {
  private rootFile: TFile | null = null;
  private depth = this.plugin.settings.defaultDepth;
  private backlinks = true;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private svg!: SVGSVGElement;
  private group!: SVGGElement;
  private depthLabel!: HTMLElement;
  private backlinkBox!: HTMLInputElement;
  private refreshTimer: number | null = null;
  private renderToken = 0;
  private editor: NoteEditor | null = null;
  private mapEl!: HTMLElement;
  private editorPane!: HTMLElement;
  private editorTitle!: HTMLInputElement;
  private editorHeight = 280;
  private editorWidth = 400;
  private editorHidden = false;
  private debug = true;
  private debugBox?: HTMLInputElement;
  private editorBox: HTMLInputElement | null = null;
  private selectedPath: string | null = null;
  private graph: MapGraph | null = null;
  private layouts = { radial: new Map<string, Pt>(), tree: new Map<string, Pt>(), free: new Map<string, Pt>() };
  private layoutRoot: string | null = null;
  private layoutTimer: number | null = null;
  private get offsets() {
    return this.layouts[this.plugin.settings.layoutMode];
  }
  private get free() {
    return this.layouts.free;
  }
  private collapsed = new Set<string>();
  private animFrame: number | null = null;
  private dragging: MapNode | null = null;
  private menuCenterBtn!: HTMLElement;
  private openIconPalette: () => void = () => {};
  private layoutBtn!: HTMLButtonElement;
  private undo = new UndoStack(this.app, () => this.scheduleRefresh());
  private nodeEls = new Map<MapNode, SVGGElement>();
  private edgeEls: {
    edge: Edge;
    el: SVGPathElement;
    cross: boolean;
    gray: boolean;
    heads: [SVGPathElement, SVGPathElement];
    hit: SVGPathElement;
    key: string;
  }[] = [];
  private tool: Tool = "select";
  private toolBtns = new Map<Tool, HTMLElement>();
  private connBox: HTMLInputElement | null = null;
  private extras: string[] = [];
  private pendingSelect: string | null = null;
  private inline: { el: HTMLElement; pos: Pt; anchor: "left" | "right" | "center"; px: number; parent?: MapNode; line?: SVGPathElement } | null = null;
  private closeInline: ((v: string | null) => void) | null = null;
  private selectedEdgeKey: string | null = null;
  private linkSourcePath: string | null = null;
  private previewEl: SVGPathElement | null = null;
  private pointerGraph: Pt | null = null;
  private dropTarget: MapNode | null = null;
  private lastPointerType = "mouse";
  private menuEl!: HTMLElement;
  private menuTrashBtn!: HTMLElement;
  private menuPath: string | null = null;
  private menuTimer: number | null = null;
  private positions = new Map<string, { x: number; y: number }>();
  private lastRootPath: string | null = null;
  private suppressClick = false;
  private boxBox!: HTMLInputElement;
  private measureCtx = document.createElement("canvas").getContext("2d")!;

  constructor(leaf: WorkspaceLeaf, private plugin: MindAtlasPlugin) {
    super(leaf);
  }

  /** Re-render after settings (font, sizes, boxes, lines) change. */
  refreshAppearance() {
    this.applyEditorLayout();
    this.syncToolbar();
    void this.render(false);
  }

  getViewType() {
    return VIEW_TYPE_MINDATLAS;
  }
  getDisplayText() {
    return this.rootFile ? `Map: ${this.rootFile.basename}` : "MindAtlas";
  }
  getIcon() {
    return "git-fork";
  }

  async setState(state: ViewState, result: any) {
    if (state?.path) {
      const f = this.app.vault.getAbstractFileByPath(state.path);
      if (f instanceof TFile) this.rootFile = f;
    }
    if (typeof state?.depth === "number") this.depth = state.depth;
    if (typeof state?.backlinks === "boolean") this.backlinks = state.backlinks;
    if (typeof state?.editorHidden === "boolean") this.editorHidden = state.editorHidden;
    if (typeof state?.debug === "boolean") this.debug = state.debug;
    if (Array.isArray(state?.extras)) {
      this.extras = state.extras.filter((x): x is string => typeof x === "string");
    }
    if (Array.isArray(state?.collapsed)) {
      this.collapsed = new Set(state.collapsed.filter((x): x is string => typeof x === "string"));
    }
    await super.setState(state, result);
    this.syncToolbar();
    await this.render(true);
    if (this.rootFile && !this.selectedPath) this.selectNode(this.rootFile);
  }

  getState(): ViewState {
    return {
      path: this.rootFile?.path,
      depth: this.depth,
      backlinks: this.backlinks,
      extras: this.extras,
      editorHidden: this.editorHidden,
      debug: this.debug,
      collapsed: [...this.collapsed],
    };
  }

  /**
   * iOS scrolls overflow-hidden containers to reveal a focused field, which slides the map
   * out of view when the keyboard opens. Nothing here should ever scroll, so undo it.
   */
  private keepInPlace() {
    if (!Platform.isMobile) return;
    const vv = window.visualViewport;
    const el = this.contentEl;
    const editing = () => {
      const a = document.activeElement;
      return a instanceof HTMLElement && el.contains(a) && (a.isContentEditable || a.tagName === "INPUT" || a.tagName === "TEXTAREA");
    };
    const dbg = el.createDiv("mind-atlas-debug");
    const pane = () => el.querySelector<HTMLElement>(":scope > .mind-atlas-editor-pane");
    const release = () => {
      el.removeClass("is-keyboard");
      el.style.height = "";
      el.style.removeProperty("--ma-h");
    };
    // While the keyboard is up, Obsidian shrinks the leaf but the flex children collapse to
    // zero height. Give the view and its children explicit pixel heights from the leaf.
    const report = (kb: boolean, parentH: number) => {
      const box = (e: Element | null) => {
        if (!e) return "-";
        const b = e.getBoundingClientRect();
        return `${Math.round(b.width)}x${Math.round(b.height)}@${Math.round(b.top)}`;
      };
      const host = el.querySelector(".mind-atlas-editor");
      const cm = el.querySelector(".cm-editor");
      const sc = el.querySelector(".cm-scroller");
      dbg.setText(`kb ${kb} leaf ${parentH} view ${box(el)} map ${box(this.mapEl)} pane ${box(pane())} host ${box(host)} cm ${box(cm)} scroller ${box(sc)} lines ${el.querySelectorAll(".cm-line").length} vv ${Math.round(vv?.height ?? 0)} win ${window.innerHeight}`);
    };
    const sync = () => {
      if (!vv) return;
      const kb = editing();
      const parentH = el.parentElement?.clientHeight ?? 0;
      if (!kb) {
        release();
        return report(kb, parentH);
      }
      if (parentH < 100) return report(kb, parentH);
      el.addClass("is-keyboard");
      el.style.height = `${parentH}px`;
      el.style.setProperty("--ma-h", `${parentH}px`);
      report(kb, parentH);
    };
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync);
    this.registerDomEvent(el, "focusin", () => {
      sync();
      for (const ms of [150, 400, 800]) window.setTimeout(sync, ms);
    });
    this.registerDomEvent(el, "focusout", () => window.setTimeout(sync, 100));
    this.register(() => {
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
      release();
    });
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("mind-atlas-container");
    this.mapEl = this.contentEl.createDiv("mind-atlas-map");
    this.mapEl.tabIndex = 0;
    this.buildToolbar();
    this.buildPalette();

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.addClass("mind-atlas-svg");
    this.group = document.createElementNS(SVG_NS, "g");
    this.svg.appendChild(this.group);
    this.mapEl.appendChild(this.svg);
    this.buildMenu();
    this.bindPanZoom();
    this.bindFileDrop();
    this.buildEditorPane();
    this.applyEditorLayout();
    this.keepInPlace();
    this.registerDomEvent(this.mapEl, "keydown", (e) => this.onKey(e));

    const refresh = () => this.scheduleRefresh();
    this.registerEvent(this.app.metadataCache.on("changed", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f instanceof TFile) void this.editor?.onExternalModify(f);
      })
    );
    await this.render(true);
  }

  async onClose() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    if (this.menuTimer) window.clearTimeout(this.menuTimer);
    if (this.animFrame !== null) cancelAnimationFrame(this.animFrame);
    if (this.layoutTimer) {
      window.clearTimeout(this.layoutTimer);
      await this.writeLayout();
    }
    await this.editor?.destroy();
    this.editor = null;
  }

  private buildEditorPane() {
    const divider = this.contentEl.createDiv("mind-atlas-divider");
    this.editorPane = this.contentEl.createDiv("mind-atlas-editor-pane");
    this.editorTitle = this.editorPane.createEl("input", {
      cls: "mind-atlas-editor-title",
      attr: { type: "text", spellcheck: "false", "aria-label": "Note title (press Enter to rename)" },
    });
    this.editorTitle.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        this.editorTitle.blur();
      } else if (e.key === "Escape") {
        this.editorTitle.value = this.editor?.currentFile?.basename ?? "";
        this.editorTitle.blur();
      }
    });
    this.editorTitle.addEventListener("blur", () => {
      const f = this.editor?.currentFile;
      if (f) void this.renameFile(f, this.editorTitle.value);
    });
    const host = this.editorPane.createDiv("mind-atlas-editor");
    this.editor = new NoteEditor(this.app, host, (f) => this.selectNode(f));

    divider.addEventListener("pointerdown", (e) => {
      divider.setPointerCapture(e.pointerId);
      const right = this.plugin.settings.editorPosition === "right";
      const start = right ? e.clientX : e.clientY;
      const startSize = right ? this.editorWidth : this.editorHeight;
      const max = (right ? this.contentEl.clientWidth : this.contentEl.clientHeight) - 160;
      const move = (ev: PointerEvent) => {
        const delta = start - (right ? ev.clientX : ev.clientY);
        const size = Math.min(max, Math.max(right ? 200 : 80, startSize + delta));
        if (right) this.editorWidth = size;
        else this.editorHeight = size;
        this.applyEditorLayout();
      };
      const up = () => {
        divider.removeEventListener("pointermove", move);
        divider.removeEventListener("pointerup", up);
      };
      divider.addEventListener("pointermove", move);
      divider.addEventListener("pointerup", up);
    });
  }

  /** Dock the editor below or beside the map, per the setting. */
  private applyEditorLayout() {
    if (!this.editorPane) return;
    const right = this.plugin.settings.editorPosition === "right";
    this.contentEl.toggleClass("is-editor-right", right);
    if (right) {
      this.editorPane.style.width = `${this.editorWidth}px`;
      this.editorPane.style.height = "";
    } else {
      this.editorPane.style.height = `${this.editorHeight}px`;
      this.editorPane.style.width = "";
    }
  }

  private buildToolbar() {
    const bar = this.contentEl.createDiv("mind-atlas-toolbar");
    bar.createSpan({ text: "Depth" });
    const minus = bar.createEl("button", { text: "−" });
    this.depthLabel = bar.createSpan({ cls: "mind-atlas-depth", text: String(this.depth) });
    const plus = bar.createEl("button", { text: "+" });
    const label = bar.createEl("label");
    this.backlinkBox = label.createEl("input", { type: "checkbox" });
    label.appendText(" Backlinks");
    const connLabel = bar.createEl("label", { attr: { title: "Also show linked notes that aren't children of anything" } });
    this.connBox = connLabel.createEl("input", { type: "checkbox" });
    connLabel.appendText(" All connections");
    this.connBox.onchange = () => {
      this.plugin.settings.showConnections = this.connBox!.checked;
      void this.plugin.saveSettings();
    };
    const edLabel = bar.createEl("label", { attr: { title: "Show or hide the note editor" } });
    this.editorBox = edLabel.createEl("input", { type: "checkbox" });
    edLabel.appendText(" Editor");
    this.editorBox.onchange = () => {
      this.editorHidden = !this.editorBox!.checked;
      this.syncToolbar();
      this.app.workspace.requestSaveLayout();
    };
    if (Platform.isMobile) {
      const dbLabel = bar.createEl("label", { attr: { title: "Show the layout debug readout" } });
      this.debugBox = dbLabel.createEl("input", { type: "checkbox" });
      dbLabel.appendText(" Debug");
      this.debugBox.onchange = () => {
        this.debug = this.debugBox!.checked;
        this.syncToolbar();
        this.app.workspace.requestSaveLayout();
      };
    }
    const boxLabel = bar.createEl("label");
    this.boxBox = boxLabel.createEl("input", { type: "checkbox" });
    boxLabel.appendText(" Boxes");
    this.boxBox.onchange = () => {
      this.plugin.settings.showBoxes = this.boxBox.checked;
      void this.plugin.saveSettings();
    };

    this.layoutBtn = bar.createEl("button");
    this.layoutBtn.onclick = () => {
      const s = this.plugin.settings;
      s.layoutMode = s.layoutMode === "radial" ? "tree" : "radial";
      void this.plugin.saveSettings();
    };

    minus.onclick = () => this.setDepth(this.depth - 1);
    plus.onclick = () => this.setDepth(this.depth + 1);
    this.backlinkBox.onchange = () => {
      this.backlinks = this.backlinkBox.checked;
      void this.render(true);
    };
    this.syncToolbar();
  }

  private syncToolbar() {
    if (this.depthLabel) this.depthLabel.setText(String(this.depth));
    if (this.backlinkBox) this.backlinkBox.checked = this.backlinks;
    this.layoutBtn?.setText(this.plugin.settings.layoutMode === "radial" ? "Radial" : "Tree");
    if (this.boxBox) this.boxBox.checked = this.plugin.settings.showBoxes;
    if (this.editorBox) this.editorBox.checked = !this.editorHidden;
    this.contentEl.toggleClass("is-editor-hidden", this.editorHidden);
    if (this.connBox) this.connBox.checked = this.plugin.settings.showConnections;
    if (this.debugBox) this.debugBox.checked = this.debug;
    this.contentEl.toggleClass("show-debug", this.debug);
  }

  private setDepth(d: number) {
    this.depth = Math.min(6, Math.max(1, d));
    this.syncToolbar();
    void this.render(true);
  }

  async setRoot(file: TFile) {
    this.rootFile = file;
    this.selectedPath = file.path;
    await this.render(true);
    (this.leaf as any).updateHeader?.();
    this.selectNode(file);
  }

  /** Select a node and load its note into the embedded editor. */
  private selectNode(file: TFile) {
    this.selectedPath = file.path;
    for (const [n, el] of this.nodeEls) {
      el.toggleClass("is-selected", n.file.path === file.path);
    }
    this.refreshCrossLinks();
    this.editorTitle.value = file.basename;
    void this.editor?.open(file);
  }

  private scheduleRefresh() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.render(false), 300);
  }

  private applyTransform() {
    this.group.setAttribute(
      "transform",
      `translate(${this.tx} ${this.ty}) scale(${this.scale})`
    );
    this.positionMenu();
    this.positionInline();
  }

  private bindPanZoom() {
    this.svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const rect = this.svg.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          const next = Math.min(3, Math.max(0.2, this.scale * Math.exp(-e.deltaY * 0.01)));
          const k = next / this.scale;
          this.tx = px - (px - this.tx) * k;
          this.ty = py - (py - this.ty) * k;
          this.scale = next;
        } else {
          this.tx -= e.deltaX;
          this.ty -= e.deltaY;
        }
        this.applyTransform();
      },
      { passive: false }
    );

    let drag: { x: number; y: number } | null = null;
    let down: { x: number; y: number } | null = null;
    this.svg.addEventListener("pointerdown", (e) => {
      this.mapEl.focus({ preventScroll: true });
      const t = e.target as Element;
      if (t.closest(".mind-atlas-node") || t.closest(".mind-atlas-hit")) return;
      this.hideMenu();
      if (this.selectedEdgeKey) {
        this.selectedEdgeKey = null;
        this.refreshEdgeSelection();
      }
      if (this.tool === "link") this.linkSourcePath = null;
      this.updatePreview();
      drag = { x: e.clientX, y: e.clientY };
      down = { x: e.clientX, y: e.clientY };
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener("pointermove", (e) => {
      this.pointerGraph = this.toGraphCoords(e);
      if (this.linkSourcePath) this.updatePreview();
      if (!drag) return;
      this.tx += e.clientX - drag.x;
      this.ty += e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      this.applyTransform();
    });
    this.svg.addEventListener("pointerup", (e) => {
      // A click (not a pan) on empty space with the add tool creates a floating note.
      if (down && this.tool === "add" && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) {
        void this.addFloating(this.toGraphCoords(e));
      }
      drag = null;
      down = null;
    });
    this.svg.addEventListener("pointercancel", () => {
      drag = null;
      down = null;
    });
  }

  /** Re-render; `recenter` resets pan/zoom so the root is centered. */
  private async render(recenter: boolean) {
    if (!this.group) return;
    const token = ++this.renderToken;
    if (!this.rootFile) {
      this.group.empty();
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", "20");
      t.setAttribute("y", "70");
      t.addClass("mind-atlas-empty");
      t.textContent = "Run “MindAtlas: Open map for current note”.";
      this.group.appendChild(t);
      return;
    }
    const graph = await buildGraph(this.app, this.rootFile, {
      depth: this.depth,
      backlinks: this.backlinks,
      connections: this.plugin.settings.showConnections,
      collapsed: this.collapsed,
      maxNodes: this.plugin.settings.maxNodes,
      extras: this.extras
        .map((p) => this.app.vault.getAbstractFileByPath(p))
        .filter((f): f is TFile => f instanceof TFile),
    });
    if (token !== this.renderToken) return; // a newer render superseded this one

    // Floating notes stop being "extra" once something links to them.
    const linkedIn = new Set(graph.treeEdges.map((e) => e.to.file.path));
    this.extras = this.extras.filter(
      (p) => graph.nodes.some((n) => n.file.path === p) && !linkedIn.has(p)
    );

    this.loadLayout(graph);
    this.restorePositions(graph);
    this.graph = graph;
    this.svg.toggleClass("ma-no-boxes", !this.plugin.settings.showBoxes);

    this.group.empty();
    this.nodeEls.clear();
    this.edgeEls = [];
    const edgeLayer = this.group.createSvg("g");
    const nodeLayer = this.group.createSvg("g");
    const cross = this.plugin.settings.crossLinks;
    for (const e of graph.treeEdges) this.addEdge(edgeLayer, e, false);
    if (cross !== "never") for (const e of graph.crossLinks) this.addEdge(edgeLayer, e, true);
    for (const n of graph.nodes) this.drawNode(nodeLayer, n, n === graph.root);
    this.previewEl = this.group.createSvg("path");
    this.previewEl.addClass("mind-atlas-preview");

    this.refreshCrossLinks();
    this.relayout(this.positions.size === 0);
    if (recenter) {
      const rect = this.svg.getBoundingClientRect();
      this.scale = 1;
      this.tx = rect.width / 2;
      this.ty = rect.height / 2;
    }
    this.applyTransform();
    this.refreshEdgeSelection();
    this.updatePreview();
    if (this.pendingSelect) {
      const target = graph.nodes.find((n) => n.file.path === this.pendingSelect);
      if (target) {
        this.pendingSelect = null;
        this.selectNode(target.file);
        this.ensureVisible(target);
      }
    }
  }

  /** Manual positions live in the center note's frontmatter (`mindmap-layout`), one set per layout. */
  private loadLayout(graph: MapGraph) {
    const path = graph.root.file.path;
    if (this.layoutRoot === path) return;
    const cache = this.app.metadataCache.getFileCache(graph.root.file);
    if (!cache) return; // not indexed yet; the metadata "changed" event re-renders later
    this.layoutRoot = path;
    this.layouts = { radial: new Map(), tree: new Map(), free: new Map() };
    const data = cache.frontmatter?.["mindmap-layout"];
    if (!data || typeof data !== "object") return;
    for (const key of ["radial", "tree", "free"] as const) {
      const set = (data as Record<string, unknown>)[key];
      if (!set || typeof set !== "object") continue;
      for (const [k, v] of Object.entries(set as Record<string, unknown>)) {
        if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x))) {
          this.layouts[key].set(k, { x: v[0], y: v[1] });
        }
      }
    }
  }

  private saveLayout() {
    if (this.layoutTimer) window.clearTimeout(this.layoutTimer);
    this.layoutTimer = window.setTimeout(() => void this.writeLayout(), 400);
  }

  private async writeLayout() {
    this.layoutTimer = null;
    const file = this.app.vault.getAbstractFileByPath(this.layoutRoot ?? "");
    if (!(file instanceof TFile)) return;
    const L = this.layouts;
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        const out: Record<string, Record<string, number[]>> = {};
        for (const key of ["radial", "tree", "free"] as const) {
          if (!L[key].size) continue;
          out[key] = {};
          for (const [k, v] of L[key]) out[key][k] = [Math.round(v.x), Math.round(v.y)];
        }
        if (Object.keys(out).length) fm["mindmap-layout"] = out;
        else delete fm["mindmap-layout"];
      });
    } catch (err) {
      new Notice(`MindAtlas: could not save positions (${(err as Error).message})`);
    }
  }

  /** Carry node positions over from the previous render so the map doesn't jump. */
  private restorePositions(graph: MapGraph) {
    let prev = this.positions;
    const rootPath = graph.root.file.path;
    if (this.lastRootPath !== rootPath) {
      // New root: keep relative positions if it was already on the map.
      const o = prev.get(rootPath);
      const next = new Map<string, { x: number; y: number }>();
      if (o) for (const [k, v] of prev) next.set(k, { x: v.x - o.x, y: v.y - o.y });
      prev = next;
      this.lastRootPath = rootPath;
    }

    const parentOf = new Map<MapNode, MapNode>();
    for (const e of graph.treeEdges) parentOf.set(e.to, e.from);
    const placed = new Set<MapNode>();
    for (const n of graph.nodes) {
      const p = prev.get(n.file.path);
      if (p) {
        n.x = p.x;
        n.y = p.y;
        placed.add(n);
      }
    }
    // New notes grow out of their parent.
    for (const n of graph.nodes) {
      if (placed.has(n)) continue;
      const parent = parentOf.get(n);
      const f = this.free.get(n.file.path);
      n.x = f?.x ?? parent?.x ?? 0;
      n.y = f?.y ?? parent?.y ?? 0;
    }
    graph.root.x = 0;
    graph.root.y = 0;
    for (const n of graph.nodes) {
      n.gx = n.x;
      n.gy = n.y;
      this.measure(n);
    }
  }

  /** Run the layout, then glide (or snap) nodes to their goal positions. */
  private relayout(snap: boolean) {
    const g = this.graph;
    if (!g) return;
    const s = this.plugin.settings;
    arrange(g.root, g.treeEdges, s.layoutMode, s.spacing);
    applyOffsets(g.root, g.treeEdges, this.offsets, this.free, g.nodes);
    if (snap || g.nodes.length > 600) {
      for (const n of g.nodes) {
        n.x = n.gx;
        n.y = n.gy;
      }
      this.updatePositions();
    } else {
      this.animate();
    }
  }

  private animate() {
    if (this.animFrame !== null) return;
    const step = () => {
      this.animFrame = null;
      const g = this.graph;
      if (!g) return;
      let moving = false;
      for (const n of g.nodes) {
        if (n === this.dragging) continue;
        const dx = n.gx - n.x;
        const dy = n.gy - n.y;
        if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) {
          n.x = n.gx;
          n.y = n.gy;
        } else {
          n.x += dx * 0.2;
          n.y += dy * 0.2;
          moving = true;
        }
      }
      this.updatePositions();
      if (moving || this.dragging) this.animFrame = requestAnimationFrame(step);
    };
    this.animFrame = requestAnimationFrame(step);
  }

  /** Branch color for a note: its own/inherited frontmatter color, else its branch's palette color. */
  private colorOf(n: MapNode): string | undefined {
    if (n.side === -1 || n.floating) return undefined;
    if (n.color) return n.color;
    if (this.plugin.settings.branchColors && n.branch >= 0) return BRANCH_COLORS[n.branch % BRANCH_COLORS.length];
    return undefined;
  }

  private fontOf(n: MapNode) {
    const sizes = this.plugin.settings.headingSizes;
    // Connection-only notes are always H4-sized.
    const level = n.floating ? Math.min(3, sizes.length - 1) : Math.min(n.depth, sizes.length - 1);
    return {
      level,
      px: sizes[level],
      weight: level < 3 ? 700 : level < 5 ? 600 : 400,
      family: this.plugin.settings.fontFamily || getComputedStyle(this.contentEl).fontFamily,
    };
  }

  /** Size the node to its (possibly truncated) title plus box padding. */
  private measure(n: MapNode) {
    const f = this.fontOf(n);
    const ctx = this.measureCtx;
    ctx.font = `${f.weight} ${f.px}px ${f.family}`;
    const prefix = n.icon ? `${n.icon} ` : "";
    const full = prefix + n.title;
    let text = full;
    let width = ctx.measureText(text).width;
    if (width > MAX_TEXT_W) {
      let lo = 1;
      let hi = text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ctx.measureText(full.slice(0, mid) + "…").width <= MAX_TEXT_W) lo = mid;
        else hi = mid - 1;
      }
      text = full.slice(0, lo) + "…";
      width = ctx.measureText(text).width;
    }
    n.label = text;
    if (this.plugin.settings.showBoxes || n.floating) {
      const pad = this.plugin.settings.boxPadding;
      n.w = Math.ceil(width) + pad * 2;
      n.h = Math.ceil(f.px * 1.25) + pad * 1.2;
    } else {
      // No box: lines attach just outside the text itself.
      n.w = Math.ceil(width) + 10;
      n.h = Math.ceil(f.px * 1.1) + 4;
    }
    n.iconH = n.iconName && resolveIcon(n.iconName) ? this.plugin.settings.iconSize + 1 : 0;
    n.h += n.iconH;
  }

  private addEdge(layer: SVGGElement, edge: Edge, cross: boolean) {
    const s = this.plugin.settings;
    // Lines touching a backlink note are grayed out.
    const gray = edge.from.side === -1 || edge.to.side === -1 || !!edge.from.floating || !!edge.to.floating;
    const el = layer.createSvg("path");
    const filled = !cross && s.lineStyle === "organic";
    el.addClass(cross ? "mind-atlas-cross" : filled ? "mind-atlas-edge-fill" : "mind-atlas-edge");
    if (gray) el.addClass("is-back");
    const k = !cross && s.taperLines ? Math.max(0.35, 1 - 0.18 * (edge.to.depth - 1)) : 1;
    if (!filled) el.style.strokeWidth = String(s.lineWidth * k);
    const col = gray ? "" : (!cross && this.colorOf(edge.to)) || s.lineColor;
    if (col) {
      if (filled) el.style.fill = col;
      else el.style.stroke = col;
    }
    const mkHead = () => {
      const h = layer.createSvg("path");
      h.addClass("mind-atlas-head");
      if (gray) h.addClass("is-back");
      if (col) h.style.fill = col;
      return h;
    };
    const heads: [SVGPathElement, SVGPathElement] = [mkHead(), mkHead()];

    // Wide invisible stroke so thin lines are easy to click or tap.
    const key = pairKey(edge.from, edge.to);
    const hit = layer.createSvg("path");
    hit.addClass("mind-atlas-hit");
    hit.addEventListener("pointerdown", (e) => e.stopPropagation());
    hit.addEventListener("click", () => {
      if (this.tool !== "select") return;
      this.selectedEdgeKey = key;
      this.hideMenu();
      this.refreshEdgeSelection();
      this.mapEl.focus({ preventScroll: true });
    });
    this.edgeEls.push({ edge, el, cross, gray, heads, hit, key });
  }

  private refreshEdgeSelection() {
    for (const e of this.edgeEls) {
      const on = e.key === this.selectedEdgeKey;
      e.el.toggleClass("is-selected", on);
      e.heads.forEach((h) => h.toggleClass("is-selected", on));
    }
  }

  /** Which side of each box a line leaves/enters, from the relative positions. */
  private sidesFor(a: MapNode, b: MapNode): [Side, Side] {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const gapX = Math.abs(dx) - (a.w + b.w) / 2;
    const gapY = Math.abs(dy) - (a.h + b.h) / 2;
    if (gapX >= gapY) return dx >= 0 ? ["R", "L"] : ["L", "R"];
    return dy >= 0 ? ["B", "T"] : ["T", "B"];
  }

  /**
   * Choose where every line meets its nodes. A left, right or bottom side takes
   * at most one line (the straightest); extra lines move to the top. Lines
   * sharing a side are spaced evenly about its center.
   */
  private computeAnchors(): Anchor[][] {
    interface End {
      node: MapNode;
      other: MapNode;
      side: Side;
      entry: number;
      end: 0 | 1;
    }
    const ends: End[] = [];
    const radial = this.plugin.settings.layoutMode === "radial";
    this.edgeEls.forEach(({ edge, cross }, i) => {
      if (cross || radial) return;
      const [sa, sb] = this.sidesFor(edge.from, edge.to);
      ends.push({ node: edge.from, other: edge.to, side: sa, entry: i, end: 0 });
      ends.push({ node: edge.to, other: edge.from, side: sb, entry: i, end: 1 });
    });

    const group = () => {
      const m = new Map<string, End[]>();
      for (const e of ends) {
        const k = `${e.node.file.path}|${e.side}`;
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(e);
      }
      return m;
    };

    for (const list of group().values()) {
      const side = list[0].side;
      if (side === "T" || list.length < 2) continue;
      const offAxis = (e: End) =>
        side === "L" || side === "R" ? Math.abs(e.other.y - e.node.y) : Math.abs(e.other.x - e.node.x);
      list.sort((a, b) => offAxis(a) - offAxis(b) || a.entry - b.entry);
      for (const e of list.slice(1)) e.side = "T";
    }

    const out: Anchor[][] = this.edgeEls.map(({ edge, cross }) =>
      cross || radial
        ? [this.boundaryAnchor(edge.from, edge.to), this.boundaryAnchor(edge.to, edge.from)]
        : [
            { p: { x: 0, y: 0 }, dir: SIDE_DIR.R },
            { p: { x: 0, y: 0 }, dir: SIDE_DIR.L },
          ]
    );
    for (const list of group().values()) {
      const { node, side } = list[0];
      const vertical = side === "L" || side === "R";
      list.sort(
        (a, b) => (vertical ? a.other.y - b.other.y : a.other.x - b.other.x) || a.entry - b.entry
      );
      const n = list.length;
      const span = (vertical ? node.h : node.w) * 0.8;
      const step = n === 1 ? 0 : Math.min(span / (n - 1), vertical ? 10 : 16);
      list.forEach((e, k) => {
        const off = (k - (n - 1) / 2) * step;
        const p = vertical
          ? { x: node.x + (side === "R" ? node.w / 2 : -node.w / 2), y: node.y + off }
          : { x: node.x + off, y: node.y + (side === "B" ? node.h / 2 : -node.h / 2) };
        out[e.entry][e.end] = { p, dir: SIDE_DIR[side] };
      });
    }
    return out;
  }

  /** Where a line from `n` toward `other` leaves the node's box, and which way it heads. */
  private boundaryAnchor(n: MapNode, other: Pt): Anchor {
    const dx = other.x - n.x;
    const dy = other.y - n.y;
    const len = Math.hypot(dx, dy) || 1;
    const hw = n.w / 2;
    const hh = n.h / 2;
    const tx = Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Infinity;
    const ty = Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty);
    const normal = tx <= ty ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) };
    const ux = dx / len;
    const uy = dy / len;
    const hx = normal.x * 0.55 + ux * 0.45;
    const hy = normal.y * 0.55 + uy * 0.45;
    const hl = Math.hypot(hx, hy) || 1;
    return { p: { x: n.x + dx * t, y: n.y + dy * t }, dir: { x: hx / hl, y: hy / hl } };
  }

  private linePath(a: Anchor, b: Anchor, style: string, widthK: number, sizeK: [number, number] = [1, 1]): string {
    const p1 = a.p;
    const p2 = b.p;
    if (style === "straight") return `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
    const d1 = a.dir;
    const d2 = b.dir;
    // Handle length follows the distance along each side's own axis, so lines
    // leave a note cleanly and sweep into the next one in a smooth S.
    const reach = (d: Pt) => Math.abs(d.x) * Math.abs(p2.x - p1.x) + Math.abs(d.y) * Math.abs(p2.y - p1.y);
    const organic = style === "organic";
    const base = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const k1 = organic ? 0.62 : 0.5;
    const k2 = organic ? 0.42 : 0.5;
    const off1 = Math.min(320, Math.max(28, reach(d1) * k1 + base * 0.12));
    const off2 = Math.min(320, Math.max(28, reach(d2) * k2 + base * 0.12));
    // Organic lines also drift slightly sideways so they feel hand-drawn.
    const bend = organic ? Math.max(-26, Math.min(26, (p2.y - p1.y) * 0.1 + (p2.x - p1.x) * 0.04)) : 0;
    const c1 = { x: p1.x + d1.x * off1 - d1.y * bend, y: p1.y + d1.y * off1 + d1.x * bend };
    const c2 = { x: p2.x + d2.x * off2 + d2.y * bend, y: p2.y + d2.y * off2 - d2.x * bend };
    if (!organic) {
      return `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
    }

    // Organic: a filled ribbon that is thick at the parent and tapers to the child.
    const w0 = (this.plugin.settings.lineWidth * 2.6 * widthK * sizeK[0]) / 2;
    const w1 = (this.plugin.settings.lineWidth * 0.5 * widthK * Math.min(sizeK[0], sizeK[1])) / 2;
    const N = 20;
    const left: Pt[] = [];
    const right: Pt[] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const u = 1 - t;
      const x = u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x;
      const y = u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y;
      let tx = 3 * u * u * (c1.x - p1.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (p2.x - c2.x);
      let ty = 3 * u * u * (c1.y - p1.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (p2.y - c2.y);
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const hw = w0 + (w1 - w0) * (1 - Math.pow(1 - t, 1.5));
      left.push({ x: x - ty * hw, y: y + tx * hw });
      right.push({ x: x + ty * hw, y: y - tx * hw });
    }
    const pts = [...left, ...right.reverse()];
    return "M" + pts.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" L") + " Z";
  }

  /** Move existing DOM elements to the layout's current positions. */
  private updatePositions() {
    for (const [n, el] of this.nodeEls) {
      el.setAttribute("transform", `translate(${n.x} ${n.y})`);
      this.positions.set(n.file.path, { x: n.x, y: n.y });
    }
    const s = this.plugin.settings;
    const anchors = this.computeAnchors();
    this.positionMenu();
    this.positionInline();
    this.updatePreview();
    this.edgeEls.forEach(({ edge, el, cross, heads }, i) => {
      // Cross-links are never ribbons; they stay dashed strokes.
      const style = cross && s.lineStyle === "organic" ? "curved" : s.lineStyle;
      const k = !cross && s.taperLines ? Math.max(0.35, 1 - 0.18 * (edge.to.depth - 1)) : 1;
      const [a, b] = anchors[i];
      if (cross) {
        const dx = b.p.x - a.p.x;
        const dy = b.p.y - a.p.y;
        const len = Math.hypot(dx, dy) || 1;
        const bow = Math.min(70, len * 0.22);
        const c = { x: (a.p.x + b.p.x) / 2 - (dy / len) * bow, y: (a.p.y + b.p.y) / 2 + (dx / len) * bow };
        const d = `M${a.p.x},${a.p.y} Q${c.x},${c.y} ${b.p.x},${b.p.y}`;
        el.setAttribute("d", d);
        this.edgeEls[i].hit.setAttribute("d", d);
        const unit = (from: Pt, to: Pt) => {
          const l = Math.hypot(to.x - from.x, to.y - from.y) || 1;
          return { x: (to.x - from.x) / l, y: (to.y - from.y) / l };
        };
        heads[0].setAttribute("d", edge.back ? arrowHead(a.p, unit(c, a.p), 8) : "");
        heads[1].setAttribute("d", edge.fwd ? arrowHead(b.p, unit(c, b.p), 8) : "");
        return;
      }
      // The ribbon is thickest at the note holding the link (the backlink end).
      const fromThick = !(edge.back && !edge.fwd);
      const sz: [number, number] = [this.fontOf(edge.from).px / 18, this.fontOf(edge.to).px / 18];
      el.setAttribute(
        "d",
        fromThick ? this.linePath(a, b, style, k, sz) : this.linePath(b, a, style, k, [sz[1], sz[0]])
      );
      this.edgeEls[i].hit.setAttribute(
        "d",
        this.linePath(a, b, style === "organic" ? "curved" : style, k)
      );

      // Arrowheads point into the node that is linked to; mutual links get both.
      const size = 7 + s.lineWidth * 2 * k;
      const ends: [boolean, typeof a, typeof a][] = [
        [edge.back, a, b],
        [edge.fwd, b, a],
      ];
      ends.forEach(([show, end, other], idx) => {
        const head = heads[idx];
        if (!show) {
          head.setAttribute("d", "");
          return;
        }
        let dir: Pt;
        if (style === "straight") {
          const len = Math.hypot(end.p.x - other.p.x, end.p.y - other.p.y) || 1;
          dir = { x: (end.p.x - other.p.x) / len, y: (end.p.y - other.p.y) / len };
        } else {
          dir = { x: -end.dir.x, y: -end.dir.y };
        }
        head.setAttribute("d", arrowHead(end.p, dir, size));
      });
    });
  }

  private toGraphCoords(e: PointerEvent) {
    const r = this.svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.tx) / this.scale, y: (e.clientY - r.top - this.ty) / this.scale };
  }

  private drawNode(layer: SVGGElement, n: MapNode, isRoot: boolean) {
    const s = this.plugin.settings;
    const s0 = s;
    const f = this.fontOf(n);
    const g = layer.createSvg("g");
    g.addClass("mind-atlas-node");
    if (isRoot) g.addClass("is-root");
    if (n.file.path === this.selectedPath) g.addClass("is-selected");
    if (n.side === -1 || n.floating) g.addClass("is-back");
    if (n.floating) g.addClass("is-floating");

    const accent = s.boxColor || "var(--interactive-accent)";
    const rect = g.createSvg("rect");
    // Without a box, keep a slightly larger invisible hit area for clicking.
    const boxed = s.showBoxes || !!n.floating;
    const hit = boxed ? 0 : 6;
    rect.setAttribute("x", String(-n.w / 2 - hit));
    rect.setAttribute("y", String(-n.h / 2 + n.iconH - hit));
    rect.setAttribute("width", String(n.w + hit * 2));
    rect.setAttribute("height", String(n.h - n.iconH + hit * 2));
    rect.setAttribute("rx", String(s.boxCornerRadius));
    // Boxes hidden: keep an invisible rect so the whole node stays clickable.
    rect.style.fill = "transparent";
    rect.style.stroke = "none";
    if (boxed) {
      const col = this.colorOf(n);
      rect.style.stroke = n.side === -1 || n.floating ? "var(--text-faint)" : col ?? accent;
      rect.style.strokeWidth = String(s.boxBorderWidth);
      if (isRoot) rect.style.fill = accent;
      else if (s.boxFilled) {
        rect.style.fill = col
          ? `color-mix(in srgb, ${col} 14%, var(--background-secondary))`
          : "var(--background-secondary)";
      }
    }

    const text = g.createSvg("text");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("y", String(n.iconH / 2));
    text.style.fontSize = `${f.px}px`;
    text.style.fontWeight = String(f.weight);
    text.style.fontFamily = f.family;
    if (isRoot && s.showBoxes) text.style.fill = "var(--text-on-accent)";
    else if (n.side !== -1 && this.colorOf(n)) text.style.fill = this.colorOf(n)!;
    text.textContent = n.label;
    const title = g.createSvg("title");
    title.textContent = n.title;

    if (n.collapsed || n.truncated) {
      const dots = g.createSvg("text");
      dots.setAttribute("x", String(n.w / 2 - 4));
      dots.setAttribute("y", String(n.h / 2 + 9));
      dots.setAttribute("text-anchor", "end");
      dots.setAttribute("dominant-baseline", "central");
      dots.addClass("mind-atlas-more");
      dots.textContent = n.collapsed ? `+${n.hidden}` : "…";
    }
    const iconId = n.iconName ? resolveIcon(n.iconName) : null;
    const glyph = iconId ? iconSvg(iconId) : null;
    if (glyph) {
      const size = s0.iconSize;
      glyph.setAttribute("x", String(-size / 2));
      glyph.setAttribute("y", String(-n.h / 2));
      glyph.setAttribute("width", String(size));
      glyph.setAttribute("height", String(size));
      glyph.setAttribute("class", "mind-atlas-badge");
      // Same color as the node's title.
      glyph.style.color = n.side === -1 || n.floating ? "var(--text-faint)" : this.colorOf(n) ?? "var(--text-normal)";
      g.appendChild(glyph);
    }

    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.lastPointerType = e.pointerType;
      this.mapEl.focus({ preventScroll: true });
      this.suppressClick = false;
      if (this.selectedEdgeKey) {
        this.selectedEdgeKey = null;
        this.refreshEdgeSelection();
      }
      if (this.tool === "link") {
        this.linkPointerDown(n, e, g);
        return;
      }
      if (this.tool === "add") return; // handled on click

      // Drag to move the node; drop it onto another node to re-parent it,
      // or into empty space to leave it (and its branch) there.
      g.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY };
      const p0 = this.toGraphCoords(e);
      const origin = { x: n.x, y: n.y };
      const branch = this.branchOf(n);
      const goals = new Map<MapNode, Pt>();
      for (const b of branch) goals.set(b, { x: b.gx, y: b.gy });
      let moved = false;
      let cancelled = false;
      let last = start;
      const move = (ev: PointerEvent) => {
        if (cancelled || isRoot) return;
        if (!moved) {
          moved = true;
          this.dragging = n;
          this.hideMenu();
          this.beginDragVisuals(n, branch);
          window.addEventListener("keydown", onEsc, true);
        }
        last = { x: ev.clientX, y: ev.clientY };
        const p = this.toGraphCoords(ev);
        const t = this.nodeAt(p, n);
        const invalid = !!t && branch.has(t);
        let dx = p.x - p0.x;
        let dy = p.y - p0.y;
        if (t && !invalid) {
          // Magnetic pull toward the prospective parent.
          dx += (t.x - (origin.x + dx)) * 0.3;
          dy += (t.y - (origin.y + dy)) * 0.3;
        }
        n.x = origin.x + dx;
        n.y = origin.y + dy;
        for (const [b, g0] of goals) {
          if (b === n) continue;
          b.gx = g0.x + (n.x - n.gx);
          b.gy = g0.y + (n.y - n.gy);
        }
        this.setDropTarget(t, invalid, n);
        this.updateDragVisuals(n, t, invalid);
        this.animate();
      };
      const finish = () => {
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", onEsc, true);
        if (!moved) return false;
        this.suppressClick = Math.hypot(last.x - start.x, last.y - start.y) >= 3;
        this.dragging = null;
        this.endDragVisuals();
        return true;
      };
      const up = () => {
        if (!finish()) return;
        const target = cancelled ? null : this.dropTarget;
        const invalid = this.dropInvalid;
        this.setDropTarget(null, false, n);
        if (cancelled || invalid) {
          this.relayout(false);
        } else if (target) {
          this.vibrate(15);
          this.relayout(false);
          void this.chooseRelation(target).then((choice) => {
            if (choice === "child") {
              this.offsets.delete(n.file.path);
              this.free.delete(n.file.path);
              this.saveLayout();
              this.relayout(false);
              void this.reparent(n, target);
            } else if (choice === "connection") {
              const [a, b] = n.side === -1 ? [n.file, target.file] : [target.file, n.file];
              void this.connect(a, b);
            }
          });
        } else {
          this.dropInSpace(n, { x: n.x, y: n.y }, goals);
        }
      };
      const cancel = () => {
        cancelled = true;
        up();
      };
      const onEsc = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        cancel();
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", cancel);
    });
    g.addEventListener("click", () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      if (this.tool === "add") {
        void this.addChildOf(n);
        return;
      }
      if (this.tool !== "select") return;
      this.selectNode(n.file);
      // Touch has no hover, so a tap opens the menu.
      if (this.lastPointerType !== "mouse") this.showMenu(n);
    });
    g.addEventListener("dblclick", () => {
      if (!isRoot && this.tool === "select") void this.setRoot(n.file);
    });
    g.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.selectNode(n.file);
      this.showContextMenu(n, e);
    });
    g.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse" || this.tool !== "select" || this.dragging) return;
      this.cancelMenuHide();
      this.showMenu(n);
    });
    g.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") this.scheduleMenuHide();
    });
    this.nodeEls.set(n, g);
  }

  // ---------- tools, keyboard, menu ----------

  private buildPalette() {
    const bar = this.mapEl.createDiv("mind-atlas-palette");
    const tools: [Tool, string, string][] = [
      ["select", "mouse-pointer-2", "Select and move. Drag a note onto another, then choose Child or Connection."],
      ["add", "file-plus", "Add note: click empty space, or click a note to add a child"],
      ["link", "link-2", "Link: drag from one note to another (Esc to cancel)"],
    ];
    for (const [tool, icon, tip] of tools) {
      const btn = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tip } });
      setIcon(btn, icon);
      btn.onclick = () => this.setTool(tool);
      this.toolBtns.set(tool, btn);
    }
    bar.createDiv("mind-atlas-palette-sep");
    const views: [string, string, () => void][] = [
      ["zoom-in", "Zoom in", () => this.zoomBy(1.25)],
      ["zoom-out", "Zoom out", () => this.zoomBy(0.8)],
      ["locate-fixed", "Center map on the root note", () => this.centerMap()],
      ["maximize", "Fit whole map in view", () => this.fitMap()],
    ];
    const more: [string, string, (e: MouseEvent) => void][] = [
      ["search", "Find a note (⌘F)", () => this.openFinder()],
      ["undo-2", "Undo (⌘Z)", () => void this.undo.undo()],
      ["redo-2", "Redo (⇧⌘Z)", () => void this.undo.redo()],
      ["wand-2", "Re-tidy: discard manual positions", () => this.retidy()],
      ["download", "Export map…", (e) => this.showExportMenu(e)],
    ];
    for (const [icon, tip, fn] of [...views, ...more] as [string, string, (e: MouseEvent) => void][]) {
      const btn = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tip } });
      setIcon(btn, icon);
      btn.onclick = (e) => fn(e);
    }
    this.setTool("select");
    this.syncToolbar();
  }

  /** Ask whether a link should make a child or only a connection. Resolves null if dismissed. */
  private chooseRelation(anchor: MapNode): Promise<"child" | "connection" | null> {
    return new Promise((resolve) => {
      const box = this.mapEl.createDiv("mind-atlas-choice");
      const r = this.mapEl.getBoundingClientRect();
      const sv = this.svg.getBoundingClientRect();
      const x = sv.left - r.left + this.tx + anchor.x * this.scale;
      const y = sv.top - r.top + this.ty + (anchor.y + anchor.h / 2) * this.scale + 8;
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      const done = (v: "child" | "connection" | null) => {
        box.remove();
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", onKey, true);
        resolve(v);
      };
      const outside = (e: Event) => {
        if (!box.contains(e.target as Node)) done(null);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        done(null);
      };
      const zone = (cls: string, icon: string, label: string, v: "child" | "connection") => {
        const b = box.createEl("button", { cls: `mind-atlas-zone ${cls}` });
        setIcon(b.createSpan(), icon);
        b.createSpan({ text: label });
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          done(v);
        });
      };
      zone("is-child", "corner-down-right", "Child", "child");
      zone("is-connection", "share-2", "Connection", "connection");
      // Deferred so the pointer-up that opened this doesn't dismiss it.
      setTimeout(() => {
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("keydown", onKey, true);
      });
    });
  }

  private async connect(src: TFile, dst: TFile) {
    try {
      await this.editor?.flush();
      let added = false;
      await this.undo.run("connection", [src.path], async () => {
        added = await addConnection(this.app, src, dst);
      });
      new Notice(
        added ? `Connected “${src.basename}” → “${dst.basename}”` : `“${src.basename}” already links to “${dst.basename}”`
      );
    } catch (err) {
      new Notice(`MindAtlas: could not add connection (${(err as Error).message})`);
    }
    this.scheduleRefresh();
  }

  private zoomBy(f: number) {
    const r = this.svg.getBoundingClientRect();
    const next = Math.min(3, Math.max(0.2, this.scale * f));
    const k = next / this.scale;
    this.tx = r.width / 2 - (r.width / 2 - this.tx) * k;
    this.ty = r.height / 2 - (r.height / 2 - this.ty) * k;
    this.scale = next;
    this.applyTransform();
  }

  private centerMap() {
    const root = this.graph?.root;
    if (!root) return;
    const r = this.svg.getBoundingClientRect();
    this.tx = r.width / 2 - root.x * this.scale;
    this.ty = r.height / 2 - root.y * this.scale;
    this.applyTransform();
  }

  private fitMap() {
    const g = this.graph;
    if (!g || !g.nodes.length) return;
    const r = this.svg.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of g.nodes) {
      x0 = Math.min(x0, n.x - n.w / 2);
      x1 = Math.max(x1, n.x + n.w / 2);
      y0 = Math.min(y0, n.y - n.h / 2);
      y1 = Math.max(y1, n.y + n.h / 2);
    }
    const m = 50;
    const sc = Math.min(2, Math.max(0.2, Math.min((r.width - m * 2) / (x1 - x0), (r.height - m * 2) / (y1 - y0))));
    this.scale = sc;
    this.tx = r.width / 2 - ((x0 + x1) / 2) * sc;
    this.ty = r.height / 2 - ((y0 + y1) / 2) * sc;
    this.applyTransform();
  }

  private setTool(t: Tool) {
    this.tool = t;
    this.linkSourcePath = null;
    this.updatePreview();
    this.hideMenu();
    for (const [name, btn] of this.toolBtns) btn.toggleClass("is-active", name === t);
    this.svg?.setAttribute("data-tool", t);
  }

  private buildMenu() {
    this.menuEl = this.mapEl.createDiv("mind-atlas-menu");
    this.menuEl.hide();
    const add = (icon: string, tip: string, fn: (n: MapNode) => void) => {
      const btn = this.menuEl.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tip } });
      setIcon(btn, icon);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const n = this.menuNode();
        if (n) fn(n);
      });
      return btn;
    };
    add("plus", "Add child note (Tab)", (n) => {
      this.hideMenu();
      void this.addChildOf(n);
    });
    add("pencil", "Rename (F2)", (n) => {
      this.hideMenu();
      void this.renameNode(n);
    });
    this.menuCenterBtn = add("locate-fixed", "Make this the center of the map (double-click or R)", (n) => {
      this.hideMenu();
      void this.setRoot(n.file);
    });
    add("link-2", "Link this note to another", (n) => {
      this.setTool("link");
      this.linkSourcePath = n.file.path;
    });
    const openPalette = (cls: string) => {
      for (const el of Array.from(this.menuEl.querySelectorAll(".mind-atlas-swatches, .mind-atlas-icons"))) {
        el.toggleClass("is-open", el.hasClass(cls) && !el.hasClass("is-open"));
      }
    };
    this.openIconPalette = () => {
      for (const el of Array.from(this.menuEl.querySelectorAll(".mind-atlas-swatches, .mind-atlas-icons"))) {
        el.toggleClass("is-open", el.hasClass("mind-atlas-icons"));
      }
    };
    add("palette", "Color", () => openPalette("mind-atlas-swatches"));
    add("shapes", "Icon", () => openPalette("mind-atlas-icons"));
    const sw = this.menuEl.createDiv("mind-atlas-swatches");
    const pick = (c: string | null) => {
      const n = this.menuNode();
      sw.removeClass("is-open");
      if (n) void this.setMeta(n, "mindmap-color", c);
    };
    for (const [c, name] of KELLY) {
      // A div, not a button: iOS applies its own sizing to buttons, which stretched these into ovals.
      const b = sw.createDiv({ cls: "mind-atlas-swatch", attr: { role: "button", "aria-label": name, title: name } });
      b.style.cssText = `width:22px;height:22px;border-radius:50%;box-sizing:border-box;background:${c};`;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        pick(c);
      });
    }
    const auto = sw.createDiv({ cls: "mind-atlas-swatch is-auto", attr: { role: "button", "aria-label": "Automatic color" } });
    auto.style.cssText = "width:22px;height:22px;border-radius:50%;box-sizing:border-box;";
    setIcon(auto, "eraser");
    auto.addEventListener("click", (e) => {
      e.stopPropagation();
      pick(null);
    });

    const ip = this.menuEl.createDiv("mind-atlas-icons");
    const pickIcon = (name: string | null) => {
      const n = this.menuNode();
      ip.removeClass("is-open");
      if (!n) return;
      // Also clear any legacy status so the chosen icon is the one shown.
      void this.setMetaMany(n, { "mindmap-icon": name, "mindmap-status": null });
    };
    const none = ip.createDiv("mind-atlas-icons-grid").createEl("button", { cls: "clickable-icon mind-atlas-iconbtn is-none", attr: { "aria-label": "Remove icon", title: "Remove icon" } });
    setIcon(none, "x");
    none.addEventListener("click", (e) => {
      e.stopPropagation();
      pickIcon(null);
    });
    for (const cat of iconCategories()) {
      ip.createDiv({ cls: "mind-atlas-icons-title", text: cat.title });
      const grid = ip.createDiv("mind-atlas-icons-grid");
      for (const name of cat.icons) {
        const b = grid.createEl("button", { cls: "clickable-icon mind-atlas-iconbtn", attr: { "aria-label": name, title: name } });
        setIcon(b, name);
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          pickIcon(name);
        });
      }
    }
    add("more-horizontal", "More…", (n) => {
      const r = this.svg.getBoundingClientRect();
      this.showContextMenu(n, { x: r.left + this.tx + n.x * this.scale, y: r.top + this.ty + (n.y + n.h / 2) * this.scale });
    });
    this.menuTrashBtn = add("trash-2", "Delete (Delete key)", (n) => {
      this.hideMenu();
      void this.deleteNode(n);
    });
    this.menuEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.menuEl.addEventListener("pointerenter", () => this.cancelMenuHide());
    this.menuEl.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") this.scheduleMenuHide();
    });
  }

  private nodeByPath(path: string | null): MapNode | null {
    if (!path || !this.graph) return null;
    return this.graph.nodes.find((n) => n.file.path === path) ?? null;
  }

  private menuNode() {
    return this.nodeByPath(this.menuPath);
  }

  private showMenu(n: MapNode) {
    this.menuPath = n.file.path;
    this.menuTrashBtn.toggleClass("is-hidden", n === this.graph?.root);
    this.menuCenterBtn.toggleClass("is-hidden", n === this.graph?.root);
    this.menuEl.show();
    this.positionMenu();
  }

  private hideMenu() {
    this.cancelMenuHide();
    this.menuPath = null;
    this.menuEl?.querySelectorAll(".mind-atlas-swatches, .mind-atlas-icons").forEach((el) => el.removeClass("is-open"));
    this.menuEl?.hide();
  }

  private scheduleMenuHide() {
    this.cancelMenuHide();
    this.menuTimer = window.setTimeout(() => this.hideMenu(), 350);
  }

  private cancelMenuHide() {
    if (this.menuTimer) window.clearTimeout(this.menuTimer);
    this.menuTimer = null;
  }

  private positionMenu() {
    if (!this.menuPath || !this.menuEl) return;
    const n = this.menuNode();
    if (!n) {
      this.hideMenu();
      return;
    }
    const x = this.tx + n.x * this.scale;
    const above = this.ty + (n.y - n.h / 2) * this.scale;
    const flip = above < 44;
    const y = flip ? this.ty + (n.y + n.h / 2) * this.scale + 4 : above - 4;
    this.menuEl.style.left = `${x}px`;
    this.menuEl.style.top = `${y}px`;
    this.menuEl.style.transform = flip ? "translate(-50%, 0)" : "translate(-50%, -100%)";
  }

  /** Leave a dragged note where it was dropped, remembered as an offset from its automatic spot. */
  private dropInSpace(n: MapNode, pos: Pt, goals: Map<MapNode, Pt>) {
    const g = this.graph;
    if (!g) return;
    const parent = this.parentOf(n);
    if (parent) {
      const o = this.offsets.get(n.file.path) ?? { x: 0, y: 0 };
      const g0 = goals.get(n) ?? { x: n.gx, y: n.gy };
      const next = { x: o.x + pos.x - g0.x, y: o.y + pos.y - g0.y };
      this.offsets.set(n.file.path, next);
      this.saveLayout();
    } else {
      this.free.set(n.file.path, pos);
      this.saveLayout();
    }
    this.relayout(false);
  }

  private nodeAt(p: Pt, exclude?: MapNode): MapNode | null {
    if (!this.graph) return null;
    for (const m of this.graph.nodes) {
      if (m === exclude) continue;
      if (Math.abs(p.x - m.x) <= m.w / 2 + 4 && Math.abs(p.y - m.y) <= m.h / 2 + 4) return m;
    }
    return null;
  }

  private dropInvalid = false;
  private dragLabelEl: HTMLElement | null = null;

  private setDropTarget(t: MapNode | null, invalid = false, _d?: MapNode) {
    if (this.dropTarget === t && this.dropInvalid === invalid) return;
    if (t && t !== this.dropTarget) this.vibrate(8);
    this.dropTarget = t;
    this.dropInvalid = invalid;
    for (const [m, el] of this.nodeEls) {
      el.toggleClass("is-drop-target", m === t && !invalid);
      el.toggleClass("is-drop-invalid", m === t && invalid);
    }
  }

  private vibrate(ms: number) {
    if (this.lastPointerType !== "mouse") navigator.vibrate?.(ms);
  }

  private branchOf(n: MapNode): Set<MapNode> {
    const out = new Set<MapNode>([n]);
    const edges = this.graph?.treeEdges ?? [];
    const stack = [n];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of edges) if (e.from === cur && !out.has(e.to)) (out.add(e.to), stack.push(e.to));
    }
    return out;
  }

  private beginDragVisuals(n: MapNode, branch: Set<MapNode>) {
    this.mapEl.addClass("is-dragging-node");
    for (const [m, el] of this.nodeEls) el.toggleClass("is-dragged", branch.has(m));
    this.dragLabelEl = this.mapEl.createDiv("mind-atlas-drag-label");
    this.dragLabelEl.style.display = "none";
  }

  private updateDragVisuals(n: MapNode, t: MapNode | null, invalid: boolean) {
    if (this.previewEl) {
      this.previewEl.setAttribute("d", t && !invalid ? `M${n.x},${n.y} L${t.x},${t.y}` : "");
    }
    const l = this.dragLabelEl;
    if (!l) return;
    if (!t) {
      l.style.display = "none";
      return;
    }
    l.style.display = "block";
    l.toggleClass("is-invalid", invalid);
    l.setText(invalid ? "Can't move into its own branch" : `Move under “${t.title}”`);
    l.style.left = `${this.tx + t.x * this.scale}px`;
    l.style.top = `${this.ty + (t.y - t.h / 2) * this.scale - 8}px`;
  }

  private endDragVisuals() {
    this.mapEl.removeClass("is-dragging-node");
    for (const el of this.nodeEls.values()) el.removeClass("is-dragged");
    this.previewEl?.setAttribute("d", "");
    this.dragLabelEl?.remove();
    this.dragLabelEl = null;
  }

  private parentOf(n: MapNode): MapNode | undefined {
    return this.graph?.treeEdges.find((e) => e.to === n)?.from;
  }

  private ensureVisible(n: MapNode) {
    const r = this.svg.getBoundingClientRect();
    const m = 70;
    const sx = this.tx + n.x * this.scale;
    const sy = this.ty + n.y * this.scale;
    if (sx < m) this.tx += m - sx;
    else if (sx > r.width - m) this.tx -= sx - (r.width - m);
    if (sy < m + 30) this.ty += m + 30 - sy;
    else if (sy > r.height - m) this.ty -= sy - (r.height - m);
    this.applyTransform();
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
    if (e.altKey) return;
    const g = this.graph;
    if (!g) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (mod) {
      if (key === "z") {
        e.preventDefault();
        void (e.shiftKey ? this.undo.redo() : this.undo.undo());
      } else if (key === "y") {
        e.preventDefault();
        void this.undo.redo();
      } else if (key === "f") {
        e.preventDefault();
        this.openFinder();
      }
      return;
    }
    const n = this.nodeByPath(this.selectedPath) ?? g.root;

    if (e.key === "Escape") {
      this.setTool("select");
      this.selectedEdgeKey = null;
      this.refreshEdgeSelection();
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      this.navigate(e.key);
    } else if (e.key === "Tab" || (e.key === "Enter" && e.shiftKey)) {
      e.preventDefault();
      void this.addChildOf(n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void this.addSibling(n);
    } else if (e.key === "F2") {
      e.preventDefault();
      void this.renameNode(n);
    } else if (e.key === " ") {
      e.preventDefault();
      this.toggleCollapse(n);
    } else if (e.key === "+" || e.key === "=") {
      this.zoomBy(1.25);
    } else if (e.key === "-") {
      this.zoomBy(0.8);
    } else if (e.key === "0") {
      this.fitMap();
    } else if (key === "r" && n !== g.root) {
      void this.setRoot(n.file);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (this.selectedEdgeKey) {
        void this.unlinkEdge(this.selectedEdgeKey);
      } else {
        void this.deleteNode(n);
      }
    }
  }

  /** Up/down: parent/child. Left/right: previous/next note in the same generation, in reading order. */
  private navigate(key: string) {
    const g = this.graph;
    if (!g) return;
    const cur = this.nodeByPath(this.selectedPath) ?? g.root;
    const radial = this.plugin.settings.layoutMode === "radial";
    let next: MapNode | undefined;
    if (key === "ArrowUp") next = this.parentOf(cur);
    else if (key === "ArrowDown") next = g.treeEdges.find((e) => e.from === cur)?.to;
    else if (key === "ArrowLeft" || key === "ArrowRight") {
      // Radial: clockwise around the center, starting at the top. Tree: top to bottom per side.
      const order = (m: MapNode) =>
        radial ? (Math.atan2(m.y - g.root.y, m.x - g.root.x) + Math.PI / 2 + Math.PI * 4) % (Math.PI * 2) : m.y;
      const same = g.nodes
        .filter((m) => m.depth === cur.depth && (radial || m.side === cur.side))
        .sort((a, b) => order(a) - order(b) || a.x - b.x);
      next = same[same.indexOf(cur) + (key === "ArrowRight" ? 1 : -1)];
    }
    if (!next) return;
    this.selectedEdgeKey = null;
    this.refreshEdgeSelection();
    this.selectNode(next.file);
    this.ensureVisible(next);
  }

  // ---------- rename, collapse, metadata, find, export ----------

  private async addSibling(n: MapNode) {
    const g = this.graph;
    const parent = n === g?.root ? undefined : this.parentOf(n);
    if (!parent) {
      void this.addChildOf(n);
      return;
    }
    await this.addChildOf(parent);
  }

  private async renameNode(n: MapNode) {
    this.setTool("select");
    const name = await this.promptInline({ x: n.x, y: n.y }, n.depth, "center", undefined, n.title);
    if (name) await this.renameFile(n.file, name);
  }

  /** Rename a note (its title is its file name) and carry the map's per-note state along. */
  private async renameFile(file: TFile, raw: string) {
    const title = sanitizeTitle(raw);
    if (!title || title === file.basename) {
      if (this.editor?.currentFile === file) this.editorTitle.value = file.basename;
      return;
    }
    const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
    const newPath = `${dir}${title}.md`;
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      new Notice(`A note named “${title}” already exists.`);
      this.editorTitle.value = file.basename;
      return;
    }
    const old = file.path;
    try {
      await this.editor?.flush();
      await this.app.fileManager.renameFile(file, newPath);
      if (this.editor?.currentFile === file) this.editorTitle.value = file.basename;
      const move = <T,>(m: Map<string, T>) => {
        if (m.has(old)) m.set(newPath, m.get(old)!);
        m.delete(old);
      };
      move(this.layouts.radial);
      move(this.layouts.tree);
      move(this.free);
      this.saveLayout();
      move(this.positions);
      if (this.collapsed.delete(old)) this.collapsed.add(newPath);
      this.extras = this.extras.map((p) => (p === old ? newPath : p));
      if (this.selectedPath === old) this.selectedPath = newPath;
      this.undo.clear();
      (this.leaf as any).updateHeader?.();
    } catch (err) {
      new Notice(`MindAtlas: could not rename (${(err as Error).message})`);
    }
    this.scheduleRefresh();
  }

  private toggleCollapse(n: MapNode) {
    if (!n.collapsed && !n.children.length && !n.truncated && !n.hidden) return;
    if (this.collapsed.has(n.file.path)) this.collapsed.delete(n.file.path);
    else this.collapsed.add(n.file.path);
    this.app.workspace.requestSaveLayout();
    void this.render(false);
  }

  private setMeta(n: MapNode, key: string, value: string | null) {
    return this.setMetaMany(n, { [key]: value });
  }

  private async setMetaMany(n: MapNode, values: Record<string, string | null>) {
    try {
      await this.editor?.flush();
      await this.undo.run("style", [n.file.path], async () => {
        await this.app.fileManager.processFrontMatter(n.file, (fm) => {
          for (const [k, v] of Object.entries(values)) {
            if (v === null) delete fm[k];
            else fm[k] = v;
          }
        });
      });
    } catch (err) {
      new Notice(`MindAtlas: could not update the note (${(err as Error).message})`);
    }
  }

  private showContextMenu(n: MapNode, ev: MouseEvent | { x: number; y: number }) {
    const g = this.graph;
    if (!g) return;
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Rename").setIcon(fi("pencil")).onClick(() => void this.renameNode(n)));
    if (n !== g.root) {
      menu.addItem((i) => i.setTitle("Make center of map").setIcon(fi("locate-fixed")).onClick(() => void this.setRoot(n.file)));
    }
    menu.addItem((i) =>
      i
        .setTitle(n.collapsed ? "Expand branch" : "Collapse branch")
        .setIcon(n.collapsed ? "chevrons-up-down" : "chevrons-down-up")
        .onClick(() => this.toggleCollapse(n))
    );
    menu.addItem((i) =>
      i.setTitle("Open note in a tab").setIcon(fi("file-text")).onClick(() => void this.app.workspace.getLeaf("tab").openFile(n.file))
    );
    menu.addSeparator();
    menu.addItem((i) => {
      i.setTitle("Color").setIcon(fi("palette"));
      const sub = (i as any).setSubmenu?.() as Menu | undefined;
      if (!sub) return;
      for (const [c, name] of KELLY) {
        sub.addItem((j) => j.setTitle(name).onClick(() => void this.setMeta(n, "mindmap-color", c)));
      }
    });
    if (n.iconName) {
      menu.addItem((i) => i.setTitle("Remove icon").setIcon(fi("x")).onClick(() => void this.setMetaMany(n, { "mindmap-icon": null, "mindmap-status": null })));
    }
    menu.addItem((i) => i.setTitle("Color: automatic").setIcon(fi("eraser")).onClick(() => void this.setMeta(n, "mindmap-color", null)));
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Icon…").setIcon(fi("shapes")).onClick(() => {
        this.showMenu(n);
        this.openIconPalette();
      })
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Copy branch as outline").setIcon(fi("copy")).onClick(() => void this.copyOutline(n))
    );
    if (ev instanceof MouseEvent) menu.showAtMouseEvent(ev);
    else menu.showAtPosition(ev);
  }

  private branchOutline(n: MapNode) {
    const kids = childMap(this.graph?.treeEdges ?? []);
    return toOutline(n, kids);
  }

  private async copyOutline(n: MapNode) {
    await navigator.clipboard.writeText(this.branchOutline(n));
    new Notice("Outline copied.");
  }

  private openFinder() {
    new NoteFinder(this.app, (f) => {
      const n = this.graph?.nodes.find((m) => m.file.path === f.path);
      if (n) {
        this.selectNode(f);
        this.ensureVisible(n);
      } else {
        void this.setRoot(f);
      }
    }).open();
  }

  /** Public so the "find note" command can use it. */
  focusFinder() {
    this.openFinder();
  }

  private showExportMenu(ev: MouseEvent) {
    const g = this.graph;
    if (!g) return;
    const menu = new Menu();
    const stamp = this.rootFile?.basename ?? "map";
    const render = () => mapToSvg(this.svg, this.group, g.nodes);
    menu.addItem((i) =>
      i.setTitle("Save as SVG").setIcon(fi("image")).onClick(async () => {
        try {
          await saveToVault(this.app, `${stamp} map.svg`, render().text);
        } catch (err) {
          new Notice(`MindAtlas: export failed (${(err as Error).message})`);
        }
      })
    );
    menu.addItem((i) =>
      i.setTitle("Save as PNG").setIcon(fi("image")).onClick(async () => {
        try {
          const r = render();
          await saveToVault(this.app, `${stamp} map.png`, await svgToPng(r.text, r.w, r.h));
        } catch (err) {
          new Notice(`MindAtlas: export failed (${(err as Error).message})`);
        }
      })
    );
    menu.addItem((i) =>
      i.setTitle("Save outline as a note").setIcon(fi("list")).onClick(async () => {
        try {
          await saveToVault(this.app, `${stamp} outline.md`, this.branchOutline(g.root));
        } catch (err) {
          new Notice(`MindAtlas: export failed (${(err as Error).message})`);
        }
      })
    );
    menu.addItem((i) => i.setTitle("Copy outline").setIcon(fi("copy")).onClick(() => void this.copyOutline(g.root)));
    menu.showAtMouseEvent(ev);
  }

  private retidy() {
    this.offsets.clear();
    this.free.clear();
    this.saveLayout();
    this.relayout(false);
  }

  private refreshCrossLinks() {
    const mode = this.plugin.settings.crossLinks;
    for (const e of this.edgeEls) {
      if (!e.cross) continue;
      const on =
        mode === "always" ||
        (mode === "hover" && (e.edge.from.file.path === this.selectedPath || e.edge.to.file.path === this.selectedPath));
      for (const el of [e.el, e.hit, ...e.heads]) el.toggleClass("is-hidden", !on);
    }
  }

  // ---------- link preview and the link tool ----------

  private updatePreview() {
    if (!this.previewEl) return;
    const src = this.nodeByPath(this.linkSourcePath);
    if (!src || !this.pointerGraph) {
      this.previewEl.setAttribute("d", "");
      return;
    }
    this.previewEl.setAttribute("d", `M${src.x},${src.y} L${this.pointerGraph.x},${this.pointerGraph.y}`);
  }

  private linkPointerDown(n: MapNode, e: PointerEvent, g: SVGGElement) {
    this.suppressClick = true;
    const pending = this.nodeByPath(this.linkSourcePath);
    if (pending && pending !== n) {
      void this.finishLink(pending, n); // click source, then click target
      return;
    }
    this.linkSourcePath = n.file.path;
    this.pointerGraph = this.toGraphCoords(e);
    this.updatePreview();
    g.setPointerCapture(e.pointerId);
    g.addEventListener(
      "pointerup",
      (ev) => {
        const t = this.nodeAt(this.toGraphCoords(ev), n);
        if (t) void this.finishLink(n, t); // drag from source onto target
      },
      { once: true }
    );
  }

  private async finishLink(src: MapNode, dst: MapNode) {
    this.setTool("select");
    const choice = await this.chooseRelation(dst);
    if (!choice) return;
    if (choice === "connection") return this.connect(src.file, dst.file);
    try {
      await this.editor?.flush();
      let added = false;
      await this.undo.run("link", [src.file.path], async () => {
        added = await addLink(this.app, src.file, dst.file);
      });
      new Notice(
        added ? `Linked “${src.title}” → “${dst.title}”` : `“${src.title}” already links to “${dst.title}”`
      );
    } catch (err) {
      new Notice(`MindAtlas: could not add link (${(err as Error).message})`);
    }
    this.scheduleRefresh();
  }

  // ---------- creating, moving and deleting notes ----------

  /** Drag a note from the file explorer onto a map node to link it from that node. */
  private bindFileDrop() {
    const fileFrom = (e: DragEvent): TFile | null => {
      const dragged = (this.app as any).dragManager?.draggable;
      if (dragged?.file instanceof TFile) return dragged.file;
      const text = e.dataTransfer?.getData("text/plain") ?? "";
      const m = /[?&]file=([^&]+)/.exec(text);
      const name = m ? decodeURIComponent(m[1]) : text.replace(/^\[\[|\]\]$/g, "");
      if (!name) return null;
      return (
        this.app.metadataCache.getFirstLinkpathDest(name, "") ??
        (this.app.vault.getAbstractFileByPath(name) instanceof TFile ? (this.app.vault.getAbstractFileByPath(name) as TFile) : null)
      );
    };
    const nodeUnder = (e: DragEvent) => {
      const r = this.svg.getBoundingClientRect();
      return this.nodeAt({ x: (e.clientX - r.left - this.tx) / this.scale, y: (e.clientY - r.top - this.ty) / this.scale });
    };
    let hot: MapNode | null = null;
    const setHot = (n: MapNode | null) => {
      if (hot === n) return;
      if (hot) this.nodeEls.get(hot)?.removeClass("is-drop-target");
      hot = n;
      if (hot) this.nodeEls.get(hot)?.addClass("is-drop-target");
    };
    this.svg.addEventListener("dragover", (e) => {
      const n = nodeUnder(e);
      setHot(n);
      if (n) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "link";
      }
    });
    this.svg.addEventListener("dragleave", () => setHot(null));
    this.svg.addEventListener("drop", (e) => {
      const n = nodeUnder(e);
      setHot(null);
      const f = fileFrom(e);
      if (!n || !f || f.extension !== "md") return;
      e.preventDefault();
      if (f.path === n.file.path) return;
      void this.linkDropped(n, f);
    });
  }

  private async linkDropped(n: MapNode, f: TFile) {
    const choice = await this.chooseRelation(n);
    if (!choice) return;
    const [src, dst] = n.side === -1 ? [f, n.file] : [n.file, f];
    if (choice === "connection") return this.connect(src, dst);
    try {
      await this.editor?.flush();
      let added = false;
      await this.undo.run("link", [src.path], async () => {
        added = await addLink(this.app, src, dst);
      });
      new Notice(added ? `Linked “${src.basename}” → “${dst.basename}”` : `“${src.basename}” already links to “${dst.basename}”`);
      if (n.depth + 1 > this.depth) {
        this.depth = Math.min(6, n.depth + 1);
        this.syncToolbar();
      }
      this.pendingSelect = f.path;
    } catch (err) {
      new Notice(`MindAtlas: could not add link (${(err as Error).message})`);
    }
    this.scheduleRefresh();
  }

  private async addChildOf(n: MapNode) {
    this.setTool("select");
    const { pos, anchor } = this.newChildSpot(n);
    const name = await this.promptInline(pos, n.depth + 1, anchor, n);
    if (!name) return;
    try {
      await this.editor?.flush();
      await this.undo.run("new note", [n.file.path], async () => {
        const file = await createNote(this.app, name, n.file);
        // On the backlink side a "child" is a note that links to this one.
        if (n.side === -1) await addLink(this.app, file, n.file);
        else await addLink(this.app, n.file, file);
        this.positions.set(file.path, pos);
        this.pendingSelect = file.path;
        return [file.path];
      });
      // Make sure the new note is within the shown depth.
      if (n.depth + 1 > this.depth) {
        this.depth = Math.min(6, n.depth + 1);
        this.syncToolbar();
        this.app.workspace.requestSaveLayout();
      }
    } catch (err) {
      new Notice(`MindAtlas: could not create note (${(err as Error).message})`);
    }
    this.scheduleRefresh();
  }

  /** Where a new child of `n` should appear: continuing outward from its parent, clear of other notes. */
  private newChildSpot(n: MapNode): { pos: Pt; anchor: "left" | "right" } {
    const g = this.graph;
    if (this.plugin.settings.layoutMode === "tree" || !g) {
      const kids = (g?.treeEdges ?? []).filter((e) => e.from === n && e.to.side === n.side).map((e) => e.to);
      const dir = n.side === -1 ? -1 : 1;
      return {
        pos: {
          x: n.x + dir * (n.w / 2 + 70),
          y: kids.length ? Math.max(...kids.map((k) => k.y + k.h)) + 20 : n.y,
        },
        anchor: dir === -1 ? "right" : "left",
      };
    }
    const parent = this.parentOf(n);
    let base = parent ? Math.atan2(n.y - parent.y, n.x - parent.x) : n.side === -1 ? Math.PI : 0;
    if (!parent && !g.nodes.some((m) => m !== n)) base = 0;
    const dist = Math.max(n.w, n.h) / 2 + 90;
    let best: Pt = { x: n.x + Math.cos(base) * dist, y: n.y + Math.sin(base) * dist };
    let bestScore = -Infinity;
    for (const deg of [0, 25, -25, 50, -50, 75, -75, 100, -100, 130, -130, 180]) {
      const a = base + (deg * Math.PI) / 180;
      const p = { x: n.x + Math.cos(a) * dist, y: n.y + Math.sin(a) * dist };
      let nearest = Infinity;
      for (const m of g.nodes) {
        if (m === n) continue;
        nearest = Math.min(nearest, Math.hypot(m.x - p.x, m.y - p.y) - Math.max(m.w, m.h) / 2);
      }
      const score = Math.min(nearest, 60) - Math.abs(deg) * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return { pos: best, anchor: best.x >= n.x ? "left" : "right" };
  }

  /** New note at a spot on the canvas; stays floating until something links to it. */
  private async addFloating(pos: Pt) {
    this.setTool("select");
    if (!this.rootFile) return;
    const name = await this.promptInline(pos, 1, "center");
    if (!name) return;
    try {
      await this.undo.run("new note", [], async () => {
        const file = await createNote(this.app, name, this.rootFile!);
        this.extras.push(file.path);
        this.positions.set(file.path, pos);
        this.free.set(file.path, pos);
        this.saveLayout();
        this.pendingSelect = file.path;
        return [file.path];
      });
      await this.render(false);
    } catch (err) {
      new Notice(`MindAtlas: could not create note (${(err as Error).message})`);
    }
  }

  /** Type a new note's title directly on the canvas. Enter accepts, Esc cancels. */
  private promptInline(pos: Pt, depth: number, anchor: "left" | "right" | "center", parent?: MapNode, initial?: string): Promise<string | null> {
    this.closeInline?.(null);
    return new Promise((resolve) => {
      const sizes = this.plugin.settings.headingSizes;
      const px = sizes[Math.min(depth, sizes.length - 1)];
      // Hide the editor while typing so the on-screen keyboard leaves room for the map.
      this.contentEl.addClass("is-prompting");
      const el = this.mapEl.createDiv("mind-atlas-inline");
      el.setAttr("data-placeholder", "type here");
      el.setAttr("contenteditable", "plaintext-only");
      if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
      el.style.fontFamily = this.plugin.settings.fontFamily || getComputedStyle(this.contentEl).fontFamily;
      this.inline = { el, pos, anchor, px, parent };
      this.positionInline();
      let done = false;
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        this.inline?.line?.remove();
        this.inline = null;
        this.closeInline = null;
        el.remove();
        this.contentEl.removeClass("is-prompting");
        window.visualViewport?.removeEventListener("resize", reveal);
        window.visualViewport?.removeEventListener("scroll", reveal);
        restore();
        this.mapEl.focus({ preventScroll: true });
        resolve(v && v.trim() ? v.trim() : null);
      };
      this.closeInline = finish;
      // On touch devices, center the node in the part of the map the keyboard leaves visible,
      // and put the view back afterwards.
      const saved = { tx: this.tx, ty: this.ty };
      const reveal = () => {
        if (done || !Platform.isMobile) return;
        // iOS scrolls the page to show a focused field; undo that so the map stays put.
        window.scrollTo(0, 0);
        for (const e of [document.scrollingElement, this.contentEl, this.mapEl]) if (e) e.scrollTop = 0;
        const vv = window.visualViewport;
        const r = this.mapEl.getBoundingClientRect();
        const top = Math.max(r.top, vv?.offsetTop ?? 0);
        const bottom = Math.min(r.bottom, vv ? vv.offsetTop + vv.height : window.innerHeight);
        const left = Math.max(r.left, vv?.offsetLeft ?? 0);
        const right = Math.min(r.right, vv ? vv.offsetLeft + vv.width : window.innerWidth);
        if (bottom - top < 40 || right - left < 40) return;
        this.tx = (left + right) / 2 - r.left - pos.x * this.scale;
        this.ty = (top + bottom) / 2 - r.top - pos.y * this.scale;
        this.applyTransform();
      };
      const restore = () => {
        if (!Platform.isMobile) return;
        this.tx = saved.tx;
        this.ty = saved.ty;
        this.applyTransform();
      };
      window.visualViewport?.addEventListener("resize", reveal);
      window.visualViewport?.addEventListener("scroll", reveal);
      el.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(el.innerText);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      });
      el.addEventListener("input", () => this.positionInline());
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("blur", () => finish(el.innerText));
      if (initial !== undefined) {
        el.addClass("is-rename");
        el.textContent = initial;
      }
      window.setTimeout(() => {
        el.focus({ preventScroll: true });
        reveal();
        window.setTimeout(reveal, 350);
        window.setTimeout(reveal, 800);
        if (initial !== undefined) document.getSelection()?.selectAllChildren(el);
      }, 0);
    });
  }

  private positionInline() {
    const i = this.inline;
    if (!i) return;
    i.el.style.left = `${this.tx + i.pos.x * this.scale}px`;
    i.el.style.top = `${this.ty + i.pos.y * this.scale}px`;
    i.el.style.fontSize = `${Math.max(i.px * this.scale, Platform.isMobile ? 16 : 0)}px`;
    i.el.style.transform = `translate(${i.anchor === "left" ? "0" : i.anchor === "right" ? "-100%" : "-50%"}, -50%)`;
    this.drawInlineLine();
  }

  /** Keep a line joined to the "type here" field while it is being typed. */
  private drawInlineLine() {
    const i = this.inline;
    if (!i || !i.parent || i.anchor === "center" || !this.group) return;
    const organic = this.plugin.settings.lineStyle === "organic";
    if (!i.line) i.line = this.group.createSvg("path");
    const line = i.line;
    if (!line.isConnected) this.group.insertBefore(line, this.group.firstChild);
    line.setAttribute("class", organic ? "mind-atlas-edge-fill" : "mind-atlas-edge");
    line.addClass("is-inline");
    const par = i.parent;
    const right = i.anchor === "left"; // field sits to the right of its parent
    const end = { x: i.pos.x + (right ? -2 : 2), y: i.pos.y };
    const style = this.plugin.settings.lineStyle;
    let a: Anchor;
    const bAnchor: Anchor = { p: end, dir: right ? SIDE_DIR.L : SIDE_DIR.R };
    if (this.plugin.settings.layoutMode === "radial") {
      a = this.boundaryAnchor(par, end);
    } else {
      a = { p: { x: par.x + (right ? par.w / 2 : -par.w / 2), y: par.y }, dir: right ? SIDE_DIR.R : SIDE_DIR.L };
    }
    line.setAttribute("d", this.linePath(a, bAnchor, style, 1, [this.fontOf(par).px / 18, i.px / 18]));
    const width = this.plugin.settings.lineWidth;
    if (!organic) line.style.strokeWidth = String(width);
    const c = this.plugin.settings.lineColor;
    if (c) {
      if (organic) line.style.fill = c;
      else line.style.stroke = c;
    }
  }

  /** Move `d` (and its branch) so that `t` links to it instead of its old parent. */
  private async reparent(d: MapNode, t: MapNode) {
    const g = this.graph;
    if (!g || d === g.root || d === t) return;
    const parent = this.parentOf(d);
    if (parent === t) return;
    for (let a: MapNode | undefined = t; a; a = this.parentOf(a)) {
      if (a === d) {
        new Notice("A note can't be moved into its own branch.");
        return;
      }
    }
    try {
      await this.editor?.flush();
      // Outgoing notes are linked from their parent; backlink notes link to it.
      const paths = [d.file.path, t.file.path, ...(parent ? [parent.file.path] : [])];
      await this.undo.run("move", paths, async () => {
        if (parent) {
          if (d.side === -1) await removeChild(this.app, d.file, parent.file);
          else await removeChild(this.app, parent.file, d.file);
        }
        if (d.side === -1) await addLink(this.app, d.file, t.file);
        else await addLink(this.app, t.file, d.file);
      });
      new Notice(`Moved “${d.title}” under “${t.title}” (⌘Z to undo)`);
    } catch (err) {
      new Notice(`MindAtlas: could not move note (${(err as Error).message})`);
    }
    this.scheduleRefresh();
  }

  private async unlinkEdge(key: string) {
    const entry = this.edgeEls.find((e) => e.key === key);
    this.selectedEdgeKey = null;
    this.refreshEdgeSelection();
    if (!entry) return;
    const { from, to } = entry.edge;
    try {
      await this.editor?.flush();
      let n = 0;
      await this.undo.run("unlink", [from.file.path, to.file.path], async () => {
        n =
          (await removeLinks(this.app, from.file, to.file)) +
          (await removeLinks(this.app, to.file, from.file));
      });
      new Notice(n ? `Removed link between “${from.title}” and “${to.title}”` : "No link to remove.");
    } catch (err) {
      new Notice(`MindAtlas: could not remove link (${(err as Error).message})`);
    }
    this.scheduleRefresh();
  }

  private async deleteNode(n: MapNode) {
    const g = this.graph;
    if (!g) return;
    if (n === g.root) {
      new Notice("The center note can't be deleted. Re-root the map first.");
      return;
    }
    const parent = this.parentOf(n);
    const incoming = Object.entries(this.app.metadataCache.resolvedLinks)
      .filter(([src, links]) => src !== n.file.path && links[n.file.path])
      .map(([src]) => src);

    const choices = [
      parent
        ? { label: "Remove link only", value: "unlink" as const }
        : { label: "Remove from map", value: "forget" as const },
      { label: "Move note to trash", value: "trash" as const, warning: true },
    ];
    const pick = await askChoice(
      this.app,
      `Delete “${n.title}”?`,
      `“${n.title}” is linked from ${incoming.length} note${incoming.length === 1 ? "" : "s"}. ` +
        `Removing the link keeps the note. Moving it to the trash also removes links to it from those notes.`,
      choices
    );
    if (!pick) return;

    try {
      await this.editor?.flush();
      const touched = [n.file.path, ...(parent ? [parent.file.path] : []), ...(pick === "trash" ? incoming : [])];
      await this.undo.run(pick === "trash" ? "delete" : "unlink", touched, async () => {
        if (pick === "unlink" && parent) {
          if (n.side === -1) await removeChild(this.app, n.file, parent.file);
          else await removeChild(this.app, parent.file, n.file);
        } else if (pick === "trash") {
          for (const src of incoming) {
            const f = this.app.vault.getAbstractFileByPath(src);
            if (f instanceof TFile) await removeLinks(this.app, f, n.file);
          }
          await this.app.fileManager.trashFile(n.file);
        }
      });
      this.extras = this.extras.filter((p) => p !== n.file.path);
      this.selectNode((parent ?? g.root).file);
      this.hideMenu();
    } catch (err) {
      new Notice(`MindAtlas: could not delete (${(err as Error).message})`);
    }
    this.scheduleRefresh();
  }
}

/** Triangle with its tip at `tip`, pointing along `dir`. */
function arrowHead(tip: Pt, dir: Pt, size: number): string {
  const bx = tip.x - dir.x * size;
  const by = tip.y - dir.y * size;
  const w = size * 0.45;
  const px = -dir.y * w;
  const py = dir.x * w;
  return `M${tip.x},${tip.y} L${bx + px},${by + py} L${bx - px},${by - py} Z`;
}
