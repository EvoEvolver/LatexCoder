export function compileErrors(log: string) {
  const errors: Array<{ path: string; line: number; message: string }> = [];
  let current = "main.tex";
  let message = "";
  for (const row of log.split("\n")) {
    const opening = /\((?:\.\/)?([^\s()]+\.tex)\b/.exec(row);
    if (opening) current = opening[1];
    const direct = /^\s*(?:error:\s*)?(?:\.\/)?(.+?\.(?:tex|sty|cls|bib)):(\d+):(?:\d+:)?\s*(.*)/.exec(row);
    if (direct && !/^\s*(?:-->|→)/.test(row)) { errors.push({ path: direct[1], line: Number(direct[2]), message: direct[3] }); continue; }
    if (/^\s*!/.test(row)) message = row.trim().slice(1).trim();
    else if (/^\s*error:/.test(row)) message = row.trim().replace(/^error:\s*/, "");
    const pointer = /^\s*(?:-->|→)\s*(?:\.\/)?(.+?\.(?:tex|sty|cls|bib)):(\d+)(?::\d+)?/.exec(row);
    if (pointer && message) { errors.push({ path: pointer[1], line: Number(pointer[2]), message }); message = ""; }
    const line = /^\s*l\.(\d+)\s*(.*)/.exec(row);
    if (line && message) { errors.push({ path: current, line: Number(line[1]), message }); message = ""; }
  }
  return errors;
}

export type BuildDiagnostic = {
  message: string;
  severity: "error" | "warning";
  path?: string;
  line?: number;
  from?: number;
  to?: number;
  source?: "compiler" | "latex";
};

export function buildDiagnostics(log: string, mappedErrors?: ReturnType<typeof compileErrors>): BuildDiagnostic[] {
  const located = mappedErrors?.length ? mappedErrors : compileErrors(log);
  const diagnostics: BuildDiagnostic[] = located.map(error => ({ ...error, severity: /warning|overfull|underfull/i.test(error.message) ? "warning" : "error" }));
  for (const row of log.split("\n")) {
    const message = row.trim();
    const severity = /^(?:!|error:|fatal(?: error)?[: ]|.*Emergency stop|.*Fatal error occurred)/i.test(message) ? "error"
      : /^(?:.*Warning:|warning:|Overfull|Underfull)/.test(message) ? "warning" : null;
    if (!severity || !message) continue;
    const clean = message.replace(/^(?:!\s*|error:\s*)/, "");
    if (diagnostics.some(item => item.message === clean || message.includes(item.message))) continue;
    diagnostics.push({ message: clean, severity });
  }
  // TeX's final abort is a consequence, not the actionable first error.
  const offset = (diagnostic: BuildDiagnostic): number => {
    const index = log.indexOf(diagnostic.message);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return diagnostics.sort((left, right) => Number(left.severity === "warning") - Number(right.severity === "warning") || offset(left) - offset(right));
}
