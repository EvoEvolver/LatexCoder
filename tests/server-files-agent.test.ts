import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { zipSync, strToU8 } from "fflate";
import { createPaperServer, safeRelativePath } from "../src/server/main.ts";
import { parseReviews, stripReviewStorage } from "../src/shared/review.ts";

import { execFileAsync, testGit, createIncomingBranch, withServer, waitFor, sha256, createFakeLatexmk, createFakeBwrap } from "./helpers/server.ts";

test("file API writes canonical project files", async () => {
  await withServer(async ({ base, projectDir }) => {
    const response = await fetch(`${base}/v1/files?path=chapter.tex`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "A new chapter.\n",
    });
    assert.equal(response.status, 201);
    assert.equal(await readFile(path.join(projectDir, "chapter.tex"), "utf8"), "A new chapter.\n");
    const downloaded = await fetch(`${base}/v1/files?path=chapter.tex`);
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), "A new chapter.\n");
  });
});

test("folders move without overwriting and SQLite trash restores folders and live text", async () => {
  await withServer(async ({ base, collaboration }) => {
    const post = (endpoint, body) => fetch(base + endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("/v1/files/folder", { path: "notes/empty" })).status, 201);
    await fetch(`${base}/v1/files?path=notes/chapter.tex`, { method: "PUT", body: "original" });
    collaboration.load("notes/chapter.tex").doc.getText("content").insert(0, "live ");
    assert.equal((await post("/v1/files/move", { from: "notes", to: "moved" })).status, 200);
    assert.equal(await (await fetch(`${base}/v1/files?path=moved/chapter.tex`)).text(), "live original");
    await fetch(`${base}/v1/files?path=occupied.tex`, { method: "PUT", body: "keep me" });
    assert.equal((await post("/v1/files/move", { from: "moved/chapter.tex", to: "occupied.tex" })).status, 409);
    assert.equal(await (await fetch(`${base}/v1/files?path=occupied.tex`)).text(), "keep me");
    assert.equal((await post("/v1/files/move", { from: "moved", to: "moved/child" })).status, 400);
    const removed = await fetch(`${base}/v1/files?path=moved`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const id = (await removed.json()).deleted.trashId;
    assert.equal((await fetch(`${base}/v1/files?path=moved/chapter.tex`)).status, 404);
    const trash = await (await fetch(`${base}/v1/trash`)).json();
    assert.ok(trash.items.some(item => item.id === id));
    assert.equal((await post("/v1/trash/restore", { id })).status, 200);
    assert.equal(await (await fetch(`${base}/v1/files?path=moved/chapter.tex`)).text(), "live original");
    assert.ok((await (await fetch(`${base}/v1/project`)).json()).project.folders.includes("moved/empty"));
    assert.equal((await post("/v1/trash/restore", { id })).status, 404);
    assert.equal((await fetch(`${base}/v1/files?path=main.tex`, { method: "DELETE" })).status, 409);
  });
});

test("replace previews span files and stale hashes reject the entire batch", async () => {
  await withServer(async ({ base }) => {
    const post = (endpoint, body) => fetch(base + endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    for (const path of ["one.tex", "two.tex"]) await fetch(`${base}/v1/files?path=${path}`, { method: "PUT", body: "needle\nneedle" });
    const preview = await post("/v1/search/replace/preview", { query: "needle", replacement: "\\section{新😀}" });
    assert.equal(preview.status, 200);
    const plan = await preview.json();
    assert.equal(plan.count, 4);
    assert.equal(plan.files.length, 2);
    await fetch(`${base}/v1/files?path=two.tex`, { method: "PUT", body: "human edit" });
    const stale = await post("/v1/search/replace", { files: plan.files });
    assert.equal(stale.status, 409);
    assert.equal(await (await fetch(`${base}/v1/files?path=one.tex`)).text(), "needle\nneedle");
    const fresh = await (await post("/v1/search/replace/preview", { query: "needle", replacement: "replacement", path: "one.tex" })).json();
    assert.equal((await post("/v1/search/replace", fresh)).status, 200);
    assert.equal(await (await fetch(`${base}/v1/files?path=one.tex`)).text(), "replacement\nreplacement");
    assert.equal(await (await fetch(`${base}/v1/files?path=two.tex`)).text(), "human edit");
  });
});

test("Agent conflict diagnostics return the latest source and diff without writing", async () => {
  await withServer(async ({ base }) => {
    const before = await fetch(`${base}/v1/files?path=main.tex`);
    const hash = before.headers.get("x-content-sha256")!;
    await fetch(`${base}/v1/files?path=main.tex`, { method: "PUT", body: "human content" });
    const headers = { "X-Base-SHA256": hash, "Content-Type": "text/plain" };
    const rejected = await fetch(`${base}/v1/files/edit?path=main.tex`, { method: "POST", headers, body: "Agent proposal" });
    assert.equal(rejected.status, 409);
    const details = (await rejected.json()).error.details;
    assert.match(details.conflictUrl, /edit\/conflict/);
    const diagnostic = await fetch(base + details.conflictUrl, { method: "POST", headers, body: "Agent proposal" });
    assert.equal(diagnostic.status, 200);
    const conflict = await diagnostic.json();
    assert.equal(conflict.currentSource, "human content");
    assert.equal(conflict.currentSha256, sha256("human content"));
    assert.match(conflict.diff, /-human content/);
    assert.match(conflict.diff, /\+Agent proposal/);
    assert.equal(await (await fetch(`${base}/v1/files?path=main.tex`)).text(), "human content");
  });
});

test("full-file edit computes Yjs changes atomically and rejects live stale hashes", async () => {
  await withServer(async ({ base, ws, projectDir, collaboration }) => {
    const room = Buffer.from("main.tex").toString("base64url");
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`${ws}/v1/collab`, room, doc, { WebSocketPolyfill: WebSocket as any });
    try {
      await waitFor(() => provider.synced);
      const downloaded = await fetch(`${base}/v1/files?path=main.tex`);
      const original = await downloaded.text();
      const hash = downloaded.headers.get("x-content-sha256")!;
      const updated = "\\section{Unicode 😀}\n" + original.replace("shared live", 'shared "direct"') + "\n\\newcommand{\\test}{Backslashes}\n";
      let transactions = 0;
      const shared = collaboration.load("main.tex");
      shared.doc.on("update", () => transactions++);
      const upload = (source, revision, query = "") => fetch(`${base}/v1/files/edit?path=main.tex${query}`, {
        method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8", ...(revision === undefined ? {} : { "X-Base-SHA256": revision }) }, body: source,
      });
      const edited = await upload(updated, hash);
      assert.equal(edited.status, 200, await edited.clone().text());
      const result = await edited.json();
      assert.equal(result.file.sha256, sha256(updated));
      assert.equal(result.edit.mode, "direct");
      assert.ok(result.edit.changeCount >= 2);
      assert.equal(transactions, 1);
      await waitFor(() => doc.getText("content").toString() === updated);
      assert.equal(await readFile(path.join(projectDir, "main.tex"), "utf8"), updated);
      const noop = await upload(updated, result.file.sha256);
      assert.equal(noop.status, 200);
      assert.equal((await noop.json()).edit.changeCount, 0);
      assert.equal(transactions, 1);
      const stale = await upload("overwrite", hash);
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).error.details.currentSha256, sha256(updated));
      const missing = await upload("overwrite", undefined);
      assert.equal(missing.status, 400);
      const invalid = await upload(Buffer.from([0xff]), result.file.sha256);
      assert.equal(invalid.status, 400);
      assert.equal(shared.doc.getText("content").toString(), updated);
      assert.equal(transactions, 1);

      // The in-memory Yjs version differs from disk before its persistence timer.
      shared.doc.getText("content").insert(0, "human edit\n");
      const live = shared.doc.getText("content").toString();
      const liveStale = await upload("overwrite", sha256(updated));
      assert.equal(liveStale.status, 409);
      assert.equal(shared.doc.getText("content").toString(), live);
      const fresh = await upload(live.replace("Backslashes", "Suggested"), sha256(live), "&mode=suggesting&agentId=ag_upload&agentName=Writer");
      assert.equal(fresh.status, 200, await fresh.clone().text());
      const suggesting = await fresh.json();
      assert.equal(suggesting.edit.mode, "suggesting");
      assert.ok(suggesting.edit.suggestionIds.length);
      assert.ok(parseReviews(shared.doc.getText("content").toString()).some(review => review.author.includes("Writer")));
    } finally { provider.destroy(); doc.destroy(); }
  });
});

test("two full-file uploads with the same base cannot overwrite each other", async () => {
  await withServer(async ({ base }) => {
    const downloaded = await fetch(`${base}/v1/files?path=main.tex`);
    const hash = downloaded.headers.get("x-content-sha256")!;
    const original = await downloaded.text();
    const versions = [original + "\nAgent one", original + "\nAgent two"];
    const responses = await Promise.all(versions.map(body => fetch(`${base}/v1/files/edit?path=main.tex`, {
      method: "POST", headers: { "X-Base-SHA256": hash, "Content-Type": "text/plain" }, body,
    })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const current = await (await fetch(`${base}/v1/files?path=main.tex`)).text();
    assert.equal(current, versions[responses.findIndex(response => response.status === 200)]);
  });
});

test("patch API applies one checked Yjs transaction and rejects stale edits", async () => {
  await withServer(async ({ base, ws, projectDir, collaboration }) => {
    const room = Buffer.from("main.tex").toString("base64url");
    const firstDoc = new Y.Doc();
    const secondDoc = new Y.Doc();
    const first = new WebsocketProvider(`${ws}/v1/collab`, room, firstDoc, { WebSocketPolyfill: WebSocket as any });
    const second = new WebsocketProvider(`${ws}/v1/collab`, room, secondDoc, { WebSocketPolyfill: WebSocket as any });
    await waitFor(() => first.synced && second.synced);

    const beforeResponse = await fetch(`${base}/v1/files?path=main.tex`);
    const before = await beforeResponse.text();
    const revision = beforeResponse.headers.get("x-content-sha256");
    assert.equal(revision, sha256(before));
    const from = before.indexOf("shared live");
    const patch = await fetch(`${base}/v1/files/patch?path=main.tex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseSha256: revision,
        agent: { id: "ag_test123", name: "Test Writer" },
        changes: [{ from, to: from + "shared live".length, insert: "edited together" }],
      }),
    });
    assert.equal(patch.status, 200);
    const result = await patch.json();
    assert.equal(result.file.sha256, patch.headers.get("x-content-sha256"));
    assert.equal(result.patch.mode, "suggesting");
    assert.equal(result.patch.suggestionIds.length, 1);
    await waitFor(() => parseReviews(firstDoc.getText("content").toString()).length === 2);
    await waitFor(() => parseReviews(secondDoc.getText("content").toString()).length === 2);
    const reviews = parseReviews(firstDoc.getText("content").toString());
    assert.deepEqual(reviews.map(item => [item.kind, item.id, item.author, item.body]), [
      ["deletion", result.patch.suggestionIds[0], "Agent: Test Writer [ag_test123]", "shared live"],
      ["addition", result.patch.suggestionIds[0], "Agent: Test Writer [ag_test123]", "edited together"],
    ]);

    const stale = await fetch(`${base}/v1/files/patch?path=main.tex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseSha256: revision, changes: [{ from: 0, to: 0, insert: "stale" }] }),
    });
    assert.equal(stale.status, 409);
    const staleError = await stale.json();
    assert.equal(staleError.error.code, "stale_file");
    assert.deepEqual(staleError.error.details, {
      path: "main.tex",
      expectedSha256: revision,
      currentSha256: patch.headers.get("x-content-sha256"),
    });
    collaboration.flush();
    const persisted = await readFile(path.join(projectDir, "main.tex"), "utf8");
    assert.match(persisted, /edited together/);
    assert.match(persisted, /Agent: Test Writer \[ag_test123\]/);
    assert.doesNotMatch(persisted, /^stale/);
    first.destroy();
    second.destroy();
    firstDoc.destroy();
    secondDoc.destroy();
  });
});

test("patch API validates all ranges before changing a file", async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/v1/files?path=unicode.tex`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "A😀B",
    });
    const current = await fetch(`${base}/v1/files?path=unicode.tex`);
    const revision = current.headers.get("x-content-sha256");
    assert.equal(await current.text(), "A😀B");

    const splitUnicode = await fetch(`${base}/v1/files/patch?path=unicode.tex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseSha256: revision, changes: [{ from: 2, to: 2, insert: "x" }] }),
    });
    assert.equal(splitUnicode.status, 400);
    assert.equal((await splitUnicode.json()).error.code, "invalid_change");

    const overlap = await fetch(`${base}/v1/files/patch?path=unicode.tex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseSha256: revision,
        changes: [
          { from: 0, to: 3, insert: "x" },
          { from: 1, to: 4, insert: "y" },
        ],
      }),
    });
    assert.equal(overlap.status, 400);
    assert.equal((await overlap.json()).error.code, "overlapping_changes");
    assert.equal(await (await fetch(`${base}/v1/files?path=unicode.tex`)).text(), "A😀B");

    const missingAgent = await fetch(`${base}/v1/files/patch?path=unicode.tex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseSha256: revision, changes: [{ from: 3, to: 4, insert: "C" }] }),
    });
    assert.equal(missingAgent.status, 400);
    assert.equal((await missingAgent.json()).error.code, "invalid_agent");

    const direct = await fetch(`${base}/v1/files/patch?path=unicode.tex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseSha256: revision,
        mode: "direct",
        changes: [{ from: 3, to: 4, insert: "C" }],
      }),
    });
    assert.equal(direct.status, 200);
    assert.equal((await direct.json()).patch.mode, "direct");
    assert.equal(await (await fetch(`${base}/v1/files?path=unicode.tex`)).text(), "A😀C");
  });
});

test("JSON parse failures use a stable structured error", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/v1/files/patch?path=main.tex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    assert.equal(response.status, 400);
    assert.deepEqual((await response.json()).error, {
      code: "invalid_json",
      message: "request body must contain valid JSON",
    });
  });
});

test("two Yjs clients collaborate and persist plain LaTeX plus a SQLite snapshot", async () => {
  await withServer(async ({ ws, stateDir, projectDir, collaboration, database: stateDatabase }) => {
    const room = Buffer.from("main.tex").toString("base64url");
    const firstDoc = new Y.Doc();
    const secondDoc = new Y.Doc();
    const first = new WebsocketProvider(`${ws}/v1/collab`, room, firstDoc, { WebSocketPolyfill: WebSocket as any });
    const second = new WebsocketProvider(`${ws}/v1/collab`, room, secondDoc, { WebSocketPolyfill: WebSocket as any });
    await waitFor(() => first.synced && second.synced);
    firstDoc.getText("content").insert(firstDoc.getText("content").length, "\n% collaborative edit\n");
    await waitFor(() => secondDoc.getText("content").toString().endsWith("% collaborative edit\n"));
    collaboration.flush();
    assert.match(await readFile(path.join(projectDir, "main.tex"), "utf8"), /% collaborative edit\n$/);
    const projectId = stateDatabase.listProjects()[0].id;
    const database = new DatabaseSync(path.join(stateDir, "state.sqlite"), { readOnly: true });
    const snapshot = database.prepare("SELECT length(snapshot) AS bytes FROM yjs_snapshots WHERE project_id = ? AND relative_path = ?").get(projectId, "main.tex") as any;
    assert.ok(snapshot.bytes > 0);
    database.close();
    first.destroy();
    second.destroy();
    firstDoc.destroy();
    secondDoc.destroy();
  });
});
