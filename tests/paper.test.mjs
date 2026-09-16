import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import { createPaperServer, safeRelativePath } from "../server.mjs";
import { parseReviews, stripReviewStorage } from "../src/review.js";

const execFileAsync = promisify(execFile);

async function testGit(cwd, args) {
  const { stdout } = await execFileAsync("git", [
    "-c", "user.name=Test User",
    "-c", "user.email=test@example.com",
    ...args,
  ], { cwd });
  return stdout.trim();
}

async function createIncomingBranch(projectDir, branch, mutate) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-git-worktree-"));
  try {
    await testGit(projectDir, ["worktree", "add", "-b", branch, temporary, "main"]);
    await mutate(temporary);
    await testGit(temporary, ["add", "-A"]);
    await testGit(temporary, ["commit", "-m", `${branch} changes`]);
  } finally {
    await testGit(projectDir, ["worktree", "remove", "--force", temporary]).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}

async function withServer(run, options = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-test-"));
  const paper = await createPaperServer({ stateDir, authDisabled: true, ...options });
  await new Promise((resolve, reject) => {
    paper.server.once("error", reject);
    paper.server.listen(0, "127.0.0.1", resolve);
  });
  const address = paper.server.address();
  try {
    await run({ ...paper, base: `http://127.0.0.1:${address.port}`, ws: `ws://127.0.0.1:${address.port}` });
  } finally {
    paper.shutdown();
    paper.sockets.close();
    await new Promise(resolve => paper.server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}

function waitFor(testValue, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (testValue()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error("condition timed out"));
      }
    }, 20);
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("path validation contains project access", () => {
  assert.equal(safeRelativePath("chapters/intro.tex"), "chapters/intro.tex");
  assert.throws(() => safeRelativePath("../../etc/passwd"), /inside the project/);
  assert.throws(() => safeRelativePath("/etc/passwd"), /inside the project/);
});

test("review storage parses without leaking into visible source", () => {
  const source = "A \\cmtbg{c1}{Ada}claim\\cmted{Needs evidence}; "
    + "\\revbg{r0}{Mo}modern wording\\reved{old wording}; "
    + "\\delbg{r1}{Lin}unclear text\\deled"
    + "\\addbg{r1}{Lin}clear text\\added.";
  const reviews = parseReviews(source);
  assert.deepEqual(reviews.map(item => [item.kind, item.id, item.author, item.body, item.note]), [
    ["comment", "c1", "Ada", "claim", "Needs evidence"],
    ["revision", "r0", "Mo", "modern wording", "old wording"],
    ["deletion", "r1", "Lin", "unclear text", ""],
    ["addition", "r1", "Lin", "clear text", ""],
  ]);
  assert.equal(stripReviewStorage(source), "A claim; modern wording; clear text.");
});

test("compile projection removes storage macros beside ordinary letters", () => {
  const source = "before \\delbg{r1}{Lin}bad\\deledafter "
    + "\\addbg{r1}{Lin}good\\addedtext";
  const clean = stripReviewStorage(source);
  assert.equal(clean, "before after goodtext");
  assert.doesNotMatch(clean, /\\(?:cmtbg|cmted|revbg|reved|addbg|added|delbg|deled)\\b/);
});

test("root negotiates Agent and human representations", async () => {
  await withServer(async ({ base }) => {
    const root = await fetch(`${base}/`);
    assert.match(root.headers.get("content-type"), /^text\/markdown/);
    assert.match(await root.text(), /^# LaTeX Coder/);

    const human = await fetch(`${base}/`, { headers: { Accept: "text/html" } });
    assert.match(human.headers.get("content-type"), /^text\/html/);
    assert.match(human.headers.get("vary"), /Accept/);
    assert.match(human.headers.get("vary"), /User-Agent/);
    assert.match(human.headers.get("content-security-policy"), /object-src 'none'/);
    assert.match(await human.text(), /<title>LaTeX Coder<\/title>/);

    const browser = await fetch(`${base}/`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" } });
    assert.match(browser.headers.get("content-type"), /^text\/html/);
    const sharedProject = await fetch(`${base}/projects/paper`);
    assert.match(sharedProject.headers.get("content-type"), /^text\/html/);
    assert.match(await sharedProject.text(), /id="editor-page"/);
    const agentOverride = await fetch(`${base}/`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/markdown" },
    });
    assert.match(agentOverride.headers.get("content-type"), /^text\/markdown/);
    const removedHumanPrefix = await fetch(`${base}/_human/`);
    assert.equal(removedHumanPrefix.status, 404);

    const asset = await fetch(`${base}/app.js`);
    assert.match(asset.headers.get("content-type"), /javascript/);
    await asset.arrayBuffer();

    const project = await fetch(`${base}/v1/project`);
    assert.match(project.headers.get("content-type"), /^application\/json/);
    assert.equal((await project.json()).project.main, "main.tex");

    const missing = await fetch(`${base}/does-not-exist`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "route_not_found");
  });
});

test("projects isolate files and support lifecycle operations", async () => {
  await withServer(async ({ base, projectsDir }) => {
    const initial = await (await fetch(`${base}/v1/projects`)).json();
    assert.equal(initial.projects.length, 1);
    const originalId = initial.projects[0].id;
    assert.equal(await testGit(path.join(projectsDir, originalId, "project"), ["branch", "--show-current"]), "main");

    const createdResponse = await fetch(`${base}/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Paper" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).project;
    assert.equal(created.id, "second-paper");

    const write = await fetch(`${base}/v1/files?project=${created.id}&path=notes.tex`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "Only in project two.\n",
    });
    assert.equal(write.status, 201);
    assert.equal(await readFile(path.join(projectsDir, created.id, "project", "notes.tex"), "utf8"), "Only in project two.\n");
    assert.equal((await fetch(`${base}/v1/files?project=${originalId}&path=notes.tex`)).status, 404);

    const renamed = await fetch(`${base}/v1/projects/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Revised Paper" }),
    });
    assert.equal((await renamed.json()).project.name, "Revised Paper");

    const deleted = await fetch(`${base}/v1/projects/${created.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    const remaining = await (await fetch(`${base}/v1/projects`)).json();
    assert.deepEqual(remaining.projects.map(project => project.id), [originalId]);
  });
});

test("invite-only users and project capability sessions enforce access boundaries", async () => {
  const adminPassword = "correct horse battery staple";
  await withServer(async ({ base, stateDir }) => {
    assert.equal((await fetch(`${base}/v1/projects`)).status, 401);
    const badLogin = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong password" }),
    });
    assert.equal(badLogin.status, 401);

    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: adminPassword }),
    });
    assert.equal(login.status, 200);
    const adminCookie = login.headers.get("set-cookie").split(";", 1)[0];
    assert.equal((await login.json()).user.username, "admin");

    const listed = await fetch(`${base}/v1/projects`, { headers: { Cookie: adminCookie } });
    assert.equal(listed.status, 200);
    const initialProject = (await listed.json()).defaultProjectId;
    assert.equal((await fetch(`${base}/v1/invitations`, { method: "POST" })).status, 401);
    const invitationResponse = await fetch(`${base}/v1/invitations`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    assert.equal(invitationResponse.status, 201);
    const invitation = (await invitationResponse.json()).invitation;
    assert.match(invitation.path, /^\/register\/[A-Za-z0-9_-]+$/);

    const registration = await fetch(`${base}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invitation.token, username: "member.one", password: "another secure password" }),
    });
    assert.equal(registration.status, 201);
    const memberCookie = registration.headers.get("set-cookie").split(";", 1)[0];
    const reused = await fetch(`${base}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invitation.token, username: "member.two", password: "another secure password" }),
    });
    assert.equal(reused.status, 404);

    const memberProjectsBeforeCreate = await fetch(`${base}/v1/projects`, { headers: { Cookie: memberCookie } });
    assert.deepEqual((await memberProjectsBeforeCreate.json()).projects, []);
    assert.equal((await fetch(`${base}/v1/project?project=${initialProject}`, { headers: { Cookie: memberCookie } })).status, 401);

    const createdResponse = await fetch(`${base}/v1/projects`, {
      method: "POST",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Shared Capability" }),
    });
    assert.equal(createdResponse.status, 201);
    const project = (await createdResponse.json()).project;
    const adminProjectsAfterCreate = await fetch(`${base}/v1/projects`, { headers: { Cookie: adminCookie } });
    assert.deepEqual((await adminProjectsAfterCreate.json()).projects.map(item => item.id), [initialProject]);
    const memberProjectsAfterCreate = await fetch(`${base}/v1/projects`, { headers: { Cookie: memberCookie } });
    assert.deepEqual((await memberProjectsAfterCreate.json()).projects.map(item => item.id), [project.id]);
    assert.equal((await fetch(`${base}/v1/project?project=${project.id}`)).status, 401);
    assert.equal((await fetch(`${base}/v1/project?project=${project.id}`, { headers: { Cookie: adminCookie } })).status, 401);
    assert.equal((await fetch(`${base}/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Stolen project" }),
    })).status, 403);
    assert.equal((await fetch(`${base}/v1/projects/${project.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    })).status, 403);

    const shareResponse = await fetch(`${base}/v1/project/share?project=${project.id}`, { headers: { Cookie: memberCookie } });
    assert.equal(shareResponse.status, 200);
    const share = (await shareResponse.json()).share;
    const exchange = await fetch(`${base}${share.path}`, { redirect: "manual" });
    assert.equal(exchange.status, 303);
    assert.equal(exchange.headers.get("location"), `/projects/${project.id}`);
    const projectCookie = exchange.headers.get("set-cookie").split(";", 1)[0];
    assert.equal((await fetch(`${base}/v1/project?project=${project.id}`, { headers: { Cookie: projectCookie } })).status, 200);
    assert.equal((await fetch(`${base}/v1/projects`, { headers: { Cookie: projectCookie } })).status, 401);
    const signedCollaboratorCookies = `${adminCookie}; ${projectCookie}`;
    const signedCollaboratorProject = await fetch(`${base}/v1/project?project=${project.id}`, {
      headers: { Cookie: signedCollaboratorCookies },
    });
    assert.equal(signedCollaboratorProject.status, 200);
    assert.equal((await signedCollaboratorProject.json()).project.permissions.manage, false);
    assert.equal((await fetch(`${base}/v1/project/share?project=${project.id}`, {
      headers: { Cookie: signedCollaboratorCookies },
    })).status, 403);

    const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-private-clone-"));
    try {
      assert.notEqual((await fetch(`${base}/git/${project.id}/info/refs?service=git-upload-pack`)).status, 200);
      await execFileAsync("git", ["clone", `${base}${share.clonePath}`, temporary]);
      assert.equal(await testGit(temporary, ["branch", "--show-current"]), "main");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }

    const storedAuth = await readFile(path.join(stateDir, "auth.json"), "utf8");
    assert.doesNotMatch(storedAuth, new RegExp(adminPassword));
    assert.doesNotMatch(storedAuth, /another secure password/);
    assert.match(storedAuth, /"hash"/);
    const storedProject = JSON.parse(await readFile(path.join(stateDir, "projects", project.id, "project.json"), "utf8"));
    assert.equal(storedProject.ownerUsername, "member.one");
    assert.ok(initialProject);
  }, { authDisabled: false, adminPassword });
});

test("project ZIP includes live files and Git HTTP serves cloneable history", async () => {
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
      const clone = path.join(temporary, "clone");
      await execFileAsync("git", ["clone", `${base}/git/${projectId}`, clone]);
      assert.equal(await readFile(path.join(clone, "notes.tex"), "utf8"), "included before commit\n");
      assert.equal(await testGit(clone, ["branch", "--show-current"]), "main");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
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
    const provider = new WebsocketProvider(`${ws}/v1/collab`, Buffer.from("main.tex").toString("base64url"), doc, { WebSocketPolyfill: WebSocket });
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

test("legacy single-project state migrates without changing source files", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-migrate-"));
  const legacyProject = path.join(stateDir, "project");
  await mkdir(legacyProject, { recursive: true });
  await writeFile(path.join(legacyProject, "main.tex"), "legacy source\n", "utf8");
  const paper = await createPaperServer({ stateDir, authDisabled: true });
  try {
    assert.equal(await readFile(path.join(stateDir, "projects", "paper", "project", "main.tex"), "utf8"), "legacy source\n");
    assert.equal(paper.projectDir, path.join(stateDir, "projects", "paper", "project"));
  } finally {
    paper.shutdown();
    paper.sockets.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

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

test("patch API applies one checked Yjs transaction and rejects stale edits", async () => {
  await withServer(async ({ base, ws, projectDir, collaboration }) => {
    const room = Buffer.from("main.tex").toString("base64url");
    const firstDoc = new Y.Doc();
    const secondDoc = new Y.Doc();
    const first = new WebsocketProvider(`${ws}/v1/collab`, room, firstDoc, { WebSocketPolyfill: WebSocket });
    const second = new WebsocketProvider(`${ws}/v1/collab`, room, secondDoc, { WebSocketPolyfill: WebSocket });
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
    assert.equal((await stale.json()).error.code, "stale_file");
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

test("two Yjs clients collaborate and persist plain LaTeX", async () => {
  await withServer(async ({ ws, projectDir, collaboration }) => {
    const room = Buffer.from("main.tex").toString("base64url");
    const firstDoc = new Y.Doc();
    const secondDoc = new Y.Doc();
    const first = new WebsocketProvider(`${ws}/v1/collab`, room, firstDoc, { WebSocketPolyfill: WebSocket });
    const second = new WebsocketProvider(`${ws}/v1/collab`, room, secondDoc, { WebSocketPolyfill: WebSocket });
    await waitFor(() => first.synced && second.synced);
    firstDoc.getText("content").insert(firstDoc.getText("content").length, "\n% collaborative edit\n");
    await waitFor(() => secondDoc.getText("content").toString().endsWith("% collaborative edit\n"));
    collaboration.flush();
    assert.match(await readFile(path.join(projectDir, "main.tex"), "utf8"), /% collaborative edit\n$/);
    first.destroy();
    second.destroy();
    firstDoc.destroy();
    secondDoc.destroy();
  });
});
