import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";

import { referenceLinks, type ReferenceLink } from "../shared/references.ts";

export const sourceModifierIsMeta = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
export const sourceModifierLabel = sourceModifierIsMeta ? "Command" : "Ctrl";
const sourceModifierKey = sourceModifierIsMeta ? "Meta" : "Control";

export function sourceModifierPressed(event: MouseEvent): boolean {
  return sourceModifierIsMeta ? event.metaKey : event.ctrlKey;
}

type SourceEditorInteractionOptions = {
  followReference: (link: ReferenceLink, view: EditorView) => void;
  openContextMenu: (event: MouseEvent, view: EditorView) => void;
};

const setModifierHeld = StateEffect.define<boolean>();
const referenceHighlights = StateField.define({
  create: () => ({ held: false, marks: Decoration.none }),
  update(value, transaction) {
    let held = value.held;
    for (const effect of transaction.effects) if (effect.is(setModifierHeld)) held = effect.value;
    if (!held) return { held, marks: Decoration.none };
    const marks = referenceLinks(transaction.state.doc.toString()).map(link =>
      Decoration.mark({ class: "cm-reference-link" }).range(link.from, link.to));
    return { held, marks: Decoration.set(marks, true) };
  },
  provide: field => EditorView.decorations.from(field, value => value.marks),
});

export function sourceEditorInteractions(options: SourceEditorInteractionOptions): Extension {
  return [
    referenceHighlights,
    ViewPlugin.define(view => {
      let held = false;
      const setHeld = (next: boolean): void => {
        if (held === next) return;
        held = next;
        view.dispatch({ effects: setModifierHeld.of(next) });
        if (!next) view.contentDOM.style.cursor = "";
      };
      const keydown = (event: KeyboardEvent): void => { if (event.key === sourceModifierKey) setHeld(true); };
      const keyup = (event: KeyboardEvent): void => { if (event.key === sourceModifierKey) setHeld(false); };
      const blur = (): void => setHeld(false);
      window.addEventListener("keydown", keydown, true);
      window.addEventListener("keyup", keyup, true);
      window.addEventListener("blur", blur);
      return {
        destroy() {
          window.removeEventListener("keydown", keydown, true);
          window.removeEventListener("keyup", keyup, true);
          window.removeEventListener("blur", blur);
        },
      };
    }),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button === 2) {
          event.preventDefault();
          if (view.state.selection.main.empty) {
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (position !== null) view.dispatch({ selection: { anchor: position } });
          }
          return true;
        }
        if (!sourceModifierPressed(event) || event.button !== 0) return false;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        const link = referenceLinks(view.state.doc.toString()).find(candidate => position >= candidate.from && position < candidate.to);
        if (!link) return false;
        event.preventDefault();
        options.followReference(link, view);
        return true;
      },
      mousemove(event, view) {
        const position = sourceModifierPressed(event) ? view.posAtCoords({ x: event.clientX, y: event.clientY }) : null;
        const linked = position !== null && referenceLinks(view.state.doc.toString())
          .some(link => position >= link.from && position < link.to);
        view.contentDOM.style.cursor = linked ? "pointer" : "";
      },
      keyup(event, view) {
        if (event.key === sourceModifierKey) view.contentDOM.style.cursor = "";
      },
      contextmenu(event, view) {
        event.preventDefault();
        options.openContextMenu(event, view);
        return true;
      },
    }),
    EditorView.baseTheme({
      ".cm-reference-link": {
        color: "var(--primary)",
        cursor: "pointer",
        textDecoration: "underline",
        textDecorationThickness: "1.5px",
        textUnderlineOffset: "3px",
      },
    }),
  ];
}
