import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { apiError, safeRelativePath } from "./core.ts";

const execute = promisify(execFile);
const metadataPrefix = "Latexcoder-Version: ";
export type VersionMetadata = { kind: "checkpoint" | "agent" | "restore"; main: string; folders?: string[]; agentId?: string; agentName?: string; mode?: string; restoredFrom?: string };
export function versionMessage(subject: string, metadata: VersionMetadata): string {
  return `${subject}\n\n${metadataPrefix}${JSON.stringify(metadata)}`;
}
async function readGit(directory: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute("git", ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: directory, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
    });
    return stdout;
  } catch (error) {
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw apiError("history_too_large", "This version is too large to display. Use the project Git clone to inspect it.", 413);
    throw apiError("history_unavailable", "Could not read this version", 409);
  }
}
export async function historyCommit(directory: string, value: unknown): Promise<string> {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw apiError("invalid_version", "A full version ID is required");
  // Only expose versions that belong to the live project's history.
  await readGit(directory, ["merge-base", "--is-ancestor", value, "main"]);
  return value;
}
export async function versionInfo(directory: string, id: string) {
  const output = await readGit(directory, ["show", "-s", "--format=%aI%n%B", id]);
  const [date, subject, ...body] = output.trimEnd().split("\n");
  let metadata: VersionMetadata | undefined;
  const line = body.findLast(line => line.startsWith(metadataPrefix));
  if (line) {
    try {
      const parsed = JSON.parse(line.slice(metadataPrefix.length));
      if (parsed && typeof parsed === "object" && typeof parsed.main === "string" && ["checkpoint", "agent", "restore"].includes(parsed.kind)) {
        safeRelativePath(parsed.main);
        if (parsed.folders !== undefined && (!Array.isArray(parsed.folders) || parsed.folders.some((folder: unknown) => typeof folder !== "string"))) throw new Error("Invalid folders");
        parsed.folders?.forEach((folder: string) => safeRelativePath(folder));
        metadata = parsed;
      }
    } catch { /* Legacy/external commit without valid application metadata. */ }
  }
  return { id, shortId: id.slice(0, 7), date, subject, metadata };
}
export async function listVersions(directory: string, before?: unknown, agentOnly = false) {
  const ref = before ? `${await historyCommit(directory, before)}^` : "main";
  // A root commit has no parent; the previous page will never emit it as a cursor.
  const args = ["log", "--first-parent", "-31", "--format=%H"];
  if (agentOnly) args.push("--fixed-strings", "--grep=\"kind\":\"agent\"");
  const ids = (await readGit(directory, [...args, ref, "--"])).trim().split("\n").filter(Boolean);
  const items = await Promise.all(ids.slice(0, 30).map(id => versionInfo(directory, id)));
  return { items, next: ids.length > 30 ? items.at(-1)!.id : null };
}
export async function versionFiles(directory: string, id: string) {
  const output = await readGit(directory, ["diff-tree", "--root", "--diff-merges=first-parent", "--no-commit-id", "-r", "--no-renames", "--numstat", "-z", id, "--"]);
  return output.split("\0").filter(Boolean).map(record => {
    const first = record.indexOf("\t"), second = record.indexOf("\t", first + 1);
    const added = record.slice(0, first), removed = record.slice(first + 1, second);
    return { path: record.slice(second + 1), added: added === "-" ? null : Number(added), removed: removed === "-" ? null : Number(removed) };
  });
}
export async function versionStructure(directory: string, id: string) {
  const info = await versionInfo(directory, id);
  const parents = (await readGit(directory, ["rev-list", "--parents", "-n", "1", id])).trim().split(" ");
  const before = parents[1] ? await versionInfo(directory, parents[1]) : null;
  async function folders(commit: string | undefined, metadata?: VersionMetadata) {
    if (!commit) return [];
    return metadata?.folders ?? (await readGit(directory, ["ls-tree", "-r", "-d", "--name-only", "-z", commit])).split("\0").filter(Boolean);
  }
  const previous = await folders(parents[1], before?.metadata), current = await folders(id, info.metadata);
  return { foldersAdded: current.filter(folder => !previous.includes(folder)), foldersRemoved: previous.filter(folder => !current.includes(folder)),
    main: info.metadata?.main && before?.metadata?.main && info.metadata.main !== before.metadata.main ? { before: before.metadata.main, after: info.metadata.main } : null };
}
export async function versionDiff(directory: string, id: string, requestedPath: unknown) {
  const file = safeRelativePath(requestedPath);
  const files = await versionFiles(directory, id);
  if (!files.some(item => item.path === file)) throw apiError("version_file_missing", "This file did not change in this version", 404);
  const patch = await readGit(directory, ["show", "--format=", "--root", "--first-parent", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=4", id, "--", file]);
  const limit = 160_000;
  return { path: file, patch: patch.slice(0, limit), truncated: patch.length > limit };
}

// Include raw review storage and empty directories: the compilation hash omits
// comments/suggestions and is not suitable for protecting a restore.
export async function historyRevision(directory: string, main: string): Promise<string> {
  const digest = createHash("sha256").update(main + "\0");
  async function visit(root: string, prefix = "") {
    const entries = await readdir(root, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".paper-output") continue;
      const name = prefix + entry.name, target = path.join(root, entry.name);
      digest.update(name + "\0" + (entry.isDirectory() ? "directory" : "file") + "\0");
      if (entry.isDirectory()) await visit(target, name + "/");
      else if (entry.isFile()) { const bytes = await readFile(target); digest.update(String(bytes.length) + "\0"); digest.update(bytes); }
      else throw apiError("history_file_unsupported", "Project history cannot include symbolic links or special files", 409);
    }
  }
  await visit(directory);
  return digest.digest("hex");
}
