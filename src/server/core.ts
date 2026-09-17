import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import type { Request } from "express";
import type { AgentIdentity, ApiError, ImportedProjectFile, PasswordRecord } from "./types.ts";

export const TEXT_EXTENSIONS = new Set([".bib", ".cls", ".csv", ".json", ".md", ".sty", ".tex", ".txt", ".yaml", ".yml"]);
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PATCH_CHANGES = 1_000;

export function apiError(code: string, message: string, status = 400, details?: Record<string, unknown>): ApiError {
  return Object.assign(new Error(message), { code, status, details });
}

export function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) throw apiError("invalid_path", "path is invalid");
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("/.paper/")) throw apiError("invalid_path", "path must stay inside the project");
  return normalized;
}

export function contentPath(value: unknown): string {
  const result = safeRelativePath(value);
  if (result.split("/").some(part => part.startsWith("."))) throw apiError("invalid_path", "Hidden metadata paths are not editable");
  return result;
}

export function isTextFile(relativePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

export function readProjectZip(body: Uint8Array): ImportedProjectFile[] {
  let total = 0, count = 0, files;
  try {
    files = unzipSync(body, { filter: entry => {
      if (++count > 1000 || entry.originalSize > MAX_FILE_BYTES || (total += entry.originalSize) > 100 * 1024 * 1024) throw apiError("zip_too_large", "ZIP exceeds file count or extracted size limits", 413);
      if (entry.name.includes("\\") || entry.name.split("/").some(part => part === ".." || part === ".git" || part === ".paper-output")) throw apiError("invalid_zip_path", "ZIP contains an unsafe path");
      if (entry.name.endsWith("/")) return false;
      safeRelativePath(entry.name);
      return !entry.name.startsWith("__MACOSX/") && !entry.name.endsWith(".DS_Store");
    } });
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
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
  for (const name of names) for (let index = 1, parts = name.split("/"); index < parts.length; index++) {
    if (names.has(parts.slice(0, index).join("/"))) throw apiError("invalid_zip_path", "ZIP contains conflicting file and directory paths");
  }
  return result;
}

export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function randomToken(bytes = 32): string { return randomBytes(bytes).toString("base64url"); }

export function cleanUsername(value: unknown): string {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw apiError("invalid_username", "username must be 3 to 32 lowercase letters, numbers, dots, dashes, or underscores");
  return username;
}

export function cleanDisplayName(value: unknown): string {
  if (typeof value !== "string") throw apiError("invalid_display_name", "display name is required");
  const displayName = value.replace(/\s+/g, " ").trim();
  if (!displayName || displayName.length > 28) throw apiError("invalid_display_name", "display name must contain 1 to 28 characters");
  return displayName;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 10 || value.length > 256) throw apiError("invalid_password", "password must contain 10 to 256 characters");
  return value;
}

export function passwordRecord(password: string): PasswordRecord {
  const salt = randomBytes(16), hash = scryptSync(password, salt, 64);
  return { salt: salt.toString("base64"), hash: hash.toString("base64") };
}

export function passwordMatches(password: unknown, record: PasswordRecord): boolean {
  try {
    if (typeof password !== "string") return false;
    const expected = Buffer.from(record.hash, "base64"), actual = scryptSync(password, Buffer.from(record.salt, "base64"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

export function parseCookies(request: Pick<Request, "headers">): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of String(request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    try { result[name] = decodeURIComponent(part.slice(separator + 1).trim()); } catch {}
  }
  return result;
}

export function sessionCookie(request: Request, name: string, value: string, maxAge: number): string {
  const secure = request.secure || request.get("x-forwarded-proto") === "https";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function isUnicodeBoundary(source: string, offset: number): boolean {
  if (offset <= 0 || offset >= source.length) return true;
  const before = source.charCodeAt(offset - 1), after = source.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

export function isWellFormedUtf16(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function agentAuthor(agent?: AgentIdentity): string {
  const clean = (value: unknown): string => String(value || "").replaceAll("\\", "/").replace(/[{}%#\r\n]/g, " ").replace(/\s+/g, " ").trim();
  const id = clean(agent?.id), name = clean(agent?.name);
  if (!/^ag_[a-zA-Z0-9]+$/.test(id) || !name || name.length > 64) throw apiError("invalid_agent", "suggesting patches require agent.id and agent.name");
  return `Agent: ${name} [${id}]`;
}

export function atomicWriteSync(target: string, bytes: string | Uint8Array): void {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes);
  renameSync(temporary, target);
}

export function roomNameForPath(relativePath: string): string { return Buffer.from(relativePath, "utf8").toString("base64url"); }
export function pathFromRoomName(roomName: string): string {
  try { return safeRelativePath(Buffer.from(roomName, "base64url").toString("utf8")); }
  catch { throw apiError("invalid_room", "collaboration room is invalid"); }
}
