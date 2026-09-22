import { apiError } from "../core.ts";
import type { GitRouteContext, RouteApp } from "./types.ts";

export function registerGitRoutes(app: RouteApp, context: GitRouteContext): void {
  const { json, raw } = context;

  app.get("/v1/git", async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      response.json({ git: await context.withGitReader(runtime, () => context.gitStatus(runtime)) });
    } catch (error) { next(error); }
  });
  app.post("/v1/git/commit", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const payload = await context.withGitReader(runtime, async () => {
        const result = await context.withLiveGitOperation(runtime, () => context.gitCheckpoint(runtime, request.body?.message));
        return { ...result, status: await context.gitStatus(runtime) };
      });
      response.json({ git: payload });
    } catch (error) { next(error); }
  });
  app.post("/v1/git/sync", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const payload = await context.withGitReader(runtime, async () => {
        const result = await context.gitSync(runtime, request.body?.ref);
        return { ...result, current: await context.gitStatus(runtime) };
      });
      response.json({ git: payload });
    } catch (error) { next(error); }
  });
  app.post("/v1/git/resolve", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const payload = await context.withGitReader(runtime, async () => {
        const result = await context.gitResolve(runtime, request.body?.message);
        return { ...result, current: await context.gitStatus(runtime) };
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
      const pushAccess = service === "git-receive-pack" ? await context.resolveGitPushProject(request) : null;
      const runtime = pushAccess?.runtime || await context.resolveGitProject(request);
      const advertised = await context.withGitReader(runtime, async () => {
        if (service === "git-upload-pack") {
          await context.withLiveGitOperation(runtime, () => context.prepareGitPull(runtime));
          return context.gitUploadPack(runtime, ["--advertise-refs"], Buffer.alloc(0), request.get("git-protocol"));
        }
        return (await context.withLiveGitOperation(runtime, () => context.gitReceivePack(runtime, ["--advertise-refs"], Buffer.alloc(0), request.get("git-protocol"), pushAccess?.actor))).output;
      });
      response.setHeader("Cache-Control", "no-store");
      response.type(`application/x-${service}-advertisement`);
      const header = `# service=${service}\n`;
      const packet = `${(Buffer.byteLength(header) + 4).toString(16).padStart(4, "0")}${header}0000`;
      response.send(Buffer.concat([Buffer.from(packet), advertised]));
    } catch (error) { next(error); }
  });
  app.post(["/git/:projectId/git-upload-pack", "/git/:projectId/:shareToken/git-upload-pack"], raw({ type: () => true, limit: "2mb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveGitProject(request);
      const result = await context.withGitReader(runtime, () => context.gitUploadPack(runtime, [], Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0), request.get("git-protocol")));
      response.setHeader("Cache-Control", "no-store");
      response.type("application/x-git-upload-pack-result").send(result);
    } catch (error) { next(error); }
  });
  app.post("/git/:projectId/:shareToken/git-receive-pack", raw({ type: () => true, limit: "32mb" }), async (request, response, next) => {
    try {
      const { runtime, actor } = await context.resolveGitPushProject(request);
      const result = await context.withGitReader(runtime, () => context.withGitOperation(runtime, () => context.gitReceivePack(runtime, [], Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0), request.get("git-protocol"), actor)));
      if (result.sync?.status) response.setHeader("X-LaTeX-Coder-Sync", result.sync.status);
      if (result.sync) context.notifyProjectFiles(runtime.id);
      response.setHeader("Cache-Control", "no-store");
      response.type("application/x-git-receive-pack-result").send(result.output);
    } catch (error) { next(error); }
  });
}
