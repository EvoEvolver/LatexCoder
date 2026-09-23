import { defaultKeymap } from "@codemirror/commands";
import { defaultHighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import * as Y from "yjs";

import type { SourceRange } from "../shared/structure.ts";

type TreeWriterEditorOptions = {
  editable: boolean;
  host: HTMLElement;
  range: SourceRange;
  text: Y.Text;
  undoManager?: Y.UndoManager;
  onInvalidated: () => void;
  selection?: { anchor: number; head?: number };
  extensions?: Extension;
};

type LocalChange = { from: number; to: number; insert: string };

function minimalChange(before: string, after: string): LocalChange | null {
  if (before === after) return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) suffix++;
  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}

/** A CodeMirror projection that writes directly into a range of one canonical Y.Text. */
export class TreeWriterEditor {
  readonly view: EditorView;

  private readonly doc: Y.Doc;
  private readonly origin = { feature: "tree-writer" };
  private start: Y.RelativePosition;
  private end: Y.RelativePosition;
  private disposed = false;
  private applyingRemote = false;

  constructor(private readonly options: TreeWriterEditorOptions) {
    const doc = options.text.doc;
    if (!doc) throw new Error("TreeWriter requires an attached Y.Text");
    this.doc = doc;
    this.start = Y.createRelativePositionFromTypeIndex(options.text, options.range.from, -1);
    this.end = Y.createRelativePositionFromTypeIndex(options.text, options.range.to, 0);
    options.undoManager?.addTrackedOrigin(this.origin);

    const initial = options.text.toString().slice(options.range.from, options.range.to);
    this.view = new EditorView({
      parent: options.host,
      state: EditorState.create({
        doc: initial,
        selection: options.selection
          ? EditorSelection.single(options.selection.anchor, options.selection.head ?? options.selection.anchor)
          : undefined,
        extensions: [
          EditorState.readOnly.of(!options.editable),
          EditorView.editable.of(options.editable),
          lineNumbers(),
          StreamLanguage.define(stex),
          syntaxHighlighting(defaultHighlightStyle),
          options.extensions || [],
          EditorView.lineWrapping,
          keymap.of([
            { key: "Mod-z", run: () => { options.undoManager?.undo(); return Boolean(options.undoManager); } },
            { key: "Mod-Shift-z", run: () => { options.undoManager?.redo(); return Boolean(options.undoManager); } },
            { key: "Mod-y", run: () => { options.undoManager?.redo(); return Boolean(options.undoManager); } },
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of(update => {
            if (!update.docChanged || this.applyingRemote || this.disposed) return;
            const start = this.resolve(this.start);
            if (start === null) return this.invalidate();
            const changes: LocalChange[] = [];
            update.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
              changes.push({ from, to, insert: inserted.toString() });
            });
            this.doc.transact(() => {
              for (const change of changes.reverse()) {
                if (change.to > change.from) options.text.delete(start + change.from, change.to - change.from);
                if (change.insert) options.text.insert(start + change.from, change.insert);
              }
            }, this.origin);
            this.resetAnchors(start, update.state.doc.length);
          }),
          EditorView.theme({
            "&": { backgroundColor: "var(--editor-background)", color: "var(--editor-foreground)", fontSize: "13px" },
            ".cm-content": { caretColor: "var(--primary)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", padding: "10px 0" },
            ".cm-gutters": { backgroundColor: "var(--editor-gutter)", color: "var(--editor-gutter-foreground)", border: "0" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--editor-active-line)" },
            ".cm-scroller": { maxHeight: "24rem", overflow: "auto" },
            "&.cm-focused": { outline: "none" },
          }),
        ],
      }),
    });
    options.text.observe(this.handleTextChange);
  }

  focus(): void {
    this.view.focus();
    if (this.options.selection) {
      this.view.dispatch({
        selection: EditorSelection.single(
          this.options.selection.anchor,
          this.options.selection.head ?? this.options.selection.anchor,
        ),
        scrollIntoView: true,
      });
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.text.unobserve(this.handleTextChange);
    this.options.undoManager?.removeTrackedOrigin(this.origin);
    this.view.destroy();
  }

  sourcePosition(localPosition: number): number | null {
    const start = this.resolve(this.start);
    return start === null ? null : start + localPosition;
  }

  private readonly handleTextChange = (_event: Y.YTextEvent, transaction: Y.Transaction): void => {
    if (this.disposed || transaction.origin === this.origin) return;
    const start = this.resolve(this.start);
    const end = this.resolve(this.end);
    if (start === null || end === null || end < start) return this.invalidate();
    const current = this.view.state.doc.toString();
    const source = this.options.text.toString().slice(start, end);
    const change = minimalChange(current, source);
    if (!change) return;
    this.applyingRemote = true;
    try {
      this.view.dispatch({ changes: change });
    } finally {
      this.applyingRemote = false;
    }
  };

  private resolve(position: Y.RelativePosition): number | null {
    const absolute = Y.createAbsolutePositionFromRelativePosition(position, this.doc);
    return absolute?.type === this.options.text ? absolute.index : null;
  }

  private resetAnchors(start: number, length: number): void {
    this.start = Y.createRelativePositionFromTypeIndex(this.options.text, start, -1);
    this.end = Y.createRelativePositionFromTypeIndex(this.options.text, start + length, 0);
  }

  private invalidate(): void {
    if (this.disposed) return;
    this.options.onInvalidated();
    this.destroy();
  }
}
