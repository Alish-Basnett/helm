import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, tmpDir, asSession } from './helpers.mjs';
import { resolveFolder } from '../folder.mjs';
import { AppTitles } from '../apptitles.mjs';

// v0.27 review fixes (CONTRACT "v0.27 additions").

const start = (h, sid, cwd) => h.send(h.ev(sid, 'session.started', { cwd, title: sid }));
const end = (h, sid) => h.send(h.ev(sid, 'session.ended', {}));
const projectOf = (h, sid) => h.state().sessions.find((s) => s.id === sid).projectId;
const legacy = (h, sid, cwd, seq = 1) => h.hub.db.run('INSERT INTO events(session_id, seq, type, at, data) VALUES (?, ?, ?, ?, ?)', sid, seq, 'session.started', 1000 + seq, JSON.stringify({ cwd }));
const nEvents = (h, type) => h.hub.db.get('SELECT COUNT(*) AS n FROM events WHERE type = ?', type).n;

test('1. a hand-made project with the folder\'s name and no folder is joined and takes the folder (recorded, replay-exact)', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await h.api('POST', '/v1/projects', { name: 'Alpha' });
  await h.api('POST', '/v1/projects', { name: 'beta' });
  await h.api('POST', '/v1/projects/P-2/archive');
  start(h, 's1', '/w/alpha');
  assert.equal(projectOf(h, 's1'), 'P-1');
  assert.equal(h.state().projects[0].folder, '/w/alpha');
  start(h, 's2', '/w/alpha');
  assert.equal(projectOf(h, 's2'), 'P-1');
  start(h, 's3', '/w/beta');
  assert.notEqual(projectOf(h, 's3'), 'P-2', 'an archived hand-made project is not joined');
  start(h, 's4', '/w/other/gamma');
  assert.equal(h.state().projects.length, 4, 'a different name makes a new project');
  const ev = JSON.parse(h.hub.db.get(`SELECT data FROM events WHERE session_id = 's1'`).data);
  assert.deepEqual([ev.joinProjectId, ev.adoptFolder], ['P-1', '/w/alpha']);
  const dump = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), dump);
});

test('2. merging into a project without a folder gives it the source\'s folder', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await h.api('POST', '/v1/projects', { name: 'Hand' });
  start(h, 's1', '/w/a'); end(h, 's1');
  assert.equal((await h.api('POST', '/v1/projects/P-2/merge-into/P-1')).status, 200);
  assert.equal(h.state().projects[0].folder, '/w/a');
  const dump = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), dump);
});

test('3 + 9. app titles: two files for one session — newest wins, one update, stable; unchanged files are not read again; file cap', async (t) => {
  const root = tmpDir('helm-app-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const known = new Map();
  const hub = { closed: false, setAppTitle: (id, title, app) => { calls.push([id, title, app]); const changed = known.get(id) !== title; known.set(id, title); return changed; } };
  const warns = [];
  const at = new AppTitles({ dir: root, hub, log: { warn: (m) => warns.push(m) } });
  const put = (name, j, mtime) => {
    const f = path.join(root, 'a', 'b', `local_${name}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(j));
    fs.utimesSync(f, mtime, mtime);
    return f;
  };
  put('old', { sessionId: 'local_old', cliSessionId: 's1', title: 'Old title' }, 1000);
  const newer = put('new', { sessionId: 'local_new', cliSessionId: 's1', title: 'New title' }, 2000);
  assert.equal(at.scan(), 1);
  assert.deepEqual(calls, [['s1', 'New title', 'local_new']], 'one update per session, the newest file');
  assert.equal(at.scan(), 0);
  assert.equal(calls.length, 2, 'asked again but nothing changes');
  assert.deepEqual(calls.at(-1), ['s1', 'New title', 'local_new'], 'no flip-flop');
  const entry = at.cache.get(newer);
  at.scan();
  assert.equal(at.cache.get(newer), entry, 'an unchanged file is served from the cache');
  put('new', { sessionId: 'local_new', cliSessionId: 's1', title: 'Newest title' }, 3000);
  assert.equal(at.scan(), 1);
  assert.notEqual(at.cache.get(newer), entry, 'a changed file is read again');
  const capped = new AppTitles({ dir: root, hub, log: { warn: (m) => warns.push(m) }, maxFiles: 1 });
  capped.scan();
  assert.equal(warns.length, 1);
  assert.match(warns[0], /more than 1 session files/);
});

test('4. joining an archived project is 409; archiving an archived project is a no-op even if a session is live again', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a'); start(h, 's2', '/w/b'); end(h, 's1');
  await h.api('POST', '/v1/projects/P-1/archive');
  const j = await h.api('POST', '/v1/sessions/s2/join', { projectId: 'P-1' });
  assert.equal(j.status, 409);
  assert.equal(projectOf(h, 's2'), 'P-2');
  h.send(h.ev('s1', 'session.heartbeat', { tokens: 1 })); // a stray heartbeat makes s1 live again
  const n = nEvents(h, 'hub.project.archive');
  assert.equal((await h.api('POST', '/v1/projects/P-1/archive')).status, 200);
  assert.deepEqual((await h.api('POST', '/v1/projects/archive', { ids: ['P-1'] })).json, { archived: ['P-1'], refused: [] });
  assert.equal(nEvents(h, 'hub.project.archive'), n, 'no new event');
});

test('5. legacy projects get the resolved folder as an event at boot; the migration reads the first session.started', async (t) => {
  const root = fs.realpathSync(tmpDir('helm-f-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'real'), link = path.join(root, 'link');
  fs.mkdirSync(real); fs.symlinkSync(real, link);
  const h = await startTest(); t.after(h.stop);
  legacy(h, 'o1', link + '/');
  legacy(h, 'o2', '/w/first'); legacy(h, 'o2', '/w/second', 2); // a later session.started overwrites sessions.cwd
  h.hub.rebuild();
  assert.deepEqual(h.state().projects.map((p) => p.folder), [link, '/w/first']);
  assert.deepEqual(h.hub.refreshFolders(), ['P-1']);
  assert.equal(h.state().projects[0].folder, real);
  assert.deepEqual(h.hub.refreshFolders(), [], 'nothing left to resolve');
  start(h, 'n1', real);
  assert.equal(projectOf(h, 'n1'), 'P-1', 'a new session in the real path joins the legacy project');
  const dump = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), dump, 'the folder event replays');
  const raw = h.hub.db.raw;
  raw.exec('DROP INDEX projects_folder'); raw.exec('ALTER TABLE projects DROP COLUMN folder');
  h.hub.db.cache.clear();
  h.hub.db.migrate();
  assert.equal(h.state().projects[1].folder, '/w/first', 'migration uses the first session.started, as a replay does');
});

test('6. merge into itself is 400 before any other check', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a');
  await h.api('POST', '/v1/projects/P-1/coordinator', { on: true });
  assert.equal((await h.api('POST', '/v1/projects/P-1/merge-into/P-1')).status, 400, 'coordinator and live, still 400');
});

test('7. merging again once everything moved is a 200 no-op with no new event', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a'); start(h, 's2', '/w/b'); end(h, 's2');
  await h.api('POST', '/v1/tasks', { projectId: 'P-2', title: 'x' });
  assert.equal((await h.api('POST', '/v1/projects/P-2/merge-into/P-1')).json.tasks, 1);
  const n = nEvents(h, 'hub.project.merge');
  const again = await h.api('POST', '/v1/projects/P-2/merge-into/P-1');
  assert.equal(again.status, 200);
  assert.equal(again.json.tasks, 0);
  assert.equal(nEvents(h, 'hub.project.merge'), n);
});

test('8. links between the two merged projects become answered and acknowledged', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a'); start(h, 's2', '/w/b');
  await h.api('POST', '/v1/projects/P-1/coordinator', { on: true });
  const S1 = await asSession(h, 's1');
  await S1('POST', '/v1/tasks', { projectId: 'P-2', title: 'card' }); // a task link P-1 -> P-2
  const S2 = await asSession(h, 's2');
  const note = await S2('POST', '/v1/links', { kind: 'note', to: 'P-1', text: 'hello' }); // a note link P-2 -> P-1, still waiting
  assert.equal(note.status, 201);
  end(h, 's2');
  assert.ok(h.state().links.every((l) => !l.acknowledgedAt));
  const r = await h.api('POST', '/v1/projects/P-2/merge-into/P-1');
  assert.equal(r.status, 200);
  const links = h.state().links;
  assert.equal(links.length, 2);
  for (const l of links) {
    assert.deepEqual([l.fromProjectId, l.toProjectId, l.state], ['P-1', 'P-1', 'answered']);
    assert.ok(l.acknowledgedAt, 'acknowledged');
  }
  const dump = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), dump);
});

test('10. resolveFolder wants an absolute path', () => {
  assert.equal(resolveFolder('relative/dir'), null);
  assert.equal(resolveFolder('./x'), null);
});

test('external git worktrees keep their own project: join, duplicates and refreshFolders leave them alone', async (t) => {
  const root = fs.realpathSync(tmpDir('helm-f-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'admin'), wt = path.join(root, 'KBank-check');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'KBank-check'), { recursive: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${main}/.git/worktrees/KBank-check\n`);
  const h = await startTest(); t.after(h.stop);
  start(h, 'a1', main); start(h, 'k1', wt);
  assert.deepEqual(h.state().projects.map((p) => p.folder), [main, wt]);
  await h.api('POST', '/v1/projects/P-1/coordinator', { on: true });
  end(h, 'k1');
  start(h, 'k2', wt);
  assert.equal(projectOf(h, 'k2'), 'P-2', 'the worktree session joins its own project, not the main repo\'s');
  assert.deepEqual((await h.get('/v1/projects/duplicates')).json.groups, [], 'not grouped with the main repo');
  assert.deepEqual(h.hub.refreshFolders(), []);
  legacy(h, 'o1', wt, 1); // a legacy project for the worktree folder
  h.hub.rebuild();
  assert.equal(h.hub.refreshFolders().length, 0, 'boot does not rewrite a worktree\'s folder');
  assert.ok(h.state().projects.every((p) => p.folder === main || p.folder === wt));
});

test('10. a session with a relative cwd has no folder and lands in Unassigned', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', 'some/relative');
  const p = h.state().projects[0];
  assert.deepEqual([p.name, p.folder], ['Unassigned', null]);
});

test('11. the workflow tick skips runs of archived projects; the auto-start tick already does', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h, 's1', '/w/a');
  const wf = (await h.api('POST', '/v1/workflows', { projectId: 'P-1', template: 'build-test-review' })).json.workflow;
  assert.equal((await h.api('POST', `/v1/workflows/${wf.id}/run`, { params: { brief: 'x' } })).status, 201);
  end(h, 's1');
  await h.api('POST', '/v1/projects/P-1/archive');
  let evaluated = 0;
  const orig = h.hub.wf.evaluate.bind(h.hub.wf);
  h.hub.wf.evaluate = (...a) => { evaluated++; return orig(...a); };
  h.hub.wf.tick();
  assert.equal(evaluated, 0, 'archived project: no run is evaluated');
  await h.api('POST', '/v1/projects/P-1/unarchive');
  h.hub.wf.tick();
  assert.ok(evaluated > 0, 'unarchived: it runs again');
  await h.api('PATCH', '/v1/projects/P-1', { autoStart: true });
  await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'n', status: 'next' });
  await h.api('POST', '/v1/projects/P-1/archive');
  assert.deepEqual(h.hub.autoTick(), []);
});
