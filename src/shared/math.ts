import { withoutComments } from "./references.ts";

export type MathRegion = {
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  source: string;
  display: boolean;
  environment: string | null;
  labels: string[];
};

type DelimitedMath = { pattern: RegExp; openLength: number; closeLength: number; display: boolean };

const DELIMITED_MATH: DelimitedMath[] = [
  { pattern: /\\\[([\s\S]*?)\\\]/g, openLength: 2, closeLength: 2, display: true },
  { pattern: /\\\(([\s\S]*?)\\\)/g, openLength: 2, closeLength: 2, display: false },
];

function labels(source: string): string[] {
  return [...withoutComments(source).matchAll(/\\label\s*\{([^{}]+)\}/g)].map(match => match[1].trim()).filter(Boolean);
}

function overlaps(regions: MathRegion[], from: number, to: number): boolean {
  return regions.some(region => from < region.to && to > region.from);
}

function escaped(source: string, position: number): boolean {
  let slashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === "\\"; index--) slashes++;
  return slashes % 2 === 1;
}

function dollarRegions(source: string, regions: MathRegion[]): void {
  for (let position = 0; position < source.length; position++) {
    if (source[position] !== "$" || escaped(source, position) || overlaps(regions, position, position + 1)) continue;
    const display = source[position + 1] === "$";
    const delimiter = display ? "$$" : "$";
    const bodyFrom = position + delimiter.length;
    let close = bodyFrom;
    while (close < source.length) {
      if (!display && source[close] === "\n") break;
      if (source.startsWith(delimiter, close) && !escaped(source, close)) break;
      close++;
    }
    if (close >= source.length || !source.startsWith(delimiter, close)) continue;
    const to = close + delimiter.length;
    if (!overlaps(regions, position, to)) {
      const body = source.slice(bodyFrom, close);
      regions.push({ from: position, to, bodyFrom, bodyTo: close, source: body, display, environment: null, labels: labels(body) });
    }
    position = to - 1;
  }
}

export function mathRegions(rawSource: string): MathRegion[] {
  const source = withoutComments(rawSource);
  const regions: MathRegion[] = [];
  const environments = /\\begin\{(equation\*?|align\*?|alignat\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}/g;
  for (const match of source.matchAll(environments)) {
    const bodyOffset = match[0].indexOf(match[2]);
    const from = match.index!;
    const bodyFrom = from + bodyOffset;
    const bodyTo = bodyFrom + match[2].length;
    regions.push({
      from, to: from + match[0].length, bodyFrom, bodyTo,
      source: rawSource.slice(bodyFrom, bodyTo), display: true,
      environment: match[1], labels: labels(rawSource.slice(bodyFrom, bodyTo)),
    });
  }
  for (const delimiter of DELIMITED_MATH) {
    for (const match of source.matchAll(delimiter.pattern)) {
      const from = match.index!;
      const to = from + match[0].length;
      if (overlaps(regions, from, to)) continue;
      const bodyFrom = from + delimiter.openLength;
      const bodyTo = to - delimiter.closeLength;
      const body = rawSource.slice(bodyFrom, bodyTo);
      regions.push({ from, to, bodyFrom, bodyTo, source: body, display: delimiter.display, environment: null, labels: labels(body) });
    }
  }
  dollarRegions(source, regions);
  return regions.sort((left, right) => left.from - right.from || left.to - right.to);
}

export function renderableMath(region: MathRegion): string {
  const source = region.source.replace(/\\label\s*\{[^{}]+\}/g, "").trim();
  if (!region.environment || /^equation/.test(region.environment)) return source;
  const environment = /^gather/.test(region.environment) ? "gathered" : "aligned";
  return `\\begin{${environment}}${source}\\end{${environment}}`;
}
