// v0.27.1: a Start / Resume never lands in another project's session; with no live session in the project it is held
// (note target 'project') and handed to the first session that starts or joins that project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';

// Client has a live session (sC); Trips (a hand-made project named like its folder) has none.
async function world(h) {
  h.send(h.ev('sC', 'session.started', { cwd: '/w/client', title: 'Client', model: 'm' }));
  const trips = (await h.api('POST', '/v1/projects', { name: 'trips' })).json.project.id;
  const client = h.state().sessions.find((s) => s.id === 'sC').projectId;
  return { trips, client };
}
const mkTask = async (h, projectId, extra = {}) =>
  (await h.api('POST', '/v1/tasks', { projectId, title: 'Trip thing', description: 'The brief', ...extra })).json.task;
const inbox = (h, sid) => h.hub.claimInbox(sid).notes;
const startTrips = (h) => h.send(h.ev('sT', 'session.started', { cwd: '/w/trips', title: 'Trips', model: 'm' }));

test('Start with no live session in the project is held, never sent to another project; the first session of the project gets it', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips, client } = await world(h);
  const task = await mkTask(h, trips, { sessionId: 'sC' }); // its session_id points at the Client session: ignored
  const r = await h.api('POST', `/v1/tasks/${task.id}/start`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.task.status, 'next');
  assert.equal(r.json.note.state, 'queued');
  assert.deepEqual(r.json.note.target, { kind: 'project', id: trips });
  assert.equal(r.json.note.sessionId, '');
  assert.deepEqual(inbox(h, 'sC'), [], 'the Client session got nothing');

  startTrips(h);
  assert.equal(h.state().sessions.find((s) => s.id === 'sT').projectId, trips);
  const n = h.state().notes.find((x) => x.id === r.json.note.id);
  assert.deepEqual([n.sessionId, n.target, n.state], ['sT', { kind: 'session', id: 'sT' }, 'queued']);
  assert.match(n.text, /^Start Helm task T-1 /);
  assert.deepEqual(inbox(h, 'sC'), []);
  assert.deepEqual(inbox(h, 'sT').map((x) => x.id), [n.id]);
  void client;
});

test('an existing session joining the project (or a live one elsewhere) also triggers delivery; Client never gets it', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips } = await world(h);
  const task = await mkTask(h, trips);
  const note = (await h.api('POST', `/v1/tasks/${task.id}/start`)).json.note;
  h.send(h.ev('sX', 'session.started', { cwd: '/w/other', title: 'Other', model: 'm' })); // a third project: not eligible
  assert.equal(h.state().notes.find((x) => x.id === note.id).state, 'queued');
  assert.equal(h.state().notes.find((x) => x.id === note.id).sessionId, '');
  await h.api('POST', '/v1/sessions/sX/join', { projectId: trips });
  assert.equal(h.state().notes.find((x) => x.id === note.id).sessionId, 'sX');
});

test('the task\'s own live session of its project is still preferred; an idle session beats a busy one', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips } = await world(h);
  startTrips(h);
  h.send(h.ev('sT2', 'session.started', { cwd: '/w/trips', title: 'Trips 2', model: 'm' }));
  const MIN = 60_000;
  h.hub.sweep(Date.now() + 3 * MIN); // both idle
  h.send(h.ev('sT', 'session.heartbeat', {}, Date.now() + 3 * MIN + 10)); // sT is active (newer), sT2 idle
  assert.equal(h.state().sessions.find((s) => s.id === 'sT').status, 'active');
  assert.equal(h.state().sessions.find((s) => s.id === 'sT2').status, 'idle');
  const a = await mkTask(h, trips);
  assert.equal((await h.api('POST', `/v1/tasks/${a.id}/start`)).json.note.sessionId, 'sT2', 'idle before busy');
  const b = await mkTask(h, trips, { sessionId: 'sT' });
  assert.equal((await h.api('POST', `/v1/tasks/${b.id}/start`)).json.note.sessionId, 'sT', 'its own session in the same project');
});

test('Resume with no live session is held and delivered as a task note', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips } = await world(h);
  startTrips(h);
  const task = await mkTask(h, trips, { status: 'in_progress' });
  h.send(h.ev('sT', 'agent.spawned', { toolUseId: 'u1', subagentType: 'helm:builder', model: 'sonnet', description: `[helm:${task.id}] go`, prompt: '' }));
  h.send(h.ev('sT', 'agent.bound', { toolUseId: 'u1', agentId: 'ag1' }));
  h.send(h.ev('sT', 'agent.completed', { agentId: 'ag1', ok: false, summary: 'aborted' }));
  h.send(h.ev('sT', 'session.ended', { reason: 'x' }));
  const r = await h.api('POST', `/v1/tasks/${task.id}/resume`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.note.target, { kind: 'project', id: trips });
  assert.equal((await h.api('POST', `/v1/tasks/${task.id}/resume`)).status, 409, 'a held start counts as in flight');
  h.send(h.ev('sT3', 'session.started', { cwd: '/w/trips', title: 'Trips again', model: 'm' }));
  const n = h.state().notes.find((x) => x.id === r.json.note.id);
  assert.deepEqual([n.target, n.sessionId], [{ kind: 'task', id: task.id }, 'sT3']);
  assert.match(n.text, /^!\[helm:resume\] Resume Helm task /);
});

test('choices with start: held in order for the project, delivered when a session is live', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips } = await world(h);
  const parent = await mkTask(h, trips);
  h.send(h.ev('sC', 'task.choices', { taskId: parent.id, choices: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }));
  const r = await h.api('POST', `/v1/tasks/${parent.id}/choices/apply`, { picked: ['a', 'b'], start: true });
  assert.deepEqual(r.json.errors, []);
  assert.deepEqual(r.json.tasks.map((x) => x.status), ['next', 'next']);
  const held = h.state().notes.filter((n) => n.target.kind === 'project');
  assert.equal(held.length, 2);
  assert.deepEqual(inbox(h, 'sC'), []);
  startTrips(h);
  assert.deepEqual(inbox(h, 'sT').map((n) => n.id), held.map((n) => n.id));
});

test('cancel drops a held start: note fails, card returns to the backlog, nothing is delivered later', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips } = await world(h);
  const task = await mkTask(h, trips);
  assert.equal((await h.api('POST', `/v1/tasks/${task.id}/start/cancel`)).status, 409, 'nothing to cancel yet');
  const note = (await h.api('POST', `/v1/tasks/${task.id}/start`)).json.note;
  const c = await h.api('POST', `/v1/tasks/${task.id}/start/cancel`);
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.task.status, 'backlog');
  assert.equal(c.json.note.state, 'failed');
  assert.match(c.json.note.error, /Cancelled/);
  assert.equal((await h.api('POST', `/v1/tasks/${task.id}/start/cancel`)).status, 409);
  assert.equal((await h.api('POST', '/v1/tasks/T-99/start/cancel')).status, 404);
  startTrips(h);
  assert.equal(h.state().notes.find((n) => n.id === note.id).sessionId, '');
  assert.deepEqual(inbox(h, 'sT'), []);
});

test('a second Start replaces a held one: the old note fails, only the new one is delivered', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips } = await world(h);
  const task = await mkTask(h, trips);
  const one = (await h.api('POST', `/v1/tasks/${task.id}/start`)).json.note;
  const two = (await h.api('POST', `/v1/tasks/${task.id}/start`)).json.note;
  assert.notEqual(one.id, two.id);
  assert.equal(h.state().notes.find((n) => n.id === one.id).state, 'failed');
  startTrips(h);
  assert.deepEqual(inbox(h, 'sT').map((n) => n.id), [two.id]);
});

test('auto-start never queues for a project without a live session', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips } = await world(h);
  await h.api('PATCH', `/v1/projects/${trips}`, { autoStart: true });
  const task = await mkTask(h, trips, { status: 'next' });
  h.hub.sweep(Date.now());
  assert.equal(h.state().notes.length, 0);
  assert.equal(h.state().tasks.find((x) => x.id === task.id).startNoteId, null);
  startTrips(h);
  h.hub.sweep(Date.now());
  const n = h.state().notes.find((x) => x.target.kind !== 'project');
  assert.ok(n && n.sessionId === 'sT', 'started in its own project once a session is live');
});

test('rebuild reproduces held, delivered, cancelled and superseded starts exactly', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips } = await world(h);
  const a = await mkTask(h, trips), b = await mkTask(h, trips), c = await mkTask(h, trips);
  await h.api('POST', `/v1/tasks/${a.id}/start`);                 // delivered below
  await h.api('POST', `/v1/tasks/${b.id}/start`);
  await h.api('POST', `/v1/tasks/${b.id}/start/cancel`);          // cancelled
  await h.api('POST', `/v1/tasks/${c.id}/start`);
  await h.api('POST', `/v1/tasks/${c.id}/start`);                 // supersedes
  const heldDump = h.hub.dump(), heldState = h.state();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), heldDump);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...heldState, seq: 0 });
  startTrips(h);
  const before = h.hub.dump(), st = h.state();
  assert.ok(st.notes.some((n) => n.sessionId === 'sT'));
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...st, seq: 0 });
});

test('a held Start follows a project merge: delivered to a session of the target project', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips } = await world(h);
  const task = await mkTask(h, trips);
  const note = (await h.api('POST', `/v1/tasks/${task.id}/start`)).json.note;
  const target = (await h.api('POST', '/v1/projects', { name: 'target' })).json.project.id;
  const m = await h.api('POST', `/v1/projects/${trips}/merge-into/${target}`);
  assert.equal(m.status, 200, m.text);
  assert.deepEqual(h.state().notes.find((n) => n.id === note.id).target, { kind: 'project', id: target });
  h.send(h.ev('sM', 'session.started', { cwd: '/w/target', title: 'Target', model: 'm' }));
  assert.equal(h.state().notes.find((n) => n.id === note.id).sessionId, 'sM');
  assert.deepEqual(inbox(h, 'sM').map((n) => n.id), [note.id]);
  const before = h.hub.dump(); h.hub.rebuild(); assert.deepEqual(h.hub.dump(), before);
});

test('a held Start follows its card when the card moves projects', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips } = await world(h);
  h.send(h.ev('sN', 'session.started', { cwd: '/w/elsewhere', title: 'N', model: 'm' }));
  const task = await mkTask(h, trips, { sessionId: 'sN' }); // sN lives in another project: ignored for routing
  const note = (await h.api('POST', `/v1/tasks/${task.id}/start`)).json.note;
  assert.deepEqual(h.state().notes.find((n) => n.id === note.id).target, { kind: 'project', id: trips });
  const dest = (await h.api('POST', '/v1/projects', { name: 'dest' })).json.project.id;
  await h.api('POST', '/v1/sessions/sN/join', { projectId: dest }); // sN carries the card into dest
  assert.equal(h.state().tasks.find((x) => x.id === task.id).projectId, dest);
  const n = h.state().notes.find((x) => x.id === note.id);
  assert.equal(n.sessionId, 'sN', "delivered by the card's current project, not the one it was queued for");
  assert.equal(h.state().sessions.find((s) => s.id === 'sN').projectId, dest);
});

test('archiving a project fails its held Start ("Project archived") and returns the card to the backlog', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { trips } = await world(h);
  const task = await mkTask(h, trips);
  const note = (await h.api('POST', `/v1/tasks/${task.id}/start`)).json.note;
  const a = await h.api('POST', `/v1/projects/${trips}/archive`);
  assert.equal(a.status, 200, a.text);
  const n = h.state().notes.find((x) => x.id === note.id);
  assert.deepEqual([n.state, n.error], ['failed', 'Project archived']);
  assert.equal(h.state().tasks.find((x) => x.id === task.id).status, 'backlog');
  const before = h.hub.dump(); h.hub.rebuild(); assert.deepEqual(h.hub.dump(), before);
});
