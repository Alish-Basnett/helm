// v0.12: a git branch + PR per task. Temp repos only; a bare repo plays "origin"; GitHub is a fetch stub (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startTest, tmpDir } from './helpers.mjs';
import { Hub } from '../hub.mjs';
import { loadConfig } from '../config.mjs';
import { parseRemote, compareUrl, parsePrUrl, summariseChecks, slugify, branchNameFor } from '../gitflow.mjs';
import { GitSync } from '../gitsync.mjs';

const ID = { name: 'Repo Owner', email: 'owner@repo.test' };
const gitIn = (dir, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();

/** A temp repo with a LOCAL identity (so the test proves Helm uses it) and one commit. */
function makeRepo(t, files) {
  const dir = fs.realpathSync(tmpDir('helm-g12-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'config', 'user.name', ID.name);
  gitIn(dir, 'config', 'user.email', ID.email);
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  gitIn(dir, 'add', '-A'); gitIn(dir, 'commit', '-q', '-m', 'init');
  return { dir, head: gitIn(dir, 'rev-parse', 'HEAD'), write, rm: (rel) => fs.rmSync(path.join(dir, rel)), git: (...a) => gitIn(dir, ...a) };
}
function bareOrigin(t) {
  const dir = fs.realpathSync(tmpDir('helm-origin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
  return dir;
}
/** A finished task in `repo` whose agent edited `list`. */
function taskIn(h, repo, list, { title = 'Do the thing', n = 1 } = {}) {
  const sid = `s${n}`, tu = `tu${n}`, ag = `ag${n}`;
  h.send(h.ev(sid, 'session.started', { cwd: repo.dir, title: 'Main', model: 'opus' }),
    h.ev(sid, 'agent.spawned', { toolUseId: tu, subagentType: 'general-purpose', description: title, prompt: 'p' }),
    h.ev(sid, 'agent.git', { toolUseId: tu, cwd: repo.dir, root: repo.dir, base: repo.head, head: repo.head, at: Date.now() }),
    h.ev(sid, 'agent.bound', { toolUseId: tu, agentId: ag }));
  const taskId = h.hub.p.getAgent(ag).task_id;
  h.send(h.ev(sid, 'tool.finished', { agentId: ag, tool: 'Edit', ok: true, summary: 'edit', files: list }),
    h.ev(sid, 'recap.generated', { taskId, what: 'Added the thing', how: 'By editing two files', learned: 'x', concepts: [] }),
    h.ev(sid, 'agent.completed', { agentId: ag, ok: true, summary: 'done' }));
  return taskId;
}
const task = (h, id) => h.state().tasks.find((x) => x.id === id);
const snapshot = (repo) => ({ head: repo.git('rev-parse', 'HEAD'), branch: repo.git('rev-parse', '--abbrev-ref', 'HEAD'), status: repo.git('status', '--porcelain=v1', '-uall'), branches: repo.git('for-each-ref', '--format=%(refname)', 'refs/heads') });

test('names, remote parsing and compare URLs (pure)', () => {
  assert.equal(slugify('Fix: the  "login" bug!! (again)'), 'fix-the-login-bug-again');
  assert.equal(slugify('日本語'), 'task');
  assert.equal(branchNameFor('T-12', 'Add JWT refresh'), 'helm/T-12-add-jwt-refresh');
  assert.ok(branchNameFor('T-1', 'x'.repeat(200)).length < 60);
  const cases = [
    ['https://github.com/acme/widgets.git', 'github.com', 'acme', 'widgets'],
    ['https://github.com/acme/widgets', 'github.com', 'acme', 'widgets'],
    ['https://user:s3cret@github.com/acme/widgets.git', 'github.com', 'acme', 'widgets'],
    ['git@github.com:acme/widgets.git', 'github.com', 'acme', 'widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'github.com', 'acme', 'widgets'],
    ['ssh://git@github.com:22/acme/my.repo.git', 'github.com', 'acme', 'my.repo'],
    ['git://github.com/acme/widgets.git', 'github.com', 'acme', 'widgets'],
  ];
  for (const [url, host, owner, repo] of cases) {
    const p = parseRemote(url);
    assert.deepEqual([p.host, p.owner, p.repo, p.github], [host, owner, repo, true], url);
    assert.ok(!/s3cret/.test(p.url), 'credentials are stripped');
  }
  assert.equal(compareUrl(parseRemote('git@github.com:acme/widgets.git'), 'main', 'helm/T-1-x'),
    'https://github.com/acme/widgets/compare/main...helm/T-1-x?expand=1');
  for (const url of ['git@gitlab.com:acme/widgets.git', 'https://bitbucket.org/acme/widgets.git', '/srv/git/widgets.git', 'file:///tmp/x']) {
    assert.equal(compareUrl(parseRemote(url), 'main', 'b'), null, url);
  }
  assert.equal(parseRemote('https://gitlab.example.com/a/b.git').github, false);
  const pr = parsePrUrl('https://github.com/acme/widgets/pull/123#issuecomment-1');
  assert.deepEqual([pr.host, pr.owner, pr.repo, pr.number, pr.url], ['github.com', 'acme', 'widgets', 123, 'https://github.com/acme/widgets/pull/123']);
  assert.equal(parsePrUrl('https://example.com/x').number, null);
  assert.throws(() => parsePrUrl('javascript:alert(1)'), /http/);
  assert.throws(() => parsePrUrl('nope'), /valid/);
});

test('create branch: only the task files, user tree and branch untouched, repo identity, recap in the body', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'one\n', 'gone.txt': 'bye\n', 'other.txt': 'other\n', 'sub/keep.txt': 'k\n' });
  const id = taskIn(h, repo, ['a.txt', path.join(repo.dir, 'sub/new.txt'), 'gone.txt']);
  // the task's edits, plus unrelated dirt the user has in the same tree
  repo.write('a.txt', 'one\ntwo\n'); repo.write('sub/new.txt', 'brand new\n'); repo.rm('gone.txt');
  repo.write('other.txt', 'USER EDIT\n'); repo.write('scratch.txt', 'untracked\n');
  const before = snapshot(repo);

  const info = (await h.get(`/v1/tasks/${id}/git`)).json;
  assert.equal(info.eligible, true);
  assert.equal(info.base, repo.head);
  assert.deepEqual(info.files.sort(), ['a.txt', 'gone.txt', 'sub/new.txt']);

  const r = await h.api('POST', `/v1/tasks/${id}/branch`);
  assert.equal(r.status, 200, r.text);
  const b = r.json.branch;
  assert.equal(b.name, 'helm/T-1-do-the-thing');
  assert.deepEqual(Object.keys(b).slice(0, 10), ['name', 'root', 'worktree', 'commit', 'base', 'remote', 'pushedAt', 'prUrl', 'pr', 'ci']);
  assert.equal(b.base, repo.head);
  assert.equal(b.remote, null);
  assert.equal(b.ci, null);
  assert.equal(b.worktree, path.join(fs.realpathSync(h.home), 'worktrees', id));
  assert.ok(fs.existsSync(path.join(b.worktree, 'a.txt')));

  // the commit: exactly the task's files, nothing else
  const changed = repo.git('show', '--name-status', '--format=', b.commit).split('\n').sort();
  assert.deepEqual(changed, ['A\tsub/new.txt', 'D\tgone.txt', 'M\ta.txt']);
  assert.equal(repo.git('rev-parse', `${b.commit}^`), repo.head, 'branches from the recorded HEAD');
  assert.equal(repo.git('show', `${b.commit}:a.txt`), 'one\ntwo');
  assert.equal(repo.git('show', `${b.commit}:other.txt`), 'other', 'the user edit to an unrelated file is not committed');
  assert.throws(() => repo.git('cat-file', '-e', `${b.commit}:scratch.txt`));
  // identity comes from the repo's local config; message and body
  assert.equal(repo.git('log', '-1', '--format=%an <%ae>', b.commit), `${ID.name} <${ID.email}>`);
  assert.equal(repo.git('log', '-1', '--format=%cn <%ce>', b.commit), `${ID.name} <${ID.email}>`);
  assert.equal(repo.git('log', '-1', '--format=%s', b.commit), 'T-1: Do the thing');
  const body = repo.git('log', '-1', '--format=%b', b.commit);
  assert.match(body, /What: Added the thing/); assert.match(body, /How: By editing two files/); assert.match(body, /From Helm/);
  assert.doesNotMatch(repo.git('log', '-1', '--format=%B', b.commit), /co-authored-by/i);
  assert.equal(repo.git('config', '--local', 'user.email'), ID.email, 'local config not rewritten');

  // the user's working tree, current branch and HEAD are exactly as they were
  assert.deepEqual(snapshot(repo), { ...before, branches: 'refs/heads/' + b.name + '\n' + before.branches });
  assert.equal(fs.readFileSync(path.join(repo.dir, 'other.txt'), 'utf8'), 'USER EDIT\n');
  assert.equal(task(h, id).branch.commit, b.commit, 'on the task row');

  // one branch per task
  const again = await h.api('POST', `/v1/tasks/${id}/branch`);
  assert.equal(again.status, 409);
  assert.match(again.json.error, /already has a branch/);
  assert.equal((await h.api('POST', '/v1/tasks/T-99/branch')).status, 404);
});

test('create branch: refusals and warnings', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'one\n', '.gitignore': 'ignored.log\n' });
  const id = taskIn(h, repo, ['a.txt']);
  // nothing changed yet -> nothing to commit, and nothing is left behind
  const none = await h.api('POST', `/v1/tasks/${id}/branch`);
  assert.equal(none.status, 409);
  assert.match(none.json.error, /nothing to commit/);
  assert.equal(task(h, id).branch, null);
  assert.equal(fs.readdirSync(path.join(h.home, 'worktrees')).length, 0, 'failed attempt removed its worktree');
  assert.equal(repo.git('branch', '--list', 'helm/*'), '', 'and its branch');
  assert.equal(repo.git('worktree', 'list').split('\n').length, 1);

  // a task with no git info / no files
  h.send(h.ev('s2', 'session.started', { cwd: '/w', title: 'X', model: 'm' }),
    h.ev('s2', 'agent.spawned', { toolUseId: 'x', subagentType: 'g', description: 'No repo' }), h.ev('s2', 'agent.bound', { toolUseId: 'x', agentId: 'agx' }));
  const other = h.hub.p.getAgent('agx').task_id;
  assert.equal((await h.api('POST', `/v1/tasks/${other}/branch`)).status, 409);
  assert.equal((await h.get(`/v1/tasks/${other}/git`)).json.eligible, false);

  // an edit after the task ended and a file the task never touched in the snapshot -> warnings, but it continues
  repo.write('a.txt', 'one\ntwo\n');
  await h.hub.snapshotTask(id);
  await new Promise((r) => setTimeout(r, 20));
  repo.write('a.txt', 'one\ntwo\nthree\n'); // edited after the snapshot
  const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(repo.dir, 'a.txt'), later, later);
  const ok = await h.api('POST', `/v1/tasks/${id}/branch`);
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.json.warnings.some((w) => /a\.txt changed after the task ended/.test(w)), JSON.stringify(ok.json.warnings));
  assert.ok(ok.json.warnings.some((w) => /differ from the diff recorded/.test(w)), JSON.stringify(ok.json.warnings));
  assert.equal(repo.git('show', `${ok.json.branch.commit}:a.txt`), 'one\ntwo\nthree');
});

test('create branch: ignored and outside files are skipped, a leftover branch name is refused', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'one\n', '.gitignore': 'ignored.log\n' });
  const outside = path.join(tmpDir('helm-out-'), 'x.txt'); fs.writeFileSync(outside, 'x'); t.after(() => fs.rmSync(path.dirname(outside), { recursive: true, force: true }));
  const id = taskIn(h, repo, ['a.txt', 'ignored.log', outside, '../escape.txt']);
  repo.write('a.txt', 'changed\n'); repo.write('ignored.log', 'log\n');
  repo.git('branch', 'helm/T-1-do-the-thing');
  const clash = await h.api('POST', `/v1/tasks/${id}/branch`);
  assert.equal(clash.status, 409); assert.match(clash.json.error, /already exists/);
  assert.ok(!fs.existsSync(path.join(h.home, 'worktrees')) || fs.readdirSync(path.join(h.home, 'worktrees')).length === 0);
  repo.git('branch', '-D', 'helm/T-1-do-the-thing');
  const r = await h.api('POST', `/v1/tasks/${id}/branch`);
  assert.equal(r.status, 200, r.text);
  assert.equal(repo.git('show', '--name-only', '--format=', r.json.branch.commit), 'a.txt');
  assert.ok(r.json.warnings.some((w) => /ignored\.log was skipped \(ignored/.test(w)));
  assert.ok(r.json.warnings.some((w) => /x\.txt was skipped \(outside the repo\)/.test(w)));
  assert.ok(r.json.warnings.some((w) => /escape\.txt was skipped \(outside the repo\)/.test(w)));
});

test('update branch: re-copies the files and adds a commit; nothing new is reported, not committed', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'one\n', 'b.txt': 'b\n' });
  const id = taskIn(h, repo, ['a.txt']);
  repo.write('a.txt', 'v2\n');
  const first = (await h.api('POST', `/v1/tasks/${id}/branch`)).json.branch;
  const same = await h.api('POST', `/v1/tasks/${id}/branch/update`);
  assert.equal(same.status, 200);
  assert.equal(same.json.unchanged, true);
  assert.equal(task(h, id).branch.commit, first.commit);

  repo.write('a.txt', 'v3\n'); repo.write('b.txt', 'b2\n');
  h.send(h.ev('s1', 'tool.finished', { agentId: 'ag1', tool: 'Edit', ok: true, summary: 'e', files: ['b.txt'] })); // the task grew a file
  const before = snapshot(repo);
  const up = await h.api('POST', `/v1/tasks/${id}/branch/update`);
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.unchanged, false);
  assert.notEqual(up.json.branch.commit, first.commit);
  assert.equal(repo.git('rev-parse', `${up.json.branch.commit}^`), first.commit, 'a new commit on top, history kept');
  assert.equal(repo.git('log', '-1', '--format=%s', up.json.branch.commit), 'T-1: Do the thing (update)');
  assert.equal(repo.git('show', `${up.json.branch.commit}:b.txt`), 'b2');
  assert.deepEqual(snapshot(repo), before);
  assert.equal((await h.api('POST', '/v1/tasks/T-1/branch/update')).status, 200);
  h.send(h.ev('s2', 'session.started', { cwd: '/w', title: 'X', model: 'm' }), h.ev('s2', 'agent.spawned', { toolUseId: 'x', subagentType: 'g', description: 'Other' }),
    h.ev('s2', 'agent.bound', { toolUseId: 'x', agentId: 'agx' }));
  assert.equal((await h.api('POST', `/v1/tasks/${h.hub.p.getAgent('agx').task_id}/branch/update`)).status, 409);
});

test('push: needs confirm, pushes to the bare origin, never force, GitHub compare URL for github remotes', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const origin = bareOrigin(t);
  const repo = makeRepo(t, { 'a.txt': 'one\n' });
  repo.git('remote', 'add', 'origin', origin);
  const id = taskIn(h, repo, ['a.txt']);
  repo.write('a.txt', 'two\n');
  assert.equal((await h.api('POST', `/v1/tasks/${id}/push`, { confirm: true })).status, 409, 'no branch yet');
  const b = (await h.api('POST', `/v1/tasks/${id}/branch`)).json.branch;

  assert.equal((await h.api('POST', `/v1/tasks/${id}/push`, {})).status, 400, 'confirm is required');
  assert.equal((await h.api('POST', `/v1/tasks/${id}/push`, { confirm: 'yes' })).status, 400);
  assert.equal((await h.api('POST', `/v1/tasks/${id}/push`, { confirm: true, remote: '--upload-pack=x' })).status, 400, 'remote names are validated');
  assert.equal((await h.api('POST', `/v1/tasks/${id}/push`, { confirm: true, remote: 'nope' })).status, 409);
  assert.equal(execFileSync('git', ['branch', '--list'], { cwd: origin, encoding: 'utf8' }).trim(), '', 'nothing pushed yet');

  const info = (await h.get(`/v1/tasks/${id}/git`)).json;
  assert.deepEqual(info.remotes.map((r) => [r.name, r.url, r.github]), [['origin', origin, false]]);

  const r = await h.api('POST', `/v1/tasks/${id}/push`, { confirm: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.branch.remote, 'origin');
  assert.equal(r.json.branch.prUrl, null, 'a non-GitHub host gets no compare URL, just "pushed"');
  assert.ok(r.json.branch.pushedAt > 0);
  assert.equal(r.json.branch.pushedCommit, b.commit);
  assert.equal(execFileSync('git', ['rev-parse', b.name], { cwd: origin, encoding: 'utf8' }).trim(), b.commit, 'the bare origin has the branch');
  assert.equal(repo.git('rev-parse', '--abbrev-ref', `${b.name}@{upstream}`), `origin/${b.name}`, 'upstream set by -u');
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'main', "the user's branch is untouched");

  // update + push again: fast-forward
  repo.write('a.txt', 'three\n');
  const up = (await h.api('POST', `/v1/tasks/${id}/branch/update`)).json.branch;
  assert.equal(up.ci, null);
  assert.equal(task(h, id).branch.pushedCommit, b.commit, 'the unpushed commit is visible: commit != pushedCommit');
  const r2 = await h.api('POST', `/v1/tasks/${id}/push`, { confirm: true });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(execFileSync('git', ['rev-parse', b.name], { cwd: origin, encoding: 'utf8' }).trim(), up.commit);
});

test('push to a GitHub-looking remote: compare URL from origin/HEAD, falling back to main, master', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const origin = bareOrigin(t);
  const repo = makeRepo(t, { 'a.txt': 'one\n' });
  // the remote *looks like* GitHub but pushInsteadOf sends the bytes to the local bare repo (no network)
  repo.git('remote', 'add', 'origin', 'https://user:tok3n@github.com/acme/widgets.git');
  repo.git('config', `url.${origin}.pushInsteadOf`, 'https://user:tok3n@github.com/acme/widgets.git');
  const id = taskIn(h, repo, ['a.txt']);
  repo.write('a.txt', 'two\n');
  const b = (await h.api('POST', `/v1/tasks/${id}/branch`)).json.branch;

  const info = (await h.get(`/v1/tasks/${id}/git`)).json;
  assert.equal(info.remotes[0].url, 'https://github.com/acme/widgets.git', 'credentials never leave the hub');
  assert.equal(info.remotes[0].pushUrl, origin, 'the dialog also gets the URL the push really goes to');
  assert.equal(info.remotes[0].github, true);

  // 1) origin/HEAD says "trunk"
  repo.git('update-ref', 'refs/remotes/origin/trunk', repo.head);
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  const r = await h.api('POST', `/v1/tasks/${id}/push`, { confirm: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.compareUrl, `https://github.com/acme/widgets/compare/trunk...${b.name}?expand=1`);
  assert.equal(r.json.branch.prUrl, r.json.compareUrl);
  assert.equal(r.json.branch.github, 'acme/widgets');
  assert.ok(!JSON.stringify(h.state()).includes('tok3n'), 'no credential in state');

  // 2) no origin/HEAD: main, then master
  const { defaultBranchOf } = await import('../gitflow.mjs');
  repo.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  assert.equal(await defaultBranchOf(repo.dir, 'origin'), 'main');
  repo.git('update-ref', '-d', 'refs/remotes/origin/main');
  repo.git('update-ref', 'refs/remotes/origin/master', repo.head);
  assert.equal(await defaultBranchOf(repo.dir, 'origin'), 'master');
});

test('a failing push surfaces a clear error and records nothing', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'one\n' });
  repo.git('remote', 'add', 'origin', path.join(tmpDir('helm-nowhere-'), 'missing.git'));
  const id = taskIn(h, repo, ['a.txt']);
  repo.write('a.txt', 'two\n');
  await h.api('POST', `/v1/tasks/${id}/branch`);
  const r = await h.api('POST', `/v1/tasks/${id}/push`, { confirm: true });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /push to origin .* failed/);
  assert.equal(task(h, id).branch.pushedAt, null);
});

test('link a PR by URL: validated against the pushed repo, unlink with null', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { id } = await githubTask(t, h);
  assert.equal((await h.api('POST', `/v1/tasks/${id}/pr`, { url: 'https://github.com/other/thing/pull/5' })).status, 400);
  assert.equal((await h.api('POST', `/v1/tasks/${id}/pr`, { url: 'https://gitlab.com/acme/widgets/pull/5' })).status, 400);
  assert.equal((await h.api('POST', `/v1/tasks/${id}/pr`, { url: 'not a url' })).status, 400);
  assert.equal((await h.api('POST', `/v1/tasks/${id}/pr`, {})).status, 400);
  const r = await h.api('POST', `/v1/tasks/${id}/pr`, { url: 'https://github.com/Acme/Widgets/pull/42' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.branch.pr, { number: 42, url: 'https://github.com/Acme/Widgets/pull/42', state: 'open', merged: false });
  assert.deepEqual(task(h, id).branch.pr.number, 42);
  const off = await h.api('POST', `/v1/tasks/${id}/pr`, { url: null });
  assert.equal(off.json.branch.pr, null);
  assert.equal((await h.api('POST', '/v1/tasks/T-77/pr', { url: 'https://github.com/a/b/pull/1' })).status, 404);
});

test('CI summarisation from fixture JSON', () => {
  const run = (name, status, conclusion) => ({ name, status, conclusion, html_url: `https://github.com/acme/widgets/runs/${name}` });
  const S = (runs) => summariseChecks({ check_runs: runs }, 5);
  assert.deepEqual(S([]), { state: 'none', checks: [], updatedAt: 5 });
  assert.equal(S([run('a', 'completed', 'success'), run('b', 'completed', 'skipped'), run('c', 'completed', 'neutral')]).state, 'success');
  assert.equal(S([run('a', 'completed', 'success'), run('b', 'in_progress', null)]).state, 'pending');
  assert.equal(S([run('a', 'queued', null)]).state, 'pending');
  assert.equal(S([run('a', 'completed', 'failure'), run('b', 'in_progress', null)]).state, 'failure', 'fails fast');
  assert.equal(S([run('a', 'completed', 'timed_out')]).state, 'failure');
  assert.equal(S([run('a', 'completed', 'cancelled')]).state, 'failure');
  const s = S([run('lint', 'completed', 'success')]);
  assert.deepEqual(s.checks, [{ name: 'lint', status: 'completed', conclusion: 'success', url: 'https://github.com/acme/widgets/runs/lint' }]);
  assert.equal(summariseChecks({ check_runs: [{ name: 'x', status: 'completed', conclusion: 'success', html_url: 'javascript:alert(1)' }] }).checks[0].url, null);
  assert.equal(summariseChecks(null).state, 'none');
});

/** A pushed task whose remote looks like GitHub (pushes land in a bare repo). */
async function githubTask(t, h, n = 1) {
  const origin = bareOrigin(t);
  const repo = makeRepo(t, { 'a.txt': 'one\n' });
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  repo.git('config', `url.${origin}.pushInsteadOf`, 'git@github.com:acme/widgets.git');
  const id = taskIn(h, repo, ['a.txt'], { n });
  repo.write('a.txt', 'two\n');
  await h.api('POST', `/v1/tasks/${id}/branch`);
  const r = await h.api('POST', `/v1/tasks/${id}/push`, { confirm: true });
  assert.equal(r.status, 200, r.text);
  return { id, repo, origin, branch: r.json.branch };
}
const reply = (status, json, headers = {}) => ({ status, json: async () => json, headers: new Headers(headers) });
const checks = (...runs) => ({ check_runs: runs.map(([name, status, conclusion]) => ({ name, status, conclusion, html_url: `https://github.com/acme/widgets/runs/${name}` })) });

test('CI polling: pending -> success, recorded as hub.task.ci events; stops when finished; replays on rebuild', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { id, branch } = await githubTask(t, h);
  const calls = [];
  let body = checks(['build', 'in_progress', null], ['lint', 'completed', 'success']);
  h.hub.gitSync.fetchImpl = async (url, init) => {
    calls.push({ url, ua: init.headers['User-Agent'] });
    if (url.includes('/check-runs')) return reply(200, body);
    if (url.includes('/pulls')) return reply(200, []);
    return reply(404, {});
  };
  const T0 = 1_000_000;
  await h.hub.gitSync.tick(T0);
  assert.ok(calls.every((c) => c.ua === 'helm-local'));
  assert.ok(calls[0].url.endsWith(`/repos/acme/widgets/commits/${branch.commit}/check-runs?per_page=100`), calls[0].url);
  assert.ok(calls.some((c) => c.url.includes(`/repos/acme/widgets/pulls?head=acme%3A${encodeURIComponent(branch.name)}&state=all`)), 'looks for an unlinked PR');
  let ci = task(h, id).branch.ci;
  assert.equal(ci.state, 'pending');
  assert.deepEqual(ci.checks.map((c) => [c.name, c.status, c.conclusion]), [['build', 'in_progress', null], ['lint', 'completed', 'success']]);

  const n = calls.length;
  await h.hub.gitSync.tick(T0 + 60_000);
  assert.equal(calls.length, n, 'not due again before 2 minutes');
  const evCount = () => h.hub.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'hub.task.ci'").n;
  const e1 = evCount();
  await h.hub.gitSync.tick(T0 + 121_000);
  assert.equal(evCount(), e1, 'an unchanged result does not grow the log');

  body = checks(['build', 'completed', 'success'], ['lint', 'completed', 'success']);
  await h.hub.gitSync.tick(T0 + 250_000);
  ci = task(h, id).branch.ci;
  assert.equal(ci.state, 'success');
  assert.equal(ci.updatedAt, T0 + 250_000);
  const m = calls.length;
  await h.hub.gitSync.tick(T0 + 900_000);
  assert.ok(!calls.slice(m).some((c) => c.url.includes('/check-runs')), 'finished: no more CI polling');

  const before = h.hub.dump();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before, 'rebuild replays branch + ci events identically');
  assert.equal(task(h, id).branch.ci.state, 'success');
});

test('CI polling: private repo -> unknown and stop; rate limit backs off; failures stop; refresh recovers', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { id } = await githubTask(t, h);
  let mode = 'private';
  const calls = [];
  h.hub.gitSync.fetchImpl = async (url) => {
    calls.push(url);
    if (mode === 'private') return reply(404, { message: 'Not Found' });
    if (mode === 'limit') return reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
    if (mode === 'down') throw new Error('socket hang up');
    return url.includes('/check-runs') ? reply(200, checks(['x', 'completed', 'failure'])) : reply(200, []);
  };
  const T0 = 5_000_000;
  await h.hub.gitSync.tick(T0);
  assert.equal(task(h, id).branch.ci.state, 'unknown');
  assert.match(task(h, id).branch.ci.reason, /private or not found/);
  const n = calls.length;
  await h.hub.gitSync.tick(T0 + 10 * 60_000);
  assert.ok(!calls.slice(n).some((u) => u.includes('/check-runs')), 'unknown stops the CI polling');

  // refresh clears unknown and polls now; a 403 backs the whole poller off
  mode = 'limit';
  await h.hub.gitSync.refresh(id, T0 + 20 * 60_000);
  assert.ok(h.hub.gitSync.backoffUntil >= T0 + 20 * 60_000 + 5 * 60_000);
  assert.equal(task(h, id).branch.ci, null, 'a rate limit leaves the state alone');
  const k = calls.length;
  await h.hub.gitSync.tick(T0 + 21 * 60_000);
  assert.equal(calls.length, k, 'backed off');
  mode = 'ok';
  await h.hub.gitSync.refresh(id, T0 + 40 * 60_000);
  assert.equal(task(h, id).branch.ci.state, 'failure');

  // network failures: three in a row -> unknown with a reason
  const r = await githubTask(t, h, 2);
  mode = 'down';
  for (let i = 0; i < 3; i++) await h.hub.gitSync.tick(T0 + (50 + i * 3) * 60_000);
  assert.equal(task(h, r.id).branch.ci.state, 'unknown');
  assert.match(task(h, r.id).branch.ci.reason, /could not be reached/);
});

test('PR polling: finds the PR for the branch, then follows open -> merged; refresh endpoint', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { id, branch } = await githubTask(t, h);
  let pr = { number: 7, html_url: 'https://github.com/acme/widgets/pull/7', state: 'open', merged_at: null };
  const urls = [];
  h.hub.gitSync.fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/check-runs')) return reply(200, checks());
    if (/\/pulls\/7$/.test(url)) return reply(200, pr);
    return reply(200, [pr]);
  };
  await h.hub.gitSync.tick(10_000_000);
  assert.deepEqual(task(h, id).branch.pr, { number: 7, url: 'https://github.com/acme/widgets/pull/7', state: 'open', merged: false });
  assert.equal(task(h, id).branch.ci.state, 'none');
  pr = { ...pr, state: 'closed', merged_at: '2026-01-01T00:00:00Z' };
  await h.hub.gitSync.tick(10_000_000 + 60_000);
  assert.equal(task(h, id).branch.pr.state, 'open', 'a linked PR is only re-read every 10 minutes');
  await h.hub.gitSync.tick(10_000_000 + 11 * 60_000);
  assert.deepEqual(task(h, id).branch.pr, { number: 7, url: 'https://github.com/acme/widgets/pull/7', state: 'closed', merged: true });
  assert.ok(urls.some((u) => u.endsWith('/pulls/7')));
  const n = urls.length;
  await h.hub.gitSync.tick(10_000_000 + 60 * 60_000);
  assert.ok(!urls.slice(n).some((u) => u.includes('/pulls')), 'merged: done');
  const r = await h.api('POST', `/v1/tasks/${id}/ci/refresh`);
  assert.equal(r.status, 200);
  assert.equal(branch.name.startsWith('helm/'), true);
});

test('clean up: removes the worktree, keeps or deletes the local branch, never a remote one', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { id, repo, origin, branch } = await githubTask(t, h);
  assert.ok(fs.existsSync(branch.worktree));
  const before = snapshot(repo);

  const kept = await h.api('DELETE', `/v1/tasks/${id}/branch`);
  assert.equal(kept.status, 200, kept.text);
  assert.equal(kept.json.branchDeleted, false);
  assert.ok(!fs.existsSync(branch.worktree));
  assert.equal(repo.git('worktree', 'list').split('\n').length, 1);
  assert.match(repo.git('branch', '--list', branch.name), /helm\/T-1/, 'branch kept');
  assert.equal(task(h, id).branch.worktree, null);
  assert.equal(task(h, id).branch.name, branch.name);
  assert.deepEqual(snapshot(repo).status, before.status);

  // Update branch re-adds the worktree for the kept branch
  repo.write('a.txt', 'three\n');
  const up = await h.api('POST', `/v1/tasks/${id}/branch/update`);
  assert.equal(up.status, 200, up.text);
  assert.ok(fs.existsSync(up.json.branch.worktree));

  // not pushed yet (the update is local only): -d refuses the unmerged tip unless forced... the upstream has the old tip
  const refused = await h.api('DELETE', `/v1/tasks/${id}/branch?deleteBranch=1`);
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /not fully merged|kept/);
  assert.equal(task(h, id).branch.worktree, null, 'the worktree was removed, the branch kept, and the record says so');
  const forced = await h.api('DELETE', `/v1/tasks/${id}/branch?deleteBranch=1&force=1`);
  assert.equal(forced.status, 200, forced.text);
  assert.equal(forced.json.branchDeleted, true);
  assert.equal(repo.git('branch', '--list', 'helm/*'), '');
  assert.equal(task(h, id).branch, null);
  assert.equal(execFileSync('git', ['branch', '--list'], { cwd: origin, encoding: 'utf8' }).includes(branch.name), true, 'the remote branch is never deleted');
  assert.equal((await h.api('DELETE', `/v1/tasks/${id}/branch`)).status, 409);
  assert.equal(repo.git('rev-parse', 'HEAD'), before.head);
});

test('safety: a recorded worktree outside $HELM_HOME/worktrees is never touched', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const repo = makeRepo(t, { 'a.txt': 'one\n' });
  const id = taskIn(h, repo, ['a.txt']);
  const victim = fs.realpathSync(tmpDir('helm-victim-')); fs.writeFileSync(path.join(victim, 'precious.txt'), 'keep');
  t.after(() => fs.rmSync(victim, { recursive: true, force: true }));
  h.hub.tx(() => h.hub.command('hub.task.branch', { taskId: id, branch: {
    name: 'helm/T-1-x', root: repo.dir, worktree: victim, commit: repo.head, base: repo.head, remote: null, pushedAt: null, prUrl: null, pr: null, ci: null } }, Date.now()));
  const r = await h.api('DELETE', `/v1/tasks/${id}/branch`);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /outside the Helm worktrees/);
  assert.ok(fs.existsSync(path.join(victim, 'precious.txt')));
  // a root that is not a repo top level is refused too
  fs.mkdirSync(path.join(repo.dir, 'sub'));
  h.hub.tx(() => h.hub.command('hub.task.branch', { taskId: id, patch: { root: path.join(repo.dir, 'sub'), worktree: null } }, Date.now()));
  assert.equal((await h.api('POST', `/v1/tasks/${id}/branch/update`)).status, 409);
});

test('rebuild reproduces branch state; migration adds the column to an old database', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const { id } = await githubTask(t, h);
  await h.api('POST', `/v1/tasks/${id}/pr`, { url: 'https://github.com/acme/widgets/pull/9' });
  h.hub.tx(() => h.hub.command('hub.task.ci', { taskId: id, ci: { state: 'failure', checks: [{ name: 'ci', status: 'completed', conclusion: 'failure', url: null }], updatedAt: 1 } }, 1));
  const before = h.hub.dump(), stateBefore = h.state();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
  assert.equal(task(h, id).branch.pr.number, 9);
  assert.equal(task(h, id).branch.ci.state, 'failure');

  const home = tmpDir('helm-mig-'); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cfg = loadConfig({ home, port: 0, singleton: false, sweep: false, remote: false });
  let hub = new Hub(cfg, { info() {}, warn() {}, error() {} });
  hub.ingest([{ sessionId: 's1', seq: 1, type: 'session.started', at: 1, data: { cwd: '/w/p', title: 'S', model: 'm' } }]);
  hub.close();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(cfg.dbFile); raw.exec('ALTER TABLE tasks DROP COLUMN branch'); raw.close();
  for (let i = 0; i < 2; i++) { // second open proves idempotence
    hub = new Hub(cfg, { info() {}, warn() {}, error() {} });
    assert.deepEqual(hub.state().tasks.map((x) => x.branch), hub.state().tasks.map(() => null));
    if (i === 0) hub.close();
  }
  hub.close();
});

test('a GitSync with no fetch stub never touches the network when nothing is pushed', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const s = new GitSync(h.hub, { fetchImpl: () => { throw new Error('network!'); } });
  assert.deepEqual(await s.tick(), { polled: 0 });
});
