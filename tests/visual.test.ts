import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseVisual, group } from '../src/client/latex-visual';

test('visual source spans retain nested formatting, math, tables, and document setup', () => {
  const source = readFileSync(new URL('./fixtures/visual-demo.tex', import.meta.url),'utf8');
  const {blocks,preamble,bodyEnd} = parseVisual(source);
  assert.match(preamble,/amsmath/);
  assert.equal(source.slice(bodyEnd).trim(),'\\end{document}');
  assert.equal(blocks.filter(b=>b.kind === 'math').length,3);
  assert.equal(blocks.filter(b=>b.kind === 'heading').length,6);
  assert.equal(blocks.find(b=>b.kind === 'table')!.cells!.length,4);
  const table = blocks.find(b=>b.kind === 'table')!;
  assert.equal(source.slice(table.cells![2][0].from,table.cells![2][0].to),'Standard');
  assert.equal(blocks.find(b=>b.kind === 'itemize')!.children!.length,3);
  const nested = '{Outer \\textbf{inner} and \\{literal\\}}';
  assert.equal(group(nested,0)?.to,nested.length-1);
});

test('unsupported environments remain intact and malformed groups are not silently removed', () => {
  const source = '\\begin{document}\n\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n\\section{Unclosed';
  const {blocks} = parseVisual(source);
  assert.equal(blocks[0].kind,'raw');
  assert.equal(source.slice(blocks[0].from,blocks[0].to),'\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}');
  assert.ok(blocks.some(b=>source.slice(b.from,b.to).includes('Unclosed')));
});

test('paragraphs beginning with math do not swallow following blocks', () => {
  const source = '$x^2$ is positive.\n\n\\section{Next}\nMore text.';
  const {blocks} = parseVisual(source);
  assert.equal(blocks.length,3);
  assert.equal(blocks[1].kind,'heading');
});
