import { localizedAttribute, localizedText, t } from './i18n.ts';
import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, type TooltipView } from "@codemirror/view";
import { getDocument, type PDFDocumentLoadingTask } from "pdfjs-dist/build/pdf.mjs";

import { labeledGraphics, resolveGraphicsPath } from "../shared/assets.ts";
import { referenceLinks } from "../shared/references.ts";
import type { ProjectFile } from "../shared/api-schema.ts";

type ImageHoverData = {
  projectId(): string;
  activeFile(): string;
  files(): ProjectFile[];
  fileUrl(path: string): string;
  readFile(path: string): Promise<string>;
  sourceForActiveFile?(editorSource: string): string;
};

type TexSource = { path: string; source: string };
type TexSourceCache = { projectId: string; signature: string; loadedAt: number; sources: TexSource[] };

const IMAGE_PATTERN = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const MAX_PREVIEW_WIDTH = 420;
const MAX_PREVIEW_HEIGHT = 280;
const SOURCE_CACHE_MS = 3_000;

function tooltipShell(path: string, titleText = "Image preview"): { dom: HTMLElement; preview: HTMLElement; status: HTMLElement } {
  const dom = document.createElement("div");
  dom.className = "cm-image-tooltip";
  const header = document.createElement("header");
  const title = document.createElement("strong");
  localizedText(title, () => t(titleText));
  const status = document.createElement("span");
  localizedText(status, () => t("Loading"));
  header.append(title, status);
  const preview = document.createElement("div");
  preview.className = "cm-image-preview";
  const footer = document.createElement("footer");
  localizedText(footer, () => path);
  dom.append(header, preview, footer);
  return { dom, preview, status };
}

function errorMessage(preview: HTMLElement, status: HTMLElement, message: string): void {
  preview.classList.add("error");
  localizedText(preview, () => message);
  localizedText(status, () => t("Unavailable"));
}

function imageTooltip(path: string, url: string): TooltipView {
  const { dom, preview, status } = tooltipShell(path);
  const image = document.createElement("img");
  image.alt = path;
  image.onload = () => {
    localizedText(status, () => `${image.naturalWidth} × ${image.naturalHeight}`);
    preview.classList.add("loaded");
  };
  image.onerror = () => errorMessage(preview, status, t("Image could not be loaded"));
  image.src = url;
  preview.append(image);
  return { dom, destroy: () => { image.src = ""; } };
}

function pdfTooltip(path: string, url: string): TooltipView {
  const { dom, preview, status } = tooltipShell(path, "PDF preview");
  const canvas = document.createElement("canvas");
  localizedAttribute(canvas, "aria-label", () => t("First page of {{v0}}", { v0: path }));
  preview.append(canvas);
  const abort = new AbortController();
  let loadingTask: PDFDocumentLoadingTask | null = null;
  let destroyed = false;

  void (async () => {
    try {
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error(t("Request failed ({{v0}})", { v0: response.status }));
      loadingTask = getDocument({ data: await response.arrayBuffer() });
      const pdf = await loadingTask.promise;
      if (destroyed) return;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(1.5, MAX_PREVIEW_WIDTH / base.width, MAX_PREVIEW_HEIGHT / base.height);
      const viewport = page.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      await page.render({
        canvas,
        canvasContext: canvas.getContext("2d"),
        viewport,
        transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      }).promise;
      if (!destroyed) {
        preview.classList.add("loaded");
        localizedText(status, () => t("pages", { count: pdf.numPages }));
      }
    } catch (error) {
      if (!destroyed && !abort.signal.aborted) {
        console.error("graphics PDF hover preview failed", error);
        errorMessage(preview, status, t("PDF preview could not be rendered"));
      }
    }
  })();

  return {
    dom,
    destroy: () => {
      destroyed = true;
      abort.abort();
      if (loadingTask) void loadingTask.destroy();
    },
  };
}

function unavailableTooltip(path: string, message: string): TooltipView {
  const { dom, preview, status } = tooltipShell(path);
  errorMessage(preview, status, message);
  return { dom };
}

export function imageHover(data: ImageHoverData): Extension {
  let sourceCache: TexSourceCache | null = null;

  const projectTexSources = async (activeSource: string): Promise<TexSource[]> => {
    const projectId = data.projectId();
    const activeFile = data.activeFile();
    const files = data.files()
      .filter(file => file.text && file.path.toLowerCase().endsWith(".tex"))
      .sort((left, right) => left.path.localeCompare(right.path));
    const signature = files.map(file => `${file.path}:${file.size}`).join("\0");
    if (sourceCache?.projectId === projectId && sourceCache.signature === signature && Date.now() - sourceCache.loadedAt < SOURCE_CACHE_MS) {
      return sourceCache.sources.map(source => source.path === activeFile ? { ...source, source: activeSource } : source);
    }
    const sources = await Promise.all(files.map(async file => ({
      path: file.path,
      source: file.path === activeFile ? activeSource : await data.readFile(file.path),
    })));
    sourceCache = { projectId, signature, loadedAt: Date.now(), sources };
    return sources;
  };

  return [
    hoverTooltip(async (view, position) => {
      const activeSource = view.state.doc.toString();
      const link = referenceLinks(activeSource)
        .find(candidate => ["asset", "label"].includes(candidate.kind) && position >= candidate.from && position <= candidate.to);
      if (!link) return null;
      const projectId = data.projectId();
      const activeFile = data.activeFile();
      let asset = link.key;
      let originFile = activeFile;
      if (link.kind === "label") {
        const sources = await projectTexSources(data.sourceForActiveFile?.(activeSource) ?? activeSource);
        if (projectId !== data.projectId() || activeFile !== data.activeFile()) return null;
        let target: { path: string; asset: string } | undefined;
        for (const source of sources) {
          const graphic = labeledGraphics(source.source).find(candidate => candidate.label === link.key);
          if (graphic) { target = { path: source.path, asset: graphic.asset }; break; }
        }
        if (!target) return null;
        asset = target.asset;
        originFile = target.path;
      }
      const path = resolveGraphicsPath(asset, originFile, data.files());
      return {
        pos: link.from,
        end: link.to,
        above: true,
        create: () => {
          if (projectId !== data.projectId() || activeFile !== data.activeFile()) return unavailableTooltip(asset, t("Preview is no longer current"));
          if (!path) return unavailableTooltip(asset, t("Project file not found"));
          const url = data.fileUrl(path);
          if (IMAGE_PATTERN.test(path)) return imageTooltip(path, url);
          if (/\.pdf$/i.test(path)) return pdfTooltip(path, url);
          return unavailableTooltip(path, t("This image format cannot be previewed"));
        },
      };
    }, { hoverTime: 650, hideOnChange: true }),
    EditorView.baseTheme({
      ".cm-image-tooltip": {
        width: "min(460px, calc(100vw - 32px))", padding: "10px 11px",
        border: "1px solid var(--border)", borderRadius: "6px",
        backgroundColor: "var(--card)", boxShadow: "0 10px 28px rgb(0 0 0 / 25%)",
        color: "var(--card-foreground)", fontFamily: "ui-sans-serif, sans-serif",
      },
      ".cm-image-tooltip header": { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", marginBottom: "8px" },
      ".cm-image-tooltip header strong": { fontSize: "11px" },
      ".cm-image-tooltip header span": { color: "var(--muted-foreground)", fontSize: "10px" },
      ".cm-image-preview": {
        display: "flex", width: "100%", height: "180px", alignItems: "center", justifyContent: "center",
        overflow: "hidden", borderRadius: "4px", backgroundColor: "var(--muted)", color: "var(--muted-foreground)", fontSize: "11px",
      },
      ".cm-image-preview img, .cm-image-preview canvas": { display: "block", maxWidth: "100%", maxHeight: `${MAX_PREVIEW_HEIGHT}px`, objectFit: "contain" },
      ".cm-image-preview.loaded": { height: "auto", minHeight: "80px" },
      ".cm-image-preview.error": { height: "96px" },
      ".cm-image-tooltip footer": { marginTop: "7px", overflow: "hidden", paddingTop: "7px", borderTop: "1px solid var(--border)", color: "var(--muted-foreground)", fontSize: "10px", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    }),
  ];
}
