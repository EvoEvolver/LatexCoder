import { fileURLToPath } from "node:url";
import path from "node:path";
import { apiError } from "./core.ts";
import { executablePath, run } from "./process.ts";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installations = new Map<string, Promise<string>>();

export async function findCompiler(configured: string | undefined, stateDir: string): Promise<string> {
  const candidates = [configured, path.join(stateDir, "bin", "tectonic"), "tectonic", "latexmk"]
    .filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const executable = await executablePath(candidate);
    if (executable) return executable;
  }
  if (configured === "latexmk" || !stateDir) throw apiError("compiler_unavailable", "The selected compiler latexmk is not installed", 503);
  if (!installations.has(stateDir)) {
    const installation = (async () => {
      const result = await run("sh", [path.join(APP_DIR, "scripts/install-tectonic.sh")], {
        cwd: APP_DIR, env: { ...process.env, LATEXCODER_STATE_DIR: stateDir }, timeoutMs: 180_000,
      });
      if (result.code !== 0) throw apiError("compiler_install_failed", `Automatic Tectonic installation failed. Check the network and retry.\n${result.output}`, 503);
      return path.join(stateDir, "bin", "tectonic");
    })();
    installations.set(stateDir, installation);
    installation.finally(() => installations.delete(stateDir)).catch(() => {});
  }
  return installations.get(stateDir)!;
}
