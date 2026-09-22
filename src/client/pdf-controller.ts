import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist/build/pdf.mjs";
import type { PdfBox, PdfPosition, SourcePosition } from "./types.ts";

type PdfElements = {
  contextMenu: HTMLElement;
  document: HTMLElement;
  download: HTMLAnchorElement;
  empty: HTMLElement;
  freshness: HTMLElement;
  goToSource: HTMLButtonElement;
  status: HTMLElement;
  view: HTMLElement;
};

type PdfControllerOptions = {
  beforeOpenContextMenu: () => void;
  elements: PdfElements;
  modifierLabel: string;
  modifierPressed: (event: MouseEvent) => boolean;
  pdfUrl: () => URL;
  sourceAt: (page: number, x: number, y: number, revision: string | null) => Promise<SourcePosition>;
  revealSource: (position: SourcePosition) => Promise<void>;
  showError: (message: string) => void;
};

type PdfHighlight = { boxes: PdfBox[]; expires: number };

export class PdfController {
  private documentProxy: PDFDocumentProxy | null = null;
  private fitMode: "width" | "page" = "width";
  private highlights: PdfHighlight | null = null;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private priorityPage: number | undefined;
  private renderVersion = 0;
  private requestVersion = 0;
  private resizeFrame = 0;
  private sourceRevisionValue: string | null = null;
  private zoom = 1;
  private contextAction: (() => Promise<void>) | null = null;
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly options: PdfControllerOptions) {
    const bounds = options.elements.view.getBoundingClientRect();
    let size = `${bounds.width}x${bounds.height}`;
    this.resizeObserver = new ResizeObserver(() => {
      const nextBounds = options.elements.view.getBoundingClientRect();
      const nextSize = `${nextBounds.width}x${nextBounds.height}`;
      if (nextSize === size) return;
      size = nextSize;
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = requestAnimationFrame(() => {
        if (this.documentProxy) void this.render(this.priorityPage);
      });
    });
    this.resizeObserver.observe(options.elements.view);
    options.elements.goToSource.addEventListener("click", () => {
      const action = this.contextAction;
      this.closeContextMenu();
      void action?.();
    });
    document.addEventListener("pointerdown", event => {
      if (!options.elements.contextMenu.contains(event.target as Node)) this.closeContextMenu();
    }, true);
    document.addEventListener("keydown", event => { if (event.key === "Escape") this.closeContextMenu(); });
    options.elements.view.addEventListener("scroll", () => this.closeContextMenu());
    window.addEventListener("resize", () => this.closeContextMenu());
  }

  get hasDocument(): boolean { return this.documentProxy !== null; }
  get document(): PDFDocumentProxy | null { return this.documentProxy; }
  get mode(): "width" | "page" { return this.fitMode; }
  get currentRenderVersion(): number { return this.renderVersion; }
  get sourceRevision(): string | null { return this.sourceRevisionValue; }
  get currentZoom(): number { return this.zoom; }

  async reset(): Promise<void> {
    this.requestVersion += 1;
    this.renderVersion += 1;
    cancelAnimationFrame(this.resizeFrame);
    if (this.loadingTask) await this.loadingTask.destroy().catch(() => {});
    this.loadingTask = null;
    this.documentProxy = null;
    this.highlights = null;
    this.sourceRevisionValue = null;
    this.priorityPage = undefined;
    this.closeContextMenu();
    this.options.elements.freshness.hidden = true;
    this.options.elements.document.replaceChildren();
    this.options.elements.document.hidden = true;
    this.options.elements.empty.hidden = false;
    this.options.elements.status.textContent = "No compiled PDF";
  }

  setFitMode(mode: "width" | "page"): void {
    this.fitMode = mode;
    this.zoom = 1;
    void this.render();
  }

  zoomBy(delta: number): void {
    this.zoom = Math.max(0.5, Math.min(2, this.zoom + delta));
    void this.render();
  }

  markStale(): void {
    if (!this.documentProxy) return;
    this.options.elements.freshness.hidden = false;
    this.options.elements.freshness.textContent = "PDF outdated";
  }

  setStale(stale: boolean): void {
    this.options.elements.freshness.hidden = !stale;
    this.options.elements.freshness.textContent = stale ? "PDF outdated" : "";
  }

  async show(force = false, priorityPage?: number): Promise<void> {
    this.closeContextMenu();
    if (force) this.priorityPage = priorityPage;
    const requestVersion = ++this.requestVersion;
    const downloadUrl = this.options.pdfUrl();
    downloadUrl.searchParams.set("v", String(Date.now()));
    downloadUrl.searchParams.set("cached", "1");
    this.options.elements.download.href = downloadUrl.toString();
    this.options.elements.status.textContent = "Loading PDF";
    this.options.elements.empty.hidden = false;
    try {
      if (force && this.loadingTask) {
        this.renderVersion += 1;
        await this.loadingTask.destroy();
        if (requestVersion !== this.requestVersion) return;
        this.loadingTask = null;
        this.documentProxy = null;
      }
      if (!this.documentProxy) {
        const response = await fetch(this.options.elements.download.href);
        if (requestVersion !== this.requestVersion) return;
        if (!response.ok) throw new Error(`PDF request failed (${response.status})`);
        this.sourceRevisionValue = response.headers.get("X-LaTeX-Coder-Source-Revision");
        const loadingTask = getDocument({ data: await response.arrayBuffer() });
        this.loadingTask = loadingTask;
        const pdf = await loadingTask.promise;
        if (requestVersion !== this.requestVersion) {
          await loadingTask.destroy();
          return;
        }
        this.documentProxy = pdf;
      }
      await this.render(priorityPage);
    } catch (error) {
      if (requestVersion !== this.requestVersion) return;
      console.error("paper PDF preview failed", error);
      this.options.elements.document.hidden = true;
      this.options.elements.status.textContent = "Preview failed. Download the PDF instead.";
    }
  }

  async render(priorityPage?: number): Promise<void> {
    if (priorityPage) this.priorityPage = priorityPage;
    const pdf = this.documentProxy;
    if (!pdf) return;
    const version = ++this.renderVersion;
    const firstPage = await pdf.getPage(1);
    const base = firstPage.getViewport({ scale: 1 });
    const widthFit = (this.options.elements.view.clientWidth - 32) / base.width;
    const heightFit = (this.options.elements.view.clientHeight - 32) / base.height;
    const fit = Math.min(4, Math.max(0.2, this.fitMode === "page" ? Math.min(widthFit, heightFit) : widthFit));
    const scale = fit * this.zoom;
    const fragment = document.createDocumentFragment();
    const renders: Array<() => Promise<void>> = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (version !== this.renderVersion) return;
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
      canvas.title = `${this.options.modifierLabel}+click to open source`;
      const sourcePoint = (event: MouseEvent) => {
        const bounds = canvas.getBoundingClientRect();
        return {
          x: (event.clientX - bounds.left) * viewport.width / bounds.width / scale,
          y: (event.clientY - bounds.top) * viewport.height / bounds.height / scale,
        };
      };
      const navigateSource = async (x: number, y: number) => {
        try {
          const destination = await this.options.sourceAt(pageNumber, x, y, this.sourceRevisionValue);
          await this.options.revealSource(destination);
        } catch (error) {
          this.options.showError(error instanceof Error ? error.message : String(error));
        }
      };
      canvas.addEventListener("click", event => {
        if (!this.options.modifierPressed(event) || event.button !== 0) return;
        event.preventDefault();
        this.closeContextMenu();
        const { x, y } = sourcePoint(event);
        void navigateSource(x, y);
      });
      canvas.addEventListener("contextmenu", event => {
        event.preventDefault();
        const { x, y } = sourcePoint(event);
        this.contextAction = () => navigateSource(x, y);
        this.openContextMenu(event);
      });
      fragment.append(canvas);
      renders.push(async () => {
        if (version !== this.renderVersion) return;
        await page.render({
          canvas,
          canvasContext: canvas.getContext("2d"),
          viewport,
          transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        }).promise;
      });
    }
    if (version !== this.renderVersion) return;
    this.options.elements.document.replaceChildren(fragment);
    this.options.elements.document.hidden = false;
    this.options.elements.empty.hidden = true;
    if (priorityPage && renders[priorityPage - 1]) {
      await renders[priorityPage - 1]();
      void (async () => {
        for (let index = 0; index < renders.length; index += 1) {
          if (version !== this.renderVersion) return;
          if (index !== priorityPage - 1) await renders[index]();
        }
      })().catch(error => { if (version === this.renderVersion) console.error("PDF background render failed", error); });
    } else {
      for (const render of renders) await render();
    }
    if (version !== this.renderVersion) return;
    this.options.elements.status.textContent = "PDF ready";
    this.renderHighlights();
  }

  async revealPosition(position: PdfPosition, revealedOutput: boolean): Promise<void> {
    if (revealedOutput) {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      cancelAnimationFrame(this.resizeFrame);
    }
    if (!this.documentProxy || this.sourceRevisionValue !== position.revision) {
      await this.show(true, position.page);
    } else if (revealedOutput || !this.options.elements.document.querySelector(`canvas[data-page="${position.page}"]`)) {
      await this.render(position.page);
    }
    if (this.sourceRevisionValue !== position.revision) throw new Error("The PDF changed. Try navigating again.");
    const canvas = this.options.elements.document.querySelector<HTMLCanvasElement>(`canvas[data-page="${position.page}"]`);
    if (!canvas || !this.documentProxy) throw new Error("PDF page not found");
    const page = await this.documentProxy.getPage(position.page);
    const viewport = page.getViewport({ scale: 1 });
    const x = Math.max(0, Math.min(viewport.width, position.x)) / viewport.width * canvas.clientWidth;
    const y = Math.max(0, Math.min(viewport.height, position.y)) / viewport.height * canvas.clientHeight;
    this.options.elements.view.scrollTo({
      top: Math.max(0, canvas.offsetTop + y - this.options.elements.view.clientHeight / 2),
      left: Math.max(0, canvas.offsetLeft + x - this.options.elements.view.clientWidth / 2),
      behavior: "auto",
    });
    const expires = Date.now() + 3000;
    this.highlights = {
      boxes: position.boxes || [{ page: position.page, left: position.x - 30, top: position.y - 8, width: 60, height: 16 }],
      expires,
    };
    this.renderHighlights();
    setTimeout(() => {
      if (this.highlights?.expires === expires) {
        this.highlights = null;
        this.renderHighlights();
      }
    }, 3000);
  }

  private closeContextMenu(): void {
    this.options.elements.contextMenu.hidden = true;
    this.contextAction = null;
  }

  private openContextMenu(event: MouseEvent): void {
    this.options.beforeOpenContextMenu();
    const menu = this.options.elements.contextMenu;
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8))}px`;
    this.options.elements.goToSource.focus({ preventScroll: true });
  }

  private renderHighlights(): void {
    const documentElement = this.options.elements.document;
    documentElement.querySelectorAll("[data-pdf-highlight]").forEach(marker => marker.remove());
    if (!this.highlights || this.highlights.expires < Date.now()) return;
    const canvases = [...documentElement.querySelectorAll("canvas")];
    let index = 0;
    for (const box of this.highlights.boxes) {
      const canvas = canvases.find(candidate => candidate.dataset.page === String(box.page));
      if (!canvas) continue;
      const scale = Number(canvas.dataset.pdfScale || 1);
      const marker = document.createElement("div");
      if (index++ === 0) marker.id = "pdf-source-marker";
      marker.dataset.pdfHighlight = "true";
      marker.className = "pointer-events-none absolute z-10 border-2 border-amber-500 bg-amber-200/30";
      marker.style.top = `${canvas.offsetTop + Math.max(0, box.top) * scale}px`;
      marker.style.left = `${canvas.offsetLeft + Math.max(0, box.left) * scale}px`;
      marker.style.width = `${Math.max(4, Math.min(box.width * scale, canvas.clientWidth))}px`;
      marker.style.height = `${Math.max(4, box.height * scale)}px`;
      documentElement.append(marker);
    }
  }
}
