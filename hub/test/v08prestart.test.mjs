// v0.8 (T-38): draft notes on a task are folded into Start and marked ran (via 'start').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';

async function setup(h, extra = {}) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'm' }));
  const pid = h.state().projects[0]?.id ?? (await h.api('POST', '/v1/projects', { name: 'P' })).json.project.id;
  const t = (await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Fold', description: 'Do it', status: 'backlog', ...extra })).json.task;
  return { pid, t };
}
const note = (h, id) => h.state().notes.find((n) => n.id === id);
const draft = async (h, taskId, text) => (await h.api('POST', '/v1/notes', { target: { kind: 'task', id: taskId }, text })).json.note;

test('/start folds the draft notes after the Brief and marks them ran via start', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { t: task } = await setup(h);
  const a = await draft(h, task.id, 'use tabs'), b = await draft(h, task.id, 'keep it small');
  const r = await h.api('POST', `/v1/tasks/${task.id}/start`);
  assert.equal(r.status, 200);
  assert.match(r.json.note.text, /Brief:\nDo it\n\nNotes from the user:\n- use tabs\n- keep it small\n\nCreate nothing new/);
  for (const id of [a.id, b.id]) {
    const n = note(h, id);
    assert.equal(n.state, 'ran'); assert.equal(n.via, 'start'); assert.ok(n.ranAt);
  }
  const ev = JSON.parse(h.hub.db.get("SELECT data FROM events WHERE type = 'hub.task.start'").data);
  assert.deepEqual(ev.noteIds, [a.id, b.id]);
  assert.equal(ev.text, r.json.note.text);
});

test('a task with no drafts keeps the original start text; non-draft notes are untouched', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { t: task } = await setup(h);
  const q = await draft(h, task.id, 'queued one');
  await h.api('POST', '/v1/notes/execute', { target: { kind: 'task', id: task.id } });
  const d = await draft(h, task.id, 'fresh draft');
  const r = await h.api('POST', `/v1/tasks/${task.id}/start`);
  assert.doesNotMatch(r.json.note.text, /queued one/);
  assert.match(r.json.note.text, /- fresh draft/);
  assert.equal(note(h, q.id).state, 'queued');
  assert.equal(note(h, d.id).state, 'ran');
  const t2 = (await h.api('POST', '/v1/tasks', { projectId: h.state().projects[0].id, title: 'Plain', description: 'x', status: 'next' })).json.task;
  const r2 = await h.api('POST', `/v1/tasks/${t2.id}/start`);
  assert.doesNotMatch(r2.json.note.text, /Notes from the user/);
});

test('auto-start folds drafts and records noteIds in hub.task.autostart', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, t: task } = await setup(h, { status: 'next' });
  const a = await draft(h, task.id, 'auto note');
  const on = await h.api('PATCH', `/v1/projects/${pid}`, { autoStart: true });
  assert.deepEqual(on.json.autoStarted, [task.id]);
  const n = note(h, a.id);
  assert.equal(n.state, 'ran'); assert.equal(n.via, 'start');
  const startNote = note(h, h.state().tasks.find((x) => x.id === task.id).startNoteId);
  assert.match(startNote.text, /Notes from the user:\n- auto note/);
  const ev = JSON.parse(h.hub.db.get("SELECT data FROM events WHERE type = 'hub.task.autostart'").data);
  assert.deepEqual(ev.noteIds, [a.id]);
});

test('create with start: true and Choices apply with start still work (no drafts to fold)', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, t: pt } = await setup(h);
  const c = await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Now', description: 'go', start: true });
  assert.equal(c.status, 201); assert.ok(c.json.note);
  h.send(h.ev('s1', 'task.choices', { taskId: pt.id, choices: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }));
  const r = await h.api('POST', `/v1/tasks/${pt.id}/choices/apply`, { picked: ['a', 'b'], start: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.errors.length, 0);
  assert.equal(r.json.tasks.length, 2);
  assert.ok(r.json.tasks.every((x) => x.startNoteId));
});

test('rebuild reproduces folded notes exactly', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { t: task } = await setup(h);
  const a = await draft(h, task.id, 'one'); await draft(h, task.id, 'two');
  await h.api('POST', `/v1/tasks/${task.id}/start`);
  const before = h.hub.dump(); const stateBefore = h.state();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
  assert.equal(note(h, a.id).via, 'start');
});
