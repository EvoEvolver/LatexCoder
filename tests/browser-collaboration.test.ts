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
      await page.locator("#file-list").getByText("pushed.tex", { exact: true }).click();
      await page.waitForFunction(() => globalThis.__paperE2E.state.activeFile === "pushed.tex");
      await toggleBlame(page);
      const pushedAuthor = page.locator(".cm-blame-author", { hasText: "Test User" }).first();
      await pushedAuthor.waitFor();
      assert.match(await pushedAuthor.getAttribute("title"), /Git author: Test <test@example\.com>.*Commit [0-9a-f]{7}/);
      await toggleBlame(page);
      await page.locator("#file-list").getByText("main.tex", { exact: true }).click();
      await git(["rm", "pushed.tex"]);
      await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Remove pushed file"]);
      await git(["push", "origin", "main"]);
      await page.waitForFunction(() => !globalThis.__paperE2E.state.files.some(file => file.path === "pushed.tex"));
      assert.equal(await page.locator("#file-list").getByText("pushed.tex", { exact: true }).count(), 0);
    } finally { await rm(temporary, { recursive: true, force: true }); }
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

test("awareness hides the local user, shows collaborator details, and jumps to remote cursors", async () => {
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

      const target = await other.evaluate(() => {
        const { provider, view } = globalThis.__paperE2E.state;
        provider.awareness.setLocalStateField("user", { name: "Collaborator Full Name", username: "collab.user", color: "#2563eb", colorLight: "#2563eb33" });
        const anchor = Math.max(1, view.state.doc.length - 4);
        view.focus();
        view.dispatch({ selection: { anchor } });
        return anchor;
      });
      await page.waitForFunction(() => [...globalThis.__paperE2E.state.provider.awareness.getStates().values()].some(value => value.user?.username === "collab.user" && value.cursor?.head));

      const avatar = page.locator("#presence .presence-avatar");
      await avatar.hover();
      const tooltip = avatar.locator(".presence-tooltip");
      await tooltip.waitFor();
      assert.match((await tooltip.textContent()) || "", /Collaborator Full Name@collab\.userEditing this file/);
      await page.screenshot({ path: "/tmp/latexcoder-awareness-details.png" });
      await page.evaluate(() => {
        const view = globalThis.__paperE2E.state.view;
        view.dispatch({ selection: { anchor: 0 } });
      });
      await avatar.click();
      await page.waitForFunction(anchor => globalThis.__paperE2E.state.view.state.selection.main.head === anchor, target);

      await other.evaluate(() => {
        const { provider, view } = globalThis.__paperE2E.state;
        view.contentDOM.blur();
        provider.awareness.setLocalStateField("cursor", null);
      });
      await page.waitForFunction(() => [...globalThis.__paperE2E.state.provider.awareness.getStates().values()].some(value => value.user?.username === "collab.user" && !value.cursor));
      await avatar.click();
      await page.locator("#toast").filter({ hasText: "Collaborator Full Name is not currently editing." }).waitFor();
    } finally {
      await other.close();
    }
  });
});

test("collaborative edits show attributed ranges in blame mode", async () => {
  await withEditor(async ({ page, base }) => {
    await page.goto(`${base}/?e2e=1`);
    await page.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    await page.evaluate(() => {
      const view = globalThis.__paperE2E.state.view;
      view.dispatch({ changes: { from: 0, insert: "% blame marker\n" } });
    });
    const blame = await (await fetch(`${base}/v1/blame?path=main.tex`)).json();
    assert.ok(blame.runs.some(run => run.authorId === "test-user" && run.authorName === "Test User"));

    await toggleBlame(page);
    const author = page.locator(".cm-blame-author", { hasText: "Test User" }).first();
    await author.waitFor();
    assert.match(await author.getAttribute("title"), /^Test User · .*Uncommitted$/);
    assert.ok(await page.locator(".cm-blame-range").count() > 0);

    await page.locator("#history-menu").click();
    await page.waitForFunction(() => document.getElementById("toggle-blame")?.getAttribute("aria-pressed") === "true");
    assert.equal(await page.locator("#toggle-blame").getAttribute("aria-pressed"), "true");
    assert.equal((await page.locator("#blame-menu-state").textContent())?.trim(), "On");
    await page.locator("#toggle-blame").click();
    assert.equal(await page.locator(".cm-blame-author").count(), 0);
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

test("project page exposes sharing while destructive actions stay in menus", async () => {
  await withEditor(async ({ page, base }) => {
    await page.setViewportSize({ width: 900, height: 700 });
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
    const centeredTitle = await page.locator("#project-title").boundingBox();
    assert.equal((await page.locator("#project-title").textContent())?.trim(), "Compact Project");
    const projectTitleStyle = await page.locator("#project-name").evaluate(element => ({ fontSize: getComputedStyle(element).fontSize, fontWeight: getComputedStyle(element).fontWeight }));
    assert.deepEqual(projectTitleStyle, { fontSize: "13px", fontWeight: "600" });
    assert.ok(centeredTitle && Math.abs(centeredTitle.x + centeredTitle.width / 2 - 450) < 1, "project title must be centered on the viewport");
    assert.equal(await page.locator("#project-title #active-file-label").count(), 0);
    await page.locator("#topbar-status").evaluate(element => { element.style.width = "400px"; });
    await page.waitForFunction(() => (document.querySelector("#project-title") as HTMLElement).hidden);
    await page.locator("#topbar-status").evaluate(element => { element.style.width = ""; });
    await page.waitForFunction(() => !(document.querySelector("#project-title") as HTMLElement).hidden);
    const projectId = new URL(page.url()).pathname.split("/").at(-1)!;
    assert.match(projectId, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(await page.locator("#files-toolbar").count(), 1);
    assert.equal(await page.locator("#files-toolbar > button").evaluateAll(buttons => buttons.filter(button => getComputedStyle(button).display !== "none").length), 1);
    assert.equal(await page.locator(".file-item").count(), await page.locator(".file-actions").count());
    assert.equal(await page.locator("#files-heading, #new-file, #new-folder, #upload-file").count(), 0);
    assert.equal(await page.locator("#settings-dialog #download-project").count(), 1);
    assert.equal(await page.locator("#settings-dialog #open-trash").count(), 1);
    assert.equal(await page.locator(".topbar #download-project").count(), 0);
    assert.equal(await page.locator("#clone-button").count(), 0);
    assert.equal(await page.locator(".topbar .brand").count(), 0);
    assert.equal((await page.locator(".topbar").boundingBox())?.height, 40);
    for (const menu of ["project", "history", "account", "collaborate"]) assert.equal(await page.locator(`#${menu}-menu`).isVisible(), true);
    assert.equal(await page.locator("#collaborate-menu svg").count(), 0);
    assert.equal(await page.locator("#collaborate-menu").evaluate(element => getComputedStyle(element).color), await page.locator("#project-menu").evaluate(element => getComputedStyle(element).color));
    await page.locator("#project-menu").click();
    assert.equal(await page.locator("#menu-download-project").isVisible(), true);
    assert.equal(await page.locator("#menu-open-trash").isVisible(), true);
    await page.screenshot({ path: "/tmp/latexcoder-application-menu.png" });
    await page.locator("#history-menu").click();
    assert.equal(await page.locator("#git-button").isVisible(), true);
    assert.equal(await page.locator("#toggle-blame").isVisible(), true);
    assert.equal(await page.locator(".editor-toolbar #toggle-blame").count(), 0);
    await page.screenshot({ path: "/tmp/latexcoder-history-menu.png" });
    assert.equal(await page.locator("#menu-download-project").isVisible(), false);
    await page.locator("#project-menu").click();
    assert.equal(await page.locator("#menu-download-project").isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".topbar #compile-button").count(), 0);
    assert.equal(await page.locator(".output-header #compile-button + .segmented").count(), 1);
    assert.equal((await page.locator("#compile-button").textContent())?.trim(), "Compile");
    assert.ok((await page.locator("#compile-button").boundingBox())!.width >= 108);

    await page.locator("#collaborate-menu").click();
    for (const item of ["share-project", "collaborate-agent", "collaborate-git", "collaborate-members", "collaborate-secrets"]) {
      assert.equal(await page.locator(`#${item}`).isVisible(), true);
    }
    assert.equal(await page.locator("#collaborate-proposal").count(), 0);
    await page.screenshot({ path: "/tmp/latexcoder-collaborate-menu.png" });
    await page.locator("#share-project").click();
    await page.locator("#access-dialog").waitFor();
    assert.equal(await page.locator("#access-dialog header strong").textContent(), "Browser sharing");
    assert.match(await page.locator("#browser-editing-description").textContent(), /Guests can edit the project without creating an account/);
    assert.doesNotMatch(await page.locator("#browser-editing-description").textContent(), /temporary/i);
    const previousShareLink = await page.locator("#share-link").inputValue();
    assert.match(previousShareLink, new RegExp(`^${base}/share/${projectId}/[A-Za-z0-9_-]+$`));
    await page.locator("#share-view").click();
    const previousViewLink = await page.locator("#share-link").inputValue();
    assert.notEqual(previousViewLink, previousShareLink);
    assert.match(await page.locator("#browser-editing-description").textContent(), /cannot change the project/);
    assert.equal(await page.locator("#access-dialog #agent-command").count(), 0);
    await page.locator("#access-close").click();

    await chooseAppMenu(page, "collaborate", "#collaborate-agent");
    await page.locator("#agent-access-dialog").waitFor();
    assert.match(await page.locator("#agent-command").inputValue(), new RegExp(`^curl -fsSL '${base}/agent/${projectId}/[A-Za-z0-9_-]+'$`));
    assert.match(await page.locator("#agent-access-dialog p").textContent(), /edit the live source directly/);
    assert.doesNotMatch(await page.locator("#agent-access-dialog p").textContent(), /Yjs/i);
    await page.locator("#agent-propose").click();
    assert.match(await page.locator("#agent-command").inputValue(), new RegExp(`^curl -fsSL '${base}/agent/${projectId}/[A-Za-z0-9_-]+/propose'$`));
    assert.match(await page.locator("#agent-access-dialog p").textContent(), /forced into Review/);
    const previousProposalCommand = await page.locator("#agent-command").inputValue();
    const previousProposalLink = previousProposalCommand.slice("curl -fsSL '".length, -1);
    await page.locator("#agent-direct").click();
    assert.match(await page.locator("#agent-command").inputValue(), new RegExp(`^curl -fsSL '${base}/agent/${projectId}/[A-Za-z0-9_-]+'$`));
    await page.locator("#agent-access-close").click();

    await chooseAppMenu(page, "collaborate", "#collaborate-git");
    await page.locator("#git-access-dialog").waitFor();
    assert.match(await page.locator("#clone-command").inputValue(), new RegExp(`^git clone ${base}/git/${projectId}/[A-Za-z0-9_-]+$`));
    await page.locator("#git-access-close").click();

    await chooseAppMenu(page, "collaborate", "#collaborate-members");
    await page.locator("#collaborator-dialog").waitFor();
    assert.match(await page.locator("#collaborator-list").textContent(), /test-userOwner/);
    await page.locator("#collaborator-close").click();

    await chooseAppMenu(page, "collaborate", "#collaborate-secrets");
    await page.locator("#access-secret-dialog").waitFor();
    assert.match(await page.locator("#rotate-secret-warning").textContent(), /Other registered collaborators and their links keep working/);
    await page.screenshot({ path: "/tmp/latexcoder-agent-modes.png" });
    await page.locator("#rotate-share-secret").click();
    assert.equal(await page.locator("#action-title").textContent(), "Rotate access secrets?");
    assert.match(await page.locator("#action-message").textContent(), /Other registered collaborators and their links keep working/);
    await page.locator("#action-submit").click();
    await page.locator("#access-secret-dialog").waitFor();
    assert.equal((await page.request.get(previousShareLink, { maxRedirects: 0 })).status(), 403);
    assert.equal((await page.request.get(previousViewLink, { maxRedirects: 0 })).status(), 403);
    assert.equal((await page.request.get(previousProposalLink)).status(), 403);
    await page.locator("#access-secret-close").click();

    await openRootFileMenu(page);
    await page.locator(".tree-context-menu").getByRole("menuitem", { name: "New file", exact: true }).click();
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

    await chooseAppMenu(page, "history", "#git-button");
    await page.waitForFunction(() => document.querySelector("#git-summary")?.textContent?.startsWith("main"));
    assert.match(await page.locator("#git-summary").textContent(), /^main · clean/);
    assert.equal(await page.locator("#git-ref").count(), 0);
    assert.equal(await page.locator("#git-sync").count(), 0);
    await page.waitForFunction(() => document.querySelector("#git-history")?.textContent !== "Loading versions…");
    assert.equal(await page.locator("#git-history").getByText("Initial project").count(), 1);
    await page.locator("#git-close").click();

    await page.locator("#back-projects").click();
    const row = page.locator(".project-row", { hasText: "Compact Project" });
    await row.waitFor();
    assert.equal(await row.getAttribute("role"), "link");
    assert.equal(await row.getByRole("button", { name: "Open" }).count(), 0);
    await row.press("Enter");
    await page.waitForURL(`${base}/projects/${projectId}`);
    await page.locator("#back-projects").click();
    await row.waitFor();
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
    const loginMark = page.locator("#auth-page .brand img");
    await loginMark.waitFor();
    assert.equal(await loginMark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), true);
    assert.match(await page.locator('link[rel="icon"]').getAttribute("href"), /l-keycap(?:-[A-Za-z0-9_-]+)?\.svg$/);
    await page.locator("#auth-username").fill("admin");
    await page.locator("#auth-password").fill("browser admin password");
    await page.locator("#auth-submit").click();
    await page.locator("#projects-page").waitFor();
    const projectMark = page.locator("#projects-page .brand img");
    assert.equal(await projectMark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), true);
    await page.locator("#projects-about").click();
    await page.locator("#about-dialog").waitFor();
    assert.equal(await page.locator("#about-github").getAttribute("href"), "https://github.com/EvoEvolver/LatexCoder");
    assert.match(await page.locator("#about-dialog").textContent(), /people, coding agents, and Git/);
    await page.screenshot({ path: "/tmp/latexcoder-about.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    const aboutBounds = await page.locator("#about-dialog").boundingBox();
    assert.ok(aboutBounds && aboutBounds.x >= 0 && aboutBounds.x + aboutBounds.width <= 390, `About dialog must fit the mobile viewport: ${JSON.stringify(aboutBounds)}`);
    await page.screenshot({ path: "/tmp/latexcoder-about-mobile.png" });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator("#about-close").click();
    assert.equal(await page.locator("#current-user").textContent(), "admin");
    assert.equal(await page.locator("#new-project").isVisible(), true);
    assert.equal(await page.locator("#admin-button").isVisible(), true);
    await page.locator("#admin-button").click();
    await page.waitForURL(`${base}/admin`);
    await page.locator("#admin-table tbody tr").first().waitFor();
    assert.match(await page.locator("#admin-table").textContent(), /admin/);
    assert.match(await page.locator("#admin-total").textContent(), /users/);
    await page.locator("#admin-projects-tab").click();
    await page.waitForFunction(() => document.querySelector("#admin-total")?.textContent?.includes("projects"));
    assert.match(await page.locator("#admin-table").textContent(), /Paper/);
    await page.locator("#admin-back").click();
    await page.waitForURL(`${base}/projects`);
    await page.locator("#account-button").click();
    await page.locator("#account-dialog").waitFor();
    assert.equal(await page.locator("#account-username").inputValue(), "admin");
    await page.locator("#account-display-name").fill("Lead Editor");
    await page.locator("#account-save").click();
    await page.locator("#account-dialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#current-user").textContent(), "Lead Editor");

    await page.locator("#invite-user").click();
    await page.locator("#invite-dialog").waitFor();
    assert.equal(await page.locator("#invite-single").getAttribute("aria-checked"), "true");
    assert.equal(await page.locator("#invite-external").getAttribute("aria-checked"), "true");
    assert.match(await page.locator("#invite-description").textContent(), /one account/);
    const defaultInvitationLink = await page.locator("#invite-link").inputValue();
    await page.locator("#invite-reusable").click();
    await page.waitForFunction(previous => (document.querySelector("#invite-link") as HTMLInputElement).value !== previous, defaultInvitationLink);
    assert.equal(await page.locator("#invite-reusable").getAttribute("aria-checked"), "true");
    assert.match(await page.locator("#invite-description").textContent(), /multiple accounts/);
    const reusableInvitationLink = await page.locator("#invite-link").inputValue();
    await page.locator("#invite-internal").click();
    await page.waitForFunction(previous => (document.querySelector("#invite-link") as HTMLInputElement).value !== previous, reusableInvitationLink);
    assert.equal(await page.locator("#invite-internal").getAttribute("aria-checked"), "true");
    assert.match(await page.locator("#invite-description").textContent(), /invite other users/);
    await page.locator("#invite-external").click();
    await page.waitForFunction(() => document.querySelector("#invite-external")?.getAttribute("aria-checked") === "true");
    await page.locator("#invite-single").click();
    await page.waitForFunction(previous => (document.querySelector("#invite-link") as HTMLInputElement).value !== previous, reusableInvitationLink);
    const invitationLink = await page.locator("#invite-link").inputValue();
    assert.match(invitationLink, new RegExp(`^${base}/register/[A-Za-z0-9_-]+$`));
    await page.locator("#invite-close").click();

    await page.locator(".project-row").first().click();
    assert.equal(await page.locator("#guest-name-field").isHidden(), true);
    const editorMark = page.locator("#editor-about img[alt='LaTeX Coder']");
    assert.equal(await editorMark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), true);
    const backBounds = await page.locator("#back-projects").boundingBox();
    const markBounds = await editorMark.boundingBox();
    const projectBounds = await page.locator("#project-menu").boundingBox();
    assert.ok(backBounds && markBounds && projectBounds && backBounds.x < markBounds.x && markBounds.x < projectBounds.x);
    await page.locator("#editor-about").click();
    await page.locator("#about-dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#about-dialog").waitFor({ state: "hidden" });
    await page.locator("#account-menu").click();
    assert.equal(await page.locator("#editor-account-button").isVisible(), true);
    assert.match(await page.locator("#editor-account-button").textContent(), /Account Settings/);
    await page.keyboard.press("Escape");
    await chooseAppMenu(page, "collaborate", "#share-project");
    await page.locator("#access-dialog").waitFor();
    const shareLink = await page.locator("#share-link").inputValue();
    await page.locator("#share-view").click();
    const viewLink = await page.locator("#share-link").inputValue();
    await page.locator("#access-close").click();
    const projectId = new URL(shareLink).pathname.split("/")[2];
    assert.match(projectId, /^[A-Za-z0-9_-]{12}$/);

    const guest = await browser.newPage();
    await guest.goto(shareLink);
    await guest.waitForURL(`${base}/projects/${projectId}`);
    await guest.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    assert.equal(await guest.locator("#back-projects").isHidden(), true);
    await guest.locator("#account-menu").click();
    assert.equal(await guest.locator("#editor-login").isVisible(), true);
    await guest.keyboard.press("Escape");
    assert.equal(await guest.evaluate(() => fetch("/v1/projects").then(response => response.status)), 401);

    const viewer = await browser.newPage();
    await viewer.goto(viewLink);
    await viewer.waitForURL(`${base}/projects/${projectId}`);
    await viewer.locator(".cm-content").waitFor();
    await viewer.waitForFunction(() => document.querySelector("#sync-state")?.textContent !== "Synchronizing");
    assert.equal(await viewer.locator("#sync-state").textContent(), "Viewing live");
    assert.equal(await viewer.locator(".cm-content").getAttribute("contenteditable"), "false");
    assert.equal(await viewer.locator("#add-comment").count(), 0);
    assert.equal(await viewer.locator("#selection-actions").isHidden(), true);
    assert.equal(await viewer.locator("#suggest-edit").isHidden(), true);
    assert.equal(await viewer.locator("#collaborate-menu").isHidden(), true);
    const sourceBeforeViewerMutation = await viewer.evaluate(project => fetch(`/v1/files?project=${project}&path=main.tex`).then(response => response.text()), projectId);
    await viewer.goto(`${base}/projects/${projectId}?e2e=1`);
    await viewer.waitForFunction(() => globalThis.__paperE2E?.state?.provider?.synced);
    await viewer.evaluate(() => globalThis.__paperE2E.state.doc.getText("content").insert(0, "% blocked viewer update\n"));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await viewer.evaluate(project => fetch(`/v1/files?project=${project}&path=main.tex`).then(response => response.text()), projectId), sourceBeforeViewerMutation);
    assert.equal(await viewer.evaluate(project => fetch(`/v1/files?project=${project}&path=blocked.tex`, {
      method: "PUT", headers: { "Content-Type": "text/plain" }, body: "blocked",
    }).then(response => response.status), projectId), 403);

    const uninvited = await browser.newPage();
    await uninvited.goto(`${base}/projects/${projectId}`);
    await uninvited.locator("#auth-page").waitFor();
    assert.equal(await uninvited.locator("#auth-title").textContent(), "Sign in");

    const invited = await browser.newPage();
    await invited.goto(invitationLink);
    await invited.locator("#auth-page").waitFor();
    assert.equal(await invited.locator("#auth-title").textContent(), "Create your account");
    await invited.locator("#auth-username").fill("browser.member");
    await invited.locator("#auth-password").fill("browser member password");
    await invited.locator("#auth-submit").click();
    await invited.locator("#projects-page").waitFor();
    assert.equal(await invited.locator("#current-user").textContent(), "browser.member");
    assert.equal(await invited.locator("#new-project").isVisible(), true);
    assert.equal(await invited.locator("#invite-user").isHidden(), true);
    assert.equal(await invited.locator("#admin-button").isHidden(), true);
    assert.equal(await invited.locator(".project-row").count(), 0);

    await invited.goto(viewLink);
    await invited.locator("#share-confirm-page").waitFor();
    assert.equal(await invited.locator("#share-confirm-title").textContent(), "Add this project?");
    assert.match(await invited.locator("#share-confirm-description").textContent(), /view-only access/);
    await invited.locator("#share-confirm-cancel").click();
    await invited.waitForURL(`${base}/projects`);
    assert.equal(await invited.locator(".project-row").count(), 0);

    await invited.goto(viewLink);
    await invited.locator("#share-confirm-submit").click();
    await invited.waitForURL(`${base}/projects/${projectId}`);
    await invited.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Viewing live");

    await invited.goto(shareLink);
    await invited.locator("#share-confirm-page").waitFor();
    assert.equal(await invited.locator("#share-confirm-title").textContent(), "Upgrade project access?");
    assert.match(await invited.locator("#share-confirm-description").textContent(), /currently have view-only access/);
    assert.equal((await invited.locator("#share-confirm-submit").textContent()).trim(), "Upgrade access");
    assert.equal((await invited.locator("#share-confirm-cancel").textContent()).trim(), "Keep view access");
    await invited.locator("#share-confirm-cancel").click();
    await invited.waitForURL(`${base}/projects/${projectId}`);
    await invited.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Viewing live");

    await invited.goto(shareLink);
    await invited.locator("#share-confirm-page").waitFor();
    await invited.locator("#share-confirm-submit").click();
    await invited.waitForURL(`${base}/projects/${projectId}`);
    await invited.waitForFunction(() => document.querySelector("#sync-state")?.textContent === "Saved live");
    assert.equal(await invited.locator("#back-projects").isVisible(), true);
    assert.equal(await invited.locator("#collaborate-menu").isVisible(), true);
    await chooseAppMenu(invited, "collaborate", "#share-project");
    await invited.locator("#access-dialog").waitFor();
    assert.notEqual(await invited.locator("#share-link").inputValue(), shareLink);
    await invited.locator("#access-close").click();
    await chooseAppMenu(invited, "collaborate", "#collaborate-members");
    await invited.locator("#collaborator-dialog").waitFor();
    assert.match(await invited.locator("#collaborator-list").textContent(), /adminOwner/);
    assert.match(await invited.locator("#collaborator-list").textContent(), /browser\.memberEdit/);
    await invited.locator("#collaborator-close").click();
    await chooseAppMenu(invited, "history", "#git-button");
    await invited.locator("#git-dialog").waitFor();
    assert.equal(await invited.locator("#clone-button").count(), 0);
  }, { authDisabled: false, adminPassword: "browser admin password" });
});
