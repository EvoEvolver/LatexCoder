import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { apiError, safeRelativePath } from "./core.ts";
import type { ProcessOptions, ProcessResult, RipgrepOptions, RipgrepResult } from "./types.ts";

const MAX_SEARCH_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
const BOOLEAN_OPTIONS = new Set([
  "--auto-hybrid-regex", "--block-buffered", "--byte-offset", "--case-sensitive", "--column", "--count", "--count-matches", "--crlf", "--fixed-strings", "--heading", "--hidden", "--ignore-case", "--include-zero", "--invert-match", "--json", "--line-buffered", "--line-number", "--multiline", "--multiline-dotall", "--max-columns-preview", "--no-filename", "--no-heading", "--no-ignore", "--no-ignore-dot", "--no-ignore-exclude", "--no-ignore-files", "--no-ignore-global", "--no-ignore-messages", "--no-ignore-parent", "--no-ignore-vcs", "--no-line-number", "--no-messages", "--no-require-git", "--no-unicode", "--null", "--null-data", "--one-file-system", "--only-matching", "--passthru", "--pcre2", "--pretty", "--quiet", "--smart-case", "--stats", "--stop-on-nonmatch", "--text", "--trim", "--unicode", "--vimgrep", "--with-filename", "--word-regexp", "--line-regexp", "--files-with-matches", "--files-without-match",
]);
const VALUE_OPTIONS = new Set(["--after-context", "--before-context", "--context", "--context-separator", "--dfa-size-limit", "--encoding", "--engine", "--field-context-separator", "--field-match-separator", "--glob", "--iglob", "--max-columns", "--max-count", "--max-depth", "--max-filesize", "--path-separator", "--regex-size-limit", "--replace", "--sort", "--sortr", "--type", "--type-not"]);
const SHORT_BOOLEAN_OPTIONS = new Set(["a", "c", "F", "H", "I", "i", "l", "n", "N", "o", "p", "P", "q", "s", "S", "U", "u", "v", "w", "x"]);
const SHORT_VALUE_OPTIONS = new Set(["A", "B", "C", "E", "g", "j", "m", "M", "r", "t", "T"]);

export function run(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 60_000, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, shell: false });
    let output = "";
    const append = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-300_000); };
    child.stdout.on("data", append); child.stderr.on("data", append); child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

export function validatedSearchOptions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw apiError("invalid_search_args", "args must be an array of at most 64 ripgrep options");
  const args: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const argument = value[index];
    if (typeof argument !== "string" || !argument || argument.length > 512 || argument.includes("\0")) throw apiError("invalid_search_args", `args[${index}] is invalid`);
    if (argument === "--" || !argument.startsWith("-")) throw apiError("invalid_search_args", `args[${index}] must be a supported ripgrep option`);
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("="), name = equals === -1 ? argument : argument.slice(0, equals);
      if (BOOLEAN_OPTIONS.has(name) && equals === -1) { args.push(argument); continue; }
      if (VALUE_OPTIONS.has(name)) {
        if (equals !== -1) {
          if (equals === argument.length - 1) throw apiError("invalid_search_args", `${name} requires a value`);
          args.push(argument); continue;
        }
        const optionValue = value[index + 1];
        if (typeof optionValue !== "string" || !optionValue || optionValue.length > 512 || optionValue.includes("\0")) throw apiError("invalid_search_args", `${name} requires a value`);
        args.push(argument, optionValue); index++; continue;
      }
      throw apiError("unsupported_search_option", `${name} is not available through the search API`);
    }
    const option = argument[1];
    if (argument.length === 2 && SHORT_VALUE_OPTIONS.has(option)) {
      const optionValue = value[index + 1];
      if (typeof optionValue !== "string" || !optionValue || optionValue.length > 512 || optionValue.includes("\0")) throw apiError("invalid_search_args", `${argument} requires a value`);
      args.push(argument, optionValue); index++; continue;
    }
    if (SHORT_VALUE_OPTIONS.has(option) && argument.length > 2) { args.push(argument); continue; }
    if ([...argument.slice(1)].every(character => SHORT_BOOLEAN_OPTIONS.has(character))) { args.push(argument); continue; }
    throw apiError("unsupported_search_option", `${argument} is not available through the search API`);
  }
  return args;
}

export async function validatedSearchPaths(projectDir: string, value: unknown): Promise<string[]> {
  if (value === undefined) return ["."];
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw apiError("invalid_search_paths", "paths must contain 1 to 32 project-relative paths");
  const paths: string[] = [];
  for (const valuePath of value) {
    const relativePath = valuePath === "." ? "." : safeRelativePath(valuePath);
    if (relativePath.split("/").includes(".git")) throw apiError("invalid_search_paths", "Git metadata cannot be searched");
    if (relativePath !== ".") {
      let current = projectDir;
      for (const component of relativePath.split("/")) {
        current = path.join(current, component);
        try { if ((await lstat(current)).isSymbolicLink()) throw apiError("invalid_search_paths", "search paths cannot traverse symbolic links"); }
        catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") break;
          throw error;
        }
      }
    }
    paths.push(relativePath);
  }
  return paths;
}

export async function executablePath(command: string): Promise<string | null> {
  const candidates = command.includes(path.sep) ? [command] : (process.env.PATH || "").split(path.delimiter).filter(Boolean).map(directory => path.join(directory, command));
  for (const candidate of candidates) try { await access(candidate, 1); return await realpath(candidate); } catch {}
  return null;
}

export async function runRipgrep(projectDir: string, args: string[], options: RipgrepOptions = {}): Promise<RipgrepResult> {
  const bwrap = await executablePath(options.bwrap || process.env.LATEXCODER_BWRAP_BIN || "bwrap");
  if (!bwrap) throw apiError("search_sandbox_unavailable", "bubblewrap is required for project search", 503);
  const rg = await executablePath(options.rg || process.env.LATEXCODER_RG_BIN || "rg");
  if (!rg) throw apiError("search_unavailable", "ripgrep is not installed", 503);
  const sandboxArgs = ["--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL", "--clearenv", "--setenv", "PATH", "/usr/bin", "--setenv", "HOME", "/tmp", "--dir", "/usr", "--dir", "/usr/bin", "--ro-bind", rg, "/usr/bin/rg"];
  for (const runtimePath of ["/lib", "/lib64", "/usr/lib", "/usr/lib64"]) if (existsSync(runtimePath)) sandboxArgs.push("--ro-bind", runtimePath, runtimePath);
  sandboxArgs.push("--tmpfs", "/tmp", "--ro-bind", projectDir, "/project", "--chdir", "/project", "/usr/bin/rg", ...args);
  return new Promise((resolve, reject) => {
    const child = spawn(bwrap, sandboxArgs, { shell: false, env: { PATH: process.env.PATH || "" } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, settled = false, limitExceeded = false, timedOut = false;
    const append = (target: Buffer[]) => (chunk: Buffer): void => { size += chunk.length; if (size > MAX_SEARCH_OUTPUT_BYTES) { limitExceeded = true; child.kill("SIGKILL"); } else target.push(chunk); };
    child.stdout.on("data", append(stdout)); child.stderr.on("data", append(stderr));
    child.on("error", error => { if (!settled) reject(apiError("search_unavailable", error.message, 503)); settled = true; });
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS) : DEFAULT_SEARCH_TIMEOUT_MS;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", code => {
      clearTimeout(timer); if (settled) return; settled = true;
      if (limitExceeded) return reject(apiError("search_output_too_large", "ripgrep output exceeded 4 MiB", 413));
      if (timedOut) return reject(apiError("search_timeout", `ripgrep exceeded the ${timeoutMs}ms search limit`, 408));
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

export function runBinary(command: string, args: string[], options: ProcessOptions = {}, input: Uint8Array = Buffer.alloc(0)): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let settled = false;
    child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", error => { if (!settled) reject(error); settled = true; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", code => {
      clearTimeout(timer); if (settled) return; settled = true;
      if (code === 0) return resolve(Buffer.concat(stdout));
      reject(apiError("git_failed", Buffer.concat(stderr).toString("utf8").trim() || `Git exited with code ${code}`, 409));
    });
    child.stdin.end(input);
  });
}
