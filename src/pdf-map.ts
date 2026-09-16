export function syncTexPositions(output: string) {
  const positions: Array<{ page: number; x: number; y: number; left: number; top: number; width: number; height: number }> = [];
  for (const record of output.split(/(?=^Page:)/m)) {
    const read = (key: string) => Number(new RegExp(`^${key}:([\\d.eE+-]+)$`, "m").exec(record)?.[1]);
    const page = read("Page"), x = read("x"), y = read("y");
    if (!page || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const h = read("h"), v = read("v"), w = read("W"), height = read("H");
    positions.push({ page, x, y, left: Number.isFinite(h) ? h : x - 30, top: Number.isFinite(v) && Number.isFinite(height) ? v - height : y - 8, width: Number.isFinite(w) && w > 0 ? w : 60, height: Number.isFinite(height) && height > 0 ? height : 16 });
  }
  return positions;
}
