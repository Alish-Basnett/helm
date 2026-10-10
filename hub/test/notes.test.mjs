import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';

async function world(h) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'opus' }));
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 't1', subagentType: 'b', model: 'sonnet', description: 'Refactor auth', prompt: '' }));
}
const note = (h, id) => h.state().notes.find((n) => n.id === id);

test('note lifecycle: draft -> queued -> sending -> ran', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  const c = await h.api('POST', '/v1/notes', { target: { kind: 'session', id: 's1' }, text: 'Remember the migration' });
  assert.equal(c.status, 201);
  const n = c.json.note;
  assert.deepEqual([n.id, n.state, n.sessionId, n.queuedAt, n.via], ['N-1', 'draft', 's1', null, null]);

  const ed = await h.api('PATCH', '/v1/notes/N-1', { text: 'Remember the migration, edited' });
  assert.equal(ed.json.note.text, 'Remember the migration, edited');

  // nothing is delivered while it is a draft
  assert.deepEqual((await h.get('/v1/sessions/s1/inbox')).json.notes, []);

  const ex = await h.api('POST', '/v1/notes/execute', { target: { kind: 'session', id: 's1' } });
  assert.equal(ex.json.notes.length, 1);
  assert.equal(ex.json.notes[0].state, 'queued');
  assert.ok(ex.json.notes[0].queuedAt);
  assert.deepEqual((await h.api('POST', '/v1/notes/execute', { target: { kind: 'session', id: 's1' } })).json.notes, [], 'no drafts left');
  assert.equal((await h.api('PATCH', '/v1/notes/N-1', { text: 'too late' })).status, 409);
  assert.equal((await h.api('DELETE', '/v1/notes/N-1')).status, 409);

  const inbox = await h.get('/v1/sessions/s1/inbox');
  assert.equal(inbox.json.notes.length, 1);
  assert.equal(inbox.json.notes[0].state, 'sending');
  assert.equal(inbox.json.notes[0].text, 'Remember the migration, edited');
  assert.equal(note(h, 'N-1').state, 'sending');
  assert.deepEqual((await h.get('/v1/sessions/s1/inbox')).json.notes, [], 'second inbox call returns nothing');

  h.send(h.ev('s1', 'note.result', { noteId: 'N-1', ok: true, via: 'prompt' }));
  const done = note(h, 'N-1');
  assert.equal(done.state, 'ran');
  assert.equal(done.via, 'prompt');
  assert.ok(done.ranAt);
  assert.equal(done.error, null);
  h.send(h.ev('s1', 'note.result', { noteId: 'N-1', ok: false, via: 'prompt', error: 'late dup' }));
  assert.equal(note(h, 'N-1').state, 'ran', 'terminal state is sticky');
});

test('failed notes can be retried and delivered again', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  await h.api('POST', '/v1/notes', { target: { kind: 'session', id: 's1' }, text: 'Try me' });
  await h.api('POST', '/v1/notes/execute', { target: { kind: 'session', id: 's1' } });
  await h.get('/v1/sessions/s1/inbox');
  h.send(h.ev('s1', 'note.result', { noteId: 'N-1', ok: false, via: 'send_message', error: 'agent not reachable' }));
  let n = note(h, 'N-1');
  assert.deepEqual([n.state, n.error, n.via], ['failed', 'agent not reachable', 'send_message']);
  assert.equal((await h.api('POST', '/v1/notes/N-1/retry')).json.note.state, 'queued');
  n = note(h, 'N-1');
  assert.deepEqual([n.state, n.error, n.via, n.ranAt], ['queued', null, null, null]);
  assert.equal((await h.api('POST', '/v1/notes/N-1/retry')).status, 409, 'only failed notes retry');
  const again = await h.get('/v1/sessions/s1/inbox');
  assert.equal(again.json.notes.length, 1);
  h.send(h.ev('s1', 'note.result', { noteId: 'N-1', ok: true, via: 'prompt' }));
  assert.equal(note(h, 'N-1').state, 'ran');
});

test('inbox claim is atomic: concurrent callers get each note exactly once, oldest first', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  for (const text of ['one', 'two', 'three']) {
    await h.api('POST', '/v1/notes', { target: { kind: 'session', id: 's1' }, text });
  }
  await h.api('POST', '/v1/notes/execute', { target: { kind: 'session', id: 's1' } });
  const calls = await Promise.all(Array.from({ length: 8 }, () => h.get('/v1/sessions/s1/inbox')));
  const got = calls.flatMap((c) => c.json.notes.map((n) => n.text));
  assert.deepEqual(got, ['one', 'two', 'three']);
  assert.equal(calls.filter((c) => c.json.notes.length).length, 1);
  // other sessions' notes are untouched
  h.send(h.ev('s2', 'session.started', { cwd: '/w/q', title: 'Two', model: 'opus' }));
  await h.api('POST', '/v1/notes', { target: { kind: 'session', id: 's2' }, text: 'for two' });
  await h.api('POST', '/v1/notes/execute', { target: { kind: 'session', id: 's2' } });
  assert.deepEqual((await h.get('/v1/sessions/s1/inbox')).json.notes, []);
  assert.equal((await h.get('/v1/sessions/s2/inbox')).json.notes.length, 1);
});

test('task notes resolve the delivering session; drafts can be edited and deleted', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  const c = await h.api('POST', '/v1/notes', { target: { kind: 'task', id: 'T-1' }, text: 'Also check the docs' });
  assert.equal(c.json.note.sessionId, 's1');
  assert.deepEqual(c.json.note.target, { kind: 'task', id: 'T-1' });
  const detail = await h.get('/v1/tasks/T-1');
  assert.equal(detail.json.notes.length, 1);
  assert.equal(detail.json.task.id, 'T-1');
  assert.equal(detail.json.agent.id, 'pending:t1');
  assert.ok(Array.isArray(detail.json.activity));
  assert.equal((await h.api('DELETE', '/v1/notes/N-1')).status, 200);
  assert.equal(h.state().notes.length, 0);
  assert.equal((await h.api('PATCH', '/v1/notes/N-1', { text: 'x' })).status, 404);
  // a task with no session anywhere: draft is fine, executing is a 409
  const orphan = await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'Backlog idea' });
  assert.equal(orphan.status, 201);
  h.send(h.ev('s1', 'session.ended', { reason: 'x' }));
  const t2 = await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'Another' });
  const n2 = await h.api('POST', '/v1/notes', { target: { kind: 'task', id: t2.json.task.id }, text: 'hi' });
  assert.equal(n2.status, 201);
  assert.equal((await h.api('POST', '/v1/notes/execute', { target: { kind: 'task', id: t2.json.task.id } })).status, 409);
});

test('note validation', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  const post = (b) => h.api('POST', '/v1/notes', b);
  assert.equal((await post({ target: { kind: 'session', id: 's1' }, text: '   ' })).status, 400);
  assert.equal((await post({ target: { kind: 'nope', id: 's1' }, text: 'x' })).status, 400);
  assert.equal((await post({ target: { kind: 'session', id: 'missing' }, text: 'x' })).status, 404);
  assert.equal((await post({ text: 'x' })).status, 400);
});
