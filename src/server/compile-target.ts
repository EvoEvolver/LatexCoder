import { readFile } from "node:fs/promises";
import { compileDirectives, compileTemplate, type CompileSelection, type CompileTarget } from "../shared/compile-directives.ts";
import { apiError, contentPath } from "./core.ts";
import { checkedContentTarget, compilationSourceRevision } from "./project-files.ts";
import type { ProjectRuntime } from "./types.ts";

export async function resolveCompileTarget(projectDir: string, fallback: string, selection: CompileSelection): Promise<CompileTarget> {
  const read = async (file: string) => {
    if (!file.endsWith(".tex")) throw new Error(`${file}: compile entry must be a .tex file`);
    try { return await readFile(checkedContentTarget(projectDir, file), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${file}: file does not exist`);
      throw error;
    }
  };
  try {
    const mode = selection.mode || "project";
    let file = contentPath(selection.file || fallback);
    let explicitRoot = false;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(file)) throw new Error(`${file}: circular latexcoder:${mode === "chapter" ? "chapter-root" : "root"} chain`);
      visited.add(file);
      const directives = compileDirectives(await read(file), file);
      const entry = directives[mode === "chapter" ? "chapter-root" : "root"];
      if (entry) {
        if (mode === "project") explicitRoot = true;
        const next = contentPath(entry.value);
        if (next !== file) { file = next; continue; }
      } else if (mode === "project" && visited.size === 1 && file !== fallback) {
        // A child may inherit the top-level root declaration from its chapter.
        if (directives["chapter-root"] && contentPath(directives["chapter-root"].value) !== file) {
          file = contentPath(directives["chapter-root"].value);
          continue;
        }
        file = contentPath(fallback);
        continue;
      } else if (mode === "chapter" && visited.size === 1 && !directives.template) {
        throw new Error(`${file}: add %% latexcoder:chapter-root <project-relative chapter.tex> to select a chapter`);
      }
      if (mode === "project") {
        // Following a chapter marker does not make that chapter the project root.
        if (!explicitRoot && file !== fallback && !visited.has(fallback)) { file = contentPath(fallback); continue; }
        return { mode, main: file };
      }
      const template = directives.template?.value;
      if (!template) throw new Error(`${file}: add %% latexcoder:template <project-relative template.tex> (or none for a complete document)`);
      if (template === "none") return { mode, main: file };
      const templatePath = contentPath(template);
      if (templatePath === file) throw new Error(`${file}: a chapter cannot be its own template`);
      compileTemplate(await read(templatePath), templatePath, file);
      return { mode, main: file, template: templatePath };
    }
  } catch (error) {
    throw apiError("invalid_compile_target", error instanceof Error ? error.message : String(error));
  }
}

export function buildSourceRevision(runtime: ProjectRuntime, projectDir = runtime.projectDir): Promise<string> {
  return compilationSourceRevision(projectDir, runtime.build.main, runtime.database.getSettings(runtime.id).compiler,
    runtime.compileTarget ? JSON.stringify(runtime.compileTarget) : "");
}
