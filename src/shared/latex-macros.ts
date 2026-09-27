import { withoutComments } from "./references.ts";

export type LatexMacroDefinition = {
  name: string;
  parameters: number;
  optionalDefault: string | null;
  body: string;
};

export type MacroExpansionOptions = {
  maxDepth?: number;
  maxExpansions?: number;
  maxLength?: number;
};

type Group = { value: string; end: number };
type ControlSequence = { name: string; end: number };

const DEFAULT_LIMITS = { maxDepth: 24, maxExpansions: 500, maxLength: 100_000 };

export class MacroExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MacroExpansionError";
  }
}

function escaped(source: string, position: number): boolean {
  let slashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === "\\"; index--) slashes++;
  return slashes % 2 === 1;
}

function skipWhitespace(source: string, position: number): number {
  while (position < source.length && /\s/.test(source[position])) position++;
  return position;
}

function groupAt(source: string, position: number, open = "{", close = "}"): Group | null {
  if (source[position] !== open) return null;
  let depth = 1;
  for (let index = position + 1; index < source.length; index++) {
    if (escaped(source, index)) continue;
    if (source[index] === open) depth++;
    if (source[index] !== close || --depth !== 0) continue;
    return { value: source.slice(position + 1, index), end: index + 1 };
  }
  return null;
}

function controlSequenceAt(source: string, position: number): ControlSequence | null {
  if (source[position] !== "\\" || position + 1 >= source.length) return null;
  const word = /^[A-Za-z@]+/.exec(source.slice(position + 1));
  if (word) return { name: word[0], end: position + 1 + word[0].length };
  return { name: source[position + 1], end: position + 2 };
}

function declaredName(source: string, position: number): { name: string; end: number } | null {
  const start = skipWhitespace(source, position);
  if (source[start] === "{") {
    const group = groupAt(source, start);
    if (!group) return null;
    const innerStart = skipWhitespace(group.value, 0);
    const control = controlSequenceAt(group.value, innerStart);
    if (!control || skipWhitespace(group.value, control.end) !== group.value.length) return null;
    return { name: control.name, end: group.end };
  }
  const control = controlSequenceAt(source, start);
  return control && /^[A-Za-z@]+$/.test(control.name) ? { name: control.name, end: control.end } : null;
}

function setDefinition(definitions: Map<string, LatexMacroDefinition>, definition: LatexMacroDefinition, mode: string): void {
  if (mode === "providecommand" && definitions.has(definition.name)) return;
  definitions.set(definition.name, definition);
}

function parseNewCommand(source: string, position: number): { definition: LatexMacroDefinition; end: number } | null {
  let cursor = skipWhitespace(source, position);
  if (source[cursor] === "*") cursor = skipWhitespace(source, cursor + 1);
  const name = declaredName(source, cursor);
  if (!name) return null;
  cursor = skipWhitespace(source, name.end);

  let parameters = 0;
  if (source[cursor] === "[") {
    const count = groupAt(source, cursor, "[", "]");
    if (!count || !/^[0-9]$/.test(count.value.trim())) return null;
    parameters = Number(count.value.trim());
    cursor = skipWhitespace(source, count.end);
  }

  let optionalDefault: string | null = null;
  if (source[cursor] === "[") {
    if (parameters < 1) return null;
    const defaultValue = groupAt(source, cursor, "[", "]");
    if (!defaultValue) return null;
    optionalDefault = defaultValue.value;
    cursor = skipWhitespace(source, defaultValue.end);
  }

  const body = groupAt(source, cursor);
  if (!body) return null;
  return { definition: { name: name.name, parameters, optionalDefault, body: body.value }, end: body.end };
}

function parseDef(source: string, position: number): { definition: LatexMacroDefinition; end: number } | null {
  const name = declaredName(source, position);
  if (!name) return null;
  let cursor = name.end;
  while (cursor < source.length && source[cursor] !== "{") cursor++;
  const signature = source.slice(name.end, cursor).trim();
  const parameters = signature ? [...signature.matchAll(/#([1-9])/g)] : [];
  if (signature !== parameters.map((_, index) => `#${index + 1}`).join("")) return null;
  const body = groupAt(source, cursor);
  if (!body) return null;
  return {
    definition: { name: name.name, parameters: parameters.length, optionalDefault: null, body: body.value },
    end: body.end,
  };
}

function parseMathOperator(source: string, position: number, starred: boolean): { definition: LatexMacroDefinition; end: number } | null {
  const name = declaredName(source, position);
  if (!name) return null;
  const body = groupAt(source, skipWhitespace(source, name.end));
  if (!body) return null;
  return {
    definition: {
      name: name.name,
      parameters: 0,
      optionalDefault: null,
      body: `\\operatorname${starred ? "*" : ""}{${body.value}}`,
    },
    end: body.end,
  };
}

export function parseLatexMacros(sources: readonly string[]): Map<string, LatexMacroDefinition> {
  const definitions = new Map<string, LatexMacroDefinition>();
  for (const rawSource of sources) {
    const source = withoutComments(rawSource);
    const declarations = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def)\b/g;
    for (const match of source.matchAll(declarations)) {
      const mode = match[1];
      const afterDeclaration = match.index! + match[0].length;
      const starred = source[skipWhitespace(source, afterDeclaration)] === "*";
      const parsed = mode === "def"
        ? parseDef(source, afterDeclaration)
        : mode === "DeclareMathOperator"
          ? parseMathOperator(source, starred ? skipWhitespace(source, afterDeclaration) + 1 : afterDeclaration, starred)
          : parseNewCommand(source, afterDeclaration);
      if (!parsed) continue;
      setDefinition(definitions, parsed.definition, mode);
    }
  }
  return definitions;
}

function invocationArgument(source: string, position: number): Group | null {
  const cursor = skipWhitespace(source, position);
  if (source[cursor] === "{") return groupAt(source, cursor);
  const control = controlSequenceAt(source, cursor);
  if (control) return { value: source.slice(cursor, control.end), end: control.end };
  const point = source.codePointAt(cursor);
  if (point === undefined) return null;
  const value = String.fromCodePoint(point);
  return { value, end: cursor + value.length };
}

function substituteArguments(body: string, arguments_: readonly string[]): string {
  let result = "";
  for (let index = 0; index < body.length; index++) {
    if (body[index] !== "#" || index + 1 >= body.length) {
      result += body[index];
      continue;
    }
    const marker = body[++index];
    if (marker === "#") result += "#";
    else if (/^[1-9]$/.test(marker)) result += arguments_[Number(marker) - 1] ?? `#${marker}`;
    else result += `#${marker}`;
  }
  return result;
}

export function expandLatexMacros(
  source: string,
  definitions: ReadonlyMap<string, LatexMacroDefinition>,
  options: MacroExpansionOptions = {},
): string {
  const limits = { ...DEFAULT_LIMITS, ...options };
  let expansions = 0;

  const expand = (input: string, depth: number): string => {
    let result = "";
    for (let index = 0; index < input.length;) {
      const control = controlSequenceAt(input, index);
      const definition = control ? definitions.get(control.name) : undefined;
      if (!control || !definition) {
        result += input[index++];
        if (result.length > limits.maxLength) throw new MacroExpansionError("Expanded formula is too long");
        continue;
      }
      if (depth >= limits.maxDepth) throw new MacroExpansionError(`Custom macro expansion is too deeply nested near \\${definition.name}`);
      if (++expansions > limits.maxExpansions) throw new MacroExpansionError("Custom macro expansion limit exceeded");

      let cursor = control.end;
      const arguments_: string[] = [];
      if (definition.optionalDefault !== null) {
        const optionalStart = skipWhitespace(input, cursor);
        const optional = groupAt(input, optionalStart, "[", "]");
        if (optional) {
          arguments_.push(optional.value);
          cursor = optional.end;
        } else {
          arguments_.push(definition.optionalDefault);
          cursor = optionalStart;
        }
      }
      while (arguments_.length < definition.parameters) {
        const argument = invocationArgument(input, cursor);
        if (!argument) throw new MacroExpansionError(`Missing argument for custom macro \\${definition.name}`);
        arguments_.push(argument.value);
        cursor = argument.end;
      }
      result += expand(substituteArguments(definition.body, arguments_), depth + 1);
      if (result.length > limits.maxLength) throw new MacroExpansionError("Expanded formula is too long");
      index = cursor;
    }
    return result;
  };

  return expand(source, 0);
}
