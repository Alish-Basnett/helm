import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, tmpDir } from './helpers.mjs';
import { seed } from '../seed.mjs';

async function world(h) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'opus' }));
}
const note = (h, id) => h.state().notes.find((n) => n.id === id);
const task = (h, id) => h.state().tasks.find((n) => n.id === id);
const S1 = { kind: 'session', id: 's1' };

test('note.reply sets, replaces, adds activity, pushes an upsert and is searchable', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  await h.api('POST', '/v1/notes', { target: S1, text: 'Check the cache layer' });
  assert.deepEqual([note(h, 'N-1').reply, note(h, 'N-1').repliedAt], [null, null]);
  h.send(h.ev('s1', 'note.reply', { noteId: 'N-1', text: 'Memoization wins here' }, 5000));
  assert.deepEqual([note(h, 'N-1').reply, note(h, 'N-1').repliedAt], ['Memoization wins here', 5000]);
  h.send(h.ev('s1', 'note.reply', { noteId: 'N-1', text: 'Actually a quokka fixes it' }, 6000));
  assert.deepEqual([note(h, 'N-1').reply, note(h, 'N-1').repliedAt], ['Actually a quokka fixes it', 6000]);
  assert.equal(h.hub.db.all("SELECT * FROM activity WHERE kind = 'note' AND summary LIKE 'Reply to N-1%'").length, 2);
  const hits = (await h.get('/v1/search?q=quokka')).json.results;
  assert.ok(hits.some((r) => r.kind === 'note' && r.id === 'N-1'));
  assert.ok(!(await h.get('/v1/search?q=memoization')).json.results.some((r) => r.kind === 'note'), 'old reply no longer indexed');
  assert.ok((await h.get('/v1/search?q=cache')).json.results.some((r) => r.kind === 'note'), 'note text still indexed');
  // unknown note and empty text are ignored
  h.send(h.ev('s1', 'note.reply', { noteId: 'N-99', text: 'x' }), h.ev('s1', 'note.reply', { noteId: 'N-1', text: '  ' }));
  assert.equal(note(h, 'N-1').reply, 'Actually a quokka fixes it');
  const long = 'z'.repeat(9000);
  h.send(h.ev('s1', 'note.reply', { noteId: 'N-1', text: long }));
  assert.equal(note(h, 'N-1').reply.length, 8000);
});

test('start: queued session note with the exact text, task -> next, startNoteId, 409s', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  const p = (await h.api('POST', '/v1/projects', { name: 'X' })).json.project;
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'opus' }));
  const pid = h.state().sessions[0].projectId;
  const t1 = (await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Ship it', description: 'Do the thing.' })).json.task;
  const r = await h.api('POST', `/v1/tasks/${t1.id}/start`);
  assert.equal(r.status, 200);
  assert.equal(r.json.note.state, 'queued');
  assert.deepEqual(r.json.note.target, S1);
  assert.equal(r.json.note.sessionId, 's1');
  assert.equal(r.json.note.text,
    'Start Helm task T-1 “Ship it”.\n\nBrief:\nDo the thing.\n\n'
    + 'Create nothing new: delegate this existing task now with the Agent tool (description starting with [helm:T-1]), '
    + 'choosing helm:builder for code changes or helm:scout for read-only work, run it in the background, '
    + 'then reply in one line with what you started.');
  assert.equal(r.json.task.status, 'next');
  assert.equal(r.json.task.startNoteId, r.json.note.id);
  assert.equal(task(h, 'T-1').startNoteId, r.json.note.id);
  // the mod receives it through the normal inbox
  assert.equal((await h.get('/v1/sessions/s1/inbox')).json.notes[0].id, r.json.note.id);
  // restart from next is allowed and replaces startNoteId
  const r2 = await h.api('POST', '/v1/tasks/T-1/start');
  assert.equal(r2.status, 200);
  assert.notEqual(r2.json.task.startNoteId, r.json.note.id);
  // blocked / later are allowed; in_progress, review, done, archived are not
  for (const [st, code] of [['blocked', 200], ['later', 200], ['in_progress', 409], ['review', 409], ['done', 409], ['archived', 409]]) {
    await h.api('PATCH', '/v1/tasks/T-1', { status: st });
    assert.equal((await h.api('POST', '/v1/tasks/T-1/start')).status, code, st);
  }
  assert.equal((await h.api('POST', '/v1/tasks/T-99/start')).status, 404);
  // no live session -> the Start is held for the project (see v0.27.1 tests), not refused
  await h.api('PATCH', '/v1/tasks/T-1', { status: 'backlog' });
  const before = h.state().notes.length;
  h.send(h.ev('s1', 'session.ended', { reason: 'x' }));
  const none = await h.api('POST', '/v1/tasks/T-1/start');
  assert.equal(none.status, 200);
  assert.equal(none.json.note.state, 'queued');
  assert.equal(none.json.note.sessionId, '');
  assert.equal(h.state().notes.length, before + 1);
  assert.equal(task(h, 'T-1').status, 'next');
  void p;
});

test('start picks the session by the job rule: task session, else project newest live', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('a', 'session.started', { cwd: '/w/p', title: 'A', model: 'opus' }));
  h.send(h.ev('b', 'session.started', { cwd: '/w/p', title: 'B', model: 'opus' }));
  const pid = h.state().sessions[0].projectId;
  await h.api('POST', `/v1/sessions/b/join`, { projectId: pid });
  const t1 = (await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Pinned', sessionId: 'a' })).json.task;
  assert.equal((await h.api('POST', `/v1/tasks/${t1.id}/start`)).json.note.sessionId, 'a');
  h.send(h.ev('a', 'session.ended', { reason: 'x' }));
  assert.equal((await h.api('POST', `/v1/tasks/${t1.id}/start`)).json.note.sessionId, 'b');
});

test('create with start: one call creates + starts; queues the start when there is no live session', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  const pid = h.state().sessions[0].projectId;
  const r = await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Go now', description: 'Brief', start: true });
  assert.equal(r.status, 201);
  assert.equal(r.json.task.status, 'next');
  assert.equal(r.json.task.startNoteId, r.json.note.id);
  assert.equal(r.json.note.state, 'queued');
  assert.match(r.json.note.text, /^Start Helm task T-1 “Go now”\./);
  assert.equal(r.json.error, undefined);
  // a plain create has no note
  const plain = await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Plain' });
  assert.equal(plain.json.note, undefined);
  assert.equal(plain.json.task.startNoteId, null);
  // disallowed status: task created, error reported
  const bad = await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Done already', status: 'done', start: true });
  assert.equal(bad.status, 201);
  assert.ok(bad.json.error);
  // no live session
  h.send(h.ev('s1', 'session.ended', { reason: 'x' }));
  const notes = h.state().notes.length;
  const none = await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Orphan', start: true });
  assert.equal(none.status, 201);
  assert.equal(none.json.error, undefined);
  assert.equal(none.json.note.state, 'queued');
  assert.deepEqual(none.json.note.target, { kind: 'project', id: pid });
  assert.equal(none.json.task.status, 'next');
  assert.equal(h.state().notes.length, notes + 1);
  assert.ok(task(h, none.json.task.id));
});

test('notes with execute: created and queued in one call; 409 creates nothing', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await world(h);
  const c = await h.api('POST', '/v1/notes', { target: S1, text: 'Talk to me', execute: true });
  assert.equal(c.status, 201);
  assert.equal(c.json.note.state, 'queued');
  assert.ok(c.json.note.queuedAt);
  assert.equal((await h.get('/v1/sessions/s1/inbox')).json.notes.length, 1);
  const d = await h.api('POST', '/v1/notes', { target: S1, text: 'Just a draft' });
  assert.equal(d.json.note.state, 'draft');
  const tk = (await h.api('POST', '/v1/tasks', { projectId: h.state().sessions[0].projectId, title: 'T' })).json.task;
  h.send(h.ev('s1', 'session.ended', { reason: 'x' }));
  const n = h.state().notes.length;
  const none = await h.api('POST', '/v1/notes', { target: { kind: 'task', id: tk.id }, text: 'x', execute: true });
  assert.equal(none.status, 409);
  assert.equal(h.state().notes.length, n, 'nothing created');
});

test('v0.3 rows rebuild deterministically from events', async (t) => {
  const h = await startTest(); t.after(h.stop);
  seed(h.hub);
  const st = h.state();
  const started = st.tasks.find((x) => x.startNoteId);
  assert.ok(started, 'seed has a started task');
  const sn = st.notes.find((n) => n.id === started.startNoteId);
  assert.equal(sn.state, 'ran');
  assert.ok(sn.reply);
  assert.ok(st.notes.filter((n) => n.reply).length >= 3);
  assert.ok(st.notes.some((n) => n.target.kind === 'task' && n.reply), 'task note with a reply');
  assert.ok(st.notes.some((n) => n.target.kind === 'session' && n.reply && !n.text.startsWith('Start Helm')), 'session note with a reply');
  await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'Live start', start: true });
  await h.api('POST', '/v1/notes', { target: { kind: 'session', id: 'demo-meridian-auth' }, text: 'exec now', execute: true });
  h.send({ sessionId: 'demo-meridian-auth', seq: 99999, type: 'note.reply', at: Date.now(), data: { noteId: 'N-1', text: 'replaced reply xylophone' } });
  const before = h.hub.dump();
  const stateBefore = h.state();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
  assert.ok(h.hub.search('xylophone').some((r) => r.kind === 'note'));
});

test('opening a pre-v0.3 database adds reply columns and start_note_id; idempotent', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Db } = await import('../db.mjs');
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, queued_at INTEGER, ran_at INTEGER, via TEXT, error TEXT, sending_at INTEGER)`);
  old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, agent_id TEXT, ord REAL NOT NULL DEFAULT 0, blocked_reason TEXT,
    depends_on TEXT NOT NULL DEFAULT '[]', files_changed TEXT NOT NULL DEFAULT '[]', tokens INTEGER NOT NULL DEFAULT 0,
    recap TEXT, recap_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER,
    conflicts TEXT NOT NULL DEFAULT '[]', explainer TEXT, explain_job TEXT)`);
  old.exec(`INSERT INTO notes VALUES ('N-1','session','s1','s1','x','ran',1,2,3,'prompt',NULL,NULL)`);
  old.exec(`INSERT INTO tasks(id, project_id, title, status, created_at, updated_at) VALUES ('T-1','P-1','t','next',1,1)`);
  old.close();
  for (let i = 0; i < 2; i++) {
    const db = new Db(file);
    const cols = (t2) => db.all(`PRAGMA table_info(${t2})`).map((c) => c.name);
    assert.ok(cols('notes').includes('reply') && cols('notes').includes('replied_at'));
    assert.ok(cols('tasks').includes('start_note_id'));
    assert.equal(db.get('SELECT reply, replied_at FROM notes').reply, null);
    assert.equal(db.get('SELECT start_note_id FROM tasks').start_note_id, null);
    db.close();
  }
});
