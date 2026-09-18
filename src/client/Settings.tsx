import { Settings, Palette, TextCursorInput, FileText, X, Sun, Moon, Monitor, Columns2, PanelLeftClose, PanelRightClose, ExternalLink, Maximize, Check, ChevronRight } from 'lucide-react';

export function WorkspaceMenus() {
  return <nav className="workspace-menubar" aria-label="Project menus">
    <button id="file-menu-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="file-menu">File</button>
    <button id="view-menu-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="view-menu">View</button>
    <div id="file-menu" className="workspace-menu" role="menu" aria-label="File" hidden>
      <button type="button" role="menuitem" data-menu-action="settings"><Settings />Settings<span className="menu-shortcut">⌘ / Ctrl ,</span></button>
    </div>
    <div id="view-menu" className="workspace-menu" role="menu" aria-label="View" hidden>
      <p>Layout options</p>
      <button role="menuitemradio" aria-checked="true" data-layout="split"><Columns2 />Split view<Check className="menu-check" /></button>
      <button role="menuitemradio" aria-checked="false" data-layout="editor"><PanelRightClose />Editor only<Check className="menu-check" /></button>
      <button role="menuitemradio" aria-checked="false" data-layout="pdf"><PanelLeftClose />PDF only<Check className="menu-check" /></button>
      <button role="menuitem" data-menu-action="open-pdf"><ExternalLink />Open PDF in separate tab</button>
      <hr />
      <button role="menuitemcheckbox" aria-checked="false" data-menu-action="focus"><Maximize />Focus mode<span className="menu-shortcut">Ctrl ⇧ M</span><Check className="menu-check" /></button>
      <button role="menuitemcheckbox" aria-checked="true" data-menu-action="files">Show file browser<Check className="menu-check" /></button>
      <hr /><p>Editor</p>
      <button role="menuitemcheckbox" aria-checked="true" data-menu-action="tabs">Show editor tabs<Check className="menu-check" /></button>
      <button role="menuitemcheckbox" aria-checked="false" data-menu-action="suggest">Suggest edits<Check className="menu-check" /></button>
      <button role="menuitem" data-menu-action="editor-settings">Editor settings<ChevronRight className="menu-end" /></button>
      <hr /><p>PDF preview</p>
      <button role="menuitem" data-menu-action="zoom-out">Zoom out<span className="menu-shortcut">−</span></button>
      <button role="menuitem" data-menu-action="zoom-reset">Fit to width</button>
      <button role="menuitem" data-menu-action="zoom-in">Zoom in<span className="menu-shortcut">+</span></button>
    </div>
  </nav>;
}

function Toggle({ id, title, description }: { id: string; title: string; description: string }) {
  return <label className="preference-row" htmlFor={id}><span><strong>{title}</strong><small>{description}</small></span><input id={id} type="checkbox" role="switch" /></label>;
}

export function SettingsDialogs() {
  return <>
    <dialog id="settings-dialog" className="settings-dialog" aria-labelledby="settings-title">
      <header className="settings-heading"><div><h2 id="settings-title">Settings</h2><p>Make room for your way of working.</p></div><button id="settings-close" className="settings-close" aria-label="Close settings"><X /></button></header>
      <div className="settings-body">
        <nav className="settings-tabs" role="tablist" aria-label="Settings" aria-orientation="vertical">
          <button id="settings-tab-appearance" role="tab" aria-selected="true" aria-controls="settings-appearance" data-settings-tab="appearance"><Palette />Appearance</button>
          <button id="settings-tab-editor" role="tab" aria-selected="false" aria-controls="settings-editor" data-settings-tab="editor" tabIndex={-1}><TextCursorInput />Editor</button>
          <button id="settings-tab-pdf" role="tab" aria-selected="false" aria-controls="settings-pdf" data-settings-tab="pdf" tabIndex={-1}><FileText />PDF</button>
        </nav>
        <div className="settings-content">
          <section id="settings-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance">
            <h3>Appearance</h3><p className="settings-description">Choose a comfortable space for long writing sessions.</p>
            <fieldset className="theme-choices"><legend>Interface theme</legend>{(['light', 'dark', 'system'] as const).map(theme => <label key={theme}><input type="radio" name="appearance-theme" value={theme} /><span className={`theme-swatch theme-swatch-${theme}`}><i /><i /><i /></span><span>{theme === 'light' ? <Sun /> : theme === 'dark' ? <Moon /> : <Monitor />}{theme[0].toUpperCase() + theme.slice(1)}</span></label>)}</fieldset>
            <h4>In dark mode</h4>
            <Toggle id="setting-dark-editor" title="Dark source editor" description="Use a dark canvas and lighter syntax colors for LaTeX." />
            <Toggle id="setting-dark-pdf" title="Dark PDF pages" description="Display dark paper with light text. Applies to the preview." />
            <p id="dark-mode-hint" className="settings-note">These choices take effect when the interface is dark.</p>
          </section>
          <section id="settings-editor" role="tabpanel" aria-labelledby="settings-tab-editor" hidden>
            <h3>Editor</h3><p className="settings-description">Tune the source editor without changing your document.</p>
            <label className="preference-row" htmlFor="setting-font-size"><span><strong>Font size</strong><small>LaTeX source text, in pixels.</small></span><select id="setting-font-size">{[11,12,13,14,15,16,18,20,22,24].map(size => <option key={size} value={size}>{size} px</option>)}</select></label>
            <label className="preference-row" htmlFor="setting-line-height"><span><strong>Line spacing</strong><small>Space between lines of source.</small></span><select id="setting-line-height"><option value="1.4">Compact</option><option value="1.6">Comfortable</option><option value="1.9">Relaxed</option></select></label>
            <Toggle id="setting-wrap" title="Wrap long lines" description="Keep long lines within the editor width." />
            <Toggle id="setting-line-numbers" title="Line numbers" description="Show line numbers beside your source." />
            <Toggle id="setting-tabs" title="Editor tabs" description="Quickly switch between open files." />
          </section>
          <section id="settings-pdf" role="tabpanel" aria-labelledby="settings-tab-pdf" hidden>
            <h3>PDF</h3><p className="settings-description">Preview comfortably. Export deliberately.</p>
            <label className="preference-row" htmlFor="setting-pdf-zoom"><span><strong>Preview zoom</strong><small>Relative to the page width. Ctrl + scroll also zooms.</small></span><select id="setting-pdf-zoom"><option value="0.75">75%</option><option value="1">Fit to width</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select></label>
            <div className="pdf-export-note"><FileText /><div><strong>A choice with every dark-mode download</strong><p>Choose the original white paper for sharing and printing, or dark paper for reading. Your compiled original is always kept.</p><p>Dark export keeps text and formulas sharp. Image and chart colors also change with the page palette.</p></div></div>
          </section>
        </div>
      </div>
      <footer className="settings-footer"><span>Saved automatically in this browser</span><button id="settings-done">Done</button></footer>
    </dialog>
    <dialog id="pdf-download-dialog" className="pdf-download-dialog" aria-labelledby="pdf-download-title">
      <header className="settings-heading"><div><h2 id="pdf-download-title">Download PDF</h2><p>Choose the paper that suits your next step.</p></div><button id="pdf-download-close" className="settings-close" aria-label="Close download dialog"><X /></button></header>
      <div className="download-options">
        <button id="download-white"><span className="download-paper paper-white">Aa<span>∑ x² + y²</span></span><strong>White paper</strong><small>Original PDF · best for printing</small></button>
        <button id="download-dark"><span className="download-paper paper-dark">Aa<span>∑ x² + y²</span></span><strong>Dark paper</strong><small>Light text · comfortable reading</small></button>
      </div>
      <p className="download-note">Dark paper also recolors images and charts. Both versions keep text selectable.</p>
      <p id="pdf-download-status" role="status" aria-live="polite" />
    </dialog>
  </>;
}
