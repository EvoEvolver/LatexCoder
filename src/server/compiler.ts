import path from "node:path";
import { apiError } from "./core.ts";
import { executablePath } from "./process.ts";

export async function findCompiler(configured: string | undefined, stateDir: string): Promise<string> {
  const candidates = [configured, path.join(stateDir, "bin", "tectonic"), "tectonic", "latexmk"]
    .filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const executable = await executablePath(candidate);
    if (executable) return executable;
  }
  throw apiError("compiler_unavailable", "install Tectonic or latexmk before compiling", 503);
}
