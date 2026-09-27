import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

export function VersionHistory() {
  return <section className="version-browser" aria-label="Persistent version history">
    <div className="version-timeline">
      <div className="version-filters" role="group" aria-label="Filter versions">
        <Button id="history-all" variant="ghost" size="sm" aria-pressed="true">All versions</Button>
        <Button id="history-agents" variant="ghost" size="sm" aria-pressed="false">Agent edits</Button>
        <Button id="history-labeled" variant="ghost" size="sm" aria-pressed="false">Labeled</Button>
      </div>
      <div className="version-summary">
        <p className="version-help">Saved automatically after 30 seconds idle, or every 5 minutes while editing.</p>
        <span id="history-version-count" className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground" role="status" />
      </div>
      <div id="git-history" className="version-list" aria-label="Saved versions" />
      <Button id="history-more" variant="ghost" size="sm" hidden>Load older versions</Button>
    </div>
    <div className="version-preview" aria-busy="false" id="history-preview">
      <div className="version-preview-heading">
        <h3 id="history-title">Select a version</h3>
        <p id="history-meta">Inspect changes before restoring. Restores always preserve your current work.</p>
        <div id="history-labels" className="mt-2 flex flex-wrap gap-1" aria-label="Version labels" />
        <form id="history-label-form" className="mt-2 flex max-w-sm gap-2">
          <Input id="history-label-input" className="h-8" maxLength={40} placeholder="Add label, e.g. arxiv-v1" aria-label="New version label" />
          <Button type="submit" variant="outline" size="sm">Add label</Button>
        </form>
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
