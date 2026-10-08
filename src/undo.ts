import { App, Notice, TFile } from "obsidian";

type Snapshot = Map<string, string | null>;

interface Entry {
  label: string;
  before: Snapshot;
  after: Snapshot;
}

/**
 * Undo/redo for edits the map makes to notes. Each entry stores the content of
 * every touched file before and after the change, so any structural operation
 * (create, link, unlink, move, trash) undoes the same way. An entry is skipped
 * with a notice if the files have been edited since.
 */
export class UndoStack {
  private undos: Entry[] = [];
  private redos: Entry[] = [];

  constructor(private app: App, private onChange: () => void) {}

  private async snapshot(paths: Iterable<string>): Promise<Snapshot> {
    const snap: Snapshot = new Map();
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      snap.set(p, f instanceof TFile ? await this.app.vault.read(f) : null);
    }
    return snap;
  }

  private async matches(expected: Snapshot) {
    const now = await this.snapshot(expected.keys());
    for (const [p, v] of expected) if (now.get(p) !== v) return false;
    return true;
  }

  private async apply(target: Snapshot) {
    for (const [path, content] of target) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (content === null) {
        if (f instanceof TFile) await this.app.fileManager.trashFile(f);
      } else if (f instanceof TFile) {
        await this.app.vault.modify(f, content);
      } else {
        await this.app.vault.create(path, content);
      }
    }
  }

  /** Run `action`, recording what it did to `paths` (and any paths it returns, e.g. new notes). */
  async run(label: string, paths: string[], action: () => Promise<string[] | void>) {
    const before = await this.snapshot(paths);
    const extra = (await action()) ?? [];
    const all = new Set([...paths, ...extra]);
    for (const p of extra) if (!before.has(p)) before.set(p, null);
    const after = await this.snapshot(all);
    for (const p of all) if (!before.has(p)) before.set(p, null);
    this.undos.push({ label, before, after });
    if (this.undos.length > 50) this.undos.shift();
    this.redos = [];
    this.onChange();
  }

  async undo() {
    const e = this.undos[this.undos.length - 1];
    if (!e) return new Notice("Nothing to undo.");
    if (!(await this.matches(e.after))) {
      return new Notice(`Can't undo “${e.label}”: the notes changed since.`);
    }
    this.undos.pop();
    await this.apply(e.before);
    this.redos.push(e);
    new Notice(`Undid ${e.label}`);
    this.onChange();
  }

  async redo() {
    const e = this.redos[this.redos.length - 1];
    if (!e) return new Notice("Nothing to redo.");
    if (!(await this.matches(e.before))) {
      return new Notice(`Can't redo “${e.label}”: the notes changed since.`);
    }
    this.redos.pop();
    await this.apply(e.after);
    this.undos.push(e);
    new Notice(`Redid ${e.label}`);
    this.onChange();
  }

  /** Forget history (e.g. after a rename, which changes paths). */
  clear() {
    this.undos = [];
    this.redos = [];
  }
}
