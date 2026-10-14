// T-73: a pending (draft) note can be edited or deleted until Start folds it in; after that the hub answers 409.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';

async function setup(h) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'm' }));
  const pid = (await h.api('POST', '/v1/projects', { name: 'P' })).json.project.id;
  const t = (await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Pend', description: 'Do it', status: 'backlog' })).json.task;
  return t;
}
const draft = async (h, taskId, text, extra = {}) => (await h.api('POST', '/v1/notes', { target: { kind: 'task', id: taskId }, text, ...extra })).json.note;
const upload = (h, name) => fetch(h.base + '/v1/attachments', { method: 'POST', headers: { 'x-filename': name, 'content-type': 'text/plain' }, body: Buffer.from('hi') }).then((r) => r.json());
const evTypes = (h) => h.hub.db.all("SELECT type FROM events WHERE type LIKE 'hub.note.%' ORDER BY seq").map((r) => r.type);

test('a pending note can be edited (attachments kept) and deleted; both are events and replay', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const task = await setup(h);
  const up = (await upload(h, 'a.txt')).attachment;
  const n = await draft(h, task.id, 'first', { attachments: [up.id] });
  const ed = await h.api('PATCH', `/v1/notes/${n.id}`, { text: 'second' });
  assert.equal(ed.status, 200);
  assert.equal(ed.json.note.text, 'second');
  assert.deepEqual(ed.json.note.attachments.map((a) => a.id), [up.id], 'text edit keeps the files');
  assert.equal(ed.json.note.state, 'draft');
  const other = await draft(h, task.id, 'to remove');
  assert.equal((await h.api('DELETE', `/v1/notes/${other.id}`)).status, 200);
  assert.ok(!h.state().notes.some((x) => x.id === other.id));
  assert.deepEqual(evTypes(h), ['hub.note.create', 'hub.note.update', 'hub.note.create', 'hub.note.delete']);
  const before = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before, 'replay reproduces the edit and the delete');
  assert.equal(h.state().notes.find((x) => x.id === n.id).text, 'second');
});

test('after Start folds a pending note in, edit and delete are refused with 409', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const task = await setup(h);
  const n = await draft(h, task.id, 'folded');
  assert.equal((await h.api('POST', `/v1/tasks/${task.id}/start`)).status, 200);
  assert.equal(h.state().notes.find((x) => x.id === n.id).state, 'ran');
  const p = await h.api('PATCH', `/v1/notes/${n.id}`, { text: 'late' });
  assert.equal(p.status, 409);
  assert.match(p.json.error, /only draft notes/);
  assert.equal((await h.api('DELETE', `/v1/notes/${n.id}`)).status, 409);
  assert.equal(h.state().notes.find((x) => x.id === n.id).text, 'folded');
});

test('a queued or sending note is refused too', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await setup(h);
  const n = (await h.api('POST', '/v1/notes', { target: { kind: 'session', id: 's1' }, text: 'x' })).json.note;
  await h.api('POST', '/v1/notes/execute', { target: { kind: 'session', id: 's1' } });
  assert.equal(h.state().notes.find((x) => x.id === n.id).state, 'queued');
  assert.equal((await h.api('PATCH', `/v1/notes/${n.id}`, { text: 'y' })).status, 409);
  assert.equal((await h.api('DELETE', `/v1/notes/${n.id}`)).status, 409);
  await h.get('/v1/sessions/s1/inbox');
  assert.equal(h.state().notes.find((x) => x.id === n.id).state, 'sending');
  assert.equal((await h.api('PATCH', `/v1/notes/${n.id}`, { text: 'y' })).status, 409);
  assert.equal((await h.api('DELETE', `/v1/notes/${n.id}`)).status, 409);
});
