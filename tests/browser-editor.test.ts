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

test("Review opens beside source independently of PDF and closes back to full editor width", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    await page.request.put(`${base}/v1/files?project=${id}&path=main.tex`, {
      data: "\\cmtbg{thread}{Ada}Claim\\cmted{Please clarify the argument}", headers: { "Content-Type": "text/plain" },
    });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.waitForFunction(() => document.querySelector("#review-count")?.textContent === "1");
    const width = (await page.locator("#editor").boundingBox()).width;
    assert.equal(await page.locator("#add-comment").count(), 0);
    assert.equal(await page.locator("#review-actions #toggle-files + #suggest-edit").count(), 1);
    assert.equal(await page.locator("#output-pane [data-output=review]").count(), 0);
    assert.equal((await page.locator("#toggle-review").textContent()).trim(), "1");
    assert.equal(await page.locator("#editor-search").count(), 0);
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

test("automatic compilation is debounced and errors navigate to source", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    let calls = 0;
    await page.route("**/v1/compile*", route => { calls++; return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: { message: "Compilation failed" } }) }); });
    await page.route("**/v1/build?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ build: {
      log: "LaTeX Warning: Citation `missing' undefined\n! Undefined control sequence",
      errors: [{ path: "/tmp/latexcoder-build/main.tex", line: 3, message: "Undefined control sequence" }],
      stale: true,
    } }) }));
    await chooseAppMenu(page, "project", "#project-settings");
    await page.locator("#settings-auto").check();
    await page.locator("#settings-form button[type=submit]").click();
    await page.evaluate(() => {
      const { view } = globalThis.__paperE2E.state;
      for (const text of [" A", " B", " C"]) view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
    });
    await page.locator("#first-fatal-error").waitFor();
    assert.equal(await page.locator('[data-output="log"]').getAttribute("class").then(value => value.includes("active")), true);
    assert.match(await page.locator("#first-fatal-error").textContent(), /First fatal errormain.tex:3 · Undefined control sequence/);
    assert.equal(await page.locator("#build-log").isVisible(), true);
    assert.equal(await page.locator("#pdf-view").isVisible(), false);
    assert.equal(await page.locator("#diagnostic-navigation").count(), 0);
    assert.equal(await page.locator(".cm-lineNumbers .cm-diagnostic-line.error").count(), 1);
    assert.equal(await page.locator(".cm-diagnostic-range.error").count(), 1);
    await page.screenshot({ path: "/tmp/latexcoder-log-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/latexcoder-log-mobile.png" });
    await page.setViewportSize({ width: 1280, height: 720 });
    assert.equal(calls, 1);
    await page.locator("#first-fatal-error").click();
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

test("line number context menu copies the active file path and line without changing selection", async () => {
  await withEditor(async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await createEditor(page, "first line\nsecond line\nthird line");
    const selection = await page.evaluate(() => {
      const { view } = globalThis.__paperTest.state;
      view.dispatch({ selection: { anchor: 1, head: 5 } });
      return { from: view.state.selection.main.from, to: view.state.selection.main.to };
    });
    await page.locator(".cm-lineNumbers .cm-gutterElement").filter({ hasText: /^2$/ }).click({ button: "right" });
    await page.locator("#line-context-menu").waitFor();
    assert.equal(await page.locator("#line-context-reference").textContent(), "main.tex:2");
    assert.equal(await page.locator("#editor-context-menu").isVisible(), false);
    assert.deepEqual(await page.evaluate(() => {
      const { main } = globalThis.__paperTest.state.view.state.selection;
      return { from: main.from, to: main.to };
    }), selection);
    await page.screenshot({ path: "/tmp/latexcoder-line-context-menu.png" });
    await page.locator("#copy-line-reference").click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "main.tex:2");
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
    await chooseAppMenu(page, "project", "#project-search-menu");
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

test("inline diagnostics cover citations, references, and labels without a toolbar button group", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    const files = [
      ["main.tex", "\\citep{known,missing}\n\\ref{missing-label}\n\\label{duplicate}"],
      ["chapter.tex", "Chapter\n\\label{duplicate}"],
      ["refs.bib", "@article{known,\n  title={Known reference}\n}"],
    ];
    for (const [relativePath, source] of files) await page.request.put(`${base}/v1/files?project=${id}&path=${relativePath}`, {
      data: source,
      headers: { "Content-Type": "text/plain" },
    });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.waitForFunction(() => document.querySelectorAll(".cm-lineNumbers .cm-diagnostic-line.warning").length === 3);
    assert.equal(await page.locator(".cm-lineNumbers .cm-diagnostic-line.warning").count(), 3);
    assert.equal(await page.locator(".cm-diagnostic-range.warning").count(), 3);
    await page.locator(".cm-diagnostic-range.warning").first().hover();
    await page.locator(".cm-diagnostic-tooltip").waitFor();
    assert.match(await page.locator(".cm-diagnostic-tooltip").textContent(), /Undefined citation|reference|Duplicate label/);
    await page.screenshot({ path: "/tmp/latexcoder-inline-diagnostics.png" });

    assert.equal(await page.locator("#diagnostic-navigation").count(), 0);
  });
});

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
    await page.locator("#selection-comment").click();
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
    await page.locator("#selection-comment").click();
    await page.locator("#review-cancel").click();
    assert.equal(await page.locator("#review-dialog").isHidden(), true);

    await selectWord();
    await page.locator("#selection-comment").click();
    await page.locator("#review-close").click();
    assert.equal(await page.locator("#review-dialog").isHidden(), true);

    await selectWord();
    await page.locator("#selection-comment").click();
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
    assert.equal(await page.locator("#selection-comment").isHidden(), true);
    assert.equal((await action.innerText()).trim(), "Accept 2 suggestions");
    await action.click();
    const { doc } = await editorState(page);
    assert.equal(doc, "A new and more text.");
    assert.equal(await page.locator("#selection-actions").isVisible(), true);
    assert.equal(await page.locator("#selection-comment").isVisible(), true);
    assert.equal(await action.isHidden(), true);
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
    const changedWord = source.match(/[A-Za-z]{6,}/)?.[0];
    assert.ok(changedWord);
    const editedSource = source.replace(changedWord, "HistoryReplacement")
      + `\n% Agent checked the equation E = mc^2 ${"and documented a deliberately long explanation ".repeat(12)}\n`;
    const edited = await fetch(`${base}/v1/files/edit?path=main.tex&agentId=researcher&agentName=Research%20agent`, {
      method: "POST", headers: { "X-Base-SHA256": original.headers.get("x-content-sha256")! }, body: editedSource,
    });
    assert.equal(edited.status, 200);
    await chooseAppMenu(page, "history", "#git-button");
    await page.locator("#history-agents").click();
    await page.waitForFunction(() => document.querySelector("#history-diff")?.textContent?.includes("+% Agent checked"));
    assert.equal((await page.locator(".diff-word-removed").allTextContents()).join(""), changedWord);
    assert.equal((await page.locator(".diff-word-added").allTextContents()).join(""), "HistoryReplacement");
    const longLine = page.locator(".diff-added", { hasText: "deliberately long explanation" });
    assert.ok((await longLine.boundingBox())!.height > 30, "long diff lines should wrap instead of scrolling horizontally");
    assert.equal(await page.locator("#history-diff").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
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
