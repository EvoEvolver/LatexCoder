# Interface languages

LaTeX Coder supports English, Simplified Chinese, and Japanese through i18next and
react-i18next. The language selector is available on the sign-in and registration
screen and in account settings. It is not shown in the editor toolbar or the
project and administration page headers. Choose **Auto**
(**Follow browser** in account settings) to use the
first supported browser language, with English as the fallback. Japanese browser
locales such as `ja-JP` resolve to `ja`.

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
is `src/client/locales/zh-CN.json`; the Japanese catalog is
`src/client/locales/ja.json`. Both catalogs contain the same message keys and
preserve all interpolation parameters. English plural forms are defined alongside
initialization, and i18next selects forms using `count`.

Pass dynamic values as interpolation parameters. Do not translate user-provided
strings or build sentences by concatenating translated fragments. Date displays
use the selected interface locale.

For Japanese, prefer natural Japanese wording to phonetic English translations:
use 設定, 履歴, 共有, 検索, 置換, and 組版 where appropriate. Keep established terms
such as ファイル when they aid understanding, and leave product names and source
identifiers unchanged. Translate the application concept “project” as 原稿
(原稿一覧, 原稿設定, 新規原稿). Keep labels concise and omit unnecessary の where
natural compounds work; retain it where grammar or clarity requires it. Use the
same wording across labels, instructions, and errors.

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
