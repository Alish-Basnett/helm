import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest, openStream } from './helpers.mjs';

// T-68: Talk must show a session note's reply the moment it is stored. The web store applies SSE `note` upserts,
// so the guarantee on the hub side is: note.reply pushes an upsert carrying the reply, in either arrival order.
const S1 = { kind: 'session', id: 's1' };

test('note.reply pushes a note upsert with the reply to live SSE clients', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'opus' }));
  const n = (await h.api('POST', '/v1/notes', { target: S1, text: 'just answer me' })).json.note;
  await h.api('POST', '/v1/notes/execute', { target: S1 });
  h.send(h.ev('s1', 'note.result', { noteId: n.id, ok: true, via: 'prompt' }));
  const s = openStream(h.base); t.after(() => s.close());
  await s.waitFor((e) => e.comment === 'connected');
  h.send(h.ev('s1', 'note.reply', { noteId: n.id, text: 'Yes, here is how.' }));
  const up = await s.waitFor((e) => e.event === 'change' && e.data.entity === 'note' && e.data.row.reply);
  assert.equal(up.data.op, 'upsert');
  assert.equal(up.data.row.id, n.id);
  assert.equal(up.data.row.state, 'ran');
  assert.equal(up.data.row.reply, 'Yes, here is how.');
  assert.ok(up.data.row.repliedAt > 0);
});

test('a reply that arrives before the delivery result is kept, and the note still becomes ran with it', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'opus' }));
  const n = (await h.api('POST', '/v1/notes', { target: S1, text: 'order test' })).json.note;
  await h.api('POST', '/v1/notes/execute', { target: S1 });
  h.send(h.ev('s1', 'note.reply', { noteId: n.id, text: 'early reply' }));
  h.send(h.ev('s1', 'note.result', { noteId: n.id, ok: true, via: 'prompt' }));
  const got = h.state().notes.find((x) => x.id === n.id);
  assert.equal(got.reply, 'early reply');
  assert.equal(got.state, 'ran');
});

test('a second reply (the real one after a "replied in session" notice) replaces the first', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'opus' }));
  const n = (await h.api('POST', '/v1/notes', { target: S1, text: 'x' })).json.note;
  await h.api('POST', '/v1/notes/execute', { target: S1 });
  h.send(h.ev('s1', 'note.result', { noteId: n.id, ok: true, via: 'prompt' }));
  h.send(h.ev('s1', 'note.reply', { noteId: n.id, text: '(Claude replied in the session, but the reply could not be captured here.)' }));
  h.send(h.ev('s1', 'note.reply', { noteId: n.id, text: 'the real answer' }));
  assert.equal(h.state().notes.find((x) => x.id === n.id).reply, 'the real answer');
});
