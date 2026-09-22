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

test("selected file background covers its actions and follows file selection", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    await page.request.put(`${base}/v1/files?project=${id}&path=other.tex`, { data: "Other", headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    const main = page.locator(".file-item").filter({ has: page.locator('[title="main.tex"]') });
    const other = page.locator(".file-item").filter({ has: page.locator('[title="other.tex"]') });
    assert.ok((await main.getAttribute("class")).split(" ").includes("active"));
    assert.notEqual(await main.evaluate(row => getComputedStyle(row).backgroundColor), "rgba(0, 0, 0, 0)");
    await page.locator('[title="other.tex"]').click();
    await page.waitForFunction(() => document.querySelector("#active-file-label")?.textContent === "other.tex");
    assert.ok((await other.getAttribute("class")).split(" ").includes("active"));
    assert.equal((await main.getAttribute("class")).split(" ").includes("active"), false);
    await page.screenshot({ path: "/tmp/latexcoder-file-selection.png" });
  });
});

test("settings and project replace preview apply through the real UI", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    await page.request.put(`${base}/v1/files?project=${id}&path=other.tex`, { data: "needle needle", headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await chooseAppMenu(page, "project", "#project-settings");
    await page.locator("#settings-main").selectOption("other.tex");
    await page.locator("#settings-compiler").selectOption("latexmk");
    await page.locator("#settings-form button[type=submit]").click();
    assert.equal((await (await page.request.get(`${base}/v1/settings?project=${id}`)).json()).settings.main, "other.tex");
    await chooseAppMenu(page, "project", "#project-search-menu");
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
    const folder = page.locator('.tree-item[data-path="notes"]');
    await folder.locator('summary').click();
    await folder.getByRole("menuitem", { name: "Rename folder", exact: true }).click();
    await page.locator("#action-input").fill("renamed");
    await page.locator("#action-submit").click();
    const renamed = page.locator('.tree-item[data-path="renamed"]');
    await renamed.waitFor();
    await renamed.locator('summary').click();
    await renamed.getByRole("menuitem", { name: "Delete folder", exact: true }).click();
    await page.locator("#action-submit").click();
    await renamed.waitFor({ state: "detached" });
    await chooseAppMenu(page, "project", "#project-settings");
    await page.locator("#open-trash").click();
    await page.locator("#trash-list button").click();
    await renamed.waitFor();
    assert.equal(await (await page.request.get(`${base}/v1/files?project=${id}&path=renamed/chapter.tex`)).text(), "chapter");
    await page.screenshot({ path: "/tmp/latexcoder-trash.png" });
    await page.locator("#trash-close").click();
    await openRootFileMenu(page);
    await page.locator(".tree-context-menu").getByRole("menuitem", { name: "New folder", exact: true }).click();
    await page.locator("#action-input").fill("destination");
    await page.locator("#action-submit").click();
    const destination = page.locator('.tree-item[data-path="destination"]');
    await destination.waitFor();
    if (await renamed.locator(":scope > .tree-row").getAttribute("aria-expanded") !== "true") await renamed.locator(":scope > .tree-row").click();
    await page.locator('.file-item').filter({ has: page.locator('[title="renamed/chapter.tex"]') }).dragTo(destination.locator(":scope > .tree-row"));
    await page.waitForFunction(() => globalThis.__paperE2E.state.files.some(file => file.path === "destination/chapter.tex"));
    assert.equal(await (await page.request.get(`${base}/v1/files?project=${id}&path=destination/chapter.tex`)).text(), "chapter");
    await page.setViewportSize({ width: 390, height: 844 });
    await chooseAppMenu(page, "project", "#project-settings");
    await page.locator("#settings-dialog[open]").waitFor();
    await page.screenshot({ path: "/tmp/latexcoder-settings-mobile.png" });
  });
});

test("file tree right-click menus mirror action menus and target folders", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    assert.equal(await page.locator("#files-toolbar").count(), 1);
    assert.equal(await page.locator("#files-toolbar > button").evaluateAll(buttons => buttons.filter(button => getComputedStyle(button).display !== "none").length), 1);
    assert.equal(await page.locator("#files-menu").count(), 1);
    assert.equal(await page.locator("#files-heading, #new-file, #new-folder, #upload-file").count(), 0);

    const main = page.locator('.tree-item[data-path="main.tex"]');
    await main.locator(".tree-row").click({ button: "right" });
    const contextMenu = main.locator(".tree-menu-panel");
    await contextMenu.waitFor();
    const common = ["Search", "New file", "New folder", "Upload"];
    const fileActions = [...common, "Download", "Rename", "Delete file"];
    assert.deepEqual(await contextMenu.getByRole("menuitem").allTextContents(), fileActions);
    await contextMenu.getByRole("menuitem", { name: "Search", exact: true }).click();
    await page.locator("#search-dialog[open]").waitFor();
    await page.locator("#search-close").click();

    await main.locator("summary").click();
    assert.deepEqual(await main.locator(".tree-menu-panel").getByRole("menuitem").allTextContents(), fileActions);
    await page.keyboard.press("Escape");

    await openRootFileMenu(page);
    assert.deepEqual(await page.locator(".tree-context-menu").getByRole("menuitem").allTextContents(), common);
    await page.mouse.click(500, 300);
    await page.locator("#files-menu").click();
    assert.deepEqual(await page.locator(".tree-context-menu").getByRole("menuitem").allTextContents(), common);
    await page.locator(".tree-context-menu").getByRole("menuitem", { name: "New folder", exact: true }).click();
    await page.locator("#action-input").fill("assets");
    await page.locator("#action-submit").click();
    const folder = page.locator('.tree-item[data-path="assets"]');
    await folder.waitFor();
    await folder.locator(":scope > .tree-row").click({ button: "right" });
    const folderMenu = folder.locator(":scope > .tree-menu");
    assert.deepEqual(await folderMenu.getByRole("menuitem").allTextContents(), [...common, "Rename folder", "Delete folder"]);
    await folderMenu.getByRole("menuitem", { name: "Upload", exact: true }).click();
    await page.locator("#upload-input").setInputFiles({ name: "figure.png", mimeType: "image/png", buffer: Buffer.from("image") });
    await page.waitForFunction(() => globalThis.__paperE2E.state.files.some(file => file.path === "assets/figure.png"));
    const { defaultProjectId: projectId } = await (await page.request.get(`${base}/v1/projects`)).json();
    assert.equal((await page.request.get(`${base}/v1/files?project=${projectId}&path=assets/figure.png`)).status(), 200);
    await folder.locator(":scope > .tree-row").click({ button: "right" });
    await page.screenshot({ path: "/tmp/latexcoder-file-context-menu.png" });
  });
});

test("project reviews span files, folders default closed, and files download", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    const content = String.raw`\cmtbg{same}{Ada}claim\cmted{Other file comment} \addbg{s1}{Ada}new text\added`;
    await page.request.put(`${base}/v1/files?project=${id}&path=chapters/other.tex`, { data: content, headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => globalThis.__paperE2E?.state.provider?.synced);
    const folder = page.locator('.tree-item[data-path="chapters"]');
    assert.equal(await folder.locator(".tree-row").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator('.file-row[title="chapters/other.tex"]').isVisible(), false);
    await folder.locator(":scope > .tree-row").click();
    const row = page.locator(".file-item", { has: page.locator('.file-row[title="chapters/other.tex"]') });
    await row.locator("summary").click();
    const downloading = page.waitForEvent("download");
    await row.getByRole("menuitem", { name: "Download", exact: true }).click();
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

test("sidebar folders expand, collapse, and create nested files", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await openRootFileMenu(page);
    await page.locator(".tree-context-menu").getByRole("menuitem", { name: "New file", exact: true }).click();
    await page.locator("#action-input").fill("chapters/intro/section.tex");
    await page.locator("#action-submit").click();
    await page.waitForFunction(() => document.querySelector("#active-file-label")?.textContent === "chapters/intro/section.tex");
    const folder = page.locator('.tree-item[data-path="chapters"]');
    const nested = page.locator('.tree-item[data-path="chapters/intro"]');
    const file = page.locator('.file-row[title="chapters/intro/section.tex"]');
    assert.equal(await file.locator(".tree-name").textContent(), "section.tex");
    await folder.locator(":scope > .tree-row").click();
    assert.equal(await file.isVisible(), false);
    await folder.locator(":scope > .tree-row").click();
    assert.equal(await file.isVisible(), true);
    await nested.locator("summary").click();
    await nested.getByRole("menuitem", { name: "New file", exact: true }).click();
    assert.equal(await page.locator("#action-input").inputValue(), "chapters/intro/chapter.tex");
    await page.locator("#action-submit").click();
    await page.waitForFunction(() => document.querySelector("#active-file-label")?.textContent === "chapters/intro/chapter.tex");
    assert.equal(await page.locator('.file-row[title="chapters/intro/chapter.tex"]').isVisible(), true);
  });
});

test("Tree follows the main document and TreeWriter navigates the outline", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    const main = String.raw`\documentclass{article}
\begin{document}
\section{Overview}
\sectiontldr{The paper starts with its central question.}
\input{chapters/method}
\section{Conclusion}
\sectiontldr{The conclusion states the main result.}
\end{document}`;
    const method = String.raw`Introduction
\subsection{Method}
Details \tldr{The method combines two stages.}`;
    await page.request.put(`${base}/v1/files?project=${id}&path=main.tex`, { data: main, headers: { "Content-Type": "text/plain" } });
    await page.request.put(`${base}/v1/files?project=${id}&path=chapters/method.tex`, { data: method, headers: { "Content-Type": "text/plain" } });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    const items = page.locator("#structure-list .structure-item");
    const headings = page.locator('#structure-list .structure-item[data-structure-type="heading"]');
    const points = page.locator('#structure-list .structure-item[data-structure-type="point"]');
    await page.waitForFunction(() => document.querySelectorAll("#structure-list .structure-item").length === 6);
    assert.deepEqual(await headings.allTextContents(), ["Overview", "Method", "Conclusion"]);
    assert.deepEqual(await points.allTextContents(), ["The paper starts with its central question.", "The method combines two stages.", "The conclusion states the main result."]);
    assert.ok((await headings.nth(1).evaluate(element => parseFloat(getComputedStyle(element).paddingLeft)))
      > (await headings.nth(0).evaluate(element => parseFloat(getComputedStyle(element).paddingLeft))));

    await headings.nth(1).click();
    await page.waitForFunction(() => document.querySelector("#active-file-label")?.textContent === "chapters/method.tex"
      && globalThis.__paperE2E.state.view.state.doc.lineAt(globalThis.__paperE2E.state.view.state.selection.main.head).number === 2);

    await page.request.put(`${base}/v1/files?project=${id}&path=chapters/method.tex`, { data: `${method}\n\\subsection{Evaluation}\nEvidence. \\tldr{Evaluation confirms the gain.}`, headers: { "Content-Type": "text/plain" } });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await items.count(), 6, "Tree should not update until requested");
    await page.locator("#refresh-structure").click();
    await page.waitForFunction(() => document.querySelectorAll("#structure-list .structure-item").length === 8);
    assert.deepEqual(await headings.allTextContents(), ["Overview", "Method", "Evaluation", "Conclusion"]);
    assert.match((await points.allTextContents()).join(" "), /Evaluation confirms the gain/);

    await page.locator("#open-structure").click();
    const structureTab = page.getByRole("tab", { name: "TreeWriter", exact: true });
    await structureTab.waitFor();
    assert.equal(await structureTab.getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#structure-view").isVisible(), true);
    assert.equal(await page.locator("#editor").isVisible(), false);
    assert.equal(await page.locator("#structure-document").getByText("Paper at a glance", { exact: true }).count(), 1);
    assert.match(await page.locator("#structure-document").textContent(), /The method combines two stages/);
    await page.screenshot({ path: "/tmp/latexcoder-tldr-structure-expanded.png" });
    const mainTab = page.getByRole("tab", { name: "main.tex", exact: true });
    await mainTab.click();
    assert.equal(await page.locator("#structure-view").isVisible(), false);
    assert.equal(await structureTab.getAttribute("aria-selected"), "false");
    assert.equal(await mainTab.getAttribute("aria-selected"), "true");
    await structureTab.click();
    await page.locator(".tree-writer-node-button", { hasText: "Overview" }).first().click();
    await page.locator(".tree-writer-node-button", { hasText: "Method" }).first().click();
    await page.locator('#structure-document [data-structure-kind="paragraph"]').first().click();
    const treeEditor = page.locator(".tree-writer-editor .cm-content");
    await treeEditor.waitFor();
    assert.equal(await structureTab.getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#active-file-label").textContent(), "chapters/method.tex");
    await page.screenshot({ path: "/tmp/latexcoder-treewriter-editor.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.getElementById("files-pane")!.getBoundingClientRect().right <= 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    assert.equal(await page.locator("#output-pane").isVisible(), false);
    await page.screenshot({ path: "/tmp/latexcoder-treewriter-editor-mobile.png" });
    await page.setViewportSize({ width: 1280, height: 720 });
    await treeEditor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("Rewritten details.");
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    const rewritten = await (await page.request.get(`${base}/v1/files?project=${id}&path=chapters/method.tex`)).text();
    assert.match(rewritten, /Rewritten details\.\s*\\tldr\{The method combines two stages\.\}/);
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForFunction(() => document.querySelector(".tree-writer-editor .cm-content")?.textContent?.includes("Details"));
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await page.waitForFunction(() => document.querySelector(".tree-writer-editor .cm-content")?.textContent?.includes("Rewritten details."));
    const remote = rewritten.replace("Rewritten details.", "Remote details.");
    await page.request.put(`${base}/v1/files?project=${id}&path=chapters/method.tex`, { data: remote, headers: { "Content-Type": "text/plain" } });
    await page.waitForFunction(() => document.querySelector(".tree-writer-editor .cm-content")?.textContent?.includes("Remote details."));
    await page.getByRole("tab", { name: "method.tex", exact: true }).click();
    await page.waitForFunction(() => globalThis.__paperE2E.state.view?.state.doc.toString().includes("Remote details."));

    const before = await page.locator("#structure-pane").boundingBox();
    const handle = await page.locator("#structure-resize").boundingBox();
    assert.ok(before && handle);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y - 60, { steps: 8 });
    await page.mouse.up();
    const after = await page.locator("#structure-pane").boundingBox();
    assert.ok(after && after.height > before.height + 50);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#structure-list .structure-item").length === 8);
    const restored = await page.locator("#structure-pane").boundingBox();
    assert.ok(restored && Math.abs(restored.height - after.height) < 2);
    await page.screenshot({ path: "/tmp/latexcoder-structure-panel.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#toggle-files").click();
    await page.locator("#open-structure").click();
    assert.equal(await page.locator("#files-pane").evaluate(element => element.classList.contains("mobile-open")), false);
    assert.equal(await page.locator("#structure-view").isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.getByRole("button", { name: "Close TreeWriter", exact: true }).click();
    assert.equal(await page.locator("#structure-view").isVisible(), false);
    assert.equal(await page.getByRole("tab", { name: "TreeWriter", exact: true }).count(), 0);
    assert.equal(await page.locator("#editor").isVisible(), true);
  });
});

test("file tabs and typed file tree preserve files across switching, closing and drag moves", async () => {
  await withEditor(async ({ page, base }) => {
    await page.request.put(`${base}/v1/files?path=notes/second.tex`, { data: "Second document." });
    await page.request.put(`${base}/v1/files?path=picture.png`, { data: "image placeholder" });
    await page.goto(`${base}/?e2e=1`);
    if (await page.locator('[data-tree-path="notes"]').getAttribute("aria-expanded") !== "true") await page.locator('[data-tree-path="notes"]').click();
    await page.locator('[data-tree-path="notes/second.tex"]').click();
    await page.getByRole("tab", { name: "second.tex", exact: true }).waitFor();
    await page.getByRole("tab", { name: "main.tex", exact: true }).click();
    await page.waitForFunction(() => globalThis.__paperE2E.state.activeFile === "main.tex");
    await page.getByRole("tab", { name: "second.tex", exact: true }).click();
    await page.waitForFunction(() => globalThis.__paperE2E.state.view?.state.doc.toString() === "Second document.");
    await page.getByRole("button", { name: "Close notes/second.tex", exact: true }).click();
    await page.waitForFunction(() => globalThis.__paperE2E.state.activeFile === "main.tex");
    assert.equal(await page.getByRole("tab", { name: "second.tex", exact: true }).count(), 0);
    assert.equal((await page.request.get(`${base}/v1/files?path=notes/second.tex`)).status(), 200);
    assert.equal(await page.locator('[data-path="picture.png"] .icon-image').count(), 1);
    if (await page.locator('[data-tree-path="notes"]').getAttribute("aria-expanded") !== "true") await page.locator('[data-tree-path="notes"]').click();
    const fileListBounds = await page.locator("#file-list").boundingBox();
    assert.ok(fileListBounds);
    await page.locator('[data-path="notes/second.tex"]').dragTo(page.locator("#file-list"), { targetPosition: { x: fileListBounds.width / 2, y: fileListBounds.height - 8 } });
    await page.locator('[data-tree-path="second.tex"]').waitFor();
    assert.equal((await page.request.get(`${base}/v1/files?path=second.tex`)).status(), 200);
    assert.equal(await page.getByRole("button", { name: "Close main.tex", exact: true }).count(), 0);
    await page.screenshot({ path: "/tmp/latexcoder-file-tree-tabs-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#toggle-files").click();
    await page.waitForFunction(() => document.getElementById("files-pane")!.getBoundingClientRect().left >= -1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.screenshot({ path: "/tmp/latexcoder-file-tree-tabs-mobile.png" });
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

test("project dashboard searches titles and tags and archives per user", async () => {
  await withEditor(async ({ page, base }) => {
    const create = async (name: string) => {
      const response = await fetch(`${base}/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      assert.equal(response.status, 201);
      return (await response.json()).project;
    };
    const tagged = await create("Quantum Notes");
    await create("Biology Draft");
    await page.goto(`${base}/projects`);
    await page.locator("#projects-page").waitFor();

    const taggedRow = page.locator(".project-row", { hasText: "Quantum Notes" });
    await taggedRow.locator("summary").click();
    await taggedRow.getByRole("button", { name: "Edit tags" }).click();
    await page.locator("#action-input").fill("Research, Quantum, research");
    await page.locator("#action-submit").click();
    await page.locator(".project-row", { hasText: "Quantum Notes" }).getByRole("button", { name: "Quantum" }).waitFor();

    await page.locator("#project-search").fill("biology");
    assert.equal(await page.locator(".project-row", { hasText: "Biology Draft" }).count(), 1);
    assert.equal(await page.locator(".project-row", { hasText: "Quantum Notes" }).count(), 0);
    await page.locator("#project-search").fill("quantum");
    assert.equal(await page.locator(".project-row", { hasText: "Quantum Notes" }).count(), 1);
    await page.locator("#project-search").fill("");

    await page.locator("#project-tag-filters").getByRole("button", { name: "Research" }).click();
    assert.equal(await page.locator(".project-row", { hasText: "Quantum Notes" }).count(), 1);
    assert.equal(await page.locator(".project-row", { hasText: "Biology Draft" }).count(), 0);
    await page.locator("#project-tag-filters").getByRole("button", { name: "Research" }).click();

    const activeRow = page.locator(".project-row", { hasText: "Quantum Notes" });
    await activeRow.locator("summary").click();
    await activeRow.getByRole("button", { name: "Archive", exact: true }).click();
    await page.waitForFunction(name => ![...document.querySelectorAll(".project-row")].some(row => row.textContent?.includes(name)), "Quantum Notes");
    await page.locator("#projects-archived").click();
    await page.locator(".project-row", { hasText: "Quantum Notes" }).waitFor();
    assert.equal(await page.locator(".project-row", { hasText: "Biology Draft" }).count(), 0);

    const archivedRow = page.locator(".project-row", { hasText: "Quantum Notes" });
    await archivedRow.locator("summary").click();
    await archivedRow.getByRole("button", { name: "Unarchive" }).click();
    await page.waitForFunction(name => ![...document.querySelectorAll(".project-row")].some(row => row.textContent?.includes(name)), "Quantum Notes");
    await page.locator("#projects-active").click();
    await page.locator(".project-row", { hasText: "Quantum Notes" }).waitFor();

    const projects = await (await fetch(`${base}/v1/projects`)).json();
    assert.equal(projects.projects.find(project => project.id === tagged.id).archived, false);
  });
});
