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

test("Git pushes update the open browser file tree without reloading the editor", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    const projectId = await page.evaluate(() => globalThis.__paperE2E.state.projectId);
    const shareResponse = await fetch(`${base}/v1/project/share?project=${projectId}`, { method: "POST" });
    assert.equal(shareResponse.status, 200);
    const { share } = await shareResponse.json();
    const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-browser-git-"));
    const clone = path.join(temporary, "clone");
    const execute = promisify(execFile);
    const git = (args: string[]) => execute("git", args, { cwd: clone, timeout: 15_000 });
    try {
      await execute("git", ["clone", `${base}${share.clonePath}`, clone], { timeout: 15_000 });
      await page.evaluate(() => { globalThis.__gitTestView = globalThis.__paperE2E.state.view; });
      await writeFile(path.join(clone, "pushed.tex"), "Git event test\n");
      await git(["add", "pushed.tex"]);
      await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Add pushed file"]);
      await git(["push", "origin", "main"]);
      await page.waitForFunction(() => globalThis.__paperE2E.state.files.some(file => file.path === "pushed.tex"));
      assert.ok(await page.locator("#file-list").getByText("pushed.tex", { exact: true }).count());
      assert.equal(await page.evaluate(() => globalThis.__gitTestView === globalThis.__paperE2E.state.view), true);
      await git(["rm", "pushed.tex"]);
      await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Remove pushed file"]);
      await git(["push", "origin", "main"]);
      await page.waitForFunction(() => !globalThis.__paperE2E.state.files.some(file => file.path === "pushed.tex"));
      assert.equal(await page.locator("#file-list").getByText("pushed.tex", { exact: true }).count(), 0);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});

test("appearance supports persistent Light, Dark, and System themes", async () => {
  await withEditor(async ({ page, base }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "system");
    assert.equal(await page.locator("html").getAttribute("class"), null);

    await page.locator("#editor-theme").click();
    await page.locator('[data-theme-option="dark"]').click();
    assert.equal(await page.locator("html").evaluate(element => element.classList.contains("dark")), true);
    assert.equal(await page.evaluate(() => localStorage.getItem("latexcoder-theme")), "dark");
    const colors = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      editor: getComputedStyle(document.querySelector(".cm-editor")).backgroundColor,
      foreground: getComputedStyle(document.querySelector(".cm-editor")).color,
    }));
    assert.notEqual(colors.body, "rgb(255, 255, 255)");
    assert.notEqual(colors.editor, "rgb(255, 255, 255)");
    assert.notEqual(colors.editor, colors.foreground);
    await page.locator("#editor-theme").click();
    assert.equal(await page.locator('[data-theme-option="dark"]').getAttribute("aria-checked"), "true");
    await page.screenshot({ path: "/tmp/latexcoder-dark-appearance.png" });
    await page.locator("#appearance-close").click();
    await page.locator("#toggle-review").click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: "/tmp/latexcoder-dark-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.getElementById("files-pane").getBoundingClientRect().right <= 1);
    await page.screenshot({ path: "/tmp/latexcoder-dark-mobile.png" });

    await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.locator("#editor-theme").click();
    await page.locator('[data-theme-option="system"]').click();
    assert.equal(await page.locator("html").evaluate(element => element.classList.contains("dark")), false);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.locator("#editor-theme").click();
    await page.locator('[data-theme-option="light"]').click();
    assert.equal(await page.locator("html").evaluate(element => element.classList.contains("dark")), false);
  });
});

test("Review opens beside source independently of PDF and closes back to full editor width", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    await page.request.put(`${base}/v1/files?project=${id}&path=main.tex`, {
      data: "\\cmtbg{thread}{Ada}Claim\\cmted{Please clarify the argument}", headers: { "Content-Type": "text/plain" },
    });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    const width = (await page.locator("#editor").boundingBox()).width;
    assert.equal(await page.locator("#review-actions #toggle-files + #add-comment").count(), 1);
    assert.equal(await page.locator("#output-pane [data-output=review]").count(), 0);
    await page.locator("#toggle-review").click();
    await page.locator("#review-list .review-item").waitFor();
    assert.equal(await page.locator("#pdf-view").isVisible(), true);
    assert.ok((await page.locator("#editor").boundingBox()).width < width);
    const editor = await page.locator("#editor").boundingBox();
    const review = await page.locator("#review-pane").boundingBox();
    assert.ok(review.x >= editor.x + editor.width - 1);
    await page.screenshot({ path: "/tmp/latexcoder-review-sidebar-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.getElementById("files-pane").getBoundingClientRect().right <= 1);
    await page.screenshot({ path: "/tmp/latexcoder-review-sidebar-mobile.png" });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator("#close-review").click();
    assert.equal(await page.locator("#review-pane").isVisible(), false);
    assert.ok(Math.abs((await page.locator("#editor").boundingBox()).width - width) < 1);
  });
});

test("citation autocomplete displays title and authors and inserts only the key", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    await page.request.put(`${base}/v1/files?project=${id}&path=refs.bib`, {
      data: "@article{paper2026, title={A Useful Paper}, author={Doe, Jane and Smith, John}}",
      headers: { "Content-Type": "text/plain" },
    });
    await page.request.put(`${base}/v1/files?project=${id}&path=main.tex`, { data: "", headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.locator(".cm-content").click();
    await page.keyboard.type("\\citep{pap");
    const candidate = page.locator(".cm-tooltip-autocomplete li").filter({ hasText: "paper2026" });
    await candidate.waitFor();
    assert.match(await candidate.textContent(), /A Useful Paper/);
    assert.match(await candidate.textContent(), /Doe, Jane; Smith, John/);
    await page.keyboard.press("Enter");
    const source = await page.evaluate(() => globalThis.__paperE2E.state.view.state.doc.toString());
    assert.match(source, /\\citep\{paper2026/);
    assert.ok(!source.includes("A Useful Paper"));
  });
});

test("selected file background covers its actions and follows file selection", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    await page.request.put(`${base}/v1/files?project=${id}&path=other.tex`, { data: "Other", headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    const main = page.locator(".file-item").filter({ has: page.locator('[title="main.tex"]') });
    const other = page.locator(".file-item").filter({ has: page.locator('[title="other.tex"]') });
    assert.ok((await main.getAttribute("class")).split(" ").includes("bg-accent"));
    assert.notEqual(await main.evaluate(row => getComputedStyle(row).backgroundColor), "rgba(0, 0, 0, 0)");
    await page.locator('[title="other.tex"]').click();
    await page.waitForFunction(() => document.querySelector("#active-file-label")?.textContent === "other.tex");
    assert.ok((await other.getAttribute("class")).split(" ").includes("bg-accent"));
    assert.equal((await main.getAttribute("class")).split(" ").includes("bg-accent"), false);
    await page.screenshot({ path: "/tmp/latexcoder-file-selection.png" });
  });
});

test("graphics references open project previews and URL references open a safe new tab", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    const source = String.raw`\includegraphics[width=\linewidth]{figs/tool_usage.pdf}
\includegraphics{figs/tool_usage}
\url{https://example.test/a%20b?q=a,b#section}`;
    await page.request.put(`${base}/v1/files?project=${id}&path=main.tex`, { data: source, headers: { "Content-Type": "text/plain" } });
    await page.request.put(`${base}/v1/files?project=${id}&path=figs/tool_usage.pdf`, { data: previewPdf(), headers: { "Content-Type": "application/pdf" } });
    await page.context().route("https://example.test/**", route => route.fulfill({ contentType: "text/html", body: "Linked page" }));
    for (const needle of ["figs/tool_usage.pdf", "figs/tool_usage}", "https://example.test/"]) {
      await page.goto(`${base}/projects/${id}?e2e=1`);
      await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
      const point = await page.evaluate(needle => {
        const { view } = globalThis.__paperE2E.state;
        const coords = view.coordsAtPos(view.state.doc.toString().indexOf(needle) + 2);
        return { x: coords.left + 1, y: (coords.top + coords.bottom) / 2 };
      }, needle);
      const popup = needle.startsWith("https") ? page.waitForEvent("popup") : null;
      const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? "Meta" : "Control");
      await page.keyboard.down(modifier);
      await page.locator(".cm-reference-link").first().waitFor();
      await page.mouse.click(point.x, point.y);
      await page.keyboard.up(modifier);
      if (popup) {
        const linked = await popup;
        await linked.waitForLoadState();
        assert.equal(linked.url(), "https://example.test/a%20b?q=a,b#section");
        assert.equal(await linked.evaluate(() => window.opener), null);
        await linked.close();
      } else {
        await page.waitForFunction(() => document.querySelector("#active-file-label")?.textContent === "figs/tool_usage.pdf");
        await page.locator("#file-pdf-document canvas").waitFor();
      }
    }
  });
});

test("within-file references scroll the definition to the editor center", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    const lines = Array.from({ length: 100 }, (_, index) => index === 0 ? "See \\ref{middle}" : index === 49 ? "\\label{middle}" : `Line ${index + 1}`);
    await page.request.put(`${base}/v1/files?project=${id}&path=main.tex`, { data: lines.join("\n"), headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    const point = await page.evaluate(() => {
      const { view } = globalThis.__paperE2E.state;
      const coords = view.coordsAtPos(view.state.doc.toString().indexOf("middle") + 2);
      return { x: coords.left + 1, y: (coords.top + coords.bottom) / 2 };
    });
    const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? "Meta" : "Control");
    await page.keyboard.down(modifier);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up(modifier);
    await page.waitForFunction(() => {
      const { view } = globalThis.__paperE2E.state;
      if (view.state.doc.lineAt(view.state.selection.main.from).number !== 50) return false;
      const coords = view.coordsAtPos(view.state.selection.main.from);
      const bounds = view.scrollDOM.getBoundingClientRect();
      return coords && Math.abs((coords.top + coords.bottom) / 2 - (bounds.top + bounds.bottom) / 2) < 20;
    });
  });
});

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

test("source navigation loads a new PDF revision once and then reuses it", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.evaluate(() => {
      const { view } = globalThis.__paperE2E.state;
      view.dispatch({ changes: { from: view.state.doc.length, insert: " TARGET" } });
    });
    await page.route("**/v1/build/position*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ page: 2, x: 50, y: 50, revision: "navigation-revision", boxes: [{ page: 2, left: 40, top: 40, width: 60, height: 20 }] }) }));
    let downloads = 0;
    await page.route("**/v1/build/pdf*", route => {
      downloads++;
      return route.fulfill({ contentType: "application/pdf", headers: { "X-LaTeX-Coder-Source-Revision": "navigation-revision" }, body: previewPdf(2) });
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await selectionContextMenu(page, "TARGET", false);
      await page.locator('[data-editor-action="pdf"]').click();
      await page.locator("#pdf-source-marker").waitFor();
      assert.equal(downloads, 1);
      assert.equal(await page.locator("#pdf-document canvas").count(), 2);
    }
    assert.ok(await page.locator('#pdf-document canvas[data-page="2"]').evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 !== 3 && value < 200 && pixels[index - index % 4 + 3] > 0);
    }));
    await page.screenshot({ path: "/tmp/latexcoder-fast-pdf-navigation.png" });
  });
});

test("collaborative undo preserves remote edits and offline changes recover after reload", async () => {
  await withEditor(async ({ page, base, browser }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    const other = await browser.newPage();
    try {
      await other.goto(page.url());
      await other.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
      const insert = (text: string) => {
        const { view } = globalThis.__paperE2E.state;
        view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
      };
      await page.evaluate(insert, " LOCAL");
      await other.waitForFunction(() => globalThis.__paperE2E.state.view.state.doc.toString().endsWith(" LOCAL"));
      await other.evaluate(insert, " REMOTE");
      await page.waitForFunction(() => globalThis.__paperE2E.state.view.state.doc.toString().endsWith(" REMOTE"));
      await page.locator(".cm-content").click();
      await page.keyboard.press(await page.evaluate(() => /Mac/.test(navigator.platform) ? "Meta+z" : "Control+z"));
      await page.waitForFunction(() => {
        const source = globalThis.__paperE2E.state.view.state.doc.toString();
        return source.endsWith(" REMOTE") && !source.includes(" LOCAL");
      });
      await page.context().setOffline(true);
      await page.evaluate(() => globalThis.__paperE2E.state.provider.disconnect());
      await page.evaluate(insert, " RECOVERED");
      await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Offline - unsynced edits");
      await page.waitForTimeout(200);
      // Ensure the browser cache is persisted before reloading and reconnecting.
      await page.evaluate(async () => {
        const persistence = globalThis.__paperE2E.state.persistence;
        await persistence?.whenSynced;
      });
      await page.context().setOffline(false);
      await page.reload();
      await page.waitForFunction(() => globalThis.__paperE2E?.state.view?.state.doc.toString().endsWith(" RECOVERED"));
      await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
      await other.waitForFunction(() => globalThis.__paperE2E.state.view.state.doc.toString().endsWith(" RECOVERED"));
      await page.evaluate(() => {
        const { view } = globalThis.__paperE2E.state;
        view.dispatch({ changes: { from: view.state.doc.length - " RECOVERED".length, to: view.state.doc.length } });
      });
      await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
      assert.ok((await (await page.request.get(`${base}/v1/files?path=main.tex`)).text()).endsWith(" REMOTE"));
    } finally { await other.close(); }
  });
});

test("settings and project replace preview apply through the real UI", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    await page.request.put(`${base}/v1/files?project=${id}&path=other.tex`, { data: "needle needle", headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.locator("#project-settings").click();
    await page.locator("#settings-main").selectOption("other.tex");
    await page.locator("#settings-compiler").selectOption("latexmk");
    await page.locator("#settings-form button[type=submit]").click();
    assert.equal((await (await page.request.get(`${base}/v1/settings?project=${id}`)).json()).settings.main, "other.tex");
    await page.locator("#editor-search").click();
    await page.locator("#search-query").fill("needle");
    await page.locator("#replace-text").fill("replacement");
    await page.locator("#replace-scope").selectOption("project");
    await page.locator("#replace-preview").click();
    await page.locator("#replace-apply").waitFor();
    assert.match(await page.locator("#search-results").textContent(), /replacement/);
    assert.equal(await (await page.request.get(`${base}/v1/files?project=${id}&path=other.tex`)).text(), "needle needle");
    await page.screenshot({ path: "/tmp/latexcoder-replace-preview.png" });
    await page.locator("#replace-apply").click();
    await page.waitForFunction(() => document.querySelector("#search-status")?.textContent === "Replacements applied");
    assert.equal(await (await page.request.get(`${base}/v1/files?project=${id}&path=other.tex`)).text(), "replacement replacement");
  });
});

test("folder menus rename, delete and restore complete directories", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    await page.request.put(`${base}/v1/files?project=${id}&path=notes/chapter.tex`, { data: "chapter", headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => globalThis.__paperE2E?.state.view);
    const folder = page.locator('.file-folder[data-path="notes"]');
    await folder.locator('[title="Folder actions"]').click();
    await folder.getByRole("button", { name: "Rename / move folder", exact: true }).click();
    await page.locator("#action-input").fill("renamed");
    await page.locator("#action-submit").click();
    const renamed = page.locator('.file-folder[data-path="renamed"]');
    await renamed.waitFor();
    await renamed.locator('[title="Folder actions"]').click();
    await renamed.getByRole("button", { name: "Delete folder", exact: true }).click();
    await page.locator("#action-submit").click();
    await renamed.waitFor({ state: "detached" });
    await page.locator("#project-settings").click();
    await page.locator("#open-trash").click();
    await page.locator("#trash-list button").click();
    await renamed.waitFor();
    assert.equal(await (await page.request.get(`${base}/v1/files?project=${id}&path=renamed/chapter.tex`)).text(), "chapter");
    await page.screenshot({ path: "/tmp/latexcoder-trash.png" });
    await page.locator("#trash-close").click();
    await page.locator("#new-folder").click();
    await page.locator("#action-input").fill("destination");
    await page.locator("#action-submit").click();
    const destination = page.locator('.file-folder[data-path="destination"]');
    await destination.waitFor();
    await renamed.locator(":scope > summary").click();
    await page.locator('.file-item').filter({ has: page.locator('[title="renamed/chapter.tex"]') }).dragTo(destination.locator(":scope > summary"));
    await page.waitForFunction(() => globalThis.__paperE2E.state.files.some(file => file.path === "destination/chapter.tex"));
    assert.equal(await (await page.request.get(`${base}/v1/files?project=${id}&path=destination/chapter.tex`)).text(), "chapter");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#project-settings").click();
    await page.locator("#settings-dialog[open]").waitFor();
    await page.screenshot({ path: "/tmp/latexcoder-settings-mobile.png" });
  });
});

test("automatic compilation is debounced and errors navigate to source", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    let calls = 0;
    await page.route("**/v1/compile*", route => { calls++; return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: { message: "Compilation failed" } }) }); });
    await page.route("**/v1/build?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ build: { log: "main.tex:3: Undefined control sequence", stale: true } }) }));
    await page.locator("#project-settings").click();
    await page.locator("#settings-auto").check();
    await page.locator("#settings-form button[type=submit]").click();
    await page.evaluate(() => {
      const { view } = globalThis.__paperE2E.state;
      for (const text of [" A", " B", " C"]) view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
    });
    await page.locator("#build-errors button").waitFor();
    assert.equal(await page.locator('[data-output="log"]').getAttribute("class").then(value => value.includes("active")), true);
    assert.match(await page.locator("#first-fatal-error").textContent(), /First fatal errormain.tex:3 · Undefined control sequence/);
    assert.equal(await page.locator("#build-log").isVisible(), true);
    assert.equal(await page.locator("#pdf-view").isVisible(), false);
    await page.screenshot({ path: "/tmp/latexcoder-log-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/latexcoder-log-mobile.png" });
    await page.setViewportSize({ width: 1280, height: 720 });
    assert.equal(calls, 1);
    await page.locator("#build-errors button").click();
    await page.waitForFunction(() => {
      const { view } = globalThis.__paperE2E.state;
      return view.state.doc.lineAt(view.state.selection.main.head).number === 3;
    });
    await page.locator('[data-output="review"]').click();
    assert.equal(await page.locator("#build-log").isVisible(), true);
    assert.equal(await page.locator("#review-pane").isVisible(), true);
    await page.locator('[data-output="log"]').click();
    assert.equal(await page.locator("#build-log").isVisible(), true);
  });
});

test("compile button shows Compiling until completion and resets on success or failure", async () => {
  for (const status of [200, 422]) {
    await withEditor(async ({ page }) => {
      let finish: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      await page.route("**/v1/compile*", async route => {
        await pending;
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { build: { log: "Done" } } : { error: { message: "Compilation failed" } }) });
      });
      await page.route("**/v1/build/pdf*", route => route.fulfill({ contentType: "application/pdf", body: previewPdf() }));
      const button = page.locator("#compile-button");
      const width = (await button.boundingBox()).width;
      await button.click();
      await page.waitForFunction(() => document.querySelector("#compile-button span")?.textContent === "Compiling");
      assert.equal(await button.isDisabled(), true);
      assert.equal(await button.getAttribute("aria-busy"), "true");
      assert.equal((await button.boundingBox()).width, width);
      finish();
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#compile-button").disabled);
      assert.equal(await button.locator("span").textContent(), "Compile");
      assert.equal(await button.getAttribute("aria-busy"), null);
    });
  }
});

async function selectionContextMenu(page, needle, testMode = true) {
  const point = await page.evaluate(({ needle, testMode }) => {
    const view = (testMode ? globalThis.__paperTest : globalThis.__paperE2E).state.view;
    const from = view.state.doc.toString().indexOf(needle);
    view.dispatch({ selection: { anchor: from, head: from + needle.length } });
    view.focus();
    const bounds = view.coordsAtPos(from + 1);
    return { x: bounds.left + 1, y: (bounds.top + bounds.bottom) / 2 };
  }, { needle, testMode });
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.locator("#editor-context-menu").waitFor();
}

test("selected text context menu preserves selection and offers editing commands", async () => {
  await withEditor(async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await createEditor(page, LIPSUM);
    await page.evaluate(() => { globalThis.__paperTest.state.suggesting = false; });
    await selectionContextMenu(page, "brave");
    assert.equal(await page.locator(".cm-editor").getAttribute("data-context-menu"), "open");
    assert.equal(await page.locator(".cm-selectionBackground").first().evaluate(element => getComputedStyle(element).backgroundColor), "rgba(63, 153, 220, 0.18)");
    assert.equal(await page.locator(".cm-selectionLayer").evaluate(element => getComputedStyle(element).zIndex), "3");
    assert.equal(await page.locator("#editor-context-menu [role=menuitem]").count(), 9);
    await page.screenshot({ path: "/tmp/latexcoder-editor-context-menu.png" });
    await page.locator('[data-editor-action="copy"]').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "brave");
    await selectionContextMenu(page, "brave");
    await page.locator('[data-editor-action="cut"]').click();
    await page.waitForFunction(() => globalThis.__paperTest.state.view.state.doc.toString() === "Hello  new world.");
    await selectionContextMenu(page, "new");
    await page.locator('[data-editor-action="undo"]').click();
    await page.waitForFunction(() => globalThis.__paperTest.state.view.state.doc.toString() === "Hello brave new world.");
    await selectionContextMenu(page, "brave");
    await page.locator('[data-editor-action="redo"]').click();
    await page.waitForFunction(() => globalThis.__paperTest.state.view.state.doc.toString() === "Hello  new world.");
    await selectionContextMenu(page, "new");
    await page.evaluate(() => navigator.clipboard.writeText("pasted"));
    await page.locator('[data-editor-action="paste"]').click();
    await page.waitForFunction(() => globalThis.__paperTest.state.view.state.doc.toString() === "Hello  pasted world.");
    await selectionContextMenu(page, "pasted");
    await page.locator('[data-editor-action="delete"]').click();
    await page.waitForFunction(() => globalThis.__paperTest.state.view.state.doc.toString() === "Hello   world.");
    await selectionContextMenu(page, "world");
    await page.locator('[data-editor-action="select-all"]').click();
    assert.equal(await page.evaluate(() => globalThis.__paperTest.state.view.state.selection.main.to), "Hello   world.".length);
    await selectionContextMenu(page, "world");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#editor-context-menu").isVisible(), false);
    assert.equal(await page.locator(".cm-editor").getAttribute("data-context-menu"), null);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => document.querySelector("#files-pane").getBoundingClientRect().right <= 0);
    await selectionContextMenu(page, "world");
    const menu = await page.locator("#editor-context-menu").boundingBox();
    assert.ok(menu.x >= 0 && menu.x + menu.width <= 390 && menu.y + menu.height <= 844);
    await page.screenshot({ path: "/tmp/latexcoder-editor-context-mobile.png" });
  });
});

test("empty selection uses the custom context menu and pastes at the clicked caret", async () => {
  await withEditor(async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await createEditor(page, LIPSUM);
    const point = await page.evaluate(() => {
      const { view } = globalThis.__paperTest.state;
      globalThis.__paperTest.state.suggesting = false;
      view.dispatch({ selection: { anchor: 0 } });
      const coords = view.coordsAtPos(12);
      return { x: coords.left + 1, y: (coords.top + coords.bottom) / 2 };
    });
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page.locator("#editor-context-menu").waitFor();
    for (const action of ["copy", "cut", "delete", "comment"]) assert.equal(await page.locator(`[data-editor-action="${action}"]`).isDisabled(), true);
    const caret = await page.evaluate(() => globalThis.__paperTest.state.view.state.selection.main.head);
    assert.ok(caret >= 12 && caret <= 13);
    await page.evaluate(() => navigator.clipboard.writeText("INSERT "));
    await page.locator('[data-editor-action="paste"]').click();
    await page.waitForFunction(expected => globalThis.__paperTest.state.view.state.doc.toString() === expected, LIPSUM.slice(0, caret) + "INSERT " + LIPSUM.slice(caret));
  });
});

test("selection context menu adds comments and blocks overlapping comments", async () => {
  await withEditor(async ({ page }) => {
    await createEditor(page, LIPSUM);
    await selectionContextMenu(page, "brave");
    await page.locator('[data-editor-action="comment"]').click();
    assert.equal(await page.evaluate(() => globalThis.__paperTest.state.reviewSelection.selected), "brave");
    await page.locator("#review-text").fill("Context comment");
    await page.locator("#dialog-submit").click();
    await page.waitForFunction(() => globalThis.__paperTest.state.view.state.doc.toString().includes("Context comment"));
    await selectionContextMenu(page, "brave");
    assert.equal(await page.locator('[data-editor-action="comment"]').isDisabled(), true);
    assert.equal(await page.locator(".cm-selectionBackground").first().evaluate(element => getComputedStyle(element).backgroundColor), "rgba(63, 153, 220, 0.18)");
    await page.screenshot({ path: "/tmp/latexcoder-review-context-selection.png" });
  });
});

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
      // On a macOS test host, physical Ctrl-click opens the native context menu.
      if (platform !== "MacIntel") {
        await page.locator("#pdf-document canvas").dispatchEvent("click", { clientX: point.x, clientY: point.y, ctrlKey: true, button: 0 });
      } else {
        await page.keyboard.down(modifier);
        await page.mouse.click(point.x, point.y);
        await page.keyboard.up(modifier);
      }
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
    assert.equal(await page.locator("#file-list").isVisible(), false);
    assert.equal(await page.locator("#files-pane").isVisible(), false);
    assert.equal(await page.locator("#files-resize").isVisible(), false);
    const collapsedOutput = await page.locator("#output-pane").boundingBox();
    const collapsedEditor = await page.locator(".editor-pane").boundingBox();
    const workspaceBox = await page.locator("#workspace").boundingBox();
    assert.ok(collapsedOutput.width >= 320);
    assert.ok(Math.abs(collapsedOutput.x + collapsedOutput.width - workspaceBox.x - workspaceBox.width) < 1);
    assert.ok(collapsedOutput.x >= collapsedEditor.x + collapsedEditor.width);
    assert.ok(collapsedOutput.height > 500);
    await page.screenshot({ path: "/tmp/latexcoder-collapsed-files-pdf.png" });
    await page.reload();
    await page.waitForFunction(() => globalThis.__paperTest);
    assert.equal(await page.locator("#files-pane").isVisible(), false);
    const restoredOutput = await page.locator("#output-pane").boundingBox();
    assert.ok(Math.abs(restoredOutput.x + restoredOutput.width - workspaceBox.x - workspaceBox.width) < 1);
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

function previewPdf(pageCount = 1) {
  const stream = "BT /F1 20 Tf 48 110 Td (Project PDF preview) Tj ET\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R ${Array.from({ length: pageCount - 1 }, (_, index) => `${index + 6} 0 R`).join(" ")}] /Count ${pageCount} >>\nendobj\n`,
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  for (let index = 0; index < pageCount - 1; index++) objects.push(`${index + 6} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`);
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
    assert.equal(await page.locator("#files-pane > .pane-header #download-project").count(), 0);
    assert.equal(await page.locator("#files-pane > .pane-header #open-trash").count(), 0);
    assert.equal(await page.locator("#settings-dialog #download-project").count(), 1);
    assert.equal(await page.locator("#settings-dialog #open-trash").count(), 1);
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

test("version history shows agent diffs and restores files through a custom confirmation", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    const original = await fetch(`${base}/v1/files?path=main.tex`);
    const source = await original.text();
    const edited = await fetch(`${base}/v1/files/edit?path=main.tex&agentId=researcher&agentName=Research%20agent`, {
      method: "POST", headers: { "X-Base-SHA256": original.headers.get("x-content-sha256")! }, body: source + "\n% Agent checked the equation E = mc^2\n",
    });
    assert.equal(edited.status, 200);
    await page.locator("#git-button").click();
    await page.locator("#history-agents").click();
    await page.waitForFunction(() => document.querySelector("#history-diff")?.textContent?.includes("+% Agent checked"));
    assert.match(await page.locator("#history-meta").textContent(), /Research agent/);
    assert.equal(await page.locator("#git-history .version-row").count(), 1);
    await page.screenshot({ path: "/tmp/latexcoder-version-history-light.png" });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: "/tmp/latexcoder-version-history-dark.png" });
    await page.locator("#history-all").click();
    await page.locator("#git-history .version-row").last().click();
    await page.waitForFunction(() => !(document.querySelector("#history-restore") as HTMLButtonElement)?.disabled);
    await page.locator("#history-restore").click();
    await page.locator("#action-dialog[open]").waitFor();
    assert.match(await page.locator("#action-message").textContent(), /saved as a checkpoint/);
    await page.locator("#action-submit").click();
    await page.waitForFunction(() => document.querySelector("#history-title")?.textContent?.startsWith("Restore version"));
    await page.waitForFunction(() => !globalThis.__paperE2E.state.doc?.getText("content").toString().includes("Agent checked"));
    assert.equal(await (await fetch(`${base}/v1/files?path=main.tex`)).text(), source);
    assert.equal(await page.locator("#history-error").isVisible(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/latexcoder-version-history-mobile.png" });
    assert.equal(await page.locator("#git-dialog").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  });
});
