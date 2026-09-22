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
import { createPaperServer, safeRelativePath } from "../src/server/main.ts";
import { parseReviews, stripReviewStorage } from "../src/shared/review.ts";

import { execFileAsync, testGit, createIncomingBranch, withServer, waitFor, sha256, createFakeLatexmk, createFakeBwrap } from "./helpers/server.ts";

test("PDF download compiles current inputs and caches by source revision", async () => {
  const compilerDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-fake-compiler-"));
  const compiler = await createFakeLatexmk(compilerDir);
  try {
    await withServer(async ({ base }) => {
      const first = await fetch(`${base}/v1/build/pdf`);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("x-build-error-count"), "0");
      assert.equal(first.headers.get("x-build-warning-count"), "0");
      assert.match(first.headers.get("link"), /\/v1\/build\?project=/);
      const firstRevision = first.headers.get("x-latex-coder-source-revision");
      assert.match(firstRevision, /^[a-f0-9]{64}$/);
      assert.match(await first.text(), /^fake-pdf-1\n/);
      assert.equal((await readFile(path.join(compilerDir, "count"), "utf8")).trim(), "1");

      const cached = await fetch(`${base}/v1/build/pdf`);
      assert.equal(cached.status, 200);
      assert.equal(cached.headers.get("x-latex-coder-source-revision"), firstRevision);
      assert.match(await cached.text(), /^fake-pdf-1\n/);
      assert.equal((await readFile(path.join(compilerDir, "count"), "utf8")).trim(), "1");

      await fetch(`${base}/v1/files?path=main.tex`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "new source for the current PDF\n",
      });
      const [updated, concurrent] = await Promise.all([
        fetch(`${base}/v1/build/pdf`),
        fetch(`${base}/v1/build/pdf`),
      ]);
      assert.equal(updated.status, 200);
      assert.equal(concurrent.status, 200);
      const updatedRevision = updated.headers.get("x-latex-coder-source-revision");
      assert.match(updatedRevision, /^[a-f0-9]{64}$/);
      assert.notEqual(updatedRevision, firstRevision);
      assert.equal(concurrent.headers.get("x-latex-coder-source-revision"), updatedRevision);
      assert.match(await updated.text(), /^fake-pdf-2\nnew source for the current PDF\n$/);
      assert.match(await concurrent.text(), /^fake-pdf-2\nnew source for the current PDF\n$/);
      assert.equal((await readFile(path.join(compilerDir, "count"), "utf8")).trim(), "2");

      const build = await (await fetch(`${base}/v1/build`)).json();
      assert.equal(build.build.sourceRevision, updatedRevision);
      assert.equal(build.build.status, "success");
    }, { compiler });
  } finally {
    await rm(compilerDir, { recursive: true, force: true });
  }
});

test("Agent PDF download returns structured diagnostics on failure instead of the old PDF", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "latexcoder-pdf-diagnostics-"));
  const compiler = await createFakeLatexmk(directory);
  try {
    await withServer(async ({ base }) => {
      await writeFile(compiler, await readFile(compiler, "utf8") + '\nprintf "LaTeX Warning: Citation undefined\\n"\n');
      const successful = await fetch(`${base}/v1/build/pdf`);
      assert.equal(successful.status, 200);
      assert.equal(successful.headers.get("x-build-warning-count"), "1");
      const warningReport = await (await fetch(`${base}/v1/build`)).json();
      assert.equal(warningReport.build.diagnostics[0].severity, "warning");
      assert.equal(warningReport.build.firstFatalError, null);
      await writeFile(compiler, '#!/bin/sh\nprintf "main.tex:3: Undefined control sequence\\n! Emergency stop.\\n"\nexit 1\n');
      await fetch(`${base}/v1/files?path=main.tex`, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "Changed source\nSecond line\n\\badcommand" });
      const response = await fetch(`${base}/v1/build/pdf`);
      assert.equal(response.status, 422);
      assert.match(response.headers.get("content-type"), /application\/json/);
      const { error } = await response.json();
      assert.equal(error.code, "compile_failed");
      assert.match(error.details.log, /Undefined control sequence/);
      assert.deepEqual(error.details.firstFatalError, { path: "main.tex", line: 3, message: "Undefined control sequence", severity: "error" });
      assert.equal(error.details.main, "main.tex");
      assert.ok(error.details.diagnostics.length >= 1);
      const { build } = await (await fetch(`${base}/v1/build`)).json();
      assert.equal(build.stale, true);
      assert.deepEqual(build.firstFatalError, error.details.firstFatalError);
    }, { compiler });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("search API exposes project-scoped ripgrep output", async () => {
  const sandboxDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-fake-bwrap-"));
  const bwrap = await createFakeBwrap(sandboxDir);
  try {
    await withServer(async ({ base }) => {
      const write = await fetch(`${base}/v1/files?path=notes.tex`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "first line\nNeedle [one]\nneedle [two]\n",
      });
      assert.equal(write.status, 201);

      const search = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pattern: "needle \\[(?:one|two)\\]",
          args: ["--ignore-case", "--line-number", "--with-filename", "--glob", "*.tex"],
          paths: ["."],
        }),
      });
      assert.equal(search.status, 200);
      assert.equal(search.headers.get("cache-control"), "no-store");
      assert.equal(search.headers.get("x-ripgrep-exit-code"), "0");
      assert.equal(await search.text(), "./notes.tex:2:Needle [one]\n./notes.tex:3:needle [two]\n");

      const noMatch = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "not present", args: ["-nH"], paths: ["notes.tex"] }),
      });
      assert.equal(noMatch.status, 200);
      assert.equal(noMatch.headers.get("x-ripgrep-exit-code"), "1");
      assert.equal(await noMatch.text(), "");

      const externalPath = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "root", paths: ["../"] }),
      });
      assert.equal(externalPath.status, 400);

      const externalCommand = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: ".", args: ["--pre=cat"] }),
      });
      assert.equal(externalCommand.status, 400);
      const uiSearch = await fetch(`${base}/v1/search/project`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "needle \\[(?:one|two)\\]", regex: true }),
      });
      assert.equal(uiSearch.status, 200);
      const matches = (await uiSearch.json()).matches;
      assert.deepEqual(matches.map(match => [match.path, match.line, match.from, match.to]), [["notes.tex", 2, 0, 12], ["notes.tex", 3, 0, 12]]);
      const invalidRegex = await fetch(`${base}/v1/search/project`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "[", regex: true }),
      });
      assert.equal(invalidRegex.status, 422);
    }, { bwrap });

    const sandboxArgs = await readFile(path.join(sandboxDir, "args"), "utf8");
    assert.match(sandboxArgs, /^--die-with-parent$/m);
    assert.match(sandboxArgs, /^--unshare-all$/m);
    assert.match(sandboxArgs, /^--ro-bind$/m);
    assert.match(sandboxArgs, /^\/project$/m);
    assert.match(sandboxArgs, /^\/usr\/bin\/rg$/m);
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
});

test("search API kills timed-out bubblewrap processes", async () => {
  const sandboxDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-search-timeout-"));
  try {
    const bwrap = await createFakeBwrap(sandboxDir);
    const slowRg = path.join(sandboxDir, "rg-slow");
    await writeFile(slowRg, "#!/bin/sh\nsleep 5\n", "utf8");
    await chmod(slowRg, 0o755);
    await withServer(async ({ base }) => {
      const startedAt = Date.now();
      const response = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: "anything" }),
      });
      assert.equal(response.status, 408);
      assert.ok(Date.now() - startedAt < 2_000);
      assert.equal((await response.json()).error.code, "search_timeout");
    }, { bwrap, rg: slowRg, searchTimeoutMs: 50 });
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
});

test("project settings persist and failed compilation retains a visibly stale cached PDF", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "latexcoder-settings-"));
  try {
    const compiler = await createFakeLatexmk(directory);
    await withServer(async ({ base, database }) => {
      const project = (await (await fetch(`${base}/v1/project`)).json()).project;
      await fetch(`${base}/v1/files?path=other.tex`, { method: "PUT", body: "Other source" });
      const settings = await fetch(`${base}/v1/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ main: "other.tex", compiler: "auto", autoCompile: true }) });
      assert.equal(settings.status, 200);
      assert.deepEqual(database.getSettings(project.id), { main: "other.tex", compiler: "auto", autoCompile: true });
      const invalid = await fetch(`${base}/v1/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ main: "../oops.tex", compiler: "auto", autoCompile: false }) });
      assert.equal(invalid.status, 400);
      const firstPdf = await (await fetch(`${base}/v1/build/pdf`)).text();
      await fetch(`${base}/v1/files?path=other.tex`, { method: "PUT", body: "Before\n\\cmtbg{one}{Name}Body\\cmted{Comment\non another line}\nAfter" });
      await writeFile(compiler, '#!/bin/sh\nprintf "other.tex:3: Undefined control sequence\\n"\nexit 1\n');
      const failure = await fetch(`${base}/v1/compile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(failure.status, 422);
      const cached = await fetch(`${base}/v1/build/pdf?cached=1`);
      assert.equal(cached.status, 200);
      assert.equal(await cached.text(), firstPdf);
      const build = (await (await fetch(`${base}/v1/build`)).json()).build;
      assert.equal(build.stale, true);
      assert.equal(build.errors[0].path, "other.tex");
      assert.equal(build.errors[0].line, 4);
      assert.equal(database.getBuild(project.id).errors[0].line, 4);
    }, { compiler });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
