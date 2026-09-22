import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createPatch } from "diff";

import { apiError, contentPath, isTextFile, MAX_FILE_BYTES, MAX_TEXT_BYTES, readProjectZip, safeRelativePath, sha256 } from "../core.ts";
import { checkedContentTarget, contentEntries } from "../project-files.ts";
import type { FileRouteContext, RouteApp } from "./types.ts";

export function registerFileRoutes(app: RouteApp, context: FileRouteContext): void {
  const { database, json, raw } = context;

  app.post("/v1/files/import", raw({ type: "application/zip", limit: "20mb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      context.assertProjectWritable(runtime);
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
      const { projectDir, collaboration } = await context.resolveProject(request);
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
  app.get("/v1/blame", async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const relativePath = safeRelativePath(request.query.path);
      if (!isTextFile(relativePath)) throw apiError("not_text", "only text files have collaborative blame", 415);
      const blame = runtime.collaboration.blame(relativePath);
      const commits = [...new Set(blame.runs.map(run => run.commit).filter((commit): commit is string => Boolean(commit)))];
      const authors = new Map(await Promise.all(commits.map(async commit => [commit, await context.gitAuthorForCommit(runtime.projectDir, commit)] as const)));
      response.setHeader("Cache-Control", "no-store");
      response.json({ path: relativePath, revision: blame.revision, runs: blame.runs.map(run => ({ ...run, gitAuthor: run.commit ? authors.get(run.commit) || null : null })) });
    } catch (error) { next(error); }
  });
  app.put("/v1/files", raw({ type: () => true, limit: MAX_FILE_BYTES }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      context.assertProjectWritable(runtime);
      const { projectDir, collaboration } = runtime;
      const relativePath = safeRelativePath(request.query.path);
      const target = path.join(projectDir, relativePath);
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (isTextFile(relativePath) && body.length > MAX_TEXT_BYTES) throw apiError("file_too_large", "text file is too large", 413);
      await context.withAgentHistory(request, runtime, `Agent upload: ${relativePath}`, async () => {
        await mkdir(path.dirname(target), { recursive: true });
        if (isTextFile(relativePath) && collaboration.replaceText(relativePath, body.toString("utf8"), context.requestBlameActor(request))) collaboration.flush();
        else { await writeFile(target, body); await collaboration.remove(relativePath); }
      });
      response.status(201).json({ file: { path: relativePath, size: body.length, text: isTextFile(relativePath) } });
    } catch (error) { next(error); }
  });
  app.post("/v1/files/edit", raw({ type: () => true, limit: MAX_TEXT_BYTES }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      context.assertProjectWritable(runtime);
      const relativePath = safeRelativePath(request.query.path);
      if (!isTextFile(relativePath)) throw apiError("not_text", "only text files can be edited", 415);
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      let source: string;
      try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); }
      catch { throw apiError("invalid_utf8", "upload must be a valid UTF-8 file"); }
      const proposal = context.isProposalAccess(runtime, request.query.access);
      const mode = proposal || request.query.mode === "suggesting" ? "suggesting" : request.query.mode === undefined || request.query.mode === "direct" ? "direct" : null;
      if (!mode) throw apiError("invalid_mode", "mode must be suggesting or direct");
      const agent = typeof request.query.agentId === "string" && typeof request.query.agentName === "string"
        ? { id: request.query.agentId.slice(0, 100), name: request.query.agentName.slice(0, 100) }
        : proposal ? { id: "ag_proposal", name: "Coding agent" } : undefined;
      const { result, version } = await context.withGitReader(runtime, () => context.withGitOperation(runtime, async () => {
        const baseSha256 = request.get("X-Base-SHA256");
        if (!baseSha256 || !/^[a-f0-9]{64}$/.test(baseSha256)) throw apiError("invalid_base_sha256", "X-Base-SHA256 must be a lowercase SHA-256 hex digest");
        const currentSha256 = sha256(runtime.collaboration.readText(relativePath));
        if (currentSha256 !== baseSha256) throw apiError("stale_file", "file changed since it was downloaded; download the latest file and retry", 409, { path: relativePath, expectedSha256: baseSha256, currentSha256 });
        await context.gitCheckpoint(runtime, "Before agent edit");
        const result = runtime.collaboration.editFile(relativePath, baseSha256, source, { mode, agent });
        runtime.collaboration.flush();
        const version = await context.gitCheckpoint(runtime, `Agent edit: ${relativePath}`, { kind: "agent", main: runtime.build.main, agentId: agent?.id, agentName: agent?.name || "Coding agent", mode });
        return { result, version: result.changeCount ? version.commit : null };
      }));
      response.setHeader("ETag", `"${result.sha256}"`);
      response.setHeader("X-Content-SHA256", result.sha256);
      response.json({ file: { path: relativePath, size: Buffer.byteLength(result.source), text: true, sha256: result.sha256 }, edit: { version, mode: result.mode, changeCount: result.changeCount, suggestionIds: result.suggestionIds } });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "stale_file") {
        const failure = error as { details?: Record<string, unknown> };
        failure.details = { ...failure.details, latestFileUrl: request.originalUrl.replace("/v1/files/edit", "/v1/files"), conflictUrl: request.originalUrl.replace("/v1/files/edit", "/v1/files/edit/conflict"), action: "Download the latest file and reapply your intended edits. Do not put a new hash on the old upload." };
      }
      next(error);
    }
  });
  app.post("/v1/files/edit/conflict", raw({ type: () => true, limit: MAX_TEXT_BYTES }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const file = contentPath(request.query.path);
      const currentSource = runtime.collaboration.readText(file);
      const baseSha256 = request.get("X-Base-SHA256");
      if (!baseSha256 || !/^[a-f0-9]{64}$/.test(baseSha256)) throw apiError("invalid_base_sha256", "Supply the original X-Base-SHA256");
      let proposedSource: string;
      try { proposedSource = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(request.body || Buffer.alloc(0)); }
      catch { throw apiError("invalid_utf8", "Upload must be valid UTF-8"); }
      response.setHeader("Cache-Control", "no-store");
      response.json({ path: file, baseSha256, currentSha256: sha256(currentSource), currentSource, diff: createPatch(file, currentSource, proposedSource, "current live file", "your rejected upload", { context: 3 }), action: "This diff includes others' changes too. Reapply only your intended changes to currentSource and upload with currentSha256." });
    } catch (error) { next(error); }
  });
  app.post("/v1/files/patch", json({ limit: `${MAX_TEXT_BYTES}b` }), (request, response, next) => {
    context.resolveProject(request).then(async runtime => {
      context.assertProjectWritable(runtime);
      const { collaboration } = runtime;
      const relativePath = safeRelativePath(request.query.path);
      if (!isTextFile(relativePath)) throw apiError("not_text", "only text files can be patched", 415);
      const proposal = context.isProposalAccess(runtime, request.query.access);
      const result = await context.withAgentHistory(request, runtime, `Agent edit: ${relativePath}`, () => collaboration.patchText(relativePath, request.body?.baseSha256, request.body?.changes, { mode: proposal ? "suggesting" : request.body?.mode, agent: proposal ? (request.body?.agent || { id: "ag_proposal", name: "Coding agent" }) : request.body?.agent }), true);
      collaboration.flush();
      response.setHeader("ETag", `"${result.sha256}"`);
      response.setHeader("X-Content-SHA256", result.sha256);
      response.json({ file: { path: relativePath, size: Buffer.byteLength(result.source), text: true, sha256: result.sha256 }, patch: { mode: result.mode, suggestionIds: result.suggestionIds } });
    }).catch(next);
  });
  app.post("/v1/files/folder", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      context.assertProjectWritable(runtime);
      const folder = contentPath(request.body?.path);
      const target = checkedContentTarget(runtime.projectDir, folder);
      if (existsSync(target)) throw apiError("path_exists", "That path already exists", 409);
      await context.withAgentHistory(request, runtime, `Agent folder: ${folder}`, () => mkdirSync(target, { recursive: true }));
      response.status(201).json({ folder });
    } catch (error) { next(error); }
  });
  app.get("/v1/trash", async (request, response, next) => {
    try { response.json({ items: database.listTrash((await context.resolveProject(request)).id) }); }
    catch (error) { next(error); }
  });
  app.post("/v1/trash/restore", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      context.assertProjectWritable(runtime);
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
      const runtime = await context.resolveProject(request);
      context.assertProjectWritable(runtime);
      const { projectDir, collaboration } = runtime;
      const relativePath = contentPath(request.query.path);
      if (relativePath === runtime.build.main || runtime.build.main.startsWith(`${relativePath}/`)) throw apiError("main_file_required", "the main document cannot be deleted", 409);
      const id = randomUUID();
      await context.withAgentHistory(request, runtime, `Agent delete: ${relativePath}`, () => {
        collaboration.flush();
        const target = path.join(projectDir, relativePath);
        const entries = contentEntries(projectDir, relativePath);
        const directory = entries[0].directory;
        const files = entries.map(file => ({ ...file, content: file.directory ? Buffer.alloc(0) : readFileSync(path.join(projectDir, file.path)), snapshot: file.directory ? null : database.getYjsSnapshot(runtime.id, file.path) }));
        database.createTrash(runtime.id, id, relativePath, directory, files);
        rmSync(target, { recursive: directory, force: false });
        for (const file of entries) if (!file.directory) void collaboration.remove(file.path);
      });
      response.json({ deleted: { path: relativePath, trashId: id } });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") next(apiError("file_not_found", "file does not exist", 404));
      else next(error);
    }
  });
  app.post("/v1/files/move", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      context.assertProjectWritable(runtime);
      const { projectDir, collaboration } = runtime;
      const from = contentPath(request.body?.from);
      const to = contentPath(request.body?.to);
      checkedContentTarget(projectDir, to);
      if (to === from || to.startsWith(`${from}/`)) throw apiError("invalid_move", "Cannot move a folder into itself");
      if (existsSync(path.join(projectDir, to))) throw apiError("path_exists", "Destination already exists", 409);
      await context.withAgentHistory(request, runtime, `Agent move: ${from} → ${to}`, () => {
        collaboration.flush();
        mkdirSync(path.dirname(path.join(projectDir, to)), { recursive: true });
        renameSync(path.join(projectDir, from), path.join(projectDir, to));
        collaboration.move(from, to);
        if (runtime.build.main === from || runtime.build.main.startsWith(`${from}/`)) runtime.build.main = to + runtime.build.main.slice(from.length);
        database.saveBuild(runtime.id, runtime.build);
      });
      response.json({ file: { path: to } });
    } catch (error) { next(error); }
  });
}
