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
    assert.deepEqual((await login.json()).user, { username: "admin", displayName: "admin", isAdmin: true });
    const profileResponse = await fetch(`${base}/v1/users/me`, {
      method: "PATCH",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Admin Editor" }),
    });
    assert.equal(profileResponse.status, 200);
    assert.deepEqual((await profileResponse.json()).user, { username: "admin", displayName: "Admin Editor", isAdmin: true });
    assert.deepEqual((await (await fetch(`${base}/v1/auth/me`, { headers: { Cookie: adminCookie } })).json()).user, {
      username: "admin",
      displayName: "Admin Editor",
      isAdmin: true,
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

    const reusableInvitationResponse = await fetch(`${base}/v1/invitations`, {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ reusable: true }),
    });
    assert.equal(reusableInvitationResponse.status, 201);
    const reusableInvitation = (await reusableInvitationResponse.json()).invitation;
    assert.equal(reusableInvitation.reusable, true);
    const reusableDetails = await (await fetch(`${base}${reusableInvitation.path}`.replace("/register/", "/v1/invitations/"))).json();
    assert.equal(reusableDetails.invitation.reusable, true);
    for (const username of ["reusable.one", "reusable.two"]) {
      const reusableRegistration = await fetch(`${base}/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: reusableInvitation.token, username, password: "another secure password" }),
      });
      assert.equal(reusableRegistration.status, 201);
    }

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
    assert.match(share.viewPath, new RegExp(`^/share/${project.id}/[A-Za-z0-9_-]+$`));
    assert.match(share.editPath, new RegExp(`^/share/${project.id}/[A-Za-z0-9_-]+$`));
    assert.notEqual(share.viewPath, share.editPath);
    assert.match(share.agentPath, new RegExp(`^/agent/${project.id}/[A-Za-z0-9_-]+$`));
    assert.match(share.proposalAgentPath, new RegExp(`^/agent/${project.id}/[A-Za-z0-9_-]+/propose$`));
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
    const proposalWorkspace = await fetch(`${base}${share.proposalAgentPath}`);
    assert.equal(proposalWorkspace.status, 200);
    const proposalInstructions = await proposalWorkspace.text();
    assert.match(proposalInstructions, /Propose Changes/);
    assert.match(proposalInstructions, /forced into reviewable suggestions/);
    assert.doesNotMatch(proposalInstructions, /Git \(Only When The User Explicitly Requests It\)/);
    assert.doesNotMatch(proposalInstructions, /Create A File/);

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
    const proposalToken = share.proposalAgentPath.split("/").at(-2);
    const proposalFileUrl = `${base}/v1/files?${new URLSearchParams({ project: project.id, access: proposalToken, path: "main.tex" })}`;
    const proposalRead = await fetch(proposalFileUrl);
    const proposalSource = await proposalRead.text();
    const proposalEdit = await fetch(`${base}/v1/files/edit?${new URLSearchParams({ project: project.id, access: proposalToken, path: "main.tex", mode: "direct" })}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Base-SHA256": proposalRead.headers.get("x-content-sha256")! },
      body: proposalSource + "Agent proposal\n",
    });
    assert.equal(proposalEdit.status, 200, await proposalEdit.clone().text());
    const proposalResult = await proposalEdit.json();
    assert.equal(proposalResult.edit.mode, "suggesting");
    assert.ok(proposalResult.edit.suggestionIds.length > 0);
    assert.ok(parseReviews(await (await fetch(proposalFileUrl)).text()).some(review => review.author.includes("Coding agent")));
    assert.equal((await fetch(`${base}/v1/files?${new URLSearchParams({ project: project.id, access: proposalToken, path: "new.tex" })}`, {
      method: "PUT", headers: { "Content-Type": "text/plain" }, body: "blocked",
    })).status, 403);
    assert.equal((await fetch(`${base}/v1/git?${new URLSearchParams({ project: project.id, access: proposalToken })}`)).status, 403);
    assert.equal((await fetch(`${base}/v1/files?project=${project.id}&access=wrong&path=main.tex`)).status, 401);

    const exchange = await fetch(`${base}${share.editPath}`, { redirect: "manual" });
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
    assert.deepEqual((await signedCollaboratorProject.json()).project.permissions, { manage: false, edit: true, collaborate: false });
    assert.equal((await fetch(`${base}/v1/project/share/rotate?project=${project.id}`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    })).status, 401);

    const viewJoinResponse = await fetch(`${base}${share.viewPath}`, { headers: { Cookie: adminCookie }, redirect: "manual" });
    assert.equal(viewJoinResponse.status, 200);
    assert.match(viewJoinResponse.headers.get("content-type"), /^text\/html/);
    const viewToken = share.viewPath.split("/").at(-1);
    const viewJoinApi = `${base}/v1/project/join/${project.id}/${viewToken}`;
    const viewJoinDetails = await (await fetch(viewJoinApi, { headers: { Cookie: adminCookie } })).json();
    assert.deepEqual(viewJoinDetails.join, {
      projectId: project.id,
      projectName: "Shared Capability",
      requestedRole: "viewer",
      currentRole: null,
      action: "join",
    });
    const membersBeforeViewConfirmation = await (await fetch(`${base}/v1/project/members?project=${project.id}`, { headers: { Cookie: memberCookie } })).json();
    assert.deepEqual(membersBeforeViewConfirmation.members.map(member => [member.username, member.role]), [["member.one", "owner"]]);
    assert.equal((await fetch(viewJoinApi, { method: "POST", headers: { Cookie: adminCookie } })).status, 200);
    const registeredViewerProject = await fetch(`${base}/v1/project?project=${project.id}`, { headers: { Cookie: adminCookie } });
    assert.equal(registeredViewerProject.status, 200);
    assert.deepEqual((await registeredViewerProject.json()).project.permissions, { manage: false, edit: false, collaborate: false });
    assert.equal((await fetch(`${base}/v1/files?project=${project.id}&path=main.tex`, { headers: { Cookie: adminCookie } })).status, 200);
    assert.equal((await fetch(`${base}/v1/files?project=${project.id}&path=viewer-write.tex`, {
      method: "PUT", headers: { Cookie: adminCookie, "Content-Type": "text/plain" }, body: "blocked",
    })).status, 403);
    assert.equal((await fetch(`${base}/v1/project/share?project=${project.id}`, { method: "POST", headers: { Cookie: adminCookie } })).status, 403);
    const viewerMembers = await (await fetch(`${base}/v1/project/members?project=${project.id}`, { headers: { Cookie: memberCookie } })).json();
    assert.deepEqual(viewerMembers.members.map(member => [member.username, member.role]), [["member.one", "owner"], ["admin", "viewer"]]);

    const joinResponse = await fetch(`${base}${share.editPath}`, { headers: { Cookie: adminCookie }, redirect: "manual" });
    assert.equal(joinResponse.status, 200);
    const editToken = share.editPath.split("/").at(-1);
    const editJoinApi = `${base}/v1/project/join/${project.id}/${editToken}`;
    const editJoinDetails = await (await fetch(editJoinApi, { headers: { Cookie: adminCookie } })).json();
    assert.equal(editJoinDetails.join.action, "upgrade");
    assert.equal(editJoinDetails.join.currentRole, "viewer");
    assert.equal(editJoinDetails.join.requestedRole, "collaborator");
    assert.equal((await fetch(editJoinApi, { method: "POST", headers: { Cookie: adminCookie } })).status, 200);
    const adminProjectsAfterJoin = await (await fetch(`${base}/v1/projects`, { headers: { Cookie: adminCookie } })).json();
    assert.deepEqual(adminProjectsAfterJoin.projects.map(item => item.id).sort(), [initialProject, project.id].sort());
    await fetch(`${base}/v1/project?project=${initialProject}&opened=1`, { headers: { Cookie: adminCookie } });
    await new Promise(resolve => setTimeout(resolve, 5));
    await fetch(`${base}/v1/project?project=${project.id}&opened=1`, { headers: { Cookie: memberCookie } });
    const sharedRecencyOrder = await (await fetch(`${base}/v1/projects`, { headers: { Cookie: adminCookie } })).json();
    assert.deepEqual(sharedRecencyOrder.projects.map(item => item.id), [project.id, initialProject]);
    assert.ok(Date.parse(sharedRecencyOrder.projects[0].lastOpenedAt) > Date.parse(sharedRecencyOrder.projects[1].lastOpenedAt));
    const registeredCollaboratorProject = await fetch(`${base}/v1/project?project=${project.id}`, { headers: { Cookie: adminCookie } });
    assert.equal(registeredCollaboratorProject.status, 200);
    assert.deepEqual((await registeredCollaboratorProject.json()).project.permissions, { manage: false, edit: true, collaborate: true });
    const adminShareResponse = await fetch(`${base}/v1/project/share?project=${project.id}`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    assert.equal(adminShareResponse.status, 200);
    const adminShare = (await adminShareResponse.json()).share;
    assert.notEqual(adminShare.editPath, share.editPath);
    const members = await (await fetch(`${base}/v1/project/members?project=${project.id}`, { headers: { Cookie: adminCookie } })).json();
    assert.deepEqual(members.members.map(member => [member.username, member.role]), [["member.one", "owner"], ["admin", "collaborator"]]);

    const tagsResponse = await fetch(`${base}/v1/projects/${project.id}/tags`, {
      method: "PATCH",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["Quantum", "Draft", "quantum"] }),
    });
    assert.equal(tagsResponse.status, 200);
    assert.deepEqual((await tagsResponse.json()).project.tags, ["Draft", "Quantum"]);
    const adminTaggedProject = (await (await fetch(`${base}/v1/projects`, { headers: { Cookie: adminCookie } })).json()).projects
      .find(item => item.id === project.id);
    assert.deepEqual(adminTaggedProject.tags, ["Draft", "Quantum"]);

    const archiveResponse = await fetch(`${base}/v1/projects/${project.id}/archive`, {
      method: "PATCH",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    assert.equal(archiveResponse.status, 200);
    const adminArchivedProject = (await (await fetch(`${base}/v1/projects`, { headers: { Cookie: adminCookie } })).json()).projects
      .find(item => item.id === project.id);
    const ownerActiveProject = (await (await fetch(`${base}/v1/projects`, { headers: { Cookie: memberCookie } })).json()).projects
      .find(item => item.id === project.id);
    assert.equal(adminArchivedProject.archived, true);
    assert.equal(ownerActiveProject.archived, false);

    const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-private-clone-"));
    try {
      assert.notEqual((await fetch(`${base}/git/${project.id}/info/refs?service=git-upload-pack`)).status, 200);
      await execFileAsync("git", ["clone", `${base}${share.clonePath}`, temporary]);
      assert.equal(await testGit(temporary, ["branch", "--show-current"]), "main");
      await writeFile(path.join(temporary, "member-push.tex"), "pushed with a personal secret\n", "utf8");
      await testGit(temporary, ["add", "member-push.tex"]);
      await testGit(temporary, ["commit", "-m", "Attribute personal Git push"]);
      await testGit(temporary, ["push", "origin", "main"]);
      const pushedBlame = await (await fetch(`${base}/v1/blame?project=${project.id}&path=member-push.tex`, {
        headers: { Cookie: memberCookie },
      })).json();
      assert.ok(pushedBlame.runs.some(run => run.authorId === "member.one"
        && run.authorName === "member.one"
        && run.commit
        && run.gitAuthor?.name === "Test User"
        && run.gitAuthor?.email === "test@example.com"));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }

    const sameOwnerShareResponse = await fetch(`${base}/v1/project/share?project=${project.id}`, {
      method: "POST",
      headers: { Cookie: memberCookie },
    });
    assert.equal(sameOwnerShareResponse.status, 200);
    assert.equal((await sameOwnerShareResponse.json()).share.editPath, share.editPath);
    const rotateResponse = await fetch(`${base}/v1/project/share/rotate?project=${project.id}`, {
      method: "POST",
      headers: { Cookie: memberCookie },
    });
    assert.equal(rotateResponse.status, 200);
    const rotatedShare = (await rotateResponse.json()).share;
    assert.notEqual(rotatedShare.editPath, share.editPath);
    assert.notEqual(rotatedShare.viewPath, share.viewPath);
    assert.equal((await fetch(`${base}${share.editPath}`, { redirect: "manual" })).status, 403);
    assert.equal((await fetch(`${base}${share.viewPath}`, { redirect: "manual" })).status, 403);
    assert.equal((await fetch(`${base}${share.agentPath}`)).status, 403);
    assert.notEqual((await fetch(`${base}${share.clonePath}/info/refs?service=git-upload-pack`)).status, 200);
    assert.equal((await fetch(`${base}/v1/project?project=${project.id}`, { headers: { Cookie: projectCookie } })).status, 401);
    assert.equal((await fetch(`${base}${rotatedShare.editPath}`, { redirect: "manual" })).status, 303);
    assert.equal((await fetch(`${base}${adminShare.editPath}`, { redirect: "manual" })).status, 303);
    assert.equal((await fetch(`${base}/v1/project?project=${project.id}`, { headers: { Cookie: adminCookie } })).status, 200);

    const database = new DatabaseSync(path.join(stateDir, "state.sqlite"), { readOnly: true });
    const users = database.prepare("SELECT username, display_name, password_hash FROM users ORDER BY username").all() as any[];
    assert.deepEqual(users.map(user => user.username), ["admin", "member.one", "reusable.one", "reusable.two"]);
    assert.deepEqual(users.map(user => user.display_name), ["Admin Editor", "member.one", "reusable.one", "reusable.two"]);
    assert.ok(users.every(user => user.password_hash && user.password_hash !== adminPassword && user.password_hash !== "another secure password"));
    const storedProject = database.prepare("SELECT owner_username FROM projects WHERE id = ?").get(project.id) as any;
    assert.equal(storedProject.owner_username, "member.one");
    database.close();
    assert.equal(existsSync(path.join(stateDir, "auth.json")), false);
    assert.equal(existsSync(path.join(stateDir, "projects", project.id, "project.json")), false);
    assert.ok(initialProject);
  }, { authDisabled: false, adminPassword });
});

test("administrators page through users and projects and manage their lifecycle", async () => {
  const adminPassword = "admin control password";
  await withServer(async ({ base }) => {
    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: adminPassword }),
    });
    const adminCookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const invitation = await (await fetch(`${base}/v1/invitations`, {
      method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" }, body: JSON.stringify({ reusable: true }),
    })).json();
    const registration = await fetch(`${base}/v1/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invitation.invitation.token, username: "managed.user", password: "managed old password" }),
    });
    const memberCookie = registration.headers.get("set-cookie")!.split(";", 1)[0];
    assert.equal((await fetch(`${base}/v1/admin/users`, { headers: { Cookie: memberCookie } })).status, 403);

    const usersResponse = await fetch(`${base}/v1/admin/users?q=managed&page=1&limit=10`, { headers: { Cookie: adminCookie } });
    assert.equal(usersResponse.status, 200);
    const users = await usersResponse.json();
    assert.equal(users.total, 1);
    assert.equal(users.items[0].username, "managed.user");
    assert.equal(users.items[0].projectCount, 0);
    assert.equal(users.items[0].deletedAt, null);

    const reset = await fetch(`${base}/v1/admin/users/managed.user/password`, {
      method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "managed new password" }),
    });
    assert.equal(reset.status, 200);
    assert.equal((await fetch(`${base}/v1/projects`, { headers: { Cookie: memberCookie } })).status, 401);
    assert.equal((await fetch(`${base}/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "managed.user", password: "managed old password" }),
    })).status, 401);
    assert.equal((await fetch(`${base}/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "managed.user", password: "managed new password" }),
    })).status, 200);

    assert.equal((await fetch(`${base}/v1/admin/users/admin`, { method: "DELETE", headers: { Cookie: adminCookie } })).status, 409);
    assert.equal((await fetch(`${base}/v1/admin/users/managed.user`, { method: "DELETE", headers: { Cookie: adminCookie } })).status, 200);
    assert.equal((await fetch(`${base}/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "managed.user", password: "managed new password" }),
    })).status, 401);
    const deletedUsers = await (await fetch(`${base}/v1/admin/users?q=managed`, { headers: { Cookie: adminCookie } })).json();
    assert.equal(typeof deletedUsers.items[0].deletedAt, "string");

    const created = await (await fetch(`${base}/v1/projects`, {
      method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Disposable Admin Project" }),
    })).json();
    const projects = await (await fetch(`${base}/v1/admin/projects?q=Disposable&limit=10`, { headers: { Cookie: adminCookie } })).json();
    assert.equal(projects.total, 1);
    assert.equal(projects.items[0].ownerUsername, "admin");
    assert.equal(projects.items[0].memberCount, 1);
    assert.equal((await fetch(`${base}/v1/admin/projects/${created.project.id}`, { method: "DELETE", headers: { Cookie: adminCookie } })).status, 200);
    assert.equal((await fetch(`${base}/v1/project?project=${created.project.id}`, { headers: { Cookie: adminCookie } })).status, 404);
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
    const exchange = await fetch(`${base}${share.share.editPath}`, { redirect: "manual" });
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
