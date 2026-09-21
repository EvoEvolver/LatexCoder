type Version = { id: string; shortId: string; date: string; subject: string; metadata?: { kind?: string; agentName?: string; mode?: string } };
type ChangedFile = { path: string; added: number | null; removed: number | null };
type Detail = { version: Version; files: ChangedFile[]; currentRevision: string; structure: { foldersAdded: string[]; foldersRemoved: string[]; main: { before: string; after: string } | null } };
type Dependencies = {
  request<T>(url: string, options?: RequestInit): Promise<T>;
  confirm(options: { title: string; message: string; submitLabel: string; danger: boolean }): Promise<unknown>;
  restored(): Promise<void>;
  project(): string;
};
const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function createVersionHistory(deps: Dependencies) {
  let agentOnly = false, cursor: string | null = null, selected: Detail | null = null, file = "";
  let generation = 0, selectionGeneration = 0, fileGeneration = 0, restoring = false;
  const list = node("git-history"), error = node("history-error"), diff = node("history-diff");
  const restore = node<HTMLButtonElement>("history-restore"), restoreFile = node<HTMLButtonElement>("history-restore-file");
  const more = node<HTMLButtonElement>("history-more");
  function fail(reason: unknown) { error.textContent = reason instanceof Error ? reason.message : "Could not load version history. Try refreshing."; error.hidden = false; }
  function clearPreview() {
    node("history-preview").setAttribute("aria-busy", "false");
    selected = null; file = ""; selectionGeneration++; fileGeneration++;
    restore.disabled = true; restoreFile.hidden = true;
    node("history-title").textContent = "Select a version";
    node("history-meta").textContent = "Inspect changes before restoring. Restores always preserve your current work.";
    node("history-structure").hidden = true;
    node("history-files").replaceChildren(); diff.replaceChildren(); error.hidden = true;
    node("history-file-label").textContent = "Changes compared with the previous version";
    node("history-diff-note").textContent = "";
  }
  async function showFile(path: string) {
    if (!selected || restoring) return;
    file = path;
    const id = selected.version.id, epoch = ++fileGeneration, project = deps.project();
    restoreFile.hidden = false; restoreFile.disabled = true;
    node("history-file-label").textContent = path;
    node("history-diff-note").textContent = "";
    diff.textContent = "Loading changes…";
    for (const button of node("history-files").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.path === path));
    try {
      const result = await deps.request<{ patch: string; truncated: boolean }>(`v1/history/${id}?path=${encodeURIComponent(path)}`);
      if (epoch !== fileGeneration || project !== deps.project()) return;
      diff.replaceChildren();
      let oldLine = 0, newLine = 0, inHunk = false;
      for (const text of result.patch.split("\n")) {
        if (!inHunk && /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode )/.test(text)) continue;
        const line = document.createElement("span"); line.className = "version-diff-line";
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        let before = "", after = "";
        if (header) { inHunk = true; oldLine = Number(header[1]); newLine = Number(header[2]); line.classList.add("diff-hunk"); }
        else if (inHunk && text.startsWith("+")) { line.classList.add("diff-added"); after = String(newLine++); }
        else if (inHunk && text.startsWith("-")) { line.classList.add("diff-removed"); before = String(oldLine++); }
        else if (text.startsWith(" ")) { before = String(oldLine++); after = String(newLine++); }
        for (const value of [before, after]) { const gutter = document.createElement("span"); gutter.className = "diff-line-number"; gutter.textContent = value; gutter.setAttribute("aria-hidden", "true"); line.append(gutter); }
        const code = document.createElement("span"); code.textContent = text || " "; line.append(code); diff.append(line);
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
      restore.disabled = false;
      if (detail.files.length) await showFile(detail.files[0].path);
      else diff.textContent = "No file changes in this checkpoint.";
    } catch (reason) { if (epoch === selectionGeneration && project === deps.project()) fail(reason); }
    finally { if (epoch === selectionGeneration) node("history-preview").setAttribute("aria-busy", "false"); }
  }
  async function refresh(append = false) {
    if (restoring) return;
    const epoch = ++generation, project = deps.project();
    if (!append) { cursor = null; list.replaceChildren(); clearPreview(); list.textContent = "Loading versions…"; }
    more.disabled = true; error.hidden = true;
    try {
      const result = await deps.request<{ items: Version[]; next: string | null }>(`v1/history?agent=${agentOnly ? "1" : "0"}${append && cursor ? `&before=${cursor}` : ""}`);
      if (epoch !== generation || project !== deps.project()) return;
      if (!append) list.replaceChildren();
      for (const version of result.items) {
        const button = document.createElement("button"); button.type = "button"; button.className = "version-row"; button.dataset.version = version.id; button.setAttribute("aria-pressed", "false");
        const title = document.createElement("strong"); title.textContent = version.subject;
        const subtitle = document.createElement("span"); subtitle.textContent = `${new Date(version.date).toLocaleString()} · ${version.shortId}`;
        const kind = document.createElement("small"); kind.textContent = version.metadata?.kind === "agent" ? `Agent · ${version.metadata.agentName || "Coding agent"}` : version.metadata?.kind === "restore" ? "Restored version" : "Checkpoint";
        button.append(kind, title, subtitle); button.addEventListener("click", () => void select(version)); list.append(button);
      }
      if (!list.childElementCount) list.textContent = agentOnly ? "No agent edits yet. Checked API edits appear here automatically." : "No saved versions yet.";
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
  node("history-all").addEventListener("click", () => filter(false));
  node("history-agents").addEventListener("click", () => filter(true));
  function filter(value: boolean) {
    if (restoring) return;
    agentOnly = value; node("history-all").setAttribute("aria-pressed", String(!value)); node("history-agents").setAttribute("aria-pressed", String(value)); void refresh();
  }
  more.addEventListener("click", () => void refresh(true));
  restore.addEventListener("click", () => void restoreSelected(false));
  restoreFile.addEventListener("click", () => void restoreSelected(true));
  return { refresh };
}
