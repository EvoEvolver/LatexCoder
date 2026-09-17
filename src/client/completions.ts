import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { withoutComments } from "../shared/references.ts";
import { citationEntries } from "../shared/bibliography.ts";
import type { ProjectFile } from "../shared/api-schema.ts";

export type CompletionKind = "cite" | "label" | "image" | "bib" | "tex";
export type ArgumentContext = { kind: CompletionKind; from: number; omitExtension: boolean };

export function completionArgument(source: string, position: number): ArgumentContext | null {
  const prefix = withoutComments(source.slice(0, position));
  const match = /\\(citep|citet|cite|autoref|cref|ref|includegraphics|bibliography|addbibresource|input|include)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)$/.exec(prefix);
  if (!match || match[2].includes("\n")) return null;
  const macro = match[1];
  const kind: CompletionKind = macro.startsWith("cite") ? "cite" : ["ref", "autoref", "cref"].includes(macro) ? "label"
    : macro === "includegraphics" ? "image" : ["bibliography", "addbibresource"].includes(macro) ? "bib" : "tex";
  const argument = match[2];
  const start = position - argument.length;
  const comma = ["cite", "label", "bib"].includes(kind) ? argument.lastIndexOf(",") + 1 : 0;
  const whitespace = /^\s*/.exec(argument.slice(comma))![0].length;
  return { kind, from: start + comma + whitespace, omitExtension: macro === "bibliography" || kind === "tex" };
}

export function definitionKeys(source: string, kind: "cite" | "label"): string[] {
  const clean = withoutComments(source);
  const pattern = kind === "label" ? /\\label\s*\{([^{}]+)\}/g : /@([a-zA-Z]+)\s*[({]\s*([^\s,]+)\s*,/g;
  return [...clean.matchAll(pattern)].filter(match => kind === "label" || !/^(comment|string|preamble)$/i.test(match[1]))
    .map(match => (kind === "label" ? match[1] : match[2]).trim());
}

type ProjectCompletionData = {
  projectId(): string;
  activeFile(): string;
  files(): ProjectFile[];
  readFile(path: string): Promise<string>;
};

export function projectCompletionSource(data: ProjectCompletionData): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const argument = completionArgument(context.state.doc.toString(), context.pos);
    if (!argument) return null;
    const projectId = data.projectId();
    const activeFile = data.activeFile();
    const files = data.files();
    let options: Array<{ label: string; type: string; detail: string; info?: string }>;
    if (argument.kind === "cite" || argument.kind === "label") {
      const kind = argument.kind;
      const candidates = files.filter(file => file.text && file.path.endsWith(kind === "cite" ? ".bib" : ".tex"));
      const definitions = await Promise.all(candidates.map(async file => {
        const source = file.path === activeFile ? context.state.doc.toString() : await data.readFile(file.path);
        if (kind === "cite") return citationEntries(source).map(entry => {
          const authors = entry.authors.slice(0, 3).join("; ") + (entry.authors.length > 3 ? "; et al." : "");
          return {
            label: entry.key, type: "reference",
            detail: [entry.title, authors].filter(Boolean).join(" — ") || file.path,
            info: [entry.title, authors, file.path].filter(Boolean).join("\n"),
          };
        });
        return definitionKeys(source, kind).map(label => ({ label, type: "reference", detail: file.path }));
      }));
      options = definitions.flat();
    } else {
      const pattern = argument.kind === "image" ? /\.(?:pdf|png|jpe?g|svg|eps|webp|gif|bmp|avif)$/i : argument.kind === "bib" ? /\.bib$/i : /\.tex$/i;
      options = files.filter(file => pattern.test(file.path)).map(file => ({
        label: argument.omitExtension ? file.path.replace(/\.[^.]+$/, "") : file.path,
        type: "file", detail: file.path,
      }));
    }
    if (context.aborted || projectId !== data.projectId() || activeFile !== data.activeFile()) return null;
    const unique = [...new Map(options.map(option => [option.label, option])).values()];
    return { from: argument.from, options: unique, validFor: /^[^{}\s,]*$/ };
  };
}
