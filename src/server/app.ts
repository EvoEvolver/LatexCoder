import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import { StateDatabase } from "./database.ts";
import { parseReviews } from "../shared/review.ts";
import { apiError, isTextFile, MAX_FILE_BYTES, MAX_TEXT_BYTES, parseCookies, passwordRecord, pathFromRoomName, randomToken, safeRelativePath, sessionCookie, sha256, validatePassword } from "./core.ts";
import { listFiles, listFolders } from "./project-files.ts";
import { run, runBinary } from "./process.ts";
import { createCollaborationStore } from "./collaboration.ts";
import { latestVersionWithMetadata, versionFolders, versionInfo, versionMessage } from "./version-history.ts";
import { createAutoCheckpoint } from "./auto-checkpoint.ts";
import type { AutoCheckpoint } from "./auto-checkpoint.ts";
import { createProjectSearch } from "./search.ts";
import { CompileQueue } from "./compile-queue.ts";
import { createCompileService } from "./compile-service.ts";
import { checkDependencies } from "./dependencies.ts";
import { createLogger, requestLogger } from "./logger.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerBuildRoutes } from "./routes/build.ts";
import { registerFileRoutes } from "./routes/files.ts";
import { registerGitRoutes } from "./routes/git.ts";
import { registerHistoryRoutes } from "./routes/history.ts";
import { registerProjectRoutes } from "./routes/projects.ts";
import { registerPublicRoutes } from "./routes/public.ts";
import { registerSearchRoutes } from "./routes/search.ts";
import type { NextFunction, Request, Response } from "express";
import type { ProjectMetadata } from "./database.ts";
import type { BlameActor, ImportedProjectFile, PaperServer, ProjectFile, ProjectRuntime, ServerOptions } from "./types.ts";

type GitRunOptions = { env?: NodeJS.ProcessEnv; allowedCodes?: number[]; code?: string; status?: number };
type AuthenticatedUser = { username: string; displayName: string; isAdmin: boolean; userType: "internal" | "external" };
type CookieSession = { key: string; token: string };
type CookieRequest = { headers: { cookie?: string } };
type ProjectAccessRequest = CookieRequest & { query?: { access?: unknown } };
type SharePaths = { id: string; viewPath: string; editPath: string; agentPath: string; proposalAgentPath: string; clonePath: string };
type ProjectAccessMode = "view" | "edit";
export { safeRelativePath } from "./core.ts";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_DOCUMENT = String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{hyperref}

\title{A Small Collaborative Paper}
\author{Author Name}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}

This document is shared live. Select text to comment, or turn on Suggesting and edit normally to track changes.

\section{Notes}

The canonical source is persisted as ordinary files and can be edited by agents through the HTTP API.

\end{document}
`;
const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Collaborative Editor",
  GIT_AUTHOR_EMAIL: "editor@localhost",
  GIT_COMMITTER_NAME: "Collaborative Editor",
  GIT_COMMITTER_EMAIL: "editor@localhost",
};

async function git(projectDir: string, args: string[], options: GitRunOptions = {}) {
  const result = await run("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: projectDir,
    env: { ...process.env, ...GIT_IDENTITY_ENV, ...(options.env || {}) },
  });
  const allowed = options.allowedCodes || [0];
  if (!allowed.includes(result.code)) {
    const message = result.output.trim().split("\n").slice(-8).join("\n") || `Git exited with code ${result.code}`;
    throw apiError(options.code || "git_failed", message, options.status || 409);
  }
  return { ...result, output: result.output.trim() };
}

type GitAuthorIdentity = { name: string; email: string };
const gitAuthorCache = new Map<string, GitAuthorIdentity | null>();

async function gitAuthorForCommit(projectDir: string, commit: string): Promise<GitAuthorIdentity | null> {
  if (!/^[0-9a-f]{40}$/i.test(commit)) return null;
  const key = `${projectDir}\0${commit}`;
  if (gitAuthorCache.has(key)) return gitAuthorCache.get(key)!;
  const result = await git(projectDir, ["show", "-s", "--format=%an%x00%ae", commit], { allowedCodes: [0, 128] });
  const [name = "", email = ""] = result.code === 0 ? result.output.split("\0") : [];
  const identity = name && email ? { name, email } : null;
  gitAuthorCache.set(key, identity);
  return identity;
}

async function ensureGitRepository(projectDir: string): Promise<void> {
  if (!existsSync(path.join(projectDir, ".git"))) {
    await git(projectDir, ["init", "-b", "main"]);
    await git(projectDir, ["add", "-A"]);
    await git(projectDir, ["commit", "--allow-empty", "-m", "Initial project"]);
  }
  const branch = (await git(projectDir, ["branch", "--show-current"])).output;
  if (branch !== "main") throw apiError("git_branch_invalid", "the collaborative working tree must remain on main", 409);
}

function cleanCommitMessage(value: unknown, fallback = "Collaborative checkpoint"): string {
  const message = typeof value === "string" ? value.replace(/\r/g, "").trim() : "";
  if (message.length > 500) throw apiError("invalid_commit_message", "commit message must not exceed 500 characters");
  return message || fallback;
}

async function gitHead(projectDir: string, ref = "HEAD"): Promise<string> {
  return (await git(projectDir, ["rev-parse", "--verify", `${ref}^{commit}`])).output.split("\n").at(-1)!;
}

async function gitCheckpoint(runtime: ProjectRuntime, message: unknown, metadata?: Parameters<typeof versionMessage>[1]): Promise<{ commit: string; created: boolean }> {
  runtime.collaboration.flush();
  // Capture the attribution boundary synchronously with the flush. Edits that
  // arrive while Git is running belong to the next checkpoint.
  const blameChanges = runtime.database.pendingBlameChangeIds(runtime.id);
  await git(runtime.projectDir, ["add", "-A"]);
  const changed = await git(runtime.projectDir, ["diff", "--cached", "--quiet"], { allowedCodes: [0, 1] });
  const head = await gitHead(runtime.projectDir);
  const folders = await listFolders(runtime.projectDir);
  const previous = await versionInfo(runtime.projectDir, head);
  const inherited = previous.metadata ? { id: head, metadata: previous.metadata } : await latestVersionWithMetadata(runtime.projectDir, head);
  const trackedFolders = new Set(await versionFolders(runtime.projectDir, head));
  const emptyFolders = folders.filter(folder => !trackedFolders.has(folder));
  const inheritedTrackedFolders = new Set(inherited ? await versionFolders(runtime.projectDir, inherited.id) : []);
  const inheritedEmptyFolders = (inherited?.metadata.folders || []).filter(folder => !inheritedTrackedFolders.has(folder));
  const mainChanged = inherited ? inherited.metadata.main !== runtime.build.main : runtime.build.main !== "main.tex";
  const foldersChanged = JSON.stringify(inheritedEmptyFolders) !== JSON.stringify(emptyFolders);
  const created = changed.code === 1 || mainChanged || foldersChanged;
  if (created) await git(runtime.projectDir, ["commit", "--allow-empty", "-m", versionMessage(cleanCommitMessage(message), { ...(metadata ?? { kind: "checkpoint", main: runtime.build.main }), folders })]);
  const commit = await gitHead(runtime.projectDir);
  if (created) runtime.database.assignBlameChanges(runtime.id, blameChanges, commit);
  return { commit, created };
}

function parseGitStatus(output: string): Array<{ index: string; worktree: string; path: string }> {
  if (!output) return [];
  return output.split("\n").filter(Boolean).map(line => ({
    index: line[0],
    worktree: line[1],
    path: line.slice(3),
  }));
}

async function gitStatus(runtime: ProjectRuntime) {
  runtime.collaboration.flush();
  const branch = (await git(runtime.projectDir, ["branch", "--show-current"])).output;
  const files = parseGitStatus((await git(runtime.projectDir, ["status", "--short", "--untracked-files=all"])).output);
  const upstreamResult = await git(runtime.projectDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowedCodes: [0, 128] });
  const upstream = upstreamResult.code === 0 ? upstreamResult.output.split("\n").at(-1) : null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = (await git(runtime.projectDir, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).output.split(/\s+/).map(Number);
    [ahead, behind] = counts;
  }
  const logOutput = (await git(runtime.projectDir, ["log", "-10", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s"])).output;
  const history = logOutput ? logOutput.split("\n").map(line => {
    const [id, shortId, author, date, subject] = line.split("\x1f");
    return { id, shortId, author, date, subject };
  }) : [];
  const conflictsOutput = (await git(runtime.projectDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/conflict"])).output;
  return {
    branch,
    head: await gitHead(runtime.projectDir),
    upstream,
    ahead,
    behind,
    dirty: files.length > 0,
    files,
    history,
    conflictBranches: conflictsOutput ? conflictsOutput.split("\n") : [],
    conflict: runtime.metadata.git?.conflict || null,
  };
}

function conflictBranchName(date = new Date()): string {
  return `conflict/${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-")}`;
}

function validateMergedText(relativePath: string, source: string): void {
  if (/^(?:<{7}|={7}|>{7})/m.test(source)) throw apiError("git_merge_invalid", `${relativePath} contains merge markers`, 409);
  if (!relativePath.endsWith(".tex")) return;
  const kinds = [
    ["\\cmtbg", "comment"], ["\\revbg", "revision"],
    ["\\addbg", "addition"], ["\\delbg", "deletion"],
  ];
  const reviews = parseReviews(source);
  for (const [marker, kind] of kinds) {
    const count = source.split(marker).length - 1;
    if (count !== reviews.filter(item => item.kind === kind).length) {
      throw apiError("git_review_conflict", `${relativePath} contains malformed review storage`, 409);
    }
  }
  const comments = reviews.filter(item => item.kind === "comment");
  const replies = comments.flatMap(item => item.replies);
  if (
    comments.some(item => !item.repliesValid)
    || source.split("\\cmtrpl").length - 1 !== replies.length
    || new Set(replies.map(reply => reply.id)).size !== replies.length
  ) {
    throw apiError("git_review_conflict", `${relativePath} contains malformed comment replies`, 409);
  }
}

async function trackedPaths(projectDir: string): Promise<string[]> {
  const output = (await git(projectDir, ["ls-files", "-z"])).output;
  return output ? output.split("\0").filter(Boolean) : [];
}

async function importGitWorktree(
  runtime: ProjectRuntime,
  sourceDir: string,
  main = runtime.build.main,
  validateReviews = true,
  blameCommit: string | null = null,
  blameActor: BlameActor = { id: "git", name: "Git import" },
): Promise<void> {
  const before = new Set(await trackedPaths(runtime.projectDir));
  const after = new Set(await trackedPaths(sourceDir));
  if (!after.has(main)) throw apiError("git_main_missing", "the incoming version deletes the main document", 409);

  // Validate the complete target tree before changing any live Yjs document.
  for (const relativePath of after) {
    safeRelativePath(relativePath);
    const source = path.join(sourceDir, relativePath);
    const details = await lstat(source);
    if (!details.isFile()) throw apiError("git_file_unsupported", `${relativePath} is not a regular file`, 409);
    if (details.size > MAX_FILE_BYTES) throw apiError("file_too_large", `${relativePath} is too large to synchronize`, 413);
    if (isTextFile(relativePath)) {
      const content = await readFile(source, "utf8");
      if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw apiError("file_too_large", `${relativePath} is too large to synchronize`, 413);
      if (validateReviews) validateMergedText(relativePath, content);
    }
  }

  for (const relativePath of before) {
    if (after.has(relativePath)) continue;
    await runtime.collaboration.remove(relativePath);
    await rm(path.join(runtime.projectDir, relativePath), { force: true });
  }
  // Remove empty directory shells that would block a restored regular file.
  for (const folder of (await listFolders(runtime.projectDir)).sort((a, b) => b.length - a.length)) {
    if ([...after].some(file => folder === file || folder.startsWith(file + "/"))) await rmdir(path.join(runtime.projectDir, folder));
  }
  for (const relativePath of after) {
    const source = path.join(sourceDir, relativePath);
    const target = path.join(runtime.projectDir, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    if (isTextFile(relativePath)) {
      const content = await readFile(source, "utf8");
      runtime.collaboration.importText(relativePath, content, { ...blameActor, commit: blameCommit });
    } else {
      await cp(source, target);
    }
  }
  runtime.collaboration.flush();
}

async function createConflictBranch(runtime: ProjectRuntime, incoming: string, local: string) {
  const existing = runtime.metadata.git?.conflict;
  if (existing?.incoming === incoming) return existing;
  let branch = conflictBranchName();
  const check = await git(runtime.projectDir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowedCodes: [0, 1] });
  if (check.code === 0) branch = `${branch}-${incoming.slice(0, 7)}`;
  await git(runtime.projectDir, ["branch", branch, incoming]);
  const conflict = { branch, incoming, base: local, createdAt: new Date().toISOString() };
  runtime.metadata = { ...runtime.metadata, git: { ...(runtime.metadata.git || {}), conflict } };
  runtime.database.saveProject(runtime.metadata);
  return conflict;
}

async function withGitOperation<T>(runtime: ProjectRuntime, task: () => Promise<T>): Promise<T> {
  if (runtime.gitBusy || runtime.deleting) throw apiError("git_busy", "another Git operation is already running", 409);
  runtime.gitBusy = true;
  try {
    await runtime.gitLiveOperation?.catch(() => {});
    runtime.collaboration.suspend();
    return await task();
  } finally {
    runtime.collaboration.resume();
    runtime.gitBusy = false;
  }
}

// Serialize index/ref writes without disconnecting editors or blocking Yjs edits.
async function withLiveGitOperation<T>(runtime: ProjectRuntime, task: () => Promise<T>): Promise<T> {
  while (runtime.gitLiveOperation) await runtime.gitLiveOperation.catch(() => {});
  assertProjectWritable(runtime);
  if (runtime.deleting) throw apiError("project_not_found", "project does not exist", 404);
  const operation = task();
  runtime.gitLiveOperation = operation;
  try { return await operation; }
  finally { runtime.gitLiveOperation = null; }
}

async function withGitReader<T>(runtime: ProjectRuntime, task: () => Promise<T>): Promise<T> {
  if (runtime.deleting) throw apiError("project_not_found", "project does not exist", 404);
  runtime.gitReaders += 1;
  try {
    return await task();
  } finally {
    runtime.gitReaders -= 1;
    if (runtime.gitReaders === 0) {
      for (const resolve of runtime.gitReaderWaiters.splice(0)) resolve();
    }
  }
}

async function waitForGitReaders(runtime: ProjectRuntime): Promise<void> {
  runtime.deleting = true;
  if (runtime.gitReaders > 0) await new Promise(resolve => runtime.gitReaderWaiters.push(resolve));
}

function assertProjectWritable(runtime: ProjectRuntime): void {
  if (runtime.gitBusy) throw apiError("git_busy", "the project is synchronizing with Git", 409);
}

async function withTemporaryWorktree<T>(runtime: ProjectRuntime, commit: string, task: (directory: string) => Promise<T>): Promise<T> {
  // The worktree target itself must not exist when `git worktree add` runs.
  const parent = await mkdtemp(path.join(os.tmpdir(), "paper-git-"));
  const worktree = path.join(parent, "worktree");
  try {
    await git(runtime.projectDir, ["worktree", "add", "--detach", worktree, commit]);
    return await task(worktree);
  } finally {
    if (existsSync(worktree)) await git(runtime.projectDir, ["worktree", "remove", "--force", worktree], { allowedCodes: [0, 128] });
    await rm(parent, { recursive: true, force: true });
  }
}

async function gitSyncLocked(runtime: ProjectRuntime, requestedRef: string, blameActor?: BlameActor) {
    await ensureGitRepository(runtime.projectDir);
    const checkpoint = await gitCheckpoint(runtime, "Checkpoint before sync");
    const local = checkpoint.commit;
    let incomingRef = typeof requestedRef === "string" ? requestedRef.trim() : "";
    if (!incomingRef) {
      const upstream = await git(runtime.projectDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowedCodes: [0, 128] });
      if (upstream.code !== 0) throw apiError("git_upstream_missing", "configure an upstream or provide an incoming ref", 409);
      await git(runtime.projectDir, ["fetch"]);
      incomingRef = upstream.output.split("\n").at(-1);
    }
    if (!incomingRef || incomingRef.length > 200 || incomingRef.startsWith("-")) {
      throw apiError("invalid_git_ref", "incoming Git ref is invalid");
    }
    const incoming = await gitHead(runtime.projectDir, incomingRef);
    if (incoming === local) return { status: "up_to_date", commit: local };

    const incomingIsAncestor = await git(runtime.projectDir, ["merge-base", "--is-ancestor", incoming, local], { allowedCodes: [0, 1] });
    if (incomingIsAncestor.code === 0) return { status: "local_ahead", commit: local, incoming };

    const localIsAncestor = await git(runtime.projectDir, ["merge-base", "--is-ancestor", local, incoming], { allowedCodes: [0, 1] });
    let mergedCommit = incoming;
    let mergeConflict = false;
    let semanticConflict: Error | null = null;

    await withTemporaryWorktree(runtime, localIsAncestor.code === 0 ? incoming : local, async worktree => {
      if (localIsAncestor.code !== 0) {
        const merge = await git(worktree, ["merge", "--no-ff", "--no-edit", incoming], { allowedCodes: [0, 1] });
        if (merge.code === 1) {
          mergeConflict = true;
          return;
        }
        mergedCommit = await gitHead(worktree);
      }
      try {
        await importGitWorktree(runtime, worktree, runtime.build.main, true, mergedCommit, blameActor);
      } catch (error) {
        semanticConflict = error instanceof Error ? error : new Error(String(error));
      }
    });

    if (mergeConflict || semanticConflict) {
      const conflict = await createConflictBranch(runtime, incoming, local);
      return {
        status: "conflict",
        commit: local,
        incoming,
        conflict,
        reason: semanticConflict instanceof Error ? semanticConflict.message : "Git could not merge the incoming version automatically",
      };
    }

    await git(runtime.projectDir, ["update-ref", "refs/heads/main", mergedCommit, local]);
    await git(runtime.projectDir, ["read-tree", mergedCommit]);
    return { status: localIsAncestor.code === 0 ? "fast_forward" : "merged", commit: mergedCommit, incoming };
}

async function gitSync(runtime: ProjectRuntime, requestedRef: string) {
  return withGitOperation(runtime, () => gitSyncLocked(runtime, requestedRef));
}

async function gitResolve(runtime: ProjectRuntime, message: unknown) {
  return withGitOperation(runtime, async () => {
    await ensureGitRepository(runtime.projectDir);
    const conflict = runtime.metadata.git?.conflict;
    if (!conflict) throw apiError("git_conflict_missing", "the project has no pending Git conflict", 409);
    const branchTip = await gitHead(runtime.projectDir, conflict.branch);
    if (branchTip !== conflict.incoming) {
      throw apiError("git_conflict_changed", "the pending conflict branch changed; synchronize again before resolving", 409);
    }
    const checkpoint = await gitCheckpoint(runtime, "Checkpoint before conflict resolution");
    const local = checkpoint.commit;
    const tree = (await git(runtime.projectDir, ["write-tree"])).output.split("\n").at(-1);
    const commit = (await git(runtime.projectDir, ["commit-tree", tree, "-p", local, "-p", conflict.incoming, "-m", cleanCommitMessage(message, "Resolve Git conflict")])).output.split("\n").at(-1);
    await git(runtime.projectDir, ["update-ref", "refs/heads/main", commit, local]);
    await git(runtime.projectDir, ["branch", "-D", conflict.branch]);
    const nextGit = { ...(runtime.metadata.git || {}) };
    delete nextGit.conflict;
    runtime.metadata = { ...runtime.metadata, git: nextGit };
    runtime.database.saveProject(runtime.metadata);
    return { status: "resolved", commit };
  });
}

async function createProjectArchive(runtime: ProjectRuntime): Promise<{ archive: string; temporary: string }> {
  assertProjectWritable(runtime);
  runtime.collaboration.flush();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "paper-archive-"));
  const index = path.join(temporary, "index");
  const archive = path.join(temporary, `${runtime.id}.zip`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(runtime.projectDir, ["read-tree", "HEAD"], { env });
    await git(runtime.projectDir, ["add", "--force", "-A"], { env });
    const tree = (await git(runtime.projectDir, ["write-tree"], { env })).output.split("\n").at(-1);
    await git(runtime.projectDir, ["archive", "--format=zip", `--prefix=${runtime.id}/`, `--output=${archive}`, tree]);
    return { archive, temporary };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function gitUploadPack(runtime: ProjectRuntime, args: string[], input: Uint8Array, protocol?: string) {
  const env: Record<string, string | undefined> = { ...process.env, ...GIT_IDENTITY_ENV };
  if (protocol) env.GIT_PROTOCOL = protocol;
  return runBinary("git", ["-c", "core.hooksPath=/dev/null", "upload-pack", "--stateless-rpc", ...args, runtime.projectDir], {
    cwd: runtime.projectDir,
    env,
  }, input);
}

async function prepareGitPull(runtime: ProjectRuntime): Promise<{ commit: string; created: boolean }> {
  await ensureGitRepository(runtime.projectDir);
  return gitCheckpoint(runtime, "Automatic checkpoint before Git pull");
}

async function syncGitIngress(runtime: ProjectRuntime): Promise<{ ingressDir: string; head: string }> {
  const ingressDir = path.join(runtime.projectRoot, "receive.git");
  if (!existsSync(ingressDir)) await git(runtime.projectDir, ["init", "--bare", ingressDir]);
  const head = await gitHead(runtime.projectDir);
  await git(ingressDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(ingressDir, ["fetch", "--no-tags", runtime.projectDir, `+${head}:refs/heads/main`]);
  return { ingressDir, head };
}

async function gitReceivePack(runtime: ProjectRuntime, args: string[], input: Uint8Array, protocol?: string, blameActor?: BlameActor) {
  const { ingressDir, head: before } = await syncGitIngress(runtime);
  const env: Record<string, string | undefined> = { ...process.env, ...GIT_IDENTITY_ENV };
  if (protocol) env.GIT_PROTOCOL = protocol;
  const output = await runBinary("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "receive.denyDeletes=true",
    "-c", "receive.denyNonFastForwards=true",
    "receive-pack", "--stateless-rpc", ...args, ingressDir,
  ], { cwd: ingressDir, env }, input);
  if (args.includes("--advertise-refs")) return { output, sync: null };

  const incoming = await gitHead(ingressDir, "refs/heads/main");
  if (incoming === before) return { output, sync: null };
  const incomingRef = `refs/latexcoder/incoming/${randomUUID()}`;
  try {
    await git(runtime.projectDir, ["fetch", "--no-tags", ingressDir, `+refs/heads/main:${incomingRef}`]);
    const sync = await gitSyncLocked(runtime, incomingRef, blameActor);
    return { output, sync };
  } finally {
    await git(runtime.projectDir, ["update-ref", "-d", incomingRef], { allowedCodes: [0, 1] });
    await syncGitIngress(runtime);
  }
}

function manual(): string {
  return `# LaTeX Coder

LaTeX Coder is a filesystem-backed collaborative LaTeX editor for trusted teams. Browsers receive the editor at this same URL; Agents receive this Markdown manual and use the JSON and file APIs below.

## Projects

\`GET /v1/auth/me\` returns the current member. Members sign in through
\`POST /v1/auth/login\`. \`POST /v1/invitations\` creates a seven-day
registration link; it is single-use by default, or reusable when sent
\`{"reusable":true}\`. Invited users register through
\`POST /v1/auth/register\`.

Member authentication is required for \`GET /v1/projects\` and project creation.
The list contains projects owned by or shared with the current member.
\`POST /v1/projects\` with \`{"name":"My paper"}\` creates an owned project.
Only its owner can rename or delete it. Rename or delete one with
\`PATCH /v1/projects/:id\` and \`DELETE /v1/projects/:id\`. Project summaries
include shared \`tags\` and the current member's personal \`archived\` state.
\`PATCH /v1/projects/:id/tags\` with \`{"tags":["Draft","Quantum"]}\`
replaces the shared tags. \`PATCH /v1/projects/:id/archive\` with
\`{"archived":true}\` archives the project only for the signed-in member.

Every project-specific request below accepts \`?project=<id>\`. If omitted,
the first accessible project is used.

Browser routes \`/projects\` and \`/projects/:id\` provide the member dashboard
and clean editor URLs. A guest first opens \`/share/<project-id>/<secret>\` to
establish a project-scoped session. That session authorizes only the selected
project and does not expose the owner's dashboard. Signing in alone never grants
access to another member's projects. A signed-in user who opens a valid share
link confirms before joining as a persistent viewer or collaborator. Each
registered member gets a different personal secret from
\`POST /v1/project/share?project=<id>\`;
rotating it does not revoke another member's links or project membership.

Each project's source directory is an independent Git repository whose live
working tree always remains on \`main\`. \`GET /v1/git\` returns status and
history. \`POST /v1/git/commit\` creates a collaborative checkpoint.
Edits are checkpointed automatically after 30 idle seconds, or every five
minutes during continuous editing, without disconnecting collaborators.
Clone, fetch, and pull checkpoint current Yjs content before advertising refs.
When that advances remote \`main\`, a normal \`git pull\` merges it with the
Agent's committed local branch, so browser users never need to commit first.
Each registered collaborator gets a personal smart HTTP URL at
\`/git/<project-id>/<share-secret>\`. Clone it and push \`main\` normally; no
upstream configuration is required. A push checkpoints current Yjs changes and
automatically merges the incoming commit into the live document. Imported text
is attributed to the personal secret's owner; commit author name and email are
returned as auxiliary blame information. Conflicts are quarantined on
\`conflict/<UTC timestamp>\`; Yjs and main remain unchanged.
After resolving the content on main, \`POST /v1/git/resolve\` records the
two-parent merge commit.

\`GET /v1/project/archive?project=<id>\` downloads the current working tree as
a ZIP, including uncommitted files.

## Inspect

\`GET /v1/project\` lists project files and the latest build.

\`GET /v1/files?path=main.tex\` reads a file as bytes.
The response includes the current \`X-Content-SHA256\` revision.

\`GET /v1/blame?path=main.tex\` returns the current character ranges with their
collaborator, change ID, and first Git checkpoint. Attribution is collaborative
metadata for trusted teams rather than a tamper-resistant audit log.

\`POST /v1/search\` runs ripgrep inside the project. Send
\`{"pattern":"citation","args":["--line-number","--glob","*.tex"],"paths":["."]}\`.
The response body is native ripgrep output and \`X-Ripgrep-Exit-Code\` is 0 for
matches or 1 for no matches.

\`GET /v1/build/pdf\` downloads a PDF for the current project contents. The
server compiles automatically when the inputs have changed and otherwise reuses
its matching cached artifact.
Compilation failure returns HTTP 422 JSON with \`error.details.log\`,
\`error.details.diagnostics\`, and \`error.details.firstFatalError\`.
Successful PDF responses include diagnostic counts and a \`Link\` header pointing
to \`GET /v1/build\` for the full log and warnings.

## Mutate

\`PUT /v1/files?path=chapters/intro.tex\` writes the raw request body.

\`POST /v1/files/edit?path=main.tex\` uploads the complete updated UTF-8 file
as raw bytes. Supply the downloaded file's \`X-Content-SHA256\` in the
\`X-Base-SHA256\` request header. The server checks the live Yjs revision,
calculates the diff, and applies it in one transaction. Stale uploads return
HTTP 409 without changing the file. Direct editing is the default.
To create suggestions, add \`&mode=suggesting&agentId=ag_unique&agentName=writer\`.

\`DELETE /v1/files?path=chapters/intro.tex\` removes a file.

\`POST /v1/compile\` with JSON \`{"main":"main.tex"}\` compiles a PDF.

Text files are synchronized through Yjs. Writing through the API updates connected editors. Inline comments use \`\\cmtbg{id}{name}text\\cmted{comment}\`; replies are appended inside the final argument as \`\\cmtrpl{reply-id}{name}{reply}\`. Suggestion mode tracks insertions as \`\\addbg{id}{name}text\\added\` and deletions as \`\\delbg{id}{name}text\\deled\`.

## Trust

Passwords are scrypt-hashed and share URLs are bearer secrets exchanged for
24-hour, project-scoped sessions. Anyone holding a share URL can edit and
reshare that project. Users, invitations, projects, sessions, build state, and
Yjs snapshots are persisted in SQLite. LaTeX
compilation is not a security sandbox; use this service with trusted teams and
do not store unrelated secrets in project directories.
`;
}

function agentProjectManual(runtime: ProjectRuntime, files: ProjectFile[], shareToken: string, origin: string, proposal = false): string {
  const capability = new URLSearchParams({ project: runtime.id, access: shareToken });
  const fileUrl = (relativePath: string): string => `/v1/files?${capability}&path=${encodeURIComponent(relativePath)}`;
  const editUrl = (relativePath: string): string => `/v1/files/edit?${capability}&path=${encodeURIComponent(relativePath)}${proposal ? "&mode=suggesting&agentId=ag_proposal&agentName=Coding%20agent" : ""}`;
  const projectUrl = `/v1/project?${capability}`;
  const searchUrl = `/v1/search?${capability}`;
  const pdfUrl = `/v1/build/pdf?${capability}`;
  const gitUrl = (endpoint: string): string => `/v1/git${endpoint}?${capability}`;
  const cloneUrl = `${origin}/git/${encodeURIComponent(runtime.id)}/${encodeURIComponent(shareToken)}`;
  const main = runtime.build.main || "main.tex";
  const fileList = files.map(file => `- ${JSON.stringify(file.path)}${file.text ? " (text)" : " (binary)"}`).join("\n");
  return `# ${runtime.metadata.name}${proposal ? " - Propose Changes" : ""}

This is the plain-text Agent workspace for project ${runtime.id}. The secret in
this URL grants ${proposal ? "proposal-only" : "direct edit"} access to this project. Keep it private.
${proposal ? "Every checked edit through this capability is forced into reviewable suggestions. It cannot directly overwrite source, create or delete files, or use Git." : ""}

## Files

${fileList || "(empty project)"}

## Inspect

GET ${projectUrl}
GET ${fileUrl(main)}

The file response includes X-Content-SHA256. Use that digest when submitting a
checked edit so a concurrent human or Agent change cannot be overwritten.

## Search The Project

curl -fsS -X POST '${origin}${searchUrl}' \\
  -H 'Content-Type: application/json' \\
  --data '{"pattern":"citation","args":["--line-number","--glob","*.tex"],"paths":["."]}'

The response is normal ripgrep output. Most search and output options are
accepted in args; pattern and project-relative paths stay separate so the
search cannot leave this project. Each search runs in a read-only bubblewrap
sandbox with no network and a 15 second timeout. X-Ripgrep-Exit-Code is 0 for
matches and 1 for no matches.

## Download The Current PDF

status=$(curl -sSL '${origin}${pdfUrl}' -D latest.headers -o latest.response -w '%{http_code}')
if [ "$status" = 200 ]; then mv latest.response latest.pdf; else cat latest.response; fi

This always downloads a PDF built from the current project inputs. The server
handles compilation and caching; do not call the compile API first.
Check the HTTP status before treating the response as a PDF. HTTP 422 returns
JSON: error.details.log contains the compiler output, diagnostics contains
errors and warnings with source path/line when available, and firstFatalError
identifies the first fatal error. Fix the source with a checked file upload,
then request this PDF URL again. Failed compilation does not return a stale PDF.
On success, X-Build-Error-Count and X-Build-Warning-Count summarize diagnostics;
the Link header points to the project-scoped log API. You can also inspect:

curl -fsS '${origin}/v1/build?${capability}'

Its build object includes log, diagnostics, and firstFatalError. A failed build
may still reference a PDF from a previous successful build; that artifact is not
evidence that the current source compiles.

## Upload An Updated File

Download the file and its revision, edit the downloaded file locally, then
upload the complete updated file as raw UTF-8 bytes. No JSON escaping, base64,
or character offsets are needed. Keep all unchanged content, including review
macros and replies, intact.

curl -fsS -D /tmp/latexcoder-headers '${origin}${fileUrl(main)}' \\
  -o /tmp/latexcoder-current.tex
SHA=$(awk 'tolower($1) == "x-content-sha256:" { gsub("\\r", "", $2); print $2 }' \\
  /tmp/latexcoder-headers)

cp /tmp/latexcoder-current.tex /tmp/latexcoder-updated.tex
# Edit /tmp/latexcoder-updated.tex with your local file-editing tool.

curl -fsS -X POST '${origin}${editUrl(main)}' \\
  -H 'Content-Type: text/plain; charset=utf-8' \\
  -H "X-Base-SHA256: $SHA" \\
  --data-binary @/tmp/latexcoder-updated.tex

The server computes Yjs operations automatically and broadcasts them to
connected editors. It checks the hash of the live collaborative content, not
an older disk copy. Missing or invalid hashes are rejected; stale hashes return
HTTP 409 with error.details.currentSha256. Download the latest file, reapply
your intended changes to that version, and retry. Never just substitute a new
hash onto an old edited file: that would overwrite others' changes.

For a read-only conflict report, POST the same proposed file and original
X-Base-SHA256 to ${origin}${editUrl(main).replace("/edit?", "/edit/conflict?")}.
The JSON response includes currentSource, currentSha256, and a unified diff
comparing the current source with your proposed upload. This is NOT a three-way
merge: the diff may include other collaborators' edits. Read the latest source,
reapply only your intended changes, and upload using its currentSha256.
The diagnostic endpoint never writes or automatically retries an edit.

${proposal
    ? "Uploads through this capability are always reviewable suggestions, even if a request asks for direct mode. The response returns the generated suggestion IDs. Suggestions may not overlap existing open reviews."
    : "Uploads are direct edits by default. To create reviewable suggestions, append &mode=suggesting&agentId=ag_uniqueid&agentName=Agent%20Name to the upload URL. The response returns the resulting file hash and generated suggestion IDs. Suggestion uploads may not overlap existing open reviews."}

${proposal ? "" : `## Reply To An Inline Comment

Comments are stored as:

\\cmtbg{thread-id}{Author}selected text\\cmted{initial comment}

To reply, edit the downloaded file to append this immediately before the final
closing brace of that comment's \\cmted argument:

\\cmtrpl{unique-reply-id}{Agent Name}{Reply text}

Keep the existing comment and replies intact unless the user explicitly asks
to resolve or rewrite them. Upload the updated file with its original base hash.
`}

${proposal ? "" : `## Create A File

PUT ${fileUrl(main)}
Content-Type: text/plain; charset=utf-8

Use PUT only for new files or binary uploads. For existing text files, use the
checked full-file upload above; do not use an unchecked PUT to bypass a conflict.
`}

## Persistent edit history

Every successful checked edit automatically saves a before/after version. The
response's edit.version identifies your change. Pass agentId and agentName query
parameters even in direct mode so the History view can identify your edits.
GET /v1/history?${capability}&agent=1 lists agent edits; GET
/v1/history/VERSION?${capability} lists changed files, and adding &path=FILE shows
added/deleted lines. These safety versions are automatic, no Git command needed.

${proposal ? "" : `## Git (Only When The User Explicitly Requests It)

Do not use Git by default. For normal editing, use the checked full-file upload
above. Only inspect Git status, create a commit, resolve a conflict, clone, or
push the repository when the user explicitly requests that Git operation.

GET ${gitUrl("")}

POST ${gitUrl("/commit")}
Content-Type: application/json

{"message":"Commit message requested by the user"}

Clone and push remote:

git clone ${cloneUrl}
cd ${runtime.id}
git push origin main

The personal URL accepts pushes from registered project members. A push
checkpoints current Yjs changes, then automatically merges the pushed commit
into Yjs-backed main. If it cannot merge safely, the incoming commit is kept on
a conflict branch and the live document stays unchanged. Browser edits are
checkpointed automatically, and clone/fetch/pull checkpoint current Yjs content
before advertising refs. Use the checked full-file upload unless the user specifically asks for a
Git workflow.
`}
`;
}

function safeProjectId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{12}$/.test(value)) {
    throw apiError("invalid_project", "project id is invalid");
  }
  return value;
}

function randomProjectId(): string {
  return randomBytes(9).toString("base64url");
}

function cleanProjectName(value: unknown): string {
  if (typeof value !== "string") throw apiError("invalid_project_name", "project name is required");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw apiError("invalid_project_name", "project name must contain 1 to 80 characters");
  return name;
}

function cleanProjectTags(tags: string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of tags) {
    const tag = value.replace(/\s+/g, " ").trim();
    const key = tag.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, tag);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

export async function createPaperServer(options: ServerOptions = {}): Promise<PaperServer> {
  const projectSearch = createProjectSearch(options);
  const stateDir = path.resolve(options.stateDir || process.env.LATEXCODER_STATE_DIR || path.join(process.cwd(), ".latexcoder"));
  const projectsDir = path.join(stateDir, "projects");
  await mkdir(stateDir, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  const database = new StateDatabase(stateDir);
  const logger = createLogger(options.logRequests ?? false);
  const autoCheckpoints = new Map<string, AutoCheckpoint>();
  const compileConcurrency = options.compileConcurrency ?? Number(process.env.LATEXCODER_COMPILE_CONCURRENCY || 2);
  const compileQueue = new CompileQueue(compileConcurrency);
  const dependencies = await checkDependencies(stateDir, options);
  logger.info("server.dependencies", { dependencies });

  const authDisabled = options.authDisabled === true;
  const configuredAdminPassword = options.adminPassword ?? process.env.LATEXCODER_ADMIN_PASSWORD;
  if (!authDisabled && database.countUsers() === 0 && configuredAdminPassword) {
    const password = validatePassword(configuredAdminPassword);
    database.createUser({
      username: "admin",
      displayName: "admin",
      ...passwordRecord(password),
      createdAt: new Date().toISOString(),
      invitedBy: null,
      isAdmin: true,
    });
  }

  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const USER_SESSION_SECONDS = 7 * 24 * 60 * 60;
  const PROJECT_SESSION_SECONDS = 24 * 60 * 60;
  const INVITATION_SECONDS = 7 * 24 * 60 * 60;

  function cookieSession(request: CookieRequest, cookieName: string): CookieSession | null {
    const token = parseCookies(request)[cookieName];
    if (!token) return null;
    return { key: sha256(token), token };
  }

  function userSession(request: CookieRequest) {
    const session = cookieSession(request, "lc_user");
    if (!session) return null;
    const record = database.getUserSession(session.key);
    return record ? { ...session, record } : null;
  }

  function projectSession(request: CookieRequest) {
    const session = cookieSession(request, "lc_access");
    if (!session) return null;
    const record = database.getProjectSession(session.key);
    return record ? { ...session, record } : null;
  }

  function currentUser(request: CookieRequest): AuthenticatedUser | null {
    if (authDisabled) return { username: "test-user", displayName: "Test User", isAdmin: true, userType: "internal" };
    const session = userSession(request);
    if (!session) return null;
    const user = database.getUser(session.record.username);
    return user && !user.deletedAt ? { username: user.username, displayName: user.displayName, isAdmin: user.isAdmin, userType: user.userType } : null;
  }

  function requestBlameActor(request: CookieRequest & { query?: Record<string, unknown> }): BlameActor {
    const requestedId = typeof request.query?.authorId === "string" ? request.query.authorId.trim().slice(0, 100) : "";
    const requestedName = typeof request.query?.authorName === "string" ? request.query.authorName.trim().slice(0, 100) : "";
    if (requestedId || requestedName) return { id: requestedId || requestedName, name: requestedName || requestedId };
    const agentId = typeof request.query?.agentId === "string" ? request.query.agentId.trim().slice(0, 100) : "";
    const agentName = typeof request.query?.agentName === "string" ? request.query.agentName.trim().slice(0, 100) : "";
    if (agentId || agentName) return { id: agentId || "agent", name: agentName || "Coding agent" };
    const user = currentUser(request);
    return user ? { id: user.username, name: user.displayName } : { id: "guest", name: "Guest" };
  }

  function requireUser(request: CookieRequest): AuthenticatedUser {
    const user = currentUser(request);
    if (!user) throw apiError("authentication_required", "sign in to continue", 401);
    return user;
  }

  function requireAdmin(request: CookieRequest): AuthenticatedUser {
    const user = requireUser(request);
    if (!user.isAdmin) throw apiError("admin_required", "administrator access is required", 403);
    return user;
  }

  function isProjectOwner(request: CookieRequest, runtime: ProjectRuntime): boolean {
    return currentUser(request)?.username === runtime.metadata.ownerUsername;
  }

  function projectMembership(request: CookieRequest, runtime: ProjectRuntime) {
    const user = currentUser(request);
    return user ? database.getProjectMember(runtime.id, user.username) : null;
  }

  function membershipAccessMode(request: CookieRequest, runtime: ProjectRuntime): ProjectAccessMode | null {
    const membership = projectMembership(request, runtime);
    if (!membership) return null;
    return membership.role === "viewer" ? "view" : "edit";
  }

  function findViewShare(runtime: ProjectRuntime, supplied: unknown) {
    if (typeof supplied !== "string" || !supplied) return null;
    return database.getProjectShareByViewToken(runtime.id, sha256(supplied));
  }

  function projectAccessMode(request: ProjectAccessRequest, runtime: ProjectRuntime): ProjectAccessMode | null {
    const membership = membershipAccessMode(request, runtime);
    if (membership) return membership;
    const session = projectSession(request);
    if (session?.record.projects.has(runtime.id)) return session.record.access.get(runtime.id) || "edit";
    if (findProjectShare(runtime, request.query?.access) || findProposalShare(runtime, request.query?.access)) return "edit";
    return findViewShare(runtime, request.query?.access) ? "view" : null;
  }

  function hasProjectAccess(request: ProjectAccessRequest, runtime: ProjectRuntime): boolean {
    return projectAccessMode(request, runtime) !== null;
  }

  function projectAccessShareId(request: ProjectAccessRequest, runtime: ProjectRuntime): string | null {
    if (projectMembership(request, runtime)) return null;
    const session = projectSession(request);
    if (session?.record.projects.has(runtime.id)) return session.record.shares.get(runtime.id) || null;
    return (findProjectShare(runtime, request.query?.access) || findProposalShare(runtime, request.query?.access))?.id || null;
  }

  function requireProjectAccess(request: ProjectAccessRequest, runtime: ProjectRuntime): void {
    if (!hasProjectAccess(request, runtime)) {
      throw apiError("project_access_required", "open a valid project share link or sign in as the project owner", 401);
    }
  }

  function requireProjectOwner(request: Request, runtime: ProjectRuntime): void {
    if (!isProjectOwner(request, runtime)) {
      throw apiError("project_owner_required", "only the project owner can manage this project", 403);
    }
  }

  function requireProjectMember(request: Request, runtime: ProjectRuntime) {
    const membership = projectMembership(request, runtime);
    if (!membership) throw apiError("project_member_required", "sign in as a project member to continue", 403);
    return membership;
  }

  function issueUserSession(request: Request, response: Response, username: string): void {
    const token = randomToken();
    database.createUserSession(sha256(token), username, Date.now() + USER_SESSION_SECONDS * 1000);
    response.append("Set-Cookie", sessionCookie(request, "lc_user", token, USER_SESSION_SECONDS));
  }

  function issueProjectSession(request: Request, response: Response, projectId: string, shareId: string | null, accessMode: ProjectAccessMode): void {
    const existing = projectSession(request);
    const token = existing?.token || randomToken();
    database.addProjectSession(sha256(token), projectId, shareId, accessMode, Date.now() + PROJECT_SESSION_SECONDS * 1000);
    response.append("Set-Cookie", sessionCookie(request, "lc_access", token, PROJECT_SESSION_SECONDS));
  }

  const projects = new Map<string, ProjectRuntime>();
  const initialOwnerUsername = authDisabled
    ? "test-user"
    : database.getUser("admin")
      ? "admin"
      : database.firstUsername() || null;
  function publicProjectMetadata(metadata: ProjectMetadata): Omit<ProjectMetadata, "shareToken" | "ownerUsername"> {
    const result = { ...metadata };
    delete result.shareToken;
    delete result.ownerUsername;
    return result;
  }

  function findProjectShare(runtime: ProjectRuntime, supplied: unknown) {
    if (typeof supplied !== "string" || !supplied) return null;
    return database.getProjectShareByToken(runtime.id, sha256(supplied));
  }

  function findProposalShare(runtime: ProjectRuntime, supplied: unknown) {
    if (typeof supplied !== "string" || !supplied) return null;
    return database.getProjectShareByProposalToken(runtime.id, sha256(supplied));
  }

  const isProposalAccess = (runtime: ProjectRuntime, supplied: unknown): boolean => Boolean(findProposalShare(runtime, supplied));

  function sharePaths(runtime: ProjectRuntime, shareId: string, shareToken: string, viewToken: string, proposalToken: string): SharePaths {
    return {
      id: shareId,
      viewPath: `/share/${encodeURIComponent(runtime.id)}/${viewToken}`,
      editPath: `/share/${encodeURIComponent(runtime.id)}/${shareToken}`,
      agentPath: `/agent/${encodeURIComponent(runtime.id)}/${shareToken}`,
      proposalAgentPath: `/agent/${encodeURIComponent(runtime.id)}/${proposalToken}/propose`,
      clonePath: `/git/${encodeURIComponent(runtime.id)}/${shareToken}`,
    };
  }

  function memberProjectShare(runtime: ProjectRuntime, username: string): SharePaths {
    const existing = database.getProjectShareForUser(runtime.id, username);
    if (existing) {
      let viewToken = existing.viewToken;
      if (!viewToken) {
        viewToken = randomToken();
        database.setProjectShareViewToken(runtime.id, username, viewToken, sha256(viewToken));
      }
      let proposalToken = existing.proposalToken;
      if (!proposalToken) {
        proposalToken = randomToken();
        database.setProjectShareProposalToken(runtime.id, username, proposalToken, sha256(proposalToken));
      }
      return sharePaths(runtime, existing.id, existing.token, viewToken, proposalToken);
    }
    const id = randomProjectId();
    const token = randomToken();
    const viewToken = randomToken();
    const proposalToken = randomToken();
    database.createProjectShare(runtime.id, id, username, token, sha256(token), viewToken, sha256(viewToken), proposalToken, sha256(proposalToken), Date.now());
    return sharePaths(runtime, id, token, viewToken, proposalToken);
  }

  function rotateShare(runtime: ProjectRuntime, username: string): SharePaths {
    const current = database.getProjectShareForUser(runtime.id, username);
    if (!current) throw apiError("share_not_found", "create your project access secret first", 404);
    const shareToken = randomToken();
    const viewToken = randomToken();
    const proposalToken = randomToken();
    if (!database.rotateProjectShare(runtime.id, username, shareToken, sha256(shareToken), viewToken, sha256(viewToken), proposalToken, sha256(proposalToken))) {
      throw apiError("share_not_found", "project access grant does not exist", 404);
    }
    runtime.collaboration.disconnectShare(current.id, "project access secret changed");
    return sharePaths(runtime, current.id, shareToken, viewToken, proposalToken);
  }

  async function loadProject(id: unknown): Promise<ProjectRuntime> {
    const projectId = safeProjectId(id);
    const cached = projects.get(projectId);
    if (cached) return cached;
    const metadata = database.getProject(projectId);
    if (!metadata) throw apiError("project_not_found", "project does not exist", 404);
    const projectRoot = path.join(projectsDir, projectId);
    if (!existsSync(projectRoot)) throw apiError("project_not_found", "project does not exist", 404);
    const projectDir = path.join(projectRoot, "project");
    const buildDir = path.join(projectRoot, "build");
    await mkdir(projectDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });
    const mainPath = path.join(projectDir, "main.tex");
    if (!(await listFiles(projectDir)).length) await writeFile(mainPath, DEFAULT_DOCUMENT, "utf8");
    await ensureGitRepository(projectDir);
    const build = database.getBuild(projectId);
    build.pdf = build.pdf && existsSync(path.join(buildDir, "latest.pdf"));
    const runtime: ProjectRuntime = {
      id: projectId, metadata, projectRoot, projectDir, buildDir,
      database,
      collaboration: createCollaborationStore(projectId, projectDir, database, () => autoCheckpoints.get(projectId)?.changed()),
      build,
      compilePromise: null,
      gitBusy: false,
      gitLiveOperation: null,
      gitReaders: 0,
      gitReaderWaiters: [],
      deleting: false,
    };
    projects.set(projectId, runtime);
    const autoCheckpoint = createAutoCheckpoint({
      idleMs: options.gitCheckpointIdleMs,
      maxWaitMs: options.gitCheckpointMaxWaitMs,
      checkpoint: () => withGitReader(runtime, () => withLiveGitOperation(runtime, () => gitCheckpoint(runtime, "Automatic checkpoint"))),
      onError: error => { if (!runtime.deleting) logger.error("git.checkpoint.failed", error, { projectId }); },
    });
    autoCheckpoints.set(projectId, autoCheckpoint);
    autoCheckpoint.changed();
    return runtime;
  }

  async function projectSummaries(username: string | null = null) {
    const summaries: Array<ReturnType<typeof publicProjectMetadata> & { build: { status: string; pdf: boolean }; membership: string; tags: string[]; archived: boolean; permissions: { manage: boolean; edit: boolean; collaborate: boolean } }> = [];
    const records = username ? database.listProjectsForUser(username) : database.listProjects();
    for (const metadata of records) {
      const runtime = await loadProject(metadata.id);
      const membership = metadata.membershipRole || "owner";
      summaries.push({
        ...publicProjectMetadata(runtime.metadata),
        build: { status: runtime.build.status, pdf: runtime.build.pdf },
        membership,
        tags: metadata.tags || database.listProjectTags(metadata.id),
        archived: metadata.membershipArchived || false,
        permissions: { manage: membership === "owner", edit: membership !== "viewer", collaborate: membership !== "viewer" },
      });
    }
    return summaries.sort((left, right) =>
      Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt)
      || left.name.localeCompare(right.name));
  }

  async function createProject(name: unknown, ownerUsername: string | null, importedFiles: ImportedProjectFile[] = []): Promise<ProjectRuntime> {
    const projectName = cleanProjectName(name);
    let id = randomProjectId();
    while (database.getProject(id) || existsSync(path.join(projectsDir, id))) id = randomProjectId();
    const projectRoot = path.join(projectsDir, id);
    const createdAt = new Date().toISOString();
    const metadata: ProjectMetadata = { id, name: projectName, ownerUsername, createdAt, lastOpenedAt: createdAt, shareToken: randomToken() };
    await mkdir(projectRoot, { recursive: true });
    try {
      for (const file of importedFiles) {
        const target = path.join(projectRoot, "project", file.relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      database.createProject(metadata);
      const runtime = await loadProject(id);
      if (importedFiles.length) {
        const main = importedFiles.find(file => file.relativePath === "main.tex")
          || importedFiles.find(file => file.relativePath.endsWith(".tex"));
        if (main) { runtime.build.main = main.relativePath; database.saveBuild(id, runtime.build); }
      }
      return runtime;
    } catch (error) {
      projects.delete(id);
      autoCheckpoints.get(id)?.close();
      autoCheckpoints.delete(id);
      database.deleteProject(id);
      await rm(projectRoot, { recursive: true, force: true });
      throw error;
    }
  }

  let existing = await projectSummaries();
  if (!existing.length && initialOwnerUsername) {
    await createProject("Paper", initialOwnerUsername);
    existing = await projectSummaries();
  }
  let defaultProjectId = existing[0]?.id || null;
  async function deleteProject(runtime: ProjectRuntime): Promise<{ defaultProjectId: string | null }> {
    const ownerUsername = runtime.metadata.ownerUsername;
    await waitForGitReaders(runtime);
    autoCheckpoints.get(runtime.id)?.close();
    autoCheckpoints.delete(runtime.id);
    runtime.collaboration.shutdown();
    projects.delete(runtime.id);
    const deletedRoot = `${runtime.projectRoot}.deleted-${randomUUID()}`;
    await rename(runtime.projectRoot, deletedRoot);
    try {
      database.deleteProject(runtime.id);
    } catch (error) {
      await rename(deletedRoot, runtime.projectRoot);
      throw error;
    }
    await rm(deletedRoot, { recursive: true, force: true });
    const remaining = await projectSummaries(ownerUsername);
    if (defaultProjectId === runtime.id) defaultProjectId = (await projectSummaries())[0]?.id || null;
    return { defaultProjectId: remaining[0]?.id || null };
  }
  const defaultProjectForRequest = async (request: CookieRequest): Promise<string> => {
    const user = currentUser(request);
    if (user) {
      const accessible = await projectSummaries(user.username);
      if (accessible.length) return accessible[0].id;
    }
    const access = projectSession(request);
    if (access) {
      for (const projectId of access.record.projects) {
        if (database.getProject(projectId)) return projectId;
      }
    }
    throw apiError("project_not_found", "no accessible project was selected", 404);
  };
  const resolveProject = async (request: Request): Promise<ProjectRuntime> => {
    const runtime = await loadProject(request.query.project || await defaultProjectForRequest(request));
    requireProjectAccess(request, runtime);
    if (findProposalShare(runtime, request.query.access)) {
      const readOnly = ["GET", "HEAD"].includes(request.method) && !request.path.startsWith("/v1/git");
      const allowed = readOnly || request.path === "/v1/search" || request.path === "/v1/files/edit" || request.path === "/v1/files/edit/conflict" || request.path === "/v1/files/patch";
      if (!allowed) throw apiError("proposal_read_only", "this Agent capability can only submit reviewable text suggestions", 403);
    }
    if (projectAccessMode(request, runtime) === "view" && !["GET", "HEAD"].includes(request.method)) {
      const readOnlyPost = new Set([
        "/v1/search/project", "/v1/search/replace/preview", "/v1/search",
        "/v1/build/position", "/v1/build/source", "/v1/compile",
      ]).has(request.path);
      if (!readOnlyPost) throw apiError("project_view_only", "this project link allows viewing but not editing", 403);
    }
    return runtime;
  };
  const resolveGitProject = async (request: Request): Promise<ProjectRuntime> => {
    const runtime = await loadProject(request.params.projectId);
    if (hasProjectAccess(request, runtime)) return runtime;
    if (!findProjectShare(runtime, request.params.shareToken)) throw apiError("project_access_required", "Git clone URL is invalid", 401);
    return runtime;
  };
  const resolveGitPushProject = async (request: Request): Promise<{ runtime: ProjectRuntime; actor: BlameActor }> => {
    const runtime = await loadProject(request.params.projectId);
    const share = findProjectShare(runtime, request.params.shareToken);
    const username = share?.username;
    const membership = username ? database.getProjectMember(runtime.id, username) : null;
    if (!username || !membership || membership.role === "viewer") {
      throw apiError("project_access_required", "a registered member's personal Git URL is required for push", 401);
    }
    const user = database.getUser(username);
    const requestUser = currentUser(request);
    return {
      runtime,
      actor: { id: username, name: user?.displayName || (requestUser?.username === username ? requestUser.displayName : username) },
    };
  };

  const { compileProject, ensureLatestPdf } = createCompileService({
    stateDir,
    database,
    queue: compileQueue,
    logger,
    serverOptions: options,
    assertWritable: assertProjectWritable,
  });

  async function withAgentHistory<T>(request: Request, runtime: ProjectRuntime, label: string, task: () => Promise<T> | T, always = false): Promise<T> {
    if (!always && typeof request.query.access !== "string" && typeof request.query.agentId !== "string") return task();
    return withGitReader(runtime, () => withGitOperation(runtime, async () => {
      await gitCheckpoint(runtime, "Before agent edit");
      const result = await task();
      runtime.collaboration.flush();
      const agent = request.body?.agent;
      const proposal = Boolean(findProposalShare(runtime, request.query.access));
      await gitCheckpoint(runtime, label, { kind: "agent", main: runtime.build.main,
        agentName: String(request.query.agentName || agent?.name || "Coding agent").slice(0, 100),
        agentId: String(request.query.agentId || agent?.id || "").slice(0, 100),
        mode: proposal ? "suggesting" : String(request.query.mode || request.body?.mode || (request.path === "/v1/files/patch" ? "suggesting" : "direct")) });
      return result;
    }));
  }

  const expressModule = await import("express");
  const express = expressModule.default;
  const app = express();
  const projectEvents = new Map<string, Set<Response>>();
  function notifyProjectFiles(projectId: string): void {
    for (const response of projectEvents.get(projectId) || []) response.write("event: files\ndata: {}\n\n");
  }
  const streamProjectEvents = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = await resolveProject(request);
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();
      const listeners = projectEvents.get(runtime.id) || new Set<Response>();
      projectEvents.set(runtime.id, listeners);
      listeners.add(response);
      // Refresh on reconnect too, including changes missed while offline.
      response.write("event: files\ndata: {}\n\n");
      const heartbeat = setInterval(() => {
        try { requireProjectAccess(request, runtime); response.write(": heartbeat\n\n"); }
        catch { response.end(); }
      }, 15_000);
      response.on("close", () => {
        clearInterval(heartbeat);
        listeners.delete(response);
        if (!listeners.size) projectEvents.delete(runtime.id);
      });
    } catch (error) { next(error); }
  };
  app.disable("x-powered-by");
  app.use(requestLogger(logger));
  app.use((request, response, next) => {
    const changesFiles = request.path.startsWith("/v1/files")
      || request.path === "/v1/trash/restore" || request.path === "/v1/search/replace";
    if (changesFiles && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      response.on("finish", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          void resolveProject(request).then(runtime => autoCheckpoints.get(runtime.id)?.changed()).catch(() => {});
        }
      });
    }
    next();
  });
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    );
    if (
      request.path.startsWith("/v1/auth")
      || request.path.startsWith("/v1/invitations")
      || request.path === "/v1/project/share"
      || request.path.startsWith("/share/")
      || request.path.startsWith("/agent/")
      || request.query?.access
    ) response.setHeader("Cache-Control", "no-store");
    next();
  });
  const readiness = () => {
    const queue = compileQueue.stats();
    const databaseReady = database.ping();
    return {
      ok: databaseReady && queue.accepting,
      status: databaseReady && queue.accepting ? "ready" : "not_ready",
      name: "latexcoder",
      schemaVersion: database.schemaVersion(),
      queue,
      dependencies,
    };
  };
  registerPublicRoutes(app, {
    agentProjectManual, appDir: APP_DIR, currentUser, database,
    findEditShare: findProjectShare, findProposalShare, findViewShare,
    issueProjectSession, loadProject, manual, readiness, streamProjectEvents,
  });
  registerAuthRoutes(app, {
    database, currentUser, issueUserSession, json: express.json, loginAttempts,
    requireUser, userSession, invitationSeconds: INVITATION_SECONDS,
  });
  registerAdminRoutes(app, { database, deleteProject, json: express.json, loadProject, requireAdmin });
  registerProjectRoutes(app, {
    assertProjectWritable, cleanProjectName, cleanProjectTags, createProject,
    createProjectArchive, database, deleteProject, isProjectOwner,
    json: express.json, loadProject, memberProjectShare, membershipAccessMode,
    projectAccessMode, projectMembership, projectSummaries, publicProjectMetadata,
    raw: express.raw, requireProjectMember, requireProjectOwner, requireUser,
    resolveProject, rotateShare, withGitReader,
  });
  registerHistoryRoutes(app, {
    database, git, gitCheckpoint, importGitWorktree, json: express.json,
    notifyProjectFiles, resolveProject, trackedPaths, withGitOperation,
    withGitReader, withTemporaryWorktree,
  });
  registerGitRoutes(app, {
    gitCheckpoint, gitReceivePack, gitResolve, gitStatus, gitSync, gitUploadPack,
    json: express.json, notifyProjectFiles, prepareGitPull, raw: express.raw,
    resolveGitProject, resolveGitPushProject, resolveProject, withGitOperation,
    withGitReader, withLiveGitOperation,
  });
  registerSearchRoutes(app, { assertProjectWritable, json: express.json, options, projectSearch, resolveProject });
  registerFileRoutes(app, {
    assertProjectWritable, database, gitAuthorForCommit, gitCheckpoint,
    isProposalAccess, json: express.json, raw: express.raw, requestBlameActor,
    resolveProject, withAgentHistory, withGitOperation, withGitReader,
  });
  registerBuildRoutes(app, { compileProject, database, ensureLatestPdf, json: express.json, options, resolveProject });

  app.use(express.static(path.join(APP_DIR, "dist"), { index: false, maxAge: "1y", immutable: true }));
  app.use((request, _response, next) => next(apiError("route_not_found", `route ${request.method} ${request.path} does not exist`, 404)));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const failure = error && typeof error === "object"
      ? error as { status?: number; type?: string; code?: string; message?: string; details?: Record<string, unknown> }
      : {};
    const status = Number.isInteger(failure.status) ? failure.status! : 500;
    const parseError = failure.type === "entity.parse.failed";
    const code = parseError ? "invalid_json" : (failure.code && typeof failure.code === "string" ? failure.code : "internal_error");
    const message = parseError ? "request body must contain valid JSON" : (status >= 500 ? "internal server error" : failure.message || "request failed");
    if (status >= 500) logger.error("http.error", error, { status });
    const body: { error: { code: string; message: string; details?: Record<string, unknown> } } = { error: { code, message } };
    if (status < 500 && failure.details) body.error.details = failure.details;
    response.status(parseError ? 400 : status).json(body);
  });

  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_TEXT_BYTES });
  server.on("upgrade", (request, socket, head) => {
    (async () => {
      const url = new URL(request.url, "http://paper.internal");
      const prefix = "/v1/collab/";
      if (!url.pathname.startsWith(prefix)) throw apiError("route_not_found", "websocket route not found", 404);
      const parts = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent);
      const scoped = parts.length > 1;
      const runtime = await loadProject(scoped ? parts[0] : await defaultProjectForRequest(request));
      requireProjectAccess(request, runtime);
      const accessMode = projectAccessMode(request, runtime)!;
      const shareId = projectAccessShareId(request, runtime);
      const relativePath = pathFromRoomName(scoped ? parts[1] : parts[0]);
      const requestedId = url.searchParams.get("authorId")?.trim().slice(0, 100) || "";
      const requestedName = url.searchParams.get("authorName")?.trim().slice(0, 100) || "";
      const user = currentUser(request);
      const actor: BlameActor = requestedId || requestedName
        ? { id: requestedId || requestedName, name: requestedName || requestedId }
        : user ? { id: user.username, name: user.displayName } : { id: "guest", name: "Guest" };
      sockets.handleUpgrade(request, socket, head, connection => runtime.collaboration.attach(connection, relativePath, shareId, url.searchParams.get("saved") === "1", accessMode === "view", actor));
    })().catch(() => {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
  });

  const defaultRuntime = defaultProjectId ? await loadProject(defaultProjectId) : null;
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    for (const checkpoint of autoCheckpoints.values()) checkpoint.close();
    for (const listeners of projectEvents.values()) for (const response of listeners) response.end();
    compileQueue.close();
    for (const runtime of projects.values()) runtime.collaboration.shutdown();
    database.close();
    closed = true;
  };
  return {
    app, server, sockets, stateDir, projectsDir, projects, database, shutdown,
    // Kept for API consumers of the original single-project server.
    projectDir: defaultRuntime?.projectDir,
    collaboration: defaultRuntime?.collaboration,
  };
}

export async function startPaperServer(options: ServerOptions = {}): Promise<PaperServer> {
  const paper = await createPaperServer({ ...options, logRequests: options.logRequests ?? true });
  const host = options.host || process.env.LATEXCODER_HOST || "0.0.0.0";
  const port = Number(options.port || process.env.LATEXCODER_PORT || process.env.PORT || 8090);
  await new Promise<void>((resolve, reject) => {
    paper.server.once("error", reject);
    paper.server.listen(port, host, () => resolve());
  });
  const address = paper.server.address();
  console.log(`LaTeX Coder listening on http://${host}:${typeof address === "object" && address ? address.port : port}`);
  return paper;
}
