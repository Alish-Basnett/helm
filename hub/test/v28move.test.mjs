// v0.28: move a card to another project; GET /v1/tasks/:id/start-target shows where a Start would go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest, asSession, sockRequest } from './helpers.mjs';

// alpha (sA, coordinator), beta (sB), gamma (sG); "dormant" is a hand-made project with no session.
async function world(h) {
  h.send(h.ev('sA', 'session.started', { cwd: '/w/alpha', title: 'Alpha main', model: 'm' }));
  h.send(h.ev('sB', 'session.started', { cwd: '/w/beta', title: 'Beta main', model: 'm' }));
  h.send(h.ev('sG', 'session.started', { cwd: '/w/gamma', title: 'Gamma main', model: 'm' }));
  const id = (sid) => h.state().sessions.find((s) => s.id === sid).projectId;
  const alpha = id('sA'), beta = id('sB'), gamma = id('sG');
  await h.api('POST', `/v1/projects/${alpha}/coordinator`, { on: true });
  const dormant = (await h.api('POST', '/v1/projects', { name: 'dormant' })).json.project.id;
  return { alpha, beta, gamma, dormant };
}
const mk = async (h, projectId, extra = {}) =>
  (await h.api('POST', '/v1/tasks', { projectId, title: 'A card', description: 'brief', ...extra })).json.task;
const task = (h, id) => h.state().tasks.find((x) => x.id === id);
const mv = (h, id, projectId) => h.api('POST', `/v1/tasks/${id}/move`, { projectId });
const who = async (h, sid) => ((h._as ??= {})[sid] ??= await asSession(h, sid));
const rebuildSame = (h) => { const b = h.hub.dump(), st = h.state(); h.hub.rebuild(); assert.deepEqual(h.hub.dump(), b); assert.deepEqual({ ...h.state(), seq: 0 }, { ...st, seq: 0 }); };

test('move keeps id, notes and dependsOn, lands at the end of the column, leaves children behind', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { beta, gamma } = await world(h);
  const dep = await mk(h, beta, { title: 'dep' });
  const parent = await mk(h, beta, { dependsOn: [dep.id] });
  const child = await mk(h, beta, { parentTaskId: parent.id });
  await h.api('POST', '/v1/notes', { target: { kind: 'task', id: parent.id }, text: 'keep me' });
  const other = await mk(h, gamma);
  const r = await mv(h, parent.id, gamma);
  assert.equal(r.status, 200, r.text);
  const moved = task(h, parent.id);
  assert.equal(moved.projectId, gamma);
  assert.deepEqual(moved.dependsOn, [dep.id]);
  assert.ok(h.state().notes.some((n) => n.target.id === parent.id && n.text === 'keep me'));
  assert.ok(moved.order > task(h, other.id).order, 'after the target column');
  assert.equal(task(h, child.id).projectId, beta, 'children are not moved');
  assert.equal((await mv(h, parent.id, gamma)).status, 200, 'same project: a no-op');
  rebuildSame(h);
});

test('archived or unknown target is 409; unknown card 404; bad body 400', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { beta, dormant } = await world(h);
  const c = await mk(h, beta);
  await h.api('POST', `/v1/projects/${dormant}/archive`);
  assert.equal((await mv(h, c.id, dormant)).status, 409);
  assert.equal((await mv(h, c.id, 'P-999')).status, 409);
  assert.equal((await mv(h, 'T-999', beta)).status, 404);
  assert.equal((await h.api('POST', `/v1/tasks/${c.id}/move`, {})).status, 400);
  assert.equal(task(h, c.id).projectId, beta);
});

test('the card\'s session is cleared when it is not in the target project, kept when it is', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { beta, gamma } = await world(h);
  const c = await mk(h, beta, { sessionId: 'sB' });
  assert.equal(task(h, c.id).sessionId, 'sB');
  await mv(h, c.id, gamma);
  assert.equal(task(h, c.id).sessionId, null);
  const d = await mk(h, beta, { sessionId: 'sG' }); // points at a session of gamma
  await mv(h, d.id, gamma);
  assert.equal(task(h, d.id).sessionId, 'sG');
  rebuildSame(h);
});

test('a held Start follows the card: delivered to a session of the new project', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { dormant, gamma } = await world(h);
  const c = await mk(h, dormant);
  const note = (await h.api('POST', `/v1/tasks/${c.id}/start`)).json.note;
  assert.deepEqual(note.target, { kind: 'project', id: dormant });
  const r = await mv(h, c.id, gamma);
  assert.equal(r.status, 200, r.text);
  const n = h.state().notes.find((x) => x.id === note.id);
  assert.equal(n.sessionId, 'sG', 'handed to the new project\'s live session');
  assert.equal(h.hub.claimInbox('sG').notes.some((x) => x.id === note.id), true);
  assert.equal(h.hub.claimInbox('sB').notes.length, 0);
  rebuildSame(h);
});

test('a held Start that stays held is retargeted to the new project', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { dormant, gamma } = await world(h);
  const other = (await h.api('POST', '/v1/projects', { name: 'other' })).json.project.id;
  const c = await mk(h, dormant);
  const note = (await h.api('POST', `/v1/tasks/${c.id}/start`)).json.note;
  await mv(h, c.id, other);
  assert.deepEqual(h.state().notes.find((x) => x.id === note.id).target, { kind: 'project', id: other });
  void gamma;
  rebuildSame(h);
});

test('over the socket only the coordinator session may move a card; the move leaves a task link', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { beta, gamma } = await world(h);
  const c = await mk(h, beta);
  const spoke = await (await who(h, 'sB'))('POST', `/v1/tasks/${c.id}/move`, { projectId: gamma });
  assert.equal(spoke.status, 403, spoke.text);
  assert.equal(task(h, c.id).projectId, beta);
  const sock = await sockRequest(h.cfg.sockFile, 'POST', `/v1/tasks/${c.id}/move`, { projectId: gamma });
  assert.equal(sock.status, 401, 'no session token');
  const spoof = await (await who(h, 'sB'))('POST', `/v1/tasks/${c.id}/move`, { projectId: gamma, fromSessionId: 'sA' });
  assert.equal(spoof.status, 403, 'the body\'s fromSessionId is ignored: the token decides');
  const ok = await (await who(h, 'sA'))('POST', `/v1/tasks/${c.id}/move`, { projectId: gamma });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(task(h, c.id).projectId, gamma);
  const link = h.state().links.find((l) => l.kind === 'task' && l.refId === c.id);
  assert.ok(link, 'a task link records it');
  assert.equal(link.fromSessionId, 'sA');
  assert.match(link.text, /^moved T-1 from beta to gamma/);
  rebuildSame(h);
});

test('the dashboard may move any card (and a smuggled fromSessionId is ignored)', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { beta, gamma } = await world(h);
  const c = await mk(h, beta);
  const r = await h.api('POST', `/v1/tasks/${c.id}/move`, { projectId: gamma, fromSessionId: 'sB' });
  assert.equal(r.status, 200, r.text);
  assert.equal(h.state().links.length, 0, 'no session, no link');
});

// ---- start-target: the answer equals where the real Start goes
const target = async (h, id) => (await h.get(`/v1/tasks/${id}/start-target`)).json;
async function actual(h, id) {
  const r = await h.api('POST', `/v1/tasks/${id}/start`);
  assert.equal(r.status, 200, r.text);
  return r.json.note;
}

test('start-target: the card\'s own live session', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { beta } = await world(h);
  h.send(h.ev('sB2', 'session.started', { cwd: '/w/beta', title: 'Beta two', model: 'm' }));
  const c = await mk(h, beta, { sessionId: 'sB' });
  const tg = await target(h, c.id);
  assert.deepEqual(tg, { projectId: beta, projectName: 'beta', sessionId: 'sB', sessionLabel: 'Beta main', held: false });
  assert.equal((await actual(h, c.id)).sessionId, tg.sessionId);
});

test('start-target: the project\'s live session ; the app title wins over the title', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { gamma } = await world(h);
  h.hub.setAppTitle('sG', 'App Gamma', 'local_1');
  const c = await mk(h, gamma);
  const tg = await target(h, c.id);
  assert.equal(tg.sessionId, 'sG');
  assert.equal(tg.held, false);
  assert.equal(tg.sessionLabel, 'App Gamma');
  assert.equal((await actual(h, c.id)).sessionId, 'sG');
});

test('start-target: held when the project has no live session, and the answer has no side effects', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { dormant } = await world(h);
  const c = await mk(h, dormant);
  const before = h.hub.dump();
  const tg = await target(h, c.id);
  assert.deepEqual(tg, { projectId: dormant, projectName: 'dormant', sessionId: null, sessionLabel: null, held: true });
  assert.deepEqual(h.hub.dump(), before, 'a GET changes nothing');
  const n = await actual(h, c.id);
  assert.deepEqual(n.target, { kind: 'project', id: dormant });
  assert.equal(n.sessionId, '');
});

test('start-target: a task session in another project is ignored', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { beta, gamma } = await world(h);
  const c = await mk(h, beta, { sessionId: 'sG' }); // sG lives in gamma
  const tg = await target(h, c.id);
  assert.equal(tg.projectId, beta);
  assert.equal(tg.sessionId, 'sB');
  assert.equal((await actual(h, c.id)).sessionId, 'sB');
  assert.equal((await h.get('/v1/tasks/T-999/start-target')).status, 404);
  void gamma;
});
