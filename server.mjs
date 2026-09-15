import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as awarenessProtocol from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";

import { parseReviews, stripReviewStorage } from "./src/review.js";

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

function apiError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
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
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
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

function createCollaborationStore(projectDir, stateDir) {
  const docs = new Map();
  const snapshotsDir = path.join(stateDir, "yjs");
  let shuttingDown = false;

  function snapshotPath(relativePath) {
    const digest = createHash("sha256").update(relativePath).digest("hex");
    return path.join(snapshotsDir, `${digest}.bin`);
  }

  function persist(shared) {
    if (shuttingDown) return;
    if (shared.persistTimer) clearTimeout(shared.persistTimer);
    shared.persistTimer = setTimeout(() => {
      shared.persistTimer = undefined;
      const text = shared.doc.getText("content").toString();
      atomicWriteSync(path.join(projectDir, shared.relativePath), text);
      atomicWriteSync(snapshotPath(shared.relativePath), Y.encodeStateAsUpdate(shared.doc));
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
    const snapshot = snapshotPath(relativePath);
    if (existsSync(snapshot)) {
      Y.applyUpdate(doc, readFileSync(snapshot));
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

  function readText(relativePath) {
    return load(relativePath).doc.getText("content").toString();
  }

  function patchText(relativePath, baseSha256, requestedChanges, options = {}) {
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
      if (shared.persistTimer) clearTimeout(shared.persistTimer);
      shared.persistTimer = undefined;
      atomicWriteSync(path.join(projectDir, shared.relativePath), shared.doc.getText("content").toString());
      atomicWriteSync(snapshotPath(shared.relativePath), Y.encodeStateAsUpdate(shared.doc));
    }
  }

  function remove(relativePath) {
    const shared = docs.get(relativePath);
    if (shared) {
      for (const connection of shared.connections.keys()) connection.close(1000, "file removed");
      shared.doc.destroy();
      docs.delete(relativePath);
    }
    return rm(snapshotPath(relativePath), { force: true });
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

  return { attach, flush, load, patchText, readText, remove, replaceText, roomNameForPath, shutdown };
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

function run(command, args, options) {
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

\`GET /v1/projects\` lists projects. \`POST /v1/projects\` with
\`{"name":"My paper"}\` creates one. Rename or delete one with
\`PATCH /v1/projects/:id\` and \`DELETE /v1/projects/:id\`.

Every project-specific request below accepts \`?project=<id>\`. If omitted,
the first project is used for backwards compatibility.

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

There is no application login. Any caller that can reach this service can read and modify every project file. LaTeX compilation is not a security sandbox; do not expose this App to untrusted users or store secrets in its project directory.
`;
}

function safeProjectId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw apiError("invalid_project", "project id is invalid");
  }
  return value;
}

function cleanProjectName(value) {
  if (typeof value !== "string") throw apiError("invalid_project_name", "project name is required");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw apiError("invalid_project_name", "project name must contain 1 to 80 characters");
  return name;
}

function projectSlug(name) {
  const slug = name.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "project";
}

async function readProjectMetadata(projectRoot, id) {
  try {
    const metadata = JSON.parse(await readFile(path.join(projectRoot, "project.json"), "utf8"));
    return { id, name: cleanProjectName(metadata.name), createdAt: metadata.createdAt || null };
  } catch {
    return { id, name: id === "paper" ? "Paper" : id, createdAt: null };
  }
}

async function writeProjectMetadata(projectRoot, metadata) {
  await writeFile(path.join(projectRoot, "project.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export async function createPaperServer(options = {}) {
  const stateDir = path.resolve(options.stateDir || process.env.LATEXCODER_STATE_DIR || process.env.PAPER_STATE_DIR || path.join(process.cwd(), ".latexcoder"));
  const projectsDir = path.join(stateDir, "projects");
  await mkdir(stateDir, { recursive: true });

  // Move the original single-project layout in place on first startup.
  const legacyProjectDir = path.join(stateDir, "project");
  if (existsSync(legacyProjectDir) && !existsSync(projectsDir)) {
    const migratedRoot = path.join(projectsDir, "paper");
    await mkdir(migratedRoot, { recursive: true });
    for (const directory of ["project", "yjs", "build"]) {
      const source = path.join(stateDir, directory);
      if (existsSync(source)) await rename(source, path.join(migratedRoot, directory));
    }
    await writeProjectMetadata(migratedRoot, { id: "paper", name: "Paper", createdAt: new Date().toISOString() });
  }
  await mkdir(projectsDir, { recursive: true });

  const projects = new Map();
  async function loadProject(id) {
    id = safeProjectId(id);
    if (projects.has(id)) return projects.get(id);
    const projectRoot = path.join(projectsDir, id);
    if (!existsSync(projectRoot)) throw apiError("project_not_found", "project does not exist", 404);
    const metadata = await readProjectMetadata(projectRoot, id);
    const projectDir = path.join(projectRoot, "project");
    const buildDir = path.join(projectRoot, "build");
    await mkdir(projectDir, { recursive: true });
    await mkdir(path.join(projectRoot, "yjs"), { recursive: true });
    await mkdir(buildDir, { recursive: true });
    const mainPath = path.join(projectDir, "main.tex");
    if (!existsSync(mainPath)) await writeFile(mainPath, DEFAULT_DOCUMENT, "utf8");
    let build = { status: "idle", main: "main.tex", startedAt: null, finishedAt: null, log: "", pdf: false };
    try {
      build = JSON.parse(await readFile(path.join(buildDir, "latest.json"), "utf8"));
      build.pdf = existsSync(path.join(buildDir, "latest.pdf"));
    } catch {}
    const runtime = {
      id, metadata, projectRoot, projectDir, buildDir,
      collaboration: createCollaborationStore(projectDir, projectRoot),
      build,
    };
    projects.set(id, runtime);
    return runtime;
  }

  async function projectSummaries() {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    const summaries = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name)) continue;
      const runtime = await loadProject(entry.name);
      summaries.push({ ...runtime.metadata, build: { status: runtime.build.status, pdf: runtime.build.pdf } });
    }
    return summaries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async function createProject(name) {
    name = cleanProjectName(name);
    const base = projectSlug(name);
    let id = base;
    let suffix = 2;
    while (existsSync(path.join(projectsDir, id))) id = `${base.slice(0, 58)}-${suffix++}`;
    const projectRoot = path.join(projectsDir, id);
    const metadata = { id, name, createdAt: new Date().toISOString() };
    await mkdir(projectRoot, { recursive: true });
    await writeProjectMetadata(projectRoot, metadata);
    return loadProject(id);
  }

  let existing = await projectSummaries();
  if (!existing.length) {
    await createProject("Paper");
    existing = await projectSummaries();
  }
  let defaultProjectId = existing[0].id;
  const resolveProject = request => loadProject(request.query.project || defaultProjectId);

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
      return response.sendFile(path.join(APP_DIR, "public", "index.html"));
    }
    return response.type("text/markdown; charset=utf-8").send(manual());
  });
  app.get("/health", (_request, response) => response.json({ ok: true, name: "latexcoder" }));
  app.get("/v1/projects", async (_request, response, next) => {
    try { response.json({ projects: await projectSummaries(), defaultProjectId }); }
    catch (error) { next(error); }
  });
  app.post("/v1/projects", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await createProject(request.body?.name);
      response.status(201).json({ project: { ...runtime.metadata, build: runtime.build } });
    } catch (error) { next(error); }
  });
  app.patch("/v1/projects/:projectId", express.json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await loadProject(request.params.projectId);
      runtime.metadata = { ...runtime.metadata, name: cleanProjectName(request.body?.name) };
      await writeProjectMetadata(runtime.projectRoot, runtime.metadata);
      response.json({ project: runtime.metadata });
    } catch (error) { next(error); }
  });
  app.delete("/v1/projects/:projectId", async (request, response, next) => {
    try {
      const runtime = await loadProject(request.params.projectId);
      runtime.collaboration.shutdown();
      projects.delete(runtime.id);
      await rm(runtime.projectRoot, { recursive: true, force: false });
      const remaining = await projectSummaries();
      if (!remaining.length) {
        const replacement = await createProject("Paper");
        defaultProjectId = replacement.id;
      } else if (defaultProjectId === runtime.id) {
        defaultProjectId = remaining[0].id;
      }
      response.json({ deleted: { id: runtime.id }, defaultProjectId });
    } catch (error) { next(error); }
  });
  app.get("/v1/project", async (request, response, next) => {
    try {
      const runtime = await resolveProject(request);
      response.json({ project: { ...runtime.metadata, main: runtime.build.main, files: await listFiles(runtime.projectDir), build: runtime.build } });
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
      const { projectDir, collaboration } = await resolveProject(request);
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
    resolveProject(request).then(({ collaboration }) => {
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
      const { projectDir, buildDir, collaboration } = runtime;
      if (runtime.build.status === "running") throw apiError("compile_busy", "a compile is already running", 409);
      collaboration.flush();
      const main = safeRelativePath(request.body?.main || runtime.build.main || "main.tex");
      if (!main.endsWith(".tex")) throw apiError("invalid_main", "main document must be a .tex file");
      runtime.build = { status: "running", main, startedAt: new Date().toISOString(), finishedAt: null, log: "", pdf: runtime.build.pdf };
      workDir = path.join(buildDir, `job-${randomUUID()}`);
      await cp(projectDir, workDir, { recursive: true });
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
      const compiler = await findCompiler(options.compiler || process.env.LATEXCODER_LATEX_BIN || process.env.PAPER_LATEX_BIN, stateDir);
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
      await writeFile(path.join(buildDir, "latest.json"), JSON.stringify(runtime.build, null, 2), "utf8");
      response.status(success ? 200 : 422).json({ build: runtime.build });
    } catch (error) {
      if (runtime) {
        runtime.build = {
          ...runtime.build,
          status: "error",
          finishedAt: new Date().toISOString(),
          log: error.message,
        };
        await writeFile(path.join(runtime.buildDir, "latest.json"), JSON.stringify(runtime.build, null, 2), "utf8");
      }
      next(error);
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  });

  app.get(/^\/(app\.js|styles\.css|pdf\.worker\.min\.mjs)$/, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(path.join(APP_DIR, "public", request.params[0]));
  });
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
      const runtime = await loadProject(scoped ? parts[0] : defaultProjectId);
      const relativePath = pathFromRoomName(scoped ? parts[1] : parts[0]);
      sockets.handleUpgrade(request, socket, head, connection => runtime.collaboration.attach(connection, relativePath));
    })().catch(() => {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
  });

  const defaultRuntime = await loadProject(defaultProjectId);
  const shutdown = () => {
    for (const runtime of projects.values()) runtime.collaboration.shutdown();
  };
  return {
    app, server, sockets, stateDir, projectsDir, projects, shutdown,
    // Kept for API consumers of the original single-project server.
    projectDir: defaultRuntime.projectDir,
    collaboration: defaultRuntime.collaboration,
  };
}

export async function startPaperServer(options = {}) {
  const paper = await createPaperServer(options);
  const host = options.host || process.env.LATEXCODER_HOST || process.env.PAPER_HOST || "0.0.0.0";
  const port = Number(options.port || process.env.LATEXCODER_PORT || process.env.PAPER_PORT || 8090);
  await new Promise((resolve, reject) => {
    paper.server.once("error", reject);
    paper.server.listen(port, host, resolve);
  });
  console.log(`LaTeX Coder listening on http://${host}:${paper.server.address().port}`);
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
