export function compileErrors(log: string) {
  const errors: Array<{ path: string; line: number; message: string }> = [];
  let current = "main.tex";
  let message = "";
  for (const row of log.split("\n")) {
    const opening = /\((?:\.\/)?([^\s()]+\.tex)\b/.exec(row);
    if (opening) current = opening[1];
    const direct = /^(?:error:\s*)?(?:\.\/)?(.+?\.tex):(\d+):\s*(.*)/.exec(row);
    if (direct) { errors.push({ path: direct[1], line: Number(direct[2]), message: direct[3] }); continue; }
    if (row.startsWith("!")) message = row.slice(1).trim();
    const line = /^l\.(\d+)\s*(.*)/.exec(row);
    if (line && message) { errors.push({ path: current, line: Number(line[1]), message }); message = ""; }
    const tectonic = /^error:\s*(.+?\.tex):(\d+):\s*(.*)/.exec(row);
    if (tectonic) errors.push({ path: tectonic[1], line: Number(tectonic[2]), message: tectonic[3] });
  }
  return errors;
}

export type BuildDiagnostic = { message: string; severity: "error" | "warning"; path?: string; line?: number };

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
