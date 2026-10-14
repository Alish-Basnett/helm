// T-66: files changed are derived from git (delta since the base, attributed by paths the task's tool calls named),
// the decision is recorded as a hub.task.files event, and files can be attached to an existing task (backfill).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startTest, tmpDir } from './helpers.mjs';
import { deriveFiles, DELTA_NOTE } from '../diff.mjs';

const gitIn = (dir, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
function makeRepo(t, files) {
  const dir = fs.realpathSync(tmpDir('helm-t66-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  gitIn(dir, 'init', '-q');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  gitIn(dir, 'add', '-A'); gitIn(dir, 'commit', '-q', '-m', 'init');
  return { dir, head: gitIn(dir, 'rev-parse', 'HEAD'), write };
}
const REPO = { 'a.txt': 'a\n', 'b.txt': 'b\n', 'sub/c.txt': 'c\n' };

/** A task bound to an agent that was spawned by the mod itself (reconcile row, then agent.git by agentId). */
async function modTask(h, repo) {
  h.send(h.ev('s1', 'session.started', { cwd: repo.dir, title: 'Main', model: 'opus' }));
  const r = await h.api('POST', '/v1/tasks', { projectId: h.state().projects[0].id, title: 'Mod work', description: 'd', status: 'in_progress' });
  assert.equal(r.status, 201);
}

test('deriveFiles: delta vs base plus untracked, attributed by mentioned paths (Bash included); no hints = labelled full delta', async (t) => {
  const repo = makeRepo(t, REPO);
  repo.write('a.txt', 'a2\n'); repo.write('b.txt', 'b2\n'); repo.write('sub/new.txt', 'n\n');
  const task = { git: { root: repo.dir, base: repo.head }, filesChanged: [] };
  const all = await deriveFiles(task);
  assert.equal(all.source, 'delta');
  assert.equal(all.note, DELTA_NOTE);
  assert.deepEqual(all.files.map((f) => path.relative(repo.dir, f)).sort(), ['a.txt', 'b.txt', 'sub/new.txt']);
  const some = await deriveFiles(task, { mentions: [`sed -i s/a/b/ ${repo.dir}/a.txt`], hints: ['Bash: touch sub/new.txt'] });
  assert.equal(some.source, 'attributed');
  assert.equal(some.note, null);
  assert.deepEqual(some.files.map((f) => path.relative(repo.dir, f)).sort(), ['a.txt', 'sub/new.txt']);
  assert.equal((await deriveFiles({ git: null, filesChanged: [] })).source, 'none');
  assert.equal((await deriveFiles({ git: { root: repo.dir, base: repo.head }, filesChanged: [] }, { mentions: ['zzz.txt'] })).source, 'none');
});

test('a task with a base derives its files when the diff is read; replay does not ask git again', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, REPO);
  await modTask(h, repo);
  h.send(h.ev('s1', 'task.git', { taskId: 'T-1', cwd: repo.dir, root: repo.dir, base: repo.head, head: repo.head, at: 1 }));
  assert.equal(h.state().tasks.find((x) => x.id === 'T-1').git.base, repo.head);
  repo.write('a.txt', 'a2\n'); repo.write('b.txt', 'b2\n');
  // the main loop touched a.txt through Bash only
  h.send(h.ev('s1', 'tool.called', { tool: 'Bash', summary: 'sed -i s/a/a2/ a.txt', paths: ['a.txt'], taskId: 'T-1' }));
  const d = (await h.get('/v1/tasks/T-1/diff')).json;
  assert.equal(d.source, 'live');
  assert.deepEqual(d.files.map((f) => f.rel), ['a.txt'], 'b.txt was not named by this task, so it is not attributed');
  assert.deepEqual(h.state().tasks.find((x) => x.id === 'T-1').filesChanged, [path.join(repo.dir, 'a.txt')]);
  const before = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before, 'rebuild reproduces the derived files from hub.task.files events');
});

test('POST /v1/tasks/:id/files attaches files, uses HEAD as base when the task has none, and refuses escapes', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, REPO);
  await modTask(h, repo);
  repo.write('a.txt', 'a2\n');
  const bad = await h.api('POST', '/v1/tasks/T-1/files', { files: ['../outside.txt'], root: repo.dir });
  assert.equal(bad.status, 400);
  assert.equal((await h.api('POST', '/v1/tasks/T-1/files', { files: [] })).status, 400);
  assert.equal((await h.api('POST', '/v1/tasks/T-9/files', { files: ['a.txt'], root: repo.dir })).status, 404);
  const ok = await h.api('POST', '/v1/tasks/T-1/files', { files: ['a.txt', path.join(repo.dir, 'a.txt')], root: repo.dir });
  assert.equal(ok.status, 200);
  const task = h.state().tasks.find((x) => x.id === 'T-1');
  assert.deepEqual(task.filesChanged, [path.join(repo.dir, 'a.txt')], 'deduped, absolute');
  assert.equal(task.git.base, repo.head);
  assert.equal(task.filesNote, 'attached by hand');
  const d = (await h.get('/v1/tasks/T-1/diff')).json;
  assert.deepEqual(d.files.map((f) => f.rel), ['a.txt']);
  const before = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
});
