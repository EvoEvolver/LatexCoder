import { withoutComments } from "./references.ts";

export type StructureEntry = {
  level: number;
  kind: "part" | "chapter" | "section" | "subsection" | "subsubsection" | "paragraph" | "subparagraph";
  title: string;
  path: string;
  line: number;
};

const LEVELS: Record<StructureEntry["kind"], number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

function bracedArgument(source: string, start: number): { value: string; end: number } | null {
  let cursor = start;
  while (/\s/.test(source[cursor] || "")) cursor++;
  if (source[cursor] !== "{") return null;
  let depth = 0;
  for (let index = cursor; index < source.length; index++) {
    if (source[index] === "\\") { index++; continue; }
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return { value: source.slice(cursor + 1, index), end: index + 1 };
  }
  return null;
}

function skipOptionalArgument(source: string, start: number): number {
  let cursor = start;
  while (/\s/.test(source[cursor] || "")) cursor++;
  if (source[cursor] !== "[") return cursor;
  let depth = 0;
  for (let index = cursor; index < source.length; index++) {
    if (source[index] === "\\") { index++; continue; }
    if (source[index] === "[") depth++;
    if (source[index] === "]" && --depth === 0) return index + 1;
  }
  return cursor;
}

function displayTitle(value: string): string {
  let title = value;
  for (let pass = 0; pass < 4; pass++) {
    title = title.replace(/\\(?:textbf|textit|texttt|textrm|textsf|emph|mbox)\*?\s*\{([^{}]*)\}/g, "$1");
  }
  return title
    .replace(/\\texorpdfstring\s*\{([^{}]*)\}\s*\{[^{}]*\}/g, "$1")
    .replace(/\\[a-zA-Z@]+\*?/g, "")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Untitled";
}

function normalizeProjectPath(value: string): string | null {
  const parts: string[] = [];
  for (const part of value.trim().split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function includedPath(origin: string, target: string, sources: ReadonlyMap<string, string>): string | null {
  const filename = /\.[^/]+$/.test(target) ? target : `${target}.tex`;
  const root = normalizeProjectPath(filename);
  const directory = origin.includes("/") ? origin.slice(0, origin.lastIndexOf("/")) : "";
  const relative = normalizeProjectPath(`${directory}/${filename}`);
  return [root, relative].find(candidate => candidate && sources.has(candidate)) || null;
}

export function projectStructure(main: string, sources: ReadonlyMap<string, string>): StructureEntry[] {
  const entries: StructureEntry[] = [];
  const visiting = new Set<string>();

  function visit(filePath: string): void {
    if (visiting.has(filePath)) return;
    const source = sources.get(filePath);
    if (source === undefined) return;
    visiting.add(filePath);
    const clean = withoutComments(source);
    const commands = /\\(subsubsection|subsection|section|chapter|part|subparagraph|paragraph|input|include)\*?(?![a-zA-Z@])/g;
    let match: RegExpExecArray | null;
    while ((match = commands.exec(clean))) {
      const command = match[1] as StructureEntry["kind"] | "input" | "include";
      const argumentStart = command === "input" || command === "include"
        ? match.index + match[0].length
        : skipOptionalArgument(clean, match.index + match[0].length);
      const argument = bracedArgument(clean, argumentStart);
      if (!argument) continue;
      commands.lastIndex = argument.end;
      if (command === "input" || command === "include") {
        const child = includedPath(filePath, argument.value, sources);
        if (child) visit(child);
        continue;
      }
      entries.push({
        level: LEVELS[command],
        kind: command,
        title: displayTitle(source.slice(argumentStart, argument.end).replace(/^\s*\{/, "").replace(/\}\s*$/, "")),
        path: filePath,
        line: source.slice(0, match.index).split("\n").length,
      });
    }
    visiting.delete(filePath);
  }

  visit(main);
  return entries;
}
