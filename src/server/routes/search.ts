import { apiError, contentPath, isWellFormedUtf16, MAX_TEXT_BYTES, sha256 } from "../core.ts";
import { runRipgrep, validatedSearchOptions, validatedSearchPaths } from "../process.ts";
import type { RouteApp, SearchRouteContext } from "./types.ts";

export function registerSearchRoutes(app: RouteApp, context: SearchRouteContext): void {
  const { json, options, projectSearch } = context;

  app.post("/v1/search/project", json({ limit: "16kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const { sources: _sources, ...result } = await projectSearch.search(runtime, request.body);
      response.setHeader("Cache-Control", "no-store");
      response.json(result);
    } catch (error) { next(error); }
  });
  app.post("/v1/search/replace/preview", json({ limit: "32kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      response.json(await projectSearch.previewReplacement(runtime, request.body));
    } catch (error) { next(error); }
  });
  app.post("/v1/search/replace", json({ limit: "24mb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      context.assertProjectWritable(runtime);
      const files = request.body?.files;
      if (!Array.isArray(files) || !files.length || files.length > 100) throw apiError("invalid_files", "Expected 1 to 100 replacement files");
      const paths = new Set<string>();
      // No awaits between validation and mutation: any stale file rejects the batch.
      for (const file of files) {
        file.path = contentPath(file.path);
        if (paths.has(file.path) || typeof file.source !== "string" || !isWellFormedUtf16(file.source) || Buffer.byteLength(file.source) > MAX_TEXT_BYTES) throw apiError("invalid_files", "Invalid or duplicate replacement file");
        paths.add(file.path);
        const current = runtime.collaboration.readText(file.path);
        if (sha256(current) !== file.baseSha256) throw apiError("stale_file", "A replacement file changed. Preview again before applying.", 409, { path: file.path, currentSha256: sha256(current) });
      }
      const results = files.map(file => ({ path: file.path, ...runtime.collaboration.editFile(file.path, file.baseSha256, file.source) }));
      runtime.collaboration.flush();
      response.json({ files: results.map(file => ({ path: file.path, sha256: file.sha256 })) });
    } catch (error) { next(error); }
  });
  app.post("/v1/search", json({ limit: "32kb" }), async (request, response, next) => {
    try {
      const runtime = await context.resolveProject(request);
      const pattern = request.body?.pattern;
      if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 4096 || pattern.includes("\0")) throw apiError("invalid_search_pattern", "pattern must contain 1 to 4096 characters");
      const searchOptions = validatedSearchOptions(request.body?.args);
      const searchPaths = await validatedSearchPaths(runtime.projectDir, request.body?.paths);
      runtime.collaboration.flush();
      const result = await runRipgrep(runtime.projectDir, [
        "--no-config", ...searchOptions, "--color=never", "--threads=4", "--one-file-system",
        "--glob=!.git/**", "--glob=!**/.git/**", "--regexp", pattern, "--", ...searchPaths,
      ], { bwrap: options.bwrap, rg: options.rg, timeoutMs: options.searchTimeoutMs });
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Ripgrep-Exit-Code", String(result.code));
      response.type("text/plain; charset=utf-8");
      if (result.code === 0 || (result.code === 1 && result.stderr.length === 0)) return response.send(result.stdout);
      response.status(422).send(result.stderr.length ? result.stderr : Buffer.from(`ripgrep exited with code ${result.code}\n`));
    } catch (error) { next(error); }
  });
}
