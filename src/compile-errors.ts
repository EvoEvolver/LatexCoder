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
