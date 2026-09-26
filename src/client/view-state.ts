export type EditorScrollState = { left: number; top: number };
export type PdfViewState = {
  fitMode: "width" | "page";
  page: number;
  xRatio: number;
  yRatio: number;
  zoom: number;
};

type StoredEditorScrollState = EditorScrollState & { updatedAt: number };
type ProjectViewState = { files?: Record<string, StoredEditorScrollState>; pdf?: PdfViewState };
type StoredViewState = { version: 1; projects: Record<string, ProjectViewState> };

const STORAGE_KEY = "latexcoder-view-state";
const MAX_FILES_PER_PROJECT = 200;

export function loadEditorScroll(projectId: string, path: string): EditorScrollState | null {
  const value = read().projects[projectId]?.files?.[path];
  return value && validNumber(value.top) && validNumber(value.left)
    ? { top: Math.max(0, value.top), left: Math.max(0, value.left) }
    : null;
}

export function saveEditorScroll(projectId: string, path: string, value: EditorScrollState): void {
  if (!projectId || !path || !validNumber(value.top) || !validNumber(value.left)) return;
  update(state => {
    const project = state.projects[projectId] ||= {};
    const files = project.files ||= {};
    files[path] = { top: Math.max(0, value.top), left: Math.max(0, value.left), updatedAt: Date.now() };
    const stale = Object.entries(files)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(MAX_FILES_PER_PROJECT);
    for (const [stalePath] of stale) delete files[stalePath];
  });
}

export function loadPdfView(projectId: string): PdfViewState | null {
  const value = read().projects[projectId]?.pdf;
  if (!value || !["width", "page"].includes(value.fitMode)
    || !validNumber(value.page) || !validNumber(value.xRatio)
    || !validNumber(value.yRatio) || !validNumber(value.zoom)) return null;
  return {
    fitMode: value.fitMode,
    page: Math.max(1, Math.floor(value.page)),
    xRatio: clamp(value.xRatio, 0, 1),
    yRatio: clamp(value.yRatio, 0, 1),
    zoom: clamp(value.zoom, 0.5, 2),
  };
}

export function savePdfView(projectId: string, value: PdfViewState): void {
  if (!projectId || !validNumber(value.page) || !validNumber(value.xRatio)
    || !validNumber(value.yRatio) || !validNumber(value.zoom)) return;
  update(state => {
    const project = state.projects[projectId] ||= {};
    project.pdf = {
      fitMode: value.fitMode,
      page: Math.max(1, Math.floor(value.page)),
      xRatio: clamp(value.xRatio, 0, 1),
      yRatio: clamp(value.yRatio, 0, 1),
      zoom: clamp(value.zoom, 0.5, 2),
    };
  });
}

function read(): StoredViewState {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as StoredViewState | null;
    if (value?.version === 1 && value.projects && typeof value.projects === "object") return value;
  } catch { /* View persistence is optional and corrupted state is ignored. */ }
  return { version: 1, projects: {} };
}

function update(change: (state: StoredViewState) => void): void {
  try {
    const state = read();
    change(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* View persistence is optional. */ }
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
