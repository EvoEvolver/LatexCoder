export function createFileTabs(host: HTMLElement, open: (path: string) => void) {
  let paths: string[] = [], project = '', active = '';
  function render() {
    const focused = (document.activeElement as HTMLElement)?.dataset.tabPath;
    host.replaceChildren();
    for (const path of paths) {
      const tab = document.createElement('div'); tab.className = 'file-tab'; tab.classList.toggle('active', path === active); tab.classList.toggle('single-tab', paths.length === 1);
      const button = document.createElement('button'); button.type = 'button'; button.dataset.tabPath = path;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(path === active)); button.tabIndex = path === active ? 0 : -1;
      button.setAttribute('aria-controls', 'editor'); button.title = path;
      const duplicate = paths.some(other => other !== path && other.split('/').pop() === path.split('/').pop());
      button.textContent = duplicate ? path : path.split('/').pop()!;
      button.onclick = () => open(path);
      button.onkeydown = event => {
        const index = paths.indexOf(path);
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); const next = event.key === 'Home' ? paths[0] : event.key === 'End' ? paths.at(-1)! : paths[(index + (event.key === 'ArrowLeft' ? -1 : 1) + paths.length) % paths.length]; open(next);
        }
      };
      const close = document.createElement('button'); close.type = 'button'; close.className = 'close-tab'; close.textContent = '×'; close.title = `Close ${path}`; close.setAttribute('aria-label', close.title); close.hidden = paths.length === 1;
      close.onclick = () => { if (paths.length === 1) return; const index = paths.indexOf(path); paths = paths.filter(p => p !== path); if (active === path) open(paths[Math.min(index, paths.length - 1)]); else render(); };
      tab.append(button, close); host.append(tab);
    }
    if (focused) host.querySelector<HTMLElement>('[aria-selected=true]')?.focus({preventScroll:true});
    host.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest', inline:'nearest'});
  }
  return {
    update(files: {path: string}[], selected: string, id: string) {
      if (project !== id) { paths = []; project = id; }
      paths = paths.filter(path => files.some(file => file.path === path));
      active = selected;
      if (selected && !paths.includes(selected) && files.some(file => file.path === selected)) paths.push(selected);
      render();
    },
    move(from: string, to: string) { paths = paths.map(p => p === from || p.startsWith(from + '/') ? to + p.slice(from.length) : p); },
  };
}
