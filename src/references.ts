export type ReferenceLink = { from: number; to: number; key: string; kind: "file" | "cite" | "label" };

function withoutComments(source: string) {
  // Keep offsets intact while ignoring unescaped TeX comments.
  return source.replace(/(^|[^\\])(?:\\\\)*%[^\n]*/gm, match => match.replace(/[^\n]/g, " "));
}

export function referenceLinks(source: string): ReferenceLink[] {
  const result: ReferenceLink[] = [];
  const clean = withoutComments(source);
  const macros = /\\(include|input|citep|citet|cite|autoref|cref|ref)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/g;
  for (const match of clean.matchAll(macros)) {
    const start = match.index! + match[0].lastIndexOf("{") + 1;
    const kind = match[1] === "include" || match[1] === "input" ? "file" : match[1].startsWith("cite") ? "cite" : "label";
    const keys = kind === "file" ? /[^\s][\s\S]*?\s*$/g : /[^,\s]+/g;
    for (const key of match[2].matchAll(keys)) {
      const value = key[0].trim();
      result.push({ from: start + key.index!, to: start + key.index! + value.length, key: value, kind });
    }
  }
  return result;
}

export function referenceDefinition(source: string, key: string, kind: "cite" | "label") {
  const clean = withoutComments(source);
  const pattern = kind === "label" ? /\\label\s*\{([^{}]+)\}/g : /@([a-zA-Z]+)\s*[({]\s*([^\s,]+)\s*,/g;
  for (const match of clean.matchAll(pattern)) {
    if ((kind === "label" ? match[1] : match[2]).trim() === key) {
      return { from: match.index!, to: match.index! + match[0].length };
    }
  }
  return null;
}
