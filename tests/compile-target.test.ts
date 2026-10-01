import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileDirectives, compileTemplate } from "../src/shared/compile-directives.ts";
import { withServer, createFakeLatexmk } from "./helpers/server.ts";

const chapter = "%% latexcoder:root main.tex\n%% latexcoder:template templates/chapter.tex\n\\chapter{Methods}\n\\input{chapters/part-a.tex}\n\\input{chapters/part-b.tex}\n";
const child = "%% latexcoder:chapter-root chapters/methods.tex\nFirst chapter subsection.\n";
const template = "\\documentclass{report}\n\\begin{document}\nTemplate introduction.\n%% latexcoder:content\n\\end{document}\n";
const main = "\\documentclass{report}\n\\begin{document}\nFull document only.\n\\input{chapters/methods.tex}\n\\end{document}\n";

async function put(base: string, file: string, source: string) {
  const response = await fetch(`${base}/v1/files?path=${encodeURIComponent(file)}`, { method: "PUT", body: source });
  assert.ok(response.ok, await response.text());
}

async function fixture(base: string) {
  for (const [file, source] of Object.entries({ "main.tex": main, "chapters/methods.tex": chapter, "chapters/part-a.tex": child,
    "chapters/part-b.tex": "%% latexcoder:chapter-root chapters/methods.tex\nSecond chapter subsection.\n", "templates/chapter.tex": template })) await put(base, file, source);
}

const selection = { mode: "chapter", file: "chapters/part-a.tex" };
const query = new URLSearchParams(selection).toString();
const compile = (base: string, body: object = selection) => fetch(`${base}/v1/compile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("compile declarations are leading comments, reject duplicates, and preserve template line numbers", () => {
  assert.equal(compileDirectives(`\uFEFF\n${child}`, "part.tex")["chapter-root"]?.line, 2);
  assert.deepEqual(compileDirectives("\\section{Example}\n%% latexcoder:template example.tex", "part.tex"), {});
  assert.throws(() => compileDirectives("%% latexcoder:root a.tex\n%% latexcoder:root b.tex", "part.tex"), /part.tex:2: duplicate/);
  assert.throws(() => compileDirectives("%% latexcoder:template", "part.tex"), /needs a value/);
  assert.equal(compileTemplate(template, "template.tex", "chapters/a b.tex"), template.replace("%% latexcoder:content", '\\input{"chapters/a b.tex"}'));
  assert.throws(() => compileTemplate(template + "%% latexcoder:content\n", "template.tex", "a.tex"), /exactly one/);
  assert.throws(() => compileTemplate("no marker", "template.tex", "a.tex"), /exactly one/);
});

test("chapter builds resolve from children and isolate PDF, metadata, cache and failures from the root", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "latexcoder-chapter-"));
  try {
    const compiler = await createFakeLatexmk(directory);
    await withServer(async ({ base, projectDir, database }) => {
      await fixture(base);
      const root = await fetch(`${base}/v1/build/pdf`);
      const rootPdf = await root.text();
      const rootRevision = root.headers.get("x-latex-coder-source-revision");
      const { target } = await (await fetch(`${base}/v1/compile-target?${query}`)).json();
      assert.deepEqual(target, { mode: "chapter", main: "chapters/methods.tex", template: "templates/chapter.tex" });
      const responses = await Promise.all([compile(base), compile(base, { mode: "chapter", file: "chapters/part-b.tex" })]);
      for (const response of responses) assert.equal(response.status, 200, await response.text());
      assert.equal((await readFile(path.join(directory, "count"), "utf8")).trim(), "2");
      const pdf = await fetch(`${base}/v1/build/pdf?${query}`);
      const chapterPdf = await pdf.text();
      assert.match(chapterPdf, /Template introduction/);
      assert.match(chapterPdf, /\\input\{"chapters\/methods.tex"\}/);
      assert.doesNotMatch(chapterPdf, /Full document only/);
      assert.notEqual(pdf.headers.get("x-latex-coder-source-revision"), rootRevision);
      assert.match(pdf.headers.get("link")!, /mode=chapter/);
      assert.equal(await (await fetch(`${base}/v1/build/pdf?cached=1`)).text(), rootPdf);
      const { project } = await (await fetch(`${base}/v1/project`)).json();
      assert.equal(project.main, "main.tex");
      assert.equal(database.getSettings(project.id).main, "main.tex");
      assert.equal(await readFile(path.join(projectDir, "templates/chapter.tex"), "utf8"), template);
      await put(base, "templates/chapter.tex", template.replace("Template introduction", "Changed template"));
      const changed = await fetch(`${base}/v1/build/pdf?${query}`);
      assert.match(await changed.text(), /Changed template/);
      assert.notEqual(changed.headers.get("x-latex-coder-source-revision"), pdf.headers.get("x-latex-coder-source-revision"));
      await writeFile(compiler, '#!/bin/sh\nprintf "chapters/part-a.tex:2: Broken chapter\\n"\nexit 1\n');
      const failure = await compile(base);
      assert.equal(failure.status, 422);
      assert.equal((await failure.json()).build.errors[0].path, "chapters/part-a.tex");
      assert.equal(await (await fetch(`${base}/v1/build/pdf?cached=1`)).text(), rootPdf);
      assert.match(await (await fetch(`${base}/v1/build/pdf?${query}&cached=1`)).text(), /Changed template/);
    }, { compiler });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("source declarations support root overrides, complete chapters and actionable invalid configurations", async () => {
  await withServer(async ({ base }) => {
    await fixture(base);
    const target = async (file: string, mode = "chapter") => {
      const response = await fetch(`${base}/v1/compile-target?${new URLSearchParams({ mode, file })}`);
      return { status: response.status, body: await response.json() };
    };
    await put(base, "alternate.tex", main);
    await put(base, "chapters/methods.tex", chapter.replace("root main.tex", "root alternate.tex"));
    assert.equal((await target("chapters/part-a.tex", "project")).body.target.main, "alternate.tex");
    await put(base, "standalone.tex", "%% latexcoder:template none\n" + main);
    assert.deepEqual((await target("standalone.tex")).body.target, { mode: "chapter", main: "standalone.tex" });
    for (const [source, expected] of [
      ["%% latexcoder:chapter-root ../outside.tex", /inside the project/],
      ["%% latexcoder:chapter-root loops.tex", /circular/],
      ["%% latexcoder:template missing.tex", /file does not exist/],
    ] as const) {
      await put(base, "bad.tex", source);
      await put(base, "loops.tex", "%% latexcoder:chapter-root bad.tex");
      const result = await target("bad.tex");
      assert.equal(result.status, 400);
      assert.match(result.body.error.message, expected);
    }
    await put(base, "templates/chapter.tex", template.replace("%% latexcoder:content", ""));
    assert.match((await target("chapters/part-a.tex")).body.error.message, /exactly one/);
    assert.equal((await (await fetch(`${base}/v1/settings`)).json()).settings.main, "main.tex");
  });
});

test("missing chapter roots fall back to the top-level root for compilation and PDF requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "latexcoder-chapter-fallback-"));
  try {
    const compiler = await createFakeLatexmk(directory);
    await withServer(async ({ base }) => {
      await fixture(base);
      await put(base, "alternate.tex", "Alternate full document");
      await put(base, "chapters/intermediate.tex", "%% latexcoder:root alternate.tex\n%% latexcoder:chapter-root missing.tex\n");
      for (const [source, expected] of [
        ["Unmarked child", "main.tex"],
        ["%% latexcoder:chapter-root missing.tex", "main.tex"],
        ["%% latexcoder:root alternate.tex\n%% latexcoder:chapter-root missing.tex", "alternate.tex"],
        ["%% latexcoder:root alternate.tex\nUnmarked child", "alternate.tex"],
        ["%% latexcoder:chapter-root chapters/intermediate.tex", "alternate.tex"],
      ]) {
        await put(base, "child.tex", source);
        const query = new URLSearchParams({ mode: "chapter", file: "child.tex" });
        const targetResponse = await fetch(`${base}/v1/compile-target?${query}`);
        assert.equal(targetResponse.status, 200);
        assert.deepEqual((await targetResponse.json()).target, { mode: "project", main: expected });
        const response = await compile(base, { mode: "chapter", file: "child.tex" });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await response.json()).build.main, expected);
        const pdf = await fetch(`${base}/v1/build/pdf?${query}`);
        assert.equal(pdf.status, 200);
        assert.match(await pdf.text(), expected === "main.tex" ? /Full document only/ : /Alternate full document/);
        const report = await (await fetch(`${base}/v1/build?${query}`)).json();
        assert.equal(report.build.status, "success");
        assert.equal(report.build.main, expected);
        assert.equal(report.build.stale, false);
      }
    }, { compiler });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const realLatexmk = ["/Library/TeX/texbin/latexmk", "/usr/bin/latexmk"].find(existsSync);
test("real chapter compilation includes all children and maps template and child SyncTeX locations", { skip: !realLatexmk }, async () => {
  await withServer(async ({ base }) => {
    await fixture(base);
    const response = await compile(base);
    assert.equal(response.status, 200, await response.text());
    const pdf = await fetch(`${base}/v1/build/pdf?${query}`);
    assert.equal(pdf.status, 200);
    assert.match(Buffer.from(await pdf.arrayBuffer()).toString("ascii", 0, 5), /%PDF-/);
    for (const [file, source, line] of [["chapters/part-a.tex", child, 2], ["chapters/part-b.tex", "%% latexcoder:chapter-root chapters/methods.tex\nSecond chapter subsection.\n", 2], ["templates/chapter.tex", template, 3]] as const) {
      const position = await fetch(`${base}/v1/build/position?${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: file, source, line }) });
      assert.equal(position.status, 200);
      const point = await position.json();
      assert.ok(point.boxes.length);
      const reverse = await fetch(`${base}/v1/build/source?${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: point.page, x: point.x, y: point.y, revision: point.revision }) });
      assert.equal(reverse.status, 200);
      assert.equal((await reverse.json()).path, file);
    }
    await put(base, "templates/chapter.tex", template.replace("Template introduction.", "\\nonexistentTemplateCommand"));
    const broken = await compile(base);
    assert.equal(broken.status, 422);
    const { build } = await broken.json();
    assert.ok(build.errors.some((error: { path: string; line: number }) => error.path === "templates/chapter.tex" && error.line === 3), build.log);
  }, { compiler: realLatexmk });
});
