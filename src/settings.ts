import { App, PluginSettingTab, Setting } from "obsidian";
import type MindAtlasPlugin from "./main";

export interface MindAtlasSettings {
  // Font sizes in px for H1 (root) .. H6; deeper generations reuse H6.
  headingSizes: number[];
  // Empty string = use the Obsidian theme font.
  fontFamily: string;
  showBoxes: boolean;
  boxFilled: boolean;
  boxCornerRadius: number;
  boxBorderWidth: number;
  boxPadding: number;
  // Empty string = theme accent color.
  boxColor: string;
  lineWidth: number;
  // Lines get thinner for deeper generations.
  taperLines: boolean;
  // Empty string = theme faint text color.
  lineColor: string;
  crossLinks: "always" | "hover" | "never";
  branchColors: boolean;
  maxNodes: number;
  iconSize: number;
  showConnections: boolean;
  defaultDepth: number;
  // Gap in px between linked nodes.
  spacing: number;
  minLine: number;
  childCap: number;
  showLabels: boolean;
  collapseBacklinks: boolean;
  hasSeenGuide: boolean;
}

export const DEFAULT_SETTINGS: MindAtlasSettings = {
  headingSizes: [36, 24, 18, 14, 12, 10],
  fontFamily: "",
  showBoxes: true,
  boxFilled: true,
  boxCornerRadius: 8,
  boxBorderWidth: 1.5,
  boxPadding: 12,
  boxColor: "",
  lineWidth: 1.5,
  taperLines: true,
  lineColor: "",
  crossLinks: "always",
  branchColors: true,
  maxNodes: 400,
  iconSize: 28,
  showConnections: false,
  defaultDepth: 3,
  spacing: 30,
  minLine: 0,
  childCap: 8,
  showLabels: true,
  collapseBacklinks: true,
  hasSeenGuide: false,
};

export function defaultSettings(): MindAtlasSettings {
  return {
    ...DEFAULT_SETTINGS,
    headingSizes: [...DEFAULT_SETTINGS.headingSizes],
  };
}

/** Merge saved data over defaults, clamping every value to its valid range. */
export function sanitizeSettings(saved: any): MindAtlasSettings {
  const d = DEFAULT_SETTINGS;
  const s = saved && typeof saved === "object" ? saved : {};
  const num = (v: unknown, def: number, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
  const str = (v: unknown, def: string) => (typeof v === "string" ? v : def);
  return {
    headingSizes: d.headingSizes.map((def, i) =>
      num(Array.isArray(s.headingSizes) ? s.headingSizes[i] : undefined, def, 8, 72)
    ),
    fontFamily: str(s.fontFamily, d.fontFamily),
    showBoxes: bool(s.showBoxes, d.showBoxes),
    boxFilled: bool(s.boxFilled, d.boxFilled),
    boxCornerRadius: num(s.boxCornerRadius, d.boxCornerRadius, 0, 24),
    boxBorderWidth: num(s.boxBorderWidth, d.boxBorderWidth, 0, 6),
    boxPadding: num(s.boxPadding, d.boxPadding, 2, 30),
    boxColor: str(s.boxColor, d.boxColor),
      lineWidth: num(s.lineWidth, d.lineWidth, 0.5, 8),
    taperLines: bool(s.taperLines, d.taperLines),
    lineColor: str(s.lineColor, d.lineColor),
    crossLinks:
      s.crossLinks === "hover" || s.crossLinks === "never" || s.crossLinks === "always"
        ? s.crossLinks
        : s.showCrossLinks === false
        ? "never"
        : d.crossLinks,
    branchColors: bool(s.branchColors, d.branchColors),
    showConnections: s.showConnections === true,
    iconSize: num(s.iconSize, d.iconSize, 10, 80),
    maxNodes: num(s.maxNodes, d.maxNodes, 50, 2000),
    defaultDepth: Math.round(num(s.defaultDepth, d.defaultDepth, 1, 6)),
    spacing: num(s.spacing, d.spacing, 0, 200),
    minLine: num(s.minLine, d.minLine, 0, 300),
    showLabels: s.showLabels !== false,
    childCap: num(s.childCap, d.childCap, 0, 100),
    collapseBacklinks: typeof s.collapseBacklinks === "boolean" ? s.collapseBacklinks : d.collapseBacklinks,
    hasSeenGuide: bool(s.hasSeenGuide, d.hasSeenGuide),
  };
}

const FONT_PRESETS: Record<string, string> = {
  "": "Theme default",
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif": "System sans-serif",
  "Georgia, 'Times New Roman', serif": "Serif",
  "'SF Mono', Menlo, Consolas, monospace": "Monospace",
  "'Avenir Next', 'Helvetica Neue', Arial, sans-serif": "Avenir / Helvetica",
  "'Comic Sans MS', 'Marker Felt', cursive": "Handwritten",
  custom: "Custom…",
};

const FALLBACK_COLOR = "#7c5cff";

export class MindAtlasSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MindAtlasPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.createEl("p", { cls: "setting-item-description", text: `MindAtlas ${this.plugin.manifest.version} — built ${__BUILD__}` });

    const slider = (
      parent: HTMLElement,
      name: string,
      min: number,
      max: number,
      step: number,
      get: () => number,
      set: (v: number) => void
    ) =>
      new Setting(parent).setName(name).addSlider((sl) =>
        sl
          .setLimits(min, max, step)
          .setValue(get())
          .setDynamicTooltip()
          .onChange(async (v) => {
            set(v);
            await save();
          })
      );

    const color = (name: string, desc: string, get: () => string, set: (v: string) => void) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addColorPicker((c) =>
          c.setValue(get() || FALLBACK_COLOR).onChange(async (v) => {
            set(v);
            await save();
          })
        )
        .addExtraButton((b) =>
          b
            .setIcon("rotate-ccw")
            .setTooltip("Use theme color")
            .onClick(async () => {
              set("");
              await save();
              this.display();
            })
        );

    // Layout
    new Setting(containerEl).setName("Layout").setHeading();
    slider(containerEl, "Children shown per note", 0, 30, 1, () => s.childCap, (v) => (s.childCap = v)).setDesc(
      "Notes with more children show a “+N more” button instead. 0 shows everything."
    );
    slider(containerEl, "Minimum line length", 0, 300, 5, () => s.minLine, (v) => (s.minLine = v)).setDesc(
      "The shortest a parent-to-child line may be, measured between the edges of the two boxes."
    );
    slider(containerEl, "Node spacing", 0, 200, 5, () => s.spacing, (v) => (s.spacing = v)).setDesc(
      "Gap between a note and its children. Branches arrange themselves around the center; you can also drag notes."
    );

    slider(containerEl, "Maximum notes shown", 50, 2000, 50, () => s.maxNodes, (v) => (s.maxNodes = v)).setDesc(
      "Larger maps are slower. Notes beyond this are hidden behind a “…” marker."
    );
    slider(containerEl, "Default depth", 1, 6, 1, () => s.defaultDepth, (v) => (s.defaultDepth = v)).setDesc(
      "Generations shown when a map is first opened. Maps you've already opened keep their own depth."
    );
    slider(containerEl, "Icon size", 10, 80, 2, () => s.iconSize, (v) => (s.iconSize = v)).setDesc(
      "Size in px of the icon shown above a note."
    );
    new Setting(containerEl)
      .setName("Branch colors")
      .setDesc("Color each branch differently. A note's mindmap-color frontmatter overrides it.")
      .addToggle((t) =>
        t.setValue(s.branchColors).onChange(async (v) => {
          s.branchColors = v;
          await save();
        })
      );

    // Font
    new Setting(containerEl).setName("Font").setHeading();
    const isPreset = s.fontFamily in FONT_PRESETS && s.fontFamily !== "custom";
    new Setting(containerEl)
      .setName("Font family")
      .setDesc("Font used for node titles in the map.")
      .addDropdown((d) =>
        d
          .addOptions(FONT_PRESETS)
          .setValue(isPreset ? s.fontFamily : "custom")
          .onChange(async (v) => {
            if (v !== "custom") s.fontFamily = v;
            else if (isPreset) s.fontFamily = "Georgia";
            await save();
            this.display();
          })
      );
    if (!isPreset) {
      new Setting(containerEl)
        .setName("Custom font")
        .setDesc("Any installed font name or CSS font-family list, e.g. Helvetica Neue, sans-serif.")
        .addText((t) =>
          t.setValue(s.fontFamily).onChange(async (v) => {
            s.fontFamily = v.trim() || "Georgia";
            await save();
          })
        );
    }

    new Setting(containerEl).setName("Heading sizes").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Node text size by generation. The center node is H1; deeper generations reuse H6. Sizes are in pixels.",
    });
    s.headingSizes.forEach((_, i) =>
      slider(
        containerEl,
        i === 0 ? "H1 (center node)" : `H${i + 1}`,
        8,
        72,
        1,
        () => s.headingSizes[i],
        (v) => (s.headingSizes[i] = v)
      )
    );

    // Boxes
    new Setting(containerEl).setName("Boxes").setHeading();
    new Setting(containerEl)
      .setName("Show boxes")
      .setDesc("Draw a box around each node. Boxes always size themselves to fit the text.")
      .addToggle((t) =>
        t.setValue(s.showBoxes).onChange(async (v) => {
          s.showBoxes = v;
          await save();
          this.display();
        })
      );
    if (s.showBoxes) {
      new Setting(containerEl)
        .setName("Fill boxes")
        .setDesc("Fill with the theme background (the center node is always filled).")
        .addToggle((t) =>
          t.setValue(s.boxFilled).onChange(async (v) => {
            s.boxFilled = v;
            await save();
          })
        );
      color("Box color", "Border color, and fill color of the center node.", () => s.boxColor, (v) => (s.boxColor = v));
      slider(containerEl, "Corner radius", 0, 24, 1, () => s.boxCornerRadius, (v) => (s.boxCornerRadius = v));
      slider(containerEl, "Border width", 0, 6, 0.5, () => s.boxBorderWidth, (v) => (s.boxBorderWidth = v));
      slider(containerEl, "Padding", 2, 30, 1, () => s.boxPadding, (v) => (s.boxPadding = v));
    }

    // Lines
    new Setting(containerEl).setName("Lines").setHeading();
    slider(containerEl, "Line thickness", 0.5, 8, 0.5, () => s.lineWidth, (v) => (s.lineWidth = v));
    new Setting(containerEl)
      .setName("Thinner lines for deeper generations")
      .setDesc("Each generation's lines are thinner than the one before.")
      .addToggle((t) =>
        t.setValue(s.taperLines).onChange(async (v) => {
          s.taperLines = v;
          await save();
        })
      );
    color("Line color", "Color of connecting lines.", () => s.lineColor, (v) => (s.lineColor = v));
    new Setting(containerEl)
      .setName("Show line labels")
      .setDesc("Show the remark written after a link in a note's Map block (for example “- [[Note]] — why”) on its line.")
      .addToggle((t) =>
        t.setValue(s.showLabels).onChange(async (v) => {
          s.showLabels = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Collapse backlinks")
      .setDesc("Hide backlink notes behind a “+N backlinks” button until you click it.")
      .addToggle((t) =>
        t.setValue(s.collapseBacklinks).onChange(async (v) => {
          s.collapseBacklinks = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Show all connections")
      .setDesc("Also show notes linked to or from the notes on the map that aren't children of anything. They float on their own, joined only by dashed lines.")
      .addToggle((t) =>
        t.setValue(s.showConnections).onChange(async (v) => {
          s.showConnections = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Cross-links")
      .setDesc("Dashed curves for links between notes that aren't in the main tree.")
      .addDropdown((d) =>
        d
          .addOptions({ always: "Always show", hover: "Only for the selected note", never: "Hide" })
          .setValue(s.crossLinks)
          .onChange(async (v) => {
            s.crossLinks = v as "always" | "hover" | "never";
            await save();
          })
      );

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Reset to defaults").onClick(async () => {
        this.plugin.settings = defaultSettings();
        await save();
        this.display();
      })
    );
  }
}
