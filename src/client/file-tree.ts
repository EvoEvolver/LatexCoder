import { Braces, ChevronRight, createIcons, File, FileCheck2, FileCode2, FileText, Folder, FolderOpen, Image, MoreHorizontal } from "lucide";

export type TreeFile = { path: string; text: boolean };
type TreeState = { files: TreeFile[]; directories: string[]; active: string; main: string };
type TreeCallbacks = {
  open(path: string): void;
  search(): void;
  rename(path: string, folder: boolean): void;
  remove(path: string, folder: boolean): void;
  create(path: string, folder: boolean): void;
  upload(path: string): void;
  move(from: string, to: string): Promise<void>;
  download(path: string): void;
};
type MenuAction = { label: string; run(): void; danger?: boolean; disabled?: boolean; title?: string } | "separator";

export function createFileTree(host: HTMLElement, callbacks: TreeCallbacks) {
  const closed = new Set<string>();
  const known = new Set<string>();
  let selectedFolder = "";
  let project = "";
  let dragged = "";
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let current: TreeState | undefined;
  let contextPanel: HTMLElement | undefined;
  const parent = (value: string): string => value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : "";
  const basename = (value: string): string => value.split("/").at(-1)!;

  function closeMenus(except?: HTMLDetailsElement): void {
    host.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu => { if (menu !== except) menu.open = false; });
    if (contextPanel) contextPanel.hidden = true;
  }

  function positionPanel(panel: HTMLElement, x: number, y: number): void {
    panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, x))}px`;
    panel.style.top = `${Math.max(8, Math.min(innerHeight - panel.offsetHeight - 8, y))}px`;
  }

  function sharedActions(directory: string): MenuAction[] {
    return [
      { label: "Search", run: callbacks.search },
      { label: "New file", run: () => callbacks.create(directory, false) },
      { label: "New folder", run: () => callbacks.create(directory, true) },
      { label: "Upload", run: () => callbacks.upload(directory) },
    ];
  }

  function entryActions(entry?: { path: string; folder: boolean }): MenuAction[] {
    if (!entry || !current) return sharedActions("");
    const directory = entry.folder ? entry.path : parent(entry.path);
    const specific: MenuAction[] = entry.folder
      ? [
          { label: "Rename folder", run: () => callbacks.rename(entry.path, true) },
          { label: "Delete folder", run: () => callbacks.remove(entry.path, true), danger: true, disabled: current.main.startsWith(`${entry.path}/`), title: "The folder containing the main document cannot be deleted" },
        ]
      : [
          { label: "Download", run: () => callbacks.download(entry.path) },
          { label: "Rename", run: () => callbacks.rename(entry.path, false) },
          { label: "Delete file", run: () => callbacks.remove(entry.path, false), danger: true, disabled: entry.path === current.main, title: "The main document cannot be deleted" },
        ];
    return [...sharedActions(directory), "separator", ...specific];
  }

  function populateMenu(panel: HTMLElement, actions: MenuAction[], close: () => void): void {
    panel.replaceChildren();
    panel.setAttribute("role", "menu");
    for (const action of actions) {
      if (action === "separator") {
        const separator = document.createElement("div"); separator.className = "tree-menu-separator"; separator.setAttribute("role", "separator"); panel.append(separator); continue;
      }
      const item = document.createElement("button"); item.type = "button"; item.textContent = action.label; item.className = action.danger ? "danger" : "";
      item.setAttribute("role", "menuitem"); item.disabled = Boolean(action.disabled); if (action.title) item.title = action.title;
      item.addEventListener("click", () => { close(); action.run(); }); panel.append(item);
    }
  }

  function openContextMenu(actions: MenuAction[], x: number, y: number): void {
    if (!contextPanel) return;
    closeMenus();
    populateMenu(contextPanel, actions, () => { if (contextPanel) contextPanel.hidden = true; });
    contextPanel.hidden = false;
    positionPanel(contextPanel, x, y);
    contextPanel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }

  function addDropTarget(element: HTMLElement, directory: string): void {
    element.addEventListener("dragover", event => {
      if (!dragged || directory === dragged || directory.startsWith(`${dragged}/`)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      element.classList.add("drop-target");
      if (closed.has(directory) && !hoverTimer) hoverTimer = setTimeout(() => { closed.delete(directory); hoverTimer = undefined; render(); }, 650);
    });
    element.addEventListener("dragleave", event => {
      if (element.contains(event.relatedTarget as Node)) return;
      element.classList.remove("drop-target"); clearTimeout(hoverTimer); hoverTimer = undefined;
    });
    element.addEventListener("drop", event => {
      event.preventDefault(); event.stopPropagation(); element.classList.remove("drop-target");
      clearTimeout(hoverTimer); hoverTimer = undefined;
      if (!dragged) return;
      const from = dragged;
      const to = directory ? `${directory}/${basename(from)}` : basename(from);
      dragged = "";
      if (from !== to && directory !== from && !directory.startsWith(`${from}/`)) {
        closed.delete(directory);
        void callbacks.move(from, to);
      }
    });
  }

  function render(): void {
    if (!current) return;
    const focused = (document.activeElement as HTMLElement | null)?.dataset.treePath;
    const scrollTop = host.scrollTop;
    host.replaceChildren();
    host.setAttribute("role", "tree");
    host.setAttribute("aria-label", "Project files");

    const directories = new Set(current.directories);
    for (const file of current.files) for (let directory = parent(file.path); directory; directory = parent(directory)) directories.add(directory);
    for (const directory of directories) if (!known.has(directory)) {
      known.add(directory);
      if (!current.active.startsWith(`${directory}/`)) closed.add(directory);
    }

    function branch(directory: string, depth: number): void {
      if (!current) return;
      const folders = [...directories].filter(path => parent(path) === directory).sort((left, right) => basename(left).localeCompare(basename(right), undefined, { numeric: true }));
      const files = current.files.filter(file => parent(file.path) === directory).sort((left, right) => basename(left.path).localeCompare(basename(right.path), undefined, { numeric: true }));
      const entries = [...folders.map(path => ({ path, folder: true, text: false })), ...files.map(file => ({ ...file, folder: false }))];
      for (const entry of entries) {
        const expanded = !closed.has(entry.path);
        const row = document.createElement("div");
        row.className = "file-item tree-item"; row.dataset.path = entry.path;
        row.style.setProperty("--depth", String(depth));
        row.classList.toggle("active", !entry.folder && entry.path === current.active);
        row.classList.toggle("bg-accent", !entry.folder && entry.path === current.active);
        row.classList.toggle("folder-selected", entry.folder && entry.path === selectedFolder);
        row.draggable = true;
        row.addEventListener("dragstart", event => { dragged = entry.path; if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", entry.path); } });
        row.addEventListener("dragend", () => { dragged = ""; clearTimeout(hoverTimer); hoverTimer = undefined; host.querySelectorAll(".drop-target").forEach(element => element.classList.remove("drop-target")); });

        const button = document.createElement("button");
        button.type = "button"; button.className = "tree-row file-row"; button.dataset.treePath = entry.path; button.title = entry.path;
        button.setAttribute("role", "treeitem"); button.setAttribute("aria-level", String(depth + 1));
        button.setAttribute("aria-selected", String(entry.folder ? selectedFolder === entry.path : current.active === entry.path));
        let icon = entry.text ? "file-text" : "file";
        if (/\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)$/i.test(entry.path)) icon = "image";
        else if (/\.pdf$/i.test(entry.path)) icon = "file-check-2";
        else if (/\.(bib|json|yaml|yml)$/i.test(entry.path)) icon = "braces";
        else if (/\.(sty|cls|py|js|ts|css)$/i.test(entry.path)) icon = "file-code-2";
        if (entry.folder) { icon = expanded ? "folder-open" : "folder"; button.setAttribute("aria-expanded", String(expanded)); addDropTarget(row, entry.path); }
        button.innerHTML = `<span class="tree-chevron ${expanded && entry.folder ? "expanded" : ""}">${entry.folder ? '<i data-lucide="chevron-right"></i>' : ""}</span><i data-lucide="${icon}" class="tree-file-icon icon-${icon}"></i><span class="tree-name"></span>`;
        button.querySelector(".tree-name")!.textContent = basename(entry.path);
        button.addEventListener("click", () => {
          if (entry.folder) { selectedFolder = entry.path; expanded ? closed.add(entry.path) : closed.delete(entry.path); render(); }
          else { selectedFolder = parent(entry.path); callbacks.open(entry.path); }
        });
        button.addEventListener("keydown", event => {
          const buttons = [...host.querySelectorAll<HTMLButtonElement>(".tree-row")];
          const index = buttons.indexOf(button);
          if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
            buttons[target]?.focus();
          } else if (event.key === "ArrowRight" && entry.folder) { event.preventDefault(); closed.delete(entry.path); render(); }
          else if (event.key === "ArrowLeft") { event.preventDefault(); if (entry.folder && expanded) { closed.add(entry.path); render(); } else buttons.find(item => item.dataset.treePath === parent(entry.path))?.focus(); }
        });

        const menu = document.createElement("details");
        menu.className = "file-actions tree-menu";
        menu.innerHTML = '<summary aria-label="Actions" title="Actions"><i data-lucide="more-horizontal"></i></summary><div class="tree-menu-panel"></div>';
        const panel = menu.querySelector<HTMLElement>("div")!;
        populateMenu(panel, entryActions(entry), () => { menu.open = false; });
        let contextPoint: { x: number; y: number } | undefined;
        menu.addEventListener("toggle", () => {
          if (!menu.open) return;
          closeMenus(menu);
          const bounds = menu.getBoundingClientRect();
          positionPanel(panel, contextPoint?.x ?? bounds.right - panel.offsetWidth, contextPoint?.y ?? bounds.bottom + 3);
          contextPoint = undefined;
        });
        row.addEventListener("contextmenu", event => {
          event.preventDefault(); event.stopPropagation();
          selectedFolder = entry.folder ? entry.path : parent(entry.path);
          contextPoint = { x: event.clientX, y: event.clientY };
          if (menu.open) { closeMenus(menu); positionPanel(panel, event.clientX, event.clientY); }
          else menu.open = true;
        });
        row.append(button, menu); host.append(row);
        if (entry.folder && expanded) branch(entry.path, depth + 1);
      }
    }
    branch("", 0);
    if (!current.files.length && !directories.size) { const empty = document.createElement("p"); empty.className = "tree-empty"; empty.textContent = "No files"; host.append(empty); }
    contextPanel = document.createElement("div"); contextPanel.className = "tree-menu-panel tree-context-menu"; contextPanel.hidden = true; host.append(contextPanel);
    createIcons({ root: host, icons: { Braces, ChevronRight, File, FileCheck2, FileCode2, FileText, Folder, FolderOpen, Image, MoreHorizontal } });
    host.querySelectorAll("svg[data-lucide]").forEach(icon => icon.removeAttribute("data-lucide"));
    if (focused) host.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    host.scrollTop = scrollTop;
  }

  addDropTarget(host, "");
  host.addEventListener("contextmenu", event => {
    if ((event.target as Element).closest(".tree-item, .tree-menu-panel")) return;
    event.preventDefault(); selectedFolder = ""; openContextMenu(entryActions(), event.clientX, event.clientY);
  });
  document.addEventListener("click", event => {
    host.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu => { if (!menu.contains(event.target as Node)) menu.open = false; });
    if (contextPanel && !contextPanel.contains(event.target as Node)) contextPanel.hidden = true;
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeMenus();
  });
  return {
    render(data: TreeState, projectId: string): void { if (project !== projectId) { closed.clear(); known.clear(); selectedFolder = ""; project = projectId; } current = data; render(); },
    get folder(): string { return selectedFolder; },
    reveal(path: string): void { for (let directory = parent(path); directory; directory = parent(directory)) { known.add(directory); closed.delete(directory); } },
  };
}
