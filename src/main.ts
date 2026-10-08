import { registerFeatherIcons } from "./icons";
import { Notice, Plugin, TFile } from "obsidian";
import { MindAtlasView, VIEW_TYPE_MINDATLAS } from "./view";
import { normalizeRelationships } from "./links";
import { defaultSettings, MindAtlasSettingTab, MindAtlasSettings, sanitizeSettings } from "./settings";

export default class MindAtlasPlugin extends Plugin {
  settings: MindAtlasSettings = defaultSettings();

  async onload() {
    registerFeatherIcons();
    await this.loadSettings();
    // Keep the explicit relationship sections in sync before any map is drawn.
    await normalizeRelationships(this.app).catch((err) => console.error("MindAtlas relationship scan failed", err));
    this.registerView(VIEW_TYPE_MINDATLAS, (leaf) => new MindAtlasView(leaf, this));
    this.addSettingTab(new MindAtlasSettingTab(this.app, this));

    this.addCommand({
      id: "open-map-for-current-note",
      name: "Open map for current note",
      callback: () => this.openMap(this.app.workspace.getActiveFile()),
    });

    this.addCommand({
      id: "find-note-on-map",
      name: "Find a note on the map",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MindAtlasView);
        if (!view) return false;
        if (!checking) view.focusFinder();
        return true;
      },
    });

    this.addCommand({
      id: "show-getting-started",
      name: "Show getting started guide",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MindAtlasView);
        if (!view) return false;
        if (!checking) view.openGettingStarted();
        return true;
      },
    });

    this.addRibbonIcon("git-fork", "MindAtlas: open map for current note", () =>
      this.openMap(this.app.workspace.getActiveFile())
    );
  }

  async loadSettings() {
    this.settings = sanitizeSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.app.workspace
      .getLeavesOfType(VIEW_TYPE_MINDATLAS)
      .forEach((l) => (l.view as MindAtlasView).refreshAppearance());
  }

  async markGettingStartedSeen() {
    if (this.settings.hasSeenGuide) return;
    this.settings.hasSeenGuide = true;
    try {
      await this.saveData(this.settings);
    } catch (err) {
      this.settings.hasSeenGuide = false;
      new Notice(`MindAtlas: could not save guide preference (${(err as Error).message})`);
    }
  }

  private async openMap(file: TFile | null) {
    if (!file || file.extension !== "md") {
      new Notice("MindAtlas: open a markdown note first.");
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_MINDATLAS,
      active: true,
      state: { path: file.path },
    });
    this.app.workspace.revealLeaf(leaf);
  }
}
