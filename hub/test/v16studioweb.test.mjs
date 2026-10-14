// Studio web screen (T-61): the pure block logic, the local store fallback and the "no innerHTML" rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  splitBlock, mergeBack, pasteText, shortcutFor, reanchor, reanchorAll, moveComments, nextBlockId, cleanBlocks, titleFrom,
} from '../../web/studio/blocks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const B = (id, type, text) => ({ id, type, text });

test('Enter splits a block and the new block gets a fresh stable id', () => {
  const r = splitBlock([B('b1', 'p', 'hello world')], 'b1', 5);
  assert.deepEqual(r.blocks, [B('b1', 'p', 'hello'), B('b2', 'p', ' world')]);
  assert.equal(r.focusId, 'b2');
});
test('Enter in a heading starts a paragraph; in a list it continues the list; on an empty item it ends the list', () => {
  assert.equal(splitBlock([B('b1', 'h1', 'Title')], 'b1', 5).blocks[1].type, 'p');
  assert.equal(splitBlock([B('b1', 'li', 'a')], 'b1', 1).blocks[1].type, 'li');
  const r = splitBlock([B('b1', 'li', '')], 'b1', 0);
  assert.deepEqual(r.blocks, [B('b1', 'p', '')]);
});
test('Backspace at the start merges into the previous block (previous id survives)', () => {
  const r = mergeBack([B('b1', 'p', 'ab'), B('b2', 'p', 'cd')], 'b2');
  assert.deepEqual(r.blocks, [B('b1', 'p', 'abcd')]);
  assert.equal(r.offset, 2);
  assert.equal(r.removed, 'b2');
});
test('Backspace at the start of the first block: heading becomes paragraph, paragraph is a no-op', () => {
  assert.equal(mergeBack([B('b1', 'h2', 'x')], 'b1').blocks[0].type, 'p');
  assert.equal(mergeBack([B('b1', 'p', 'x')], 'b1'), null);
});
test('paste is plain text: lines become blocks, code keeps newlines, no markup is interpreted', () => {
  const r = pasteText([B('b1', 'p', 'ac')], 'b1', 1, 1, 'X\nY\nZ');
  assert.deepEqual(r.blocks.map((b) => b.text), ['aX', 'Y', 'Zc']);
  const c = pasteText([B('b1', 'code', 'ac')], 'b1', 1, 1, 'X\nY');
  assert.equal(c.blocks.length, 1);
  assert.equal(c.blocks[0].text, 'aX\nYc');
  const t = pasteText([B('b1', 'p', '')], 'b1', 0, 0, '<b onclick=x>hi</b>');
  assert.equal(t.blocks[0].text, '<b onclick=x>hi</b>'); // stays inert text
});
test('typing shortcuts turn a paragraph into a heading, list, quote or code block', () => {
  assert.deepEqual(shortcutFor(B('b1', 'p', '## Plan')), { type: 'h2', text: 'Plan' });
  assert.deepEqual(shortcutFor(B('b1', 'p', '- item')), { type: 'li', text: 'item' });
  assert.equal(shortcutFor(B('b1', 'h1', '# x')), null);
});
test('comment anchors survive edits: same offsets, then nearest match, then orphaned', () => {
  const c = { id: 'c1', blockId: 'b1', start: 4, end: 9, quote: 'quick', state: 'open' };
  assert.deepEqual(reanchor(c, 'The quick fox'), { start: 4, end: 9 });
  assert.deepEqual(reanchor(c, 'Oh, the quick fox'), { start: 8, end: 13 });
  assert.equal(reanchor(c, 'The slow fox'), null);
  const out = reanchorAll([c], [B('b1', 'p', 'The slow fox')]);
  assert.equal(out[0].state, 'orphaned');
  assert.equal(reanchorAll([out[0]], [B('b1', 'p', 'a quick one')])[0].state, 'open'); // text came back
});
test('comments follow their text when blocks merge', () => {
  const c = { id: 'c1', blockId: 'b2', start: 1, end: 3, quote: 'bc', state: 'open' };
  assert.deepEqual(moveComments([c], 'b2', 'b1', 4)[0], { ...c, blockId: 'b1', start: 5, end: 7 });
});
test('ids and cleaning', () => {
  assert.equal(nextBlockId([B('b3', 'p', ''), B('b1', 'p', '')]), 'b4');
  assert.deepEqual(cleanBlocks([{ id: 'x', type: 'weird', text: 5 }]), [B('b1', 'p', '')]);
  assert.equal(titleFrom('  A one-pager\nmore'), 'A one-pager');
});

test('local store: create, save, comments, archive, with a localStorage that throws', async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const { createStudioStore, localBackend } = await import('../../web/studio/store.js');
  const s = createStudioStore(localBackend());
  const { doc } = await s.createDoc({ projectId: 'P-1', prompt: 'Write a CV' });
  assert.equal((await s.listDocs()).length, 1);
  await s.saveBlocks(doc.id, [B('b1', 'h1', 'Hi'), B('b2', 'p', 'there')], 'Hi');
  await s.saveComments(doc.id, [{ id: 'c1', blockId: 'b2', start: 0, end: 5, quote: 'there', text: 'x', state: 'open' }]);
  const back = await s.getDoc(doc.id);
  assert.equal(back.doc.blocks[1].text, 'there');
  assert.equal(back.comments.length, 1);
  assert.equal((await s.applyAll(doc.id)).ok, false); // a browser-only document cannot run the doc_edit job
  await s.deleteDoc(doc.id);
  assert.equal((await s.listDocs()).length, 0);
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  const { doc: d2 } = await s.createDoc({ prompt: 'again' }); // must not throw
  assert.ok(d2.id);
  delete globalThis.localStorage;
});

test('hard rule: Studio sources never write HTML strings into the DOM', () => {
  const files = ['studio/blocks.js', 'studio/editor.js', 'studio/paper.js', 'studio/store.js', 'studio/sync.js', 'studio/export.js', 'views/studio.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/.test(src), `${f} must not use HTML sinks`);
  }
});
