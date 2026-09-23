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

test("appearance supports persistent Light, Dark, and System themes", async () => {
  await withEditor(async ({ page, base }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${base}/?e2e=1`);
    await page.locator("#auth-page").waitFor();
    await page.locator("#auth-username").fill("admin");
    await page.locator("#auth-password").fill("browser admin password");
    await page.locator("#auth-submit").click();
    await page.locator("#projects-page").waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "system");
    assert.equal(await page.locator("html").getAttribute("class"), null);
    assert.equal(await page.locator("#auth-theme, #projects-theme, #editor-theme").count(), 0);

    await page.locator("#account-button").click();
    await page.locator("#account-dialog").waitFor();
    await page.locator('[data-theme-option="dark"]').click();
    assert.equal(await page.locator("html").evaluate(element => element.classList.contains("dark")), true);
    assert.equal(await page.evaluate(() => localStorage.getItem("latexcoder-theme")), "dark");
    assert.equal(await page.locator("#account-dialog").isVisible(), true);
    assert.equal(await page.locator('[data-theme-option="dark"]').getAttribute("aria-checked"), "true");
    assert.equal(await page.locator('[data-theme-option="dark"]').evaluate(button => button.classList.contains("border-primary")), true);
    assert.equal(await page.locator('[data-theme-option="system"]').evaluate(button => button.classList.contains("border-primary")), false);
    await page.screenshot({ path: "/tmp/latexcoder-dark-account.png" });
    await page.locator("#account-close").click();
    await page.locator(".project-row").first().click();
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    const colors = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      editor: getComputedStyle(document.querySelector(".cm-editor")).backgroundColor,
      foreground: getComputedStyle(document.querySelector(".cm-editor")).color,
    }));
    assert.notEqual(colors.body, "rgb(255, 255, 255)");
    assert.notEqual(colors.editor, "rgb(255, 255, 255)");
    assert.notEqual(colors.editor, colors.foreground);
    await chooseAppMenu(page, "account", "#editor-account-button");
    assert.equal(await page.locator('[data-theme-option="dark"]').getAttribute("aria-checked"), "true");
    await page.locator("#account-close").click();
    await page.locator("#toggle-review").click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: "/tmp/latexcoder-dark-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.getElementById("files-pane").getBoundingClientRect().right <= 1);
    await page.screenshot({ path: "/tmp/latexcoder-dark-mobile.png" });

    await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await chooseAppMenu(page, "account", "#editor-account-button");
    await page.locator('[data-theme-option="system"]').click();
    assert.equal(await page.locator("html").evaluate(element => element.classList.contains("dark")), false);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.locator('[data-theme-option="light"]').click();
    assert.equal(await page.locator("html").evaluate(element => element.classList.contains("dark")), false);
  }, { authDisabled: false, adminPassword: "browser admin password" });
});

test("workspace panels resize, collapse from arrow handles, and switch the single workspace view", async () => {
  await withEditor(async ({ page }) => {
    await createEditor(page, LIPSUM);
    const width = async selector => (await page.locator(selector).boundingBox()).width;
    const drag = async (selector, delta) => {
      const box = await page.locator(selector).boundingBox();
      const y = box.y + 24;
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, y, { steps: 8 });
      await page.mouse.up();
    };
    const files = await width("#files-pane");
    const toolbarHeights = await page.locator("#files-toolbar, #file-tabs, .output-header").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    assert.deepEqual(toolbarHeights, [44, 44, 44]);
    const toolbarStyles = await page.locator("#files-toolbar, #file-tabs, .output-header").evaluateAll(elements => elements.map(element => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderBottomColor })));
    assert.equal(new Set(toolbarStyles.map(style => style.background)).size, 1);
    assert.equal(new Set(toolbarStyles.map(style => style.border)).size, 1);
    assert.equal(await width("#output-resize"), 8);
    const resizeStyles = await page.locator("#files-resize, #output-resize").evaluateAll(elements => elements.map(element => {
      const handle = element.querySelector("button");
      return {
        background: getComputedStyle(element).backgroundColor,
        width: element.getBoundingClientRect().width,
        handleHeight: handle ? getComputedStyle(handle).height : "",
        handleWidth: handle ? getComputedStyle(handle).width : "",
        handleBorder: handle ? getComputedStyle(handle).borderWidth : "",
      };
    }));
    assert.deepEqual(resizeStyles, [resizeStyles[0], resizeStyles[0]]);
    assert.equal(resizeStyles[0].handleBorder, "0px");
    await drag("#files-resize", 60);
    assert.ok(await width("#files-pane") > files + 50);
    const output = await width("#output-pane");
    await drag("#output-resize", -60);
    assert.ok(await width("#output-pane") > output + 50);
    const resizedOutput = await width("#output-pane");
    await drag("#output-resize", -1000);
    const widestOutput = await page.locator("#output-pane").boundingBox();
    const protectedEditor = await page.locator("#editor-pane").boundingBox();
    const protectedHandle = await page.locator("#output-resize").boundingBox();
    assert.ok(protectedEditor.width >= 360, `PDF resizing must preserve the editor minimum width: ${protectedEditor.width}`);
    assert.ok(Math.abs(protectedHandle.x - protectedEditor.x - protectedEditor.width) < 1, "PDF resize handle must remain on the editor boundary");
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("#output-resize")?.id, {
      x: protectedHandle.x + protectedHandle.width / 2,
      y: protectedHandle.y + protectedHandle.height / 2,
    }), "output-resize");
    await drag("#output-resize", widestOutput.width - resizedOutput);
    assert.ok(Math.abs(await width("#output-pane") - resizedOutput) < 1, "PDF width should remain adjustable after reaching its maximum");
    assert.equal(await page.locator("#workspace-view-switch").isVisible(), false);
    await page.locator("#toggle-files-column").click();
    assert.equal(await page.locator("#file-list").isVisible(), false);
    assert.equal(await page.locator("#files-pane").isVisible(), false);
    assert.equal(await page.locator("#files-resize").isVisible(), true);
    assert.equal(await page.locator("#toggle-files-column").getAttribute("title"), "Show files");
    const collapsedOutput = await page.locator("#output-pane").boundingBox();
    const collapsedEditor = await page.locator(".editor-pane").boundingBox();
    const workspaceBox = await page.locator("#workspace").boundingBox();
    assert.ok(collapsedOutput.width >= 320);
    assert.ok(Math.abs(collapsedOutput.width - resizedOutput) < 1, "hiding Files must preserve the chosen PDF width");
    assert.ok(Math.abs(collapsedOutput.x + collapsedOutput.width - workspaceBox.x - workspaceBox.width) < 1);
    assert.ok(collapsedOutput.x >= collapsedEditor.x + collapsedEditor.width);
    assert.ok(collapsedOutput.height > 500);
    await page.screenshot({ path: "/tmp/latexcoder-collapsed-files-pdf.png" });
    await page.reload();
    await page.waitForFunction(() => globalThis.__paperTest);
    assert.equal(await page.locator("#files-pane").isVisible(), false);
    assert.equal(await page.locator("#files-resize").isVisible(), true);
    const restoredOutput = await page.locator("#output-pane").boundingBox();
    assert.ok(Math.abs(restoredOutput.width - resizedOutput) < 1, "reload must restore the chosen PDF width");
    assert.ok(Math.abs(restoredOutput.x + restoredOutput.width - workspaceBox.x - workspaceBox.width) < 1);
    await page.locator("#toggle-files-column").click();
    assert.equal(await page.locator("#files-pane").isVisible(), true);

    await page.locator("#toggle-output-column").click();
    assert.equal(await page.locator("#output-pane").isVisible(), false);
    assert.equal(await page.locator("#output-resize").isVisible(), true);
    assert.equal(await page.locator("#toggle-output-column").getAttribute("title"), "Show PDF");
    assert.equal(await page.locator("#workspace-view-switch").isVisible(), true);
    assert.equal(await page.locator("#editor-pane").isVisible(), true);
    assert.equal((await page.locator("#open-pdf").textContent())?.trim(), "Switch to PDF");
    const switchToPdf = await page.locator("#open-pdf").boundingBox();
    await page.screenshot({ path: "/tmp/latexcoder-single-source.png" });
    await page.locator("#open-pdf").click();
    assert.equal(await page.locator("#editor-pane").isVisible(), false);
    assert.equal(await page.locator("#output-pane").isVisible(), true);
    assert.equal(await page.locator("#close-output").isVisible(), true);
    assert.equal(await page.locator("#output-view-tabs button").count(), 2);
    assert.deepEqual(await page.locator("#output-view-tabs button").allTextContents(), ["PDF", "Log "]);
    const switchToSource = await page.locator("#close-output").boundingBox();
    assert.ok(Math.abs(switchToPdf.x + switchToPdf.width - switchToSource.x - switchToSource.width) < 100, "source and PDF switch commands should occupy comparable toolbar positions");
    const singlePdf = await page.locator("#output-pane").boundingBox();
    const singleWorkspace = await page.locator("#workspace").boundingBox();
    const singleLayout = await page.locator("#output-pane").evaluate(element => ({ style: element.getAttribute("style"), computedRow: getComputedStyle(element).gridRow, workspaceRows: getComputedStyle(element.parentElement!).gridTemplateRows }));
    assert.ok(singlePdf.width > resizedOutput + 200, "single-view PDF should fill the source column");
    assert.ok(singlePdf.x > singleWorkspace.x);
    assert.ok(Math.abs(singlePdf.y - singleWorkspace.y) < 1, `single-view PDF must stay in the workspace's first row: ${JSON.stringify({ singlePdf, singleWorkspace, singleLayout })}`);
    assert.ok(Math.abs(singlePdf.height - singleWorkspace.height) < 1, `single-view PDF must fill the workspace height: ${JSON.stringify({ singlePdf, singleWorkspace })}`);
    await page.screenshot({ path: "/tmp/latexcoder-single-pdf.png" });
    await page.locator("#close-output").click();
    assert.equal(await page.locator("#editor-pane").isVisible(), true);
    assert.equal(await page.locator("#output-pane").isVisible(), false);
    await page.locator("#toggle-output-column").click();
    assert.equal(await page.locator("#output-pane").isVisible(), true);
    assert.equal(await page.locator("#workspace-view-switch").isVisible(), false);
    await page.screenshot({ path: "/tmp/latexcoder-resizable-desktop.png" });
    await page.reload();
    await page.waitForFunction(() => globalThis.__paperTest);
    assert.ok(await width("#files-pane") > files + 50);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("#files-resize").isVisible(), false);
    await page.locator("#toggle-files").click();
    assert.equal(await page.locator("#files-pane").evaluate(element => element.classList.contains("mobile-open")), true);
    await page.waitForFunction(() => document.getElementById("files-pane")!.getBoundingClientRect().x >= -1);
    assert.equal(await page.locator("#close-files").isVisible(), true);
    const mobileFiles = await page.locator("#files-pane").boundingBox();
    const mobileClose = await page.locator("#close-files").boundingBox();
    assert.ok(mobileFiles && mobileFiles.x >= -1 && mobileFiles.width >= 250, `Files drawer must be fully visible: ${JSON.stringify(mobileFiles)}`);
    assert.ok(mobileClose && mobileClose.x >= 0 && mobileClose.x < mobileFiles.width, "Files close button must be inside the viewport");
    await page.screenshot({ path: "/tmp/latexcoder-resizable-mobile.png" });
    await page.locator("#close-files").click();
    assert.equal(await page.locator("#files-pane").evaluate(element => element.classList.contains("mobile-open")), false);
    assert.equal(await page.locator("#toggle-files").getAttribute("aria-expanded"), "false");
    await page.waitForFunction(() => document.getElementById("files-pane")!.getBoundingClientRect().right <= 1);
  });
});
