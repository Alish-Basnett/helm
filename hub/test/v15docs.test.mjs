// v0.15: Studio documents (docs / doc_versions / doc_comments, hub.doc.* events, REST routes, doc_draft + doc_edit judging, export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest } from './helpers.mjs';
import {
  parseMarkdown, blocksToMarkdown, blocksToHtml, cleanBlocks, judgePatches, relocate, makeAnchor, parseInline,
} from '../docs.mjs';

const T0 = 1_800_000_000_000;
async function setup() {
  const h = await startTest();
  const clock = { t: T0 };
  h.hub.setClock(() => clock.t);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }, clock.t));
  return { h, clock, pid: h.state().projects[0].id };
}
const mk = (h, pid, md = '# Report\n\nFirst paragraph here.\n\nSecond paragraph here.') =>
  h.api('POST', '/v1/docs', { projectId: pid, title: 'Quarterly', markdown: md });
const tick = (h, clock, ms) => { clock.t += ms; };
const jobResult = (h, clock, jobId, text) => {
  h.hub.claimJobs('s1', clock.t);
  h.send(h.ev('s1', 'job.result', { jobId, ok: true, text }, clock.t));
};

test('pure: markdown round trip, inline marks, html escaping, closed block vocabulary', () => {
  const blocks = cleanBlocks(parseMarkdown('# T\n\nHello **bold** and *it* and [x](https://a.io).\n\n- one\n  - nested\n1. num\n\n> q\n\n```\ncode <b>\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---')).blocks;
  assert.deepEqual(blocks.map((b) => b.type), ['h1', 'p', 'li', 'li', 'li', 'quote', 'code', 'table', 'hr']);
  assert.deepEqual(blocks.map((b) => b.id), ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']);
  assert.equal(blocks[3].level, 1);
  assert.deepEqual(blocks[7].rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(blocks[1].marks.map((m) => m.t).sort(), ['a', 'b', 'i']);
  const md = blocksToMarkdown(blocks);
  assert.deepEqual(cleanBlocks(parseMarkdown(md)).blocks.map((b) => [b.type, b.text]), blocks.map((b) => [b.type, b.text]));
  assert.match(blocksToMarkdown(blocks, { ids: true }), /<!--b2--> Hello/);
  const html = blocksToHtml(cleanBlocks([{ type: 'p', text: '<script>alert(1)</script> & "q"' }, { type: 'code', text: '</pre><b>' }]).blocks, { title: '<x>' });
  assert.ok(!html.includes('<script>') && !html.includes('</pre><b>'));
  assert.match(html, /&lt;script&gt;/);
  assert.throws(() => cleanBlocks([{ type: 'script', text: 'x' }]), /block type/);
  assert.throws(() => cleanBlocks([{ type: 'p', text: 'x', marks: [{ s: 0, e: 9, t: 'b' }] }]), /outside/);
  assert.throws(() => cleanBlocks([{ type: 'p', text: 'x', marks: [{ s: 0, e: 1, t: 'a', href: 'javascript:alert(1)' }] }]), /href/);
  assert.throws(() => cleanBlocks([{ id: 'b1', type: 'p' }, { id: 'b1', type: 'p' }]), /duplicate/);
  assert.equal(parseInline('[bad](javascript:x)').marks.length, 0);
});

test('pure: anchors relocate by position, context, quote, or give up', () => {
  const b = { id: 'b1', type: 'p', text: 'The quick brown fox jumps' };
  const a = makeAnchor(b, 4, 9);
  assert.equal(a.quote, 'quick');
  assert.equal(relocate(a, b.text), a);
  assert.equal(relocate(a, 'Oh. The quick brown fox').start, 8);
  assert.equal(relocate(a, 'a quick one').start, 2);
  assert.equal(relocate(a, 'nothing here'), null);
  assert.throws(() => makeAnchor(b, 5, 5), /outside/);
});

test('pure: judgePatches applies exact single matches, flags everything else, one outcome per comment', () => {
  const blocks = cleanBlocks(parseMarkdown('# H\n\nalpha beta alpha\n\ngamma delta')).blocks;
  const r = judgePatches(blocks, 10, ['C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6'], [
    { commentId: 'C-1', blockId: 'b3', op: 'replace', find: 'delta', with: 'DELTA!' },
    { commentId: 'C-2', blockId: 'b2', op: 'replace', find: 'alpha', with: 'x' },      // twice in the block
    { commentId: 'C-3', blockId: 'b99', op: 'delete' },                                  // no such block
    { commentId: 'C-4', blockId: 'b1', op: 'insert_after', blocks: [{ type: 'p', text: 'new' }] },
    { commentId: 'C-5', op: 'reply', text: 'No data in the document.' },
    { commentId: 'C-ghost', blockId: 'b1', op: 'delete' },                                // not one of ours: ignored
  ]);
  assert.deepEqual(r.results.map((x) => [x.commentId, x.status]), [['C-1', 'applied'], ['C-2', 'conflict'], ['C-3', 'conflict'], ['C-4', 'applied'], ['C-5', 'conflict'], ['C-6', 'conflict']]);
  assert.equal(r.results[4].reason, 'No data in the document.');
  assert.equal(r.blocks.find((b) => b.id === 'b3').text, 'gamma DELTA!');
  assert.equal(r.blocks[1].text, 'new');
  assert.equal(r.blocks[1].id, 'b10');
  assert.equal(r.next, 11);
});

test('create seeds blocks, validates, indexes for search, appears in state and SSE', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const seen = [];
  h.hub.subscribe((rows) => seen.push(...rows.filter((r) => r.entity === 'doc')));
  assert.equal((await h.api('POST', '/v1/docs', { title: 'x' })).status, 404);
  assert.equal((await h.api('POST', '/v1/docs', { projectId: pid })).status, 400);
  assert.equal((await h.api('POST', '/v1/docs', { projectId: pid, title: 'x', kind: 'poem' })).status, 400);
  assert.equal((await h.api('POST', '/v1/docs', { projectId: pid, title: 'x', blocks: [{ type: 'p', text: 'a' }], markdown: 'b' })).status, 400);
  const r = await mk(h, pid);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.doc.id, 'D-1');
  assert.equal(r.json.doc.version, 0);
  assert.equal(r.json.doc.blocks.length, 3);
  assert.equal(r.json.job, null);
  assert.equal(seen.at(-1).op, 'upsert');
  assert.ok(h.hub.search('paragraph').some((x) => x.kind === 'doc' && x.id === 'D-1' && x.projectId === pid));
  assert.equal(h.state().docs.length, 1);
  assert.equal(h.state().docs[0].blocks, undefined);
  const d = (await h.get('/v1/docs/D-1')).json;
  assert.equal(d.versions.length, 1);
  assert.equal(d.versions[0].cause, 'create');
  assert.equal((await h.get('/v1/docs/D-9')).status, 404);
  assert.equal((await h.get(`/v1/docs?projectId=${pid}`)).json.docs.length, 1);
  // rename + archive (DELETE archives and hides it)
  assert.equal((await h.api('PATCH', '/v1/docs/D-1', { title: 'Q3' })).json.doc.title, 'Q3');
  assert.equal((await h.api('PATCH', '/v1/docs/D-1', { archived: 'x' })).status, 400);
  assert.equal((await h.api('DELETE', '/v1/docs/D-1')).json.doc.archived, true);
  assert.equal((await h.get('/v1/docs')).json.docs.length, 0);
  assert.equal((await h.get('/v1/docs?includeArchived=1')).json.docs.length, 1);
  assert.ok(!h.hub.search('paragraph').some((x) => x.kind === 'doc'));
});

test('edit: set / insert / delete ops, baseVersion 409, validation, and edits coalesce into one snapshot per 5 minutes', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await mk(h, pid);
  const e1 = await h.api('POST', '/v1/docs/D-1/edit', { baseVersion: 0, ops: [{ blockId: 'b2', text: 'First paragraph, edited.' }] });
  assert.equal(e1.status, 200, e1.text);
  assert.equal(e1.json.doc.version, 1);
  assert.equal(e1.json.doc.blocks[1].text, 'First paragraph, edited.');
  tick(h, clock, 60_000);
  const e2 = await h.api('POST', '/v1/docs/D-1/edit', { baseVersion: 1, ops: [
    { op: 'insert', after: 'b2', block: { type: 'p', text: 'Inserted.' } }, { op: 'delete', blockId: 'b3' }] });
  assert.equal(e2.json.doc.version, 1, 'within 5 minutes: same snapshot');
  assert.deepEqual(e2.json.doc.blocks.map((b) => b.text), ['Report', 'First paragraph, edited.', 'Inserted.']);
  assert.equal(e2.json.doc.blocks[2].id, 'b4');
  const stale = await h.api('POST', '/v1/docs/D-1/edit', { baseVersion: 0, ops: [{ blockId: 'b2', text: 'x' }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.version, 1);
  tick(h, clock, 6 * 60_000);
  assert.equal((await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ blockId: 'b1', text: 'Report v2' }] })).json.doc.version, 2, 'after the idle window: a new snapshot');
  for (const bad of [{}, { ops: [] }, { ops: [{ blockId: 'b99', text: 'x' }] }, { ops: [{ blockId: 'b1', text: 5 }] }, { ops: [{ blockId: 'b1', type: 'iframe' }] },
    { ops: [{ op: 'delete', blockId: 'zz' }] }, { ops: [{ op: 'insert', after: 'nope', block: { type: 'p', text: 'x' } }] }]) {
    assert.ok([400, 404].includes((await h.api('POST', '/v1/docs/D-1/edit', bad)).status), JSON.stringify(bad));
  }
  const versions = (await h.get('/v1/docs/D-1')).json.versions;
  assert.deepEqual(versions.map((v) => [v.n, v.cause]), [[2, 'edit'], [1, 'edit'], [0, 'create']]);
  assert.equal((await h.get('/v1/docs/D-1/versions/1')).json.version.blocks.length, 3);
  assert.equal((await h.get('/v1/docs/D-1/versions/9')).status, 404);
  // manual save seals the snapshot: the next edit starts a new one even inside the window
  assert.equal((await h.api('POST', '/v1/docs/D-1/save')).status, 200);
  assert.equal((await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ blockId: 'b1', text: 'Report v3' }] })).json.doc.version, 3);
  assert.equal((await h.get('/v1/docs/D-1')).json.versions.find((v) => v.n === 2).cause, 'manual');
});

test('comments: anchor from a selection, whole-doc comment, re-anchor on edit, orphaned and recovered, update, delete', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await mk(h, pid);
  const add = (body) => h.api('POST', '/v1/docs/D-1/comments', body);
  assert.equal((await add({ text: '' })).status, 400);
  assert.equal((await add({ text: 'x', blockId: 'b99', start: 0, end: 1 })).status, 404);
  assert.equal((await add({ text: 'x', blockId: 'b2', start: 5, end: 5 })).status, 400);
  const c1 = (await add({ text: 'Tighten this', blockId: 'b2', start: 0, end: 5 })).json.comment;
  assert.equal(c1.id, 'C-1');
  assert.equal(c1.anchor.quote, 'First');
  assert.equal(c1.state, 'open');
  const c2 = (await add({ text: 'More formal tone overall' })).json.comment;
  assert.equal(c2.anchor, null);
  // typing before the quote moves the anchor
  await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ blockId: 'b2', text: 'Well, First paragraph here.' }] });
  let cs = (await h.get('/v1/docs/D-1')).json.comments;
  assert.equal(cs[0].anchor.start, 6);
  assert.equal(cs[0].state, 'open');
  // removing the quote orphans it; putting it back recovers it
  await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ blockId: 'b2', text: 'Gone.' }] });
  assert.equal((await h.get('/v1/docs/D-1')).json.comments[0].state, 'orphaned');
  await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ blockId: 'b2', text: 'First again.' }] });
  assert.equal((await h.get('/v1/docs/D-1')).json.comments[0].state, 'open');
  // deleting the block orphans too
  await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ op: 'delete', blockId: 'b2' }] });
  assert.equal((await h.get('/v1/docs/D-1')).json.comments[0].state, 'orphaned');
  // update / dismiss / delete
  assert.equal((await h.api('PATCH', '/v1/docs/D-1/comments/C-2', { text: 'Formal please' })).json.comment.text, 'Formal please');
  assert.equal((await h.api('PATCH', '/v1/docs/D-1/comments/C-2', { state: 'applied' })).status, 400);
  assert.equal((await h.api('PATCH', '/v1/docs/D-1/comments/C-2', { state: 'dismissed' })).json.comment.state, 'dismissed');
  assert.equal((await h.api('PATCH', '/v1/docs/D-1/comments/C-2', {})).status, 400);
  assert.equal((await h.api('PATCH', '/v1/docs/D-1/comments/C-9', { text: 'x' })).status, 404);
  assert.equal((await h.api('DELETE', '/v1/docs/D-1/comments/C-1')).status, 200);
  assert.equal((await h.get('/v1/docs/D-1')).json.comments.length, 1);
});

test('apply: one doc_edit job, hub judges the reply, one new version, per-comment results, conflicts re-appliable', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await mk(h, pid);
  const add = (body) => h.api('POST', '/v1/docs/D-1/comments', body).then((r) => r.json.comment);
  await add({ text: 'Say "opening" instead', blockId: 'b2', start: 0, end: 5 });
  await add({ text: 'Cut this paragraph', blockId: 'b3', start: 0, end: 6 });
  await add({ text: 'Add revenue figures', blockId: 'b1', start: 0, end: 6 });
  const r = await h.api('POST', '/v1/docs/D-1/apply', {});
  assert.equal(r.status, 201, r.text);
  const job = r.json.job;
  assert.equal(job.kind, 'doc_edit');
  assert.deepEqual(job.input.commentIds, ['C-1', 'C-2', 'C-3']);
  assert.ok(job.input.blocks.length >= 3 && job.input.outline[0].id === 'b1');
  assert.deepEqual(r.json.comments.map((c) => c.state), ['queued', 'queued', 'queued']);
  assert.equal((await h.api('POST', '/v1/docs/D-1/apply', {})).status, 400, 'nothing open left');
  assert.equal((await h.api('PATCH', '/v1/docs/D-1/comments/C-1', { state: 'open' })).status, 409);
  const reply = '```json\n' + JSON.stringify({ patches: [
    { commentId: 'C-1', blockId: 'b2', op: 'replace', find: 'First', with: 'Opening' },
    { commentId: 'C-2', blockId: 'b3', op: 'delete' },
    { commentId: 'C-3', op: 'reply', text: 'There is no revenue data in the document.' },
  ] }) + '\n```';
  jobResult(h, clock, job.id, reply);
  const d = (await h.get('/v1/docs/D-1')).json;
  assert.deepEqual(d.doc.blocks.map((b) => b.text), ['Report', 'Opening paragraph here.']);
  assert.equal(d.doc.version, 1);
  assert.equal(d.versions[0].cause, 'apply');
  assert.deepEqual(d.comments.map((c) => [c.state, c.appliedVersion]), [['applied', 1], ['applied', 1], ['conflict', null]]);
  assert.match(d.comments[2].reason, /no revenue data/);
  const j = h.state().jobs.find((x) => x.id === job.id);
  assert.equal(j.state, 'done');
  assert.deepEqual(JSON.parse(j.result), { docId: 'D-1', applied: 2, conflicts: 1 });
  // a conflicted comment can be applied again; a garbage reply fails the job and frees the comment
  const r2 = await h.api('POST', '/v1/docs/D-1/apply', { commentIds: ['C-3'] });
  assert.equal(r2.status, 201, r2.text);
  jobResult(h, clock, r2.json.job.id, 'sorry, I cannot');
  assert.equal(h.state().jobs.find((x) => x.id === r2.json.job.id).state, 'failed');
  assert.equal((await h.get('/v1/docs/D-1')).json.comments[2].state, 'open');
  // revert writes a NEW version; history is not rewritten
  const rv = await h.api('POST', '/v1/docs/D-1/revert', { toVersion: 0 });
  assert.equal(rv.json.doc.version, 2);
  assert.equal(rv.json.doc.blocks.length, 3);
  assert.deepEqual((await h.get('/v1/docs/D-1')).json.versions.map((v) => v.cause), ['revert', 'apply', 'create']);
  assert.equal((await h.api('POST', '/v1/docs/D-1/revert', { toVersion: 7 })).status, 404);
  assert.equal((await h.api('POST', '/v1/docs/D-1/revert', { toVersion: 'x' })).status, 400);
});

test('apply without a live session is 409 and changes nothing; typing during a job does not break unrelated patches', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await mk(h, pid);
  await h.api('POST', '/v1/docs/D-1/comments', { text: 'Tweak', blockId: 'b3', start: 0, end: 6 });
  h.send(h.ev('s1', 'session.ended', {}, clock.t));
  const r = await h.api('POST', '/v1/docs/D-1/apply', {});
  assert.equal(r.status, 409);
  assert.equal((await h.get('/v1/docs/D-1')).json.comments[0].state, 'open');
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }, clock.t));
  const ok = await h.api('POST', '/v1/docs/D-1/apply', {});
  assert.equal(ok.status, 201, ok.text);
  // the user keeps typing elsewhere while the job runs; the patch still applies (string-level match)
  await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ blockId: 'b2', text: 'Typed while waiting.' }] });
  jobResult(h, clock, ok.json.job.id, JSON.stringify({ patches: [{ commentId: 'C-1', blockId: 'b3', op: 'replace', find: 'Second', with: '2nd' }] }));
  const d = (await h.get('/v1/docs/D-1')).json;
  assert.equal(d.doc.blocks[1].text, 'Typed while waiting.');
  assert.equal(d.doc.blocks[2].text, '2nd paragraph here.');
  assert.equal(d.comments[0].state, 'applied');
  // ...but if the commented block itself was edited (its hash no longer matches), it is a conflict and the comment is reusable
  await h.api('POST', '/v1/docs/D-1/comments', { text: 'Again', blockId: 'b3', start: 0, end: 3 });
  const j2 = (await h.api('POST', '/v1/docs/D-1/apply', {})).json.job;
  await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ blockId: 'b3', text: 'Rewritten by hand.' }] });
  jobResult(h, clock, j2.id, JSON.stringify({ patches: [{ commentId: 'C-2', blockId: 'b3', op: 'replace', find: '2nd', with: 'x' }] }));
  const c2 = (await h.get('/v1/docs/D-1')).json.comments[1];
  assert.equal(c2.state, 'conflict');
  assert.match(c2.reason, /edited while the job ran/);
});

test('create with a prompt queues a doc_draft job; the markdown reply becomes version 1; a changed doc discards the draft', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  assert.equal((await h.api('POST', '/v1/docs', { projectId: pid, title: 'Brief', prompt: 'x'.repeat(9000) })).status, 400);
  const r = await h.api('POST', '/v1/docs', { projectId: pid, title: 'Brief', kind: 'report', prompt: 'Write a one page brief about caching' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.job.kind, 'doc_draft');
  assert.equal(r.json.job.input.docId, 'D-1');
  jobResult(h, clock, r.json.job.id, '```markdown\n# Caching brief\n\nCaching stores **results**.\n\n- fast\n- cheap\n```');
  const d = (await h.get('/v1/docs/D-1')).json;
  assert.deepEqual(d.doc.blocks.map((b) => b.type), ['h1', 'p', 'li', 'li']);
  assert.equal(d.doc.version, 1);
  assert.equal(d.versions[0].cause, 'draft');
  assert.equal(h.state().jobs.find((j) => j.id === r.json.job.id).state, 'done');
  // second doc: user edits before the draft lands
  const r2 = await h.api('POST', '/v1/docs', { projectId: pid, title: 'Other', prompt: 'p' });
  await h.api('POST', '/v1/docs/D-2/edit', { ops: [{ op: 'insert', after: null, block: { type: 'p', text: 'mine' } }] });
  jobResult(h, clock, r2.json.job.id, '# Draft');
  assert.equal(h.state().jobs.find((j) => j.id === r2.json.job.id).state, 'failed');
  assert.equal((await h.get('/v1/docs/D-2')).json.doc.blocks[0].text, 'mine');
  // no live session: the doc is still created, with a draftError
  h.send(h.ev('s1', 'session.ended', {}, clock.t));
  const r3 = await h.api('POST', '/v1/docs', { projectId: pid, title: 'Offline', prompt: 'p' });
  assert.equal(r3.status, 201);
  assert.equal(r3.json.job, null);
  assert.match(r3.json.draftError, /no live session/);
});

test('rebuild reproduces every doc table byte for byte', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await mk(h, pid);
  await h.api('POST', '/v1/docs/D-1/comments', { text: 'a', blockId: 'b2', start: 0, end: 5 });
  await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ blockId: 'b3', text: 'Edited second.' }] });
  tick(h, clock, 10 * 60_000);
  await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ op: 'insert', after: 'b3', block: { type: 'li', text: 'x', level: 1 } }] });
  const j = (await h.api('POST', '/v1/docs/D-1/apply', {})).json.job;
  jobResult(h, clock, j.id, JSON.stringify({ patches: [{ commentId: 'C-1', blockId: 'b2', op: 'replace', find: 'First', with: '1st' }] }));
  await h.api('POST', '/v1/docs/D-1/revert', { toVersion: 1 });
  await h.api('POST', '/v1/docs/D-1/export', { format: 'html' });
  const before = h.hub.dump(), st = h.state();
  assert.ok(before.docs.length === 1 && before.doc_versions.length >= 4 && before.doc_comments.length === 1);
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...st, seq: 0 });
});

test('export: html / md downloads are recorded and sealed; previews are not; pdf and docx work or say why not', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await mk(h, pid, '# Title <b>\n\nBody & more.');
  await h.api('POST', '/v1/docs/D-1/edit', { ops: [{ blockId: 'b2', text: 'Body & more, edited.' }] });
  const prev = await fetch(`${h.base}/v1/docs/D-1/export?format=html`);
  assert.equal(prev.status, 200);
  assert.match(prev.headers.get('content-disposition'), /^attachment/);
  const body = await prev.text();
  assert.match(body, /<h1 data-block="b1">Title &lt;b&gt;<\/h1>/);
  assert.match(body, /Body &amp; more, edited\./);
  assert.equal((await h.get('/v1/docs/D-1')).json.versions[0].cause, 'edit', 'a preview does not seal');
  const md = await fetch(`${h.base}/v1/docs/D-1/export?format=md&v=0`);
  assert.match(await md.text(), /Body & more\.\n$/);
  const dl = await h.api('POST', '/v1/docs/D-1/export', { format: 'md' });
  assert.equal(dl.status, 200);
  assert.equal((await h.get('/v1/docs/D-1')).json.versions[0].cause, 'manual', 'a real export seals the snapshot');
  assert.equal((await h.get('/v1/docs/D-1/export?format=rtf')).status, 400);
  assert.equal((await h.get('/v1/docs/D-1/export?v=9')).status, 404);
  assert.equal((await h.get('/v1/docs/D-1/export?v=x&format=html')).status, 400);
  assert.ok(fs.existsSync(path.join(h.home, 'studio', 'D-1', '1.html')));
  // pdf: real Chrome when installed, else a clear 501
  const pdf = await fetch(`${h.base}/v1/docs/D-1/export?format=pdf`);
  if (pdf.status === 200) {
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /^inline/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  } else assert.equal(pdf.status, 501);
  const nochrome = process.env.HELM_CHROME;
  process.env.HELM_CHROME = '/nonexistent/chrome';
  try { const rr = await h.get("/v1/docs/D-1/export?format=pdf&v=0"); assert.equal(rr.status, 501, rr.text); } finally { if (nochrome === undefined) delete process.env.HELM_CHROME; else process.env.HELM_CHROME = nochrome; }
  if (process.platform === 'darwin') {
    const docx = await fetch(`${h.base}/v1/docs/D-1/export?format=docx`);
    assert.equal(docx.status, 200);
    assert.equal(Buffer.from(await docx.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  }
});

test('a database from before v0.15 gains the doc tables empty (CREATE IF NOT EXISTS)', async (t) => {
  const { h } = await setup(); t.after(h.stop);
  const names = h.hub.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'doc%' ORDER BY name").map((r) => r.name);
  assert.deepEqual(names, ['doc_comments', 'doc_versions', 'docs']);
});
