import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type AddressInfo } from "node:net";
import test from "node:test";
import ssh2 from "ssh2";
import { createPaperServer } from "../src/server/app.ts";
import { parseSshPublicKey } from "../src/server/ssh-keys.ts";
import { execFileAsync, testGit, withServer } from "./helpers/server.ts";

const { Client, utils } = ssh2;

test("SSH public key validation accepts supported public keys and rejects private or malformed keys", () => {
  for (const pair of [utils.generateKeyPairSync("ed25519"), utils.generateKeyPairSync("rsa", { bits: 2048 }), utils.generateKeyPairSync("ecdsa", { bits: 256 })]) {
    assert.match(parseSshPublicKey(pair.public).fingerprint, /^SHA256:/);
    assert.throws(() => parseSshPublicKey(pair.private), /public key/);
  }
  for (const value of [null, "ssh-ed25519 AAAA", "ssh-ed25519 AAAA\nssh-ed25519 AAAA", "command=bad ssh-ed25519 AAAA"]) {
    assert.throws(() => parseSshPublicKey(value));
  }
});

test("SSH Git authenticates private keys, enforces membership, synchronizes pushes, and preserves access links", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "latexcoder-ssh-"));
  let paper = await createPaperServer({ stateDir: temporary, adminPassword: "ssh-test-password", sshPort: 0, sshHost: "127.0.0.1", sshPublicHost: "git.example.test", sshPublicPort: 45124 });
  await new Promise<void>(resolve => paper.server.listen(0, "127.0.0.1", resolve));
  let base = `http://127.0.0.1:${(paper.server.address() as AddressInfo).port}`;
  const api = (url: string, cookie = "", method = "GET", body?: unknown) => fetch(`${base}${url}`, {
    method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = async (username: string) => {
    const result = await api("/v1/auth/login", "", "POST", { username, password: "ssh-test-password" });
    assert.equal(result.status, 200);
    return result.headers.get("set-cookie")!.split(";")[0];
  };
  const key = utils.generateKeyPairSync("ed25519");
  const wrongKey = utils.generateKeyPairSync("ecdsa", { bits: 256 });
  const rsaKey = utils.generateKeyPairSync("rsa", { bits: 2048 });
  const rsaPath = path.join(temporary, "rsa_key");
  await writeFile(rsaPath, rsaKey.private, { mode: 0o600 });
  const privatePath = path.join(temporary, "test_key");
  const wrongPath = path.join(temporary, "wrong_key");
  await writeFile(privatePath, key.private, { mode: 0o600 });
  await writeFile(wrongPath, wrongKey.private, { mode: 0o600 });
  const git = (args: string[], cwd = temporary, keyPath = privatePath) => execFileAsync("git", args, { cwd, timeout: 15_000,
    env: { ...process.env, GIT_SSH_COMMAND: `ssh -F /dev/null -i '${keyPath}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`, GIT_TERMINAL_PROMPT: "0" },
  });
  const stop = async () => { await paper.shutdown(); paper.sockets.close(); await new Promise(resolve => paper.server.close(resolve)); };
  try {
    const admin = await login("admin");
    assert.equal((await api("/v1/users/me/ssh-keys")).status, 401);
    const added = await api("/v1/users/me/ssh-keys", admin, "POST", { title: "Laptop", publicKey: key.public });
    assert.equal(added.status, 201);
    const savedKey = (await added.json()).key;
    assert.equal((await api("/v1/users/me/ssh-keys", admin, "POST", { title: "Duplicate", publicKey: key.public })).status, 409);
    assert.equal((await api("/v1/users/me/ssh-keys", admin, "POST", { title: "Private", publicKey: key.private })).status, 400);
    const created = await api("/v1/projects", admin, "POST", { name: "SSH test" });
    const { project } = await created.json();
    const access = await (await api(`/v1/git/ssh?project=${project.id}`, admin)).json();
    assert.equal(access.enabled, true);
    assert.equal(access.keyCount, 1);
    assert.equal(access.url, `ssh://git@git.example.test:45124/${project.id}.git`);
    assert.equal((await (await api("/v1/auth/me", admin)).json()).features.sshGit, true);
    const sshUrl = () => `ssh://git@127.0.0.1:${(paper.sshServer!.address() as AddressInfo).port}/${project.id}.git`;
    assert.equal((await stat(path.join(temporary, "ssh_host_ed25519_key"))).mode & 0o777, 0o600);
    await assert.rejects(git(["ls-remote", sshUrl()], temporary, wrongPath), /Permission denied/);
    const clone = path.join(temporary, "clone");
    await git(["clone", sshUrl(), clone]);
    const original = await readFile(path.join(clone, "main.tex"), "utf8");
    assert.match(original, /documentclass/);
    const runtime = paper.projects.get(project.id)!;
    runtime.collaboration.replaceText("main.tex", original + "\n% browser edit\n");
    await writeFile(path.join(clone, "ssh.tex"), "SSH push\n");
    await testGit(clone, ["add", "ssh.tex"]);
    await testGit(clone, ["commit", "-m", "SSH push"]);
    await git(["push", "origin", "main"], clone);
    assert.equal(runtime.collaboration.readText("ssh.tex"), "SSH push\n");
    assert.match(runtime.collaboration.readText("main.tex"), /browser edit/);
    assert.ok(runtime.collaboration.blame("ssh.tex").runs.some(run => run.authorId === "admin"));
    await git(["pull", "--no-rebase"], clone);
    assert.match(await readFile(path.join(clone, "main.tex"), "utf8"), /browser edit/);
    const { share } = await (await api(`/v1/project/share?project=${project.id}`, admin, "POST")).json();
    await git(["ls-remote", `${base}${share.clonePath}`]);

    const { invitation } = await (await api("/v1/invitations", admin, "POST", {})).json();
    const registered = await api("/v1/auth/register", "", "POST", { token: invitation.token, username: "reader", password: "ssh-test-password" });
    assert.equal(registered.status, 201);
    const reader = await login("reader");
    const readerAdded = await api("/v1/users/me/ssh-keys", reader, "POST", { title: "Reader", publicKey: wrongKey.public });
    assert.equal(readerAdded.status, 201);
    assert.equal((await api(`/v1/users/me/ssh-keys/${savedKey.id}`, reader, "DELETE")).status, 404);
    await assert.rejects(git(["ls-remote", sshUrl()], temporary, wrongPath), /access is no longer valid/);
    paper.database.addProjectMember(project.id, "reader", "viewer");
    await git(["ls-remote", sshUrl()], temporary, wrongPath);
    await assert.rejects(git(["push", "origin", "main"], clone, wrongPath), /access is no longer valid/);

    const client = new Client();
    await new Promise<void>((resolve, reject) => client.once("ready", resolve).once("error", reject).connect({
      host: "127.0.0.1", port: (paper.sshServer!.address() as AddressInfo).port, username: "git", privateKey: key.private,
    }));
    try {
      await new Promise<void>(resolve => client.exec("cat /etc/passwd", error => { assert.ok(error); resolve(); }));
      assert.equal((await api(`/v1/users/me/ssh-keys/${savedKey.id}`, admin, "DELETE")).status, 200);
      await new Promise<void>((resolve, reject) => client.exec(`git-upload-pack '/${project.id}.git'`, (error, channel) => {
        if (error) return reject(error);
        channel.resume();
        channel.stderr.resume();
        channel.once("exit", code => { assert.equal(code, 1); resolve(); });
      }));
    } finally { client.end(); }
    await assert.rejects(git(["ls-remote", sshUrl()]), /Permission denied/);
    await git(["ls-remote", `${base}${share.clonePath}`]);
    paper.database.softDeleteUser("reader", new Date().toISOString());
    await assert.rejects(git(["ls-remote", sshUrl()], temporary, wrongPath), /Permission denied/);

    assert.equal((await api("/v1/users/me/ssh-keys", admin, "POST", { title: "RSA", publicKey: rsaKey.public })).status, 201);
    await git(["ls-remote", sshUrl()], temporary, rsaPath);
    await stop();
    paper = await createPaperServer({ stateDir: temporary, sshPort: 0, sshHost: "127.0.0.1", sshPublicHost: "git.example.test", sshPublicPort: 45124 });
    await new Promise<void>(resolve => paper.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(paper.server.address() as AddressInfo).port}`;
    const restarted = await (await api(`/v1/git/ssh?project=${project.id}`, await login("admin"))).json();
    assert.equal(restarted.hostFingerprint, access.hostFingerprint);
    assert.equal(paper.database.listSshKeys("reader").length, 1);
    assert.equal(paper.database.listSshKeys("admin").length, 1);
    await git(["ls-remote", sshUrl()], temporary, rsaPath);
  } finally { await stop(); await rm(temporary, { recursive: true, force: true }); }
});


test("incomplete or invalid SSH configuration hides the feature and keeps HTTP Git working", async t => {
  const cases = [
    { name: "missing host", sshPublicHost: "", sshPublicPort: 45124 },
    { name: "missing port", sshPublicHost: "git.example.test", sshPublicPort: undefined },
    { name: "URL instead of host", sshPublicHost: "https://git.example.test", sshPublicPort: 45124 },
    { name: "invalid public port", sshPublicHost: "git.example.test", sshPublicPort: 65536 },
    { name: "invalid listen port", sshPublicHost: "git.example.test", sshPublicPort: 45124, sshPort: NaN },
    { name: "HTTP and SSH port conflict", sshPublicHost: "git.example.test", sshPublicPort: 45124, port: 2222, sshPort: 2222 },
  ];
  for (const { name, ...options } of cases) await t.test(name, () => withServer(async ({ base, sshServer }) => {
    assert.equal(sshServer, undefined);
    assert.equal((await (await fetch(`${base}/v1/auth/me`)).json()).features.sshGit, false);
    const { projects } = await (await fetch(`${base}/v1/projects`)).json();
    const projectId = projects[0].id;
    const metadata = await fetch(`${base}/v1/git/ssh?project=${projectId}`);
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), { enabled: false, url: null, keyCount: 0, hostFingerprint: null });
    const { share } = await (await fetch(`${base}/v1/project/share?project=${projectId}`, { method: "POST" })).json();
    await execFileAsync("git", ["ls-remote", `${base}${share.clonePath}`], { timeout: 15_000 });
  }, { sshPort: 0, sshHost: "127.0.0.1", ...options }));
});

test("SSH public endpoint falls back to Railway without changing the listener port", async t => {
  const variables = ["LATEXCODER_SSH_PUBLIC_HOST", "LATEXCODER_SSH_PUBLIC_PORT", "RAILWAY_TCP_PROXY_DOMAIN", "RAILWAY_TCP_PROXY_PORT"] as const;
  const original = variables.map(name => process.env[name]);
  const cases = [
    { name: "Railway fallback", host: undefined, port: undefined, railwayPort: "15140", endpoint: "shuttle.proxy.rlwy.net:15140" },
    { name: "explicit environment wins", host: "git.example.test", port: "45124", railwayPort: "15140", endpoint: "git.example.test:45124" },
    { name: "host override only", host: "git.example.test", port: undefined, railwayPort: "15140", endpoint: "git.example.test:15140" },
    { name: "port override only", host: undefined, port: "45124", railwayPort: "15140", endpoint: "shuttle.proxy.rlwy.net:45124" },
    { name: "invalid explicit host stays disabled", host: "https://git.example.test", port: undefined, railwayPort: "15140", endpoint: null },
    { name: "invalid Railway port stays disabled", host: undefined, port: undefined, railwayPort: "65536", endpoint: null },
    { name: "incomplete Railway endpoint stays disabled", host: undefined, port: undefined, railwayPort: undefined, endpoint: null },
  ];
  try {
    for (const scenario of cases) await t.test(scenario.name, async () => {
      const values = [scenario.host, scenario.port, "shuttle.proxy.rlwy.net", scenario.railwayPort];
      variables.forEach((name, index) => {
        if (values[index] === undefined) delete process.env[name];
        else process.env[name] = values[index];
      });
      await withServer(async ({ base, sshServer }) => {
        const enabled = scenario.endpoint !== null;
        assert.equal(Boolean(sshServer), enabled);
        assert.equal((await (await fetch(`${base}/v1/auth/me`)).json()).features.sshGit, enabled);
        const { projects } = await (await fetch(`${base}/v1/projects`)).json();
        const access = await (await fetch(`${base}/v1/git/ssh?project=${projects[0].id}`)).json();
        assert.equal(access.enabled, enabled);
        assert.equal(access.url, enabled ? `ssh://git@${scenario.endpoint}/${projects[0].id}.git` : null);
        if (sshServer) assert.ok((sshServer.address() as AddressInfo).port > 0);
      }, { sshPort: 0, sshHost: "127.0.0.1" });
    });
  } finally {
    variables.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
  }
});

test("SSH bind failure does not crash HTTP or advertise SSH", async () => {
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  try {
    await withServer(async ({ base, sshServer }) => {
      assert.equal(sshServer, undefined);
      assert.equal((await (await fetch(`${base}/v1/auth/me`)).json()).features.sshGit, false);
      assert.equal((await fetch(`${base}/v1/projects`)).status, 200);
    }, { sshPort: (occupied.address() as AddressInfo).port, sshHost: "127.0.0.1", sshPublicHost: "git.example.test", sshPublicPort: 45124 });
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
});
