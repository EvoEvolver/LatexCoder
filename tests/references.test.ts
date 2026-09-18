import assert from "node:assert/strict";
import test from "node:test";
import { referenceLinks, referenceDefinition } from "../src/shared/references.ts";

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

test("graphics and URL links preserve complete paths, punctuation and percent escapes", () => {
  const source = String.raw`\includegraphics[width=\linewidth]{figs/tool_usage.pdf}
\includegraphics*{figs/tool_usage} \url{https://example.test/a%20b?q=a,b#section} \ref{after}
% \includegraphics{ignored.pdf} \url{https://ignored.test}
`;
  const links = referenceLinks(source);
  assert.deepEqual(links.map(({ key, kind }) => ({ key, kind })), [
    { key: "figs/tool_usage.pdf", kind: "asset" }, { key: "figs/tool_usage", kind: "asset" },
    { key: "https://example.test/a%20b?q=a,b#section", kind: "url" }, { key: "after", kind: "label" },
  ]);
  for (const link of links) assert.equal(source.slice(link.from, link.to), link.key);
});
