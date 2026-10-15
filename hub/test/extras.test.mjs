// v0.2 extras: conflict radar, questions inbox, jobs (explain / digest), digests, search, rebuild, migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, openStream, tmpDir } from './helpers.mjs';
import { Hub, localDate } from '../hub.mjs';
import { loadConfig } from '../config.mjs';
import { createLogger } from '../log.mjs';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** Session s1 with agents a1..aN (tasks T-1..T-N), all bound and running. */
function world(h, n = 2, t0 = T0, sid = 's1') {
  h.send(h.ev(sid, 'session.started', { cwd: '/w/proj', title: 'S', model: 'opus' }, t0));
  for (let i = 1; i <= n; i++) {
    h.send(h.ev(sid, 'agent.spawned', { toolUseId: `tu${i}`, subagentType: 'b', model: 'sonnet', description: `Job number ${i}`, prompt: '' }, t0));
    h.send(h.ev(sid, 'agent.bound', { toolUseId: `tu${i}`, agentId: `a${i}` }, t0));
  }
}
const edit = (h, agentId, file, at, tu = `e-${agentId}-${file}-${at}`) =>
  h.send(h.ev('s1', 'tool.called', { agentId, toolUseId: tu, tool: 'Edit', summary: `Edit ${file}`, files: [file] }, at));
const task = (h, id) => h.state().tasks.find((t) => t.id === id);
const agent = (h, id) => h.state().agents.find((a) => a.id === id);
const question = (h, id) => h.state().questions.find((q) => q.id === id);

// ================================================================ conflict radar
test('conflict radar: two agents touching one path conflict; both tasks and GET /v1/conflicts show it', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h);
  edit(h, 'a1', '/w/proj/src/a.ts', T0 + 1000);
  assert.deepEqual(task(h, 'T-1').conflicts, [], 'one agent alone is no conflict');
  assert.deepEqual((await h.get('/v1/conflicts')).json, { conflicts: [] });
  edit(h, 'a2', '/w/proj/src/other.ts', T0 + 2000);
  assert.deepEqual(task(h, 'T-2').conflicts, [], 'different files do not conflict');
  edit(h, 'a2', '/w/proj/src/a.ts', T0 + 3000);

  assert.deepEqual(task(h, 'T-1').conflicts, [
    { path: '/w/proj/src/a.ts', otherTaskId: 'T-2', otherAgentId: 'a2', otherSessionId: 's1' }]);
  assert.deepEqual(task(h, 'T-2').conflicts, [
    { path: '/w/proj/src/a.ts', otherTaskId: 'T-1', otherAgentId: 'a1', otherSessionId: 's1' }]);
  const r = await h.get('/v1/conflicts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.conflicts, [{
    path: '/w/proj/src/a.ts',
    agents: [{ agentId: 'a1', taskId: 'T-1', sessionId: 's1', at: T0 + 1000 }, { agentId: 'a2', taskId: 'T-2', sessionId: 's1', at: T0 + 3000 }],
  }]);
  // a conflict is also visible through /v1/tasks (the mod's helm_task tool) and the task detail
  assert.equal((await h.get('/v1/tasks?sessionId=s1')).json.tasks[0].conflicts.length, 1);
  assert.equal((await h.get('/v1/tasks/T-2')).json.task.conflicts.length, 1);
  // tool.called without files, or with junk files, changes nothing
  h.send(h.ev('s1', 'tool.called', { agentId: 'a1', toolUseId: 'q1', tool: 'Read', summary: 'Read x', files: [1, null, ''] }, T0 + 4000));
  assert.equal(h.hub.conflicts().length, 1);
});

test('conflict radar: pushed as a task upsert over SSE, and cleared the same way', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h);
  edit(h, 'a1', '/w/p/x.ts', T0 + 1000);
  const s = openStream(h.base, {}, `/v1/stream?since=${h.hub.seqNow()}`); t.after(() => s.close());
  await s.waitFor((e) => e.comment === 'connected');
  edit(h, 'a2', '/w/p/x.ts', T0 + 2000);
  const up = await s.waitFor((e) => e.event === 'change' && e.data.entity === 'task' && e.data.row.id === 'T-1' && e.data.row.conflicts.length === 1);
  assert.equal(up.data.row.conflicts[0].otherAgentId, 'a2');
  h.hub.sweep(T0 + 30 * MIN); // both agents still running: conflict stands no matter how long ago
  assert.equal(task(h, 'T-1').conflicts.length, 1, 'running agents conflict regardless of the window');
});

test('conflict radar: finished agents conflict only inside the 10 minute window; the sweep expires them', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h);
  edit(h, 'a1', '/w/p/x.ts', T0 + 1000);
  h.send(h.ev('s1', 'agent.completed', { agentId: 'a1', ok: true, summary: 'ok' }, T0 + 2000));
  assert.equal(h.hub.conflicts().length, 0, 'a1 alone');
  edit(h, 'a2', '/w/p/x.ts', T0 + 3000);
  assert.equal(h.hub.conflicts().length, 1, 'a1 finished but touched x.ts within 10 min');
  assert.equal(task(h, 'T-2').conflicts[0].otherAgentId, 'a1');
  h.send(h.ev('s1', 'agent.completed', { agentId: 'a2', ok: true, summary: 'ok' }, T0 + 4000));
  assert.equal(h.hub.conflicts().length, 1, 'completion recomputes; both touches are recent');

  const early = h.hub.sweep(T0 + 5 * MIN);
  assert.ok(!early || !early.conflictsChanged, 'nothing expired at 5 min');
  const seq0 = h.hub.seqNow();
  const r = h.hub.sweep(T0 + 12 * MIN);
  assert.equal(r.conflictsChanged, true);
  assert.deepEqual(h.hub.conflicts(), []);
  assert.deepEqual([task(h, 'T-1').conflicts, task(h, 'T-2').conflicts], [[], []]);
  const pushed = h.hub.changesSince(seq0).rows.filter((c) => c.entity === 'task').map((c) => JSON.parse(c.row).id);
  assert.deepEqual(pushed.sort(), ['T-1', 'T-2']);
  assert.equal(h.hub.sweep(T0 + 13 * MIN)?.conflictsChanged ?? false, false, 'idempotent');
  const ev = h.hub.db.all(`SELECT data FROM events WHERE type = 'hub.sweep'`).map((e) => JSON.parse(e.data));
  assert.equal(ev.at(-1).conflicts, true, 'recorded as a hub.sweep event');
});

test('conflict radar: a pending agent id is renamed on bind and conflicts follow', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }, T0));
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tuA', subagentType: 'b', model: 's', description: 'A', prompt: '' }, T0));
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tuB', subagentType: 'b', model: 's', description: 'B', prompt: '' }, T0));
  h.send(h.ev('s1', 'tool.called', { agentId: 'pending:tuA', toolUseId: 'x1', tool: 'Write', summary: 'Write f', files: ['/w/p/f.ts'] }, T0 + 1000));
  h.send(h.ev('s1', 'tool.called', { agentId: 'pending:tuB', toolUseId: 'x2', tool: 'Write', summary: 'Write f', files: ['/w/p/f.ts'] }, T0 + 2000));
  assert.equal(task(h, 'T-1').conflicts[0].otherAgentId, 'pending:tuB');
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tuB', agentId: 'real-b' }, T0 + 3000));
  assert.equal(task(h, 'T-1').conflicts[0].otherAgentId, 'real-b');
  assert.deepEqual(h.hub.conflicts()[0].agents.map((a) => a.agentId).sort(), ['pending:tuA', 'real-b']);
});

// ==================================================================== questions
test('AskUserQuestion opens a question; the matching tool.finished answers it', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h, 1);
  const s = openStream(h.base, {}, `/v1/stream?since=${h.hub.seqNow()}`); t.after(() => s.close());
  await s.waitFor((e) => e.comment === 'connected');
  h.send(h.ev('s1', 'tool.called', { agentId: 'a1', toolUseId: 'ask1', tool: 'AskUserQuestion', summary: 'Which database should the cache use?' }, T0 + 1000));
  const q = question(h, 'Q-1');
  assert.deepEqual(
    { ...q }, {
      id: 'Q-1', sessionId: 's1', agentId: 'a1', taskId: 'T-1', kind: 'ask', text: 'Which database should the cache use?',
      toolUseId: 'ask1', state: 'open', createdAt: T0 + 1000, answeredAt: null,
    });
  const ev = await s.waitFor((e) => e.event === 'change' && e.data.entity === 'question');
  assert.equal(ev.data.row.state, 'open');
  h.send(h.ev('s1', 'tool.called', { agentId: 'a1', toolUseId: 'ask1', tool: 'AskUserQuestion', summary: 'duplicate delivery' }, T0 + 1500));
  assert.equal(h.state().questions.length, 1, 'same toolUseId does not open a second question');

  h.send(h.ev('s1', 'tool.finished', { agentId: 'a1', toolUseId: 'other', tool: 'Read', ok: true, summary: 'x' }, T0 + 2000));
  assert.equal(question(h, 'Q-1').state, 'open', 'a different toolUseId leaves it open');
  h.send(h.ev('s1', 'tool.finished', { agentId: 'a1', toolUseId: 'ask1', tool: 'AskUserQuestion', ok: true, summary: 'answered' }, T0 + 3000));
  assert.deepEqual([question(h, 'Q-1').state, question(h, 'Q-1').answeredAt], ['answered', T0 + 3000]);
  await s.waitFor((e) => e.event === 'change' && e.data.entity === 'question' && e.data.row.state === 'answered');
});

test('questions: main-session ask, list filter, dismiss, errors, and session end', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h, 1);
  h.send(h.ev('s1', 'tool.called', { toolUseId: 'm1', tool: 'AskUserQuestion', summary: 'Ship it?' }, T0 + 1000));
  h.send(h.ev('s1', 'tool.called', { agentId: 'a1', toolUseId: 'm2', tool: 'AskUserQuestion', summary: 'Rename the table?' }, T0 + 1100));
  const main = h.state().questions.find((q) => q.text === 'Ship it?');
  assert.deepEqual([main.agentId, main.taskId, main.kind], [null, null, 'ask']);
  assert.equal((await h.get('/v1/questions?state=open')).json.questions.length, 2);
  assert.equal((await h.get('/v1/questions?state=answered')).json.questions.length, 0);
  assert.equal((await h.get('/v1/questions')).json.questions.length, 2);
  assert.equal((await h.get('/v1/questions?state=bogus')).status, 400);

  const d = await h.api('POST', `/v1/questions/${main.id}/dismiss`);
  assert.equal(d.status, 200);
  assert.equal(d.json.question.state, 'answered');
  assert.ok(d.json.question.answeredAt > 0);
  const again = await h.api('POST', `/v1/questions/${main.id}/dismiss`);
  assert.equal(again.status, 200, 'dismissing twice is harmless');
  assert.equal(again.json.question.answeredAt, d.json.question.answeredAt);
  assert.equal((await h.api('POST', '/v1/questions/Q-999/dismiss')).status, 404);
  assert.equal((await h.get('/v1/questions?state=open')).json.questions.length, 1);

  // an agent that finishes cannot still be asking
  h.send(h.ev('s1', 'agent.completed', { agentId: 'a1', ok: true, summary: 'done' }, T0 + 5000));
  assert.equal((await h.get('/v1/questions?state=open')).json.questions.length, 0);
  h.send(h.ev('s1', 'tool.called', { toolUseId: 'm3', tool: 'AskUserQuestion', summary: 'Anyone there?' }, T0 + 6000));
  assert.equal(h.hub.questions({ state: 'open' }).length, 1);
  h.send(h.ev('s1', 'session.ended', { reason: 'bye' }, T0 + 7000));
  assert.equal(h.hub.questions({ state: 'open' }).length, 0, 'ending the session closes its questions');
});

test('/v1/state carries open questions plus the last 50 answered', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h, 1);
  for (let i = 1; i <= 55; i++) {
    h.send(h.ev('s1', 'tool.called', { toolUseId: `q${i}`, tool: 'AskUserQuestion', summary: `question ${i}` }, T0 + i * 1000));
    h.send(h.ev('s1', 'tool.finished', { toolUseId: `q${i}`, tool: 'AskUserQuestion', ok: true, summary: 'a' }, T0 + i * 1000 + 500));
  }
  h.send(h.ev('s1', 'tool.called', { toolUseId: 'qopen', tool: 'AskUserQuestion', summary: 'still open' }, T0 + 99_000));
  const qs = (await h.get('/v1/state')).json.questions;
  assert.equal(qs.filter((q) => q.state === 'open').length, 1);
  assert.equal(qs.filter((q) => q.state === 'answered').length, 50);
  assert.ok(!qs.some((q) => q.text === 'question 5'), 'oldest answered fall off');
  assert.ok(qs.some((q) => q.text === 'question 55'));
  // project scoped state
  assert.equal((await h.get('/v1/state?projectId=P-1')).json.questions.length, 51);
});

test('waiting agents: reconcile waiting opens one question, never stalls, running closes it', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h, 2);
  const rec = (agents, at) => h.send(h.ev('s1', 'reconcile', { agents }, at));
  rec([{ agentId: 'a1', status: 'waiting' }, { agentId: 'a2', status: 'running' }], T0 + 1000);
  assert.equal(agent(h, 'a1').status, 'waiting');
  assert.equal(agent(h, 'a2').status, 'running');
  const q = h.state().questions;
  assert.equal(q.length, 1);
  assert.deepEqual([q[0].kind, q[0].agentId, q[0].taskId, q[0].text, q[0].toolUseId, q[0].state], ['waiting', 'a1', 'T-1', 'Waiting for input', null, 'open']);
  rec([{ agentId: 'a1', status: 'waiting' }, { agentId: 'a2', status: 'running' }], T0 + 2000);
  assert.equal(h.state().questions.length, 1, 'one open waiting question per agent');

  // an hour of silence: a2 stalls and blocks, a1 does not
  const r = h.hub.sweep(T0 + 60 * MIN);
  assert.equal(r.stalled, 1);
  assert.equal(r.blocked, 1);
  assert.equal(agent(h, 'a1').status, 'waiting');
  assert.equal(agent(h, 'a2').status, 'stalled');
  assert.equal(task(h, 'T-1').status, 'in_progress', 'waiting task is not blocked');

  // answered: back to running, with a fresh activity time so it does not stall at once
  rec([{ agentId: 'a1', status: 'running' }, { agentId: 'a2', status: 'running' }], T0 + 61 * MIN);
  assert.equal(agent(h, 'a1').status, 'running');
  assert.equal(agent(h, 'a1').lastActivityAt, T0 + 61 * MIN);
  assert.equal(question(h, 'Q-1').state, 'answered');
  assert.equal(h.hub.sweep(T0 + 62 * MIN)?.stalled ?? 0, 0);

  // waiting again -> a new question; finishing while waiting closes it
  rec([{ agentId: 'a1', status: 'waiting' }, { agentId: 'a2', status: 'running' }], T0 + 63 * MIN);
  assert.equal(question(h, 'Q-2').state, 'open');
  rec([{ agentId: 'a1', status: 'done' }, { agentId: 'a2', status: 'running' }], T0 + 64 * MIN);
  assert.equal(agent(h, 'a1').status, 'done');
  assert.equal(question(h, 'Q-2').state, 'answered');
});

test('waiting agents: a stalled agent that starts waiting unblocks its task; a new tool call resumes it; unknown waiting agents are created', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h, 1);
  h.hub.sweep(T0 + 11 * MIN);
  assert.equal(task(h, 'T-1').blockedReason, 'no activity for 10 min');
  h.send(h.ev('s1', 'reconcile', { agents: [{ agentId: 'a1', status: 'waiting' }] }, T0 + 12 * MIN));
  assert.equal(agent(h, 'a1').status, 'waiting');
  assert.equal(task(h, 'T-1').status, 'in_progress');
  h.send(h.ev('s1', 'tool.called', { agentId: 'a1', toolUseId: 'w1', tool: 'Bash', summary: 'Bash: ls' }, T0 + 13 * MIN));
  assert.equal(agent(h, 'a1').status, 'running');
  assert.equal(agent(h, 'a1').toolCount, 1);
  assert.equal(question(h, 'Q-1').state, 'answered');

  h.send(h.ev('s1', 'reconcile', { agents: [{ agentId: 'a1', status: 'running' }, { agentId: 'ghost', status: 'waiting' }] }, T0 + 14 * MIN));
  assert.equal(agent(h, 'ghost').status, 'waiting');
  assert.equal(h.state().questions.filter((q) => q.state === 'open' && q.agentId === 'ghost').length, 1);
  h.send(h.ev('s1', 'session.ended', { reason: 'x' }, T0 + 15 * MIN));
  assert.equal(agent(h, 'ghost').status, 'failed', 'a waiting agent still fails with its session');
  assert.equal(h.hub.questions({ state: 'open' }).length, 0);
});

// ========================================================================= jobs
test('explain: needs a live session (409), then queues a job whose input the hub builds; repeat returns the same job', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const now = Date.now();
  await h.api('POST', '/v1/projects', { name: 'Solo' });
  const tk = (await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'Explain me', description: 'Do the thing' })).json.task;
  const no = await h.api('POST', `/v1/tasks/${tk.id}/explain`);
  assert.equal(no.status, 409);
  assert.deepEqual(no.json, { error: 'no live session' });
  assert.equal((await h.api('POST', '/v1/tasks/T-99/explain')).status, 404);

  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }, now));
  await h.api('POST', '/v1/sessions/s1/join', { projectId: 'P-1' }); // a job never runs in another project's session
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu', taskId: tk.id, subagentType: 'b', model: 'sonnet', description: 'work', prompt: '' }, now));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu', agentId: 'ag' }, now));
  for (let i = 1; i <= 45; i++) h.send(h.ev('s1', 'tool.called', { agentId: 'ag', toolUseId: `t${i}`, tool: 'Read', summary: `Read file${i}.ts` }, now + i));
  h.send(h.ev('s1', 'tool.finished', { agentId: 'ag', toolUseId: 't45', tool: 'Edit', ok: true, summary: 'edited', files: ['/w/p/a.ts'] }, now + 50));
  h.send(h.ev('s1', 'recap.generated', { taskId: tk.id, what: 'W', how: 'H', learned: 'L', concepts: ['c1'] }, now + 60));

  const r = await h.api('POST', `/v1/tasks/${tk.id}/explain`);
  assert.equal(r.status, 200);
  const job = r.json.job;
  assert.match(job.id, /^J-\d+$/);
  assert.deepEqual(
    [job.kind, job.sessionId, job.taskId, job.projectId, job.state, job.result, job.error, job.claimedAt, job.doneAt],
    ['explain', 's1', tk.id, 'P-1', 'queued', null, null, null, null]);
  assert.equal(job.input.title, 'Explain me');
  assert.equal(job.input.description, 'Do the thing');
  assert.deepEqual(job.input.recap, { what: 'W', how: 'H', learned: 'L', concepts: ['c1'] });
  assert.deepEqual(job.input.filesChanged, ['/w/p/a.ts']);
  assert.equal(job.input.activity.length, 40, 'last 40 tool summaries');
  assert.equal(job.input.activity[0], 'Read file6.ts', 'oldest first');
  assert.equal(job.input.activity.at(-1), 'Read file45.ts');
  assert.deepEqual(task(h, tk.id).explainJob, { id: job.id, state: 'queued' });
  assert.equal(task(h, tk.id).explainer, null);
  assert.equal(h.state().jobs.length, 1);

  const again = await h.api('POST', `/v1/tasks/${tk.id}/explain`);
  assert.equal(again.json.job.id, job.id, 'idempotent while queued');
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM jobs').n, 1);
  // ... and while running
  await h.get('/v1/sessions/s1/jobs');
  assert.equal((await h.api('POST', `/v1/tasks/${tk.id}/explain`)).json.job.id, job.id);
});

test('GET /v1/sessions/:id/jobs claims queued jobs atomically; job.result completes explain and digest jobs', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const now = Date.now();
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }, now));
  h.send(h.ev('s2', 'session.started', { cwd: '/w/q', title: 'S2', model: 'm' }, now));
  const tk = (await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'T one', sessionId: 's1' })).json.task;
  const j1 = (await h.api('POST', `/v1/tasks/${tk.id}/explain`)).json.job;
  assert.equal(j1.sessionId, 's1');
  assert.deepEqual((await h.get('/v1/sessions/s2/jobs')).json, { jobs: [] }, 'other sessions get nothing');
  const claim = await h.get('/v1/sessions/s1/jobs');
  assert.equal(claim.json.jobs.length, 1);
  assert.equal(claim.json.jobs[0].id, j1.id);
  assert.equal(claim.json.jobs[0].state, 'running');
  assert.ok(claim.json.jobs[0].claimedAt > 0);
  assert.deepEqual((await h.get('/v1/sessions/s1/jobs')).json, { jobs: [] }, 'second poll: already claimed');
  assert.deepEqual(task(h, tk.id).explainJob, { id: j1.id, state: 'running' });

  h.send(h.ev('s1', 'job.result', { jobId: j1.id, ok: true, text: '## How it works\n\nIt **rotates** tokens.' }, now + 1000));
  const done = h.state().jobs.find((j) => j.id === j1.id);
  assert.deepEqual([done.state, done.result, done.error, done.doneAt], ['done', '## How it works\n\nIt **rotates** tokens.', null, now + 1000]);
  assert.equal(task(h, tk.id).explainer, '## How it works\n\nIt **rotates** tokens.');
  assert.deepEqual(task(h, tk.id).explainJob, { id: j1.id, state: 'done' });
  h.send(h.ev('s1', 'job.result', { jobId: j1.id, ok: false, error: 'late' }, now + 2000));
  assert.equal(h.state().jobs.find((j) => j.id === j1.id).state, 'done', 'a finished job is final');
  // re-explain after done starts a new job
  const j2 = (await h.api('POST', `/v1/tasks/${tk.id}/explain`)).json.job;
  assert.notEqual(j2.id, j1.id);
  await h.get('/v1/sessions/s1/jobs');
  h.send(h.ev('s1', 'job.result', { jobId: j2.id, ok: false, error: 'model refused' }, now + 3000));
  const failed = h.state().jobs.find((j) => j.id === j2.id);
  assert.deepEqual([failed.state, failed.error], ['failed', 'model refused']);
  assert.deepEqual(task(h, tk.id).explainJob, { id: j2.id, state: 'failed' });
  assert.equal(task(h, tk.id).explainer, '## How it works\n\nIt **rotates** tokens.', 'a failed re-run keeps the old explainer');
  // ok without text counts as a failure
  const j3 = (await h.api('POST', `/v1/tasks/${tk.id}/explain`)).json.job;
  await h.get('/v1/sessions/s1/jobs');
  h.send(h.ev('s1', 'job.result', { jobId: j3.id, ok: true }, now + 4000));
  assert.deepEqual([h.state().jobs.find((j) => j.id === j3.id).state, h.state().jobs.find((j) => j.id === j3.id).error], ['failed', 'empty result']);
  h.send(h.ev('s1', 'job.result', { jobId: 'J-404', ok: true, text: 'x' }, now + 5000)); // unknown job: ignored, not fatal
});

test('job session choice: task session, else project newest live; never an ended session or another project', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const now = Date.now();
  h.send(h.ev('sA', 'session.started', { cwd: '/w/alpha', title: 'A', model: 'm' }, now));       // P-1
  h.send(h.ev('sB', 'session.started', { cwd: '/w/alpha2', title: 'B', model: 'm' }, now + 10));  // P-2
  h.send(h.ev('sC', 'session.started', { cwd: '/w/gamma', title: 'C', model: 'm' }, now + 20));   // P-3
  await h.api('POST', '/v1/sessions/sB/join', { projectId: 'P-1' }); // sA and sB share P-1
  const mk = async (sessionId) => (await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: `t-${sessionId}`, sessionId })).json.task.id;
  const explain = async (id) => (await h.api('POST', `/v1/tasks/${id}/explain`));
  const pick = async (sessionId) => { const id = await mk(sessionId); const r = await explain(id); return r.json.job?.sessionId ?? r.status; };

  assert.equal(await pick('sA'), 'sA', "the task's own session");
  h.send(h.ev('sA', 'session.ended', { reason: 'x' }, now + 100));
  h.send(h.ev('sB', 'session.heartbeat', {}, now + 200));
  assert.equal(await pick('sA'), 'sB', 'task session ended: project newest live session');
  h.hub.sweep(now + 3 * MIN); // sB, sC go idle (no heartbeat for 2 min)
  assert.equal(h.state().sessions.find((s) => s.id === 'sB').status, 'idle');
  assert.equal(await pick('sA'), 'sB', 'an idle session still counts');
  h.send(h.ev('sB', 'session.ended', { reason: 'x' }, now + 4 * MIN));
  // project P-1 has no live session left: another project's session (idle, or woken up) is never used
  assert.equal(await pick('sA'), 409, 'only an idle foreign session exists: not eligible');
  h.send(h.ev('sC', 'session.heartbeat', {}, now + 5 * MIN));
  assert.equal(await pick('sA'), 409, 'an active session of another project is not a fallback either');
  assert.equal(await pick('sC'), 409, "a task whose session_id is another project's session ignores it");
  h.send(h.ev('sC', 'session.ended', { reason: 'x' }, now + 6 * MIN));
  assert.equal(await pick(null), 409);
});

test('the sweep fails running jobs after HELM_JOB_MS (and unclaimed queued ones); a late real result still wins', async (t) => {
  const h = await startTest({ jobMs: 1000 }); t.after(h.stop);
  assert.equal(h.hub.cfg.jobMs, 1000);
  const now = Date.now();
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }, now));
  const tk = (await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'slow', sessionId: 's1' })).json.task;
  const j1 = (await h.api('POST', `/v1/tasks/${tk.id}/explain`)).json.job;
  const claimedAt = Date.now();
  await h.get('/v1/sessions/s1/jobs');
  assert.equal(h.hub.sweep(claimedAt + 500)?.jobsFailed ?? 0, 0, 'not yet');
  const seq0 = h.hub.seqNow();
  const r = h.hub.sweep(claimedAt + 5000);
  assert.equal(r.jobsFailed, 1);
  const f = h.state().jobs.find((j) => j.id === j1.id);
  assert.deepEqual([f.state, f.error], ['failed', 'timed out']);
  assert.deepEqual(task(h, tk.id).explainJob, { id: j1.id, state: 'failed' });
  const changes = h.hub.changesSince(seq0).rows;
  assert.ok(changes.some((c) => c.entity === 'job' && JSON.parse(c.row).error === 'timed out'));
  assert.ok(changes.some((c) => c.entity === 'task'));
  assert.equal(h.hub.sweep(claimedAt + 6000)?.jobsFailed ?? 0, 0);
  const ev = h.hub.db.all(`SELECT data FROM events WHERE type = 'hub.sweep'`).map((e) => JSON.parse(e.data)).at(-1);
  assert.deepEqual(ev.jobs, [{ id: j1.id, error: 'timed out' }]);

  // the answer arrives after all
  h.send(h.ev('s1', 'job.result', { jobId: j1.id, ok: true, text: 'Better late than never' }, claimedAt + 7000));
  assert.equal(h.state().jobs.find((j) => j.id === j1.id).state, 'done');
  assert.equal(task(h, tk.id).explainer, 'Better late than never');

  // a queued job nobody claims does not wedge re-explain forever
  const j2 = (await h.api('POST', `/v1/tasks/${tk.id}/explain`)).json.job;
  const q0 = Date.now();
  assert.equal(h.hub.sweep(q0 + 5000).jobsFailed, 1);
  const u = h.state().jobs.find((j) => j.id === j2.id);
  assert.equal(u.state, 'failed');
  assert.match(u.error, /not picked up/);
  const j3 = (await h.api('POST', `/v1/tasks/${tk.id}/explain`)).json.job;
  assert.notEqual(j3.id, j2.id);
});

// ====================================================================== digests
test('digest: the hub builds the input from tasks of that local date; job.result becomes a Digest', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const noon = new Date(2026, 4, 12, 12, 0, 0).getTime();           // 2026-05-12 local
  const prevDay = new Date(2026, 4, 11, 15, 0, 0).getTime();
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'S', model: 'm' }, prevDay));
  h.send(h.ev('s1', 'session.heartbeat', {}, noon));
  const mkTask = (title, status, at) => h.hub.createTask({ projectId: 'P-1', title, status }, at).task.id;
  const tDone = mkTask('Finish login', 'done', noon);
  const tDoneOld = mkTask('Done yesterday', 'done', prevDay);
  const tBlocked = mkTask('Needs creds', 'in_progress', noon);
  h.hub.updateTask(tBlocked, { status: 'blocked', blockedReason: 'waiting on API key' }, noon + 1000);
  const tProg = mkTask('Half way', 'in_progress', noon + 2000);
  h.send(h.ev('s1', 'recap.generated', { taskId: tDone, what: 'Login works', how: 'JWT', learned: 'Expiry matters', concepts: ['auth', 'jwt'] }, noon + 3000));
  mkTask('Untouched backlog', 'backlog', noon);

  const bad = await h.api('POST', '/v1/digest', { date: '2026-13-40' });
  assert.equal(bad.status, 400);
  assert.equal((await h.api('POST', '/v1/digest', { date: 'yesterday' })).status, 400);
  assert.equal((await h.api('POST', '/v1/digest', { projectId: 'P-99' })).status, 404);

  const dated = h.hub.requestDigest({ date: '2026-05-12', projectId: 'P-1' }, noon + 5000).job;
  assert.equal(dated.kind, 'digest');
  assert.deepEqual([dated.sessionId, dated.projectId, dated.taskId, dated.state], ['s1', 'P-1', null, 'queued']);
  assert.deepEqual(dated.input, {
    date: '2026-05-12', projectName: 'proj',
    done: [{ id: tDone, title: 'Finish login', recap: { what: 'Login works', how: 'JWT', learned: 'Expiry matters', concepts: ['auth', 'jwt'] } }],
    blocked: [{ id: tBlocked, title: 'Needs creds', reason: 'waiting on API key' }],
    inProgress: [{ id: tProg, title: 'Half way' }],
    concepts: ['auth', 'jwt'],
  });
  assert.ok(dated.input.done.every((d) => d.id !== tDoneOld));
  // default date = today (local) at the time of the request; no project = all projects
  const def = h.hub.requestDigest({}, noon + 6000).job;
  assert.equal(def.input.date, localDate(noon + 6000));
  assert.equal(def.input.projectName, null);
  assert.equal(def.projectId, null);
  assert.equal(h.hub.requestDigest(undefined, noon + 6000).job.input.date, '2026-05-12');
  const prev = h.hub.requestDigest({ date: '2026-05-11' }, noon + 7000).job;
  assert.deepEqual(prev.input.done.map((d) => d.id), [tDoneOld]);

  await h.get('/v1/sessions/s1/jobs');
  h.send(h.ev('s1', 'job.result', { jobId: dated.id, ok: true, text: '# Tuesday\n\nShipped **login**.' }, noon + 8000));
  const digests = (await h.get('/v1/digests')).json.digests;
  assert.equal(digests.length, 1);
  assert.deepEqual(digests[0], { id: 'D-1', date: '2026-05-12', projectId: 'P-1', text: '# Tuesday\n\nShipped **login**.', createdAt: noon + 8000 });
  assert.deepEqual(h.state().digests, digests);
  assert.deepEqual((await h.get('/v1/digests?projectId=P-1')).json.digests, digests);
  assert.deepEqual((await h.get('/v1/digests?projectId=P-2')).json.digests, []);
  assert.deepEqual((await h.get('/v1/state?projectId=P-1')).json.digests, digests);
  assert.equal(h.state().jobs.find((j) => j.id === dated.id).state, 'done');
  assert.equal(h.state().tasks.find((x) => x.id === tDone).explainJob, null, 'digest jobs do not touch tasks');
});

test('digests: newest first, limit honoured, SSE entities job and digest', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const now = Date.now();
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }, now));
  const s = openStream(h.base, {}, `/v1/stream?since=${h.hub.seqNow()}`); t.after(() => s.close());
  await s.waitFor((e) => e.comment === 'connected');
  const dates = ['2026-01-01', '2026-01-03', '2026-01-02'];
  for (let i = 0; i < dates.length; i++) {
    const j = (await h.api('POST', '/v1/digest', { date: dates[i] })).json.job;
    await h.get('/v1/sessions/s1/jobs');
    h.send(h.ev('s1', 'job.result', { jobId: j.id, ok: true, text: `digest for ${dates[i]}` }, now + 1000 * (i + 1)));
  }
  await s.waitFor((e) => e.event === 'change' && e.data.entity === 'job' && e.data.row.state === 'queued');
  await s.waitFor((e) => e.event === 'change' && e.data.entity === 'job' && e.data.row.state === 'done');
  const dg = await s.waitFor((e) => e.event === 'change' && e.data.entity === 'digest');
  assert.equal(dg.data.op, 'upsert');
  assert.equal(dg.data.row.date, '2026-01-01');
  assert.deepEqual((await h.get('/v1/digests')).json.digests.map((d) => d.date), ['2026-01-03', '2026-01-02', '2026-01-01']);
  assert.equal((await h.get('/v1/digests?limit=2')).json.digests.length, 2);
});

// ======================================================================= search
test('search finds questions, explainer text and digests', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const now = Date.now();
  world(h, 1, now);
  h.send(h.ev('s1', 'tool.called', { agentId: 'a1', toolUseId: 'qq', tool: 'AskUserQuestion', summary: 'Should the quokka cache be persistent?' }, now + 10));
  let hit = h.hub.search('quokka').find((r) => r.kind === 'question');
  assert.ok(hit, 'question indexed');
  assert.deepEqual([hit.id, hit.taskId, hit.sessionId, hit.projectId], ['Q-1', 'T-1', 's1', 'P-1']);

  assert.equal(h.hub.search('marsupial').length, 0);
  const j = (await h.api('POST', '/v1/tasks/T-1/explain')).json.job;
  await h.get('/v1/sessions/s1/jobs');
  h.send(h.ev('s1', 'job.result', { jobId: j.id, ok: true, text: 'The marsupial pattern keeps state in a pouch.' }, now + 20));
  hit = h.hub.search('marsupial').find((r) => r.kind === 'task');
  assert.equal(hit.id, 'T-1', 'explainer is part of the task document');
  assert.match(hit.snippet, /<mark>marsupial<\/mark>/);

  const dj = (await h.api('POST', '/v1/digest', { date: '2026-02-02', projectId: 'P-1' })).json.job;
  await h.get('/v1/sessions/s1/jobs');
  h.send(h.ev('s1', 'job.result', { jobId: dj.id, ok: true, text: 'Wombat migration finished early.' }, now + 30));
  hit = h.hub.search('wombat').find((r) => r.kind === 'digest');
  assert.deepEqual([hit.id, hit.projectId], ['D-1', 'P-1']);
  // editing the task keeps the explainer searchable
  await h.api('PATCH', '/v1/tasks/T-1', { title: 'Renamed' });
  assert.ok(h.hub.search('marsupial').some((r) => r.kind === 'task'));
});

// ============================================================ rebuild determinism
async function busyHub(h) {
  const now = Date.now();
  world(h, 3, now);
  edit(h, 'a1', '/w/p/shared.ts', now + 1000);
  edit(h, 'a2', '/w/p/shared.ts', now + 2000);
  edit(h, 'a3', '/w/p/solo.ts', now + 2500);
  h.send(h.ev('s1', 'tool.called', { agentId: 'a1', toolUseId: 'k1', tool: 'AskUserQuestion', summary: 'Pick a colour' }, now + 3000));
  h.send(h.ev('s1', 'tool.finished', { agentId: 'a1', toolUseId: 'k1', tool: 'AskUserQuestion', ok: true, summary: 'blue' }, now + 3500));
  h.send(h.ev('s1', 'tool.called', { toolUseId: 'k2', tool: 'AskUserQuestion', summary: 'Open question' }, now + 4000));
  h.send(h.ev('s1', 'tool.called', { toolUseId: 'k3', tool: 'AskUserQuestion', summary: 'Dismissed question' }, now + 4100));
  await h.api('POST', '/v1/questions/Q-3/dismiss');
  h.send(h.ev('s1', 'reconcile', { agents: [{ agentId: 'a1', status: 'running' }, { agentId: 'a2', status: 'waiting' }, { agentId: 'a3', status: 'running' }] }, now + 5000));
  const j1 = (await h.api('POST', '/v1/tasks/T-1/explain')).json.job;
  await h.api('POST', '/v1/tasks/T-3/explain');
  await h.get('/v1/sessions/s1/jobs');
  h.send(h.ev('s1', 'job.result', { jobId: j1.id, ok: true, text: '## Explained\nbecause.' }, now + 6000));
  const dj = (await h.api('POST', '/v1/digest', { date: '2026-03-03', projectId: 'P-1' })).json.job;
  await h.get('/v1/sessions/s1/jobs');
  h.send(h.ev('s1', 'job.result', { jobId: dj.id, ok: true, text: 'Digest text' }, now + 7000));
  const dj2 = (await h.api('POST', '/v1/digest', {})).json.job;
  h.send(h.ev('s1', 'agent.completed', { agentId: 'a3', ok: true, summary: 'done' }, now + 8000));
  return { now, dj2 };
}

test('rebuild reproduces conflicts, questions, jobs, digests, waiting agents and sweeps byte for byte', async (t) => {
  const h = await startTest({ jobMs: 1000 }); t.after(h.stop);
  const { now } = await busyHub(h);
  h.hub.sweep(now + 20 * MIN); // stalls a1, times out the running and the unclaimed job, idles the session
  const before = h.hub.dump();
  const stateBefore = h.state();
  assert.ok(before.agent_files.length >= 2 && before.questions.length === 4 && before.jobs.length >= 3 && before.digests.length === 1);
  assert.ok(before.tasks.some((x) => x.explainer), 'sanity: explainer stored');
  const info = h.hub.rebuild();
  assert.ok(info.replayed > 20, `replayed ${info.replayed}`);
  assert.deepEqual(h.hub.dump(), before, 'projection tables identical');
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
  assert.ok(h.hub.search('explained').some((r) => r.kind === 'task') && h.hub.search('digest').some((r) => r.kind === 'digest'));
  // the rebuilt hub keeps counting where it left off
  assert.equal((await h.api('POST', '/v1/digest', { projectId: 'P-1' })).json.job.id, `J-${before.counters.find((c) => c.name === 'J').n + 1}`);
});

test('rebuild while conflicts are live (no sweep) reproduces them too', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await busyHub(h);
  assert.ok(h.hub.conflicts().some((c) => c.path === '/w/p/shared.ts'));
  const before = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual(h.hub.conflicts().map((c) => c.path), ['/w/p/shared.ts']);
});

// ======================================================================= migration
test('a database from before v0.2 gains the new tables and task columns; its data survives and a rebuild backfills', async (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig({ home: dir, port: 0, singleton: false, sweep: false });
  const log = createLogger(path.join(dir, 'x.log'), { tty: false });
  let hub = new Hub(cfg, log);
  const ev = (sid, seq, type, data, at) => ({ sessionId: sid, seq, type, at, data });
  hub.ingest([
    ev('s1', 1, 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }, T0),
    ev('s1', 2, 'agent.spawned', { toolUseId: 'tu1', subagentType: 'b', model: 'm', description: 'Old task', prompt: '' }, T0),
    ev('s1', 3, 'agent.bound', { toolUseId: 'tu1', agentId: 'a1' }, T0),
    ev('s1', 4, 'tool.called', { toolUseId: 'qa', tool: 'AskUserQuestion', summary: 'Asked before v0.2' }, T0 + 1),
  ]);
  const wasTask = hub.state().tasks[0];
  hub.close();
  // Strip everything v0.2 added to simulate the old file format.
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(cfg.dbFile);
  for (const tbl of ['agent_files', 'conflicts', 'questions', 'jobs', 'digests']) raw.exec(`DROP TABLE ${tbl}`);
  for (const col of ['conflicts', 'explainer', 'explain_job']) raw.exec(`ALTER TABLE tasks DROP COLUMN ${col}`);
  const cols = () => raw.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  assert.ok(!cols().includes('conflicts') && !cols().includes('explainer'));
  raw.close();

  for (let i = 0; i < 2; i++) { // the second open proves the migration is idempotent
    hub = new Hub(cfg, log);
    const st = hub.state();
    assert.deepEqual(st.questions, []);
    assert.deepEqual([st.jobs, st.digests], [[], []]);
    assert.deepEqual(
      { ...st.tasks[0] }, { ...wasTask, conflicts: [], explainer: null, explainJob: null }, 'old rows read back with empty v0.2 fields');
    assert.deepEqual(hub.conflicts(), []);
    assert.equal(hub.conflictsStale(T0 + 60 * MIN), false);
    if (i === 0) hub.close();
  }
  // new events work on the migrated file
  hub.ingest([
    ev('s1', 5, 'tool.called', { agentId: 'a1', toolUseId: 'e1', tool: 'Edit', summary: 'Edit f', files: ['/w/p/f.ts'] }, T0 + 5000),
  ]);
  assert.equal(hub.db.get('SELECT COUNT(*) AS n FROM agent_files').n, 1);
  // `helmd --rebuild` replays the old events through the new projections: the pre-v0.2 question appears
  hub.rebuild();
  assert.deepEqual(hub.state().questions.map((q) => q.text), ['Asked before v0.2']);
  hub.close();
});

// ================================================================== demo-live
test('--demo-live occasionally asks a question and makes two agents edit the same file', async (t) => {
  const { seed, startDemoLive } = await import('../seed.mjs');
  const h = await startTest(); t.after(h.stop);
  seed(h.hub);
  const before = h.hub.db.get('SELECT COUNT(*) AS n FROM events').n;
  // deterministic randomness + a fast tick so a few hundred steps fit in the test
  let a = 20261010;
  const real = Math.random;
  Math.random = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const q = (like) => h.hub.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'tool.called' AND data LIKE ?`, like).n;
  const asks0 = q('%AskUserQuestion%'), files0 = q('%"files"%'); // the seed already contains some
  const stop = startDemoLive(h.hub, null, { tickMs: 4 });
  try {
    const t0 = Date.now();
    while ((q('%AskUserQuestion%') < asks0 + 1 || q('%"files"%') < files0 + 2) && Date.now() - t0 < 12_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(q('%AskUserQuestion%') >= asks0 + 1, 'an AskUserQuestion call was emitted');
    assert.ok(q('%"files"%') >= files0 + 2, 'conflicting edits announce files on tool.called');
  } finally {
    Math.random = real;
    stop();
  }
  assert.ok(h.hub.db.get('SELECT COUNT(*) AS n FROM events').n > before);
  assert.ok(h.state().questions.length >= 4, 'live question joined the three seeded ones');
});

test('reconcile: a discovered agent tagged [helm:T-n] binds to that card, even after it was found untagged', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h, 1);
  // a spawn the mod made itself: no agent.spawned, only reconcile reports it (with its description)
  h.send(h.ev('s1', 'reconcile', { agents: [{ agentId: 'a1', status: 'running' }, { agentId: 'f1', status: 'running', description: '[helm:T-1] follow-up', type: 'helm:builder' }] }, T0 + 1000));
  assert.equal(agent(h, 'f1').task_id ?? agent(h, 'f1').taskId, 'T-1');
  assert.equal(agent(h, 'f1').description, 'follow-up');
  // a row an older hub created untagged gets bound on the next report
  h.hub.db.run("UPDATE agents SET task_id = NULL, status = 'stalled' WHERE id = 'f1'");
  h.send(h.ev('s1', 'reconcile', { agents: [{ agentId: 'f1', status: 'running', description: '[helm:T-1] follow-up', type: 'helm:builder' }] }, T0 + 70_000));
  const f = agent(h, 'f1');
  assert.equal(f.task_id ?? f.taskId, 'T-1');
  assert.equal(f.status, 'running');
});
