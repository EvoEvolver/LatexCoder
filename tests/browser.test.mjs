import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { createPaperServer } from "../server.mjs";

// Drives the real bundled LaTeX Coder editor in headless Chromium against the real
// server, so these tests exercise the exact suggesting-mode transaction
// filter, keymap, and DOM that users hit in the browser.
async function withEditor(run) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-e2e-"));
  const paper = await createPaperServer({ stateDir });
  await new Promise((resolve, reject) => {
    paper.server.once("error", reject);
    paper.server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${paper.server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/?test=1`);
    await page.waitForFunction(() => globalThis.__paperTest);
    await run({ page, base });
    await page.close();
  } finally {
    await browser.close();
    paper.shutdown();
    paper.sockets.close();
    await new Promise(resolve => paper.server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}

const LIPSUM = "Hello brave new world.";

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
    await page.locator(".cm-review-comment", { hasText: "{fragment % note" }).waitFor();
    await page.locator('[data-output="review"]').click();
    await page.locator(".review-item button", { hasText: "Resolve" }).click();
    assert.equal((await editorState(page)).doc, content);
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
