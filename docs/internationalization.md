# Interface languages

LaTeX Coder supports English and Simplified Chinese through i18next and
react-i18next. The language selector is available on the sign-in page, project
list, administration page, editor toolbar, and account settings. Choose **Auto**
(**Follow browser** in account settings) to use the
first supported browser language, with English as the fallback.

The preference is local to the browser and is shared between its tabs. It does
not modify project files or change another collaborator's interface. Switching
languages preserves the editor instance, selection, undo history, and live
collaboration connection. CodeMirror's built-in search and other built-in UI
retain their existing language. Document contents, file names, comments,
bibliography metadata, Git commit messages, and compiler logs retain their
original text.

## Translation resources

`src/client/i18n.ts` initializes the shared instance before the application shell
mounts. English messages serve as catalog keys; key and namespace separators are
disabled so punctuation in messages is literal. The Simplified Chinese catalog
is `src/client/locales/zh-CN.json`. English plural forms are defined alongside
initialization, and i18next selects forms using `count`.

Pass dynamic values as interpolation parameters. Do not translate user-provided
strings or build sentences by concatenating translated fragments. Date displays
use the selected interface locale.

## React and controller ownership

The shell mixes React markup with controller-owned DOM. `Message` and `Localized`
subscribe to translations at the leaves so changing language does not rerender
or remount the whole shell. `LanguageSelector` uses the same i18next instance.

Controllers use `localizedText(node, () => t(...))` and
`localizedAttribute(node, name, () => t(...))` for live labels. These bindings
update the existing text nodes and attributes. They preserve appended controls
and never replace editor content. Store translation callbacks rather than
already-translated strings when a long-lived control needs to update in place.
Treat UI state as data, never as a comparison against displayed text.

Known API error codes map to translated descriptions. Unmapped errors remain
readable in their original form, and the error object preserves the server's
original message and details. Translation does not alter API codes or responses.

## Checks

`tests/i18n.test.ts` checks language resolution, interpolation consistency, and
fallback behavior. `tests/browser-i18n.test.ts` exercises browser detection,
language switching, persistence, UI updates, and preservation of the live
editor and undo history. The existing browser suite also runs against the
English interface.
