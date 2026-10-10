import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest, openStream, sleep } from './helpers.mjs';

test('SSE delivers changes as they are committed', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const s = openStream(h.base); t.after(() => s.close());
  await s.waitFor((e) => e.comment === 'connected');
  await h.api('POST', '/v1/events', { events: [h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' })] });
  const proj = await s.waitFor((e) => e.event === 'change' && e.data.entity === 'project');
  assert.equal(proj.data.op, 'upsert');
  assert.equal(proj.data.row.name, 'p');
  assert.ok(Number.isInteger(proj.id));
  const sess = await s.waitFor((e) => e.event === 'change' && e.data.entity === 'session');
  assert.equal(sess.data.row.id, 's1');
  assert.ok(sess.id > proj.id, 'ids are increasing change seqs');
  await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'From UI' });
  const task = await s.waitFor((e) => e.event === 'change' && e.data.entity === 'task');
  assert.equal(task.data.row.title, 'From UI');
  // a rejected command emits nothing
  const before = s.events.length;
  await h.api('POST', '/v1/tasks', { projectId: 'P-1' });
  await sleep(60);
  assert.equal(s.events.length, before);
  // deletes carry op=delete
  await h.api('POST', '/v1/notes', { target: { kind: 'session', id: 's1' }, text: 'tmp' });
  await h.api('DELETE', '/v1/notes/N-1');
  await s.waitFor((e) => e.event === 'change' && e.data.entity === 'note' && e.data.op === 'delete');
});

test('Last-Event-ID resumes from the changes table; nothing is lost or repeated', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await h.api('POST', '/v1/events', { events: [h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' })] });
  const seqAfterStart = (await h.get('/v1/state')).json.seq;
  assert.ok(seqAfterStart >= 2);
  await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'missed 1' });
  await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'missed 2' });
  const s = openStream(h.base, { 'Last-Event-ID': String(seqAfterStart) }); t.after(() => s.close());
  await s.waitFor((e) => e.event === 'change' && e.data.row.title === 'missed 2');
  const replayed = s.events.filter((e) => e.event === 'change');
  assert.deepEqual(replayed.map((e) => e.data.row.title), ['missed 1', 'missed 2']);
  assert.ok(replayed.every((e) => e.id > seqAfterStart));
  assert.ok(!s.events.some((e) => e.event === 'reset'));
  // and the live stream continues after the replay
  await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'live 3' });
  const live = await s.waitFor((e) => e.event === 'change' && e.data.row.title === 'live 3');
  assert.equal(live.id, replayed[1].id + 1);
  // resuming from the latest id replays nothing
  const s2 = openStream(h.base, { 'Last-Event-ID': String(live.id) }); t.after(() => s2.close());
  await s2.waitFor((e) => e.comment === 'connected');
  await sleep(80);
  assert.equal(s2.events.filter((e) => e.event === 'change').length, 0);
});

test('too-old or impossible Last-Event-ID gets event: reset', async (t) => {
  const h = await startTest({ keepChanges: 6 }); t.after(h.stop);
  await h.api('POST', '/v1/events', { events: [h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' })] });
  for (let i = 0; i < 30; i++) await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'bulk ' + i });
  const kept = h.hub.db.get('SELECT COUNT(*) AS n FROM changes').n;
  assert.ok(kept <= 6 + 6, `changes are trimmed (kept ${kept})`);
  const cur = h.hub.seqNow();
  const old = openStream(h.base, { 'Last-Event-ID': '1' }); t.after(() => old.close());
  const r = await old.waitFor((e) => e.event === 'reset');
  assert.equal(r.data.seq, cur);
  assert.equal(r.id, cur, 'reset carries the current id so the next resume is clean');
  const future = openStream(h.base, { 'Last-Event-ID': String(cur + 100) }); t.after(() => future.close());
  await future.waitFor((e) => e.event === 'reset');
  const junk = openStream(h.base, { 'Last-Event-ID': 'banana' }); t.after(() => junk.close());
  await junk.waitFor((e) => e.event === 'reset');
  // recent enough still resumes
  const recent = openStream(h.base, { 'Last-Event-ID': String(cur - 2) }); t.after(() => recent.close());
  await recent.waitFor((e) => e.event === 'change');
  assert.ok(!recent.events.some((e) => e.event === 'reset'));
  // ?since= works for clients that cannot set headers
  const q = openStream(h.base, {}, `/v1/stream?since=${cur - 1}`); t.after(() => q.close());
  await q.waitFor((e) => e.event === 'change');
});

test('SSE heartbeat comments keep the connection alive', async (t) => {
  const h = await startTest({ sseHeartbeatMs: 50 }); t.after(h.stop);
  const s = openStream(h.base); t.after(() => s.close());
  await s.waitFor((e) => e.comment === 'hb', 2000);
});
