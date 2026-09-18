import { chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations, schemaVersion } from "./database/migrations.ts";

export type ProjectMetadata = {
  id: string;
  name: string;
  ownerUsername: string | null;
  shareToken: string;
  createdAt: string;
  membershipRole?: string;
  git?: { conflict?: { branch: string; incoming: string; base: string; createdAt: string }; [key: string]: unknown };
};

export type BuildMetadata = {
  status: string;
  main: string;
  startedAt: string | null;
  finishedAt: string | null;
  log: string;
  pdf: boolean;
  sourceRevision: string | null;
  errors?: Array<{ path: string; line: number; message: string }>;
};

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;
type ProjectRow = SqlRow & {
  id: string;
  name: string;
  owner_username: string | null;
  share_token: string;
  created_at: string;
  git_state_json: string | null;
};

const EMPTY_BUILD: BuildMetadata = {
  status: "idle",
  main: "main.tex",
  startedAt: null,
  finishedAt: null,
  log: "",
  pdf: false,
  sourceRevision: null,
};

export class StateDatabase {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(stateDir: string) {
    this.path = path.join(stateDir, "state.sqlite");
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    runMigrations(this.db);
    chmodSync(this.path, 0o600);
  }

  schemaVersion(): number {
    return schemaVersion(this.db);
  }

  ping(): boolean {
    return Number((this.db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok) === 1;
  }

  close() {
    this.db.close();
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  countUsers() {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as SqlRow).count);
  }

  firstUsername() {
    return (this.db.prepare("SELECT username FROM users ORDER BY created_at, username LIMIT 1").get() as SqlRow | undefined)?.username as string | undefined;
  }

  getUser(username: string) {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as SqlRow | undefined;
    if (!row) return null;
    return {
      username: row.username as string,
      displayName: (row.display_name || row.username) as string,
      salt: row.password_salt as string,
      hash: row.password_hash as string,
      createdAt: row.created_at as string,
      invitedBy: row.invited_by as string | null,
    };
  }

  createUser(user: { username: string; displayName: string; salt: string; hash: string; createdAt: string; invitedBy: string | null }) {
    this.db.prepare(`
      INSERT INTO users (username, display_name, password_salt, password_hash, created_at, invited_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.username, user.displayName, user.salt, user.hash, user.createdAt, user.invitedBy);
  }

  updateUserDisplayName(username: string, displayName: string) {
    const result = this.db.prepare("UPDATE users SET display_name = ? WHERE username = ?").run(displayName, username);
    return Number(result.changes) === 1;
  }

  getInvitation(tokenHash: string) {
    const row = this.db.prepare("SELECT * FROM invitations WHERE token_hash = ?").get(tokenHash) as SqlRow | undefined;
    if (!row) return null;
    return {
      tokenHash: row.token_hash as string,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
      expiresAt: Number(row.expires_at),
      usedAt: row.used_at as string | null,
      usedBy: row.used_by as string | null,
    };
  }

  createInvitation(invitation: { tokenHash: string; createdBy: string; createdAt: string; expiresAt: number }) {
    this.db.prepare(`
      INSERT INTO invitations (token_hash, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(invitation.tokenHash, invitation.createdBy, invitation.createdAt, invitation.expiresAt);
  }

  consumeInvitation(tokenHash: string, username: string, usedAt: string) {
    const result = this.db.prepare(`
      UPDATE invitations SET used_at = ?, used_by = ?
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
    `).run(usedAt, username, tokenHash, Date.now());
    return Number(result.changes) === 1;
  }

  getUserSession(tokenHash: string) {
    this.db.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").run(Date.now());
    const row = this.db.prepare("SELECT username, expires_at FROM user_sessions WHERE token_hash = ?").get(tokenHash) as SqlRow | undefined;
    return row ? { username: row.username as string, expiresAt: Number(row.expires_at) } : null;
  }

  createUserSession(tokenHash: string, username: string, expiresAt: number) {
    this.db.prepare(`
      INSERT INTO user_sessions (token_hash, username, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET username = excluded.username, expires_at = excluded.expires_at
    `).run(tokenHash, username, expiresAt);
  }

  deleteUserSession(tokenHash: string) {
    this.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(tokenHash);
  }

  getProjectSession(tokenHash: string) {
    this.db.prepare("DELETE FROM project_sessions WHERE expires_at <= ?").run(Date.now());
    const rows = this.db.prepare("SELECT project_id, share_id, expires_at FROM project_sessions WHERE token_hash = ?").all(tokenHash) as SqlRow[];
    if (!rows.length) return null;
    return {
      projects: new Set(rows.map(row => row.project_id as string)),
      shares: new Map(rows.map(row => [row.project_id as string, row.share_id as string])),
      expiresAt: Math.max(...rows.map(row => Number(row.expires_at))),
    };
  }

  addProjectSession(tokenHash: string, projectId: string, shareId: string, expiresAt: number) {
    this.transaction(() => {
      this.db.prepare("UPDATE project_sessions SET expires_at = ? WHERE token_hash = ?").run(expiresAt, tokenHash);
      this.db.prepare(`
        INSERT INTO project_sessions (token_hash, project_id, share_id, expires_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(token_hash, project_id) DO UPDATE SET
          share_id = excluded.share_id,
          expires_at = excluded.expires_at
      `).run(tokenHash, projectId, shareId, expiresAt);
    });
  }

  createProjectShare(projectId: string, id: string, username: string, token: string, tokenHash: string, createdAt: number) {
    this.db.prepare(`
      INSERT INTO project_shares (id, project_id, username, token, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, projectId, username, token, tokenHash, createdAt);
  }

  getProjectShareForUser(projectId: string, username: string) {
    const row = this.db.prepare(`
      SELECT id, project_id, username, token, created_at FROM project_shares
      WHERE project_id = ? AND username = ?
    `).get(projectId, username) as SqlRow | undefined;
    return row ? {
      id: row.id as string,
      projectId: row.project_id as string,
      username: row.username as string,
      token: row.token as string,
      createdAt: Number(row.created_at),
    } : null;
  }

  getProjectShareByToken(projectId: string, tokenHash: string) {
    const row = this.db.prepare(`
      SELECT id, project_id, username, created_at FROM project_shares WHERE project_id = ? AND token_hash = ?
    `).get(projectId, tokenHash) as SqlRow | undefined;
    return row ? {
      id: row.id as string,
      projectId: row.project_id as string,
      username: row.username as string | null,
      createdAt: Number(row.created_at),
    } : null;
  }

  rotateProjectShare(projectId: string, username: string, token: string, tokenHash: string) {
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE project_shares SET token = ?, token_hash = ? WHERE project_id = ? AND username = ?
      `).run(token, tokenHash, projectId, username);
      if (Number(result.changes) !== 1) return false;
      const share = this.getProjectShareForUser(projectId, username);
      this.db.prepare("DELETE FROM project_sessions WHERE project_id = ? AND share_id = ?").run(projectId, share!.id);
      return true;
    });
  }

  getProjectMember(projectId: string, username: string) {
    const row = this.db.prepare(`
      SELECT project_id, username, role, joined_at FROM project_members WHERE project_id = ? AND username = ?
    `).get(projectId, username) as SqlRow | undefined;
    return row ? { projectId: row.project_id as string, username: row.username as string, role: row.role as string, joinedAt: Number(row.joined_at) } : null;
  }

  addProjectMember(projectId: string, username: string, role = "collaborator", joinedAt = Date.now()) {
    this.db.prepare(`
      INSERT INTO project_members (project_id, username, role, joined_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, username) DO NOTHING
    `).run(projectId, username, role, joinedAt);
  }

  listProjectMembers(projectId: string) {
    return (this.db.prepare(`
      SELECT username, role, joined_at FROM project_members WHERE project_id = ?
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, username COLLATE NOCASE
    `).all(projectId) as SqlRow[]).map(row => ({ username: row.username as string, role: row.role as string, joinedAt: Number(row.joined_at) }));
  }

  listProjects(ownerUsername?: string | null) {
    const rows = ownerUsername
      ? this.db.prepare("SELECT * FROM projects WHERE owner_username = ? ORDER BY name COLLATE NOCASE").all(ownerUsername)
      : this.db.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE").all();
    return (rows as ProjectRow[]).map(row => this.projectFromRow(row));
  }

  listProjectsForUser(username: string) {
    const rows = this.db.prepare(`
      SELECT projects.*, project_members.role AS membership_role
      FROM project_members JOIN projects ON projects.id = project_members.project_id
      WHERE project_members.username = ? ORDER BY projects.name COLLATE NOCASE
    `).all(username) as Array<ProjectRow & { membership_role: string }>;
    return rows.map(row => ({ ...this.projectFromRow(row), membershipRole: row.membership_role as string }));
  }

  getProject(id: string) {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? this.projectFromRow(row) : null;
  }

  createProject(metadata: ProjectMetadata) {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO projects (id, name, owner_username, share_token, created_at, git_state_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        metadata.id,
        metadata.name,
        metadata.ownerUsername,
        metadata.shareToken,
        metadata.createdAt,
        metadata.git ? JSON.stringify(metadata.git) : null,
      );
      this.saveBuild(metadata.id, EMPTY_BUILD);
      if (metadata.ownerUsername) this.addProjectMember(metadata.id, metadata.ownerUsername, "owner", Date.parse(metadata.createdAt));
    });
  }

  saveProject(metadata: ProjectMetadata) {
    this.db.prepare(`
      UPDATE projects SET name = ?, owner_username = ?, share_token = ?, git_state_json = ? WHERE id = ?
    `).run(
      metadata.name,
      metadata.ownerUsername,
      metadata.shareToken,
      metadata.git ? JSON.stringify(metadata.git) : null,
      metadata.id,
    );
  }

  deleteProject(id: string) {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  getBuild(projectId: string): BuildMetadata {
    const row = this.db.prepare("SELECT * FROM builds WHERE project_id = ?").get(projectId) as SqlRow | undefined;
    if (!row) return { ...EMPTY_BUILD };
    return {
      status: String(row.status),
      main: String(row.main_file),
      startedAt: row.started_at === null ? null : String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      log: String(row.log),
      pdf: Boolean(row.has_pdf),
      sourceRevision: row.source_revision as string | null,
      errors: JSON.parse(String((this.db.prepare("SELECT errors FROM build_errors WHERE project_id = ?").get(projectId) as SqlRow | undefined)?.errors || "[]")),
    };
  }

  getSettings(projectId: string) {
    const row = this.db.prepare("SELECT compiler, auto_compile FROM project_settings WHERE project_id = ?").get(projectId) as SqlRow | undefined;
    return { main: this.getBuild(projectId).main, compiler: row?.compiler ? String(row.compiler) : "auto", autoCompile: Boolean(row?.auto_compile) };
  }

  saveSettings(projectId: string, settings: { compiler: string; autoCompile: boolean }) {
    this.db.prepare("INSERT INTO project_settings (project_id, compiler, auto_compile) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET compiler = excluded.compiler, auto_compile = excluded.auto_compile").run(projectId, settings.compiler, settings.autoCompile ? 1 : 0);
  }

  createTrash(projectId: string, id: string, originalPath: string, directory: boolean, files: Array<{ path: string; content: Uint8Array; snapshot: Uint8Array | null; directory: boolean }>) {
    this.transaction(() => {
      this.db.prepare("INSERT INTO trash_entries VALUES (?, ?, ?, ?, ?)").run(id, projectId, originalPath, directory ? 1 : 0, new Date().toISOString());
      for (const file of files) this.db.prepare("INSERT INTO trash_files VALUES (?, ?, ?, ?, ?)").run(id, file.path, file.content, file.snapshot, file.directory ? 1 : 0);
    });
  }

  listTrash(projectId: string) {
    return this.db.prepare("SELECT id, original_path AS path, directory, deleted_at AS deletedAt FROM trash_entries WHERE project_id = ? ORDER BY deleted_at DESC").all(projectId) as Array<{ id: string; path: string; directory: number; deletedAt: string }>;
  }

  getTrash(projectId: string, id: string) {
    const entry = this.db.prepare("SELECT original_path AS path, directory FROM trash_entries WHERE project_id = ? AND id = ?").get(projectId, id) as { path: string; directory: number } | undefined;
    const files = this.db.prepare("SELECT relative_path AS path, content, snapshot, directory FROM trash_files WHERE trash_id = ?").all(id) as Array<{ path: string; content: Uint8Array; snapshot: Uint8Array | null; directory: number }>;
    return entry ? { ...entry, files } : null;
  }

  removeTrash(projectId: string, id: string) {
    this.db.prepare("DELETE FROM trash_entries WHERE project_id = ? AND id = ?").run(projectId, id);
  }

  saveBuild(projectId: string, build: BuildMetadata) {
    this.db.prepare(`
      INSERT INTO builds (project_id, status, main_file, started_at, finished_at, log, has_pdf, source_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        status = excluded.status,
        main_file = excluded.main_file,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        log = excluded.log,
        has_pdf = excluded.has_pdf,
        source_revision = excluded.source_revision
    `).run(projectId, build.status, build.main, build.startedAt, build.finishedAt, build.log, build.pdf ? 1 : 0, build.sourceRevision);
    this.db.prepare("INSERT INTO build_errors VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET errors = excluded.errors").run(projectId, JSON.stringify(build.errors || []));
  }

  getYjsSnapshot(projectId: string, relativePath: string) {
    const row = this.db.prepare(`
      SELECT snapshot FROM yjs_snapshots WHERE project_id = ? AND relative_path = ?
    `).get(projectId, relativePath) as { snapshot: Uint8Array } | undefined;
    return row ? new Uint8Array(row.snapshot) : null;
  }

  saveYjsSnapshot(projectId: string, relativePath: string, snapshot: Uint8Array) {
    this.db.prepare(`
      INSERT INTO yjs_snapshots (project_id, relative_path, snapshot, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, relative_path) DO UPDATE SET
        snapshot = excluded.snapshot,
        updated_at = excluded.updated_at
    `).run(projectId, relativePath, snapshot, Date.now());
  }

  deleteYjsSnapshot(projectId: string, relativePath: string) {
    this.db.prepare("DELETE FROM yjs_snapshots WHERE project_id = ? AND relative_path = ?").run(projectId, relativePath);
  }

  private projectFromRow(row: ProjectRow): ProjectMetadata {
    return {
      id: row.id,
      name: row.name,
      ownerUsername: row.owner_username,
      shareToken: row.share_token,
      createdAt: row.created_at,
      git: row.git_state_json ? JSON.parse(row.git_state_json) : undefined,
    };
  }
}
