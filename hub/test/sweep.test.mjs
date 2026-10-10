import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest, waitUntil } from './helpers.mjs';

const MIN = 60_000;

async function setup(h, t0) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'S', model: 'opus' }, t0));
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu1', subagentType: 'b', model: 'sonnet', description: 'Long job', prompt: '' }, t0));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: 'ag1' }, t0));
}
const agent = (h) => h.state().agents.find((a) => a.id === 'ag1');
const task = (h) => h.state().tasks[0];

test('stall -> stalled (5 min) -> task blocked (10 min) -> recovers on tool.called', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const t0 = 1_700_000_000_000;
  await setup(h, t0);
  h.send(h.ev('s1', 'tool.called', { agentId: 'ag1', toolUseId: 'x', tool: 'Bash', summary: 'Bash: sleep' }, t0 + 1000));

  const early = h.hub.sweep(t0 + 4 * MIN); // only the 2-min idle rule can fire this early
  assert.deepEqual([early?.stalled ?? 0, early?.blocked ?? 0], [0, 0], 'no stall at 4 min');
  assert.equal(agent(h).status, 'running');

  const r1 = h.hub.sweep(t0 + 5 * MIN + 2000);
  assert.equal(r1.stalled, 1);
  assert.equal(agent(h).status, 'stalled');
  assert.equal(task(h).status, 'in_progress', 'not blocked until 10 min');

  const r2 = h.hub.sweep(t0 + 10 * MIN + 2000);
  assert.equal(r2.blocked, 1);
  assert.equal(task(h).status, 'blocked');
  assert.equal(task(h).blockedReason, 'no activity for 10 min');
  assert.equal(agent(h).status, 'stalled');
  assert.equal(h.hub.sweep(t0 + 11 * MIN), null, 'sweeping again is a no-op');

  h.send(h.ev('s1', 'tool.called', { agentId: 'ag1', toolUseId: 'y', tool: 'Read', summary: 'Read back' }, t0 + 12 * MIN));
  assert.equal(agent(h).status, 'running');
  assert.equal(task(h).status, 'in_progress');
  assert.equal(task(h).blockedReason, null);
});

test('a single sweep past 10 min stalls and blocks together; a failure-blocked task is not touched', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const t0 = 1_700_000_000_000;
  await setup(h, t0);
  const r = h.hub.sweep(t0 + 11 * MIN);
  assert.deepEqual([r.stalled, r.blocked], [1, 1]);
  assert.equal(task(h).blockedReason, 'no activity for 10 min');
  // manual block reason survives a recovery attempt: only the stall reason is auto-cleared
  await h.api('PATCH', '/v1/tasks/T-1', { status: 'blocked', blockedReason: 'waiting on design' });
  h.send(h.ev('s1', 'tool.called', { agentId: 'ag1', toolUseId: 'z', tool: 'Read', summary: 'r' }, t0 + 12 * MIN));
  assert.equal(agent(h).status, 'running');
  assert.equal(task(h).status, 'blocked');
  assert.equal(task(h).blockedReason, 'waiting on design');
});

test('session without a heartbeat for 2 min goes idle, heartbeat revives it', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const t0 = 1_700_000_000_000;
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }, t0));
  assert.equal(h.hub.sweep(t0 + 119_000), null);
  assert.equal(h.hub.sweep(t0 + 121_000).idle, 1);
  assert.equal(h.state().sessions[0].status, 'idle');
  h.send(h.ev('s1', 'session.heartbeat', {}, t0 + 125_000));
  assert.equal(h.state().sessions[0].status, 'active');
  // activity from an idle session also wakes it
  h.hub.sweep(t0 + 125_000 + 121_000);
  assert.equal(h.state().sessions[0].status, 'idle');
  h.send(h.ev('s1', 'tool.called', { tool: 'Read', toolUseId: 'u', summary: 'r' }, t0 + 260_000));
  assert.equal(h.state().sessions[0].status, 'active');
});

test('ended sessions and finished agents are never swept', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const t0 = 1_700_000_000_000;
  await setup(h, t0);
  h.send(h.ev('s1', 'agent.completed', { agentId: 'ag1', ok: true, summary: 'ok' }, t0 + 1000));
  h.send(h.ev('s1', 'session.ended', { reason: 'x' }, t0 + 2000));
  assert.equal(h.hub.sweep(t0 + 60 * MIN), null);
  assert.equal(agent(h).status, 'done');
  assert.equal(h.state().sessions[0].status, 'ended');
});

test('timings are injectable and the sweep timer runs on its own', async (t) => {
  const h = await startTest({ stallMs: 150, blockMs: 300, idleMs: 200, sweepMs: 40, sweep: true });
  t.after(h.stop);
  const now = Date.now();
  await setup(h, now);
  await waitUntil(() => agent(h).status === 'stalled', 3000);
  await waitUntil(() => task(h).status === 'blocked', 3000);
  await waitUntil(() => h.state().sessions[0].status === 'idle', 3000);
  assert.equal(task(h).blockedReason, 'no activity for 10 min');
  h.send(h.ev('s1', 'tool.called', { agentId: 'ag1', toolUseId: 'q', tool: 'Read', summary: 'r' }));
  assert.equal(agent(h).status, 'running');
});

// ---------------------------------------------------------------- notes stuck in `sending`
const SENDING_MS = 1000;
const TIMEOUT_ERR = 'delivery unconfirmed — retry';
const note = (h, id = 'N-1') => h.state().notes.find((n) => n.id === id);

/** One note claimed by the mod (queued -> sending); returns the claim time. */
async function sendingNote(h) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }));
  await h.api('POST', '/v1/notes', { target: { kind: 'session', id: 's1' }, text: 'Please rerun the tests' });
  await h.api('POST', '/v1/notes/execute', { target: { kind: 'session', id: 's1' } });
  const claimedAt = Date.now();
  assert.equal((await h.get('/v1/sessions/s1/inbox')).json.notes.length, 1);
  assert.equal(note(h).state, 'sending');
  return claimedAt;
}

test('a note stuck in sending fails after HELM_SENDING_MS, shows up on SSE, and can be retried', async (t) => {
  const h = await startTest({ sendingMs: SENDING_MS }); t.after(h.stop);
  const claimedAt = await sendingNote(h);
  assert.equal(h.hub.cfg.sendingMs, SENDING_MS);

  assert.equal(h.hub.sweep(claimedAt + SENDING_MS - 400), null, 'not yet: claim is younger than the timeout');
  assert.equal(note(h).state, 'sending');

  const seq0 = h.hub.seqNow();
  const r = h.hub.sweep(claimedAt + SENDING_MS + 2000);
  assert.equal(r.timedOut, 1);
  const n = note(h);
  assert.deepEqual([n.state, n.error, n.ranAt, n.via], ['failed', TIMEOUT_ERR, null, null]);
  assert.equal(h.hub.sweep(claimedAt + SENDING_MS + 2500)?.timedOut ?? 0, 0, 'already failed notes are not timed out again');

  // emitted as a change (what SSE and the UI consume)
  const changes = h.hub.changesSince(seq0).rows.filter((c) => c.entity === 'note');
  assert.equal(changes.length, 1);
  assert.equal(JSON.parse(changes[0].row).state, 'failed');
  assert.equal(JSON.parse(changes[0].row).error, TIMEOUT_ERR);

  // recorded as a hub.* event
  const ev = h.hub.db.all(`SELECT * FROM events WHERE type = 'hub.sweep'`).map((e) => JSON.parse(e.data));
  assert.deepEqual(ev.at(-1).sending, ['N-1']);

  // the existing Retry endpoint works on it, and a fresh claim restarts the clock
  const retry = await h.api('POST', '/v1/notes/N-1/retry');
  assert.equal(retry.status, 200);
  assert.equal(retry.json.note.state, 'queued');
  assert.equal(retry.json.note.error, null);
  assert.equal((await h.get('/v1/sessions/s1/inbox')).json.notes.length, 1);
  assert.equal(note(h).state, 'sending');
});

test('a late note.result overrides the sending timeout (ran or failed wins)', async (t) => {
  const h = await startTest({ sendingMs: SENDING_MS }); t.after(h.stop);
  const claimedAt = await sendingNote(h);
  h.hub.sweep(claimedAt + 5000);
  assert.equal(note(h).error, TIMEOUT_ERR);

  h.send(h.ev('s1', 'note.result', { noteId: 'N-1', ok: true, via: 'prompt' }, claimedAt + 6000));
  let n = note(h);
  assert.deepEqual([n.state, n.error, n.via, n.ranAt], ['ran', null, 'prompt', claimedAt + 6000]);
  h.send(h.ev('s1', 'note.result', { noteId: 'N-1', ok: false, error: 'dup' }, claimedAt + 7000));
  assert.equal(note(h).state, 'ran', 'a real result is still sticky');

  // a late failure replaces the generic timeout error with the real one
  await h.api('POST', '/v1/notes', { target: { kind: 'session', id: 's1' }, text: 'second' });
  await h.api('POST', '/v1/notes/execute', { target: { kind: 'session', id: 's1' } });
  const c2 = Date.now();
  await h.get('/v1/sessions/s1/inbox');
  h.hub.sweep(c2 + 5000);
  assert.equal(note(h, 'N-2').error, TIMEOUT_ERR);
  h.send(h.ev('s1', 'note.result', { noteId: 'N-2', ok: false, via: 'send_message', error: 'agent not reachable' }, c2 + 6000));
  n = note(h, 'N-2');
  assert.deepEqual([n.state, n.error, n.via], ['failed', 'agent not reachable', 'send_message']);
  h.send(h.ev('s1', 'note.result', { noteId: 'N-2', ok: true }, c2 + 7000));
  assert.equal(note(h, 'N-2').state, 'failed', 'a real failure is final');
});

test('rebuild reproduces timed-out and late-resolved notes', async (t) => {
  const h = await startTest({ sendingMs: SENDING_MS }); t.after(h.stop);
  const claimedAt = await sendingNote(h);
  await h.api('POST', '/v1/notes', { target: { kind: 'session', id: 's1' }, text: 'other' });
  await h.api('POST', '/v1/notes/execute', { target: { kind: 'session', id: 's1' } });
  await h.get('/v1/sessions/s1/inbox');
  h.hub.sweep(claimedAt + 5000);
  assert.deepEqual(h.state().notes.map((n) => [n.state, n.error]), [['failed', TIMEOUT_ERR], ['failed', TIMEOUT_ERR]]);
  h.send(h.ev('s1', 'note.result', { noteId: 'N-1', ok: true, via: 'prompt' }, claimedAt + 6000));

  const before = h.hub.dump();
  const stateBefore = h.state();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before, 'projection tables identical, including sending_at');
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
  assert.equal(note(h, 'N-1').state, 'ran');
  assert.equal(note(h, 'N-2').error, TIMEOUT_ERR);
});

test('opening a database from before sending_at adds the column; legacy sending rows time out via queued_at', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Db } = await import('../db.mjs');
  const { tmpDir } = await import('./helpers.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, queued_at INTEGER, ran_at INTEGER, via TEXT, error TEXT)`);
  old.exec(`INSERT INTO notes VALUES ('N-1','session','s1','s1','x','sending',1,2,NULL,NULL,NULL)`);
  old.close();
  for (let i = 0; i < 2; i++) { // second open proves the migration is idempotent
    const db = new Db(file);
    assert.ok(db.all('PRAGMA table_info(notes)').some((c) => c.name === 'sending_at'));
    assert.equal(db.get('SELECT state, sending_at FROM notes').state, 'sending');
    db.close();
  }
});
