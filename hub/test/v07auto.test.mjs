// v0.7 (T-41): Up next auto mode — the setting, the start rule, backoff, rebuild, migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, tmpDir } from './helpers.mjs';
import { loadConfig } from '../config.mjs';
import { createLogger } from '../log.mjs';
import { Hub } from '../hub.mjs';

const MIN = 60_000;
async function setup(h, { live = true, tasks = 3 } = {}) {
  const clock = { t: Date.now() };
  h.hub.setClock(() => clock.t);
  if (live) h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'm' }, clock.t));
  const pid = h.state().projects[0]?.id ?? (await h.api('POST', '/v1/projects', { name: 'P' })).json.project.id;
  const ids = [];
  for (let i = 1; i <= tasks; i++) {
    ids.push((await h.api('POST', '/v1/tasks', { projectId: pid, title: `Task ${i}`, description: `Do ${i}`, status: 'next' })).json.task.id);
    clock.t += 5;
  }
  return { pid, ids, clock };
}
const task = (h, id) => h.state().tasks.find((x) => x.id === id);
const setAuto = (h, pid, on) => h.api('PATCH', `/v1/projects/${pid}`, { autoStart: on });
const autoEvents = (h) => h.hub.db.all("SELECT data FROM events WHERE type = 'hub.task.autostart' ORDER BY id").map((r) => JSON.parse(r.data));

test('autoStart defaults off, PATCH validates and is exposed on every read path', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid } = await setup(h, { tasks: 0 });
  assert.equal(h.state().projects[0].autoStart, false);
  assert.equal((await h.get(`/v1/projects/${pid}`)).json.project.autoStart, false);
  assert.equal((await h.api('PATCH', `/v1/projects/${pid}`, { autoStart: 'yes' })).status, 400);
  const on = await setAuto(h, pid, true);
  assert.equal(on.status, 200);
  assert.equal(on.json.project.autoStart, true);
  assert.deepEqual(on.json.autoStarted, []);
  assert.equal((await h.get(`/v1/projects/${pid}`)).json.project.autoStart, true);
  assert.equal((await h.get('/v1/projects')).json.projects[0].autoStart, true);
  assert.equal((await h.get(`/v1/state?projectId=${pid}`)).json.projects[0].autoStart, true);
  assert.equal((await h.get('/v1/projects/nope')).status, 404);
});

test('auto on with nothing in progress starts the top task right away (and says so)', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, ids } = await setup(h);
  // make the second task the top by order
  await h.api('PATCH', `/v1/tasks/${ids[1]}`, { order: -5 });
  const on = await setAuto(h, pid, true);
  assert.deepEqual(on.json.autoStarted, [ids[1]]);
  const t2 = task(h, ids[1]);
  assert.ok(t2.startNoteId);
  assert.ok(t2.autoStartedAt);
  assert.equal(task(h, ids[0]).startNoteId, null);
  const note = h.state().notes.find((n) => n.id === t2.startNoteId);
  assert.equal(note.state, 'queued');
  assert.match(note.text, /Start Helm task T-2/);
  const ev = autoEvents(h);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].taskId, ids[1]);
  assert.ok(ev[0].reason);
  const detail = (await h.get(`/v1/tasks/${ids[1]}`)).json;
  assert.ok(detail.activity.some((a) => /Auto-started/.test(a.summary)));
});

test('with a task in progress nothing starts until it reaches review or done, then the next one does', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, ids } = await setup(h);
  await h.api('PATCH', `/v1/tasks/${ids[0]}`, { status: 'in_progress' });
  const on = await setAuto(h, pid, true);
  assert.deepEqual(on.json.autoStarted, []);
  assert.equal(task(h, ids[1]).startNoteId, null);
  await h.api('PATCH', `/v1/tasks/${ids[0]}`, { status: 'review' });
  assert.ok(task(h, ids[1]).startNoteId, 'review counts as not in progress');
  // the started one moves to in_progress -> the third must wait; done frees it
  await h.api('PATCH', `/v1/tasks/${ids[1]}`, { status: 'in_progress' });
  assert.equal(task(h, ids[2]).startNoteId, null);
  await h.api('PATCH', `/v1/tasks/${ids[1]}`, { status: 'done' });
  assert.ok(task(h, ids[2]).startNoteId);
  assert.equal(autoEvents(h).length, 2);
});

test('a real agent completion (review) frees the slot', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, ids, clock } = await setup(h, { tasks: 2 });
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'u1', subagentType: 'helm:builder', model: 'sonnet', description: `[helm:${ids[0]}] go`, prompt: '' }, clock.t));
  assert.equal(task(h, ids[0]).status, 'in_progress');
  await setAuto(h, pid, true);
  assert.equal(task(h, ids[1]).startNoteId, null);
  const agent = h.state().agents[0];
  h.send(h.ev('s1', 'agent.completed', { agentId: agent.id, ok: true, summary: 'done' }, clock.t + 10));
  assert.equal(task(h, ids[0]).status, 'review');
  assert.ok(task(h, ids[1]).startNoteId);
});

test('no double-start while the start note is queued or sending, or delivered less than 3 minutes ago', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, ids, clock } = await setup(h);
  await setAuto(h, pid, true);
  const nid = task(h, ids[0]).startNoteId;
  assert.ok(nid);
  // queued: sweeps and unrelated commands start nothing
  h.hub.sweep(clock.t + 1000);
  await h.api('PATCH', `/v1/tasks/${ids[2]}`, { title: 'renamed' });
  assert.equal(autoEvents(h).length, 1);
  // the mod claims it -> sending
  const claim = await h.get('/v1/sessions/s1/inbox');
  assert.equal(claim.json.notes.length, 1);
  assert.equal(h.state().notes.find((n) => n.id === nid).state, 'sending');
  h.hub.sweep(clock.t + 2000);
  assert.equal(autoEvents(h).length, 1);
  // delivered, but the agent has not come up yet: still "starting" for 3 minutes
  h.send(h.ev('s1', 'note.result', { noteId: nid, ok: true, via: 'prompt' }, clock.t));
  h.hub.sweep(clock.t + MIN);
  assert.equal(autoEvents(h).length, 1);
  // delivered but not answered yet (the session is still busy with an earlier turn): still starting
  clock.t += 4 * MIN;
  h.hub.sweep(clock.t);
  assert.equal(autoEvents(h).length, 1, 'no re-start while the delivered start note has no reply');
  // the session answered but no agent came up: now it may try again
  h.send(h.ev('s1', 'note.reply', { noteId: nid, text: 'ok' }, clock.t));
  clock.t += 1000;
  h.hub.sweep(clock.t);
  assert.equal(autoEvents(h).length, 2, 'after the reply with no agent it moves on');
});

test('a delivered start note with no reply stops counting as starting after 30 minutes', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, ids, clock } = await setup(h);
  await setAuto(h, pid, true);
  const nid = task(h, ids[0]).startNoteId;
  await h.get('/v1/sessions/s1/inbox');
  h.send(h.ev('s1', 'note.result', { noteId: nid, ok: true, via: 'prompt' }, clock.t));
  clock.t += 29 * MIN;
  h.hub.sweep(clock.t);
  assert.equal(autoEvents(h).length, 1);
  clock.t += 2 * MIN;
  h.hub.sweep(clock.t);
  assert.equal(autoEvents(h).length, 2);
});

test('no live session: nothing starts; it starts once a session appears', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, ids, clock } = await setup(h, { live: false });
  const on = await setAuto(h, pid, true);
  assert.deepEqual(on.json.autoStarted, []);
  h.hub.sweep(clock.t + MIN);
  assert.equal(autoEvents(h).length, 0);
  assert.equal(task(h, ids[0]).startNoteId, null);
  h.send(h.ev('s9', 'session.started', { cwd: '/w/p', title: 'Late', model: 'm' }, clock.t + 2 * MIN));
  // the session may land in another project (cwd mapping); join it to ours first if so
  const s = h.state().sessions.find((x) => x.id === 's9');
  if (s.projectId !== pid) await h.api('POST', '/v1/sessions/s9/join', { projectId: pid });
  assert.ok(task(h, ids[0]).startNoteId);
  assert.equal(autoEvents(h).length, 1);
});

test('a failed auto-start backs off for 5 minutes, then retries the same task', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, ids, clock } = await setup(h);
  await setAuto(h, pid, true);
  const nid = task(h, ids[0]).startNoteId;
  await h.get('/v1/sessions/s1/inbox');
  clock.t += 1000;
  h.send(h.ev('s1', 'note.result', { noteId: nid, ok: false, via: 'prompt', error: 'session busy' }, clock.t));
  assert.equal(h.state().notes.find((n) => n.id === nid).state, 'failed');
  assert.equal(autoEvents(h).length, 1);
  clock.t += 4 * MIN;
  h.hub.sweep(clock.t);
  assert.equal(autoEvents(h).length, 1, 'still backing off');
  assert.equal(task(h, ids[1]).startNoteId, null, 'does not skip to the next task');
  clock.t += 2 * MIN;
  h.hub.sweep(clock.t);
  const ev = autoEvents(h);
  assert.equal(ev.length, 2);
  assert.equal(ev[1].taskId, ids[0]);
  assert.notEqual(task(h, ids[0]).startNoteId, nid);
});

test('manual mode never starts anything', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, ids, clock } = await setup(h);
  h.hub.sweep(clock.t + 10 * MIN);
  await h.api('PATCH', `/v1/tasks/${ids[0]}`, { status: 'done' });
  assert.equal(autoEvents(h).length, 0);
  await setAuto(h, pid, true);
  const started = autoEvents(h).length;
  assert.equal(started, 1);
  await setAuto(h, pid, false);
  await h.api('PATCH', `/v1/tasks/${ids[1]}`, { status: 'done' });
  h.hub.sweep(clock.t + 20 * MIN);
  assert.equal(autoEvents(h).length, started);
  assert.ok(h.state().tasks.filter((x) => x.status === 'next').every((x) => x.startNoteId === null || x.id === autoEvents(h)[0].taskId));
});

test('only the project that opted in auto-starts', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, ids } = await setup(h);
  const other = (await h.api('POST', '/v1/projects', { name: 'Other' })).json.project.id;
  const ot = (await h.api('POST', '/v1/tasks', { projectId: other, title: 'Elsewhere', status: 'next' })).json.task.id;
  await setAuto(h, pid, true);
  assert.ok(task(h, ids[0]).startNoteId);
  assert.equal(task(h, ot).startNoteId, null);
});

test('rebuild reproduces auto-started tasks, notes and the setting exactly (and emits nothing)', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { pid, ids, clock } = await setup(h);
  await setAuto(h, pid, true);
  await h.api('PATCH', `/v1/tasks/${ids[0]}`, { status: 'in_progress' });
  await h.api('PATCH', `/v1/tasks/${ids[0]}`, { status: 'done' });
  const eventsBefore = h.hub.db.get('SELECT COUNT(*) AS c FROM events').c;
  const before = h.hub.dump(), st = h.state();
  h.hub.rebuild();
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS c FROM events').c, eventsBefore);
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...st, seq: 0 });
  assert.equal(h.state().projects[0].autoStart, true);
  assert.ok(h.state().tasks.filter((x) => x.autoStartedAt).length >= 2);
  void clock;
});

test('a database from before v0.7 gains projects.auto_start / tasks.auto_started_at; idempotent; rebuild back-fills', async (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig({ home: dir, port: 0, singleton: false, sweep: false });
  const log = createLogger(path.join(dir, 'x.log'), { tty: false });
  let hub = new Hub(cfg, log);
  const T = Date.now();
  hub.ingest([{ sessionId: 's1', seq: 1, type: 'session.started', at: T, data: { cwd: '/w/p', title: 'S', model: 'm' } }]);
  const pid = hub.state().projects[0].id;
  const tk = hub.createTask({ projectId: pid, title: 'Go', status: 'next' }).task;
  hub.updateProject(pid, { autoStart: true });
  assert.ok(hub.state().tasks.find((x) => x.id === tk.id).autoStartedAt);
  hub.close();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(cfg.dbFile);
  raw.exec('ALTER TABLE projects DROP COLUMN auto_start');
  raw.exec('ALTER TABLE tasks DROP COLUMN auto_started_at');
  raw.close();
  for (let i = 0; i < 2; i++) {
    hub = new Hub(cfg, log);
    assert.equal(hub.state().projects[0].autoStart, false);
    assert.equal(hub.state().tasks[0].autoStartedAt, null);
    if (i === 0) hub.close();
  }
  hub.rebuild();
  assert.equal(hub.state().projects[0].autoStart, true);
  assert.ok(hub.state().tasks.find((x) => x.id === tk.id).autoStartedAt);
  hub.close();
});
