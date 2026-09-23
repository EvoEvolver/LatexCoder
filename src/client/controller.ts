import { createVersionHistory } from "./version-history";
import { createFileTabs } from "./file-tabs.ts";
import { createFileTree } from "./file-tree.ts";
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
import { Annotation, EditorSelection, EditorState, RangeSet, StateEffect, StateField, Transaction, type Extension, type Range, type TransactionSpec } from "@codemirror/state";
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumberMarkers,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
  WidgetType,
  ViewPlugin,
} from "@codemirror/view";
import {
  ArchiveRestore,
  Archive,
  ArrowLeft,
  createIcons,
  CheckCheck,
  Code2,
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
  Plus,
  RefreshCw,
  TerminalSquare,
  Tag,
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
import { Awareness } from "y-protocols/awareness";
import { diffLines } from "diff";
import * as Y from "yjs";

import { parseReviews, stripReviewStorage, type ReviewItem } from "../shared/review.ts";
import { referenceDefinition, type ReferenceLink } from "../shared/references.ts";
import { buildDiagnostics, compileErrors } from "../shared/compile-errors.ts";
import { latexDiagnostics } from "../shared/latex-diagnostics.ts";
import {
  flattenStructure,
  documentTitle,
  projectStructure,
  rootStructureInsertion,
  structureInsertions,
  type SourceRange,
  type StructureEntry,
  type StructureHeading,
  type StructureInsertion,
  type StructurePoint,
  type StructureSummary,
} from "../shared/structure.ts";
import type { BuildDiagnostic } from "../shared/compile-errors.ts";
import { createApiClient, socketUrl } from "./api.ts";
import { projectCompletionSource } from "./completions.ts";
import { setThemePreference, themePreference, type ThemePreference } from "./theme.ts";
import { EditorSession } from "./editor-session.ts";
import { createElementRegistry, optionalElement } from "./dom.ts";
import { PdfController } from "./pdf-controller.ts";
import { WorkspaceController } from "./workspace-controller.ts";
import { TreeWriterEditor } from "./tree-writer-editor.ts";
import { sourceEditorInteractions, sourceModifierIsMeta, sourceModifierLabel, sourceModifierPressed } from "./source-editor-interactions.ts";
import type {
  AppState, BlameRun, BuildInfo, CurrentUser, DialogOptions, EditorSettings, GitState, PdfPosition,
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
    ArchiveRestore,
    ChevronRight,
    Folder,
    Archive,
    ArrowLeft,
    CheckCheck,
    Code2,
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
    Plus,
    RefreshCw,
    TerminalSquare,
    Tag,
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

const elementIds = [
  "access-close", "access-dialog", "access-done", "access-project-name", "access-secret-close", "access-secret-dialog", "access-secret-done", "agent-access-close", "agent-access-dialog", "agent-access-done", "agent-command", "agent-command-label", "agent-direct", "agent-editing-description", "agent-propose", "back-projects",
  "account-button", "account-cancel", "account-close", "account-dialog", "account-display-name", "account-form", "account-logout", "account-save", "account-username",
  "action-cancel", "action-close", "action-dialog", "action-form", "action-input", "action-label", "action-message", "action-submit", "action-title",
  "auth-description", "auth-error", "auth-form", "auth-page", "auth-password", "auth-submit", "auth-title", "auth-username",
  "active-file-label", "binary-download", "binary-fallback", "binary-fallback-download", "binary-kind", "binary-name", "binary-status", "binary-view",
  "browser-editing-description", "build-log", "build-output", "clone-command", "close-files", "close-output", "compile-button", "copy-agent-link", "copy-clone-command", "copy-share-link", "display-name", "download-project",
  "collaborate-menu", "collaborator-close", "collaborator-dialog", "collaborator-done", "collaborator-list", "editor-page", "editor-pane", "editor-topbar", "editor", "empty-output", "file-list", "file-pdf-document", "file-preview-viewport", "file-preview-zoom-in", "file-preview-zoom-out", "files-menu", "files-pane", "guest-name-field", "image-preview", "new-project", "open-pdf", "output-pane", "pdf-document", "project-title", "review-actions", "topbar-actions", "topbar-status",
  "copy-invite-link", "current-user", "invite-close", "invite-description", "invite-dialog", "invite-done", "invite-link", "invite-regenerate", "invite-reusable", "invite-single", "invite-user", "logout-button",
  "pdf-download", "pdf-fit-page", "pdf-fit-width", "pdf-status", "pdf-surface", "pdf-view", "pdf-zoom-in", "pdf-zoom-out", "presence", "review-count", "review-dialog", "review-form",
  "project-list", "project-name", "project-search", "project-tag-filters", "projects-active", "projects-archived", "projects-page", "review-cancel", "review-close", "review-list", "review-pane", "review-text", "rotate-share-secret", "share-edit", "share-link", "share-link-label", "share-view", "suggest-edit", "sync-state",
  "git-change-count", "git-close", "git-commit", "git-conflict", "git-conflict-branch", "git-dialog", "git-file-list",
  "git-access-close", "git-access-dialog", "git-access-done", "git-history", "git-message", "git-refresh", "git-resolve", "git-summary",
  "toast", "toggle-files", "toggle-files-column", "toggle-output-column", "upload-input", "selection-actions", "selection-accept", "selection-comment", "structure-document", "structure-list", "structure-pane", "structure-resize", "structure-view", "open-structure", "refresh-structure", "workspace-view-switch",
] as const;

const elements = createElementRegistry(elementIds, {
  access_secret_dialog: HTMLDialogElement,
  access_dialog: HTMLDialogElement,
  agent_access_dialog: HTMLDialogElement,
  account_dialog: HTMLDialogElement,
  action_dialog: HTMLDialogElement,
  collaborator_dialog: HTMLDialogElement,
  git_access_dialog: HTMLDialogElement,
  git_dialog: HTMLDialogElement,
  invite_dialog: HTMLDialogElement,
  review_dialog: HTMLDialogElement,
  account_display_name: HTMLInputElement,
  account_username: HTMLInputElement,
  action_input: HTMLInputElement,
  agent_command: HTMLInputElement,
  auth_password: HTMLInputElement,
  auth_username: HTMLInputElement,
  clone_command: HTMLInputElement,
  display_name: HTMLInputElement,
  git_message: HTMLInputElement,
  invite_link: HTMLInputElement,
  project_search: HTMLInputElement,
  share_link: HTMLInputElement,
  upload_input: HTMLInputElement,
  review_text: HTMLTextAreaElement,
  binary_download: HTMLAnchorElement,
  binary_fallback_download: HTMLAnchorElement,
  download_project: HTMLAnchorElement,
  pdf_download: HTMLAnchorElement,
  image_preview: HTMLImageElement,
  account_save: HTMLButtonElement,
  action_submit: HTMLButtonElement,
  auth_submit: HTMLButtonElement,
  compile_button: HTMLButtonElement,
  file_preview_zoom_in: HTMLButtonElement,
  file_preview_zoom_out: HTMLButtonElement,
  git_commit: HTMLButtonElement,
  git_refresh: HTMLButtonElement,
  git_resolve: HTMLButtonElement,
  invite_regenerate: HTMLButtonElement,
  invite_reusable: HTMLButtonElement,
  invite_single: HTMLButtonElement,
  refresh_structure: HTMLButtonElement,
  selection_comment: HTMLButtonElement,
});

const themeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-theme-option]")];
function onDynamicClick(id: string, listener: (event: Event) => void): void {
  document.addEventListener("click", event => {
    if ((event.target as Element).closest(`#${id}`)) listener(event);
  });
}

function syncThemeControls(): void {
  const preference = themePreference();
  for (const button of themeButtons) {
    const selected = button.dataset.themeOption === preference;
    button.setAttribute("aria-checked", String(selected));
    button.classList.toggle("border-primary", selected);
    button.classList.toggle("bg-accent", selected);
  }
}
for (const button of themeButtons) button.addEventListener("click", () => {
  setThemePreference(button.dataset.themeOption as ThemePreference);
  syncThemeControls();
});
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
  projectCanEdit: true,
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
  pdfFitMode: "width",
  pdfRenderVersion: 0,
  pdfSourceRevision: null,
  pdfZoom: 1,
  filePreviewDocument: null,
  filePreviewLoadingTask: null,
  filePreviewVersion: 0,
  filePreviewZoom: 1,
  reviewSelection: null,
  selectionSuggestionIds: [],
  suggesting: false,
  toastTimer: null,
  compileDiagnostics: [],
  staticDiagnostics: [],
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
let editorSession: EditorSession | null = null;

function updateSyncStatus() {
  if (!state.provider) return;
  const connected = state.provider.wsconnected;
  elements.sync_state.textContent = !connected ? state.unsaved ? "Offline - unsynced edits" : "Reconnecting"
    : !state.provider.synced ? "Synchronizing"
    : !state.projectCanEdit ? "Viewing live"
    : state.unsaved ? "Saving..." : "Saved live";
}

function scheduleAutoCompile() {
  clearTimeout(autoCompileTimer);
  if (state.projectCanEdit && state.settings?.autoCompile && state.projectId) autoCompileTimer = setTimeout(() => {
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
  elements.back_projects.hidden = !registered;
  document.documentElement.dataset.authState = registered ? "registered" : "guest";
  elements.current_user.textContent = state.user?.displayName || state.user?.username || "";
}

let projectTitleLayoutFrame = 0;
function updateProjectTitleVisibility(): void {
  cancelAnimationFrame(projectTitleLayoutFrame);
  projectTitleLayoutFrame = requestAnimationFrame(() => {
    const title = elements.project_title;
    if (window.matchMedia("(max-width: 760px)").matches) {
      title.hidden = true;
      title.setAttribute("aria-hidden", "true");
      return;
    }
    title.hidden = false;
    const titleBounds = title.getBoundingClientRect();
    const actionsBounds = elements.topbar_actions.getBoundingClientRect();
    const statusBounds = elements.topbar_status.getBoundingClientRect();
    const overlaps = titleBounds.left < actionsBounds.right + 12 || titleBounds.right > statusBounds.left - 12;
    title.hidden = overlaps;
    title.setAttribute("aria-hidden", String(overlaps));
  });
}

const topbarResizeObserver = new ResizeObserver(updateProjectTitleVisibility);
topbarResizeObserver.observe(elements.editor_topbar);
topbarResizeObserver.observe(elements.topbar_actions);
topbarResizeObserver.observe(elements.topbar_status);
new MutationObserver(updateProjectTitleVisibility).observe(elements.project_name, { childList: true, characterData: true, subtree: true });
updateProjectTitleVisibility();

function openAccountPanel(): void {
  if (!state.user) return;
  elements.account_username.value = state.user.username;
  elements.account_display_name.value = state.user.displayName || state.user.username;
  syncThemeControls();
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

function openActionDialog({ title, label = "", value = "", maxLength = 512, message = "", submitLabel, danger = false, zip = false, allowEmpty = false }: DialogOptions): Promise<string | boolean | null> {
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
  elements.action_input.required = hasInput && !allowEmpty;
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
      if (hasInput && !result && !allowEmpty) { elements.action_input.reportValidity(); return; }
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
  if (!view || !state.projectCanEdit) return;
  const selection = view.state.selection.main;
  if (selection.empty) return;
  const overlappingReviews = parseReviews(view.state.doc.toString())
    .filter(item => selection.from < item.to && selection.to > item.from);
  const ids = [...new Set(overlappingReviews
    .filter(item => item.kind !== "comment" && selection.from < item.to && selection.to > item.from)
    .map(item => item.id))];
  const canComment = overlappingReviews.length === 0;
  if (!ids.length && !canComment) return;
  const caret = view.coordsAtPos(selection.head, 1);
  const editor = elements.editor.getBoundingClientRect();
  if (!caret || caret.bottom < editor.top || caret.top > editor.bottom) return;

  state.selectionSuggestionIds = ids;
  elements.selection_comment.hidden = !canComment;
  elements.selection_accept.hidden = ids.length === 0;
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

const fileTabs = createFileTabs(
  document.getElementById("file-tabs")!,
  path => { void openFile(path); },
  id => { if (id === "structure") showExpandedStructure(); },
);
const fileTree = createFileTree(elements.file_list, {
  open: path => { void openFile(path); },
  search: () => openProjectSearch(),
  rename: (path, folder) => { void renameEntry(path, folder); },
  remove: (path, folder) => { void deleteEntry(path, folder); },
  create: (path, folder) => { void (folder ? newFolder(path) : newFile(path)); },
  upload: path => openUpload(path),
  move: moveFilePath,
  download: path => {
    const anchor = document.createElement("a");
    anchor.href = projectApiUrl(`v1/files?path=${encodeURIComponent(path)}`).toString();
    anchor.download = path.split("/").at(-1)!;
    anchor.click();
  },
});
elements.files_menu.addEventListener("click", event => {
  event.stopPropagation();
  fileTree.openRootMenu(elements.files_menu);
});

let activeFileIsTransient = false;

function renderFiles(): void {
  fileTabs.update(state.files, state.activeFile, state.projectId, { transient: activeFileIsTransient });
  fileTree.render({ files: state.files, directories: state.folders || [], active: state.activeFile, main: state.main || "", editable: state.projectCanEdit }, state.projectId);
}

function syncProjectPermissionUi(): void {
  const editable = state.projectCanEdit;
  for (const id of ["project-settings", "menu-open-trash", "history-save-checkpoint"]) {
    const control = document.getElementById(id);
    if (control) control.hidden = !editable;
  }
  elements.git_commit.hidden = !editable;
  elements.git_message.hidden = !editable;
  elements.git_resolve.hidden = !editable || !state.git?.conflict;
  document.getElementById("history-restore")!.hidden = !editable;
  document.getElementById("history-restore-file")!.hidden = !editable;
  const textFile = state.files.find(file => file.path === state.activeFile)?.text;
  elements.suggest_edit.hidden = !editable || !textFile;
  if (!editable) elements.selection_actions.hidden = true;
}

let structureVersion = 0;
let structureEntries: StructureEntry[] = [];
let structureSources = new Map<string, string>();
let treeWriterEditor: TreeWriterEditor | null = null;
let treeWriterNodeId = "";
let treeWriterOpenVersion = 0;
const projectedSourceViews = new WeakMap<EditorView, { sourcePosition: (localPosition: number) => number | null }>();

function closeTreeWriterEditor(): void {
  treeWriterOpenVersion += 1;
  treeWriterEditor?.destroy();
  treeWriterEditor = null;
  treeWriterNodeId = "";
  elements.structure_document.querySelectorAll<HTMLElement>("[data-tree-editor-panel]").forEach(panel => { panel.hidden = true; });
  elements.structure_document.querySelectorAll<HTMLElement>('[data-tree-leaf="true"]').forEach(button => button.setAttribute("aria-expanded", "false"));
  elements.structure_document.querySelectorAll<HTMLElement>("[data-tree-editor-trigger]").forEach(button => button.setAttribute("aria-pressed", "false"));
}

async function refreshStructure(): Promise<void> {
  const version = ++structureVersion;
  const project = state.projectId;
  closeTreeWriterEditor();
  elements.refresh_structure.disabled = true;
  elements.structure_list.innerHTML = '<p class="px-2 py-3 text-xs text-muted-foreground">Loading tree…</p>';
  try {
    const texFiles = state.files.filter(file => file.text && /\.tex$/i.test(file.path));
    const pairs = await Promise.all(texFiles.map(async file => {
      if (file.path === state.activeFile && editorSession?.synced) return [file.path, editorSession.text.toString()] as const;
      const response = await fetch(projectApiUrl(`v1/files?path=${encodeURIComponent(file.path)}`));
      if (!response.ok) throw new Error(`Could not read ${file.path}`);
      return [file.path, await response.text()] as const;
    }));
    if (version !== structureVersion || project !== state.projectId) return;
    structureSources = new Map(pairs);
    structureEntries = projectStructure(state.main, structureSources);
    renderStructure();
  } catch (error) {
    if (version === structureVersion && project === state.projectId) {
      elements.structure_list.innerHTML = '<p class="px-2 py-3 text-xs text-destructive"></p>';
      elements.structure_list.querySelector("p")!.textContent = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (version === structureVersion && project === state.projectId) elements.refresh_structure.disabled = false;
  }
}

function structureSourceButton(entry: StructureEntry, level: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "structure-item block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary";
  button.title = `${entry.path}:${entry.line} - ${entry.title}`;
  button.dataset.path = entry.path;
  button.dataset.line = String(entry.line);
  button.dataset.structureType = entry.type;
  button.dataset.structureKind = entry.kind;
  button.style.paddingLeft = `${8 + Math.min(4, level) * 6}px`;
  button.addEventListener("click", () => { void revealSource(entry).catch(error => showToast(error.message)); });
  return button;
}

function structureSummaryButton(heading: StructureHeading, summary: StructureSummary, level: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "structure-item flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs leading-4 text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary";
  button.style.paddingLeft = `${8 + Math.min(4, level) * 6}px`;
  button.dataset.structureType = "point";
  button.dataset.structureKind = "section";
  button.title = `${heading.path}:${summary.line} - ${summary.title}`;
  const bullet = document.createElement("span");
  bullet.className = "mt-[7px] size-1.5 shrink-0 rounded-full bg-primary";
  const text = document.createElement("span");
  text.className = "line-clamp-2";
  text.textContent = summary.title;
  button.append(bullet, text);
  button.addEventListener("click", () => { void revealSource({ path: heading.path, line: summary.line }).catch(error => showToast(error.message)); });
  return button;
}

type TreeWriterPanel = { host: HTMLElement; panel: HTMLElement; status: HTMLElement; title: HTMLElement };
type TreeWriterTarget = {
  id: string;
  label: string;
  range: SourceRange;
  selection?: { anchor: number; head?: number };
  selectMacroArgument?: boolean;
  skipSnapshotCheck?: boolean;
};

function treeWriterPanel(nodeId: string): TreeWriterPanel {
  const panel = document.createElement("div");
  panel.className = "tree-writer-editor-panel";
  panel.dataset.treeEditorPanel = nodeId;
  panel.hidden = true;
  const toolbar = document.createElement("header");
  toolbar.className = "tree-writer-editor-toolbar";
  const title = document.createElement("span");
  const done = document.createElement("button");
  done.type = "button";
  done.className = "tree-writer-done";
  done.textContent = "Done";
  done.addEventListener("click", () => {
    closeTreeWriterEditor();
    void refreshStructure();
  });
  toolbar.append(title, done);
  const status = document.createElement("div");
  status.className = "tree-writer-editor-status";
  const host = document.createElement("div");
  host.className = "tree-writer-editor";
  panel.append(toolbar, status, host);
  return { host, panel, status, title };
}

function treeWriterIconButton(icon: "code-2", title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-writer-icon-button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<i data-lucide="${icon}"></i>`;
  return button;
}

function treeWriterAddMenu(insertions: StructureInsertion[], open: (insertion: StructureInsertion) => void): HTMLElement {
  const menu = document.createElement("details");
  menu.className = "tree-writer-add-menu";
  const trigger = document.createElement("summary");
  trigger.className = "tree-writer-icon-button";
  trigger.title = "Add node";
  trigger.setAttribute("aria-label", "Add node");
  trigger.innerHTML = '<i data-lucide="plus"></i>';
  trigger.addEventListener("click", () => {
    elements.structure_document.querySelectorAll<HTMLDetailsElement>(".tree-writer-add-menu[open]")
      .forEach(other => { if (other !== menu) other.removeAttribute("open"); });
  });
  const content = document.createElement("div");
  content.className = "tree-writer-add-menu-content";
  for (const insertion of insertions) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = insertion.label;
    item.addEventListener("click", () => {
      menu.removeAttribute("open");
      open(insertion);
    });
    content.append(item);
  }
  menu.append(trigger, content);
  return menu;
}

function treeWriterMacroSelection(source: string): { anchor: number; head: number } | undefined {
  const open = source.indexOf("{");
  const close = source.lastIndexOf("}");
  return open >= 0 && close > open ? { anchor: open + 1, head: close } : undefined;
}

function sameSourceRange(left: SourceRange, right: SourceRange): boolean {
  return left.path === right.path && left.from === right.from && left.to === right.to;
}

function treeWriterTldrList(titles: readonly string[]): HTMLUListElement {
  const list = document.createElement("ul");
  list.className = "tree-writer-tldr-list";
  for (const title of titles) {
    const item = document.createElement("li");
    item.textContent = title;
    list.append(item);
  }
  return list;
}

function treeWriterPointGroup(points: readonly StructurePoint[], depth: number): HTMLElement {
  const first = points[0];
  const last = points.at(-1)!;
  const section = document.createElement("section");
  section.className = "tree-writer-node tree-writer-tldr-group";
  section.dataset.treeNode = first.id;
  section.style.setProperty("--tree-depth", String(Math.min(depth, 6)));

  const row = document.createElement("div");
  row.className = "tree-writer-tldr-row";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-writer-tldr-button";
  button.dataset.structureType = "point";
  button.dataset.structureKind = "paragraph";
  button.dataset.treeLeaf = "true";
  button.setAttribute("aria-expanded", "false");
  button.append(treeWriterTldrList(points.map(point => point.title)));
  row.append(button);

  const editorPanel = treeWriterPanel(`tldr:${first.id}`);
  if (state.projectCanEdit) {
    const sourceButton = treeWriterIconButton("code-2", "Edit TL;DR source");
    sourceButton.dataset.treeEditorTrigger = `tldr:${first.id}`;
    sourceButton.addEventListener("click", () => {
      void openTreeWriterRange({
        id: `tldr:${first.id}:source`,
        label: "Editing TL;DR source",
        range: first.macroRange,
        selectMacroArgument: points.length === 1,
      }, sourceButton, editorPanel).catch(error => showTreeWriterError(error, editorPanel));
    });
    row.append(sourceButton);
    row.append(treeWriterAddMenu(structureInsertions(last), insertion => {
      void insertTreeWriterNode(insertion, editorPanel).catch(error => showTreeWriterError(error, editorPanel));
    }));
  }
  section.append(row, editorPanel.panel);

  button.addEventListener("click", () => {
    if (treeWriterNodeId === `tldr:${first.id}:body`) {
      closeTreeWriterEditor();
      return;
    }
    void openTreeWriterRange({
      id: `tldr:${first.id}:body`,
      label: "Editing source text",
      range: first.sourceRange,
    }, button, editorPanel).catch(error => showTreeWriterError(error, editorPanel));
  });
  return section;
}

function appendTreeWriterEntries(host: HTMLElement, entries: readonly StructureEntry[], depth: number): void {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.type === "heading") {
      host.append(treeWriterNode(entry, depth));
      continue;
    }
    const points = [entry];
    while (
      entries[index + 1]?.type === "point"
      && sameSourceRange((entries[index + 1] as StructurePoint).macroRange, entry.macroRange)
    ) {
      points.push(entries[++index] as StructurePoint);
    }
    host.append(treeWriterPointGroup(points, depth));
  }
}

function treeWriterNode(entry: StructureHeading, depth: number): HTMLElement {
  const summaryPoints = entry.summary
    ? entry.children.filter((child): child is StructurePoint => child.type === "point" && sameSourceRange(child.macroRange, entry.summary!.macroRange))
    : [];
  const groupedIds = new Set(summaryPoints.map(point => point.id));
  const remainingChildren = entry.children.filter(child => !groupedIds.has(child.id));
  const section = document.createElement("section");
  section.className = "tree-writer-node";
  section.dataset.treeNode = entry.id;
  section.style.setProperty("--tree-depth", String(Math.min(depth, 6)));

  const row = document.createElement("div");
  row.className = "tree-writer-node-row";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-writer-node-button";
  button.dataset.structureType = entry.type;
  button.dataset.structureKind = entry.kind;
  button.dataset.treeLeaf = String(remainingChildren.length === 0);
  const chevron = document.createElement("span");
  chevron.className = "tree-writer-chevron";
  chevron.textContent = "›";
  chevron.hidden = remainingChildren.length === 0;
  const label = document.createElement("span");
  label.className = "tree-writer-label";
  label.textContent = entry.title;
  button.append(chevron, label);
  row.append(button);

  const editorPanel = treeWriterPanel(entry.id);
  if (state.projectCanEdit) {
    const sourceButton = treeWriterIconButton("code-2", `Edit ${entry.kind} source`);
    sourceButton.dataset.treeEditorTrigger = entry.id;
    sourceButton.addEventListener("click", () => {
      void openTreeWriterRange({
        id: `${entry.id}:command`,
        label: `Editing \\${entry.kind} source`,
        range: entry.commandRange,
        selectMacroArgument: true,
      }, sourceButton, editorPanel).catch(error => showTreeWriterError(error, editorPanel));
    });
    row.append(sourceButton);
    const insertions = structureInsertions(entry);
    if (insertions.length) {
      row.append(treeWriterAddMenu(insertions, insertion => {
        void insertTreeWriterNode(insertion, editorPanel).catch(error => showTreeWriterError(error, editorPanel));
      }));
    }
  }
  section.append(row);

  if (entry.summary) {
    const summaryRow = document.createElement("div");
    summaryRow.className = "tree-writer-summary-row tree-writer-tldr-row";
    summaryRow.append(treeWriterTldrList([entry.summary.title, ...summaryPoints.map(point => point.title)]));
    if (state.projectCanEdit) {
      const summaryButton = treeWriterIconButton("code-2", "Edit TL;DR source");
      summaryButton.dataset.treeEditorTrigger = `${entry.id}:summary`;
      summaryButton.addEventListener("click", () => {
        void openTreeWriterRange({
          id: `${entry.id}:summary`,
          label: "Editing TL;DR source",
          range: entry.summary!.macroRange,
          selectMacroArgument: summaryPoints.length === 0,
        }, summaryButton, editorPanel).catch(error => showTreeWriterError(error, editorPanel));
      });
      summaryRow.append(summaryButton);
    }
    section.append(summaryRow);
  }
  section.append(editorPanel.panel);

  if (remainingChildren.length) {
    const children = document.createElement("div");
    children.className = "tree-writer-children";
    children.hidden = true;
    appendTreeWriterEntries(children, remainingChildren, depth + 1);
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => {
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      children.hidden = expanded;
    });
    section.append(children);
    return section;
  }

  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    if (treeWriterNodeId === `${entry.id}:body`) {
      closeTreeWriterEditor();
      return;
    }
    void openTreeWriterRange({
      id: `${entry.id}:body`,
      label: "Editing source text",
      range: entry.sourceRange,
    }, button, editorPanel).catch(error => showTreeWriterError(error, editorPanel));
  });
  return section;
}

function showTreeWriterError(error: unknown, panel: TreeWriterPanel): void {
  panel.panel.hidden = false;
  panel.status.hidden = false;
  panel.status.textContent = error instanceof Error ? error.message : String(error);
  showToast(panel.status.textContent);
}

async function openTreeWriterRange(target: TreeWriterTarget, trigger: HTMLButtonElement, panel: TreeWriterPanel): Promise<void> {
  closeTreeWriterEditor();
  if (state.activeFile !== target.range.path || !editorSession) {
    await openFile(target.range.path, { keepAuxiliary: true, transient: true });
  }
  showExpandedStructure();
  const version = ++treeWriterOpenVersion;
  treeWriterNodeId = target.id;
  trigger.setAttribute(trigger.dataset.treeLeaf === "true" ? "aria-expanded" : "aria-pressed", "true");
  panel.panel.hidden = false;
  panel.title.textContent = target.label;
  panel.status.hidden = false;
  panel.status.textContent = "Opening source...";
  const session = editorSession;
  if (!session) throw new Error("Could not open the source document");
  const deadline = Date.now() + 5000;
  while (!session.synced && editorSession === session && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (version !== treeWriterOpenVersion || editorSession !== session || !document.contains(panel.host)) return;
  const snapshot = structureSources.get(target.range.path);
  if (!target.skipSnapshotCheck && snapshot !== undefined && snapshot !== session.text.toString()) {
    panel.status.textContent = "The source changed. Refreshing the tree...";
    await refreshStructure();
    showToast("The Tree was refreshed because the source changed. Try the action again.");
    return;
  }
  if (target.range.to > session.text.length) {
    panel.status.textContent = "This source range no longer exists.";
    return;
  }
  panel.status.hidden = true;
  const selection = target.selectMacroArgument
    ? treeWriterMacroSelection(session.text.toString().slice(target.range.from, target.range.to))
    : target.selection;
  const undoManager = state.view ? editorUndoManagers.get(state.view) : undefined;
  const editor = new TreeWriterEditor({
    editable: state.projectCanEdit,
    host: panel.host,
    range: target.range,
    text: session.text,
    undoManager,
    selection,
    extensions: sourceEditorInteractions({
      followReference: link => { void followReference(link); },
      openContextMenu: openEditorContextMenu,
    }),
    onInvalidated: () => {
      panel.status.hidden = false;
      panel.status.textContent = "This source range was removed. Refresh the Tree to continue.";
    },
  });
  treeWriterEditor = editor;
  projectedSourceViews.set(editor.view, { sourcePosition: position => editor.sourcePosition(position) });
  if (undoManager) editorUndoManagers.set(editor.view, undoManager);
  editor.focus();
}

async function insertTreeWriterNode(insertion: StructureInsertion, panel: TreeWriterPanel): Promise<void> {
  closeTreeWriterEditor();
  if (state.activeFile !== insertion.path || !editorSession) {
    await openFile(insertion.path, { keepAuxiliary: true, transient: true });
  }
  showExpandedStructure();
  const session = editorSession;
  if (!session) throw new Error("Could not open the source document");
  const deadline = Date.now() + 5000;
  while (!session.synced && editorSession === session && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  const snapshot = structureSources.get(insertion.path);
  if (snapshot !== undefined && snapshot !== session.text.toString()) {
    await refreshStructure();
    throw new Error("The Tree was refreshed because the source changed. Try the action again.");
  }
  if (insertion.at > session.text.length) throw new Error("The insertion point no longer exists");
  session.doc.transact(() => session.text.insert(insertion.at, insertion.template));
  const braces = insertion.template.indexOf("{}");
  const cursor = braces < 0 ? insertion.template.length : braces + 1;
  const trigger = document.createElement("button");
  trigger.dataset.treeEditorTrigger = "inserted";
  await openTreeWriterRange({
    id: `inserted:${insertion.path}:${insertion.at}`,
    label: `Editing ${insertion.template.trim().split("{")[0]} source`,
    range: { path: insertion.path, from: insertion.at, to: insertion.at + insertion.template.length },
    selection: { anchor: cursor },
    skipSnapshotCheck: true,
  }, trigger, panel);
}

function renderStructure(): void {
  closeTreeWriterEditor();
  elements.structure_list.replaceChildren();
  elements.structure_document.replaceChildren();
  const overview = document.createElement("header");
  overview.className = "tree-writer-overview";
  const heading = document.createElement("div");
  const title = document.createElement("h1");
  title.className = "text-xl font-semibold";
  title.textContent = documentTitle(structureSources.get(state.main) || "")
    || state.projects.find(project => project.id === state.projectId)?.name
    || "Untitled paper";
  const source = document.createElement("p");
  source.className = "mt-1 text-xs text-muted-foreground";
  source.textContent = state.main;
  heading.append(title, source);
  overview.append(heading);
  const rootPanel = treeWriterPanel("root-insertion");
  rootPanel.panel.style.setProperty("--tree-depth", "0");
  if (state.projectCanEdit) {
    const addSection = document.createElement("button");
    addSection.type = "button";
    addSection.className = "tree-writer-add-root";
    addSection.innerHTML = '<i data-lucide="plus"></i><span>Add section</span>';
    addSection.addEventListener("click", () => {
      const mainSource = structureSources.get(state.main);
      if (mainSource === undefined) {
        showToast("Refresh the Tree before adding a section.");
        return;
      }
      void insertTreeWriterNode(rootStructureInsertion(state.main, mainSource), rootPanel)
        .catch(error => showTreeWriterError(error, rootPanel));
    });
    overview.append(addSection);
  }
  elements.structure_document.append(overview, rootPanel.panel);
  if (!structureEntries.length) {
    const empty = document.createElement("p");
    empty.className = "px-2 py-3 text-xs text-muted-foreground";
    empty.textContent = "No sections or TL;DR points found";
    elements.structure_list.append(empty);
    const expandedEmpty = empty.cloneNode(true) as HTMLElement;
    expandedEmpty.className = "py-16 text-center text-sm text-muted-foreground";
    elements.structure_document.append(expandedEmpty);
    createIcons({ icons: ICONS });
    return;
  }
  const flatEntries = flattenStructure(structureEntries);
  const baseLevel = Math.min(...flatEntries.map(entry => entry.level));

  for (const entry of flatEntries) {
    const button = structureSourceButton(entry, entry.level - baseLevel);
    if (entry.type === "heading") {
      button.classList.add("truncate", "font-medium");
      button.textContent = entry.title;
    } else {
      button.classList.add("flex", "items-start", "gap-2", "whitespace-normal", "leading-4", "text-muted-foreground");
      const bullet = document.createElement("span");
      bullet.className = "mt-[7px] size-1.5 shrink-0 rounded-full bg-muted-foreground/70";
      const text = document.createElement("span");
      text.className = "line-clamp-2";
      text.textContent = entry.title;
      button.append(bullet, text);
    }
    elements.structure_list.append(button);
    if (entry.type === "heading" && entry.summary) {
      elements.structure_list.append(structureSummaryButton(entry, entry.summary, entry.level - baseLevel + 1));
    }
  }
  const tree = document.createElement("div");
  tree.className = "tree-writer-tree";
  appendTreeWriterEntries(tree, structureEntries, 0);
  elements.structure_document.append(tree);
  createIcons({ icons: ICONS });
}

elements.refresh_structure.addEventListener("click", () => { void refreshStructure(); });
document.addEventListener("click", event => {
  elements.structure_document.querySelectorAll<HTMLDetailsElement>(".tree-writer-add-menu[open]").forEach(menu => {
    if (!menu.contains(event.target as Node)) menu.removeAttribute("open");
  });
});
elements.open_structure.addEventListener("click", () => {
  fileTabs.openAuxiliary({ id: "structure", label: "TreeWriter", controls: "structure-view" });
});

function showExpandedStructure(): void {
  setReviewOpen(false);
  setOutputViewOpen(false);
  setMobileFilesOpen(false);
  elements.structure_view.hidden = false;
  elements.editor.hidden = true;
  elements.binary_view.hidden = true;
  elements.review_actions.hidden = false;
  elements.suggest_edit.hidden = true;
}

function hideExpandedStructure(): void {
  closeTreeWriterEditor();
  elements.structure_view.hidden = true;
  const file = state.files.find(candidate => candidate.path === state.activeFile);
  elements.editor.hidden = !file?.text;
  elements.binary_view.hidden = file?.text !== false;
  elements.suggest_edit.hidden = !state.projectCanEdit || !file?.text;
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
      if (!state.projectCanEdit) {
        if (item.kind === "comment") actions.append(tooltipButton("Open thread", () => openCommentThread(item.id)));
      } else if (item.kind === "comment") {
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
    setOutputViewOpen(false);
    view.dispatch({ selection: { anchor: current.from, head: current.to }, effects: EditorView.scrollIntoView(current.from, { y: "center" }) });
    view.focus();
  } catch (error) { showToast(error.message); }
}

type PositionedDiagnostic = BuildDiagnostic & { from: number; to: number };
const setEditorDiagnostics = StateEffect.define<PositionedDiagnostic[]>();

class DiagnosticLineNumberMarker extends GutterMarker {
  readonly elementClass: string = "";
  constructor(readonly severity: PositionedDiagnostic["severity"]) {
    super();
    this.elementClass = `cm-diagnostic-line ${severity}`;
  }
}

type EditorDiagnosticState = {
  diagnostics: PositionedDiagnostic[];
  lineMarkers: RangeSet<GutterMarker>;
};

function diagnosticLineMarkers(state: EditorState, diagnostics: PositionedDiagnostic[]): RangeSet<GutterMarker> {
  const byLine = new Map<number, PositionedDiagnostic["severity"]>();
  for (const diagnostic of diagnostics) {
    const line = state.doc.lineAt(diagnostic.from).from;
    const existing = byLine.get(line);
    if (!existing || (existing === "warning" && diagnostic.severity === "error")) byLine.set(line, diagnostic.severity);
  }
  return RangeSet.of([...byLine.entries()].map(([line, severity]) => new DiagnosticLineNumberMarker(severity).range(line)), true);
}

const editorDiagnosticField = StateField.define<EditorDiagnosticState>({
  create: () => ({ diagnostics: [], lineMarkers: RangeSet.empty }),
  update(value, transaction) {
    let diagnostics = value.diagnostics;
    for (const effect of transaction.effects) if (effect.is(setEditorDiagnostics)) diagnostics = effect.value;
    if (transaction.docChanged && diagnostics === value.diagnostics) diagnostics = diagnostics.map(diagnostic => ({
      ...diagnostic,
      from: transaction.changes.mapPos(diagnostic.from),
      to: transaction.changes.mapPos(diagnostic.to),
    }));
    return { diagnostics, lineMarkers: diagnosticLineMarkers(transaction.state, diagnostics) };
  },
  provide: field => [
    EditorView.decorations.from(field, value => Decoration.set(value.diagnostics.map(diagnostic =>
      Decoration.mark({
        class: `cm-diagnostic-range ${diagnostic.severity}`,
        attributes: { title: diagnostic.message },
      }).range(diagnostic.from, diagnostic.to)), true)),
    lineNumberMarkers.from(field, value => value.lineMarkers),
  ],
});

const editorDiagnosticTooltip = hoverTooltip((view, position) => {
  const diagnostics = view.state.field(editorDiagnosticField).diagnostics.filter(diagnostic => position >= diagnostic.from && position <= diagnostic.to);
  if (!diagnostics.length) return null;
  return {
    pos: diagnostics[0].from,
    end: diagnostics[0].to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-diagnostic-tooltip";
      for (const diagnostic of diagnostics) {
        const row = document.createElement("div");
        row.className = diagnostic.severity;
        row.textContent = diagnostic.message;
        dom.append(row);
      }
      return { dom };
    },
  };
});

const setEditorBlame = StateEffect.define<BlameRun[]>();
const setEditorBlameMode = StateEffect.define<boolean>();
let blameModeEnabled = false;

function blameDetails(blame: BlameRun): string {
  const details = [blame.authorName];
  if (blame.gitAuthor) details.push(`Git author: ${blame.gitAuthor.name} <${blame.gitAuthor.email}>`);
  if (blame.createdAt) details.push(new Date(blame.createdAt).toLocaleString());
  details.push(blame.commit ? `Commit ${blame.commit.slice(0, 7)}` : "Uncommitted");
  return details.join(" · ");
}

function readableBlameRuns(runs: readonly BlameRun[]): BlameRun[] {
  const merged: BlameRun[] = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (previous && previous.to === run.from && previous.authorId === run.authorId && previous.commit === run.commit) {
      previous.to = run.to;
      if (run.createdAt && (!previous.createdAt || run.createdAt < previous.createdAt)) previous.createdAt = run.createdAt;
      continue;
    }
    merged.push({ ...run });
  }
  return merged;
}

class BlameAuthorWidget extends WidgetType {
  constructor(readonly blame: BlameRun) { super(); }
  eq(other: BlameAuthorWidget): boolean {
    return this.blame.authorId === other.blame.authorId
      && this.blame.authorName === other.blame.authorName
      && this.blame.commit === other.blame.commit
      && this.blame.createdAt === other.blame.createdAt
      && this.blame.gitAuthor?.name === other.blame.gitAuthor?.name
      && this.blame.gitAuthor?.email === other.blame.gitAuthor?.email;
  }
  toDOM(): HTMLElement {
    const label = document.createElement("span");
    label.className = "cm-blame-author";
    label.textContent = this.blame.authorName;
    label.title = blameDetails(this.blame);
    label.style.setProperty("--blame-color", colorFor(this.blame.authorId || this.blame.authorName));
    return label;
  }
  ignoreEvent(): boolean { return true; }
}

const editorBlameField = StateField.define<BlameRun[]>({
  create: () => [],
  update(runs, transaction) {
    for (const effect of transaction.effects) if (effect.is(setEditorBlame)) return effect.value;
    if (!transaction.docChanged) return runs;
    return runs.map(run => ({
      ...run,
      from: transaction.changes.mapPos(run.from, 1),
      to: transaction.changes.mapPos(run.to, -1),
    })).filter(run => run.to > run.from);
  },
});

const editorBlameModeField = StateField.define<boolean>({
  create: () => blameModeEnabled,
  update(enabled, transaction) {
    for (const effect of transaction.effects) if (effect.is(setEditorBlameMode)) return effect.value;
    return enabled;
  },
});

function buildBlameDecorations(editorState: EditorState): DecorationSet {
  if (!editorState.field(editorBlameModeField)) return Decoration.none;
  const decorations: Range<Decoration>[] = [];
  for (const blame of readableBlameRuns(editorState.field(editorBlameField))) {
    const from = Math.max(0, Math.min(blame.from, editorState.doc.length));
    const to = Math.max(from, Math.min(blame.to, editorState.doc.length));
    if (to <= from) continue;
    const color = colorFor(blame.authorId || blame.authorName);
    decorations.push(Decoration.widget({ widget: new BlameAuthorWidget(blame), side: -1 }).range(from));
    decorations.push(Decoration.mark({
      class: "cm-blame-range",
      attributes: { title: blameDetails(blame), style: `--blame-color: ${color}` },
    }).range(from, to));
  }
  return Decoration.set(decorations, true);
}

class BlameDecorationsPlugin {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildBlameDecorations(view.state); }
  update(update: ViewUpdate): void {
    if (update.docChanged
      || update.startState.field(editorBlameField) !== update.state.field(editorBlameField)
      || update.startState.field(editorBlameModeField) !== update.state.field(editorBlameModeField)) {
      this.decorations = buildBlameDecorations(update.state);
    }
  }
}

const editorBlameDecorations = ViewPlugin.fromClass(BlameDecorationsPlugin, {
  decorations: plugin => plugin.decorations,
});

let blameRequestVersion = 0;
let blameRefreshTimer: ReturnType<typeof setTimeout> | undefined;

async function refreshEditorBlame(): Promise<void> {
  const view = state.view;
  const projectId = state.projectId;
  const relativePath = state.activeFile;
  if (!view || !projectId || !relativePath) return;
  const version = ++blameRequestVersion;
  try {
    const result = await request<{ path: string; revision: string; runs: BlameRun[] }>(`v1/blame?path=${encodeURIComponent(relativePath)}`);
    if (version !== blameRequestVersion || state.view !== view || state.projectId !== projectId || state.activeFile !== relativePath) return;
    view.dispatch({ effects: setEditorBlame.of(result.runs) });
  } catch (error) {
    console.error("blame refresh failed", error);
  }
}

function scheduleBlameRefresh(delay = 350): void {
  clearTimeout(blameRefreshTimer);
  blameRefreshTimer = setTimeout(() => { void refreshEditorBlame(); }, delay);
}

function navigableDiagnostics(): BuildDiagnostic[] {
  const seen = new Set<string>();
  return [...state.compileDiagnostics, ...state.staticDiagnostics]
    .filter((diagnostic): diagnostic is BuildDiagnostic & { path: string; line: number } => Boolean(diagnostic.path && diagnostic.line))
    .filter(diagnostic => {
      const key = `${diagnostic.path}:${diagnostic.line}:${diagnostic.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => Number(left.severity === "warning") - Number(right.severity === "warning")
      || left.path.localeCompare(right.path) || left.line - right.line || (left.from || 0) - (right.from || 0));
}

function applyEditorDiagnostics(): void {
  const diagnostics = navigableDiagnostics();
  if (!state.view) return;
  const source = state.view.state.doc;
  const active = diagnostics.filter(diagnostic => diagnostic.path === state.activeFile).map(diagnostic => {
    const line = source.line(Math.max(1, Math.min(source.lines, diagnostic.line!)));
    const exact = diagnostic.source === "latex" && diagnostic.from !== undefined && diagnostic.to !== undefined
      && diagnostic.from >= line.from && diagnostic.to <= line.to;
    const firstContent = line.text.search(/\S/);
    const from = exact ? diagnostic.from! : firstContent < 0 ? line.from : line.from + firstContent;
    const to = exact ? diagnostic.to! : Math.max(from + 1, line.to);
    return { ...diagnostic, from: Math.min(from, source.length), to: Math.min(Math.max(from + 1, to), source.length) };
  }).filter(diagnostic => diagnostic.to > diagnostic.from);
  state.view.dispatch({ effects: setEditorDiagnostics.of(active) });
}

let staticDiagnosticTimer: ReturnType<typeof setTimeout> | undefined;
let staticDiagnosticVersion = 0;
let staticSourceProject = "";
const staticSourceCache = new Map<string, string>();
async function refreshStaticDiagnostics(): Promise<void> {
  const version = ++staticDiagnosticVersion;
  const project = state.projectId;
  if (staticSourceProject !== project) {
    staticSourceProject = project;
    staticSourceCache.clear();
  }
  const activeFile = state.activeFile;
  const activeSource = state.view?.state.doc.toString();
  const candidates = state.files.filter(file => file.text && /\.(?:tex|bib)$/i.test(file.path));
  const sources = await Promise.all(candidates.map(async file => {
    if (file.path === activeFile && activeSource !== undefined) {
      staticSourceCache.set(file.path, activeSource);
      return { path: file.path, source: activeSource };
    }
    const cached = staticSourceCache.get(file.path);
    if (cached !== undefined) return { path: file.path, source: cached };
    const response = await fetch(projectApiUrl(`v1/files?path=${encodeURIComponent(file.path)}`));
    const source = response.ok ? await response.text() : "";
    staticSourceCache.set(file.path, source);
    return { path: file.path, source };
  }));
  if (version !== staticDiagnosticVersion || project !== state.projectId) return;
  state.staticDiagnostics = latexDiagnostics(sources);
  applyEditorDiagnostics();
}

function scheduleStaticDiagnostics(): void {
  clearTimeout(staticDiagnosticTimer);
  staticDiagnosticTimer = setTimeout(() => { void refreshStaticDiagnostics().catch(error => console.error("LaTeX diagnostics failed", error)); }, 350);
}

function editorExtensions(ytext: Y.Text, provider: Pick<WebsocketProvider, "awareness">, editable = true): Extension[] {
  const undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set() });
  return [
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
    lineNumbers({
      domEventHandlers: {
        contextmenu(view, line, event) {
          event.preventDefault();
          event.stopPropagation();
          openLineContextMenu(event as MouseEvent, view.state.doc.lineAt(line.from).number);
          return true;
        },
      },
    }),
    editorBlameField,
    editorBlameModeField,
    editorBlameDecorations,
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
    sourceEditorInteractions({
      followReference: link => { void followReference(link); },
      openContextMenu: openEditorContextMenu,
    }),
    reviewDecorations,
    reviewTooltip,
    editorDiagnosticField,
    editorDiagnosticTooltip,
    protectReviewStorage,
    EditorView.clipboardOutputFilter.of(source => stripReviewStorage(source)),
    keymap.of([...yUndoManagerKeymap, ...defaultKeymap, ...searchKeymap, indentWithTab]),
    EditorView.lineWrapping,
    EditorView.updateListener.of(update => {
      if (update.docChanged || update.selectionSet) {
        closeEditorContextMenu();
        closeLineContextMenu();
      }
      if (update.docChanged) {
        queueReviewRender();
        markPdfStale();
        state.compileDiagnostics = state.compileDiagnostics.filter(diagnostic => diagnostic.path !== state.activeFile);
        scheduleStaticDiagnostics();
        queueMicrotask(applyEditorDiagnostics);
        scheduleAutoCompile();
        scheduleBlameRefresh();
      }
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) {
        queueMicrotask(renderSelectionActions);
      }
    }),
    EditorView.theme({
      "&": { width: "100%", maxWidth: "100%", minWidth: "0", height: "100%", overflow: "hidden", backgroundColor: "var(--editor-background)", color: "var(--editor-foreground)", fontSize: "13px" },
      ".cm-scroller": { minWidth: "0", overflow: "auto", fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace", lineHeight: "1.55" },
      ".cm-gutters": { borderRight: "1px solid var(--border)", color: "var(--editor-gutter-foreground)", backgroundColor: "var(--editor-gutter)" },
      ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--editor-active-line)" },
      ".cm-content": { minWidth: "0", padding: "12px 0", caretColor: "var(--primary)" },
      ".cm-line": { padding: "0 14px" },
      ".cm-lineNumbers .cm-gutterElement.cm-diagnostic-line.error": { color: "#d92d20", fontWeight: "750" },
      ".cm-lineNumbers .cm-gutterElement.cm-diagnostic-line.warning": { color: "#b7791f", fontWeight: "700" },
      ".cm-blame-author": { display: "inline-flex", height: "16px", margin: "0 5px 0 2px", padding: "0 5px", alignItems: "center", borderRadius: "3px", backgroundColor: "var(--blame-color)", color: "white", fontFamily: "ui-sans-serif, sans-serif", fontSize: "9px", fontWeight: "700", lineHeight: "16px", verticalAlign: "1px", whiteSpace: "nowrap", cursor: "help" },
      ".cm-blame-range": { borderRadius: "2px", backgroundColor: "color-mix(in srgb, var(--blame-color) 16%, transparent)", boxShadow: "inset 0 -2px 0 color-mix(in srgb, var(--blame-color) 72%, transparent)", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone", cursor: "help" },
      ".cm-diagnostic-range.error": { textDecoration: "underline wavy #d92d20", textUnderlineOffset: "3px", textDecorationThickness: "1px" },
      ".cm-diagnostic-range.warning": { textDecoration: "underline wavy #d28a16", textUnderlineOffset: "3px", textDecorationThickness: "1px" },
      ".cm-diagnostic-tooltip": { maxWidth: "360px", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "6px", backgroundColor: "var(--card)", boxShadow: "0 10px 28px rgb(0 0 0 / 25%)", color: "var(--card-foreground)", fontFamily: "ui-sans-serif, sans-serif", fontSize: "11px" },
      ".cm-diagnostic-tooltip > div + div": { marginTop: "6px", paddingTop: "6px", borderTop: "1px solid var(--border)" },
      "&.cm-focused .cm-cursor": { borderLeftColor: "var(--primary)" },
      ".cm-review-comment": { padding: "1px 0", borderBottom: "2px solid #d28a16", borderRadius: "2px", backgroundColor: "var(--editor-comment)", cursor: "help" },
      ".cm-review-insertion": { padding: "1px 0", borderBottom: "2px solid #188064", backgroundColor: "var(--editor-insertion)", color: "var(--editor-insertion-foreground)", textDecoration: "underline", textDecorationColor: "#188064", textUnderlineOffset: "3px", cursor: "help" },
      ".cm-review-deletion": { marginLeft: "4px", padding: "1px 3px", borderRadius: "3px", backgroundColor: "var(--editor-deletion)", color: "var(--editor-deletion-foreground)", textDecoration: "line-through", textDecorationThickness: "1.5px", cursor: "help", whiteSpace: "pre-wrap" },
      ".cm-review-tooltip": { width: "min(320px, calc(100vw - 32px))", padding: "11px", border: "1px solid var(--border)", borderLeft: "3px solid #d28a16", borderRadius: "6px", backgroundColor: "var(--card)", boxShadow: "0 10px 28px rgb(0 0 0 / 25%)", color: "var(--card-foreground)", fontFamily: "ui-sans-serif, sans-serif" },
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
  closeTreeWriterEditor();
  closeEditorContextMenu();
  if (editorSession) editorSession.dispose();
  else {
    // Tests can install an in-memory editor without a websocket session.
    state.provider?.destroy();
    state.view?.destroy();
    state.doc?.destroy();
    state.persistence?.destroy();
  }
  editorSession = null;
  state.persistence = null;
  clearTimeout(autoCompileTimer);
  clearTimeout(staticDiagnosticTimer);
  clearTimeout(blameRefreshTimer);
  blameRequestVersion += 1;
  staticDiagnosticVersion += 1;
  state.provider = null;
  state.view = null;
  state.doc = null;
  state.selectionSuggestionIds = [];
  elements.selection_actions.hidden = true;
}

function setBlameMode(enabled: boolean): void {
  blameModeEnabled = enabled;
  syncBlameMenuItem();
  if (state.view) state.view.dispatch({ effects: setEditorBlameMode.of(enabled) });
  if (enabled) void refreshEditorBlame();
}

function syncBlameMenuItem(): void {
  // Radix renders menu content in a portal, so this node is intentionally
  // queried when the menu opens rather than captured in the static registry.
  const item = optionalElement("toggle-blame", HTMLElement);
  if (!item) return;
  item.setAttribute("aria-pressed", String(blameModeEnabled));
  item.classList.toggle("bg-accent", blameModeEnabled);
  const stateLabel = item.querySelector<HTMLElement>("#blame-menu-state");
  if (stateLabel) stateLabel.textContent = blameModeEnabled ? "On" : "Off";
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

type PresenceUser = { name: string; username: string | null; color: string };
type PresenceEntry = { clientId: number; user: PresenceUser; hasCursor: boolean };

function presenceEntry(clientId: number, value: Record<string, unknown>): PresenceEntry | null {
  const candidate = value.user as Record<string, unknown> | undefined;
  if (!candidate || typeof candidate.name !== "string" || !candidate.name.trim()) return null;
  const cursor = value.cursor as { anchor?: unknown; head?: unknown } | null | undefined;
  return {
    clientId,
    user: {
      name: candidate.name,
      username: typeof candidate.username === "string" && candidate.username ? candidate.username : null,
      color: typeof candidate.color === "string" ? candidate.color : colorFor(candidate.name),
    },
    hasCursor: Boolean(cursor?.anchor && cursor?.head),
  };
}

function jumpToCollaborator(clientId: number, name: string): void {
  const awarenessState = state.provider?.awareness.getStates().get(clientId);
  const cursor = awarenessState?.cursor as { head?: Y.RelativePosition } | null | undefined;
  const ytext = state.doc?.getText("content");
  if (!state.view || !state.doc || !ytext || !cursor?.head) {
    showToast(`${name} is not currently editing.`);
    return;
  }
  try {
    const position = Y.createAbsolutePositionFromRelativePosition(cursor.head, state.doc);
    if (!position || position.type !== ytext) {
      showToast(`${name} is not currently editing.`);
      return;
    }
    const anchor = Math.max(0, Math.min(position.index, state.view.state.doc.length));
    state.view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
    state.view.focus();
  } catch {
    showToast(`${name} is not currently editing.`);
  }
}

function updatePresence(): void {
  elements.presence.replaceChildren();
  if (!state.provider) return;
  const users = [...state.provider.awareness.getStates().entries()]
    .filter(([clientId]) => clientId !== state.provider.awareness.clientID)
    .map(([clientId, value]) => presenceEntry(clientId, value))
    .filter((entry): entry is PresenceEntry => entry !== null)
    .slice(0, 10);
  for (const { clientId, user, hasCursor } of users) {
    const avatar = document.createElement("button");
    avatar.type = "button";
    avatar.className = "presence-avatar group relative -ml-1.5 grid size-7 place-items-center rounded-full border-2 border-background text-[9px] font-bold text-white shadow-sm outline-none transition-transform hover:z-20 hover:-translate-y-0.5 focus-visible:z-20 focus-visible:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1";
    avatar.style.backgroundColor = user.color;
    avatar.setAttribute("aria-label", `Go to ${user.name}${user.username ? ` (@${user.username})` : ""}`);
    avatar.addEventListener("click", () => jumpToCollaborator(clientId, user.name));

    const initials = document.createElement("span");
    initials.textContent = Array.from(user.name.trim()).slice(0, 2).join("").toUpperCase();
    const tooltip = document.createElement("span");
    tooltip.id = `presence-details-${clientId}`;
    tooltip.className = "presence-tooltip pointer-events-none absolute right-0 top-full z-50 mt-2 hidden w-max min-w-44 max-w-64 gap-0.5 rounded-md border bg-card px-3 py-2 text-left font-normal text-card-foreground shadow-xl group-hover:grid group-focus-visible:grid";
    tooltip.setAttribute("role", "tooltip");
    avatar.setAttribute("aria-describedby", tooltip.id);
    const fullName = document.createElement("strong");
    fullName.className = "break-words text-xs font-semibold";
    fullName.textContent = user.name;
    const username = document.createElement("span");
    username.className = "break-all text-[10px] text-muted-foreground";
    username.textContent = user.username ? `@${user.username}` : "Guest collaborator";
    const status = document.createElement("span");
    status.className = `mt-1 text-[10px] ${hasCursor ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`;
    status.textContent = hasCursor ? "Editing this file" : "No active cursor";
    tooltip.append(fullName, username, status);
    avatar.append(initials, tooltip);
    elements.presence.append(avatar);
  }
}

function setAwareness() {
  if (!state.provider) return;
  const name = displayName();
  const color = colorFor(name);
  state.provider.awareness.setLocalStateField("user", { name, username: state.user?.username || null, color, colorLight: `${color}33` });
}

async function openFile(relativePath: string, options: { keepAuxiliary?: boolean; transient?: boolean } = {}): Promise<void> {
  const file = state.files.find(candidate => candidate.path === relativePath);
  if (!file) return;
  if (!options.keepAuxiliary) {
    fileTabs.activateFile();
    hideExpandedStructure();
  }
  setMobileFilesOpen(false);
  activeFileIsTransient = options.transient === true;
  if (relativePath === state.activeFile && (state.view || !file.text)) {
    renderFiles();
    return;
  }
  if (state.view && state.activeFile) staticSourceCache.set(state.activeFile, state.view.state.doc.toString());
  disconnectEditor();
  resetFilePreview();
  state.activeFile = relativePath;
  fileTree.reveal(relativePath);
  elements.active_file_label.textContent = relativePath;
  elements.binary_view.hidden = file.text;
  elements.editor.hidden = !file.text;
  elements.review_actions.hidden = !file.text;
  elements.suggest_edit.hidden = !state.projectCanEdit || !file.text;
  renderFiles();
  if (!file.text) {
    elements.sync_state.textContent = "Preview";
    renderReviews();
    await showFilePreview(file);
    return;
  }

  elements.sync_state.textContent = "Connecting";
  let guestAuthorId = localStorage.getItem("latexcoder-guest-author-id");
  if (!guestAuthorId) {
    guestAuthorId = `guest-${crypto.randomUUID()}`;
    localStorage.setItem("latexcoder-guest-author-id", guestAuthorId);
  }
  const session = new EditorSession({
    socketUrl: socketUrl(`v1/collab/${encodeURIComponent(state.projectId)}`),
    room: encodeRoom(relativePath),
    authorId: state.user?.username || guestAuthorId,
    authorName: displayName(),
    editable: state.projectCanEdit,
    persistenceKey: `project:${state.projectId}:${relativePath}`,
    parent: elements.editor,
    extensions: editorExtensions,
    callbacks: {
      onAwarenessChange: updatePresence,
      onSaved: () => {
        if (editorSession !== session) return;
        updateSyncStatus();
        scheduleBlameRefresh(0);
      },
      onStatusChange: () => { if (editorSession === session) updateSyncStatus(); },
      onUnsavedChange: unsaved => { state.unsaved = unsaved; },
      onSynced: () => {
        if (editorSession !== session) return;
        renderReviews();
        scheduleStaticDiagnostics();
        applyEditorDiagnostics();
        scheduleAutoCompile();
        scheduleBlameRefresh(0);
      },
    },
  });
  editorSession = session;
  state.doc = session.doc;
  state.provider = session.provider;
  state.persistence = session.persistence;
  state.view = session.view;
  applyEditorDiagnostics();
  setAwareness();
}

function applyReviewDecisions(ids: string[], decision: ReviewDecision): void {
  if (!state.view || !state.projectCanEdit) return;
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
    if (!state.projectCanEdit) {
      actions.hidden = true;
    } else if (group.kind === "comment") {
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
  if (!state.projectCanEdit) return showToast("This link has View access.");
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

elements.review_form.addEventListener("submit", (event: Event) => {
  event.preventDefault();
  if (!state.projectCanEdit) return;
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
elements.review_close.addEventListener("click", () => elements.review_dialog.close());
elements.review_cancel.addEventListener("click", () => elements.review_dialog.close());

function randomId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function refreshProject(open = false, recordOpen = false) {
  const data = await request<{ project: ProjectDetail }>(recordOpen ? "v1/project?opened=1" : "v1/project");
  const known = state.projects.find(project => project.id === data.project.id);
  if (known) Object.assign(known, { name: data.project.name, createdAt: data.project.createdAt, lastOpenedAt: data.project.lastOpenedAt, tags: data.project.tags, archived: data.project.archived });
  else if (state.user) {
    state.projects.push({ id: data.project.id, name: data.project.name, createdAt: data.project.createdAt, lastOpenedAt: data.project.lastOpenedAt, tags: data.project.tags, archived: data.project.archived, permissions: data.project.permissions });
  }
  state.projectCanManage = Boolean(data.project.permissions?.manage);
  state.projectCanEdit = Boolean(data.project.permissions?.edit);
  elements.collaborate_menu.hidden = !data.project.permissions?.collaborate;
  elements.project_name.textContent = data.project.name;
  document.title = `${data.project.name} · LaTeX Coder`;
  state.main = data.project.main;
  state.files = data.project.files;
  state.folders = data.project.folders || [];
  staticSourceProject = state.projectId;
  staticSourceCache.clear();
  state.settings = data.project.settings;
  renderFiles();
  syncProjectPermissionUi();
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
    void refreshStructure();
  }
  scheduleStaticDiagnostics();
  await refreshGit(false);
}

let projectSearchQuery = "";
let selectedProjectTag = "";
let projectArchiveView: "active" | "archived" = "active";

function projectTagButton(tag: string, selected: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"}`;
  button.textContent = tag;
  button.setAttribute("aria-pressed", String(selected));
  button.addEventListener("click", () => {
    selectedProjectTag = selectedProjectTag.toLocaleLowerCase() === tag.toLocaleLowerCase() ? "" : tag;
    renderProjects();
  });
  return button;
}

function renderProjectTagFilters(): void {
  const archived = projectArchiveView === "archived";
  const uniqueTags = new Map<string, string>();
  for (const tag of state.projects.filter(project => project.archived === archived).flatMap(project => project.tags)) {
    if (!uniqueTags.has(tag.toLocaleLowerCase())) uniqueTags.set(tag.toLocaleLowerCase(), tag);
  }
  const tags = [...uniqueTags.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  if (selectedProjectTag && !tags.some(tag => tag.toLocaleLowerCase() === selectedProjectTag.toLocaleLowerCase())) selectedProjectTag = "";
  elements.project_tag_filters.replaceChildren(...tags.map(tag => projectTagButton(tag, selectedProjectTag.toLocaleLowerCase() === tag.toLocaleLowerCase())));
  elements.project_tag_filters.hidden = tags.length === 0;
}

function renderProjects() {
  renderProjectTagFilters();
  elements.project_list.replaceChildren();
  const query = projectSearchQuery.trim().toLocaleLowerCase();
  const selectedTag = selectedProjectTag.toLocaleLowerCase();
  const archived = projectArchiveView === "archived";
  const projects = state.projects.filter(project => {
    if (project.archived !== archived) return false;
    if (selectedTag && !project.tags.some(tag => tag.toLocaleLowerCase() === selectedTag)) return false;
    return !query || project.name.toLocaleLowerCase().includes(query) || project.tags.some(tag => tag.toLocaleLowerCase().includes(query));
  });
  if (!projects.length) {
    const empty = document.createElement("p");
    empty.className = "px-5 py-12 text-center text-sm text-muted-foreground";
    empty.textContent = query || selectedTag ? "No projects match these filters." : archived ? "No archived projects." : "No active projects yet.";
    elements.project_list.append(empty);
    return;
  }
  for (const project of projects) {
    const row = document.createElement("article");
    row.className = "project-row grid min-h-20 cursor-pointer grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-3 outline-none last:border-b-0 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&>svg]:size-5 [&>svg]:text-primary max-sm:grid-cols-[1.5rem_minmax(0,1fr)_auto]";
    row.tabIndex = 0;
    row.setAttribute("role", "link");
    row.setAttribute("aria-label", `Open ${project.name}`);
    const openProject = () => { void openProjectPage(project.id); };
    row.addEventListener("click", event => {
      if ((event.target as Element).closest("button, a, details, summary")) return;
      openProject();
    });
    row.addEventListener("keydown", event => {
      if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      openProject();
    });
    row.innerHTML = '<i data-lucide="folder-kanban"></i>';
    const main = document.createElement("div");
    main.className = "project-row-main min-w-0";
    const name = document.createElement("strong");
    name.className = "block truncate text-sm font-semibold";
    name.textContent = project.name;
    const details = document.createElement("span");
    details.className = "mt-1 block text-[10px] text-muted-foreground";
    details.textContent = project.lastOpenedAt
      ? `Last opened ${new Date(project.lastOpenedAt).toLocaleString()}`
      : "Collaborative LaTeX project";
    main.append(name, details);
    if (project.tags.length) {
      const tags = document.createElement("div");
      tags.className = "mt-1.5 flex flex-wrap gap-1";
      tags.append(...project.tags.map(tag => projectTagButton(tag, selectedTag === tag.toLocaleLowerCase())));
      main.append(tags);
    }
    const menu = document.createElement("details");
    menu.className = "context-menu relative";
    menu.innerHTML = '<summary class="icon-button grid size-8 cursor-pointer list-none place-items-center rounded-md hover:bg-accent" title="Project actions"><i data-lucide="more-horizontal"></i></summary><div class="context-menu-panel absolute right-0 top-9 z-20 w-44 rounded-md border bg-card p-1 shadow-xl"></div>';
    const panel = menu.querySelector("div");
    const actions: Array<[string, string, () => void | Promise<void>, boolean?]> = [
      ...(project.permissions?.edit ? [["tag", "Edit tags", () => editProjectTags(project)]] as Array<[string, string, () => void | Promise<void>, boolean?]> : []),
      [project.archived ? "archive-restore" : "archive", project.archived ? "Unarchive" : "Archive", () => setProjectArchived(project, !project.archived)],
      ["download", "Download ZIP", () => downloadProject(project.id)],
      ...(project.permissions?.manage ? [
        ["pencil", "Rename", () => renameProject(project)],
        ["trash-2", "Delete project", () => deleteProject(project), true],
      ] as Array<[string, string, () => void | Promise<void>, boolean?]> : []),
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
    row.append(main, menu);
    elements.project_list.append(row);
  }
  createIcons({ icons: ICONS });
}

async function editProjectTags(project: ProjectSummary): Promise<void> {
  const value = await openActionDialog({
    title: "Edit project tags",
    label: "Tags",
    value: project.tags.join(", "),
    maxLength: 512,
    message: "Separate tags with commas. Use up to 12 tags.",
    submitLabel: "Save tags",
    allowEmpty: true,
  });
  if (typeof value !== "string") return;
  const tags = value.split(",").map(tag => tag.trim()).filter(Boolean);
  try {
    await request(`v1/projects/${encodeURIComponent(project.id)}/tags`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
    });
    await refreshProjects(project.id);
    showToast("Project tags updated.");
  } catch (error) { showToast(error.message); }
}

async function setProjectArchived(project: ProjectSummary, archived: boolean): Promise<void> {
  try {
    await request(`v1/projects/${encodeURIComponent(project.id)}/archive`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    await refreshProjects();
    showToast(archived ? "Project archived for your account." : "Project restored to active projects.");
  } catch (error) { showToast(error.message); }
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
  for (const dialog of collaborateDialogs) if (dialog.open) dialog.close();
  elements.editor_page.hidden = true;
  elements.projects_page.hidden = false;
  elements.auth_page.hidden = true;
  if (push && window.location.pathname !== "/projects") window.history.pushState({}, "", "/projects");
  document.title = "Projects · LaTeX Coder";
  void refreshProjects().catch(error => showToast(error.message));
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
  state.projectCanEdit = false;
  elements.collaborate_menu.hidden = true;
  syncProjectPermissionUi();
  syncAccountUi();
  if (push && window.location.pathname !== projectPageUrl(projectId)) window.history.pushState({}, "", projectPageUrl(projectId));
  document.title = `${project.name} · LaTeX Coder`;
  if (!changed && state.view) return;
  state.activeFile = "";
  await pdfController.reset();
  elements.build_output.textContent = "";
  await refreshProject(true, true);
  watchProjectFiles();
}

const pdfController = new PdfController({
  beforeOpenContextMenu: closeEditorContextMenu,
  elements: {
    contextMenu: document.getElementById("pdf-context-menu")!,
    document: elements.pdf_document,
    download: elements.pdf_download,
    empty: elements.empty_output,
    freshness: document.getElementById("pdf-freshness")!,
    goToSource: document.getElementById("pdf-go-to-source") as HTMLButtonElement,
    status: elements.pdf_status,
    view: elements.pdf_view,
  },
  modifierLabel: sourceModifierLabel,
  modifierPressed: sourceModifierPressed,
  pdfUrl: () => projectApiUrl("v1/build/pdf"),
  sourceAt: async (page, x, y, revision) => {
    const projectId = state.projectId;
    const destination = await request<SourcePosition>("v1/build/source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page, x, y, revision }),
    });
    if (state.projectId !== projectId) throw new Error("The project changed. Try again.");
    return destination;
  },
  revealSource,
  showError: showToast,
});
// Preserve the read-only E2E/debug surface while PdfController owns the data.
Object.defineProperties(state, {
  pdfDocument: { get: () => pdfController.document },
  pdfFitMode: { get: () => pdfController.mode },
  pdfRenderVersion: { get: () => pdfController.currentRenderVersion },
  pdfSourceRevision: { get: () => pdfController.sourceRevision },
  pdfZoom: { get: () => pdfController.currentZoom },
});

async function showPdf(force = false, priorityPage?: number) {
  await pdfController.show(force, priorityPage);
  await refreshPdfStatus();
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
    renderBuildErrors(result.build.log, result.build.errors);
    await showPdf(true);
    selectOutput("pdf");
    setOutputViewOpen(true);
    showToast("PDF compiled.");
  } catch (error) {
    const build = await request<{ build: BuildInfo }>("v1/build").catch((): null => null);
    if (state.projectId !== project) return;
    elements.build_output.textContent = build?.build?.log || error.message;
    renderBuildErrors(build?.build?.log || error.message, build?.build?.errors, true);
    selectOutput("log");
    setOutputViewOpen(true);
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
  pdfController.markStale();
}

async function refreshPdfStatus() {
  const project = state.projectId;
  if (!project || !pdfController.hasDocument) return;
  try {
    const { build } = await request<{ build: BuildInfo }>("v1/build");
    if (project !== state.projectId) return;
    pdfController.setStale(Boolean(build.stale || pdfController.sourceRevision !== build.sourceRevision));
  } catch { markPdfStale(); }
}

function resolveDiagnosticPath(pathname?: string): string | undefined {
  const normalized = pathname?.trim().replace(/^['"]|['"]$/g, "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized) {
    const exact = state.files.find(file => file.text && file.path === normalized);
    if (exact) return exact.path;
    const suffix = state.files.find(file => file.text && normalized.endsWith(`/${file.path}`));
    if (suffix) return suffix.path;
    const basename = normalized.split("/").at(-1);
    const basenameMatches = state.files.filter(file => file.text && file.path.split("/").at(-1) === basename);
    if (basenameMatches.length === 1) return basenameMatches[0].path;
  }
  return state.files.some(file => file.text && file.path === state.main) && (!normalized || normalized === "main.tex")
    ? state.main
    : undefined;
}

function renderBuildErrors(log: string, mappedErrors?: ReturnType<typeof compileErrors>, failed = false) {
  const list = document.getElementById("build-errors")!;
  list.replaceChildren();
  const errors = buildDiagnostics(log, mappedErrors, state.main);
  if (failed && !errors.some(error => error.severity === "error")) errors.unshift({ severity: "error", message: log.trim() || "Compilation failed." });
  const resolvedErrors = errors.map(error => ({ ...error, resolvedPath: error.line ? resolveDiagnosticPath(error.path) : undefined }));
  state.compileDiagnostics = resolvedErrors.map(({ resolvedPath, ...diagnostic }) => resolvedPath ? { ...diagnostic, path: resolvedPath } : diagnostic);
  applyEditorDiagnostics();
  const count = document.getElementById("log-error-count")!;
  const fatalCount = resolvedErrors.filter(error => error.severity === "error").length;
  count.textContent = String(fatalCount);
  count.hidden = !fatalCount;
  list.hidden = !errors.length;
  const heading = document.createElement("h3");
  heading.className = "mb-2 text-sm font-semibold";
  const warningCount = resolvedErrors.length - fatalCount;
  heading.textContent = `${fatalCount} ${fatalCount === 1 ? "error" : "errors"} · ${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`;
  list.append(heading);
  const items = document.createElement("ol");
  items.className = "list-decimal space-y-2 pl-5";
  list.append(items);
  const firstFatalIndex = resolvedErrors.findIndex(error => error.severity === "error");
  for (const [index, error] of resolvedErrors.entries()) {
    const item = document.createElement("li");
    item.className = "text-xs";
    const button = document.createElement("button");
    button.className = "block w-full rounded border p-2 text-left whitespace-pre-wrap break-words hover:bg-accent " + (error.severity === "error" ? "border-red-200 text-red-800 dark:border-red-900 dark:text-red-300" : "border-amber-200 text-amber-800 dark:border-amber-900 dark:text-amber-300");
    if (index === firstFatalIndex) {
      button.id = "first-fatal-error";
      const badge = document.createElement("strong");
      badge.className = "mb-1 block text-xs";
      badge.textContent = "First fatal error";
      button.append(badge);
    }
    const message = document.createElement("span");
    const displayedPath = error.resolvedPath || error.path;
    message.textContent = `${displayedPath ? `${displayedPath}${error.line ? `:${error.line}` : ""} · ` : ""}${error.message}`;
    button.append(message);
    if (error.resolvedPath && error.line) {
      button.title = "Go to source";
      const action = document.createElement("span");
      action.className = "mt-1 block text-[11px] underline";
      action.textContent = "Go to source";
      button.append(action);
      button.addEventListener("click", () => { void revealSource({ path: error.resolvedPath!, line: error.line!, from: error.from, to: error.to }).catch(error => showToast(error.message)); });
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
  elements.pdf_surface.hidden = name !== "pdf";
  elements.build_log.hidden = name !== "log";
  if (name === "log") elements.build_log.scrollTop = 0;
}

function setOutputViewOpen(open: boolean): void {
  workspaceController.setOutputViewOpen(open);
}

setInterval(() => {
  if (state.projectId && !elements.review_pane.hidden && !document.hidden) renderReviews();
}, 3000);

function renderGitStatus(gitState: GitState): void {
  state.git = gitState;
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
  const conflict = gitState.conflict;
  elements.git_conflict.hidden = !conflict;
  elements.git_conflict_branch.textContent = conflict?.branch || "";
  elements.git_resolve.hidden = !state.projectCanEdit || !conflict;
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
    await refreshEditorBlame();
    await versionHistory.refresh();
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

let currentAccessShare: ShareDetails | null = null;
let browserShareMode: "view" | "edit" = "edit";
let agentEditingMode: "direct" | "propose" = "direct";
const collaborateDialogs = [
  elements.access_dialog, elements.agent_access_dialog, elements.git_access_dialog,
  elements.collaborator_dialog, elements.access_secret_dialog,
];

function setBrowserShareMode(mode: "view" | "edit"): void {
  browserShareMode = mode;
  for (const button of [elements.share_view, elements.share_edit]) {
    const selected = button.dataset.shareMode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  }
  elements.share_link_label.textContent = mode === "view" ? "View link" : "Edit link";
  elements.browser_editing_description.textContent = mode === "view"
    ? "Signed-in users join as viewers. Guests can read the source and PDF but cannot change the project."
    : "Signed-in users join as collaborators. Guests can edit the project without creating an account.";
  if (currentAccessShare) {
    const path = mode === "view" ? currentAccessShare.viewPath : currentAccessShare.editPath;
    elements.share_link.value = `${window.location.origin}${path}`;
  }
}

function setAgentEditingMode(mode: "direct" | "propose"): void {
  agentEditingMode = mode;
  for (const button of [elements.agent_direct, elements.agent_propose]) {
    const selected = button.dataset.agentMode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  }
  elements.agent_command_label.textContent = mode === "direct" ? "Direct editing" : "Proposed changes";
  elements.agent_editing_description.textContent = mode === "direct"
    ? "Use this command when the agent should edit the live source directly, without review."
    : "Every agent edit is forced into Review for acceptance or rejection.";
  if (currentAccessShare) {
    const path = mode === "direct" ? currentAccessShare.agentPath : currentAccessShare.proposalAgentPath;
    elements.agent_command.value = `curl -fsSL '${window.location.origin}${path}'`;
  }
}

function displayAccessShare(share: ShareDetails): void {
  currentAccessShare = share;
  state.accessShareId = share.id;
  const cloneUrl = `${window.location.origin}${share.clonePath}`;
  elements.clone_command.value = `git clone ${cloneUrl}`;
  setBrowserShareMode(browserShareMode);
  setAgentEditingMode(agentEditingMode);
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
    role.textContent = member.role === "owner" ? "Owner" : member.role === "viewer" ? "View" : "Edit";
    row.append(name, role);
    return row;
  }));
}

type CollaboratePanel = "browser" | "agent" | "git" | "members" | "secrets";
async function openCollaboratePanel(panel: CollaboratePanel): Promise<void> {
  const project = state.projects.find(candidate => candidate.id === state.projectId);
  if (!project) return;
  if (panel === "members") await refreshProjectMembers();
  else {
    const result = await request<{ share: ShareDetails }>("v1/project/share", { method: "POST" });
    displayAccessShare(result.share);
  }
  elements.access_project_name.textContent = project.name;
  const dialog = {
    browser: elements.access_dialog,
    agent: elements.agent_access_dialog,
    git: elements.git_access_dialog,
    members: elements.collaborator_dialog,
    secrets: elements.access_secret_dialog,
  }[panel];
  dialog.showModal();
  if (panel === "browser") elements.share_link.select();
}

async function rotateShareSecret() {
  elements.access_secret_dialog.close();
  const confirmed = await openActionDialog({
    title: "Rotate access secrets?",
    message: "Your previous View, Edit, Agent editing, and Git links will stop working immediately, and their guest sessions will be signed out. Other registered collaborators and their links keep working.",
    submitLabel: "Rotate my secrets",
    danger: true,
  });
  if (!confirmed) {
    elements.access_secret_dialog.showModal();
    return;
  }
  const result = await request<{ share: ShareDetails }>("v1/project/share/rotate", { method: "POST" });
  displayAccessShare(result.share);
  elements.access_secret_dialog.showModal();
  showToast("Your secrets were rotated. Previous links no longer work.");
}

async function enterProjectDashboard(replace = false) {
  await refreshProjects();
  syncAccountUi();
  if (replace) window.history.replaceState({}, "", "/projects");
  showProjectsPage(false);
}

type InvitationMode = "single" | "reusable";
let invitationMode: InvitationMode = "single";
let invitationRequestVersion = 0;

function syncInvitationMode(): void {
  for (const [button, mode] of [[elements.invite_single, "single"], [elements.invite_reusable, "reusable"]] as const) {
    const selected = invitationMode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  }
  elements.invite_description.textContent = invitationMode === "single"
    ? "This link can register one account and expires in seven days. The new user can manage projects and invite others."
    : "This link can register multiple accounts for seven days. New users can manage projects and invite others.";
}

async function createInvitation(mode: InvitationMode = invitationMode): Promise<void> {
  invitationMode = mode;
  const requestVersion = ++invitationRequestVersion;
  syncInvitationMode();
  try {
    const result = await request<{ invitation: { path: string } }>("v1/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reusable: mode === "reusable" }),
    });
    if (requestVersion !== invitationRequestVersion) return;
    elements.invite_link.value = `${window.location.origin}${result.invitation.path}`;
    if (!elements.invite_dialog.open) elements.invite_dialog.showModal();
    elements.invite_link.select();
  } catch (error) {
    if (requestVersion === invitationRequestVersion) showToast(error.message);
  }
}

elements.display_name.value = localStorage.getItem("paper-display-name") || `Guest ${Math.floor(Math.random() * 900 + 100)}`;
elements.display_name.addEventListener("change", () => {
  elements.display_name.value = cleanMetadata(displayName()).slice(0, 28) || "Guest";
  localStorage.setItem("paper-display-name", elements.display_name.value);
  setAwareness();
});
elements.account_button.addEventListener("click", openAccountPanel);
onDynamicClick("editor-account-button", openAccountPanel);
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
onDynamicClick("back-projects", () => showProjectsPage());
onDynamicClick("editor-login", () => {
  window.history.pushState({}, "", "/login");
  showAuthPage();
});
for (const [id, panel] of [
  ["share-project", "browser"], ["collaborate-agent", "agent"],
  ["collaborate-git", "git"], ["collaborate-members", "members"],
  ["collaborate-secrets", "secrets"],
] as const) onDynamicClick(id, () => openCollaboratePanel(panel).catch(error => showToast(error.message)));
elements.download_project.addEventListener("click", (event: Event) => {
  event.preventDefault();
  downloadProject(state.projectId);
});
onDynamicClick("menu-download-project", () => downloadProject(state.projectId));
for (const [dialog, close, done] of [
  [elements.access_dialog, elements.access_close, elements.access_done],
  [elements.agent_access_dialog, elements.agent_access_close, elements.agent_access_done],
  [elements.git_access_dialog, elements.git_access_close, elements.git_access_done],
  [elements.collaborator_dialog, elements.collaborator_close, elements.collaborator_done],
  [elements.access_secret_dialog, elements.access_secret_close, elements.access_secret_done],
] as const) {
  close.addEventListener("click", () => dialog.close());
  done.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event: Event) => { event.preventDefault(); dialog.close(); });
}
elements.share_view.addEventListener("click", () => setBrowserShareMode("view"));
elements.share_edit.addEventListener("click", () => setBrowserShareMode("edit"));
elements.agent_direct.addEventListener("click", () => setAgentEditingMode("direct"));
elements.agent_propose.addEventListener("click", () => setAgentEditingMode("propose"));
elements.copy_share_link.addEventListener("click", () => copyText(elements.share_link.value, `${browserShareMode === "view" ? "View" : "Edit"} link copied.`));
elements.copy_agent_link.addEventListener("click", () => copyText(elements.agent_command.value, `${agentEditingMode === "direct" ? "Direct" : "Propose"} agent command copied.`));
elements.copy_clone_command.addEventListener("click", () => copyText(elements.clone_command.value, "Clone command copied."));
elements.rotate_share_secret.addEventListener("click", () => rotateShareSecret().catch(error => {
  showToast(error.message);
  if (!elements.access_secret_dialog.open) elements.access_secret_dialog.showModal();
}));
elements.invite_user.addEventListener("click", () => void createInvitation("single"));
onDynamicClick("editor-invite-user", () => void createInvitation("single"));
elements.invite_regenerate.addEventListener("click", () => void createInvitation());
elements.invite_single.addEventListener("click", () => void createInvitation("single"));
elements.invite_reusable.addEventListener("click", () => void createInvitation("reusable"));
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
onDynamicClick("editor-logout", logout);
const versionHistory = createVersionHistory({
  request,
  confirm: openActionDialog,
  project: () => state.projectId,
  editable: () => state.projectCanEdit,
  restored: async () => { await refreshProject(true); await refreshGit(); markPdfStale(); showToast("Version restored. Your previous work is saved in History."); },
});
async function openHistory(focusCheckpoint = false): Promise<void> {
  elements.git_dialog.showModal();
  await Promise.all([refreshGit(), versionHistory.refresh()]);
  if (focusCheckpoint) elements.git_message.focus();
}
onDynamicClick("git-button", () => { void openHistory(); });
onDynamicClick("history-save-checkpoint", () => { void openHistory(true); });
elements.git_close.addEventListener("click", () => elements.git_dialog.close());
elements.git_dialog.addEventListener("cancel", (event: Event) => {
  event.preventDefault();
  elements.git_dialog.close();
});
elements.git_refresh.addEventListener("click", () => { void refreshGit(); void versionHistory.refresh(); });
elements.git_commit.addEventListener("click", async () => {
  const result = await runGitAction("v1/git/commit", { message: elements.git_message.value }, "Checkpoint committed.");
  if (result) elements.git_message.value = "";
});
elements.git_resolve.addEventListener("click", async () => {
  const result = await runGitAction("v1/git/resolve", { message: elements.git_message.value }, "Conflict marked resolved.");
  if (result) elements.git_message.value = "";
});
elements.project_search.addEventListener("input", () => {
  projectSearchQuery = elements.project_search.value;
  renderProjects();
});
for (const [button, view] of [[elements.projects_active, "active"], [elements.projects_archived, "archived"]] as const) {
  button.addEventListener("click", () => {
    projectArchiveView = view;
    selectedProjectTag = "";
    elements.projects_active.classList.toggle("active", view === "active");
    elements.projects_archived.classList.toggle("active", view === "archived");
    elements.projects_active.setAttribute("aria-pressed", String(view === "active"));
    elements.projects_archived.setAttribute("aria-pressed", String(view === "archived"));
    renderProjects();
  });
}
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
elements.selection_comment.addEventListener("mousedown", (event: Event) => event.preventDefault());
elements.selection_comment.addEventListener("click", openReviewDialog);
elements.selection_accept.addEventListener("mousedown", (event: Event) => event.preventDefault());
elements.selection_accept.addEventListener("click", () => {
  applyReviewDecisions(state.selectionSuggestionIds, "accept");
  state.view?.focus();
});
elements.suggest_edit.addEventListener("click", () => {
  if (!state.projectCanEdit) return;
  state.suggesting = !state.suggesting;
  elements.suggest_edit.classList.toggle("active", state.suggesting);
  elements.suggest_edit.setAttribute("aria-pressed", String(state.suggesting));
  elements.suggest_edit.querySelector("span").textContent = state.suggesting ? "Suggesting" : "Suggest";
  showToast(state.suggesting ? "Suggestion mode on." : "Suggestion mode off.");
  state.view?.focus();
});
elements.open_pdf.addEventListener("click", () => {
  selectOutput("pdf");
  setOutputViewOpen(true);
});
elements.close_output.addEventListener("click", () => setOutputViewOpen(false));
function updatePdfFitButtons(): void {
  for (const [button, mode] of [[elements.pdf_fit_width, "width"], [elements.pdf_fit_page, "page"]] as const) {
    const active = pdfController.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}
function setPdfFitMode(mode: "width" | "page"): void {
  pdfController.setFitMode(mode);
  updatePdfFitButtons();
}
elements.pdf_fit_width.addEventListener("click", () => setPdfFitMode("width"));
elements.pdf_fit_page.addEventListener("click", () => setPdfFitMode("page"));
updatePdfFitButtons();
elements.pdf_zoom_out.addEventListener("click", () => {
  pdfController.zoomBy(-0.15);
});
elements.pdf_zoom_in.addEventListener("click", () => {
  pdfController.zoomBy(0.15);
});
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
let uploadFolder = "";
function openUpload(folderPath = ""): void {
  uploadFolder = folderPath;
  elements.upload_input.click();
}
elements.upload_input.addEventListener("change", async () => {
  try {
    for (const file of elements.upload_input.files) {
      const archive = file.name.toLowerCase().endsWith(".zip");
      const relativePath = uploadFolder && !archive ? `${uploadFolder}/${file.name}` : file.name;
      await request(archive ? "v1/files/import" : `v1/files?path=${encodeURIComponent(relativePath)}`, {
        method: archive ? "POST" : "PUT",
        headers: { "Content-Type": archive ? "application/zip" : "application/octet-stream" },
        body: file,
      });
    }
    await refreshProject();
    showToast("Upload complete.");
  } catch (error) { showToast(error.message); }
  elements.upload_input.value = "";
  uploadFolder = "";
});
async function newFile(folderPath = "") {
  const name = await openActionDialog({
    title: "New file",
    label: "File path",
    value: folderPath ? `${folderPath}/chapter.tex` : "chapter.tex",
    submitLabel: "Create file",
  });
  if (!name) return;
  try {
    await request(`v1/files?path=${encodeURIComponent(String(name))}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "",
    });
    await refreshProject();
    await openFile(String(name));
  } catch (error) { showToast(error.message); }
}
async function renameEntry(target: string, folder: boolean): Promise<void> {
  const name = await openActionDialog({
    title: folder ? "Rename folder" : "Rename file",
    label: "Path",
    value: target,
    submitLabel: "Rename",
  });
  if (!name || name === target) return;
  try { await moveFilePath(target, String(name)); }
  catch (error) { showToast(error.message); }
}

async function deleteEntry(target: string, folder: boolean): Promise<void> {
  if (!folder) return deleteFile(target);
  const confirmed = await openActionDialog({
    title: "Delete folder?",
    message: `Move “${target}” and all files inside it to Recently deleted? They can be restored.`,
    submitLabel: "Delete folder",
    danger: true,
  });
  if (!confirmed) return;
  try {
    const wasActive = state.activeFile.startsWith(`${target}/`);
    if (wasActive) disconnectEditor();
    await request(`v1/files?path=${encodeURIComponent(target)}`, { method: "DELETE" });
    if (wasActive) state.activeFile = "";
    await refreshProject(wasActive);
    showToast("Folder deleted.");
  } catch (error) {
    showToast(error.message);
    await refreshProject(state.activeFile.startsWith(`${target}/`));
  }
}

async function deleteFile(target: string): Promise<void> {
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
async function moveFilePath(from: string, to: string) {
  const wasActive = state.activeFile === from || state.activeFile.startsWith(`${from}/`);
  await request("v1/files/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to }) });
  fileTabs.move(from, to);
  if (wasActive) { disconnectEditor(); state.activeFile = to + state.activeFile.slice(from.length); }
  fileTree.reveal(to);
  await refreshProject(wasActive);
  markPdfStale();
}

async function newFolder(prefix = "") {
  const name = await openActionDialog({ title: "New folder", label: "Folder path", value: prefix ? prefix + "/folder" : "folder", submitLabel: "Create" });
  if (!name) return;
  try { await request("v1/files/folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: name }) }); await refreshProject(); }
  catch (error) { showToast(error.message); }
}

const aboutDialog = document.getElementById("about-dialog") as HTMLDialogElement;
for (const id of ["projects-about", "editor-about"]) {
  document.getElementById(id)!.addEventListener("click", () => aboutDialog.showModal());
}
document.getElementById("about-close")!.addEventListener("click", () => aboutDialog.close());

const settingsDialog = document.getElementById("settings-dialog") as HTMLDialogElement;
onDynamicClick("project-settings", async () => {
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
document.getElementById("settings-close")!.addEventListener("click", () => settingsDialog.close());
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
onDynamicClick("menu-open-trash", () => { trashDialog.showModal(); void renderTrash().catch(error => showToast(error.message)); });

const editorContextMenu = document.getElementById("editor-context-menu")!;
const lineContextMenu = document.getElementById("line-context-menu")!;
const lineContextReference = document.getElementById("line-context-reference")!;
const copyLineReference = document.getElementById("copy-line-reference") as HTMLButtonElement;
let contextView: EditorView | null = null;
let currentLineReference = "";

function canonicalContext(view: EditorView): { view: EditorView; from: number; to: number } | null {
  const selection = view.state.selection.main;
  if (view === state.view) return { view, from: selection.from, to: selection.to };
  const projection = projectedSourceViews.get(view);
  const sourceView = state.view;
  if (!projection || !sourceView) return null;
  const from = projection.sourcePosition(selection.from);
  const to = projection.sourcePosition(selection.to);
  return from === null || to === null ? null : { view: sourceView, from, to };
}

function closeEditorContextMenu() {
  editorContextMenu.hidden = true;
  if (contextView) delete contextView.dom.dataset.contextMenu;
  contextView = null;
}

function closeLineContextMenu(): void {
  lineContextMenu.hidden = true;
  currentLineReference = "";
}

function openLineContextMenu(event: MouseEvent, lineNumber: number): void {
  closeEditorContextMenu();
  currentLineReference = `${state.activeFile}:${lineNumber}`;
  lineContextReference.textContent = currentLineReference;
  lineContextMenu.hidden = false;
  const bounds = lineContextMenu.getBoundingClientRect();
  lineContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`;
  lineContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`;
  copyLineReference.focus({ preventScroll: true });
}

function openEditorContextMenu(event: MouseEvent, view: EditorView) {
  closeLineContextMenu();
  contextView = view;
  view.dom.dataset.contextMenu = "open";
  const selection = view.state.selection.main;
  const canonical = canonicalContext(view);
  const overlapsReview = canonical
    ? parseReviews(canonical.view.state.doc.toString()).some(item => canonical.from < item.to && canonical.to > item.from)
    : false;
  editorContextMenu.querySelectorAll<HTMLButtonElement>("[data-editor-action]").forEach(button => {
    const action = button.dataset.editorAction;
    const manager = editorUndoManagers.get(view);
    const writeAction = action === "undo" || action === "redo" || action === "cut" || action === "delete" || action === "paste" || action === "comment";
    button.disabled = !state.projectCanEdit && writeAction ? true
      : action === "undo" ? !manager?.undoStack.length
      : action === "redo" ? !manager?.redoStack.length
      : action === "comment" ? selection.empty || overlapsReview || !canonical
      : action === "copy" || action === "cut" || action === "delete" ? selection.empty
      : action === "select-all" ? !view.state.doc.length
      : action === "pdf" ? !canonical || !state.activeFile.endsWith(".tex") || !state.projectId
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
      elements.pdf_status.textContent = pdfController.hasDocument ? "PDF ready" : "No compiled PDF";
    }
  }
  if (state.projectId !== project || state.view !== view) return;
  selectOutput("pdf");
  const revealedOutput = workspaceController.isNarrow || workspaceController.isOutputHidden;
  if (revealedOutput) {
    setOutputViewOpen(true);
  }
  await pdfController.revealPosition(position, revealedOutput);
  if (state.projectId !== project) throw new Error("The project changed. Try again.");
  await refreshPdfStatus();
}

editorContextMenu.addEventListener("click", async event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-editor-action]");
  const view = contextView;
  if (!button || button.disabled || !view) return;
  const action = button.dataset.editorAction;
  const doc = view.state.doc;
  const selection = view.state.selection;
  closeEditorContextMenu();
  view.focus();
  try {
    if (action === "undo") { editorUndoManagers.get(view)?.undo(); return; }
    if (action === "redo") { editorUndoManagers.get(view)?.redo(); return; }
    if (action === "select-all") { selectAll(view); return; }
    if (action === "comment" || action === "pdf") {
      const canonical = canonicalContext(view);
      if (!canonical) throw new Error("The source range changed. Reopen the TreeWriter editor.");
      canonical.view.dispatch({ selection: { anchor: canonical.from, head: canonical.to } });
      if (action === "comment") openReviewDialog();
      else await goToPdf(canonical.view);
      return;
    }
    if (action === "copy" || action === "cut") {
      const text = selection.ranges.map(range => stripReviewStorage(doc.sliceString(range.from, range.to))).join("\n");
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else if (!document.execCommand("copy")) throw new Error("Clipboard access unavailable");
      if (action === "copy") return;
    }
    const inserted = action === "paste" ? await navigator.clipboard.readText() : "";
    if (view.state.doc !== doc || !view.state.selection.eq(selection)) throw new Error("The selection changed. Try again.");
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
copyLineReference.addEventListener("click", async () => {
  const reference = currentLineReference;
  closeLineContextMenu();
  if (reference) await copyText(reference, `Copied ${reference}`);
});
lineContextMenu.addEventListener("keydown", event => {
  if (event.key !== "Escape" && event.key !== "Tab") return;
  event.preventDefault();
  closeLineContextMenu();
  state.view?.focus();
});
document.addEventListener("pointerdown", event => {
  if (!editorContextMenu.contains(event.target as Node)) closeEditorContextMenu();
  if (!lineContextMenu.contains(event.target as Node)) closeLineContextMenu();
}, true);
window.addEventListener("blur", () => { closeEditorContextMenu(); closeLineContextMenu(); });
window.addEventListener("resize", () => { closeEditorContextMenu(); closeLineContextMenu(); });
document.addEventListener("scroll", event => {
  if (!editorContextMenu.contains(event.target as Node)) closeEditorContextMenu();
  if (!lineContextMenu.contains(event.target as Node)) closeLineContextMenu();
}, true);

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
  setOutputViewOpen(false);
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
onDynamicClick("project-search-menu", openProjectSearch);
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
  if ((sourceModifierIsMeta ? event.metaKey : event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f" && !elements.editor_page.hidden) {
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

const workspaceController = new WorkspaceController({
  closeFiles: elements.close_files,
  closeOutput: elements.close_output,
  editorPane: elements.editor_pane,
  fileList: elements.file_list,
  filesPane: elements.files_pane,
  filesResize: document.getElementById("files-resize")!,
  openPdf: elements.open_pdf,
  outputPane: elements.output_pane,
  outputResize: document.getElementById("output-resize")!,
  structureResize: elements.structure_resize,
  toggleFiles: elements.toggle_files,
  toggleFilesColumn: elements.toggle_files_column,
  toggleOutputColumn: elements.toggle_output_column,
  viewSwitch: elements.workspace_view_switch,
  workspace: document.getElementById("workspace")!,
});

function setMobileFilesOpen(open: boolean): void {
  workspaceController.setMobileFilesOpen(open);
}
onDynamicClick("toggle-blame", () => setBlameMode(!blameModeEnabled));
document.getElementById("history-menu")!.addEventListener("click", () => requestAnimationFrame(syncBlameMenuItem));
document.getElementById("toggle-review")!.addEventListener("click", () => setReviewOpen(Boolean(elements.review_pane.hidden)));
document.getElementById("close-review")!.addEventListener("click", () => setReviewOpen(false));
document.querySelectorAll<HTMLElement>("[data-output]:not([data-output=review])").forEach(button => button.addEventListener("click", () => {
  if (button.dataset.output === "pdf" || button.dataset.output === "review" || button.dataset.output === "log") selectOutput(button.dataset.output);
}));
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
