import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import ssh2 from "ssh2";
import { createPaperServer } from "../src/server/app.ts";
import { chooseAppMenu, withEditor } from "./helpers/browser.ts";

test("account SSH keys and default SSH Git menu work end to end", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "latexcoder-ssh-browser-"));
  const paper = await createPaperServer({ stateDir, adminPassword: "ssh-test-password", sshPort: 0, sshHost: "127.0.0.1", sshPublicHost: "127.0.0.1", sshPublicPort: 2222 });
  await new Promise<void>(resolve => paper.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(paper.server.address() as AddressInfo).port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const login = await page.request.post(`${base}/v1/auth/login`, { data: { username: "admin", password: "ssh-test-password" } });
    assert.equal(login.status(), 200);
    const { project } = await (await page.request.post(`${base}/v1/projects`, { data: { name: "SSH browser" } })).json();
    await page.goto(`${base}/projects/${project.id}`);
    await chooseAppMenu(page, "collaborate", "#collaborate-git");
    await page.locator("#git-access-dialog").waitFor();
    assert.equal(await page.locator("#git-mode-ssh").getAttribute("aria-checked"), "true");
    assert.match(await page.locator("#clone-command").inputValue(), /^git clone ssh:\/\/git@127\.0\.0\.1:/);
    assert.match(await page.locator("#git-access-description").textContent(), /Add an SSH public key/);
    await page.locator("#git-mode-link").click();
    assert.match(await page.locator("#clone-command").inputValue(), new RegExp(`^git clone ${base}/git/`));
    await page.locator("#git-access-close").click();
    await chooseAppMenu(page, "collaborate", "#collaborate-git");
    await page.locator("#git-access-dialog").waitFor();
    assert.equal(await page.locator("#git-mode-ssh").getAttribute("aria-checked"), "true");
    await page.locator("#git-manage-keys").click();
    await page.locator("#account-dialog").waitFor();
    await page.locator("#ssh-key-title").fill("My laptop");
    await page.locator("#ssh-key-public").fill(ssh2.utils.generateKeyPairSync("ed25519").public);
    await page.locator("#ssh-key-add").click();
    await page.getByRole("button", { name: "Remove SSH key My laptop", exact: true }).waitFor();
    assert.match(await page.locator("#ssh-key-list").textContent(), /SHA256:/);
    assert.equal(await page.locator("#account-dialog").isVisible(), true, "adding a key must not submit the profile form");
    await page.screenshot({ path: "/tmp/latexcoder-ssh-account.png" });
    await page.locator("#account-close").click();
    await chooseAppMenu(page, "collaborate", "#collaborate-git");
    await page.locator("#git-access-dialog").waitFor();
    assert.match(await page.locator("#git-access-description").textContent(), /Authenticate with the private key/);
    await page.screenshot({ path: "/tmp/latexcoder-ssh-git.png" });
    await page.locator("#git-manage-keys").click();
    await page.getByRole("button", { name: "Remove SSH key My laptop", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#ssh-key-list")?.textContent === "No SSH keys added yet.");
    assert.equal((await (await page.request.get(`${base}/v1/users/me/ssh-keys`)).json()).keys.length, 0);
    await page.setViewportSize({ width: 390, height: 700 });
    const overflow = await page.locator("#account-dialog").evaluate(element => element.scrollWidth > element.clientWidth);
    assert.equal(overflow, false);
    await page.locator("#account-close").click();
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.route("**/v1/git/ssh?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "SSH configuration unavailable" } }) }));
    await chooseAppMenu(page, "collaborate", "#collaborate-git");
    await page.locator("#git-access-dialog").waitFor();
    assert.equal(await page.locator("#git-mode-ssh").isVisible(), false);
    assert.equal(await page.locator("#git-manage-keys").isVisible(), false);
    assert.equal(await page.locator("#account-ssh-keys").isVisible(), false);
    assert.doesNotMatch(await page.locator("body").innerText(), /SSH configuration unavailable/);
    assert.match(await page.locator("#clone-command").inputValue(), new RegExp(`^git clone ${base}/git/`));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await paper.shutdown();
    paper.sockets.close();
    await new Promise(resolve => paper.server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});


for (const host of ["", "https://git.example.test"]) {
  test(`SSH stays hidden with ${host ? "invalid" : "missing"} public configuration`, async () => {
    await withEditor(async ({ page, base }) => {
      const sshRequests: string[] = [];
      page.on("request", request => {
        if (/\/v1\/(git\/ssh|users\/me\/ssh-keys)/.test(request.url())) sshRequests.push(request.url());
      });
      const { projects } = await (await page.request.get(`${base}/v1/projects`)).json();
      await page.goto(`${base}/projects/${projects[0].id}`);
      await chooseAppMenu(page, "account", "#editor-account-button");
      await page.locator("#account-dialog").waitFor();
      assert.equal(await page.locator("#account-ssh-keys").isVisible(), false);
      assert.doesNotMatch(await page.locator("#account-dialog").innerText(), /SSH/);
      await page.locator("#account-close").click();
      await chooseAppMenu(page, "collaborate", "#collaborate-git");
      await page.locator("#git-access-dialog").waitFor();
      assert.equal(await page.locator("#git-auth-options").isVisible(), false);
      assert.equal(await page.locator("#git-manage-keys").isVisible(), false);
      assert.equal(await page.locator("#git-host-fingerprint").isVisible(), false);
      assert.equal(await page.locator("#copy-clone-command").isEnabled(), true);
      assert.match(await page.locator("#clone-command").inputValue(), new RegExp(`^git clone ${base}/git/`));
      assert.doesNotMatch(await page.locator("#git-access-dialog").innerText(), /SSH|environment|configur/i);
      assert.deepEqual(sshRequests, []);
    }, { sshPort: 0, sshHost: "127.0.0.1", sshPublicHost: host, sshPublicPort: 45124 });
  });
}
