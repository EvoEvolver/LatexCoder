import { apiError, contentPath, MAX_TEXT_BYTES, sha256 } from "./core.ts";
import { listFiles } from "./project-files.ts";
import { runRipgrep } from "./process.ts";
import type { ProjectRuntime, ReplacementFile, SearchInput, SearchMatch, SearchOptions } from "./types.ts";

export function createProjectSearch(options: SearchOptions = {}) {
  async function search(runtime: ProjectRuntime, input: SearchInput = {}): Promise<{ matches: SearchMatch[]; truncated: boolean; sources: Map<string, string> }> {
    const { query, caseSensitive = false, regex = false } = input;
    if (typeof query !== "string" || !query.length || query.length > 512 || query.includes("\0")) throw apiError("invalid_query", "Search must contain 1 to 512 characters");
    runtime.collaboration.flush();
    const selectedPath = input.path ? contentPath(input.path) : null;
    const files = (await listFiles(runtime.projectDir)).filter(file => file.text && (!selectedPath || file.path === selectedPath));
    const sources = new Map<string, string>();
    for (const file of files) sources.set(file.path, runtime.collaboration.readText(file.path));
    runtime.collaboration.flush();
    const matches: SearchMatch[] = [];
    if (regex) {
      const result = await runRipgrep(runtime.projectDir, ["--no-config", "--json", "--threads=4", "--one-file-system", ...(caseSensitive ? [] : ["--ignore-case"]), "--glob=!.git/**", "--regexp", query, "--", selectedPath || "."], { bwrap: options.bwrap, rg: options.rg, timeoutMs: options.searchTimeoutMs });
      if (result.code !== 0 && result.code !== 1) throw apiError("invalid_query", result.stderr.toString(), 422);
      for (const row of result.stdout.toString().split("\n")) {
        if (!row) continue;
        const event = JSON.parse(row);
        if (event.type !== "match" || !event.data.path.text || !event.data.lines.text) continue;
        const data = event.data, file = data.path.text.replace(/^\.\//, "");
        if (!sources.has(file)) continue;
        for (const match of data.submatches) {
          const from = Buffer.from(data.lines.text).subarray(0, match.start).toString().length;
          const to = Buffer.from(data.lines.text).subarray(0, match.end).toString().length;
          matches.push({ path: file, line: data.line_number, from, to, text: data.lines.text.replace(/\r?\n$/, "") });
          if (matches.length >= 500) break;
        }
        if (matches.length >= 500) break;
      }
    } else {
      const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
      outer: for (const file of files) {
        const source = sources.get(file.path)!;
        for (const [index, text] of source.split("\n").entries()) for (const match of text.matchAll(literal)) {
          const from = match.index;
          matches.push({ path: file.path, line: index + 1, from, to: from + query.length, text });
          if (matches.length >= 500) break outer;
        }
      }
    }
    for (const [file, source] of sources) if (runtime.collaboration.readText(file) !== source) throw apiError("stale_search", "Files changed during search. Retry with the latest content.", 409);
    return { matches, truncated: matches.length >= 500, sources };
  }

  async function previewReplacement(runtime: ProjectRuntime, input: SearchInput = {}): Promise<{ files: ReplacementFile[]; count: number }> {
    const { replacement } = input;
    if (typeof replacement !== "string" || replacement.length > 4096) throw apiError("invalid_replacement", "Replacement must be text of at most 4096 characters");
    const result = await search(runtime, input);
    if (result.truncated) throw apiError("too_many_matches", "More than 499 matches. Narrow the search before replacing.", 413);
    const files: ReplacementFile[] = [];
    for (const [file, before] of result.sources) {
      const matches = result.matches.filter(match => match.path === file);
      if (!matches.length) continue;
      const lineOffsets = [0];
      for (let index = 0; index < before.length; index++) if (before[index] === "\n") lineOffsets.push(index + 1);
      let source = before;
      for (const match of matches.reverse()) {
        const start = lineOffsets[match.line - 1] + match.from, end = lineOffsets[match.line - 1] + match.to;
        source = source.slice(0, start) + replacement + source.slice(end);
      }
      if (Buffer.byteLength(source) > MAX_TEXT_BYTES) throw apiError("file_too_large", "Replacement would create an oversized file", 413);
      files.push({ path: file, baseSha256: sha256(before), before, source, count: matches.length });
    }
    if (files.reduce((size, file) => size + Buffer.byteLength(file.source) + Buffer.byteLength(file.before), 0) > 12 * 1024 * 1024) throw apiError("preview_too_large", "Replacement preview is too large. Narrow the scope.", 413);
    return { files, count: result.matches.length };
  }
  return { search, previewReplacement };
}
