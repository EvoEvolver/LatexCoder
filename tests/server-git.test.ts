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

test("project ZIP includes live files and a personal Git remote supports clone and push", async () => {
  await withServer(async ({ base }) => {
    const projects = await (await fetch(`${base}/v1/projects`)).json();
    const projectId = projects.defaultProjectId;
    await fetch(`${base}/v1/files?project=${projectId}&path=notes.tex`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "included before commit\n",
    });

    const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-export-test-"));
    try {
      const archiveResponse = await fetch(`${base}/v1/project/archive?project=${projectId}`);
      assert.equal(archiveResponse.status, 200);
      assert.match(archiveResponse.headers.get("content-disposition"), new RegExp(`${projectId}\\.zip`));
      const archive = path.join(temporary, "project.zip");
      await writeFile(archive, Buffer.from(await archiveResponse.arrayBuffer()));
      const { stdout: archivedNotes } = await execFileAsync("unzip", ["-p", archive, `${projectId}/notes.tex`]);
      assert.equal(archivedNotes, "included before commit\n");

      await fetch(`${base}/v1/git/commit?project=${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Include notes" }),
      });
      const shareResponse = await fetch(`${base}/v1/project/share?project=${projectId}`, { method: "POST" });
      assert.equal(shareResponse.status, 200);
      const share = (await shareResponse.json()).share;
      const clone = path.join(temporary, "clone");
      await execFileAsync("git", ["clone", `${base}${share.clonePath}`, clone]);
      assert.equal(await readFile(path.join(clone, "notes.tex"), "utf8"), "included before commit\n");
      assert.equal(await testGit(clone, ["branch", "--show-current"]), "main");
      await fetch(`${base}/v1/files?project=${projectId}&path=live.tex`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "uncommitted live collaboration\n",
      });
      await writeFile(path.join(clone, "pushed.tex"), "arrived through git push\n", "utf8");
      await testGit(clone, ["add", "pushed.tex"]);
      await testGit(clone, ["commit", "-m", "Push into collaboration"]);
      await testGit(clone, ["push", "origin", "main"]);
      assert.equal(
        await (await fetch(`${base}/v1/files?project=${projectId}&path=pushed.tex`)).text(),
        "arrived through git push\n",
      );
      assert.equal(
        await (await fetch(`${base}/v1/files?project=${projectId}&path=live.tex`)).text(),
        "uncommitted live collaboration\n",
      );
      const gitState = await (await fetch(`${base}/v1/git?project=${projectId}`)).json();
      assert.equal(gitState.git.branch, "main");
      assert.equal(gitState.git.dirty, false);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

test("automatic Git checkpoints capture live Yjs edits without closing collaboration", async () => {
  await withServer(async ({ base, ws, projectDir, collaboration }) => {
    const socket = new WebSocket(`${ws}/v1/collab/${collaboration.roomNameForPath("main.tex")}`);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    let disconnected = false;
    socket.on("close", () => { disconnected = true; });
    try {
      const before = await testGit(projectDir, ["rev-parse", "HEAD"]);
      const shared = collaboration.load("main.tex");
      shared.doc.getText("content").insert(0, "% automatic live checkpoint\n");
      const deadline = Date.now() + 5_000;
      while (await testGit(projectDir, ["rev-parse", "HEAD"]) === before) {
        assert.ok(Date.now() < deadline, "automatic checkpoint did not run");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.match(await testGit(projectDir, ["show", "HEAD:main.tex"]), /automatic live checkpoint/);
      assert.equal(disconnected, false);
      assert.equal(socket.readyState, WebSocket.OPEN);
      const head = await testGit(projectDir, ["rev-parse", "HEAD"]);
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(await testGit(projectDir, ["rev-parse", "HEAD"]), head);
      const write = await fetch(`${base}/v1/files?path=automatic.tex`, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "automatic file creation\n" });
      assert.equal(write.status, 201);
      const fileDeadline = Date.now() + 5_000;
      while (await testGit(projectDir, ["rev-parse", "HEAD"]) === head) {
        assert.ok(Date.now() < fileDeadline);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.match(await testGit(projectDir, ["show", "HEAD:automatic.tex"]), /automatic file creation/);
    } finally { socket.terminate(); }
  }, { gitCheckpointIdleMs: 100, gitCheckpointMaxWaitMs: 500 });
});

test("collaborative blame follows Yjs text, checkpoints, and file moves", async () => {
  await withServer(async ({ base, ws }) => {
    const doc = new Y.Doc();
    const room = Buffer.from("main.tex").toString("base64url");
    const provider = new WebsocketProvider(`${ws}/v1/collab`, room, doc, {
      WebSocketPolyfill: WebSocket as any,
      params: { authorId: "alice", authorName: "Alice" },
    });
    try {
      await waitFor(() => provider.synced);
      doc.getText("content").insert(0, "% attributed edit\n");
      let blame: any;
      const deadline = Date.now() + 3_000;
      do {
        blame = await (await fetch(`${base}/v1/blame?path=main.tex`)).json();
        if (blame.runs.some(run => run.authorId === "alice" && run.commit === null)) break;
        assert.ok(Date.now() < deadline, "blame attribution did not arrive");
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (true);
      const alice = blame.runs.find(run => run.authorId === "alice");
      assert.equal(alice.from, 0);
      assert.equal(alice.to, "% attributed edit\n".length);

      const checkpoint = await fetch(`${base}/v1/git/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Attribute Alice's edit" }),
      });
      assert.equal(checkpoint.status, 200);
      const commit = (await checkpoint.json()).git.commit;
      blame = await (await fetch(`${base}/v1/blame?path=main.tex`)).json();
      assert.equal(blame.runs.find(run => run.authorId === "alice").commit, commit);

      const moved = await fetch(`${base}/v1/files/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "main.tex", to: "paper.tex" }),
      });
      assert.equal(moved.status, 200, await moved.clone().text());
      blame = await (await fetch(`${base}/v1/blame?path=paper.tex`)).json();
      assert.equal(blame.runs.find(run => run.authorId === "alice").commit, commit);
    } finally {
      provider.destroy();
      doc.destroy();
    }
  }, { gitCheckpointIdleMs: 3_600_000, gitCheckpointMaxWaitMs: 3_600_000 });
});

test("Git clone, fetch, and pull checkpoint current content without a browser commit", async () => {
  await withServer(async ({ base, projectDir, collaboration }) => {
    const { project } = await (await fetch(`${base}/v1/project`)).json();
    const { share } = await (await fetch(`${base}/v1/project/share?project=${project.id}`, { method: "POST" })).json();
    const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-auto-clone-"));
    const clone = path.join(temporary, "clone");
    try {
      const text = collaboration.load("main.tex").doc.getText("content");
      text.insert(0, "% latest before clone\n");
      await execFileAsync("git", ["clone", `${base}${share.clonePath}`, clone]);
      assert.match(await readFile(path.join(clone, "main.tex"), "utf8"), /latest before clone/);
      text.insert(0, "% latest before fetch\n");
      await testGit(clone, ["fetch", "origin"]);
      assert.match(await testGit(clone, ["show", "origin/main:main.tex"]), /latest before fetch/);

      await writeFile(path.join(clone, "agent.tex"), "committed by agent\n", "utf8");
      await testGit(clone, ["add", "agent.tex"]);
      await testGit(clone, ["commit", "-m", "Agent work before pull"]);
      text.insert(0, "% latest before pull\n");
      await testGit(clone, ["pull", "--no-rebase", "origin", "main"]);
      assert.match(await readFile(path.join(clone, "main.tex"), "utf8"), /latest before pull/);
      assert.equal(await readFile(path.join(clone, "agent.tex"), "utf8"), "committed by agent\n");
      assert.equal((await testGit(clone, ["rev-list", "--parents", "-1", "HEAD"])).split(" ").length, 3);

      const head = await testGit(projectDir, ["rev-parse", "HEAD"]);
      await testGit(clone, ["fetch", "origin"]);
      assert.equal(await testGit(projectDir, ["rev-parse", "HEAD"]), head);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});

test("Git pull without project changes does not create an empty checkpoint", async () => {
  await withServer(async ({ base, projectDir }) => {
    const { project } = await (await fetch(`${base}/v1/project`)).json();
    const { share } = await (await fetch(`${base}/v1/project/share?project=${project.id}`, { method: "POST" })).json();
    assert.equal((await fetch(`${base}/v1/files?path=chapters/notes.tex`, {
      method: "PUT", headers: { "Content-Type": "text/plain" }, body: "nested source\n",
    })).status, 201);
    assert.equal((await fetch(`${base}/v1/git/commit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Nested source" }),
    })).status, 200);

    const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-no-empty-pull-"));
    const clone = path.join(temporary, "clone");
    try {
      await execFileAsync("git", ["clone", `${base}${share.clonePath}`, clone]);
      await testGit(projectDir, ["commit", "--allow-empty", "-m", "External metadata-free commit"]);
      const expectedHead = await testGit(projectDir, ["rev-parse", "HEAD"]);
      const expectedCount = await testGit(projectDir, ["rev-list", "--count", "HEAD"]);

      await testGit(clone, ["pull", "--ff-only", "origin", "main"]);
      assert.equal(await testGit(projectDir, ["rev-parse", "HEAD"]), expectedHead);
      assert.equal(await testGit(projectDir, ["rev-list", "--count", "HEAD"]), expectedCount);

      await testGit(clone, ["pull", "--ff-only", "origin", "main"]);
      assert.equal(await testGit(projectDir, ["rev-parse", "HEAD"]), expectedHead);
      assert.equal(await testGit(projectDir, ["rev-list", "--count", "HEAD"]), expectedCount);

      await testGit(projectDir, ["rm", "chapters/notes.tex"]);
      await testGit(projectDir, ["commit", "-m", "External directory removal"]);
      const removalHead = await testGit(projectDir, ["rev-parse", "HEAD"]);
      const removalCount = await testGit(projectDir, ["rev-list", "--count", "HEAD"]);
      await testGit(clone, ["pull", "--ff-only", "origin", "main"]);
      assert.equal(await testGit(projectDir, ["rev-parse", "HEAD"]), removalHead);
      assert.equal(await testGit(projectDir, ["rev-list", "--count", "HEAD"]), removalCount);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});

test("Git checkpoints and fast-forward sync keep collaboration on main", async () => {
  await withServer(async ({ base, projectDir }) => {
    await fetch(`${base}/v1/files?path=notes.tex`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "local checkpoint\n",
    });
    const committed = await fetch(`${base}/v1/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Add notes" }),
    });
    assert.equal(committed.status, 200);
    assert.equal(await testGit(projectDir, ["status", "--short"]), "");
    assert.equal(await testGit(projectDir, ["log", "-1", "--format=%s"]), "Add notes");

    await createIncomingBranch(projectDir, "incoming", async worktree => {
      await writeFile(path.join(worktree, "remote.tex"), "incoming file\n", "utf8");
    });
    const synced = await fetch(`${base}/v1/git/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "incoming" }),
    });
    assert.equal(synced.status, 200);
    assert.equal((await synced.json()).git.status, "fast_forward");
    assert.equal(await testGit(projectDir, ["branch", "--show-current"]), "main");
    assert.equal(await (await fetch(`${base}/v1/files?path=remote.tex`)).text(), "incoming file\n");
    assert.equal(await testGit(projectDir, ["status", "--short"]), "");
  });
});

test("Git sync creates a clean merge without checking Yjs off main", async () => {
  await withServer(async ({ base, projectDir, ws }) => {
    await createIncomingBranch(projectDir, "incoming-clean", async worktree => {
      await writeFile(path.join(worktree, "incoming.tex"), "incoming side\n", "utf8");
      const source = await readFile(path.join(worktree, "main.tex"), "utf8");
      await writeFile(path.join(worktree, "main.tex"), `${source}\n% incoming update\n`, "utf8");
    });
    await fetch(`${base}/v1/files?path=local.tex`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "collaborative side\n",
    });
    await fetch(`${base}/v1/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Local side" }),
    });
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`${ws}/v1/collab`, Buffer.from("main.tex").toString("base64url"), doc, { WebSocketPolyfill: WebSocket as any });
    await waitFor(() => provider.synced);

    const response = await fetch(`${base}/v1/git/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "incoming-clean" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).git.status, "merged");
    assert.equal(await testGit(projectDir, ["branch", "--show-current"]), "main");
    assert.equal((await testGit(projectDir, ["rev-list", "--parents", "-1", "HEAD"])).split(" ").length, 3);
    assert.equal(await (await fetch(`${base}/v1/files?path=incoming.tex`)).text(), "incoming side\n");
    assert.equal(await (await fetch(`${base}/v1/files?path=local.tex`)).text(), "collaborative side\n");
    await waitFor(() => doc.getText("content").toString().endsWith("% incoming update\n"));
    assert.equal(await testGit(projectDir, ["status", "--short"]), "");
    provider.destroy();
    doc.destroy();
  });
});

test("Git conflicts quarantine incoming commits while Yjs stays on main", async () => {
  await withServer(async ({ base, projectDir }) => {
    const original = await (await fetch(`${base}/v1/files?path=main.tex`)).text();
    await createIncomingBranch(projectDir, "incoming-conflict", async worktree => {
      await writeFile(path.join(worktree, "main.tex"), original.replace("shared live", "incoming version"), "utf8");
    });

    const local = original.replace("shared live", "local collaborative version");
    await fetch(`${base}/v1/files?path=main.tex`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: local,
    });
    await fetch(`${base}/v1/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Local collaboration" }),
    });

    const sync = await fetch(`${base}/v1/git/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "incoming-conflict" }),
    });
    assert.equal(sync.status, 200);
    const result = (await sync.json()).git;
    assert.equal(result.status, "conflict");
    assert.match(result.conflict.branch, /^conflict\/\d{8}-\d{6}Z(?:-[a-f0-9]+)?$/);
    assert.equal(await testGit(projectDir, ["branch", "--show-current"]), "main");
    assert.equal(await (await fetch(`${base}/v1/files?path=main.tex`)).text(), local);
    assert.match(await testGit(projectDir, ["show", `${result.conflict.branch}:main.tex`]), /incoming version/);

    await testGit(projectDir, ["branch", "-f", result.conflict.branch, "HEAD"]);
    const changedConflict = await fetch(`${base}/v1/git/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Must not resolve a changed conflict branch" }),
    });
    assert.equal(changedConflict.status, 409);
    assert.equal((await changedConflict.json()).error.code, "git_conflict_changed");
    await testGit(projectDir, ["branch", "-f", result.conflict.branch, result.conflict.incoming]);

    const resolvedSource = local.replace("local collaborative version", "resolved version");
    await fetch(`${base}/v1/files?path=main.tex`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: resolvedSource,
    });
    const resolved = await fetch(`${base}/v1/git/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Resolve incoming changes" }),
    });
    assert.equal(resolved.status, 200);
    assert.equal((await resolved.json()).git.status, "resolved");
    assert.equal((await testGit(projectDir, ["rev-list", "--parents", "-1", "HEAD"])).split(" ").length, 3);
    assert.equal(await testGit(projectDir, ["branch", "--show-current"]), "main");
    assert.equal(await (await fetch(`${base}/v1/files?path=main.tex`)).text(), resolvedSource);
    assert.doesNotMatch(await testGit(projectDir, ["branch", "--list", "conflict/*"]), /conflict\//);
  });
});
