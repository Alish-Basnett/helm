// T-63: one end-to-end Studio walk-through on a temp HELM_HOME hub, acting as the mod where a job needs a model.
// It only covers the seams between the pieces. Detail lives (and is not repeated here) in:
//   v15docs.test.mjs        routes, validation, anchors, coalescing, search, SSE, old-db migration
//   v19studiojobs.test.mjs  judgePatches rules one by one, hash conflicts, scope, draft failures, rebuild with an undo
//   studioexport.test.mjs   serializer escaping, every block type, the 501 for a missing Chrome
//   v16studioweb / v19studioweb / t62studiopill  browser store, diffs, migration, pill model
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTest } from './helpers.mjs';
import { VERSION } from '../config.mjs';

const CHROME = process.env.HELM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
const hasTextutil = fs.existsSync('/usr/bin/textutil');
const T0 = 1_800_000_000_000;

test('Studio end to end: draft, comment, Apply all (mixed outcomes), revert, export, rebuild', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const clock = { t: T0 };
  h.hub.setClock(() => clock.t);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }, clock.t));
  const pid = h.state().projects[0].id;

  // the mod: claim the queued job, check what it was sent, answer it
  const modAnswer = (jobId, kind, reply) => {
    const claimed = h.hub.claimJobs('s1', clock.t);
    const job = (Array.isArray(claimed) ? claimed : claimed.jobs ?? []).find((j) => j.id === jobId);
    assert.ok(job, `job ${jobId} is handed to the live session`);
    assert.equal(job.kind, kind);
    h.send(h.ev('s1', 'job.result', { jobId, ok: true, text: reply }, clock.t));
    return job;
  };

  // version string comes from one source, so /v1/health and the plugin manifest agree
  const manifest = JSON.parse(fs.readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal((await h.get('/v1/health')).json.version, manifest.version);
  assert.equal(VERSION, manifest.version);
  assert.equal(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, manifest.version, 'hub/package.json matches the manifest');

  // 1. create + doc_draft -> version 1
  const created = await h.api('POST', '/v1/docs', { projectId: pid, title: 'Proposal', kind: 'report', prompt: 'Write a proposal' });
  assert.equal(created.status, 201);
  assert.equal(created.json.doc.version, 0);
  assert.equal(created.json.job.kind, 'doc_draft');
  const draftJob = modAnswer(created.json.job.id, 'doc_draft', '```json\n' + JSON.stringify({ blocks: [
    { type: 'h1', text: 'Proposal' },
    { type: 'p', text: 'We will build a thing.' },
    { type: 'p', text: 'It will cost money.' },
    { type: 'p', text: 'It ships soon.' },
    { type: 'p', text: 'Contact us.' },
  ] }) + '\n```');
  assert.equal(draftJob.input.prompt, 'Write a proposal');
  const id = created.json.doc.id;
  let d = (await h.get(`/v1/docs/${id}`)).json;
  assert.equal(d.doc.version, 1);
  assert.equal(d.versions[0].cause, 'draft');
  assert.deepEqual(d.doc.blocks.map((b) => b.id), ['b1', 'b2', 'b3', 'b4', 'b5']);

  // 2. comments on b2, b3, b4 and b5
  for (const [blockId, text] of [['b2', 'sharpen'], ['b3', 'give a number'], ['b4', 'say when'], ['b5', 'add an email']]) {
    assert.equal((await h.api('POST', `/v1/docs/${id}/comments`, { blockId, start: 0, end: 2, text })).status, 201);
  }

  // 3. Apply all: one doc_edit job; the model returns one applied patch, one refusal (reply -> conflict),
  //    one failed patch (unknown op) and nothing at all for b5 (-> conflict: no change).
  const edited = d.doc.blocks.length; // 5 blocks before
  const apply = await h.api('POST', `/v1/docs/${id}/apply`, {});
  assert.equal(apply.status, 201);
  assert.equal(apply.json.job.kind, 'doc_edit');
  assert.ok(apply.json.job.input.blocks.every((b) => typeof b.hash === 'string'));
  modAnswer(apply.json.job.id, 'doc_edit', JSON.stringify({ patches: [
    { commentId: 'C-1', blockId: 'b2', op: 'replace_text', text: 'We will build a thing, on time.' }, // applied
    { commentId: 'C-2', blockId: 'b3', op: 'reply', text: 'no figure in the document' },                 // refused -> conflict
    { commentId: 'C-3', blockId: 'b4', op: 'explode' },                                                  // unknown op -> conflict
  ] }));
  d = (await h.get(`/v1/docs/${id}`)).json;
  assert.equal(d.doc.version, 2, 'the whole batch is exactly one new version');
  assert.equal(d.versions[0].cause, 'apply');
  assert.equal(d.doc.blocks.length, edited);
  assert.equal(d.doc.blocks[1].text, 'We will build a thing, on time.');
  assert.deepEqual(d.comments.map((c) => c.state), ['applied', 'conflict', 'conflict', 'conflict']);
  assert.equal(d.comments[0].appliedVersion, 2);
  assert.match(d.comments[1].reason, /figure/);
  assert.match(d.comments[2].reason, /unknown patch op/);
  assert.match(d.comments[3].reason, /no change/);
  assert.equal(h.state().jobs.find((j) => j.id === apply.json.job.id).state, 'done');

  // 4. revert reopens exactly the comment the batch applied (the conflicts stay conflicts)
  const rv = await h.api('POST', `/v1/docs/${id}/revert`, { toVersion: 1 });
  assert.equal(rv.json.doc.version, 3);
  assert.equal(rv.json.doc.blocks[1].text, 'We will build a thing.');
  d = (await h.get(`/v1/docs/${id}`)).json;
  assert.deepEqual(d.comments.map((c) => c.state), ['open', 'conflict', 'conflict', 'conflict']);

  // 5. export: html always; pdf and docx only where the binaries exist
  const html = await h.api('POST', `/v1/docs/${id}/export`, { format: 'html' });
  assert.equal(html.status, 200);
  assert.match(html.text, /We will build a thing\./);
  assert.doesNotMatch(html.text, /sharpen|give a number/, 'comments never reach an export');
  if (hasChrome) {
    const pdf = await fetch(`${h.base}/v1/docs/${id}/export?format=pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  } else t.diagnostic('pdf export skipped: Chrome not installed');
  if (hasTextutil) {
    const docx = await fetch(`${h.base}/v1/docs/${id}/export?format=docx`);
    assert.equal(docx.status, 200);
    assert.equal(Buffer.from(await docx.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  } else t.diagnostic('docx export skipped: textutil not installed');

  // 6. --rebuild reproduces identical doc state (tables and the state the web store sees)
  const before = h.hub.dump(), st = h.state();
  assert.ok(before.docs.length === 1 && before.doc_versions.length >= 4 && before.doc_comments.length === 4);
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...st, seq: 0 });
});
