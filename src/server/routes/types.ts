import type { Express, Request, RequestHandler, Response } from "express";

import type { StateDatabase } from "../database.ts";
import type { BlameActor, ProjectFile, ProjectRuntime, ServerOptions } from "../types.ts";
import type { ProjectMetadata } from "../database.ts";
import type { createProjectSearch } from "../search.ts";

export type RouteApp = Express;

export type JsonMiddleware = (options: { limit: string }) => RequestHandler;
export type RawMiddleware = (options: { type: (() => boolean) | string; limit: string | number }) => RequestHandler;

export type AuthenticatedUser = { username: string; displayName: string; isAdmin: boolean };
export type UserSession = { key: string; token: string; record: { username: string } };

export interface AuthRouteContext {
  database: StateDatabase;
  currentUser(request: Request): AuthenticatedUser | null;
  issueUserSession(request: Request, response: Response, username: string): void;
  json: JsonMiddleware;
  loginAttempts: Map<string, { count: number; resetAt: number }>;
  requireUser(request: Request): AuthenticatedUser;
  userSession(request: Request): UserSession | null;
  invitationSeconds: number;
}

export interface AdminRouteContext {
  database: StateDatabase;
  deleteProject(runtime: ProjectRuntime): Promise<{ defaultProjectId: string | null }>;
  json: JsonMiddleware;
  loadProject(id: unknown): Promise<ProjectRuntime>;
  requireAdmin(request: Request): AuthenticatedUser;
}

export interface GitRouteContext {
  gitCheckpoint(runtime: ProjectRuntime, message: unknown): Promise<{ commit: string; created: boolean }>;
  gitReceivePack(runtime: ProjectRuntime, args: string[], input: Uint8Array, protocol?: string, actor?: BlameActor): Promise<{ output: Buffer; sync: { status?: string } | null }>;
  gitResolve(runtime: ProjectRuntime, message: unknown): Promise<Record<string, unknown>>;
  gitStatus(runtime: ProjectRuntime): Promise<Record<string, unknown>>;
  gitSync(runtime: ProjectRuntime, requestedRef: string): Promise<Record<string, unknown>>;
  gitUploadPack(runtime: ProjectRuntime, args: string[], input: Uint8Array, protocol?: string): Promise<Buffer>;
  json: JsonMiddleware;
  notifyProjectFiles(projectId: string): void;
  prepareGitPull(runtime: ProjectRuntime): Promise<{ commit: string; created: boolean }>;
  raw: RawMiddleware;
  resolveGitProject(request: Request): Promise<ProjectRuntime>;
  resolveGitPushProject(request: Request): Promise<{ runtime: ProjectRuntime; actor: BlameActor }>;
  resolveProject(request: Request): Promise<ProjectRuntime>;
  withGitOperation<T>(runtime: ProjectRuntime, task: () => Promise<T>): Promise<T>;
  withGitReader<T>(runtime: ProjectRuntime, task: () => Promise<T>): Promise<T>;
  withLiveGitOperation<T>(runtime: ProjectRuntime, task: () => Promise<T>): Promise<T>;
}

export interface BuildRouteContext {
  compileProject: (runtime: ProjectRuntime, main: string) => Promise<{ success: boolean; build: ProjectRuntime["build"] }>;
  database: StateDatabase;
  ensureLatestPdf: (runtime: ProjectRuntime) => Promise<ProjectRuntime["build"]>;
  json: JsonMiddleware;
  options: ServerOptions;
  resolveProject(request: Request): Promise<ProjectRuntime>;
}

export interface ProjectSummary {
  id: string;
  archived: boolean;
  [key: string]: unknown;
}

export interface ProjectRouteContext {
  assertProjectWritable(runtime: ProjectRuntime): void;
  cleanProjectName(value: unknown): string;
  cleanProjectTags(tags: string[]): string[];
  createProject(name: unknown, ownerUsername: string | null, importedFiles?: Array<{ relativePath: string; content: Uint8Array }>): Promise<ProjectRuntime>;
  database: StateDatabase;
  deleteProject(runtime: ProjectRuntime): Promise<{ defaultProjectId: string | null }>;
  isProjectOwner(request: Request, runtime: ProjectRuntime): boolean;
  json: JsonMiddleware;
  memberProjectShare(runtime: ProjectRuntime, username: string): Record<string, string>;
  membershipAccessMode(request: Request, runtime: ProjectRuntime): "view" | "edit" | null;
  projectAccessMode(request: Request, runtime: ProjectRuntime): "view" | "edit" | null;
  projectMembership(request: Request, runtime: ProjectRuntime): { role: string; archived: boolean } | null;
  projectSummaries(username?: string | null): Promise<ProjectSummary[]>;
  publicProjectMetadata(metadata: ProjectMetadata): Omit<ProjectMetadata, "shareToken" | "ownerUsername">;
  raw: RawMiddleware;
  requireProjectMember(request: Request, runtime: ProjectRuntime): { role: string; archived: boolean };
  requireProjectOwner(request: Request, runtime: ProjectRuntime): void;
  requireUser(request: Request): AuthenticatedUser;
  resolveProject(request: Request): Promise<ProjectRuntime>;
  loadProject(id: unknown): Promise<ProjectRuntime>;
  rotateShare(runtime: ProjectRuntime, username: string): Record<string, string>;
  withGitReader<T>(runtime: ProjectRuntime, task: () => Promise<T>): Promise<T>;
  createProjectArchive(runtime: ProjectRuntime): Promise<{ archive: string; temporary: string }>;
}

export interface SearchRouteContext {
  assertProjectWritable(runtime: ProjectRuntime): void;
  json: JsonMiddleware;
  options: ServerOptions;
  projectSearch: ReturnType<typeof createProjectSearch>;
  resolveProject(request: Request): Promise<ProjectRuntime>;
}

export interface FileRouteContext {
  assertProjectWritable(runtime: ProjectRuntime): void;
  database: StateDatabase;
  gitAuthorForCommit(projectDir: string, commit: string): Promise<{ name: string; email: string } | null>;
  gitCheckpoint(runtime: ProjectRuntime, message: unknown, metadata?: Record<string, unknown>): Promise<{ commit: string; created: boolean }>;
  isProposalAccess(runtime: ProjectRuntime, access: unknown): boolean;
  json: JsonMiddleware;
  raw: RawMiddleware;
  requestBlameActor(request: Request): BlameActor;
  resolveProject(request: Request): Promise<ProjectRuntime>;
  withAgentHistory<T>(request: Request, runtime: ProjectRuntime, label: string, task: () => Promise<T> | T, always?: boolean): Promise<T>;
  withGitOperation<T>(runtime: ProjectRuntime, task: () => Promise<T>): Promise<T>;
  withGitReader<T>(runtime: ProjectRuntime, task: () => Promise<T>): Promise<T>;
}

export interface HistoryRouteContext {
  database: StateDatabase;
  git(projectDir: string, args: string[]): Promise<{ output: string }>;
  gitCheckpoint(runtime: ProjectRuntime, message: unknown, metadata?: Record<string, unknown>): Promise<{ commit: string; created: boolean }>;
  importGitWorktree(runtime: ProjectRuntime, sourceDir: string, main?: string, validateReviews?: boolean): Promise<void>;
  json: JsonMiddleware;
  notifyProjectFiles(projectId: string): void;
  resolveProject(request: Request): Promise<ProjectRuntime>;
  trackedPaths(projectDir: string): Promise<string[]>;
  withGitOperation<T>(runtime: ProjectRuntime, task: () => Promise<T>): Promise<T>;
  withGitReader<T>(runtime: ProjectRuntime, task: () => Promise<T>): Promise<T>;
  withTemporaryWorktree<T>(runtime: ProjectRuntime, commit: string, task: (directory: string) => Promise<T>): Promise<T>;
}

export interface PublicRouteContext {
  agentProjectManual(runtime: ProjectRuntime, files: ProjectFile[], shareToken: string, origin: string, proposal?: boolean): string;
  appDir: string;
  currentUser(request: Request): AuthenticatedUser | null;
  database: StateDatabase;
  findEditShare(runtime: ProjectRuntime, token: unknown): { id: string } | null;
  findProposalShare(runtime: ProjectRuntime, token: unknown): { id: string } | null;
  findViewShare(runtime: ProjectRuntime, token: unknown): { id: string } | null;
  issueProjectSession(request: Request, response: Response, projectId: string, shareId: string | null, accessMode: "view" | "edit"): void;
  loadProject(id: unknown): Promise<ProjectRuntime>;
  manual(): string;
  readiness(): { ok: boolean; [key: string]: unknown };
  streamProjectEvents: RequestHandler;
}
