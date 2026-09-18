import { setThemePreference, themePreference } from "./theme";
import { Compartment } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { setupWorkspace } from './workspace';

export type Preferences = { theme: 'light' | 'dark' | 'system'; darkEditor: boolean; darkPdf: boolean; fontSize: number; lineHeight: number; wrap: boolean; lineNumbers: boolean; tabs: boolean; pdfZoom: number };
export const defaults: Preferences = { theme: 'system', darkEditor: true, darkPdf: true, fontSize: 13, lineHeight: 1.6, wrap: true, lineNumbers: true, tabs: true, pdfZoom: 1 };
const storageKey = 'paper-preferences';
export function readPreferences(): Preferences {
  let saved: Partial<Preferences> = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { /* Defaults also work when storage is blocked. */ }
  const result = { ...defaults };
  if (['light','dark','system'].includes(saved.theme)) result.theme = saved.theme;
  for (const key of ['darkEditor','darkPdf','wrap','lineNumbers','tabs'] as const) if (typeof saved[key] === 'boolean') result[key] = saved[key];
  if ([11,12,13,14,15,16,18,20,22,24].includes(saved.fontSize)) result.fontSize = saved.fontSize;
  if ([1.4,1.6,1.9].includes(saved.lineHeight)) result.lineHeight = saved.lineHeight;
  if ([.75,1,1.25,1.5,2].includes(saved.pdfZoom)) result.pdfZoom = saved.pdfZoom;
  return result;
}
let preferences = readPreferences();
preferences.theme = themePreference();
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
export const editorPreferences = new Compartment();
export const isDarkTheme = () => preferences.theme === 'dark' || (preferences.theme === 'system' && systemTheme.matches);
export const isDarkPdf = () => isDarkTheme() && preferences.darkPdf;
export function preferenceExtensions() {
  return [preferences.wrap ? EditorView.lineWrapping : [], preferences.lineNumbers ? lineNumbers() : [],
    EditorView.theme({}, { dark: isDarkTheme() && preferences.darkEditor }),
    syntaxHighlighting(HighlightStyle.define([
      { tag: [tags.keyword, tags.tagName, tags.function(tags.variableName)], color: 'var(--code-keyword)' },
      { tag: [tags.string, tags.special(tags.string)], color: 'var(--code-string)' },
      { tag: [tags.number, tags.atom, tags.bool], color: 'var(--code-number)' },
      { tag: [tags.comment, tags.meta], color: 'var(--code-comment)' },
      { tag: [tags.bracket, tags.operator], color: 'var(--code-punctuation)' },
    ])),
  ];
}

export function setupPreferences(options: {
  workspace: ReturnType<typeof setupWorkspace>; view: () => EditorView | null;
  renderPdf: () => Promise<void>; zoom: (value: number) => void; openPdf: () => void;
}) {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = byId<HTMLDialogElement>('settings-dialog');
  function apply(reconfigure = true) {
    const root = document.documentElement;
    root.classList.toggle("dark", isDarkTheme());
    root.dataset.themePreference = preferences.theme;
    root.dataset.theme = isDarkTheme() ? 'dark' : 'light';
    root.dataset.darkEditor = String(isDarkTheme() && preferences.darkEditor);
    root.style.setProperty('--code-font-size', `${preferences.fontSize}px`);
    root.style.setProperty('--code-line-height', String(preferences.lineHeight));
    byId('editor-pane').classList.toggle('tabs-hidden', !preferences.tabs);
    byId('file-tabs').hidden = !preferences.tabs;
    if (reconfigure) options.view()?.dispatch({ effects: editorPreferences.reconfigure(preferenceExtensions()) });
    byId<HTMLInputElement>('setting-dark-editor').checked = preferences.darkEditor;
    byId<HTMLInputElement>('setting-dark-pdf').checked = preferences.darkPdf;
    byId<HTMLInputElement>('setting-wrap').checked = preferences.wrap;
    byId<HTMLInputElement>('setting-line-numbers').checked = preferences.lineNumbers;
    byId<HTMLInputElement>('setting-tabs').checked = preferences.tabs;
    byId<HTMLSelectElement>('setting-font-size').value = String(preferences.fontSize);
    byId<HTMLSelectElement>('setting-line-height').value = String(preferences.lineHeight);
    byId<HTMLSelectElement>('setting-pdf-zoom').value = String(preferences.pdfZoom);
    dialog.querySelector<HTMLInputElement>(`[name=appearance-theme][value=${preferences.theme}]`)!.checked = true;
    byId('dark-mode-hint').hidden = isDarkTheme();
    updateMenu();
  }
  function save(changes: Partial<Preferences>) {
    const beforeDark = isDarkPdf(); preferences = { ...preferences, ...changes };
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch {}
    if (changes.theme) setThemePreference(changes.theme);
    apply();
    if (changes.pdfZoom !== undefined) options.zoom(preferences.pdfZoom);
    else if (beforeDark !== isDarkPdf()) void options.renderPdf();
  }
  dialog.querySelectorAll<HTMLInputElement>('[name=appearance-theme]').forEach(input => input.onchange = () => save({ theme: input.value as Preferences['theme'] }));
  for (const [id, key] of [['dark-editor','darkEditor'],['dark-pdf','darkPdf'],['wrap','wrap'],['line-numbers','lineNumbers'],['tabs','tabs']] as const) {
    const input = byId<HTMLInputElement>(`setting-${id}`); input.onchange = () => save({ [key]: input.checked });
  }
  for (const [id, key] of [['font-size','fontSize'],['line-height','lineHeight'],['pdf-zoom','pdfZoom']] as const) {
    const input = byId<HTMLSelectElement>(`setting-${id}`); input.onchange = () => save({ [key]: Number(input.value) });
  }
  window.addEventListener('latexcoder-theme-change', () => {
    const before = isDarkPdf(); preferences.theme = themePreference(); apply();
    if (before !== isDarkPdf()) void options.renderPdf();
  });
  systemTheme.addEventListener('change' , () => { if (preferences.theme === 'system') { apply(); void options.renderPdf(); } });

  const tabs = [...dialog.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')];
  function selectTab(name: string) {
    tabs.forEach(tab => {
      const active = tab.dataset.settingsTab === name;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      byId(tab.getAttribute('aria-controls')!).hidden = !active;
    });
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => selectTab(tab.dataset.settingsTab!);
    tab.onkeydown = event => {
      if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.settingsTab!); tabs[next].focus();
    };
  });
  function openSettings(tab = 'appearance') { selectTab(tab); dialog.showModal(); tabs.find(t => t.dataset.settingsTab === tab)?.focus(); }
  byId('settings-close').onclick = byId('settings-done').onclick = () => dialog.close();
  dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });

  let openMenu: string | null = null;
  function closeMenus(restore = false) {
    const last = openMenu;
    for (const name of ['file','view']) { byId(`${name}-menu`).hidden = true; byId(`${name}-menu-button`).setAttribute('aria-expanded','false'); }
    openMenu = null;
    if (restore && last) byId(`${last}-menu-button`).focus();
  }
  function updateMenu() {
    const state = options.workspace.getState();
    document.querySelectorAll<HTMLElement>('[data-layout]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.layout === state.mode)));
    for (const [action, value] of [['focus', state.focus], ['files', !state.filesHidden], ['tabs', preferences.tabs], ['suggest', byId('suggest-edit').getAttribute('aria-pressed') === 'true']] as const) {
      document.querySelector(`[data-menu-action=${action}]`)?.setAttribute('aria-checked', String(value));
    }
  }
  for (const name of ['file','view']) {
    const trigger = byId(`${name}-menu-button`), menu = byId(`${name}-menu`);
    const items = () => [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const show = () => {
      closeMenus(); updateMenu(); menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); openMenu = name;
      menu.style.left = `${Math.min(trigger.getBoundingClientRect().left, window.innerWidth - menu.offsetWidth - 8)}px`;
      items()[0]?.focus();
    };
    trigger.onclick = () => openMenu === name ? closeMenus() : show();
    trigger.onkeydown = event => { if (event.key === 'ArrowDown') { event.preventDefault(); show(); } };
    menu.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenus(true); }
      if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault(); const list = items(), index = list.indexOf(document.activeElement as HTMLButtonElement);
        list[event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + list.length) % list.length]?.focus();
      }
      if (['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); closeMenus(); byId(`${name === 'file' ? 'view' : 'file'}-menu-button`).click(); }
      if (event.key === 'Tab') closeMenus();
    };
  }
  document.addEventListener('pointerdown', event => { if (!(event.target as Element).closest('.workspace-menubar')) closeMenus(); });
  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach(button => button.onclick = () => {
    options.workspace.setMode(button.dataset.layout!);
    if (button.dataset.layout === 'pdf') document.querySelector<HTMLButtonElement>('[data-output=pdf]')?.click();
    closeMenus(true);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-menu-action]').forEach(button => button.onclick = () => {
    closeMenus(true);
    switch (button.dataset.menuAction) {
      case 'settings': openSettings(); break;
      case 'editor-settings': openSettings('editor'); break;
      case 'open-pdf': options.openPdf(); break;
      case 'focus': options.workspace.toggleFocus(); break;
      case 'files': options.workspace.toggleFiles(); break;
      case 'tabs': save({ tabs: !preferences.tabs }); break;
      case 'suggest': byId('suggest-edit').click(); break;
      case 'zoom-in': byId('pdf-zoom-in').click(); break;
      case 'zoom-out': byId('pdf-zoom-out').click(); break;
      case 'zoom-reset': options.zoom(1); break;
    }
  });
  byId('workspace').addEventListener('layoutchange', updateMenu);
  document.addEventListener('keydown', event => {
    if (byId('editor-page').hidden || document.querySelector('dialog[open]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); closeMenus(); openSettings(); }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyM') { event.preventDefault(); options.workspace.toggleFocus(); }
  });
  apply(false); options.zoom(preferences.pdfZoom);
}
