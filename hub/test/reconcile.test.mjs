import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';

async function world(h) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'opus' }));
  for (const [tu, id] of [['t1', 'a1'], ['t2', 'a2'], ['t3', 'a3'], ['t4', 'a4']]) {
    h.send(h.ev('s1', 'agent.spawned', { toolUseId: tu, subagentType: 'b', model: 'sonnet', description: `job ${id}`, prompt: '' }));
    h.send(h.ev('s1', 'agent.bound', { toolUseId: tu, agentId: id }));
  }
}
const byId = (h, id) => h.state().agents.find((a) => a.id === id);

test('reconcile repairs drift both ways', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  h.send(h.ev('s1', 'reconcile', { agents: [
    { agentId: 'a1', status: 'done' },     // hub thinks running, engine finished
    { agentId: 'a2', status: 'running' },  // in sync
    { agentId: 'a3', status: 'failed' },   // engine failed
    // a4 missing entirely                  // engine lost it
    { agentId: 'ghost', status: 'running' }, // engine runs one the hub never heard of
  ] }));
  assert.equal(byId(h, 'a1').status, 'done');
  assert.equal(byId(h, 'a2').status, 'running');
  assert.equal(byId(h, 'a3').status, 'failed');
  assert.equal(byId(h, 'a4').status, 'failed');
  const ghost = byId(h, 'ghost');
  assert.ok(ghost, 'unknown running agent is created');
  assert.equal(ghost.status, 'running');
  const tasks = h.state().tasks;
  const taskOf = (id) => tasks.find((x) => x.id === byId(h, id).taskId);
  assert.equal(taskOf('a1').status, 'review');
  assert.equal(taskOf('a3').status, 'blocked');
  assert.equal(taskOf('a4').status, 'blocked');
  assert.equal(taskOf('a2').status, 'in_progress');
  // idempotent
  h.send(h.ev('s1', 'reconcile', { agents: [{ agentId: 'a2', status: 'running' }, { agentId: 'ghost', status: 'running' }] }));
  assert.equal(h.state().agents.length, 5);
  // the ghost is later reported finished
  h.send(h.ev('s1', 'reconcile', { agents: [{ agentId: 'a2', status: 'running' }, { agentId: 'ghost', status: 'done' }] }));
  assert.equal(byId(h, 'ghost').status, 'done');
});

test('reconcile is scoped to its own session', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  h.send(h.ev('s2', 'session.started', { cwd: '/w/q', title: 'Other', model: 'opus' }));
  h.send(h.ev('s2', 'reconcile', { agents: [] }));
  assert.ok(h.state().agents.filter((a) => a.sessionId === 's1').every((a) => a.status === 'running'));
});

test('a running agent unknown to the hub binds to the sole pending agent instead of duplicating', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'opus' }));
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 't1', subagentType: 'b', model: 'sonnet', description: 'job', prompt: '' }));
  h.send(h.ev('s1', 'reconcile', { agents: [{ agentId: 'real-1', status: 'running' }] }));
  const st = h.state();
  assert.deepEqual(st.agents.map((a) => a.id), ['real-1']);
  assert.equal(st.tasks[0].agentId, 'real-1');
});

test('the inbound endpoints the mod uses: /agents, /project, /tasks', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  const ag = await h.get('/v1/sessions/s1/agents');
  assert.equal(ag.json.agents.length, 4);
  assert.equal((await h.get('/v1/sessions/s1/project')).json.project.name, 'p');
  assert.equal((await h.get('/v1/sessions/nope/project')).status, 404);
  assert.deepEqual((await h.get('/v1/sessions/nope/agents')).json.agents, []);
  const tasks = await h.get('/v1/tasks?sessionId=s1&status=in_progress');
  assert.equal(tasks.json.tasks.length, 4);
  assert.equal((await h.get('/v1/tasks?sessionId=s1&status=done')).json.tasks.length, 0);
  assert.equal((await h.get('/v1/tasks?status=bogus')).status, 400);
});
