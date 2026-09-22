import { apiError } from "../core.ts";
import { listFiles } from "../project-files.ts";
import type { PublicRouteContext, RouteApp } from "./types.ts";

export function registerPublicRoutes(app: RouteApp, context: PublicRouteContext): void {
  app.get("/v1/project/events", context.streamProjectEvents);
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
    const representation = accepted[0]?.mediaType || (/Mozilla\//i.test(request.get("user-agent") || "") ? "text/html" : "text/markdown");
    if (representation === "text/html") {
      response.setHeader("Cache-Control", "no-store");
      return response.sendFile(`${context.appDir}/dist/index.html`);
    }
    return response.type("text/markdown; charset=utf-8").send(context.manual());
  });
  app.get(["/login", "/projects", "/projects/:projectId", "/register/:token"], (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(`${context.appDir}/dist/index.html`);
  });
  app.get("/share/:projectId/:token", async (request, response, next) => {
    try {
      const runtime = await context.loadProject(request.params.projectId);
      const editShare = context.findEditShare(runtime, request.params.token);
      const viewShare = context.findViewShare(runtime, request.params.token);
      const share = editShare || viewShare;
      if (!share) throw apiError("share_link_invalid", "project share link is invalid", 403);
      const accessMode = editShare ? "edit" : "view";
      const user = context.currentUser(request);
      if (user) context.database.addProjectMember(runtime.id, user.username, accessMode === "edit" ? "collaborator" : "viewer");
      else context.issueProjectSession(request, response, runtime.id, share.id, accessMode);
      response.redirect(303, `/projects/${encodeURIComponent(runtime.id)}`);
    } catch (error) { next(error); }
  });
  app.get(["/agent/:projectId/:token", "/agent/:projectId/:token/propose"], async (request, response, next) => {
    try {
      const runtime = await context.loadProject(request.params.projectId);
      const proposal = request.path.endsWith("/propose");
      const share = proposal ? context.findProposalShare(runtime, request.params.token) : context.findEditShare(runtime, request.params.token);
      if (!share) throw apiError("agent_link_invalid", "Agent link is invalid", 403);
      response.setHeader("Cache-Control", "no-store");
      response.type("text/plain; charset=utf-8").send(context.agentProjectManual(runtime, await listFiles(runtime.projectDir), String(request.params.token), `${request.protocol}://${request.get("host")}`, proposal));
    } catch (error) { next(error); }
  });
  app.get("/health/live", (_request, response) => response.json({ ok: true, status: "live", name: "latexcoder" }));
  app.get(["/health", "/health/ready"], (_request, response) => {
    const health = context.readiness();
    response.status(health.ok ? 200 : 503).json(health);
  });
}
