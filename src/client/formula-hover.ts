import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip } from "@codemirror/view";
import katex from "katex";
import "katex/dist/katex.min.css";

import { expandLatexMacros, parseLatexMacros, type LatexMacroDefinition } from "../shared/latex-macros.ts";
import { mathRegions, renderableMath, type MathRegion } from "../shared/math.ts";
import { referenceLinks } from "../shared/references.ts";
import type { ProjectFile } from "../shared/api-schema.ts";

type FormulaHoverData = {
  projectId(): string;
  activeFile(): string;
  files(): ProjectFile[];
  readFile(path: string): Promise<string>;
};

type LocatedFormula = { region: MathRegion; path: string; label?: string };
type TexSource = { path: string; source: string };
type TexSourceCache = { projectId: string; signature: string; loadedAt: number; sources: TexSource[] };

const SOURCE_CACHE_MS = 3_000;

function formulaTooltipDom(formula: LocatedFormula, macros: ReadonlyMap<string, LatexMacroDefinition>): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-formula-tooltip";
  const header = document.createElement("header");
  const kind = document.createElement("strong");
  kind.textContent = formula.region.display ? "Display formula" : "Inline formula";
  const location = document.createElement("span");
  location.textContent = formula.label
    ? `\\label{${formula.label}}`
    : formula.region.environment
      ? `\\begin{${formula.region.environment}}`
      : "";
  header.append(kind);
  if (location.textContent) header.append(location);
  const preview = document.createElement("div");
  preview.className = "cm-formula-preview";
  try {
    katex.render(expandLatexMacros(renderableMath(formula.region), macros), preview, {
      displayMode: formula.region.display,
      output: "htmlAndMathml",
      strict: false,
      throwOnError: true,
      trust: false,
    });
  } catch (error) {
    preview.classList.add("fallback");
    const source = document.createElement("pre");
    source.textContent = formula.region.source.trim();
    const message = document.createElement("p");
    message.textContent = `Preview unavailable: ${error instanceof Error ? error.message : "unsupported formula"}`;
    preview.append(source, message);
  }
  const footer = document.createElement("footer");
  footer.textContent = formula.path;
  dom.append(header, preview, footer);
  return dom;
}

export function formulaHover(data: FormulaHoverData): Extension {
  let sourceCache: TexSourceCache | null = null;

  const projectTexSources = async (activeSource: string): Promise<TexSource[]> => {
    const projectId = data.projectId();
    const activeFile = data.activeFile();
    const files = data.files()
      .filter(file => file.text && /\.(?:tex|sty|cls)$/i.test(file.path))
      .sort((left, right) => left.path.localeCompare(right.path));
    const signature = files.map(file => `${file.path}:${file.size}`).join("\0");
    if (sourceCache?.projectId === projectId && sourceCache.signature === signature && Date.now() - sourceCache.loadedAt < SOURCE_CACHE_MS) {
      return sourceCache.sources.map(source => source.path === activeFile ? { ...source, source: activeSource } : source);
    }
    const sources = await Promise.all(files.map(async file => ({
      path: file.path,
      source: file.path === activeFile ? activeSource : await data.readFile(file.path),
    })));
    sourceCache = { projectId, signature, loadedAt: Date.now(), sources };
    return sources;
  };

  return [
    hoverTooltip(async (view, position) => {
      const activeSource = view.state.doc.toString();
      const direct = mathRegions(activeSource).find(region => position >= region.from && position <= region.to);
      let formula: LocatedFormula | undefined = direct ? { region: direct, path: data.activeFile() } : undefined;
      let from = direct?.from;
      let to = direct?.to;

      const projectId = data.projectId();
      const activeFile = data.activeFile();
      const sources = await projectTexSources(activeSource);
      if (projectId !== data.projectId() || activeFile !== data.activeFile()) return null;

      if (!formula) {
        const link = referenceLinks(activeSource)
          .find(candidate => candidate.kind === "label" && position >= candidate.from && position <= candidate.to);
        if (!link) return null;
        for (const file of sources) {
          const region = mathRegions(file.source).find(candidate => candidate.labels.includes(link.key));
          if (region) { formula = { region, path: file.path, label: link.key }; break; }
        }
        if (!formula) return null;
        from = link.from;
        to = link.to;
      }

      const located = formula;
      const macros = parseLatexMacros(sources.map(source => source.source));
      return { pos: from!, end: to!, above: true, create: () => ({ dom: formulaTooltipDom(located, macros) }) };
    }, { hoverTime: 650, hideOnChange: true }),
    EditorView.baseTheme({
      ".cm-formula-tooltip": {
        width: "min(480px, calc(100vw - 32px))", padding: "10px 11px",
        border: "1px solid var(--border)", borderRadius: "6px",
        backgroundColor: "var(--card)", boxShadow: "0 10px 28px rgb(0 0 0 / 25%)",
        color: "var(--card-foreground)", fontFamily: "ui-sans-serif, sans-serif",
      },
      ".cm-formula-tooltip header": { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", marginBottom: "8px" },
      ".cm-formula-tooltip header strong": { fontSize: "11px" },
      ".cm-formula-tooltip header span": { overflow: "hidden", color: "var(--primary)", fontFamily: "ui-monospace, monospace", fontSize: "10px", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      ".cm-formula-preview": { maxWidth: "100%", overflowX: "auto", padding: "8px 5px", color: "var(--card-foreground)" },
      ".cm-formula-preview .katex-display": { margin: "0.25em 0" },
      ".cm-formula-preview.fallback": { padding: "5px 0" },
      ".cm-formula-preview.fallback pre": { margin: 0, overflowX: "auto", color: "var(--card-foreground)", fontFamily: "ui-monospace, monospace", fontSize: "11px", whiteSpace: "pre-wrap" },
      ".cm-formula-preview.fallback p": { margin: "7px 0 0", color: "var(--destructive)", fontSize: "10px", lineHeight: "1.35" },
      ".cm-formula-tooltip footer": { marginTop: "7px", paddingTop: "7px", borderTop: "1px solid var(--border)", color: "var(--muted-foreground)", fontSize: "10px" },
    }),
  ];
}
