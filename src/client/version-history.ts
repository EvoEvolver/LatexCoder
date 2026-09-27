import { diffWordsWithSpace } from "diff";

type Version = { id: string; shortId: string; date: string; subject: string; labels: string[]; metadata?: { kind?: string; agentName?: string; mode?: string } };
type VersionFilter = "all" | "agent" | "labeled";
type ChangedFile = { path: string; added: number | null; removed: number | null };
type Detail = { version: Version; files: ChangedFile[]; currentRevision: string; structure: { foldersAdded: string[]; foldersRemoved: string[]; main: { before: string; after: string } | null } };
type Dependencies = {
  request<T>(url: string, options?: RequestInit): Promise<T>;
  confirm(options: { title: string; message: string; submitLabel: string; danger: boolean }): Promise<unknown>;
  restored(): Promise<void>;
  project(): string;
  editable(): boolean;
};
const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type ParsedDiffLine = {
  text: string;
  kind: "added" | "removed" | "context" | "hunk";
  before: string;
  after: string;
  counterpart?: string;
};

function appendWordDiff(code: HTMLElement, line: ParsedDiffLine): void {
  const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : "";
  if (!line.counterpart || !marker) {
    code.textContent = line.text || " ";
    return;
  }
  code.append(document.createTextNode(marker));
  const removed = line.kind === "removed" ? line.text.slice(1) : line.counterpart.slice(1);
  const added = line.kind === "added" ? line.text.slice(1) : line.counterpart.slice(1);
  for (const part of diffWordsWithSpace(removed, added)) {
    if ((line.kind === "removed" && part.added) || (line.kind === "added" && part.removed)) continue;
    if ((line.kind === "removed" && part.removed) || (line.kind === "added" && part.added)) {
      const changed = document.createElement("mark");
      changed.className = line.kind === "removed" ? "diff-word-removed" : "diff-word-added";
      changed.textContent = part.value;
      code.append(changed);
    } else code.append(document.createTextNode(part.value));
  }
}

function pairChangedLines(lines: ParsedDiffLine[]): void {
  for (let index = 0; index < lines.length;) {
    if (lines[index].kind !== "removed") { index += 1; continue; }
    const removedStart = index;
    while (index < lines.length && lines[index].kind === "removed") index += 1;
    const addedStart = index;
    while (index < lines.length && lines[index].kind === "added") index += 1;
    const pairs = Math.min(addedStart - removedStart, index - addedStart);
    for (let offset = 0; offset < pairs; offset += 1) {
      lines[removedStart + offset].counterpart = lines[addedStart + offset].text;
      lines[addedStart + offset].counterpart = lines[removedStart + offset].text;
    }
  }
}

export function createVersionHistory(deps: Dependencies) {
  let filter: VersionFilter = "all", cursor: string | null = null, selected: Detail | null = null, file = "";
  let generation = 0, selectionGeneration = 0, fileGeneration = 0, restoring = false;
  const list = node("git-history"), error = node("history-error"), diff = node("history-diff");
  const restore = node<HTMLButtonElement>("history-restore"), restoreFile = node<HTMLButtonElement>("history-restore-file");
  const more = node<HTMLButtonElement>("history-more"), versionCount = node("history-version-count");
  const labelForm = node<HTMLFormElement>("history-label-form"), labelInput = node<HTMLInputElement>("history-label-input");
  function fail(reason: unknown) { error.textContent = reason instanceof Error ? reason.message : "Could not load version history. Try refreshing."; error.hidden = false; }
  function clearPreview() {
    node("history-preview").setAttribute("aria-busy", "false");
    selected = null; file = ""; selectionGeneration++; fileGeneration++;
    restore.disabled = true; restoreFile.hidden = true;
    labelForm.hidden = true;
    node("history-labels").replaceChildren();
    node("history-title").textContent = "Select a version";
    node("history-meta").textContent = "Inspect changes before restoring. Restores always preserve your current work.";
    node("history-structure").hidden = true;
    node("history-files").replaceChildren(); diff.replaceChildren(); error.hidden = true;
    node("history-file-label").textContent = "Changes compared with the previous version";
    node("history-diff-note").textContent = "";
  }
  function labelBadge(value: string, removable: boolean): HTMLElement {
    const badge = document.createElement("span");
    badge.className = "inline-flex max-w-full items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-foreground";
    const text = document.createElement("span"); text.className = "truncate"; text.textContent = value; badge.append(text);
    if (removable) {
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "text-muted-foreground hover:text-foreground";
      remove.textContent = "x"; remove.title = `Remove ${value}`; remove.setAttribute("aria-label", `Remove label ${value}`);
      remove.addEventListener("click", () => void changeLabel(value, true)); badge.append(remove);
    }
    return badge;
  }
  function showSelectedLabels(): void {
    const container = node("history-labels"); container.replaceChildren();
    if (!selected) return;
    for (const label of selected.version.labels) container.append(labelBadge(label, deps.editable()));
    labelForm.hidden = !deps.editable();
  }
  function showRowLabels(version: Version, container: HTMLElement): void {
    container.replaceChildren(...version.labels.map(label => labelBadge(label, false)));
    container.hidden = version.labels.length === 0;
  }
  async function changeLabel(label: string, remove: boolean): Promise<void> {
    if (!selected || !deps.editable()) return;
    const version = selected.version, project = deps.project();
    error.hidden = true;
    try {
      const result = await deps.request<{ labels: string[] }>(`v1/history/${version.id}/labels`, {
        method: remove ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!selected || selected.version.id !== version.id || project !== deps.project()) return;
      selected.version.labels = result.labels;
      showSelectedLabels();
      const rowLabels = list.querySelector<HTMLElement>(`[data-version="${version.id}"] .version-labels`);
      if (rowLabels) showRowLabels(selected.version, rowLabels);
      if (filter === "labeled" && !result.labels.length) await refresh();
    } catch (reason) { if (project === deps.project()) fail(reason); }
  }
  async function showFile(path: string) {
    if (!selected || restoring) return;
    file = path;
    const id = selected.version.id, epoch = ++fileGeneration, project = deps.project();
    restoreFile.hidden = !deps.editable(); restoreFile.disabled = true;
    node("history-file-label").textContent = path;
    node("history-diff-note").textContent = "";
    diff.textContent = "Loading changes…";
    for (const button of node("history-files").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.path === path));
    try {
      const result = await deps.request<{ patch: string; truncated: boolean }>(`v1/history/${id}?path=${encodeURIComponent(path)}`);
      if (epoch !== fileGeneration || project !== deps.project()) return;
      diff.replaceChildren();
      let oldLine = 0, newLine = 0, inHunk = false;
      const lines: ParsedDiffLine[] = [];
      for (const text of result.patch.split("\n")) {
        if (!inHunk && /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode )/.test(text)) continue;
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        let before = "", after = "";
        let kind: ParsedDiffLine["kind"] = "context";
        if (header) { inHunk = true; oldLine = Number(header[1]); newLine = Number(header[2]); kind = "hunk"; }
        else if (inHunk && text.startsWith("+")) { kind = "added"; after = String(newLine++); }
        else if (inHunk && text.startsWith("-")) { kind = "removed"; before = String(oldLine++); }
        else if (text.startsWith(" ")) { before = String(oldLine++); after = String(newLine++); }
        lines.push({ text, kind, before, after });
      }
      pairChangedLines(lines);
      for (const parsed of lines) {
        const line = document.createElement("span");
        line.className = `version-diff-line diff-${parsed.kind}`;
        for (const value of [parsed.before, parsed.after]) { const gutter = document.createElement("span"); gutter.className = "diff-line-number"; gutter.textContent = value; gutter.setAttribute("aria-hidden", "true"); line.append(gutter); }
        const code = document.createElement("span"); code.className = "diff-code"; appendWordDiff(code, parsed); line.append(code); diff.append(line);
      }
      if (!result.patch) diff.textContent = "No textual changes in this file.";
      node("history-diff-note").textContent = result.truncated ? "Large diff truncated. Clone the project to inspect the complete change." : "− removed  /  + added";
      restoreFile.disabled = false;
    } catch (reason) { if (epoch === fileGeneration && project === deps.project()) { diff.textContent = ""; fail(reason); } }
  }
  async function select(version: Version) {
    if (restoring) return;
    clearPreview();
    const epoch = ++selectionGeneration, project = deps.project();
    node("history-title").textContent = version.subject;
    node("history-meta").textContent = "Loading version…";
    node("history-preview").setAttribute("aria-busy", "true");
    for (const button of list.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.version === version.id));
    try {
      const detail = await deps.request<Detail>(`v1/history/${version.id}`);
      if (epoch !== selectionGeneration || project !== deps.project()) return;
      selected = detail;
      showSelectedLabels();
      const structure = detail.structure;
      const structureText = [structure.foldersAdded.length ? `Folders added: ${structure.foldersAdded.join(", ")}` : "", structure.foldersRemoved.length ? `Folders removed: ${structure.foldersRemoved.join(", ")}` : "", structure.main ? `Main document: ${structure.main.before} → ${structure.main.after}` : ""].filter(Boolean).join(" · ");
      node("history-structure").textContent = structureText;
      node("history-structure").hidden = !structureText;
      const metadata = version.metadata;
      node("history-meta").textContent = `${new Date(version.date).toLocaleString()} · ${version.shortId}${metadata?.kind === "agent" ? ` · ${metadata.agentName || "Coding agent"} · ${metadata.mode === "suggesting" ? "Suggestions" : "Direct edit"}` : ""}`;
      for (const item of detail.files) {
        const button = document.createElement("button"); button.type = "button"; button.dataset.path = item.path;
        const label = document.createElement("span"); label.textContent = item.path;
        const count = document.createElement("small"); count.textContent = item.added === null ? "Binary" : `+${item.added} −${item.removed}`;
        button.append(label, count); button.addEventListener("click", () => void showFile(item.path)); node("history-files").append(button);
      }
      restore.disabled = !deps.editable();
      if (detail.files.length) await showFile(detail.files[0].path);
      else diff.textContent = "No file changes in this checkpoint.";
    } catch (reason) { if (epoch === selectionGeneration && project === deps.project()) fail(reason); }
    finally { if (epoch === selectionGeneration) node("history-preview").setAttribute("aria-busy", "false"); }
  }
  async function refresh(append = false) {
    if (restoring) return;
    const epoch = ++generation, project = deps.project();
    if (!append) { cursor = null; list.replaceChildren(); clearPreview(); list.textContent = "Loading versions…"; versionCount.textContent = ""; }
    more.disabled = true; error.hidden = true;
    try {
      const result = await deps.request<{ items: Version[]; next: string | null; total: number }>(`v1/history?filter=${filter}${append && cursor ? `&before=${cursor}` : ""}`);
      if (epoch !== generation || project !== deps.project()) return;
      versionCount.textContent = `${result.total} ${result.total === 1 ? "version" : "versions"}`;
      if (!append) list.replaceChildren();
      for (const version of result.items) {
        const button = document.createElement("button"); button.type = "button"; button.className = "version-row"; button.dataset.version = version.id; button.setAttribute("aria-pressed", "false");
        const title = document.createElement("strong"); title.textContent = version.subject;
        const subtitle = document.createElement("span"); subtitle.textContent = `${new Date(version.date).toLocaleString()} · ${version.shortId}`;
        const kind = document.createElement("small"); kind.textContent = version.metadata?.kind === "agent" ? `Agent · ${version.metadata.agentName || "Coding agent"}` : version.metadata?.kind === "restore" ? "Restored version" : "Checkpoint";
        const labels = document.createElement("span"); labels.className = "version-labels flex flex-wrap gap-1"; showRowLabels(version, labels);
        button.append(kind, title, subtitle, labels); button.addEventListener("click", () => void select(version)); list.append(button);
      }
      if (!list.childElementCount) list.textContent = filter === "agent" ? "No agent edits yet. Checked API edits appear here automatically." : filter === "labeled" ? "No labeled versions yet. Add a label to a saved version to keep it easy to find." : "No saved versions yet.";
      cursor = result.next; more.hidden = !cursor;
      if (!append && result.items.length) await select(result.items[0]);
    } catch (reason) { if (epoch === generation && project === deps.project()) { if (!append) list.textContent = "History unavailable"; fail(reason); } }
    finally { if (epoch === generation) more.disabled = false; }
  }
  async function restoreSelected(singleFile: boolean) {
    if (!selected || restoring) return;
    const detail = selected, path = singleFile ? file : undefined, project = deps.project();
    const confirmed = await deps.confirm({ title: path ? "Restore file?" : "Restore project version?", message: `Restore ${path || "all project files"} to ${detail.version.shortId}? Your current work will be saved as a checkpoint first. You can restore that checkpoint to undo this action.`, submitLabel: path ? "Restore file" : "Restore version", danger: true });
    if (!confirmed || project !== deps.project()) return;
    restoring = true; restore.disabled = true; restoreFile.disabled = true; error.hidden = true;
    restore.textContent = "Restoring…";
    try {
      await deps.request(`v1/history/${detail.version.id}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentRevision: detail.currentRevision, path }) });
      await deps.restored(); restoring = false; await refresh();
    } catch (reason) { fail(reason); }
    finally { restoring = false; restore.textContent = "Restore this version"; restore.disabled = !selected; restoreFile.disabled = false; }
  }
  node("history-all").addEventListener("click", () => setFilter("all"));
  node("history-agents").addEventListener("click", () => setFilter("agent"));
  node("history-labeled").addEventListener("click", () => setFilter("labeled"));
  function setFilter(value: VersionFilter) {
    if (restoring) return;
    filter = value;
    for (const name of ["all", "agents", "labeled"] as const) node(`history-${name}`).setAttribute("aria-pressed", String(value === (name === "agents" ? "agent" : name)));
    void refresh();
  }
  labelForm.addEventListener("submit", event => {
    event.preventDefault();
    const value = labelInput.value;
    if (!value.trim()) return;
    labelInput.value = "";
    void changeLabel(value, false);
  });
  more.addEventListener("click", () => void refresh(true));
  restore.addEventListener("click", () => void restoreSelected(false));
  restoreFile.addEventListener("click", () => void restoreSelected(true));
  return { refresh };
}
