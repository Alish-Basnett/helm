import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, sockRequest, tmpDir } from './helpers.mjs';
import { normaliseFolder, resolveFolder } from '../folder.mjs';

// v0.27: one project per folder, project archive and merge (CONTRACT "v0.27 additions").

const start = (h, sid, cwd, extra = {}) => h.send(h.ev(sid, 'session.started', { cwd, title: sid, model: 'opus', ...extra }));
const end = (h, sid) => h.send(h.ev(sid, 'session.ended', { reason: 'exit' }));
const projectOf = (h, sid) => h.state().sessions.find((s) => s.id === sid).projectId;
const folderOf = (h, id) => h.state().projects.find((p) => p.id === id).folder;
const sock = (h, method, p, body) => sockRequest(h.cfg.sockFile, method, p, body);

test('normaliseFolder: slashes and Claude worktrees', () => {
  assert.equal(normaliseFolder('/a/b/'), '/a/b');
  assert.equal(normaliseFolder('/a//b///'), '/a/b');
  assert.equal(normaliseFolder('/'), '/');
  assert.equal(normaliseFolder(''), '');
  assert.equal(normaliseFolder('/r/proj/.claude/worktrees/agent-1'), '/r/proj');
  assert.equal(normaliseFolder('/r/proj/.claude/worktrees/agent-1/packages/x/'), '/r/proj');
});

test('resolveFolder: symlinks resolve, an external git worktree stays its own folder, a missing folder keeps its path', () => {
  const root = fs.realpathSync(tmpDir('helm-f-'));
  try {
    const main = path.join(root, 'main'), wt = path.join(root, 'wt'), link = path.join(root, 'link');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${main}/.git/worktrees/wt\n`);
    fs.symlinkSync(main, link);
    assert.equal(resolveFolder(link), main);
    assert.equal(resolveFolder(main + '/'), main);
    assert.equal(resolveFolder(wt), wt, 'an external git worktree is its own folder');
    assert.equal(resolveFolder(path.join(root, 'nope') + '/'), path.join(root, 'nope'));
    assert.equal(resolveFolder(''), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session joins the project of its folder; another folder gets its own', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/alpha');
  start(h, 's2', '/w/alpha/');
  start(h, 's3', '/w/beta');
  start(h, 's4', '/w/alpha/.claude/worktrees/feature-x');
  const st = h.state();
  assert.equal(st.projects.length, 2);
  assert.deepEqual(['s1', 's2', 's3', 's4'].map((s) => projectOf(h, s)), ['P-1', 'P-1', 'P-2', 'P-1']);
  assert.deepEqual(st.projects.map((p) => [p.name, p.folder]), [['alpha', '/w/alpha'], ['beta', '/w/beta']]);
  start(h, 's5', '/w/alpha');
  assert.equal(h.state().projects.length, 2, 'a repeat in a known folder makes no project');
  start(h, 's1', '/w/gamma');
  assert.equal(projectOf(h, 's1'), 'P-1', 'a running session never moves on a second session.started');
});

test('the mod cannot choose the folder or the project: both are decided by the hub', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/alpha');
  start(h, 's2', '/w/beta', { folder: '/w/alpha', joinProjectId: 'P-1' });
  assert.equal(projectOf(h, 's2'), 'P-2');
  assert.equal(folderOf(h, 'P-2'), '/w/beta');
  const ev = h.hub.db.get(`SELECT data FROM events WHERE session_id = 's2'`);
  assert.deepEqual([JSON.parse(ev.data).folder, JSON.parse(ev.data).joinProjectId], ['/w/beta', null]);
});

test('an archived project is never joined; several in a folder: coordinator, else one with a live session, else the newest', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a'); end(h, 's1');
  assert.equal((await h.api('POST', '/v1/projects/P-1/archive')).status, 200);
  start(h, 's2', '/w/a');
  assert.equal(projectOf(h, 's2'), 'P-2', 'archived P-1 is skipped');
  assert.equal((await h.api('POST', '/v1/projects/P-1/unarchive')).status, 200);
  // P-1 (ended s1) and P-2 (live s2) share /w/a
  start(h, 's3', '/w/a');
  assert.equal(projectOf(h, 's3'), 'P-2', 'live beats newest-only');
  end(h, 's2'); end(h, 's3');
  start(h, 's4', '/w/a');
  assert.equal(projectOf(h, 's4'), 'P-2', 'none live: the newest');
  assert.equal((await h.api('POST', '/v1/sessions/s4/join', { projectId: 'P-1' })).status, 200);
  end(h, 's4');
  assert.equal((await h.api('POST', '/v1/sessions/s2/join', { projectId: 'P-2' })).status, 200);
  h.send(h.ev('s2', 'session.heartbeat', { tokens: 1 })); // s2 is live again in P-2 ...
  assert.equal((await h.api('POST', '/v1/projects/P-1/coordinator', { on: true })).status, 200);
  start(h, 's5', '/w/a');
  assert.equal(projectOf(h, 's5'), 'P-1', 'the coordinator project wins over a live one');
});

test('events recorded before v0.27 (no decision in them) still create a project each, and replay keeps them', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const db = h.hub.db;
  for (const sid of ['o1', 'o2']) {
    db.run('INSERT INTO events(session_id, seq, type, at, data) VALUES (?, 1, ?, ?, ?)', sid, 'session.started', 1000, JSON.stringify({ cwd: '/w/old/', title: sid }));
  }
  h.hub.rebuild();
  const st = h.state();
  assert.deepEqual(st.projects.map((p) => [p.id, p.folder]), [['P-1', '/w/old'], ['P-2', '/w/old']]);
  assert.deepEqual(h.state().sessions.map((s) => s.projectId), ['P-1', 'P-2']);
  const dup = (await h.get('/v1/projects/duplicates')).json;
  assert.equal(dup.groups.length, 1);
  assert.equal(dup.groups[0].folder, '/w/old');
  assert.equal(dup.groups[0].suggestedTarget, 'P-2');
  assert.deepEqual(dup.groups[0].projects.map((p) => [p.id, p.liveSessions, p.endedSessions, p.tasks, p.openTasks]), [['P-1', 1, 0, 0, 0], ['P-2', 1, 0, 0, 0]]);
});

test('the one-time migration gives existing projects the folder of their first session', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/alpha/'); start(h, 's2', '/w/beta');
  await h.api('POST', '/v1/projects', { name: 'Manual' });
  const raw = h.hub.db.raw;
  raw.exec('DROP INDEX projects_folder'); raw.exec('ALTER TABLE projects DROP COLUMN folder');
  h.hub.db.cache.clear();
  h.hub.db.migrate();
  assert.deepEqual(h.state().projects.map((p) => p.folder), ['/w/alpha', '/w/beta', null]);
});

test('archive: human only, refuses the coordinator and a live session, keeps everything inside', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a'); start(h, 's2', '/w/b'); start(h, 's3', '/w/c');
  await h.api('POST', '/v1/tasks', { projectId: 'P-2', title: 'keep me' });
  await h.api('POST', '/v1/projects/P-3/coordinator', { on: true });
  assert.equal((await h.apiBare('POST', '/v1/projects/P-1/archive', undefined, {})).status, 403, 'no cookie');
  assert.equal((await h.apiBare('POST', '/v1/projects/P-1/archive', undefined, { cookie: await h.dashCookie(), origin: 'https://evil.example' })).status, 403, 'foreign origin');
  assert.equal((await sock(h, 'POST', '/v1/projects/P-1/archive')).status, 403, 'socket');
  assert.equal((await sock(h, 'POST', '/v1/projects/P-1/unarchive')).status, 403, 'socket');
  assert.equal((await sock(h, 'POST', '/v1/projects/archive', { ids: ['P-1'] })).status, 403, 'socket bulk');
  assert.equal((await h.api('POST', '/v1/projects/P-9/archive')).status, 404);
  const live = await h.api('POST', '/v1/projects/P-1/archive');
  assert.equal(live.status, 409);
  assert.match(live.json.error, /1 live session/);
  const coord = await h.api('POST', '/v1/projects/P-3/archive');
  assert.equal(coord.status, 409);
  assert.match(coord.json.error, /coordinator/);
  end(h, 's2');
  const ok = await h.api('POST', '/v1/projects/P-2/archive');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.project.archived, true);
  assert.equal((await h.api('POST', '/v1/projects/P-2/archive')).status, 200, 'archiving twice is a no-op');
  const st = h.state();
  assert.equal(st.tasks.filter((x) => x.projectId === 'P-2').length, 1, 'cards are kept');
  assert.equal(st.sessions.find((x) => x.id === 's2').projectId, 'P-2');
  assert.equal((await h.api('POST', '/v1/projects/P-2/unarchive')).json.project.archived, false);
  assert.equal((await h.api('POST', '/v1/projects/P-2/unarchive')).status, 200);
  assert.equal((await h.api('POST', '/v1/projects/P-9/unarchive')).status, 404);
});

test('bulk archive lists what it refused and never fails the batch', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a'); start(h, 's2', '/w/b'); start(h, 's3', '/w/c'); end(h, 's2');
  await h.api('POST', '/v1/projects/P-3/coordinator', { on: true }); end(h, 's3');
  const r = await h.api('POST', '/v1/projects/archive', { ids: ['P-1', 'P-2', 'P-2', 'P-3', 'P-9'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.archived, ['P-2']);
  assert.deepEqual(r.json.refused, [
    { id: 'P-1', reason: '1 live session' },
    { id: 'P-3', reason: 'the coordinator project cannot be archived' },
    { id: 'P-9', reason: 'project not found' },
  ]);
  assert.deepEqual(h.state().projects.map((p) => p.archived), [false, true, false]);
  assert.equal((await h.api('POST', '/v1/projects/archive', {})).status, 400);
  assert.equal((await h.api('POST', '/v1/projects/archive', { ids: [1] })).status, 400);
  assert.equal((await h.api('POST', '/v1/projects/archive', { ids: Array.from({ length: 1001 }, (_, i) => `P-${i}`) })).status, 400);
  assert.equal((await h.apiBare('POST', '/v1/projects/archive', { ids: ['P-1'] }, {})).status, 403);
});

test('merge-into moves cards (ids kept), sessions, notes, links and docs, then archives the source', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a'); start(h, 's2', '/w/b'); start(h, 's3', '/w/c');
  await h.api('POST', '/v1/projects/P-3/coordinator', { on: true });
  const t1 = (await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'target card' })).json.task.id;
  const m1 = (await h.api('POST', '/v1/tasks', { projectId: 'P-2', title: 'old card 1' })).json.task.id;
  const m2 = (await h.api('POST', '/v1/tasks', { projectId: 'P-2', title: 'old card 2', dependsOn: [m1] })).json.task.id;
  await h.api('POST', '/v1/notes', { target: { kind: 'task', id: m1 }, text: 'a note on the old card' });
  const S3 = async (method, p, body) => { const { asSession } = await import('./helpers.mjs'); return (await asSession(h, 's3'))(method, p, body); };
  await S3('POST', '/v1/tasks', { projectId: 'P-2', title: 'from coordinator' }); // makes a task link into P-2
  assert.equal(h.state().links.find((l) => l.toProjectId === 'P-2').kind, 'task');
  end(h, 's2');
  const r = await h.api('POST', '/v1/projects/P-2/merge-into/P-1');
  assert.equal(r.status, 200);
  assert.equal(r.json.tasks, 3);
  assert.equal(r.json.source.archived, true);
  assert.equal(r.json.target.archived, false);
  const st = h.state();
  const moved = st.tasks.filter((x) => x.projectId === 'P-1');
  assert.deepEqual(moved.map((x) => x.title), ['target card', 'old card 1', 'old card 2', 'from coordinator']);
  assert.equal(moved.find((x) => x.id === m2).dependsOn[0], m1);
  assert.deepEqual(h.hub.db.all(`SELECT title FROM tasks WHERE project_id = 'P-1' AND status = 'backlog' ORDER BY ord`).map((r) => r.title),
    ['target card', 'old card 1', 'old card 2', 'from coordinator'], 'moved cards go after the target\'s own');
  assert.equal(st.tasks.some((x) => x.projectId === 'P-2'), false);
  assert.equal(st.tasks.find((x) => x.id === t1).projectId, 'P-1');
  assert.equal(st.sessions.find((x) => x.id === 's2').projectId, 'P-1');
  assert.equal(st.links.find((l) => l.kind === 'task').toProjectId, 'P-1');
  assert.equal(st.tasks.find((x) => x.title === 'from coordinator').fromProjectId, 'P-3');
  assert.ok(h.state().notes.some((n) => n.target.id === m1), 'the note follows its card');
  assert.equal((await h.get('/v1/state?projectId=P-1')).json.tasks.length, 4);
});

test('merge-into refusals: unknown, itself, coordinator source, live source, archived target, human only', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a'); start(h, 's2', '/w/b'); start(h, 's3', '/w/c'); end(h, 's2'); end(h, 's3');
  await h.api('POST', '/v1/projects/P-3/coordinator', { on: true });
  const merge = (a, b) => h.api('POST', `/v1/projects/${a}/merge-into/${b}`);
  assert.equal((await merge('P-9', 'P-1')).status, 404);
  assert.equal((await merge('P-2', 'P-9')).status, 404);
  assert.equal((await merge('P-2', 'P-2')).status, 400);
  const live = await merge('P-1', 'P-2');
  assert.equal(live.status, 409); assert.match(live.json.error, /1 live session/);
  const coord = await merge('P-3', 'P-2');
  assert.equal(coord.status, 409); assert.match(coord.json.error, /coordinator/);
  await h.api('POST', '/v1/projects/P-2/archive');
  const arch = await h.api('POST', '/v1/projects/P-1/merge-into/P-2');
  assert.equal(arch.status, 409);
  assert.equal((await h.apiBare('POST', '/v1/projects/P-3/merge-into/P-1', undefined, {})).status, 403);
  assert.equal((await sock(h, 'POST', '/v1/projects/P-2/merge-into/P-1')).status, 403);
  assert.ok(h.state().sessions.every((s) => ['P-1', 'P-2', 'P-3'].includes(s.projectId)));
  assert.equal(h.state().sessions.find((s) => s.id === 's2').projectId, 'P-2', 'nothing moved');
});

test('everything above replays exactly (--rebuild is identical)', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a'); start(h, 's2', '/w/a/'); start(h, 's3', '/w/b'); start(h, 's4', '/w/c');
  await h.api('POST', '/v1/tasks', { projectId: 'P-2', title: 'x' });
  await h.api('POST', '/v1/tasks', { projectId: 'P-2', title: 'y', status: 'next' });
  end(h, 's3');
  await h.api('POST', '/v1/projects/P-2/merge-into/P-1');
  await h.api('POST', '/v1/projects/P-2/unarchive');
  await h.api('POST', '/v1/projects/P-2/archive');
  end(h, 's4');
  await h.api('POST', '/v1/projects/archive', { ids: ['P-3'] });
  start(h, 's5', '/w/c');
  start(h, 's6', '/w/b');
  const before = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
});

test('bulk ack takes 1000 ids in one call (single transaction) and refuses 1001', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const evs = [];
  for (let i = 0; i < 1000; i++) {
    evs.push(h.ev(`b${i}`, 'session.started', { cwd: '/w/bulk' }), h.ev(`b${i}`, 'session.ended', {}));
  }
  h.send(...evs);
  assert.equal(h.state().projects.length, 1);
  const ids = Array.from({ length: 1000 }, (_, i) => `b${i}`);
  const t0 = Date.now();
  const r = await h.api('POST', '/v1/ack', { sessionIds: ids });
  assert.equal(r.status, 200);
  assert.equal(r.json.acked.length, 1000);
  assert.deepEqual(r.json.refused, []);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
  assert.equal(h.state().sessions.filter((s) => s.acknowledgedAt).length, 1000);
  const n = h.hub.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'hub.ack'`).n;
  assert.equal(n, 1000);
  assert.equal((await h.api('POST', '/v1/ack', { sessionIds: [...ids, 'x'] })).status, 400);
  assert.equal((await h.api('POST', '/v1/ack', { sessionIds: ids.slice(0, 600), linkIds: ids.slice(0, 401) })).status, 400, 'the cap counts all three lists');
});
