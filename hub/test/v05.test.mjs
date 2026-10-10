// v0.5: git base at spawn, task diffs (live / snapshot / history / none), caps, path safety, rebuild, migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startTest, tmpDir } from './helpers.mjs';
import { seed } from '../seed.mjs';
import { computeDiff, FILE_PATCH_CAP, TOTAL_PATCH_CAP } from '../diff.mjs';

const gitIn = (dir, env, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a],
  { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }).trim();

/** A real temp repo with one commit holding `files` ({ rel: text }). Cleaned up with the test. */
function makeRepo(t, files, { date } = {}) {
  const dir = fs.realpathSync(tmpDir('helm-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  gitIn(dir, {}, 'init', '-q');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  const commit = (msg, d) => {
    gitIn(dir, {}, 'add', '-A');
    gitIn(dir, d ? { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } : {}, 'commit', '-q', '-m', msg);
    return gitIn(dir, {}, 'rev-parse', 'HEAD');
  };
  const head = commit('init', date);
  return { dir, head, write, commit, rm: (rel) => fs.rmSync(path.join(dir, rel)) };
}

/** A session with one agent on a task. Returns ids; `git` adds an agent.git event. */
function spawnAgent(h, repo, { tu = 'tu1', agentId = 'ag1', at, bind = true, git = true, sid = 's1', taskId } = {}) {
  const evs = [];
  if (!h.hub.p.getSession(sid)) evs.push(h.ev(sid, 'session.started', { cwd: repo ? repo.dir : '/w', title: 'Main', model: 'opus' }));
  evs.push(h.ev(sid, 'agent.spawned', { toolUseId: tu, subagentType: 'general-purpose', description: 'Do the thing', prompt: 'p', ...(taskId ? { taskId } : {}) }, at));
  if (git && repo) evs.push(h.ev(sid, 'agent.git', { toolUseId: tu, cwd: repo.dir, root: repo.dir, base: repo.head, head: repo.head, at: at ?? Date.now() }, at));
  if (bind) evs.push(h.ev(sid, 'agent.bound', { toolUseId: tu, agentId }, at));
  h.send(...evs);
  return h.hub.p.getAgent(bind ? agentId : `pending:${tu}`).task_id;
}
const files = (h, sid, agentId, list) => h.send(h.ev(sid, 'tool.finished', { agentId, tool: 'Edit', ok: true, summary: 'edit', files: list }));
const lines = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n') + '\n';
const byRel = (d) => Object.fromEntries(d.files.map((f) => [f.rel, f]));

test('agent.git: stored on the agent and task; matches by toolUseId then agentId; first base wins', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'a\n' });
  // arrives while the agent is still pending -> survives the pending -> bound rename
  const taskId = spawnAgent(h, repo, { bind: false });
  let task = h.state().tasks.find((x) => x.id === taskId);
  assert.deepEqual(Object.keys(task.git).sort(), ['at', 'base', 'head', 'root']);
  assert.equal(task.git.base, repo.head);
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: 'ag1' }));
  assert.equal(h.hub.p.getAgent('ag1').task_id, taskId);
  assert.equal(JSON.parse(h.hub.p.getAgent('ag1').git).root, repo.dir);

  // a follow-up agent on the same task, with a later base, never moves the base
  repo.write('a.txt', 'a\nb\n');
  const second = repo.commit('second');
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu2', taskId, subagentType: 'general-purpose', description: 'follow up' }),
    h.ev('s1', 'agent.bound', { toolUseId: 'tu2', agentId: 'ag2' }),
    // matched by agentId only (no toolUseId)
    h.ev('s1', 'agent.git', { agentId: 'ag2', cwd: repo.dir, root: repo.dir, base: second, head: second, at: 5 }));
  assert.equal(JSON.parse(h.hub.p.getAgent('ag2').git).base, second, 'agent keeps its own');
  task = h.state().tasks.find((x) => x.id === taskId);
  assert.equal(task.git.base, repo.head, 'task keeps the first base');

  // junk is ignored, never throws
  const before = JSON.stringify(h.state().tasks);
  h.send(h.ev('s1', 'agent.git', { toolUseId: 'nope', root: repo.dir, base: repo.head, head: repo.head }),
    h.ev('s1', 'agent.git', { toolUseId: 'tu1', root: 'relative', base: repo.head, head: repo.head }),
    h.ev('s1', 'agent.git', { toolUseId: 'tu1', root: repo.dir, base: '--output=x', head: repo.head }));
  assert.equal(JSON.stringify(h.state().tasks), before);
});

test('live diff: modified, added (untracked) and deleted files with numstat totals; updates diffStat', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'one\ntwo\nthree\n', 'sub/b.txt': 'b1\nb2\n', 'c.txt': 'c1\nc2\n' });
  const taskId = spawnAgent(h, repo);
  repo.write('a.txt', 'one\nTWO\nthree\n');           // +1 -1
  repo.write('sub/new.txt', 'n1\nn2\n');               // untracked, +2
  repo.rm('c.txt');                                    // deleted, -2
  files(h, 's1', 'ag1', ['a.txt', path.join(repo.dir, 'sub/new.txt'), path.join(repo.dir, 'c.txt'), 'sub/b.txt']);
  const r = await h.get(`/v1/tasks/${taskId}/diff`);
  assert.equal(r.status, 200);
  const d = r.json;
  assert.equal(d.source, 'live');
  assert.equal(d.root, repo.dir);
  assert.equal(d.base, repo.head);
  assert.deepEqual(d.totals, { files: 3, additions: 3, deletions: 3 }, 'unchanged b.txt is not listed');
  const f = byRel(d);
  assert.deepEqual([f['a.txt'].status, f['a.txt'].additions, f['a.txt'].deletions], ['M', 1, 1]);
  assert.deepEqual([f['sub/new.txt'].status, f['sub/new.txt'].additions, f['sub/new.txt'].deletions], ['A', 2, 0]);
  assert.deepEqual([f['c.txt'].status, f['c.txt'].additions, f['c.txt'].deletions], ['D', 0, 2]);
  assert.match(f['a.txt'].patch, /^diff --git a\/a\.txt b\/a\.txt/m);
  assert.match(f['a.txt'].patch, /^-two$/m);
  assert.match(f['a.txt'].patch, /^\+TWO$/m);
  assert.match(f['sub/new.txt'].patch, /^new file mode/m);
  assert.match(f['c.txt'].patch, /^deleted file mode/m);
  assert.equal(f['a.txt'].path, path.join(repo.dir, 'a.txt'));
  assert.equal(f['a.txt'].binary, false);
  assert.equal(f['a.txt'].truncated, false);
  assert.deepEqual(h.state().tasks[0].diffStat, { files: 3, additions: 3, deletions: 3 }, 'live result updates Task.diffStat');
  assert.equal((await h.get('/v1/tasks/T-99/diff')).status, 404);
});

test('binary file: numstat dashes become binary:true with no patch', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'a\n' });
  const taskId = spawnAgent(h, repo);
  repo.write('img.bin', Buffer.from([0, 1, 2, 3, 0, 255, 0, 9]).toString('latin1'));
  fs.writeFileSync(path.join(repo.dir, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 0, 9]));
  files(h, 's1', 'ag1', ['img.bin']);
  const d = (await h.get(`/v1/tasks/${taskId}/diff`)).json;
  assert.equal(d.files[0].binary, true);
  assert.equal(d.files[0].status, 'A');
  assert.equal(d.files[0].patch, '');
});

test('snapshot is recorded on completion (off the ingest path); refresh recomputes live', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'one\n' });
  const taskId = spawnAgent(h, repo);
  repo.write('a.txt', 'one\ntwo\n');
  files(h, 's1', 'ag1', ['a.txt']);
  const r = h.send(h.ev('s1', 'agent.completed', { agentId: 'ag1', ok: true, summary: 'done' }));
  assert.equal(r.accepted, 1);
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM task_diffs').n, 0, 'nothing computed inside ingest');
  await h.hub.flushSnapshots();
  const ev = h.hub.db.get("SELECT data FROM events WHERE type = 'hub.task.diff'");
  assert.equal(JSON.parse(ev.data).taskId, taskId);
  assert.deepEqual(h.state().tasks[0].diffStat, { files: 1, additions: 1, deletions: 0 });

  // the working tree moves on; the snapshot stays frozen
  repo.write('a.txt', 'one\ntwo\nthree\nfour\n');
  const snap = (await h.get(`/v1/tasks/${taskId}/diff`)).json;
  assert.equal(snap.source, 'snapshot');
  assert.deepEqual(snap.totals, { files: 1, additions: 1, deletions: 0 });
  assert.match(snap.files[0].patch, /^\+two$/m);

  const live = (await h.get(`/v1/tasks/${taskId}/diff?refresh=1`)).json;
  assert.equal(live.source, 'live');
  assert.deepEqual(live.totals, { files: 1, additions: 3, deletions: 0 });
  assert.deepEqual(h.state().tasks[0].diffStat, { files: 1, additions: 3, deletions: 0 }, 'refresh updates diffStat');
  assert.equal((await h.get(`/v1/tasks/${taskId}/diff`)).json.source, 'snapshot', 'the snapshot itself is untouched');

  // a task whose agent made no diffable changes records nothing for a non-repo; completion of an agent without files is quiet
  const none = spawnAgent(h, null, { tu: 'tu9', agentId: 'ag9', sid: 's1', git: false });
  h.send(h.ev('s1', 'agent.completed', { agentId: 'ag9', ok: true }));
  await h.hub.flushSnapshots();
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM task_diffs WHERE task_id = ?', none).n, 0);
});

test('history mode when there is no base: squashed commits in the task window, else git diff HEAD', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const old = new Date(Date.now() - 3600_000).toISOString();
  const repo = makeRepo(t, { 'x.txt': 'x1\n', 'y.txt': 'y1\n' }, { date: old });
  const taskId = spawnAgent(h, repo, { git: false, at: Date.now() - 20_000 });
  assert.equal(h.state().tasks.find((x) => x.id === taskId).git, null);
  repo.write('x.txt', 'x1\nx2\n'); repo.commit('x2');
  repo.write('x.txt', 'x1\nx2\nx3\n'); repo.commit('x3');         // two commits squash into +2
  repo.write('y.txt', 'y1\ny2\n');                                  // uncommitted -> git diff HEAD
  files(h, 's1', 'ag1', [path.join(repo.dir, 'x.txt'), path.join(repo.dir, 'y.txt')]);
  const d = (await h.get(`/v1/tasks/${taskId}/diff`)).json;
  assert.equal(d.source, 'history');
  assert.equal(d.note, 'approximate: no base recorded');
  assert.equal(d.base, null);
  const f = byRel(d);
  assert.deepEqual([f['x.txt'].status, f['x.txt'].additions, f['x.txt'].deletions], ['M', 2, 0]);
  assert.match(f['x.txt'].patch, /^\+x2$/m);
  assert.match(f['x.txt'].patch, /^\+x3$/m);
  assert.deepEqual([f['y.txt'].status, f['y.txt'].additions], ['M', 1]);
});

test('none: no files, a non-repo path, git missing', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const taskId = spawnAgent(h, null, { git: false });
  let d = (await h.get(`/v1/tasks/${taskId}/diff`)).json;
  assert.equal(d.source, 'none');
  assert.match(d.note, /no files/);
  assert.deepEqual(d.totals, { files: 0, additions: 0, deletions: 0 });
  assert.deepEqual(d.files, []);

  const plain = fs.realpathSync(tmpDir('helm-plain-')); t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  fs.writeFileSync(path.join(plain, 'f.txt'), 'x\n');
  files(h, 's1', 'ag1', [path.join(plain, 'f.txt')]);
  d = (await h.get(`/v1/tasks/${taskId}/diff`)).json;
  assert.equal(d.source, 'none');
  assert.match(d.note, /outside any git repo/);

  // git binary absent: a clean `none`, never a throw
  const PATH = process.env.PATH;
  process.env.PATH = path.join(plain, 'nothing-here');
  try {
    const r = await computeDiff({ filesChanged: [path.join(plain, 'f.txt')], git: null, createdAt: 0, doneAt: null });
    assert.equal(r.source, 'none');
    assert.match(r.note, /git is not available/);
  } finally { process.env.PATH = PATH; }
});

test('caps: 120 KB per file and 600 KB total mark truncated; stats still count everything', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'a\n' });
  const taskId = spawnAgent(h, repo);
  const big = [];
  for (let i = 0; i < 8; i++) { repo.write(`big${i}.txt`, lines(10_000 + i, 'padding padding')); big.push(`big${i}.txt`); }
  repo.write('small.txt', 'tiny\n');
  files(h, 's1', 'ag1', [...big, 'small.txt']);
  const d = (await h.get(`/v1/tasks/${taskId}/diff`)).json;
  assert.equal(d.source, 'live');
  assert.equal(d.totals.files, 9);
  assert.equal(d.totals.additions, 8 * 10_000 + 28 + 1, 'numstat is exact even when patches are cut');
  const f = byRel(d);
  for (const b of big) {
    assert.equal(f[b].truncated, true, b);
    assert.ok(Buffer.byteLength(f[b].patch) <= FILE_PATCH_CAP, 'per-file cap');
    assert.equal(f[b].additions >= 10_000, true);
  }
  const total = d.files.reduce((n, x) => n + Buffer.byteLength(x.patch), 0);
  assert.ok(total <= TOTAL_PATCH_CAP, `total ${total} within cap`);
  assert.ok(f['small.txt'].truncated, 'over the total budget: stat kept, patch dropped, flagged');
  assert.equal(f['small.txt'].additions, 1);
});

test('paths: traversal and symlink escapes are refused; another repo diffs against its own HEAD', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'a\n' });
  const other = makeRepo(t, { 'o.txt': 'o1\n' });
  const secret = fs.realpathSync(tmpDir('helm-secret-')); t.after(() => fs.rmSync(secret, { recursive: true, force: true }));
  fs.writeFileSync(path.join(secret, 'pw.txt'), 'hunter2\n');
  const taskId = spawnAgent(h, repo);
  repo.write('a.txt', 'a\nb\n');
  fs.symlinkSync(path.join(secret, 'pw.txt'), path.join(repo.dir, 'link.txt'));
  fs.symlinkSync(secret, path.join(repo.dir, 'linkdir'));
  other.write('o.txt', 'o1\no2\n');
  files(h, 's1', 'ag1', [
    'a.txt', '../../../../../../etc/hosts', '/etc/hosts', 'link.txt', 'linkdir/pw.txt',
    path.join(repo.dir, '..', path.basename(secret), 'pw.txt'), path.join(other.dir, 'o.txt'), 'bad\0name',
  ]);
  const d = (await h.get(`/v1/tasks/${taskId}/diff`)).json;
  assert.equal(d.source, 'live');
  assert.deepEqual(d.files.map((x) => x.rel).sort(), ['a.txt', 'o.txt']);
  const f = byRel(d);
  assert.equal(f['o.txt'].path, path.join(other.dir, 'o.txt'));
  assert.match(f['o.txt'].patch, /^\+o2$/m, 'diffed against the other repo HEAD');
  assert.match(d.note, /refused \d+ path/);
  assert.ok(!JSON.stringify(d).includes('hunter2'), 'no content from outside the repo');
  assert.ok(!d.files.some((x) => x.path.includes('etc/hosts')));
});

test('rebuild reproduces snapshots, live stats and git bases byte for byte', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'one\n' });
  const taskId = spawnAgent(h, repo);
  repo.write('a.txt', 'one\ntwo\n');
  files(h, 's1', 'ag1', ['a.txt']);
  h.send(h.ev('s1', 'agent.completed', { agentId: 'ag1', ok: true, summary: 'ok' }));
  await h.hub.flushSnapshots();
  repo.write('a.txt', 'one\ntwo\nthree\n');
  await h.get(`/v1/tasks/${taskId}/diff?refresh=1`);
  const before = h.hub.dump();
  const stateBefore = h.state();
  assert.equal(before.task_diffs.length, 1);
  assert.ok(stateBefore.tasks[0].git && stateBefore.tasks[0].diffStat);
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
  // after the rebuild the snapshot still serves
  assert.equal((await h.get(`/v1/tasks/${taskId}/diff`)).json.source, 'snapshot');
});

test('seed: a real git repo inside HELM_HOME gives one task a base and real diffs', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const r = seed(h.hub);
  if (!r.gitTaskId) return; // git unavailable: skipped gracefully
  const task = h.state().tasks.find((x) => x.id === r.gitTaskId);
  assert.ok(task.git.root.startsWith(fs.realpathSync(h.home)));
  assert.ok(task.filesChanged.includes('src/auth/refresh.ts'));
  const d = (await h.get(`/v1/tasks/${r.gitTaskId}/diff`)).json;
  assert.equal(d.source, 'live');
  assert.deepEqual(d.files.map((x) => [x.rel, x.status]).sort(),
    [['src/auth/refresh.ts', 'A'], ['src/auth/tokens.ts', 'M'], ['test/auth/refresh.test.ts', 'A']]);
  await h.hub.snapshotTask(r.gitTaskId);
  assert.equal((await h.get(`/v1/tasks/${r.gitTaskId}/diff`)).json.source, 'snapshot');
});

test('opening a pre-v0.5 database adds tasks.git / diff_stat, agents.git and task_diffs; idempotent', async (t) => {
  const { Db } = await import('../db.mjs');
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'helm.db');
  let db = new Db(file);
  db.run(`INSERT INTO tasks(id, project_id, title, status, created_at, updated_at) VALUES ('T-1','P-1','keep me','done',1,2)`);
  db.run(`INSERT INTO agents(id, session_id, task_id, tool_use_id, started_at, last_activity_at) VALUES ('ag1','s1','T-1','tu',1,1)`);
  // simulate the old schema
  db.exec('ALTER TABLE tasks DROP COLUMN git; ALTER TABLE tasks DROP COLUMN diff_stat; ALTER TABLE agents DROP COLUMN git; DROP TABLE task_diffs');
  db.close();
  for (let i = 0; i < 2; i++) {
    db = new Db(file);
    const cols = (tbl) => db.all(`PRAGMA table_info(${tbl})`).map((c) => c.name);
    assert.ok(cols('tasks').includes('git') && cols('tasks').includes('diff_stat') && cols('agents').includes('git'));
    assert.equal(db.get('SELECT title, git, diff_stat FROM tasks').title, 'keep me');
    assert.equal(db.get('SELECT git, diff_stat FROM tasks').git, null);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM task_diffs').n, 0);
    db.close();
  }
  const { Hub } = await import('../hub.mjs');
  const { loadConfig } = await import('../config.mjs');
  const hub = new Hub(loadConfig({ home: dir }), null);
  const task = hub.state().tasks[0];
  assert.deepEqual([task.id, task.git, task.diffStat], ['T-1', null, null]);
  const d = await hub.taskDiff('T-1');
  assert.equal(d.source, 'none');
  hub.close();
});
