// Task diffs (v0.5): what did the agent change? Pure read-only git: execFile only (no shell), 5 s per call,
// per-file and total caps, and every path must resolve inside a repo root (no `..` or symlink escapes).
//
// computeDiff(task) -> Promise<Diff>. Never rejects: a missing git binary, a non-repo path or a git failure all
// come back as { source: 'none', note }.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const GIT_TIMEOUT_MS = 5000;
export const FILE_PATCH_CAP = 120 * 1024;   // bytes of patch kept per file
export const TOTAL_PATCH_CAP = 600 * 1024;  // bytes of patch kept per diff
export const HISTORY_SLACK_MS = 10 * 60_000;
export const HISTORY_NOTE = 'approximate: no base recorded';
const MAX_FILES = 200;
const MAX_BUFFER = FILE_PATCH_CAP * 2 + 64 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HEX = /^[0-9a-f]{7,64}$/i;
const safeEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_PAGER: 'cat' });
const SAFE_CFG = ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];

class GitMissing extends Error {}

/** Run git (no shell). Resolves { code, stdout, overflow }; rejects GitMissing only when the binary is absent. */
function git(cwd, args, { okCodes = [0], buffer = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...SAFE_CFG, ...args], {
      cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'buffer', env: safeEnv(), windowsHide: true,
    }, (err, stdout) => {
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
      if (!err) return resolve({ code: 0, out, text: buffer ? '' : out.toString('utf8'), overflow: false });
      if (err.code === 'ENOENT' && !err.killed && err.syscall && /spawn/.test(err.syscall)) return reject(new GitMissing('git is not installed'));
      const overflow = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      const code = typeof err.code === 'number' ? err.code : overflow ? 0 : -1;
      if (overflow || okCodes.includes(code)) return resolve({ code, out, text: buffer ? '' : out.toString('utf8'), overflow });
      const e = new Error(String(err.message || err).split('\n')[0]);
      e.code = code;
      return reject(e);
    });
  });
}

// ------------------------------------------------------------------ paths
const within = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** realpath that tolerates a missing tail (deleted files): resolve the deepest existing ancestor, re-append the rest. */
function realpathLoose(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch {
      const up = path.dirname(cur);
      if (up === cur) return p;
      tail.push(path.basename(cur));
      cur = up;
    }
  }
}
function deepestExistingDir(p) {
  let cur = p;
  for (;;) {
    try { if (fs.statSync(cur).isDirectory()) return cur; } catch { /* keep walking */ }
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

async function repoTop(dir, cache) {
  if (cache.has(dir)) return cache.get(dir);
  let top = null;
  try {
    const r = await git(dir, ['rev-parse', '--show-toplevel'], { okCodes: [0, 128] });
    const t = r.text.trim();
    if (r.code === 0 && t) top = fs.realpathSync(t);
  } catch (e) { if (e instanceof GitMissing) throw e; }
  cache.set(dir, top);
  return top;
}

// ------------------------------------------------------------------ per-file diffs
/** Parse `--raw --numstat -z` output into [{ status, additions, deletions, binary }] keyed by path. */
function parseRawNumstat(buf) {
  const toks = buf.toString('utf8').split('\0');
  const status = new Map(), stat = new Map();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith(':')) {
      const st = t.trim().split(/\s+/).pop();
      status.set(toks[++i], st[0]);
    } else if (/^(\d+|-)\t(\d+|-)\t/.test(t)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(t);
      stat.set(m[3], { additions: m[1] === '-' ? 0 : +m[1], deletions: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-' });
    }
  }
  return { status, stat };
}

/** Keep the first FILE_PATCH_CAP bytes of a patch, cut at a line boundary. */
function capPatch(buf, overflow, budget) {
  const cap = Math.min(FILE_PATCH_CAP, Math.max(0, budget));
  if (buf.length <= cap && !overflow) return { patch: buf.toString('utf8'), truncated: false, bytes: buf.length };
  let cut = buf.subarray(0, cap);
  const nl = cut.lastIndexOf(0x0a);
  if (nl > 0) cut = cut.subarray(0, nl + 1);
  return { patch: cut.toString('utf8'), truncated: true, bytes: cut.length };
}

/**
 * Diff one path inside a repo. `a` is a commit-ish; `b` a commit-ish or null for the working tree.
 * Untracked (b == null) files go through `git diff --no-index`. Returns a file entry or null when unchanged.
 */
async function diffOne(top, rel, a, b) {
  const target = b ? [a, b] : [a];
  let r = await git(top, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--raw', '--numstat', '-z', ...target, '--', rel],
    { buffer: true });
  let { status, stat } = parseRawNumstat(r.out);
  let st = status.get(rel);
  let untracked = false;
  if (!st && !b) {
    // not in the base: untracked in the working tree?
    const u = await git(top, ['ls-files', '--others', '--exclude-standard', '-z', '--', rel], { buffer: true });
    if (u.out.toString('utf8').split('\0').includes(rel)) {
      untracked = true;
      r = await git(top, ['diff', '--no-ext-diff', '--no-textconv', '--raw', '--numstat', '-z', '--no-index', '--', '/dev/null', rel],
        { okCodes: [0, 1], buffer: true });
      ({ stat } = parseRawNumstat(r.out));
      st = 'A';
      stat = new Map([[rel, stat.get(rel) || [...stat.values()][0] || { additions: 0, deletions: 0, binary: false }]]);
    }
  }
  if (!st) return null;
  const s = stat.get(rel) || { additions: 0, deletions: 0, binary: false };
  const status1 = st === 'T' ? 'M' : 'ADM'.includes(st) ? st : '?';
  return { rel, status: status1, ...s, untracked, target };
}

async function patchOne(top, f) {
  const args = f.untracked
    ? ['diff', '--no-ext-diff', '--no-textconv', '--patch', '--no-index', '--', '/dev/null', f.rel]
    : ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--patch', ...f.target, '--', f.rel];
  const r = await git(top, args, { okCodes: [0, 1], buffer: true });
  return r;
}

/**
 * Resolve every path to { abs, top, rel } or a refusal. `rootReal` is the task's repo root (real path) or null.
 * Inside the root -> that repo. Outside -> the path's own repo. Anything else (or a symlink escape) is refused.
 */
async function resolvePaths(files, rootReal, rootLex, cache) {
  const ok = [], refused = [];
  for (const raw of files) {
    if (typeof raw !== 'string' || !raw || raw.includes('\0')) { refused.push({ path: String(raw), reason: 'invalid path' }); continue; }
    let lex;
    if (path.isAbsolute(raw)) lex = path.resolve(raw);
    else if (rootLex) lex = path.resolve(rootLex, raw);
    else { refused.push({ path: raw, reason: 'relative path without a repo root' }); continue; }
    const real = realpathLoose(lex);
    if (rootReal && within(rootReal, real)) {
      if (isLink(lex) && !within(rootReal, realpathLoose(lex))) { refused.push({ path: raw, reason: 'symlink escape' }); continue; }
      ok.push({ abs: lex, top: rootReal, rel: path.relative(rootReal, real).split(path.sep).join('/'), own: false });
      continue;
    }
    // lexically inside the root but really elsewhere: a symlink escape
    if ((rootReal && within(rootReal, lex)) || (rootLex && within(rootLex, lex))) {
      refused.push({ path: raw, reason: 'symlink escape' }); continue;
    }
    if (isLink(lex)) { refused.push({ path: raw, reason: 'symlink outside the repo' }); continue; }
    const top = await repoTop(deepestExistingDir(path.dirname(real)), cache);
    if (!top || !within(top, real) || real === top) { refused.push({ path: raw, reason: 'outside any git repo' }); continue; }
    ok.push({ abs: lex, top, rel: path.relative(top, real).split(path.sep).join('/'), own: true });
  }
  return { ok, refused };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** Assemble { files, totals } for resolved paths; `pick(p)` returns the [a, b] pair to diff for each. */
async function build(paths, pick) {
  const metas = await pool(paths, 4, async (p) => {
    try { const [a, b] = await pick(p); const m = await diffOne(p.top, p.rel, a, b); return m && { m, p }; } catch (e) {
      if (e instanceof GitMissing) throw e;
      return null;
    }
  });
  const hits = metas.filter(Boolean).sort((x, y) => (x.p.abs < y.p.abs ? -1 : x.p.abs > y.p.abs ? 1 : 0));
  const files = [];
  let budget = TOTAL_PATCH_CAP, additions = 0, deletions = 0;
  for (const { m, p } of hits) {
    let patch = '', truncated = false;
    if (!m.binary) {
      let r;
      try { r = await patchOne(p.top, m); } catch (e) { if (e instanceof GitMissing) throw e; r = null; }
      if (r) ({ patch, truncated } = capPatch(r.out, r.overflow, budget));
      budget -= Buffer.byteLength(patch);
    }
    additions += m.additions; deletions += m.deletions;
    files.push({
      path: p.abs, rel: m.rel, status: m.status, additions: m.additions, deletions: m.deletions,
      binary: m.binary, patch, truncated,
    });
  }
  return { files, totals: { files: files.length, additions, deletions } };
}

const none = (note, root = null, base = null) => ({
  source: 'none', root, base, totals: { files: 0, additions: 0, deletions: 0 }, files: [], note,
});
const refusedNote = (refused) => (refused.length
  ? `refused ${refused.length} path${refused.length === 1 ? '' : 's'}: ${refused.slice(0, 3).map((r) => `${r.path} (${r.reason})`).join(', ')}${refused.length > 3 ? ', ...' : ''}`
  : '');
const joinNotes = (...n) => n.filter(Boolean).join('; ') || undefined;

/**
 * @param task { filesChanged: string[], git: {root, base}|null, createdAt, doneAt }
 * @param opts { now }
 */
export async function computeDiff(task, { now = Date.now() } = {}) {
  try {
    return await compute(task, now);
  } catch (e) {
    if (e instanceof GitMissing) return none('git is not available');
    return none(`diff failed: ${String(e && e.message || e).slice(0, 200)}`);
  }
}

async function compute(task, now) {
  const list = [...new Set((Array.isArray(task.filesChanged) ? task.filesChanged : []).filter((f) => typeof f === 'string'))].slice(0, MAX_FILES);
  if (!list.length) return none('no files recorded for this task', task.git?.root ?? null, task.git?.base ?? null);
  const cache = new Map();
  const g = task.git && typeof task.git.root === 'string' ? task.git : null;
  let rootReal = null;
  if (g) {
    const top = fs.existsSync(g.root) ? await repoTop(g.root, cache).catch((e) => { if (e instanceof GitMissing) throw e; return null; }) : null;
    let real = null;
    try { real = fs.realpathSync(g.root); } catch { /* gone */ }
    if (top && real && top === real) rootReal = top;
  }
  const { ok, refused } = await resolvePaths(list, rootReal, g ? g.root : null, cache);
  const rnote = refusedNote(refused);

  // ---- live: a recorded base in a repo that still exists
  let base = g && HEX.test(String(g.base || '')) ? g.base : null;
  if (rootReal && base) {
    try { await git(rootReal, ['cat-file', '-e', `${base}^{commit}`]); } catch (e) { if (e instanceof GitMissing) throw e; base = null; }
  }
  if (rootReal && base) {
    if (!ok.length) return none(joinNotes('no usable paths', rnote), rootReal, base);
    const { files, totals } = await build(ok, async (p) => [p.own ? await headOf(p.top) : base, null]);
    return { source: 'live', root: rootReal, base, totals, files, ...(rnote ? { note: rnote } : {}) };
  }

  // ---- history: no usable base
  if (!ok.length) return none(joinNotes(g ? 'not a git repository' : 'no git repository for these paths', rnote), g?.root ?? null);
  const since = new Date((task.createdAt ?? 0)).toISOString();
  const until = new Date((task.doneAt ?? now) + HISTORY_SLACK_MS).toISOString();
  const { files, totals } = await build(ok, async (p) => {
    try {
      const r = await git(p.top, ['log', '--no-ext-diff', '--format=%H', `--since=${since}`, `--until=${until}`, '--', p.rel], { okCodes: [0, 128] });
      const hashes = r.text.split('\n').filter((h) => HEX.test(h));
      if (hashes.length) {
        const newest = hashes[0], oldest = hashes[hashes.length - 1];
        const parent = await git(p.top, ['rev-parse', '--verify', '-q', `${oldest}^`], { okCodes: [0, 1, 128] });
        const pa = parent.text.trim();
        // squash: oldest^ .. newest (or empty tree .. newest for a root commit). Not including later worktree edits.
        return [HEX.test(pa) ? pa : EMPTY_TREE, newest];
      }
    } catch (e) { if (e instanceof GitMissing) throw e; }
    return [await headOf(p.top), null];
  });
  return { source: 'history', root: g ? (rootReal || g.root) : ok[0].top, base: null, totals, files, note: joinNotes(HISTORY_NOTE, rnote) };
}

async function headOf(top) {
  try {
    const r = await git(top, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1, 128] });
    const h = r.text.trim();
    return HEX.test(h) ? h : EMPTY_TREE;
  } catch (e) { if (e instanceof GitMissing) throw e; return EMPTY_TREE; }
}

/** Compact stat stored on the task. */
export const diffStat = (d) => (d && d.totals ? { files: d.totals.files, additions: d.totals.additions, deletions: d.totals.deletions } : null);
