import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { parseReviews } from "../../shared/review.ts";
import { createProjectRequestSchema, projectArchiveRequestSchema, projectTagsRequestSchema, settingsRequestSchema, updateProjectRequestSchema } from "../../shared/api-schema.ts";
import { apiError, contentPath, readProjectZip } from "../core.ts";
import { listFiles, listFolders } from "../project-files.ts";
import type { ZodType } from "zod";
import type { ProjectRouteContext, RouteApp } from "./types.ts";

function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw apiError("invalid_request", "request body is invalid", 400, {
    issues: result.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })),
  });
}

export function registerProjectRoutes(app: RouteApp, context: ProjectRouteContext): void {
  const { database, json, raw } = context;

  app.get("/v1/projects", async (request, response, next) => {
    try {
      const user = context.requireUser(request);
      const accessible = await context.projectSummaries(user.username);
      response.json({ projects: accessible, defaultProjectId: accessible.find(project => !project.archived)?.id || null });
    } catch (error) { next(error); }
  });
  app.post("/v1/projects", json({ limit: "16kb" }), raw({ type: "application/zip", limit: "20mb" }), async (request, response, next) => {
    try {
      const user = context.requireUser(request);
      const importedFiles = request.is("application/zip") ? readProjectZip(request.body) : [];
      const name = request.is("application/zip") ? request.query.name : parseBody(createProjectRequestSchema, request.body).name;
      const runtime = await context.createProject(name, user.username, importedFiles);
      response.status(201).json({ project: { ...context.publicProjectMetadata(runtime.metadata), build: runtime.build, tags: [], archived: false } });
    } catch (error) { next(error); }
  });
  app.patch("/v1/projects/:projectId", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.loadProject(request.params.projectId);
      context.requireProjectOwner(request, runtime);
      runtime.metadata = { ...runtime.metadata, name: context.cleanProjectName(parseBody(updateProjectRequestSchema, request.body).name) };
      database.saveProject(runtime.metadata);
      response.json({ project: context.publicProjectMetadata(runtime.metadata) });
    } catch (error) { next(error); }
  });
  app.patch("/v1/projects/:projectId/tags", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.loadProject(request.params.projectId);
      const membership = context.requireProjectMember(request, runtime);
      if (membership.role === "viewer") throw apiError("project_edit_required", "view-only members cannot change project tags", 403);
      const tags = context.cleanProjectTags(parseBody(projectTagsRequestSchema, request.body).tags);
      database.replaceProjectTags(runtime.id, tags);
      response.json({ project: { id: runtime.id, tags } });
    } catch (error) { next(error); }
  });
  app.patch("/v1/projects/:projectId/archive", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.loadProject(request.params.projectId);
      const user = context.requireUser(request);
      context.requireProjectMember(request, runtime);
      const { archived } = parseBody(projectArchiveRequestSchema, request.body);
      if (!database.setProjectArchived(runtime.id, user.username, archived)) throw apiError("project_member_required", "sign in as a project member to continue", 403);
      response.json({ project: { id: runtime.id, archived } });
    } catch (error) { next(error); }
  });
  app.delete("/v1/projects/:projectId", async (request, response, next) => {
    try {
      const runtime = await context.loadProject(request.params.projectId);
      context.requireProjectOwner(request, runtime);
      const result = await context.deleteProject(runtime);
      response.json({ deleted: { id: runtime.id }, defaultProjectId: result.defaultProjectId });
    } catch (error) { next(error); }
  });
  app.get("/v1/project", async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const membership = context.projectMembership(request, runtime);
      if (request.query.opened === "1") {
        const lastOpenedAt = new Date().toISOString();
        database.markProjectOpened(runtime.id, lastOpenedAt);
        runtime.metadata = { ...runtime.metadata, lastOpenedAt };
      }
      response.json({ project: {
        ...context.publicProjectMetadata(runtime.metadata),
        tags: database.listProjectTags(runtime.id),
        archived: membership?.archived || false,
        main: runtime.build.main,
        files: await listFiles(runtime.projectDir),
        folders: await listFolders(runtime.projectDir),
        settings: database.getSettings(runtime.id),
        build: runtime.build,
        permissions: {
          manage: context.isProjectOwner(request, runtime),
          edit: context.projectAccessMode(request, runtime) === "edit",
          collaborate: context.membershipAccessMode(request, runtime) === "edit",
        },
      } });
    } catch (error) { next(error); }
  });
  app.get("/v1/settings", async (request, response, next) => {
    try { response.json({ settings: database.getSettings((await context.resolveProject(request)).id) }); }
    catch (error) { next(error); }
  });
  app.patch("/v1/settings", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      context.assertProjectWritable(runtime);
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
      const runtime = await context.resolveProject(request);
      const files = await listFiles(runtime.projectDir);
      response.setHeader("Cache-Control", "no-store");
      response.json({ files: files.filter(file => file.text).map(file => ({ path: file.path, reviews: parseReviews(runtime.collaboration.readText(file.path)) })) });
    } catch (error) { next(error); }
  });
  app.post("/v1/project/share", async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const user = context.requireUser(request);
      context.requireProjectMember(request, runtime);
      response.json({ share: context.memberProjectShare(runtime, user.username) });
    } catch (error) { next(error); }
  });
  app.post("/v1/project/share/rotate", async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const user = context.requireUser(request);
      context.requireProjectMember(request, runtime);
      response.json({ share: context.rotateShare(runtime, user.username) });
    } catch (error) { next(error); }
  });
  app.get("/v1/project/members", async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      context.requireProjectMember(request, runtime);
      response.json({ members: database.listProjectMembers(runtime.id) });
    } catch (error) { next(error); }
  });
  app.get("/v1/project/archive", async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const { archive, temporary } = await context.withGitReader(runtime, () => context.createProjectArchive(runtime));
      response.download(archive, `${runtime.id}.zip`, async error => {
        await rm(temporary, { recursive: true, force: true });
        if (error && !response.headersSent) next(error);
      });
    } catch (error) { next(error); }
  });
}
