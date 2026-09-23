import { withoutComments } from "./references.ts";

export type SourceRange = { path: string; from: number; to: number };
export type StructureSummary = {
  title: string;
  line: number;
  range: SourceRange;
  commandRange: SourceRange;
  macroRange: SourceRange;
};

export type StructureInsertion = {
  at: number;
  label: string;
  path: string;
  template: string;
};

type StructureNodeBase = {
  id: string;
  level: number;
  title: string;
  path: string;
  line: number;
  commandRange: SourceRange;
  sourceRange: SourceRange;
  children: StructureEntry[];
};

export type StructureHeading = StructureNodeBase & {
  type: "heading";
  kind: "part" | "chapter" | "section" | "subsection" | "subsubsection" | "paragraph" | "subparagraph";
  summary: StructureSummary | null;
};

export type StructurePoint = StructureNodeBase & {
  type: "point";
  kind: "paragraph";
  summaryRange: SourceRange;
  macroRange: SourceRange;
  children: [];
};

export type StructureEntry = StructureHeading | StructurePoint;

const LEVELS: Record<StructureHeading["kind"], number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

const CHILD_HEADING: Partial<Record<StructureHeading["kind"], StructureHeading["kind"]>> = {
  part: "chapter",
  chapter: "section",
  section: "subsection",
  subsection: "subsubsection",
  subsubsection: "paragraph",
  paragraph: "subparagraph",
};

type ParsedArgument = { value: string; from: number; to: number; end: number };
type ParsedCommand = {
  command: StructureHeading["kind"] | "input" | "include" | "tldr" | "sectiontldr";
  start: number;
  end: number;
  argument: ParsedArgument;
  level: number | null;
};

function bracedArgument(source: string, start: number): ParsedArgument | null {
  let cursor = start;
  while (/\s/.test(source[cursor] || "")) cursor++;
  if (source[cursor] !== "{") return null;
  let depth = 0;
  for (let index = cursor; index < source.length; index++) {
    if (source[index] === "\\") { index++; continue; }
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) {
      return { value: source.slice(cursor + 1, index), from: cursor + 1, to: index, end: index + 1 };
    }
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

function trimRange(source: string, from: number, to: number): { from: number; to: number } {
  while (from < to && /\s/.test(source[from])) from++;
  while (to > from && /\s/.test(source[to - 1])) to--;
  return { from, to };
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function parseCommands(source: string): ParsedCommand[] {
  const clean = withoutComments(source);
  const commands: ParsedCommand[] = [];
  const pattern = /\\(sectiontldr|subsubsection|subsection|section|chapter|part|subparagraph|paragraph|input|include|tldr)\*?(?![a-zA-Z@])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean))) {
    const command = match[1] as ParsedCommand["command"];
    const argumentStart = command === "input" || command === "include" || command === "tldr" || command === "sectiontldr"
      ? match.index + match[0].length
      : skipOptionalArgument(clean, match.index + match[0].length);
    const argument = bracedArgument(clean, argumentStart);
    if (!argument) continue;
    pattern.lastIndex = argument.end;
    commands.push({
      command,
      start: match.index,
      end: argument.end,
      argument,
      level: command in LEVELS ? LEVELS[command as StructureHeading["kind"]] : null,
    });
  }
  return commands;
}

function paragraphStart(source: string, clean: string, floor: number, macroStart: number): number {
  let boundary = floor;
  const segment = clean.slice(floor, macroStart);
  for (const match of segment.matchAll(/\n[ \t]*\n|\\par(?![a-zA-Z@])/g)) {
    boundary = floor + match.index! + match[0].length;
  }
  return trimRange(source, boundary, macroStart).from;
}

export function flattenStructure(entries: readonly StructureEntry[]): StructureEntry[] {
  const result: StructureEntry[] = [];
  const visit = (entry: StructureEntry): void => {
    result.push(entry);
    for (const child of entry.children) visit(child);
  };
  for (const entry of entries) visit(entry);
  return result;
}

export function documentTitle(source: string): string | null {
  const clean = withoutComments(source);
  const pattern = /\\title\*?(?![a-zA-Z@])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean))) {
    const argument = bracedArgument(clean, skipOptionalArgument(clean, match.index + match[0].length));
    if (argument) return displayTitle(source.slice(argument.from, argument.to));
  }
  return null;
}

export function structureInsertions(entry: StructureEntry): StructureInsertion[] {
  if (entry.type === "point") {
    return [{
      at: entry.commandRange.to,
      label: "Add TL;DR",
      path: entry.path,
      template: "\n\\tldr{}",
    }];
  }
  const at = entry.sourceRange.to;
  const firstNestedHeading = entry.children
    .filter((child): child is StructureHeading => child.type === "heading" && child.path === entry.path)
    .sort((left, right) => left.commandRange.from - right.commandRange.from)[0];
  const tldrAt = firstNestedHeading?.commandRange.from ?? at;
  const insertions: StructureInsertion[] = [];
  if (!entry.summary) {
    insertions.push({
      at: entry.commandRange.to,
      label: "Add section TL;DR",
      path: entry.path,
      template: "\n\\sectiontldr{}",
    });
  }
  const child = CHILD_HEADING[entry.kind];
  if (child) {
    insertions.push({
      at,
      label: `Add ${child}`,
      path: entry.path,
      template: `\n\n\\${child}{}\n`,
    });
  }
  insertions.push({
    at: tldrAt,
    label: "Add TL;DR",
    path: entry.path,
    template: firstNestedHeading ? "\n\\tldr{}\n" : "\n\\tldr{}",
  });
  return insertions;
}

export function rootStructureInsertion(main: string, source: string): StructureInsertion {
  const endDocument = /\\end\s*\{document\}/g;
  let match: RegExpExecArray | null;
  let at = source.length;
  while ((match = endDocument.exec(source))) at = match.index;
  return {
    at,
    label: "Add section",
    path: main,
    template: `${at > 0 && source[at - 1] !== "\n" ? "\n" : ""}\\section{}\n`,
  };
}

export function projectStructure(main: string, sources: ReadonlyMap<string, string>): StructureEntry[] {
  const roots: StructureEntry[] = [];
  const visiting = new Set<string>();
  const headingStack: StructureHeading[] = [];
  let currentHeading: StructureHeading | null = null;

  function append(entry: StructureEntry): void {
    const parent = headingStack.at(-1);
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }

  function visit(filePath: string): void {
    if (visiting.has(filePath)) return;
    const source = sources.get(filePath);
    if (source === undefined) return;
    visiting.add(filePath);
    const clean = withoutComments(source);
    const commands = parseCommands(source);
    let localHeading: StructureHeading | null = null;
    let previousParagraph: StructurePoint | null = null;
    let paragraphFloor = 0;
    let annotationEnd = -1;
    let annotationGroup: Array<StructureSummary | StructurePoint> = [];

    function addToAnnotationGroup(annotation: StructureSummary | StructurePoint, parsed: ParsedCommand): void {
      const continues = annotationGroup.length > 0 && clean.slice(annotationEnd, parsed.start).trim() === "";
      if (!continues) annotationGroup = [];
      annotationGroup.push(annotation);
      annotationEnd = parsed.end;
      const from = annotationGroup[0].commandRange.from;
      const macroRange = { path: filePath, from, to: parsed.end };
      for (const member of annotationGroup) member.macroRange = macroRange;
    }

    function resetAnnotationGroup(): void {
      annotationEnd = -1;
      annotationGroup = [];
    }

    for (let index = 0; index < commands.length; index++) {
      const parsed = commands[index];
      if (parsed.command === "input" || parsed.command === "include") {
        resetAnnotationGroup();
        const child = includedPath(filePath, parsed.argument.value, sources);
        if (child) visit(child);
        paragraphFloor = parsed.end;
        previousParagraph = null;
        continue;
      }

      if (parsed.level !== null) {
        resetAnnotationGroup();
        while (headingStack.length && headingStack.at(-1)!.level >= parsed.level) headingStack.pop();
        const nextBoundary = commands.slice(index + 1).find(candidate => candidate.level !== null && candidate.level <= parsed.level)?.start ?? source.length;
        const body = trimRange(source, parsed.end, nextBoundary);
        const heading: StructureHeading = {
          id: `${filePath}:heading:${parsed.start}`,
          type: "heading",
          level: parsed.level,
          kind: parsed.command as StructureHeading["kind"],
          title: displayTitle(source.slice(parsed.argument.from, parsed.argument.to)),
          path: filePath,
          line: lineAt(source, parsed.start),
          commandRange: { path: filePath, from: parsed.start, to: parsed.end },
          sourceRange: { path: filePath, ...body },
          summary: null,
          children: [],
        };
        append(heading);
        headingStack.push(heading);
        currentHeading = heading;
        localHeading = heading;
        paragraphFloor = parsed.end;
        previousParagraph = null;
        continue;
      }

      if (parsed.command === "sectiontldr") {
        const directlyBelowHeading = Boolean(
          currentHeading
          && localHeading === currentHeading
          && clean.slice(currentHeading.commandRange.to, parsed.start).trim() === "",
        );
        if (currentHeading && directlyBelowHeading) {
          const summary: StructureSummary = {
            title: displayTitle(source.slice(parsed.argument.from, parsed.argument.to)),
            line: lineAt(source, parsed.start),
            range: { path: filePath, from: parsed.argument.from, to: parsed.argument.to },
            commandRange: { path: filePath, from: parsed.start, to: parsed.end },
            macroRange: { path: filePath, from: parsed.start, to: parsed.end },
          };
          currentHeading.summary = summary;
          addToAnnotationGroup(summary, parsed);
          if (localHeading === currentHeading) {
            const nextBoundary = commands.slice(index + 1).find(candidate => candidate.level !== null && candidate.level <= currentHeading!.level)?.start ?? source.length;
            currentHeading.sourceRange = { path: filePath, ...trimRange(source, parsed.end, nextBoundary) };
          }
          paragraphFloor = parsed.end;
          previousParagraph = null;
        } else {
          resetAnnotationGroup();
        }
        continue;
      }

      const gapFromPrevious = previousParagraph ? clean.slice(previousParagraph.commandRange.to, parsed.start) : "";
      const sameParagraph = Boolean(previousParagraph && !/\n[ \t]*\n|\\par(?![a-zA-Z@])/.test(gapFromPrevious));
      const body = sameParagraph
        ? previousParagraph!.sourceRange
        : { path: filePath, ...trimRange(source, paragraphStart(source, clean, paragraphFloor, parsed.start), parsed.start) };
      const point: StructurePoint = {
        id: `${filePath}:paragraph:${parsed.start}`,
        type: "point",
        level: currentHeading ? currentHeading.level + 1 : 0,
        kind: "paragraph",
        title: displayTitle(source.slice(parsed.argument.from, parsed.argument.to)),
        path: filePath,
        line: lineAt(source, parsed.start),
        commandRange: { path: filePath, from: parsed.start, to: parsed.end },
        summaryRange: { path: filePath, from: parsed.argument.from, to: parsed.argument.to },
        macroRange: { path: filePath, from: parsed.start, to: parsed.end },
        sourceRange: body,
        children: [],
      };
      append(point);
      addToAnnotationGroup(point, parsed);
      if (currentHeading?.summary && annotationGroup[0] === currentHeading.summary && localHeading === currentHeading) {
        const nextBoundary = commands.slice(index + 1)
          .find(candidate => candidate.level !== null && candidate.level <= currentHeading!.level)?.start ?? source.length;
        currentHeading.sourceRange = { path: filePath, ...trimRange(source, parsed.end, nextBoundary) };
      }
      previousParagraph = point;
    }
    visiting.delete(filePath);
  }

  visit(main);
  return roots;
}
