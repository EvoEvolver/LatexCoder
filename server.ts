import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import * as awarenessProtocol from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";

import { StateDatabase } from "./src/database.ts";
import { parseReviews, stripReviewStorage } from "./src/review.ts";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEXT_EXTENSIONS = new Set([".bib", ".cls", ".csv", ".json", ".md", ".sty", ".tex", ".txt", ".yaml", ".yml"]);
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PATCH_CHANGES = 1_000;
const DEFAULT_DOCUMENT = String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{hyperref}

\title{A Small Collaborative Paper}
\author{Author Name}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}

This document is shared live. Select text to comment, or turn on Suggesting and edit normally to track changes.

\section{Notes}

The canonical source is persisted as ordinary files and can be edited by agents through the HTTP API.

\end{document}
`;

function apiError(code: string, message: string, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) {
    throw apiError("invalid_path", "path is invalid");
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("/.paper/")) {
    throw apiError("invalid_path", "path must stay inside the project");
  }
  return normalized;
}

function isTextFile(relativePath) {
  return TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function cleanUsername(value) {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw apiError("invalid_username", "username must be 3 to 32 lowercase letters, numbers, dots, dashes, or underscores");
  }
  return username;
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < 10 || value.length > 256) {
    throw apiError("invalid_password", "password must contain 10 to 256 characters");
  }
  return value;
}

function passwordRecord(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return { salt: salt.toString("base64"), hash: hash.toString("base64") };
}

function passwordMatches(password, record) {
  try {
    const expected = Buffer.from(record.hash, "base64");
    const actual = scryptSync(password, Buffer.from(record.salt, "base64"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function parseCookies(request) {
  const result = {};
  for (const part of String(request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    try { result[name] = decodeURIComponent(part.slice(separator + 1).trim()); } catch {}
  }
  return result;
}

function sessionCookie(request, name, value, maxAge) {
  const secure = request.secure || request.get("x-forwarded-proto") === "https";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function isUnicodeBoundary(source, offset) {
  if (offset <= 0 || offset >= source.length) return true;
  const before = source.charCodeAt(offset - 1);
  const after = source.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function cleanReviewMetadata(value) {
  return String(value || "").replaceAll("\\", "/").replace(/[{}%#\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

function agentAuthor(agent) {
  const id = cleanReviewMetadata(agent?.id);
  const name = cleanReviewMetadata(agent?.name);
  if (!/^ag_[a-zA-Z0-9]+$/.test(id) || !name || name.length > 64) {
    throw apiError("invalid_agent", "suggesting patches require agent.id and agent.name");
  }
  return `Agent: ${name} [${id}]`;
}

function atomicWriteSync(target, bytes) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes);
  renameSync(temporary, target);
}

function roomNameForPath(relativePath) {
  return Buffer.from(relativePath, "utf8").toString("base64url");
}

function pathFromRoomName(roomName) {
  try {
    return safeRelativePath(Buffer.from(roomName, "base64url").toString("utf8"));
  } catch {
    throw apiError("invalid_room", "collaboration room is invalid");
  }
}

function createCollaborationStore(projectId, projectDir, database) {
  const docs = new Map();
  let shuttingDown = false;
  let suspended = false;

  function persist(shared) {
    if (shuttingDown || suspended || shared.removed) return;
    if (shared.persistTimer) clearTimeout(shared.persistTimer);
    shared.persistTimer = setTimeout(() => {
      shared.persistTimer = undefined;
      const text = shared.doc.getText("content").toString();
      atomicWriteSync(path.join(projectDir, shared.relativePath), text);
      database.saveYjsSnapshot(projectId, shared.relativePath, Y.encodeStateAsUpdate(shared.doc));
    }, 180);
  }

  function broadcast(shared, payload, except = null) {
    for (const connection of shared.connections.keys()) {
      if (connection !== except && connection.readyState === WebSocket.OPEN) connection.send(payload);
    }
  }

  function load(relativePath) {
    let shared = docs.get(relativePath);
    if (shared) return shared;
    if (!isTextFile(relativePath)) throw apiError("not_text", "only text files can be collaboratively edited", 415);
    const target = path.join(projectDir, relativePath);
    if (!existsSync(target)) throw apiError("file_not_found", "file does not exist", 404);
    const doc = new Y.Doc();
    const snapshot = database.getYjsSnapshot(projectId, relativePath);
    if (snapshot) {
      Y.applyUpdate(doc, snapshot);
    } else {
      const source = readFileSync(target, "utf8");
      if (Buffer.byteLength(source) > MAX_TEXT_BYTES) throw apiError("file_too_large", "text file is too large", 413);
      doc.getText("content").insert(0, source);
    }
    shared = {
      relativePath,
      doc,
      awareness: new awarenessProtocol.Awareness(doc),
      connections: new Map(),
      persistTimer: undefined,
      removed: false,
    };
    shared.awareness.setLocalState(null);
    doc.on("update", (update, origin) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      broadcast(shared, encoding.toUint8Array(encoder), origin);
      persist(shared);
    });
    shared.awareness.on("update", ({ added, updated, removed }, origin) => {
      const changed = [...added, ...updated, ...removed];
      if (origin && shared.connections.has(origin)) {
        const controlled = shared.connections.get(origin);
        for (const id of added) controlled.add(id);
        for (const id of removed) controlled.delete(id);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(shared.awareness, changed));
      broadcast(shared, encoding.toUint8Array(encoder), null);
    });
    docs.set(relativePath, shared);
    return shared;
  }

  function attach(connection, relativePath) {
    if (suspended) {
      connection.close(1012, "project is synchronizing with Git");
      return;
    }
    const shared = load(relativePath);
    shared.connections.set(connection, new Set());
    connection.binaryType = "arraybuffer";
    connection.on("message", raw => {
      try {
        const decoder = decoding.createDecoder(new Uint8Array(raw));
        const type = decoding.readVarUint(decoder);
        if (type === MESSAGE_SYNC) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, shared.doc, connection);
          if (encoding.length(encoder) > 1) connection.send(encoding.toUint8Array(encoder));
        } else if (type === MESSAGE_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(
            shared.awareness,
            decoding.readVarUint8Array(decoder),
            connection,
          );
        }
      } catch (error) {
        console.error("paper websocket message failed", error);
        connection.close(1003, "invalid collaboration message");
      }
    });
    let alive = true;
    connection.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) return connection.terminate();
      alive = false;
      connection.ping();
    }, 30_000);
    connection.on("close", () => {
      clearInterval(heartbeat);
      const controlled = shared.connections.get(connection) || new Set();
      shared.connections.delete(connection);
      awarenessProtocol.removeAwarenessStates(shared.awareness, [...controlled], null);
      persist(shared);
    });

    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, shared.doc);
    connection.send(encoding.toUint8Array(syncEncoder));
    const clients = [...shared.awareness.getStates().keys()];
    if (clients.length) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(shared.awareness, clients),
      );
      connection.send(encoding.toUint8Array(awarenessEncoder));
    }
  }

  function replaceText(relativePath, source) {
    const shared = docs.get(relativePath);
    if (!shared) return false;
    const text = shared.doc.getText("content");
    shared.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, source);
    }, "rest-api");
    return true;
  }

  function importText(relativePath, source) {
    const target = path.join(projectDir, relativePath);
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const shared = load(relativePath);
    const text = shared.doc.getText("content");
    if (text.toString() === source) return;
    shared.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, source);
    }, "git-sync");
  }

  function readText(relativePath) {
    return load(relativePath).doc.getText("content").toString();
  }

  function patchText(relativePath, baseSha256, requestedChanges, options: any = {}) {
    if (typeof baseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(baseSha256)) {
      throw apiError("invalid_base_sha256", "baseSha256 must be a lowercase SHA-256 hex digest");
    }
    if (!Array.isArray(requestedChanges) || requestedChanges.length === 0 || requestedChanges.length > MAX_PATCH_CHANGES) {
      throw apiError("invalid_changes", `changes must contain 1 to ${MAX_PATCH_CHANGES} edits`);
    }
    const shared = load(relativePath);
    const text = shared.doc.getText("content");
    const source = text.toString();
    if (sha256(source) !== baseSha256) {
      throw apiError("stale_file", "file changed since it was read; fetch it and retry the patch", 409);
    }
    const changes = requestedChanges.map((change, index) => {
      const from = change?.from;
      const to = change?.to;
      const insert = change?.insert;
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > source.length) {
        throw apiError("invalid_change", `changes[${index}] has an invalid range`);
      }
      if (typeof insert !== "string") {
        throw apiError("invalid_change", `changes[${index}].insert must be a string`);
      }
      if (from === to && insert.length === 0) {
        throw apiError("invalid_change", `changes[${index}] does not change the document`);
      }
      if (!isUnicodeBoundary(source, from) || !isUnicodeBoundary(source, to)) {
        throw apiError("invalid_change", `changes[${index}] splits a Unicode character`);
      }
      return { from, to, insert, index };
    }).sort((left, right) => left.from - right.from || left.to - right.to);
    for (let index = 1; index < changes.length; index += 1) {
      if (changes[index].from < changes[index - 1].to) {
        throw apiError("overlapping_changes", "patch ranges must not overlap");
      }
    }
    const mode = options.mode ?? "suggesting";
    if (mode !== "suggesting" && mode !== "direct") {
      throw apiError("invalid_mode", "mode must be suggesting or direct");
    }
    let author = "";
    const suggestionIds = [];
    if (mode === "suggesting") {
      author = agentAuthor(options.agent);
      const reviews = parseReviews(source);
      for (const change of changes) {
        const conflicts = reviews.some(item => change.from < item.to && change.to > item.from);
        if (conflicts) throw apiError("review_conflict", "suggesting patches cannot overlap an open review", 409);
        const id = `r${randomUUID().replaceAll("-", "")}`;
        const deleted = source.slice(change.from, change.to);
        const deletion = deleted ? `\\delbg{${id}}{${author}}${deleted}\\deled` : "";
        const addition = change.insert ? `\\addbg{${id}}{${author}}${change.insert}\\added` : "";
        change.insert = `${deletion}${addition}`;
        suggestionIds.push(id);
      }
    }
    let projectedBytes = Buffer.byteLength(source);
    for (const change of changes) {
      projectedBytes -= Buffer.byteLength(source.slice(change.from, change.to));
      projectedBytes += Buffer.byteLength(change.insert);
    }
    if (projectedBytes > MAX_TEXT_BYTES) throw apiError("file_too_large", "patched text file is too large", 413);

    shared.doc.transact(() => {
      for (const change of changes.reverse()) {
        if (change.to > change.from) text.delete(change.from, change.to - change.from);
        if (change.insert) text.insert(change.from, change.insert);
      }
    }, "rest-patch-api");
    const result = text.toString();
    return { source: result, sha256: sha256(result), mode, suggestionIds };
  }

  function flush() {
    for (const shared of docs.values()) {
      if (shared.removed) continue;
      if (shared.persistTimer) clearTimeout(shared.persistTimer);
      shared.persistTimer = undefined;
      atomicWriteSync(path.join(projectDir, shared.relativePath), shared.doc.getText("content").toString());
      database.saveYjsSnapshot(projectId, shared.relativePath, Y.encodeStateAsUpdate(shared.doc));
    }
  }

  function remove(relativePath) {
    const shared = docs.get(relativePath);
    if (shared) {
      shared.removed = true;
      if (shared.persistTimer) clearTimeout(shared.persistTimer);
      shared.persistTimer = undefined;
      for (const connection of shared.connections.keys()) connection.close(1000, "file removed");
      shared.doc.destroy();
      docs.delete(relativePath);
    }
    database.deleteYjsSnapshot(projectId, relativePath);
    return Promise.resolve();
  }

  function shutdown() {
    flush();
    shuttingDown = true;
    for (const shared of docs.values()) {
      if (shared.persistTimer) clearTimeout(shared.persistTimer);
      for (const connection of shared.connections.keys()) connection.terminate();
      shared.doc.destroy();
    }
    docs.clear();
  }

  function suspend() {
    suspended = true;
    for (const shared of docs.values()) {
      for (const connection of shared.connections.keys()) connection.close(1012, "project is synchronizing with Git");
    }
    flush();
  }

  function resume() {
    suspended = false;
  }

  return { attach, flush, importText, load, patchText, readText, remove, replaceText, resume, roomNameForPath, shutdown, suspend };
}

async function listFiles(projectDir) {
  const result = [];
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        const details = await stat(path.join(directory, entry.name));
        result.push({ path: relativePath, size: details.size, text: isTextFile(relativePath) });
      }
    }
  }
  await visit(projectDir);
  return result;
}

function run(command: string, args: string[], options: any): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let output = "";
    const append = chunk => { output = (output + chunk.toString()).slice(-300_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function runBinary(command: string, args: string[], options: any = {}, input = Buffer.alloc(0)): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", error => {
      if (!settled) reject(error);
      settled = true;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) return resolve(Buffer.concat(stdout));
      reject(apiError("git_failed", Buffer.concat(stderr).toString("utf8").trim() || `Git exited with code ${code}`, 409));
    });
    child.stdin.end(input);
  });
}

const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Collaborative Editor",
  GIT_AUTHOR_EMAIL: "editor@localhost",
  GIT_COMMITTER_NAME: "Collaborative Editor",
  GIT_COMMITTER_EMAIL: "editor@localhost",
};

async function git(projectDir: string, args: string[], options: any = {}) {
  const result = await run("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: projectDir,
    env: { ...process.env, ...GIT_IDENTITY_ENV, ...(options.env || {}) },
  });
  const allowed = options.allowedCodes || [0];
  if (!allowed.includes(result.code)) {
    const message = result.output.trim().split("\n").slice(-8).join("\n") || `Git exited with code ${result.code}`;
    throw apiError(options.code || "git_failed", message, options.status || 409);
  }
  return { ...result, output: result.output.trim() };
}

async function ensureGitRepository(projectDir) {
  if (!existsSync(path.join(projectDir, ".git"))) {
    await git(projectDir, ["init", "-b", "main"]);
    await git(projectDir, ["add", "-A"]);
    await git(projectDir, ["commit", "--allow-empty", "-m", "Initial project"]);
  }
  const branch = (await git(projectDir, ["branch", "--show-current"])).output;
  if (branch !== "main") throw apiError("git_branch_invalid", "the collaborative working tree must remain on main", 409);
}

function cleanCommitMessage(value, fallback = "Collaborative checkpoint") {
  const message = typeof value === "string" ? value.replace(/\r/g, "").trim() : "";
  if (message.length > 500) throw apiError("invalid_commit_message", "commit message must not exceed 500 characters");
  return message || fallback;
}

async function gitHead(projectDir, ref = "HEAD") {
  return (await git(projectDir, ["rev-parse", "--verify", `${ref}^{commit}`])).output.split("\n").at(-1);
}

async function gitCheckpoint(runtime, message) {
  runtime.collaboration.flush();
  await git(runtime.projectDir, ["add", "-A"]);
  const changed = await git(runtime.projectDir, ["diff", "--cached", "--quiet"], { allowedCodes: [0, 1] });
  if (changed.code === 1) await git(runtime.projectDir, ["commit", "-m", cleanCommitMessage(message)]);
  return { commit: await gitHead(runtime.projectDir), created: changed.code === 1 };
}

function parseGitStatus(output) {
  if (!output) return [];
  return output.split("\n").filter(Boolean).map(line => ({
    index: line[0],
    worktree: line[1],
    path: line.slice(3),
  }));
}

async function gitStatus(runtime) {
  runtime.collaboration.flush();
  const branch = (await git(runtime.projectDir, ["branch", "--show-current"])).output;
  const files = parseGitStatus((await git(runtime.projectDir, ["status", "--short", "--untracked-files=all"])).output);
  const upstreamResult = await git(runtime.projectDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowedCodes: [0, 128] });
  const upstream = upstreamResult.code === 0 ? upstreamResult.output.split("\n").at(-1) : null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = (await git(runtime.projectDir, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).output.split(/\s+/).map(Number);
    [ahead, behind] = counts;
  }
  const logOutput = (await git(runtime.projectDir, ["log", "-10", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s"])).output;
  const history = logOutput ? logOutput.split("\n").map(line => {
    const [id, shortId, author, date, subject] = line.split("\x1f");
    return { id, shortId, author, date, subject };
  }) : [];
  const conflictsOutput = (await git(runtime.projectDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/conflict"])).output;
  return {
    branch,
    head: await gitHead(runtime.projectDir),
    upstream,
    ahead,
    behind,
    dirty: files.length > 0,
    files,
    history,
    conflictBranches: conflictsOutput ? conflictsOutput.split("\n") : [],
    conflict: runtime.metadata.git?.conflict || null,
  };
}

function conflictBranchName(date = new Date()) {
  return `conflict/${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-")}`;
}

function validateMergedText(relativePath, source) {
  if (/^(?:<{7}|={7}|>{7})/m.test(source)) throw apiError("git_merge_invalid", `${relativePath} contains merge markers`, 409);
  if (!relativePath.endsWith(".tex")) return;
  const kinds = [
    ["\\cmtbg", "comment"], ["\\revbg", "revision"],
    ["\\addbg", "addition"], ["\\delbg", "deletion"],
  ];
  const reviews = parseReviews(source);
  for (const [marker, kind] of kinds) {
    const count = source.split(marker).length - 1;
    if (count !== reviews.filter(item => item.kind === kind).length) {
      throw apiError("git_review_conflict", `${relativePath} contains malformed review storage`, 409);
    }
  }
}

async function trackedPaths(projectDir) {
  const output = (await git(projectDir, ["ls-files", "-z"])).output;
  return output ? output.split("\0").filter(Boolean) : [];
}

async function importGitWorktree(runtime, sourceDir) {
  const before = new Set(await trackedPaths(runtime.projectDir));
  const after = new Set(await trackedPaths(sourceDir));
  if (!after.has(runtime.build.main)) throw apiError("git_main_missing", "the incoming version deletes the main document", 409);

  // Validate the complete target tree before changing any live Yjs document.
  for (const relativePath of after) {
    safeRelativePath(relativePath);
    const source = path.join(sourceDir, relativePath);
    const details = await lstat(source);
    if (!details.isFile()) throw apiError("git_file_unsupported", `${relativePath} is not a regular file`, 409);
    if (details.size > MAX_FILE_BYTES) throw apiError("file_too_large", `${relativePath} is too large to synchronize`, 413);
    if (isTextFile(relativePath)) {
      const content = await readFile(source, "utf8");
      if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw apiError("file_too_large", `${relativePath} is too large to synchronize`, 413);
      validateMergedText(relativePath, content);
    }
  }

  for (const relativePath of after) {
    const source = path.join(sourceDir, relativePath);
    const target = path.join(runtime.projectDir, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    if (isTextFile(relativePath)) {
      const content = await readFile(source, "utf8");
      runtime.collaboration.importText(relativePath, content);
    } else {
      await cp(source, target);
    }
  }
  for (const relativePath of before) {
    if (after.has(relativePath)) continue;
    await runtime.collaboration.remove(relativePath);
    await rm(path.join(runtime.projectDir, relativePath), { force: true });
  }
  runtime.collaboration.flush();
}

async function createConflictBranch(runtime, incoming, local) {
  const existing = runtime.metadata.git?.conflict;
  if (existing?.incoming === incoming) return existing;
  let branch = conflictBranchName();
  const check = await git(runtime.projectDir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowedCodes: [0, 1] });
  if (check.code === 0) branch = `${branch}-${incoming.slice(0, 7)}`;
  await git(runtime.projectDir, ["branch", branch, incoming]);
  const conflict = { branch, incoming, base: local, createdAt: new Date().toISOString() };
  runtime.metadata = { ...runtime.metadata, git: { ...(runtime.metadata.git || {}), conflict } };
  runtime.database.saveProject(runtime.metadata);
  return conflict;
}

async function withGitOperation(runtime, task) {
  if (runtime.gitBusy || runtime.deleting) throw apiError("git_busy", "another Git operation is already running", 409);
  runtime.gitBusy = true;
  runtime.collaboration.suspend();
  try {
    return await task();
  } finally {
    runtime.collaboration.resume();
    runtime.gitBusy = false;
  }
}

async function withGitReader(runtime, task) {
  if (runtime.deleting) throw apiError("project_not_found", "project does not exist", 404);
  runtime.gitReaders += 1;
  try {
    return await task();
  } finally {
    runtime.gitReaders -= 1;
    if (runtime.gitReaders === 0) {
      for (const resolve of runtime.gitReaderWaiters.splice(0)) resolve();
    }
  }
}

async function waitForGitReaders(runtime) {
  runtime.deleting = true;
  if (runtime.gitReaders > 0) await new Promise(resolve => runtime.gitReaderWaiters.push(resolve));
}

function assertProjectWritable(runtime) {
  if (runtime.gitBusy) throw apiError("git_busy", "the project is synchronizing with Git", 409);
}

async function withTemporaryWorktree(runtime, commit, task) {
  // The worktree target itself must not exist when `git worktree add` runs.
  const parent = await mkdtemp(path.join(os.tmpdir(), "paper-git-"));
  const worktree = path.join(parent, "worktree");
  try {
    await git(runtime.projectDir, ["worktree", "add", "--detach", worktree, commit]);
    return await task(worktree);
  } finally {
    if (existsSync(worktree)) await git(runtime.projectDir, ["worktree", "remove", "--force", worktree], { allowedCodes: [0, 128] });
    await rm(parent, { recursive: true, force: true });
  }
}

async function gitSync(runtime, requestedRef) {
  return withGitOperation(runtime, async () => {
    await ensureGitRepository(runtime.projectDir);
    const checkpoint = await gitCheckpoint(runtime, "Checkpoint before sync");
    const local = checkpoint.commit;
    let incomingRef = typeof requestedRef === "string" ? requestedRef.trim() : "";
    if (!incomingRef) {
      const upstream = await git(runtime.projectDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowedCodes: [0, 128] });
      if (upstream.code !== 0) throw apiError("git_upstream_missing", "configure an upstream or provide an incoming ref", 409);
      await git(runtime.projectDir, ["fetch"]);
      incomingRef = upstream.output.split("\n").at(-1);
    }
    if (!incomingRef || incomingRef.length > 200 || incomingRef.startsWith("-")) {
      throw apiError("invalid_git_ref", "incoming Git ref is invalid");
    }
    const incoming = await gitHead(runtime.projectDir, incomingRef);
    if (incoming === local) return { status: "up_to_date", commit: local };

    const incomingIsAncestor = await git(runtime.projectDir, ["merge-base", "--is-ancestor", incoming, local], { allowedCodes: [0, 1] });
    if (incomingIsAncestor.code === 0) return { status: "local_ahead", commit: local, incoming };

    const localIsAncestor = await git(runtime.projectDir, ["merge-base", "--is-ancestor", local, incoming], { allowedCodes: [0, 1] });
    let mergedCommit = incoming;
    let mergeConflict = false;
    let semanticConflict = null;

    await withTemporaryWorktree(runtime, localIsAncestor.code === 0 ? incoming : local, async worktree => {
      if (localIsAncestor.code !== 0) {
        const merge = await git(worktree, ["merge", "--no-ff", "--no-edit", incoming], { allowedCodes: [0, 1] });
        if (merge.code === 1) {
          mergeConflict = true;
          return;
        }
        mergedCommit = await gitHead(worktree);
      }
      try {
        await importGitWorktree(runtime, worktree);
      } catch (error) {
        semanticConflict = error;
      }
    });

    if (mergeConflict || semanticConflict) {
      const conflict = await createConflictBranch(runtime, incoming, local);
      return {
        status: "conflict",
        commit: local,
        incoming,
        conflict,
        reason: semanticConflict?.message || "Git could not merge the incoming version automatically",
      };
    }

    await git(runtime.projectDir, ["update-ref", "refs/heads/main", mergedCommit, local]);
    await git(runtime.projectDir, ["read-tree", mergedCommit]);
    return { status: localIsAncestor.code === 0 ? "fast_forward" : "merged", commit: mergedCommit, incoming };
  });
}

async function gitResolve(runtime, message) {
  return withGitOperation(runtime, async () => {
    await ensureGitRepository(runtime.projectDir);
    const conflict = runtime.metadata.git?.conflict;
    if (!conflict) throw apiError("git_conflict_missing", "the project has no pending Git conflict", 409);
    const branchTip = await gitHead(runtime.projectDir, conflict.branch);
    if (branchTip !== conflict.incoming) {
      throw apiError("git_conflict_changed", "the pending conflict branch changed; synchronize again before resolving", 409);
    }
    const checkpoint = await gitCheckpoint(runtime, "Checkpoint before conflict resolution");
    const local = checkpoint.commit;
    const tree = (await git(runtime.projectDir, ["write-tree"])).output.split("\n").at(-1);
    const commit = (await git(runtime.projectDir, ["commit-tree", tree, "-p", local, "-p", conflict.incoming, "-m", cleanCommitMessage(message, "Resolve Git conflict")])).output.split("\n").at(-1);
    await git(runtime.projectDir, ["update-ref", "refs/heads/main", commit, local]);
    await git(runtime.projectDir, ["branch", "-D", conflict.branch]);
    const nextGit = { ...(runtime.metadata.git || {}) };
    delete nextGit.conflict;
    runtime.metadata = { ...runtime.metadata, git: nextGit };
    runtime.database.saveProject(runtime.metadata);
    return { status: "resolved", commit };
  });
}

async function createProjectArchive(runtime) {
  assertProjectWritable(runtime);
  runtime.collaboration.flush();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "paper-archive-"));
  const index = path.join(temporary, "index");
  const archive = path.join(temporary, `${runtime.id}.zip`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(runtime.projectDir, ["read-tree", "HEAD"], { env });
    await git(runtime.projectDir, ["add", "--force", "-A"], { env });
    const tree = (await git(runtime.projectDir, ["write-tree"], { env })).output.split("\n").at(-1);
    await git(runtime.projectDir, ["archive", "--format=zip", `--prefix=${runtime.id}/`, `--output=${archive}`, tree]);
    return { archive, temporary };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function gitUploadPack(runtime, args, input, protocol) {
  const env: Record<string, string | undefined> = { ...process.env, ...GIT_IDENTITY_ENV };
  if (protocol) env.GIT_PROTOCOL = protocol;
  return runBinary("git", ["-c", "core.hooksPath=/dev/null", "upload-pack", "--stateless-rpc", ...args, runtime.projectDir], {
    cwd: runtime.projectDir,
    env,
  }, input);
}

async function findCompiler(configured, stateDir) {
  const candidates = [configured, path.join(stateDir, "bin", "tectonic"), "tectonic", "latexmk"].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    const probe = await run("sh", ["-c", `command -v "$1"`, "paper", candidate], {});
    if (probe.code === 0) return candidate;
  }
  throw apiError("compiler_unavailable", "install Tectonic or latexmk before compiling", 503);
}

function manual() {
  return `# LaTeX Coder

LaTeX Coder is a filesystem-backed collaborative LaTeX editor for trusted teams. Browsers receive the editor at this same URL; Agents receive this Markdown manual and use the JSON and file APIs below.

## Projects

\`GET /v1/auth/me\` returns the current member. Members sign in through
\`POST /v1/auth/login\`. \`POST /v1/invitations\` creates a single-use,
seven-day registration link; invited users register through
\`POST /v1/auth/register\`.

Member authentication is required for \`GET /v1/projects\` and project creation.
The list contains only projects owned by the current member. \`POST /v1/projects\`
with \`{"name":"My paper"}\` creates an owned project. Only its owner can rename,
delete, or retrieve its share secret. Rename or delete one with
\`PATCH /v1/projects/:id\` and \`DELETE /v1/projects/:id\`.

Every project-specific request below accepts \`?project=<id>\`. If omitted,
the first accessible project is used.

Browser routes \`/projects\` and \`/projects/:id\` provide the member dashboard
and clean editor URLs. A guest first opens \`/share/<project-id>/<secret>\` to
establish a project-scoped session. That session authorizes only the selected
project and does not expose the owner's dashboard. Signing in alone never grants
access to another member's projects.

Each project's source directory is an independent Git repository whose live
working tree always remains on \`main\`. \`GET /v1/git\` returns status and
history. \`POST /v1/git/commit\` creates a collaborative checkpoint.
\`POST /v1/git/sync\` accepts \`{"ref":"incoming-branch"}\`, or uses the
configured upstream when ref is omitted. A conflicting incoming commit is
quarantined on \`conflict/<UTC timestamp>\`; Yjs and main remain unchanged.
After resolving the content on main, \`POST /v1/git/resolve\` records the
two-parent merge commit.

\`GET /v1/project/archive?project=<id>\` downloads the current working tree as
a ZIP, including uncommitted files. Clone committed history over read-only
smart HTTP with \`git clone <origin>/git/<project-id>/<share-secret>\`.

## Inspect

\`GET /v1/project\` lists project files and the latest build.

\`GET /v1/files?path=main.tex\` reads a file as bytes.
The response includes the current \`X-Content-SHA256\` revision.

\`GET /v1/build/pdf\` downloads the latest successful PDF.

## Mutate

\`PUT /v1/files?path=chapters/intro.tex\` writes the raw request body.

\`POST /v1/files/patch?path=main.tex\` applies checked UTF-16 ranges in one
Yjs transaction. It defaults to Suggesting mode and requires Agent identity:
\`{"baseSha256":"...","agent":{"id":"ag_...","name":"writer"},"changes":[{"from":10,"to":14,"insert":"replacement"}]}\`.
Use \`"mode":"direct"\` only when an unreviewed edit is explicitly intended.
Overlapping, stale, or Unicode-splitting edits are rejected without changing the file.

\`DELETE /v1/files?path=chapters/intro.tex\` removes a file.

\`POST /v1/compile\` with JSON \`{"main":"main.tex"}\` compiles a PDF.

Text files are synchronized through Yjs. Writing through the API updates connected editors. Inline comments use \`\\cmtbg{id}{name}text\\cmted{comment}\`. Suggestion mode tracks insertions as \`\\addbg{id}{name}text\\added\` and deletions as \`\\delbg{id}{name}text\\deled\`.

## Trust

Passwords are scrypt-hashed and share URLs are bearer secrets exchanged for
24-hour, project-scoped sessions. Anyone holding a share URL can edit and
reshare that project. Users, invitations, projects, sessions, build state, and
Yjs snapshots are persisted in SQLite. LaTeX
compilation is not a security sandbox; use this service with trusted teams and
do not store unrelated secrets in project directories.
`;
}

function safeProjectId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{12}$/.test(value)) {
    throw apiError("invalid_project", "project id is invalid");
  }
  return value;
}

function randomProjectId() {
  return randomBytes(9).toString("base64url");
}

function cleanProjectName(value) {
  if (typeof value !== "string") throw apiError("invalid_project_name", "project name is required");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw apiError("invalid_project_name", "project name must contain 1 to 80 characters");
  return name;
}

export async function createPaperServer(options: any = {}) {
  const stateDir = path.resolve(options.stateDir || process.env.LATEXCODER_STATE_DIR || path.join(process.cwd(), ".latexcoder"));
  const projectsDir = path.join(stateDir, "projects");
  await mkdir(stateDir, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  const database = new StateDatabase(stateDir);

  const authDisabled = options.authDisabled === true;
  const configuredAdminPassword = options.adminPassword ?? process.env.LATEXCODER_ADMIN_PASSWORD;
  if (!authDisabled && database.countUsers() === 0 && configuredAdminPassword) {
    const password = validatePassword(configuredAdminPassword);
    database.createUser({
      username: "admin",
      ...passwordRecord(password),
      createdAt: new Date().toISOString(),
      invitedBy: null,
    });
  }

  const loginAttempts = new Map();
  const USER_SESSION_SECONDS = 7 * 24 * 60 * 60;
  const PROJECT_SESSION_SECONDS = 24 * 60 * 60;
  const INVITATION_SECONDS = 7 * 24 * 60 * 60;

  function cookieSession(request, cookieName) {
    const token = parseCookies(request)[cookieName];
    if (!token) return null;
    return { key: sha256(token), token };
  }

  function userSession(request) {
    const session = cookieSession(request, "lc_user");
    if (!session) return null;
    const record = database.getUserSession(session.key);
    return record ? { ...session, record } : null;
  }

  function projectSession(request) {
    const session = cookieSession(request, "lc_access");
    if (!session) return null;
    const record = database.getProjectSession(session.key);
    return record ? { ...session, record } : null;
  }

  function currentUser(request) {
    if (authDisabled) return { username: "test-user" };
    const session = userSession(request);
    return session ? { username: session.record.username } : null;
  }

  function requireUser(request) {
    const user = currentUser(request);
    if (!user) throw apiError("authentication_required", "sign in to continue", 401);
    return user;
  }

  function isProjectOwner(request, runtime) {
    return currentUser(request)?.username === runtime.metadata.ownerUsername;
  }

  function hasProjectAccess(request, runtime) {
    if (isProjectOwner(request, runtime)) return true;
    const session = projectSession(request);
    return Boolean(session?.record.projects.has(runtime.id));
  }

  function requireProjectAccess(request, runtime) {
    if (!hasProjectAccess(request, runtime)) {
      throw apiError("project_access_required", "open a valid project share link or sign in as the project owner", 401);
    }
  }

  function requireProjectOwner(request, runtime) {
    if (!isProjectOwner(request, runtime)) {
      throw apiError("project_owner_required", "only the project owner can manage this project", 403);
    }
  }

  function issueUserSession(request, response, username) {
    const token = randomToken();
    database.createUserSession(sha256(token), username, Date.now() + USER_SESSION_SECONDS * 1000);
    response.append("Set-Cookie", sessionCookie(request, "lc_user", token, USER_SESSION_SECONDS));
  }

  function issueProjectSession(request, response, projectId) {
    const existing = projectSession(request);
    const token = existing?.token || randomToken();
    database.addProjectSession(sha256(token), projectId, Date.now() + PROJECT_SESSION_SECONDS * 1000);
    response.append("Set-Cookie", sessionCookie(request, "lc_access", token, PROJECT_SESSION_SECONDS));
  }

  const projects = new Map();
  const initialOwnerUsername = authDisabled
    ? "test-user"
    : database.getUser("admin")
      ? "admin"
      : database.firstUsername() || null;
  function publicProjectMetadata(metadata) {
    const result = { ...metadata };
    delete result.shareToken;
    delete result.ownerUsername;
    return result;
  }

  async function loadProject(id) {
    id = safeProjectId(id);
    if (projects.has(id)) return projects.get(id);
    const metadata = database.getProject(id);
    if (!metadata) throw apiError("project_not_found", "project does not exist", 404);
    const projectRoot = path.join(projectsDir, id);
    if (!existsSync(projectRoot)) throw apiError("project_not_found", "project does not exist", 404);
    const projectDir = path.join(projectRoot, "project");
    const buildDir = path.join(projectRoot, "build");
    await mkdir(projectDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });
    const mainPath = path.join(projectDir, "main.tex");
    if (!existsSync(mainPath)) await writeFile(mainPath, DEFAULT_DOCUMENT, "utf8");
    await ensureGitRepository(projectDir);
    const build = database.getBuild(id);
    build.pdf = build.pdf && existsSync(path.join(buildDir, "latest.pdf"));
    const runtime = {
      id, metadata, projectRoot, projectDir, buildDir,
      database,
      collaboration: createCollaborationStore(id, projectDir, database),
      build,
      gitBusy: false,
      gitReaders: 0,
      gitReaderWaiters: [],
      deleting: false,
    };
    projects.set(id, runtime);
    return runtime;
  }

  async function projectSummaries(ownerUsername = null) {
    const summaries = [];
    for (const metadata of database.listProjects(ownerUsername)) {
      const runtime = await loadProject(metadata.id);
      summaries.push({ ...publicProjectMetadata(runtime.metadata), build: { status: runtime.build.status, pdf: runtime.build.pdf } });
    }
    return summaries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async function createProject(name, ownerUsername) {
    name = cleanProjectName(name);
    let id = randomProjectId();
    while (database.getProject(id) || existsSync(path.join(projectsDir, id))) id = randomProjectId();
    const projectRoot = path.join(projectsDir, id);
    const metadata = { id, name, ownerUsername, createdAt: new Date().toISOString(), shareToken: randomToken() };
    await mkdir(projectRoot, { recursive: true });
    try {
      database.createProject(metadata);
      return await loadProject(id);
    } catch (error) {
      projects.delete(id);
      database.deleteProject(id);
      await rm(projectRoot, { recursive: true, force: true });
      throw error;
    }
  }

  let existing = await projectSummaries();
  if (!existing.length && initialOwnerUsername) {
    await createProject("Paper", initialOwnerUsername);
    existing = await projectSummaries();
  }
  let defaultProjectId = existing[0]?.id || null;
  const defaultProjectForRequest = async request => {
    const user = currentUser(request);
    if (user) {
      const owned = await projectSummaries(user.username);
      if (owned.length) return owned[0].id;
    }
    const access = projectSession(request);
    if (access) {
      for (const projectId of access.record.projects) {
        if (database.getProject(projectId)) return projectId;
      }
    }
    throw apiError("project_not_found", "no accessible project was selected", 404);
  };
  const resolveProject = async request => {
    const runtime = await loadProject(request.query.project || await defaultProjectForRequest(request));
    requireProjectAccess(request, runtime);
    return runtime;
  };
  const resolveGitProject = async request => {
    const runtime = await loadProject(request.params.projectId);
    if (hasProjectAccess(request, runtime)) return runtime;
    const supplied = String(request.params.shareToken || "");
    const expected = Buffer.from(sha256(runtime.metadata.shareToken), "hex");
    const actual = Buffer.from(sha256(supplied), "hex");
    if (!timingSafeEqual(expected, actual)) throw apiError("project_access_required", "Git clone URL is invalid", 401);
    return runtime;
  };

  const expressModule = await import("express");
  const express = expressModule.default;
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    );
    if (
      request.path.startsWith("/v1/auth")
      || request.path.startsWith("/v1/invitations")
      || request.path === "/v1/project/share"
      || request.path.startsWith("/share/")
    ) response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/", (request, response) => {
    response.setHeader("Vary", "Accept, User-Agent");
    const accepted = String(request.get("accept") || "")
      .split(",")
      .map((entry, order) => {
        const [mediaType, ...parameters] = entry.trim().toLowerCase().split(";");
        const quality = parameters.reduce((value, parameter) => {
          const match = parameter.trim().match(/^q=(0(?:\.\d+)?|1(?:\.0+)?)$/);
          return match ? Number(match[1]) : value;
        }, 1);
        return { mediaType, quality, order };
      })
      .filter(entry => entry.mediaType === "text/html" || entry.mediaType === "text/markdown")
      .sort((left, right) => right.quality - left.quality || left.order - right.order);
    const representation = accepted[0]?.mediaType
      || (/Mozilla\//i.test(request.get("user-agent") || "") ? "text/html" : "text/markdown");
    if (representation === "text/html") {
      response.setHeader("Cache-Control", "no-store");
      return response.sendFile(path.join(APP_DIR, "dist", "index.html"));
    }
    return response.type("text/markdown; charset=utf-8").send(manual());
  });
  app.get(["/login", "/projects", "/projects/:projectId", "/register/:token"], (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(path.join(APP_DIR, "dist", "index.html"));
  });
  app.get("/share/:projectId/:token", async (request, response, next) => {
    try {
      const runtime = await loadProject(request.params.projectId);
      const expected = Buffer.from(sha256(runtime.metadata.shareToken), "hex");
      const actual = Buffer.from(sha256(String(request.params.token || "")), "hex");
      if (!timingSafeEqual(expected, actual)) throw apiError("share_link_invalid", "project share link is invalid", 403);
      issueProjectSession(request, response, runtime.id);
      response.redirect(303, `/projects/${encodeURIComponent(runtime.id)}`);
    } catch (error) { next(error); }
  });
  app.get("/health", (_request, response) => response.json({ ok: true, name: "latexcoder" }));
  app.get("/v1/auth/me", (request, response) => {
    response.json({
      user: currentUser(request),
      invitationOnly: true,
      bootstrapReady: database.countUsers() > 0,
    });
  });
  app.post("/v1/auth/login", express.json({ limit: "16kb" }), (request, response, next) => {
    try {
      const attemptKey = request.ip || request.socket.remoteAddress || "unknown";
      let attempts = loginAttempts.get(attemptKey);
      if (!attempts || attempts.resetAt <= Date.now()) {
        attempts = { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
        loginAttempts.set(attemptKey, attempts);
      }
      if (attempts.count >= 10) throw apiError("login_rate_limited", "too many login attempts; try again later", 429);
      const username = cleanUsername(request.body?.username);
      const user = database.getUser(username);
      if (!user || !passwordMatches(request.body?.password, user)) {
        attempts.count += 1;
        throw apiError("invalid_credentials", "username or password is incorrect", 401);
      }
      loginAttempts.delete(attemptKey);
      issueUserSession(request, response, username);
      response.json({ user: { username } });
    } catch (error) { next(error); }
  });
  app.post("/v1/auth/logout", (request, response) => {
    const session = userSession(request);
    if (session) database.deleteUserSession(session.key);
    response.append("Set-Cookie", sessionCookie(request, "lc_user", "", 0));
    response.json({ user: null });
  });
  app.get("/v1/invitations/:token", (request, response, next) => {
    try {
      const invitation = database.getInvitation(sha256(String(request.params.token || "")));
      const valid = invitation && !invitation.usedAt && invitation.expiresAt > Date.now();
      if (!valid) throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
      response.json({ invitation: { invitedBy: invitation.createdBy, expiresAt: new Date(invitation.expiresAt).toISOString() } });
    } catch (error) { next(error); }
  });
  app.post("/v1/invitations", (request, response, next) => {
    try {
      const user = requireUser(request);
      const token = randomToken();
      const createdAt = new Date();
      database.createInvitation({
        tokenHash: sha256(token),
        createdBy: user.username,
        createdAt: createdAt.toISOString(),
        expiresAt: createdAt.getTime() + INVITATION_SECONDS * 1000,
      });
      response.status(201).json({ invitation: { token, path: `/register/${token}` } });
    } catch (error) { next(error); }
  });
  app.post("/v1/auth/register", express.json({ limit: "16kb" }), (request, response, next) => {
    try {
      const token = String(request.body?.token || "");
      const tokenHash = sha256(token);
      const invitation = database.getInvitation(tokenHash);
      if (!invitation || invitation.usedAt || invitation.expiresAt <= Date.now()) {
        throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
      }
      const username = cleanUsername(request.body?.username);
      if (database.getUser(username)) throw apiError("username_taken", "username is already registered", 409);
      const password = validatePassword(request.body?.password);
      const createdAt = new Date().toISOString();
      database.transaction(() => {
        const current = database.getInvitation(tokenHash);
        if (!current || current.usedAt || current.expiresAt <= Date.now()) {
          throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
        }
        database.createUser({ username, ...passwordRecord(password), createdAt, invitedBy: current.createdBy });
        if (!database.consumeInvitation(tokenHash, username, createdAt)) {
          throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
        }
      });
      issueUserSession(request, response, username);
      response.status(201).json({ user: { username } });
    } catch (error) { next(error); }
  });
  app.get("/v1/projects", async (request, response, next) => {
    try {
      const user = requireUser(request);
      const owned = await projectSummaries(user.username);
      response.json({ projects: owned, defaultProjectId: owned[0]?.id || null });
    }
    catch (error) { next(error); }
  });
  app.post("/v1/projects", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const user = requireUser(request);
      const runtime = await createProject(request.body?.name, user.username);
      response.status(201).json({ project: { ...publicProjectMetadata(runtime.metadata), build: runtime.build } });
    } catch (error) { next(error); }
  });
  app.patch("/v1/projects/:projectId", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await loadProject(request.params.projectId);
      requireProjectOwner(request, runtime);
      runtime.metadata = { ...runtime.metadata, name: cleanProjectName(request.body?.name) };
      database.saveProject(runtime.metadata);
      response.json({ project: publicProjectMetadata(runtime.metadata) });
    } catch (error) { next(error); }
  });
  app.delete("/v1/projects/:projectId", async (request, response, next) => {
    try {
      const runtime = await loadProject(request.params.projectId);
      requireProjectOwner(request, runtime);
      const ownerUsername = runtime.metadata.ownerUsername;
      await waitForGitReaders(runtime);
      runtime.collaboration.shutdown();
      projects.delete(runtime.id);
      const deletedRoot = `${runtime.projectRoot}.deleted-${randomUUID()}`;
      await rename(runtime.projectRoot, deletedRoot);
      try {
        database.deleteProject(runtime.id);
      } catch (error) {
        await rename(deletedRoot, runtime.projectRoot);
        throw error;
      }
      await rm(deletedRoot, { recursive: true, force: true });
      const remaining = await projectSummaries(ownerUsername);
      if (defaultProjectId === runtime.id) defaultProjectId = (await projectSummaries())[0]?.id || null;
      response.json({ deleted: { id: runtime.id }, defaultProjectId: remaining[0]?.id || null });
    } catch (error) { next(error); }
  });
  app.get("/v1/project", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      response.json({ project: {
        ...publicProjectMetadata(runtime.metadata),
        main: runtime.build.main,
        files: await listFiles(runtime.projectDir),
        build: runtime.build,
        permissions: { manage: isProjectOwner(request, runtime) },
      } });
    } catch (error) { next(error); }
  });
  app.get("/v1/project/share", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      requireProjectOwner(request, runtime);
      response.json({ share: {
        path: `/share/${encodeURIComponent(runtime.id)}/${runtime.metadata.shareToken}`,
        clonePath: `/git/${encodeURIComponent(runtime.id)}/${runtime.metadata.shareToken}`,
      } });
    } catch (error) { next(error); }
  });
  app.get("/v1/project/archive", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const { archive, temporary } = await withGitReader(runtime, () => createProjectArchive(runtime));
      response.download(archive, `${runtime.id}.zip`, async error => {
        await rm(temporary, { recursive: true, force: true });
        if (error && !response.headersSent) next(error);
      });
    } catch (error) { next(error); }
  });
  app.get("/v1/git", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      response.json({ git: await withGitReader(runtime, () => gitStatus(runtime)) });
    }
    catch (error) { next(error); }
  });
  app.post("/v1/git/commit", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const payload = await withGitReader(runtime, async () => {
        const result = await withGitOperation(runtime, () => gitCheckpoint(runtime, request.body?.message));
        return { ...result, status: await gitStatus(runtime) };
      });
      response.json({ git: payload });
    } catch (error) { next(error); }
  });
  app.post("/v1/git/sync", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const payload = await withGitReader(runtime, async () => {
        const result = await gitSync(runtime, request.body?.ref);
        return { ...result, current: await gitStatus(runtime) };
      });
      response.json({ git: payload });
    } catch (error) { next(error); }
  });
  app.post("/v1/git/resolve", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const payload = await withGitReader(runtime, async () => {
        const result = await gitResolve(runtime, request.body?.message);
        return { ...result, current: await gitStatus(runtime) };
      });
      response.json({ git: payload });
    } catch (error) { next(error); }
  });
  app.get(["/git/:projectId/info/refs", "/git/:projectId/:shareToken/info/refs"], async (request, response, next) => {
    try {
      if (request.query.service !== "git-upload-pack") throw apiError("git_service_invalid", "only git-upload-pack is available", 400);
      const runtime = await resolveGitProject(request);
      const advertised = await withGitReader(runtime, () => gitUploadPack(
        runtime,
        ["--advertise-refs"],
        Buffer.alloc(0),
        request.get("git-protocol"),
      ));
      response.setHeader("Cache-Control", "no-store");
      response.type("application/x-git-upload-pack-advertisement");
      response.send(Buffer.concat([Buffer.from("001e# service=git-upload-pack\n0000"), advertised]));
    } catch (error) { next(error); }
  });
  app.post(["/git/:projectId/git-upload-pack", "/git/:projectId/:shareToken/git-upload-pack"], express.raw({ type: () => true, limit: "2mb" }), async (request, response, next) => {
    try {
      const runtime = await resolveGitProject(request);
      const result = await withGitReader(runtime, () => gitUploadPack(
        runtime,
        [],
        Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        request.get("git-protocol"),
      ));
      response.setHeader("Cache-Control", "no-store");
      response.type("application/x-git-upload-pack-result").send(result);
    } catch (error) { next(error); }
  });
  app.get("/v1/files", async (request, response, next) => {
    try {
      const { projectDir, collaboration } = await resolveProject(request);
      const relativePath = safeRelativePath(request.query.path);
      if (isTextFile(relativePath)) {
        const source = collaboration.readText(relativePath);
        const revision = sha256(source);
        response.setHeader("ETag", `"${revision}"`);
        response.setHeader("X-Content-SHA256", revision);
        return response.type(path.extname(relativePath)).send(source);
      }
      response.sendFile(path.join(projectDir, relativePath), { dotfiles: "allow" }, error => {
        if (error && !response.headersSent) next(apiError("file_not_found", "file does not exist", 404));
      });
    } catch (error) { next(error); }
  });
  app.put("/v1/files", express.raw({ type: () => true, limit: MAX_FILE_BYTES }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const { projectDir, collaboration } = runtime;
      const relativePath = safeRelativePath(request.query.path);
      const target = path.join(projectDir, relativePath);
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (isTextFile(relativePath) && body.length > MAX_TEXT_BYTES) throw apiError("file_too_large", "text file is too large", 413);
      await mkdir(path.dirname(target), { recursive: true });
      if (isTextFile(relativePath) && collaboration.replaceText(relativePath, body.toString("utf8"))) {
        collaboration.flush();
      } else {
        await writeFile(target, body);
        await collaboration.remove(relativePath);
      }
      response.status(201).json({ file: { path: relativePath, size: body.length, text: isTextFile(relativePath) } });
    } catch (error) { next(error); }
  });
  app.post("/v1/files/patch", express.json({ limit: `${MAX_TEXT_BYTES}b` }), (request, response, next) => {
    resolveProject(request).then(runtime => {
      assertProjectWritable(runtime);
      const { collaboration } = runtime;
      const relativePath = safeRelativePath(request.query.path);
      if (!isTextFile(relativePath)) throw apiError("not_text", "only text files can be patched", 415);
      const result = collaboration.patchText(relativePath, request.body?.baseSha256, request.body?.changes, {
        mode: request.body?.mode,
        agent: request.body?.agent,
      });
      collaboration.flush();
      response.setHeader("ETag", `"${result.sha256}"`);
      response.setHeader("X-Content-SHA256", result.sha256);
      response.json({
        file: { path: relativePath, size: Buffer.byteLength(result.source), text: true, sha256: result.sha256 },
        patch: { mode: result.mode, suggestionIds: result.suggestionIds },
      });
    }).catch(next);
  });
  app.delete("/v1/files", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const { projectDir, collaboration } = runtime;
      const relativePath = safeRelativePath(request.query.path);
      if (relativePath === runtime.build.main) throw apiError("main_file_required", "the main document cannot be deleted", 409);
      await rm(path.join(projectDir, relativePath), { force: false });
      await collaboration.remove(relativePath);
      response.json({ deleted: { path: relativePath } });
    } catch (error) {
      if (error.code === "ENOENT") next(apiError("file_not_found", "file does not exist", 404));
      else next(error);
    }
  });
  app.post("/v1/files/move", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const { projectDir, collaboration } = runtime;
      const from = safeRelativePath(request.body?.from);
      const to = safeRelativePath(request.body?.to);
      await mkdir(path.dirname(path.join(projectDir, to)), { recursive: true });
      await rename(path.join(projectDir, from), path.join(projectDir, to));
      await collaboration.remove(from);
      await collaboration.remove(to);
      if (runtime.build.main === from) runtime.build.main = to;
      response.json({ file: { path: to } });
    } catch (error) { next(error); }
  });
  app.get("/v1/build", async (request, response, next) => {
    try { response.json({ build: (await resolveProject(request)).build }); }
    catch (error) { next(error); }
  });
  app.get("/v1/build/pdf", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      if (!runtime.build.pdf) return next(apiError("pdf_not_found", "no successful PDF build exists", 404));
      response.setHeader("Cache-Control", "no-store");
      response.sendFile(path.join(runtime.buildDir, "latest.pdf"), { dotfiles: "allow" });
    } catch (error) { next(error); }
  });
  app.post("/v1/compile", express.json({ limit: "16kb" }), async (request, response, next) => {
    let workDir;
    let runtime;
    try {
      runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const { projectDir, buildDir, collaboration } = runtime;
      if (runtime.build.status === "running") throw apiError("compile_busy", "a compile is already running", 409);
      collaboration.flush();
      const main = safeRelativePath(request.body?.main || runtime.build.main || "main.tex");
      if (!main.endsWith(".tex")) throw apiError("invalid_main", "main document must be a .tex file");
      runtime.build = { status: "running", main, startedAt: new Date().toISOString(), finishedAt: null, log: "", pdf: runtime.build.pdf };
      database.saveBuild(runtime.id, runtime.build);
      workDir = path.join(buildDir, `job-${randomUUID()}`);
      const gitDir = path.join(projectDir, ".git");
      await cp(projectDir, workDir, { recursive: true, filter: source => source !== gitDir && !source.startsWith(`${gitDir}${path.sep}`) });
      // Review storage belongs to the editor, not the rendered document.
      // Compile a clean temporary projection of every TeX file: comment and
      // legacy revision bodies remain, additions are accepted, and deletions
      // disappear. Canonical project files are never rewritten here.
      for (const file of await listFiles(workDir)) {
        if (!file.path.endsWith(".tex")) continue;
        const sourcePath = path.join(workDir, file.path);
        const source = await readFile(sourcePath, "utf8");
        await writeFile(sourcePath, stripReviewStorage(source), "utf8");
      }
      const outputDir = path.join(workDir, ".paper-output");
      await mkdir(outputDir, { recursive: true });
      const compiler = await findCompiler(options.compiler || process.env.LATEXCODER_LATEX_BIN, stateDir);
      const executable = path.basename(compiler);
      const args = executable.startsWith("latexmk")
        ? ["-pdf", "-interaction=nonstopmode", "-halt-on-error", `-outdir=${outputDir}`, main]
        : ["--keep-logs", "--outdir", outputDir, main];
      const result = await run(compiler, args, {
        cwd: workDir,
        env: { ...process.env, XDG_CACHE_HOME: path.join(stateDir, "cache") },
      });
      const pdfName = `${path.basename(main, ".tex")}.pdf`;
      const outputPdf = path.join(outputDir, pdfName);
      const success = result.code === 0 && existsSync(outputPdf);
      if (success) await cp(outputPdf, path.join(buildDir, "latest.pdf"));
      runtime.build = {
        status: success ? "success" : "error",
        main,
        startedAt: runtime.build.startedAt,
        finishedAt: new Date().toISOString(),
        log: result.output || (success ? "Compilation completed." : `Compiler exited with code ${result.code}.`),
        pdf: success || runtime.build.pdf,
      };
      database.saveBuild(runtime.id, runtime.build);
      response.status(success ? 200 : 422).json({ build: runtime.build });
    } catch (error) {
      if (runtime) {
        runtime.build = {
          ...runtime.build,
          status: "error",
          finishedAt: new Date().toISOString(),
          log: error.message,
        };
        database.saveBuild(runtime.id, runtime.build);
      }
      next(error);
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  });

  app.use(express.static(path.join(APP_DIR, "dist"), { index: false, maxAge: "1y", immutable: true }));
  app.use((request, _response, next) => next(apiError("route_not_found", `route ${request.method} ${request.path} does not exist`, 404)));
  app.use((error, _request, response, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 500;
    const code = error.code && typeof error.code === "string" ? error.code : "internal_error";
    if (status >= 500) console.error(error);
    response.status(status).json({ error: { code, message: status >= 500 ? "internal server error" : error.message } });
  });

  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_TEXT_BYTES });
  server.on("upgrade", (request, socket, head) => {
    (async () => {
      const url = new URL(request.url, "http://paper.internal");
      const prefix = "/v1/collab/";
      if (!url.pathname.startsWith(prefix)) throw apiError("route_not_found", "websocket route not found", 404);
      const parts = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent);
      const scoped = parts.length > 1;
      const runtime = await loadProject(scoped ? parts[0] : await defaultProjectForRequest(request));
      requireProjectAccess(request, runtime);
      const relativePath = pathFromRoomName(scoped ? parts[1] : parts[0]);
      sockets.handleUpgrade(request, socket, head, connection => runtime.collaboration.attach(connection, relativePath));
    })().catch(() => {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
  });

  const defaultRuntime = defaultProjectId ? await loadProject(defaultProjectId) : null;
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    for (const runtime of projects.values()) runtime.collaboration.shutdown();
    database.close();
    closed = true;
  };
  return {
    app, server, sockets, stateDir, projectsDir, projects, database, shutdown,
    // Kept for API consumers of the original single-project server.
    projectDir: defaultRuntime?.projectDir,
    collaboration: defaultRuntime?.collaboration,
  };
}

export async function startPaperServer(options: any = {}) {
  const paper = await createPaperServer(options);
  const host = options.host || process.env.LATEXCODER_HOST || "0.0.0.0";
  const port = Number(options.port || process.env.LATEXCODER_PORT || 8090);
  await new Promise<void>((resolve, reject) => {
    paper.server.once("error", reject);
    paper.server.listen(port, host, () => resolve());
  });
  const address = paper.server.address();
  console.log(`LaTeX Coder listening on http://${host}:${typeof address === "object" && address ? address.port : port}`);
  return paper;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paper = await startPaperServer();
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    paper.shutdown();
    paper.sockets.close();
    paper.server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
