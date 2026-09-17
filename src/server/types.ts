import type { SpawnOptionsWithoutStdio } from "node:child_process";
import type { Server } from "node:http";
import type { Application } from "express";
import type { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type * as Y from "yjs";
import type { BuildMetadata, ProjectMetadata, StateDatabase } from "./database.ts";

export type ApiError = Error & { code: string; status: number; details?: Record<string, unknown> };
export type PasswordRecord = { salt: string; hash: string };
export type AgentIdentity = { id: string; name: string };
export type ProjectFile = { path: string; size: number; text: boolean };
export type ImportedProjectFile = { relativePath: string; content: Uint8Array };
export type ContentEntry = { path: string; directory: boolean };
export type SearchMatch = { path: string; line: number; from: number; to: number; text: string };
export type SearchInput = { query?: unknown; caseSensitive?: boolean; regex?: boolean; path?: unknown; replacement?: unknown };
export type ReplacementFile = { path: string; baseSha256: string; before: string; source: string; count: number };
export type SearchOptions = { bwrap?: string; rg?: string; searchTimeoutMs?: number };
export type ServerOptions = SearchOptions & { stateDir?: string; authDisabled?: boolean; adminPassword?: string; compiler?: string; synctex?: string; host?: string; port?: number };
export type ProcessResult = { code: number | null; output: string };
export type RipgrepResult = { code: number | null; stdout: Buffer; stderr: Buffer };
export type ProcessOptions = SpawnOptionsWithoutStdio & { timeoutMs?: number };
export type RipgrepOptions = SearchOptions & { timeoutMs?: number };
export type PatchChange = { from: number; to: number; insert: string };
export type EditMode = "direct" | "suggesting";
export type EditOptions = { mode?: EditMode; agent?: AgentIdentity };
export type EditResult = { source: string; sha256: string; mode: EditMode; suggestionIds: string[]; changeCount?: number };

export interface CollaborationStore {
  attach(connection: WebSocket, relativePath: string, shareId?: string | null, savedAcknowledgments?: boolean): void;
  disconnectShare(shareId: string, reason: string): void;
  editFile(relativePath: string, baseSha256: string, updated: string, options?: EditOptions): EditResult;
  flush(): void;
  importText(relativePath: string, source: string): void;
  load(relativePath: string): SharedDocument;
  patchText(relativePath: string, baseSha256: string, changes: PatchChange[], options?: EditOptions): EditResult;
  readText(relativePath: string): string;
  remove(relativePath: string): Promise<void>;
  replaceText(relativePath: string, source: string): boolean;
  resume(): void;
  roomNameForPath(relativePath: string): string;
  shutdown(): void;
  suspend(): void;
}

export interface SharedDocument {
  relativePath: string;
  doc: Y.Doc;
  awareness: import("y-protocols/awareness").Awareness;
  connections: Map<WebSocket, Set<number>>;
  persistTimer?: ReturnType<typeof setTimeout>;
  removed: boolean;
  saveRequests: Map<WebSocket, string>;
}

export interface ProjectRuntime {
  id: string;
  metadata: ProjectMetadata;
  projectRoot: string;
  projectDir: string;
  buildDir: string;
  database: StateDatabase;
  collaboration: CollaborationStore;
  build: BuildMetadata;
  compilePromise: Promise<{ success: boolean; build: BuildMetadata }> | null;
  gitBusy: boolean;
  gitReaders: number;
  gitReaderWaiters: Array<(value?: void) => void>;
  deleting: boolean;
}

export interface PaperServer {
  app: Application;
  server: Server;
  sockets: WebSocketServer;
  stateDir: string;
  projectsDir: string;
  projects: Map<string, ProjectRuntime>;
  database: StateDatabase;
  shutdown(): void;
  projectDir?: string;
  collaboration?: CollaborationStore;
}
