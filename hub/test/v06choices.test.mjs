// v0.6 (T-21): Choices — task.choices, apply / reset, parent link, 409 capture, rebuild, migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, tmpDir } from './helpers.mjs';
import { loadConfig } from '../config.mjs';
import { createLogger } from '../log.mjs';
import { Hub } from '../hub.mjs';

const C = [
  { id: 'a', title: 'Screen A', detail: 'Do A', effort: 'S', value: 'high' },
  { id: 'b', title: 'Screen B', detail: 'Do B', effort: 'L', value: 'low' },
  { id: 'c', title: 'Screen C' },
];
async function setup(h, { live = true } = {}) {
  if (live) h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'm' }));
  const pid = h.state().projects[0]?.id ?? (await h.api('POST', '/v1/projects', { name: 'P' })).json.project.id;
  const t = (await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Plan it', sessionId: live ? 's1' : null })).json.task;
  h.send(h.ev('s1', 'task.choices', { taskId: t.id, choices: C }));
  return { pid, t };
}
const task = (h, id) => h.state().tasks.find((x) => x.id === id);

test('task.choices sets the set with defaults; replacing keeps state of surviving ids', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { t: pt } = await setup(h);
  let cs = task(h, pt.id).choices;
  assert.equal(cs.length, 3);
  assert.deepEqual(cs[2], { id: 'c', title: 'Screen C', detail: '', effort: null, value: null, state: 'open', taskId: null });
  assert.equal(task(h, pt.id).parentTaskId, null);
  await h.api('POST', `/v1/tasks/${pt.id}/choices/apply`, { picked: ['a'] });
  h.send(h.ev('s1', 'task.choices', { taskId: pt.id, choices: [{ id: 'a', title: 'Screen A v2' }, { id: 'd', title: 'New D' }, { title: 'No id' }] }));
  cs = task(h, pt.id).choices;
  assert.deepEqual(cs.map((c) => [c.id, c.state]), [['a', 'picked'], ['d', 'open'], ['c3', 'open']]);
  assert.equal(cs[0].title, 'Screen A v2');
  assert.ok(cs[0].taskId);
  h.send(h.ev('s1', 'task.choices', { taskId: 'T-999', choices: C })); // unknown task: ignored
});

test('apply creates linked tasks (backlog without start), marks picked and skipped; reset reopens', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { t: pt } = await setup(h);
  const r = await h.api('POST', `/v1/tasks/${pt.id}/choices/apply`, { picked: ['a', 'b'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.tasks.length, 2);
  assert.deepEqual(r.json.errors, []);
  const [ta, tb] = r.json.tasks;
  assert.equal(ta.title, 'Screen A');
  assert.equal(ta.parentTaskId, pt.id);
  assert.equal(ta.status, 'backlog');
  assert.equal(ta.projectId, pt.projectId);
  assert.match(ta.description, /Do A/);
  assert.match(ta.description, new RegExp(`From ${pt.id}\\.`));
  assert.deepEqual(r.json.choices.map((c) => [c.id, c.state, c.taskId]), [['a', 'picked', ta.id], ['b', 'picked', tb.id], ['c', 'skipped', null]]);
  assert.equal(task(h, ta.id).parentTaskId, pt.id);
  assert.equal(h.state().notes.length, 0);
  // already applied -> 400
  assert.equal((await h.api('POST', `/v1/tasks/${pt.id}/choices/apply`, { picked: ['a'] })).status, 400);
  assert.equal((await h.api('POST', `/v1/tasks/${pt.id}/choices/apply`, { picked: 'x' })).status, 400);
  assert.equal((await h.api('POST', '/v1/tasks/T-999/choices/apply', { picked: [] })).status, 404);
  const z = await h.api('POST', `/v1/tasks/${pt.id}/choices/reset`);
  assert.equal(z.status, 200);
  assert.deepEqual(z.json.choices.map((c) => [c.state, c.taskId]), [['open', null], ['open', null], ['open', null]]);
  assert.equal(h.state().tasks.filter((x) => x.parentTaskId === pt.id).length, 2); // created tasks stay
  assert.equal((await h.api('POST', '/v1/tasks/T-999/choices/reset')).status, 404);
});

test('apply with start queues a start note per task and moves them to next', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { t: pt } = await setup(h);
  const r = await h.api('POST', `/v1/tasks/${pt.id}/choices/apply`, { picked: ['a', 'c'], start: true });
  assert.deepEqual(r.json.errors, []);
  assert.deepEqual(r.json.tasks.map((x) => x.status), ['next', 'next']);
  const notes = h.state().notes.filter((n) => n.state === 'queued');
  assert.equal(notes.length, 2);
  assert.match(notes[0].text, /Start Helm task T-\d+ .Screen A./);
  assert.ok(r.json.tasks.every((x) => x.startNoteId));
});

test('a 409 on start is captured in errors; the task is still created and the batch succeeds', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { t: pt } = await setup(h, { live: false }); // no live session anywhere
  const r = await h.api('POST', `/v1/tasks/${pt.id}/choices/apply`, { picked: ['a', 'b'], start: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.tasks.length, 2);
  assert.equal(r.json.errors.length, 2);
  assert.equal(r.json.errors[0].status, 409);
  assert.equal(r.json.errors[0].choiceId, 'a');
  assert.deepEqual(r.json.tasks.map((x) => x.status), ['backlog', 'backlog']);
  assert.equal(r.json.choices.filter((c) => c.state === 'picked').length, 2);
});

test('rebuild reproduces choices, parent links and notes exactly', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { t: pt } = await setup(h);
  await h.api('POST', `/v1/tasks/${pt.id}/choices/apply`, { picked: ['a', 'b'], start: true });
  await h.api('POST', `/v1/tasks/${pt.id}/choices/reset`);
  await h.api('POST', `/v1/tasks/${pt.id}/choices/apply`, { picked: ['c'] });
  const before = h.hub.dump(), st = h.state();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...st, seq: 0 });
});

test('a database from before T-21 gains tasks.choices / parent_task_id; idempotent; rebuild back-fills', async (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig({ home: dir, port: 0, singleton: false, sweep: false });
  const log = createLogger(path.join(dir, 'x.log'), { tty: false });
  let hub = new Hub(cfg, log);
  const T = Date.now();
  hub.ingest([{ sessionId: 's1', seq: 1, type: 'session.started', at: T, data: { cwd: '/w/p', title: 'S', model: 'm' } }]);
  const pid = hub.state().projects[0].id;
  const tk = hub.createTask({ projectId: pid, title: 'Plan' }).task;
  hub.ingest([{ sessionId: 's1', seq: 2, type: 'task.choices', at: T + 1, data: { taskId: tk.id, choices: C } }]);
  hub.applyChoices(tk.id, { picked: ['a'] });
  hub.close();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(cfg.dbFile);
  raw.exec('ALTER TABLE tasks DROP COLUMN choices');
  raw.exec('ALTER TABLE tasks DROP COLUMN parent_task_id');
  raw.close();
  for (let i = 0; i < 2; i++) {
    hub = new Hub(cfg, log);
    assert.ok(hub.state().tasks.every((x) => Array.isArray(x.choices) && x.choices.length === 0 && x.parentTaskId === null));
    if (i === 0) hub.close();
  }
  hub.rebuild();
  const s = hub.state();
  assert.equal(s.tasks.find((x) => x.id === tk.id).choices.length, 3);
  assert.equal(s.tasks.filter((x) => x.parentTaskId === tk.id).length, 1);
  hub.close();
});

test('seed includes a planning task with 6 open choices', async (t) => {
  const { seed } = await import('../seed.mjs');
  const h = await startTest(); t.after(h.stop);
  seed(h.hub, null);
  const plan = h.state().tasks.find((x) => x.choices.length);
  assert.equal(plan.choices.length, 6);
  assert.ok(plan.choices.every((c) => c.state === 'open'));
});

test('apply with notes and a message: description composition, stored note, start note, validation, rebuild', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { t: pt } = await setup(h);
  const bad = async (body) => (await h.api('POST', `/v1/tasks/${pt.id}/choices/apply`, { picked: ['a'], ...body })).status;
  assert.equal(await bad({ notes: { a: 'x'.repeat(501) } }), 400);
  assert.equal(await bad({ notes: 'no' }), 400);
  assert.equal(await bad({ notes: { a: 5 } }), 400);
  assert.equal(await bad({ message: 'm'.repeat(1001) }), 400);
  assert.equal(task(h, pt.id).choices.every((c) => c.state === 'open'), true); // rejected requests change nothing
  const r = await h.api('POST', `/v1/tasks/${pt.id}/choices/apply`, {
    picked: ['a', 'b', 'c'], start: true, notes: { a: ' use the blue one ', c: 'quick' }, message: 'Ship by Friday',
  });
  assert.equal(r.status, 200);
  const [ta, tb, tc] = r.json.tasks;
  assert.equal(ta.description, `Do A\n\nNote: use the blue one\n\nMessage: Ship by Friday\n\nFrom ${pt.id}.`);
  assert.equal(tb.description, `Do B\n\nMessage: Ship by Friday\n\nFrom ${pt.id}.`);
  assert.equal(tc.description, `Note: quick\n\nMessage: Ship by Friday\n\nFrom ${pt.id}.`);
  const cs = task(h, pt.id).choices;
  assert.deepEqual(cs.map((c) => c.note ?? null), ['use the blue one', null, 'quick']);
  assert.ok(cs.every((c) => c.message === 'Ship by Friday'));
  const queued = h.state().notes.filter((n) => n.state === 'queued');
  assert.ok(queued.some((n) => /Note: use the blue one/.test(n.text) && /Message: Ship by Friday/.test(n.text)));
  // mod re-emitting the set keeps notes; reset clears them
  h.send(h.ev('s1', 'task.choices', { taskId: pt.id, choices: C }));
  assert.equal(task(h, pt.id).choices[0].note, 'use the blue one');
  const before = h.hub.dump(), st = h.state();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...st, seq: 0 });
  await h.api('POST', `/v1/tasks/${pt.id}/choices/reset`);
  assert.ok(task(h, pt.id).choices.every((c) => !('note' in c) && !('message' in c)));
});
