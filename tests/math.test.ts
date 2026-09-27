import assert from "node:assert/strict";
import test from "node:test";

import { mathRegions, renderableMath } from "../src/shared/math.ts";

test("math regions cover common inline, display, and equation syntax", () => {
  const source = String.raw`Price \$5 and inline $a_b + c$ or \(x^2\).
Display \[\frac{1}{2}\] and $$y = mx + b$$.
\begin{align}
  E &= mc^2 \label{eq:mass} \\
  F &= ma
\end{align}
% ignored $not_math$ and \[not math\]
`;
  const regions = mathRegions(source);
  assert.equal(regions.length, 5);
  assert.deepEqual(regions.map(region => [region.source, region.display, region.environment]), [
    ["a_b + c", false, null],
    ["x^2", false, null],
    ["\\frac{1}{2}", true, null],
    ["y = mx + b", true, null],
    ["\n  E &= mc^2 \\label{eq:mass} \\\\\n  F &= ma\n", true, "align"],
  ]);
  for (const region of regions) assert.equal(source.slice(region.bodyFrom, region.bodyTo), region.source);
  assert.deepEqual(regions.at(-1)?.labels, ["eq:mass"]);
  assert.equal(renderableMath(regions.at(-1)!), String.raw`\begin{aligned}E &= mc^2  \\
  F &= ma\end{aligned}`);
});

test("math regions ignore comments, incomplete delimiters, and nested dollar scans", () => {
  const source = "% $ignored$\n$open only\n\\begin{equation}$nested$\\label{eq:x}\\end{equation}";
  const regions = mathRegions(source);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].environment, "equation");
  assert.equal(regions[0].source, "$nested$\\label{eq:x}");
  assert.equal(renderableMath(regions[0]), "$nested$");
});
