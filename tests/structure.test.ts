import assert from "node:assert/strict";
import test from "node:test";

import { projectStructure } from "../src/shared/structure.ts";

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

  assert.deepEqual(projectStructure("main.tex", sources), [
    { type: "heading", level: 0, kind: "part", title: "Opening", path: "main.tex", line: 1 },
    { type: "point", level: 1, kind: "section", title: "The opening frames the paper.", path: "main.tex", line: 2 },
    { type: "heading", level: 1, kind: "chapter", title: "Method", path: "chapters/method.tex", line: 1 },
    { type: "point", level: 2, kind: "section", title: "The method has two stages.", path: "chapters/method.tex", line: 2 },
    { type: "heading", level: 3, kind: "subsection", title: "Implementation", path: "chapters/method.tex", line: 3 },
    { type: "point", level: 4, kind: "paragraph", title: "The implementation is reproducible.", path: "chapters/method.tex", line: 4 },
    { type: "heading", level: 2, kind: "section", title: "Results", path: "main.tex", line: 5 },
    { type: "point", level: 3, kind: "paragraph", title: "The result is positive.", path: "main.tex", line: 6 },
  ]);
});

test("project structure resolves root-relative includes before file-relative includes", () => {
  const sources = new Map([
    ["paper/main.tex", String.raw`\include{shared}`],
    ["shared.tex", String.raw`\section{Root copy}`],
    ["paper/shared.tex", String.raw`\section{Relative copy}`],
  ]);
  assert.equal(projectStructure("paper/main.tex", sources)[0]?.title, "Root copy");
});
