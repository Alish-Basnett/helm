// v0.23: Studio model jobs. doc_draft (JSON blocks) and doc_edit ("Apply all"): the hub judges every patch with deterministic code
// (block exists, hash of the block still matches, schema, scope), applies the good ones as ONE version and records a state per comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';
import { judgePatches, cleanBlocks, parseMarkdown, blockHash } from '../docs.mjs';
import { draftBlocks } from '../docsengine.mjs';

const T0 = 1_800_000_000_000;
async function setup() {
  const h = await startTest();
  const clock = { t: T0 };
  h.hub.setClock(() => clock.t);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }, clock.t));
  return { h, clock, pid: h.state().projects[0].id };
}
const LONG = '# Title\n\nAlpha one.\n\nBeta two.\n\nGamma three.\n\nDelta four.\n\nEpsilon five.\n\nZeta six.'; // b1..b7
const mk = (h, pid, md = LONG) => h.api('POST', '/v1/docs', { projectId: pid, title: 'Doc', markdown: md });
const result = (h, clock, jobId, text) => { h.hub.claimJobs('s1', clock.t); h.send(h.ev('s1', 'job.result', { jobId, ok: true, text }, clock.t)); };
const comment = (h, blockId, text = 'change it', start = 0, end = 4) => h.api('POST', '/v1/docs/D-1/comments', { blockId, start, end, text });
const patches = (list) => '```json\n' + JSON.stringify({ patches: list }) + '\n```';

// ---------------------------------------------------------------- pure judge
test('judge: replace_text keeps marks outside the changed words; retype changes only the type', () => {
  const blocks = cleanBlocks([
    { type: 'p', text: 'Hello bold world', marks: [{ s: 6, e: 10, t: 'b' }] },
    { type: 'p', text: 'Plain sentence here.' },
  ]).blocks;
  const r = judgePatches(blocks, 3, ['C-1', 'C-2'], [
    { commentId: 'C-1', blockId: 'b1', op: 'replace_text', text: 'Hello bold planet' },
    { commentId: 'C-2', blockId: 'b2', op: 'retype', type: 'h2' },
  ]);
  assert.deepEqual(r.results.map((x) => x.status), ['applied', 'applied']);
  assert.equal(r.blocks[0].text, 'Hello bold planet');
  assert.deepEqual(r.blocks[0].marks, [{ s: 6, e: 10, t: 'b' }]);
  assert.deepEqual([r.blocks[1].type, r.blocks[1].text, r.blocks[1].id], ['h2', 'Plain sentence here.', 'b2']);
});

test('judge: bad ops, bad types, no-op replacements and a second whole-text change to one block are conflicts with reasons', () => {
  const blocks = cleanBlocks(parseMarkdown('# H\n\nalpha\n\n| a |\n|---|\n| 1 |')).blocks; // b1 h1, b2 p, b3 table
  const run = (ps) => judgePatches(blocks, 4, ps.map((p) => p.commentId), ps).results;
  const [a, b, c, d, e] = run([
    { commentId: 'C-1', blockId: 'b2', op: 'explode' },
    { commentId: 'C-2', blockId: 'b2', op: 'retype', type: 'table' },
    { commentId: 'C-3', blockId: 'b3', op: 'retype', type: 'p' },
    { commentId: 'C-4', blockId: 'b2', op: 'replace_text', text: 'alpha' },
    { commentId: 'C-5', blockId: 'b3', op: 'replace_text', text: 'x' },
  ]);
  assert.match(a.reason, /unknown patch op/);
  assert.match(b.reason, /cannot retype to/);
  assert.match(c.reason, /cannot retype a table/);
  assert.match(d.reason, /same as the original/);
  assert.match(e.reason, /cannot replace text in a table/);
  const two = judgePatches(blocks, 4, ['C-1', 'C-2'], [
    { commentId: 'C-1', blockId: 'b2', op: 'replace_text', text: 'beta' },
    { commentId: 'C-2', blockId: 'b2', op: 'replace_text', text: 'gamma' },
  ]);
  assert.deepEqual(two.results.map((x) => x.status), ['applied', 'conflict']);
  assert.match(two.results[1].reason, /already changed/);
  assert.equal(two.blocks[1].text, 'beta');
});

test('judge: a block whose hash no longer matches is a conflict, even when the patch text would still fit', () => {
  const blocks = cleanBlocks(parseMarkdown('one two three')).blocks;
  const stale = blockHash({ ...blocks[0], text: 'one two' });
  const r = judgePatches(blocks, 2, ['C-1'], [{ commentId: 'C-1', blockId: 'b1', op: 'replace', find: 'two', with: '2' }], { hashes: { b1: stale } });
  assert.equal(r.results[0].status, 'conflict');
  assert.match(r.results[0].reason, /edited while the job ran/);
  assert.equal(r.blocks[0].text, 'one two three');
  const ok = judgePatches(blocks, 2, ['C-1'], [{ commentId: 'C-1', blockId: 'b1', op: 'replace', find: 'two', with: '2' }], { hashes: { b1: blockHash(blocks[0]) } });
  assert.equal(ok.results[0].status, 'applied');
});

test('judge: only commented blocks can change; insert_after may sit beside a commented block; whole-doc comments may touch any block', () => {
  const blocks = cleanBlocks(parseMarkdown('# T\n\nA\n\nB\n\nC\n\nD\n\nE')).blocks; // b1..b6, comment on b3 (B)
  const scope = { commentBlocks: { 'C-1': 'b3', 'C-2': 'b3', 'C-3': 'b3', 'C-4': 'b3', 'C-5': 'b3' } };
  const ids = ['C-1', 'C-2', 'C-3', 'C-4', 'C-5'];
  const r = judgePatches(blocks, 7, ids, [
    { commentId: 'C-1', blockId: 'b5', op: 'delete' },                                            // an uncommented block
    { commentId: 'C-2', blockId: 'b6', op: 'insert_after', blocks: [{ type: 'p', text: 'far' }] },  // not beside a commented block
    { commentId: 'C-3', blockId: 'b4', op: 'insert_after', blocks: [{ type: 'p', text: 'near' }] },  // direct neighbour
    { commentId: 'C-4', blockId: 'b3', op: 'replace_text', text: 'B!' },                              // its own block
    { commentId: 'C-5', blockId: 'b2', op: 'replace_text', text: 'A!' },                              // a neighbour is context, not a target
  ], scope);
  assert.deepEqual(r.results.map((x) => x.status), ['conflict', 'conflict', 'applied', 'applied', 'conflict']);
  assert.match(r.results[0].reason, /not on/);
  assert.deepEqual(r.blocks.map((b) => b.text), ['T', 'A', 'B!', 'C', 'near', 'D', 'E']);
  const whole = judgePatches(blocks, 7, ['C-1'], [{ commentId: 'C-1', blockId: 'b5', op: 'replace_text', text: 'D!' }], { commentBlocks: { 'C-1': null } });
  assert.equal(whole.results[0].status, 'applied');
});

test('draftBlocks: JSON blocks (fenced or bare), markdown fallback, broken JSON is an error, model ids are ignored', () => {
  const j = draftBlocks('```json\n{"blocks":[{"id":"b9","type":"h1","text":"T"},{"type":"p","text":"Hi **x**","marks":[{"s":3,"e":4,"t":"b"}]}]}\n```');
  assert.deepEqual(cleanBlocks(j).blocks.map((b) => [b.id, b.type]), [['b1', 'h1'], ['b2', 'p']]);
  assert.equal(draftBlocks('{"blocks":[{"type":"p","text":"x"}]}').length, 1);
  assert.deepEqual(draftBlocks('# Title\n\nBody').map((b) => b.type), ['h1', 'p']);
  assert.throws(() => draftBlocks('{"blocks":[{"type":"p","text":"cut off'), /not valid JSON/);
  assert.throws(() => draftBlocks('{"title":"x"}'), /no "blocks" list/);
  assert.throws(() => cleanBlocks(draftBlocks('{"blocks":[{"type":"marquee","text":"x"}]}')), /block type must be/);
});

// ----------------------------------------------------------------- doc_draft
test('doc_draft: JSON blocks become version 1; broken or invalid JSON fails the job and leaves the doc empty at version 0', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  const mkDraft = (title) => h.api('POST', '/v1/docs', { projectId: pid, title, prompt: 'Write a note about caching' });
  const a = await mkDraft('A');
  assert.equal(a.json.job.kind, 'doc_draft');
  result(h, clock, a.json.job.id, '```json\n' + JSON.stringify({ blocks: [
    { type: 'h1', text: 'Caching' }, { type: 'p', text: 'It is fast.', marks: [{ s: 6, e: 10, t: 'b' }] },
    { type: 'li', text: 'one' }, { type: 'quote', text: 'q' }, { type: 'code', text: 'x = 1' }, { type: 'h3', text: 'Small' },
  ] }) + '\n```');
  const d = (await h.get('/v1/docs/D-1')).json;
  assert.deepEqual(d.doc.blocks.map((b) => [b.id, b.type]), [['b1', 'h1'], ['b2', 'p'], ['b3', 'li'], ['b4', 'quote'], ['b5', 'code'], ['b6', 'h3']]);
  assert.deepEqual(d.doc.blocks[1].marks, [{ s: 6, e: 10, t: 'b' }]);
  assert.equal(d.doc.version, 1);
  assert.equal(d.versions[0].cause, 'draft');
  assert.equal(h.state().jobs.find((j) => j.id === a.json.job.id).state, 'done');
  // broken JSON (a reply cut off by max_tokens) is a failed job, not a half document
  const b = await mkDraft('B');
  result(h, clock, b.json.job.id, '{"blocks":[{"type":"p","text":"cut off here');
  const jb = h.state().jobs.find((j) => j.id === b.json.job.id);
  assert.equal(jb.state, 'failed');
  assert.match(jb.error, /not valid JSON/);
  const db = (await h.get('/v1/docs/D-2')).json.doc;
  assert.deepEqual([db.version, db.blocks.length], [0, 0]);
  // schema-invalid blocks fail too
  const c = await mkDraft('C');
  result(h, clock, c.json.job.id, JSON.stringify({ blocks: [{ type: 'marquee', text: 'x' }] }));
  assert.match(h.state().jobs.find((j) => j.id === c.json.job.id).error, /block type must be/);
  assert.equal((await h.get('/v1/docs/D-3')).json.doc.version, 0);
});

// ------------------------------------------------------------------ doc_edit
test('doc_edit input: only commented blocks and one neighbour each side, each with a base hash', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await mk(h, pid);
  await comment(h, 'b3');                 // Beta
  const j = (await h.api('POST', '/v1/docs/D-1/apply', {})).json.job;
  assert.deepEqual(j.input.blocks.map((b) => b.id), ['b2', 'b3', 'b4']);
  const doc = (await h.get('/v1/docs/D-1')).json.doc;
  for (const b of j.input.blocks) assert.equal(b.hash, blockHash(doc.blocks.find((x) => x.id === b.id)));
  assert.deepEqual(j.input.comments.map((c) => [c.id, c.blockId]), [['C-1', 'b3']]);
  assert.ok(JSON.stringify(j.input).length < 2000, 'the prompt stays small');
});

test('Apply all: valid patches become ONE version, each comment gets applied or conflict, one revert undoes the batch', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await mk(h, pid);
  await comment(h, 'b2', 'rename');   // C-1
  await comment(h, 'b3', 'drop');     // C-2
  await comment(h, 'b4', 'retype');   // C-3
  await comment(h, 'b5', 'expand');   // C-4
  await comment(h, 'b6', 'touch');    // C-5, patched on an UNcommented block below
  await comment(h, 'b7', 'ghost');    // C-6: the model returns no patch for it
  const before = (await h.get('/v1/docs/D-1')).json;
  const job = (await h.api('POST', '/v1/docs/D-1/apply', {})).json.job;
  result(h, clock, job.id, patches([
    { commentId: 'C-1', blockId: 'b2', op: 'replace_text', text: 'Alpha ONE.' },
    { commentId: 'C-2', blockId: 'b3', op: 'delete' },
    { commentId: 'C-3', blockId: 'b4', op: 'retype', type: 'h2' },
    { commentId: 'C-4', blockId: 'b5', op: 'insert_after', blocks: [{ type: 'p', text: 'More about epsilon.' }] }, // after Delta
    { commentId: 'C-5', blockId: 'b1', op: 'replace_text', text: 'Hacked title' },   // b1 has no comment: refused
  ]));
  const d = (await h.get('/v1/docs/D-1')).json;
  assert.equal(d.doc.version, before.doc.version + 1, 'exactly one new version for the whole batch');
  assert.equal(d.versions[0].cause, 'apply');
  assert.deepEqual(d.doc.blocks.map((b) => b.text), ['Title', 'Alpha ONE.', 'Gamma three.', 'Delta four.', 'More about epsilon.', 'Epsilon five.', 'Zeta six.']);
  assert.equal(d.doc.blocks[0].text, 'Title', 'the uncommented heading is untouched');
  assert.equal(d.doc.blocks[2].type, 'h2');
  assert.deepEqual(d.comments.map((c) => c.state), ['applied', 'applied', 'applied', 'applied', 'conflict', 'conflict']);
  assert.deepEqual(d.comments.map((c) => c.appliedVersion), [d.doc.version, d.doc.version, d.doc.version, d.doc.version, null, null]);
  assert.match(d.comments[4].reason, /not on/);
  assert.match(d.comments[5].reason, /no change/);
  assert.equal(h.state().jobs.find((j) => j.id === job.id).state, 'done');
  // one undo reverts the whole batch and re-opens exactly the comments it applied
  const rv = await h.api('POST', '/v1/docs/D-1/revert', { toVersion: d.doc.version - 1 });
  assert.equal(rv.json.doc.version, d.doc.version + 1, 'the revert is a new version; history is kept');
  assert.deepEqual(rv.json.doc.blocks.map((b) => b.text), before.doc.blocks.map((b) => b.text));
  const after = (await h.get('/v1/docs/D-1')).json;
  assert.deepEqual(after.comments.map((c) => c.state), ['open', 'open', 'open', 'open', 'conflict', 'conflict']);
  assert.deepEqual(after.versions.map((v) => v.cause).slice(0, 2), ['revert', 'apply']);
  // ...and the same comments can be applied again
  const again = await h.api('POST', '/v1/docs/D-1/apply', {});
  assert.equal(again.status, 201);
  assert.deepEqual(again.json.job.input.commentIds, ['C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6']);
});

test('Apply all: nothing valid in the reply means no new version; a block edited while the job ran is a per-comment conflict', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await mk(h, pid);
  await comment(h, 'b2'); await comment(h, 'b4');
  const job = (await h.api('POST', '/v1/docs/D-1/apply', {})).json.job;
  const v0 = (await h.get('/v1/docs/D-1')).json.doc.version;
  await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ blockId: 'b2', text: 'Typed by hand.' }] }); // user edits a commented block meanwhile
  result(h, clock, job.id, patches([
    { commentId: 'C-1', blockId: 'b2', op: 'replace', find: 'one', with: '1' },        // find would still match? no: b2 changed, hash differs
    { commentId: 'C-2', blockId: 'b4', op: 'replace_text', text: 'Gamma 3.' },
  ]));
  const d = (await h.get('/v1/docs/D-1')).json;
  assert.deepEqual(d.comments.map((c) => c.state), ['conflict', 'applied']);
  assert.match(d.comments[0].reason, /edited while the job ran/);
  assert.equal(d.doc.blocks[1].text, 'Typed by hand.', 'the user text is never overwritten');
  assert.equal(d.doc.blocks[3].text, 'Gamma 3.');
  assert.equal(d.doc.version, v0 + 2, 'one version for the hand edit, one for the batch');
  // when every patch is refused nothing is written
  await comment(h, 'b6');
  const j2 = (await h.api('POST', '/v1/docs/D-1/apply', { commentIds: ['C-3'] })).json.job;
  const v1 = (await h.get('/v1/docs/D-1')).json.doc.version;
  result(h, clock, j2.id, patches([{ commentId: 'C-3', blockId: 'b2', op: 'delete' }]));
  const e = (await h.get('/v1/docs/D-1')).json;
  assert.equal(e.doc.version, v1);
  assert.equal(e.comments[2].state, 'conflict');
});

test('Apply all: a reply that is not JSON fails the job and frees the comments', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await mk(h, pid);
  await comment(h, 'b2');
  const job = (await h.api('POST', '/v1/docs/D-1/apply', {})).json.job;
  result(h, clock, job.id, '{"patches":[{"commentId":"C-1","blockId":"b2","op":"del');
  assert.equal(h.state().jobs.find((j) => j.id === job.id).state, 'failed');
  const d = (await h.get('/v1/docs/D-1')).json;
  assert.equal(d.comments[0].state, 'open');
  assert.equal(d.doc.version, 0);
});

test('edit: the browser may choose the id of a block it inserts (kept when free), so its comments keep pointing at it', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await mk(h, pid, '# T\n\nOne');
  const r = await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ op: 'insert', after: 'b2', block: { id: 'b7', type: 'p', text: 'Mine' } }] });
  assert.deepEqual(r.json.doc.blocks.map((b) => b.id), ['b1', 'b2', 'b7']);
  const r2 = await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ op: 'insert', after: 'b7', block: { id: 'b7', type: 'p', text: 'Clash' } }, { op: 'insert', after: 'b7', block: { id: 'x1', type: 'p', text: 'Bad id' } }] });
  const ids = r2.json.doc.blocks.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, 'ids stay unique');
  assert.ok(ids.every((i) => /^b\d+$/.test(i)));
  assert.equal((await comment(h, 'b7', 'on mine', 0, 4)).status, 201);
});

test('rebuild: a doc with a draft, a mixed Apply all, a conflict and an undo replays byte for byte', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  const d = await h.api('POST', '/v1/docs', { projectId: pid, title: 'Doc', prompt: 'p' });
  result(h, clock, d.json.job.id, JSON.stringify({ blocks: [
    { type: 'h1', text: 'T' }, { type: 'p', text: 'Alpha beta.' }, { type: 'p', text: 'Gamma delta.' }, { type: 'p', text: 'Epsilon zeta.' } ] }));
  await comment(h, 'b2'); await comment(h, 'b3'); await comment(h, 'b4');
  const job = (await h.api('POST', '/v1/docs/D-1/apply', {})).json.job;
  result(h, clock, job.id, patches([
    { commentId: 'C-1', blockId: 'b2', op: 'replace_text', text: 'Alpha gamma.' },
    { commentId: 'C-2', blockId: 'b3', op: 'retype', type: 'quote' },
    { commentId: 'C-3', blockId: 'b4', op: 'insert_after', blocks: [{ type: 'li', text: 'item' }] },
  ]));
  const v = (await h.get('/v1/docs/D-1')).json.doc.version;
  await h.api('POST', '/v1/docs/D-1/revert', { toVersion: v - 1 });
  const j2 = (await h.api('POST', '/v1/docs/D-1/apply', { commentIds: ['C-1'] })).json.job;
  result(h, clock, j2.id, patches([{ commentId: 'C-1', blockId: 'b2', op: 'reply', text: 'cannot' }]));
  const before = h.hub.dump(), st = h.state();
  assert.ok(before.doc_versions.length >= 4);
  assert.ok(before.doc_comments.some((c) => c.state === 'conflict') && before.doc_comments.some((c) => c.state === 'open'));
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...st, seq: 0 });
});
