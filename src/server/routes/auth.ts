import { apiError, cleanDisplayName, cleanUsername, passwordMatches, passwordRecord, randomToken, sessionCookie, sha256, validatePassword } from "../core.ts";
import { createInvitationRequestSchema, loginRequestSchema, registerRequestSchema, updateProfileRequestSchema } from "../../shared/api-schema.ts";
import type { ZodType } from "zod";
import type { AuthRouteContext, RouteApp } from "./types.ts";

function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw apiError("invalid_request", "request body is invalid", 400, {
    issues: result.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })),
  });
}

function invitationIsValid(invitation: ReturnType<AuthRouteContext["database"]["getInvitation"]>): boolean {
  return Boolean(invitation && invitation.expiresAt > Date.now() && (invitation.reusable || !invitation.usedAt));
}

export function registerAuthRoutes(app: RouteApp, context: AuthRouteContext): void {
  const { database, json } = context;

  app.get("/v1/auth/me", (request, response) => {
    response.json({
      user: context.currentUser(request),
      invitationOnly: true,
      bootstrapReady: database.countUsers() > 0,
    });
  });
  app.post("/v1/auth/login", json({ limit: "16kb" }), (request, response, next) => {
    try {
      const body = parseBody(loginRequestSchema, request.body);
      const attemptKey = request.ip || request.socket.remoteAddress || "unknown";
      let attempts = context.loginAttempts.get(attemptKey);
      if (!attempts || attempts.resetAt <= Date.now()) {
        attempts = { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
        context.loginAttempts.set(attemptKey, attempts);
      }
      if (attempts.count >= 10) throw apiError("login_rate_limited", "too many login attempts; try again later", 429);
      const username = cleanUsername(body.username);
      const user = database.getUser(username);
      if (!user || !passwordMatches(body.password, user)) {
        attempts.count += 1;
        throw apiError("invalid_credentials", "username or password is incorrect", 401);
      }
      context.loginAttempts.delete(attemptKey);
      context.issueUserSession(request, response, username);
      response.json({ user: { username, displayName: user.displayName } });
    } catch (error) { next(error); }
  });
  app.post("/v1/auth/logout", (request, response) => {
    const session = context.userSession(request);
    if (session) database.deleteUserSession(session.key);
    response.append("Set-Cookie", sessionCookie(request, "lc_user", "", 0));
    response.json({ user: null });
  });
  app.patch("/v1/users/me", json({ limit: "16kb" }), (request, response, next) => {
    try {
      const user = context.requireUser(request);
      const displayName = cleanDisplayName(parseBody(updateProfileRequestSchema, request.body).displayName);
      if (!database.updateUserDisplayName(user.username, displayName)) throw apiError("user_not_found", "user does not exist", 404);
      response.json({ user: { username: user.username, displayName } });
    } catch (error) { next(error); }
  });
  app.get("/v1/invitations/:token", (request, response, next) => {
    try {
      const invitation = database.getInvitation(sha256(String(request.params.token || "")));
      if (!invitationIsValid(invitation)) throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
      response.json({ invitation: { invitedBy: invitation!.createdBy, expiresAt: new Date(invitation!.expiresAt).toISOString(), reusable: invitation!.reusable } });
    } catch (error) { next(error); }
  });
  app.post("/v1/invitations", json({ limit: "1kb" }), (request, response, next) => {
    try {
      const user = context.requireUser(request);
      const { reusable } = parseBody(createInvitationRequestSchema, request.body ?? {});
      const token = randomToken();
      const createdAt = new Date();
      database.createInvitation({
        tokenHash: sha256(token),
        createdBy: user.username,
        createdAt: createdAt.toISOString(),
        expiresAt: createdAt.getTime() + context.invitationSeconds * 1000,
        reusable,
      });
      response.status(201).json({ invitation: { token, path: `/register/${token}`, reusable } });
    } catch (error) { next(error); }
  });
  app.post("/v1/auth/register", json({ limit: "16kb" }), (request, response, next) => {
    try {
      const body = parseBody(registerRequestSchema, request.body);
      const tokenHash = sha256(body.token);
      const invitation = database.getInvitation(tokenHash);
      if (!invitationIsValid(invitation)) {
        throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
      }
      const username = cleanUsername(body.username);
      if (database.getUser(username)) throw apiError("username_taken", "username is already registered", 409);
      const password = validatePassword(body.password);
      const createdAt = new Date().toISOString();
      database.transaction(() => {
        const current = database.getInvitation(tokenHash);
        if (!invitationIsValid(current)) {
          throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
        }
        database.createUser({ username, displayName: username, ...passwordRecord(password), createdAt, invitedBy: current.createdBy });
        if (!current!.reusable && !database.consumeInvitation(tokenHash, username, createdAt)) {
          throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
        }
      });
      context.issueUserSession(request, response, username);
      response.status(201).json({ user: { username, displayName: username } });
    } catch (error) { next(error); }
  });
}
