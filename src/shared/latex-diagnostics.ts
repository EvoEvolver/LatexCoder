import type { BuildDiagnostic } from "./compile-errors.ts";

export type LatexSourceFile = { path: string; source: string };

type Occurrence = { path: string; key: string; from: number; to: number; line: number };

function withoutComments(source: string): string {
  return source.replace(/(^|[^\\])%[^\n]*/g, value => value.replace(/[^\n]/g, " "));
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 10) line += 1;
  return line;
}

function macroKeys(path: string, source: string, expression: RegExp): Occurrence[] {
  const clean = withoutComments(source);
  const occurrences: Occurrence[] = [];
  for (const match of clean.matchAll(expression)) {
    const argument = match[1] || "";
    const argumentOffset = match.index + match[0].lastIndexOf(argument);
    for (const keyMatch of argument.matchAll(/[^,\s]+/g)) {
      const key = keyMatch[0];
      const from = argumentOffset + keyMatch.index;
      occurrences.push({ path, key, from, to: from + key.length, line: lineAt(source, from) });
    }
  }
  return occurrences;
}

export function latexDiagnostics(files: LatexSourceFile[]): BuildDiagnostic[] {
  const labels: Occurrence[] = [];
  const references: Occurrence[] = [];
  const citations: Occurrence[] = [];
  const bibliographyKeys = new Set<string>();

  for (const file of files) {
    if (/\.bib$/i.test(file.path)) {
      for (const match of withoutComments(file.source).matchAll(/@[a-z]+\s*[{(]\s*([^,\s]+)/gi)) bibliographyKeys.add(match[1]);
      continue;
    }
    if (!/\.tex$/i.test(file.path)) continue;
    labels.push(...macroKeys(file.path, file.source, /\\label\s*\{([^{}]+)\}/g));
    references.push(...macroKeys(file.path, file.source, /\\(?:ref|autoref|cref)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g));
    citations.push(...macroKeys(file.path, file.source, /\\(?:cite|citep|citet)\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]+)\}/g));
  }

  const labelCounts = new Map<string, number>();
  for (const label of labels) labelCounts.set(label.key, (labelCounts.get(label.key) || 0) + 1);
  const labelKeys = new Set(labels.map(label => label.key));
  const diagnostic = (item: Occurrence, message: string): BuildDiagnostic => ({
    path: item.path,
    line: item.line,
    from: item.from,
    to: item.to,
    message,
    severity: "warning",
    source: "latex",
  });

  return [
    ...labels.filter(label => (labelCounts.get(label.key) || 0) > 1).map(label => diagnostic(label, `Duplicate label: ${label.key}`)),
    ...references.filter(reference => !labelKeys.has(reference.key)).map(reference => diagnostic(reference, `Undefined reference: ${reference.key}`)),
    ...citations.filter(citation => !bibliographyKeys.has(citation.key)).map(citation => diagnostic(citation, `Undefined citation: ${citation.key}`)),
  ].sort((left, right) => (left.path || "").localeCompare(right.path || "") || (left.from || 0) - (right.from || 0));
}
