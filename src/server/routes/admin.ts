import { adminUpdateUserTypeRequestSchema } from "../../shared/api-schema.ts";
import { apiError, randomToken, sha256 } from "../core.ts";
import type { AdminRouteContext, RouteApp } from "./types.ts";

function pagination(query: Record<string, unknown>): { page: number; limit: number; search: string } {
  const page = Math.max(1, Math.trunc(Number(query.page) || 1));
  const limit = Math.min(100, Math.max(10, Math.trunc(Number(query.limit) || 50)));
  const search = typeof query.q === "string" ? query.q.trim().slice(0, 120) : "";
  return { page, limit, search };
}

export function registerAdminRoutes(app: RouteApp, context: AdminRouteContext): void {
  const { database, json } = context;

  app.get("/v1/admin/users", (request, response, next) => {
    try {
      context.requireAdmin(request);
      const { page, limit, search } = pagination(request.query);
      const result = database.listAdminUsers(search, limit, (page - 1) * limit);
      response.json({ ...result, page, limit });
    } catch (error) { next(error); }
  });

  app.get("/v1/admin/projects", (request, response, next) => {
    try {
      context.requireAdmin(request);
      const { page, limit, search } = pagination(request.query);
      const result = database.listAdminProjects(search, limit, (page - 1) * limit);
      response.json({ ...result, page, limit });
    } catch (error) { next(error); }
  });

  app.post("/v1/admin/users/:username/password-reset", (request, response, next) => {
    try {
      const admin = context.requireAdmin(request);
      const username = String(request.params.username);
      const token = randomToken();
      const createdAt = Date.now();
      const expiresAt = createdAt + context.passwordResetSeconds * 1000;
      if (!database.createPasswordReset({
        tokenHash: sha256(token), username, createdBy: admin.username, createdAt, expiresAt,
      })) {
        throw apiError("user_not_found", "active user does not exist", 404);
      }
      response.status(201).json({
        reset: { username, path: `/reset-password/${token}`, expiresAt: new Date(expiresAt).toISOString() },
      });
    } catch (error) { next(error); }
  });

  app.patch("/v1/admin/users/:username/type", json({ limit: "1kb" }), (request, response, next) => {
    try {
      context.requireAdmin(request);
      const parsed = adminUpdateUserTypeRequestSchema.safeParse(request.body);
      if (!parsed.success) throw apiError("invalid_request", "userType must be internal or external", 400);
      const username = String(request.params.username);
      if (!database.updateUserType(username, parsed.data.userType)) {
        throw apiError("user_type_locked", "active non-admin user does not exist or cannot be changed", 409);
      }
      response.json({ user: { username, userType: parsed.data.userType } });
    } catch (error) { next(error); }
  });

  app.delete("/v1/admin/users/:username", (request, response, next) => {
    try {
      const admin = context.requireAdmin(request);
      const username = String(request.params.username);
      if (username === admin.username) throw apiError("admin_self_delete", "administrators cannot delete their own account", 409);
      if (!database.softDeleteUser(username, new Date().toISOString())) {
        throw apiError("user_not_found", "active non-admin user does not exist", 404);
      }
      response.json({ user: { username, deleted: true }, sessionsRevoked: true });
    } catch (error) { next(error); }
  });

  app.delete("/v1/admin/projects/:projectId", async (request, response, next) => {
    try {
      context.requireAdmin(request);
      const runtime = await context.loadProject(request.params.projectId);
      await context.deleteProject(runtime);
      response.json({ project: { id: runtime.id, deleted: true } });
    } catch (error) { next(error); }
  });
}
