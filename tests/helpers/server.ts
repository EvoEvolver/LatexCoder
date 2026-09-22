import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { zipSync, strToU8 } from "fflate";
import { createPaperServer, safeRelativePath } from "../../src/server/main.ts";
import { parseReviews, stripReviewStorage } from "../../src/shared/review.ts";
import type { CollaborationStore, PaperServer, ServerOptions } from "../../src/server/types.ts";

export const execFileAsync = promisify(execFile);

export type ServerTestContext = Omit<PaperServer, "projectDir" | "collaboration"> & {
  base: string;
  ws: string;
  projectDir: string;
  collaboration: CollaborationStore;
};

export async function testGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c", "user.name=Test User",
    "-c", "user.email=test@example.com",
    ...args,
  ], { cwd });
  return stdout.trim();
}

export async function createIncomingBranch(projectDir: string, branch: string, mutate: (worktree: string) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-git-worktree-"));
  try {
    await testGit(projectDir, ["worktree", "add", "-b", branch, temporary, "main"]);
    await mutate(temporary);
    await testGit(temporary, ["add", "-A"]);
    await testGit(temporary, ["commit", "-m", `${branch} changes`]);
  } finally {
    await testGit(projectDir, ["worktree", "remove", "--force", temporary]).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function withServer(run: (context: ServerTestContext) => Promise<void>, options: ServerOptions = {}): Promise<void> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-test-"));
  const paper = await createPaperServer({ stateDir, authDisabled: true, ...options });
  await new Promise<void>((resolve, reject) => {
    paper.server.once("error", reject);
    paper.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = paper.server.address() as AddressInfo;
  try {
    if (!paper.projectDir || !paper.collaboration) throw new Error("test server did not create its default project");
    await run({
      ...paper,
      projectDir: paper.projectDir,
      collaboration: paper.collaboration,
      base: `http://127.0.0.1:${address.port}`,
      ws: `ws://127.0.0.1:${address.port}`,
    });
  } finally {
    paper.shutdown();
    paper.sockets.close();
    await new Promise(resolve => paper.server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}

export function waitFor(testValue: () => boolean, timeout = 3000) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (testValue()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error("condition timed out"));
      }
    }, 20);
  });
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function createFakeLatexmk(directory: string): Promise<string> {
  const executable = path.join(directory, "latexmk-fake");
  await writeFile(executable, [
    "#!/bin/sh",
    'root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'count_file="$root/count"',
    'out=""',
    'main=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    -outdir=*) out="${arg#-outdir=}" ;;',
    '    *.tex) main="$arg" ;;',
    '  esac',
    'done',
    'mkdir -p "$out"',
    'count=0',
    '[ ! -f "$count_file" ] || read count < "$count_file"',
    'count=$((count + 1))',
    'printf "%s\n" "$count" > "$count_file"',
    'base=${main##*/}',
    'base=${base%.tex}',
    '{ printf "fake-pdf-%s\n" "$count"; cat "$main"; } > "$out/$base.pdf"',
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);
  return executable;
}

export async function createFakeBwrap(directory: string): Promise<string> {
  const executable = path.join(directory, "bwrap-fake");
  await writeFile(executable, [
    "#!/bin/sh",
    'root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'printf "%s\\n" "$@" > "$root/args"',
    'project=""',
    'rg=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --ro-bind)',
    '      [ "$3" != "/project" ] || project="$2"',
    '      [ "$3" != "/usr/bin/rg" ] || rg="$2"',
    '      shift 3 ;;',
    '    --setenv) shift 3 ;;',
    '    --cap-drop) shift 2 ;;',
    '    --dir|--proc|--dev|--tmpfs|--chdir) shift 2 ;;',
    '    --die-with-parent|--new-session|--unshare-all|--clearenv) shift ;;',
    '    /usr/bin/rg)',
    '      cd "$project" || exit 125',
    '      shift',
    '      exec "$rg" "$@" ;;',
    '    *) exit 126 ;;',
    '  esac',
    'done',
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);
  return executable;
}
