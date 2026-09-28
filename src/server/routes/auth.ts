import { randomUUID } from "node:crypto";
import { parseSshPublicKey } from "../ssh-keys.ts";
import { apiError, cleanDisplayName, cleanUsername, passwordMatches, passwordRecord, randomToken, sessionCookie, sha256, validatePassword } from "../core.ts";
import { createInvitationRequestSchema, loginRequestSchema, passwordResetRequestSchema, registerRequestSchema, updateProfileRequestSchema } from "../../shared/api-schema.ts";
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

function passwordResetIsValid(reset: ReturnType<AuthRouteContext["database"]["getPasswordReset"]>): boolean {
  return Boolean(reset && !reset.deletedAt && !reset.usedAt && reset.expiresAt > Date.now());
}

export function registerAuthRoutes(app: RouteApp, context: AuthRouteContext): void {
  const { database, json } = context;

  app.get("/v1/auth/me", (request, response) => {
    response.json({
      user: context.currentUser(request),
      invitationOnly: true,
      bootstrapReady: database.countUsers() > 0,
      features: { sshGit: context.sshGitEnabled() },
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
      if (!user || user.deletedAt || !passwordMatches(body.password, user)) {
        attempts.count += 1;
        throw apiError("invalid_credentials", "username or password is incorrect", 401);
      }
      context.loginAttempts.delete(attemptKey);
      context.issueUserSession(request, response, username);
      response.json({ user: { username, displayName: user.displayName, isAdmin: user.isAdmin, userType: user.userType } });
    } catch (error) { next(error); }
  });
  app.post("/v1/auth/logout", (request, response) => {
    const session = context.userSession(request);
    if (session) database.deleteUserSession(session.key);
    response.append("Set-Cookie", sessionCookie(request, "lc_user", "", 0));
    response.json({ user: null });
  });
  app.get("/v1/auth/password-reset/:token", (request, response, next) => {
    try {
      const reset = database.getPasswordReset(sha256(String(request.params.token || "")));
      if (!passwordResetIsValid(reset)) throw apiError("password_reset_invalid", "password reset link is invalid, expired, or already used", 404);
      response.json({ reset: { username: reset!.username, displayName: reset!.displayName, expiresAt: new Date(reset!.expiresAt).toISOString() } });
    } catch (error) { next(error); }
  });
  app.post("/v1/auth/password-reset", json({ limit: "16kb" }), (request, response, next) => {
    try {
      const body = parseBody(passwordResetRequestSchema, request.body);
      const record = passwordRecord(validatePassword(body.password));
      const username = database.consumePasswordReset(sha256(body.token), record.salt, record.hash, Date.now());
      if (!username) throw apiError("password_reset_invalid", "password reset link is invalid, expired, or already used", 404);
      const user = database.getUser(username)!;
      context.issueUserSession(request, response, username);
      response.json({ user: { username, displayName: user.displayName, isAdmin: user.isAdmin, userType: user.userType } });
    } catch (error) { next(error); }
  });
  app.patch("/v1/users/me", json({ limit: "16kb" }), (request, response, next) => {
    try {
      const user = context.requireUser(request);
      const displayName = cleanDisplayName(parseBody(updateProfileRequestSchema, request.body).displayName);
      if (!database.updateUserDisplayName(user.username, displayName)) throw apiError("user_not_found", "user does not exist", 404);
      response.json({ user: { username: user.username, displayName, isAdmin: user.isAdmin, userType: user.userType } });
    } catch (error) { next(error); }
  });
  app.get("/v1/users/me/ssh-keys", (request, response, next) => {
    try {
      const user = context.requireUser(request);
      response.setHeader("Cache-Control", "no-store");
      response.json({ keys: database.listSshKeys(user.username) });
    } catch (error) { next(error); }
  });
  app.post("/v1/users/me/ssh-keys", json({ limit: "20kb" }), (request, response, next) => {
    try {
      const user = context.requireUser(request);
      const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
      if (!title || title.length > 80) throw apiError("invalid_ssh_key_title", "Key title must contain 1 to 80 characters.", 400);
      const parsed = parseSshPublicKey(request.body?.publicKey);
      if (database.getSshKey(parsed.fingerprint)) throw apiError("ssh_key_exists", "This public key is already registered.", 409);
      if (database.listSshKeys(user.username).length >= 50) throw apiError("ssh_key_limit", "Remove an unused key before adding another.", 400);
      const key = { id: randomUUID(), username: user.username, title, ...parsed, createdAt: new Date().toISOString() };
      database.addSshKey(key);
      response.status(201).json({ key });
    } catch (error) { next(error); }
  });
  app.delete("/v1/users/me/ssh-keys/:id", (request, response, next) => {
    try {
      const user = context.requireUser(request);
      if (!database.deleteSshKey(user.username, String(request.params.id))) throw apiError("ssh_key_not_found", "SSH key not found.", 404);
      response.json({ ok: true });
    } catch (error) { next(error); }
  });
  app.get("/v1/invitations/:token", (request, response, next) => {
    try {
      const invitation = database.getInvitation(sha256(String(request.params.token || "")));
      if (!invitationIsValid(invitation)) throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
      response.json({ invitation: { invitedBy: invitation!.createdBy, expiresAt: new Date(invitation!.expiresAt).toISOString(), reusable: invitation!.reusable, userType: invitation!.userType } });
    } catch (error) { next(error); }
  });
  app.post("/v1/invitations", json({ limit: "1kb" }), (request, response, next) => {
    try {
      const user = context.requireUser(request);
      if (!user.isAdmin && user.userType !== "internal") {
        throw apiError("invitation_forbidden", "external users cannot invite new users", 403);
      }
      const { reusable, userType } = parseBody(createInvitationRequestSchema, request.body ?? {});
      const token = randomToken();
      const createdAt = new Date();
      database.createInvitation({
        tokenHash: sha256(token),
        createdBy: user.username,
        createdAt: createdAt.toISOString(),
        expiresAt: createdAt.getTime() + context.invitationSeconds * 1000,
        reusable,
        userType,
      });
      response.status(201).json({ invitation: { token, path: `/register/${token}`, reusable, userType } });
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
        database.createUser({ username, displayName: username, ...passwordRecord(password), createdAt, invitedBy: current.createdBy, userType: current.userType });
        if (!current!.reusable && !database.consumeInvitation(tokenHash, username, createdAt)) {
          throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
        }
      });
      context.issueUserSession(request, response, username);
      response.status(201).json({ user: { username, displayName: username, isAdmin: false, userType: invitation!.userType } });
    } catch (error) { next(error); }
  });
}
