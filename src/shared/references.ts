export type ReferenceLink = { from: number; to: number; key: string; kind: "file" | "asset" | "url" | "cite" | "label" };

export function withoutComments(source: string) {
  // Keep offsets intact while ignoring unescaped TeX comments.
  const characters = source.split("");
  for (let index = 0; index < source.length; index++) {
    const url = source[index] === "\\" ? /^\\url\s*\{[^{}]*\}/.exec(source.slice(index)) : null;
    if (url) { index += url[0].length - 1; continue; }
    if (source[index] !== "%") continue;
    let slashes = 0;
    for (let before = index - 1; before >= 0 && source[before] === "\\"; before--) slashes++;
    if (slashes % 2) continue;
    while (index < source.length && source[index] !== "\n") characters[index++] = " ";
  }
  return characters.join("");
}

export function referenceLinks(source: string): ReferenceLink[] {
  const result: ReferenceLink[] = [];
  const clean = withoutComments(source);
  const macros = /\\(includegraphics|include|input|url|citep|citet|cite|autoref|cref|ref)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/g;
  for (const match of clean.matchAll(macros)) {
    const start = match.index! + match[0].lastIndexOf("{") + 1;
    const kind = match[1] === "includegraphics" ? "asset" : match[1] === "url" ? "url" : match[1] === "include" || match[1] === "input" ? "file" : match[1].startsWith("cite") ? "cite" : "label";
    const keys = kind === "file" || kind === "asset" || kind === "url" ? /[^\s][\s\S]*?\s*$/g : /[^,\s]+/g;
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
