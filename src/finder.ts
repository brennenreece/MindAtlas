import { App, FuzzySuggestModal, TFile } from "obsidian";

/** Quick jump: fuzzy-search the vault's notes. */
export class NoteFinder extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onPick: (f: TFile) => void) {
    super(app);
    this.setPlaceholder("Jump to a note…");
  }
  getItems() {
    return this.app.vault.getMarkdownFiles();
  }
  getItemText(f: TFile) {
    return f.path.replace(/\.md$/, "");
  }
  onChooseItem(f: TFile) {
    this.onPick(f);
  }
}
