import test from 'node:test';
import assert from 'node:assert/strict';
import { projectReviews } from '../src/client/visual-review';

test('visible review projection maps text edits inside marker boundaries', () => {
 const raw='Before \\cmtbg{c1}{Alice}\\textbf{hello}\\cmted{note} after \\delbg{d1}{Bob}old\\deled\\addbg{d1}{Bob}new\\added.';
 const projection=projectReviews(raw);
 assert.equal(projection.text,'Before \\textbf{hello} after new.');
 const from=projection.text.indexOf('hello'); const range=projection.range(from,from+5);
 assert.equal(raw.slice(range.from,range.to),'hello');
 const added=projection.text.indexOf('new');
 const cursor=projection.range(added+3,added+3);
 assert.equal(raw.slice(cursor.from,cursor.from+7),'\\added.');
 assert.equal(projection.marks.filter(m=>m.kind==='deletion').length,1);
});
