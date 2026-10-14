// T-70: an interrupted task (its latest agent ended without success) can be Resumed instead of Started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';

async function setup(h, extra = {}) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'm' }));
  const pid = (await h.api('POST', '/v1/projects', { name: 'P' })).json.project.id;
  const task = (await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Stopped one', description: 'The brief', status: 'in_progress', ...extra })).json.task;
  return { pid, task };
}
const T = (h, id) => h.state().tasks.find((x) => x.id === id);
const spawn = (h, taskId, tu) => {
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: tu, subagentType: 'helm:builder', model: 'sonnet', description: `[helm:${taskId}] go`, prompt: '' }));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: tu, agentId: `ag-${tu}` }));
  return `ag-${tu}`;
};

test('a task whose agent failed is interrupted, with lastAgentId; a successful one is not', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { task } = await setup(h);
  const ag = spawn(h, task.id, 'u1');
  assert.equal(T(h, task.id).interrupted, false);
  h.send(h.ev('s1', 'agent.completed', { agentId: ag, ok: false, summary: 'ended: aborted' }));
  assert.equal(T(h, task.id).interrupted, true);
  assert.equal(T(h, task.id).lastAgentId, ag);
  const ok = (await h.api('POST', '/v1/tasks', { projectId: h.state().projects[0].id, title: 'fine', status: 'in_progress' })).json.task;
  const ag2 = spawn(h, ok.id, 'u2');
  h.send(h.ev('s1', 'agent.completed', { agentId: ag2, ok: true, summary: 'done' }));
  assert.equal(T(h, ok.id).interrupted, false);
});

test('interrupted survives a move to Later but not to Done, and clears when a new agent starts', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { task } = await setup(h);
  const ag = spawn(h, task.id, 'u1');
  h.send(h.ev('s1', 'agent.completed', { agentId: ag, ok: false, summary: 'x' }));
  await h.api('PATCH', `/v1/tasks/${task.id}`, { status: 'later' });
  assert.equal(T(h, task.id).interrupted, true);
  assert.equal((await h.get(`/v1/tasks/${task.id}`)).json.task.interrupted, true);
  spawn(h, task.id, 'u2');
  assert.equal(T(h, task.id).interrupted, false);
  assert.equal(T(h, task.id).lastAgentId, 'ag-u2');
  h.send(h.ev('s1', 'agent.completed', { agentId: 'ag-u2', ok: false, summary: 'y' }));
  assert.equal(T(h, task.id).interrupted, true);
  await h.api('PATCH', `/v1/tasks/${task.id}`, { status: 'done' });
  assert.equal(T(h, task.id).interrupted, false);
});

test('POST /resume queues a task note marked for resume, moves the card to next, and refuses a second click', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { task } = await setup(h);
  const ag = spawn(h, task.id, 'u1');
  h.send(h.ev('s1', 'agent.completed', { agentId: ag, ok: false, summary: 'x' }));
  await h.api('PATCH', `/v1/tasks/${task.id}`, { status: 'later' });
  await h.api('POST', '/v1/notes', { target: { kind: 'task', id: task.id }, text: 'prefer small commits' });
  const r = await h.api('POST', `/v1/tasks/${task.id}/resume`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.note.target, { kind: 'task', id: task.id });
  assert.equal(r.json.note.state, 'queued');
  assert.match(r.json.note.text, /^!\[helm:resume\] Resume Helm task /);
  assert.match(r.json.note.text, /prefer small commits/);
  assert.equal(r.json.task.status, 'next');
  assert.equal(r.json.task.startNoteId, r.json.note.id);
  assert.equal((await h.api('POST', `/v1/tasks/${task.id}/resume`)).status, 409);
  // a new agent bound to the card clears the flag
  spawn(h, task.id, 'u3');
  assert.equal(T(h, task.id).interrupted, false);
});

test('resume is refused for a task that is not interrupted; Start on an interrupted task resumes', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { task } = await setup(h, { status: 'backlog' });
  assert.equal((await h.api('POST', `/v1/tasks/${task.id}/resume`)).status, 409);
  const ag = spawn(h, task.id, 'u1');
  h.send(h.ev('s1', 'agent.completed', { agentId: ag, ok: false, summary: 'x' }));
  const r = await h.api('POST', `/v1/tasks/${task.id}/start`);
  assert.equal(r.status, 200);
  assert.match(r.json.note.text, /^!\[helm:resume\]/);
});

test('the resume event replays: --rebuild gives identical interrupted state', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { task } = await setup(h);
  const ag = spawn(h, task.id, 'u1');
  h.send(h.ev('s1', 'agent.completed', { agentId: ag, ok: false, summary: 'x' }));
  await h.api('POST', `/v1/tasks/${task.id}/resume`);
  const before = JSON.stringify(h.state().tasks.map((x) => [x.id, x.interrupted, x.lastAgentId, x.status, x.startNoteId]));
  const dump = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), dump);
  assert.equal(JSON.stringify(h.state().tasks.map((x) => [x.id, x.interrupted, x.lastAgentId, x.status, x.startNoteId])), before);
});
