/** A lossless source lens. Editable spans refer to the original LaTeX, while
 * unsupported constructs remain explicit source blocks. Merely viewing a file
 * never serializes or rewrites it. */
export type Span = { from: number; to: number };
export type Block = Span & { kind: string; content?: Span; level?: number; env?: string; children?: Block[]; cells?: Span[][]; caption?: Span; image?: string };
export function group(source: string, start: number): Span | null {
  if (source[start] !== '{') return null;
  let depth = 1;
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return { from: start + 1, to: i };
  }
  return null;
}
function trimmed(source: string, from: number, to: number): Span {
  while (from < to && /\s/.test(source[from])) from++;
  while (to > from && /\s/.test(source[to - 1])) to--;
  return { from, to };
}
function environment(source: string, start: number) {
  const begin = /^\\begin\{([^}]+)\}(?:\[[^\]]*\])?/.exec(source.slice(start));
  if (!begin) return null;
  const re = /\\(begin|end)\{([^}]+)\}/g; re.lastIndex = start + begin[0].length;
  let depth = 1, match;
  while ((match = re.exec(source))) {
    if (match[2] !== begin[1]) continue;
    depth += match[1] === 'begin' ? 1 : -1;
    if (!depth) return { env: begin[1], content: {from: start + begin[0].length, to: match.index}, to: re.lastIndex };
  }
  return null;
}
export function splitTable(source: string, from: number, to: number): Span[][] {
  const rows: Span[][] = []; let row: Span[] = [], start = from, depth = 0;
  function cell(end: number) { row.push(trimmed(source, start, end)); }
  for (let i = from; i < to; i++) {
    if (source[i] === '\\') {
      const rule = /^\\(?:toprule|midrule|bottomrule|hline)(?:\[[^\]]*\])?/.exec(source.slice(i));
      if (rule && !source.slice(start, i).trim()) { i += rule[0].length - 1; start = i + 1; continue; }
      if (source[i + 1] === '\\' && !depth) { cell(i); rows.push(row); row = []; i++; start = i + 1; continue; }
      i++; continue;
    }
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (source[i] === '&' && !depth) { cell(i); start = i + 1; }
  }
  if (source.slice(start, to).trim()) { cell(to); rows.push(row); }
  return rows;
}
export function parseVisual(source: string): { blocks: Block[]; bodyEnd: number; preamble: string } {
  const begin = /\\begin\{document\}/.exec(source);
  const end = source.lastIndexOf('\\end{document}');
  const bodyStart = begin ? begin.index + begin[0].length : 0;
  const bodyEnd = end >= bodyStart ? end : source.length;
  const blocks: Block[] = [];
  const preamble = begin ? source.slice(0, begin.index) : '';
  let i = bodyStart;
  while (i < bodyEnd) {
    if (/\s/.test(source[i])) { i++; continue; }
    const from = i, rest = source.slice(i, bodyEnd);
    const heading = /^\\(section|subsection|subsubsection|paragraph)\*?/.exec(rest);
    if (heading) {
      const content = group(source, i + heading[0].length);
      if (content) { i = content.to + 1; blocks.push({kind:'heading', from, to:i, content, level: ['section','subsection','subsubsection','paragraph'].indexOf(heading[1]) + 2}); continue; }
    }
    if (rest.startsWith('\\maketitle')) {
      i += 10;
      for (const kind of ['title', 'author', 'date']) {
        const match = new RegExp('\\\\' + kind + '\\s*\\{').exec(preamble);
        if (match) { const content = group(source, match.index + match[0].length - 1); if (content) blocks.push({kind, from: content.from, to: content.to, content}); }
      }
      continue;
    }
    const env = environment(source, i);
    if (env) {
      i = env.to;
      const block: Block = {kind: 'raw', from, to: i, env: env.env, content: env.content};
      if (/^(equation\*?|align\*?|gather\*?|displaymath)$/.test(env.env)) block.kind = 'math';
      else if (['itemize','enumerate'].includes(env.env)) {
        const children: Block[] = [], items = [...source.slice(env.content.from, env.content.to).matchAll(/\\item(?:\[[^\]]*\])?\s*/g)];
        // Nested lists are retained as source until their structure can be edited losslessly.
        if (!/\\begin\{/.test(source.slice(env.content.from, env.content.to))) {
          for (let j = 0; j < items.length; j++) {
            const itemFrom = env.content.from + items[j].index!;
            const content = trimmed(source, itemFrom + items[j][0].length, j + 1 < items.length ? env.content.from + items[j+1].index! : env.content.to);
            children.push({kind:'item', from: itemFrom, to:content.to, content});
          }
          block.kind = env.env; block.children = children;
        }
      } else if (['table', 'table*', 'tabular'].includes(env.env)) {
        const inner = env.env === 'tabular' ? { ...env, from } : (() => {
          const match = /\\begin\{tabular\}/.exec(source.slice(env.content.from, env.content.to));
          return match ? environment(source, env.content.from + match.index) : null;
        })();
        if (inner) {
          let col = inner.content.from; while (/\s/.test(source[col])) col++;
          const columns = group(source, col);
          if (columns && !/\\(?:multicolumn|multirow|begin|cline|cmidrule)\b/.test(source.slice(columns.to + 1, inner.content.to))) {
            block.kind = 'table'; block.cells = splitTable(source, columns.to + 1, inner.content.to);
            const caption = /\\caption\s*\{/.exec(source.slice(env.content.from, env.content.to));
            if (caption) block.caption = group(source, env.content.from + caption.index + caption[0].length - 1)!;
          }
        }
      } else if (env.env === 'abstract' || env.env === 'quote') block.kind = env.env;
      else if (env.env === 'figure') {
        const image = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/.exec(source.slice(env.content.from, env.content.to));
        if (image) { block.kind = 'figure'; block.image = image[1]; }
        const caption = /\\caption\s*\{/.exec(source.slice(env.content.from, env.content.to));
        if (caption) block.caption = group(source, env.content.from + caption.index + caption[0].length - 1)!;
      }
      blocks.push(block); continue;
    }
    if (rest.startsWith('\\[') || rest.startsWith('$$')) {
      const closing = rest.startsWith('$$') ? '$$' : '\\]';
      const stop = source.indexOf(closing, i + 2);
      if (stop >= 0) { i = stop + 2; blocks.push({kind:'math', from, to:i, content:{from:from+2,to:stop}}); continue; }
    }
    if (source[i] === '%' || /^\\(?:label|input|include|bibliography|bibliographystyle|newpage|clearpage|tableofcontents)\b/.test(rest)) {
      const stop = source.indexOf('\n', i); i = stop < 0 ? bodyEnd : Math.min(stop, bodyEnd); blocks.push({kind:'raw',from,to:i}); continue;
    }
    // Scan a paragraph without splitting inside groups or inline math.
    let depth = 0, math = false;
    for (; i < bodyEnd; i++) {
      if (source[i] === '\\') {
        if (i > from && !depth && !math && /^(?:\\(?:section|subsection|subsubsection|begin|maketitle)\b|\\\[)/.test(source.slice(i))) break;
        i++; continue;
      }
      if (source[i] === '{') depth++;
      if (source[i] === '}') depth--;
      if (source[i] === '$') math = !math;
      if (!depth && !math && /^\n\s*\n/.test(source.slice(i))) break;
    }
    const content = trimmed(source, from, i); blocks.push({kind:'paragraph',from,to:i,content});
  }
  return { blocks, bodyEnd, preamble };
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const escapeLatex = (value: string) => value.replace(/[\\{}$%&#_^~]/g, c => ({'\\':'\\textbackslash{}','~':'\\textasciitilde{}','^':'\\textasciicircum{}'}[c] || '\\' + c));
