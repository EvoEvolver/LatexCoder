import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { zipSync, strToU8 } from "fflate";
import { createPaperServer } from "../src/server/main.ts";

import { withEditor, LIPSUM, chooseAppMenu, toggleBlame, openRootFileMenu, selectionContextMenu, realLatexmk, previewPdf, createEditor, setCursor, editorState, dragSelect } from "./helpers/browser.ts";

test("PDF navigation vertically centers the destination source line", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    await page.request.put(`${base}/v1/files?project=${id}&path=main.tex`, { data: Array.from({ length: 100 }, (_, index) => `Source line ${index + 1}`).join("\n"), headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.route("**/v1/compile*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ build: { log: "Done" } }) }));
    await page.route("**/v1/build/pdf*", route => route.fulfill({ contentType: "application/pdf", body: previewPdf() }));
    await page.route("**/v1/build/source*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ path: "main.tex", line: 50 }) }));
    await page.locator("#compile-button").click();
    await page.locator("#pdf-document canvas").waitFor();
    await page.locator("#pdf-document canvas").dispatchEvent("click", { clientX: 50, clientY: 50, metaKey: true, ctrlKey: true, button: 0 });
    await page.waitForFunction(() => {
      const { view } = globalThis.__paperE2E.state;
      if (view.state.doc.lineAt(view.state.selection.main.head).number !== 50) return false;
      const coords = view.coordsAtPos(view.state.selection.main.head);
      const bounds = view.scrollDOM.getBoundingClientRect();
      return coords && Math.abs((coords.top + coords.bottom) / 2 - (bounds.top + bounds.bottom) / 2) < 20;
    });
    await page.evaluate(() => {
      const { view } = globalThis.__paperE2E.state;
      view.scrollDOM.scrollTop = 0;
    });
    const canvas = page.locator("#pdf-document canvas");
    const bounds = await canvas.boundingBox();
    await page.mouse.click(bounds.x + 50, bounds.y + 50, { button: "right" });
    await page.locator("#pdf-context-menu").waitFor();
    await page.screenshot({ path: "/tmp/latexcoder-pdf-context-menu.png" });
    const sourceResponse = page.waitForResponse(response => response.url().includes("/v1/build/source"));
    await page.locator("#pdf-go-to-source").click();
    const position = (await (await sourceResponse).request().postDataJSON());
    assert.equal(position.page, 1);
    assert.ok(position.x > 0 && position.y > 0);
    await page.waitForFunction(() => {
      const { view } = globalThis.__paperE2E.state;
      const coords = view.coordsAtPos(view.state.selection.main.head);
      const bounds = view.scrollDOM.getBoundingClientRect();
      return coords && Math.abs((coords.top + coords.bottom) / 2 - (bounds.top + bounds.bottom) / 2) < 20;
    });
    assert.equal(await page.locator("#pdf-context-menu").isVisible(), false);
  });
});

test("PDF preview fits page width or a whole page", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.route("**/v1/compile*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ build: { log: "Done" } }) }));
    await page.route("**/v1/build/pdf*", route => route.fulfill({ contentType: "application/pdf", body: previewPdf(1, 300, 600) }));
    await page.locator("#compile-button").click();
    const canvas = page.locator("#pdf-document canvas");
    await canvas.waitFor();

    await page.locator("#pdf-fit-width").click();
    await page.waitForFunction(() => globalThis.__paperE2E.state.pdfFitMode === "width" && globalThis.__paperE2E.state.pdfZoom === 1);
    await page.waitForFunction(() => {
      const view = document.querySelector<HTMLElement>("#pdf-view");
      const page = document.querySelector<HTMLCanvasElement>("#pdf-document canvas").getBoundingClientRect();
      return Math.abs(page.width - (view.clientWidth - 32)) < 2;
    });
    const widthFit = await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("#pdf-view");
      const page = document.querySelector<HTMLCanvasElement>("#pdf-document canvas").getBoundingClientRect();
      return { view: { width: view.clientWidth, height: view.clientHeight }, page: { width: page.width, height: page.height } };
    });
    assert.ok(Math.abs(widthFit.page.width - (widthFit.view.width - 32)) < 2);
    assert.equal(await page.locator("#pdf-fit-width").getAttribute("aria-pressed"), "true");

    await page.locator("#pdf-fit-page").click();
    await page.waitForFunction(() => globalThis.__paperE2E.state.pdfFitMode === "page");
    await page.waitForFunction(() => {
      const view = document.querySelector<HTMLElement>("#pdf-view");
      const page = document.querySelector<HTMLCanvasElement>("#pdf-document canvas").getBoundingClientRect();
      return page.height <= view.clientHeight - 31 && page.height > view.clientHeight - 34;
    });
    const pageFit = await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("#pdf-view");
      const page = document.querySelector<HTMLCanvasElement>("#pdf-document canvas").getBoundingClientRect();
      return { view: { width: view.clientWidth, height: view.clientHeight }, page: { width: page.width, height: page.height } };
    });
    assert.ok(pageFit.page.width <= pageFit.view.width - 31);
    assert.ok(pageFit.page.height <= pageFit.view.height - 31);
    assert.ok(pageFit.page.height > pageFit.view.height - 34);
    assert.equal(await page.locator("#pdf-fit-page").getAttribute("aria-pressed"), "true");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(previous => document.querySelector<HTMLCanvasElement>("#pdf-document canvas").getBoundingClientRect().height > previous + 100, pageFit.page.height);
    await page.screenshot({ path: "/tmp/latexcoder-pdf-fit-page.png" });
  });
});

test("mobile editor can open, compile, view, and close the PDF preview", async () => {
  await withEditor(async ({ page, base }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.route("**/v1/compile*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ build: { log: "Done" } }) }));
    await page.route("**/v1/build/pdf*", route => route.fulfill({ contentType: "application/pdf", body: previewPdf(1, 300, 600) }));

    assert.equal(await page.locator("#output-pane").isVisible(), false);
    assert.equal(await page.locator("#open-pdf").isVisible(), true);
    await page.locator("#open-pdf").click();
    assert.equal(await page.locator("#output-pane").isVisible(), true);
    assert.equal(await page.locator("#editor-pane").isVisible(), false);
    assert.equal(await page.locator("#open-pdf").getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("#compile-button").isVisible(), true);
    assert.equal(await page.locator("#close-output").isVisible(), true);
    assert.equal((await page.locator("#close-output").textContent())?.trim(), "Switch to source");
    assert.equal(await page.locator("#output-view-tabs #close-output").count(), 0);

    await page.locator("#compile-button").click();
    await page.locator("#pdf-document canvas").waitFor();
    const controls = await page.locator("#close-output").boundingBox();
    assert.ok(controls && controls.x + controls.width <= 390, "mobile PDF controls must stay within the viewport");
    await page.screenshot({ path: "/tmp/latexcoder-mobile-pdf.png" });

    await page.locator("#close-output").click();
    assert.equal(await page.locator("#output-pane").isVisible(), false);
    assert.equal(await page.locator("#open-pdf").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("#editor").isVisible(), true);
  });
});

test("source navigation loads a new PDF revision once and then reuses it", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.evaluate(() => {
      const { view } = globalThis.__paperE2E.state;
      view.dispatch({ changes: { from: view.state.doc.length, insert: " TARGET" } });
    });
    await page.route("**/v1/build/position*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ page: 2, x: 50, y: 50, revision: "navigation-revision", boxes: [{ page: 2, left: 40, top: 40, width: 60, height: 20 }] }) }));
    await page.route("**/v1/build?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ build: { log: "", stale: false, sourceRevision: "navigation-revision" } }) }));
    let downloads = 0;
    await page.route("**/v1/build/pdf*", route => {
      downloads++;
      return route.fulfill({ contentType: "application/pdf", headers: { "X-LaTeX-Coder-Source-Revision": "navigation-revision" }, body: previewPdf(2, 300, 600) });
    });
    await page.locator("#toggle-output-column").click();
    assert.equal(await page.locator("#output-pane").isVisible(), false);
    for (let attempt = 0; attempt < 2; attempt++) {
      await selectionContextMenu(page, "TARGET", false);
      await page.locator('[data-editor-action="pdf"]').click();
      await page.locator("#pdf-source-marker").waitFor();
      await page.waitForFunction(() => {
        const marker = document.querySelector("#pdf-source-marker")?.getBoundingClientRect();
        const viewport = document.querySelector("#pdf-view")?.getBoundingClientRect();
        return marker && viewport && Math.abs(marker.top + marker.height / 2 - viewport.top - viewport.height / 2) < 3;
      });
      assert.equal(await page.locator("#output-pane").isVisible(), true);
      assert.equal(await page.locator("#editor-pane").isVisible(), false);
      assert.equal(downloads, 1);
      assert.equal(await page.locator("#pdf-document canvas").count(), 2);
      if (attempt === 0) {
        await page.locator("#close-output").click();
        assert.equal(await page.locator("#editor-pane").isVisible(), true);
      }
    }
    assert.equal(await page.locator("#pdf-freshness").isHidden(), true);
    assert.equal(await page.locator("#pdf-freshness").textContent(), "");
    await page.evaluate(() => {
      const { view } = globalThis.__paperE2E.state;
      view.dispatch({ changes: { from: view.state.doc.length, insert: " STALE" } });
    });
    await page.locator("#pdf-freshness").waitFor();
    assert.equal(await page.locator("#pdf-freshness").textContent(), "PDF outdated");
    const floatingStatus = await page.evaluate(() => {
      const surface = document.querySelector("#pdf-surface").getBoundingClientRect();
      const status = document.querySelector("#pdf-freshness").getBoundingClientRect();
      return { right: surface.right - status.right, bottom: surface.bottom - status.bottom, width: status.width, height: status.height };
    });
    assert.ok(floatingStatus.right >= 8 && floatingStatus.right <= 16);
    assert.ok(floatingStatus.bottom >= 8 && floatingStatus.bottom <= 16);
    assert.ok(floatingStatus.width < 140 && floatingStatus.height < 40);
    assert.ok(await page.locator('#pdf-document canvas[data-page="2"]').evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 !== 3 && value < 200 && pixels[index - index % 4 + 3] > 0);
    }));
    await page.screenshot({ path: "/tmp/latexcoder-fast-pdf-navigation.png" });
  });
});

test("real compiler Log errors navigate to an included source file", { skip: !realLatexmk }, async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    for (const [file, source] of [
      ["main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{chapters/broken}\n\\end{document}"],
      ["chapters/broken.tex", "First line\nSecond line\n\\thisCommandDoesNotExist"],
    ]) await page.request.put(`${base}/v1/files?project=${id}&path=${file}`, { data: source, headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.locator("#compile-button").click();
    const error = page.locator("#build-errors button").filter({ hasText: "chapters/broken.tex:3" }).first();
    await error.waitFor();
    assert.equal(await error.isEnabled(), true);
    await error.click();
    await page.waitForFunction(() => {
      const { state } = globalThis.__paperE2E;
      return state.activeFile === "chapters/broken.tex" && state.view.state.doc.lineAt(state.view.state.selection.main.head).number === 3;
    });
  }, { compiler: realLatexmk });
});

for (const platform of ["MacIntel", "Linux x86_64"]) {
test(`${platform} real SyncTeX PDF modifier-click opens included source and rejects stale source`, { skip: !realLatexmk }, async () => {
  await withEditor(async ({ page, base }) => {
    await page.addInitScript(value => Object.defineProperty(navigator, "platform", { value }), platform);
    const modifier = platform === "MacIntel" ? "Meta" : "Control";
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
    let sourceRequests = 0;
    page.on("request", request => { if (request.url().includes("/v1/build/source")) sourceRequests++; });
    await page.mouse.click(point.x, point.y);
    await page.keyboard.down(modifier === "Meta" ? "Control" : "Meta");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up(modifier === "Meta" ? "Control" : "Meta");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(sourceRequests, 0);
    const sourceResponse = page.waitForResponse(response => response.url().includes("/v1/build/source"));
    const clickSource = async () => {
      // Dispatch the browser event directly: physical modifier-click behavior is
      // host-OS dependent, while the application contract is metaKey vs ctrlKey.
      await page.locator("#pdf-document canvas").dispatchEvent("click", {
        clientX: point.x, clientY: point.y, button: 0,
        metaKey: platform === "MacIntel", ctrlKey: platform !== "MacIntel",
      });
    };
    await clickSource();
    const response = await sourceResponse;
    assert.equal(response.status(), 200, await response.text());
    await page.waitForFunction(() => document.querySelector("#active-file-label")?.textContent === "chapters/intro.tex");
    await page.waitForFunction(() => {
      const view = globalThis.__paperE2E.state.view;
      return view.state.doc.lineAt(view.state.selection.main.head).text.includes("Unique source");
    });
    await page.screenshot({ path: "/tmp/latexcoder-pdf-source.png" });
    await selectionContextMenu(page, "Unique source", false);
    const beforeNavigation = await page.evaluate(() => globalThis.__paperE2E.state.pdfRenderVersion);
    let navigationDownloads = 0;
    const trackDownload = request => { if (request.url().includes("/v1/build/pdf")) navigationDownloads++; };
    page.on("request", trackDownload);
    const positionResponse = page.waitForResponse(response => response.url().includes("/v1/build/position"));
    await page.locator('[data-editor-action="pdf"]').click();
    const forward = await positionResponse;
    assert.equal(forward.status(), 200, await forward.text());
    await page.locator("#pdf-source-marker").waitFor();
    page.off("request", trackDownload);
    assert.equal(navigationDownloads, 0, "same-revision navigation must not download the PDF again");
    assert.equal(await page.evaluate(() => globalThis.__paperE2E.state.pdfRenderVersion), beforeNavigation, "same-revision navigation must not rerender the PDF");
    const boxes = (await forward.json()).boxes;
    assert.ok(boxes.length > 0 && boxes.every(box => box.width > 0 && box.height > 0));
    const width = (await page.locator("#pdf-source-marker").boundingBox()).width;
    await page.locator("#pdf-zoom-in").click();
    await page.waitForFunction(previous => document.querySelector("#pdf-source-marker")?.getBoundingClientRect().width > previous, width);
    await page.screenshot({ path: "/tmp/latexcoder-source-to-pdf.png" });
    const noteOnlyEdit = child.replace("Hidden comment", "Hidden\nupdated comment");
    await page.request.put(`${base}/v1/files?project=${id}&path=chapters/intro.tex`, { data: noteOnlyEdit, headers: { "Content-Type": "text/plain" } });
    const refreshedMapping = await page.request.post(`${base}/v1/build/position?project=${id}`, { data: { path: "chapters/intro.tex", line: 5, source: noteOnlyEdit } });
    assert.equal(refreshedMapping.status(), 200, await refreshedMapping.text());
    const revision = await page.evaluate(() => globalThis.__paperE2E.state.pdfSourceRevision);
    const invalid = await page.request.post(`${base}/v1/build/source?project=${id}`, { data: { page: 1, x: -1, y: 20, revision } });
    assert.equal(invalid.status(), 400);
    const outdated = await page.request.post(`${base}/v1/build/source?project=${id}`, { data: { page: 1, x: 200, y: 130, revision: "old" } });
    assert.equal(outdated.status(), 409);
    await page.request.put(`${base}/v1/files?project=${id}&path=chapters/intro.tex`, { data: child + "Changed", headers: { "Content-Type": "text/plain" } });
    await clickSource();
    await page.waitForFunction(() => document.querySelector("#toast")?.textContent?.includes("source changed"));
  }, { compiler: realLatexmk });
});
}

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
