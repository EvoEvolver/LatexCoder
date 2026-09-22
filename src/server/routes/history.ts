import { existsSync } from "node:fs";
import { cp, lstat, mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import { apiError, safeRelativePath } from "../core.ts";
import { listFolders } from "../project-files.ts";
import { historyCommit, historyRevision, listVersions, versionDiff, versionFiles, versionInfo, versionStructure } from "../version-history.ts";
import type { HistoryRouteContext, RouteApp } from "./types.ts";

export function registerHistoryRoutes(app: RouteApp, context: HistoryRouteContext): void {
  app.get("/v1/history", async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      response.setHeader("Cache-Control", "no-store");
      response.json(await context.withGitReader(runtime, () => listVersions(runtime.projectDir, request.query.before, request.query.agent === "1")));
    } catch (error) { next(error); }
  });
  app.get("/v1/history/:version", async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const result = await context.withGitReader(runtime, async () => {
        const id = await historyCommit(runtime.projectDir, request.params.version);
        if (request.query.path !== undefined) return versionDiff(runtime.projectDir, id, request.query.path);
        runtime.collaboration.flush();
        return { version: await versionInfo(runtime.projectDir, id), files: await versionFiles(runtime.projectDir, id), structure: await versionStructure(runtime.projectDir, id), currentRevision: await historyRevision(runtime.projectDir, runtime.build.main) };
      });
      response.setHeader("Cache-Control", "no-store");
      response.json(result);
    } catch (error) { next(error); }
  });
  app.post("/v1/history/:version/restore", context.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const result = await context.withGitReader(runtime, () => context.withGitOperation(runtime, async () => {
        const id = await historyCommit(runtime.projectDir, request.params.version);
        const currentRevision = await historyRevision(runtime.projectDir, runtime.build.main);
        if (request.body?.currentRevision !== currentRevision) throw apiError("stale_restore", "The project changed. Refresh the version preview before restoring.", 409);
        const selectedPath = request.body?.path === undefined ? null : safeRelativePath(request.body.path);
        if (selectedPath && !(await versionFiles(runtime.projectDir, id)).some(file => file.path === selectedPath)) throw apiError("version_file_missing", "This file did not change in this version", 404);
        const previousFolders = await listFolders(runtime.projectDir);
        const info = await versionInfo(runtime.projectDir, id);
        const backup = await context.gitCheckpoint(runtime, "Before restoring " + id.slice(0, 7));
        const previousMain = runtime.build.main;
        try {
          await context.withTemporaryWorktree(runtime, id, async directory => {
            const paths = await context.trackedPaths(directory);
            const main = info.metadata?.main || (paths.includes(previousMain) ? previousMain : paths.includes("main.tex") ? "main.tex" : "");
            if (!main && !selectedPath) throw apiError("restore_main_missing", "This old version does not identify its main document", 409);
            if (selectedPath) {
              await context.withTemporaryWorktree(runtime, backup.commit, async combined => {
                const source = path.join(directory, selectedPath), target = path.join(combined, selectedPath);
                if (paths.includes(selectedPath)) {
                  const details = await lstat(source);
                  if (!details.isFile()) throw apiError("git_file_unsupported", "Cannot restore a symbolic link", 409);
                  await mkdir(path.dirname(target), { recursive: true });
                  await cp(source, target);
                } else await rm(target, { force: true });
                if (existsSync(target) || (await context.trackedPaths(combined)).includes(selectedPath)) await context.git(combined, ["--literal-pathspecs", "add", "-A", "--", selectedPath]);
                await context.importGitWorktree(runtime, combined, previousMain, false);
              });
            } else {
              await context.importGitWorktree(runtime, directory, main, false);
              runtime.build.main = main;
              for (const folder of (await listFolders(runtime.projectDir)).sort((a, b) => b.length - a.length)) {
                if (!info.metadata?.folders?.includes(folder)) await rmdir(path.join(runtime.projectDir, folder)).catch(error => { if (error.code !== "ENOTEMPTY") throw error; });
              }
              for (const folder of info.metadata?.folders || []) await mkdir(path.join(runtime.projectDir, safeRelativePath(folder)), { recursive: true });
            }
          });
          const restored = await context.gitCheckpoint(runtime, (selectedPath ? `Restore ${selectedPath} from ` : "Restore version ") + id.slice(0, 7), { kind: "restore", main: runtime.build.main, restoredFrom: id });
          context.database.saveBuild(runtime.id, runtime.build);
          return { ...restored, backup: backup.commit };
        } catch (error) {
          runtime.build.main = previousMain;
          await context.git(runtime.projectDir, ["add", "-A"]);
          await context.withTemporaryWorktree(runtime, backup.commit, directory => context.importGitWorktree(runtime, directory, previousMain, false));
          for (const folder of previousFolders) await mkdir(path.join(runtime.projectDir, folder), { recursive: true });
          throw error;
        }
      }));
      context.notifyProjectFiles(runtime.id);
      response.json(result);
    } catch (error) { next(error); }
  });
}
