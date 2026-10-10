import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';

const start = (h, sid = 's1', cwd = '/work/alpha') => h.send(h.ev(sid, 'session.started', { cwd, title: 'Alpha work', model: 'opus' }));
const spawnAgent = (h, sid, toolUseId, description, extra = {}) =>
  h.send(h.ev(sid, 'agent.spawned', { toolUseId, subagentType: 'helm:builder', model: 'sonnet', description, prompt: 'p', ...extra }));

test('duplicate (sessionId, seq) is ignored and counted', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const e = h.ev('s1', 'session.started', { cwd: '/work/alpha', title: 'A', model: 'opus' });
  const a = await h.api('POST', '/v1/events', { events: [e] });
  assert.deepEqual([a.json.accepted, a.json.duplicates, a.json.lastSeq], [1, 0, 1]);
  const b = await h.api('POST', '/v1/events', { events: [e, e] });
  assert.deepEqual([b.json.accepted, b.json.duplicates, b.json.lastSeq], [0, 2, 1]);
  const tool = h.ev('s1', 'tool.called', { tool: 'Read', toolUseId: 'u', summary: 'Read x' });
  await h.api('POST', '/v1/events', { events: [tool, tool, tool] });
  const st = h.state();
  assert.equal(st.projects.length, 1);
  assert.equal(st.sessions.length, 1);
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM events').n, 2);
  assert.equal(h.hub.db.get("SELECT COUNT(*) AS n FROM activity WHERE kind = 'tool'").n, 1);
});

test('session.started creates a project from basename(cwd); a restart keeps the project', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  const s1 = h.state();
  assert.equal(s1.projects[0].name, 'alpha');
  assert.equal(s1.projects[0].id, 'P-1');
  h.send(h.ev('s1', 'session.started', { cwd: '/elsewhere/beta', title: 'Renamed', model: 'sonnet' }));
  const s2 = h.state();
  assert.equal(s2.projects.length, 1, 'existing session must not spawn another project');
  assert.equal(s2.sessions[0].title, 'Renamed');
  assert.equal(s2.sessions[0].projectId, 'P-1');
});

test('heartbeat sets tokens and costUsd; absent fields leave them alone', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  assert.equal(h.state().sessions[0].costUsd, 0);
  h.send(h.ev('s1', 'session.heartbeat', { tokens: 1200, costUsd: 0.42 }));
  let s = h.state().sessions[0];
  assert.deepEqual([s.tokens, s.costUsd, s.status], [1200, 0.42, 'active']);
  h.send(h.ev('s1', 'session.heartbeat', {}));
  s = h.state().sessions[0];
  assert.deepEqual([s.tokens, s.costUsd], [1200, 0.42]);
  h.send(h.ev('s1', 'session.heartbeat', { tokens: 5000, costUsd: 1.5 }));
  s = h.state().sessions[0];
  assert.deepEqual([s.tokens, s.costUsd], [5000, 1.5]);
});

test('turn.started / turn.completed toggle busy for the main agent only', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  h.send(h.ev('s1', 'turn.started', {}));
  assert.equal(h.state().sessions[0].busy, true);
  h.send(h.ev('s1', 'turn.started', { agentId: 'someone' }));
  h.send(h.ev('s1', 'turn.completed', { agentId: 'someone', ok: true }));
  assert.equal(h.state().sessions[0].busy, true);
  h.send(h.ev('s1', 'turn.completed', { ok: true }));
  assert.equal(h.state().sessions[0].busy, false);
});

test('[helm:T-n] tag links to the existing task; no tag auto-creates one', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  const mk = await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'Hand-made task', status: 'next' });
  assert.equal(mk.status, 201);
  assert.equal(mk.json.task.id, 'T-1');
  spawnAgent(h, 's1', 'tu1', 'Implement the thing [helm:T-1]');
  let st = h.state();
  assert.equal(st.tasks.length, 1, 'tagged spawn must not create a task');
  assert.equal(st.tasks[0].status, 'in_progress');
  assert.equal(st.tasks[0].agentId, 'pending:tu1');
  assert.equal(st.agents[0].taskId, 'T-1');

  spawnAgent(h, 's1', 'tu2', 'Investigate flaky test');
  st = h.state();
  assert.equal(st.tasks.length, 2);
  const auto = st.tasks.find((x) => x.id === 'T-2');
  assert.equal(auto.title, 'Investigate flaky test');
  assert.equal(auto.status, 'in_progress');
  assert.equal(auto.projectId, 'P-1');
  assert.equal(auto.agentId, 'pending:tu2');

  // explicit taskId wins over the description
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu3', taskId: 'T-1', subagentType: 'x', model: 'haiku', description: 'second pass [helm:T-2]', prompt: '' }));
  assert.equal(h.state().agents.find((a) => a.toolUseId === 'tu3').taskId, 'T-1');
  // unknown tag falls through to auto-create
  spawnAgent(h, 's1', 'tu4', 'ghost [helm:T-99]');
  assert.equal(h.state().tasks.length, 3);
});

test('pending agent is renamed on agent.bound (activity, task.agentId follow)', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  spawnAgent(h, 's1', 'tu1', 'Work on it');
  h.send(h.ev('s1', 'tool.called', { agentId: 'pending:tu1', toolUseId: 'x1', tool: 'Read', summary: 'Read a.ts' }));
  h.send(h.ev('s1', 'tool.finished', { agentId: 'pending:tu1', toolUseId: 'x1', tool: 'Read', ok: true, summary: 'ok' }));
  assert.equal(h.state().agents[0].id, 'pending:tu1');
  const stream = [];
  const unsub = h.hub.subscribe((rows) => stream.push(...rows));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: 'ag-real' }));
  unsub();
  const st = h.state();
  assert.deepEqual(st.agents.map((a) => a.id), ['ag-real']);
  assert.equal(st.tasks[0].agentId, 'ag-real');
  const act = h.hub.db.all("SELECT DISTINCT agent_id FROM activity WHERE kind IN ('tool','tool_done','status')");
  assert.deepEqual(act.map((r) => r.agent_id), ['ag-real']);
  assert.ok(stream.some((c) => c.entity === 'agent' && c.op === 'delete' && JSON.parse(c.row).id === 'pending:tu1'));
  assert.ok(stream.some((c) => c.entity === 'agent' && c.op === 'upsert' && JSON.parse(c.row).id === 'ag-real'));
  // later tool calls use the real id
  h.send(h.ev('s1', 'tool.called', { agentId: 'ag-real', toolUseId: 'x2', tool: 'Edit', summary: 'Edit a.ts' }));
  const a = h.state().agents[0];
  assert.equal(a.toolCount, 2);
  assert.equal(a.nowDoing, 'Edit a.ts');
});

test('an unknown agentId from a tool call lazily binds the sole pending agent', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  spawnAgent(h, 's1', 'tu1', 'Work');
  h.send(h.ev('s1', 'tool.called', { agentId: 'ag-early', toolUseId: 'x', tool: 'Grep', summary: 'Grep: foo' }));
  assert.equal(h.state().agents[0].id, 'ag-early');
  assert.equal(h.state().tasks[0].agentId, 'ag-early');
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: 'ag-early' })); // now a no-op
  assert.equal(h.state().agents.length, 1);
});

test('with several pending agents an early completion waits for its bind; orphan tool calls keep them alive', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const t0 = Date.now();
  start(h);
  spawnAgent(h, 's1', 'tuA', 'Agent A');
  spawnAgent(h, 's1', 'tuB', 'Agent B');
  h.send(h.ev('s1', 'tool.called', { agentId: 'ag-A', toolUseId: 'x', tool: 'Read', summary: 'Read z' }, t0 + 5000));
  const pend = h.state().agents;
  assert.ok(pend.every((a) => a.id.startsWith('pending:')));
  assert.ok(pend.every((a) => a.lastActivityAt >= t0 + 5000), 'every pending agent is kept alive');
  h.send(h.ev('s1', 'agent.completed', { agentId: 'ag-A', ok: true, summary: 'done early', tokens: 100 }, t0 + 6000));
  assert.ok(h.state().agents.every((a) => a.status === 'running'));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tuA', agentId: 'ag-A' }, t0 + 7000));
  const st = h.state();
  const a = st.agents.find((x) => x.id === 'ag-A');
  assert.equal(a.status, 'done');
  assert.equal(a.toolCount, 1, 'orphan tool call counted at bind');
  assert.equal(st.tasks.find((x) => x.id === a.taskId).status, 'review');
  assert.equal(h.hub.db.get("SELECT task_id FROM activity WHERE tool = 'Read'").task_id, a.taskId, 'orphan activity gets its task');
});

test('agent.completed ok -> task review; failed -> task blocked with the summary', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  spawnAgent(h, 's1', 'tu1', 'Good agent');
  spawnAgent(h, 's1', 'tu2', 'Bad agent');
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: 'g' }));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu2', agentId: 'b' }));
  h.send(h.ev('s1', 'tool.finished', { agentId: 'g', toolUseId: 'f1', tool: 'Edit', ok: true, summary: 'edited', files: ['a.ts', 'b.ts'] }));
  h.send(h.ev('s1', 'tool.finished', { agentId: 'g', toolUseId: 'f2', tool: 'Edit', ok: true, summary: 'edited', files: ['b.ts', 'c.ts'] }));
  h.send(h.ev('s1', 'agent.completed', { agentId: 'g', ok: true, summary: 'all good', tokens: 1234 }));
  h.send(h.ev('s1', 'agent.completed', { agentId: 'b', ok: false, summary: 'compile error in x.ts' }));
  const st = h.state();
  const g = st.agents.find((a) => a.id === 'g'), b = st.agents.find((a) => a.id === 'b');
  assert.deepEqual([g.status, b.status], ['done', 'failed']);
  assert.ok(g.endedAt && b.endedAt);
  assert.equal(g.tokens, 1234);
  const tg = st.tasks.find((x) => x.id === g.taskId), tb = st.tasks.find((x) => x.id === b.taskId);
  assert.equal(tg.status, 'review');
  assert.deepEqual(tg.filesChanged, ['a.ts', 'b.ts', 'c.ts'], 'files deduped');
  assert.equal(tg.tokens, 1234);
  assert.equal(tb.status, 'blocked');
  assert.equal(tb.blockedReason, 'compile error in x.ts');
  // repeating the completion is harmless
  h.send(h.ev('s1', 'agent.completed', { agentId: 'g', ok: false, summary: 'conflicting repeat' }));
  assert.equal(h.state().agents.find((a) => a.id === 'g').status, 'done');
});

test('recap.generated stores the recap and logs a recap activity', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  spawnAgent(h, 's1', 'tu1', 'Add JWT refresh rotation');
  h.send(h.ev('s1', 'recap.generated', { taskId: 'T-1', what: 'Did W', how: 'Via H', learned: 'L', concepts: ['auth', 'jwt', 'Auth', ' '] }));
  const task = h.state().tasks[0];
  assert.deepEqual(task.recap, { what: 'Did W', how: 'Via H', learned: 'L', concepts: ['auth', 'jwt'] });
  const act = h.hub.sessionActivity('s1', 50);
  assert.ok(act.some((a) => a.kind === 'recap' && a.taskId === 'T-1' && a.summary === 'Did W'));
  const learn = await h.get('/v1/learn');
  assert.deepEqual(learn.json.concepts.map((c) => [c.name, c.count]), [['auth', 1], ['jwt', 1]]);
  assert.equal(learn.json.concepts[0].recaps[0].taskId, 'T-1');
});

test('session.ended fails running agents ("session ended") and blocks their tasks', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  spawnAgent(h, 's1', 'tu1', 'Long job');
  spawnAgent(h, 's1', 'tu2', 'Finished job');
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: 'a1' }));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu2', agentId: 'a2' }));
  h.send(h.ev('s1', 'agent.completed', { agentId: 'a2', ok: true, summary: 'ok' }));
  h.send(h.ev('s1', 'turn.started', {}));
  h.send(h.ev('s1', 'session.ended', { reason: 'exit' }));
  const st = h.state();
  assert.equal(st.sessions[0].status, 'ended');
  assert.equal(st.sessions[0].busy, false);
  const a1 = st.agents.find((a) => a.id === 'a1'), a2 = st.agents.find((a) => a.id === 'a2');
  assert.equal(a1.status, 'failed');
  assert.equal(a2.status, 'done');
  const t1 = st.tasks.find((x) => x.id === a1.taskId);
  assert.equal(t1.status, 'blocked');
  assert.equal(t1.blockedReason, 'session ended');
  assert.ok(h.hub.sessionActivity('s1', 50).some((a) => a.summary.includes('session ended')));
});

test('events for a never-started session create a stub session in "Unassigned"', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('ghost-session-1', 'tool.called', { tool: 'Read', toolUseId: 'u', summary: 'Read q' }));
  const st = h.state();
  assert.equal(st.sessions.length, 1);
  assert.equal(st.projects[0].name, 'Unassigned');
  assert.equal(st.sessions[0].nowDoing, 'Read q');
});

test('invalid envelopes are rejected, a poisoned event does not break the batch', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const good = h.ev('s1', 'session.started', { cwd: '/w/p', title: 't', model: 'm' });
  const bad = [
    { sessionId: '', seq: 1, type: 'x', at: 1, data: {} },
    { sessionId: 's', seq: 'one', type: 'x', at: 1, data: {} },
    { sessionId: 's', seq: 1, type: 'hub.sweep', at: 1, data: {} },
    { sessionId: '_hub', seq: 1, type: 'tool.called', at: 1, data: {} },
    'nope',
  ];
  const poison = h.ev('s1', 'agent.spawned', {}); // missing toolUseId -> apply throws, rolled back
  const after = h.ev('s1', 'session.heartbeat', { tokens: 7 });
  const r = await h.api('POST', '/v1/events', { events: [good, ...bad, poison, after] });
  assert.equal(r.status, 200);
  assert.equal(r.json.rejected, 5);
  assert.equal(r.json.accepted, 3);
  assert.equal(h.state().sessions[0].tokens, 7);
  assert.equal(h.state().agents.length, 0);
  assert.equal((await h.api('POST', '/v1/events', { nope: 1 })).status, 400);
  assert.equal((await h.api('POST', '/v1/events', [1])).status, 400);
});

test('events in one batch are applied in seq order per session', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const e1 = h.ev('s1', 'session.started', { cwd: '/w/p', title: 't', model: 'm' });
  const e2 = h.ev('s1', 'agent.spawned', { toolUseId: 'u1', subagentType: 'x', model: 'm', description: 'D', prompt: '' });
  const e3 = h.ev('s1', 'agent.bound', { toolUseId: 'u1', agentId: 'real' });
  const r = h.hub.ingest([e3, e2, e1]);
  assert.equal(r.accepted, 3);
  assert.equal(h.state().agents[0].id, 'real');
});

test('a stub session (events before session.started) moves to its real project on session.started', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('s9', 'session.heartbeat', { tokens: 5 }));
  let st = h.state();
  assert.equal(st.projects.find((p) => p.id === st.sessions[0].projectId).name, 'Unassigned');
  h.send(h.ev('s9', 'agent.spawned', { toolUseId: 'u9', subagentType: 'helm:scout', model: 'haiku', description: 'Look around', prompt: 'p' }));
  h.send(h.ev('s9', 'session.started', { cwd: '/work/gamma', title: 'gamma', model: 'opus' }));
  st = h.state();
  const s = st.sessions.find((x) => x.id === 's9');
  const p = st.projects.find((x) => x.id === s.projectId);
  assert.equal(p.name, 'gamma');
  assert.ok(st.tasks.every((x) => x.projectId === p.id), 'tasks follow the session');
  assert.ok(!st.projects.some((x) => x.name === 'Unassigned'), 'empty auto stub project is dropped');
});

test('agent.completed files are appended to the task, deduped with tool.finished files', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  spawnAgent(h, 's1', 'uf', 'Edit things');
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'uf', agentId: 'af' }));
  h.send(h.ev('s1', 'tool.finished', { agentId: 'af', toolUseId: 'x1', tool: 'Edit', ok: true, summary: 'Editing a.ts', files: ['/w/a.ts'] }));
  h.send(h.ev('s1', 'agent.completed', { agentId: 'af', ok: true, summary: 'done', files: ['/w/a.ts', '/w/b.css'] }));
  const task = h.state().tasks[0];
  assert.deepEqual(task.filesChanged, ['/w/a.ts', '/w/b.css']);
  assert.equal(task.status, 'review');
});

test('main-loop tool calls carrying taskId are attributed to that task (activity and files)', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  const task = (await h.api('POST', '/v1/tasks', { projectId: h.state().projects[0].id, title: 'Do it myself' })).json.task;
  h.send(h.ev('s1', 'tool.called', { toolUseId: 'm1', tool: 'Edit', summary: 'Editing x.ts', taskId: task.id, files: ['/w/x.ts'] }));
  h.send(h.ev('s1', 'tool.finished', { toolUseId: 'm1', tool: 'Edit', ok: true, summary: 'Editing x.ts', taskId: task.id, files: ['/w/x.ts'] }));
  h.send(h.ev('s1', 'tool.called', { toolUseId: 'm2', tool: 'Read', summary: 'Reading y.ts', taskId: 'T-999' }));
  const d = (await h.api('GET', `/v1/tasks/${task.id}`)).json;
  assert.equal(d.activity.filter((r) => r.kind === 'tool' || r.kind === 'tool_done').length, 2);
  assert.deepEqual(d.task.filesChanged, ['/w/x.ts']);
});
