import { fileURLToPath } from "node:url";
import path from "node:path";
import { apiError } from "./core.ts";
import { executablePath, run } from "./process.ts";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installations = new Map<string, Promise<string>>();
type CompilerDependencies = {
  executablePath(candidate: string): Promise<string | null>;
  installTectonic(stateDir: string): Promise<string>;
};

async function installTectonic(stateDir: string): Promise<string> {
  const result = await run("sh", [path.join(APP_DIR, "scripts/install-tectonic.sh")], {
    cwd: APP_DIR,
    env: { ...process.env, LATEXCODER_STATE_DIR: stateDir },
    timeoutMs: 180_000,
  });
  if (result.code !== 0) {
    throw apiError("compiler_install_failed", `Automatic Tectonic installation failed. Check the network and retry.\n${result.output}`, 503);
  }
  const installed = path.join(stateDir, "bin", "tectonic");
  if (!await executablePath(installed)) throw apiError("compiler_install_failed", "Automatic Tectonic installation did not produce an executable", 503);
  return installed;
}

export async function findCompiler(configured: string | undefined, stateDir: string, dependencies: CompilerDependencies = { executablePath, installTectonic }): Promise<string> {
  const candidates = [configured, path.join(stateDir, "bin", "tectonic"), "tectonic", "latexmk"]
    .filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const executable = await dependencies.executablePath(candidate);
    if (executable) return executable;
  }
  if (configured === "latexmk" || !stateDir) {
    throw apiError("compiler_unavailable", "The selected compiler latexmk is not installed", 503);
  }
  let installation = installations.get(stateDir);
  if (!installation) {
    installation = dependencies.installTectonic(stateDir);
    installations.set(stateDir, installation);
    installation.finally(() => installations.delete(stateDir)).catch(() => {});
  }
  return installation;
}
