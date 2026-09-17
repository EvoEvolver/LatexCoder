export type CitationEntry = { key: string; title: string; authors: string[] };

function displayText(value: string): string {
  return value.replace(/\\[a-zA-Z]+\s*/g, "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

export function citationEntries(source: string): CitationEntry[] {
  const entries: CitationEntry[] = [];
  const header = /@([a-zA-Z]+)\s*([({])\s*([^\s,]+)\s*,/g;
  for (let match = header.exec(source); match; match = header.exec(source)) {
    if (/^(comment|string|preamble)$/i.test(match[1])) continue;
    const fields: Record<string, string> = {};
    let position = header.lastIndex;
    const closing = match[2] === "{" ? "}" : ")";
    // Consume whole field values so nested braces and quoted commas stay intact.
    while (position < source.length) {
      while (/[\s,]/.test(source[position] || "") && position < source.length) position++;
      if (source[position] === closing) { position++; break; }
      const field = /^([a-zA-Z][\w-]*)\s*=\s*/.exec(source.slice(position));
      if (!field) break;
      position += field[0].length;
      const start = position;
      let depth = 0;
      let quoted = false;
      while (position < source.length) {
        const character = source[position];
        if (character === "\\") { position += 2; continue; }
        if (character === '"' && depth === 0) quoted = !quoted;
        else if (character === "{") depth++;
        else if (character === "}" && depth > 0) depth--;
        else if (!quoted && depth === 0 && (character === "," || character === closing)) break;
        position++;
      }
      fields[field[1].toLowerCase()] = source.slice(start, position).trim().replace(/^"|"$/g, "");
    }
    header.lastIndex = Math.max(position, header.lastIndex);
    entries.push({
      key: match[3], title: displayText(fields.title || ""),
      authors: (fields.author || "").split(/\s+and\s+/i).map(displayText).filter(Boolean),
    });
  }
  return entries;
}
