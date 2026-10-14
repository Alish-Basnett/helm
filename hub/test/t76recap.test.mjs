// T-76: recaps that always exist. The final report is stored with the completion, parsed deterministically (real reports,
// bold labels, multi-line HOW), the sweep derives a missing recap (or queues a Haiku job), and POST /v1/recaps/backfill
// repairs the board. Everything is an event, so --rebuild reproduces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';
import { recapFromReport, reportedFiles, looksDegraded, recapFromJson } from '../recap.mjs';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

// trimmed copies of real builder reports from the live board
const PLAIN = `DONE: "Create" now queues a \`doc_draft\` job and "Apply all" queues one \`doc_edit\` job. The hub suite passes (316 tests, up from 294).

HOW:
- **Hub:** T-58 had already built the doc tables, so I extended them.
  - \`judgePatches\` now accepts \`replace_text\` and \`delete\`.
- **Mod:**
  - Prompts are rewritten for JSON blocks.

FILES: hub/docs.mjs, \`hooks/register.ts\`
LEARNED: Never let a model write straight into your data. Ask it for structured proposals, then let plain code check each one.
TAGS: llm-jobs, event-sourcing, testing`;
const BOLD = `**DONE:** Fixed the lost queue.\n\n**HOW**:\n1. Saved it to the store.\n2. Restored it on start.\n\n**FILES:** none\n**LEARNED**: State held only in memory dies with the process.\n**TAGS:** Persistence, Reload`;
const HEADINGS = `Some preamble that quotes DONE: nothing.\n\n## DONE\nShipped the export.\n\n## HOW\nOne module per format.\n\n## LEARNED\nKeep content apart from rendering.`;
const NO_LEARNED = `DONE: only this\nHOW: and this`;
const LONG = `DONE: ${'A very long sentence about the work that goes on and on. '.repeat(12)}\nLEARNED: ok`;

test('recapFromReport reads plain, bold, heading and multi-line reports', () => {
  const a = recapFromReport(PLAIN);
  assert.equal(a.what, '"Create" now queues a doc_draft job and "Apply all" queues one doc_edit job. The hub suite passes (316 tests, up from 294).');
  assert.equal(a.how, 'Hub: T-58 had already built the doc tables, so I extended them. judgePatches now accepts replace_text and delete. Mod: Prompts are rewritten for JSON blocks.');
  assert.equal(a.learned, 'Never let a model write straight into your data. Ask it for structured proposals, then let plain code check each one.');
  assert.deepEqual(a.concepts, ['llm-jobs', 'event-sourcing', 'testing']);
  assert.deepEqual(reportedFiles(PLAIN), ['hub/docs.mjs', 'hooks/register.ts']);

  const b = recapFromReport(BOLD);
  assert.deepEqual(b, { what: 'Fixed the lost queue.', how: 'Saved it to the store. Restored it on start.', learned: 'State held only in memory dies with the process.', concepts: ['persistence', 'reload'] });
  assert.deepEqual(reportedFiles(BOLD), []);

  const c = recapFromReport(HEADINGS);
  assert.deepEqual(c, { what: 'Shipped the export.', how: 'One module per format.', learned: 'Keep content apart from rendering.', concepts: [] });
});

test('recapFromReport: no LEARNED means no free recap; long sections are cut at a sentence, not mid-word', () => {
  assert.equal(recapFromReport(NO_LEARNED), null);
  assert.equal(recapFromReport(''), null);
  assert.equal(recapFromReport('I finished the work.'), null);
  const l = recapFromReport(LONG);
  assert.ok(l.what.length <= 220 && l.what.endsWith('.'), l.what);
  assert.ok(!l.what.includes('…'));
});

test('looksDegraded flags the recaps the old line parser produced', () => {
  assert.equal(looksDegraded({ what: 'x', how: '- **Hub:**', learned: 'y' }), true);
  assert.equal(looksDegraded({ what: 'cut off…', how: 'fine here', learned: 'y' }), true);
  assert.equal(looksDegraded({ what: 'x', how: '', learned: 'y' }), true);
  assert.equal(looksDegraded({ what: 'x', how: 'Real sentence here.', learned: 'y' }), false);
  assert.equal(looksDegraded(null), false);
});

test('recapFromJson accepts a Haiku reply with prose or fences around it', () => {
  assert.deepEqual(recapFromJson('Sure: ```json\n{"what":"Did it","how":"Like so","learned":"A thing","concepts":["Git","SQL","x","y"]}\n```'),
    { what: 'Did it', how: 'Like so', learned: 'A thing', concepts: ['git', 'sql', 'x'] });
  assert.equal(recapFromJson('no json'), null);
  assert.equal(recapFromJson('{"what":"","learned":"x"}'), null);
});

async function finished(h, { report, id = 'ag1', t0 = T0, tool = true } = {}) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'S', model: 'opus' }, t0));
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu1', subagentType: 'b', model: 'sonnet', description: 'Build it', prompt: '' }, t0));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: id }, t0));
  if (tool) h.send(h.ev('s1', 'tool.called', { agentId: id, toolUseId: 'x', tool: 'Edit', summary: 'Edit: a.ts', files: ['/w/proj/a.ts'] }, t0 + 1000));
  h.send(h.ev('s1', 'agent.completed', { agentId: id, ok: true, summary: 'DONE: cut at 400', ...(report ? { report } : {}) }, t0 + 2000));
}
const task = (h) => h.state().tasks.find((t) => t.id === 'T-1');
const agentRow = (h, id = 'ag1') => h.hub.db.get('SELECT * FROM agents WHERE id = ?', id);

test('agent.completed stores the full final report on the agent, and a later empty completion does not erase it', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await finished(h, { report: PLAIN });
  assert.equal(h.hub.db.get('SELECT report FROM agents WHERE id = ?', 'ag1').report, PLAIN);
  h.send(h.ev('s1', 'agent.completed', { agentId: 'ag1', ok: true, summary: 'completed (recovered by reconciler)' }, T0 + 5000));
  assert.equal(h.hub.db.get('SELECT report FROM agents WHERE id = ?', 'ag1').report, PLAIN);
});

test('safety net: a finished task with a stored report gets its recap from the sweep after the grace period, once', async (t) => {
  const h = await startTest({ recapGraceMs: 3 * MIN }); t.after(h.stop);
  await finished(h, { report: PLAIN });
  assert.equal(task(h).status, 'review');
  assert.equal(task(h).recap, null);
  h.hub.sweep(T0 + 2 * MIN);
  assert.equal(task(h).recap, null, 'inside the grace period the mod may still deliver its own recap');
  h.hub.sweep(T0 + 6 * MIN);
  assert.match(task(h).recap.what, /^"Create" now queues/);
  assert.deepEqual(task(h).recap.concepts, ['llm-jobs', 'event-sourcing', 'testing']);
  const ev = h.hub.db.all(`SELECT data FROM events WHERE type = 'recap.generated'`).map((r) => JSON.parse(r.data));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].source, 'sweep:report:stored');
  h.hub.sweep(T0 + 9 * MIN);
  assert.equal(h.hub.db.all(`SELECT 1 FROM events WHERE type = 'recap.generated'`).length, 1, 'a task with a recap is left alone');
  const before = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before, 'rebuild reproduces the report and the derived recap');
});

test('safety net: no stored report but an activity trail queues one Haiku recap job, whose result becomes the recap', async (t) => {
  const h = await startTest({ recapGraceMs: 3 * MIN }); t.after(h.stop);
  await finished(h, {});
  h.hub.sweep(T0 + 6 * MIN);
  const jobs = h.hub.db.all(`SELECT * FROM jobs WHERE kind = 'recap'`);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].task_id, 'T-1');
  const input = JSON.parse(jobs[0].input);
  assert.ok(Array.isArray(input.filesChanged));
  assert.ok(input.tools.some((s) => /Edit/.test(s)));
  h.hub.sweep(T0 + 7 * MIN);
  assert.equal(h.hub.db.all(`SELECT 1 FROM jobs WHERE kind = 'recap'`).length, 1, 'an open job is not queued twice');
  h.send(h.ev('s1', 'job.result', { jobId: jobs[0].id, ok: true, text: '{"what":"Edited a.ts","how":"One edit","learned":"Small diffs review well","concepts":["Git"]}' }, T0 + 8 * MIN));
  assert.deepEqual(task(h).recap, { what: 'Edited a.ts', how: 'One edit', learned: 'Small diffs review well', concepts: ['git'] });
  const before = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
});

test('safety net: nothing to summarise means no job; a malformed Haiku reply fails the job and leaves the task alone', async (t) => {
  const h = await startTest({ recapGraceMs: 3 * MIN }); t.after(h.stop);
  await finished(h, { tool: false });
  h.hub.sweep(T0 + 6 * MIN);
  assert.equal(h.hub.db.all(`SELECT 1 FROM jobs WHERE kind = 'recap'`).length, 0);
  const h2 = await startTest({ recapGraceMs: 3 * MIN }); t.after(h2.stop);
  await finished(h2, {});
  h2.hub.sweep(T0 + 6 * MIN);
  const j = h2.hub.db.get(`SELECT * FROM jobs WHERE kind = 'recap'`);
  h2.send(h2.ev('s1', 'job.result', { jobId: j.id, ok: true, text: 'not json at all' }, T0 + 7 * MIN));
  assert.equal(h2.hub.db.get('SELECT state FROM jobs WHERE id = ?', j.id).state, 'failed');
  assert.equal(task(h2).recap, null);
});

test('POST /v1/recaps/backfill: dry run, stored reports, transcript reports, degraded recaps with improve; replayable', async (t) => {
  const h = await startTest({ recapGraceMs: -1 }); t.after(h.stop);
  await finished(h, { report: PLAIN });                                   // T-1: report stored, no recap
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu2', subagentType: 'b', model: 'sonnet', description: 'Second [helm:T-2]', prompt: '' }, T0 + 3000));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu2', agentId: 'ag2' }, T0 + 3000));
  h.send(h.ev('s1', 'agent.completed', { agentId: 'ag2', ok: true, summary: 'DONE: x' }, T0 + 4000)); // T-2: no report stored
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu3', subagentType: 'b', model: 'sonnet', description: 'Third [helm:T-3]', prompt: '' }, T0 + 5000));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu3', agentId: 'ag3' }, T0 + 5000));
  h.send(h.ev('s1', 'agent.completed', { agentId: 'ag3', ok: true, summary: 'DONE: y' }, T0 + 6000));
  h.send(h.ev('s1', 'recap.generated', { taskId: 'T-3', what: 'cut off at the limit…', how: '- **Hub:**', learned: 'old' }, T0 + 7000)); // T-3: degraded recap

  const dry = (await h.api('POST', '/v1/recaps/backfill', { dryRun: true })).json;
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.results.map((r) => [r.taskId, r.source]), [['T-1', 'report:stored'], ['T-2', 'skipped']]);
  assert.equal(task(h).recap, null, 'a dry run records nothing');

  const real = (await h.api('POST', '/v1/recaps/backfill', { reports: { ag2: BOLD, ag3: HEADINGS }, improve: true })).json;
  const bySrc = Object.fromEntries(real.results.map((r) => [r.taskId, r.source]));
  assert.deepEqual(bySrc, { 'T-1': 'report:stored', 'T-2': 'report:transcript', 'T-3': 'report:transcript' });
  assert.equal(real.results.find((r) => r.taskId === 'T-3').replaced, true);
  assert.equal(h.state().tasks.find((x) => x.id === 'T-2').recap.what, 'Fixed the lost queue.');
  assert.equal(h.state().tasks.find((x) => x.id === 'T-3').recap.what, 'Shipped the export.');
  assert.equal(h.hub.db.get('SELECT report FROM agents WHERE id = ?', 'ag2').report, BOLD, 'a transcript report is stored on the agent');

  const again = (await h.api('POST', '/v1/recaps/backfill', { improve: true })).json;
  assert.deepEqual(again.results, [], 'nothing left to do');
  assert.equal((await h.api('POST', '/v1/recaps/backfill', { reports: [] })).status, 400);

  const before = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before, 'the backfill is replayable');
});

test('backfill queues a Haiku job for a card the main loop did itself (no agent) when it has activity, and skips an empty one', async (t) => {
  const h = await startTest({ recapGraceMs: -1 }); t.after(h.stop);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'S', model: 'opus' }, T0));
  const pid = h.state().projects[0].id;
  await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Did it myself', description: 'd', status: 'in_progress' });
  await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Empty', description: 'd', status: 'done' });
  // attributed while the card is in progress (T-51), then the card moves on to review
  h.send(h.ev('s1', 'tool.called', { tool: 'Edit', summary: 'Edit: b.ts', taskId: 'T-1', files: ['/w/proj/b.ts'] }, T0 + 1000));
  await h.api('PATCH', '/v1/tasks/T-1', { status: 'review' });
  const r = (await h.api('POST', '/v1/recaps/backfill', {})).json;
  const by = Object.fromEntries(r.results.map((x) => [x.taskId, x]));
  assert.equal(by['T-1'].source, 'haiku-job');
  assert.ok(by['T-1'].jobId);
  assert.equal(by['T-2'].source, 'skipped');
});
