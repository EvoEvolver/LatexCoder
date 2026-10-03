import assert from "node:assert/strict";
import test from "node:test";
import { withEditor, realLatexmk, previewPdf, chooseCompileMode } from "./helpers/browser.ts";

test("compile arrow offers checked targets and explains missing chapter directives using live source", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    const source = "\\documentclass{article}\n\\begin{document}\nText\n%% latexcoder:template none\n\\end{document}\n";
    await page.request.put(`${base}/v1/files?project=${id}&path=main.tex`, { data: source });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => globalThis.__paperE2E?.state.provider?.synced);
    assert.equal(await page.locator("select#compile-mode").count(), 0);
    assert.equal(await page.locator("#compile-control > button").count(), 2);
    await page.locator("#compile-mode").focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.locator("#compile-mode-project").getAttribute("aria-checked"), "true");
    await page.locator("#compile-mode-chapter").click();
    const help = page.locator("#chapter-help-dialog");
    await help.waitFor();
    assert.match(await help.textContent() || "", /main.tex/);
    for (const marker of ["chapter-root", "template", "content"]) assert.ok((await help.textContent())?.includes(`%% latexcoder:${marker}`));
    assert.equal(await page.evaluate(() => globalThis.__paperE2E.state.view.state.doc.toString()), source);
    await page.keyboard.press("Escape");
    await chooseCompileMode(page, "chapter");
    await help.waitFor();
    await page.locator("#chapter-help-close").click();
    await page.evaluate(() => {
      const view = globalThis.__paperE2E.state.view;
      view.dispatch({ changes: { from: 0, insert: "%% latexcoder:template none\n" } });
    });
    const targetResponse = page.waitForResponse(response => response.url().includes("/v1/build?") && response.url().includes("mode=chapter"));
    await chooseCompileMode(page, "chapter");
    await targetResponse;
    assert.equal(await help.isVisible(), false, "a live template declaration suppresses the setup guide");
    await page.locator("#compile-mode").click();
    assert.equal(await page.locator("#compile-mode-chapter").getAttribute("aria-checked"), "true");
    await page.locator("#compile-mode-project").click();
    assert.equal(await help.isVisible(), false);
  });
});

test("Compile switches between the top-level document and the whole chapter from a child file", { skip: !realLatexmk }, async () => {
  await withEditor(async ({ page, base }) => {
    page.setDefaultTimeout(15000);
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    const files = {
      "main.tex": "\\documentclass{report}\n\\begin{document}\nFull document only.\n\\input{chapters/methods.tex}\n\\end{document}\n",
      "chapters/methods.tex": "%% latexcoder:root main.tex\n%% latexcoder:template templates/chapter.tex\n\\chapter{Methods}\n\\input{chapters/child.tex}\n\\input{chapters/sibling.tex}\n",
      "chapters/child.tex": "%% latexcoder:chapter-root chapters/methods.tex\nFirst subsection text.\n",
      "chapters/sibling.tex": "%% latexcoder:chapter-root chapters/methods.tex\n\nSecond subsection text.\n",
      "templates/chapter.tex": "\\documentclass{report}\n\\begin{document}\nTemplate only.\n%% latexcoder:content\n\\end{document}\n",
    };
    for (const [file, source] of Object.entries(files)) {
      const response = await page.request.put(`${base}/v1/files?project=${id}&path=${encodeURIComponent(file)}`, { data: source });
      assert.ok(response.ok());
    }
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => globalThis.__paperE2E?.state.provider?.synced);
    // The unmarked main file uses the full document even in Chapter root mode.
    await chooseCompileMode(page, "chapter");
    await page.locator("#chapter-help-dialog").waitFor();
    await page.locator("#chapter-help-done").click();
    await page.waitForFunction(() => document.querySelector("#compile-mode")?.getAttribute("title") === "Top-level root: main.tex");
    const fallbackResponse = page.waitForResponse(response => response.url().includes("/v1/compile") && response.request().method() === "POST");
    await page.locator("#compile-button").click();
    const fallback = await fallbackResponse;
    assert.equal(fallback.status(), 200);
    assert.equal((await fallback.json()).build.main, "main.tex");
    await page.locator("#pdf-document canvas").first().waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#compile-button")?.disabled);
    await page.locator('[data-tree-path="chapters"]').click();
    await page.locator('[data-tree-path="chapters/child.tex"]').click();
    await page.waitForFunction(() => globalThis.__paperE2E.state.activeFile === "chapters/child.tex" && globalThis.__paperE2E.state.provider?.synced);
    await chooseCompileMode(page, "chapter");
    await page.waitForFunction(() => document.querySelector("#compile-mode")?.getAttribute("title")?.includes("templates/chapter.tex"));
    const compileResponse = page.waitForResponse(response => response.url().includes("/v1/compile") && response.request().method() === "POST");
    await page.locator("#compile-button").click();
    assert.deepEqual((await compileResponse).request().postDataJSON(), { mode: "chapter", file: "chapters/child.tex" });
    await page.locator("#pdf-document canvas").first().waitFor();
    const pdfText = () => page.evaluate(async () => {
      const pdf = globalThis.__paperE2E.state.pdfDocument;
      const text: string[] = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        text.push(content.items.map(item => "str" in item ? item.str : "").join(" "));
      }
      return text.join("\n");
    });
    assert.match(await pdfText(), /First subsection text/);
    assert.match(await pdfText(), /Second subsection text/);
    assert.match(await pdfText(), /Template only/);
    assert.doesNotMatch(await pdfText(), /Full document only/);
    const chapterDownload = await page.locator("#pdf-download").getAttribute("href");
    assert.match(chapterDownload!, /mode=chapter/);
    assert.equal(await page.locator("#pdf-download").getAttribute("download"), "methods.pdf");
    await page.locator('[data-tree-path="chapters/sibling.tex"]').click();
    assert.equal(await page.locator("#pdf-download").getAttribute("href"), chapterDownload);
    await chooseCompileMode(page, "project");
    await page.waitForFunction(() => document.querySelector("#compile-mode")?.getAttribute("title") === "Top-level root: main.tex");
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#compile-button")?.disabled);
    await page.locator("#compile-button").click();
    await page.locator("#pdf-document canvas").first().waitFor();
    assert.match(await pdfText(), /Full document only/);
    assert.doesNotMatch(await pdfText(), /Template only/);
    const settings = await (await page.request.get(`${base}/v1/settings?project=${id}`)).json();
    assert.equal(settings.settings.main, "main.tex");
    assert.ok(await page.evaluate(() => {
      const header = document.querySelector(".output-header")!.getBoundingClientRect();
      return ["compile-button", "compile-mode", "output-view-tabs", "pdf-download"].every(id => {
        const rect = document.getElementById(id)!.getBoundingClientRect();
        return rect.top >= header.top && rect.bottom <= header.bottom && rect.left >= header.left && rect.right <= header.right;
      });
    }), "compile controls fit inside the PDF toolbar");
    await page.screenshot({ path: "/tmp/latexcoder-chapter-compile.png" });
  }, { compiler: realLatexmk });
});

test("switching compile mode discards a late response from the previous target", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    await page.request.put(`${base}/v1/files?project=${id}&path=main.tex`, { data: "%% latexcoder:template none\n\\documentclass{article}\n\\begin{document}Text\\end{document}" });
    let finish: (() => void) | undefined;
    let arrived!: () => void;
    const requestArrived = new Promise<void>(resolve => { arrived = resolve; });
    await page.route("**/v1/compile?*", async route => {
      await new Promise<void>(resolve => { finish = resolve; arrived(); });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ build: { log: "OLD CHAPTER RESULT", main: "main.tex" } }) });
    });
    let downloads = 0;
    await page.route("**/v1/build/pdf*", route => {
      downloads++;
      return route.fulfill({ contentType: "application/pdf", body: previewPdf() });
    });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => globalThis.__paperE2E?.state.provider?.synced);
    await chooseCompileMode(page, "chapter");
    await page.locator("#compile-button").click();
    await requestArrived;
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>("#compile-button")?.disabled);
    await chooseCompileMode(page, "project");
    finish!();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#compile-button")?.disabled);
    assert.doesNotMatch(await page.locator("#build-output").textContent() || "", /OLD CHAPTER RESULT/);
    assert.equal(downloads, 0);
  });
});
