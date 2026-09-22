import assert from "node:assert/strict";
import test from "node:test";

import { flattenStructure, projectStructure } from "../src/shared/structure.ts";

test("project structure follows includes from the main document in source order", () => {
  const sources = new Map([
    ["main.tex", String.raw`\part{Opening}
\sectiontldr{The opening frames the paper.}
% \section{Ignored}
\input{chapters/method}
\section{Results}
Results support \textbf{the claim}. \tldr{The result is \emph{positive}.}`],
    ["chapters/method.tex", String.raw`\chapter[Short]{Method}
\sectiontldr{The method has two stages.}
\subsection{\textbf{Implementation}}
Implementation details. \tldr{The implementation is reproducible.}
\input{../main}`],
  ]);

  const entries = flattenStructure(projectStructure("main.tex", sources));
  assert.deepEqual(entries.map(entry => ({ type: entry.type, level: entry.level, kind: entry.kind, title: entry.title, path: entry.path, line: entry.line })), [
    { type: "heading", level: 0, kind: "part", title: "Opening", path: "main.tex", line: 1 },
    { type: "heading", level: 1, kind: "chapter", title: "Method", path: "chapters/method.tex", line: 1 },
    { type: "heading", level: 3, kind: "subsection", title: "Implementation", path: "chapters/method.tex", line: 3 },
    { type: "point", level: 4, kind: "paragraph", title: "The implementation is reproducible.", path: "chapters/method.tex", line: 4 },
    { type: "heading", level: 2, kind: "section", title: "Results", path: "main.tex", line: 5 },
    { type: "point", level: 3, kind: "paragraph", title: "The result is positive.", path: "main.tex", line: 6 },
  ]);
  assert.equal(entries[0].type === "heading" ? entries[0].summary?.title : null, "The opening frames the paper.");
  assert.equal(entries[1].type === "heading" ? entries[1].summary?.title : null, "The method has two stages.");
});

test("project structure resolves root-relative includes before file-relative includes", () => {
  const sources = new Map([
    ["paper/main.tex", String.raw`\include{shared}`],
    ["shared.tex", String.raw`\section{Root copy}`],
    ["paper/shared.tex", String.raw`\section{Relative copy}`],
  ]);
  assert.equal(projectStructure("paper/main.tex", sources)[0]?.title, "Root copy");
});

test("leaf nodes own exact editable source ranges without annotation macros", () => {
  const source = String.raw`\section{Analysis}
\sectiontldr{The analysis has two claims.}
First paragraph with \textbf{markup}.
\tldr{First claim.}
\tldr{Supporting claim.}

\subsection{Leaf}
Leaf source with \cite{paper}.

\section{Next}`;
  const roots = projectStructure("main.tex", new Map([["main.tex", source]]));
  const entries = flattenStructure(roots);
  const paragraphs = entries.filter(entry => entry.type === "point");
  const leaf = entries.find(entry => entry.type === "heading" && entry.title === "Leaf");
  assert.equal(paragraphs.length, 2);
  assert.deepEqual(paragraphs[0].sourceRange, paragraphs[1].sourceRange);
  assert.equal(source.slice(paragraphs[0].sourceRange.from, paragraphs[0].sourceRange.to), "First paragraph with \\textbf{markup}.");
  assert.ok(leaf);
  assert.equal(source.slice(leaf.sourceRange.from, leaf.sourceRange.to), "Leaf source with \\cite{paper}.");
  assert.equal(roots[0].type === "heading" ? roots[0].summary?.title : null, "The analysis has two claims.");
});
