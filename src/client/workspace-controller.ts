type WorkspaceElements = {
  closeFiles: HTMLElement;
  closeOutput: HTMLElement;
  editorPane: HTMLElement;
  fileList: HTMLElement;
  filesPane: HTMLElement;
  filesResize: HTMLElement;
  openPdf: HTMLElement;
  outputPane: HTMLElement;
  outputResize: HTMLElement;
  structureResize: HTMLElement;
  toggleFiles: HTMLElement;
  toggleFilesColumn: HTMLElement;
  toggleOutputColumn: HTMLElement;
  viewSwitch: HTMLElement;
  workspace: HTMLElement;
};

type StoredLayout = {
  filesHidden?: boolean;
  filesWidth?: number;
  outputHidden?: boolean;
  outputWidth?: number | null;
  structureHeight?: number;
};

const COLUMN_HANDLE_WIDTH = 8;
const MIN_FILES_WIDTH = 180;
const MIN_OUTPUT_WIDTH = 320;
const COMPACT_EDITOR_WIDTH = 240;
const MIN_EDITOR_WIDTH = 360;

export class WorkspaceController {
  private desktopOutputOpen = false;
  private filesHidden = false;
  private filesWidth = 208;
  private outputHidden = false;
  private outputWidth: number | null = null;
  private structureHeight = 220;
  private readonly narrow = window.matchMedia("(max-width: 760px)");
  private readonly columns: Array<[HTMLElement, number]>;

  constructor(private readonly elements: WorkspaceElements) {
    this.columns = [
      [elements.filesPane, 1], [elements.filesResize, 2], [elements.editorPane, 3],
      [elements.outputResize, 4], [elements.outputPane, 5],
    ];
    this.restore();
    this.bindStructureResize();
    this.bindColumnResize(elements.filesResize, "files");
    this.bindColumnResize(elements.outputResize, "output");
    elements.toggleFiles.addEventListener("click", () => this.setMobileFilesOpen(!elements.filesPane.classList.contains("mobile-open")));
    elements.toggleFilesColumn.addEventListener("click", () => {
      this.filesHidden = !this.filesHidden;
      this.save();
      this.update();
    });
    elements.toggleOutputColumn.addEventListener("click", () => {
      this.outputHidden = !this.outputHidden;
      this.desktopOutputOpen = false;
      this.save();
      this.update();
    });
    elements.closeFiles.addEventListener("click", () => this.setMobileFilesOpen(false));
    new ResizeObserver(() => this.update()).observe(elements.workspace);
    this.narrow.addEventListener("change", () => this.update());
    this.update();
  }

  get isNarrow(): boolean { return this.narrow.matches; }
  get isOutputHidden(): boolean { return this.outputHidden; }

  setMobileFilesOpen(open: boolean): void {
    this.elements.filesPane.classList.toggle("mobile-open", open);
    this.update();
  }

  setOutputViewOpen(open: boolean): void {
    if (this.narrow.matches) this.elements.outputPane.classList.toggle("mobile-open", open);
    else if (this.outputHidden) this.desktopOutputOpen = open;
    this.update();
    this.elements.openPdf.setAttribute("aria-expanded", String(open));
  }

  private editorMinimum(width: number): number {
    const filesMinimum = this.filesHidden ? 0 : MIN_FILES_WIDTH;
    const outputMinimum = this.outputHidden ? 0 : MIN_OUTPUT_WIDTH;
    return Math.max(COMPACT_EDITOR_WIDTH, Math.min(
      MIN_EDITOR_WIDTH,
      width - filesMinimum - outputMinimum - COLUMN_HANDLE_WIDTH * 2,
    ));
  }

  private update(): void {
    const mobile = this.narrow.matches;
    const mobileOutputOpen = this.elements.outputPane.classList.contains("mobile-open");
    const singlePaneOutput = !mobile && this.outputHidden && this.desktopOutputOpen;
    this.elements.filesPane.style.transform = mobile
      ? this.elements.filesPane.classList.contains("mobile-open") ? "translateX(0)" : "translateX(-100%)"
      : "";
    this.elements.editorPane.hidden = (mobile && mobileOutputOpen) || singlePaneOutput;
    this.elements.outputPane.hidden = !mobile && this.outputHidden && !this.desktopOutputOpen;
    for (const [pane, column] of this.columns) {
      pane.style.gridColumn = mobile ? "" : String(column);
      pane.style.gridRow = mobile ? "" : "1";
    }
    if (singlePaneOutput) this.elements.outputPane.style.gridColumn = "3";
    this.elements.filesPane.hidden = !mobile && this.filesHidden;
    this.elements.fileList.hidden = !mobile && this.filesHidden;
    const width = this.elements.workspace.clientWidth;
    const filesHeight = this.elements.filesPane.clientHeight;
    if (filesHeight) {
      this.structureHeight = Math.max(112, Math.min(this.structureHeight, filesHeight - 104));
      this.elements.filesPane.style.gridTemplateRows = `44px minmax(96px,1fr) 8px ${this.structureHeight}px`;
    }
    if (width && !mobile) {
      const handlesWidth = COLUMN_HANDLE_WIDTH * 2;
      const outputMinimum = this.outputHidden ? 0 : MIN_OUTPUT_WIDTH;
      const editorMinimum = this.editorMinimum(width);
      const filesMaximum = width - editorMinimum - outputMinimum - handlesWidth;
      this.filesWidth = Math.max(MIN_FILES_WIDTH, Math.min(this.filesWidth, filesMaximum));
      const filesWidth = this.filesHidden ? 0 : this.filesWidth;
      const remaining = width - filesWidth - handlesWidth;
      const output = Math.max(MIN_OUTPUT_WIDTH, Math.min(
        remaining - editorMinimum,
        this.outputWidth ?? remaining * 0.46,
      ));
      this.elements.workspace.style.gridTemplateColumns = `${filesWidth}px ${COLUMN_HANDLE_WIDTH}px minmax(${editorMinimum}px,1fr) ${COLUMN_HANDLE_WIDTH}px ${this.outputHidden ? 0 : output}px`;
    }
    this.elements.toggleFiles.title = mobile ? "Files" : this.filesHidden ? "Show files" : "Hide files";
    this.elements.toggleFiles.setAttribute("aria-expanded", String(mobile ? this.elements.filesPane.classList.contains("mobile-open") : !this.filesHidden));
    this.elements.viewSwitch.hidden = !mobile && !this.outputHidden;
    this.elements.closeOutput.hidden = !mobile && !singlePaneOutput;
    this.syncColumnToggle(this.elements.toggleFilesColumn, this.filesHidden, ["Hide files", "Show files"]);
    this.syncColumnToggle(this.elements.toggleOutputColumn, this.outputHidden, ["Hide PDF", "Show PDF"]);
  }

  private syncColumnToggle(button: HTMLElement, hidden: boolean, labels: [string, string]): void {
    button.title = hidden ? labels[1] : labels[0];
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(!hidden));
    button.querySelector("[data-collapse-icon]")?.toggleAttribute("hidden", hidden);
    button.querySelector("[data-expand-icon]")?.toggleAttribute("hidden", !hidden);
  }

  private adjustStructureHeight(delta: number): void {
    this.structureHeight -= delta;
    this.update();
  }

  private bindStructureResize(): void {
    const handle = this.elements.structureResize;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      let previous = event.clientY;
      const move = (next: PointerEvent) => { this.adjustStructureHeight(next.clientY - previous); previous = next.clientY; };
      const stop = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("lostpointercapture", stop);
        this.save();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("lostpointercapture", stop);
    });
    handle.addEventListener("keydown", event => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      this.adjustStructureHeight((event.key === "ArrowUp" ? -1 : 1) * (event.shiftKey ? 40 : 10));
      this.save();
    });
  }

  private bindColumnResize(handle: HTMLElement, kind: "files" | "output"): void {
    const adjust = (delta: number) => {
      if (this.narrow.matches) return;
      if (kind === "files") {
        if (this.filesHidden) return;
        this.filesWidth += delta;
      } else {
        if (this.outputHidden) return;
        const width = this.elements.workspace.clientWidth;
        const remaining = width - (this.filesHidden ? 0 : this.filesWidth) - COLUMN_HANDLE_WIDTH * 2;
        this.outputWidth = Math.max(MIN_OUTPUT_WIDTH, Math.min(
          remaining - this.editorMinimum(width),
          this.elements.outputPane.getBoundingClientRect().width - delta,
        ));
      }
      this.update();
    };
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || (event.target as Element).closest("button")) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      let previous = event.clientX;
      const move = (next: PointerEvent) => { adjust(next.clientX - previous); previous = next.clientX; };
      const stop = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("lostpointercapture", stop);
        this.save();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("lostpointercapture", stop);
    });
    handle.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      adjust((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 10));
      this.save();
    });
  }

  private restore(): void {
    try {
      const saved = JSON.parse(localStorage.getItem("workspace-layout") || "null") as StoredLayout | null;
      if (!saved) return;
      if (Number.isFinite(saved.filesWidth)) this.filesWidth = saved.filesWidth!;
      if (Number.isFinite(saved.outputWidth)) this.outputWidth = saved.outputWidth!;
      if (Number.isFinite(saved.structureHeight)) this.structureHeight = saved.structureHeight!;
      this.filesHidden = saved.filesHidden === true;
      this.outputHidden = saved.outputHidden === true;
    } catch { /* Storage is optional and preferences may be invalid. */ }
  }

  private save(): void {
    try {
      localStorage.setItem("workspace-layout", JSON.stringify({
        filesWidth: this.filesWidth,
        outputWidth: this.outputWidth,
        structureHeight: this.structureHeight,
        filesHidden: this.filesHidden,
        outputHidden: this.outputHidden,
      }));
    } catch { /* Storage is optional. */ }
  }
}
