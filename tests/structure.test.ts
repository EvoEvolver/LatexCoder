import assert from "node:assert/strict";
import test from "node:test";

import { projectStructure } from "../src/shared/structure.ts";

test("project structure follows includes from the main document in source order", () => {
  const sources = new Map([
    ["main.tex", String.raw`\part{Opening}
% \section{Ignored}
\input{chapters/method}
\section{Results}`],
    ["chapters/method.tex", String.raw`\chapter[Short]{Method}
\subsection{\textbf{Implementation}}
\input{../main}`],
  ]);

  assert.deepEqual(projectStructure("main.tex", sources), [
    { level: 0, kind: "part", title: "Opening", path: "main.tex", line: 1 },
    { level: 1, kind: "chapter", title: "Method", path: "chapters/method.tex", line: 1 },
    { level: 3, kind: "subsection", title: "Implementation", path: "chapters/method.tex", line: 2 },
    { level: 2, kind: "section", title: "Results", path: "main.tex", line: 4 },
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
