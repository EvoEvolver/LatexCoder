import assert from "node:assert/strict";
import test from "node:test";
import { referenceLinks, referenceDefinition } from "../src/references.ts";

test("references support optional arguments, multiple keys, and comments", () => {
  const source = String.raw`\include{chapters/intro}
\citep[see][p. 3]{smith, doe} \citet{smith} \cite{doe}
\ref{sec:a} \autoref{sec:a} \cref{sec:a,sec:b}
% \cite{ignored}
`;
  const links = referenceLinks(source);
  assert.deepEqual(links.map(link => link.key), ["chapters/intro", "smith", "doe", "smith", "doe", "sec:a", "sec:a", "sec:a", "sec:b"]);
  for (const link of links) assert.equal(source.slice(link.from, link.to), link.key);
  assert.equal(referenceDefinition(String.raw`% \label{a}
\label{a}`, "a", "label")?.from, 12);
  assert.ok(referenceDefinition("@article{smith,\n title={Title}\n}", "smith", "cite"));
});
