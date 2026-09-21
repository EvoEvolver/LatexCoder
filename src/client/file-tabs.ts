export type TabFile = { path: string };
export type AuxiliaryTab = { id: string; label: string; controls: string };

export function createFileTabs(host: HTMLElement, open: (path: string) => void, openAuxiliary: (id: string) => void) {
  let paths: string[] = [];
  let project = "";
  let active = "";
  let auxiliary: AuxiliaryTab | null = null;
  let auxiliaryActive = false;

  function render(): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset.tabPath;
    host.replaceChildren();
    for (const path of paths) {
      const tab = document.createElement("div");
      tab.className = "file-tab";
      tab.classList.toggle("active", !auxiliaryActive && path === active);
      tab.classList.toggle("single-tab", paths.length === 1);

      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tabPath = path;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(!auxiliaryActive && path === active));
      button.setAttribute("aria-controls", "editor");
      button.tabIndex = !auxiliaryActive && path === active ? 0 : -1;
      button.title = path;
      const basename = path.split("/").at(-1)!;
      button.textContent = paths.some(other => other !== path && other.split("/").at(-1) === basename) ? path : basename;
      button.addEventListener("click", () => open(path));
      button.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = paths.indexOf(path);
        const next = event.key === "Home" ? paths[0]
          : event.key === "End" ? paths.at(-1)!
          : paths[(index + (event.key === "ArrowLeft" ? -1 : 1) + paths.length) % paths.length];
        open(next);
      });

      const close = document.createElement("button");
      close.type = "button";
      close.className = "close-tab";
      close.textContent = "x";
      close.title = `Close ${path}`;
      close.setAttribute("aria-label", close.title);
      close.hidden = paths.length === 1;
      close.addEventListener("click", () => {
        if (paths.length === 1) return;
        const index = paths.indexOf(path);
        paths = paths.filter(candidate => candidate !== path);
        if (active === path) open(paths[Math.min(index, paths.length - 1)]);
        else render();
      });
      tab.append(button, close);
      host.append(tab);
    }
    if (auxiliary) {
      const tab = document.createElement("div");
      tab.className = "file-tab auxiliary-tab";
      tab.classList.toggle("active", auxiliaryActive);
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tabPanel = auxiliary.id;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(auxiliaryActive));
      button.setAttribute("aria-controls", auxiliary.controls);
      button.tabIndex = auxiliaryActive ? 0 : -1;
      button.textContent = auxiliary.label;
      button.addEventListener("click", () => { auxiliaryActive = true; render(); openAuxiliary(auxiliary!.id); });
      const close = document.createElement("button");
      close.type = "button";
      close.className = "close-tab";
      close.textContent = "x";
      close.title = `Close ${auxiliary.label}`;
      close.setAttribute("aria-label", close.title);
      close.addEventListener("click", () => {
        const wasActive = auxiliaryActive;
        auxiliary = null;
        auxiliaryActive = false;
        render();
        if (wasActive && active) open(active);
      });
      tab.append(button, close);
      host.append(tab);
    }
    if (focused) host.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
    host.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  return {
    update(files: TabFile[], selected: string, projectId: string): void {
      if (project !== projectId) { paths = []; auxiliary = null; auxiliaryActive = false; project = projectId; }
      paths = paths.filter(path => files.some(file => file.path === path));
      active = selected;
      if (selected && !paths.includes(selected) && files.some(file => file.path === selected)) paths.push(selected);
      render();
    },
    move(from: string, to: string): void {
      paths = paths.map(path => path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
    },
    openAuxiliary(tab: AuxiliaryTab): void {
      auxiliary = tab;
      auxiliaryActive = true;
      render();
      openAuxiliary(tab.id);
    },
    activateFile(): void {
      if (!auxiliaryActive) return;
      auxiliaryActive = false;
      render();
    },
  };
}
