import { parseReviews } from "./review.ts";

// SyncTeX sees the compile projection, not the review macros in the editor.
export function compileSourceMap(source: string) {
  let text = "";
  const offsets: number[] = [];
  const append = (from: number, to: number) => {
    text += source.slice(from, to);
    for (let offset = from; offset < to; offset++) offsets.push(offset);
  };
  let cursor = 0;
  for (const item of parseReviews(source)) {
    append(cursor, item.from);
    if (item.kind !== "deletion") append(item.bodyFrom, item.bodyTo);
    cursor = item.to;
  }
  append(cursor, source.length);
  const lines = [1];
  let originalLine = 1;
  let originalOffset = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index !== 0 && text[index - 1] !== "\n") continue;
    const target = offsets[index] ?? source.length;
    while (originalOffset < target) if (source[originalOffset++] === "\n") originalLine++;
    lines[index === 0 ? 0 : lines.length] = originalLine;
  }
  return { text, lines, offsets };
}

export function projectedPosition(source: string, originalOffset: number) {
  const projection = compileSourceMap(source);
  let offset = projection.offsets.findIndex(value => value >= originalOffset);
  if (offset < 0) offset = projection.text.length;
  const prefix = projection.text.slice(0, offset);
  return { line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") };
}
