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
  lastOpenedAt: string;
  membershipRole?: string;
  membershipArchived?: boolean;
  tags?: string[];
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

export type BlameChange = {
  id: string;
  projectId: string;
  authorId: string;
  authorName: string;
  createdAt: number;
  commit: string | null;
};

export type UserType = "internal" | "external";

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;
type ProjectRow = SqlRow & {
  id: string;
  name: string;
  owner_username: string | null;
  share_token: string;
  created_at: string;
  last_opened_at: string | null;
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
    return (this.db.prepare("SELECT username FROM users WHERE deleted_at IS NULL ORDER BY created_at, username LIMIT 1").get() as SqlRow | undefined)?.username as string | undefined;
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
      isAdmin: Boolean(row.is_admin),
      userType: row.user_type as UserType,
      deletedAt: row.deleted_at as string | null,
    };
  }

  createUser(user: { username: string; displayName: string; salt: string; hash: string; createdAt: string; invitedBy: string | null; isAdmin?: boolean; userType?: UserType }) {
    this.db.prepare(`
      INSERT INTO users (username, display_name, password_salt, password_hash, created_at, invited_by, is_admin, user_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.username, user.displayName, user.salt, user.hash, user.createdAt, user.invitedBy, Number(user.isAdmin || false), user.userType || "internal");
  }

  listAdminUsers(query: string, limit: number, offset: number) {
    const search = `%${query}%`;
    const where = query ? "WHERE users.username LIKE ? ESCAPE '\\' OR users.display_name LIKE ? ESCAPE '\\'" : "";
    const parameters = query ? [search, search] : [];
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM users ${where}`).get(...parameters) as SqlRow).count);
    const rows = this.db.prepare(`
      SELECT users.username, users.display_name, users.created_at, users.invited_by, users.is_admin, users.user_type, users.deleted_at,
        COUNT(DISTINCT project_members.project_id) AS project_count,
        COUNT(DISTINCT CASE WHEN project_members.role = 'owner' THEN project_members.project_id END) AS owned_project_count
      FROM users LEFT JOIN project_members ON project_members.username = users.username
      ${where}
      GROUP BY users.username
      ORDER BY users.deleted_at IS NOT NULL, users.is_admin DESC, users.created_at, users.username COLLATE NOCASE
      LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset) as SqlRow[];
    return { total, items: rows.map(row => ({
      username: row.username as string,
      displayName: row.display_name as string,
      createdAt: row.created_at as string,
      invitedBy: row.invited_by as string | null,
      isAdmin: Boolean(row.is_admin),
      userType: row.user_type as UserType,
      deletedAt: row.deleted_at as string | null,
      projectCount: Number(row.project_count),
      ownedProjectCount: Number(row.owned_project_count),
    })) };
  }

  listAdminProjects(query: string, limit: number, offset: number) {
    const search = `%${query}%`;
    const where = query ? "WHERE projects.id LIKE ? ESCAPE '\\' OR projects.name LIKE ? ESCAPE '\\' OR projects.owner_username LIKE ? ESCAPE '\\'" : "";
    const parameters = query ? [search, search, search] : [];
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM projects ${where}`).get(...parameters) as SqlRow).count);
    const rows = this.db.prepare(`
      SELECT projects.id, projects.name, projects.owner_username, projects.created_at, projects.last_opened_at,
        users.display_name AS owner_display_name, users.deleted_at AS owner_deleted_at,
        COUNT(project_members.username) AS member_count
      FROM projects
      LEFT JOIN users ON users.username = projects.owner_username
      LEFT JOIN project_members ON project_members.project_id = projects.id
      ${where}
      GROUP BY projects.id
      ORDER BY projects.last_opened_at DESC, projects.name COLLATE NOCASE
      LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset) as SqlRow[];
    return { total, items: rows.map(row => ({
      id: row.id as string,
      name: row.name as string,
      ownerUsername: row.owner_username as string | null,
      ownerDisplayName: row.owner_display_name as string | null,
      ownerDeletedAt: row.owner_deleted_at as string | null,
      createdAt: row.created_at as string,
      lastOpenedAt: row.last_opened_at as string,
      memberCount: Number(row.member_count),
    })) };
  }

  softDeleteUser(username: string, deletedAt: string) {
    return this.transaction(() => {
      const result = this.db.prepare("UPDATE users SET deleted_at = ? WHERE username = ? AND deleted_at IS NULL AND is_admin = 0").run(deletedAt, username);
      if (Number(result.changes) === 1) this.db.prepare("DELETE FROM user_sessions WHERE username = ?").run(username);
      return Number(result.changes) === 1;
    });
  }

  resetUserPassword(username: string, salt: string, hash: string) {
    return this.transaction(() => {
      const result = this.db.prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE username = ? AND deleted_at IS NULL").run(salt, hash, username);
      if (Number(result.changes) === 1) this.db.prepare("DELETE FROM user_sessions WHERE username = ?").run(username);
      return Number(result.changes) === 1;
    });
  }

  updateUserDisplayName(username: string, displayName: string) {
    const result = this.db.prepare("UPDATE users SET display_name = ? WHERE username = ?").run(displayName, username);
    return Number(result.changes) === 1;
  }

  updateUserType(username: string, userType: UserType) {
    const result = this.db.prepare(`
      UPDATE users SET user_type = ?
      WHERE username = ? AND deleted_at IS NULL AND is_admin = 0
    `).run(userType, username);
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
      reusable: Boolean(row.reusable),
      userType: row.user_type as UserType,
    };
  }

  createInvitation(invitation: { tokenHash: string; createdBy: string; createdAt: string; expiresAt: number; reusable: boolean; userType: UserType }) {
    this.db.prepare(`
      INSERT INTO invitations (token_hash, created_by, created_at, expires_at, reusable, user_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(invitation.tokenHash, invitation.createdBy, invitation.createdAt, invitation.expiresAt, Number(invitation.reusable), invitation.userType);
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
    const rows = this.db.prepare("SELECT project_id, share_id, access_mode, expires_at FROM project_sessions WHERE token_hash = ?").all(tokenHash) as SqlRow[];
    if (!rows.length) return null;
    return {
      projects: new Set(rows.map(row => row.project_id as string)),
      shares: new Map(rows.map(row => [row.project_id as string, row.share_id as string])),
      access: new Map(rows.map(row => [row.project_id as string, row.access_mode as "view" | "edit"])),
      expiresAt: Math.max(...rows.map(row => Number(row.expires_at))),
    };
  }

  addProjectSession(tokenHash: string, projectId: string, shareId: string, accessMode: "view" | "edit", expiresAt: number) {
    this.transaction(() => {
      this.db.prepare("UPDATE project_sessions SET expires_at = ? WHERE token_hash = ?").run(expiresAt, tokenHash);
      this.db.prepare(`
        INSERT INTO project_sessions (token_hash, project_id, share_id, access_mode, expires_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(token_hash, project_id) DO UPDATE SET
          share_id = excluded.share_id,
          access_mode = excluded.access_mode,
          expires_at = excluded.expires_at
      `).run(tokenHash, projectId, shareId, accessMode, expiresAt);
    });
  }

  createProjectShare(projectId: string, id: string, username: string, token: string, tokenHash: string, viewToken: string, viewTokenHash: string, proposalToken: string, proposalTokenHash: string, createdAt: number) {
    this.db.prepare(`
      INSERT INTO project_shares (id, project_id, username, token, token_hash, view_token, view_token_hash, proposal_token, proposal_token_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, username, token, tokenHash, viewToken, viewTokenHash, proposalToken, proposalTokenHash, createdAt);
  }

  getProjectShareForUser(projectId: string, username: string) {
    const row = this.db.prepare(`
      SELECT id, project_id, username, token, view_token, proposal_token, created_at FROM project_shares
      WHERE project_id = ? AND username = ?
    `).get(projectId, username) as SqlRow | undefined;
    return row ? {
      id: row.id as string,
      projectId: row.project_id as string,
      username: row.username as string,
      token: row.token as string,
      viewToken: row.view_token as string | null,
      proposalToken: row.proposal_token as string | null,
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

  getProjectShareByViewToken(projectId: string, tokenHash: string) {
    const row = this.db.prepare(`
      SELECT id, project_id, username, created_at FROM project_shares WHERE project_id = ? AND view_token_hash = ?
    `).get(projectId, tokenHash) as SqlRow | undefined;
    return row ? {
      id: row.id as string,
      projectId: row.project_id as string,
      username: row.username as string | null,
      createdAt: Number(row.created_at),
    } : null;
  }

  setProjectShareViewToken(projectId: string, username: string, token: string, tokenHash: string) {
    const result = this.db.prepare(`
      UPDATE project_shares SET view_token = ?, view_token_hash = ? WHERE project_id = ? AND username = ?
    `).run(token, tokenHash, projectId, username);
    return Number(result.changes) === 1;
  }

  getProjectShareByProposalToken(projectId: string, tokenHash: string) {
    const row = this.db.prepare(`
      SELECT id, project_id, username, created_at FROM project_shares WHERE project_id = ? AND proposal_token_hash = ?
    `).get(projectId, tokenHash) as SqlRow | undefined;
    return row ? {
      id: row.id as string,
      projectId: row.project_id as string,
      username: row.username as string | null,
      createdAt: Number(row.created_at),
    } : null;
  }

  setProjectShareProposalToken(projectId: string, username: string, token: string, tokenHash: string) {
    const result = this.db.prepare(`
      UPDATE project_shares SET proposal_token = ?, proposal_token_hash = ? WHERE project_id = ? AND username = ?
    `).run(token, tokenHash, projectId, username);
    return Number(result.changes) === 1;
  }

  rotateProjectShare(projectId: string, username: string, token: string, tokenHash: string, viewToken: string, viewTokenHash: string, proposalToken: string, proposalTokenHash: string) {
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE project_shares SET token = ?, token_hash = ?, view_token = ?, view_token_hash = ?, proposal_token = ?, proposal_token_hash = ? WHERE project_id = ? AND username = ?
      `).run(token, tokenHash, viewToken, viewTokenHash, proposalToken, proposalTokenHash, projectId, username);
      if (Number(result.changes) !== 1) return false;
      const share = this.getProjectShareForUser(projectId, username);
      this.db.prepare("DELETE FROM project_sessions WHERE project_id = ? AND share_id = ?").run(projectId, share!.id);
      return true;
    });
  }

  getProjectMember(projectId: string, username: string) {
    const row = this.db.prepare(`
      SELECT project_id, username, role, joined_at, archived FROM project_members WHERE project_id = ? AND username = ?
    `).get(projectId, username) as SqlRow | undefined;
    return row ? { projectId: row.project_id as string, username: row.username as string, role: row.role as string, joinedAt: Number(row.joined_at), archived: Boolean(row.archived) } : null;
  }

  addProjectMember(projectId: string, username: string, role: "owner" | "collaborator" | "viewer" = "collaborator", joinedAt = Date.now()) {
    this.db.prepare(`
      INSERT INTO project_members (project_id, username, role, joined_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, username) DO UPDATE SET role = CASE
        WHEN project_members.role IN ('owner', 'collaborator') OR excluded.role = 'viewer' THEN project_members.role
        ELSE excluded.role
      END
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
      ? this.db.prepare("SELECT * FROM projects WHERE owner_username = ? ORDER BY last_opened_at DESC, name COLLATE NOCASE").all(ownerUsername)
      : this.db.prepare("SELECT * FROM projects ORDER BY last_opened_at DESC, name COLLATE NOCASE").all();
    return (rows as ProjectRow[]).map(row => this.projectFromRow(row));
  }

  listProjectsForUser(username: string) {
    const rows = this.db.prepare(`
      SELECT projects.*, project_members.role AS membership_role, project_members.archived AS membership_archived
      FROM project_members JOIN projects ON projects.id = project_members.project_id
      WHERE project_members.username = ? ORDER BY projects.last_opened_at DESC, projects.name COLLATE NOCASE
    `).all(username) as Array<ProjectRow & { membership_role: string; membership_archived: number }>;
    return rows.map(row => ({
      ...this.projectFromRow(row),
      membershipRole: row.membership_role as string,
      membershipArchived: Boolean(row.membership_archived),
      tags: this.listProjectTags(row.id),
    }));
  }

  listProjectTags(projectId: string): string[] {
    return (this.db.prepare("SELECT tag FROM project_tags WHERE project_id = ? ORDER BY tag COLLATE NOCASE").all(projectId) as Array<{ tag: string }>)
      .map(row => row.tag);
  }

  replaceProjectTags(projectId: string, tags: string[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM project_tags WHERE project_id = ?").run(projectId);
      const insert = this.db.prepare("INSERT INTO project_tags (project_id, tag, created_at) VALUES (?, ?, ?)");
      const createdAt = Date.now();
      for (const tag of tags) insert.run(projectId, tag, createdAt);
    });
  }

  setProjectArchived(projectId: string, username: string, archived: boolean): boolean {
    const result = this.db.prepare("UPDATE project_members SET archived = ? WHERE project_id = ? AND username = ?")
      .run(archived ? 1 : 0, projectId, username);
    return Number(result.changes) === 1;
  }

  getProject(id: string) {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? this.projectFromRow(row) : null;
  }

  createProject(metadata: ProjectMetadata) {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO projects (id, name, owner_username, share_token, created_at, last_opened_at, git_state_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        metadata.id,
        metadata.name,
        metadata.ownerUsername,
        metadata.shareToken,
        metadata.createdAt,
        metadata.lastOpenedAt,
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

  markProjectOpened(id: string, lastOpenedAt: string) {
    const result = this.db.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?").run(lastOpenedAt, id);
    return Number(result.changes) === 1;
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

  moveYjsSnapshots(projectId: string, from: string, to: string) {
    const rows = this.db.prepare(`
      SELECT relative_path FROM yjs_snapshots
      WHERE project_id = ? AND (relative_path = ? OR substr(relative_path, 1, ?) = ?)
      ORDER BY length(relative_path)
    `).all(projectId, from, from.length + 1, `${from}/`) as Array<{ relative_path: string }>;
    this.transaction(() => {
      for (const row of rows) {
        const destination = to + row.relative_path.slice(from.length);
        this.db.prepare("UPDATE yjs_snapshots SET relative_path = ? WHERE project_id = ? AND relative_path = ?")
          .run(destination, projectId, row.relative_path);
      }
    });
  }

  createBlameChange(change: Omit<BlameChange, "projectId"> & { projectId: string }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO blame_changes
        (change_id, project_id, author_id, author_name, created_at, commit_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(change.id, change.projectId, change.authorId, change.authorName, change.createdAt, change.commit);
  }

  getBlameChanges(projectId: string, changeIds: string[]): Map<string, BlameChange> {
    const result = new Map<string, BlameChange>();
    for (let offset = 0; offset < changeIds.length; offset += 500) {
      const ids = changeIds.slice(offset, offset + 500);
      if (!ids.length) continue;
      const placeholders = ids.map(() => "?").join(", ");
      const rows = this.db.prepare(`
        SELECT change_id, project_id, author_id, author_name, created_at, commit_hash
        FROM blame_changes WHERE project_id = ? AND change_id IN (${placeholders})
      `).all(projectId, ...ids) as Array<{
        change_id: string; project_id: string; author_id: string; author_name: string;
        created_at: number; commit_hash: string | null;
      }>;
      for (const row of rows) result.set(row.change_id, {
        id: row.change_id,
        projectId: row.project_id,
        authorId: row.author_id,
        authorName: row.author_name,
        createdAt: Number(row.created_at),
        commit: row.commit_hash,
      });
    }
    return result;
  }

  pendingBlameChangeIds(projectId: string): string[] {
    return (this.db.prepare(`
      SELECT change_id FROM blame_changes
      WHERE project_id = ? AND commit_hash IS NULL ORDER BY created_at, change_id
    `).all(projectId) as Array<{ change_id: string }>).map(row => row.change_id);
  }

  assignBlameChanges(projectId: string, changeIds: string[], commit: string): number {
    let assigned = 0;
    this.transaction(() => {
      for (let offset = 0; offset < changeIds.length; offset += 500) {
        const ids = changeIds.slice(offset, offset + 500);
        if (!ids.length) continue;
        const placeholders = ids.map(() => "?").join(", ");
        const result = this.db.prepare(`
          UPDATE blame_changes SET commit_hash = ?
          WHERE project_id = ? AND commit_hash IS NULL AND change_id IN (${placeholders})
        `).run(commit, projectId, ...ids);
        assigned += Number(result.changes);
      }
    });
    return assigned;
  }

  private projectFromRow(row: ProjectRow): ProjectMetadata {
    return {
      id: row.id,
      name: row.name,
      ownerUsername: row.owner_username,
      shareToken: row.share_token,
      createdAt: row.created_at,
      lastOpenedAt: row.last_opened_at || row.created_at,
      git: row.git_state_json ? JSON.parse(row.git_state_json) : undefined,
    };
  }
}
