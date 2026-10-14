// v0.23 Studio web: the hub backend of studio/store.js against a real in-process hub, the pure sync helpers, and local migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';
import { diffBlocks, toEditorBlocks, diffComments, toLocalComment, docJobs, jobActive, jobProgress, undoableBatch } from '../../web/studio/sync.js';
import { createStudioStore, hubBackend, localBackend } from '../../web/studio/store.js';

const B = (id, type, text) => ({ id, type, text });
const T0 = 1_800_000_000_000;

test('diffBlocks: only changed blocks are sent; type changes keep marks; inserts keep the editor id; deletes come first', () => {
  const base = [B('b1', 'h1', 'T'), B('b2', 'p', 'one'), B('b3', 'p', 'two'), B('b4', 'p', 'gone')];
  const next = [B('b1', 'h1', 'T'), B('b2', 'h2', 'one'), B('b5', 'p', 'new'), B('b3', 'p', 'two!')];
  assert.deepEqual(diffBlocks(base, next), [
    { op: 'delete', blockId: 'b4' },
    { op: 'set', blockId: 'b2', type: 'h2' },
    { op: 'insert', after: 'b2', block: { id: 'b5', type: 'p', text: 'new' } },
    { op: 'set', blockId: 'b3', text: 'two!' },
  ]);
  assert.deepEqual(diffBlocks(base, base), []);
  assert.deepEqual(diffBlocks([], [B('b1', 'p', '')]), [{ op: 'insert', after: null, block: { id: 'b1', type: 'p', text: '' } }]);
});

test('toEditorBlocks: tables and images show as flat text, unknown types as paragraphs, and an untouched one produces no op', () => {
  const hubBlocks = [{ id: 'b1', type: 'table', rows: [['a', 'b'], ['1', '2']], text: '', marks: [] }, { id: 'b2', type: 'hr', text: '' }, { id: 'b3', type: 'li', text: 'x', level: 2 }];
  const ed = toEditorBlocks(hubBlocks);
  assert.deepEqual(ed.map((b) => [b.type, b.text]), [['p', 'a | b / 1 | 2'], ['p', ''], ['li', 'x']]);
  assert.deepEqual(diffBlocks(ed, ed.map((b) => ({ ...b }))), []);
});

test('diffComments: local ids are created, vanished hub comments deleted (never a queued one), edited text patched', () => {
  const hub = [{ id: 'C-1', text: 'a', state: 'open' }, { id: 'C-2', text: 'b', state: 'open' }, { id: 'C-3', text: 'c', state: 'queued' }];
  const local = [{ id: 'C-1', text: 'a!', blockId: 'b1' }, { id: 'c1', text: 'new', blockId: 'b2' }, { id: 'c2', text: 'no block', blockId: null }];
  assert.deepEqual(diffComments(hub, local), { create: [local[1]], del: ['C-2'], patch: [{ id: 'C-1', text: 'a!' }] });
  assert.deepEqual(toLocalComment({ id: 'C-9', blockId: 'b2', anchor: { start: 1, end: 4, quote: 'abc' }, text: 't', state: 'conflict', reason: 'r', appliedVersion: null, jobId: 'J-1' }),
    { id: 'C-9', blockId: 'b2', start: 1, end: 4, quote: 'abc', text: 't', state: 'conflict', createdAt: undefined, reason: 'r', appliedVersion: null, jobId: 'J-1' });
});

test('job helpers: newest draft job, progress wording, and Undo only while the doc is exactly at the applied version', () => {
  const jobs = new Map([
    ['J-1', { id: 'J-1', kind: 'doc_draft', input: { docId: 'D-1' }, state: 'failed', createdAt: 10 }],
    ['J-2', { id: 'J-2', kind: 'doc_draft', input: { docId: 'D-1' }, state: 'running', createdAt: 20, claimedAt: 21_000 }],
    ['J-3', { id: 'J-3', kind: 'doc_draft', input: { docId: 'D-2' }, state: 'running', createdAt: 30 }],
  ]);
  assert.equal(docJobs(jobs, 'D-1').draft.id, 'J-2');
  assert.ok(jobActive(jobs.get('J-2')) && !jobActive(jobs.get('J-1')) && !jobActive(null));
  assert.match(jobProgress({ state: 'queued' }, 0), /Waiting for a Claude Code session/);
  assert.equal(jobProgress(jobs.get('J-2'), 33_000, 'Sonnet is writing'), 'Sonnet is writing… 12 s');
  const cs = [{ id: 'C-1', state: 'applied', appliedVersion: 4 }, { id: 'C-2', state: 'conflict', appliedVersion: null }];
  assert.equal(undoableBatch(cs, 4).length, 1);
  assert.equal(undoableBatch(cs, 5), null);
});

async function liveStore(t) {
  const h = await startTest();
  t.after(h.stop);
  const clock = { t: T0 };
  h.hub.setClock(() => clock.t);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }, clock.t));
  const req = async (method, p, body) => {
    const r = await h.api(method, p, body);
    if (r.status >= 400) throw Object.assign(new Error(r.json?.error || `HTTP ${r.status}`), { status: r.status, data: r.json });
    return r.json;
  };
  const store = createStudioStore(localBackend(), hubBackend(req), async () => true);
  const reply = (jobId, text) => { h.hub.claimJobs('s1', clock.t); h.send(h.ev('s1', 'job.result', { jobId, ok: true, text }, clock.t)); };
  return { h, store, reply, pid: h.state().projects[0].id };
}

test('hub store: create queues the draft, saves are block diffs, comments get hub ids, Apply all lands as one version and Undo reverts it', async (t) => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  t.after(() => { delete globalThis.localStorage; });
  const { h, store, reply, pid } = await liveStore(t);
  const made = await store.createDoc({ projectId: pid, prompt: 'A short note about caching' });
  assert.equal(made.job.kind, 'doc_draft');
  assert.equal(made.doc.id, 'D-1');
  reply(made.job.id, JSON.stringify({ blocks: [{ type: 'h1', text: 'Caching' }, { type: 'p', text: 'Caching is fast and cheap.' }, { type: 'p', text: 'It can be stale.' }] }));
  let { doc, comments } = await store.getDoc('D-1');
  assert.deepEqual(doc.blocks.map((b) => [b.id, b.type]), [['b1', 'h1'], ['b2', 'p'], ['b3', 'p']]);
  assert.equal(doc.version, 1);
  // the user types a new block, edits one, retypes one: three small ops, one hub version, and the new block keeps its id
  const r = await store.saveBlocks('D-1', [B('b1', 'h1', 'Caching'), B('b2', 'p', 'Caching is fast.'), B('b4', 'p', 'Typed.'), B('b3', 'h2', 'It can be stale.')], 'Caching');
  assert.equal(r.version, 2);
  assert.deepEqual((await h.get('/v1/docs/D-1')).json.doc.blocks.map((b) => [b.id, b.type, b.text]),
    [['b1', 'h1', 'Caching'], ['b2', 'p', 'Caching is fast.'], ['b4', 'p', 'Typed.'], ['b3', 'h2', 'It can be stale.']]);
  // a comment made on screen (local id c1) is created on the hub and comes back with its hub id
  const sc = await store.saveComments('D-1', [{ id: 'c1', blockId: 'b2', start: 0, end: 7, quote: 'Caching', text: 'say "A cache"', state: 'open' }]);
  assert.deepEqual(sc.idMap, { c1: 'C-1' });
  const a = await store.applyAll('D-1');
  assert.ok(a.ok && a.count === 1);
  assert.equal((await store.getDoc('D-1')).comments[0].state, 'queued');
  reply(a.job.id, '```json\n' + JSON.stringify({ patches: [{ commentId: 'C-1', blockId: 'b2', op: 'replace_text', text: 'A cache is fast.' }] }) + '\n```');
  ({ doc, comments } = await store.getDoc('D-1'));
  assert.equal(doc.blocks[1].text, 'A cache is fast.');
  assert.deepEqual([comments[0].state, comments[0].appliedVersion, comments[0].jobId], ['applied', doc.version, a.job.id]);
  assert.equal(undoableBatch(comments, doc.version).length, 1);
  const u = await store.undoApply('D-1', doc.version - 1);
  assert.equal(u.doc.blocks[1].text, 'Caching is fast.');
  assert.equal((await store.getDoc('D-1')).comments[0].state, 'open');
  // no live session: Apply all says so instead of throwing
  h.send(h.ev('s1', 'session.ended', {}, T0));
  const no = await store.applyAll('D-1');
  assert.equal(no.ok, false);
  assert.match(no.reason, /no live session/i);
});

test('local documents with a project move to the hub on first save, with their comments; without a project they stay local', async (t) => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  t.after(() => { delete globalThis.localStorage; });
  const { h, store, pid } = await liveStore(t);
  const local = localBackend();
  const { doc } = await local.createDoc({ projectId: pid, title: 'Old', prompt: 'from the browser' }); // made while the hub was down
  const stay = (await local.createDoc({ projectId: null, title: 'Loose', prompt: 'no project' })).doc;
  assert.ok((await store.listDocs()).some((d) => d.id === doc.id));
  await store.saveComments(doc.id, [{ id: 'c1', blockId: 'b2', start: 0, end: 7, quote: 'from th', text: 'check', state: 'open' }]);
  const moved = await store.saveBlocks(doc.id, [B('b1', 'h1', 'Old'), B('b2', 'quote', 'from the browser'), B('b3', 'p', 'Body')], 'Old');
  assert.equal(moved.id, 'D-1');
  assert.deepEqual(moved.idMap, { c1: 'C-1' });
  const onHub = (await h.get('/v1/docs/D-1')).json;
  assert.deepEqual(onHub.doc.blocks.map((b) => b.text), ['Old', 'from the browser', 'Body']);
  assert.equal(onHub.comments[0].anchor.quote, 'from th');
  // later saves go to the hub, and the old local copy is gone from the list
  assert.equal((await store.saveBlocks('D-1', [B('b1', 'h1', 'Old'), B('b2', 'quote', 'from the browser'), B('b3', 'p', 'Body, edited')], 'Old')).version, 1);
  const list = await store.listDocs();
  const ids = list.map((d) => d.id); // (the store keeps a module-level memory copy, so other tests' documents may be listed too)
  assert.ok(ids.includes('D-1') && ids.includes(stay.id) && !ids.includes(doc.id));
  const keep = await store.saveBlocks(stay.id, [B('b1', 'h1', 'Loose'), B('b2', 'p', 'x')], 'Loose');
  assert.equal(keep.id, undefined);
  assert.equal((await h.get('/v1/docs')).json.docs.length, 1);
});

test('with the hub down the store is the local one: list, create and save keep working', async (t) => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  t.after(() => { delete globalThis.localStorage; });
  const down = async () => { throw new Error('offline'); };
  const store = createStudioStore(localBackend(), hubBackend(down), async () => { throw new Error('offline'); });
  const { doc } = await store.createDoc({ projectId: 'P-1', prompt: 'offline note' });
  assert.match(doc.id, /^L-/);
  assert.deepEqual((await store.saveBlocks(doc.id, [B('b1', 'h1', 'x')], 'x')).id, undefined);
  assert.ok((await store.listDocs()).some((d) => d.id === doc.id));
  assert.equal(await store.hubUp(), false);
});
