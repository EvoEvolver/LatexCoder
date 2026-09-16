import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { chromium } from "playwright";
import { zipSync, strToU8 } from "fflate";

import { createPaperServer } from "../server.ts";

// Drives the real bundled LaTeX Coder editor in headless Chromium against the real
// server, so these tests exercise the exact suggesting-mode transaction
// filter, keymap, and DOM that users hit in the browser.
async function withEditor(run: (context: any) => Promise<void>, options: any = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-e2e-"));
  const paper = await createPaperServer({ stateDir, authDisabled: true, ...options });
  await new Promise<void>((resolve, reject) => {
    paper.server.once("error", reject);
    paper.server.listen(0, "127.0.0.1", () => resolve());
  });
  const base = `http://127.0.0.1:${(paper.server.address() as AddressInfo).port}`;
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${base}/?test=1`);
    await page.waitForFunction(() => globalThis.__paperTest);
    await run({ page, base, browser });
    await page.close();
  } finally {
    await browser?.close();
    paper.shutdown();
    paper.sockets.close();
    await new Promise(resolve => paper.server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}

const LIPSUM = "Hello brave new world.";

test("project search opens cross-file matches and respects case", async () => {
  await withEditor(async ({ page, base }) => {
    const projects = await (await page.request.get(`${base}/v1/projects`)).json();
    const id = projects.defaultProjectId;
    await page.request.put(`${base}/v1/files?project=${id}&path=chapters/search.tex`, { data: "First line\nUnique Search Target\nunique search target", headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => globalThis.__paperE2E?.state.view);
    await page.locator("#editor-search").click();
    await page.locator("#search-query").fill("Unique Search Target");
    await page.locator("#search-form button").click();
    await page.waitForFunction(() => document.querySelector("#search-status")?.textContent === "2 matches");
    await page.locator("#search-case").check();
    await page.locator("#search-form button").click();
    await page.waitForFunction(() => document.querySelector("#search-status")?.textContent === "1 matches");
    await page.screenshot({ path: "/tmp/latexcoder-project-search.png" });
    await page.locator(".search-result").click();
    await page.waitForFunction(() => {
      const view = globalThis.__paperE2E.state.view;
      return view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to) === "Unique Search Target";
    });
    assert.equal(await page.locator("#active-file-label").textContent(), "chapters/search.tex");
  });
});

const realLatexmk = ["/Library/TeX/texbin/latexmk", "/usr/bin/latexmk"].find(existsSync);
test("real SyncTeX PDF double-click opens included source and rejects stale source", { skip: !realLatexmk }, async () => {
  await withEditor(async ({ page, base }) => {
    page.setDefaultTimeout(30000);
    const projects = await (await page.request.get(`${base}/v1/projects`)).json();
    const id = projects.defaultProjectId;
    const child = "\\cmtbg{test}{Author}Intro.\\cmted{\nHidden comment\n}\nUnique source navigation sentence.\n";
    for (const [file, source] of [["main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}"], ["chapters/intro.tex", child]]) {
      await page.request.put(`${base}/v1/files?project=${id}&path=${encodeURIComponent(file)}`, { data: source, headers: { "Content-Type": "text/plain" } });
    }
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => globalThis.__paperE2E?.state.view);
    await page.locator("#compile-button").click();
    await page.locator("#pdf-document canvas").waitFor();
    const point = await page.evaluate(async () => {
      const pdf = globalThis.__paperE2E.state.pdfDocument;
      const page = await pdf.getPage(1);
      const item = (await page.getTextContent()).items.find(item => "str" in item && item.str.includes("Unique source"));
      if (!item || !("transform" in item)) throw new Error("PDF text not rendered");
      const viewport = page.getViewport({ scale: 1 });
      const [x, y] = viewport.convertToViewportPoint(item.transform[4] + item.width / 2, item.transform[5] + item.height / 2);
      const bounds = document.querySelector("#pdf-document canvas").getBoundingClientRect();
      return { x: bounds.left + x / viewport.width * bounds.width, y: bounds.top + y / viewport.height * bounds.height };
    });
    const sourceResponse = page.waitForResponse(response => response.url().includes("/v1/build/source"));
    await page.mouse.dblclick(point.x, point.y);
    const response = await sourceResponse;
    assert.equal(response.status(), 200, await response.text());
    await page.waitForFunction(() => document.querySelector("#active-file-label")?.textContent === "chapters/intro.tex");
    await page.waitForFunction(() => {
      const view = globalThis.__paperE2E.state.view;
      return view.state.doc.lineAt(view.state.selection.main.head).text.includes("Unique source");
    });
    await page.screenshot({ path: "/tmp/latexcoder-pdf-source.png" });
    const revision = await page.evaluate(() => globalThis.__paperE2E.state.pdfSourceRevision);
    const invalid = await page.request.post(`${base}/v1/build/source?project=${id}`, { data: { page: 1, x: -1, y: 20, revision } });
    assert.equal(invalid.status(), 400);
    const outdated = await page.request.post(`${base}/v1/build/source?project=${id}`, { data: { page: 1, x: 200, y: 130, revision: "old" } });
    assert.equal(outdated.status(), 409);
    await page.request.put(`${base}/v1/files?project=${id}&path=chapters/intro.tex`, { data: child + "Changed", headers: { "Content-Type": "text/plain" } });
    await page.mouse.dblclick(point.x, point.y);
    await page.waitForFunction(() => document.querySelector("#toast")?.textContent?.includes("source changed"));
  }, { compiler: realLatexmk });
});

test("workspace panels resize and Files can be hidden and restored", async () => {
  await withEditor(async ({ page }) => {
    await createEditor(page, LIPSUM);
    const width = async selector => (await page.locator(selector).boundingBox()).width;
    const drag = async (selector, delta) => {
      const box = await page.locator(selector).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
    };
    const files = await width("#files-pane");
    await drag("#files-resize", 60);
    assert.ok(await width("#files-pane") > files + 50);
    const output = await width("#output-pane");
    await drag("#output-resize", -60);
    assert.ok(await width("#output-pane") > output + 50);
    await page.locator("#toggle-files").click();
    assert.equal(await page.locator("#files-pane").isVisible(), false);
    assert.equal(await page.locator("#files-resize").isVisible(), false);
    await page.locator("#toggle-files").click();
    assert.equal(await page.locator("#files-pane").isVisible(), true);
    await page.screenshot({ path: "/tmp/latexcoder-resizable-desktop.png" });
    await page.reload();
    await page.waitForFunction(() => globalThis.__paperTest);
    assert.ok(await width("#files-pane") > files + 50);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("#files-resize").isVisible(), false);
    await page.locator("#toggle-files").click();
    assert.equal(await page.locator("#files-pane").evaluate(element => element.classList.contains("mobile-open")), true);
    await page.screenshot({ path: "/tmp/latexcoder-resizable-mobile.png" });
  });
});

function previewPdf() {
  const stream = "BT /F1 20 Tf 48 110 Td (Project PDF preview) Tj ET\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(source));
    source += object;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

async function createEditor(page, content) {
  await page.evaluate(async text => {
    const view = globalThis.__paperTest.createEditor(text, true);
    const deadline = Date.now() + 3000;
    while (view.state.doc.toString() !== text) {
      if (Date.now() > deadline) throw new Error("editor did not sync initial content");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }, content);
}

function setCursor(page, position) {
  return page.evaluate(pos => {
    const { view } = globalThis.__paperTest.state;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
  }, position);
}

function editorState(page) {
  return page.evaluate(() => {
    const { view } = globalThis.__paperTest.state;
    return { doc: view.state.doc.toString(), head: view.state.selection.main.head };
  });
}

async function dragSelect(page, from, to) {
  const points = await page.evaluate(([start, end]) => {
    const { view } = globalThis.__paperTest.state;
    const startBox = view.coordsAtPos(start);
    const endBox = view.coordsAtPos(end);
    return {
      start: { x: startBox.left + 1, y: (startBox.top + startBox.bottom) / 2 },
      end: { x: endBox.left - 1, y: (endBox.top + endBox.bottom) / 2 },
    };
  }, [from, to]);
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 8 });
  await page.mouse.up();
}

test("mouse drag creates an inline text selection", async () => {
  await withEditor(async ({ page }) => {
    await createEditor(page, LIPSUM);
    const from = LIPSUM.indexOf("brave");
    const to = from + "brave".length;
    await dragSelect(page, from, to);
    const selection = await page.evaluate(() => {
      const { main } = globalThis.__paperTest.state.view.state.selection;
      const backgrounds = [...document.querySelectorAll(".cm-selectionBackground")];
      return {
        from: main.from,
        to: main.to,
        backgrounds: backgrounds.map(element => getComputedStyle(element).backgroundColor),
      };
    });
    assert.equal(selection.from, from);
    assert.equal(selection.to, to);
    assert.ok(selection.backgrounds.length > 0, "CodeMirror draws the selected range");
    assert.ok(selection.backgrounds.every(color => color === "rgba(63, 153, 220, 0.18)"));
  });
});

test("selection remains visible inside an inline review mark", async () => {
  await withEditor(async ({ page }) => {
    const content = "Hello \\cmtbg{c1}{Ada}brave\\cmted{Check this} world.";
    await createEditor(page, content);
    const from = content.indexOf("brave");
    const to = from + "brave".length;
    await dragSelect(page, from, to);
    const visual = await page.evaluate(() => {
      const { main } = globalThis.__paperTest.state.view.state.selection;
      const layer = document.querySelector(".cm-selectionLayer");
      const backgrounds = [...document.querySelectorAll(".cm-selectionBackground")];
      return {
        selected: main.to - main.from,
        layerZIndex: getComputedStyle(layer).zIndex,
        backgrounds: backgrounds.map(element => getComputedStyle(element).backgroundColor),
      };
    });
    assert.equal(visual.selected, "brave".length);
    assert.equal(visual.layerZIndex, "3");
    assert.ok(visual.backgrounds.length > 0);
    assert.ok(visual.backgrounds.every(color => color === "rgba(63, 153, 220, 0.18)"));
  });
});

test("comment accepts arbitrary selected LaTeX fragments", async () => {
  await withEditor(async ({ page }) => {
    const content = "Before {fragment % note\nafter";
    await createEditor(page, content);
    const from = content.indexOf("{fragment");
    const to = content.indexOf("\nafter");
    await page.evaluate(([anchor, head]) => {
      const { view } = globalThis.__paperTest.state;
      view.dispatch({ selection: { anchor, head } });
      view.focus();
    }, [from, to]);
    await page.locator("#add-comment").click();
    await page.locator("#review-text").fill("Comment on this fragment");
    await page.locator("#dialog-submit").click();

    const { doc } = await editorState(page);
    assert.match(doc, /\\cmtbg\{[^}]+\}\{[^}]+\}\{fragment % note\\cmted\{Comment on this fragment\}/);
    const highlight = page.locator(".cm-review-comment", { hasText: "{fragment % note" });
    await highlight.waitFor();
    await highlight.hover();
    const tooltip = page.locator(".cm-review-tooltip.comment");
    await tooltip.waitFor();
    assert.equal(await tooltip.getByRole("button", { name: "Open thread" }).count(), 1);
    await tooltip.getByRole("button", { name: "Reply", exact: true }).click();
    const replyForm = page.locator(".comment-reply-form");
    await replyForm.locator("textarea").fill("I added a source");
    await replyForm.getByRole("button", { name: "Reply", exact: true }).click();
    await page.locator(".comment-message", { hasText: "I added a source" }).waitFor();
    assert.equal(await page.locator(".review-item.comment .comment-message").count(), 2);
    assert.match((await editorState(page)).doc, /\\cmtrpl\{[^}]+\}\{[^}]+\}\{I added a source\}/);
    await page.locator(".review-item button", { hasText: "Resolve" }).click();
    assert.equal((await editorState(page)).doc, content);
  });
});

test("an empty inline comment can be cancelled or closed", async () => {
  await withEditor(async ({ page }) => {
    await createEditor(page, LIPSUM);
    const selectWord = () => page.evaluate(() => {
      const { view } = globalThis.__paperTest.state;
      view.dispatch({ selection: { anchor: 6, head: 11 } });
      view.focus();
    });

    await selectWord();
    await page.locator("#add-comment").click();
    await page.locator("#review-cancel").click();
    assert.equal(await page.locator("#review-dialog").isHidden(), true);

    await selectWord();
    await page.locator("#add-comment").click();
    await page.locator("#review-close").click();
    assert.equal(await page.locator("#review-dialog").isHidden(), true);

    await selectWord();
    await page.locator("#add-comment").click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#review-dialog").isHidden(), true);
    assert.equal((await editorState(page)).doc, LIPSUM);
  });
});

test("selection overlay preserves the addition highlight", async () => {
  await withEditor(async ({ page }) => {
    const content = "Hello \\addbg{r1}{Ada}brave\\added world.";
    await createEditor(page, content);
    const from = content.indexOf("brave");
    await dragSelect(page, from, from + "brave".length);
    const visual = await page.evaluate(() => {
      const insertion = document.querySelector(".cm-review-insertion");
      const selection = document.querySelector(".cm-selectionBackground");
      return {
        insertionBackground: getComputedStyle(insertion).backgroundColor,
        selectionBackground: getComputedStyle(selection).backgroundColor,
        selectionOutline: getComputedStyle(selection).boxShadow,
      };
    });
    assert.equal(visual.insertionBackground, "rgb(220, 239, 231)");
    assert.equal(visual.selectionBackground, "rgba(63, 153, 220, 0.18)");
    assert.notEqual(visual.selectionOutline, "none");
  });
});

test("selection action accepts every suggestion in the selected range", async () => {
  await withEditor(async ({ page }) => {
    const content = "A \\delbg{r1}{Ada}old\\deled\\addbg{r1}{Ada}new\\added and "
      + "\\addbg{r2}{Lin}more\\added text.";
    await createEditor(page, content);
    await page.evaluate(length => {
      const { view } = globalThis.__paperTest.state;
      view.dispatch({ selection: { anchor: 0, head: length } });
      view.focus();
    }, content.length);
    const action = page.locator("#selection-accept");
    await action.waitFor();
    assert.equal((await action.innerText()).trim(), "Accept 2 suggestions");
    await action.click();
    const { doc } = await editorState(page);
    assert.equal(doc, "A new and more text.");
    assert.equal(await page.locator("#selection-actions").isHidden(), true);
  });
});

test("real collaborative page creates and accepts an insertion suggestion", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.waitForFunction(() => document.querySelector("#git-summary")?.textContent?.startsWith("main"));
    assert.equal(await page.locator("#presence .presence-avatar").count(), 0);
    await page.locator("#suggest-edit").click();
    await page.evaluate(() => {
      const { view } = globalThis.__paperE2E.state;
      view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
      view.focus();
    });
    await page.keyboard.type(" tracked");
    await page.waitForSelector(".cm-review-insertion");

    await page.locator('[data-output="review"]').click();
    const accept = page.locator(".review-item.revision button", { hasText: "Accept" });
    await accept.waitFor();
    await accept.click();
    await page.waitForFunction(() => !document.querySelector(".cm-review-insertion"));

    await page.waitForTimeout(180);
    const source = await (await fetch(`${base}/v1/files?path=main.tex`)).text();
    assert.match(source, / tracked$/);
    assert.doesNotMatch(source, /\\(?:addbg|added)\b/);
  });
});

test("awareness shows other collaborators but not the local user", async () => {
  await withEditor(async ({ page, base, browser }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.waitForFunction(() => document.querySelector("#git-summary")?.textContent?.startsWith("main"));
    assert.equal(await page.locator("#presence .presence-avatar").count(), 0);

    const other = await browser.newPage();
    try {
      await other.goto(`${base}/?e2e=1`);
      await other.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
      await other.waitForFunction(() => document.querySelector("#git-summary")?.textContent?.startsWith("main"));
      await page.waitForFunction(() => document.querySelectorAll("#presence .presence-avatar").length === 1);
      await other.waitForFunction(() => document.querySelectorAll("#presence .presence-avatar").length === 1);
    } finally {
      await other.close();
    }
  });
});

test("real collaborative page replaces a selection and exposes review actions", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.locator("#suggest-edit").click();
    await page.evaluate(() => {
      const { view } = globalThis.__paperE2E.state;
      const source = view.state.doc.toString();
      const from = source.indexOf("shared live");
      view.dispatch({ selection: { anchor: from, head: from + "shared live".length }, scrollIntoView: true });
      view.focus();
    });
    await page.keyboard.type("collaborative");

    const insertion = page.locator(".cm-review-insertion", { hasText: "collaborative" });
    await insertion.waitFor();
    await page.locator(".cm-review-deletion", { hasText: "shared live" }).waitFor();
    await insertion.hover();
    const tooltipAccept = page.locator(".cm-review-tooltip-actions button", { hasText: "Accept" });
    await tooltipAccept.waitFor();

    await page.locator('[data-output="review"]').click();
    const panelAccept = page.locator(".review-item.revision button", { hasText: "Accept" });
    await panelAccept.waitFor();
    await panelAccept.click();
    await page.waitForFunction(() => !document.querySelector(".cm-review-insertion"));

    await page.waitForTimeout(180);
    const source = await (await fetch(`${base}/v1/files?path=main.tex`)).text();
    assert.match(source, /This document is collaborative\./);
    assert.doesNotMatch(source, /\\(?:addbg|added|delbg|deled)\b/);
  });
});

test("image and project PDF files render interactive previews", async () => {
  await withEditor(async ({ page, base }) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#236b59"/><circle cx="160" cy="90" r="45" fill="#ffffff"/></svg>';
    assert.equal((await page.request.put(`${base}/v1/files?path=diagram.svg`, {
      data: svg,
      headers: { "Content-Type": "image/svg+xml" },
    })).status(), 201);
    assert.equal((await page.request.put(`${base}/v1/files?path=reference.pdf`, {
      data: previewPdf(),
      headers: { "Content-Type": "application/pdf" },
    })).status(), 201);

    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.locator(".file-row", { hasText: "diagram.svg" }).click();
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>("#image-preview");
      return image && !image.hidden && image.naturalWidth === 320;
    });
    assert.equal(await page.locator("#binary-kind").textContent(), "Image preview");
    assert.equal(await page.locator("#binary-status").textContent(), "320 × 180");
    assert.equal(await page.locator("#review-actions").isHidden(), true);
    const initialWidth = (await page.locator("#image-preview").boundingBox())!.width;
    await page.locator("#file-preview-zoom-in").click();
    assert.ok((await page.locator("#image-preview").boundingBox())!.width > initialWidth);

    await page.locator(".file-row", { hasText: "reference.pdf" }).click();
    await page.locator("#file-pdf-document canvas").waitFor();
    assert.equal(await page.locator("#binary-kind").textContent(), "PDF preview");
    assert.equal(await page.locator("#binary-status").textContent(), "1 page");
    const rendered = await page.locator("#file-pdf-document canvas").evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = false;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 0 && (pixels[index] < 240 || pixels[index + 1] < 240 || pixels[index + 2] < 240)) {
          ink = true;
          break;
        }
      }
      return { width: canvas.width, height: canvas.height, ink };
    });
    assert.ok(rendered.width > 100 && rendered.height > 100);
    assert.equal(rendered.ink, true);
    assert.match(await page.locator("#binary-download").getAttribute("href"), /path=reference\.pdf/);
  });
});

test("project reviews span files, folders default closed, and files download", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    const content = String.raw`\cmtbg{same}{Ada}claim\cmted{Other file comment} \addbg{s1}{Ada}new text\added`;
    await page.request.put(`${base}/v1/files?project=${id}&path=chapters/other.tex`, { data: content, headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => globalThis.__paperE2E?.state.provider?.synced);
    const folder = page.locator('.file-folder[data-path="chapters"]');
    assert.equal(await folder.getAttribute("open"), null);
    assert.equal(await page.locator('.file-row[title="chapters/other.tex"]').isVisible(), false);
    await folder.locator(":scope > summary").click();
    const row = page.locator(".file-item", { has: page.locator('.file-row[title="chapters/other.tex"]') });
    await row.locator("summary").click();
    const downloading = page.waitForEvent("download");
    await row.getByRole("button", { name: "Download", exact: true }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "other.tex");
    await page.locator('[data-output="review"]').click();
    const comment = page.locator('.review-item.comment[data-file-path="chapters/other.tex"]');
    const suggestion = page.locator('.review-item.revision[data-file-path="chapters/other.tex"]');
    await comment.waitFor();
    await suggestion.getByRole("button", { name: "Accept", exact: true }).click();
    await suggestion.waitFor({ state: "detached" });
    await comment.getByRole("button", { name: "Reply", exact: true }).click();
    await comment.locator("textarea").fill("Reply from project review");
    await comment.locator("form").getByRole("button", { name: "Reply", exact: true }).click();
    await comment.getByText("Reply from project review", { exact: true }).waitFor();
    await comment.getByRole("button", { name: "Resolve", exact: true }).click();
    await comment.waitFor({ state: "detached" });
    assert.equal(await page.locator("#active-file-label").textContent(), "chapters/other.tex");
  });
});

for (const platform of ["MacIntel", "Linux x86_64"]) {
test(`${platform} modifier-click follows includes, citations, and label references`, async () => {
  await withEditor(async ({ page, base }) => {
    await page.addInitScript(value => Object.defineProperty(navigator, "platform", { value }), platform);
    const modifier = platform === "MacIntel" ? "Meta" : "Control";
    const projects = await (await page.request.get(`${base}/v1/projects`)).json();
    const id = projects.defaultProjectId;
    const source = String.raw`\include{chapters/intro}
\cite{smith} \citep[see]{smith} \citet{smith}
\ref{sec:intro} \autoref{sec:intro} \cref{sec:intro}`;
    for (const [path, body] of [["main.tex", source], ["chapters/intro.tex", String.raw`\section{Intro}\label{sec:intro}`], ["refs.bib", "@article{smith, title={Title}}"]]) {
      await page.request.put(`${base}/v1/files?project=${id}&path=${encodeURIComponent(path)}`, { data: body, headers: { "Content-Type": "text/plain" } });
    }
    for (const macro of ["include", "cite", "citep", "citet", "ref", "autoref", "cref"]) {
      await page.goto(`${base}/projects/${id}?e2e=1`);
      await page.waitForFunction(() => globalThis.__paperE2E?.state.view?.state.doc.toString().includes("\\include"));
      const point = await page.evaluate(command => {
        const view = globalThis.__paperE2E.state.view;
        const text = view.state.doc.toString();
        const pos = text.indexOf("{", text.indexOf("\\" + command)) + 2;
        const coords = view.coordsAtPos(pos);
        return { x: coords.left + 1, y: (coords.top + coords.bottom) / 2 };
      }, macro);
      await page.keyboard.down(modifier === "Meta" ? "Control" : "Meta");
      assert.equal(await page.locator(".cm-reference-link").count(), 0);
      await page.keyboard.up(modifier === "Meta" ? "Control" : "Meta");
      await page.keyboard.down(modifier);
      await page.locator(".cm-reference-link").first().waitFor();
      assert.equal(await page.locator(".cm-reference-link").first().evaluate(element => getComputedStyle(element).textDecorationLine), "underline");
      await page.mouse.click(point.x, point.y);
      await page.keyboard.up(modifier);
      assert.equal(await page.locator(".cm-reference-link").count(), 0);
      const target = macro.startsWith("cite") ? "refs.bib" : "chapters/intro.tex";
      await page.waitForFunction(path => document.querySelector("#active-file-label")?.textContent === path, target);
      if (macro !== "include") await page.waitForFunction(() => !globalThis.__paperE2E.state.view.state.selection.main.empty);
    }
  });
});
}

test("sidebar folders expand, collapse, and create nested files", async () => {
  await withEditor(async ({ page, base }) => {
    await page.locator("#new-file").click();
    await page.locator("#action-input").fill("chapters/intro/section.tex");
    await page.locator("#action-submit").click();
    await page.waitForFunction(() => document.querySelector("#active-file-label")?.textContent === "chapters/intro/section.tex");
    const folder = page.locator('.file-folder[data-path="chapters"]');
    const nested = page.locator('.file-folder[data-path="chapters/intro"]');
    const file = page.locator('.file-row[title="chapters/intro/section.tex"]');
    assert.equal(await file.locator("span").textContent(), "section.tex");
    await folder.locator(":scope > summary").click();
    assert.equal(await file.isVisible(), false);
    await folder.locator(":scope > summary").click();
    assert.equal(await file.isVisible(), true);
    await nested.getByRole("button", { name: "New file in chapters/intro", exact: true }).click();
    assert.equal(await page.locator("#action-input").inputValue(), "chapters/intro/chapter.tex");
    await page.locator("#action-submit").click();
    await page.waitForFunction(() => document.querySelector("#active-file-label")?.textContent === "chapters/intro/chapter.tex");
    assert.equal(await page.locator('.file-row[title="chapters/intro/chapter.tex"]').isVisible(), true);
  });
});

test("new project and file upload accept ZIP archives", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/projects`);
    await page.locator("#new-project").click();
    await page.locator("#action-input").fill("ZIP project");
    await page.locator("#project-zip-input").setInputFiles({ name: "paper.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync({ "paper/main.tex": strToU8("Imported paper") })) });
    await page.locator("#action-submit").click();
    await page.waitForFunction(() => document.querySelector("#project-name")?.textContent === "ZIP project");
    await page.locator(".cm-content").getByText("Imported paper", { exact: true }).waitFor();
    await page.locator("#upload-input").setInputFiles({ name: "files.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync({ "notes.txt": strToU8("ZIP notes") })) });
    await page.locator(".file-item", { hasText: "notes.txt" }).waitFor();
    assert.equal(await page.locator(".file-item", { hasText: "files.zip" }).count(), 0);
  });
});

test("project page exposes sharing while destructive actions stay in menus", async () => {
  await withEditor(async ({ page, base }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(`${base}/projects`);
    await page.locator("#projects-page").waitFor();
    assert.equal(await page.locator("#new-project").isVisible(), true);
    assert.equal(await page.locator("#delete-project").count(), 0);

    await page.locator("#new-project").click();
    await page.locator("#action-input").fill("Cancelled Project");
    await page.keyboard.press("Escape");
    await page.locator("#action-dialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".project-row", { hasText: "Cancelled Project" }).count(), 0);

    await page.locator("#new-project").click();
    await page.locator("#action-dialog").waitFor();
    assert.equal(await page.locator("#action-title").textContent(), "New project");
    await page.locator("#action-input").fill("Compact Project");
    await page.locator("#action-submit").click();
    await page.waitForFunction(() => document.querySelector("#project-name")?.textContent === "Compact Project");
    await page.waitForURL(/\/projects\/[A-Za-z0-9_-]{12}$/);
    const projectId = new URL(page.url()).pathname.split("/").at(-1)!;
    assert.match(projectId, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(await page.locator("#files-pane > .pane-header details").count(), 0);
    assert.equal(await page.locator(".file-item").count(), await page.locator(".file-actions").count());
    assert.equal(await page.locator("#files-pane > .pane-header #download-project").count(), 1);
    assert.equal(await page.locator(".topbar #download-project").count(), 0);
    assert.equal(await page.locator("#clone-button").count(), 0);
    assert.equal(await page.locator("#share-project + #git-button").count(), 1);
    assert.equal((await page.locator("#share-project").textContent())?.trim(), "Collaborate");
    assert.equal(await page.locator(".topbar #compile-button").count(), 0);
    assert.equal(await page.locator(".output-header #compile-button + .segmented").count(), 1);
    assert.equal((await page.locator("#compile-button").textContent())?.trim(), "Compile");
    assert.ok((await page.locator("#compile-button").boundingBox())!.width >= 108);

    await page.locator("#share-project").click();
    await page.locator("#access-dialog").waitFor();
    assert.equal(await page.locator("#access-dialog header strong").textContent(), "Collaborate");
    assert.match(await page.locator("#browser-editing-description").textContent(), /Guests can edit the project without creating an account/);
    assert.doesNotMatch(await page.locator("#browser-editing-description").textContent(), /temporary/i);
    assert.match(await page.locator("#share-link").inputValue(), new RegExp(`^${base}/share/${projectId}/[A-Za-z0-9_-]+$`));
    assert.match(await page.locator("#agent-command").inputValue(), new RegExp(`^curl -fsSL '${base}/agent/${projectId}/[A-Za-z0-9_-]+'$`));
    assert.equal(await page.locator("#agent-editing-section label").textContent(), "Agent editing");
    assert.match(await page.locator("#agent-editing-section p").textContent(), /ask the agent to run it/);
    assert.doesNotMatch(await page.locator("#agent-editing-section p").textContent(), /Yjs/i);
    assert.match(await page.locator("#clone-command").inputValue(), new RegExp(`^git clone ${base}/git/${projectId}/[A-Za-z0-9_-]+$`));
    assert.equal(await page.locator("#clone-section label").textContent(), "Git clone and push");
    assert.match(await page.locator("#rotate-secret-warning").textContent(), /Other registered collaborators and their links keep working/);
    assert.match(await page.locator("#collaborator-list").textContent(), /test-userowner/);
    const previousShareLink = await page.locator("#share-link").inputValue();
    await page.locator("#rotate-share-secret").click();
    assert.equal(await page.locator("#action-title").textContent(), "Rotate access secret?");
    assert.match(await page.locator("#action-message").textContent(), /Other registered collaborators and their links keep working/);
    await page.locator("#action-submit").click();
    await page.locator("#access-dialog").waitFor();
    assert.notEqual(await page.locator("#share-link").inputValue(), previousShareLink);
    assert.equal((await page.request.get(previousShareLink, { maxRedirects: 0 })).status(), 403);
    await page.locator("#access-close").click();

    await page.locator("#new-file").click();
    await page.locator("#action-input").fill("delete-me.tex");
    await page.locator("#action-submit").click();
    await page.waitForFunction(() => document.querySelector("#active-file-label")?.textContent === "delete-me.tex"
      && document.querySelector("#sync-state")?.textContent === "Saved live");
    const fileRow = page.locator(".file-item", { hasText: "delete-me.tex" });
    await fileRow.locator("summary").click();
    await fileRow.getByText("Delete file").click();
    await page.locator("#action-submit").click();
    await page.waitForFunction(() => ![...document.querySelectorAll(".file-row")].some(row => row.textContent.includes("delete-me.tex")));
    await page.locator("#toast", { hasText: "File deleted." }).waitFor();

    await page.locator("#git-button").click();
    await page.waitForFunction(() => document.querySelector("#git-summary")?.textContent?.startsWith("main"));
    assert.match(await page.locator("#git-summary").textContent(), /^main · clean/);
    assert.equal(await page.locator("#git-ref").count(), 0);
    assert.equal(await page.locator("#git-sync").count(), 0);
    assert.equal(await page.locator("#git-history").getByText("Initial project").count(), 1);
    await page.locator("#git-close").click();

    await page.locator("#back-projects").click();
    const row = page.locator(".project-row", { hasText: "Compact Project" });
    await row.locator("summary").click();
    await row.getByText("Delete project").click();
    await page.locator("#action-dialog").waitFor();
    assert.equal(await page.locator("#action-submit").textContent(), "Delete project");
    await page.locator("#action-submit").click();
    await page.waitForFunction(() => ![...document.querySelectorAll(".project-row")].some(item => item.textContent.includes("Compact Project")));
    await page.locator("#toast", { hasText: "Project deleted." }).waitFor();
  });
});

test("login, invitations, and capability links separate members from guests", async () => {
  await withEditor(async ({ page, base, browser }) => {
    await page.goto(`${base}/`);
    await page.locator("#auth-page").waitFor();
    await page.locator("#auth-username").fill("admin");
    await page.locator("#auth-password").fill("browser admin password");
    await page.locator("#auth-submit").click();
    await page.locator("#projects-page").waitFor();
    assert.equal(await page.locator("#current-user").textContent(), "admin");
    assert.equal(await page.locator("#new-project").isVisible(), true);
    await page.locator("#account-button").click();
    await page.locator("#account-dialog").waitFor();
    assert.equal(await page.locator("#account-username").inputValue(), "admin");
    await page.locator("#account-display-name").fill("Lead Editor");
    await page.locator("#account-save").click();
    await page.locator("#account-dialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#current-user").textContent(), "Lead Editor");

    await page.locator("#invite-user").click();
    await page.locator("#invite-dialog").waitFor();
    const invitationLink = await page.locator("#invite-link").inputValue();
    assert.match(invitationLink, new RegExp(`^${base}/register/[A-Za-z0-9_-]+$`));
    await page.locator("#invite-close").click();

    await page.locator(".project-row-main button").first().click();
    assert.equal(await page.locator("#guest-name-field").isHidden(), true);
    assert.equal(await page.locator("#editor-account-button").isVisible(), true);
    assert.equal(await page.locator("#editor-account-name").textContent(), "Lead Editor");
    await page.locator("#share-project").click();
    await page.locator("#access-dialog").waitFor();
    const shareLink = await page.locator("#share-link").inputValue();
    const projectId = new URL(shareLink).pathname.split("/")[2];
    assert.match(projectId, /^[A-Za-z0-9_-]{12}$/);

    const guest = await browser.newPage();
    await guest.goto(shareLink);
    await guest.waitForURL(`${base}/projects/${projectId}`);
    await guest.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    assert.equal(await guest.locator("#back-projects").isHidden(), true);
    assert.equal(await guest.locator("#editor-login").isVisible(), true);
    assert.equal(await guest.evaluate(() => fetch("/v1/projects").then(response => response.status)), 401);

    const uninvited = await browser.newPage();
    await uninvited.goto(`${base}/projects/${projectId}`);
    await uninvited.locator("#auth-page").waitFor();
    assert.equal(await uninvited.locator("#auth-title").textContent(), "Sign in");

    const invited = await browser.newPage();
    await invited.goto(invitationLink);
    await invited.locator("#auth-page").waitFor();
    assert.equal(await invited.locator("#auth-title").textContent(), "Join the team");
    await invited.locator("#auth-username").fill("browser.member");
    await invited.locator("#auth-password").fill("browser member password");
    await invited.locator("#auth-submit").click();
    await invited.locator("#projects-page").waitFor();
    assert.equal(await invited.locator("#current-user").textContent(), "browser.member");
    assert.equal(await invited.locator("#new-project").isVisible(), true);
    assert.equal(await invited.locator(".project-row").count(), 0);

    await invited.goto(shareLink);
    await invited.waitForURL(`${base}/projects/${projectId}`);
    await invited.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    assert.equal(await invited.locator("#back-projects").isVisible(), true);
    assert.equal(await invited.locator("#share-project").isVisible(), true);
    await invited.locator("#share-project").click();
    await invited.locator("#access-dialog").waitFor();
    assert.notEqual(await invited.locator("#share-link").inputValue(), shareLink);
    assert.match(await invited.locator("#collaborator-list").textContent(), /adminowner/);
    assert.match(await invited.locator("#collaborator-list").textContent(), /browser\.membercollaborator/);
    await invited.locator("#access-close").click();
    await invited.locator("#git-button").click();
    await invited.locator("#git-dialog").waitFor();
    assert.equal(await invited.locator("#clone-button").count(), 0);
  }, { authDisabled: false, adminPassword: "browser admin password" });
});

test("suggesting keeps the caret before a Backspace deletion", async () => {
  await withEditor(async ({ page }) => {
    await createEditor(page, LIPSUM);
    // Caret after "brave" so Backspace removes the trailing "e".
    const caret = LIPSUM.indexOf("brave") + "brave".length;
    await setCursor(page, caret);
    await page.keyboard.press("Backspace");
    const { doc, head } = await editorState(page);
    assert.match(doc, /\\delbg\{[^}]+\}\{[^}]+\}e\\deled/);
    assert.equal(head, caret - 1, "caret moves to where the removed character started");
    assert.ok(doc.slice(head).startsWith("\\delbg"), "caret sits before the deletion marker");
  });
});

test("suggesting keeps the caret after a forward Delete", async () => {
  await withEditor(async ({ page }) => {
    await createEditor(page, LIPSUM);
    // Caret before "brave" so Delete removes the "b".
    const caret = LIPSUM.indexOf("brave");
    await setCursor(page, caret);
    await page.keyboard.press("Delete");
    const { doc, head } = await editorState(page);
    assert.match(doc, /\\delbg\{[^}]+\}\{[^}]+\}b\\deled/);
    assert.equal(head, doc.indexOf("\\deled") + "\\deled".length, "caret stays ahead of the wrapped character");
  });
});

test("suggesting wraps selection deletes and replacements", async () => {
  await withEditor(async ({ page }) => {
    await createEditor(page, LIPSUM);
    const from = LIPSUM.indexOf("brave");
    const to = from + "brave".length;
    await page.evaluate(([anchor, head]) => {
      const { view } = globalThis.__paperTest.state;
      view.dispatch({ selection: { anchor, head } });
      view.focus();
    }, [from, to]);
    await page.keyboard.press("Backspace");
    let { doc, head } = await editorState(page);
    assert.match(doc, /\\delbg\{[^}]+\}\{[^}]+\}brave\\deled/);
    assert.equal(head, doc.indexOf("\\deled") + "\\deled".length);

    await createEditor(page, LIPSUM);
    await page.evaluate(([anchor, head]) => {
      const { view } = globalThis.__paperTest.state;
      view.dispatch({ selection: { anchor, head } });
      view.focus();
    }, [from, to]);
    await page.keyboard.type("bold");
    ({ doc, head } = await editorState(page));
    assert.match(doc, /\\delbg\{[^}]+\}\{[^}]+\}brave\\deled\\addbg\{[^}]+\}\{[^}]+\}bold\\added/);
    assert.equal(head, doc.indexOf("bold\\added") + "bold".length, "caret lands after the inserted replacement");
  });
});

test("consecutive Backspace deletions stay in one review block", async () => {
  await withEditor(async ({ page }) => {
    await createEditor(page, LIPSUM);
    const caret = LIPSUM.indexOf("brave") + "brave".length;
    await setCursor(page, caret);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    const { doc, head } = await editorState(page);
    assert.match(doc, /Hello br\\delbg\{[^}]+\}\{[^}]+\}ave\\deled new world\./);
    assert.equal(head, "Hello br".length);
  });
});
