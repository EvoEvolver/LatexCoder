import assert from "node:assert/strict";
import test from "node:test";

import { latexDiagnostics } from "../src/shared/latex-diagnostics.ts";

test("LaTeX diagnostics find undefined citations and references across files", () => {
  const diagnostics = latexDiagnostics([
    { path: "main.tex", source: "\\citep[see][]{known, missing}\n\\ref{found} \\autoref{lost}\n\\label{duplicate}" },
    { path: "chapter.tex", source: "% \\label{ignored}\n\\label{found}\n\\label{duplicate}" },
    { path: "refs.bib", source: "@article{known,\n title={Known}\n}" },
  ]);
  assert.deepEqual(diagnostics.map(item => [item.path, item.line, item.message]), [
    ["chapter.tex", 3, "Duplicate label: duplicate"],
    ["main.tex", 1, "Undefined citation: missing"],
    ["main.tex", 2, "Undefined reference: lost"],
    ["main.tex", 3, "Duplicate label: duplicate"],
  ]);
  assert.equal(diagnostics.every(item => Number.isInteger(item.from) && item.to! > item.from!), true);
});
