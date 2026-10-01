import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildDiagnostics, compileErrors } from "../shared/compile-errors.ts";
import { compileSourceMap } from "../shared/source-map.ts";
import { compileTemplate, type CompileSelection } from "../shared/compile-directives.ts";
import { buildSourceRevision, resolveCompileTarget } from "./compile-target.ts";
import { apiError, safeRelativePath } from "./core.ts";
import { findCompiler } from "./compiler.ts";
import type { CompileQueue } from "./compile-queue.ts";
import type { BuildMetadata, StateDatabase } from "./database.ts";
import type { Logger } from "./logger.ts";
import { listFiles } from "./project-files.ts";
import { run } from "./process.ts";
import type { ProjectRuntime, ServerOptions } from "./types.ts";

type CompileServiceOptions = {
  stateDir: string;
  database: StateDatabase;
  queue: CompileQueue;
  logger: Logger;
  serverOptions: ServerOptions;
  assertWritable(runtime: ProjectRuntime): void;
};

export function compilerArguments(executable: string, outputDir: string, main: string, tectonicBundleUrl?: string): string[] {
  if (executable.startsWith("latexmk")) {
    return ["-pdf", "-synctex=1", "-file-line-error", "-interaction=nonstopmode", "-halt-on-error", `-outdir=${outputDir}`, main];
  }
  const bundleUrl = tectonicBundleUrl?.trim();
  return [...(bundleUrl ? ["--bundle", bundleUrl] : []), "--synctex", "--keep-logs", "--outdir", outputDir, main];
}

export function createCompileService({ stateDir, database, queue, logger, serverOptions, assertWritable }: CompileServiceOptions) {
  const targets = new WeakMap<ProjectRuntime, Map<string, Promise<ProjectRuntime>>>();
  const resolveBuildRuntime = async (project: ProjectRuntime, selection: CompileSelection): Promise<ProjectRuntime> => {
    project.collaboration.flush();
    const target = await resolveCompileTarget(project.projectDir, project.build.main, selection);
    if (target.mode === "project" && target.main === project.build.main) return project;
    const key = createHash("sha256").update(JSON.stringify(target)).digest("hex");
    let entries = targets.get(project);
    if (!entries) targets.set(project, entries = new Map());
    let pending = entries.get(key);
    if (!pending) {
      pending = (async () => {
        // Inherit live project guards/collaboration, but own all build state.
        const runtime: ProjectRuntime = Object.create(project);
        runtime.compileTarget = target;
        runtime.compilePromise = null;
        runtime.buildDir = path.join(project.buildDir, "targets", key);
        await mkdir(runtime.buildDir, { recursive: true });
        runtime.build = { status: "idle", main: target.main, target, startedAt: null, finishedAt: null, log: "", pdf: false, sourceRevision: null };
        try {
          const cached = JSON.parse(await readFile(path.join(runtime.buildDir, "build.json"), "utf8"));
          runtime.build = { ...cached, main: target.main, target };
          if (runtime.build.status === "running") runtime.build.status = "idle";
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return runtime;
      })();
      entries.set(key, pending);
      pending.catch(() => entries!.delete(key));
    }
    return pending;
  };

  const saveBuild = async (runtime: ProjectRuntime) => {
    if (!runtime.compileTarget) { database.saveBuild(runtime.id, runtime.build); return; }
    const temporary = path.join(runtime.buildDir, "build.json.tmp");
    await writeFile(temporary, JSON.stringify(runtime.build));
    await rename(temporary, path.join(runtime.buildDir, "build.json"));
  };

  const performCompile = async (runtime: ProjectRuntime, requestedMain: unknown): Promise<{ success: boolean; build: BuildMetadata }> => {
    let workDir: string | undefined;
    const previousPdf = runtime.build.pdf;
    const previousRevision = runtime.build.sourceRevision;
    try {
      assertWritable(runtime);
      const { projectDir, buildDir, collaboration } = runtime;
      collaboration.flush();
      const main = safeRelativePath(requestedMain || runtime.build.main || "main.tex");
      if (!main.endsWith(".tex")) throw apiError("invalid_main", "main document must be a .tex file");
      runtime.build = { status: "running", main, target: runtime.compileTarget, startedAt: new Date().toISOString(), finishedAt: null, log: "", pdf: previousPdf, sourceRevision: previousRevision };
      await saveBuild(runtime);
      workDir = path.join(buildDir, `job-${randomUUID()}`);
      const gitDir = path.join(projectDir, ".git");
      await cp(projectDir, workDir, { recursive: true, filter: source => source !== gitDir && !source.startsWith(`${gitDir}${path.sep}`) });
      const settings = database.getSettings(runtime.id);
      const sourceRevision = await buildSourceRevision(runtime, workDir);
      const sourceMaps: Record<string, { lines: number[]; source: string; path?: string }> = {};
      for (const file of await listFiles(workDir)) {
        if (!file.path.endsWith(".tex")) continue;
        const sourcePath = path.join(workDir, file.path);
        const source = await readFile(sourcePath, "utf8");
        const projection = compileSourceMap(source);
        sourceMaps[file.path] = { lines: projection.lines, source };
        await writeFile(sourcePath, projection.text, "utf8");
      }
      let entry = main;
      const inputPaths: Record<string, string> = {};
      const template = runtime.compileTarget?.template;
      if (template) {
        entry = `latexcoder-entry-${randomUUID()}.tex`;
        const source = await readFile(path.join(workDir, template), "utf8");
        await writeFile(path.join(workDir, entry), compileTemplate(source, template, main), "utf8");
        sourceMaps[entry] = { ...sourceMaps[template], path: template };
        inputPaths[template] = entry;
      }
      const outputDir = path.join(workDir, ".paper-output");
      await mkdir(outputDir, { recursive: true });
      const compiler = await findCompiler(
        settings.compiler === "auto" ? serverOptions.compiler || process.env.LATEXCODER_LATEX_BIN : settings.compiler,
        settings.compiler === "latexmk" ? "" : stateDir,
      );
      if (settings.compiler !== "auto" && !path.basename(compiler).startsWith(settings.compiler)) {
        throw apiError("compiler_unavailable", `The selected compiler ${settings.compiler} is not installed`, 503);
      }
      const executable = path.basename(compiler);
      const tectonicBundleUrl = serverOptions.tectonicBundleUrl ?? process.env.LATEXCODER_TECTONIC_BUNDLE_URL;
      const args = compilerArguments(executable, outputDir, entry, tectonicBundleUrl);
      const result = await run(compiler, args, { timeoutMs: executable.startsWith("latexmk") ? 60_000 : 180_000, cwd: workDir, env: { ...process.env, XDG_CACHE_HOME: path.join(stateDir, "cache") } });
      const pdfName = `${path.basename(entry, ".tex")}.pdf`;
      const outputPdf = path.join(outputDir, pdfName);
      const success = result.code === 0 && existsSync(outputPdf);
      if (success) {
        await cp(outputPdf, path.join(buildDir, "latest.pdf"));
        const syncFile = path.join(outputDir, pdfName.replace(/\.pdf$/, ".synctex.gz"));
        await rm(path.join(buildDir, "latest.synctex.gz"), { force: true });
        if (existsSync(syncFile)) await cp(syncFile, path.join(buildDir, "latest.synctex.gz"));
        await writeFile(path.join(buildDir, "source-map.json"), JSON.stringify({ root: await realpath(workDir), files: sourceMaps, inputPaths, revision: sourceRevision }));
      }
      runtime.build = {
        status: success ? "success" : "error", main, target: runtime.compileTarget, startedAt: runtime.build.startedAt, finishedAt: new Date().toISOString(),
        log: result.output || (success ? "Compilation completed." : `Compiler exited with code ${result.code}.`),
        errors: compileErrors(result.output || "", main).map(error => {
          const file = Object.keys(sourceMaps).find(file => error.path === file || error.path.endsWith(`/${file}`));
          return file ? { ...error, path: sourceMaps[file].path || file, line: sourceMaps[file].lines[error.line - 1] || error.line } : error;
        }),
        pdf: success || previousPdf,
        sourceRevision: success ? sourceRevision : previousRevision,
      };
      await saveBuild(runtime);
      return { success, build: runtime.build };
    } catch (error) {
      runtime.build = {
        ...runtime.build, status: "error", finishedAt: new Date().toISOString(),
        log: error instanceof Error ? error.message : String(error), errors: [], pdf: previousPdf, sourceRevision: previousRevision,
      };
      await saveBuild(runtime);
      throw error;
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  };

  const compileProject = async (runtime: ProjectRuntime, main: unknown): Promise<{ success: boolean; build: BuildMetadata }> => {
    if (runtime.compilePromise) return runtime.compilePromise;
    const promise = queue.run(async () => {
      const startedAt = performance.now();
      logger.info("compile.started", { projectId: runtime.id, queued: queue.stats().queued });
      try {
        const result = await performCompile(runtime, main);
        logger.info("compile.finished", { projectId: runtime.id, success: result.success, durationMs: Math.round(performance.now() - startedAt) });
        return result;
      } catch (error) {
        logger.error("compile.failed", error, { projectId: runtime.id, durationMs: Math.round(performance.now() - startedAt) });
        throw error;
      }
    });
    runtime.compilePromise = promise;
    try {
      return await promise;
    } finally {
      if (runtime.compilePromise === promise) runtime.compilePromise = null;
    }
  };

  const ensureLatestPdf = async (runtime: ProjectRuntime): Promise<BuildMetadata> => {
    const main = safeRelativePath(runtime.build.main || "main.tex");
    for (let attempt = 0; attempt < 3; attempt++) {
      runtime.collaboration.flush();
      const currentRevision = await buildSourceRevision(runtime);
      if (runtime.build.pdf && runtime.build.status === "success" && runtime.build.main === main
        && runtime.build.sourceRevision === currentRevision && existsSync(path.join(runtime.buildDir, "latest.pdf"))) return runtime.build;
      const result = await compileProject(runtime, main);
      if (!result.success) {
        const diagnostics = buildDiagnostics(result.build.log, result.build.errors, result.build.main);
        if (!diagnostics.some(item => item.severity === "error")) diagnostics.unshift({ severity: "error", message: result.build.log || "LaTeX compilation failed" });
        throw apiError("compile_failed", "LaTeX compilation failed; inspect error.details for diagnostics", 422, {
          main: result.build.main,
          log: result.build.log,
          diagnostics,
          firstFatalError: diagnostics.find(item => item.severity === "error") || null,
        });
      }
    }
    throw apiError("compile_changed", "the project kept changing while the PDF was compiling; retry the download", 409);
  };

  return { compileProject, ensureLatestPdf, resolveBuildRuntime };
}
