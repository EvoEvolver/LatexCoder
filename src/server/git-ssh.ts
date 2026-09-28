import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ssh2, { type Connection, type ServerChannel } from "ssh2";
import type { StateDatabase } from "./database.ts";
import { sshFingerprint } from "./ssh-keys.ts";

const { Server, utils } = ssh2;

export type SshGitRunner = (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<Buffer>;

type SshGitOptions = {
  stateDir: string;
  database: StateDatabase;
  port: number;
  host: string;
  run(username: string, fingerprint: string, projectId: string, push: boolean, runner: SshGitRunner): Promise<void>;
};

function runGit(channel: ServerChannel, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (channel.destroyed) { reject(new Error("SSH connection closed.")); return; }
    const child = spawn("git", args, { cwd, env, stdio: "pipe" });
    const abort = () => child.kill("SIGKILL");
    const timeout = setTimeout(abort, 120_000);
    channel.once("close", abort);
    channel.pipe(child.stdin);
    child.stdout.pipe(channel, { end: false });
    child.stderr.pipe(channel.stderr, { end: false });
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timeout);
      channel.removeListener("close", abort);
      channel.unpipe(child.stdin);
      if (code === 0) resolve(Buffer.alloc(0));
      else reject(new Error("Git transfer failed or timed out."));
    });
  });
}

export async function createGitSshServer(options: SshGitOptions) {
  const hostKeyPath = path.join(options.stateDir, "ssh_host_ed25519_key");
  let hostKey: Buffer;
  try { hostKey = await readFile(hostKeyPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const generated = utils.generateKeyPairSync("ed25519");
    await writeFile(hostKeyPath, generated.private, { mode: 0o600, flag: "wx" });
    hostKey = Buffer.from(generated.private);
  }
  await chmod(hostKeyPath, 0o600);
  const parsedHost = utils.parseKey(hostKey);
  if (parsedHost instanceof Error || Array.isArray(parsedHost)) throw new Error("Invalid SSH host key");
  const fingerprint = sshFingerprint(parsedHost.getPublicSSH());
  const connections = new Set<Connection>();
  const channels = new Set<ServerChannel>();
  const tasks = new Set<Promise<void>>();
  let closed = false;
  const server = new Server({ hostKeys: [hostKey] }, client => {
    connections.add(client);
    let username = "";
    let keyFingerprint = "";
    const timeout = setTimeout(() => client.end(), 150_000);
    client.on("error", () => {});
    client.once("close", () => { clearTimeout(timeout); connections.delete(client); });
    client.on("authentication", context => {
      if (closed || context.method !== "publickey" || context.username !== "git") return context.reject(["publickey"]);
      const candidateFingerprint = sshFingerprint(context.key.data);
      const key = options.database.getSshKey(candidateFingerprint);
      const user = key && options.database.getUser(key.username);
      if (!key || !user || user.deletedAt) return context.reject(["publickey"]);
      const parsed = utils.parseKey(key.publicKey);
      if (parsed instanceof Error || Array.isArray(parsed)
        || !parsed.getPublicSSH().equals(context.key.data)
        || (context.signature && parsed.verify(context.blob!, context.signature, context.hashAlgo) !== true)) {
        return context.reject(["publickey"]);
      }
      // An unsigned probe may be acknowledged, but only a verified signature establishes identity.
      if (context.signature) { username = key.username; keyFingerprint = candidateFingerprint; }
      context.accept();
    });
    client.on("ready", () => {
      client.on("session", (accept, reject) => {
        if (closed || !username) return reject();
        const session = accept();
        session.on("exec", (acceptExec, rejectExec, info) => {
          const match = /^git-(upload|receive)-pack '(?:\/)?([A-Za-z0-9_-]{12})(?:\.git)?'$/.exec(info.command);
          if (!match || closed) return rejectExec();
          const channel = acceptExec();
          channels.add(channel);
          channel.once("close", () => channels.delete(channel));
          channel.on("error", () => {});
          const task = options.run(username, keyFingerprint, match[2], match[1] === "receive",
            (args, cwd, env) => runGit(channel, args, cwd, env)).then(() => {
            channel.exit(0);
            channel.end();
          }, error => {
            if (!channel.destroyed) {
              channel.stderr.write(`${error instanceof Error ? error.message : "Git access denied"}\n`);
              channel.exit(1);
              channel.end();
            }
          });
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => { server.removeListener("error", reject); resolve(); });
  });
  return {
    server,
    fingerprint,
    async close(): Promise<void> {
      closed = true;
      server.close();
      for (const channel of channels) channel.destroy();
      for (const client of connections) client.end();
      await Promise.allSettled([...tasks]);
    },
  };
}
