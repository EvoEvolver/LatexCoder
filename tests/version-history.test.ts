import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createPaperServer } from "../src/server/main.ts";

async function fixture(run: (context: any) => Promise<void>) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-history-"));
  let paper: Awaited<ReturnType<typeof createPaperServer>>;
  let base: string;
  async function start() {
    paper = await createPaperServer({ stateDir, authDisabled: true, gitCheckpointIdleMs: 3_600_000, gitCheckpointMaxWaitMs: 3_600_000 });
    await new Promise<void>(resolve => paper.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(paper.server.address() as AddressInfo).port}`;
  }
  async function stop() { paper.shutdown(); paper.sockets.close(); await new Promise<void>(resolve => paper.server.close(() => resolve())); }
  await start();
  const api = async (url: string, options?: RequestInit) => {
    const response = await fetch(`${base}/${url}`, options);
    const data = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(data)}`);
    return data;
  };
  const post = (url: string, body = {}) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const put = (file: string, body: string | Buffer) => api(`v1/files?path=${encodeURIComponent(file)}`, { method: "PUT", body: typeof body === "string" ? body : new Uint8Array(body) });
  const read = async (file: string) => (await fetch(`${base}/v1/files?path=${encodeURIComponent(file)}`)).text();
  const checkpoint = async (message: string) => (await post("v1/git/commit", { message })).git.commit;
  const restore = async (id: string, file?: string) => {
    const detail = await api(`v1/history/${id}`);
    return post(`v1/history/${id}/restore`, { currentRevision: detail.currentRevision, path: file });
  };
  try { await run({ api, post, put, read, checkpoint, restore, fetch: (url: string, options?: RequestInit) => fetch(`${base}/${url}`, options), restart: async () => { await stop(); await start(); }, paper: () => paper }); }
  finally { await stop(); await rm(stateDir, { recursive: true, force: true }); }
}

test("agent edits have isolated persistent diffs and restoring preserves the current project", async () => {
  await fixture(async ({ api, put, read, restore, fetch, restart, paper }) => {
    await put("main.tex", "Human baseline\n");
    await put("notes.tex", "Uncommitted human note\n");
    const current = await fetch("v1/files?path=main.tex");
    const edited = await fetch("v1/files/edit?path=main.tex&agentId=writer&agentName=Research%20agent", {
      method: "POST", headers: { "X-Base-SHA256": current.headers.get("x-content-sha256") }, body: "Agent formula $E=mc^2$\n",
    });
    assert.equal(edited.status, 200, await edited.clone().text());
    const { edit } = await edited.json();
    assert.match(edit.version, /^[a-f0-9]{40}$/);
    const history = await api("v1/history?agent=1");
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].metadata.agentName, "Research agent");
    const details = await api(`v1/history/${edit.version}`);
    assert.deepEqual(details.files.map(file => file.path), ["main.tex"]);
    const diff = await api(`v1/history/${edit.version}?path=main.tex`);
    assert.match(diff.patch, /-Human baseline/);
    assert.match(diff.patch, /\+Agent formula/);
    await restart();
    assert.equal((await api("v1/history?agent=1")).items[0].id, edit.version);
    await put("main.tex", "Later human work\n");
    const restored = await restore(edit.version);
    assert.equal(await read("main.tex"), "Agent formula $E=mc^2$\n");
    assert.equal(paper().collaboration.readText("main.tex"), await read("main.tex"));
    assert.equal(await read("notes.tex"), "Uncommitted human note\n");
    await restore(restored.backup);
    assert.equal(await read("main.tex"), "Later human work\n");
  });
});

test("history restores binary files, deletions, empty folders, main rename and single files", async () => {
  await fixture(async ({ api, post, put, read, checkpoint, restore, fetch }) => {
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
    await put("figures/plot.png", bytes);
    await put("main.tex", "Version one\n");
    await post("v1/files/folder", { path: "empty/research" });
    const first = await checkpoint("First version");
    await post("v1/files/move", { from: "main.tex", to: "chapters/main.tex" });
    await put("chapters/main.tex", "Version two\n");
    await put("other.tex", "Keep this file\n");
    await fetch("v1/files?path=figures/plot.png", { method: "DELETE" });
    await fetch("v1/files?path=empty", { method: "DELETE" });
    await checkpoint("Second version");
    await restore(first, "figures/plot.png");
    assert.deepEqual(Buffer.from(await (await fetch("v1/files?path=figures/plot.png")).arrayBuffer()), bytes);
    assert.equal(await read("other.tex"), "Keep this file\n");
    assert.equal((await api("v1/project")).project.main, "chapters/main.tex");
    await restore(first);
    const project = (await api("v1/project")).project;
    assert.equal(project.main, "main.tex");
    assert.equal(await read("main.tex"), "Version one\n");
    assert.ok(project.folders.includes("empty/research"));
    assert.equal((await fetch("v1/files?path=other.tex")).status, 404);
    assert.equal(project.folders.includes("chapters"), false);
  });
});

test("stale restore includes review-only edits and cannot discard concurrent work", async () => {
  await fixture(async ({ api, put, post, checkpoint, fetch, read }) => {
    await put("main.tex", "Hello\n");
    const id = await checkpoint("Baseline");
    const preview = await api(`v1/history/${id}`);
    const commented = "\\cmtbg{c1}{Reviewer}Hello\\cmted{A new review comment}\n";
    await put("main.tex", commented);
    const response = await fetch(`v1/history/${id}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentRevision: preview.currentRevision }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "stale_restore");
    assert.equal(await read("main.tex"), commented);
    assert.equal((await fetch("v1/history/HEAD")).status, 400);
    assert.equal((await fetch(`v1/history/${id}?path=../outside`)).status, 400);
    const missing = await fetch(`v1/history/${id}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(missing.status, 409);
  });
});

test("history paginates all saved versions without duplicates", async () => {
  await fixture(async ({ api, put, checkpoint }) => {
    for (let index = 0; index < 33; index++) { await put("main.tex", `Version ${index}\n`); await checkpoint(`Checkpoint ${index}`); }
    const first = await api("v1/history");
    assert.equal(first.items.length, 30);
    assert.ok(first.next);
    const second = await api(`v1/history?before=${first.next}`);
    assert.ok(second.items.length >= 4);
    assert.equal(second.next, null);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, first.items.length + second.items.length);
  });
});

test("agent asset operations and patches are attributed, and invalid drafts remain restorable", async () => {
  await fixture(async ({ api, post, put, read, restore, checkpoint, fetch }) => {
    await put("main.tex", "\\revbg{unfinished review storage\n");
    const draft = await checkpoint("Unfinished draft");
    await put("main.tex", "Valid again\n");
    const upload = await fetch("v1/files?path=figures/chart.png&agentId=plotter&agentName=Plotter", { method: "PUT", body: new Uint8Array([137, 80, 78, 71]) });
    assert.equal(upload.status, 201);
    await post("v1/files/folder?agentId=plotter&agentName=Plotter", { path: "empty-agent-folder" });
    let history = await api("v1/history?agent=1");
    assert.equal(history.items.length, 2);
    assert.equal(history.items[0].metadata.agentName, "Plotter");
    const asset = history.items.find(item => item.subject.startsWith("Agent upload"));
    const changes = await api(`v1/history/${asset.id}`);
    assert.deepEqual(changes.files.map(file => file.path), ["figures/chart.png"]);
    const current = await fetch("v1/files?path=main.tex");
    await post("v1/files/patch?path=main.tex", { baseSha256: current.headers.get("x-content-sha256"), agent: { id: "ag_proofreader", name: "Proofreader" }, changes: [{ from: 0, to: 5, insert: "Revised" }] });
    history = await api("v1/history?agent=1");
    assert.equal(history.items[0].metadata.agentName, "Proofreader");
    await restore(draft);
    assert.equal(await read("main.tex"), "\\revbg{unfinished review storage\n");
  });
});

test("restoring a file over a directory works in both directions", async () => {
  await fixture(async ({ post, put, checkpoint, restore, fetch, read }) => {
    await put("notes.tex", "A standalone file\n");
    const fileVersion = await checkpoint("File");
    assert.equal((await fetch("v1/files?path=notes.tex", { method: "DELETE" })).status, 200);
    await put("notes.tex/nested.tex", "A nested file\n");
    const directoryVersion = await checkpoint("Directory");
    await restore(fileVersion);
    assert.equal(await read("notes.tex"), "A standalone file\n");
    await restore(directoryVersion);
    assert.equal(await read("notes.tex/nested.tex"), "A nested file\n");
  });
});
