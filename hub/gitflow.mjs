// Branch per task (v0.12): create a branch + commit from a task's changed files, push it, parse remotes, summarise CI.
//
// Safety rules (the user's real repos are on the other end of this):
//  - git runs through execFile only (no shell), with a timeout, and with GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE removed
//    from the environment so a stray variable can never point a command at another repo.
//  - The user's working tree and current branch are never touched. Everything happens in a linked worktree under
//    $HELM_HOME/worktrees/T-n, created with `git worktree add --detach` at the task's recorded HEAD.
//  - Files are copied FROM the working tree INTO the worktree, after realpath checks on both ends.
//  - Pushing is a separate, explicit step (see Hub.pushBranch) and never forces. Remote branches are never deleted.
//  - No tokens: pushes use whatever credential helper / ssh agent the user already has. URLs are stored without credentials.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HttpError } from './errors.mjs';
import { within, realpathLoose } from './diff.mjs';

export const LOCAL_TIMEOUT_MS = 20_000;
export const PUSH_TIMEOUT_MS = 60_000;
const MAX_FILES = 500;
const HEX = /^[0-9a-f]{7,64}$/i;
const CFG = ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']; // local plumbing never runs the user's hooks (push keeps them: LFS needs pre-push)
const redact = (s) => String(s || '').replace(/(:\/\/)[^@/\s]+@/g, '$1');

function env(literal = true) {
  const e = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(literal ? { GIT_LITERAL_PATHSPECS: '1' } : {}), LC_ALL: 'C', GIT_PAGER: 'cat' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']) delete e[k];
  if (!e.GIT_SSH_COMMAND && !e.GIT_SSH) e.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'; // no tty: never wait on a prompt
  return e;
}

/** Run git. Resolves { code, text }; throws an HttpError (message carries git's first stderr line) unless the exit code is in okCodes. */
export function git(cwd, args, { timeout = LOCAL_TIMEOUT_MS, okCodes = [0], status = 500, hooks = false, input = null, literal = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...CFG, ...(hooks ? [] : NO_HOOKS), ...args], {
      cwd, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: env(literal), windowsHide: true,
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, text: stdout });
      if (err.code === 'ENOENT' && /spawn/.test(err.syscall || '')) return reject(new HttpError(500, 'git is not installed'));
      if (err.killed || err.signal === 'SIGTERM') return reject(new HttpError(504, `git ${args[0]} timed out after ${Math.round(timeout / 1000)}s`));
      const code = typeof err.code === 'number' ? err.code : -1;
      if (okCodes.includes(code)) return resolve({ code, text: stdout });
      const msg = redact(String(stderr || err.message || '').trim().split('\n').find((l) => l.trim()) || `git ${args[0]} failed`);
      const e = new HttpError(status, `git ${args[0]}: ${msg}`.slice(0, 400));
      e.stderr = redact(stderr);
      return reject(e);
    });
    if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

// ------------------------------------------------------------------ names and remotes
export function slugify(title) {
  const s = String(title || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'task';
}
export const branchNameFor = (taskId, title) => `helm/${taskId}-${slugify(title)}`;

const SEG = '[A-Za-z0-9_.-]+';
const REMOTE_RES = [
  new RegExp(`^(?:https?|git)://(?:[^@/]+@)?([^/:]+)(?::\\d+)?/(${SEG})/(${SEG}?)(?:\\.git)?/?$`, 'i'),     // https / git
  new RegExp(`^ssh://(?:[^@/]+@)?([^/:]+)(?::\\d+)?/(${SEG})/(${SEG}?)(?:\\.git)?/?$`, 'i'),                // ssh://git@host[:port]/o/r.git
  new RegExp(`^(?:[^@/\\s]+@)?([^/:\\s]+):(${SEG})/(${SEG}?)(?:\\.git)?/?$`, 'i'),                          // git@host:o/r.git
];
/** Parse a git remote URL -> { host, owner, repo, github, url } (url has credentials stripped), or { host: null, github: false, url }. */
export function parseRemote(raw) {
  const url = redact(String(raw || '').trim());
  for (const re of REMOTE_RES) {
    const m = re.exec(url);
    if (m) {
      const host = m[1].toLowerCase();
      const github = host === 'github.com' || host === 'www.github.com';
      return { host, owner: m[2], repo: m[3], github, url };
    }
  }
  return { host: null, owner: null, repo: null, github: false, url };
}
export function compareUrl(parsed, defaultBranch, branch) {
  if (!parsed || !parsed.github) return null;
  const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${parsed.owner}/${parsed.repo}/compare/${enc(defaultBranch)}...${enc(branch)}?expand=1`;
}
/** A pasted PR URL -> { host, owner, repo, number } (number null when the URL has none). Throws 400 for anything that is not http(s). */
export function parsePrUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new HttpError(400, 'url must be a valid http(s) URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'url must be an http(s) URL');
  const m = /^\/([^/]+)\/([^/]+)\/(?:pull|pulls|merge_requests)\/(\d+)(?:\/|$)/.exec(u.pathname);
  u.username = ''; u.password = ''; u.hash = '';
  return { host: u.hostname.toLowerCase(), owner: m ? m[1] : null, repo: m ? m[2] : null, number: m ? Number(m[3]) : null, url: u.toString() };
}

// ------------------------------------------------------------------ CI
const FAIL = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const OK = new Set(['success', 'neutral', 'skipped']);
/** Summarise GitHub's check-runs JSON -> { state: 'pending'|'success'|'failure'|'none', checks, updatedAt }. */
export function summariseChecks(json, now = Date.now()) {
  const runs = Array.isArray(json && json.check_runs) ? json.check_runs : [];
  const checks = runs.slice(0, 100).map((r) => ({
    name: String(r.name || '').slice(0, 120), status: String(r.status || ''), conclusion: r.conclusion == null ? null : String(r.conclusion),
    url: typeof r.html_url === 'string' && /^https:\/\//.test(r.html_url) ? r.html_url : null,
  }));
  let state = 'none';
  if (checks.length) {
    if (checks.some((c) => c.status === 'completed' && FAIL.has(c.conclusion))) state = 'failure';
    else if (checks.every((c) => c.status === 'completed' && OK.has(c.conclusion))) state = 'success';
    else state = 'pending';
  }
  return { state, checks, updatedAt: now };
}

// ------------------------------------------------------------------ paths
export const worktreesDir = (home) => path.join(home, 'worktrees');

/** The repo root as a real path, verified to be the top level of a git work tree. */
export async function resolveRepo(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new HttpError(409, 'this task has no usable repo root');
  let real;
  try { real = fs.realpathSync(root); } catch { throw new HttpError(409, `the repo at ${root} no longer exists`); }
  let top;
  try { top = (await git(real, ['rev-parse', '--show-toplevel'], { status: 409 })).text.trim(); } catch (e) {
    if (e.status === 409) throw new HttpError(409, `${root} is not a git repository`);
    throw e;
  }
  let topReal;
  try { topReal = fs.realpathSync(top); } catch { topReal = top; }
  if (topReal !== real) throw new HttpError(409, `${root} is not the top level of its git repository`);
  return real;
}
/** The worktree path for a task, created lazily. Refuses anything that resolves outside $HELM_HOME/worktrees. */
export function worktreePathFor(home, taskId) {
  if (!/^T-\d+$/.test(taskId)) throw new HttpError(400, 'invalid task id');
  fs.mkdirSync(worktreesDir(home), { recursive: true });
  const base = fs.realpathSync(worktreesDir(home));
  return path.join(base, taskId);
}
/** A recorded worktree path must still sit under $HELM_HOME/worktrees (real path), else we refuse to touch it. */
export function assertUnderWorktrees(home, wt) {
  const base = realpathLoose(worktreesDir(home));
  const real = realpathLoose(wt);
  if (!within(base, real) || real === base) throw new HttpError(409, 'refusing to touch a path outside the Helm worktrees directory');
  return real;
}

// ------------------------------------------------------------------ copying a task's files into the worktree
/**
 * Copy the task's changed files from the repo's working tree into the worktree; files deleted in the working tree are `git rm`'d.
 * Returns { copied: rel[], removed: rel[], skipped: [{path, reason}], warnings: string[] }. Stages everything it keeps.
 */
async function syncFiles({ repo, wt, files, doneAt }) {
  const wtReal = fs.realpathSync(wt);
  const list = [...new Set((Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f && !f.includes('\0')))].slice(0, MAX_FILES);
  const copied = [], removed = [], skipped = [], warnings = [];
  for (const raw of list) {
    const lex = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repo, raw);
    const real = realpathLoose(lex);
    if (!within(repo, real) || real === repo) { skipped.push({ path: raw, reason: 'outside the repo' }); continue; }
    const rel = path.relative(repo, real).split(path.sep).join('/');
    if (rel === '.git' || rel.startsWith('.git/')) { skipped.push({ path: raw, reason: 'inside .git' }); continue; }
    let st = null;
    try { st = fs.lstatSync(real); } catch { /* deleted */ }
    if (!st) { removed.push(rel); continue; }
    if (st.isSymbolicLink()) { skipped.push({ path: raw, reason: 'symlink' }); continue; }
    if (!st.isFile()) { skipped.push({ path: raw, reason: 'not a regular file' }); continue; }
    const dest = path.join(wtReal, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!within(wtReal, fs.realpathSync(path.dirname(dest)))) { skipped.push({ path: raw, reason: 'destination escapes the worktree' }); continue; }
    fs.copyFileSync(real, dest);
    copied.push(rel);
    if (doneAt && st.mtimeMs > doneAt) warnings.push(`${rel} changed after the task ended`);
  }
  // Ignored files cannot be added (and would abort the whole `git add`): drop them with a note.
  let keep = copied;
  if (copied.length) {
    const r = await git(wtReal, ['check-ignore', '-z', '--stdin'], { okCodes: [0, 1], literal: false, input: copied.join('\0') + '\0' });
    const ignored = new Set(r.text.split('\0').filter(Boolean));
    if (ignored.size) {
      keep = copied.filter((c) => !ignored.has(c));
      for (const i of ignored) { skipped.push({ path: i, reason: 'ignored by .gitignore' }); fs.rmSync(path.join(wtReal, i), { force: true }); }
    }
  }
  for (let i = 0; i < keep.length; i += 100) await git(wtReal, ['add', '--', ...keep.slice(i, i + 100)]);
  for (let i = 0; i < removed.length; i += 100) await git(wtReal, ['rm', '-q', '-f', '--ignore-unmatch', '--', ...removed.slice(i, i + 100)]);
  for (const s of skipped) warnings.push(`${s.path} was skipped (${s.reason})`);
  return { copied: keep, removed, skipped, warnings };
}

async function hasStaged(wt) {
  const r = await git(wt, ['diff', '--cached', '--quiet'], { okCodes: [0, 1] });
  return r.code === 1;
}
async function commitStaged(wt, subject, body) {
  try {
    // Uses the repo's own identity (local config, falling back to the user's global config). Nothing about it is overridden.
    await git(wt, ['commit', '-q', '--no-verify', '-m', subject, ...(body ? ['-m', body] : [])], { status: 409 });
  } catch (e) {
    if (/tell me who you are|empty ident|unable to auto-detect|Author identity unknown/i.test(`${e.stderr || ''} ${e.message}`)) {
      throw new HttpError(409, 'git has no identity in this repo: run `git config user.name` and `git config user.email` there, then try again');
    }
    throw e;
  }
  return (await git(wt, ['rev-parse', 'HEAD'])).text.trim();
}
export function commitBody(task) {
  const r = task.recap || {};
  const lines = [];
  if (r.what) lines.push(`What: ${r.what}`);
  if (r.how) lines.push(`How: ${r.how}`);
  if (lines.length) lines.push('');
  lines.push(`From Helm (${task.id}).`);
  return lines.join('\n');
}

const branchExists = async (repo, name) => (await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${name}`], { okCodes: [0, 1] })).code === 0;

// ------------------------------------------------------------------ create / update
/**
 * Create the worktree, branch and commit for a task. Returns { record, files, warnings } (record = the Task.branch value).
 * On any failure after the worktree exists, it is removed again so a retry starts clean.
 */
export async function createBranch({ task, home, now = Date.now() }) {
  const g = task.git;
  if (!g || typeof g.root !== 'string') throw new HttpError(409, 'this task has no git info (it was not started inside a git repo)');
  const files = Array.isArray(task.filesChanged) ? task.filesChanged : [];
  if (!files.length) throw new HttpError(409, 'this task has no changed files to commit');
  const head = String(g.head || '');
  if (!HEX.test(head)) throw new HttpError(409, 'this task has no recorded HEAD to branch from');
  const repo = await resolveRepo(g.root);
  const has = await git(repo, ['cat-file', '-e', `${head}^{commit}`], { okCodes: [0, 128, 1] });
  if (has.code !== 0) throw new HttpError(409, `the base commit ${head.slice(0, 8)} is not in the repo any more`);
  const name = branchNameFor(task.id, task.title);
  await git(repo, ['check-ref-format', '--branch', name], { status: 409 });
  if (await branchExists(repo, name)) throw new HttpError(409, `a branch named ${name} already exists in the repo; delete or rename it first`);
  const wt = worktreePathFor(home, task.id);
  await git(repo, ['worktree', 'prune']);
  if (fs.existsSync(wt)) throw new HttpError(409, `${wt} already exists; remove it before creating the branch`);
  await git(repo, ['worktree', 'add', '--detach', wt, head], { status: 409 });
  try {
    const wtReal = assertUnderWorktrees(home, wt);
    await git(wtReal, ['checkout', '-q', '-b', name]);
    const sync = await syncFiles({ repo, wt: wtReal, files, doneAt: task.doneAt });
    if (!(await hasStaged(wtReal))) throw new HttpError(409, 'these files already match the base commit, so there is nothing to commit');
    const commit = await commitStaged(wtReal, `${task.id}: ${task.title}`.slice(0, 200), commitBody(task));
    const warnings = [...sync.warnings];
    if (g.base && g.base !== head) {
      const pre = (await git(repo, ['diff', '--name-only', '-z', head, g.base], { okCodes: [0, 128, 1] })).text.split('\0').filter(Boolean);
      const overlap = sync.copied.filter((c) => pre.includes(c));
      if (overlap.length) warnings.push(`${overlap.length} file${overlap.length === 1 ? '' : 's'} already had uncommitted edits when the task started, so the commit includes them: ${overlap.slice(0, 3).join(', ')}${overlap.length > 3 ? ', ...' : ''}`);
    }
    const record = {
      name, root: repo, worktree: wtReal, commit, base: head, remote: null, pushedAt: null, prUrl: null, pr: null, ci: null,
      remoteUrl: null, pushedCommit: null, createdAt: now, updatedAt: now, files: [...sync.copied, ...sync.removed],
    };
    return { record, files: record.files, warnings };
  } catch (e) {
    try { await git(repo, ['worktree', 'remove', '--force', wt]); } catch { try { fs.rmSync(wt, { recursive: true, force: true }); await git(repo, ['worktree', 'prune']); } catch { /* best effort */ } }
    try { await git(repo, ['branch', '-D', name], { okCodes: [0, 1, 128] }); } catch { /* best effort */ }
    throw e;
  }
}

/** The worktree for an existing branch record: reuse it, or re-add it (after a cleanup that kept the branch). */
async function ensureWorktree({ record, task, home }) {
  const repo = await resolveRepo(record.root);
  if (!(await branchExists(repo, record.name))) throw new HttpError(409, `branch ${record.name} no longer exists in the repo; clean up and create it again`);
  let wt = record.worktree ? assertUnderWorktrees(home, record.worktree) : worktreePathFor(home, task.id);
  if (!fs.existsSync(wt)) {
    await git(repo, ['worktree', 'prune']);
    await git(repo, ['worktree', 'add', wt, record.name], { status: 409 });
    wt = assertUnderWorktrees(home, wt);
  } else {
    const cur = (await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'], { status: 409 })).text.trim();
    if (cur !== record.name) throw new HttpError(409, `the worktree is on ${cur}, not ${record.name}`);
  }
  return { repo, wt: fs.realpathSync(wt) };
}

/** Re-copy the task's files and add a new commit. Returns { record, warnings, unchanged }. */
export async function updateBranch({ task, record, home, now = Date.now() }) {
  const { repo, wt } = await ensureWorktree({ record, task, home });
  const sync = await syncFiles({ repo, wt, files: task.filesChanged, doneAt: task.doneAt });
  if (!(await hasStaged(wt))) return { record: { ...record, worktree: wt, updatedAt: now }, warnings: sync.warnings, unchanged: true };
  const commit = await commitStaged(wt, `${task.id}: ${task.title} (update)`.slice(0, 200), commitBody(task));
  const files = [...new Set([...(record.files || []), ...sync.copied, ...sync.removed])];
  return { record: { ...record, worktree: wt, commit, updatedAt: now, ci: null, files }, warnings: sync.warnings, unchanged: false };
}

// ------------------------------------------------------------------ remotes and push
export async function listRemotes(root) {
  const repo = await resolveRepo(root);
  const names = (await git(repo, ['remote'])).text.split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const name of names) {
    const r = await git(repo, ['remote', 'get-url', name], { okCodes: [0, 2, 128, 1] });
    if (r.code !== 0) continue;
    const p = parseRemote(r.text.trim());
    // where `git push` really goes can differ (pushurl / pushInsteadOf): the confirm dialog shows both
    const pu = await git(repo, ['remote', 'get-url', '--push', name], { okCodes: [0, 2, 128, 1] });
    const pushUrl = pu.code === 0 ? parseRemote(pu.text.trim()).url : p.url;
    out.push({ name, url: p.url, ...(pushUrl !== p.url ? { pushUrl } : {}), host: p.host, github: p.github, owner: p.owner, repo: p.repo });
  }
  return out;
}
export async function defaultBranchOf(repo, remote) {
  const sym = await git(repo, ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`], { okCodes: [0, 1, 128] });
  const m = new RegExp(`^refs/remotes/${remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.+)$`).exec(sym.text.trim());
  if (sym.code === 0 && m) return m[1];
  for (const b of ['main', 'master']) {
    if ((await git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${b}`], { okCodes: [0, 1, 128] })).code === 0) return b;
  }
  return 'main';
}
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
/** Push the task's branch (never forced). Returns { remote, remoteUrl, prUrl, github, pushedCommit, pushedAt }. */
export async function pushBranch({ task, record, home, remote = 'origin', now = Date.now(), timeout = PUSH_TIMEOUT_MS }) {
  if (typeof remote !== 'string' || !REMOTE_NAME.test(remote)) throw new HttpError(400, 'invalid remote name');
  const { repo, wt } = await ensureWorktree({ record, task, home });
  const remotes = await listRemotes(repo);
  const r = remotes.find((x) => x.name === remote);
  if (!r) throw new HttpError(409, `this repo has no remote named ${remote}`);
  try {
    await git(wt, ['push', '-u', remote, record.name], { timeout, status: 502, hooks: true });
  } catch (e) {
    throw new HttpError(e.status === 504 ? 504 : 502, `push to ${remote} (${r.url}) failed: ${e.message.replace(/^git push: /, '')}`);
  }
  const commit = (await git(wt, ['rev-parse', 'HEAD'])).text.trim();
  const parsed = parseRemote(r.url);
  const def = await defaultBranchOf(repo, remote);
  return {
    remote, remoteUrl: r.url, github: parsed.github ? `${parsed.owner}/${parsed.repo}` : null,
    prUrl: compareUrl(parsed, def, record.name), pushedCommit: commit, pushedAt: now,
  };
}

// ------------------------------------------------------------------ clean up
/** Remove the worktree and optionally the local branch. Never touches remote branches. Returns { branchDeleted }. */
export async function cleanupBranch({ record, home, deleteBranch = false, force = false }) {
  const repo = await resolveRepo(record.root);
  if (record.worktree) {
    const wt = assertUnderWorktrees(home, record.worktree);
    if (fs.existsSync(wt)) {
      try { await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), wt], { status: 409 }); } catch (e) {
        throw new HttpError(409, `${e.message} (pass force to discard changes in the worktree)`);
      }
    }
    await git(repo, ['worktree', 'prune']);
  }
  let branchDeleted = false;
  if (deleteBranch && (await branchExists(repo, record.name))) {
    try { await git(repo, ['branch', force ? '-D' : '-d', record.name], { status: 409 }); branchDeleted = true; } catch (e) {
      throw new HttpError(409, `the worktree was removed but the branch was kept: ${e.message} (pass force to delete it anyway)`, { worktreeRemoved: true });
    }
  } else if (deleteBranch) branchDeleted = true; // already gone
  return { branchDeleted };
}
