import type { DatabaseSync } from "node:sqlite";

export const LATEST_SCHEMA_VERSION = 6;

type ColumnRow = { name: string };
type Migration = { version: number; name: string; up(database: DatabaseSync): void };

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnRow[])
    .some(candidate => candidate.name === column);
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS users (
          username TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
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
        CREATE TABLE IF NOT EXISTS project_members (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          username TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('owner', 'collaborator')),
          joined_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, username)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS project_shares (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          username TEXT,
          token TEXT,
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS project_sessions (
          token_hash TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          share_id TEXT,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (token_hash, project_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS builds (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          main_file TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          log TEXT NOT NULL,
          has_pdf INTEGER NOT NULL CHECK (has_pdf IN (0, 1)),
          source_revision TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS yjs_snapshots (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          snapshot BLOB NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, relative_path)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS project_settings (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          compiler TEXT NOT NULL DEFAULT 'auto',
          auto_compile INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE TABLE IF NOT EXISTS build_errors (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          errors TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS trash_entries (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          original_path TEXT NOT NULL,
          directory INTEGER NOT NULL,
          deleted_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS trash_files (
          trash_id TEXT NOT NULL REFERENCES trash_entries(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          content BLOB NOT NULL,
          snapshot BLOB,
          directory INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (trash_id, relative_path)
        ) STRICT;
      `);
    },
  },
  {
    version: 2,
    name: "user display names",
    up(database) {
      if (!hasColumn(database, "users", "display_name")) {
        database.exec("ALTER TABLE users ADD COLUMN display_name TEXT;");
        database.exec("UPDATE users SET display_name = username WHERE display_name IS NULL;");
      }
    },
  },
  {
    version: 3,
    name: "personal project shares",
    up(database) {
      if (!hasColumn(database, "project_sessions", "share_id")) {
        database.exec("ALTER TABLE project_sessions ADD COLUMN share_id TEXT;");
        database.exec("DELETE FROM project_sessions WHERE share_id IS NULL;");
      }
      if (!hasColumn(database, "project_shares", "username")) database.exec("ALTER TABLE project_shares ADD COLUMN username TEXT;");
      if (!hasColumn(database, "project_shares", "token")) database.exec("ALTER TABLE project_shares ADD COLUMN token TEXT;");
    },
  },
  {
    version: 4,
    name: "build source revision",
    up(database) {
      if (!hasColumn(database, "builds", "source_revision")) database.exec("ALTER TABLE builds ADD COLUMN source_revision TEXT;");
    },
  },
  {
    version: 5,
    name: "membership and lookup indexes",
    up(database) {
      database.exec(`
        CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_username, name);
        CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(username, joined_at);
        CREATE INDEX IF NOT EXISTS project_shares_project_idx ON project_shares(project_id, created_at);
        CREATE INDEX IF NOT EXISTS project_sessions_expiry_idx ON project_sessions(expires_at);
        CREATE UNIQUE INDEX IF NOT EXISTS project_shares_member_idx
          ON project_shares(project_id, username) WHERE username IS NOT NULL;
        INSERT OR IGNORE INTO project_members (project_id, username, role, joined_at)
          SELECT id, owner_username, 'owner', CAST(strftime('%s', created_at) AS INTEGER) * 1000
          FROM projects WHERE owner_username IS NOT NULL;
      `);
    },
  },
  {
    version: 6,
    name: "ensure project settings, trash and compilation diagnostics on upgrades",
    up(database) {
      // Earlier releases added tables to the initial migration only. Existing
      // databases have already applied it, so create missing tables idempotently.
      migrations[0].up(database);
      if (!hasColumn(database, "trash_files", "directory")) {
        database.exec("ALTER TABLE trash_files ADD COLUMN directory INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
];

export function schemaVersion(database: DatabaseSync): number {
  return Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

export function runMigrations(database: DatabaseSync): number {
  let current = schemaVersion(database);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(`Database schema ${current} is newer than supported schema ${LATEST_SCHEMA_VERSION}`);
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.up(database);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
      current = migration.version;
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`Database migration ${migration.version} (${migration.name}) failed`, { cause: error });
    }
  }
  return current;
}
