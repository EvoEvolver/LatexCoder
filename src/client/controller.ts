import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab, selectAll } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Annotation, EditorSelection, EditorState, StateEffect, StateField, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
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
  rectangularSelection,
  WidgetType,
  ViewPlugin,
} from "@codemirror/view";
import {
  Archive,
  ArrowLeft,
  createIcons,
  CheckCheck,
  ChevronRight,
  Copy,
  Download,
  File,
  FileCheck2,
  FilePlus2,
  FileText,
  Folder,
  FolderKanban,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestCreateArrow,
  Image,
  Link,
  LogIn,
  LogOut,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Play,
  RefreshCw,
  TerminalSquare,
  Trash2,
  Upload,
  UserPlus,
  UserRound,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { diffLines } from "diff";
import * as Y from "yjs";

import { createFileTabs } from "./file-tabs";
import { installPdfWheel } from "./pdf-wheel";
import { darkenPdfCanvas, downloadPdf, downloadPdfBytes } from './pdf-appearance';
import { setupPreferences, editorPreferences, preferenceExtensions, isDarkTheme, isDarkPdf } from './preferences';
import { projectReviews } from "./visual-review";
import { RichEditor } from "./rich-editor";
import { setupWorkspace } from "./workspace";
import { createFileTree } from "./file-tree";
import { parseReviews, stripReviewStorage, type ReviewItem } from "../shared/review.ts";
import { referenceLinks, referenceDefinition, type ReferenceLink } from "../shared/references.ts";
import { buildDiagnostics, compileErrors } from "../shared/compile-errors.ts";
import { createApiClient, socketUrl } from "./api.ts";
import { projectCompletionSource } from "./completions.ts";
import { setThemePreference, themePreference, type ThemePreference } from "./theme.ts";
import type {
  AppElement, AppState, BuildInfo, CurrentUser, DialogOptions, EditorSettings, GitState, PdfPosition,
  ProjectDetail, ProjectFile, ProjectMember, ProjectSummary, ReplacementPreview, ReviewDecision, ReviewGroup,
  SearchMatch, ShareDetails, SourcePosition,
} from "./types.ts";

declare global {
  interface Window {
    __paperTest?: unknown;
    __paperE2E?: unknown;
  }
}

const ICONS = {
    ChevronRight,
    Folder,
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
    LogIn,
    LogOut,
    MessageSquarePlus,
    MoreHorizontal,
    PanelLeft,
    Pencil,
    Play,
    RefreshCw,
    TerminalSquare,
    Trash2,
    Upload,
    UserPlus,
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
  "access-close", "access-dialog", "access-done", "access-download", "access-project-name", "agent-command", "back-projects",
  "account-button", "account-cancel", "account-close", "account-dialog", "account-display-name", "account-form", "account-logout", "account-save", "account-username",
  "action-cancel", "action-close", "action-dialog", "action-form", "action-input", "action-label", "action-message", "action-submit", "action-title",
  "auth-description", "auth-error", "auth-form", "auth-page", "auth-password", "auth-submit", "auth-title", "auth-username",
  "active-file-label", "add-comment", "binary-download", "binary-fallback", "binary-fallback-download", "binary-kind", "binary-name", "binary-status", "binary-view",
  "build-log", "build-output", "clone-command", "clone-section", "close-output", "compile-button", "copy-agent-link", "copy-clone-command", "copy-share-link", "display-name", "download-project",
  "collaborator-list", "editor-account-button", "editor-account-name", "editor-login", "editor-page", "editor", "empty-output", "file-list", "file-pdf-document", "file-preview-viewport", "file-preview-zoom-in", "file-preview-zoom-out", "files-pane", "guest-name-field", "image-preview", "new-file", "new-project", "output-pane", "pdf-document", "review-actions",
  "copy-invite-link", "current-user", "invite-close", "invite-dialog", "invite-done", "invite-link", "invite-regenerate", "invite-user", "logout-button",
  "pdf-download", "pdf-status", "pdf-view", "pdf-zoom-in", "pdf-zoom-out", "presence", "review-count", "review-dialog", "review-form",
  "project-list", "project-name", "projects-page", "review-cancel", "review-close", "review-list", "review-pane", "review-text", "rotate-share-secret", "share-link", "share-project", "suggest-edit", "sync-state",
  "git-button", "git-change-count", "git-close", "git-commit", "git-conflict", "git-conflict-branch", "git-dialog", "git-dirty", "git-file-list",
  "git-history", "git-message", "git-refresh", "git-resolve", "git-summary",
  "toast", "toggle-files", "collapse-files", "collapse-output", "collapse-editor", "new-folder", "rich-text-toggle", "rich-editor", "workspace", "upload-file", "upload-input", "selection-actions", "selection-accept",
].map(id => [id.replaceAll("-", "_"), document.getElementById(id)])) as Record<string, AppElement>;
const appearanceDialog = document.getElementById("appearance-dialog") as HTMLDialogElement;
const themeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-theme-option]")];
function syncThemeControls(): void {
  const preference = themePreference();
  for (const button of themeButtons) {
    const selected = button.dataset.themeOption === preference;
    button.setAttribute("aria-checked", String(selected));
    button.classList.toggle("border-primary", selected);
    button.classList.toggle("bg-accent", selected);
  }
  for (const trigger of document.querySelectorAll<HTMLElement>("#auth-theme, #projects-theme, #editor-theme")) {
    trigger.title = `Appearance: ${preference[0].toUpperCase()}${preference.slice(1)}`;
  }
}
for (const trigger of document.querySelectorAll<HTMLElement>("#auth-theme, #projects-theme, #editor-theme")) {
  trigger.addEventListener("click", () => { syncThemeControls(); appearanceDialog.showModal(); });
}
for (const button of themeButtons) button.addEventListener("click", () => {
  setThemePreference(button.dataset.themeOption as ThemePreference);
  syncThemeControls();
  appearanceDialog.close();
});
document.getElementById("appearance-close")!.addEventListener("click", () => appearanceDialog.close());
appearanceDialog.addEventListener("cancel", event => { event.preventDefault(); appearanceDialog.close(); });
window.addEventListener("latexcoder-theme-change", syncThemeControls);
syncThemeControls();

const IMAGE_PREVIEW_PATTERN = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const palette = ["#236b59", "#98602b", "#7455a5", "#2c6e9d", "#a14960", "#55713a", "#855b43", "#39716e"];
const latexHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.macroName, tags.controlKeyword], color: "var(--syntax-keyword)" },
  { tag: [tags.name, tags.typeName, tags.className, tags.variableName], color: "var(--syntax-name)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.atom], color: "var(--syntax-number)" },
  { tag: [tags.comment, tags.meta], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [tags.heading, tags.strong], color: "var(--foreground)", fontWeight: "700" },
  { tag: tags.link, color: "var(--primary)", textDecoration: "underline" },
]);
const state: AppState = {
  activeFile: "main.tex",
  projectId: "",
  projects: [],
  user: null,
  bootstrapReady: true,
  projectCanManage: false,
  accessShareId: "",
  git: null,
  main: "main.tex",
  files: [],
  folders: [],
  settings: null,
  view: null,
  doc: null,
  provider: null,
  persistence: null,
  unsaved: false,
  pdfDocument: null,
  pdfLoadingTask: null,
  pdfRequestVersion: 0,
  pdfRenderVersion: 0,
  pdfZoom: 1,
  pdfSourceRevision: null,
  pdfHighlights: null,
  filePreviewDocument: null,
  filePreviewLoadingTask: null,
  filePreviewVersion: 0,
  filePreviewZoom: 1,
  reviewSelection: null,
  selectionSuggestionIds: [],
  suggesting: false,
  toastTimer: null,
};
const { request, projectApiUrl } = createApiClient(() => state.projectId);
const reviewMutation = Annotation.define();
// Track the deletion block each author created most recently so consecutive
// Backspace keystrokes extend it instead of nesting new markers. The record
// lives per-transaction because positions shift as the document changes.
const lastDeletion = new WeakMap();
const editorUndoManagers = new WeakMap<EditorView, Y.UndoManager>();
let autoCompileTimer: ReturnType<typeof setTimeout>;
let compileRunning = false;
let compileQueued = false;

function updateSyncStatus() {
  if (!state.provider) return;
  const connected = state.provider.wsconnected;
  elements.sync_state.textContent = !connected ? state.unsaved ? "Offline - unsynced edits" : "Reconnecting"
    : !state.provider.synced ? "Synchronizing"
    : state.unsaved ? "Saving..." : "Saved live";
}

function scheduleAutoCompile() {
  clearTimeout(autoCompileTimer);
  if (state.settings?.autoCompile && state.projectId) autoCompileTimer = setTimeout(() => {
    if (state.provider?.wsconnected && state.provider.synced) compile();
  }, 1200);
}

function hash(value: string): number {
  let result = 0;
  for (const character of value) result = ((result << 5) - result + character.charCodeAt(0)) | 0;
  return Math.abs(result);
}

function colorFor(name: string): string {
  return palette[hash(name) % palette.length];
}

function displayName(): string {
  return state.user?.displayName || elements.display_name.value.trim() || "Guest";
}

function syncAccountUi(): void {
  const registered = Boolean(state.user);
  elements.guest_name_field.hidden = registered;
  elements.editor_account_button.hidden = !registered;
  elements.current_user.textContent = state.user?.displayName || state.user?.username || "";
  elements.editor_account_name.textContent = state.user?.displayName || state.user?.username || "";
}

function openAccountPanel(): void {
  if (!state.user) return;
  elements.account_username.value = state.user.username;
  elements.account_display_name.value = state.user.displayName || state.user.username;
  elements.account_dialog.showModal();
  queueMicrotask(() => elements.account_display_name.select());
}

function encodeRoom(relativePath: string): string {
  const bytes = new TextEncoder().encode(relativePath);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function showToast(message: string): void {
  if (testMode) return;
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3200);
}

function openActionDialog({ title, label = "", value = "", maxLength = 512, message = "", submitLabel, danger = false, zip = false }: DialogOptions): Promise<string | boolean | null> {
  document.querySelector("#project-zip-field")?.remove();
  if (zip) {
    const field = document.createElement("label");
    field.id = "project-zip-field";
    field.className = "grid gap-1.5 text-sm font-medium";
    field.textContent = "Import ZIP (optional)";
    const input = document.createElement("input");
    input.id = "project-zip-input";
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.className = "text-sm file:mr-3 file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-secondary-foreground";
    field.append(input);
    elements.action_form.querySelector("footer").before(field);
  }
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
    const finish = (result: string | boolean | null): void => {
      if (settled) return;
      settled = true;
      elements.action_form.removeEventListener("submit", submit);
      elements.action_dialog.removeEventListener("cancel", cancel);
      elements.action_cancel.removeEventListener("click", cancel);
      elements.action_close.removeEventListener("click", cancel);
      elements.action_dialog.close();
      resolve(result);
    };
    const submit = (event: Event): void => {
      event.preventDefault();
      const result = hasInput ? elements.action_input.value.trim() : true;
      if (hasInput && !result) { elements.action_input.reportValidity(); return; }
      finish(result);
    };
    const cancel = (event: Event): void => {
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

const workspaceLayout = setupWorkspace();
const fileTabs = createFileTabs(document.getElementById("file-tabs")!, path => void openFile(path));
const fileTree = createFileTree(elements.file_list, {
  open: openFile, rename: renameEntry, remove: deleteEntry, create: createEntry,
  move: moveEntry,
  download: path => { const a = document.createElement('a'); a.href = projectApiUrl(`v1/files?path=${encodeURIComponent(path)}`).toString(); a.download = path.split('/').at(-1)!; a.click(); },
});
function renderFiles() {
  fileTabs.update(state.files, state.activeFile, state.projectId);
  fileTree.render({ files: state.files, directories: state.folders || [], active: state.activeFile, main: state.main || "" }, state.projectId);
}
async function moveEntry(from: string, to: string) {
  const active = state.activeFile;
  const affected = active === from || active.startsWith(from + "/");
  try {
    await request("v1/files/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({from, to}) });
    fileTabs.move(from, to);
    if (affected) { disconnectEditor(); state.activeFile = to + active.slice(from.length); }
    fileTree.reveal(to);
    await refreshProject(affected);
  } catch (error) { showToast(error.message); }
}
async function renameEntry(target: string, folder: boolean) {
  const name = await openActionDialog({ title: folder ? "Rename folder" : "Rename file", label: "Path", value: target, submitLabel: "Rename" });
  if (name && name !== target) await moveEntry(target, String(name));
}
async function deleteEntry(target: string, folder: boolean) {
  if (!folder) return deleteFile(target);
  const confirmed = await openActionDialog({ title: "Delete folder?", message: `Delete “${target}” and all files inside it? You can restore them from Deleted files in Project settings.`, submitLabel: "Delete folder", danger: true });
  if (!confirmed) return;
  const affected = state.activeFile.startsWith(target + "/");
  try {
    await request(`v1/files?path=${encodeURIComponent(target)}`, { method: "DELETE" });
    if (affected) { disconnectEditor(); state.activeFile = ""; }
    await refreshProject(affected); showToast("Folder deleted.");
  } catch (error) { showToast(error.message); }
}
async function createEntry(parent: string, folder: boolean) {
  const name = await openActionDialog({ title: folder ? "New folder" : "New file", label: "Path", value: (parent ? parent + "/" : "") + (folder ? "untitled" : "chapter.tex"), submitLabel: "Create" });
  if (!name) return;
  try {
    if (!folder && state.files.some(file => file.path === name)) throw new Error("A file already exists at this path.");
    if (folder) await request("v1/files/folder", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({path: name}) });
    else await request(`v1/files?path=${encodeURIComponent(String(name))}`, { method: "PUT", headers: {"Content-Type": "text/plain; charset=utf-8"}, body: "" });
    fileTree.reveal(String(name) + (folder ? "/" : "")); await refreshProject();
    if (!folder) await openFile(String(name));
  } catch (error) { showToast(error.message); }
}

elements.file_list.addEventListener("scroll", () => {
  for (const menu of elements.file_list.querySelectorAll(".file-actions[open]")) menu.removeAttribute("open");
}, { passive: true });

class RevisionDeletionWidget extends WidgetType {
  id: string;
  author: string;
  text: string;

  constructor(id: string, author: string, text: string) {
    super();
    this.id = id;
    this.author = author;
    this.text = text;
  }

  eq(other: RevisionDeletionWidget): boolean {
    return other.id === this.id && other.author === this.author && other.text === this.text;
  }

  toDOM(): HTMLElement {
    const deletion = document.createElement("span");
    deletion.className = "cm-review-deletion";
    deletion.textContent = this.text;
    deletion.title = `Original text changed by ${this.author || "Guest"}`;
    return deletion;
  }

  ignoreEvent(): boolean { return true; }
}

function buildReviewDecorations(editorState: EditorState) {
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

function tooltipButton(label: string, action: () => void): HTMLButtonElement {
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
        ? `${item.author || "Guest"} commented · ${item.messages.length} message${item.messages.length === 1 ? "" : "s"}`
        : `${item.author || "Guest"} suggested an edit`;
      const note = document.createElement("p");
      if (item.kind === "comment") {
        const latest = item.messages.at(-1);
        note.textContent = latest.root
          ? latest.body
          : `${latest.author || "Guest"}: ${latest.body}`;
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
        actions.append(
          tooltipButton("Reply", () => openCommentThread(item.id, true)),
          tooltipButton("Open thread", () => openCommentThread(item.id)),
          tooltipButton("Resolve", () => applyReviewDecision(item.id, "resolve")),
        );
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

function trackedSuggestion(transaction: Transaction, reviews: ReviewItem[]): Transaction | TransactionSpec | readonly TransactionSpec[] {
  const changes: Array<{ from: number; to: number; inserted: string }> = [];
  transaction.changes.iterChanges((from: number, to: number, _newFrom: number, _newTo: number, inserted) => {
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
  if (/\\(?:cmtbg|cmted|cmtrpl|revbg|reved|addbg|added|delbg|deled)\b/.test(change.inserted)) {
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
    if (/\\(?:cmtbg|cmted|cmtrpl|revbg|reved|addbg|added|delbg|deled)\b/.test(inserted.toString())) blocked = true;
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

async function followReference(link: ReferenceLink) {
  const projectId = state.projectId;
  const originFile = state.activeFile;
  try {
    if (link.kind === "url") {
      const url = new URL(link.key);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) throw new Error("Unsupported URL protocol");
      window.open(url.href, "_blank", "noopener,noreferrer");
      return;
    }
    let destination: { path: string; from: number; to: number } | undefined;
    if (link.kind === "file" || link.kind === "asset") {
      const directory = originFile.split("/").slice(0, -1).join("/");
      const normalize = (value: string) => {
        const parts: string[] = [];
        for (const part of value.split("/")) {
          if (part === "..") parts.pop();
          else if (part && part !== ".") parts.push(part);
        }
        return parts.join("/");
      };
      const names = link.kind === "asset" ? /\.[^/]+$/.test(link.key) ? [link.key] : [link.key, ...["pdf", "png", "jpg", "jpeg", "svg", "webp", "gif"].map(extension => `${link.key}.${extension}`)] : [link.key.endsWith(".tex") ? link.key : `${link.key}.tex`];
      const candidates = names.flatMap(name => [normalize(name), normalize(`${directory}/${name}`)]);
      const file = candidates.map(candidate => state.files.find(file => file.path === candidate)).find(Boolean);
      if (file) destination = { path: file.path, from: 0, to: 0 };
    } else {
      const kind = link.kind;
      const candidates = state.files.filter(file => file.path.endsWith(kind === "cite" ? ".bib" : ".tex"));
      candidates.sort((left, right) => Number(right.path === originFile) - Number(left.path === originFile));
      for (const file of candidates) {
        const source = file.path === originFile ? state.view.state.doc.toString()
          : await (await fetch(projectApiUrl(`v1/files?path=${encodeURIComponent(file.path)}`))).text();
        const definition = referenceDefinition(source, link.key, kind);
        if (definition) { destination = { path: file.path, ...definition }; break; }
      }
    }
    if (state.projectId !== projectId || state.activeFile !== originFile) return;
    if (!destination) { showToast(`Definition not found: ${link.key}`); return; }
    await openFile(destination.path);
    if (link.kind === "asset") return;
    const provider = state.provider;
    const view = state.view;
    const deadline = Date.now() + 5000;
    while (!provider.synced && Date.now() < deadline && state.view === view) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (state.view !== view || !provider.synced) return;
    const source = view.state.doc.toString();
    const current = link.kind === "file" ? { from: 0, to: 0 } : referenceDefinition(source, link.key, link.kind);
    if (!current) { showToast(`Definition not found: ${link.key}`); return; }
    elements.output_pane.classList.remove("mobile-open");
    view.dispatch({ selection: { anchor: current.from, head: current.to }, effects: EditorView.scrollIntoView(current.from, { y: "center" }) });
    view.focus();
  } catch (error) { showToast(error.message); }
}

const referenceControl = StateEffect.define<boolean>();
const macReferences = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const referenceModifier = macReferences ? "Meta" : "Control";
const referenceModifierPressed = (event: MouseEvent) => macReferences ? event.metaKey : event.ctrlKey;
let controlHeld = false;
const referenceHighlights = StateField.define({
  create: () => ({ held: controlHeld, marks: Decoration.none }),
  update(value, transaction) {
    let held = value.held;
    for (const effect of transaction.effects) if (effect.is(referenceControl)) held = effect.value;
    if (!held) return { held, marks: Decoration.none };
    const marks = referenceLinks(transaction.state.doc.toString()).map(link =>
      Decoration.mark({ class: "cm-reference-link" }).range(link.from, link.to));
    return { held, marks: Decoration.set(marks, true) };
  },
  provide: field => EditorView.decorations.from(field, value => value.marks),
});

function setReferenceControl(held: boolean) {
  if (held === controlHeld) return;
  controlHeld = held;
  state.view?.dispatch({ effects: referenceControl.of(held) });
  if (!held && state.view) state.view.contentDOM.style.cursor = "";
}
window.addEventListener("keydown", event => { if (event.key === referenceModifier) setReferenceControl(true); }, true);
window.addEventListener("keyup", event => { if (event.key === referenceModifier) setReferenceControl(false); }, true);
window.addEventListener("blur", () => setReferenceControl(false));

function editorExtensions(ytext: Y.Text, provider: Pick<WebsocketProvider, "awareness">): Extension[] {
  const undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set() });
  state.undoManager = undoManager;
  return [
    editorPreferences.of(preferenceExtensions()),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    ViewPlugin.define(view => {
      editorUndoManagers.set(view, undoManager);
      return { destroy() { editorUndoManagers.delete(view); undoManager.destroy(); } };
    }),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(latexHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [projectCompletionSource({
      projectId: () => state.projectId,
      activeFile: () => state.activeFile,
      files: () => state.files,
      readFile: async relativePath => {
        const response = await fetch(projectApiUrl(`v1/files?path=${encodeURIComponent(relativePath)}`));
        if (!response.ok) return "";
        return response.text();
      },
    })] }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    StreamLanguage.define(stex),
    referenceHighlights,
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
        if (!referenceModifierPressed(event) || event.button !== 0) return false;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        const link = referenceLinks(view.state.doc.toString()).find(link => position >= link.from && position < link.to);
        if (!link) return false;
        event.preventDefault();
        void followReference(link);
        return true;
      },
      mousemove(event, view) {
        const position = referenceModifierPressed(event) ? view.posAtCoords({ x: event.clientX, y: event.clientY }) : null;
        const linked = position !== null && referenceLinks(view.state.doc.toString()).some(link => position >= link.from && position < link.to);
        view.contentDOM.style.cursor = linked ? "pointer" : "";
      },
      keyup(event, view) { if (event.key === referenceModifier) view.contentDOM.style.cursor = ""; },
      contextmenu(event, view) {
        event.preventDefault();
        openEditorContextMenu(event, view);
        return true;
      },
    }),
    reviewDecorations,
    reviewTooltip,
    protectReviewStorage,
    EditorView.clipboardOutputFilter.of(source => stripReviewStorage(source)),
    keymap.of([...yUndoManagerKeymap, ...defaultKeymap, ...searchKeymap, indentWithTab]),
    EditorView.updateListener.of(update => {
      if (update.docChanged || update.selectionSet) closeEditorContextMenu();
      if (update.docChanged) {
        queueReviewRender();
        queueMicrotask(() => { visualEditor.sync(); visualEditor.refreshReviews(); });
        elements.git_dirty.hidden = false;
        markPdfStale();
        scheduleAutoCompile();
      }
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) {
        queueMicrotask(renderSelectionActions);
      }
    }),
    EditorView.theme({
      "&": { width: "100%", maxWidth: "100%", minWidth: "0", height: "100%", overflow: "hidden", backgroundColor: "var(--code-background)", color: "var(--code-foreground)", fontSize: "var(--code-font-size, 13px)" },
      ".cm-scroller": { minWidth: "0", overflow: "auto", fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace", lineHeight: "var(--code-line-height, 1.6)" },
      ".cm-gutters": { borderRight: "1px solid var(--code-border)", color: "var(--code-comment)", backgroundColor: "var(--code-gutter)" },
      ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--code-active)" },
      ".cm-content": { minWidth: "0", padding: "12px 0", caretColor: "var(--code-caret)" },
      ".cm-line": { padding: "0 14px" },
      "&.cm-focused .cm-cursor": { borderLeftColor: "var(--code-caret)" },
      ".cm-review-comment": { padding: "1px 0", borderBottom: "2px solid #d28a16", borderRadius: "2px", backgroundColor: "#fff0aa", cursor: "help" },
      ".cm-review-insertion": { padding: "1px 0", borderBottom: "2px solid #188064", backgroundColor: "#dcefe7", color: "#115b48", textDecoration: "underline", textDecorationColor: "#188064", textUnderlineOffset: "3px", cursor: "help" },
      ".cm-review-deletion": { marginLeft: "4px", padding: "1px 3px", borderRadius: "3px", backgroundColor: "#f8dddd", color: "#a1373d", textDecoration: "line-through", textDecorationThickness: "1.5px", cursor: "help", whiteSpace: "pre-wrap" },
      ".cm-review-tooltip": { width: "min(320px, calc(100vw - 32px))", padding: "11px", border: "1px solid #d8dbd5", borderLeft: "3px solid #d28a16", borderRadius: "6px", backgroundColor: "#fff", boxShadow: "0 10px 28px rgb(21 25 20 / 18%)", color: "#292b27", fontFamily: "ui-sans-serif, sans-serif" },
      ".cm-reference-link": { textDecoration: "underline", color: "var(--code-caret)", cursor: "pointer" },
      ".cm-review-tooltip.revision": { borderLeftColor: "#188064" },
      ".cm-review-tooltip strong": { display: "block", marginBottom: "6px", fontSize: "11px" },
      ".cm-review-tooltip p": { maxHeight: "120px", margin: "0", overflow: "auto", fontSize: "12px", lineHeight: "1.45", whiteSpace: "pre-wrap" },
      ".cm-review-tooltip-actions": { display: "flex", justifyContent: "flex-end", gap: "5px", marginTop: "9px" },
      ".cm-review-tooltip-actions button": { height: "27px", padding: "0 9px", border: "1px solid var(--border)", borderRadius: "4px", backgroundColor: "var(--background)", color: "var(--foreground)", fontSize: "10px", fontWeight: "650" },
      // Keep local selections unmistakable next to comment and revision marks.
      // CodeMirror's default theme is loaded at the same precedence, so the
      // drawn selection layer needs an explicit override.
      // CodeMirror normally puts this layer behind the content. Review marks
      // have their own backgrounds, so selected text inside a mark would hide
      // the selection unless the translucent layer is drawn above it.
      "&.cm-focused .cm-selectionLayer, &[data-context-menu] .cm-selectionLayer": { zIndex: "3 !important", pointerEvents: "none" },
      "&.cm-focused .cm-selectionBackground, &[data-context-menu] .cm-selectionBackground": {
        backgroundColor: "rgb(63 153 220 / 18%) !important",
        boxShadow: "inset 0 0 0 1px rgb(38 120 181 / 85%)",
      },
      ".cm-content ::selection": { backgroundColor: "rgb(63 153 220 / 22%) !important" },
    }),
    yCollab(ytext, provider.awareness, { undoManager }),
  ];
}

function disconnectEditor() {
  visualEditor.hide();
  elements.rich_text_toggle.classList.remove("active");
  document.getElementById("source-mode")?.classList.add("active");
  document.getElementById("source-mode")?.setAttribute("aria-pressed", "true");
  elements.rich_text_toggle.setAttribute("aria-pressed", "false");
  closeEditorContextMenu();
  state.provider?.destroy();
  state.view?.destroy();
  state.doc?.destroy();
  state.persistence?.destroy();
  state.persistence = null;
  clearTimeout(autoCompileTimer);
  state.provider = null;
  state.view = null;
  state.doc = null;
  state.selectionSuggestionIds = [];
  elements.selection_actions.hidden = true;
}

function resetFilePreview() {
  state.filePreviewVersion += 1;
  state.filePreviewLoadingTask?.destroy().catch(() => {});
  state.filePreviewLoadingTask = null;
  state.filePreviewDocument = null;
  state.filePreviewZoom = 1;
  elements.image_preview.onload = null;
  elements.image_preview.onerror = null;
  elements.image_preview.removeAttribute("src");
  elements.image_preview.hidden = true;
  elements.file_pdf_document.replaceChildren();
  elements.file_pdf_document.hidden = true;
  elements.binary_fallback.hidden = true;
}

function sizeImagePreview() {
  const image = elements.image_preview;
  if (!image.naturalWidth || !image.naturalHeight) return;
  const viewport = elements.file_preview_viewport;
  const fit = Math.min(
    1,
    Math.max(0.05, (viewport.clientWidth - 32) / image.naturalWidth),
    Math.max(0.05, (viewport.clientHeight - 32) / image.naturalHeight),
  );
  image.style.width = `${Math.round(image.naturalWidth * fit * state.filePreviewZoom)}px`;
  image.style.height = `${Math.round(image.naturalHeight * fit * state.filePreviewZoom)}px`;
}

async function renderFilePdf() {
  const pdf = state.filePreviewDocument;
  if (!pdf) return;
  const version = ++state.filePreviewVersion;
  const firstPage = await pdf.getPage(1);
  const base = firstPage.getViewport({ scale: 1 });
  const fit = Math.min(1.25, Math.max(0.25, (elements.file_preview_viewport.clientWidth - 32) / base.width));
  const scale = fit * state.filePreviewZoom;
  const fragment = document.createDocumentFragment();
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (version !== state.filePreviewVersion) return;
    const page = pageNumber === 1 ? firstPage : await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.setAttribute("aria-label", `Preview page ${pageNumber}`);
    fragment.append(canvas);
    await page.render({
      canvas,
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    }).promise;
  }
  if (version !== state.filePreviewVersion) return;
  elements.file_pdf_document.replaceChildren(fragment);
  elements.file_pdf_document.hidden = false;
  elements.binary_status.textContent = `${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}`;
}

function showFilePreviewFallback(relativePath: string, message = "Preview unavailable"): void {
  elements.binary_kind.textContent = "Binary file";
  elements.binary_status.textContent = message;
  elements.binary_name.textContent = relativePath;
  elements.binary_fallback.hidden = false;
  elements.file_preview_zoom_in.disabled = true;
  elements.file_preview_zoom_out.disabled = true;
}

async function showFilePreview(file: ProjectFile): Promise<void> {
  resetFilePreview();
  const relativePath = file.path;
  const url = projectApiUrl(`v1/files?path=${encodeURIComponent(relativePath)}`);
  elements.binary_download.href = url.toString();
  elements.binary_download.download = relativePath.split("/").at(-1);
  elements.binary_fallback_download.href = url.toString();
  elements.binary_fallback_download.download = relativePath.split("/").at(-1);
  elements.file_preview_zoom_in.disabled = false;
  elements.file_preview_zoom_out.disabled = false;
  const version = state.filePreviewVersion;

  if (IMAGE_PREVIEW_PATTERN.test(relativePath)) {
    elements.binary_kind.textContent = "Image preview";
    elements.binary_status.textContent = "Loading";
    elements.image_preview.alt = relativePath;
    elements.image_preview.onload = () => {
      if (version !== state.filePreviewVersion) return;
      elements.image_preview.hidden = false;
      elements.binary_status.textContent = `${elements.image_preview.naturalWidth} × ${elements.image_preview.naturalHeight}`;
      sizeImagePreview();
    };
    elements.image_preview.onerror = () => {
      if (version === state.filePreviewVersion) showFilePreviewFallback(relativePath, "Image preview failed");
    };
    elements.image_preview.src = url.toString();
    return;
  }

  if (/\.pdf$/i.test(relativePath)) {
    elements.binary_kind.textContent = "PDF preview";
    elements.binary_status.textContent = "Loading";
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`PDF request failed (${response.status})`);
      const loadingTask = getDocument({ data: await response.arrayBuffer() });
      state.filePreviewLoadingTask = loadingTask;
      const pdf = await loadingTask.promise;
      if (version !== state.filePreviewVersion) {
        await loadingTask.destroy();
        return;
      }
      state.filePreviewDocument = pdf;
      await renderFilePdf();
    } catch (error) {
      if (state.activeFile !== relativePath) return;
      console.error("project PDF preview failed", error);
      showFilePreviewFallback(relativePath, "PDF preview failed");
    }
    return;
  }

  showFilePreviewFallback(relativePath);
}

function updatePresence() {
  elements.presence.replaceChildren();
  if (!state.provider) return;
  const users = [...state.provider.awareness.getStates().entries()]
    .filter(([clientId]) => clientId !== state.provider.awareness.clientID)
    .map(([, value]) => value.user)
    .filter(Boolean)
    .slice(0, 10);
  for (const user of users) {
    const avatar = document.createElement("span");
    avatar.className = "presence-avatar -ml-1.5 grid size-7 place-items-center rounded-full border-2 border-background text-[9px] font-bold text-white";
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

async function openFile(relativePath: string): Promise<void> {
  const file = state.files.find(candidate => candidate.path === relativePath);
  if (!file) return;
  elements.files_pane.classList.remove("mobile-open");
  if (relativePath === state.activeFile && (state.view || !file.text)) return;
  disconnectEditor();
  resetFilePreview();
  state.activeFile = relativePath;
  fileTree.reveal(relativePath);
  elements.active_file_label.textContent = relativePath;
  elements.binary_view.hidden = file.text;
  elements.editor.hidden = !file.text;
  elements.review_actions.hidden = !file.text;
  elements.rich_text_toggle.parentElement.hidden = !file.text || !/\.tex$/i.test(relativePath);
  document.getElementById("format-tools")!.hidden = !file.text;
  renderFiles();
  if (!file.text) {
    elements.sync_state.textContent = "Preview";
    renderReviews();
    await showFilePreview(file);
    return;
  }

  elements.sync_state.textContent = "Connecting";
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(socketUrl(`v1/collab/${encodeURIComponent(state.projectId)}`), encodeRoom(relativePath), doc, { connect: true, params: { saved: "1" } });
  const ytext = doc.getText("content");
  state.doc = doc;
  state.provider = provider;
  state.persistence = new IndexeddbPersistence(`project:${state.projectId}:${relativePath}`, doc);
  state.unsaved = true;
  let nonce = 0;
  const requestSave = () => {
    state.unsaved = true;
    if (provider.wsconnected && provider.synced) {
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, 3);
      encoding.writeVarString(message, String(nonce));
      provider.ws.send(encoding.toUint8Array(message));
    }
    updateSyncStatus();
  };
  provider.messageHandlers[3] = (_encoder, decoder) => {
    const savedNonce = decoding.readVarString(decoder);
    if (state.provider === provider && savedNonce === String(nonce)) { state.unsaved = false; updateSyncStatus(); }
  };
  doc.on("update", (_update, origin) => {
    if (state.provider !== provider) return;
    if (origin !== provider) { nonce++; requestSave(); }
  });
  state.view = new EditorView({
    state: EditorState.create({ doc: "", extensions: editorExtensions(ytext, provider) }),
    parent: elements.editor,
  });
  provider.on("status", () => {
    if (state.provider === provider) updateSyncStatus();
  });
  provider.on("sync", synced => {
    if (synced) {
      if (state.provider !== provider) return;
      requestSave();
      renderReviews();
      scheduleAutoCompile();
    }
  });
  provider.awareness.on("change", updatePresence);
  setAwareness();
}

function applyReviewDecisions(ids: string[], decision: ReviewDecision): void {
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

function applyReviewDecision(id: string, decision: ReviewDecision): void {
  applyReviewDecisions([id], decision);
}

function appendCommentReply(threadId: string, value: string): boolean {
  if (!state.view || !value.trim()) return false;
  const thread = parseReviews(state.view.state.doc.toString())
    .find(item => item.kind === "comment" && item.id === threadId);
  if (!thread || !thread.repliesValid || thread.replyInsertAt === null) {
    showToast("This comment thread cannot accept a reply.");
    return false;
  }
  const reply = `\\cmtrpl{${randomId()}}{${cleanMetadata(displayName())}}{${cleanMetadata(value)}}`;
  state.view.dispatch({
    changes: { from: thread.replyInsertAt, to: thread.replyInsertAt, insert: reply },
    annotations: reviewMutation.of(true),
  });
  renderReviews();
  return true;
}

function openCommentThread(threadId: string, reply = false): void {
  selectOutput("review");
  renderReviews();
  const article = [...elements.review_list.querySelectorAll<HTMLElement>(".review-item")]
    .find(candidate => candidate.dataset.reviewId === threadId && candidate.dataset.filePath === state.activeFile);
  if (!article) return;
  article.scrollIntoView({ block: "nearest", behavior: "smooth" });
  article.classList.add("ring-2", "ring-primary");
  setTimeout(() => article.classList.remove("ring-2", "ring-primary"), 1200);
  if (reply) article.querySelector<HTMLElement>("[data-comment-reply]")?.click();
}

function reviewButton(label: string, action: () => void | Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "h-7 rounded-md border bg-background px-2.5 text-[11px] font-medium hover:bg-accent";
  button.textContent = label;
  button.addEventListener("click", event => {
    event.stopPropagation();
    action();
  });
  return button;
}

function openReplyComposer(article: HTMLElement, threadId: string): void {
  const existing = article.querySelector(".comment-reply-form");
  if (existing) return existing.querySelector("textarea").focus();
  const form = document.createElement("form");
  form.className = "comment-reply-form mb-2 space-y-2 border-t pt-2";
  const input = document.createElement("textarea");
  input.className = "min-h-16 w-full resize-y rounded-md border bg-background px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
  input.placeholder = "Write a reply";
  input.required = true;
  const controls = document.createElement("div");
  controls.className = "flex justify-end gap-1.5";
  const cancel = reviewButton("Cancel", () => form.remove());
  cancel.type = "button";
  const submit = reviewButton("Reply", () => {});
  submit.type = "submit";
  submit.classList.add("bg-primary", "text-primary-foreground", "hover:bg-primary/90");
  controls.append(cancel, submit);
  form.append(input, controls);
  form.addEventListener("click", event => event.stopPropagation());
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (state.activeFile !== article.dataset.filePath) { showToast("Open this comment's file before replying."); return; }
    form.remove();
    if (appendCommentReply(threadId, input.value)) showToast("Reply added.");
  });
  article.querySelector(".review-buttons").before(form);
  input.focus();
}

let projectReviewFiles: Array<{ path: string; reviews: ReturnType<typeof parseReviews> }> = [];
let reviewProjectId = "";
let reviewRequestVersion = 0;

function renderReviews() {
  if (reviewProjectId !== state.projectId) {
    reviewProjectId = state.projectId;
    projectReviewFiles = [];
    elements.review_list.replaceChildren();
  }
  drawReviews();
  if (!state.projectId) return;
  const projectId = state.projectId;
  const version = ++reviewRequestVersion;
  request<{ files: typeof projectReviewFiles }>("v1/reviews").then(result => {
    if (state.projectId !== projectId || version !== reviewRequestVersion) return;
    projectReviewFiles = result.files;
    drawReviews();
  }).catch(error => { if (version === reviewRequestVersion) showToast(error.message); });
}

async function selectReviewFile(filePath: string) {
  if (state.activeFile === filePath && state.view) return true;
  await openFile(filePath);
  const view = state.view;
  const provider = state.provider;
  if (!view) return false;
  const deadline = Date.now() + 5000;
  while (provider && !provider.synced && state.view === view && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return state.view === view && (!provider || provider.synced);
}

function drawReviews() {
  const composer = elements.review_list.querySelector<HTMLElement>(".comment-reply-form");
  if (composer && composer.closest<HTMLElement>(".review-item")?.dataset.filePath === state.activeFile) return;
  const files = projectReviewFiles.filter(file => file.path !== state.activeFile);
  if (state.view) files.unshift({ path: state.activeFile, reviews: parseReviews(state.view.state.doc.toString()) });
  const groups: ReviewGroup[] = [];
  for (const file of files) {
    const revisions = new Map<string, ReviewGroup>();
    for (const item of file.reviews) {
    if (item.kind === "comment" || item.kind === "revision") {
      groups.push({ id: item.id, path: file.path, kind: item.kind === "comment" ? "comment" : "revision", items: [item] });
    } else {
      let group = revisions.get(item.id);
      if (!group) {
        group = { id: item.id, path: file.path, kind: "revision", items: [] };
        revisions.set(item.id, group);
        groups.push(group);
      }
      group.items.push(item);
    }
    }
  }
  elements.review_count.textContent = String(groups.length);
  elements.review_list.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty-output flex min-h-52 flex-col items-center justify-center gap-3 text-sm text-muted-foreground [&_svg]:size-8";
    empty.innerHTML = '<i data-lucide="file-check-2"></i><span>No open reviews</span>';
    elements.review_list.append(empty);
    createIcons({ icons: ICONS });
    return;
  }
  for (const group of groups) {
    const item = group.items[0];
    const article = document.createElement("article");
    article.className = `review-item ${group.kind} mb-2 min-w-0 rounded-md border border-l-[3px] border-l-amber-700 bg-card p-3 [overflow-wrap:anywhere] [&.revision]:border-l-primary`;
    article.dataset.reviewId = group.id;
    article.dataset.filePath = group.path;
    const path = document.createElement("div");
    path.className = "mb-2 truncate font-mono text-[11px] text-muted-foreground";
    path.textContent = group.path;
    path.title = group.path;
    const decide = async (decision: ReviewDecision): Promise<void> => {
      if (await selectReviewFile(group.path)) applyReviewDecision(group.id, decision);
    };
    const meta = document.createElement("div");
    meta.className = "review-meta mb-2 flex items-center justify-between gap-2 text-xs [&_strong]:truncate [&_span]:uppercase [&_span]:text-[9px] [&_span]:text-muted-foreground";
    const author = document.createElement("strong");
    author.textContent = item.author || "Guest";
    const type = document.createElement("span");
    type.textContent = group.kind;
    meta.append(author, type);
    const quote = document.createElement("pre");
    quote.className = "review-quote mb-2 overflow-hidden whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground";
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
    const note = document.createElement("div");
    note.className = "review-note mb-2 text-sm leading-relaxed";
    if (group.kind === "comment") {
      note.classList.add("space-y-2");
      for (const message of item.messages) {
        const messageRow = document.createElement("div");
        messageRow.className = `comment-message rounded-md px-2.5 py-2 ${message.root ? "bg-amber-50 dark:bg-amber-950/40" : "bg-muted"}`;
        const messageAuthor = document.createElement("strong");
        messageAuthor.className = "mb-0.5 block text-[11px]";
        messageAuthor.textContent = message.author || "Guest";
        const messageBody = document.createElement("p");
        messageBody.className = "whitespace-pre-wrap text-sm";
        messageBody.textContent = message.body;
        messageRow.append(messageAuthor, messageBody);
        note.append(messageRow);
      }
    } else {
      note.textContent = item.kind === "revision" ? `Before: ${item.note}` : "Tracked change";
    }
    const actions = document.createElement("div");
    actions.className = "review-buttons flex flex-wrap gap-1.5";
    if (group.kind === "comment") {
      const reply = reviewButton("Reply", async () => {
        if (!await selectReviewFile(group.path)) return;
        drawReviews();
        const current = [...elements.review_list.querySelectorAll<HTMLElement>(".review-item")].find(candidate => candidate.dataset.reviewId === group.id && candidate.dataset.filePath === group.path);
        if (current) openReplyComposer(current, group.id);
      });
      reply.dataset.commentReply = "";
      actions.append(reply, reviewButton("Resolve", () => decide("resolve")));
    } else {
      actions.append(
        reviewButton("Accept", () => decide("accept")),
        reviewButton("Reject", () => decide("reject")),
      );
    }
    article.append(path, meta, quote, note, actions);
    article.addEventListener("click", async () => {
      if (!await selectReviewFile(group.path)) return;
      const latest = parseReviews(state.view.state.doc.toString()).find(candidate => candidate.id === group.id);
      if (!latest) return;
      state.view.dispatch({ selection: { anchor: latest.bodyFrom, head: latest.bodyTo }, effects: EditorView.scrollIntoView(latest.bodyFrom, { y: "center" }) });
      state.view.focus();
    });
    elements.review_list.append(article);
  }
}

let reviewRenderTimer: ReturnType<typeof setTimeout> | undefined;
function queueReviewRender(): void {
  clearTimeout(reviewRenderTimer);
  reviewRenderTimer = setTimeout(renderReviews, 120);
}

function cleanMetadata(value: string): string {
  return value.replaceAll("\\", "/").replace(/[{}%#]/g, " ").replace(/\s+/g, " ").trim();
}

function openReviewDialog() {
  if (!state.view) return showToast("Open a text file first.");
  if (!elements.rich_editor.hidden) {
    const visible = visualEditor.selection();
    if (!visible || visible.from === visible.to) return showToast("Select text first.");
    const selection = projectReviews(state.view.state.doc.toString()).range(visible.from, visible.to);
    state.view.dispatch({selection:{anchor:selection.from,head:selection.to}});
  }
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

elements.review_form.addEventListener("submit", (event: Event) => {
  event.preventDefault();
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
  if (elements.rich_editor.hidden) state.view.focus();
  else { visualEditor.sync(true); workspaceLayout.showOutput(); selectOutput("review"); }
  renderReviews();
});
elements.review_close.addEventListener("click", () => elements.review_dialog.close());
elements.review_cancel.addEventListener("click", () => elements.review_dialog.close());

function randomId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function refreshProject(open = false) {
  const data = await request<{ project: ProjectDetail }>("v1/project");
  const known = state.projects.find(project => project.id === data.project.id);
  if (known) Object.assign(known, { name: data.project.name, createdAt: data.project.createdAt });
  else if (state.user) {
    state.projects.push({ id: data.project.id, name: data.project.name, createdAt: data.project.createdAt, permissions: data.project.permissions });
  }
  state.projectCanManage = Boolean(data.project.permissions?.manage);
  elements.share_project.hidden = !data.project.permissions?.collaborate;
  elements.project_name.textContent = data.project.name;
  document.title = `${data.project.name} · LaTeX Coder`;
  state.main = data.project.main;
  state.files = data.project.files;
  state.folders = data.project.folders || [];
  state.settings = data.project.settings;
  renderFiles();
  elements.build_output.textContent = data.project.build.log || "No compilation yet.";
  renderBuildErrors(data.project.build.log, data.project.build.errors, data.project.build.status === "error");
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
    row.className = "project-row grid min-h-16 grid-cols-[2rem_minmax(0,1fr)_auto_auto] items-center gap-3 border-b px-4 py-2 last:border-b-0 [&>svg]:size-5 [&>svg]:text-primary max-sm:grid-cols-[1.5rem_minmax(0,1fr)_auto]";
    row.innerHTML = '<i data-lucide="folder-kanban"></i>';
    const main = document.createElement("div");
    main.className = "project-row-main min-w-0 [&>button]:block [&>button]:max-w-full [&>button]:truncate [&>button]:text-left [&>button]:text-sm [&>button]:font-semibold [&>button:hover]:text-primary [&>span]:mt-1 [&>span]:block [&>span]:text-[10px] [&>span]:text-muted-foreground";
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
    open.className = "secondary-button h-8 rounded-md border bg-background px-3 text-xs font-medium shadow-sm hover:bg-accent max-sm:hidden";
    open.textContent = "Open";
    open.addEventListener("click", () => openProjectPage(project.id));
    const menu = document.createElement("details");
    menu.className = "context-menu relative";
    menu.innerHTML = '<summary class="icon-button grid size-8 cursor-pointer list-none place-items-center rounded-md hover:bg-accent" title="Project actions"><i data-lucide="more-horizontal"></i></summary><div class="context-menu-panel absolute right-0 top-9 z-20 w-40 rounded-md border bg-card p-1 shadow-xl"></div>';
    const panel = menu.querySelector("div");
    const actions: Array<[string, string, () => void | Promise<void>, boolean?]> = [
      ...(project.permissions?.manage ? [
        ["pencil", "Rename", () => renameProject(project)],
        ["trash-2", "Delete project", () => deleteProject(project), true],
      ] as Array<[string, string, () => void | Promise<void>, boolean?]> : []),
      ["archive", "Download ZIP", () => downloadProject(project.id)],
    ];
    for (const [icon, label, action, danger] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-accent [&_svg]:size-3.5${danger ? " danger text-destructive" : ""}`;
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
  const data = await request<{ projects: ProjectSummary[]; defaultProjectId?: string }>("v1/projects");
  state.projects = data.projects;
  if (preferredId && state.projects.some(project => project.id === preferredId)) state.projectId = preferredId;
  renderProjects();
  return data;
}

function projectPageUrl(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

function routeProjectId() {
  const match = window.location.pathname.match(/^\/projects\/([^/]+)$/);
  if (match) return decodeURIComponent(match[1]);
  return new URLSearchParams(window.location.search).get("project") || "";
}

function routeInvitationToken() {
  const match = window.location.pathname.match(/^\/register\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : "";
}

let projectEventSource: EventSource | null = null;
function stopProjectEvents(): void {
  projectEventSource?.close();
  projectEventSource = null;
}

function watchProjectFiles(): void {
  stopProjectEvents();
  const projectId = state.projectId;
  const source = new EventSource(projectApiUrl("v1/project/events").toString());
  projectEventSource = source;
  let refreshing = false;
  let pending = false;
  source.addEventListener("files", async () => {
    pending = true;
    if (refreshing) return;
    refreshing = true;
    try {
      while (pending && projectEventSource === source) {
        pending = false;
        const data = await request<{ project: ProjectDetail }>("v1/project");
        if (state.projectId !== projectId || projectEventSource !== source) return;
        const changed = JSON.stringify(state.files) !== JSON.stringify(data.project.files)
          || JSON.stringify(state.folders) !== JSON.stringify(data.project.folders || []);
        state.files = data.project.files;
        state.folders = data.project.folders || [];
        state.main = data.project.main;
        if (changed) renderFiles();
        if (state.activeFile && !state.files.some(file => file.path === state.activeFile)) {
          disconnectEditor();
          resetFilePreview();
          state.activeFile = "";
          const target = state.files.find(file => file.path === state.main) || state.files[0];
          if (target) await openFile(target.path);
        }
      }
    } catch (error) { console.error("Project file refresh failed", error); }
    finally { refreshing = false; }
  });
}

function showAuthPage(mode = "login", description = "") {
  stopProjectEvents();
  disconnectEditor();
  elements.projects_page.hidden = true;
  elements.editor_page.hidden = true;
  elements.auth_page.hidden = false;
  elements.auth_error.hidden = true;
  elements.auth_error.textContent = "";
  elements.auth_submit.disabled = false;
  elements.auth_password.value = "";
  const registering = mode === "register";
  elements.auth_title.textContent = registering ? "Join the team" : "Sign in";
  elements.auth_description.textContent = description || (registering
    ? "Choose an account for this invitation."
    : state.bootstrapReady
      ? "Core team members can sign in to manage projects."
      : "Set LATEXCODER_ADMIN_PASSWORD and restart the service to create the initial admin account.");
  elements.auth_submit.querySelector("span").textContent = registering ? "Create account" : "Sign in";
  elements.auth_password.autocomplete = registering ? "new-password" : "current-password";
  document.title = `${registering ? "Join" : "Sign in"} · LaTeX Coder`;
  elements.auth_username.focus();
}

function showProjectsPage(push = true) {
  stopProjectEvents();
  if (!state.user) {
    if (push) window.history.pushState({}, "", "/login");
    showAuthPage();
    return;
  }
  disconnectEditor();
  resetFilePreview();
  if (elements.git_dialog.open) elements.git_dialog.close();
  if (elements.access_dialog.open) elements.access_dialog.close();
  elements.editor_page.hidden = true;
  elements.projects_page.hidden = false;
  elements.auth_page.hidden = true;
  if (push && window.location.pathname !== "/projects") window.history.pushState({}, "", "/projects");
  document.title = "Projects · LaTeX Coder";
}

async function openProjectPage(projectId: string, push = true): Promise<void> {
  const project = state.projects.find(candidate => candidate.id === projectId)
    || { id: projectId, name: projectId };
  if (!project) {
    showProjectsPage(false);
    throw new Error("Project does not exist");
  }
  const changed = projectId !== state.projectId;
  if (changed) {
    disconnectEditor();
    resetFilePreview();
  }
  elements.projects_page.hidden = true;
  elements.auth_page.hidden = true;
  elements.editor_page.hidden = false;
  state.projectId = projectId;
  elements.project_name.textContent = project.name;
  elements.download_project.href = projectApiUrl("v1/project/archive").toString();
  elements.download_project.download = `${project.id}.zip`;
  state.projectCanManage = false;
  elements.share_project.hidden = true;
  elements.back_projects.hidden = !state.user;
  elements.editor_login.hidden = Boolean(state.user);
  syncAccountUi();
  if (push && window.location.pathname !== projectPageUrl(projectId)) window.history.pushState({}, "", projectPageUrl(projectId));
  document.title = `${project.name} · LaTeX Coder`;
  if (!changed && state.view) return;
  state.activeFile = "";
  state.pdfRequestVersion += 1;
  state.pdfRenderVersion += 1;
  if (state.pdfLoadingTask) await state.pdfLoadingTask.destroy().catch(() => {});
  state.pdfLoadingTask = null;
  state.pdfDocument = null;
  elements.pdf_download.removeAttribute('href');
  state.pdfHighlights = null;
  elements.pdf_document.replaceChildren();
  elements.pdf_document.hidden = true;
  elements.empty_output.hidden = false;
  elements.pdf_status.textContent = "No compiled PDF";
  elements.build_output.textContent = "";
  await refreshProject(true);
  watchProjectFiles();
}

const pdfContextMenu = document.getElementById("pdf-context-menu")!;
let pdfContextAction: (() => Promise<void>) | null = null;
function closePdfContextMenu() { pdfContextMenu.hidden = true; pdfContextAction = null; }
document.getElementById("pdf-go-to-source")!.addEventListener("click", () => {
  const action = pdfContextAction;
  closePdfContextMenu();
  void action?.();
});
document.addEventListener("pointerdown", event => { if (!pdfContextMenu.contains(event.target as Node)) closePdfContextMenu(); }, true);
document.addEventListener("keydown", event => { if (event.key === "Escape") closePdfContextMenu(); });
elements.pdf_view.addEventListener("scroll", closePdfContextMenu);
window.addEventListener("resize", closePdfContextMenu);

async function renderPdf(priorityPage?: number) {
  closePdfContextMenu();
  const pdf = state.pdfDocument;
  if (!pdf) return;
  const version = ++state.pdfRenderVersion;
  const dark = isDarkPdf();
  const firstPage = await pdf.getPage(1);
  const base = firstPage.getViewport({ scale: 1 });
  const fit = Math.max(0.05, (elements.pdf_view.clientWidth - 32) / base.width);
  const scale = fit * state.pdfZoom;
  const fragment = document.createDocumentFragment();
  const renders: Array<() => Promise<void>> = [];

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
    canvas.dataset.page = String(pageNumber);
    canvas.dataset.pdfScale = String(scale);
    canvas.title = `${macReferences ? "Command" : "Ctrl"}+click to open source`;
    const revision = state.pdfSourceRevision;
    const projectId = state.projectId;
    const navigateSource = async (x: number, y: number) => {
      if (state.projectId !== projectId || !canvas.isConnected) return;
      try {
        const destination = await request<SourcePosition>("v1/build/source", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page: pageNumber, x, y, revision }),
        });
        if (state.projectId === projectId) await revealSource(destination);
      } catch (error) { showToast(error.message); }
    };
    const sourcePoint = (event: MouseEvent) => {
      const bounds = canvas.getBoundingClientRect();
      return { x: (event.clientX - bounds.left) * viewport.width / bounds.width / scale, y: (event.clientY - bounds.top) * viewport.height / bounds.height / scale };
    };
    canvas.addEventListener("click", event => {
      if (!referenceModifierPressed(event) || event.button !== 0) return;
      event.preventDefault();
      closePdfContextMenu();
      const { x, y } = sourcePoint(event);
      void navigateSource(x, y);
    });
    canvas.addEventListener("contextmenu", event => {
      event.preventDefault();
      closeEditorContextMenu();
      const { x, y } = sourcePoint(event);
      pdfContextAction = () => navigateSource(x, y);
      pdfContextMenu.hidden = false;
      pdfContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - pdfContextMenu.offsetWidth - 8))}px`;
      pdfContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - pdfContextMenu.offsetHeight - 8))}px`;
      document.getElementById("pdf-go-to-source")!.focus({ preventScroll: true });
    });
    fragment.append(canvas);
    renders.push(async () => {
      if (version !== state.pdfRenderVersion) return;
      await page.render({
        canvas,
        canvasContext: canvas.getContext("2d"),
        viewport,
        transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      }).promise;
      if (dark) darkenPdfCanvas(canvas);
    });
  }
  if (version !== state.pdfRenderVersion) return;
  elements.pdf_document.replaceChildren(fragment);
  elements.pdf_document.hidden = false;
  elements.empty_output.hidden = true;
  if (priorityPage && renders[priorityPage - 1]) {
    await renders[priorityPage - 1]();
    // Reserve every page's layout, but do not make navigation wait for other pages.
    void (async () => {
      for (let index = 0; index < renders.length; index++) {
        if (version !== state.pdfRenderVersion) return;
        if (index !== priorityPage - 1) await renders[index]();
      }
    })().catch(error => { if (version === state.pdfRenderVersion) console.error("PDF background render failed", error); });
  } else {
    for (const render of renders) await render();
  }
  if (version !== state.pdfRenderVersion) return;
  elements.pdf_status.textContent = "PDF ready";
  renderPdfHighlights();
  refreshPdfStatus();
}

async function showPdf(force = false, priorityPage?: number) {
  const requestVersion = ++state.pdfRequestVersion;
  const downloadUrl = projectApiUrl("v1/build/pdf");
  downloadUrl.searchParams.set("v", String(Date.now()));
  downloadUrl.searchParams.set("cached", "1");
  elements.pdf_download.href = downloadUrl.toString();
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
      if (requestVersion !== state.pdfRequestVersion) return;
      if (!response.ok) throw new Error(`PDF request failed (${response.status})`);
      state.pdfSourceRevision = response.headers.get("X-LaTeX-Coder-Source-Revision");
      const loadingTask = getDocument({ data: await response.arrayBuffer() });
      state.pdfLoadingTask = loadingTask;
      const pdf = await loadingTask.promise;
      if (requestVersion !== state.pdfRequestVersion) {
        await loadingTask.destroy();
        return;
      }
      state.pdfDocument = pdf;
    }
    await renderPdf(priorityPage);
  } catch (error) {
    if (requestVersion !== state.pdfRequestVersion) return;
    console.error("paper PDF preview failed", error);
    elements.pdf_document.hidden = true;
    elements.pdf_status.textContent = "Preview failed. Download the PDF instead.";
  }
}

async function compile() {
  if (compileRunning) { compileQueued = true; return; }
  compileRunning = true;
  const project = state.projectId;
  elements.compile_button.disabled = true;
  elements.compile_button.querySelector("span").textContent = "Compiling";
  elements.compile_button.setAttribute("aria-busy", "true");
  elements.sync_state.textContent = "Compiling";
  try {
    const result = await request<{ build: BuildInfo }>("v1/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ main: state.main }),
    });
    if (state.projectId !== project) return;
    elements.build_output.textContent = result.build.log;
    workspaceLayout.showOutput();
    renderBuildErrors(result.build.log, result.build.errors);
    await showPdf(true);
    selectOutput("pdf");
    elements.output_pane.classList.add("mobile-open");
    showToast("PDF compiled.");
  } catch (error) {
    const build = await request<{ build: BuildInfo }>("v1/build").catch((): null => null);
    if (state.projectId !== project) return;
    elements.build_output.textContent = build?.build?.log || error.message;
    renderBuildErrors(build?.build?.log || error.message, build?.build?.errors, true);
    selectOutput("log");
    elements.output_pane.classList.add("mobile-open");
    showToast("Compilation failed. See Log for details.");
  } finally {
    elements.compile_button.disabled = false;
    elements.compile_button.querySelector("span").textContent = "Compile";
    elements.compile_button.removeAttribute("aria-busy");
    compileRunning = false;
    updateSyncStatus();
    refreshPdfStatus();
    if (compileQueued) { compileQueued = false; scheduleAutoCompile(); }
  }
}

function markPdfStale() {
  const freshness = document.getElementById("pdf-freshness")!;
  if (!state.pdfDocument) return;
  freshness.hidden = false;
  freshness.textContent = "PDF outdated - showing last successful compilation";
  freshness.classList.add("text-amber-700");
}

async function refreshPdfStatus() {
  const project = state.projectId;
  if (!project || !state.pdfDocument) return;
  try {
    const { build } = await request<{ build: BuildInfo }>("v1/build");
    if (project !== state.projectId) return;
    const freshness = document.getElementById("pdf-freshness")!;
    freshness.hidden = false;
    const stale = build.stale || state.pdfSourceRevision !== build.sourceRevision;
    freshness.textContent = stale ? "PDF outdated - showing last successful compilation" : "PDF current";
    freshness.classList.toggle("text-amber-700", stale);
  } catch { markPdfStale(); }
}

function renderBuildErrors(log: string, mappedErrors?: ReturnType<typeof compileErrors>, failed = false) {
  const list = document.getElementById("build-errors")!;
  list.replaceChildren();
  const errors = buildDiagnostics(log, mappedErrors);
  if (failed && !errors.some(error => error.severity === "error")) errors.unshift({ severity: "error", message: log.trim() || "Compilation failed." });
  const count = document.getElementById("log-error-count")!;
  const fatalCount = errors.filter(error => error.severity === "error").length;
  count.textContent = String(fatalCount);
  count.hidden = !fatalCount;
  list.hidden = !errors.length;
  const heading = document.createElement("h3");
  heading.className = "mb-2 text-sm font-semibold";
  const warningCount = errors.length - fatalCount;
  heading.textContent = `${fatalCount} ${fatalCount === 1 ? "error" : "errors"} · ${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`;
  list.append(heading);
  const items = document.createElement("ol");
  items.className = "list-decimal space-y-2 pl-5";
  list.append(items);
  for (const [index, error] of errors.entries()) {
    const file = error.path ? state.files.find(file => file.path === error.path || error.path!.endsWith(`/${file.path}`)) : undefined;
    const item = document.createElement("li");
    item.className = "text-xs";
    const button = document.createElement("button");
    button.className = "block w-full rounded border p-2 text-left whitespace-pre-wrap break-words hover:bg-accent " + (error.severity === "error" ? "border-red-200 text-red-800 dark:border-red-900 dark:text-red-300" : "border-amber-200 text-amber-800 dark:border-amber-900 dark:text-amber-300");
    if (index === 0 && error.severity === "error") {
      button.id = "first-fatal-error";
      const badge = document.createElement("strong");
      badge.className = "mb-1 block text-xs";
      badge.textContent = "First fatal error";
      button.append(badge);
    }
    const message = document.createElement("span");
    message.textContent = `${error.path ? `${file?.path || error.path}:${error.line} · ` : ""}${error.message}`;
    button.append(message);
    if (file && error.line) {
      button.title = "Go to source";
      const action = document.createElement("span");
      action.className = "mt-1 block text-[11px] underline";
      action.textContent = "Go to source";
      button.append(action);
      button.addEventListener("click", () => { void revealSource({ path: file.path, line: error.line! }).catch(error => showToast(error.message)); });
    } else button.disabled = true;
    item.append(button);
    items.append(item);
  }
}

function setReviewOpen(open: boolean): void {
  elements.review_pane.hidden = !open;
  document.getElementById("editor-body")!.style.gridTemplateColumns = open ? "minmax(0,1fr) minmax(0,42%)" : "minmax(0,1fr)";
  const button = document.getElementById("toggle-review")!;
  button.setAttribute("aria-expanded", String(open));
  button.classList.toggle("bg-accent", open);
  if (open) renderReviews();
}

function selectOutput(name: "pdf" | "review" | "log"): void {
  if (name === "review") { setReviewOpen(true); return; }
  document.querySelectorAll<HTMLElement>("[data-output]:not([data-output=review])").forEach(button => button.classList.toggle("active", button.dataset.output === name));
  elements.pdf_view.hidden = name !== "pdf";
  elements.build_log.hidden = name !== "log";
  if (name === "log") elements.build_log.scrollTop = 0;
}

setInterval(() => {
  if (state.projectId && !elements.review_pane.hidden && !document.hidden) renderReviews();
}, 3000);

function renderGitStatus(gitState: GitState): void {
  state.git = gitState;
  elements.git_dirty.hidden = !gitState.dirty;
  elements.git_summary.textContent = `${gitState.branch} · ${gitState.dirty ? "uncommitted changes" : "clean"}`;
  elements.git_change_count.textContent = String(gitState.files.length);
  elements.git_file_list.replaceChildren();
  if (!gitState.files.length) {
    const empty = document.createElement("div");
    empty.className = "git-empty py-4 text-center text-xs text-muted-foreground";
    empty.textContent = "Working tree clean";
    elements.git_file_list.append(empty);
  } else {
    for (const file of gitState.files) {
      const row = document.createElement("div");
      row.className = "git-file-row grid min-h-7 grid-cols-[2rem_minmax(0,1fr)] items-center gap-2 border-b text-xs [&_code]:text-amber-700 [&_span]:truncate";
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
    row.className = "git-history-row grid min-h-7 grid-cols-[4rem_minmax(0,1fr)_6rem] items-center gap-2 border-b text-xs [&_code]:text-primary [&_span]:truncate [&_time]:text-right [&_time]:text-[9px] [&_time]:text-muted-foreground";
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
    const result = await request<{ git: GitState }>("v1/git");
    renderGitStatus(result.git);
    return result.git;
  } catch (error) {
    if (showErrors) showToast(error.message);
    return null;
  }
}

async function runGitAction(endpoint: string, body: Record<string, unknown>, successMessage: string) {
  const buttons = [elements.git_commit, elements.git_resolve, elements.git_refresh];
  buttons.forEach(button => { button.disabled = true; });
  elements.sync_state.textContent = "Git operation";
  try {
    const result = await request<{ git: GitState }>(endpoint, {
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
    updateSyncStatus();
  }
}

function downloadProject(projectId: string): void {
  const link = document.createElement("a");
  link.href = `${window.location.origin}/v1/project/archive?project=${encodeURIComponent(projectId)}`;
  link.download = `${projectId}.zip`;
  link.click();
}

async function renameProject(project: ProjectSummary): Promise<void> {
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
      elements.project_name.textContent = String(name);
      document.title = `${name} · LaTeX Coder`;
    }
    showToast("Project renamed.");
  } catch (error) { showToast(error.message); }
}

async function deleteProject(project: ProjectSummary): Promise<void> {
  const confirmed = await openActionDialog({
    title: "Delete project",
    message: `Delete “${project.name}” and all of its files? You can restore them from Deleted files in Project settings.`,
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

async function copyText(value: string, message: string): Promise<void> {
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

function displayAccessShare(share: ShareDetails): void {
  state.accessShareId = share.id;
  const shareUrl = `${window.location.origin}${share.path}`;
  const agentUrl = `${window.location.origin}${share.agentPath}`;
  const cloneUrl = `${window.location.origin}${share.clonePath}`;
  elements.share_link.value = shareUrl;
  elements.agent_command.value = `curl -fsSL '${agentUrl}'`;
  elements.clone_command.value = `git clone ${cloneUrl}`;
  elements.share_link.select();
}

async function refreshProjectMembers() {
  const result = await request<{ members: ProjectMember[] }>("v1/project/members");
  elements.collaborator_list.replaceChildren(...result.members.map((member: ProjectMember) => {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-3 rounded bg-muted px-2 py-1.5";
    const name = document.createElement("span");
    name.textContent = member.username;
    const role = document.createElement("span");
    role.className = "text-muted-foreground";
    role.textContent = member.role;
    row.append(name, role);
    return row;
  }));
}

async function openAccessDialog() {
  const project = state.projects.find(candidate => candidate.id === state.projectId);
  if (!project) return;
  const result = await request<{ share: ShareDetails }>("v1/project/share", { method: "POST" });
  displayAccessShare(result.share);
  await refreshProjectMembers();
  elements.access_project_name.textContent = project.name;
  elements.access_download.href = projectApiUrl("v1/project/archive").toString();
  elements.access_download.download = `${project.id}.zip`;
  elements.access_dialog.showModal();
}

async function rotateShareSecret() {
  elements.access_dialog.close();
  const confirmed = await openActionDialog({
    title: "Rotate access secret?",
    message: "Links containing your previous secret will stop working immediately, and their guest sessions will be signed out. Other registered collaborators and their links keep working.",
    submitLabel: "Rotate my secret",
    danger: true,
  });
  if (!confirmed) {
    elements.access_dialog.showModal();
    return;
  }
  const result = await request<{ share: ShareDetails }>("v1/project/share/rotate", { method: "POST" });
  displayAccessShare(result.share);
  elements.access_dialog.showModal();
  showToast("Your secret was rotated. Previous links no longer work.");
}

async function enterProjectDashboard(replace = false) {
  await refreshProjects();
  syncAccountUi();
  if (replace) window.history.replaceState({}, "", "/projects");
  showProjectsPage(false);
}

async function createInvitation() {
  try {
    const result = await request<{ invitation: { path: string } }>("v1/invitations", { method: "POST" });
    elements.invite_link.value = `${window.location.origin}${result.invitation.path}`;
    if (!elements.invite_dialog.open) elements.invite_dialog.showModal();
    elements.invite_link.select();
  } catch (error) { showToast(error.message); }
}

elements.display_name.value = localStorage.getItem("paper-display-name") || `Guest ${Math.floor(Math.random() * 900 + 100)}`;
elements.display_name.addEventListener("change", () => {
  elements.display_name.value = cleanMetadata(displayName()).slice(0, 28) || "Guest";
  localStorage.setItem("paper-display-name", elements.display_name.value);
  setAwareness();
});
elements.account_button.addEventListener("click", openAccountPanel);
elements.editor_account_button.addEventListener("click", openAccountPanel);
elements.account_close.addEventListener("click", () => elements.account_dialog.close());
elements.account_cancel.addEventListener("click", () => elements.account_dialog.close());
elements.account_dialog.addEventListener("cancel", (event: Event) => {
  event.preventDefault();
  elements.account_dialog.close();
});
elements.account_form.addEventListener("submit", async (event: Event) => {
  event.preventDefault();
  elements.account_save.disabled = true;
  try {
    const result = await request<{ user: CurrentUser }>("v1/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: elements.account_display_name.value }),
    });
    state.user = result.user;
    syncAccountUi();
    setAwareness();
    elements.account_dialog.close();
    showToast("Display name updated.");
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.account_save.disabled = false;
  }
});
elements.auth_form.addEventListener("submit", async (event: Event) => {
  event.preventDefault();
  elements.auth_submit.disabled = true;
  elements.auth_error.hidden = true;
  try {
    const token = routeInvitationToken();
    const result = await request<{ user: CurrentUser }>(token ? "v1/auth/register" : "v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: token || undefined,
        username: elements.auth_username.value,
        password: elements.auth_password.value,
      }),
    });
    state.user = result.user;
    syncAccountUi();
    await enterProjectDashboard(true);
  } catch (error) {
    elements.auth_error.textContent = error.message;
    elements.auth_error.hidden = false;
  } finally {
    elements.auth_submit.disabled = false;
  }
});
elements.back_projects.addEventListener("click", () => showProjectsPage());
elements.editor_login.addEventListener("click", () => {
  window.history.pushState({}, "", "/login");
  showAuthPage();
});
elements.share_project.addEventListener("click", () => openAccessDialog().catch(error => showToast(error.message)));
elements.download_project.addEventListener("click", (event: Event) => {
  event.preventDefault();
  downloadProject(state.projectId);
});
elements.access_close.addEventListener("click", () => elements.access_dialog.close());
elements.access_done.addEventListener("click", () => elements.access_dialog.close());
elements.access_dialog.addEventListener("cancel", (event: Event) => {
  event.preventDefault();
  elements.access_dialog.close();
});
elements.copy_share_link.addEventListener("click", () => copyText(elements.share_link.value, "Editable link copied."));
elements.copy_agent_link.addEventListener("click", () => copyText(elements.agent_command.value, "Agent editing command copied."));
elements.copy_clone_command.addEventListener("click", () => copyText(elements.clone_command.value, "Clone command copied."));
elements.rotate_share_secret.addEventListener("click", () => rotateShareSecret().catch(error => {
  showToast(error.message);
  if (!elements.access_dialog.open) elements.access_dialog.showModal();
}));
elements.invite_user.addEventListener("click", createInvitation);
elements.invite_regenerate.addEventListener("click", createInvitation);
elements.invite_close.addEventListener("click", () => elements.invite_dialog.close());
elements.invite_done.addEventListener("click", () => elements.invite_dialog.close());
elements.invite_dialog.addEventListener("cancel", (event: Event) => {
  event.preventDefault();
  elements.invite_dialog.close();
});
elements.copy_invite_link.addEventListener("click", () => copyText(elements.invite_link.value, "Invitation link copied."));
async function logout() {
  await request("v1/auth/logout", { method: "POST" }).catch((): null => null);
  state.user = null;
  state.projects = [];
  syncAccountUi();
  if (elements.account_dialog.open) elements.account_dialog.close();
  window.history.replaceState({}, "", "/login");
  showAuthPage();
}
elements.logout_button.addEventListener("click", logout);
elements.account_logout.addEventListener("click", logout);
elements.git_button.addEventListener("click", async () => {
  elements.git_dialog.showModal();
  await refreshGit();
});
elements.git_close.addEventListener("click", () => elements.git_dialog.close());
elements.git_dialog.addEventListener("cancel", (event: Event) => {
  event.preventDefault();
  elements.git_dialog.close();
});
elements.git_refresh.addEventListener("click", () => refreshGit());
elements.git_commit.addEventListener("click", async () => {
  const result = await runGitAction("v1/git/commit", { message: elements.git_message.value }, "Checkpoint committed.");
  if (result) elements.git_message.value = "";
});
elements.git_resolve.addEventListener("click", async () => {
  const result = await runGitAction("v1/git/resolve", { message: elements.git_message.value }, "Conflict marked resolved.");
  if (result) elements.git_message.value = "";
});
elements.new_project.addEventListener("click", async () => {
  const name = await openActionDialog({
    title: "New project",
    zip: true,
    label: "Project name",
    value: "Untitled paper",
    maxLength: 80,
    submitLabel: "Create project",
  });
  if (!name) return;
  try {
    const archive = (document.querySelector("#project-zip-input") as HTMLInputElement)?.files?.[0];
    const result = await request<{ project: ProjectSummary }>(archive ? `v1/projects?name=${encodeURIComponent(String(name))}` : "v1/projects", {
      method: "POST",
      headers: { "Content-Type": archive ? "application/zip" : "application/json" },
      body: archive || JSON.stringify({ name }),
    });
    await refreshProjects(result.project.id);
    await openProjectPage(result.project.id);
    showToast("Project created.");
  } catch (error) { showToast(error.message); }
});
elements.compile_button.addEventListener("click", compile);
elements.add_comment.addEventListener("mousedown", event => event.preventDefault());
elements.add_comment.addEventListener("click", openReviewDialog);
elements.selection_accept.addEventListener("mousedown", (event: Event) => event.preventDefault());
elements.selection_accept.addEventListener("click", () => {
  applyReviewDecisions(state.selectionSuggestionIds, "accept");
  state.view?.focus();
});
elements.suggest_edit.addEventListener("click", () => {
  state.suggesting = !state.suggesting;
  elements.suggest_edit.classList.toggle("active", state.suggesting);
  elements.suggest_edit.setAttribute("aria-pressed", String(state.suggesting));
  elements.suggest_edit.querySelector("span").textContent = state.suggesting ? "Suggest" : "Edit";
  showToast(state.suggesting ? "Suggestion mode on." : "Suggestion mode off.");
  if (elements.rich_editor.hidden) state.view?.focus();
});
elements.close_output.addEventListener("click", () => elements.output_pane.classList.remove("mobile-open"));
installPdfWheel(elements.pdf_view, () => state.pdfZoom, value => { state.pdfZoom = value; }, renderPdf);
elements.pdf_zoom_out.addEventListener("click", () => {
  state.pdfZoom = Math.max(0.5, state.pdfZoom - 0.15);
  renderPdf();
});
elements.pdf_zoom_in.addEventListener("click", () => {
  state.pdfZoom = Math.min(3, state.pdfZoom + 0.15);
  renderPdf();
});
const pdfDownloadDialog = document.getElementById('pdf-download-dialog') as HTMLDialogElement;
elements.pdf_download.addEventListener('click', event => {
  event.preventDefault();
  if (!state.pdfDocument && !elements.pdf_download.getAttribute('href')) return showToast('Compile your document before downloading.');
  if (isDarkTheme()) {
    document.getElementById('pdf-download-status')!.textContent = '';
    pdfDownloadDialog.showModal();
  } else void savePdf(false);
});
async function savePdf(dark: boolean) {
  const pdf = state.pdfDocument;
  const status = document.getElementById('pdf-download-status')!;
  const buttons = [...pdfDownloadDialog.querySelectorAll<HTMLButtonElement>('.download-options button')];
  buttons.forEach(button => button.disabled = true);
  status.textContent = dark ? 'Preparing dark paper…' : 'Preparing your original PDF…';
  try {
    const name = (elements.project_name.textContent || 'paper').replace(/[^\p{L}\p{N}._-]+/gu, '-');
    if (pdf) await downloadPdf(pdf, dark, name);
    else {
      const response = await fetch(elements.pdf_download.href);
      if (!response.ok) throw new Error(`PDF request failed (${response.status}). Try compiling again.`);
      await downloadPdfBytes(new Uint8Array(await response.arrayBuffer()), dark, name);
    }
    pdfDownloadDialog.close();
  } catch (error) {
    status.textContent = `Could not download the PDF: ${error.message}`;
    if (!pdfDownloadDialog.open) showToast(status.textContent);
  } finally { buttons.forEach(button => button.disabled = false); }
}
document.getElementById('download-white')!.onclick = () => void savePdf(false);
document.getElementById('download-dark')!.onclick = () => void savePdf(true);
document.getElementById('pdf-download-close')!.onclick = () => pdfDownloadDialog.close();
elements.file_preview_zoom_out.addEventListener("click", () => {
  state.filePreviewZoom = Math.max(0.5, state.filePreviewZoom - 0.2);
  if (!elements.image_preview.hidden) sizeImagePreview();
  else renderFilePdf();
});
elements.file_preview_zoom_in.addEventListener("click", () => {
  state.filePreviewZoom = Math.min(3, state.filePreviewZoom + 0.2);
  if (!elements.image_preview.hidden) sizeImagePreview();
  else renderFilePdf();
});
elements.upload_file.addEventListener("click", () => elements.upload_input.click());
elements.upload_input.addEventListener("change", async () => {
  try {
    for (const file of elements.upload_input.files) {
      const archive = file.name.toLowerCase().endsWith(".zip");
      await request(archive ? "v1/files/import" : `v1/files?path=${encodeURIComponent(file.name)}`, {
        method: archive ? "POST" : "PUT",
        headers: { "Content-Type": archive ? "application/zip" : "application/octet-stream" },
        body: file,
      });
    }
    await refreshProject();
    showToast("Upload complete.");
  } catch (error) { showToast(error.message); }
  elements.upload_input.value = "";
});
elements.new_file.addEventListener("click", () => createEntry(fileTree.folder, false));
elements.new_folder.addEventListener("click", () => createEntry(fileTree.folder, true));
async function deleteFile(target: string) {
  const confirmed = await openActionDialog({
    title: "Delete file",
    message: `Move “${target}” to Recently deleted? It can be restored.`,
    submitLabel: "Delete file",
    danger: true,
  });
  if (!confirmed) return;
  try {
    const wasActive = state.activeFile === target || state.activeFile.startsWith(`${target}/`);
    if (wasActive) disconnectEditor();
    await request(`v1/files?path=${encodeURIComponent(target)}`, { method: "DELETE" });
    if (wasActive) state.activeFile = "";
    await refreshProject(wasActive);
    showToast("File deleted.");
  } catch (error) {
    showToast(error.message);
    await refreshProject(state.activeFile === target || state.activeFile.startsWith(`${target}/`));
  }
}
const settingsDialog = document.getElementById("project-settings-dialog") as HTMLDialogElement;
document.getElementById("project-settings")!.addEventListener("click", async () => {
  try {
    const { settings } = await request<{ settings: EditorSettings }>("v1/settings");
    const main = document.getElementById("settings-main") as HTMLSelectElement;
    main.replaceChildren();
    for (const file of state.files.filter(file => file.path.endsWith(".tex"))) main.add(new Option(file.path, file.path));
    main.value = settings.main;
    (document.getElementById("settings-compiler") as HTMLSelectElement).value = settings.compiler;
    (document.getElementById("settings-auto") as HTMLInputElement).checked = settings.autoCompile;
    settingsDialog.showModal();
  } catch (error) { showToast(error.message); }
});
document.getElementById("project-settings-close")!.addEventListener("click", () => settingsDialog.close());
document.getElementById("settings-form")!.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const { settings } = await request<{ settings: EditorSettings }>("v1/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ main: (document.getElementById("settings-main") as HTMLSelectElement).value, compiler: (document.getElementById("settings-compiler") as HTMLSelectElement).value, autoCompile: (document.getElementById("settings-auto") as HTMLInputElement).checked }) });
    state.settings = settings; state.main = settings.main;
    settingsDialog.close(); markPdfStale(); scheduleAutoCompile();
    renderFiles();
  } catch (error) { showToast(error.message); }
});

const trashDialog = document.getElementById("trash-dialog") as HTMLDialogElement;
document.getElementById("trash-close")!.addEventListener("click", () => trashDialog.close());
async function renderTrash() {
  const { items } = await request<{ items: Array<{ id: string; path: string }> }>("v1/trash");
  const list = document.getElementById("trash-list")!;
  list.replaceChildren();
  if (!items.length) list.textContent = "No deleted files";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "flex min-w-0 items-center justify-between gap-2 border-b py-2 text-xs";
    const label = document.createElement("span"); label.className = "min-w-0 truncate"; label.textContent = item.path;
    const restore = document.createElement("button"); restore.className = "shrink-0 rounded-md border px-2 py-1 hover:bg-accent"; restore.textContent = "Restore";
    restore.addEventListener("click", async () => {
      restore.disabled = true;
      try { await request("v1/trash/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id }) }); await refreshProject(); await renderTrash(); }
      catch (error) { showToast(error.message); restore.disabled = false; }
    });
    row.append(label, restore); list.append(row);
  }
}
document.getElementById("open-trash")!.addEventListener("click", () => { settingsDialog.close(); trashDialog.showModal(); void renderTrash().catch(error => showToast(error.message)); });

const editorContextMenu = document.getElementById("editor-context-menu")!;
let contextView: EditorView | null = null;

function closeEditorContextMenu() {
  editorContextMenu.hidden = true;
  if (contextView) delete contextView.dom.dataset.contextMenu;
  contextView = null;
}

function openEditorContextMenu(event: MouseEvent, view: EditorView) {
  contextView = view;
  view.dom.dataset.contextMenu = "open";
  const selection = view.state.selection.main;
  const overlapsReview = parseReviews(view.state.doc.toString()).some(item => selection.from < item.to && selection.to > item.from);
  editorContextMenu.querySelectorAll<HTMLButtonElement>("[data-editor-action]").forEach(button => {
    const action = button.dataset.editorAction;
    const manager = editorUndoManagers.get(view);
    button.disabled = action === "undo" ? !manager?.undoStack.length
      : action === "redo" ? !manager?.redoStack.length
      : action === "comment" ? selection.empty || overlapsReview
      : action === "copy" || action === "cut" || action === "delete" ? selection.empty
      : action === "select-all" ? !view.state.doc.length
      : action === "pdf" ? !state.activeFile.endsWith(".tex") || !state.projectId
      : action === "paste" ? !navigator.clipboard?.readText
      : false;
  });
  editorContextMenu.hidden = false;
  elements.selection_actions.hidden = true;
  const bounds = editorContextMenu.getBoundingClientRect();
  const clicked = view.posAtCoords({ x: event.clientX, y: event.clientY });
  const caret = view.coordsAtPos(clicked ?? selection.head);
  const x = event.clientX || caret?.left || 8;
  const y = Math.max(event.clientY, (caret?.bottom || 4) + 4);
  editorContextMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
  const top = y + bounds.height <= window.innerHeight - 8 ? y : (caret?.top || event.clientY) - bounds.height - 4;
  editorContextMenu.style.top = `${Math.max(8, top)}px`;
  editorContextMenu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

async function goToPdf(view: EditorView) {
  const project = state.projectId;
  const file = state.activeFile;
  const source = view.state.doc.toString();
  const { from, to } = view.state.selection.main;
  const line = view.state.doc.lineAt(from).number;
  selectOutput("pdf");
  elements.pdf_status.textContent = "Locating source; updating PDF if needed...";
  let position;
  try {
    position = await request<PdfPosition>("v1/build/position", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: file, source, line, from, to }),
    });
  } finally {
    if (state.projectId === project && elements.pdf_status.textContent === "Locating source; updating PDF if needed...") {
      elements.pdf_status.textContent = state.pdfDocument ? "PDF ready" : "No compiled PDF";
    }
  }
  if (state.projectId !== project || state.view !== view) return;
  selectOutput("pdf");
  if (!state.pdfDocument || state.pdfSourceRevision !== position.revision) {
    await showPdf(true, position.page);
  } else if (!elements.pdf_document.querySelector(`canvas[data-page="${position.page}"]`)) {
    await renderPdf(position.page);
  }
  if (state.projectId !== project || state.pdfSourceRevision !== position.revision) throw new Error("The PDF changed. Try navigating again.");
  const canvas = (elements.pdf_document as HTMLElement).querySelector<HTMLCanvasElement>(`canvas[data-page="${position.page}"]`);
  if (!canvas) throw new Error("PDF page not found");
  const page = await state.pdfDocument.getPage(position.page);
  const viewport = page.getViewport({ scale: 1 });
  const x = Math.max(0, Math.min(viewport.width, position.x)) / viewport.width * canvas.clientWidth;
  const y = Math.max(0, Math.min(viewport.height, position.y)) / viewport.height * canvas.clientHeight;
  if (narrowWorkspace.matches) elements.output_pane.classList.add("mobile-open");
  elements.pdf_view.scrollTo({ top: Math.max(0, canvas.offsetTop + y - elements.pdf_view.clientHeight / 2), left: Math.max(0, canvas.offsetLeft + x - elements.pdf_view.clientWidth / 2), behavior: "smooth" });
  const expires = Date.now() + 3000;
  state.pdfHighlights = { boxes: position.boxes || [{ page: position.page, left: position.x - 30, top: position.y - 8, width: 60, height: 16 }], expires };
  renderPdfHighlights();
  setTimeout(() => { if (state.pdfHighlights?.expires === expires) { state.pdfHighlights = null; renderPdfHighlights(); } }, 3000);
}

function renderPdfHighlights() {
  elements.pdf_document.querySelectorAll("[data-pdf-highlight]").forEach((marker: Element) => marker.remove());
  if (!state.pdfHighlights || state.pdfHighlights.expires < Date.now()) return;
  const canvases = [...elements.pdf_document.querySelectorAll("canvas")];
  let index = 0;
  for (const box of state.pdfHighlights.boxes) {
    const canvas = canvases.find(canvas => canvas.dataset.page === String(box.page));
    if (!canvas) continue;
    // Canvas render scale is independent of device pixel ratio.
    const scale = Number(canvas.dataset.pdfScale || 1);
    const marker = document.createElement("div");
    if (index++ === 0) marker.id = "pdf-source-marker";
    marker.dataset.pdfHighlight = "true";
    marker.className = "pointer-events-none absolute z-10 border-2 border-amber-500 bg-amber-200/30";
    marker.style.top = `${canvas.offsetTop + Math.max(0, box.top) * scale}px`;
    marker.style.left = `${canvas.offsetLeft + Math.max(0, box.left) * scale}px`;
    marker.style.width = `${Math.max(4, Math.min(box.width * scale, canvas.clientWidth))}px`;
    marker.style.height = `${Math.max(4, box.height * scale)}px`;
    elements.pdf_document.append(marker);
  }
}

editorContextMenu.addEventListener("click", async event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-editor-action]");
  const view = contextView;
  if (!button || button.disabled || !view || state.view !== view) return;
  const action = button.dataset.editorAction;
  const doc = view.state.doc;
  const selection = view.state.selection;
  closeEditorContextMenu();
  view.focus();
  try {
    if (action === "undo") { editorUndoManagers.get(view)?.undo(); return; }
    if (action === "redo") { editorUndoManagers.get(view)?.redo(); return; }
    if (action === "select-all") { selectAll(view); return; }
    if (action === "comment") { openReviewDialog(); return; }
    if (action === "pdf") { await goToPdf(view); return; }
    if (action === "copy" || action === "cut") {
      const text = selection.ranges.map(range => stripReviewStorage(doc.sliceString(range.from, range.to))).join("\n");
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else if (!document.execCommand("copy")) throw new Error("Clipboard access unavailable");
      if (action === "copy") return;
    }
    const inserted = action === "paste" ? await navigator.clipboard.readText() : "";
    if (state.view !== view || view.state.doc !== doc || !view.state.selection.eq(selection)) throw new Error("The selection changed. Try again.");
    view.dispatch({ ...view.state.replaceSelection(inserted), userEvent: action === "paste" ? "input.paste" : "delete.cut" });
  } catch (error) { showToast(error.message); }
});

editorContextMenu.addEventListener("keydown", event => {
  if (event.key === "Escape" || event.key === "Tab") {
    const view = contextView;
    event.preventDefault();
    closeEditorContextMenu();
    view?.focus();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...editorContextMenu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
});
document.addEventListener("pointerdown", event => { if (!editorContextMenu.contains(event.target as Node)) closeEditorContextMenu(); }, true);
window.addEventListener("blur", closeEditorContextMenu);
window.addEventListener("resize", closeEditorContextMenu);
document.addEventListener("scroll", event => { if (!editorContextMenu.contains(event.target as Node)) closeEditorContextMenu(); }, true);

async function revealSource(destination: { path: string; line: number; from?: number; to?: number }) {
  const project = state.projectId;
  await openFile(destination.path);
  const view = state.view;
  const provider = state.provider;
  if (!view || !provider) return;
  const deadline = Date.now() + 5000;
  while (!provider.synced && state.view === view && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (state.projectId !== project || state.view !== view || !provider.synced) return;
  const line = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, destination.line)));
  elements.output_pane.classList.remove("mobile-open");
  const selection = { anchor: line.from + Math.min(line.length, destination.from || 0), head: line.from + Math.min(line.length, destination.to ?? destination.from ?? 0) };
  view.dispatch({ selection, effects: EditorView.scrollIntoView(selection.anchor, { y: "center" }) });
  view.focus();
}

const searchDialog = document.getElementById("search-dialog") as HTMLDialogElement;
const searchQuery = document.getElementById("search-query") as HTMLInputElement;
const searchStatus = document.getElementById("search-status")!;
const searchResults = document.getElementById("search-results")!;
let replacementPlan: Array<{ path: string; baseSha256: string; before: string; source: string }> = [];
let replacementProject = "";
const applyReplacements = document.getElementById("replace-apply") as HTMLButtonElement;
let searchVersion = 0;
const openProjectSearch = () => { searchDialog.showModal(); searchQuery.focus(); };
document.getElementById("project-search")!.addEventListener("click", openProjectSearch);
document.getElementById("editor-search")!.addEventListener("click", openProjectSearch);
document.getElementById("search-close")!.addEventListener("click", () => searchDialog.close());
searchDialog.addEventListener("close", () => { searchVersion++; replacementPlan = []; applyReplacements.hidden = true; });
for (const id of ["search-query", "replace-text", "replace-scope", "search-case", "search-regex"]) document.getElementById(id)!.addEventListener("input", () => { searchVersion++; replacementPlan = []; applyReplacements.hidden = true; });
document.getElementById("replace-preview")!.addEventListener("click", async () => {
  const version = ++searchVersion;
  const project = state.projectId;
  replacementPlan = []; applyReplacements.hidden = true; searchResults.replaceChildren();
  searchStatus.textContent = "Preparing replacement preview...";
  try {
    const result = await request<{ files: ReplacementPreview[]; count: number }>("v1/search/replace/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      query: searchQuery.value, replacement: (document.getElementById("replace-text") as HTMLInputElement).value,
      caseSensitive: (document.getElementById("search-case") as HTMLInputElement).checked, regex: (document.getElementById("search-regex") as HTMLInputElement).checked,
      path: (document.getElementById("replace-scope") as HTMLSelectElement).value === "file" ? state.activeFile : undefined,
    }) });
    if (version !== searchVersion || project !== state.projectId) return;
    replacementPlan = result.files; replacementProject = project;
    searchStatus.textContent = `${result.count} replacements in ${result.files.length} files`;
    for (const file of result.files) {
      const heading = document.createElement("strong"); heading.className = "block border-t py-2 text-xs"; heading.textContent = file.path;
      const preview = document.createElement("pre"); preview.className = "overflow-auto whitespace-pre-wrap break-words font-mono text-xs";
      for (const part of diffLines(file.before, file.source)) {
        const row = document.createElement("span"); row.className = "block " + (part.added ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200" : part.removed ? "bg-red-100 text-red-900 dark:bg-red-950/50 dark:text-red-200" : "text-muted-foreground");
        row.textContent = part.value.split("\n").map(line => (part.added ? "+ " : part.removed ? "- " : "  ") + line).join("\n");
        preview.append(row);
      }
      searchResults.append(heading, preview);
    }
    applyReplacements.hidden = !result.files.length;
  } catch (error) { if (version === searchVersion) searchStatus.textContent = error.message; }
});
applyReplacements.addEventListener("click", async () => {
  if (!replacementPlan.length || replacementProject !== state.projectId) return;
  applyReplacements.disabled = true;
  try {
    await request("v1/search/replace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: replacementPlan.map(({ before, ...file }) => file) }) });
    replacementPlan = []; applyReplacements.hidden = true; searchStatus.textContent = "Replacements applied";
    markPdfStale(); await refreshProject();
  } catch (error) { replacementPlan = []; applyReplacements.hidden = true; searchStatus.textContent = error.message; }
  finally { applyReplacements.disabled = false; }
});
window.addEventListener("keydown", event => {
  if ((macReferences ? event.metaKey : event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f" && !elements.editor_page.hidden) {
    event.preventDefault();
    if (!searchDialog.open) openProjectSearch();
  }
});
document.getElementById("search-form")!.addEventListener("submit", async event => {
  event.preventDefault();
  const version = ++searchVersion;
  replacementPlan = []; applyReplacements.hidden = true;
  const project = state.projectId;
  searchStatus.textContent = "Searching...";
  searchResults.replaceChildren();
  try {
    const result = await request<{ matches: SearchMatch[]; truncated: boolean }>("v1/search/project", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: searchQuery.value, caseSensitive: (document.getElementById("search-case") as HTMLInputElement).checked, regex: (document.getElementById("search-regex") as HTMLInputElement).checked }),
    });
    if (version !== searchVersion || state.projectId !== project) return;
    searchStatus.textContent = result.matches.length ? `${result.matches.length} matches${result.truncated ? " (first 500)" : ""}` : "No matches";
    for (const match of result.matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result block w-full min-w-0 border-b px-2 py-2 text-left hover:bg-accent focus-visible:bg-accent";
      const label = document.createElement("strong");
      label.className = "block truncate text-xs";
      label.textContent = `${match.path}:${match.line}`;
      const text = document.createElement("div");
      text.className = "mt-1 overflow-hidden text-ellipsis whitespace-pre font-mono text-xs text-muted-foreground";
      text.append(document.createTextNode(match.text.slice(0, match.from)));
      const mark = document.createElement("mark");
      mark.className = "bg-amber-200 text-foreground dark:bg-amber-800/60";
      mark.textContent = match.text.slice(match.from, match.to);
      text.append(mark, document.createTextNode(match.text.slice(match.to)));
      button.append(label, text);
      button.addEventListener("click", () => { searchDialog.close(); void revealSource(match).catch(error => showToast(error.message)); });
      searchResults.append(button);
    }
  } catch (error) { if (version === searchVersion) searchStatus.textContent = error.message; }
});

const narrowWorkspace = window.matchMedia("(max-width: 760px)");
elements.toggle_files.addEventListener("click", () => elements.files_pane.classList.toggle("mobile-open"));
function applyCodeTool(action: string) {
  const view = state.view;
  if (!view) return;
  if (action === "Undo") { state.undoManager?.undo(); return; }
  if (action === "Redo") { state.undoManager?.redo(); return; }
  const selection = view.state.selection.main;
  const selected = view.state.sliceDoc(selection.from,selection.to);
  const templates: Record<string, string> = {
    "Bold": `\\textbf{${selected || "text"}}`,
    "Italic": `\\emph{${selected || "text"}}`,
    "Add heading": `\\section{${selected || "New section"}}`,
    "Add bullet list": `\\begin{itemize}\n${(selected || "First item").split("\n").map(line => "\\item " + line).join("\n")}\n\\end{itemize}`,
    "Add numbered list": `\\begin{enumerate}\n${(selected || "First step").split("\n").map(line => "\\item " + line).join("\n")}\n\\end{enumerate}`,
    "Add equation": `\\[\n${selected || "E = mc^2"}\n\\]`,
    "Add table": "\\begin{tabular}{ll}\nColumn 1 & Column 2 \\\\\nValue & Value \\\\\n\\end{tabular}",
    "Add paragraph": "\n\n" + (selected || "Write something.") + "\n\n",
  };
  const insert = templates[action]; if (insert === undefined) return;
  view.dispatch({changes:{from:selection.from,to:selection.to,insert},selection:{anchor:selection.from+insert.length},userEvent:"input"}); view.focus();
}
const visualEditor = new RichEditor(elements.rich_editor, {
  source: () => projectReviews(state.view?.state.doc.toString() || "").text,
  marks: () => projectReviews(state.view?.state.doc.toString() || "").marks,
  review: id => { workspaceLayout.showOutput(); selectOutput("review"); openCommentThread(id); },
  codeAction: applyCodeTool,
  change: (from, to, insert) => {
    if (!state.view) return;
    const range = projectReviews(state.view.state.doc.toString()).range(from,to);
    state.view.dispatch({changes: {...range, insert}, userEvent: "input"});
    queueMicrotask(() => visualEditor.refreshReviews());
  },
  image: path => {
    const parent = state.activeFile.includes("/") ? state.activeFile.slice(0,state.activeFile.lastIndexOf("/")+1) : "";
    const normalize = (value: string) => { const parts: string[] = []; for (const part of value.split("/")) { if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part); } return parts.join("/"); };
    const candidates = [normalize(parent + path), normalize(path)];
    const candidate = candidates.map(candidate => state.files.find(file => file.path === candidate || file.path.replace(/\.[^.]+$/, "") === candidate)).find(Boolean);
    const url = projectApiUrl("v1/files"); url.searchParams.set("path", candidate?.path || candidates[0]); return url.toString();
  },
  undo: () => { state.undoManager?.undo(); queueMicrotask(() => visualEditor.sync(true)); },
  redo: () => { state.undoManager?.redo(); queueMicrotask(() => visualEditor.sync(true)); },
  notice: showToast,
});
elements.rich_text_toggle.setAttribute("aria-pressed", "false");
function setEditorMode(enabled: boolean) {
  if (!state.view) return;
  if (enabled === !elements.rich_editor.hidden) return;
  if (enabled) visualEditor.show(); else visualEditor.hide();
  elements.editor.hidden = enabled;
  elements.review_actions.hidden = false;
  elements.rich_text_toggle.classList.toggle("active", enabled);
  document.getElementById("source-mode")!.classList.toggle("active", !enabled);
  document.getElementById("source-mode")!.setAttribute("aria-pressed", String(!enabled));
  elements.rich_text_toggle.setAttribute("aria-pressed", String(enabled));
}
document.getElementById("source-mode")!.addEventListener("click", () => setEditorMode(false));
elements.rich_text_toggle.addEventListener("click", () => setEditorMode(true));
document.querySelectorAll<HTMLElement>("[data-output]:not([data-output=review])").forEach(button => button.addEventListener("click", () => selectOutput(button.dataset.output as "pdf" | "review" | "log")));
setupPreferences({
  workspace: workspaceLayout,
  view: () => state.view,
  renderPdf,
  zoom: value => { state.pdfZoom = value; void renderPdf(); },
  openPdf: () => {
    if (!state.pdfDocument) return showToast('Compile your document to open the PDF.');
    window.open(elements.pdf_download.href, '_blank', 'noopener,noreferrer');
  },
});
let previewResizeTimer: ReturnType<typeof setTimeout>;
let previewWidth = 0;
new ResizeObserver(() => {
  const width = elements.pdf_view.clientWidth;
  if (!width || width === previewWidth) return;
  previewWidth = width; clearTimeout(previewResizeTimer);
  previewResizeTimer = setTimeout(() => { if (state.pdfDocument) renderPdf().catch(error => console.error(error)); }, 180);
}).observe(elements.pdf_view);
document.getElementById("toggle-review")!.addEventListener("click", () => setReviewOpen(Boolean(elements.review_pane.hidden)));
document.getElementById("close-review")!.addEventListener("click", () => setReviewOpen(false));
window.addEventListener("beforeunload", () => {
  disconnectEditor();
  resetFilePreview();
});
async function routeApp() {
  const invitationToken = routeInvitationToken();
  if (invitationToken) {
    try {
      const result = await request<{ invitation: { invitedBy: string } }>(`v1/invitations/${encodeURIComponent(invitationToken)}`);
      showAuthPage("register", `Invited by ${result.invitation.invitedBy}. Choose an account to join the core team.`);
    } catch (error) {
      showAuthPage("register", error.message);
      elements.auth_submit.disabled = true;
    }
    return;
  }
  const projectId = routeProjectId();
  if (projectId) {
    if (state.user && !state.projects.length) await refreshProjects();
    await openProjectPage(projectId, false);
    return;
  }
  if (state.user) {
    await enterProjectDashboard(false);
    return;
  }
  showAuthPage();
}

window.addEventListener("popstate", () => routeApp().catch(error => {
  showAuthPage();
  showToast(error.message);
}));

if (testMode) {
  elements.editor_page.hidden = false;
  window.__paperTest = {
    state,
    createEditor(content: string, suggesting = true): EditorView {
      disconnectEditor();
      const doc = new Y.Doc();
      const ytext = doc.getText("content");
      const awareness = new Awareness(doc);
      const provider = { awareness, destroy: () => awareness.destroy() };
      state.suggesting = suggesting;
      state.doc = doc;
      state.provider = provider as unknown as WebsocketProvider;
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
  request<{ user: CurrentUser | null; bootstrapReady: boolean }>("v1/auth/me").then(async auth => {
    state.user = auth.user;
    state.bootstrapReady = auth.bootstrapReady;
    syncAccountUi();
    if (e2eMode && state.user && !routeProjectId()) {
      const data = await refreshProjects();
      return openProjectPage(data.defaultProjectId || state.projects[0]?.id, false);
    }
    return routeApp();
  }).catch(error => {
    showAuthPage();
    showToast(error.message);
  });
}
