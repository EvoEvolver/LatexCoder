import { Localized, Message } from './Localized';
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

export function VersionHistory() {
  return <Localized aria-label="Persistent version history"><section className="version-browser" aria-label="Persistent version history">
    <div className="version-timeline">
      <Localized aria-label="Filter versions"><div className="version-filters" role="group" aria-label="Filter versions">
        <Button id="history-all" variant="ghost" size="sm" aria-pressed="true"><Message id="All versions" /></Button>
        <Button id="history-agents" variant="ghost" size="sm" aria-pressed="false"><Message id="Agent edits" /></Button>
        <Button id="history-labeled" variant="ghost" size="sm" aria-pressed="false"><Message id="Labeled" /></Button>
      </div></Localized>
      <div className="version-summary">
        <p className="version-help"><Message id="Saved automatically after 30 seconds idle, or every 5 minutes while editing." /></p>
        <span id="history-version-count" className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground" role="status" />
      </div>
      <Localized aria-label="Saved versions"><div id="git-history" className="version-list" aria-label="Saved versions" /></Localized>
      <Button id="history-more" variant="ghost" size="sm" hidden><Message id="Load older versions" /></Button>
    </div>
    <div className="version-preview" aria-busy="false" id="history-preview">
      <div className="version-preview-heading">
        <h3 id="history-title"><Message id="Select a version" /></h3>
        <p id="history-meta"><Message id="Inspect changes before restoring. Restores always preserve your current work." /></p>
        <Localized aria-label="Version labels"><div id="history-labels" className="mt-2 flex flex-wrap gap-1" aria-label="Version labels" /></Localized>
        <form id="history-label-form" className="mt-2 flex max-w-sm gap-2">
          <Localized placeholder="Add label, e.g. arxiv-v1" aria-label="New version label"><Input id="history-label-input" className="h-8" maxLength={40} placeholder="Add label, e.g. arxiv-v1" aria-label="New version label" /></Localized>
          <Button type="submit" variant="outline" size="sm"><Message id="Add label" /></Button>
        </form>
      </div>
      <div id="history-error" role="alert" hidden />
      <p id="history-structure" className="version-structure" hidden />
      <Localized aria-label="Changed files"><div id="history-files" aria-label="Changed files" /></Localized>
      <div className="version-diff-heading"><span id="history-file-label"><Message id="Changes compared with the previous version" /></span><Button id="history-restore-file" variant="ghost" size="sm" hidden><Message id="Restore file" /></Button></div>
      <Localized aria-label="File changes"><pre id="history-diff" className="version-diff" tabIndex={0} aria-label="File changes" /></Localized>
      <div className="version-restore"><span id="history-diff-note" role="status" /><Button id="history-restore" variant="outline" size="sm" disabled><Message id="Restore this version" /></Button></div>
    </div>
  </section></Localized>;
}
