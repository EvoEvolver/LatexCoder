import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip } from "@codemirror/view";

import { citationEntries, type CitationEntry } from "../shared/bibliography.ts";
import { referenceLinks } from "../shared/references.ts";
import type { ProjectFile } from "../shared/api-schema.ts";

type CitationHoverData = {
  projectId(): string;
  files(): ProjectFile[];
  readFile(path: string): Promise<string>;
};

type LocatedCitation = CitationEntry & { path: string };

function citationTooltipDom(citation: LocatedCitation): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-citation-tooltip";

  const header = document.createElement("header");
  const key = document.createElement("code");
  key.textContent = citation.key;
  const metadata = document.createElement("span");
  metadata.textContent = [citation.type, citation.year].filter(Boolean).join(" · ");
  header.append(key, metadata);

  const title = document.createElement("strong");
  title.textContent = citation.title || "Untitled bibliography entry";
  dom.append(header, title);

  if (citation.authors.length) {
    const authors = document.createElement("p");
    authors.textContent = citation.authors.join("; ");
    dom.append(authors);
  }

  const source = document.createElement("footer");
  source.textContent = [citation.venue, citation.path].filter(Boolean).join(" · ");
  dom.append(source);
  return dom;
}

export function citationHover(data: CitationHoverData): Extension {
  return [
    hoverTooltip(async (view, position) => {
      const link = referenceLinks(view.state.doc.toString())
        .find(candidate => candidate.kind === "cite" && position >= candidate.from && position <= candidate.to);
      if (!link) return null;
      const projectId = data.projectId();
      const bibliographyFiles = data.files().filter(file => file.text && file.path.toLowerCase().endsWith(".bib"));
      const sources = await Promise.all(bibliographyFiles.map(async file => ({ path: file.path, source: await data.readFile(file.path) })));
      if (projectId !== data.projectId()) return null;
      let citation: LocatedCitation | undefined;
      for (const file of sources) {
        const entry = citationEntries(file.source).find(candidate => candidate.key === link.key);
        if (entry) { citation = { ...entry, path: file.path }; break; }
      }
      if (!citation) return null;
      return {
        pos: link.from,
        end: link.to,
        above: true,
        create: () => ({ dom: citationTooltipDom(citation) }),
      };
    }, { hoverTime: 650, hideOnChange: true }),
    EditorView.baseTheme({
      ".cm-citation-tooltip": {
        width: "min(360px, calc(100vw - 32px))",
        padding: "10px 11px",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        backgroundColor: "var(--card)",
        boxShadow: "0 10px 28px rgb(0 0 0 / 25%)",
        color: "var(--card-foreground)",
        fontFamily: "ui-sans-serif, sans-serif",
      },
      ".cm-citation-tooltip header": { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", marginBottom: "7px" },
      ".cm-citation-tooltip header code": { color: "var(--primary)", fontSize: "11px", fontWeight: "700" },
      ".cm-citation-tooltip header span": { color: "var(--muted-foreground)", fontSize: "10px", textTransform: "capitalize" },
      ".cm-citation-tooltip strong": { display: "block", fontSize: "12px", lineHeight: "1.4" },
      ".cm-citation-tooltip p": { margin: "5px 0 0", color: "var(--muted-foreground)", fontSize: "11px", lineHeight: "1.4" },
      ".cm-citation-tooltip footer": { marginTop: "8px", paddingTop: "7px", borderTop: "1px solid var(--border)", color: "var(--muted-foreground)", fontSize: "10px", lineHeight: "1.35" },
    }),
  ];
}
