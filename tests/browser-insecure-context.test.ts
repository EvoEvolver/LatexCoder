import assert from "node:assert/strict";
import test from "node:test";
import { withEditor } from "./helpers/browser.ts";

// Reproduces a plain-HTTP LAN origin, where browsers do not expose
// crypto.randomUUID because the context is not secure. Before the fix,
// opening a source file threw "crypto.randomUUID is not a function" and the
// editor never appeared.
test("source editing works when crypto.randomUUID is unavailable (insecure origin)", async () => {
  await withEditor(async ({ page, base }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), "undefined");

    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.locator("#file-list").getByText("main.tex", { exact: true }).click();
    await page.waitForFunction(() => globalThis.__paperE2E?.state?.activeFile === "main.tex");

    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), "undefined");
    assert.equal(await page.locator("#editor").isVisible(), true);
    assert.equal(await page.evaluate(() => globalThis.__paperE2E.state.view.state.doc.length > 0), true);
    assert.deepEqual(pageErrors.filter(message => /randomUUID/i.test(message)), []);
  }, {}, () => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
  });
});
