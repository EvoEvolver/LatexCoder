import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
import { unzipSync } from "fflate";

import { StateDatabase } from "./src/database.ts";
import { parseReviews, stripReviewStorage } from "./src/review.ts";
import { compileSourceMap, projectedPosition } from "./src/source-map.ts";
import { syncTexPositions } from "./src/pdf-map.ts";
import { fileChanges } from "./src/file-diff.ts";
import { compileErrors } from "./src/compile-errors.ts";
import { createPatch } from "diff";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEXT_EXTENSIONS = new Set([".bib", ".cls", ".csv", ".json", ".md", ".sty", ".tex", ".txt", ".yaml", ".yml"]);
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_SAVED = 3;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PATCH_CHANGES = 1_000;
const MAX_SEARCH_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_BOOLEAN_OPTIONS = new Set([
  "--auto-hybrid-regex", "--block-buffered", "--byte-offset", "--case-sensitive",
  "--column", "--count", "--count-matches", "--crlf", "--fixed-strings",
  "--heading", "--hidden", "--ignore-case", "--include-zero", "--invert-match",
  "--json", "--line-buffered", "--line-number", "--multiline", "--multiline-dotall",
  "--max-columns-preview",
  "--no-filename", "--no-heading", "--no-ignore", "--no-ignore-dot",
  "--no-ignore-exclude", "--no-ignore-files", "--no-ignore-global", "--no-ignore-messages",
  "--no-ignore-parent", "--no-ignore-vcs", "--no-line-number", "--no-messages",
  "--no-require-git", "--no-unicode", "--null", "--null-data", "--one-file-system",
  "--only-matching", "--passthru", "--pcre2", "--pretty", "--quiet",
  "--smart-case", "--stats", "--stop-on-nonmatch", "--text", "--trim", "--unicode",
  "--vimgrep", "--with-filename", "--word-regexp", "--line-regexp",
  "--files-with-matches", "--files-without-match",
]);
const SEARCH_VALUE_OPTIONS = new Set([
  "--after-context", "--before-context", "--context", "--context-separator",
  "--dfa-size-limit", "--encoding", "--engine", "--field-context-separator",
  "--field-match-separator", "--glob", "--iglob", "--max-columns",
  "--max-count", "--max-depth", "--max-filesize",
  "--path-separator", "--regex-size-limit", "--replace", "--sort", "--sortr",
  "--type", "--type-not",
]);
const SEARCH_SHORT_BOOLEAN_OPTIONS = new Set(["a", "c", "F", "H", "I", "i", "l", "n", "N", "o", "p", "P", "q", "s", "S", "U", "u", "v", "w", "x"]);
const SEARCH_SHORT_VALUE_OPTIONS = new Set(["A", "B", "C", "E", "g", "j", "m", "M", "r", "t", "T"]);
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

function apiError(code: string, message: string, status = 400, details: Record<string, unknown> | undefined = undefined) {
  return Object.assign(new Error(message), { code, status, details });
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

function contentPath(value) {
  const result = safeRelativePath(value);
  if (result.split("/").some(part => part.startsWith("."))) throw apiError("invalid_path", "Hidden metadata paths are not editable");
  return result;
}

function isTextFile(relativePath) {
  return TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function readProjectZip(body) {
  let total = 0;
  let count = 0;
  let files;
  try {
    files = unzipSync(body, { filter: entry => {
      if (++count > 1000 || entry.originalSize > MAX_FILE_BYTES || (total += entry.originalSize) > 100 * 1024 * 1024) {
        throw apiError("zip_too_large", "ZIP exceeds file count or extracted size limits", 413);
      }
      if (entry.name.includes("\\") || entry.name.split("/").some(part => part === ".." || part === ".git" || part === ".paper-output")) {
        throw apiError("invalid_zip_path", "ZIP contains an unsafe path");
      }
      if (entry.name.endsWith("/")) return false;
      safeRelativePath(entry.name);
      return !entry.name.startsWith("__MACOSX/") && !entry.name.endsWith(".DS_Store");
    } });
  } catch (error) {
    if (error.status) throw error;
    throw apiError("invalid_zip", "ZIP archive could not be read");
  }
  const entries = Object.entries(files) as [string, Uint8Array][];
  if (!entries.length) throw apiError("empty_zip", "ZIP contains no project files");
  const root = entries[0][0].split("/")[0];
  const stripRoot = entries.every(([name]) => name.startsWith(`${root}/`));
  const result = entries.map(([name, content]) => {
    const relativePath = safeRelativePath(stripRoot ? name.slice(root.length + 1) : name);
    if (isTextFile(relativePath) && content.length > MAX_TEXT_BYTES) throw apiError("file_too_large", "ZIP text file is too large", 413);
    return { relativePath, content };
  });
  const names = new Set(result.map(file => file.relativePath));
  if (names.size !== result.length) throw apiError("invalid_zip_path", "ZIP contains duplicate paths");
  for (const name of names) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (names.has(parts.slice(0, index).join("/"))) throw apiError("invalid_zip_path", "ZIP contains conflicting file and directory paths");
    }
  }
  return result;
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

function cleanDisplayName(value) {
  if (typeof value !== "string") throw apiError("invalid_display_name", "display name is required");
  const displayName = value.replace(/\s+/g, " ").trim();
  if (!displayName || displayName.length > 28) {
    throw apiError("invalid_display_name", "display name must contain 1 to 28 characters");
  }
  return displayName;
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

function isWellFormedUtf16(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
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
  const connectionShares = new WeakMap();
  const savedConnections = new WeakSet();
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
      acknowledge(shared);
    }, 180);
  }

  function broadcast(shared, payload, except = null) {
    for (const connection of shared.connections.keys()) {
      if (connection !== except && connection.readyState === WebSocket.OPEN) connection.send(payload);
    }
  }

  function acknowledge(shared) {
    for (const [client, nonce] of shared.saveRequests) {
      if (client.readyState === WebSocket.OPEN) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SAVED);
        encoding.writeVarString(encoder, nonce);
        client.send(encoding.toUint8Array(encoder));
      }
    }
    shared.saveRequests.clear();
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
      saveRequests: new Map(),
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

  function attach(connection, relativePath, shareId = null, savedAcknowledgments = false) {
    if (suspended) {
      connection.close(1012, "project is synchronizing with Git");
      return;
    }
    const shared = load(relativePath);
    shared.connections.set(connection, new Set());
    connectionShares.set(connection, shareId);
    if (savedAcknowledgments) savedConnections.add(connection);
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
          persist(shared);
        } else if (type === MESSAGE_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(
            shared.awareness,
            decoding.readVarUint8Array(decoder),
            connection,
          );
        } else if (type === MESSAGE_SAVED && savedConnections.has(connection)) {
          const nonce = decoding.readVarString(decoder);
          if (nonce.length > 64) throw apiError("invalid_nonce", "Save nonce too long");
          shared.saveRequests.set(connection, nonce);
          persist(shared);
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
      shared.saveRequests.delete(connection);
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
    const currentSha256 = sha256(source);
    if (currentSha256 !== baseSha256) {
      throw apiError("stale_file", "file changed since it was read; fetch it and retry the patch", 409, {
        path: relativePath,
        expectedSha256: baseSha256,
        currentSha256,
      });
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
      if (!isWellFormedUtf16(insert)) {
        throw apiError("invalid_change", `changes[${index}].insert contains an unpaired UTF-16 surrogate`);
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

  function editFile(relativePath, baseSha256, updated, options: any = {}) {
    if (typeof baseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(baseSha256)) throw apiError("invalid_base_sha256", "X-Base-SHA256 must be a lowercase SHA-256 hex digest");
    const source = readText(relativePath);
    const currentSha256 = sha256(source);
    if (currentSha256 !== baseSha256) throw apiError("stale_file", "file changed since it was downloaded; download the latest file, reapply your edits, and retry", 409, { path: relativePath, expectedSha256: baseSha256, currentSha256 });
    const mode = options.mode ?? "direct";
    if (mode !== "direct" && mode !== "suggesting") throw apiError("invalid_mode", "mode must be suggesting or direct");
    if (mode === "suggesting") agentAuthor(options.agent);
    const changes = fileChanges(source, updated);
    if (!changes.length) return { source, sha256: currentSha256, mode, suggestionIds: [], changeCount: 0 };
    const result = patchText(relativePath, baseSha256, changes, { ...options, mode });
    return { ...result, changeCount: changes.length };
  }

  function flush() {
    for (const shared of docs.values()) {
      if (shared.removed) continue;
      if (shared.persistTimer) clearTimeout(shared.persistTimer);
      shared.persistTimer = undefined;
      atomicWriteSync(path.join(projectDir, shared.relativePath), shared.doc.getText("content").toString());
      database.saveYjsSnapshot(projectId, shared.relativePath, Y.encodeStateAsUpdate(shared.doc));
      acknowledge(shared);
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

  function disconnectShare(shareId, reason) {
    for (const shared of docs.values()) {
      for (const connection of shared.connections.keys()) {
        if (connectionShares.get(connection) === shareId) connection.close(1008, reason);
      }
    }
  }

  return { attach, disconnectShare, editFile, flush, importText, load, patchText, readText, remove, replaceText, resume, roomNameForPath, shutdown, suspend };
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

async function listFolders(projectDir, prefix = ""): Promise<string[]> {
  const folders: string[] = [];
  for (const entry of await readdir(path.join(projectDir, prefix), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folder = prefix ? `${prefix}/${entry.name}` : entry.name;
    folders.push(folder, ...await listFolders(projectDir, folder));
  }
  return folders.sort();
}

function checkedContentTarget(root: string, relativePath: string) {
  const target = path.join(root, contentPath(relativePath));
  for (let directory = target; directory !== root; directory = path.dirname(directory)) {
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw apiError("invalid_path", "Symbolic links are not editable");
  }
  return target;
}

function contentEntries(root: string, relativePath: string): Array<{ path: string; directory: boolean }> {
  const target = checkedContentTarget(root, relativePath);
  const info = lstatSync(target);
  const entries = [{ path: relativePath, directory: info.isDirectory() }];
  if (info.isDirectory()) for (const child of readdirSync(target)) {
    if (child.startsWith(".")) throw apiError("invalid_path", "Folder contains hidden metadata");
    entries.push(...contentEntries(root, `${relativePath}/${child}`));
  }
  return entries;
}

async function compilationSourceRevision(projectDir, main = "main.tex", compiler = "auto") {
  const digest = createHash("sha256");
  digest.update(`${main}\0${compiler}\0`);
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".paper-output") continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        let content = await readFile(absolutePath);
        if (relativePath.endsWith(".tex")) content = Buffer.from(stripReviewStorage(content.toString("utf8")));
        digest.update(relativePath);
        digest.update("\0");
        digest.update(String(content.length));
        digest.update("\0");
        digest.update(content);
        digest.update("\0");
      }
    }
  }
  await visit(projectDir);
  return digest.digest("hex");
}

function run(command: string, args: string[], options: any): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 60_000, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, shell: false });
    let output = "";
    const append = chunk => { output = (output + chunk.toString()).slice(-300_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function validatedSearchOptions(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw apiError("invalid_search_args", "args must be an array of at most 64 ripgrep options");
  }
  const args = [];
  for (let index = 0; index < value.length; index += 1) {
    const argument = value[index];
    if (typeof argument !== "string" || !argument || argument.length > 512 || argument.includes("\0")) {
      throw apiError("invalid_search_args", `args[${index}] is invalid`);
    }
    if (argument === "--" || !argument.startsWith("-")) {
      throw apiError("invalid_search_args", `args[${index}] must be a supported ripgrep option`);
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = equals === -1 ? argument : argument.slice(0, equals);
      if (SEARCH_BOOLEAN_OPTIONS.has(name) && equals === -1) {
        args.push(argument);
        continue;
      }
      if (SEARCH_VALUE_OPTIONS.has(name)) {
        if (equals !== -1) {
          if (equals === argument.length - 1) throw apiError("invalid_search_args", `${name} requires a value`);
          args.push(argument);
          continue;
        }
        const optionValue = value[index + 1];
        if (typeof optionValue !== "string" || !optionValue || optionValue.length > 512 || optionValue.includes("\0")) {
          throw apiError("invalid_search_args", `${name} requires a value`);
        }
        args.push(argument, optionValue);
        index += 1;
        continue;
      }
      throw apiError("unsupported_search_option", `${name} is not available through the search API`);
    }
    const option = argument[1];
    if (argument.length === 2 && SEARCH_SHORT_VALUE_OPTIONS.has(option)) {
      const optionValue = value[index + 1];
      if (typeof optionValue !== "string" || !optionValue || optionValue.length > 512 || optionValue.includes("\0")) {
        throw apiError("invalid_search_args", `${argument} requires a value`);
      }
      args.push(argument, optionValue);
      index += 1;
      continue;
    }
    if (SEARCH_SHORT_VALUE_OPTIONS.has(option) && argument.length > 2) {
      args.push(argument);
      continue;
    }
    if ([...argument.slice(1)].every(character => SEARCH_SHORT_BOOLEAN_OPTIONS.has(character))) {
      args.push(argument);
      continue;
    }
    throw apiError("unsupported_search_option", `${argument} is not available through the search API`);
  }
  return args;
}

async function validatedSearchPaths(projectDir, value) {
  if (value === undefined) return ["."];
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw apiError("invalid_search_paths", "paths must contain 1 to 32 project-relative paths");
  }
  const paths = [];
  for (let index = 0; index < value.length; index += 1) {
    const relativePath = value[index] === "." ? "." : safeRelativePath(value[index]);
    if (relativePath.split("/").includes(".git")) {
      throw apiError("invalid_search_paths", "Git metadata cannot be searched");
    }
    if (relativePath !== ".") {
      let current = projectDir;
      for (const component of relativePath.split("/")) {
        current = path.join(current, component);
        try {
          if ((await lstat(current)).isSymbolicLink()) {
            throw apiError("invalid_search_paths", "search paths cannot traverse symbolic links");
          }
        } catch (error) {
          if (error.code === "ENOENT") break;
          throw error;
        }
      }
    }
    paths.push(relativePath);
  }
  return paths;
}

async function executablePath(command) {
  const candidates = command.includes(path.sep)
    ? [command]
    : (process.env.PATH || "").split(path.delimiter).filter(Boolean).map(directory => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, 1);
      return await realpath(candidate);
    } catch {}
  }
  return null;
}

async function runRipgrep(projectDir, args, options: any = {}): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  const bwrap = await executablePath(options.bwrap || process.env.LATEXCODER_BWRAP_BIN || "bwrap");
  if (!bwrap) throw apiError("search_sandbox_unavailable", "bubblewrap is required for project search", 503);
  const rg = await executablePath(options.rg || process.env.LATEXCODER_RG_BIN || "rg");
  if (!rg) throw apiError("search_unavailable", "ripgrep is not installed", 503);
  const sandboxArgs = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--cap-drop", "ALL",
    "--clearenv",
    "--setenv", "PATH", "/usr/bin",
    "--setenv", "HOME", "/tmp",
    "--dir", "/usr",
    "--dir", "/usr/bin",
    "--ro-bind", rg, "/usr/bin/rg",
  ];
  for (const runtimePath of ["/lib", "/lib64", "/usr/lib", "/usr/lib64"]) {
    if (existsSync(runtimePath)) sandboxArgs.push("--ro-bind", runtimePath, runtimePath);
  }
  sandboxArgs.push(
    "--tmpfs", "/tmp",
    "--ro-bind", projectDir, "/project",
    "--chdir", "/project",
    "/usr/bin/rg",
    ...args,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(bwrap, sandboxArgs, {
      shell: false,
      env: { PATH: process.env.PATH || "" },
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    let limitExceeded = false;
    let timedOut = false;
    const append = target => chunk => {
      size += chunk.length;
      if (size > MAX_SEARCH_OUTPUT_BYTES) {
        limitExceeded = true;
        child.kill("SIGKILL");
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on("data", append(stdout));
    child.stderr.on("data", append(stderr));
    child.on("error", error => {
      if (!settled) reject(apiError("search_unavailable", error.message, 503));
      settled = true;
    });
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS)
      : DEFAULT_SEARCH_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (limitExceeded) return reject(apiError("search_output_too_large", "ripgrep output exceeded 4 MiB", 413));
      if (timedOut) return reject(apiError("search_timeout", `ripgrep exceeded the ${timeoutMs}ms search limit`, 408));
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
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
  const comments = reviews.filter(item => item.kind === "comment");
  const replies = comments.flatMap(item => item.replies);
  if (
    comments.some(item => !item.repliesValid)
    || source.split("\\cmtrpl").length - 1 !== replies.length
    || new Set(replies.map(reply => reply.id)).size !== replies.length
  ) {
    throw apiError("git_review_conflict", `${relativePath} contains malformed comment replies`, 409);
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

async function gitSyncLocked(runtime, requestedRef) {
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
}

async function gitSync(runtime, requestedRef) {
  return withGitOperation(runtime, () => gitSyncLocked(runtime, requestedRef));
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

async function syncGitIngress(runtime) {
  const ingressDir = path.join(runtime.projectRoot, "receive.git");
  if (!existsSync(ingressDir)) await git(runtime.projectDir, ["init", "--bare", ingressDir]);
  const head = await gitHead(runtime.projectDir);
  await git(ingressDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(ingressDir, ["fetch", "--no-tags", runtime.projectDir, `+${head}:refs/heads/main`]);
  return { ingressDir, head };
}

async function gitReceivePack(runtime, args, input, protocol) {
  const { ingressDir, head: before } = await syncGitIngress(runtime);
  const env: Record<string, string | undefined> = { ...process.env, ...GIT_IDENTITY_ENV };
  if (protocol) env.GIT_PROTOCOL = protocol;
  const output = await runBinary("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "receive.denyDeletes=true",
    "-c", "receive.denyNonFastForwards=true",
    "receive-pack", "--stateless-rpc", ...args, ingressDir,
  ], { cwd: ingressDir, env }, input);
  if (args.includes("--advertise-refs")) return { output, sync: null };

  const incoming = await gitHead(ingressDir, "refs/heads/main");
  if (incoming === before) return { output, sync: null };
  const incomingRef = `refs/latexcoder/incoming/${randomUUID()}`;
  try {
    await git(runtime.projectDir, ["fetch", "--no-tags", ingressDir, `+refs/heads/main:${incomingRef}`]);
    const sync = await gitSyncLocked(runtime, incomingRef);
    return { output, sync };
  } finally {
    await git(runtime.projectDir, ["update-ref", "-d", incomingRef], { allowedCodes: [0, 1] });
    await syncGitIngress(runtime);
  }
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
The list contains projects owned by or shared with the current member.
\`POST /v1/projects\` with \`{"name":"My paper"}\` creates an owned project.
Only its owner can rename or delete it. Rename or delete one with
\`PATCH /v1/projects/:id\` and \`DELETE /v1/projects/:id\`.

Every project-specific request below accepts \`?project=<id>\`. If omitted,
the first accessible project is used.

Browser routes \`/projects\` and \`/projects/:id\` provide the member dashboard
and clean editor URLs. A guest first opens \`/share/<project-id>/<secret>\` to
establish a project-scoped session. That session authorizes only the selected
project and does not expose the owner's dashboard. Signing in alone never grants
access to another member's projects. A signed-in user who opens a valid share
link joins as a persistent registered collaborator. Each registered member gets
a different personal secret from \`POST /v1/project/share?project=<id>\`;
rotating it does not revoke another member's links or project membership.

Each project's source directory is an independent Git repository whose live
working tree always remains on \`main\`. \`GET /v1/git\` returns status and
history. \`POST /v1/git/commit\` creates a collaborative checkpoint.
Each registered collaborator gets a personal smart HTTP URL at
\`/git/<project-id>/<share-secret>\`. Clone it and push \`main\` normally; no
upstream configuration is required. A push checkpoints current Yjs changes and
automatically merges the incoming commit into the live document. Conflicts are
quarantined on \`conflict/<UTC timestamp>\`; Yjs and main remain unchanged.
After resolving the content on main, \`POST /v1/git/resolve\` records the
two-parent merge commit.

\`GET /v1/project/archive?project=<id>\` downloads the current working tree as
a ZIP, including uncommitted files.

## Inspect

\`GET /v1/project\` lists project files and the latest build.

\`GET /v1/files?path=main.tex\` reads a file as bytes.
The response includes the current \`X-Content-SHA256\` revision.

\`POST /v1/search\` runs ripgrep inside the project. Send
\`{"pattern":"citation","args":["--line-number","--glob","*.tex"],"paths":["."]}\`.
The response body is native ripgrep output and \`X-Ripgrep-Exit-Code\` is 0 for
matches or 1 for no matches.

\`GET /v1/build/pdf\` downloads a PDF for the current project contents. The
server compiles automatically when the inputs have changed and otherwise reuses
its matching cached artifact.

## Mutate

\`PUT /v1/files?path=chapters/intro.tex\` writes the raw request body.

\`POST /v1/files/edit?path=main.tex\` uploads the complete updated UTF-8 file
as raw bytes. Supply the downloaded file's \`X-Content-SHA256\` in the
\`X-Base-SHA256\` request header. The server checks the live Yjs revision,
calculates the diff, and applies it in one transaction. Stale uploads return
HTTP 409 without changing the file. Direct editing is the default.
To create suggestions, add \`&mode=suggesting&agentId=ag_unique&agentName=writer\`.

\`DELETE /v1/files?path=chapters/intro.tex\` removes a file.

\`POST /v1/compile\` with JSON \`{"main":"main.tex"}\` compiles a PDF.

Text files are synchronized through Yjs. Writing through the API updates connected editors. Inline comments use \`\\cmtbg{id}{name}text\\cmted{comment}\`; replies are appended inside the final argument as \`\\cmtrpl{reply-id}{name}{reply}\`. Suggestion mode tracks insertions as \`\\addbg{id}{name}text\\added\` and deletions as \`\\delbg{id}{name}text\\deled\`.

## Trust

Passwords are scrypt-hashed and share URLs are bearer secrets exchanged for
24-hour, project-scoped sessions. Anyone holding a share URL can edit and
reshare that project. Users, invitations, projects, sessions, build state, and
Yjs snapshots are persisted in SQLite. LaTeX
compilation is not a security sandbox; use this service with trusted teams and
do not store unrelated secrets in project directories.
`;
}

function agentProjectManual(runtime, files, shareToken, origin) {
  const capability = new URLSearchParams({ project: runtime.id, access: shareToken });
  const fileUrl = relativePath => `/v1/files?${capability}&path=${encodeURIComponent(relativePath)}`;
  const editUrl = relativePath => `/v1/files/edit?${capability}&path=${encodeURIComponent(relativePath)}`;
  const projectUrl = `/v1/project?${capability}`;
  const searchUrl = `/v1/search?${capability}`;
  const pdfUrl = `/v1/build/pdf?${capability}`;
  const gitUrl = endpoint => `/v1/git${endpoint}?${capability}`;
  const cloneUrl = `${origin}/git/${encodeURIComponent(runtime.id)}/${encodeURIComponent(shareToken)}`;
  const main = runtime.build.main || "main.tex";
  const fileList = files.map(file => `- ${JSON.stringify(file.path)}${file.text ? " (text)" : " (binary)"}`).join("\n");
  return `# ${runtime.metadata.name}

This is the plain-text Agent workspace for project ${runtime.id}. The secret in
this URL grants edit access to this project. Keep it private.

## Files

${fileList || "(empty project)"}

## Inspect

GET ${projectUrl}
GET ${fileUrl(main)}

The file response includes X-Content-SHA256. Use that digest when submitting a
checked edit so a concurrent human or Agent change cannot be overwritten.

## Search The Project

curl -fsS -X POST '${origin}${searchUrl}' \\
  -H 'Content-Type: application/json' \\
  --data '{"pattern":"citation","args":["--line-number","--glob","*.tex"],"paths":["."]}'

The response is normal ripgrep output. Most search and output options are
accepted in args; pattern and project-relative paths stay separate so the
search cannot leave this project. Each search runs in a read-only bubblewrap
sandbox with no network and a 15 second timeout. X-Ripgrep-Exit-Code is 0 for
matches and 1 for no matches.

## Download The Current PDF

curl -fsSL '${origin}${pdfUrl}' -o latest.pdf

This always downloads a PDF built from the current project inputs. The server
handles compilation and caching; do not call the compile API first.

## Upload An Updated File

Download the file and its revision, edit the downloaded file locally, then
upload the complete updated file as raw UTF-8 bytes. No JSON escaping, base64,
or character offsets are needed. Keep all unchanged content, including review
macros and replies, intact.

curl -fsS -D /tmp/latexcoder-headers '${origin}${fileUrl(main)}' \\
  -o /tmp/latexcoder-current.tex
SHA=$(awk 'tolower($1) == "x-content-sha256:" { gsub("\\r", "", $2); print $2 }' \\
  /tmp/latexcoder-headers)

cp /tmp/latexcoder-current.tex /tmp/latexcoder-updated.tex
# Edit /tmp/latexcoder-updated.tex with your local file-editing tool.

curl -fsS -X POST '${origin}${editUrl(main)}' \\
  -H 'Content-Type: text/plain; charset=utf-8' \\
  -H "X-Base-SHA256: $SHA" \\
  --data-binary @/tmp/latexcoder-updated.tex

The server computes Yjs operations automatically and broadcasts them to
connected editors. It checks the hash of the live collaborative content, not
an older disk copy. Missing or invalid hashes are rejected; stale hashes return
HTTP 409 with error.details.currentSha256. Download the latest file, reapply
your intended changes to that version, and retry. Never just substitute a new
hash onto an old edited file: that would overwrite others' changes.

For a read-only conflict report, POST the same proposed file and original
X-Base-SHA256 to ${origin}${editUrl(main).replace("/edit?", "/edit/conflict?")}.
The JSON response includes currentSource, currentSha256, and a unified diff
comparing the current source with your proposed upload. This is NOT a three-way
merge: the diff may include other collaborators' edits. Read the latest source,
reapply only your intended changes, and upload using its currentSha256.
The diagnostic endpoint never writes or automatically retries an edit.

Uploads are direct edits by default. To create reviewable suggestions, append
&mode=suggesting&agentId=ag_uniqueid&agentName=Agent%20Name to the upload URL.
The response returns the resulting file hash and generated suggestion IDs.
Suggestion uploads may not overlap existing open reviews.

## Reply To An Inline Comment

Comments are stored as:

\\cmtbg{thread-id}{Author}selected text\\cmted{initial comment}

To reply, edit the downloaded file to append this immediately before the final
closing brace of that comment's \\cmted argument:

\\cmtrpl{unique-reply-id}{Agent Name}{Reply text}

Keep the existing comment and replies intact unless the user explicitly asks
to resolve or rewrite them. Upload the updated file with its original base hash.

## Create A File

PUT ${fileUrl(main)}
Content-Type: text/plain; charset=utf-8

Use PUT only for new files or binary uploads. For existing text files, use the
checked full-file upload above; do not use an unchecked PUT to bypass a conflict.

## Git (Only When The User Explicitly Requests It)

Do not use Git by default. For normal editing, use the checked full-file upload
above. Only inspect Git status, create a commit, resolve a conflict, clone, or
push the repository when the user explicitly requests that Git operation.

GET ${gitUrl("")}

POST ${gitUrl("/commit")}
Content-Type: application/json

{"message":"Commit message requested by the user"}

Clone and push remote:

git clone ${cloneUrl}
cd ${runtime.id}
git push origin main

The personal URL accepts pushes from registered project members. A push
checkpoints current Yjs changes, then automatically merges the pushed commit
into Yjs-backed main. If it cannot merge safely, the incoming commit is kept on
a conflict branch and the live document stays unchanged. The remote may not
contain uncommitted Yjs changes until the checkpoint created by a push or web
commit. Use the checked full-file upload unless the user specifically asks for a
Git workflow.
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
      displayName: "admin",
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
    if (authDisabled) return { username: "test-user", displayName: "Test User" };
    const session = userSession(request);
    if (!session) return null;
    const user = database.getUser(session.record.username);
    return user ? { username: user.username, displayName: user.displayName } : null;
  }

  function requireUser(request) {
    const user = currentUser(request);
    if (!user) throw apiError("authentication_required", "sign in to continue", 401);
    return user;
  }

  function isProjectOwner(request, runtime) {
    return currentUser(request)?.username === runtime.metadata.ownerUsername;
  }

  function projectMembership(request, runtime) {
    const user = currentUser(request);
    return user ? database.getProjectMember(runtime.id, user.username) : null;
  }

  function hasProjectAccess(request, runtime) {
    if (projectMembership(request, runtime)) return true;
    const session = projectSession(request);
    if (session?.record.projects.has(runtime.id)) return true;
    return Boolean(findProjectShare(runtime, request.query?.access));
  }

  function projectAccessShareId(request, runtime) {
    if (projectMembership(request, runtime)) return null;
    const session = projectSession(request);
    if (session?.record.projects.has(runtime.id)) return session.record.shares.get(runtime.id) || null;
    return findProjectShare(runtime, request.query?.access)?.id || null;
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

  function requireProjectMember(request, runtime) {
    const membership = projectMembership(request, runtime);
    if (!membership) throw apiError("project_member_required", "sign in as a project member to continue", 403);
    return membership;
  }

  function issueUserSession(request, response, username) {
    const token = randomToken();
    database.createUserSession(sha256(token), username, Date.now() + USER_SESSION_SECONDS * 1000);
    response.append("Set-Cookie", sessionCookie(request, "lc_user", token, USER_SESSION_SECONDS));
  }

  function issueProjectSession(request, response, projectId, shareId) {
    const existing = projectSession(request);
    const token = existing?.token || randomToken();
    database.addProjectSession(sha256(token), projectId, shareId, Date.now() + PROJECT_SESSION_SECONDS * 1000);
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

  function findProjectShare(runtime, supplied) {
    if (typeof supplied !== "string" || !supplied) return null;
    return database.getProjectShareByToken(runtime.id, sha256(supplied));
  }

  function sharePaths(runtime, shareId, shareToken) {
    return {
      id: shareId,
      path: `/share/${encodeURIComponent(runtime.id)}/${shareToken}`,
      agentPath: `/agent/${encodeURIComponent(runtime.id)}/${shareToken}`,
      clonePath: `/git/${encodeURIComponent(runtime.id)}/${shareToken}`,
    };
  }

  function memberProjectShare(runtime, username) {
    const existing = database.getProjectShareForUser(runtime.id, username);
    if (existing) return sharePaths(runtime, existing.id, existing.token);
    const id = randomProjectId();
    const token = randomToken();
    database.createProjectShare(runtime.id, id, username, token, sha256(token), Date.now());
    return sharePaths(runtime, id, token);
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
    if (!(await listFiles(projectDir)).length) await writeFile(mainPath, DEFAULT_DOCUMENT, "utf8");
    await ensureGitRepository(projectDir);
    const build = database.getBuild(id);
    build.pdf = build.pdf && existsSync(path.join(buildDir, "latest.pdf"));
    const runtime = {
      id, metadata, projectRoot, projectDir, buildDir,
      database,
      collaboration: createCollaborationStore(id, projectDir, database),
      build,
      compilePromise: null,
      gitBusy: false,
      gitReaders: 0,
      gitReaderWaiters: [],
      deleting: false,
    };
    projects.set(id, runtime);
    return runtime;
  }

  async function projectSummaries(username = null) {
    const summaries = [];
    const records = username ? database.listProjectsForUser(username) : database.listProjects();
    for (const metadata of records) {
      const runtime = await loadProject(metadata.id);
      summaries.push({
        ...publicProjectMetadata(runtime.metadata),
        build: { status: runtime.build.status, pdf: runtime.build.pdf },
        membership: metadata.membershipRole || "owner",
        permissions: { manage: (metadata.membershipRole || "owner") === "owner" },
      });
    }
    return summaries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async function createProject(name, ownerUsername, importedFiles = []) {
    name = cleanProjectName(name);
    let id = randomProjectId();
    while (database.getProject(id) || existsSync(path.join(projectsDir, id))) id = randomProjectId();
    const projectRoot = path.join(projectsDir, id);
    const metadata = { id, name, ownerUsername, createdAt: new Date().toISOString(), shareToken: randomToken() };
    await mkdir(projectRoot, { recursive: true });
    try {
      for (const file of importedFiles) {
        const target = path.join(projectRoot, "project", file.relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      database.createProject(metadata);
      const runtime = await loadProject(id);
      if (importedFiles.length) {
        const main = importedFiles.find(file => file.relativePath === "main.tex")
          || importedFiles.find(file => file.relativePath.endsWith(".tex"));
        if (main) { runtime.build.main = main.relativePath; database.saveBuild(id, runtime.build); }
      }
      return runtime;
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
      const accessible = await projectSummaries(user.username);
      if (accessible.length) return accessible[0].id;
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
    if (!findProjectShare(runtime, request.params.shareToken)) throw apiError("project_access_required", "Git clone URL is invalid", 401);
    return runtime;
  };
  const resolveGitPushProject = async request => {
    const runtime = await loadProject(request.params.projectId);
    const share = findProjectShare(runtime, request.params.shareToken);
    if (!share?.username || !database.getProjectMember(runtime.id, share.username)) {
      throw apiError("project_access_required", "a registered member's personal Git URL is required for push", 401);
    }
    return runtime;
  };

  const performCompile = async (runtime, main) => {
    let workDir;
    const previousPdf = runtime.build.pdf;
    const previousRevision = runtime.build.sourceRevision;
    try {
      assertProjectWritable(runtime);
      const { projectDir, buildDir, collaboration } = runtime;
      collaboration.flush();
      main = safeRelativePath(main || runtime.build.main || "main.tex");
      if (!main.endsWith(".tex")) throw apiError("invalid_main", "main document must be a .tex file");
      runtime.build = {
        status: "running",
        main,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        log: "",
        pdf: previousPdf,
        sourceRevision: previousRevision,
      };
      database.saveBuild(runtime.id, runtime.build);
      workDir = path.join(buildDir, `job-${randomUUID()}`);
      const gitDir = path.join(projectDir, ".git");
      await cp(projectDir, workDir, { recursive: true, filter: source => source !== gitDir && !source.startsWith(`${gitDir}${path.sep}`) });
      const settings = database.getSettings(runtime.id);
      const sourceRevision = await compilationSourceRevision(workDir, main, settings.compiler);
      const sourceMaps: Record<string, { lines: number[]; source: string }> = {};
      for (const file of await listFiles(workDir)) {
        if (!file.path.endsWith(".tex")) continue;
        const sourcePath = path.join(workDir, file.path);
        const source = await readFile(sourcePath, "utf8");
        const projection = compileSourceMap(source);
        sourceMaps[file.path] = { lines: projection.lines, source };
        await writeFile(sourcePath, projection.text, "utf8");
      }
      const outputDir = path.join(workDir, ".paper-output");
      await mkdir(outputDir, { recursive: true });
      const compiler = await findCompiler(settings.compiler === "auto" ? options.compiler || process.env.LATEXCODER_LATEX_BIN : settings.compiler, settings.compiler === "latexmk" ? "" : stateDir);
      if (settings.compiler !== "auto" && !path.basename(compiler).startsWith(settings.compiler)) throw apiError("compiler_unavailable", `The selected compiler ${settings.compiler} is not installed`, 503);
      const executable = path.basename(compiler);
      const args = executable.startsWith("latexmk")
        ? ["-pdf", "-synctex=1", "-file-line-error", "-interaction=nonstopmode", "-halt-on-error", `-outdir=${outputDir}`, main]
        : ["--synctex", "--keep-logs", "--outdir", outputDir, main];
      const result = await run(compiler, args, {
        cwd: workDir,
        env: { ...process.env, XDG_CACHE_HOME: path.join(stateDir, "cache") },
      });
      const pdfName = `${path.basename(main, ".tex")}.pdf`;
      const outputPdf = path.join(outputDir, pdfName);
      const success = result.code === 0 && existsSync(outputPdf);
      if (success) {
        await cp(outputPdf, path.join(buildDir, "latest.pdf"));
        const syncFile = path.join(outputDir, pdfName.replace(/\.pdf$/, ".synctex.gz"));
        await rm(path.join(buildDir, "latest.synctex.gz"), { force: true });
        if (existsSync(syncFile)) await cp(syncFile, path.join(buildDir, "latest.synctex.gz"));
        await writeFile(path.join(buildDir, "source-map.json"), JSON.stringify({ root: await realpath(workDir), files: sourceMaps, revision: sourceRevision }));
      }
      runtime.build = {
        status: success ? "success" : "error",
        main,
        startedAt: runtime.build.startedAt,
        finishedAt: new Date().toISOString(),
        log: result.output || (success ? "Compilation completed." : `Compiler exited with code ${result.code}.`),
        errors: compileErrors(result.output || "").map(error => {
          const file = Object.keys(sourceMaps).find(file => error.path === file || error.path.endsWith(`/${file}`));
          return file ? { ...error, path: file, line: sourceMaps[file].lines[error.line - 1] || error.line } : error;
        }),
        pdf: success || previousPdf,
        sourceRevision: success ? sourceRevision : previousRevision,
      };
      database.saveBuild(runtime.id, runtime.build);
      return { success, build: runtime.build };
    } catch (error) {
      runtime.build = {
        ...runtime.build,
        status: "error",
        finishedAt: new Date().toISOString(),
        log: error.message,
        errors: [],
        pdf: previousPdf,
        sourceRevision: previousRevision,
      };
      database.saveBuild(runtime.id, runtime.build);
      throw error;
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  };

  const compileProject = async (runtime, main) => {
    if (runtime.compilePromise) return runtime.compilePromise;
    const promise = performCompile(runtime, main);
    runtime.compilePromise = promise;
    try {
      return await promise;
    } finally {
      if (runtime.compilePromise === promise) runtime.compilePromise = null;
    }
  };

  const ensureLatestPdf = async runtime => {
    const main = safeRelativePath(runtime.build.main || "main.tex");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      runtime.collaboration.flush();
      const currentRevision = await compilationSourceRevision(runtime.projectDir, main, database.getSettings(runtime.id).compiler);
      if (
        runtime.build.pdf
        && runtime.build.status === "success"
        && runtime.build.main === main
        && runtime.build.sourceRevision === currentRevision
        && existsSync(path.join(runtime.buildDir, "latest.pdf"))
      ) return runtime.build;
      const result = await compileProject(runtime, main);
      if (!result.success) throw apiError("compile_failed", result.build.log || "LaTeX compilation failed", 422);
    }
    throw apiError("compile_changed", "the project kept changing while the PDF was compiling; retry the download", 409);
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
      || request.path.startsWith("/agent/")
      || request.query?.access
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
      const share = findProjectShare(runtime, request.params.token);
      if (!share) throw apiError("share_link_invalid", "project share link is invalid", 403);
      const user = currentUser(request);
      if (user) database.addProjectMember(runtime.id, user.username);
      else issueProjectSession(request, response, runtime.id, share.id);
      response.redirect(303, `/projects/${encodeURIComponent(runtime.id)}`);
    } catch (error) { next(error); }
  });
  app.get("/agent/:projectId/:token", async (request, response, next) => {
    try {
      const runtime = await loadProject(request.params.projectId);
      if (!findProjectShare(runtime, request.params.token)) throw apiError("agent_link_invalid", "Agent link is invalid", 403);
      response.setHeader("Cache-Control", "no-store");
      response.type("text/plain; charset=utf-8").send(agentProjectManual(
        runtime,
        await listFiles(runtime.projectDir),
        request.params.token,
        `${request.protocol}://${request.get("host")}`,
      ));
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
      response.json({ user: { username, displayName: user.displayName } });
    } catch (error) { next(error); }
  });
  app.post("/v1/auth/logout", (request, response) => {
    const session = userSession(request);
    if (session) database.deleteUserSession(session.key);
    response.append("Set-Cookie", sessionCookie(request, "lc_user", "", 0));
    response.json({ user: null });
  });
  app.patch("/v1/users/me", express.json({ limit: "16kb" }), (request, response, next) => {
    try {
      const user = requireUser(request);
      const displayName = cleanDisplayName(request.body?.displayName);
      if (!database.updateUserDisplayName(user.username, displayName)) throw apiError("user_not_found", "user does not exist", 404);
      response.json({ user: { username: user.username, displayName } });
    } catch (error) { next(error); }
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
        database.createUser({ username, displayName: username, ...passwordRecord(password), createdAt, invitedBy: current.createdBy });
        if (!database.consumeInvitation(tokenHash, username, createdAt)) {
          throw apiError("invitation_invalid", "invitation is invalid or expired", 404);
        }
      });
      issueUserSession(request, response, username);
      response.status(201).json({ user: { username, displayName: username } });
    } catch (error) { next(error); }
  });
  app.get("/v1/projects", async (request, response, next) => {
    try {
      const user = requireUser(request);
      const accessible = await projectSummaries(user.username);
      response.json({ projects: accessible, defaultProjectId: accessible[0]?.id || null });
    }
    catch (error) { next(error); }
  });
  app.post("/v1/projects", express.json({ limit: "16kb" }), express.raw({ type: "application/zip", limit: "20mb" }), async (request, response, next) => {
    try {
      const user = requireUser(request);
      const importedFiles = request.is("application/zip") ? readProjectZip(request.body) : [];
      const runtime = await createProject(request.is("application/zip") ? request.query.name : request.body?.name, user.username, importedFiles);
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
        folders: await listFolders(runtime.projectDir),
        settings: database.getSettings(runtime.id),
        build: runtime.build,
        permissions: { manage: isProjectOwner(request, runtime), collaborate: Boolean(projectMembership(request, runtime)) },
      } });
    } catch (error) { next(error); }
  });
  app.get("/v1/settings", async (request, response, next) => {
    try { response.json({ settings: database.getSettings((await resolveProject(request)).id) }); }
    catch (error) { next(error); }
  });
  app.patch("/v1/settings", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      if (runtime.compilePromise) throw apiError("compile_running", "Wait for compilation before changing settings", 409);
      const main = contentPath(request.body?.main);
      const { compiler, autoCompile } = request.body || {};
      if (!main.endsWith(".tex") || !existsSync(path.join(runtime.projectDir, main))) throw apiError("invalid_main", "Select an existing .tex file");
      if (!["auto", "tectonic", "latexmk"].includes(compiler) || typeof autoCompile !== "boolean") throw apiError("invalid_settings", "Invalid compiler or automatic compilation setting");
      database.saveSettings(runtime.id, { compiler, autoCompile });
      runtime.build.main = main;
      database.saveBuild(runtime.id, runtime.build);
      response.json({ settings: database.getSettings(runtime.id) });
    } catch (error) { next(error); }
  });
  app.get("/v1/reviews", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const files = await listFiles(runtime.projectDir);
      response.setHeader("Cache-Control", "no-store");
      response.json({ files: files.filter(file => file.text).map(file => ({
        path: file.path,
        reviews: parseReviews(runtime.collaboration.readText(file.path)),
      })) });
    } catch (error) { next(error); }
  });
  app.post("/v1/project/share", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const user = requireUser(request);
      requireProjectMember(request, runtime);
      response.json({ share: memberProjectShare(runtime, user.username) });
    } catch (error) { next(error); }
  });
  app.post("/v1/project/share/rotate", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const user = requireUser(request);
      requireProjectMember(request, runtime);
      const current = database.getProjectShareForUser(runtime.id, user.username);
      if (!current) throw apiError("share_not_found", "create your project access secret first", 404);
      const shareToken = randomToken();
      if (!database.rotateProjectShare(runtime.id, user.username, shareToken, sha256(shareToken))) {
        throw apiError("share_not_found", "project access grant does not exist", 404);
      }
      runtime.collaboration.disconnectShare(current.id, "project access secret changed");
      response.json({ share: sharePaths(runtime, current.id, shareToken) });
    } catch (error) { next(error); }
  });
  app.get("/v1/project/members", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      requireProjectMember(request, runtime);
      response.json({ members: database.listProjectMembers(runtime.id) });
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
      const service = request.query.service;
      if (service !== "git-upload-pack" && service !== "git-receive-pack") {
        throw apiError("git_service_invalid", "unsupported Git service", 400);
      }
      const runtime = service === "git-receive-pack"
        ? await resolveGitPushProject(request)
        : await resolveGitProject(request);
      const advertised = await withGitReader(runtime, async () => {
        if (service === "git-upload-pack") {
          return gitUploadPack(runtime, ["--advertise-refs"], Buffer.alloc(0), request.get("git-protocol"));
        }
        assertProjectWritable(runtime);
        return (await gitReceivePack(runtime, ["--advertise-refs"], Buffer.alloc(0), request.get("git-protocol"))).output;
      });
      response.setHeader("Cache-Control", "no-store");
      response.type(`application/x-${service}-advertisement`);
      const header = `# service=${service}\n`;
      const packet = `${(Buffer.byteLength(header) + 4).toString(16).padStart(4, "0")}${header}0000`;
      response.send(Buffer.concat([Buffer.from(packet), advertised]));
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
  app.post("/git/:projectId/:shareToken/git-receive-pack", express.raw({ type: () => true, limit: "32mb" }), async (request, response, next) => {
    try {
      const runtime = await resolveGitPushProject(request);
      const result = await withGitReader(runtime, () => withGitOperation(runtime, () => gitReceivePack(
        runtime,
        [],
        Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        request.get("git-protocol"),
      )));
      if (result.sync?.status) response.setHeader("X-LaTeX-Coder-Sync", result.sync.status);
      response.setHeader("Cache-Control", "no-store");
      response.type("application/x-git-receive-pack-result").send(result.output);
    } catch (error) { next(error); }
  });
  const searchProject = async (runtime, input) => {
      const { query, caseSensitive = false, regex = false } = input || {};
      if (typeof query !== "string" || !query.length || query.length > 512 || query.includes("\0")) throw apiError("invalid_query", "Search must contain 1 to 512 characters");
      // Literal UI search works on macOS too; regex stays in the sandboxed rg API.
      runtime.collaboration.flush();
      const files = (await listFiles(runtime.projectDir)).filter(file => file.text && (!input.path || file.path === contentPath(input.path)));
      const sources = new Map<string, string>();
      for (const file of files) sources.set(file.path, runtime.collaboration.readText(file.path));
      runtime.collaboration.flush();
      const matches: Array<{ path: string; line: number; from: number; to: number; text: string }> = [];
      if (regex) {
        const result = await runRipgrep(runtime.projectDir, ["--no-config", "--json", "--threads=4", "--one-file-system", ...(caseSensitive ? [] : ["--ignore-case"]), "--glob=!.git/**", "--regexp", query, "--", input.path ? contentPath(input.path) : "."], { bwrap: options.bwrap, rg: options.rg, timeoutMs: options.searchTimeoutMs });
        if (result.code !== 0 && result.code !== 1) throw apiError("invalid_query", result.stderr.toString(), 422);
        for (const row of result.stdout.toString().split("\n")) {
          if (!row) continue;
          const event = JSON.parse(row);
          if (event.type !== "match" || !event.data.path.text || !event.data.lines.text) continue;
          const data = event.data;
          const file = data.path.text.replace(/^\.\//, "");
          if (!sources.has(file)) continue;
          for (const match of data.submatches) {
            const from = Buffer.from(data.lines.text).subarray(0, match.start).toString().length;
            const to = Buffer.from(data.lines.text).subarray(0, match.end).toString().length;
            matches.push({ path: file, line: data.line_number, from, to, text: data.lines.text.replace(/\r?\n$/, "") });
            if (matches.length >= 500) break;
          }
          if (matches.length >= 500) break;
        }
      } else {
        const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
        outer: for (const file of files) {
          const source = sources.get(file.path)!;
          const lines = source.split("\n");
          for (let index = 0; index < lines.length; index++) {
            const text = lines[index];
            for (const match of text.matchAll(literal)) {
              const from = match.index;
              matches.push({ path: file.path, line: index + 1, from, to: from + query.length, text });
              if (matches.length >= 500) break outer;
            }
          }
        }
      }
      for (const [file, source] of sources) if (runtime.collaboration.readText(file) !== source) throw apiError("stale_search", "Files changed during search. Retry with the latest content.", 409);
      return { matches, truncated: matches.length >= 500, sources };
  };
  app.post("/v1/search/project", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const { sources, ...result } = await searchProject(runtime, request.body);
      response.setHeader("Cache-Control", "no-store");
      response.json(result);
    } catch (error) { next(error); }
  });
  app.post("/v1/search/replace/preview", express.json({ limit: "32kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const { replacement } = request.body || {};
      if (typeof replacement !== "string" || replacement.length > 4096) throw apiError("invalid_replacement", "Replacement must be text of at most 4096 characters");
      const result = await searchProject(runtime, request.body);
      if (result.truncated) throw apiError("too_many_matches", "More than 499 matches. Narrow the search before replacing.", 413);
      const files = [];
      for (const [file, before] of result.sources) {
        const matches = result.matches.filter(match => match.path === file);
        if (!matches.length) continue;
        const lineOffsets = [0];
        for (let index = 0; index < before.length; index++) if (before[index] === "\n") lineOffsets.push(index + 1);
        let after = before;
        for (const match of matches.reverse()) {
          const start = lineOffsets[match.line - 1] + match.from;
          const end = lineOffsets[match.line - 1] + match.to;
          after = after.slice(0, start) + replacement + after.slice(end);
        }
        if (Buffer.byteLength(after) > MAX_TEXT_BYTES) throw apiError("file_too_large", "Replacement would create an oversized file", 413);
        files.push({ path: file, baseSha256: sha256(before), before, source: after, count: matches.length });
      }
      if (files.reduce((size, file) => size + Buffer.byteLength(file.source) + Buffer.byteLength(file.before), 0) > 12 * 1024 * 1024) throw apiError("preview_too_large", "Replacement preview is too large. Narrow the scope.", 413);
      response.json({ files, count: result.matches.length });
    } catch (error) { next(error); }
  });
  app.post("/v1/search/replace", express.json({ limit: "24mb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const files = request.body?.files;
      if (!Array.isArray(files) || !files.length || files.length > 100) throw apiError("invalid_files", "Expected 1 to 100 replacement files");
      const paths = new Set<string>();
      // No awaits between validation and mutation: any stale file rejects the batch.
      for (const file of files) {
        file.path = contentPath(file.path);
        if (paths.has(file.path) || typeof file.source !== "string" || !isWellFormedUtf16(file.source) || Buffer.byteLength(file.source) > MAX_TEXT_BYTES) throw apiError("invalid_files", "Invalid or duplicate replacement file");
        paths.add(file.path);
        const current = runtime.collaboration.readText(file.path);
        if (sha256(current) !== file.baseSha256) throw apiError("stale_file", "A replacement file changed. Preview again before applying.", 409, { path: file.path, currentSha256: sha256(current) });
      }
      const results = files.map(file => ({ path: file.path, ...runtime.collaboration.editFile(file.path, file.baseSha256, file.source) }));
      runtime.collaboration.flush();
      response.json({ files: results.map(file => ({ path: file.path, sha256: file.sha256 })) });
    } catch (error) { next(error); }
  });
  app.post("/v1/search", express.json({ limit: "32kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const pattern = request.body?.pattern;
      if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 4096 || pattern.includes("\0")) {
        throw apiError("invalid_search_pattern", "pattern must contain 1 to 4096 characters");
      }
      const searchOptions = validatedSearchOptions(request.body?.args);
      const searchPaths = await validatedSearchPaths(runtime.projectDir, request.body?.paths);
      runtime.collaboration.flush();
      const result = await runRipgrep(runtime.projectDir, [
        "--no-config",
        ...searchOptions,
        "--color=never",
        "--threads=4",
        "--one-file-system",
        "--glob=!.git/**",
        "--glob=!**/.git/**",
        "--regexp", pattern,
        "--",
        ...searchPaths,
      ], {
        bwrap: options.bwrap,
        rg: options.rg,
        timeoutMs: options.searchTimeoutMs,
      });
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Ripgrep-Exit-Code", String(result.code));
      response.type("text/plain; charset=utf-8");
      if (result.code === 0 || (result.code === 1 && result.stderr.length === 0)) return response.send(result.stdout);
      response.status(422).send(result.stderr.length ? result.stderr : Buffer.from(`ripgrep exited with code ${result.code}\n`));
    } catch (error) { next(error); }
  });
  app.post("/v1/files/import", express.raw({ type: "application/zip", limit: "20mb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      if (!Buffer.isBuffer(request.body)) throw apiError("invalid_zip", "send application/zip bytes");
      const files = readProjectZip(request.body);
      for (const file of files) {
        let target = runtime.projectDir;
        for (const part of file.relativePath.split("/")) {
          target = path.join(target, part);
          if (existsSync(target)) {
            const details = await lstat(target);
            if (details.isSymbolicLink()) throw apiError("invalid_zip_path", "import cannot traverse symbolic links");
            if (target !== path.join(runtime.projectDir, file.relativePath) && !details.isDirectory()) throw apiError("file_exists", "import path conflicts with an existing file", 409);
          }
        }
        if (existsSync(target)) throw apiError("file_exists", `${file.relativePath} already exists; ZIP was not imported`, 409);
      }
      for (const file of files) {
        const target = path.join(runtime.projectDir, file.relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      response.status(201).json({ files: files.map(file => ({ path: file.relativePath })) });
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
  app.post("/v1/files/edit", express.raw({ type: () => true, limit: MAX_TEXT_BYTES }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const relativePath = safeRelativePath(request.query.path);
      if (!isTextFile(relativePath)) throw apiError("not_text", "only text files can be edited", 415);
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      let source: string;
      try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); }
      catch { throw apiError("invalid_utf8", "upload must be a valid UTF-8 file"); }
      const result = runtime.collaboration.editFile(relativePath, request.get("X-Base-SHA256"), source, {
        mode: request.query.mode,
        agent: { id: request.query.agentId, name: request.query.agentName },
      });
      runtime.collaboration.flush();
      response.setHeader("ETag", `"${result.sha256}"`);
      response.setHeader("X-Content-SHA256", result.sha256);
      response.json({ file: { path: relativePath, size: Buffer.byteLength(result.source), text: true, sha256: result.sha256 }, edit: { mode: result.mode, changeCount: result.changeCount, suggestionIds: result.suggestionIds } });
    } catch (error) {
      if (error.code === "stale_file") error.details = { ...error.details,
        latestFileUrl: request.originalUrl.replace("/v1/files/edit", "/v1/files"),
        conflictUrl: request.originalUrl.replace("/v1/files/edit", "/v1/files/edit/conflict"),
        action: "Download the latest file and reapply your intended edits. Do not put a new hash on the old upload.",
      };
      next(error);
    }
  });
  app.post("/v1/files/edit/conflict", express.raw({ type: () => true, limit: MAX_TEXT_BYTES }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const file = contentPath(request.query.path);
      const currentSource = runtime.collaboration.readText(file);
      const baseSha256 = request.get("X-Base-SHA256");
      if (!baseSha256 || !/^[a-f0-9]{64}$/.test(baseSha256)) throw apiError("invalid_base_sha256", "Supply the original X-Base-SHA256");
      let proposedSource;
      try { proposedSource = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(request.body || Buffer.alloc(0)); }
      catch { throw apiError("invalid_utf8", "Upload must be valid UTF-8"); }
      response.setHeader("Cache-Control", "no-store");
      response.json({ path: file, baseSha256, currentSha256: sha256(currentSource), currentSource,
        diff: createPatch(file, currentSource, proposedSource, "current live file", "your rejected upload", { context: 3 }),
        action: "This diff includes others' changes too. Reapply only your intended changes to currentSource and upload with currentSha256.",
      });
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
  app.post("/v1/files/folder", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const folder = contentPath(request.body?.path);
      const target = checkedContentTarget(runtime.projectDir, folder);
      if (existsSync(target)) throw apiError("path_exists", "That path already exists", 409);
      mkdirSync(target, { recursive: true });
      response.status(201).json({ folder });
    } catch (error) { next(error); }
  });
  app.get("/v1/trash", async (request, response, next) => {
    try { response.json({ items: database.listTrash((await resolveProject(request)).id) }); }
    catch (error) { next(error); }
  });
  app.post("/v1/trash/restore", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const id = String(request.body?.id || "");
      const entry = database.getTrash(runtime.id, id);
      if (!entry) throw apiError("trash_not_found", "Deleted item not found", 404);
      const target = checkedContentTarget(runtime.projectDir, entry.path);
      if (existsSync(target)) throw apiError("path_exists", "The original path is occupied. Move it before restoring.", 409);
      if (entry.directory) mkdirSync(target, { recursive: true });
      for (const file of entry.files) {
        const destination = checkedContentTarget(runtime.projectDir, file.path);
        if (file.directory) { mkdirSync(destination, { recursive: true }); continue; }
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, file.content);
        if (file.snapshot) database.saveYjsSnapshot(runtime.id, file.path, file.snapshot);
      }
      database.removeTrash(runtime.id, id);
      response.json({ restored: { path: entry.path } });
    } catch (error) { next(error); }
  });
  app.delete("/v1/files", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      assertProjectWritable(runtime);
      const { projectDir, collaboration } = runtime;
      const relativePath = contentPath(request.query.path);
      if (relativePath === runtime.build.main || runtime.build.main.startsWith(`${relativePath}/`)) throw apiError("main_file_required", "the main document cannot be deleted", 409);
      collaboration.flush();
      const target = path.join(projectDir, relativePath);
      const entries = contentEntries(projectDir, relativePath);
      const directory = entries[0].directory;
      const files = entries.map(file => ({ ...file, content: file.directory ? Buffer.alloc(0) : readFileSync(path.join(projectDir, file.path)), snapshot: file.directory ? null : database.getYjsSnapshot(runtime.id, file.path) }));
      const id = randomUUID();
      database.createTrash(runtime.id, id, relativePath, directory, files);
      try {
        rmSync(target, { recursive: directory, force: false });
        for (const file of entries) if (!file.directory) void collaboration.remove(file.path);
      } catch (error) { throw error; }
      response.json({ deleted: { path: relativePath, trashId: id } });
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
      const from = contentPath(request.body?.from);
      const to = contentPath(request.body?.to);
      checkedContentTarget(projectDir, to);
      if (to === from || to.startsWith(`${from}/`)) throw apiError("invalid_move", "Cannot move a folder into itself");
      if (existsSync(path.join(projectDir, to))) throw apiError("path_exists", "Destination already exists", 409);
      collaboration.flush();
      const entries = contentEntries(projectDir, from);
      mkdirSync(path.dirname(path.join(projectDir, to)), { recursive: true });
      renameSync(path.join(projectDir, from), path.join(projectDir, to));
      for (const file of entries) if (!file.directory) void collaboration.remove(file.path);
      if (runtime.build.main === from || runtime.build.main.startsWith(`${from}/`)) runtime.build.main = to + runtime.build.main.slice(from.length);
      database.saveBuild(runtime.id, runtime.build);
      response.json({ file: { path: to } });
    } catch (error) { next(error); }
  });
  app.get("/v1/build", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      runtime.collaboration.flush();
      const currentRevision = await compilationSourceRevision(runtime.projectDir, runtime.build.main, database.getSettings(runtime.id).compiler);
      response.json({ build: { ...runtime.build, stale: currentRevision !== runtime.build.sourceRevision, errors: runtime.build.errors?.length ? runtime.build.errors : compileErrors(runtime.build.log) } });
    }
    catch (error) { next(error); }
  });
  app.get("/v1/build/pdf", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const build = request.query.cached === "1" ? runtime.build : await ensureLatestPdf(runtime);
      if (!build.pdf || !existsSync(path.join(runtime.buildDir, "latest.pdf"))) throw apiError("pdf_not_found", "No successful PDF yet", 404);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("ETag", `"${build.sourceRevision}"`);
      response.setHeader("X-LaTeX-Coder-Source-Revision", build.sourceRevision);
      response.sendFile(path.join(runtime.buildDir, "latest.pdf"), { dotfiles: "allow" });
    } catch (error) { next(error); }
  });
  app.post("/v1/build/position", express.json({ limit: `${MAX_TEXT_BYTES * 2}b` }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const file = safeRelativePath(request.body?.path);
      const { line, source, from, to } = request.body || {};
      if (!file.endsWith(".tex") || !Number.isSafeInteger(line) || line < 1 || typeof source !== "string") throw apiError("invalid_position", "Expected a LaTeX file, source, and positive line number");
      if (runtime.collaboration.readText(file) !== source) throw apiError("stale_source", "The source changed. Try navigating again.", 409);
      await ensureLatestPdf(runtime);
      if (!existsSync(path.join(runtime.buildDir, "latest.synctex.gz"))) await compileProject(runtime, runtime.build.main);
      if (!existsSync(path.join(runtime.buildDir, "latest.synctex.gz"))) throw apiError("synctex_missing", "The compiler did not produce SyncTeX data", 409);
      let snapshot = JSON.parse(await readFile(path.join(runtime.buildDir, "source-map.json"), "utf8"));
      if (snapshot.files[file]?.source !== source) {
        const result = await compileProject(runtime, runtime.build.main);
        if (!result.success) throw apiError("compile_failed", "Compilation failed while locating the PDF position", 422);
        snapshot = JSON.parse(await readFile(path.join(runtime.buildDir, "source-map.json"), "utf8"));
      }
      const map = snapshot.files[file];
      if (!map) throw apiError("source_not_found", "This file is not part of the compiled document", 404);
      if (map.source !== source || runtime.collaboration.readText(file) !== source) throw apiError("stale_source", "The source changed. Try navigating again.", 409);
      let projectedLine = 1;
      for (let index = 0; index < map.lines.length; index++) {
        if (Math.abs(map.lines[index] - line) < Math.abs(map.lines[projectedLine - 1] - line)) projectedLine = index + 1;
      }
      const start = Number.isSafeInteger(from) && from >= 0 && from <= source.length ? projectedPosition(source, from) : { line: projectedLine, column: 0 };
      const end = Number.isSafeInteger(to) && to >= (from || 0) && to <= source.length ? projectedPosition(source, to) : start;
      const boxes = [];
      try {
        for (let batch = start.line; batch <= Math.min(end.line, start.line + 19); batch += 4) {
          const lines = Array.from({ length: Math.min(4, Math.min(end.line, start.line + 19) - batch + 1) }, (_, index) => batch + index);
          const results = await Promise.all(lines.map(targetLine => run(options.synctex || "synctex", ["view", "-i", `${targetLine}:${targetLine === start.line ? start.column : 0}:${path.join(snapshot.root, file)}`, "-o", path.join(runtime.buildDir, "latest.pdf")], { cwd: runtime.buildDir, timeoutMs: 1000, env: { ...process.env, SYNCTEX_VIEWER: "" } })));
          for (const result of results) boxes.push(...syncTexPositions(result.output));
        }
      } catch { throw apiError("synctex_unavailable", "SyncTeX is not installed on the server", 503); }
      if (runtime.compilePromise || snapshot.revision !== runtime.build.sourceRevision || runtime.collaboration.readText(file) !== source) throw apiError("stale_source", "The source or PDF changed. Try navigating again.", 409);
      const unique = [...new Map(boxes.map(box => [JSON.stringify(box), box])).values()].slice(0, 200);
      if (!unique.length) throw apiError("source_not_found", "No PDF position for this source", 404);
      const { page, x, y } = unique[0];
      response.setHeader("Cache-Control", "no-store");
      response.json({ page, x, y, boxes: unique, revision: snapshot.revision });
    } catch (error) { next(error); }
  });
  app.post("/v1/build/source", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const { page, x, y, revision } = request.body || {};
      if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100000 || y > 100000) throw apiError("invalid_position", "Invalid PDF position");
      if (runtime.compilePromise || revision !== runtime.build.sourceRevision) throw apiError("stale_pdf", "The PDF changed. Refresh the preview and try again.", 409);
      if (!existsSync(path.join(runtime.buildDir, "latest.synctex.gz"))) throw apiError("synctex_missing", "Compile the project to enable PDF source navigation.", 409);
      const snapshot = JSON.parse(await readFile(path.join(runtime.buildDir, "source-map.json"), "utf8"));
      let result;
      try {
        result = await run(options.synctex || "synctex", ["edit", "-o", `${page}:${x}:${y}:${path.join(runtime.buildDir, "latest.pdf")}`], { cwd: runtime.buildDir, timeoutMs: 5000, env: { ...process.env, SYNCTEX_EDITOR: "" } });
      } catch { throw apiError("synctex_unavailable", "SyncTeX is not installed on the server", 503); }
      if (runtime.compilePromise || revision !== runtime.build.sourceRevision) throw apiError("stale_pdf", "The PDF changed. Refresh the preview and try again.", 409);
      const input = /^Input:(.*)$/m.exec(result.output)?.[1]?.trim();
      const line = Number(/^Line:(\d+)$/m.exec(result.output)?.[1]);
      if (!input || !line || result.code !== 0) throw apiError("source_not_found", "No source location at this PDF position", 404);
      let file = path.relative(snapshot.root, path.resolve(snapshot.root, input));
      if (!snapshot.files[file] && snapshot.files[`${file}.tex`]) file += ".tex";
      const map = snapshot.files[file];
      if (!map) throw apiError("source_not_found", "The source is outside this project", 404);
      runtime.collaboration.flush();
      const current = await readFile(path.join(runtime.projectDir, safeRelativePath(file)), "utf8");
      if (current !== map.source) throw apiError("stale_source", "This source changed since compilation. Compile again to navigate accurately.", 409);
      response.setHeader("Cache-Control", "no-store");
      response.json({ path: file, line: map.lines[line - 1] || line });
    } catch (error) { next(error); }
  });
  app.post("/v1/compile", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      const main = safeRelativePath(request.body?.main || runtime.build.main || "main.tex");
      let result = await compileProject(runtime, main);
      if (result.build.main !== main) result = await compileProject(runtime, main);
      response.status(result.success ? 200 : 422).json({ build: result.build });
    } catch (error) { next(error); }
  });

  app.use(express.static(path.join(APP_DIR, "dist"), { index: false, maxAge: "1y", immutable: true }));
  app.use((request, _response, next) => next(apiError("route_not_found", `route ${request.method} ${request.path} does not exist`, 404)));
  app.use((error, _request, response, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 500;
    const parseError = error.type === "entity.parse.failed";
    const code = parseError ? "invalid_json" : (error.code && typeof error.code === "string" ? error.code : "internal_error");
    const message = parseError ? "request body must contain valid JSON" : (status >= 500 ? "internal server error" : error.message);
    if (status >= 500) console.error(error);
    const body: { error: { code: string; message: string; details?: Record<string, unknown> } } = { error: { code, message } };
    if (status < 500 && error.details && typeof error.details === "object") body.error.details = error.details;
    response.status(parseError ? 400 : status).json(body);
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
      const shareId = projectAccessShareId(request, runtime);
      const relativePath = pathFromRoomName(scoped ? parts[1] : parts[0]);
      sockets.handleUpgrade(request, socket, head, connection => runtime.collaboration.attach(connection, relativePath, shareId, url.searchParams.get("saved") === "1"));
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
  const port = Number(options.port || process.env.LATEXCODER_PORT || process.env.PORT || 8090);
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
