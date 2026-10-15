import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, tmpDir, sleep, sockRequest } from './helpers.mjs';
import { cleanAppTitle } from '../apptitles.mjs';

// v0.27: app session titles, PATCH archived checks, join/keep rule.

const put = (root, name, j, sub = 'a/b') => {
  fs.mkdirSync(path.join(root, sub), { recursive: true });
  fs.writeFileSync(path.join(root, sub, `local_${name}.json`), JSON.stringify(j));
};
const start = (h, sid, cwd) => h.send(h.ev(sid, 'session.started', { cwd, title: sid }));
const appTitles = (h, id) => { const s = h.state().sessions.find((x) => x.id === id); return [s.appTitle, s.appSessionId]; };

test('cleanAppTitle strips control characters and caps at 200', () => {
  assert.equal(cleanAppTitle('a\u0000b\nc‮d\u0007 '), 'a b c d');
  assert.equal(cleanAppTitle('x'.repeat(500)).length, 200);
  assert.equal(cleanAppTitle(42), '');
});

test('app titles: scan records a change once, keeps title, ignores unknown sessions and other fields, replays exactly', async (t) => {
  const root = tmpDir('helm-app-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = await startTest({ appSessionsDir: root }); t.after(h.stop);
  start(h, 's1', '/w/a'); start(h, 's2', '/w/b');
  assert.deepEqual(appTitles(h, 's1'), [null, null]);
  put(root, 'u1', { sessionId: 'local_u1', cliSessionId: 's1', cwd: '/w/a', title: 'Fix the\nlogin  bug\u0000', createdAt: 1, secret: 'nope' });
  put(root, 'u9', { sessionId: 'local_u9', cliSessionId: 'unknown', title: 'ghost' }, 'c/d');
  put(root, 'bad', {}, 'e/f');
  fs.writeFileSync(path.join(root, 'a/b/local_broken.json'), '{nope');
  const before = h.hub.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'hub.session.title'`).n;
  assert.equal(h.hub.appTitles.scan(), 1);
  assert.deepEqual(appTitles(h, 's1'), ['Fix the login bug', 'local_u1']);
  assert.equal(h.state().sessions[0].title, 's1', 'title is untouched');
  assert.equal(h.hub.appTitles.scan(), 0, 'no change, no event');
  assert.equal(h.hub.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'hub.session.title'`).n, before + 1);
  put(root, 'u1', { sessionId: 'local_u1', cliSessionId: 's1', title: 'x'.repeat(300) });
  assert.equal(h.hub.appTitles.scan(), 1);
  assert.equal(appTitles(h, 's1')[0].length, 200);
  const dump = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), dump);
});

test('app titles: the watcher picks up a new file and a rename, pushes the session over SSE; a missing directory is fine', async (t) => {
  const root = tmpDir('helm-app-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = await startTest({ appSessionsDir: root, appTitleDebounceMs: 20, appTitleRescanMs: 100 }); t.after(h.stop);
  start(h, 's1', '/w/a');
  put(root, 'u1', { sessionId: 'local_u1', cliSessionId: 's1', title: 'First' });
  for (let i = 0; i < 40 && appTitles(h, 's1')[0] !== 'First'; i++) await sleep(50);
  assert.equal(appTitles(h, 's1')[0], 'First');
  put(root, 'u1', { sessionId: 'local_u1', cliSessionId: 's1', title: 'Second' });
  for (let i = 0; i < 40 && appTitles(h, 's1')[0] !== 'Second'; i++) await sleep(50);
  assert.equal(appTitles(h, 's1')[0], 'Second');
  const row = h.hub.db.get(`SELECT row FROM changes WHERE entity = 'session' ORDER BY seq DESC LIMIT 1`);
  assert.equal(JSON.parse(row.row).appTitle, 'Second');
  const gone = await startTest({ appSessionsDir: path.join(root, 'missing') });
  assert.equal(gone.hub.appTitles.scan(), 0);
  await gone.stop();
});

test('PATCH /v1/projects/:id archived is human only and has the archive checks; other fields stay open', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a'); start(h, 's2', '/w/b'); start(h, 's3', '/w/c');
  await h.api('POST', '/v1/projects/P-3/coordinator', { on: true });
  h.send(h.ev('s2', 'session.ended', {}));
  assert.equal((await h.apiBare('PATCH', '/v1/projects/P-2', { archived: true }, {})).status, 403, 'no cookie');
  assert.equal((await sockRequest(h.cfg.sockFile, 'PATCH', '/v1/projects/P-2', { archived: true })).status, 403, 'socket');
  const live = await h.api('PATCH', '/v1/projects/P-1', { archived: true });
  assert.equal(live.status, 409); assert.match(live.json.error, /1 live session/);
  const coord = await h.api('PATCH', '/v1/projects/P-3', { archived: true });
  assert.equal(coord.status, 409); assert.match(coord.json.error, /coordinator/);
  assert.deepEqual(h.state().projects.map((p) => p.archived), [false, false, false]);
  assert.equal((await h.api('PATCH', '/v1/projects/P-2', { archived: true })).json.project.archived, true);
  assert.equal((await h.api('PATCH', '/v1/projects/P-2', { archived: false })).json.project.archived, false);
  assert.equal((await h.apiBare('PATCH', '/v1/projects/P-1', { name: 'Renamed' }, {})).status, 200, 'rename needs no cookie');
});

test('duplicates: recommendedKeep and the join rule — coordinator, then most open cards, then live, then newest', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const db = h.hub.db;
  for (const sid of ['o1', 'o2', 'o3']) { // legacy events: one project each in the same folder
    db.run('INSERT INTO events(session_id, seq, type, at, data) VALUES (?, 1, ?, ?, ?)', sid, 'session.started', 1000, JSON.stringify({ cwd: '/w/s' }));
  }
  h.hub.rebuild();
  for (const sid of ['o1', 'o2']) h.send({ sessionId: sid, seq: 2, type: 'session.ended', at: Date.now(), data: {} });
  for (let i = 0; i < 5; i++) await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: `a${i}` });
  await h.api('POST', '/v1/tasks', { projectId: 'P-3', title: 'b' });
  const g = (await h.get('/v1/projects/duplicates')).json.groups[0];
  assert.equal(g.recommendedKeep, 'P-1', 'most open cards, though P-3 is newer and live');
  assert.equal(g.suggestedTarget, 'P-1');
  start(h, 'n1', '/w/s');
  assert.equal(h.state().sessions.find((s) => s.id === 'n1').projectId, 'P-1', 'the next session joins the keep');
  await h.api('POST', '/v1/projects/P-2/coordinator', { on: true });
  assert.equal((await h.get('/v1/projects/duplicates')).json.groups[0].recommendedKeep, 'P-2', 'the coordinator beats cards');
  await h.api('POST', '/v1/projects/P-2/coordinator', { on: false });
  const done = await h.api('POST', '/v1/projects/P-2/archive');
  assert.equal(done.status, 200);
  await h.api('POST', '/v1/projects/P-2/unarchive');
  for (const t of h.state().tasks) await h.api('PATCH', `/v1/tasks/${t.id}`, { status: 'done' });
  assert.equal((await h.get('/v1/projects/duplicates')).json.groups[0].recommendedKeep, 'P-3', 'no open cards, both live: the newest');
  h.send({ sessionId: 'o3', seq: 2, type: 'session.ended', at: Date.now(), data: {} });
  assert.equal((await h.get('/v1/projects/duplicates')).json.groups[0].recommendedKeep, 'P-1', 'no open cards: the one with a live session');
});
