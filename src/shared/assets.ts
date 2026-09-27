export const GRAPHICS_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "svg", "webp", "gif", "avif", "bmp"] as const;

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
