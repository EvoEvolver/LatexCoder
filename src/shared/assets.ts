import { referenceLinks, withoutComments } from "./references.ts";

export const GRAPHICS_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "svg", "webp", "gif", "avif", "bmp"] as const;

export type LabeledGraphic = { label: string; asset: string };

export function labeledGraphics(rawSource: string): LabeledGraphic[] {
  const source = withoutComments(rawSource);
  const result: LabeledGraphic[] = [];
  const figures = /\\begin\{(figure\*?)\}([\s\S]*?)\\end\{\1\}/g;
  for (const figure of source.matchAll(figures)) {
    const body = figure[2];
    const assets = referenceLinks(body).filter(link => link.kind === "asset");
    if (!assets.length) continue;
    for (const label of body.matchAll(/\\label\s*\{([^{}]+)\}/g)) {
      const key = label[1].trim();
      if (!key) continue;
      const position = label.index!;
      const asset = assets.filter(candidate => candidate.to <= position).at(-1) ?? assets[0];
      result.push({ label: key, asset: asset.key });
    }
  }
  return result;
}

export function normalizeProjectPath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

export function resolveGraphicsPath(key: string, originFile: string, files: readonly { path: string }[]): string | null {
  const directory = originFile.split("/").slice(0, -1).join("/");
  const names = /\.[^/]+$/.test(key) ? [key] : [key, ...GRAPHICS_EXTENSIONS.map(extension => `${key}.${extension}`)];
  const candidates = names.flatMap(name => [normalizeProjectPath(name), normalizeProjectPath(`${directory}/${name}`)]);
  const paths = new Set(files.map(file => file.path));
  return candidates.find(candidate => paths.has(candidate)) ?? null;
}
