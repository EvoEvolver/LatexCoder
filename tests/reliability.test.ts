import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CompileQueue } from "../src/server/compile-queue.ts";
import { StateDatabase } from "../src/server/database.ts";
import { createPaperServer } from "../src/server/main.ts";

test("SQLite migrations upgrade a version-one database transactionally", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-migration-"));
  const filename = path.join(stateDir, "state.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE users (username TEXT PRIMARY KEY, password_salt TEXT, password_hash TEXT, created_at TEXT, invited_by TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, owner_username TEXT, share_token TEXT, created_at TEXT, git_state_json TEXT);
    CREATE TABLE project_members (project_id TEXT, username TEXT, role TEXT, joined_at INTEGER, PRIMARY KEY (project_id, username));
    CREATE TABLE project_shares (id TEXT PRIMARY KEY, project_id TEXT, token_hash TEXT, created_at INTEGER);
    CREATE TABLE project_sessions (token_hash TEXT, project_id TEXT, expires_at INTEGER, PRIMARY KEY (token_hash, project_id));
    CREATE TABLE builds (project_id TEXT PRIMARY KEY, status TEXT, main_file TEXT, started_at TEXT, finished_at TEXT, log TEXT, has_pdf INTEGER);
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const database = new StateDatabase(stateDir);
  try {
    assert.equal(database.schemaVersion(), 6);
    assert.equal(database.ping(), true);
    const upgraded = new DatabaseSync(filename, { readOnly: true });
    try {
      const columns = (table: string) => (upgraded.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
      assert.ok(columns("users").includes("display_name"));
      assert.ok(columns("project_sessions").includes("share_id"));
      assert.ok(columns("project_shares").includes("username"));
      assert.ok(columns("builds").includes("source_revision"));
      assert.ok(columns("build_errors").includes("errors"));
      assert.ok(columns("project_settings").includes("compiler"));
      assert.ok(columns("trash_files").includes("directory"));
    } finally {
      upgraded.close();
    }
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("compile queue enforces its global concurrency limit", async () => {
  const queue = new CompileQueue(2);
  let active = 0;
  let maximum = 0;
  const releases: Array<() => void> = [];
  const task = (value: number) => queue.run(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => releases.push(resolve));
    active--;
    return value;
  });
  const results = [task(1), task(2), task(3)];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(queue.stats(), { active: 2, queued: 1, concurrency: 2, accepting: true });
  releases.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.stats().active, 2);
  releases.splice(0).forEach(release => release());
  await new Promise(resolve => setImmediate(resolve));
  releases.splice(0).forEach(release => release());
  assert.deepEqual(await Promise.all(results), [1, 2, 3]);
  assert.equal(maximum, 2);
});

test("health endpoints distinguish liveness and readiness", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-health-"));
  const paper = await createPaperServer({ stateDir, authDisabled: true });
  await new Promise<void>((resolve, reject) => {
    paper.server.once("error", reject);
    paper.server.listen(0, "127.0.0.1", resolve);
  });
  const port = (paper.server.address() as AddressInfo).port;
  try {
    const live = await (await fetch(`http://127.0.0.1:${port}/health/live`)).json();
    assert.deepEqual(live, { ok: true, status: "live", name: "latexcoder" });
    const readyResponse = await fetch(`http://127.0.0.1:${port}/health/ready`);
    const ready = await readyResponse.json();
    assert.equal(readyResponse.status, 200);
    assert.equal(ready.status, "ready");
    assert.equal(ready.schemaVersion, 6);
    assert.deepEqual(ready.queue, { active: 0, queued: 0, concurrency: 2, accepting: true });
    assert.equal(typeof ready.dependencies.git.available, "boolean");
  } finally {
    paper.shutdown();
    paper.sockets.close();
    await new Promise(resolve => paper.server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("version-five databases gain missing diagnostic tables without losing projects", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-v5-"));
  try {
    const fresh = new StateDatabase(stateDir);
    fresh.close();
    const legacy = new DatabaseSync(path.join(stateDir, "state.sqlite"));
    legacy.exec(`INSERT INTO projects (id, name, share_token, created_at) VALUES ('retained', 'Existing paper', 'secret', '2026-01-01');
      INSERT INTO builds (project_id, status, main_file, log, has_pdf) VALUES ('retained', 'idle', 'main.tex', '', 0);
      DROP TABLE build_errors; DROP TABLE project_settings; DROP TABLE trash_files; DROP TABLE trash_entries;
      PRAGMA user_version = 5;`);
    legacy.close();
    const upgraded = new StateDatabase(stateDir);
    assert.equal(upgraded.schemaVersion(), 6);
    assert.deepEqual(upgraded.getBuild('retained').errors, []);
    assert.equal(upgraded.getSettings('retained').compiler, 'auto');
    assert.deepEqual(upgraded.listTrash('retained'), []);
    upgraded.close();
    const repeated = new StateDatabase(stateDir);
    assert.equal(repeated.schemaVersion(), 6);
    repeated.close();
    const verify = new DatabaseSync(path.join(stateDir, "state.sqlite"));
    assert.equal(verify.prepare('SELECT name FROM projects WHERE id = ?').get('retained').name, 'Existing paper');
    verify.close();
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
