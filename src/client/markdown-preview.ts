import DOMPurify from "dompurify";
import { marked } from "marked";

type MarkdownPreviewOptions = {
  activeFile: string;
  container: HTMLElement;
  files: readonly { path: string }[];
  fileUrl(relativePath: string): string;
  source: string;
};

function projectPath(activeFile: string, rawTarget: string): string | null {
  if (!rawTarget || rawTarget.startsWith("#") || rawTarget.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(rawTarget)) return null;
  const encodedPath = rawTarget.split(/[?#]/, 1)[0].replaceAll("\\", "/");
  let target: string;
  try { target = decodeURIComponent(encodedPath); }
  catch { target = encodedPath; }
  const parts = target.startsWith("/") ? [] : activeFile.split("/").slice(0, -1);
  for (const part of target.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/") || null;
}

export function renderMarkdownPreview(options: MarkdownPreviewOptions): void {
  const rendered = marked.parse(options.source, { async: false, gfm: true }) as string;
  options.container.innerHTML = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  for (const image of options.container.querySelectorAll<HTMLImageElement>("img[src]")) {
    const relativePath = projectPath(options.activeFile, image.getAttribute("src") || "");
    if (relativePath) image.src = options.fileUrl(relativePath);
    image.removeAttribute("srcset");
    image.loading = "lazy";
  }
  for (const anchor of options.container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = anchor.getAttribute("href") || "";
    const relativePath = projectPath(options.activeFile, href);
    if (relativePath && options.files.some(file => file.path === relativePath)) {
      anchor.href = "#";
      anchor.dataset.projectPath = relativePath;
    } else if (/^(?:https?:|mailto:)/i.test(href)) {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    }
  }
}
