import assert from "node:assert/strict";
import test from "node:test";
import { withEditor, openRootFileMenu } from "./helpers/browser.ts";

for (const locale of [
  { code: "zh-CN", browser: "zh-Hans-CN", compile: "编译", chapter: "章节入口", root: "顶层入口:", newFile: "新建文件", settings: "项目设置" },
  { code: "ja", browser: "ja-JP", compile: "組版", chapter: "章の起点", root: "全体の起点:", newFile: "新規ファイル", settings: "プロジェクト設定" },
]) {
test(`${locale.code} language switching preserves the live editor and updates React and controller UI`, async () => {
  await withEditor(async ({ page, base }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => globalThis.__paperE2E?.state.provider?.synced);
    await page.locator("#compile-mode").selectOption("chapter");
    await page.waitForFunction(() => document.querySelector("#compile-mode")?.getAttribute("title")?.startsWith("Top-level root:"));
    const language = page.locator("#editor-page [data-language-select]");
    const view = await page.evaluateHandle(() => globalThis.__paperE2E.state.view);
    const provider = await page.evaluateHandle(() => globalThis.__paperE2E.state.provider);
    await page.evaluate(() => {
      const view = globalThis.__paperE2E.state.view;
      view.dispatch({ changes: { from: 0, insert: "% Project — user content\n" }, selection: { anchor: 8 } });
    });
    const before = await page.evaluate(() => ({ text: globalThis.__paperE2E.state.view.state.doc.toString(), selection: globalThis.__paperE2E.state.view.state.selection.toJSON() }));
    await language.selectOption(locale.code);
    await page.waitForFunction(text => document.querySelector("#compile-button")?.textContent === text, locale.compile);
    assert.equal(await page.locator("html").getAttribute("lang"), locale.code);
    assert.equal(await page.locator("#compile-mode option[value=chapter]").textContent(), locale.chapter);
    assert.ok((await page.locator("#compile-mode").getAttribute("title"))?.startsWith(locale.root));
    assert.ok(await page.evaluate(view => view === globalThis.__paperE2E.state.view, view));
    assert.ok(await page.evaluate(provider => provider === globalThis.__paperE2E.state.provider, provider));
    assert.deepEqual(await page.evaluate(() => ({ text: globalThis.__paperE2E.state.view.state.doc.toString(), selection: globalThis.__paperE2E.state.view.state.selection.toJSON() })), before);
    await openRootFileMenu(page);
    assert.ok((await page.locator(".tree-context-menu").textContent())?.includes(locale.newFile));
    await page.keyboard.press("Escape");
    await page.locator("#project-menu").click();
    assert.ok((await page.locator("#project-settings").textContent())?.includes(locale.settings));
    await page.keyboard.press("Escape");
    await language.selectOption("en");
    await page.waitForFunction(() => document.querySelector("#compile-button")?.textContent === "Compile");
    assert.equal(await page.locator("#compile-mode option[value=chapter]").textContent(), "Chapter root");
    assert.match(await page.locator("#compile-mode").getAttribute("title") || "", /^Top-level root:/);
    await page.locator("#editor .cm-content").focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    assert.ok(!(await page.evaluate(() => globalThis.__paperE2E.state.view.state.doc.toString())).includes("Project — user content"));
    await language.selectOption(locale.code);
    await page.reload();
    await page.waitForFunction(() => globalThis.__paperE2E);
    assert.equal(await language.inputValue(), locale.code);
    assert.equal(await page.locator("#compile-button").textContent(), locale.compile);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/tmp/latexcoder-i18n-${locale.code}-mobile.png` });
    await language.selectOption("en");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1280, height: 800 });
    await language.selectOption(locale.code);
    await page.screenshot({ path: `/tmp/latexcoder-i18n-${locale.code}-desktop.png` });
    assert.deepEqual(errors, []);
  });
});

test(`${locale.browser} browser language is used when no personal preference exists`, async () => {
  await withEditor(async ({ page }) => {
    assert.equal(await page.locator("html").getAttribute("lang"), locale.code);
    assert.equal(await page.locator("#compile-button").textContent(), locale.compile);
    await page.locator("#editor-page [data-language-select]").selectOption("en");
    await page.waitForFunction(() => document.documentElement.lang === "en");
    await page.locator("#editor-page [data-language-select]").selectOption("system");
    await page.waitForFunction(language => document.documentElement.lang === language, locale.code);
  }, {}, locale.code === "ja"
    ? () => Object.defineProperty(navigator, "languages", { value: ["ja-JP", "en"] })
    : () => Object.defineProperty(navigator, "languages", { value: ["zh-Hans-CN", "en"] }));
});
}

test("language switching after closing TreeWriter does not access the closed tab state", async () => {
  await withEditor(async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.locator("#open-structure").click();
    // Retain the detached tab so the regression does not depend on GC timing.
    const tab = await page.locator(".auxiliary-tab").elementHandle();
    await page.locator(".auxiliary-tab .close-tab").click();
    await page.locator("#editor-page [data-language-select]").selectOption("zh-CN");
    await page.waitForFunction(() => document.querySelector("#compile-button")?.textContent === "编译");
    assert.equal(await page.locator(".auxiliary-tab").count(), 0);
    assert.deepEqual(errors, []);
    await tab?.dispose();
  });
});

test("invitation descriptions switch language without clearing account input", async () => {
  await withEditor(async ({ page, base }) => {
    await page.route("**/v1/invitations/language-test", route => route.fulfill({
      json: { invitation: { invitedBy: "Project", userType: "external" } },
    }));
    await page.goto(`${base}/register/language-test`);
    await page.locator("#auth-description").filter({ hasText: "Invited by Project" }).waitFor();
    await page.locator("#auth-username").fill("my-account");
    await page.locator("#auth-page [data-language-select]").selectOption("zh-CN");
    await page.locator("#auth-description").filter({ hasText: "由 Project 邀请" }).waitFor();
    assert.match(await page.locator("#auth-description").textContent() || "", /此外部账户/);
    assert.equal(await page.locator("#auth-username").inputValue(), "my-account");
    await page.locator("#auth-page [data-language-select]").selectOption("en");
    await page.locator("#auth-description").filter({ hasText: "Invited by Project. This external account" }).waitFor();
  });
});

test("changing language preserves an open review reply and leaves document text untranslated", async () => {
  await withEditor(async ({ page, base }) => {
    const { defaultProjectId: id } = await (await page.request.get(`${base}/v1/projects`)).json();
    const source = "\\cmtbg{thread}{Project}Compile\\cmted{Review this claim}";
    await page.request.put(`${base}/v1/files?project=${id}&path=main.tex`, { data: source });
    await page.goto(`${base}/projects/${id}?e2e=1`);
    await page.waitForFunction(() => globalThis.__paperE2E?.state.provider?.synced);
    await page.locator("#toggle-review").click();
    await page.locator(".review-item").getByRole("button", { name: "Reply", exact: true }).click();
    await page.locator(".comment-reply-form textarea").fill("My unsent reply");
    await page.locator("#editor-page [data-language-select]").selectOption("zh-CN");
    await page.locator(".comment-reply-form").getByRole("button", { name: "回复", exact: true }).waitFor();
    assert.equal(await page.locator(".comment-reply-form textarea").inputValue(), "My unsent reply");
    assert.equal(await page.locator(".comment-reply-form textarea").getAttribute("placeholder"), "撰写回复");
    assert.equal(await page.evaluate(() => globalThis.__paperE2E.state.view.state.doc.toString()), source);
    assert.equal(await page.locator(".review-meta strong").textContent(), "Project");
    assert.equal(await page.locator(".review-quote").textContent(), "Compile");
  });
});
