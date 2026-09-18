import { Button } from "./components/ui/button";

export function VersionHistory() {
  return <section className="version-browser" aria-label="Persistent version history">
    <div className="version-timeline">
      <div className="version-filters" role="group" aria-label="Filter versions">
        <Button id="history-all" variant="ghost" size="sm" aria-pressed="true">All versions</Button>
        <Button id="history-agents" variant="ghost" size="sm" aria-pressed="false">Agent edits</Button>
      </div>
      <p className="version-help">Saved automatically after 30 seconds idle, or every 5 minutes while editing.</p>
      <div id="git-history" className="version-list" aria-label="Saved versions" />
      <Button id="history-more" variant="ghost" size="sm" hidden>Load older versions</Button>
    </div>
    <div className="version-preview" aria-busy="false" id="history-preview">
      <div className="version-preview-heading">
        <h3 id="history-title">Select a version</h3>
        <p id="history-meta">Inspect changes before restoring. Restores always preserve your current work.</p>
      </div>
      <div id="history-error" role="alert" hidden />
      <p id="history-structure" className="version-structure" hidden />
      <div id="history-files" aria-label="Changed files" />
      <div className="version-diff-heading"><span id="history-file-label">Changes compared with the previous version</span><Button id="history-restore-file" variant="ghost" size="sm" hidden>Restore file</Button></div>
      <pre id="history-diff" className="version-diff" tabIndex={0} aria-label="File changes" />
      <div className="version-restore"><span id="history-diff-note" role="status" /><Button id="history-restore" variant="outline" size="sm" disabled>Restore this version</Button></div>
    </div>
  </section>;
}
