import { App, Notice, TFile } from "obsidian";
import { createNote } from "./links";
import { Annotation, EditorState, Range } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  keymap,
} from "@codemirror/view";
import { autocompletion, closeBrackets, closeBracketsKeymap, CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";

const external = Annotation.define<boolean>();
const SAVE_DELAY = 600;
const WIKILINK = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;

const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Split a note into its frontmatter block (kept out of the editor) and the body. */
function splitFrontmatter(text: string): { front: string; body: string } {
  const m = FRONTMATTER.exec(text);
  return m ? { front: m[0], body: text.slice(m[0].length) } : { front: "", body: text };
}

const mark = (cls: string) => Decoration.mark({ class: cls });
const lineDeco = (cls: string) => Decoration.line({ class: cls });
const hide = Decoration.replace({});

class Bullet extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "ma-bullet";
    s.textContent = "•";
    return s;
  }
  eq() {
    return true;
  }
}
const bullet = Decoration.replace({ widget: new Bullet() });

/**
 * Live-preview styling: Markdown renders like reading mode, and the syntax characters
 * (#, **, [[ ]], …) only show while the cursor is on the text they belong to.
 */
function styleDocument(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const sel = view.state.selection.ranges;
  const touches = (a: number, b: number) => sel.some((r) => r.from <= b && r.to >= a);
  let fenced = false;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      pos = line.to + 1;
      const t = line.text;
      if (/^\s*(```|~~~)/.test(t)) {
        fenced = !fenced;
        out.push(lineDeco("ma-codeblock").range(line.from));
        continue;
      }
      if (fenced) {
        out.push(lineDeco("ma-codeblock").range(line.from));
        continue;
      }
      const lineActive = touches(line.from, line.to);
      const h = /^(#{1,6})\s+/.exec(t);
      if (h) {
        out.push(lineDeco(`ma-h ma-h${h[1].length}`).range(line.from));
        if (!lineActive) out.push(hide.range(line.from, line.from + h[0].length));
      } else if (/^\s*>/.test(t)) {
        out.push(lineDeco("ma-quote").range(line.from));
        const q = /^\s*>\s?/.exec(t)!;
        if (!lineActive) out.push(hide.range(line.from, line.from + q[0].length));
      }
      const li = /^\s*([-*+]|\d+\.)\s/.exec(t);
      if (li && !h) {
        const ms = line.from + li[0].search(/\S/);
        const me = line.from + li[0].length;
        if (/^[-*+]$/.test(li[1]) && !lineActive) out.push(bullet.range(ms, me - 1));
        else out.push(mark("ma-list").range(ms, me - 1));
      }
      const rules: [RegExp, string, number][] = [
        [/\*\*[^*\n]+\*\*/g, "ma-bold", 2],
        [/(?<!\*)\*[^*\n]+\*(?!\*)/g, "ma-italic", 1],
        [/~~[^~\n]+~~/g, "ma-strike", 2],
        [/==[^=\n]+==/g, "ma-highlight", 2],
        [/`[^`\n]+`/g, "ma-code", 1],
      ];
      for (const [re, cls, k] of rules) {
        for (const m of t.matchAll(re)) {
          const s = line.from + (m.index ?? 0);
          const e = s + m[0].length;
          out.push(mark(cls).range(s, e));
          if (!touches(s, e)) {
            out.push(hide.range(s, s + k));
            out.push(hide.range(e - k, e));
          }
        }
      }
      for (const m of t.matchAll(WIKILINK)) {
        const s = line.from + (m.index ?? 0);
        const e = s + m[0].length;
        out.push(mark("ma-link").range(s, e));
        if (touches(s, e)) continue;
        const pipe = m[0].indexOf("|");
        out.push(hide.range(s, s + (pipe >= 0 ? pipe + 1 : 2)));
        out.push(hide.range(e - 2, e));
      }
    }
  }
  return Decoration.set(out, true);
}

const styling = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = styleDocument(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = styleDocument(u.view);
    }
  },
  { decorations: (v) => v.decorations }
);

/** An embedded CodeMirror 6 editor that autosaves to a vault file. */
export class NoteEditor {
  private view: EditorView;
  private file: TFile | null = null;
  private saveTimer: number | null = null;
  private dirty = false;

  constructor(
    private app: App,
    host: HTMLElement,
    private onNavigate: (file: TFile) => void
  ) {
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          history(),
          closeBrackets(),
          autocompletion({ override: [(c) => this.linkSuggestions(c)], icons: false }),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping,
          styling,
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) {
              this.scheduleSave();
            }
          }),
          EditorView.domEventHandlers({
            click: (e, view) => this.handleLinkClick(e, view),
            blur: () => void this.flush(),
          }),
        ],
      }),
    });
  }

  /** `[[` completion: offer vault notes and finish the link. */
  private linkSuggestions(ctx: CompletionContext) {
    const m = ctx.matchBefore(/\[\[[^\]\n|]*$/);
    if (!m) return null;
    const typed = m.text.slice(2).toLowerCase();
    const from = m.from + 2;
    const options = this.app.vault
      .getMarkdownFiles()
      .filter((f) => !typed || f.path.toLowerCase().includes(typed))
      .sort((a, b) => {
        const ap = a.basename.toLowerCase().startsWith(typed) ? 0 : 1;
        const bp = b.basename.toLowerCase().startsWith(typed) ? 0 : 1;
        return ap - bp || a.basename.length - b.basename.length;
      })
      .slice(0, 30)
      .map((f) => {
        const name = this.app.metadataCache.fileToLinktext(f, this.file?.path ?? "", true);
        return {
          label: name,
          detail: f.parent?.path === "/" ? "" : f.parent?.path,
          // Auto-closed brackets may already follow the cursor; reuse them rather than doubling.
          apply: (view: EditorView, _c: unknown, start: number, end: number) => {
            const after = view.state.doc.sliceString(end, end + 2);
            const stop = end + (after === "]]" ? 2 : 0);
            view.dispatch({
              changes: { from: start, to: stop, insert: `${name}]]` },
              selection: { anchor: start + name.length + 2 },
            });
          },
        };
      });
    return { from, options, filter: false };
  }

  get currentFile() {
    return this.file;
  }

  async open(file: TFile) {
    if (this.file?.path === file.path) return;
    await this.flush();
    this.file = file;
    const text = splitFrontmatter(await this.app.vault.read(file)).body;
    if (this.file !== file) return; // superseded by a newer open()
    this.setDoc(text);
    this.view.dispatch({ selection: { anchor: 0 } });
  }

  /** Pick up edits made elsewhere, unless there are unsaved local changes. */
  async onExternalModify(file: TFile) {
    if (!this.file || file.path !== this.file.path || this.dirty) return;
    const text = splitFrontmatter(await this.app.vault.read(file)).body;
    if (text === this.view.state.doc.toString()) return;
    const sel = Math.min(this.view.state.selection.main.head, text.length);
    this.setDoc(text, sel);
  }

  async flush() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    const body = this.view.state.doc.toString();
    // Re-attach whatever frontmatter the file has right now, so changes made elsewhere aren't lost.
    await this.app.vault.process(this.file, (current) => splitFrontmatter(current).front + body);
  }

  async destroy() {
    await this.flush();
    this.view.destroy();
  }

  private setDoc(text: string, cursor = 0) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: cursor },
      annotations: external.of(true),
    });
  }

  private scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DELAY);
  }

  /** Cmd/Ctrl-click a [[wikilink]] to jump to that note. */
  /** Click a [[link]] to open it; an unresolved link creates the note first, like Obsidian. */
  private handleLinkClick(e: MouseEvent, view: EditorView): boolean {
    if (e.button !== 0 || e.shiftKey || e.altKey || !this.file) return false;
    if (!view.state.selection.main.empty) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    for (const m of line.text.matchAll(WIKILINK)) {
      const s = line.from + (m.index ?? 0);
      if (pos < s || pos > s + m[0].length) continue;
      const target = m[1].trim();
      e.preventDefault();
      void this.followLink(target);
      return true;
    }
    return false;
  }

  private async followLink(target: string) {
    const from = this.file;
    if (!from) return;
    try {
      let dest = this.app.metadataCache.getFirstLinkpathDest(target, from.path);
      if (!dest) {
        await this.flush();
        const name = target.split("/").pop() ?? target;
        dest = await createNote(this.app, name, from);
      }
      this.onNavigate(dest);
    } catch (err) {
      new Notice(`MindAtlas: could not open “${target}” (${(err as Error).message})`);
    }
  }
}
