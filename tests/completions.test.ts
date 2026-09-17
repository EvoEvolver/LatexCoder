import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { completionArgument, definitionKeys, projectCompletionSource } from "../src/client/completions.ts";
import { citationEntries } from "../src/shared/bibliography.ts";

test("citation entries retain nested titles and author metadata", () => {
  const source = '@article{paper, title={A {Nested} Title}, author={Doe, Jane and Smith, John and Third, Alice and Fourth, Bob}}';
  assert.deepEqual(citationEntries(source), [{ key: "paper", title: "A Nested Title", authors: ["Doe, Jane", "Smith, John", "Third, Alice", "Fourth, Bob"] }]);
  assert.equal(citationEntries('@book(other, title="A, quoted title", author="Someone")')[0].title, "A, quoted title");
});

test("completion arguments support optional arguments, multiple keys and bibliography styles", () => {
  for (const macro of ["cite", "citep", "citet", "ref", "autoref", "cref"]) {
    const source = `\\${macro}*[see][p. 2]{first, se`;
    const argument = completionArgument(source, source.length)!;
    assert.equal(argument.kind, macro.startsWith("cite") ? "cite" : "label");
    assert.equal(source.slice(argument.from), "se");
  }
  for (const [source, kind, omit] of [["\\includegraphics[width=\\linewidth]{figs/", "image", false], ["\\bibliography{one, refs", "bib", true], ["\\addbibresource{refs", "bib", false]] as const) {
    assert.equal(completionArgument(source, source.length)?.kind, kind);
    assert.equal(completionArgument(source, source.length)?.omitExtension, omit);
  }
  const comment = "% \\cite{abc";
  assert.equal(completionArgument(comment, comment.length), null);
  assert.deepEqual(definitionKeys("% \\label{ignored}\n\\label{sec:intro}", "label"), ["sec:intro"]);
  assert.deepEqual(definitionKeys('@article{paper, title={Title}}\n@string{journal, value="x"}', "cite"), ["paper"]);
});

test("project completion reads cross-file definitions and uses live active text", async () => {
  const source = "\\label{live}\n\\cref{";
  const complete = projectCompletionSource({
    projectId: () => "project", activeFile: () => "main.tex",
    files: () => ["main.tex", "sub.tex", "refs.bib", "figs/chart.pdf"].map(path => ({ path, text: !path.endsWith("pdf"), size: 1 })),
    readFile: async path => path === "sub.tex" ? "\\label{remote}" : "@article{paper, title={Title}}",
  });
  const result = await complete(new CompletionContext(EditorState.create({ doc: source }), source.length, true));
  assert.deepEqual(result?.options.map(option => option.label), ["live", "remote"]);
  for (const [doc, expected] of [["\\cite{", "paper"], ["\\includegraphics{", "figs/chart.pdf"], ["\\bibliography{", "refs"], ["\\addbibresource{", "refs.bib"]]) {
    const result = await complete(new CompletionContext(EditorState.create({ doc }), doc.length, true));
    assert.ok(result?.options.some(option => option.label === expected));
  }
});
