export type CompileMode = "project" | "chapter";
export type CompileSelection = { mode?: CompileMode; file?: string };
export type CompileTarget = { mode: CompileMode; main: string; template?: string };
export type CompileDirective = { value: string; line: number };
export type CompileDirectives = Partial<Record<"root" | "chapter-root" | "template", CompileDirective>>;

// Only the leading comment block is configuration; examples in the body are not.
export function compileDirectives(source: string, file: string): CompileDirectives {
  const result: CompileDirectives = {};
  for (const [index, row] of source.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    if (!row.trim()) continue;
    if (!row.trimStart().startsWith("%")) break;
    const match = /^\s*%%\s*latexcoder:(root|chapter-root|template)(?:\s+(.*?))?\s*$/.exec(row);
    if (!match) continue;
    const key = match[1] as keyof CompileDirectives;
    if (!match[2]?.trim()) throw new Error(`${file}:${index + 1}: latexcoder:${key} needs a value`);
    if (result[key]) throw new Error(`${file}:${index + 1}: duplicate latexcoder:${key}`);
    result[key] = { value: match[2].trim(), line: index + 1 };
  }
  return result;
}

export function compileTemplate(source: string, file: string, main: string): string {
  const marker = /^[\t ]*%%[\t ]*latexcoder:content[\t ]*\r?$/gm;
  if ([...source.matchAll(marker)].length !== 1) {
    throw new Error(`${file}: expected exactly one %% latexcoder:content line`);
  }
  // TeX filename syntax is narrower than filesystem path syntax.
  if (/["%{}#$^~\r\n\\]/.test(main)) throw new Error(`${main}: unsupported character in template input path`);
  return source.replace(marker, () => `\\input{"${main}"}`);
}
