import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { zipSync, strToU8 } from "fflate";
import { createPaperServer } from "../../src/server/main.ts";
import type { ServerOptions } from "../../src/server/types.ts";

export type EditorTestContext = { page: Page; base: string; browser: Browser };

// Drives the real bundled LaTeX Coder editor in headless Chromium against the real
// server, so these tests exercise the exact suggesting-mode transaction
// filter, keymap, and DOM that users hit in the browser.
export async function withEditor(run: (context: EditorTestContext) => Promise<void>, options: ServerOptions = {}): Promise<void> {
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

export const LIPSUM = "Hello brave new world.";

export async function chooseAppMenu(page: Page, menu: "project" | "history" | "account" | "collaborate", item: string): Promise<void> {
  await page.locator(`#${menu}-menu`).click();
  await page.locator(item).click();
}

export async function toggleBlame(page: Page): Promise<void> {
  await page.locator("#history-menu").click();
  await page.locator("#toggle-blame").click();
}

export async function openRootFileMenu(page: Page): Promise<void> {
  await page.locator(".tree-context-menu").waitFor({ state: "attached" });
  await page.locator("#file-list").evaluate(element => {
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.bottom - 8,
    }));
  });
  await page.locator(".tree-context-menu").waitFor();
}

export async function selectionContextMenu(page: Page, needle: string, testMode = true): Promise<void> {
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

export const realLatexmk = ["/Library/TeX/texbin/latexmk", "/usr/bin/latexmk"].find(existsSync);

export function previewPdf(pageCount = 1, width = 300, height = 160): Buffer {
  const stream = "BT /F1 20 Tf 48 110 Td (Project PDF preview) Tj ET\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R ${Array.from({ length: pageCount - 1 }, (_, index) => `${index + 6} 0 R`).join(" ")}] /Count ${pageCount} >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  for (let index = 0; index < pageCount - 1; index++) objects.push(`${index + 6} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`);
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

export async function createEditor(page: Page, content: string): Promise<void> {
  await page.evaluate(async text => {
    const view = globalThis.__paperTest.createEditor(text, true);
    const deadline = Date.now() + 3000;
    while (view.state.doc.toString() !== text) {
      if (Date.now() > deadline) throw new Error("editor did not sync initial content");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }, content);
}

export function setCursor(page: Page, position: number): Promise<void> {
  return page.evaluate(pos => {
    const { view } = globalThis.__paperTest.state;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
  }, position);
}

export function editorState(page: Page): Promise<{ doc: string; head: number }> {
  return page.evaluate(() => {
    const { view } = globalThis.__paperTest.state;
    return { doc: view.state.doc.toString(), head: view.state.selection.main.head };
  });
}

export async function dragSelect(page: Page, from: number, to: number): Promise<void> {
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
