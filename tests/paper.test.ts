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

async function withServer(run: (context: any) => Promise<void>, options: any = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-test-"));
  const paper = await createPaperServer({ stateDir, authDisabled: true, ...options });
  await new Promise<void>((resolve, reject) => {
    paper.server.once("error", reject);
    paper.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = paper.server.address() as AddressInfo;
  try {
    await run({ ...paper, base: `http://127.0.0.1:${address.port}`, ws: `ws://127.0.0.1:${address.port}` });
  } finally {
    paper.shutdown();
    paper.sockets.close();
    await new Promise(resolve => paper.server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}

function waitFor(testValue: () => boolean, timeout = 3000) {
  return new Promise<void>((resolve, reject) => {
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

async function createFakeLatexmk(directory) {
  const executable = path.join(directory, "latexmk-fake");
  await writeFile(executable, [
    "#!/bin/sh",
    'root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'count_file="$root/count"',
    'out=""',
    'main=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    -outdir=*) out="${arg#-outdir=}" ;;',
    '    *.tex) main="$arg" ;;',
    '  esac',
    'done',
    'mkdir -p "$out"',
    'count=0',
    '[ ! -f "$count_file" ] || read count < "$count_file"',
    'count=$((count + 1))',
    'printf "%s\n" "$count" > "$count_file"',
    'base=${main##*/}',
    'base=${base%.tex}',
    '{ printf "fake-pdf-%s\n" "$count"; cat "$main"; } > "$out/$base.pdf"',
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);
  return executable;
}

async function createFakeBwrap(directory) {
  const executable = path.join(directory, "bwrap-fake");
  await writeFile(executable, [
    "#!/bin/sh",
    'root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'printf "%s\\n" "$@" > "$root/args"',
    'project=""',
    'rg=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --ro-bind)',
    '      [ "$3" != "/project" ] || project="$2"',
    '      [ "$3" != "/usr/bin/rg" ] || rg="$2"',
    '      shift 3 ;;',
    '    --setenv) shift 3 ;;',
    '    --cap-drop) shift 2 ;;',
    '    --dir|--proc|--dev|--tmpfs|--chdir) shift 2 ;;',
    '    --die-with-parent|--new-session|--unshare-all|--clearenv) shift ;;',
    '    /usr/bin/rg)',
    '      cd "$project" || exit 125',
    '      shift',
    '      exec "$rg" "$@" ;;',
    '    *) exit 126 ;;',
    '  esac',
    'done',
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);
  return executable;
}

test("path validation contains project access", () => {
  assert.equal(safeRelativePath("chapters/intro.tex"), "chapters/intro.tex");
  assert.throws(() => safeRelativePath("../../etc/passwd"), /inside the project/);
  assert.throws(() => safeRelativePath("/etc/passwd"), /inside the project/);
});

test("ZIP initializes projects and imports files without overwriting", async () => {
  await withServer(async ({ base }) => {
    const archive = zipSync({ "paper/paper.tex": strToU8("\\section{Imported}"), "paper/images/a.png": new Uint8Array([1, 2, 3]) });
    const created = await fetch(`${base}/v1/projects?name=ZIP%20paper`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: Buffer.from(archive) });
    assert.equal(created.status, 201);
    const { project } = await created.json();
    assert.equal(project.build.main, "paper.tex");
    assert.equal(await (await fetch(`${base}/v1/files?project=${project.id}&path=paper.tex`)).text(), "\\section{Imported}");
    assert.equal((await fetch(`${base}/v1/files?project=${project.id}&path=main.tex`)).status, 404);
    const upload = async files => fetch(`${base}/v1/files/import?project=${project.id}`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: Buffer.from(zipSync(files)) });
    assert.equal((await upload({ "notes.txt": strToU8("hello") })).status, 201);
    assert.equal((await upload({ "notes.txt": strToU8("overwrite"), "other.txt": strToU8("new") })).status, 409);
    assert.equal((await fetch(`${base}/v1/files?project=${project.id}&path=other.txt`)).status, 404);
    assert.equal((await upload({ "../outside.txt": strToU8("bad") })).status, 400);
    assert.equal((await upload({ ".git/config": strToU8("bad") })).status, 400);
  });
});

test("review storage parses without leaking into visible source", () => {
  const source = "A \\cmtbg{c1}{Ada}claim\\cmted{Needs evidence\\cmtrpl{m1}{Lin}{Added a citation}\\cmtrpl{m2}{Ada}{Thanks}}; "
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
  assert.deepEqual(reviews[0].messages.map(message => [message.id, message.author, message.body, message.root]), [
    ["c1", "Ada", "Needs evidence", true],
    ["m1", "Lin", "Added a citation", false],
    ["m2", "Ada", "Thanks", false],
  ]);
  assert.equal(reviews[0].repliesValid, true);
  assert.equal(stripReviewStorage(source), "A claim; modern wording; clear text.");
});

test("concurrent comment replies remain complete and parseable", () => {
  const initial = "A \\cmtbg{c1}{Ada}claim\\cmted{Needs evidence}.";
  const base = new Y.Doc();
  base.getText("content").insert(0, initial);
  const baseUpdate = Y.encodeStateAsUpdate(base);
  const left = new Y.Doc();
  const right = new Y.Doc();
  Y.applyUpdate(left, baseUpdate);
  Y.applyUpdate(right, baseUpdate);
  const insertAt = parseReviews(initial)[0].replyInsertAt;
  left.getText("content").insert(insertAt, "\\cmtrpl{m1}{Lin}{Added a citation}");
  right.getText("content").insert(insertAt, "\\cmtrpl{m2}{Mo}{Checked the source}");
  const leftUpdate = Y.encodeStateAsUpdate(left);
  const rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
  assert.equal(left.getText("content").toString(), right.getText("content").toString());
  const thread = parseReviews(left.getText("content").toString())[0];
  assert.equal(thread.repliesValid, true);
  assert.deepEqual(new Set(thread.replies.map(reply => reply.body)), new Set(["Added a citation", "Checked the source"]));
  base.destroy();
  left.destroy();
  right.destroy();
});

test("compile projection removes storage macros beside ordinary letters", () => {
  const source = "before \\delbg{r1}{Lin}bad\\deledafter "
    + "\\addbg{r1}{Lin}good\\addedtext";
  const clean = stripReviewStorage(source);
  assert.equal(clean, "before after goodtext");
  assert.doesNotMatch(clean, /\\(?:cmtbg|cmted|cmtrpl|revbg|reved|addbg|added|delbg|deled)\\b/);
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
    const humanHtml = await human.text();
    assert.match(humanHtml, /<title>LaTeX Coder<\/title>/);

    const browser = await fetch(`${base}/`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" } });
    assert.match(browser.headers.get("content-type"), /^text\/html/);
    const sharedProject = await fetch(`${base}/projects/AbCdEf0123_-`);
    assert.match(sharedProject.headers.get("content-type"), /^text\/html/);
    assert.match(await sharedProject.text(), /id="root"/);
    const agentOverride = await fetch(`${base}/`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/markdown" },
    });
    assert.match(agentOverride.headers.get("content-type"), /^text\/markdown/);
    const removedHumanPrefix = await fetch(`${base}/_human/`);
    assert.equal(removedHumanPrefix.status, 404);

    const assetPath = humanHtml.match(/<script[^>]+src="([^"]+)"/)?.[1];
    assert.ok(assetPath);
    const asset = await fetch(`${base}${assetPath}`);
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
    assert.match(created.id, /^[A-Za-z0-9_-]{12}$/);
    assert.notEqual(created.id, "second-paper");

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
    const renamedProject = (await renamed.json()).project;
    assert.equal(renamedProject.name, "Revised Paper");
    assert.equal(renamedProject.id, created.id);
    assert.match((await fetch(`${base}/projects/${created.id}`)).headers.get("content-type"), /^text\/html/);

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
    assert.deepEqual((await login.json()).user, { username: "admin", displayName: "admin" });
    const profileResponse = await fetch(`${base}/v1/users/me`, {
      method: "PATCH",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Admin Editor" }),
    });
    assert.equal(profileResponse.status, 200);
    assert.deepEqual((await profileResponse.json()).user, { username: "admin", displayName: "Admin Editor" });
    assert.deepEqual((await (await fetch(`${base}/v1/auth/me`, { headers: { Cookie: adminCookie } })).json()).user, {
      username: "admin",
      displayName: "Admin Editor",
    });

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

    const shareResponse = await fetch(`${base}/v1/project/share?project=${project.id}`, { method: "POST", headers: { Cookie: memberCookie } });
    assert.equal(shareResponse.status, 200);
    const share = (await shareResponse.json()).share;
    assert.match(share.agentPath, new RegExp(`^/agent/${project.id}/[A-Za-z0-9_-]+$`));
    const agentWorkspace = await fetch(`${base}${share.agentPath}`);
    assert.match(agentWorkspace.headers.get("content-type"), /^text\/plain/);
    const agentInstructions = await agentWorkspace.text();
    assert.match(agentInstructions, /^# Shared Capability/m);
    assert.match(agentInstructions, /Upload An Updated File/);
    assert.match(agentInstructions, /No JSON escaping, base64/);
    assert.match(agentInstructions, /X-Base-SHA256: \$SHA/);
    assert.match(agentInstructions, /--data-binary @\/tmp\/latexcoder-updated\.tex/);
    assert.match(agentInstructions, /Never just substitute a new/);
    assert.ok(!agentInstructions.includes("FROM=0"));
    assert.match(agentInstructions, /Search The Project/);
    assert.match(agentInstructions, /curl -fsS -X POST '.*\/v1\/search\?project=/);
    assert.match(agentInstructions, /X-Ripgrep-Exit-Code/);
    assert.match(agentInstructions, /Download The Current PDF/);
    assert.match(agentInstructions, /curl -sSL '.*\/v1\/build\/pdf\?project=/);
    assert.match(agentInstructions, /error.details.log/);
    assert.match(agentInstructions, /firstFatalError/);
    assert.match(agentInstructions, /do not call the compile API first/);
    assert.match(agentInstructions, /Reply To An Inline Comment/);
    assert.match(agentInstructions, /\\cmtrpl\{unique-reply-id\}\{Agent Name\}\{Reply text\}/);
    assert.match(agentInstructions, /\/v1\/files\/edit\?project=/);
    assert.match(agentInstructions, /Git \(Only When The User Explicitly Requests It\)/);
    assert.match(agentInstructions, /Do not use Git by default/);
    assert.match(agentInstructions, /\/v1\/git\/commit\?project=/);
    assert.ok(agentInstructions.includes(`git clone ${base}${share.clonePath}`));
    assert.match(agentInstructions, /personal URL accepts pushes from registered project members/);

    const shareToken = share.agentPath.split("/").at(-1);
    const agentFileUrl = `${base}/v1/files?${new URLSearchParams({ project: project.id, access: shareToken, path: "main.tex" })}`;
    const agentRead = await fetch(agentFileUrl);
    assert.equal(agentRead.status, 200);
    assert.equal(agentRead.headers.get("cache-control"), "no-store");
    const agentSource = await agentRead.text();
    const agentPatchUrl = `${base}/v1/files/edit?${new URLSearchParams({ project: project.id, access: shareToken, path: "main.tex" })}`;
    const agentPatch = await fetch(agentPatchUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Base-SHA256": agentRead.headers.get("x-content-sha256")! },
      body: agentSource + "\n% edited from Agent workspace\n",
    });
    assert.equal(agentPatch.status, 200);
    assert.match(await (await fetch(agentFileUrl)).text(), /% edited from Agent workspace\n$/);
    assert.equal((await fetch(`${base}/v1/files?project=${project.id}&access=wrong&path=main.tex`)).status, 401);

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
    assert.equal((await fetch(`${base}/v1/project/share/rotate?project=${project.id}`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    })).status, 401);

    const joinResponse = await fetch(`${base}${share.path}`, { headers: { Cookie: adminCookie }, redirect: "manual" });
    assert.equal(joinResponse.status, 303);
    const adminProjectsAfterJoin = await (await fetch(`${base}/v1/projects`, { headers: { Cookie: adminCookie } })).json();
    assert.deepEqual(adminProjectsAfterJoin.projects.map(item => item.id).sort(), [initialProject, project.id].sort());
    const registeredCollaboratorProject = await fetch(`${base}/v1/project?project=${project.id}`, { headers: { Cookie: adminCookie } });
    assert.equal(registeredCollaboratorProject.status, 200);
    assert.deepEqual((await registeredCollaboratorProject.json()).project.permissions, { manage: false, collaborate: true });
    const adminShareResponse = await fetch(`${base}/v1/project/share?project=${project.id}`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    assert.equal(adminShareResponse.status, 200);
    const adminShare = (await adminShareResponse.json()).share;
    assert.notEqual(adminShare.path, share.path);
    const members = await (await fetch(`${base}/v1/project/members?project=${project.id}`, { headers: { Cookie: adminCookie } })).json();
    assert.deepEqual(members.members.map(member => [member.username, member.role]), [["member.one", "owner"], ["admin", "collaborator"]]);

    const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-private-clone-"));
    try {
      assert.notEqual((await fetch(`${base}/git/${project.id}/info/refs?service=git-upload-pack`)).status, 200);
      await execFileAsync("git", ["clone", `${base}${share.clonePath}`, temporary]);
      assert.equal(await testGit(temporary, ["branch", "--show-current"]), "main");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }

    const sameOwnerShareResponse = await fetch(`${base}/v1/project/share?project=${project.id}`, {
      method: "POST",
      headers: { Cookie: memberCookie },
    });
    assert.equal(sameOwnerShareResponse.status, 200);
    assert.equal((await sameOwnerShareResponse.json()).share.path, share.path);
    const rotateResponse = await fetch(`${base}/v1/project/share/rotate?project=${project.id}`, {
      method: "POST",
      headers: { Cookie: memberCookie },
    });
    assert.equal(rotateResponse.status, 200);
    const rotatedShare = (await rotateResponse.json()).share;
    assert.notEqual(rotatedShare.path, share.path);
    assert.equal((await fetch(`${base}${share.path}`, { redirect: "manual" })).status, 403);
    assert.equal((await fetch(`${base}${share.agentPath}`)).status, 403);
    assert.notEqual((await fetch(`${base}${share.clonePath}/info/refs?service=git-upload-pack`)).status, 200);
    assert.equal((await fetch(`${base}/v1/project?project=${project.id}`, { headers: { Cookie: projectCookie } })).status, 401);
    assert.equal((await fetch(`${base}${rotatedShare.path}`, { redirect: "manual" })).status, 303);
    assert.equal((await fetch(`${base}${adminShare.path}`, { redirect: "manual" })).status, 303);
    assert.equal((await fetch(`${base}/v1/project?project=${project.id}`, { headers: { Cookie: adminCookie } })).status, 200);

    const database = new DatabaseSync(path.join(stateDir, "state.sqlite"), { readOnly: true });
    const users = database.prepare("SELECT username, display_name, password_hash FROM users ORDER BY username").all() as any[];
    assert.deepEqual(users.map(user => user.username), ["admin", "member.one"]);
    assert.deepEqual(users.map(user => user.display_name), ["Admin Editor", "member.one"]);
    assert.ok(users.every(user => user.password_hash && user.password_hash !== adminPassword && user.password_hash !== "another secure password"));
    const storedProject = database.prepare("SELECT owner_username FROM projects WHERE id = ?").get(project.id) as any;
    assert.equal(storedProject.owner_username, "member.one");
    database.close();
    assert.equal(existsSync(path.join(stateDir, "auth.json")), false);
    assert.equal(existsSync(path.join(stateDir, "projects", project.id, "project.json")), false);
    assert.ok(initialProject);
  }, { authDisabled: false, adminPassword });
});

test("user and project sessions survive a server restart", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-session-restart-"));
  const adminPassword = "restart persistence password";
  let paper: any;
  const start = async () => {
    paper = await createPaperServer({ stateDir, authDisabled: false, adminPassword });
    await new Promise<void>((resolve, reject) => {
      paper.server.once("error", reject);
      paper.server.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${(paper.server.address() as AddressInfo).port}`;
  };
  const stop = async () => {
    paper.sockets.close();
    await new Promise(resolve => paper.server.close(resolve));
    paper.shutdown();
  };

  try {
    let base = await start();
    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: adminPassword }),
    });
    const userCookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const projects = await (await fetch(`${base}/v1/projects`, { headers: { Cookie: userCookie } })).json();
    const projectId = projects.defaultProjectId;
    const share = await (await fetch(`${base}/v1/project/share?project=${projectId}`, { method: "POST", headers: { Cookie: userCookie } })).json();
    const exchange = await fetch(`${base}${share.share.path}`, { redirect: "manual" });
    const projectCookie = exchange.headers.get("set-cookie")!.split(";", 1)[0];
    await stop();

    base = await start();
    assert.equal((await fetch(`${base}/v1/projects`, { headers: { Cookie: userCookie } })).status, 200);
    assert.equal((await fetch(`${base}/v1/project?project=${projectId}`, { headers: { Cookie: projectCookie } })).status, 200);
  } finally {
    if (paper?.server.listening) await stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("PDF download compiles current inputs and caches by source revision", async () => {
  const compilerDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-fake-compiler-"));
  const compiler = await createFakeLatexmk(compilerDir);
  try {
    await withServer(async ({ base }) => {
      const first = await fetch(`${base}/v1/build/pdf`);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("x-build-error-count"), "0");
      assert.equal(first.headers.get("x-build-warning-count"), "0");
      assert.match(first.headers.get("link"), /\/v1\/build\?project=/);
      const firstRevision = first.headers.get("x-latex-coder-source-revision");
      assert.match(firstRevision, /^[a-f0-9]{64}$/);
      assert.match(await first.text(), /^fake-pdf-1\n/);
      assert.equal((await readFile(path.join(compilerDir, "count"), "utf8")).trim(), "1");

      const cached = await fetch(`${base}/v1/build/pdf`);
      assert.equal(cached.status, 200);
      assert.equal(cached.headers.get("x-latex-coder-source-revision"), firstRevision);
      assert.match(await cached.text(), /^fake-pdf-1\n/);
      assert.equal((await readFile(path.join(compilerDir, "count"), "utf8")).trim(), "1");

      await fetch(`${base}/v1/files?path=main.tex`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "new source for the current PDF\n",
      });
      const [updated, concurrent] = await Promise.all([
        fetch(`${base}/v1/build/pdf`),
        fetch(`${base}/v1/build/pdf`),
      ]);
      assert.equal(updated.status, 200);
      assert.equal(concurrent.status, 200);
      const updatedRevision = updated.headers.get("x-latex-coder-source-revision");
      assert.match(updatedRevision, /^[a-f0-9]{64}$/);
      assert.notEqual(updatedRevision, firstRevision);
      assert.equal(concurrent.headers.get("x-latex-coder-source-revision"), updatedRevision);
      assert.match(await updated.text(), /^fake-pdf-2\nnew source for the current PDF\n$/);
      assert.match(await concurrent.text(), /^fake-pdf-2\nnew source for the current PDF\n$/);
      assert.equal((await readFile(path.join(compilerDir, "count"), "utf8")).trim(), "2");

      const build = await (await fetch(`${base}/v1/build`)).json();
      assert.equal(build.build.sourceRevision, updatedRevision);
      assert.equal(build.build.status, "success");
    }, { compiler });
  } finally {
    await rm(compilerDir, { recursive: true, force: true });
  }
});

test("Agent PDF download returns structured diagnostics on failure instead of the old PDF", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "latexcoder-pdf-diagnostics-"));
  const compiler = await createFakeLatexmk(directory);
  try {
    await withServer(async ({ base }) => {
      await writeFile(compiler, await readFile(compiler, "utf8") + '\nprintf "LaTeX Warning: Citation undefined\\n"\n');
      const successful = await fetch(`${base}/v1/build/pdf`);
      assert.equal(successful.status, 200);
      assert.equal(successful.headers.get("x-build-warning-count"), "1");
      const warningReport = await (await fetch(`${base}/v1/build`)).json();
      assert.equal(warningReport.build.diagnostics[0].severity, "warning");
      assert.equal(warningReport.build.firstFatalError, null);
      await writeFile(compiler, '#!/bin/sh\nprintf "main.tex:3: Undefined control sequence\\n! Emergency stop.\\n"\nexit 1\n');
      await fetch(`${base}/v1/files?path=main.tex`, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "Changed source\nSecond line\n\\badcommand" });
      const response = await fetch(`${base}/v1/build/pdf`);
      assert.equal(response.status, 422);
      assert.match(response.headers.get("content-type"), /application\/json/);
      const { error } = await response.json();
      assert.equal(error.code, "compile_failed");
      assert.match(error.details.log, /Undefined control sequence/);
      assert.deepEqual(error.details.firstFatalError, { path: "main.tex", line: 3, message: "Undefined control sequence", severity: "error" });
      assert.equal(error.details.main, "main.tex");
      assert.ok(error.details.diagnostics.length >= 1);
      const { build } = await (await fetch(`${base}/v1/build`)).json();
      assert.equal(build.stale, true);
      assert.deepEqual(build.firstFatalError, error.details.firstFatalError);
    }, { compiler });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("search API exposes project-scoped ripgrep output", async () => {
  const sandboxDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-fake-bwrap-"));
  const bwrap = await createFakeBwrap(sandboxDir);
  try {
    await withServer(async ({ base }) => {
      const write = await fetch(`${base}/v1/files?path=notes.tex`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "first line\nNeedle [one]\nneedle [two]\n",
      });
      assert.equal(write.status, 201);

      const search = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pattern: "needle \\[(?:one|two)\\]",
          args: ["--ignore-case", "--line-number", "--with-filename", "--glob", "*.tex"],
          paths: ["."],
        }),
      });
      assert.equal(search.status, 200);
      assert.equal(search.headers.get("cache-control"), "no-store");
      assert.equal(search.headers.get("x-ripgrep-exit-code"), "0");
      assert.equal(await search.text(), "./notes.tex:2:Needle [one]\n./notes.tex:3:needle [two]\n");

      const noMatch = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "not present", args: ["-nH"], paths: ["notes.tex"] }),
      });
      assert.equal(noMatch.status, 200);
      assert.equal(noMatch.headers.get("x-ripgrep-exit-code"), "1");
      assert.equal(await noMatch.text(), "");

      const externalPath = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "root", paths: ["../"] }),
      });
      assert.equal(externalPath.status, 400);

      const externalCommand = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: ".", args: ["--pre=cat"] }),
      });
      assert.equal(externalCommand.status, 400);
      const uiSearch = await fetch(`${base}/v1/search/project`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "needle \\[(?:one|two)\\]", regex: true }),
      });
      assert.equal(uiSearch.status, 200);
      const matches = (await uiSearch.json()).matches;
      assert.deepEqual(matches.map(match => [match.path, match.line, match.from, match.to]), [["notes.tex", 2, 0, 12], ["notes.tex", 3, 0, 12]]);
      const invalidRegex = await fetch(`${base}/v1/search/project`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "[", regex: true }),
      });
      assert.equal(invalidRegex.status, 422);
    }, { bwrap });

    const sandboxArgs = await readFile(path.join(sandboxDir, "args"), "utf8");
    assert.match(sandboxArgs, /^--die-with-parent$/m);
    assert.match(sandboxArgs, /^--unshare-all$/m);
    assert.match(sandboxArgs, /^--ro-bind$/m);
    assert.match(sandboxArgs, /^\/project$/m);
    assert.match(sandboxArgs, /^\/usr\/bin\/rg$/m);
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
});

test("search API kills timed-out bubblewrap processes", async () => {
  const sandboxDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-search-timeout-"));
  try {
    const bwrap = await createFakeBwrap(sandboxDir);
    const slowRg = path.join(sandboxDir, "rg-slow");
    await writeFile(slowRg, "#!/bin/sh\nsleep 5\n", "utf8");
    await chmod(slowRg, 0o755);
    await withServer(async ({ base }) => {
      const startedAt = Date.now();
      const response = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "anything" }),
      });
      assert.equal(response.status, 408);
      assert.ok(Date.now() - startedAt < 2_000);
      assert.equal((await response.json()).error.code, "search_timeout");
    }, { bwrap, rg: slowRg, searchTimeoutMs: 50 });
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
});

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

test("SQLite is authoritative and legacy or stray directories are ignored", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-sqlite-authority-"));
  const strayProject = path.join(stateDir, "projects", "stray", "project");
  await mkdir(strayProject, { recursive: true });
  await writeFile(path.join(strayProject, "main.tex"), "stray source\n", "utf8");
  const paper = await createPaperServer({ stateDir, authDisabled: true });
  try {
    const projects = paper.database.listProjects();
    assert.equal(projects.length, 1);
    assert.match(projects[0].id, /^[A-Za-z0-9_-]{12}$/);
    assert.notEqual(await readFile(path.join(stateDir, "projects", projects[0].id, "project", "main.tex"), "utf8"), "stray source\n");
    assert.equal(paper.projectDir, path.join(stateDir, "projects", projects[0].id, "project"));
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

test("project settings persist and failed compilation retains a visibly stale cached PDF", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "latexcoder-settings-"));
  try {
    const compiler = await createFakeLatexmk(directory);
    await withServer(async ({ base, database }) => {
      const project = (await (await fetch(`${base}/v1/project`)).json()).project;
      await fetch(`${base}/v1/files?path=other.tex`, { method: "PUT", body: "Other source" });
      const settings = await fetch(`${base}/v1/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ main: "other.tex", compiler: "auto", autoCompile: true }) });
      assert.equal(settings.status, 200);
      assert.deepEqual(database.getSettings(project.id), { main: "other.tex", compiler: "auto", autoCompile: true });
      const invalid = await fetch(`${base}/v1/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ main: "../oops.tex", compiler: "auto", autoCompile: false }) });
      assert.equal(invalid.status, 400);
      const firstPdf = await (await fetch(`${base}/v1/build/pdf`)).text();
      await fetch(`${base}/v1/files?path=other.tex`, { method: "PUT", body: "Before\n\\cmtbg{one}{Name}Body\\cmted{Comment\non another line}\nAfter" });
      await writeFile(compiler, '#!/bin/sh\nprintf "other.tex:3: Undefined control sequence\\n"\nexit 1\n');
      const failure = await fetch(`${base}/v1/compile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(failure.status, 422);
      const cached = await fetch(`${base}/v1/build/pdf?cached=1`);
      assert.equal(cached.status, 200);
      assert.equal(await cached.text(), firstPdf);
      const build = (await (await fetch(`${base}/v1/build`)).json()).build;
      assert.equal(build.stale, true);
      assert.equal(build.errors[0].path, "other.tex");
      assert.equal(build.errors[0].line, 4);
      assert.equal(database.getBuild(project.id).errors[0].line, 4);
    }, { compiler });
  } finally { await rm(directory, { recursive: true, force: true }); }
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

test("directory tree preserves empty folders and moves descendants without overwriting", async () => {
  await withServer(async ({base}) => {
    const put = (file, body) => fetch(`${base}/v1/files?path=${encodeURIComponent(file)}`, {method:'PUT',body});
    const move = (from,to) => fetch(`${base}/v1/files/move`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from,to})});
    assert.equal((await fetch(`${base}/v1/files/folder`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'notes/empty'})})).status,201);
    assert.ok((await (await fetch(`${base}/v1/project`)).json()).project.folders.includes('notes/empty'));
    await put('notes/chapter.tex','Keep this text.');
    await put('existing.tex','Do not overwrite.');
    assert.equal((await move('notes/chapter.tex','existing.tex')).status,409);
    assert.equal(await (await fetch(`${base}/v1/files?path=existing.tex`)).text(),'Do not overwrite.');
    assert.equal((await move('notes','notes/child')).status,400);
    assert.equal((await move('notes','chapters')).status,200);
    assert.equal(await (await fetch(`${base}/v1/files?path=chapters/chapter.tex`)).text(),'Keep this text.');
    assert.equal((await fetch(`${base}/v1/files?path=chapters`,{method:'DELETE'})).status,200);
    assert.ok(!(await (await fetch(`${base}/v1/project`)).json()).project.folders.includes('chapters'));
    assert.equal((await move('main.tex','paper/main.tex')).status,200);
    assert.equal((await fetch(`${base}/v1/files?path=paper`,{method:'DELETE'})).status,409);
    assert.equal((await move('paper','research')).status,200);
    assert.equal((await (await fetch(`${base}/v1/project`)).json()).project.main,'research/main.tex');
    assert.equal((await fetch(`${base}/v1/files?path=.git`,{method:'DELETE'})).status,400);
    assert.equal((await fetch(`${base}/v1/files/folder`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'../outside'})})).status,400);
  });
});
