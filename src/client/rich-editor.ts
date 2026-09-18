import katex from 'katex';
import 'katex/dist/katex.min.css';
import { createIcons, Bold, Italic, Heading2, List, ListOrdered, Table2, Sigma, Code2, Plus, Undo2, Redo2, Pencil } from 'lucide';
import type { projectReviews } from './visual-review';
import { parseVisual, group, escapeHtml, escapeLatex, type Span, type Block } from './latex-visual';

type Options = {
  source(): string; change(from: number, to: number, insert: string): void;
  codeAction(action: string, value?: string): void;
  marks(): ReturnType<typeof projectReviews>["marks"]; review(id: string): void;
  image(path: string): string; undo(): void; redo(): void; notice(message: string): void;
};
function formula(value: string, display = false) {
  try { return katex.renderToString(value.trim(), { displayMode: display, throwOnError: true, trust: false, strict: 'ignore', output: 'htmlAndMathml' }); }
  catch { return `<code class="formula-fallback">${escapeHtml(value)}</code>`; }
}
function inline(source: string): string {
  let html = '', i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const format = /^\\(textbf|textit|emph|underline|texttt)\s*/.exec(rest);
    if (format) {
      const content = group(source, i + format[0].length);
      if (content) { const tag = ({textbf:'strong',textit:'em',emph:'em',underline:'u',texttt:'code'})[format[1]]!;
        html += `<${tag} data-command="${format[1]}">${inline(source.slice(content.from, content.to))}</${tag}>`; i = content.to + 1; continue; }
    }
    if (source[i] === '$' || rest.startsWith('\\(')) {
      const width = source[i] === '$' ? 1 : 2, closer = width === 1 ? '$' : '\\)';
      let end = source.indexOf(closer, i + width);
      while (end > 0 && source[end - 1] === '\\' && width === 1) end = source.indexOf(closer, end + 1);
      if (end >= 0) { const raw = source.slice(i, end + width); html += `<span class="inline-equation" contenteditable="false" data-latex="${escapeHtml(raw)}" title="Double-click to edit formula">${formula(source.slice(i + width, end))}</span>`; i = end + width; continue; }
    }
    const escaped = /^\\([%&#_${}])/.exec(rest);
    if (escaped) { html += escapeHtml(escaped[1]); i += 2; continue; }
    if (rest.startsWith('\\\\')) { html += '<br>'; i += 2; continue; }
    if (source[i] === '\\') {
      const command = /^\\[a-zA-Z]+\*?/.exec(rest);
      let end = i + (command?.[0].length || 2);
      while (source[end] === '{') { const g = group(source, end); if (!g) break; end = g.to + 1; }
      const raw = source.slice(i, end);
      const label = raw === '\\today' ? new Date().toLocaleDateString('en', {year:'numeric',month:'long',day:'numeric'}) : raw;
      html += `<span class="latex-token" contenteditable="false" data-latex="${escapeHtml(raw)}" title="LaTeX command, preserved in source">${escapeHtml(label)}</span>`; i = end; continue;
    }
    if (source[i] === '%') { const end = source.indexOf('\n',i); const to = end < 0 ? source.length : end; const raw = source.slice(i,to); html += `<span class="latex-token" contenteditable="false" data-latex="${escapeHtml(raw)}">${escapeHtml(raw)}</span>`; i = to; continue; }
    html += source[i] === '~' ? '&nbsp;' : escapeHtml(source[i]); i++;
  }
  return html;
}
export function serializeInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeLatex(node.textContent || '').replaceAll('\u00a0', '~');
  if (!(node instanceof HTMLElement)) return '';
  if (node.dataset.latex !== undefined) return node.dataset.latex;
  const inner = [...node.childNodes].map(serializeInline).join('');
  if (node.dataset.command && ['textbf','textit','emph','underline','texttt'].includes(node.dataset.command)) return `\\${node.dataset.command}{${inner}}`;
  switch (node.tagName) {
    case 'B': case 'STRONG': return `\\textbf{${inner}}`;
    case 'I': case 'EM': return `\\emph{${inner}}`;
    case 'U': return `\\underline{${inner}}`;
    case 'CODE': return `\\texttt{${inner}}`;
    case 'BR': return '\\\\\n';
    case 'DIV': case 'P': return '\n\n' + inner;
    default: return inner;
  }
}
export class RichEditor {
  private source = '';
  private leaves: { span: Span; element: HTMLElement; raw: string }[] = [];
  private active: HTMLElement | null = null;
  private applying = false;
  private composing = false;
  private toolbar: HTMLElement;
  private page: HTMLElement;
  private popover: HTMLDialogElement;
  private textarea: HTMLTextAreaElement;
  private commitPopover: (() => void) | null = null;
  constructor(private host: HTMLElement, private options: Options) {
    host.innerHTML = '<div class="visual-scroll"><article class="visual-page" aria-label="Visual document"></article></div>';
    this.toolbar = document.getElementById('format-tools')!; this.page = host.querySelector('.visual-page')!;
    this.popover = document.createElement('dialog'); this.popover.className = 'visual-source-dialog';
    this.popover.innerHTML = '<form method="dialog"><header><strong>Edit LaTeX block</strong><button value="cancel" aria-label="Close">×</button></header><label for="visual-block-source">LaTeX source</label><textarea id="visual-block-source" spellcheck="false"></textarea><div class="visual-formula-preview"></div><footer><button value="cancel">Cancel</button><button value="save" class="save-block">Apply</button></footer></form>';
    document.body.append(this.popover); this.textarea = this.popover.querySelector('textarea')!;
    this.popover.querySelector('form')!.addEventListener('submit', event => {
      if ((event.submitter as HTMLButtonElement)?.value !== 'save') return;
      event.preventDefault(); this.commitPopover?.(); this.commitPopover = null; this.popover.close('save');
    });
    this.popover.addEventListener('close', () => { this.commitPopover = null; });
    this.textarea.addEventListener('input', () => this.previewFormula());
    const actions: [string,string,()=>void][] = [
      ['undo-2','Undo',options.undo], ['redo-2','Redo',options.redo],
      ['bold','Bold',()=>this.format('bold')], ['italic','Italic',()=>this.format('italic')],
      ['heading-2','Add heading',()=>this.insert('\\section{New section}')],
      ['list','Add bullet list',()=>this.insert('\\begin{itemize}\n\\item First item\n\\item Second item\n\\end{itemize}')],
      ['list-ordered','Add numbered list',()=>this.insert('\\begin{enumerate}\n\\item First step\n\\item Second step\n\\end{enumerate}')],
      ['sigma','Add equation',()=>this.editSource('E = mc^2', value=>this.insert('\\[\n'+value+'\n\\]'),true)],
      ['table-2','Add table',()=>this.insert('\\begin{tabular}{ll}\n\\textbf{Column 1} & \\textbf{Column 2} \\\\\nValue & Value \\\\\n\\end{tabular}')],
      ['plus','Add paragraph',()=>this.insert('Write something.')],
    ];
    for (const [icon,title,action] of actions) {
      const b = document.createElement('button'); b.type = 'button'; b.title = title; b.setAttribute('aria-label',title); b.innerHTML = `<i data-lucide="${icon}"></i>`;
      b.onmousedown = e => e.preventDefault(); b.onclick = () => this.host.hidden ? options.codeAction(title) : action(); this.toolbar.append(b);
    }

    this.page.addEventListener('focusin', event => { const el = (event.target as Element).closest<HTMLElement>('[data-editable]'); if (el) this.active = el; });
    this.page.addEventListener('compositionstart', () => { this.composing = true; });
    this.page.addEventListener('compositionend', event => { this.composing = false; this.onInput(event); });
    this.page.addEventListener('input', event => { if (!this.composing) this.onInput(event); });
    this.page.addEventListener('paste', event => { event.preventDefault(); document.execCommand('insertText',false,event.clipboardData?.getData('text/plain') || ''); });
    this.page.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? options.redo() : options.undo(); }
      if ((event.ctrlKey || event.metaKey) && ['b','i'].includes(event.key.toLowerCase())) { event.preventDefault(); this.format(event.key.toLowerCase() === 'b' ? 'bold' : 'italic'); }
      if (event.key === 'Tab' && (event.target as Element).closest('td, th')) {
        const index = this.leaves.findIndex(l => l.element === event.target); const next = this.leaves[index + (event.shiftKey ? -1 : 1)]; if (next) { event.preventDefault(); next.element.focus(); }
      }
    });
    this.page.addEventListener('dblclick', event => {
      const token = (event.target as Element).closest<HTMLElement>('.inline-equation');
      if (!token) return;
      const leaf = this.leaves.find(l=>l.element.contains(token)); if (!leaf) return;
      const old = token.dataset.latex!;
      this.editSource(old.startsWith('$') ? old.slice(1,-1) : old.slice(2,-2), value => {
        if (!token.isConnected) { this.options.notice('The document changed. Reopen the formula to edit it.'); return; }
        token.dataset.latex = '$'+value+'$'; token.innerHTML = formula(value); this.saveLeaf(leaf);
      }, true);
    });
    createIcons({ root: this.toolbar, icons: { Bold, Italic, Heading2, List, ListOrdered, Table2, Sigma, Code2, Plus, Undo2, Redo2, Pencil } });
    this.toolbar.querySelectorAll("svg[data-lucide]").forEach(icon => icon.removeAttribute("data-lucide"));
  }
  private previewFormula() { const preview = this.popover.querySelector<HTMLElement>('.visual-formula-preview')!; preview.innerHTML = this.popover.dataset.math === 'true' ? formula(this.textarea.value,true) : ''; }
  private editSource(raw: string, save: (value:string)=>void, math = false) {
    this.textarea.value = raw; this.popover.dataset.math = String(math); this.previewFormula(); this.commitPopover = () => save(this.textarea.value);
    this.popover.returnValue = ''; this.popover.showModal(); this.textarea.focus();
  }
  private format(command: string) {
    if (!this.active || !this.active.isConnected) { this.options.notice('Select text in a paragraph to format it.'); return; }
    this.active.focus(); document.execCommand(command); const leaf = this.leaves.find(l=>l.element === this.active); if (leaf) this.saveLeaf(leaf);
  }
  private onInput(event: Event) { const leaf = this.leaves.find(l=>l.element === event.target); if (leaf) this.saveLeaf(leaf); }
  private saveLeaf(leaf: typeof this.leaves[number]) {
    if (this.options.source() !== this.source) { this.options.notice('The source changed. The visual document has been refreshed.'); this.sync(true); return; }
    const value = [...leaf.element.childNodes].map(serializeInline).join('').replace(/\n\n$/, '');
    if (value === leaf.raw) return;
    const {from,to} = leaf.span;
    const before = this.source;
    // Only replace the changed characters, retaining surrounding collaborative text.
    let left = 0; while (left < value.length && left < leaf.raw.length && value[left] === leaf.raw[left]) left++;
    let right = 0; while (right < value.length - left && right < leaf.raw.length - left && value[value.length-1-right] === leaf.raw[leaf.raw.length-1-right]) right++;
    this.applying = true;
    this.options.change(from + left, to - right, value.slice(left, value.length - right));
    this.applying = false;
    this.source = this.options.source();
    if (this.source !== before.slice(0,from) + value + before.slice(to)) { this.sync(true); return; }
    const delta = value.length - (to-from);
    for (const other of this.leaves) { if (other === leaf) continue; if (other.span.from >= to) { other.span.from += delta; other.span.to += delta; } }
    leaf.span.to = from + value.length; leaf.raw = value;
    this.refreshReviewMarks();
  }
  private editable(tag: string, span: Span, className = '') {
    const el = document.createElement(tag); el.className = className; el.contentEditable = 'true'; el.dataset.editable = 'true'; el.spellcheck = true;
    el.setAttribute('role','textbox'); el.setAttribute('aria-label', tag === 'h1' ? 'Document title' : tag.startsWith('h') ? 'Section heading' : tag === 'td' || tag === 'th' ? 'Table cell' : 'Paragraph');
    el.setAttribute('aria-multiline','true'); el.innerHTML = inline(this.source.slice(span.from,span.to)) || '<br>';
    this.leaves.push({element: el,span:{...span},raw:this.source.slice(span.from,span.to)}); return el;
  }
  private insert(latex: string) {
    const model = parseVisual(this.options.source());
    const active = this.leaves.find(leaf => leaf.element === this.active);
    const block = active && model.blocks.find(block => block.from <= active.span.to && block.to >= active.span.to && !['title','author','date'].includes(block.kind));
    const end = block?.to ?? model.bodyEnd;
    const inserted = '\n\n' + latex + '\n\n';
    this.options.change(end,end,inserted); this.sync(true);
    const next = this.leaves.find(leaf => leaf.span.from >= end && leaf.span.to <= end + inserted.length);
    next?.element.focus(); next?.element.scrollIntoView({block:'nearest'});
  }
  sync(force = false) {
    if (this.applying || this.host.hidden) return;
    const source = this.options.source(); if (!force && source === this.source) return;
    if (this.composing) return;
    const focusIndex = this.leaves.findIndex(l=>l.element === document.activeElement);
    const selection = this.selection();
    this.source = source; this.leaves = []; this.page.replaceChildren();
    const model = parseVisual(source);
    if (model.preamble) {
      const setup = document.createElement('details'); setup.className = 'visual-preamble';
      setup.innerHTML = '<summary>Document setup</summary><pre></pre>'; setup.querySelector('pre')!.textContent = model.preamble; this.page.append(setup);
    }
    for (const block of model.blocks) this.renderBlock(block);
    const add = document.createElement('button'); add.className = 'visual-add'; add.textContent = '+ Add a paragraph'; add.onclick = ()=>this.insert('Write something.'); this.page.append(add);
    this.refreshReviewMarks();
    if (focusIndex >= 0) { this.leaves[focusIndex]?.element.focus({preventScroll:true}); if (selection) this.restoreSelection(selection.from, selection.to); }
  }
  private renderBlock(block: Block) {
    const content = block.content!;
    if (['paragraph','heading','title','author','date'].includes(block.kind)) {
      this.page.append(this.editable(block.kind === 'heading' ? 'h'+Math.min(4,block.level!) : block.kind === 'title' ? 'h1' : 'p', content, `visual-${block.kind}`)); return;
    }
    if (['itemize','enumerate'].includes(block.kind)) {
      const list = document.createElement(block.kind === 'itemize' ? 'ul' : 'ol');
      for (const child of block.children!) list.append(this.editable('li',child.content!)); this.page.append(list); return;
    }
    if (block.kind === 'abstract' || block.kind === 'quote') {
      const section = document.createElement('section'); section.className = 'visual-'+block.kind;
      if (block.kind === 'abstract') { const heading = document.createElement('h2'); heading.textContent = 'Abstract'; section.append(heading); }
      section.append(this.editable('p',content)); this.page.append(section); return;
    }
    if (block.kind === 'math') {
      const wrapper = document.createElement('div'); wrapper.className = 'visual-equation';
      const tex = this.source.slice(content.from,content.to); const value = block.env?.startsWith('align') ? '\\begin{aligned}'+tex+'\\end{aligned}' : tex;
      wrapper.innerHTML = formula(value,true); this.blockEdit(wrapper, block, 'Edit equation', true); this.page.append(wrapper); return;
    }
    if (block.kind === 'table') {
      const wrap = document.createElement('figure'); wrap.className = 'visual-table'; const table = document.createElement('table'); const body = document.createElement('tbody');
      block.cells!.forEach((cells,index)=> { const row = document.createElement('tr'); for (const cell of cells) row.append(this.editable(index === 0 ? 'th':'td',cell)); body.append(row); });
      table.append(body); const scroll = document.createElement('div'); scroll.className = 'visual-table-scroll'; scroll.append(table); wrap.append(scroll);
      if (block.caption) wrap.append(this.editable('figcaption',block.caption)); this.blockEdit(wrap,block,'Edit table source'); this.page.append(wrap); return;
    }
    if (block.kind === 'figure') {
      const wrap = document.createElement('figure'); wrap.className = 'visual-figure'; const img = document.createElement('img'); img.src = this.options.image(block.image!); img.alt = block.image!; wrap.append(img);
      if (block.caption) wrap.append(this.editable('figcaption',block.caption)); this.blockEdit(wrap,block,'Edit figure source'); this.page.append(wrap); return;
    }
    const raw = document.createElement('div'); raw.className = 'visual-raw';
    const label = document.createElement('span'); label.textContent = block.env ? `LaTeX · ${block.env}` : 'LaTeX'; const code = document.createElement('pre'); code.textContent = this.source.slice(block.from,block.to);
    raw.append(label,code); this.blockEdit(raw,block,'Edit LaTeX source'); this.page.append(raw);
  }
  private blockEdit(host: HTMLElement, _block: Block, label: string, math = false) {
    const b = document.createElement('button'); b.className = 'visual-block-edit'; b.title = label; b.setAttribute('aria-label',label); b.textContent = 'Edit';
    b.onclick = () => {
      // Reparse before opening: preceding text edits may have moved this block.
      const nodes = [...this.page.querySelectorAll('.visual-equation,.visual-table,.visual-figure,.visual-raw')]; const index = nodes.indexOf(host);
      const model = parseVisual(this.options.source()); const now = model.blocks.filter(item=>['math','table','figure','raw'].includes(item.kind))[index];
      if (!now) return;
      const span = math ? now.content! : now;
      const baseline = this.options.source(); const raw = baseline.slice(span.from,span.to);
      this.editSource(raw,value=> { if (this.options.source() !== baseline) { this.options.notice('The source changed. Reopen this block to edit the latest version.'); return; } this.options.change(span.from,span.to,value); this.sync(true); }, math);
    }; host.append(b);
  }
  /** Serialize only the prefix before a DOM endpoint, keeping formatting braces
   * open. This maps selections inside bold/italic text to the source body. */
  private prefix(root: Node, target: Node, offset: number): string | null {
    const el = root instanceof HTMLElement ? root : null;
    const command = el?.dataset.command || ({STRONG:'textbf',B:'textbf',I:'emph',EM:'emph',U:'underline',CODE:'texttt'}[el?.tagName || '']);
    let value = command ? `\\${command}{` : (el && ['DIV','P'].includes(el.tagName) && !el.dataset.editable ? '\n\n' : '');
    if (root === target) return root.nodeType === Node.TEXT_NODE
      ? escapeLatex((root.textContent || '').slice(0,offset)).replaceAll('\u00a0','~')
      : value + [...root.childNodes].slice(0,offset).map(serializeInline).join('');
    if (!root.contains(target)) return null;
    if (el?.dataset.latex !== undefined) return '';
    for (const child of root.childNodes) {
      const partial = this.prefix(child,target,offset);
      if (partial !== null) return value + partial;
      value += serializeInline(child);
    }
    return value;
  }
  selection(): {from:number;to:number} | null {
    const selection = getSelection(); if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const first = this.leaves.find(l=>l.element.contains(range.startContainer));
    const last = this.leaves.find(l=>l.element.contains(range.endContainer));
    if (!first || !last) return null;
    return {from:first.span.from + (this.prefix(first.element,range.startContainer,range.startOffset)?.length || 0), to:last.span.from + (this.prefix(last.element,range.endContainer,range.endOffset)?.length || 0)};
  }
  private point(position: number, end = false): {node:Node; offset:number} | null {
    const leaf = this.leaves.find(l=>position >= l.span.from && position <= l.span.to);
    if (!leaf) return null;
    const walker = document.createTreeWalker(leaf.element,NodeFilter.SHOW_TEXT);
    let node: Node | null; let closest: {node:Node;offset:number;distance:number} | null = null;
    while ((node=walker.nextNode())) {
      if ((node.parentElement as HTMLElement)?.closest('[data-latex]')) continue;
      for (let offset=0;offset<=(node.textContent?.length || 0);offset++) {
        const at=leaf.span.from+(this.prefix(leaf.element,node,offset)?.length || 0);
        const distance=Math.abs(at-position);
        if (!closest || distance<closest.distance || (end && distance===closest.distance)) closest={node,offset,distance};
        if (!distance) return {node,offset};
      }
    }
    return closest;
  }
  private restoreSelection(from:number,to:number) {
    const start=this.point(from),end=this.point(to,true); if (!start || !end) return;
    const range=document.createRange(); range.setStart(start.node,start.offset);range.setEnd(end.node,end.offset);
    const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);
  }
  private refreshReviewMarks() {
    this.page.querySelectorAll('.visual-review-badge').forEach(el=>el.remove());
    const ranges: Record<string, Range[]> = {comment:[],addition:[],revision:[]};
    for (const mark of this.options.marks()) {
      if (mark.to > mark.from && ranges[mark.kind]) {
        const start=this.point(mark.from), end=this.point(mark.to,true);
        if (start && end) { const range=document.createRange();range.setStart(start.node,start.offset);range.setEnd(end.node,end.offset);ranges[mark.kind].push(range); }
      }
      const leaf=this.leaves.find(l=>mark.from>=l.span.from && mark.from<=l.span.to);
      if (!leaf) continue;
      const badge=document.createElement('button'); badge.className='visual-review-badge'; badge.dataset.reviewId=mark.id;
      badge.textContent=mark.kind==='comment' ? 'Comment' : mark.kind==='deletion' ? 'Deleted text' : 'Suggestion';
      badge.title=`${mark.author}: ${mark.note || mark.kind}`; badge.onclick=()=>this.options.review(mark.id);
      leaf.element.insertAdjacentElement('afterend',badge);
    }
    const highlights=(CSS as any).highlights, HighlightClass=(window as any).Highlight;
    if (highlights && HighlightClass) for (const [kind,list] of Object.entries(ranges)) highlights.set('visual-'+kind,new HighlightClass(...list));
  }
  refreshReviews() { if (!this.host.hidden) this.refreshReviewMarks(); }
  show() { this.host.hidden = false; this.sync(true); }
  hide() { if (this.composing && this.active) { const leaf = this.leaves.find(l=>l.element === this.active); if (leaf) this.saveLeaf(leaf); } this.host.hidden = true; this.source = ''; this.active = null; }
}
