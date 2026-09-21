import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import { StateDatabase } from "./database.ts";
import { parseReviews } from "../shared/review.ts";
import { projectedPosition } from "../shared/source-map.ts";
import { syncTexPositions } from "../shared/pdf-map.ts";
import { buildDiagnostics, compileErrors } from "../shared/compile-errors.ts";
import { createPatch } from "diff";
import { apiError, cleanDisplayName, cleanUsername, contentPath, isTextFile, isWellFormedUtf16, MAX_FILE_BYTES, MAX_TEXT_BYTES, parseCookies, passwordMatches, passwordRecord, pathFromRoomName, randomToken, readProjectZip, safeRelativePath, sessionCookie, sha256, validatePassword } from "./core.ts";
import { checkedContentTarget, compilationSourceRevision, contentEntries, listFiles, listFolders } from "./project-files.ts";
import { run, runBinary, runRipgrep, validatedSearchOptions, validatedSearchPaths } from "./process.ts";
import { createCollaborationStore } from "./collaboration.ts";
import { historyCommit, historyRevision, listVersions, versionDiff, versionFiles, versionInfo, versionMessage, versionStructure } from "./version-history.ts";
import { createAutoCheckpoint } from "./auto-checkpoint.ts";
import type { AutoCheckpoint } from "./auto-checkpoint.ts";
import { createProjectSearch } from "./search.ts";
import { CompileQueue } from "./compile-queue.ts";
import { createCompileService } from "./compile-service.ts";
import { checkDependencies } from "./dependencies.ts";
import { createLogger, requestLogger } from "./logger.ts";
import { compileRequestSchema, createProjectRequestSchema, loginRequestSchema, registerRequestSchema, settingsRequestSchema, updateProfileRequestSchema, updateProjectRequestSchema } from "../shared/api-schema.ts";
import type { ZodType } from "zod";
import type { NextFunction, Request, Response } from "express";
import type { ProjectMetadata } from "./database.ts";
import type { ImportedProjectFile, PaperServer, ProjectFile, ProjectRuntime, ServerOptions } from "./types.ts";

type GitRunOptions = { env?: NodeJS.ProcessEnv; allowedCodes?: number[]; code?: string; status?: number };
type AuthenticatedUser = { username: string; displayName: string };
type CookieSession = { key: string; token: string };
type CookieRequest = { headers: { cookie?: string } };
type ProjectAccessRequest = CookieRequest & { query?: { access?: unknown } };
type SharePaths = { id: string; path: string; agentPath: string; clonePath: string };
export { safeRelativePath } from "./core.ts";

function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw apiError("invalid_request", "request body is invalid", 400, {
    issues: result.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })),
  });
}

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
  await git(runtime.projectDir, ["add", "-A"]);
  const changed = await git(runtime.projectDir, ["diff", "--cached", "--quiet"], { allowedCodes: [0, 1] });
  const folders = await listFolders(runtime.projectDir);
  const previous = await versionInfo(runtime.projectDir, await gitHead(runtime.projectDir));
  const mainChanged = previous.metadata ? previous.metadata.main !== runtime.build.main : runtime.build.main !== "main.tex";
  const foldersChanged = JSON.stringify(previous.metadata?.folders || []) !== JSON.stringify(folders);
  const created = changed.code === 1 || mainChanged || foldersChanged;
  if (created) await git(runtime.projectDir, ["commit", "--allow-empty", "-m", versionMessage(cleanCommitMessage(message), { ...(metadata ?? { kind: "checkpoint", main: runtime.build.main }), folders })]);
  return { commit: await gitHead(runtime.projectDir), created };
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

async function importGitWorktree(runtime: ProjectRuntime, sourceDir: string, main = runtime.build.main, validateReviews = true): Promise<void> {
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
      runtime.collaboration.importText(relativePath, content);
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

async function gitSyncLocked(runtime: ProjectRuntime, requestedRef: string) {
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
        await importGitWorktree(runtime, worktree);
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

async function syncGitIngress(runtime: ProjectRuntime): Promise<{ ingressDir: string; head: string }> {
  const ingressDir = path.join(runtime.projectRoot, "receive.git");
  if (!existsSync(ingressDir)) await git(runtime.projectDir, ["init", "--bare", ingressDir]);
  const head = await gitHead(runtime.projectDir);
  await git(ingressDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(ingressDir, ["fetch", "--no-tags", runtime.projectDir, `+${head}:refs/heads/main`]);
  return { ingressDir, head };
}

async function gitReceivePack(runtime: ProjectRuntime, args: string[], input: Uint8Array, protocol?: string) {
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
    const sync = await gitSyncLocked(runtime, incomingRef);
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
\`POST /v1/auth/login\`. \`POST /v1/invitations\` creates a single-use,
seven-day registration link; invited users register through
\`POST /v1/auth/register\`.

Member authentication is required for \`GET /v1/projects\` and project creation.
The list contains projects owned by or shared with the current member.
\`POST /v1/projects\` with \`{"name":"My paper"}\` creates an owned project.
Only its owner can rename or delete it. Rename or delete one with
\`PATCH /v1/projects/:id\` and \`DELETE /v1/projects/:id\`.

Every project-specific request below accepts \`?project=<id>\`. If omitted,
the first accessible project is used.

Browser routes \`/projects\` and \`/projects/:id\` provide the member dashboard
and clean editor URLs. A guest first opens \`/share/<project-id>/<secret>\` to
establish a project-scoped session. That session authorizes only the selected
project and does not expose the owner's dashboard. Signing in alone never grants
access to another member's projects. A signed-in user who opens a valid share
link joins as a persistent registered collaborator. Each registered member gets
a different personal secret from \`POST /v1/project/share?project=<id>\`;
rotating it does not revoke another member's links or project membership.

Each project's source directory is an independent Git repository whose live
working tree always remains on \`main\`. \`GET /v1/git\` returns status and
history. \`POST /v1/git/commit\` creates a collaborative checkpoint.
Edits are checkpointed automatically after 30 idle seconds, or every five
minutes during continuous editing, without disconnecting collaborators.
Clone and fetch checkpoint current Yjs content before advertising refs.
Each registered collaborator gets a personal smart HTTP URL at
\`/git/<project-id>/<share-secret>\`. Clone it and push \`main\` normally; no
upstream configuration is required. A push checkpoints current Yjs changes and
automatically merges the incoming commit into the live document. Conflicts are
quarantined on \`conflict/<UTC timestamp>\`; Yjs and main remain unchanged.
After resolving the content on main, \`POST /v1/git/resolve\` records the
two-parent merge commit.

\`GET /v1/project/archive?project=<id>\` downloads the current working tree as
a ZIP, including uncommitted files.

## Inspect

\`GET /v1/project\` lists project files and the latest build.

\`GET /v1/files?path=main.tex\` reads a file as bytes.
The response includes the current \`X-Content-SHA256\` revision.

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

function agentProjectManual(runtime: ProjectRuntime, files: ProjectFile[], shareToken: string, origin: string): string {
  const capability = new URLSearchParams({ project: runtime.id, access: shareToken });
  const fileUrl = (relativePath: string): string => `/v1/files?${capability}&path=${encodeURIComponent(relativePath)}`;
  const editUrl = (relativePath: string): string => `/v1/files/edit?${capability}&path=${encodeURIComponent(relativePath)}`;
  const projectUrl = `/v1/project?${capability}`;
  const searchUrl = `/v1/search?${capability}`;
  const pdfUrl = `/v1/build/pdf?${capability}`;
  const gitUrl = (endpoint: string): string => `/v1/git${endpoint}?${capability}`;
  const cloneUrl = `${origin}/git/${encodeURIComponent(runtime.id)}/${encodeURIComponent(shareToken)}`;
  const main = runtime.build.main || "main.tex";
  const fileList = files.map(file => `- ${JSON.stringify(file.path)}${file.text ? " (text)" : " (binary)"}`).join("\n");
  return `# ${runtime.metadata.name}

This is the plain-text Agent workspace for project ${runtime.id}. The secret in
this URL grants edit access to this project. Keep it private.

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

Uploads are direct edits by default. To create reviewable suggestions, append
&mode=suggesting&agentId=ag_uniqueid&agentName=Agent%20Name to the upload URL.
The response returns the resulting file hash and generated suggestion IDs.
Suggestion uploads may not overlap existing open reviews.

## Reply To An Inline Comment

Comments are stored as:

\\cmtbg{thread-id}{Author}selected text\\cmted{initial comment}

To reply, edit the downloaded file to append this immediately before the final
closing brace of that comment's \\cmted argument:

\\cmtrpl{unique-reply-id}{Agent Name}{Reply text}

Keep the existing comment and replies intact unless the user explicitly asks
to resolve or rewrite them. Upload the updated file with its original base hash.

## Create A File

PUT ${fileUrl(main)}
Content-Type: text/plain; charset=utf-8

Use PUT only for new files or binary uploads. For existing text files, use the
checked full-file upload above; do not use an unchecked PUT to bypass a conflict.

## Persistent edit history

Every successful checked edit automatically saves a before/after version. The
response's edit.version identifies your change. Pass agentId and agentName query
parameters even in direct mode so the History view can identify your edits.
GET /v1/history?${capability}&agent=1 lists agent edits; GET
/v1/history/VERSION?${capability} lists changed files, and adding &path=FILE shows
added/deleted lines. These safety versions are automatic, no Git command needed.

## Git (Only When The User Explicitly Requests It)

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
checkpointed automatically, and clone/fetch checkpoint current Yjs content
before advertising refs. Use the checked full-file upload unless the user specifically asks for a
Git workflow.
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
    if (authDisabled) return { username: "test-user", displayName: "Test User" };
    const session = userSession(request);
    if (!session) return null;
    const user = database.getUser(session.record.username);
    return user ? { username: user.username, displayName: user.displayName } : null;
  }

  function requireUser(request: CookieRequest): AuthenticatedUser {
    const user = currentUser(request);
    if (!user) throw apiError("authentication_required", "sign in to continue", 401);
    return user;
  }

  function isProjectOwner(request: CookieRequest, runtime: ProjectRuntime): boolean {
    return currentUser(request)?.username === runtime.metadata.ownerUsername;
  }

  function projectMembership(request: CookieRequest, runtime: ProjectRuntime) {
    const user = currentUser(request);
    return user ? database.getProjectMember(runtime.id, user.username) : null;
  }

  function hasProjectAccess(request: ProjectAccessRequest, runtime: ProjectRuntime): boolean {
    if (projectMembership(request, runtime)) return true;
    const session = projectSession(request);
    if (session?.record.projects.has(runtime.id)) return true;
    return Boolean(findProjectShare(runtime, request.query?.access));
  }

  function projectAccessShareId(request: ProjectAccessRequest, runtime: ProjectRuntime): string | null {
    if (projectMembership(request, runtime)) return null;
    const session = projectSession(request);
    if (session?.record.projects.has(runtime.id)) return session.record.shares.get(runtime.id) || null;
    return findProjectShare(runtime, request.query?.access)?.id || null;
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

  function issueProjectSession(request: Request, response: Response, projectId: string, shareId: string | null): void {
    const existing = projectSession(request);
    const token = existing?.token || randomToken();
    database.addProjectSession(sha256(token), projectId, shareId, Date.now() + PROJECT_SESSION_SECONDS * 1000);
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

  function sharePaths(runtime: ProjectRuntime, shareId: string, shareToken: string): SharePaths {
    return {
      id: shareId,
      path: `/share/${encodeURIComponent(runtime.id)}/${shareToken}`,
      agentPath: `/agent/${encodeURIComponent(runtime.id)}/${shareToken}`,
      clonePath: `/git/${encodeURIComponent(runtime.id)}/${shareToken}`,
    };
  }

  function memberProjectShare(runtime: ProjectRuntime, username: string): SharePaths {
    const existing = database.getProjectShareForUser(runtime.id, username);
    if (existing) return sharePaths(runtime, existing.id, existing.token);
    const id = randomProjectId();
    const token = randomToken();
    database.createProjectShare(runtime.id, id, username, token, sha256(token), Date.now());
    return sharePaths(runtime, id, token);
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
    const summaries: Array<ReturnType<typeof publicProjectMetadata> & { build: { status: string; pdf: boolean }; membership: string; permissions: { manage: boolean } }> = [];
    const records = username ? database.listProjectsForUser(username) : database.listProjects();
    for (const metadata of records) {
      const runtime = await loadProject(metadata.id);
      summaries.push({
        ...publicProjectMetadata(runtime.metadata),
        build: { status: runtime.build.status, pdf: runtime.build.pdf },
        membership: metadata.membershipRole || "owner",
        permissions: { manage: (metadata.membershipRole || "owner") === "owner" },
      });
    }
    return summaries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async function createProject(name: unknown, ownerUsername: string | null, importedFiles: ImportedProjectFile[] = []): Promise<ProjectRuntime> {
    const projectName = cleanProjectName(name);
    let id = randomProjectId();
    while (database.getProject(id) || existsSync(path.join(projectsDir, id))) id = randomProjectId();
    const projectRoot = path.join(projectsDir, id);
    const metadata: ProjectMetadata = { id, name: projectName, ownerUsername, createdAt: new Date().toISOString(), shareToken: randomToken() };
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
    return runtime;
  };
  const resolveGitProject = async (request: Request): Promise<ProjectRuntime> => {
    const runtime = await loadProject(request.params.projectId);
    if (hasProjectAccess(request, runtime)) return runtime;
    if (!findProjectShare(runtime, request.params.shareToken)) throw apiError("project_access_required", "Git clone URL is invalid", 401);
    return runtime;
  };
  const resolveGitPushProject = async (request: Request): Promise<ProjectRuntime> => {
    const runtime = await loadProject(request.params.projectId);
    const share = findProjectShare(runtime, request.params.shareToken);
    if (!share?.username || !database.getProjectMember(runtime.id, share.username)) {
      throw apiError("project_access_required", "a registered member's personal Git URL is required for push", 401);
    }
    return runtime;
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
      await gitCheckpoint(runtime, label, { kind: "agent", main: runtime.build.main,
        agentName: String(request.query.agentName || agent?.name || "Coding agent").slice(0, 100),
        agentId: String(request.query.agentId || agent?.id || "").slice(0, 100),
        mode: String(request.query.mode || request.body?.mode || (request.path === "/v1/files/patch" ? "suggesting" : "direct")) });
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
  app.get("/v1/project/events", streamProjectEvents);
  app.get("/", (request, response) => {
    response.setHeader("Vary", "Accept, User-Agent");
    const accepted = String(request.get("accept") || "")
      .split(",")
      .map((entry, order) => {
        const [mediaType, ...parameters] = entry.trim().toLowerCase().split(";");
        const quality = parameters.reduce((value, parameter) => {
          const match = parameter.trim().match(/^q=(0(?:\.\d+)?|1(?:\.0+)?)$/);
          return match ? Number(match[1]) : value;
        }, 1);
        return { mediaType, quality, order };
      })
      .filter(entry => entry.mediaType === "text/html" || entry.mediaType === "text/markdown")
      .sort((left, right) => right.quality - left.quality || left.order - right.order);
    const representation = accepted[0]?.mediaType
      || (/Mozilla\//i.test(request.get("user-agent") || "") ? "text/html" : "text/markdown");
    if (representation === "text/html") {
      response.setHeader("Cache-Control", "no-store");
      return response.sendFile(path.join(APP_DIR, "dist", "index.html"));
    }
    return response.type("text/markdown; charset=utf-8").send(manual());
  });
  app.get(["/login", "/projects", "/projects/:projectId", "/register/:token"], (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(path.join(APP_DIR, "dist", "index.html"));
  });
  app.get("/share/:projectId/:token", async (request, response, next) => {
    try {
      const runtime = await loadProject(request.params.projectId);
      const share = findProjectShare(runtime, request.params.token);
      if (!share) throw apiError("share_link_invalid", "project share link is invalid", 403);
      const user = currentUser(request);
      if (user) database.addProjectMember(runtime.id, user.username);
      else issueProjectSession(request, response, runtime.id, share.id);
      response.redirect(303, `/projects/${encodeURIComponent(runtime.id)}`);
    } catch (error) { next(error); }
  });
  app.get("/agent/:projectId/:token", async (request, response, next) => {
    try {
      const runtime = await loadProject(request.params.projectId);
      if (!findProjectShare(runtime, request.params.token)) throw apiError("agent_link_invalid", "Agent link is invalid", 403);
      response.setHeader("Cache-Control", "no-store");
      response.type("text/plain; charset=utf-8").send(agentProjectManual(
        runtime,
        await listFiles(runtime.projectDir),
        request.params.token,
        `${request.protocol}://${request.get("host")}`,
      ));
    } catch (error) { next(error); }
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
  app.get("/health/live", (_request, response) => response.json({ ok: true, status: "live", name: "latexcoder" }));
  app.get(["/health", "/health/ready"], (_request, response) => {
    const health = readiness();
    response.status(health.ok ? 200 : 503).json(health);
  });
  app.get("/v1/auth/me", (request, response) => {
    response.json({
      user: currentUser(request),
      invitationOnly: true,
      bootstrapReady: database.countUsers() > 0,
    });
  });
  app.post("/v1/auth/login", express.json({ limit: "16kb" }), (request, response, next) => {
    try {
      const body = parseBody(loginRequestSchema, request.body);
      const attemptKey = request.ip || request.socket.remoteAddress || "unknown";
      let attempts = loginAttempts.get(attemptKey);
      if (!attempts || attempts.resetAt <= Date.now()) {
        attempts = { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
        loginAttempts.set(attemptKey, attempts);
      }
      if (attempts.count >= 10) throw apiError("login_rate_limited", "too many login attempts; try again later", 429);
      const username = cleanUsername(body.username);
      const user = database.getUser(username);
      if (!user || !passwordMatches(body.password, user)) {
        attempts.count += 1;
        throw apiError("invalid_credentials", "username or password is incorrect", 401);
      }
      loginAttempts.delete(attemptKey);
      issueUserSession(request, response, username);
      response.json({ user: { username, displayName: user.displayName } });
    } catch (error) { next(error); }
  });
  app.post("/v1/auth/logout", (request, response) => {
    const session = userSession(request);
    if (session) database.deleteUserSession(session.key);
    response.append("Set-Cookie", sessionCookie(request, "lc_user", "", 0));
    response.json({ user: null });
  });
  app.patch("/v1/users/me", express.json({ limit: "16kb" }), (request, response, next) => {
    try {
      const user = requireUser(request);
      const displayName = cleanDisplayName(parseBody(updateProfileRequestSchema, request.body).displayName);
      if (!database.updateUserDisplayName(user.username, displayName)) throw apiError("user_not_found", "user does not exist", 404);
      response.json({ user: { username: user.username, displayName } });
    } catch (error) { next(error); }
  });
  app.get("/v1/invitations/:token", (request, response, next) => {
    try {
      const invitation = database.getInvitation(sha256(String(request.params.token || "")));
      const valid = invitation && !invitation.usedAt && invitation.expiresAt > Date.now();
      if (!valid) throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
      response.json({ invitation: { invitedBy: invitation.createdBy, expiresAt: new Date(invitation.expiresAt).toISOString() } });
    } catch (error) { next(error); }
  });
  app.post("/v1/invitations", (request, response, next) => {
    try {
      const user = requireUser(request);
      const token = randomToken();
      const createdAt = new Date();
      database.createInvitation({
        tokenHash: sha256(token),
        createdBy: user.username,
        createdAt: createdAt.toISOString(),
        expiresAt: createdAt.getTime() + INVITATION_SECONDS * 1000,
      });
      response.status(201).json({ invitation: { token, path: `/register/${token}` } });
    } catch (error) { next(error); }
  });
  app.post("/v1/auth/register", express.json({ limit: "16kb" }), (request, response, next) => {
    try {
      const body = parseBody(registerRequestSchema, request.body);
      const token = body.token;
      const tokenHash = sha256(token);
      const invitation = database.getInvitation(tokenHash);
      if (!invitation || invitation.usedAt || invitation.expiresAt <= Date.now()) {
        throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
      }
      const username = cleanUsername(body.username);
      if (database.getUser(username)) throw apiError("username_taken", "username is already registered", 409);
      const password = validatePassword(body.password);
      const createdAt = new Date().toISOString();
      database.transaction(() => {
        const current = database.getInvitation(tokenHash);
        if (!current || current.usedAt || current.expiresAt <= Date.now()) {
          throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
        }
        database.createUser({ username, displayName: username, ...passwordRecord(password), createdAt, invitedBy: current.createdBy });
        if (!database.consumeInvitation(tokenHash, username, createdAt)) {
          throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
        }
      });
      issueUserSession(request, response, username);
      response.status(201).json({ user: { username, displayName: username } });
    } catch (error) { next(error); }
  });
  app.get("/v1/projects", async (request, response, next) => {
    try {
      const user = requireUser(request);
      const accessible = await projectSummaries(user.username);
      response.json({ projects: accessible, defaultProjectId: accessible[0]?.id || null });
    }
    catch (error) { next(error); }
  });
  app.post("/v1/projects", express.json({ limit: "16kb" }), express.raw({ type: "application/zip", limit: "20mb" }), async (request, response, next) => {
    try {
      const user = requireUser(request);
      const importedFiles = request.is("application/zip") ? readProjectZip(request.body) : [];
      const name = request.is("application/zip") ? request.query.name : parseBody(createProjectRequestSchema, request.body).name;
      const runtime = await createProject(name, user.username, importedFiles);
      response.status(201).json({ project: { ...publicProjectMetadata(runtime.metadata), build: runtime.build } });
    } catch (error) { next(error); }
  });
  app.patch("/v1/projects/:projectId", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await loadProject(request.params.projectId);
      requireProjectOwner(request, runtime);
      runtime.metadata = { ...runtime.metadata, name: cleanProjectName(parseBody(updateProjectRequestSchema, request.body).name) };
      database.saveProject(runtime.metadata);
      response.json({ project: publicProjectMetadata(runtime.metadata) });
    } catch (error) { next(error); }
  });
  app.delete("/v1/projects/:projectId", async (request, response, next) => {
    try {
      const runtime = await loadProject(request.params.projectId);
      requireProjectOwner(request, runtime);
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
      response.json({ deleted: { id: runtime.id }, defaultProjectId: remaining[0]?.id || null });
    } catch (error) { next(error); }
  });
  app.get("/v1/project", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      response.json({ project: {
        ...publicProjectMetadata(runtime.metadata),
        main: runtime.build.main,
        files: await listFiles(runtime.projectDir),
        folders: await listFolders(runtime.projectDir),
        settings: database.getSettings(runtime.id),
        build: runtime.build,
        permissions: { manage: isProjectOwner(request, runtime), collaborate: Boolean(projectMembership(request, runtime)) },
      } });
    } catch (error) { next(error); }
  });
  app.get("/v1/settings", async (request, response, next) => {
    try { response.json({ settings: database.getSettings((await resolveProject(request)).id) }); }
    catch (error) { next(error); }
  });
  app.patch("/v1/settings", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      if (runtime.compilePromise) throw apiError("compile_running", "Wait for compilation before changing settings", 409);
      const body = parseBody(settingsRequestSchema, request.body);
      const main = contentPath(body.main);
      const { compiler, autoCompile } = body;
      if (!main.endsWith(".tex") || !existsSync(path.join(runtime.projectDir, main))) throw apiError("invalid_main", "Select an existing .tex file");
      if (!["auto", "tectonic", "latexmk"].includes(compiler) || typeof autoCompile !== "boolean") throw apiError("invalid_settings", "Invalid compiler or automatic compilation setting");
      database.saveSettings(runtime.id, { compiler, autoCompile });
      runtime.build.main = main;
      database.saveBuild(runtime.id, runtime.build);
      response.json({ settings: database.getSettings(runtime.id) });
    } catch (error) { next(error); }
  });
  app.get("/v1/reviews", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const files = await listFiles(runtime.projectDir);
      response.setHeader("Cache-Control", "no-store");
      response.json({ files: files.filter(file => file.text).map(file => ({
        path: file.path,
        reviews: parseReviews(runtime.collaboration.readText(file.path)),
      })) });
    } catch (error) { next(error); }
  });
  app.post("/v1/project/share", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const user = requireUser(request);
      requireProjectMember(request, runtime);
      response.json({ share: memberProjectShare(runtime, user.username) });
    } catch (error) { next(error); }
  });
  app.post("/v1/project/share/rotate", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const user = requireUser(request);
      requireProjectMember(request, runtime);
      const current = database.getProjectShareForUser(runtime.id, user.username);
      if (!current) throw apiError("share_not_found", "create your project access secret first", 404);
      const shareToken = randomToken();
      if (!database.rotateProjectShare(runtime.id, user.username, shareToken, sha256(shareToken))) {
        throw apiError("share_not_found", "project access grant does not exist", 404);
      }
      runtime.collaboration.disconnectShare(current.id, "project access secret changed");
      response.json({ share: sharePaths(runtime, current.id, shareToken) });
    } catch (error) { next(error); }
  });
  app.get("/v1/project/members", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      requireProjectMember(request, runtime);
      response.json({ members: database.listProjectMembers(runtime.id) });
    } catch (error) { next(error); }
  });
  app.get("/v1/project/archive", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const { archive, temporary } = await withGitReader(runtime, () => createProjectArchive(runtime));
      response.download(archive, `${runtime.id}.zip`, async error => {
        await rm(temporary, { recursive: true, force: true });
        if (error && !response.headersSent) next(error);
      });
    } catch (error) { next(error); }
  });
  app.get("/v1/history", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      response.setHeader("Cache-Control", "no-store");
      response.json(await withGitReader(runtime, () => listVersions(runtime.projectDir, request.query.before, request.query.agent === "1")));
    } catch (error) { next(error); }
  });
  app.get("/v1/history/:version", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const result = await withGitReader(runtime, async () => {
        const id = await historyCommit(runtime.projectDir, request.params.version);
        if (request.query.path !== undefined) return versionDiff(runtime.projectDir, id, request.query.path);
        runtime.collaboration.flush();
        return { version: await versionInfo(runtime.projectDir, id), files: await versionFiles(runtime.projectDir, id), structure: await versionStructure(runtime.projectDir, id),
          currentRevision: await historyRevision(runtime.projectDir, runtime.build.main) };
      });
      response.setHeader("Cache-Control", "no-store");
      response.json(result);
    } catch (error) { next(error); }
  });
  app.post("/v1/history/:version/restore", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const result = await withGitReader(runtime, () => withGitOperation(runtime, async () => {
        const id = await historyCommit(runtime.projectDir, request.params.version);
        const currentRevision = await historyRevision(runtime.projectDir, runtime.build.main);
        if (request.body?.currentRevision !== currentRevision) throw apiError("stale_restore", "The project changed. Refresh the version preview before restoring.", 409);
        const selectedPath = request.body?.path === undefined ? null : safeRelativePath(request.body.path);
        if (selectedPath && !(await versionFiles(runtime.projectDir, id)).some(file => file.path === selectedPath)) throw apiError("version_file_missing", "This file did not change in this version", 404);
        const previousFolders = await listFolders(runtime.projectDir);
        const info = await versionInfo(runtime.projectDir, id);
        const backup = await gitCheckpoint(runtime, "Before restoring " + id.slice(0, 7));
        const previousMain = runtime.build.main;
        try {
          await withTemporaryWorktree(runtime, id, async directory => {
            const paths = await trackedPaths(directory);
            const main = info.metadata?.main || (paths.includes(previousMain) ? previousMain : paths.includes("main.tex") ? "main.tex" : "");
            if (!main && !selectedPath) throw apiError("restore_main_missing", "This old version does not identify its main document", 409);
            if (selectedPath) {
              await withTemporaryWorktree(runtime, backup.commit, async combined => {
                const source = path.join(directory, selectedPath), target = path.join(combined, selectedPath);
                if (paths.includes(selectedPath)) {
                  const details = await lstat(source);
                  if (!details.isFile()) throw apiError("git_file_unsupported", "Cannot restore a symbolic link", 409);
                  await mkdir(path.dirname(target), { recursive: true });
                  await cp(source, target);
                } else await rm(target, { force: true });
                if (existsSync(target) || (await trackedPaths(combined)).includes(selectedPath)) await git(combined, ["--literal-pathspecs", "add", "-A", "--", selectedPath]);
                await importGitWorktree(runtime, combined, previousMain, false);
              });
            } else {
              await importGitWorktree(runtime, directory, main, false);
              runtime.build.main = main;
              for (const folder of (await listFolders(runtime.projectDir)).sort((a, b) => b.length - a.length)) {
                if (!info.metadata?.folders?.includes(folder)) await rmdir(path.join(runtime.projectDir, folder)).catch(error => { if (error.code !== "ENOTEMPTY") throw error; });
              }
              for (const folder of info.metadata?.folders || []) await mkdir(path.join(runtime.projectDir, safeRelativePath(folder)), { recursive: true });
            }
          });
          const restored = await gitCheckpoint(runtime, (selectedPath ? `Restore ${selectedPath} from ` : "Restore version ") + id.slice(0, 7), { kind: "restore", main: runtime.build.main, restoredFrom: id });
          database.saveBuild(runtime.id, runtime.build);
          return { ...restored, backup: backup.commit };
        } catch (error) {
          runtime.build.main = previousMain;
          await git(runtime.projectDir, ["add", "-A"]);
          await withTemporaryWorktree(runtime, backup.commit, directory => importGitWorktree(runtime, directory, previousMain, false));
          for (const folder of previousFolders) await mkdir(path.join(runtime.projectDir, folder), { recursive: true });
          throw error;
        }
      }));
      notifyProjectFiles(runtime.id);
      response.json(result);
    } catch (error) { next(error); }
  });
  app.get("/v1/git", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      response.json({ git: await withGitReader(runtime, () => gitStatus(runtime)) });
    }
    catch (error) { next(error); }
  });
  app.post("/v1/git/commit", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const payload = await withGitReader(runtime, async () => {
        const result = await withLiveGitOperation(runtime, () => gitCheckpoint(runtime, request.body?.message));
        return { ...result, status: await gitStatus(runtime) };
      });
      response.json({ git: payload });
    } catch (error) { next(error); }
  });
  app.post("/v1/git/sync", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const payload = await withGitReader(runtime, async () => {
        const result = await gitSync(runtime, request.body?.ref);
        return { ...result, current: await gitStatus(runtime) };
      });
      response.json({ git: payload });
    } catch (error) { next(error); }
  });
  app.post("/v1/git/resolve", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const payload = await withGitReader(runtime, async () => {
        const result = await gitResolve(runtime, request.body?.message);
        return { ...result, current: await gitStatus(runtime) };
      });
      response.json({ git: payload });
    } catch (error) { next(error); }
  });
  app.get(["/git/:projectId/info/refs", "/git/:projectId/:shareToken/info/refs"], async (request, response, next) => {
    try {
      const service = request.query.service;
      if (service !== "git-upload-pack" && service !== "git-receive-pack") {
        throw apiError("git_service_invalid", "unsupported Git service", 400);
      }
      const runtime = service === "git-receive-pack"
        ? await resolveGitPushProject(request)
        : await resolveGitProject(request);
      const advertised = await withGitReader(runtime, async () => {
        if (service === "git-upload-pack") {
          await withLiveGitOperation(runtime, () => gitCheckpoint(runtime, "Automatic checkpoint"));
          return gitUploadPack(runtime, ["--advertise-refs"], Buffer.alloc(0), request.get("git-protocol"));
        }
        return (await withLiveGitOperation(runtime, () => gitReceivePack(runtime, ["--advertise-refs"], Buffer.alloc(0), request.get("git-protocol")))).output;
      });
      response.setHeader("Cache-Control", "no-store");
      response.type(`application/x-${service}-advertisement`);
      const header = `# service=${service}\n`;
      const packet = `${(Buffer.byteLength(header) + 4).toString(16).padStart(4, "0")}${header}0000`;
      response.send(Buffer.concat([Buffer.from(packet), advertised]));
    } catch (error) { next(error); }
  });
  app.post(["/git/:projectId/git-upload-pack", "/git/:projectId/:shareToken/git-upload-pack"], express.raw({ type: () => true, limit: "2mb" }), async (request, response, next) => {
    try {
      const runtime = await resolveGitProject(request);
      const result = await withGitReader(runtime, () => gitUploadPack(
        runtime,
        [],
        Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        request.get("git-protocol"),
      ));
      response.setHeader("Cache-Control", "no-store");
      response.type("application/x-git-upload-pack-result").send(result);
    } catch (error) { next(error); }
  });
  app.post("/git/:projectId/:shareToken/git-receive-pack", express.raw({ type: () => true, limit: "32mb" }), async (request, response, next) => {
    try {
      const runtime = await resolveGitPushProject(request);
      const result = await withGitReader(runtime, () => withGitOperation(runtime, () => gitReceivePack(
        runtime,
        [],
        Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        request.get("git-protocol"),
      )));
      if (result.sync?.status) response.setHeader("X-LaTeX-Coder-Sync", result.sync.status);
      if (result.sync) notifyProjectFiles(runtime.id);
      response.setHeader("Cache-Control", "no-store");
      response.type("application/x-git-receive-pack-result").send(result.output);
    } catch (error) { next(error); }
  });
  app.post("/v1/search/project", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const { sources, ...result } = await projectSearch.search(runtime, request.body);
      response.setHeader("Cache-Control", "no-store");
      response.json(result);
    } catch (error) { next(error); }
  });
  app.post("/v1/search/replace/preview", express.json({ limit: "32kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      response.json(await projectSearch.previewReplacement(runtime, request.body));
    } catch (error) { next(error); }
  });
  app.post("/v1/search/replace", express.json({ limit: "24mb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const files = request.body?.files;
      if (!Array.isArray(files) || !files.length || files.length > 100) throw apiError("invalid_files", "Expected 1 to 100 replacement files");
      const paths = new Set<string>();
      // No awaits between validation and mutation: any stale file rejects the batch.
      for (const file of files) {
        file.path = contentPath(file.path);
        if (paths.has(file.path) || typeof file.source !== "string" || !isWellFormedUtf16(file.source) || Buffer.byteLength(file.source) > MAX_TEXT_BYTES) throw apiError("invalid_files", "Invalid or duplicate replacement file");
        paths.add(file.path);
        const current = runtime.collaboration.readText(file.path);
        if (sha256(current) !== file.baseSha256) throw apiError("stale_file", "A replacement file changed. Preview again before applying.", 409, { path: file.path, currentSha256: sha256(current) });
      }
      const results = files.map(file => ({ path: file.path, ...runtime.collaboration.editFile(file.path, file.baseSha256, file.source) }));
      runtime.collaboration.flush();
      response.json({ files: results.map(file => ({ path: file.path, sha256: file.sha256 })) });
    } catch (error) { next(error); }
  });
  app.post("/v1/search", express.json({ limit: "32kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const pattern = request.body?.pattern;
      if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 4096 || pattern.includes("\0")) {
        throw apiError("invalid_search_pattern", "pattern must contain 1 to 4096 characters");
      }
      const searchOptions = validatedSearchOptions(request.body?.args);
      const searchPaths = await validatedSearchPaths(runtime.projectDir, request.body?.paths);
      runtime.collaboration.flush();
      const result = await runRipgrep(runtime.projectDir, [
        "--no-config",
        ...searchOptions,
        "--color=never",
        "--threads=4",
        "--one-file-system",
        "--glob=!.git/**",
        "--glob=!**/.git/**",
        "--regexp", pattern,
        "--",
        ...searchPaths,
      ], {
        bwrap: options.bwrap,
        rg: options.rg,
        timeoutMs: options.searchTimeoutMs,
      });
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Ripgrep-Exit-Code", String(result.code));
      response.type("text/plain; charset=utf-8");
      if (result.code === 0 || (result.code === 1 && result.stderr.length === 0)) return response.send(result.stdout);
      response.status(422).send(result.stderr.length ? result.stderr : Buffer.from(`ripgrep exited with code ${result.code}\n`));
    } catch (error) { next(error); }
  });
  app.post("/v1/files/import", express.raw({ type: "application/zip", limit: "20mb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      if (!Buffer.isBuffer(request.body)) throw apiError("invalid_zip", "send application/zip bytes");
      const files = readProjectZip(request.body);
      for (const file of files) {
        let target = runtime.projectDir;
        for (const part of file.relativePath.split("/")) {
          target = path.join(target, part);
          if (existsSync(target)) {
            const details = await lstat(target);
            if (details.isSymbolicLink()) throw apiError("invalid_zip_path", "import cannot traverse symbolic links");
            if (target !== path.join(runtime.projectDir, file.relativePath) && !details.isDirectory()) throw apiError("file_exists", "import path conflicts with an existing file", 409);
          }
        }
        if (existsSync(target)) throw apiError("file_exists", `${file.relativePath} already exists; ZIP was not imported`, 409);
      }
      for (const file of files) {
        const target = path.join(runtime.projectDir, file.relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      response.status(201).json({ files: files.map(file => ({ path: file.relativePath })) });
    } catch (error) { next(error); }
  });
  app.get("/v1/files", async (request, response, next) => {
    try {
      const { projectDir, collaboration } = await resolveProject(request);
      const relativePath = safeRelativePath(request.query.path);
      if (isTextFile(relativePath)) {
        const source = collaboration.readText(relativePath);
        const revision = sha256(source);
        response.setHeader("ETag", `"${revision}"`);
        response.setHeader("X-Content-SHA256", revision);
        return response.type(path.extname(relativePath)).send(source);
      }
      response.sendFile(path.join(projectDir, relativePath), { dotfiles: "allow" }, error => {
        if (error && !response.headersSent) next(apiError("file_not_found", "file does not exist", 404));
      });
    } catch (error) { next(error); }
  });
  app.put("/v1/files", express.raw({ type: () => true, limit: MAX_FILE_BYTES }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const { projectDir, collaboration } = runtime;
      const relativePath = safeRelativePath(request.query.path);
      const target = path.join(projectDir, relativePath);
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (isTextFile(relativePath) && body.length > MAX_TEXT_BYTES) throw apiError("file_too_large", "text file is too large", 413);
      await withAgentHistory(request, runtime, `Agent upload: ${relativePath}`, async () => {
        await mkdir(path.dirname(target), { recursive: true });
        if (isTextFile(relativePath) && collaboration.replaceText(relativePath, body.toString("utf8"))) {
          collaboration.flush();
        } else {
          await writeFile(target, body);
          await collaboration.remove(relativePath);
        }
      });
      response.status(201).json({ file: { path: relativePath, size: body.length, text: isTextFile(relativePath) } });
    } catch (error) { next(error); }
  });
  app.post("/v1/files/edit", express.raw({ type: () => true, limit: MAX_TEXT_BYTES }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const relativePath = safeRelativePath(request.query.path);
      if (!isTextFile(relativePath)) throw apiError("not_text", "only text files can be edited", 415);
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      let source: string;
      try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); }
      catch { throw apiError("invalid_utf8", "upload must be a valid UTF-8 file"); }
      const mode = request.query.mode === "suggesting" ? "suggesting" : request.query.mode === undefined || request.query.mode === "direct" ? "direct" : null;
      if (!mode) throw apiError("invalid_mode", "mode must be suggesting or direct");
      const agent = typeof request.query.agentId === "string" && typeof request.query.agentName === "string"
        ? { id: request.query.agentId.slice(0, 100), name: request.query.agentName.slice(0, 100) } : undefined;
      const { result, version } = await withGitReader(runtime, () => withGitOperation(runtime, async () => {
        // Check before making a checkpoint, and again inside editFile. The suspended
        // collaboration store isolates this commit from concurrent browser edits.
        const baseSha256 = request.get("X-Base-SHA256");
        if (!baseSha256 || !/^[a-f0-9]{64}$/.test(baseSha256)) throw apiError("invalid_base_sha256", "X-Base-SHA256 must be a lowercase SHA-256 hex digest");
        const currentSha256 = sha256(runtime.collaboration.readText(relativePath));
        if (currentSha256 !== baseSha256) throw apiError("stale_file", "file changed since it was downloaded; download the latest file and retry", 409, { path: relativePath, expectedSha256: baseSha256, currentSha256 });
        await gitCheckpoint(runtime, "Before agent edit");
        const result = runtime.collaboration.editFile(relativePath, request.get("X-Base-SHA256"), source, { mode, agent });
        runtime.collaboration.flush();
        const version = await gitCheckpoint(runtime, `Agent edit: ${relativePath}`, {
          kind: "agent", main: runtime.build.main, agentId: agent?.id, agentName: agent?.name || "Coding agent", mode,
        });
        return { result, version: result.changeCount ? version.commit : null };
      }));
      response.setHeader("ETag", `"${result.sha256}"`);
      response.setHeader("X-Content-SHA256", result.sha256);
      response.json({ file: { path: relativePath, size: Buffer.byteLength(result.source), text: true, sha256: result.sha256 }, edit: { version, mode: result.mode, changeCount: result.changeCount, suggestionIds: result.suggestionIds } });
    } catch (error) {
      if (error.code === "stale_file") error.details = { ...error.details,
        latestFileUrl: request.originalUrl.replace("/v1/files/edit", "/v1/files"),
        conflictUrl: request.originalUrl.replace("/v1/files/edit", "/v1/files/edit/conflict"),
        action: "Download the latest file and reapply your intended edits. Do not put a new hash on the old upload.",
      };
      next(error);
    }
  });
  app.post("/v1/files/edit/conflict", express.raw({ type: () => true, limit: MAX_TEXT_BYTES }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const file = contentPath(request.query.path);
      const currentSource = runtime.collaboration.readText(file);
      const baseSha256 = request.get("X-Base-SHA256");
      if (!baseSha256 || !/^[a-f0-9]{64}$/.test(baseSha256)) throw apiError("invalid_base_sha256", "Supply the original X-Base-SHA256");
      let proposedSource;
      try { proposedSource = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(request.body || Buffer.alloc(0)); }
      catch { throw apiError("invalid_utf8", "Upload must be valid UTF-8"); }
      response.setHeader("Cache-Control", "no-store");
      response.json({ path: file, baseSha256, currentSha256: sha256(currentSource), currentSource,
        diff: createPatch(file, currentSource, proposedSource, "current live file", "your rejected upload", { context: 3 }),
        action: "This diff includes others' changes too. Reapply only your intended changes to currentSource and upload with currentSha256.",
      });
    } catch (error) { next(error); }
  });
  app.post("/v1/files/patch", express.json({ limit: `${MAX_TEXT_BYTES}b` }), (request, response, next) => {
    resolveProject(request).then(async runtime => {
      assertProjectWritable(runtime);
      const { collaboration } = runtime;
      const relativePath = safeRelativePath(request.query.path);
      if (!isTextFile(relativePath)) throw apiError("not_text", "only text files can be patched", 415);
      const result = await withAgentHistory(request, runtime, `Agent edit: ${relativePath}`, () => collaboration.patchText(relativePath, request.body?.baseSha256, request.body?.changes, {
        mode: request.body?.mode,
        agent: request.body?.agent,
      }), true);
      collaboration.flush();
      response.setHeader("ETag", `"${result.sha256}"`);
      response.setHeader("X-Content-SHA256", result.sha256);
      response.json({
        file: { path: relativePath, size: Buffer.byteLength(result.source), text: true, sha256: result.sha256 },
        patch: { mode: result.mode, suggestionIds: result.suggestionIds },
      });
    }).catch(next);
  });
  app.post("/v1/files/folder", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const folder = contentPath(request.body?.path);
      const target = checkedContentTarget(runtime.projectDir, folder);
      if (existsSync(target)) throw apiError("path_exists", "That path already exists", 409);
      await withAgentHistory(request, runtime, `Agent folder: ${folder}`, () => mkdirSync(target, { recursive: true }));
      response.status(201).json({ folder });
    } catch (error) { next(error); }
  });
  app.get("/v1/trash", async (request, response, next) => {
    try { response.json({ items: database.listTrash((await resolveProject(request)).id) }); }
    catch (error) { next(error); }
  });
  app.post("/v1/trash/restore", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const id = String(request.body?.id || "");
      const entry = database.getTrash(runtime.id, id);
      if (!entry) throw apiError("trash_not_found", "Deleted item not found", 404);
      const target = checkedContentTarget(runtime.projectDir, entry.path);
      if (existsSync(target)) throw apiError("path_exists", "The original path is occupied. Move it before restoring.", 409);
      if (entry.directory) mkdirSync(target, { recursive: true });
      for (const file of entry.files) {
        const destination = checkedContentTarget(runtime.projectDir, file.path);
        if (file.directory) { mkdirSync(destination, { recursive: true }); continue; }
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, file.content);
        if (file.snapshot) database.saveYjsSnapshot(runtime.id, file.path, file.snapshot);
      }
      database.removeTrash(runtime.id, id);
      response.json({ restored: { path: entry.path } });
    } catch (error) { next(error); }
  });
  app.delete("/v1/files", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const { projectDir, collaboration } = runtime;
      const relativePath = contentPath(request.query.path);
      if (relativePath === runtime.build.main || runtime.build.main.startsWith(`${relativePath}/`)) throw apiError("main_file_required", "the main document cannot be deleted", 409);
      const id = randomUUID();
      await withAgentHistory(request, runtime, `Agent delete: ${relativePath}`, () => {
        collaboration.flush();
        const target = path.join(projectDir, relativePath);
        const entries = contentEntries(projectDir, relativePath);
        const directory = entries[0].directory;
        const files = entries.map(file => ({ ...file, content: file.directory ? Buffer.alloc(0) : readFileSync(path.join(projectDir, file.path)), snapshot: file.directory ? null : database.getYjsSnapshot(runtime.id, file.path) }));
        database.createTrash(runtime.id, id, relativePath, directory, files);
        try {
          rmSync(target, { recursive: directory, force: false });
          for (const file of entries) if (!file.directory) void collaboration.remove(file.path);
        } catch (error) { throw error; }
      });
      response.json({ deleted: { path: relativePath, trashId: id } });
    } catch (error) {
      if (error.code === "ENOENT") next(apiError("file_not_found", "file does not exist", 404));
      else next(error);
    }
  });
  app.post("/v1/files/move", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const { projectDir, collaboration } = runtime;
      const from = contentPath(request.body?.from);
      const to = contentPath(request.body?.to);
      checkedContentTarget(projectDir, to);
      if (to === from || to.startsWith(`${from}/`)) throw apiError("invalid_move", "Cannot move a folder into itself");
      if (existsSync(path.join(projectDir, to))) throw apiError("path_exists", "Destination already exists", 409);
      await withAgentHistory(request, runtime, `Agent move: ${from} → ${to}`, () => {
        collaboration.flush();
        const entries = contentEntries(projectDir, from);
        mkdirSync(path.dirname(path.join(projectDir, to)), { recursive: true });
        renameSync(path.join(projectDir, from), path.join(projectDir, to));
        for (const file of entries) if (!file.directory) void collaboration.remove(file.path);
        if (runtime.build.main === from || runtime.build.main.startsWith(`${from}/`)) runtime.build.main = to + runtime.build.main.slice(from.length);
        database.saveBuild(runtime.id, runtime.build);
      });
      response.json({ file: { path: to } });
    } catch (error) { next(error); }
  });
  app.get("/v1/build", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      runtime.collaboration.flush();
      const currentRevision = await compilationSourceRevision(runtime.projectDir, runtime.build.main, database.getSettings(runtime.id).compiler);
      const diagnostics = buildDiagnostics(runtime.build.log, runtime.build.errors);
      response.setHeader("Cache-Control", "no-store");
      response.json({ build: { ...runtime.build, stale: currentRevision !== runtime.build.sourceRevision, errors: runtime.build.errors?.length ? runtime.build.errors : compileErrors(runtime.build.log), diagnostics, firstFatalError: diagnostics.find(item => item.severity === "error") || null } });
    }
    catch (error) { next(error); }
  });
  app.get("/v1/build/pdf", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      response.setHeader("Cache-Control", "no-store");
      const build = request.query.cached === "1" ? runtime.build : await ensureLatestPdf(runtime);
      if (!build.pdf || !existsSync(path.join(runtime.buildDir, "latest.pdf"))) throw apiError("pdf_not_found", "No successful PDF yet", 404);
      response.setHeader("Cache-Control", "no-store");
      const diagnostics = buildDiagnostics(build.log, build.errors);
      response.setHeader("X-Build-Error-Count", diagnostics.filter(item => item.severity === "error").length);
      response.setHeader("X-Build-Warning-Count", diagnostics.filter(item => item.severity === "warning").length);
      const logQuery = new URLSearchParams({ project: runtime.id });
      if (typeof request.query.access === "string") logQuery.set("access", request.query.access);
      response.setHeader("Link", `</v1/build?${logQuery}>; rel="describedby"; type="application/json"`);
      response.setHeader("ETag", `"${build.sourceRevision}"`);
      response.setHeader("X-LaTeX-Coder-Source-Revision", build.sourceRevision);
      response.sendFile(path.join(runtime.buildDir, "latest.pdf"), { dotfiles: "allow" });
    } catch (error) { next(error); }
  });
  app.post("/v1/build/position", express.json({ limit: `${MAX_TEXT_BYTES * 2}b` }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const file = safeRelativePath(request.body?.path);
      const { line, source, from, to } = request.body || {};
      if (!file.endsWith(".tex") || !Number.isSafeInteger(line) || line < 1 || typeof source !== "string") throw apiError("invalid_position", "Expected a LaTeX file, source, and positive line number");
      if (runtime.collaboration.readText(file) !== source) throw apiError("stale_source", "The source changed. Try navigating again.", 409);
      await ensureLatestPdf(runtime);
      if (!existsSync(path.join(runtime.buildDir, "latest.synctex.gz"))) await compileProject(runtime, runtime.build.main);
      if (!existsSync(path.join(runtime.buildDir, "latest.synctex.gz"))) throw apiError("synctex_missing", "The compiler did not produce SyncTeX data", 409);
      let snapshot = JSON.parse(await readFile(path.join(runtime.buildDir, "source-map.json"), "utf8"));
      if (snapshot.files[file]?.source !== source) {
        const result = await compileProject(runtime, runtime.build.main);
        if (!result.success) throw apiError("compile_failed", "Compilation failed while locating the PDF position", 422);
        snapshot = JSON.parse(await readFile(path.join(runtime.buildDir, "source-map.json"), "utf8"));
      }
      const map = snapshot.files[file];
      if (!map) throw apiError("source_not_found", "This file is not part of the compiled document", 404);
      if (map.source !== source || runtime.collaboration.readText(file) !== source) throw apiError("stale_source", "The source changed. Try navigating again.", 409);
      let projectedLine = 1;
      for (let index = 0; index < map.lines.length; index++) {
        if (Math.abs(map.lines[index] - line) < Math.abs(map.lines[projectedLine - 1] - line)) projectedLine = index + 1;
      }
      const start = Number.isSafeInteger(from) && from >= 0 && from <= source.length ? projectedPosition(source, from) : { line: projectedLine, column: 0 };
      const end = Number.isSafeInteger(to) && to >= (from || 0) && to <= source.length ? projectedPosition(source, to) : start;
      const boxes = [];
      try {
        for (let batch = start.line; batch <= Math.min(end.line, start.line + 19); batch += 4) {
          const lines = Array.from({ length: Math.min(4, Math.min(end.line, start.line + 19) - batch + 1) }, (_, index) => batch + index);
          const results = await Promise.all(lines.map(targetLine => run(options.synctex || "synctex", ["view", "-i", `${targetLine}:${targetLine === start.line ? start.column : 0}:${path.join(snapshot.root, file)}`, "-o", path.join(runtime.buildDir, "latest.pdf")], { cwd: runtime.buildDir, timeoutMs: 1000, env: { ...process.env, SYNCTEX_VIEWER: "" } })));
          for (const result of results) boxes.push(...syncTexPositions(result.output));
        }
      } catch { throw apiError("synctex_unavailable", "SyncTeX is not installed on the server", 503); }
      if (runtime.compilePromise || snapshot.revision !== runtime.build.sourceRevision || runtime.collaboration.readText(file) !== source) throw apiError("stale_source", "The source or PDF changed. Try navigating again.", 409);
      const unique = [...new Map(boxes.map(box => [JSON.stringify(box), box])).values()].slice(0, 200);
      if (!unique.length) throw apiError("source_not_found", "No PDF position for this source", 404);
      const { page, x, y } = unique[0];
      response.setHeader("Cache-Control", "no-store");
      response.json({ page, x, y, boxes: unique, revision: snapshot.revision });
    } catch (error) { next(error); }
  });
  app.post("/v1/build/source", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const { page, x, y, revision } = request.body || {};
      if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100000 || y > 100000) throw apiError("invalid_position", "Invalid PDF position");
      if (runtime.compilePromise || revision !== runtime.build.sourceRevision) throw apiError("stale_pdf", "The PDF changed. Refresh the preview and try again.", 409);
      if (!existsSync(path.join(runtime.buildDir, "latest.synctex.gz"))) throw apiError("synctex_missing", "Compile the project to enable PDF source navigation.", 409);
      const snapshot = JSON.parse(await readFile(path.join(runtime.buildDir, "source-map.json"), "utf8"));
      let result;
      try {
        result = await run(options.synctex || "synctex", ["edit", "-o", `${page}:${x}:${y}:${path.join(runtime.buildDir, "latest.pdf")}`], { cwd: runtime.buildDir, timeoutMs: 5000, env: { ...process.env, SYNCTEX_EDITOR: "" } });
      } catch { throw apiError("synctex_unavailable", "SyncTeX is not installed on the server", 503); }
      if (runtime.compilePromise || revision !== runtime.build.sourceRevision) throw apiError("stale_pdf", "The PDF changed. Refresh the preview and try again.", 409);
      const input = /^Input:(.*)$/m.exec(result.output)?.[1]?.trim();
      const line = Number(/^Line:(\d+)$/m.exec(result.output)?.[1]);
      if (!input || !line || result.code !== 0) throw apiError("source_not_found", "No source location at this PDF position", 404);
      let file = path.relative(snapshot.root, path.resolve(snapshot.root, input));
      if (!snapshot.files[file] && snapshot.files[`${file}.tex`]) file += ".tex";
      const map = snapshot.files[file];
      if (!map) throw apiError("source_not_found", "The source is outside this project", 404);
      runtime.collaboration.flush();
      const current = await readFile(path.join(runtime.projectDir, safeRelativePath(file)), "utf8");
      if (current !== map.source) throw apiError("stale_source", "This source changed since compilation. Compile again to navigate accurately.", 409);
      response.setHeader("Cache-Control", "no-store");
      response.json({ path: file, line: map.lines[line - 1] || line });
    } catch (error) { next(error); }
  });
  app.post("/v1/compile", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const body = parseBody(compileRequestSchema, request.body);
      const main = safeRelativePath(body.main || runtime.build.main || "main.tex");
      let result = await compileProject(runtime, main);
      if (result.build.main !== main) result = await compileProject(runtime, main);
      response.status(result.success ? 200 : 422).json({ build: result.build });
    } catch (error) { next(error); }
  });

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
      const shareId = projectAccessShareId(request, runtime);
      const relativePath = pathFromRoomName(scoped ? parts[1] : parts[0]);
      sockets.handleUpgrade(request, socket, head, connection => runtime.collaboration.attach(connection, relativePath, shareId, url.searchParams.get("saved") === "1"));
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
