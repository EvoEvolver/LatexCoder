import { chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ProjectMetadata = {
  id: string;
  name: string;
  ownerUsername: string | null;
  shareToken: string;
  createdAt: string;
  git?: Record<string, unknown>;
};

export type BuildMetadata = {
  status: string;
  main: string;
  startedAt: string | null;
  finishedAt: string | null;
  log: string;
  pdf: boolean;
};

const EMPTY_BUILD: BuildMetadata = {
  status: "idle",
  main: "main.tex",
  startedAt: null,
  finishedAt: null,
  log: "",
  pdf: false,
};

export class StateDatabase {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(stateDir: string) {
    this.path = path.join(stateDir, "state.sqlite");
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        invited_by TEXT REFERENCES users(username)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS invitations (
        token_hash TEXT PRIMARY KEY,
        created_by TEXT NOT NULL REFERENCES users(username),
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at TEXT,
        used_by TEXT REFERENCES users(username)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_username TEXT,
        share_token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        git_state_json TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_username, name);

      CREATE TABLE IF NOT EXISTS project_shares (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS project_shares_project_idx ON project_shares(project_id, created_at);

      CREATE TABLE IF NOT EXISTS project_sessions (
        token_hash TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        share_id TEXT,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (token_hash, project_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS project_sessions_expiry_idx ON project_sessions(expires_at);

      CREATE TABLE IF NOT EXISTS builds (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        main_file TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        log TEXT NOT NULL,
        has_pdf INTEGER NOT NULL CHECK (has_pdf IN (0, 1))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS yjs_snapshots (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        snapshot BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, relative_path)
      ) STRICT;
    `);
    const projectSessionColumns = this.db.prepare("PRAGMA table_info(project_sessions)").all() as any[];
    if (!projectSessionColumns.some(column => column.name === "share_id")) {
      this.db.exec("ALTER TABLE project_sessions ADD COLUMN share_id TEXT;");
      this.db.exec("DELETE FROM project_sessions WHERE share_id IS NULL;");
    }
    this.db.exec("PRAGMA user_version = 2;");
    chmodSync(this.path, 0o600);
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
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as any).count);
  }

  firstUsername() {
    return (this.db.prepare("SELECT username FROM users ORDER BY created_at, username LIMIT 1").get() as any)?.username as string | undefined;
  }

  getUser(username: string) {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
    if (!row) return null;
    return {
      username: row.username as string,
      salt: row.password_salt as string,
      hash: row.password_hash as string,
      createdAt: row.created_at as string,
      invitedBy: row.invited_by as string | null,
    };
  }

  createUser(user: { username: string; salt: string; hash: string; createdAt: string; invitedBy: string | null }) {
    this.db.prepare(`
      INSERT INTO users (username, password_salt, password_hash, created_at, invited_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.username, user.salt, user.hash, user.createdAt, user.invitedBy);
  }

  getInvitation(tokenHash: string) {
    const row = this.db.prepare("SELECT * FROM invitations WHERE token_hash = ?").get(tokenHash) as any;
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
    const row = this.db.prepare("SELECT username, expires_at FROM user_sessions WHERE token_hash = ?").get(tokenHash) as any;
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
    const rows = this.db.prepare("SELECT project_id, share_id, expires_at FROM project_sessions WHERE token_hash = ?").all(tokenHash) as any[];
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

  createProjectShare(projectId: string, id: string, tokenHash: string, createdAt: number) {
    this.db.prepare(`
      INSERT INTO project_shares (id, project_id, token_hash, created_at) VALUES (?, ?, ?, ?)
    `).run(id, projectId, tokenHash, createdAt);
  }

  getProjectShareByToken(projectId: string, tokenHash: string) {
    const row = this.db.prepare(`
      SELECT id, project_id, created_at FROM project_shares WHERE project_id = ? AND token_hash = ?
    `).get(projectId, tokenHash) as any;
    return row ? { id: row.id as string, projectId: row.project_id as string, createdAt: Number(row.created_at) } : null;
  }

  rotateProjectShare(projectId: string, shareId: string, tokenHash: string) {
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE project_shares SET token_hash = ? WHERE id = ? AND project_id = ?
      `).run(tokenHash, shareId, projectId);
      if (Number(result.changes) !== 1) return false;
      this.db.prepare("DELETE FROM project_sessions WHERE project_id = ? AND share_id = ?").run(projectId, shareId);
      return true;
    });
  }

  listProjects(ownerUsername?: string | null) {
    const rows = ownerUsername
      ? this.db.prepare("SELECT * FROM projects WHERE owner_username = ? ORDER BY name COLLATE NOCASE").all(ownerUsername)
      : this.db.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE").all();
    return (rows as any[]).map(row => this.projectFromRow(row));
  }

  getProject(id: string) {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
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
    const row = this.db.prepare("SELECT * FROM builds WHERE project_id = ?").get(projectId) as any;
    if (!row) return { ...EMPTY_BUILD };
    return {
      status: row.status,
      main: row.main_file,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      log: row.log,
      pdf: Boolean(row.has_pdf),
    };
  }

  saveBuild(projectId: string, build: BuildMetadata) {
    this.db.prepare(`
      INSERT INTO builds (project_id, status, main_file, started_at, finished_at, log, has_pdf)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        status = excluded.status,
        main_file = excluded.main_file,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        log = excluded.log,
        has_pdf = excluded.has_pdf
    `).run(projectId, build.status, build.main, build.startedAt, build.finishedAt, build.log, build.pdf ? 1 : 0);
  }

  getYjsSnapshot(projectId: string, relativePath: string) {
    const row = this.db.prepare(`
      SELECT snapshot FROM yjs_snapshots WHERE project_id = ? AND relative_path = ?
    `).get(projectId, relativePath) as any;
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

  private projectFromRow(row: any): ProjectMetadata {
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
