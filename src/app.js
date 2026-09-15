import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Annotation, EditorSelection, EditorState, StateField, Transaction } from "@codemirror/state";
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection,
  WidgetType,
} from "@codemirror/view";
import {
  Archive,
  ArrowLeft,
  createIcons,
  CheckCheck,
  Copy,
  Download,
  File,
  FileCheck2,
  FilePlus2,
  FileText,
  FolderKanban,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestCreateArrow,
  Image,
  Link,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Play,
  RefreshCw,
  TerminalSquare,
  Trash2,
  Upload,
  UserRound,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/build/pdf.mjs";
import { yCollab, ySyncAnnotation } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import { parseReviews, stripReviewStorage } from "./review.js";

const ICONS = {
    Archive,
    ArrowLeft,
    CheckCheck,
    Copy,
    Download,
    File,
    FileCheck2,
    FilePlus2,
    FileText,
    FolderKanban,
    FolderPlus,
    GitBranch,
    GitCommitHorizontal,
    GitMerge,
    GitPullRequestCreateArrow,
    Image,
    Link,
    MessageSquarePlus,
    MoreHorizontal,
    PanelLeft,
    Pencil,
    Play,
    RefreshCw,
    TerminalSquare,
    Trash2,
    Upload,
    UserRound,
    X,
    ZoomIn,
    ZoomOut,
};
createIcons({ icons: ICONS });

// Test hooks: with ?test=1 the app exposes its internals, silences toasts,
// and skips the editor boot so browser tests can drive the suggestion logic.
const testMode = new URLSearchParams(window.location.search).has("test");
const e2eMode = new URLSearchParams(window.location.search).has("e2e");

const elements = Object.fromEntries([
  "access-close", "access-dialog", "access-done", "access-download", "access-project-name", "back-projects",
  "action-cancel", "action-close", "action-dialog", "action-form", "action-input", "action-label", "action-message", "action-submit", "action-title",
  "active-file-label", "add-comment", "binary-download", "binary-name", "binary-view",
  "build-log", "build-output", "clone-button", "clone-command", "clone-section", "close-log", "close-output", "compile-button", "copy-clone-command", "copy-share-link", "delete-file", "display-name", "download-project",
  "editor-page", "editor", "empty-output", "file-list", "file-menu", "files-pane", "new-file", "new-project", "output-pane", "pdf-document",
  "pdf-download", "pdf-status", "pdf-view", "pdf-zoom-in", "pdf-zoom-out", "presence", "rename-file", "review-count", "review-dialog", "review-form",
  "project-list", "project-name", "projects-page", "review-list", "review-pane", "review-text", "share-link", "share-project", "show-log", "suggest-edit", "sync-state",
  "git-button", "git-change-count", "git-close", "git-commit", "git-conflict", "git-conflict-branch", "git-dialog", "git-dirty", "git-file-list",
  "git-history", "git-message", "git-ref", "git-refresh", "git-resolve", "git-summary", "git-sync",
  "toast", "toggle-files", "upload-file", "upload-input", "selection-actions", "selection-accept",
].map(id => [id.replaceAll("-", "_"), document.getElementById(id)]));

const apiUrl = relative => new URL(`/${String(relative).replace(/^\//, "")}`, window.location.origin);
GlobalWorkerOptions.workerSrc = apiUrl("pdf.worker.min.mjs").toString();
const socketUrl = relative => {
  const url = apiUrl(relative);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
};

const palette = ["#236b59", "#98602b", "#7455a5", "#2c6e9d", "#a14960", "#55713a", "#855b43", "#39716e"];
const state = {
  activeFile: "main.tex",
  projectId: "",
  projects: [],
  git: null,
  main: "main.tex",
  files: [],
  view: null,
  doc: null,
  provider: null,
  pdfDocument: null,
  pdfLoadingTask: null,
  pdfRequestVersion: 0,
  pdfRenderVersion: 0,
  pdfZoom: 1,
  reviewSelection: null,
  selectionSuggestionIds: [],
  suggesting: false,
  toastTimer: null,
};
const reviewMutation = Annotation.define();
// Track the deletion block each author created most recently so consecutive
// Backspace keystrokes extend it instead of nesting new markers. The record
// lives per-transaction because positions shift as the document changes.
const lastDeletion = new WeakMap();

function hash(value) {
  let result = 0;
  for (const character of value) result = ((result << 5) - result + character.charCodeAt(0)) | 0;
  return Math.abs(result);
}

function colorFor(name) {
  return palette[hash(name) % palette.length];
}

function displayName() {
  return elements.display_name.value.trim() || "Guest";
}

function encodeRoom(relativePath) {
  const bytes = new TextEncoder().encode(relativePath);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function showToast(message) {
  if (testMode) return;
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3200);
}

function openActionDialog({ title, label = "", value = "", maxLength = 512, message = "", submitLabel, danger = false }) {
  const hasInput = Boolean(label);
  elements.action_title.textContent = title;
  elements.action_label.textContent = label;
  elements.action_label.hidden = !hasInput;
  elements.action_input.hidden = !hasInput;
  elements.action_input.disabled = !hasInput;
  elements.action_input.required = hasInput;
  elements.action_input.value = value;
  elements.action_input.maxLength = maxLength;
  elements.action_message.textContent = message;
  elements.action_message.hidden = !message;
  elements.action_submit.textContent = submitLabel;
  elements.action_submit.classList.toggle("danger-button", danger);
  elements.action_dialog.showModal();

  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      elements.action_form.removeEventListener("submit", submit);
      elements.action_dialog.removeEventListener("cancel", cancel);
      elements.action_cancel.removeEventListener("click", cancel);
      elements.action_close.removeEventListener("click", cancel);
      elements.action_dialog.close();
      resolve(result);
    };
    const submit = event => {
      event.preventDefault();
      const result = hasInput ? elements.action_input.value.trim() : true;
      if (hasInput && !result) return elements.action_input.reportValidity();
      finish(result);
    };
    const cancel = event => {
      event.preventDefault();
      finish(null);
    };
    elements.action_form.addEventListener("submit", submit);
    elements.action_dialog.addEventListener("cancel", cancel);
    elements.action_cancel.addEventListener("click", cancel);
    elements.action_close.addEventListener("click", cancel);
    queueMicrotask(() => (hasInput ? elements.action_input : elements.action_submit).focus());
    if (hasInput) queueMicrotask(() => elements.action_input.select());
  });
}

function renderSelectionActions() {
  const view = state.view;
  const menu = elements.selection_actions;
  menu.hidden = true;
  state.selectionSuggestionIds = [];
  if (!view) return;
  const selection = view.state.selection.main;
  if (selection.empty) return;
  const ids = [...new Set(parseReviews(view.state.doc.toString())
    .filter(item => item.kind !== "comment" && selection.from < item.to && selection.to > item.from)
    .map(item => item.id))];
  if (!ids.length) return;
  const caret = view.coordsAtPos(selection.head, 1);
  const editor = elements.editor.getBoundingClientRect();
  if (!caret || caret.bottom < editor.top || caret.top > editor.bottom) return;

  state.selectionSuggestionIds = ids;
  elements.selection_accept.querySelector("span").textContent = ids.length === 1
    ? "Accept suggestion"
    : `Accept ${ids.length} suggestions`;
  menu.hidden = false;
  const bounds = menu.getBoundingClientRect();
  const left = Math.min(window.innerWidth - bounds.width - 8, Math.max(8, caret.left));
  const below = caret.bottom + 7;
  const top = below + bounds.height <= window.innerHeight - 8
    ? below
    : Math.max(8, caret.top - bounds.height - 7);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

async function request(relative, options = {}) {
  const url = apiUrl(relative);
  if (state.projectId && url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/v1/projects")) {
    url.searchParams.set("project", state.projectId);
  }
  const response = await fetch(url, options);
  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error?.message || body || `Request failed (${response.status})`);
  return body;
}

function projectApiUrl(relative) {
  const url = apiUrl(relative);
  if (state.projectId) url.searchParams.set("project", state.projectId);
  return url;
}

function fileIcon(file) {
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(file.path)) return "image";
  return file.text ? "file-text" : "file";
}

function renderFiles() {
  elements.file_list.replaceChildren();
  for (const file of state.files) {
    const button = document.createElement("button");
    button.className = `file-row${file.path === state.activeFile ? " active" : ""}`;
    button.title = file.path;
    button.innerHTML = `<i data-lucide="${fileIcon(file)}"></i><span></span>`;
    button.querySelector("span").textContent = file.path;
    button.addEventListener("click", () => openFile(file.path));
    elements.file_list.append(button);
  }
  elements.file_menu.hidden = !state.activeFile;
  elements.delete_file.disabled = !state.activeFile || state.activeFile === state.main;
  elements.delete_file.title = state.activeFile === state.main ? "The main document cannot be deleted" : "";
  createIcons({ icons: ICONS });
}

class RevisionDeletionWidget extends WidgetType {
  constructor(id, author, text) {
    super();
    this.id = id;
    this.author = author;
    this.text = text;
  }

  eq(other) {
    return other.id === this.id && other.author === this.author && other.text === this.text;
  }

  toDOM() {
    const deletion = document.createElement("span");
    deletion.className = "cm-review-deletion";
    deletion.textContent = this.text;
    deletion.title = `Original text changed by ${this.author || "Guest"}`;
    return deletion;
  }

  ignoreEvent() { return true; }
}

function buildReviewDecorations(editorState) {
  const ranges = [];
  for (const item of parseReviews(editorState.doc.toString())) {
    ranges.push(Decoration.replace({}).range(item.from, item.bodyFrom));
    if (item.bodyFrom < item.bodyTo) {
      const reviewClass = item.kind === "comment"
        ? "cm-review-comment"
        : item.kind === "deletion" ? "cm-review-deletion" : "cm-review-insertion";
      ranges.push(Decoration.mark({
        class: reviewClass,
        attributes: { "data-review-id": item.id },
      }).range(item.bodyFrom, item.bodyTo));
    }
    const replacement = item.kind === "revision"
      ? { widget: new RevisionDeletionWidget(item.id, item.author, item.note) }
      : {};
    ranges.push(Decoration.replace(replacement).range(item.bodyTo, item.to));
  }
  return Decoration.set(ranges, true);
}

const reviewDecorations = StateField.define({
  create: buildReviewDecorations,
  update(decorations, transaction) {
    return transaction.docChanged ? buildReviewDecorations(transaction.state) : decorations;
  },
  provide: field => EditorView.decorations.from(field),
});

function tooltipButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", event => {
    event.preventDefault();
    action();
  });
  return button;
}

const reviewTooltip = hoverTooltip((view, position) => {
  const reviews = parseReviews(view.state.doc.toString());
  const item = reviews
    .find(candidate => position >= candidate.bodyFrom && position <= candidate.bodyTo);
  if (!item) return null;
  return {
    pos: item.bodyFrom,
    end: item.bodyTo,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = `cm-review-tooltip ${item.kind}`;
      const meta = document.createElement("strong");
      meta.textContent = item.kind === "comment"
        ? `${item.author || "Guest"} commented`
        : `${item.author || "Guest"} suggested an edit`;
      const note = document.createElement("p");
      if (item.kind === "comment") {
        note.textContent = item.note;
      } else if (item.kind === "revision") {
        note.textContent = `Original: ${item.note}`;
      } else {
        const related = reviews.filter(candidate => candidate.id === item.id && candidate.kind !== "comment");
        const addition = related.find(candidate => candidate.kind === "addition");
        const deletion = related.find(candidate => candidate.kind === "deletion");
        note.textContent = [
          addition?.body ? `Added: ${addition.body}` : "",
          deletion?.body ? `Deleted: ${deletion.body}` : "",
        ].filter(Boolean).join("\n");
      }
      const actions = document.createElement("div");
      actions.className = "cm-review-tooltip-actions";
      if (item.kind === "comment") {
        actions.append(tooltipButton("Resolve", () => applyReviewDecision(item.id, "resolve")));
      } else {
        actions.append(
          tooltipButton("Accept", () => applyReviewDecision(item.id, "accept")),
          tooltipButton("Reject", () => applyReviewDecision(item.id, "reject")),
        );
      }
      dom.append(meta, note, actions);
      return { dom };
    },
  };
}, { hoverTime: 220, hideOnChange: true });

function trackedSuggestion(transaction, reviews) {
  const changes = [];
  transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    changes.push({ from, to, inserted: inserted.toString() });
  });
  if (changes.length !== 1) {
    queueMicrotask(() => showToast("Suggestion mode supports one selection at a time."));
    return [];
  }

  const change = changes[0];
  const author = cleanMetadata(displayName());
  const source = transaction.startState.doc.toString();
  // Only edits strictly after the \documentclass line are reviewable; files
  // without one (chapters, notes) have no protected preamble at all.
  const documentClass = source.match(/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/);
  const reviewableFrom = documentClass?.index === undefined
    ? 0
    : documentClass.index + documentClass[0].length;
  if (change.from < reviewableFrom) {
    queueMicrotask(() => showToast("Turn off Suggesting to edit the document class."));
    return [];
  }
  if (/\\(?:cmtbg|cmted|revbg|reved|addbg|added|delbg|deled)\b/.test(change.inserted)) {
    queueMicrotask(() => showToast("Review storage macros are managed by LaTeX Coder."));
    return [];
  }

  const ownAddition = reviews.find(item => (
    item.kind === "addition"
    && item.author === author
    && change.from >= item.bodyFrom
    && change.to <= item.bodyTo
  ));
  if (ownAddition) {
    if (!change.inserted && change.from === ownAddition.bodyFrom && change.to === ownAddition.bodyTo) {
      return {
        changes: { from: ownAddition.from, to: ownAddition.to, insert: "" },
        selection: { anchor: ownAddition.from },
        annotations: reviewMutation.of(true),
      };
    }
    return transaction;
  }

  if (change.from === change.to && change.inserted) {
    const adjacentAddition = reviews.find(item => (
      item.kind === "addition"
      && item.author === author
      && (change.from === item.bodyTo || change.from === item.to)
    ));
    if (adjacentAddition) {
      return {
        changes: { from: adjacentAddition.bodyTo, insert: change.inserted },
        selection: { anchor: adjacentAddition.bodyTo + change.inserted.length },
        annotations: reviewMutation.of(true),
      };
    }
  }

  const deleted = transaction.startState.sliceDoc(change.from, change.to);
  const userEvent = transaction.annotation(Transaction.userEvent);
  // yCollab echoes the merge transaction back as a plain input.type sync, so
  // also treat a deletion at the recorded block boundary as a Backspace.
  const last = lastDeletion.get(state.view);
  const backwardDelete = deleted && !change.inserted
    && (userEvent === "delete.backward" || (last && change.from + deleted.length === last.from));
  // Consecutive Backspace keystrokes extend the deletion block the caret is
  // sitting at instead of nesting a new marker pair per character.
  const previousDeletion = backwardDelete && last && reviews.find(item => (
    item.kind === "deletion" && item.author === author && item.id === last.id && item.from === last.from
  ));
  if (previousDeletion && previousDeletion.from === change.from + deleted.length) {
    // Backspace sits right before the block it just created: extend its body
    // on the left with the newly removed text and keep the caret there, so
    // consecutive keystrokes grow one review block instead of nesting markers.
    // The selection maps backward through the rewrite, otherwise it would be
    // dragged past the inserted text.
    const body = `${deleted}${previousDeletion.body}`;
    const changes = {
      from: change.from,
      to: previousDeletion.to,
      insert: `\\delbg{${previousDeletion.id}}{${previousDeletion.author}}${body}\\deled`,
    };
    last.from = change.from;
    lastDeletion.set(state.view, last);
    return {
      changes,
      selection: EditorSelection.cursor(change.from).map(transaction.startState.changes(changes), -1),
      annotations: reviewMutation.of(true),
      // Keep the Backspace identity so follow-up keystrokes are recognised as
      // deletions instead of entering the generic suggestion path.
      userEvent: "delete.backward",
    };
  }

  if (reviews.some(item => change.from < item.to && change.to > item.from)) {
    queueMicrotask(() => showToast("Resolve the existing review before editing this text."));
    return [];
  }
  const id = randomId();
  const deletion = deleted ? `\\delbg{${id}}{${author}}${deleted}\\deled` : "";
  const additionStart = change.inserted ? `\\addbg{${id}}{${author}}` : "";
  const addition = change.inserted ? `${additionStart}${change.inserted}\\added` : "";
  const replacement = `${deletion}${addition}`;
  // Backspace wraps text behind the caret: the caret stays where the user
  // pressed it, in front of the new deletion block, ready to continue
  // deleting. Forward delete wraps text ahead of the caret: the caret moves
  // behind the block. Selection deletes and replacements stay where the edit
  // started.
  const cursor = backwardDelete
    ? change.from
    : change.from + deletion.length + (addition ? additionStart.length + change.inserted.length : 0);
  if (backwardDelete) lastDeletion.set(state.view, { id, from: change.from });
  return {
    changes: { from: change.from, to: change.to, insert: replacement },
    selection: { anchor: cursor },
    annotations: reviewMutation.of(true),
    // The tracked macro pair replaces the raw edit, so treat every suggestion
    // as one history entry instead of letting the original delete event merge
    // with later typing.
    userEvent: "input.type.suggestion",
  };
}

const protectReviewStorage = EditorState.transactionFilter.of(transaction => {
  if (
    !transaction.docChanged
    || transaction.annotation(reviewMutation)
    || transaction.annotation(ySyncAnnotation) !== undefined
  ) return transaction;

  const reviews = parseReviews(transaction.startState.doc.toString());
  if (state.suggesting) return trackedSuggestion(transaction, reviews);
  let blocked = false;
  transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    if (/\\(?:cmtbg|cmted|revbg|reved|addbg|added|delbg|deled)\b/.test(inserted.toString())) blocked = true;
    for (const item of reviews) {
      for (const range of [
        { from: item.from, to: item.bodyFrom },
        { from: item.bodyTo, to: item.to },
        ...(item.kind === "deletion" ? [{ from: item.bodyFrom, to: item.bodyTo }] : []),
      ]) {
        const touches = from === to
          ? from > range.from && from < range.to
          : from < range.to && to > range.from;
        if (touches) blocked = true;
      }
    }
  });
  if (!blocked) return transaction;
  queueMicrotask(() => showToast("Use Review actions to change comments and suggestions."));
  return [];
});

function editorExtensions(ytext, provider) {
  const undoManager = new Y.UndoManager(ytext);
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    StreamLanguage.define(stex),
    reviewDecorations,
    reviewTooltip,
    protectReviewStorage,
    EditorView.clipboardOutputFilter.of(source => stripReviewStorage(source)),
    keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    EditorView.lineWrapping,
    EditorView.updateListener.of(update => {
      if (update.docChanged) {
        queueReviewRender();
        elements.git_dirty.hidden = false;
      }
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) {
        queueMicrotask(renderSelectionActions);
      }
    }),
    EditorView.theme({
      "&": { backgroundColor: "#ffffff", color: "#292b27" },
      ".cm-content": { padding: "12px 0", caretColor: "#1d6b55" },
      ".cm-line": { padding: "0 14px" },
      "&.cm-focused .cm-cursor": { borderLeftColor: "#1d6b55" },
      // Keep local selections unmistakable next to comment and revision marks.
      // CodeMirror's default theme is loaded at the same precedence, so the
      // drawn selection layer needs an explicit override.
      // CodeMirror normally puts this layer behind the content. Review marks
      // have their own backgrounds, so selected text inside a mark would hide
      // the selection unless the translucent layer is drawn above it.
      "&.cm-focused .cm-selectionLayer": { zIndex: "3 !important", pointerEvents: "none" },
      "&.cm-focused .cm-selectionBackground": {
        backgroundColor: "rgb(63 153 220 / 18%) !important",
        boxShadow: "inset 0 0 0 1px rgb(38 120 181 / 85%)",
      },
      ".cm-content ::selection": { backgroundColor: "rgb(63 153 220 / 22%) !important" },
    }),
    yCollab(ytext, provider.awareness, { undoManager }),
  ];
}

function disconnectEditor() {
  state.provider?.destroy();
  state.view?.destroy();
  state.doc?.destroy();
  state.provider = null;
  state.view = null;
  state.doc = null;
  state.selectionSuggestionIds = [];
  elements.selection_actions.hidden = true;
}

function updatePresence() {
  elements.presence.replaceChildren();
  if (!state.provider) return;
  const users = [...state.provider.awareness.getStates().values()]
    .map(value => value.user)
    .filter(Boolean)
    .slice(0, 10);
  for (const user of users) {
    const avatar = document.createElement("span");
    avatar.className = "presence-avatar";
    avatar.title = user.name;
    avatar.style.backgroundColor = user.color;
    avatar.textContent = user.name.slice(0, 2).toUpperCase();
    elements.presence.append(avatar);
  }
}

function setAwareness() {
  if (!state.provider) return;
  const name = displayName();
  const color = colorFor(name);
  state.provider.awareness.setLocalStateField("user", { name, color, colorLight: `${color}33` });
}

async function openFile(relativePath) {
  const file = state.files.find(candidate => candidate.path === relativePath);
  if (!file) return;
  elements.files_pane.classList.remove("mobile-open");
  if (relativePath === state.activeFile && (state.view || !file.text)) return;
  disconnectEditor();
  state.activeFile = relativePath;
  elements.active_file_label.textContent = relativePath;
  elements.binary_view.hidden = file.text;
  elements.editor.hidden = !file.text;
  renderFiles();
  if (!file.text) {
    elements.binary_name.textContent = relativePath;
    elements.binary_download.href = projectApiUrl(`v1/files?path=${encodeURIComponent(relativePath)}`);
    elements.sync_state.textContent = "Stored";
    renderReviews();
    return;
  }

  elements.sync_state.textContent = "Connecting";
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(socketUrl(`v1/collab/${encodeURIComponent(state.projectId)}`), encodeRoom(relativePath), doc, { connect: true });
  const ytext = doc.getText("content");
  state.doc = doc;
  state.provider = provider;
  state.view = new EditorView({
    state: EditorState.create({ doc: "", extensions: editorExtensions(ytext, provider) }),
    parent: elements.editor,
  });
  provider.on("status", ({ status }) => {
    elements.sync_state.textContent = status === "connected" ? "Saved live" : "Reconnecting";
  });
  provider.on("sync", synced => {
    if (synced) {
      elements.sync_state.textContent = "Saved live";
      renderReviews();
    }
  });
  provider.awareness.on("change", updatePresence);
  setAwareness();
}

function applyReviewDecisions(ids, decision) {
  if (!state.view) return;
  const selected = new Set(ids);
  const items = parseReviews(state.view.state.doc.toString()).filter(candidate => selected.has(candidate.id));
  if (!items.length) return;
  const changes = items.map(item => {
    let insert = item.body;
    if (item.kind === "revision") insert = decision === "reject" ? item.note : item.body;
    if (item.kind === "addition") insert = decision === "reject" ? "" : item.body;
    if (item.kind === "deletion") insert = decision === "reject" ? item.body : "";
    return { from: item.from, to: item.to, insert };
  }).sort((left, right) => left.from - right.from);
  state.view.dispatch({ changes, annotations: reviewMutation.of(true) });
  renderReviews();
  renderSelectionActions();
}

function applyReviewDecision(id, decision) {
  applyReviewDecisions([id], decision);
}

function reviewButton(label, action) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", event => {
    event.stopPropagation();
    action();
  });
  return button;
}

function renderReviews() {
  const source = state.view?.state.doc.toString() || "";
  const reviews = parseReviews(source);
  const groups = [];
  const revisions = new Map();
  for (const item of reviews) {
    if (item.kind === "comment" || item.kind === "revision") {
      groups.push({ id: item.id, kind: item.kind === "comment" ? "comment" : "revision", items: [item] });
    } else {
      let group = revisions.get(item.id);
      if (!group) {
        group = { id: item.id, kind: "revision", items: [] };
        revisions.set(item.id, group);
        groups.push(group);
      }
      group.items.push(item);
    }
  }
  elements.review_count.textContent = String(groups.length);
  elements.review_list.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty-output";
    empty.innerHTML = '<i data-lucide="file-check-2"></i><span>No open reviews</span>';
    elements.review_list.append(empty);
    createIcons({ icons: ICONS });
    return;
  }
  for (const group of groups) {
    const item = group.items[0];
    const article = document.createElement("article");
    article.className = `review-item ${group.kind}`;
    const meta = document.createElement("div");
    meta.className = "review-meta";
    const author = document.createElement("strong");
    author.textContent = item.author || "Guest";
    const type = document.createElement("span");
    type.textContent = group.kind;
    meta.append(author, type);
    const quote = document.createElement("pre");
    quote.className = "review-quote";
    if (group.kind === "comment" || item.kind === "revision") {
      quote.textContent = item.body.trim().slice(0, 240) || "Empty selection";
    } else {
      const addition = group.items.find(candidate => candidate.kind === "addition");
      const deletion = group.items.find(candidate => candidate.kind === "deletion");
      quote.textContent = [
        deletion?.body ? `- ${deletion.body.trim()}` : "",
        addition?.body ? `+ ${addition.body.trim()}` : "",
      ].filter(Boolean).join("\n");
    }
    const note = document.createElement("p");
    note.className = "review-note";
    note.textContent = group.kind === "comment"
      ? item.note
      : item.kind === "revision" ? `Before: ${item.note}` : "Tracked change";
    const actions = document.createElement("div");
    actions.className = "review-buttons";
    if (group.kind === "comment") {
      actions.append(reviewButton("Resolve", () => applyReviewDecision(group.id, "resolve")));
    } else {
      actions.append(
        reviewButton("Accept", () => applyReviewDecision(group.id, "accept")),
        reviewButton("Reject", () => applyReviewDecision(group.id, "reject")),
      );
    }
    article.append(meta, quote, note, actions);
    article.addEventListener("click", () => {
      state.view.dispatch({ selection: { anchor: item.bodyFrom, head: item.bodyTo }, scrollIntoView: true });
      state.view.focus();
    });
    elements.review_list.append(article);
  }
}

let reviewRenderTimer;
function queueReviewRender() {
  clearTimeout(reviewRenderTimer);
  reviewRenderTimer = setTimeout(renderReviews, 120);
}

function cleanMetadata(value) {
  return value.replaceAll("\\", "/").replace(/[{}%#]/g, " ").replace(/\s+/g, " ").trim();
}

function openReviewDialog() {
  if (!state.view) return showToast("Open a text file first.");
  const selection = state.view.state.selection.main;
  const selected = state.view.state.sliceDoc(selection.from, selection.to);
  if (!selected) return showToast("Select text first.");
  if (parseReviews(state.view.state.doc.toString()).some(item => selection.from < item.to && selection.to > item.from)) {
    return showToast("Resolve the existing review before adding another one.");
  }
  state.reviewSelection = { from: selection.from, to: selection.to, selected };
  document.getElementById("dialog-title").textContent = "Inline comment";
  document.getElementById("dialog-label").textContent = "Comment";
  elements.review_text.value = "";
  elements.review_dialog.showModal();
  elements.review_text.focus();
  elements.review_text.select();
}

elements.review_form.addEventListener("submit", event => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return elements.review_dialog.close();
  const review = state.reviewSelection;
  const value = elements.review_text.value;
  if (!review || !value.trim()) return;
  const id = randomId();
  const author = cleanMetadata(displayName());
  const inserted = `\\cmtbg{${id}}{${author}}${review.selected}\\cmted{${cleanMetadata(value)}}`;
  state.view.dispatch({
    changes: { from: review.from, to: review.to, insert: inserted },
    annotations: reviewMutation.of(true),
  });
  elements.review_dialog.close();
  state.view.focus();
  renderReviews();
});

function randomId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function refreshProject(open = false) {
  const data = await request("v1/project");
  state.main = data.project.main;
  state.files = data.project.files;
  renderFiles();
  if (data.project.build.log) elements.build_output.textContent = data.project.build.log;
  if (data.project.build.pdf) showPdf();
  if (open) {
    const target = state.files.find(file => file.path === state.activeFile)?.path
      || state.files.find(file => file.path === data.project.main)?.path
      || state.files.find(file => file.text)?.path
      || state.files[0]?.path;
    if (target) {
      state.activeFile = "";
      await openFile(target);
    }
  }
  await refreshGit(false);
}

function renderProjects() {
  elements.project_list.replaceChildren();
  for (const project of state.projects) {
    const row = document.createElement("article");
    row.className = "project-row";
    row.innerHTML = '<i data-lucide="folder-kanban"></i>';
    const main = document.createElement("div");
    main.className = "project-row-main";
    const name = document.createElement("button");
    name.type = "button";
    name.textContent = project.name;
    name.addEventListener("click", () => openProjectPage(project.id));
    const details = document.createElement("span");
    details.textContent = project.createdAt
      ? `Created ${new Date(project.createdAt).toLocaleDateString()}`
      : "Collaborative LaTeX project";
    main.append(name, details);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary-button";
    open.textContent = "Open";
    open.addEventListener("click", () => openProjectPage(project.id));
    const menu = document.createElement("details");
    menu.className = "context-menu";
    menu.innerHTML = '<summary class="icon-button" title="Project actions"><i data-lucide="more-horizontal"></i></summary><div class="context-menu-panel"></div>';
    const panel = menu.querySelector("div");
    const actions = [
      ["pencil", "Rename", () => renameProject(project)],
      ["archive", "Download ZIP", () => downloadProject(project.id)],
      ["trash-2", "Delete project", () => deleteProject(project), true],
    ];
    for (const [icon, label, action, danger] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      if (danger) button.className = "danger";
      button.innerHTML = `<i data-lucide="${icon}"></i><span></span>`;
      button.querySelector("span").textContent = label;
      button.addEventListener("click", () => {
        menu.open = false;
        action();
      });
      panel.append(button);
    }
    row.append(main, open, menu);
    elements.project_list.append(row);
  }
  createIcons({ icons: ICONS });
}

async function refreshProjects(preferredId = "") {
  const data = await request("v1/projects");
  state.projects = data.projects;
  if (preferredId && state.projects.some(project => project.id === preferredId)) state.projectId = preferredId;
  renderProjects();
  return data;
}

function projectPageUrl(projectId) {
  return `/projects/${encodeURIComponent(projectId)}`;
}

function routeProjectId() {
  const match = window.location.pathname.match(/^\/projects\/([^/]+)$/);
  if (match) return decodeURIComponent(match[1]);
  return new URLSearchParams(window.location.search).get("project") || "";
}

function showProjectsPage(push = true) {
  disconnectEditor();
  if (elements.git_dialog.open) elements.git_dialog.close();
  if (elements.access_dialog.open) elements.access_dialog.close();
  elements.editor_page.hidden = true;
  elements.projects_page.hidden = false;
  if (push && window.location.pathname !== "/projects") window.history.pushState({}, "", "/projects");
  document.title = "Projects · LaTeX Coder";
}

async function openProjectPage(projectId, push = true) {
  const project = state.projects.find(candidate => candidate.id === projectId);
  if (!project) {
    showProjectsPage(false);
    throw new Error("Project does not exist");
  }
  const changed = projectId !== state.projectId;
  if (changed) disconnectEditor();
  elements.projects_page.hidden = true;
  elements.editor_page.hidden = false;
  state.projectId = projectId;
  elements.project_name.textContent = project.name;
  elements.download_project.href = projectApiUrl("v1/project/archive");
  elements.download_project.download = `${project.id}.zip`;
  if (push && window.location.pathname !== projectPageUrl(projectId)) window.history.pushState({}, "", projectPageUrl(projectId));
  document.title = `${project.name} · LaTeX Coder`;
  if (!changed && state.view) return;
  state.activeFile = "";
  state.pdfRequestVersion += 1;
  state.pdfRenderVersion += 1;
  if (state.pdfLoadingTask) await state.pdfLoadingTask.destroy().catch(() => {});
  state.pdfLoadingTask = null;
  state.pdfDocument = null;
  elements.pdf_document.replaceChildren();
  elements.pdf_document.hidden = true;
  elements.empty_output.hidden = false;
  elements.pdf_status.textContent = "No compiled PDF";
  elements.build_output.textContent = "";
  await refreshProject(true);
}

async function renderPdf() {
  const pdf = state.pdfDocument;
  if (!pdf) return;
  const version = ++state.pdfRenderVersion;
  const firstPage = await pdf.getPage(1);
  const base = firstPage.getViewport({ scale: 1 });
  const fit = Math.min(1.25, Math.max(0.35, (elements.pdf_view.clientWidth - 32) / base.width));
  const scale = fit * state.pdfZoom;
  const fragment = document.createDocumentFragment();

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (version !== state.pdfRenderVersion) return;
    const page = pageNumber === 1 ? firstPage : await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.setAttribute("aria-label", `PDF page ${pageNumber}`);
    fragment.append(canvas);
    await page.render({
      canvas,
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    }).promise;
  }
  if (version !== state.pdfRenderVersion) return;
  elements.pdf_document.replaceChildren(fragment);
  elements.pdf_document.hidden = false;
  elements.empty_output.hidden = true;
  elements.pdf_status.textContent = "PDF ready";
}

async function showPdf(force = false) {
  const requestVersion = ++state.pdfRequestVersion;
  const downloadUrl = projectApiUrl("v1/build/pdf");
  downloadUrl.searchParams.set("v", Date.now());
  elements.pdf_download.href = downloadUrl;
  elements.pdf_status.textContent = "Loading PDF";
  elements.empty_output.hidden = false;
  try {
    if (force && state.pdfLoadingTask) {
      state.pdfRenderVersion += 1;
      await state.pdfLoadingTask.destroy();
      if (requestVersion !== state.pdfRequestVersion) return;
      state.pdfLoadingTask = null;
      state.pdfDocument = null;
    }
    if (!state.pdfDocument) {
      const response = await fetch(elements.pdf_download.href);
      if (!response.ok) throw new Error(`PDF request failed (${response.status})`);
      const loadingTask = getDocument({ data: await response.arrayBuffer() });
      state.pdfLoadingTask = loadingTask;
      const pdf = await loadingTask.promise;
      if (requestVersion !== state.pdfRequestVersion) {
        await loadingTask.destroy();
        return;
      }
      state.pdfDocument = pdf;
    }
    await renderPdf();
  } catch (error) {
    if (requestVersion !== state.pdfRequestVersion) return;
    console.error("paper PDF preview failed", error);
    elements.pdf_document.hidden = true;
    elements.pdf_status.textContent = "Preview failed. Download the PDF instead.";
  }
}

async function compile() {
  elements.compile_button.disabled = true;
  elements.sync_state.textContent = "Compiling";
  try {
    const result = await request("v1/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ main: state.main }),
    });
    elements.build_output.textContent = result.build.log;
    await showPdf(true);
    selectOutput("pdf");
    elements.output_pane.classList.add("mobile-open");
    showToast("PDF compiled.");
  } catch (error) {
    const build = await request("v1/build").catch(() => null);
    elements.build_output.textContent = build?.build?.log || error.message;
    elements.build_log.hidden = false;
    showToast(error.message);
  } finally {
    elements.compile_button.disabled = false;
    elements.sync_state.textContent = state.provider ? "Saved live" : "Stored";
  }
}

function selectOutput(name) {
  document.querySelectorAll("[data-output]").forEach(button => button.classList.toggle("active", button.dataset.output === name));
  elements.pdf_view.hidden = name !== "pdf";
  elements.review_pane.hidden = name !== "review";
  if (name === "review") renderReviews();
}

function renderGitStatus(gitState) {
  state.git = gitState;
  elements.git_dirty.hidden = !gitState.dirty;
  const relation = gitState.upstream
    ? `${gitState.ahead} ahead, ${gitState.behind} behind ${gitState.upstream}`
    : "no upstream";
  elements.git_summary.textContent = `${gitState.branch} · ${gitState.dirty ? "uncommitted changes" : "clean"} · ${relation}`;
  elements.git_change_count.textContent = String(gitState.files.length);
  elements.git_file_list.replaceChildren();
  if (!gitState.files.length) {
    const empty = document.createElement("div");
    empty.className = "git-empty";
    empty.textContent = "Working tree clean";
    elements.git_file_list.append(empty);
  } else {
    for (const file of gitState.files) {
      const row = document.createElement("div");
      row.className = "git-file-row";
      const status = document.createElement("code");
      status.textContent = `${file.index}${file.worktree}`.trim() || "M";
      const name = document.createElement("span");
      name.textContent = file.path;
      row.append(status, name);
      elements.git_file_list.append(row);
    }
  }
  elements.git_history.replaceChildren();
  for (const commit of gitState.history) {
    const row = document.createElement("div");
    row.className = "git-history-row";
    const id = document.createElement("code");
    id.textContent = commit.shortId;
    const subject = document.createElement("span");
    subject.textContent = commit.subject;
    subject.title = `${commit.author}: ${commit.subject}`;
    const date = document.createElement("time");
    date.dateTime = commit.date;
    date.textContent = new Date(commit.date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    row.append(id, subject, date);
    elements.git_history.append(row);
  }
  const conflict = gitState.conflict;
  elements.git_conflict.hidden = !conflict;
  elements.git_conflict_branch.textContent = conflict?.branch || "";
  elements.git_resolve.hidden = !conflict;
}

async function refreshGit(showErrors = true) {
  try {
    const result = await request("v1/git");
    renderGitStatus(result.git);
    return result.git;
  } catch (error) {
    if (showErrors) showToast(error.message);
    return null;
  }
}

async function runGitAction(endpoint, body, successMessage) {
  const buttons = [elements.git_commit, elements.git_sync, elements.git_resolve, elements.git_refresh];
  buttons.forEach(button => { button.disabled = true; });
  elements.sync_state.textContent = "Git operation";
  try {
    const result = await request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (["fast_forward", "merged"].includes(result.git.status)) await refreshProject(true);
    await refreshGit();
    showToast(result.git.status === "conflict" ? `Conflict saved to ${result.git.conflict.branch}.` : successMessage);
    return result;
  } catch (error) {
    showToast(error.message);
    return null;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
    elements.sync_state.textContent = state.provider ? "Saved live" : "Stored";
  }
}

function downloadProject(projectId) {
  const link = document.createElement("a");
  link.href = `${window.location.origin}/v1/project/archive?project=${encodeURIComponent(projectId)}`;
  link.download = `${projectId}.zip`;
  link.click();
}

async function renameProject(project) {
  const name = await openActionDialog({
    title: "Rename project",
    label: "Project name",
    value: project.name,
    maxLength: 80,
    submitLabel: "Rename",
  });
  if (!name || name === project.name) return;
  try {
    await request(`v1/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await refreshProjects(project.id);
    if (state.projectId === project.id) {
      elements.project_name.textContent = name;
      document.title = `${name} · LaTeX Coder`;
    }
    showToast("Project renamed.");
  } catch (error) { showToast(error.message); }
}

async function deleteProject(project) {
  const confirmed = await openActionDialog({
    title: "Delete project",
    message: `Delete “${project.name}” and all of its files? This cannot be undone.`,
    submitLabel: "Delete project",
    danger: true,
  });
  if (!confirmed) return;
  try {
    if (state.projectId === project.id) disconnectEditor();
    await request(`v1/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
    if (state.projectId === project.id) state.projectId = "";
    await refreshProjects();
    showProjectsPage();
    showToast("Project deleted.");
  } catch (error) { showToast(error.message); }
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  showToast(message);
}

function openAccessDialog(focusClone = false) {
  const project = state.projects.find(candidate => candidate.id === state.projectId);
  if (!project) return;
  const shareUrl = `${window.location.origin}${projectPageUrl(project.id)}`;
  const cloneUrl = `${window.location.origin}/git/${encodeURIComponent(project.id)}`;
  elements.access_project_name.textContent = project.name;
  elements.share_link.value = shareUrl;
  elements.clone_command.value = `git clone ${cloneUrl}`;
  elements.access_download.href = projectApiUrl("v1/project/archive");
  elements.access_download.download = `${project.id}.zip`;
  elements.access_dialog.showModal();
  (focusClone ? elements.clone_command : elements.share_link).select();
}

elements.display_name.value = localStorage.getItem("paper-display-name") || `Guest ${Math.floor(Math.random() * 900 + 100)}`;
elements.display_name.addEventListener("change", () => {
  elements.display_name.value = cleanMetadata(displayName()).slice(0, 28) || "Guest";
  localStorage.setItem("paper-display-name", elements.display_name.value);
  setAwareness();
});
elements.back_projects.addEventListener("click", () => showProjectsPage());
elements.share_project.addEventListener("click", () => openAccessDialog(false));
elements.clone_button.addEventListener("click", () => openAccessDialog(true));
elements.download_project.addEventListener("click", event => {
  event.preventDefault();
  downloadProject(state.projectId);
});
elements.access_close.addEventListener("click", () => elements.access_dialog.close());
elements.access_done.addEventListener("click", () => elements.access_dialog.close());
elements.access_dialog.addEventListener("cancel", event => {
  event.preventDefault();
  elements.access_dialog.close();
});
elements.copy_share_link.addEventListener("click", () => copyText(elements.share_link.value, "Editable link copied."));
elements.copy_clone_command.addEventListener("click", () => copyText(elements.clone_command.value, "Clone command copied."));
elements.git_button.addEventListener("click", async () => {
  elements.git_dialog.showModal();
  await refreshGit();
});
elements.git_close.addEventListener("click", () => elements.git_dialog.close());
elements.git_dialog.addEventListener("cancel", event => {
  event.preventDefault();
  elements.git_dialog.close();
});
elements.git_refresh.addEventListener("click", () => refreshGit());
elements.git_commit.addEventListener("click", async () => {
  const result = await runGitAction("v1/git/commit", { message: elements.git_message.value }, "Checkpoint committed.");
  if (result) elements.git_message.value = "";
});
elements.git_sync.addEventListener("click", () => runGitAction(
  "v1/git/sync",
  { ref: elements.git_ref.value.trim() || undefined },
  "Git synchronization complete.",
));
elements.git_resolve.addEventListener("click", async () => {
  const result = await runGitAction("v1/git/resolve", { message: elements.git_message.value }, "Conflict marked resolved.");
  if (result) elements.git_message.value = "";
});
elements.new_project.addEventListener("click", async () => {
  const name = await openActionDialog({
    title: "New project",
    label: "Project name",
    value: "Untitled paper",
    maxLength: 80,
    submitLabel: "Create project",
  });
  if (!name) return;
  try {
    const result = await request("v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await refreshProjects(result.project.id);
    await openProjectPage(result.project.id);
    showToast("Project created.");
  } catch (error) { showToast(error.message); }
});
elements.compile_button.addEventListener("click", compile);
elements.add_comment.addEventListener("click", openReviewDialog);
elements.selection_accept.addEventListener("mousedown", event => event.preventDefault());
elements.selection_accept.addEventListener("click", () => {
  applyReviewDecisions(state.selectionSuggestionIds, "accept");
  state.view?.focus();
});
elements.suggest_edit.addEventListener("click", () => {
  state.suggesting = !state.suggesting;
  elements.suggest_edit.classList.toggle("active", state.suggesting);
  elements.suggest_edit.setAttribute("aria-pressed", String(state.suggesting));
  elements.suggest_edit.querySelector("span").textContent = state.suggesting ? "Suggesting" : "Suggest";
  showToast(state.suggesting ? "Suggestion mode on." : "Suggestion mode off.");
  state.view?.focus();
});
elements.show_log.addEventListener("click", () => { elements.build_log.hidden = false; });
elements.close_log.addEventListener("click", () => { elements.build_log.hidden = true; });
elements.close_output.addEventListener("click", () => elements.output_pane.classList.remove("mobile-open"));
elements.pdf_zoom_out.addEventListener("click", () => {
  state.pdfZoom = Math.max(0.5, state.pdfZoom - 0.15);
  renderPdf();
});
elements.pdf_zoom_in.addEventListener("click", () => {
  state.pdfZoom = Math.min(2, state.pdfZoom + 0.15);
  renderPdf();
});
elements.upload_file.addEventListener("click", () => elements.upload_input.click());
elements.upload_input.addEventListener("change", async () => {
  try {
    for (const file of elements.upload_input.files) {
      await request(`v1/files?path=${encodeURIComponent(file.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
    }
    await refreshProject();
    showToast("Upload complete.");
  } catch (error) { showToast(error.message); }
  elements.upload_input.value = "";
});
elements.new_file.addEventListener("click", async () => {
  const name = await openActionDialog({
    title: "New file",
    label: "File path",
    value: "chapter.tex",
    submitLabel: "Create file",
  });
  if (!name) return;
  try {
    await request(`v1/files?path=${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "",
    });
    await refreshProject();
    await openFile(name);
  } catch (error) { showToast(error.message); }
});
elements.rename_file.addEventListener("click", async () => {
  if (!state.activeFile) return;
  elements.file_menu.open = false;
  const name = await openActionDialog({
    title: "Rename file",
    label: "File path",
    value: state.activeFile,
    submitLabel: "Rename",
  });
  if (!name || name === state.activeFile) return;
  try {
    const old = state.activeFile;
    disconnectEditor();
    await request("v1/files/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: old, to: name }),
    });
    state.activeFile = name;
    await refreshProject(true);
  } catch (error) { showToast(error.message); }
});
elements.delete_file.addEventListener("click", async () => {
  if (!state.activeFile) return;
  elements.file_menu.open = false;
  const confirmed = await openActionDialog({
    title: "Delete file",
    message: `Delete “${state.activeFile}”? This cannot be undone.`,
    submitLabel: "Delete file",
    danger: true,
  });
  if (!confirmed) return;
  try {
    const target = state.activeFile;
    disconnectEditor();
    await request(`v1/files?path=${encodeURIComponent(target)}`, { method: "DELETE" });
    state.activeFile = "";
    await refreshProject(true);
    showToast("File deleted.");
  } catch (error) {
    showToast(error.message);
    await refreshProject(true);
  }
});
elements.toggle_files.addEventListener("click", () => elements.files_pane.classList.toggle("mobile-open"));
document.querySelectorAll("[data-output]").forEach(button => button.addEventListener("click", () => selectOutput(button.dataset.output)));
window.addEventListener("beforeunload", disconnectEditor);
window.addEventListener("popstate", () => {
  const projectId = routeProjectId();
  if (projectId) openProjectPage(projectId, false).catch(error => showToast(error.message));
  else showProjectsPage(false);
});

if (testMode) {
  elements.editor_page.hidden = false;
  window.__paperTest = {
    state,
    createEditor(content, suggesting = true) {
      disconnectEditor();
      const doc = new Y.Doc();
      const ytext = doc.getText("content");
      const provider = { awareness: null, destroy() {} };
      state.suggesting = suggesting;
      state.doc = doc;
      state.provider = provider;
      state.view = new EditorView({
        state: EditorState.create({ doc: "", extensions: editorExtensions(ytext, provider) }),
        parent: elements.editor,
      });
      // Insert only after the binding is attached, so yCollab mirrors the
      // initial text into the editor document.
      ytext.insert(0, content);
      return state.view;
    },
  };
} else {
  if (e2eMode) window.__paperE2E = { state };
  refreshProjects().then(data => {
    const requested = routeProjectId();
    if (requested) return openProjectPage(requested, false);
    if (e2eMode) return openProjectPage(data.defaultProjectId || state.projects[0]?.id, false);
    showProjectsPage(false);
    if (window.location.pathname !== "/projects") window.history.replaceState({}, "", "/projects");
  }).catch(error => showToast(error.message));
}
