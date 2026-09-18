import path from "node:path";
import { executablePath } from "./process.ts";

export type DependencyStatus = { available: boolean; path: string | null };
export type DependencyReport = Record<"git" | "rg" | "bwrap" | "synctex" | "compiler", DependencyStatus>;

export async function checkDependencies(stateDir: string, configured: { compiler?: string; synctex?: string; rg?: string; bwrap?: string }): Promise<DependencyReport> {
  const compilerCandidates = [configured.compiler, path.join(stateDir, "bin", "tectonic"), "tectonic", "latexmk"].filter((value): value is string => Boolean(value));
  let compiler: string | null = null;
  for (const candidate of compilerCandidates) {
    compiler = await executablePath(candidate);
    if (compiler) break;
  }
  const entries = await Promise.all([
    executablePath("git"),
    executablePath(configured.rg || process.env.LATEXCODER_RG_BIN || "rg"),
    executablePath(configured.bwrap || process.env.LATEXCODER_BWRAP_BIN || "bwrap"),
    executablePath(configured.synctex || process.env.LATEXCODER_SYNCTEX_BIN || "synctex"),
  ]);
  const status = (value: string | null): DependencyStatus => ({ available: Boolean(value), path: value });
  return { git: status(entries[0]), rg: status(entries[1]), bwrap: status(entries[2]), synctex: status(entries[3]), compiler: status(compiler) };
}
