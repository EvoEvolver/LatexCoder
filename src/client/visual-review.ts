import { parseReviews } from '../shared/review';

/** Project review storage into the visible source while retaining both boundary
 * affinities, so edits never include a hidden review marker by accident. */
export function projectReviews(raw: string) {
  let text = '', cursor = 0;
  const starts: number[] = [], ends: number[] = [];
  const marks: {from: number; to: number; id: string; kind: string; author: string; note: string}[] = [];
  function copy(from: number, to: number) {
    for (let i = from; i < to; i++) { starts[text.length] = i; text += raw[i]; ends[text.length] = i + 1; }
  }
  for (const item of parseReviews(raw)) {
    if (item.from < cursor) continue;
    copy(cursor, item.from);
    const from = text.length;
    if (item.kind !== 'deletion') copy(item.bodyFrom, item.bodyTo);
    marks.push({from, to:text.length, id:item.id, kind:item.kind, author:item.author, note:item.kind === 'deletion' ? item.body : item.note});
    cursor = item.to;
  }
  copy(cursor, raw.length); starts[text.length] = raw.length; ends[0] = 0;
  return { text, marks,
    range(from: number, to: number) {
      if (from === to) {
        // Prefer the end of an existing addition so continued typing extends it.
        const addition = marks.find(mark => mark.kind === 'addition' && mark.to === from);
        const at = addition ? ends[from] : starts[from] ?? ends[from] ?? 0;
        return { from:at, to:at };
      }
      return {from: starts[from] ?? raw.length, to: ends[to] ?? raw.length};
    },
  };
}
