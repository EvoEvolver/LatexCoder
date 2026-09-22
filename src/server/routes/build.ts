import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildDiagnostics, compileErrors } from "../../shared/compile-errors.ts";
import { projectedPosition } from "../../shared/source-map.ts";
import { syncTexPositions } from "../../shared/pdf-map.ts";
import { compileRequestSchema } from "../../shared/api-schema.ts";
import { apiError, MAX_TEXT_BYTES, safeRelativePath } from "../core.ts";
import { compilationSourceRevision } from "../project-files.ts";
import { run } from "../process.ts";
import type { ZodType } from "zod";
import type { BuildRouteContext, RouteApp } from "./types.ts";

function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw apiError("invalid_request", "request body is invalid", 400, {
    issues: result.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })),
  });
}

export function registerBuildRoutes(app: RouteApp, context: BuildRouteContext): void {
  const { database, json, options } = context;

  app.get("/v1/build", async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      runtime.collaboration.flush();
      const currentRevision = await compilationSourceRevision(runtime.projectDir, runtime.build.main, database.getSettings(runtime.id).compiler);
      const diagnostics = buildDiagnostics(runtime.build.log, runtime.build.errors, runtime.build.main);
      response.setHeader("Cache-Control", "no-store");
      response.json({ build: { ...runtime.build, stale: currentRevision !== runtime.build.sourceRevision, errors: runtime.build.errors?.length ? runtime.build.errors : compileErrors(runtime.build.log, runtime.build.main), diagnostics, firstFatalError: diagnostics.find(item => item.severity === "error") || null } });
    } catch (error) { next(error); }
  });
  app.get("/v1/build/pdf", async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      response.setHeader("Cache-Control", "no-store");
      const build = request.query.cached === "1" ? runtime.build : await context.ensureLatestPdf(runtime);
      if (!build.pdf || !existsSync(path.join(runtime.buildDir, "latest.pdf"))) throw apiError("pdf_not_found", "No successful PDF yet", 404);
      response.setHeader("Cache-Control", "no-store");
      const diagnostics = buildDiagnostics(build.log, build.errors, build.main);
      response.setHeader("X-Build-Error-Count", diagnostics.filter(item => item.severity === "error").length);
      response.setHeader("X-Build-Warning-Count", diagnostics.filter(item => item.severity === "warning").length);
      const logQuery = new URLSearchParams({ project: runtime.id });
      if (typeof request.query.access === "string") logQuery.set("access", request.query.access);
      response.setHeader("Link", `</v1/build?${logQuery}>; rel="describedby"; type="application/json"`);
      response.setHeader("ETag", `"${build.sourceRevision}"`);
      response.setHeader("X-LaTeX-Coder-Source-Revision", build.sourceRevision);
      response.sendFile(path.join(runtime.buildDir, "latest.pdf"), { dotfiles: "allow" });
    } catch (error) { next(error); }
  });
  app.post("/v1/build/position", json({ limit: `${MAX_TEXT_BYTES * 2}b` }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const file = safeRelativePath(request.body?.path);
      const { line, source, from, to } = request.body || {};
      if (!file.endsWith(".tex") || !Number.isSafeInteger(line) || line < 1 || typeof source !== "string") throw apiError("invalid_position", "Expected a LaTeX file, source, and positive line number");
      if (runtime.collaboration.readText(file) !== source) throw apiError("stale_source", "The source changed. Try navigating again.", 409);
      await context.ensureLatestPdf(runtime);
      if (!existsSync(path.join(runtime.buildDir, "latest.synctex.gz"))) await context.compileProject(runtime, runtime.build.main);
      if (!existsSync(path.join(runtime.buildDir, "latest.synctex.gz"))) throw apiError("synctex_missing", "The compiler did not produce SyncTeX data", 409);
      let snapshot = JSON.parse(await readFile(path.join(runtime.buildDir, "source-map.json"), "utf8"));
      if (snapshot.files[file]?.source !== source) {
        const result = await context.compileProject(runtime, runtime.build.main);
        if (!result.success) throw apiError("compile_failed", "Compilation failed while locating the PDF position", 422);
        snapshot = JSON.parse(await readFile(path.join(runtime.buildDir, "source-map.json"), "utf8"));
      }
      const map = snapshot.files[file];
      if (!map) throw apiError("source_not_found", "This file is not part of the compiled document", 404);
      if (map.source !== source || runtime.collaboration.readText(file) !== source) throw apiError("stale_source", "The source changed. Try navigating again.", 409);
      let projectedLine = 1;
      for (let index = 0; index < map.lines.length; index++) {
        if (Math.abs(map.lines[index] - line) < Math.abs(map.lines[projectedLine - 1] - line)) projectedLine = index + 1;
      }
      const start = Number.isSafeInteger(from) && from >= 0 && from <= source.length ? projectedPosition(source, from) : { line: projectedLine, column: 0 };
      const end = Number.isSafeInteger(to) && to >= (from || 0) && to <= source.length ? projectedPosition(source, to) : start;
      const boxes = [];
      try {
        for (let batch = start.line; batch <= Math.min(end.line, start.line + 19); batch += 4) {
          const lines = Array.from({ length: Math.min(4, Math.min(end.line, start.line + 19) - batch + 1) }, (_, index) => batch + index);
          const results = await Promise.all(lines.map(targetLine => run(options.synctex || "synctex", ["view", "-i", `${targetLine}:${targetLine === start.line ? start.column : 0}:${path.join(snapshot.root, file)}`, "-o", path.join(runtime.buildDir, "latest.pdf")], { cwd: runtime.buildDir, timeoutMs: 1000, env: { ...process.env, SYNCTEX_VIEWER: "" } })));
          for (const result of results) boxes.push(...syncTexPositions(result.output));
        }
      } catch { throw apiError("synctex_unavailable", "SyncTeX is not installed on the server", 503); }
      if (runtime.compilePromise || snapshot.revision !== runtime.build.sourceRevision || runtime.collaboration.readText(file) !== source) throw apiError("stale_source", "The source or PDF changed. Try navigating again.", 409);
      const unique = [...new Map(boxes.map(box => [JSON.stringify(box), box])).values()].slice(0, 200);
      if (!unique.length) throw apiError("source_not_found", "No PDF position for this source", 404);
      const { page, x, y } = unique[0];
      response.setHeader("Cache-Control", "no-store");
      response.json({ page, x, y, boxes: unique, revision: snapshot.revision });
    } catch (error) { next(error); }
  });
  app.post("/v1/build/source", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const { page, x, y, revision } = request.body || {};
      if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100000 || y > 100000) throw apiError("invalid_position", "Invalid PDF position");
      if (runtime.compilePromise || revision !== runtime.build.sourceRevision) throw apiError("stale_pdf", "The PDF changed. Refresh the preview and try again.", 409);
      if (!existsSync(path.join(runtime.buildDir, "latest.synctex.gz"))) throw apiError("synctex_missing", "Compile the project to enable PDF source navigation.", 409);
      const snapshot = JSON.parse(await readFile(path.join(runtime.buildDir, "source-map.json"), "utf8"));
      let result;
      try {
        result = await run(options.synctex || "synctex", ["edit", "-o", `${page}:${x}:${y}:${path.join(runtime.buildDir, "latest.pdf")}`], { cwd: runtime.buildDir, timeoutMs: 5000, env: { ...process.env, SYNCTEX_EDITOR: "" } });
      } catch { throw apiError("synctex_unavailable", "SyncTeX is not installed on the server", 503); }
      if (runtime.compilePromise || revision !== runtime.build.sourceRevision) throw apiError("stale_pdf", "The PDF changed. Refresh the preview and try again.", 409);
      const input = /^Input:(.*)$/m.exec(result.output)?.[1]?.trim();
      const line = Number(/^Line:(\d+)$/m.exec(result.output)?.[1]);
      if (!input || !line || result.code !== 0) throw apiError("source_not_found", "No source location at this PDF position", 404);
      let file = path.relative(snapshot.root, path.resolve(snapshot.root, input));
      if (!snapshot.files[file] && snapshot.files[`${file}.tex`]) file += ".tex";
      const map = snapshot.files[file];
      if (!map) throw apiError("source_not_found", "The source is outside this project", 404);
      runtime.collaboration.flush();
      const current = await readFile(path.join(runtime.projectDir, safeRelativePath(file)), "utf8");
      if (current !== map.source) throw apiError("stale_source", "This source changed since compilation. Compile again to navigate accurately.", 409);
      response.setHeader("Cache-Control", "no-store");
      response.json({ path: file, line: map.lines[line - 1] || line });
    } catch (error) { next(error); }
  });
  app.post("/v1/compile", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const body = parseBody(compileRequestSchema, request.body);
      const main = safeRelativePath(body.main || runtime.build.main || "main.tex");
      let result = await context.compileProject(runtime, main);
      if (result.build.main !== main) result = await context.compileProject(runtime, main);
      response.status(result.success ? 200 : 422).json({ build: result.build });
    } catch (error) { next(error); }
  });
}
