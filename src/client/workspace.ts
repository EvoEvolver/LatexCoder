/** Actual grid tracks own the dividers; never infer pixel widths from CSS units. */
export function setupWorkspace() {
  const workspace = document.getElementById('workspace')!;
  const files = document.getElementById('files-pane')!;
  const editor = document.getElementById('editor-pane')!;
  const output = document.getElementById('output-pane')!;
  const fileDivider = document.getElementById('files-divider')!;
  const outputDivider = document.getElementById('output-divider')!;
  const buttons = ['files', 'editor', 'output'].map(id => document.getElementById(`collapse-${id}`)!);
  let fileWidth = 232, editorShare = .5;
  let filesHidden = false, editorHidden = false, outputHidden = false;
  let focusSnapshot: { filesHidden: boolean; editorHidden: boolean; outputHidden: boolean } | null = null;
  try {
    const saved = JSON.parse(localStorage.getItem('paper-workspace') || 'null');
    if (saved) {
      fileWidth = Math.max(160, Math.min(480, Number(saved.fileWidth) || 232));
      filesHidden = saved.filesHidden === true;
      editorShare = Math.max(.15, Math.min(.85, Number(saved.editorShare) || .5));
    }
  } catch { /* Ignore stale preferences. */ }
  const mobile = matchMedia('(max-width: 760px)');
  const persist = () => { try { localStorage.setItem('paper-workspace', JSON.stringify({fileWidth, editorShare, filesHidden})); } catch {} };
  function layout() {
    const width = workspace.clientWidth;
    if (!width) return;
    workspace.classList.toggle('files-collapsed', filesHidden);
    workspace.classList.toggle('editor-collapsed', editorHidden);
    workspace.classList.toggle('output-collapsed', outputHidden);
    if (!mobile.matches) {
      const fw = filesHidden ? 0 : Math.min(fileWidth, Math.max(160, width - 470));
      const available = Math.max(0, width - fw - 20);
      const minimum = Math.min(260, available / 2);
      const ew = editorHidden ? 0 : outputHidden ? available : Math.max(minimum, Math.min(available - minimum, available * editorShare));
      workspace.style.gridTemplateColumns = `${fw}px 10px ${ew}px 10px minmax(0,1fr)`;
      fileDivider.setAttribute('aria-valuenow', String(Math.round(fw)));
      outputDivider.setAttribute('aria-valuenow', String(Math.round(ew)));
    } else workspace.style.removeProperty('grid-template-columns');
    [files, editor, output].forEach((pane, i) => { pane.inert = !mobile.matches && [filesHidden, editorHidden, outputHidden][i]; });
    buttons.forEach((button, i) => {
      const hidden = [filesHidden, editorHidden, outputHidden][i];
      const label = `${hidden ? 'Show' : 'Hide'} ${['files', 'source', 'PDF'][i]}`;
      button.title = label; button.setAttribute('aria-label', label);
      button.setAttribute('aria-expanded', String(!hidden));
      button.classList.toggle('is-collapsed', hidden);
    });
    // At either edge, keep only the control that restores the hidden pane.
    buttons[1].hidden = outputHidden;
    buttons[2].hidden = editorHidden;
    workspace.dispatchEvent(new CustomEvent('layoutchange'));
  }
  buttons.forEach((button, i) => button.addEventListener('click', () => {
    focusSnapshot = null;
    if (i === 0) filesHidden = !filesHidden;
    if (i === 1) { editorHidden = !editorHidden; if (editorHidden) outputHidden = false; }
    if (i === 2) { outputHidden = !outputHidden; if (outputHidden) editorHidden = false; }
    layout(); persist();
  }));
  function resize(kind: string, delta: number, startFiles: number, startEditor: number) {
    focusSnapshot = null;
    const total = workspace.clientWidth;
    if (kind === 'files') {
      filesHidden = false;
      fileWidth = Math.max(160, Math.min(total - 470, 480, startFiles + delta));
    } else {
      editorHidden = false; outputHidden = false;
      const available = total - files.getBoundingClientRect().width - 20;
      editorShare = Math.max(.1, Math.min(.9, (startEditor + delta) / available));
    }
    layout();
  }
  [fileDivider, outputDivider].forEach(handle => {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || (event.target as Element).closest('button')) return;
      event.preventDefault();
      const x = event.clientX, fw = files.getBoundingClientRect().width, ew = editor.getBoundingClientRect().width;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-panes'); handle.classList.add('is-dragging');
      const move = (e: PointerEvent) => resize(handle.dataset.resize!, e.clientX - x, fw, ew);
      const done = () => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('lostpointercapture', done);
        document.body.classList.remove('resizing-panes'); handle.classList.remove('is-dragging'); persist();
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('lostpointercapture', done);
      handle.addEventListener('pointerup', () => { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); }, { once: true });
    });
    handle.addEventListener('keydown', event => {
      if (event.target !== handle || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); resize(handle.dataset.resize!, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10), files.getBoundingClientRect().width, editor.getBoundingClientRect().width); persist();
    });
  });
  new ResizeObserver(layout).observe(workspace);
  mobile.addEventListener('change', layout);
  layout();
  return {
    showOutput() { focusSnapshot = null; outputHidden = false; layout(); },
    getState() { return { filesHidden: mobile.matches ? !files.classList.contains('mobile-open') : filesHidden, mode: editorHidden ? 'pdf' : outputHidden ? 'editor' : 'split', focus: !!focusSnapshot }; },
    setMode(mode: string) {
      focusSnapshot = null;
      editorHidden = mode === 'pdf'; outputHidden = mode === 'editor';
      output.classList.toggle('mobile-open', mode === 'pdf'); layout();
    },
    toggleFiles() {
      focusSnapshot = null;
      if (mobile.matches) files.classList.toggle('mobile-open');
      else filesHidden = !filesHidden;
      layout(); persist();
    },
    toggleFocus() {
      if (focusSnapshot) {
        ({ filesHidden, editorHidden, outputHidden } = focusSnapshot); focusSnapshot = null;
      } else {
        focusSnapshot = { filesHidden, editorHidden, outputHidden };
        filesHidden = true; editorHidden = false; outputHidden = true;
      }
      layout();
    },
  };
}
