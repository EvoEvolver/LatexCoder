import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { fileChanges } from "../shared/file-diff.ts";
import { parseReviews } from "../shared/review.ts";
import type { StateDatabase } from "./database.ts";
import { agentAuthor, apiError, atomicWriteSync, isTextFile, isUnicodeBoundary, isWellFormedUtf16, MAX_PATCH_CHANGES, MAX_TEXT_BYTES, roomNameForPath, sha256 } from "./core.ts";
import type { CollaborationStore, EditMode, EditOptions, EditResult, PatchChange, SharedDocument } from "./types.ts";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_SAVED = 3;

export function createCollaborationStore(projectId: string, projectDir: string, database: StateDatabase, onChange: () => void = () => {}): CollaborationStore {
  const docs = new Map<string, SharedDocument>();
  const connectionShares = new WeakMap<WebSocket, string | null>();
  const savedConnections = new WeakSet<WebSocket>();
  let shuttingDown = false, suspended = false;

  function acknowledge(shared: SharedDocument): void {
    for (const [client, nonce] of shared.saveRequests) if (client.readyState === WebSocket.OPEN) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SAVED); encoding.writeVarString(encoder, nonce);
      client.send(encoding.toUint8Array(encoder));
    }
    shared.saveRequests.clear();
  }

  function persist(shared: SharedDocument): void {
    if (shuttingDown || suspended || shared.removed) return;
    if (shared.persistTimer) clearTimeout(shared.persistTimer);
    shared.persistTimer = setTimeout(() => {
      shared.persistTimer = undefined;
      atomicWriteSync(path.join(projectDir, shared.relativePath), shared.doc.getText("content").toString());
      database.saveYjsSnapshot(projectId, shared.relativePath, Y.encodeStateAsUpdate(shared.doc));
      acknowledge(shared);
    }, 180);
  }

  function broadcast(shared: SharedDocument, payload: Uint8Array, except: unknown = null): void {
    for (const connection of shared.connections.keys()) if (connection !== except && connection.readyState === WebSocket.OPEN) connection.send(payload);
  }

  function load(relativePath: string): SharedDocument {
    let shared = docs.get(relativePath);
    if (shared) return shared;
    if (!isTextFile(relativePath)) throw apiError("not_text", "only text files can be collaboratively edited", 415);
    const target = path.join(projectDir, relativePath);
    if (!existsSync(target)) throw apiError("file_not_found", "file does not exist", 404);
    const doc = new Y.Doc(), snapshot = database.getYjsSnapshot(projectId, relativePath);
    if (snapshot) Y.applyUpdate(doc, snapshot);
    else {
      const source = readFileSync(target, "utf8");
      if (Buffer.byteLength(source) > MAX_TEXT_BYTES) throw apiError("file_too_large", "text file is too large", 413);
      doc.getText("content").insert(0, source);
    }
    shared = { relativePath, doc, awareness: new awarenessProtocol.Awareness(doc), connections: new Map(), persistTimer: undefined, removed: false, saveRequests: new Map() };
    shared.awareness.setLocalState(null);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC); syncProtocol.writeUpdate(encoder, update);
      broadcast(shared, encoding.toUint8Array(encoder), origin); persist(shared);
      if (!suspended && !shuttingDown) onChange();
    });
    shared.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: WebSocket | null) => {
      const changed = [...added, ...updated, ...removed];
      if (origin && shared.connections.has(origin)) {
        const controlled = shared.connections.get(origin);
        for (const id of added) controlled.add(id);
        for (const id of removed) controlled.delete(id);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS); encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(shared.awareness, changed));
      broadcast(shared, encoding.toUint8Array(encoder));
    });
    docs.set(relativePath, shared);
    return shared;
  }

  function attach(connection: WebSocket, relativePath: string, shareId: string | null = null, savedAcknowledgments = false): void {
    if (suspended) return connection.close(1012, "project is synchronizing with Git");
    const shared = load(relativePath);
    shared.connections.set(connection, new Set()); connectionShares.set(connection, shareId);
    if (savedAcknowledgments) savedConnections.add(connection);
    connection.binaryType = "arraybuffer";
    connection.on("message", raw => {
      if (suspended || shuttingDown || shared.removed) return;
      try {
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        const decoder = decoding.createDecoder(bytes), type = decoding.readVarUint(decoder);
        if (type === MESSAGE_SYNC) {
          const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, shared.doc, connection);
          if (encoding.length(encoder) > 1) connection.send(encoding.toUint8Array(encoder));
          persist(shared);
        } else if (type === MESSAGE_AWARENESS) awarenessProtocol.applyAwarenessUpdate(shared.awareness, decoding.readVarUint8Array(decoder), connection);
        else if (type === MESSAGE_SAVED && savedConnections.has(connection)) {
          const nonce = decoding.readVarString(decoder);
          if (nonce.length > 64) throw apiError("invalid_nonce", "Save nonce too long");
          shared.saveRequests.set(connection, nonce); persist(shared);
        }
      } catch (error) { console.error("paper websocket message failed", error); connection.close(1003, "invalid collaboration message"); }
    });
    let alive = true;
    connection.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) return connection.terminate(); alive = false; connection.ping(); }, 30_000);
    connection.on("close", () => {
      clearInterval(heartbeat);
      const controlled = shared.connections.get(connection) || new Set();
      shared.connections.delete(connection); shared.saveRequests.delete(connection);
      awarenessProtocol.removeAwarenessStates(shared.awareness, [...controlled], null); persist(shared);
    });
    const syncEncoder = encoding.createEncoder(); encoding.writeVarUint(syncEncoder, MESSAGE_SYNC); syncProtocol.writeSyncStep1(syncEncoder, shared.doc); connection.send(encoding.toUint8Array(syncEncoder));
    const clients = [...shared.awareness.getStates().keys()];
    if (clients.length) {
      const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, MESSAGE_AWARENESS); encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(shared.awareness, clients)); connection.send(encoding.toUint8Array(encoder));
    }
  }

  function replaceText(relativePath: string, source: string): boolean {
    const shared = docs.get(relativePath);
    if (!shared) return false;
    const text = shared.doc.getText("content");
    shared.doc.transact(() => { text.delete(0, text.length); text.insert(0, source); }, "rest-api");
    return true;
  }

  function importText(relativePath: string, source: string): void {
    const target = path.join(projectDir, relativePath);
    if (!existsSync(target)) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, source); }
    const shared = load(relativePath), text = shared.doc.getText("content");
    if (text.toString() !== source) shared.doc.transact(() => { text.delete(0, text.length); text.insert(0, source); }, "git-sync");
  }

  function readText(relativePath: string): string { return load(relativePath).doc.getText("content").toString(); }

  function patchText(relativePath: string, baseSha256: string, requestedChanges: PatchChange[], options: EditOptions = {}): EditResult {
    if (typeof baseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(baseSha256)) throw apiError("invalid_base_sha256", "baseSha256 must be a lowercase SHA-256 hex digest");
    if (!Array.isArray(requestedChanges) || !requestedChanges.length || requestedChanges.length > MAX_PATCH_CHANGES) throw apiError("invalid_changes", `changes must contain 1 to ${MAX_PATCH_CHANGES} edits`);
    const shared = load(relativePath), text = shared.doc.getText("content"), source = text.toString(), currentSha256 = sha256(source);
    if (currentSha256 !== baseSha256) throw apiError("stale_file", "file changed since it was read; fetch it and retry the patch", 409, { path: relativePath, expectedSha256: baseSha256, currentSha256 });
    const changes = requestedChanges.map((change, index) => {
      const { from, to, insert } = change || {};
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > source.length) throw apiError("invalid_change", `changes[${index}] has an invalid range`);
      if (typeof insert !== "string") throw apiError("invalid_change", `changes[${index}].insert must be a string`);
      if (!isWellFormedUtf16(insert)) throw apiError("invalid_change", `changes[${index}].insert contains an unpaired UTF-16 surrogate`);
      if (from === to && !insert) throw apiError("invalid_change", `changes[${index}] does not change the document`);
      if (!isUnicodeBoundary(source, from) || !isUnicodeBoundary(source, to)) throw apiError("invalid_change", `changes[${index}] splits a Unicode character`);
      return { from, to, insert, index };
    }).sort((left, right) => left.from - right.from || left.to - right.to);
    for (let index = 1; index < changes.length; index++) if (changes[index].from < changes[index - 1].to) throw apiError("overlapping_changes", "patch ranges must not overlap");
    const mode: EditMode = options.mode ?? "suggesting", suggestionIds: string[] = [];
    if (!['suggesting', 'direct'].includes(mode)) throw apiError("invalid_mode", "mode must be suggesting or direct");
    if (mode === "suggesting") {
      const author = agentAuthor(options.agent), reviews = parseReviews(source);
      for (const change of changes) {
        if (reviews.some(item => change.from < item.to && change.to > item.from)) throw apiError("review_conflict", "suggesting patches cannot overlap an open review", 409);
        const id = `r${randomUUID().replaceAll("-", "")}`, deleted = source.slice(change.from, change.to);
        change.insert = `${deleted ? `\\delbg{${id}}{${author}}${deleted}\\deled` : ""}${change.insert ? `\\addbg{${id}}{${author}}${change.insert}\\added` : ""}`;
        suggestionIds.push(id);
      }
    }
    let projectedBytes = Buffer.byteLength(source);
    for (const change of changes) projectedBytes += Buffer.byteLength(change.insert) - Buffer.byteLength(source.slice(change.from, change.to));
    if (projectedBytes > MAX_TEXT_BYTES) throw apiError("file_too_large", "patched text file is too large", 413);
    shared.doc.transact(() => { for (const change of changes.reverse()) { if (change.to > change.from) text.delete(change.from, change.to - change.from); if (change.insert) text.insert(change.from, change.insert); } }, "rest-patch-api");
    const result = text.toString();
    return { source: result, sha256: sha256(result), mode, suggestionIds };
  }

  function editFile(relativePath: string, baseSha256: string, updated: string, options: EditOptions = {}): EditResult {
    if (typeof baseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(baseSha256)) throw apiError("invalid_base_sha256", "X-Base-SHA256 must be a lowercase SHA-256 hex digest");
    const source = readText(relativePath), currentSha256 = sha256(source);
    if (currentSha256 !== baseSha256) throw apiError("stale_file", "file changed since it was downloaded; download the latest file, reapply your edits, and retry", 409, { path: relativePath, expectedSha256: baseSha256, currentSha256 });
    const mode: EditMode = options.mode ?? "direct";
    if (!['direct', 'suggesting'].includes(mode)) throw apiError("invalid_mode", "mode must be suggesting or direct");
    if (mode === "suggesting") agentAuthor(options.agent);
    const changes = fileChanges(source, updated);
    if (!changes.length) return { source, sha256: currentSha256, mode, suggestionIds: [], changeCount: 0 };
    return { ...patchText(relativePath, baseSha256, changes, { ...options, mode }), changeCount: changes.length };
  }

  function flush(): void {
    for (const shared of docs.values()) if (!shared.removed) {
      if (shared.persistTimer) clearTimeout(shared.persistTimer);
      shared.persistTimer = undefined;
      atomicWriteSync(path.join(projectDir, shared.relativePath), shared.doc.getText("content").toString());
      database.saveYjsSnapshot(projectId, shared.relativePath, Y.encodeStateAsUpdate(shared.doc)); acknowledge(shared);
    }
  }
  function remove(relativePath: string): Promise<void> {
    const shared = docs.get(relativePath);
    if (shared) { shared.removed = true; if (shared.persistTimer) clearTimeout(shared.persistTimer); for (const connection of shared.connections.keys()) connection.close(1000, "file removed"); shared.doc.destroy(); docs.delete(relativePath); }
    database.deleteYjsSnapshot(projectId, relativePath); return Promise.resolve();
  }
  function shutdown(): void { flush(); shuttingDown = true; for (const shared of docs.values()) { if (shared.persistTimer) clearTimeout(shared.persistTimer); for (const connection of shared.connections.keys()) connection.terminate(); shared.doc.destroy(); } docs.clear(); }
  function suspend(): void { suspended = true; for (const shared of docs.values()) for (const connection of shared.connections.keys()) connection.close(1012, "project is synchronizing with Git"); flush(); }
  function resume(): void { suspended = false; }
  function disconnectShare(shareId: string, reason: string): void { for (const shared of docs.values()) for (const connection of shared.connections.keys()) if (connectionShares.get(connection) === shareId) connection.close(1008, reason); }
  return { attach, disconnectShare, editFile, flush, importText, load, patchText, readText, remove, replaceText, resume, roomNameForPath, shutdown, suspend };
}
