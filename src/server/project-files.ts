import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { stripReviewStorage } from "../shared/review.ts";
import { apiError, contentPath, isTextFile } from "./core.ts";
import type { ContentEntry, ProjectFile } from "./types.ts";

export async function listFiles(projectDir: string): Promise<ProjectFile[]> {
  const result: ProjectFile[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relativePath);
      else if (entry.isFile()) {
        const details = await stat(path.join(directory, entry.name));
        result.push({ path: relativePath, size: details.size, text: isTextFile(relativePath) });
      }
    }
  }
  await visit(projectDir);
  return result;
}

export async function listFolders(projectDir: string, prefix = ""): Promise<string[]> {
  const folders: string[] = [];
  for (const entry of await readdir(path.join(projectDir, prefix), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folder = prefix ? `${prefix}/${entry.name}` : entry.name;
    folders.push(folder, ...await listFolders(projectDir, folder));
  }
  return folders.sort();
}

export function checkedContentTarget(root: string, relativePath: string): string {
  const target = path.join(root, contentPath(relativePath));
  for (let directory = target; directory !== root; directory = path.dirname(directory)) {
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw apiError("invalid_path", "Symbolic links are not editable");
  }
  return target;
}

export function contentEntries(root: string, relativePath: string): ContentEntry[] {
  const target = checkedContentTarget(root, relativePath);
  const info = lstatSync(target);
  const entries = [{ path: relativePath, directory: info.isDirectory() }];
  if (info.isDirectory()) for (const child of readdirSync(target)) {
    if (child.startsWith(".")) throw apiError("invalid_path", "Folder contains hidden metadata");
    entries.push(...contentEntries(root, `${relativePath}/${child}`));
  }
  return entries;
}

export async function compilationSourceRevision(projectDir: string, main = "main.tex", compiler = "auto"): Promise<string> {
  const digest = createHash("sha256");
  digest.update(`${main}\0${compiler}\0`);
  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".paper-output") continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) {
        let content = await readFile(absolutePath);
        if (relativePath.endsWith(".tex")) content = Buffer.from(stripReviewStorage(content.toString("utf8")));
        digest.update(relativePath); digest.update("\0"); digest.update(String(content.length)); digest.update("\0"); digest.update(content); digest.update("\0");
      }
    }
  }
  await visit(projectDir);
  return digest.digest("hex");
}
