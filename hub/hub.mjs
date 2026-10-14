// Hub core: ingest, commands, queries, sweep, rebuild. Transport-agnostic (http.mjs wraps it).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Db } from './db.mjs';
import {
  Projector, HUB_SESSION, TASK_STATUSES, JOB_TIMEOUT_ERROR, JOB_UNCLAIMED_ERROR, cut, computeConflicts,
  localDate, usageSummary, usageBreakdown, usageToday, toAttachment, MAX_NOTE_ATTACHMENTS,
  toProject, toSession, SESSION_SQL, computeHealth, HEALTH, costToday, toAgent, toTask, toNote, toActivity, toQuestion, toJob, toDigest, toLink,
} from './projections.mjs';
import { computeDiff, diffStat, deriveFiles, repoHead, within } from './diff.mjs';
import { search as ftsSearch, learn as ftsLearn } from './search.mjs';
import { WfEngine } from './wfengine.mjs';
import * as gf from './gitflow.mjs';
import { GitSync } from './gitsync.mjs';
import {
  toConcept, getConcept, resolveConcept, conceptKey, backfillConcepts, STATE_CONCEPTS, MAX_ALIASES,
} from './concepts.mjs';
import { DocsEngine } from './docsengine.mjs';
import { toDoc } from './docs.mjs';
import { toTemplate, getTemplate, renderTemplate, agentOfSubagent, TEMPLATE_AGENTS, MAX_CHECKS, MAX_TAGS } from './templates.mjs';

import { HttpError } from './errors.mjs';
import { safetyNet, backfill as backfillRecapsImpl } from './recapjobs.mjs';
export { HttpError };
const bad = (m) => new HttpError(400, m);
const notFound = (m) => new HttpError(404, m);

const isStr = (v) => typeof v === 'string';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const TABLES = [
  'projects', 'sessions', 'agents', 'tasks', 'notes', 'activity', 'late_completions',
  'agent_files', 'conflicts', 'questions', 'jobs', 'digests', 'attachments', 'usage', 'task_diffs',
  'workflows', 'workflow_versions', 'runs', 'run_nodes', 'steps', 'templates', 'concepts', 'concept_tasks', 'concept_keys',
  'session_samples',
  'docs', 'doc_versions', 'doc_comments', 'links',
];
export const RESUME_MARK = '[helm:resume]';
const MAX_AUTO_CONCURRENCY = 5; // T-71: the most tasks Up next auto mode runs at once
const COORD_MSG = 'Only the coordinator session can work on another project\'s board. Send it to the coordinator with action note.';
const WORK_MSG = 'work only applies to cards of this session\'s own project. To get another project\'s card done, update it or send its project a note.';
const MAX_ACK_BULK = 1000;
const MAX_ACKED_AGENTS = 200; // /v1/state keeps this many acknowledged agents
const MAX_ACKED_LINKS = 100;
const START_FROM = ['backlog', 'next', 'later', 'blocked'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export { localDate };

export class Hub {
  constructor(cfg, log, { clock = Date.now, fetch: fetchImpl } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.clock = clock;
    this.db = new Db(cfg.dbFile);
    this.p = new Projector(this.db, { log, attachDir: cfg.attachDir, clock: () => this.clock(), costWarnUsd: cfg.costWarnUsd });
    this.subs = new Set();
    this.startedAt = clock();
    this.backfillConcepts();        // v0.13: a database from before concepts gets them from its existing recaps, once
    this.lastPushed = this.seqNow();
    this.trimmedTo = 0;
    this.autoSnapshot = true;       // snapshot a task's diff when its agent completes (the seed switches this off)
    this.snapshots = new Set();     // in-flight snapshot promises (see flushSnapshots)
    this.closed = false;
    this.inAuto = false;            // re-entrancy guard for autoTick (also held during rebuild)
    this.lastAuto = [];             // task ids the most recent autoTick started
    this.tokens = new Map();        // v0.26: session id -> secret, IN MEMORY ONLY (never an event, a row, the state or SSE); gone on restart
    this.dashSecret = crypto.randomBytes(24).toString('hex'); // v0.26: per-launch secret of the dashboard cookie
    this.inLinks = false;           // re-entrancy guard for deliverLinks
    this.replaying = false;         // true during rebuild(): replay applies recorded workflow events and never decides
    this.gitBusy = new Set();       // v0.12: task ids with a git operation in flight (one at a time per task)
    this.gitSync = new GitSync(this, { fetchImpl }); // v0.12: PR + CI polling for pushed branches (the timer lives in server.mjs)
    this.docs = new DocsEngine(this); // v0.15 Studio documents: commands, doc_draft / doc_edit judging, export
    this.wf = new WfEngine(this);   // v0.9 workflows: decisions + commands (the reducer lives in workflows.mjs)
  }
  /** One-time (meta flag) projection of the recaps already in the tasks table into concepts. */
  backfillConcepts() {
    if (this.db.get("SELECT 1 AS x FROM meta WHERE key = 'concepts_backfilled'")) return 0;
    return this.db.transaction(() => {
      const n = backfillConcepts(this.p);
      this.db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('concepts_backfilled', '1')");
      return n;
    });
  }
  now() { return this.clock(); }
  setClock(fn) { this.clock = fn; }

  // ------------------------------------------------------------ plumbing
  tx(fn) {
    const outer = this.db.depth === 0;
    const r = this.db.transaction(fn, {
      onCommit: () => this.afterCommit(),
      onRollback: () => { this.p.dirty = false; },
    });
    // v0.7: every committed ingest / command may free the project's slot, so re-evaluate auto mode.
    if (outer) { this.autoTick(); this.wf.tick(); this.docs.tick(); this.deliverLinks(); } // v0.9: results/steps/sessions may have unblocked a workflow run
    return r;
  }
  seqNow() {
    const r = this.db.get("SELECT seq FROM sqlite_sequence WHERE name = 'changes'");
    return r ? r.seq : 0;
  }
  afterCommit() {
    if (!this.p.dirty) return;
    this.p.dirty = false;
    const cur = this.seqNow();
    const cutAt = cur - this.cfg.keepChanges;
    if (cutAt > this.trimmedTo + Math.min(100, this.cfg.keepChanges)) {
      this.db.run('DELETE FROM changes WHERE seq <= ?', cutAt);
      this.trimmedTo = cutAt;
    }
    if (this.subs.size && cur > this.lastPushed) {
      const rows = this.db.all('SELECT seq, entity, op, row FROM changes WHERE seq > ? ORDER BY seq', this.lastPushed);
      for (const fn of [...this.subs]) {
        try { fn(rows); } catch (e) { this.log?.warn('subscriber failed', e); }
      }
    }
    this.lastPushed = cur;
  }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  /** Changes after lastId for SSE resume. { reset: true } when the client must refetch state. */
  changesSince(lastId) {
    const cur = this.seqNow();
    const floor = Number(this.db.get("SELECT value FROM meta WHERE key = 'resetFloor'")?.value || 0);
    if (!Number.isInteger(lastId) || lastId < 0 || lastId > cur || lastId < floor) return { reset: true, rows: [] };
    if (lastId === cur) return { reset: false, rows: [] };
    const min = this.db.get('SELECT MIN(seq) AS m FROM changes').m;
    if (min == null || lastId < min - 1) return { reset: true, rows: [] };
    return { reset: false, rows: this.db.all('SELECT seq, entity, op, row FROM changes WHERE seq > ? ORDER BY seq', lastId) };
  }

  /** Record a hub-originated event (command / sweep) and apply it. Must run inside tx(). */
  command(type, data, at) {
    const seq = this.db.get('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM events WHERE session_id = ?', HUB_SESSION).s;
    this.db.run('INSERT INTO events(session_id, seq, type, at, data) VALUES (?, ?, ?, ?, ?)',
      HUB_SESSION, seq, type, at, JSON.stringify(data));
    return this.p.apply({ sessionId: HUB_SESSION, seq, type, at, data });
  }

  // -------------------------------------------------------------- ingest
  static validateEvent(e, now) {
    if (!isObj(e)) return 'event must be an object';
    if (!isStr(e.sessionId) || !e.sessionId || e.sessionId.length > 200) return 'sessionId must be a non-empty string';
    if (e.sessionId === HUB_SESSION) return 'reserved sessionId';
    if (!Number.isSafeInteger(e.seq) || e.seq < 0) return 'seq must be a non-negative integer';
    if (!isStr(e.type) || !e.type || e.type.length > 64) return 'type must be a non-empty string';
    if (e.type.startsWith('hub.')) return 'reserved event type';
    if (e.type.startsWith('wf.') && e.type !== 'wf.step.result') return 'reserved event type'; // only step results come from mods
    if (e.at !== undefined && !(typeof e.at === 'number' && Number.isFinite(e.at))) return 'at must be a number';
    if (e.data !== undefined && !isObj(e.data)) return 'data must be an object';
    return null;
  }

  /** POST /v1/sessions/:id/register (socket only): mint the session's secret. Returned once; a new call replaces it. */
  registerSession(id) {
    if (!isStr(id) || !id || id.length > 200) throw bad('invalid session id');
    const token = crypto.randomBytes(32).toString('hex');
    this.tokens.set(id, token);
    return { token };
  }
  checkToken(id, token) {
    const want = this.tokens.get(id);
    if (!want || !isStr(token) || token.length !== want.length) return false;
    return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(token));
  }
  /** The Set-Cookie value of the dashboard, and the check the human-only routes make against the cookie the browser sends back. */
  dashCookie() { return `helm_dash=${this.dashSecret}; HttpOnly; SameSite=Strict; Path=/`; }
  checkDash(cookieHeader) {
    const m = /(?:^|;\s*)helm_dash=([0-9a-f]+)/.exec(String(cookieHeader ?? ''));
    return !!m && m[1].length === this.dashSecret.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(this.dashSecret));
  }
  /** A task.choices event may change only a card of the sender's own project (or any, from the coordinator), and only as the authenticated session. */
  mayWriteChoices(e, authSession) {
    if (!authSession || authSession !== e.sessionId) return false;
    const s = this.p.getSession(e.sessionId), t = this.p.getTask(e.data && e.data.taskId);
    if (!s) return false;
    return !t || t.project_id === s.project_id || !!this.p.getProject(s.project_id)?.coordinator;
  }

  ingest(events, opts) {
    if (!Array.isArray(events)) throw bad('events must be an array');
    const now = this.now();
    const valid = [];
    let rejected = 0;
    for (const e of events) {
      const err = Hub.validateEvent(e, now);
      if (err) { rejected++; this.log?.warn(`rejected event: ${err}`); continue; }
      valid.push({ sessionId: e.sessionId, seq: e.seq, type: e.type, at: e.at ?? now, data: e.data ?? {} });
    }
    // apply in seq order per session (sessions keep their first-appearance order)
    const order = new Map();
    for (const e of valid) if (!order.has(e.sessionId)) order.set(e.sessionId, order.size);
    valid.sort((a, b) => order.get(a.sessionId) - order.get(b.sessionId) || a.seq - b.seq);

    let accepted = 0, duplicates = 0;
    const lastSeqBySession = {};
    this.tx(() => {
      const maxSeen = new Map();
      for (const ev of valid) {
        if (opts && ev.type === 'task.choices' && !this.mayWriteChoices(ev, opts.authSession)) {
          rejected++;
          this.log?.warn(`rejected task.choices from ${ev.sessionId}: not allowed for that session`);
          continue;
        }
        if (!maxSeen.has(ev.sessionId)) {
          maxSeen.set(ev.sessionId,
            this.db.get('SELECT COALESCE(MAX(seq), -1) AS m FROM events WHERE session_id = ?', ev.sessionId).m);
        }
        const r = this.db.run('INSERT OR IGNORE INTO events(session_id, seq, type, at, data) VALUES (?, ?, ?, ?, ?)',
          ev.sessionId, ev.seq, ev.type, ev.at, JSON.stringify(ev.data));
        if (r.changes === 0) { duplicates++; continue; }
        accepted++;
        const prev = maxSeen.get(ev.sessionId);
        // The mod numbers events by clock (≥ 1e12), so gaps are normal there; only counter-style seqs warn.
        if (prev >= 0 && ev.seq > prev + 1 && ev.seq < 1e12) {
          this.log?.warn(`seq gap for ${ev.sessionId}: ${prev} -> ${ev.seq}`);
        }
        if (ev.seq > prev) maxSeen.set(ev.sessionId, ev.seq);
        this.applySafely(ev);
      }
      for (const sid of order.keys()) {
        lastSeqBySession[sid] = this.db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?', sid).m;
      }
    });
    const lastSeq = Math.max(0, ...Object.values(lastSeqBySession));
    if (this.autoSnapshot && accepted) this.scheduleSnapshots(valid);
    return { accepted, duplicates, rejected, lastSeq, lastSeqBySession };
  }

  // ------------------------------------------------------------ task diffs (v0.5)
  /** After a commit: queue a diff snapshot for every task whose agent just finished. Never blocks or throws. */
  scheduleSnapshots(events) {
    try {
      const tasks = new Set();
      for (const ev of events) {
        if (ev.type !== 'agent.completed' && ev.type !== 'agent.bound') continue; // a bind can apply a late completion
        const id = ev.data && ev.data.agentId;
        if (typeof id !== 'string') continue;
        const a = this.p.getAgent(id);
        if (a && a.task_id && (a.status === 'done' || a.status === 'failed')) tasks.add(a.task_id);
      }
      for (const taskId of tasks) {
        const p = new Promise((r) => setImmediate(r))
          .then(() => this.snapshotTask(taskId))
          .catch((e) => this.log?.warn(`diff snapshot failed for ${taskId}`, e))
          .finally(() => this.snapshots.delete(p));
        this.snapshots.add(p);
      }
    } catch (e) { this.log?.warn('scheduleSnapshots failed', e); }
  }
  /** Resolves once every queued snapshot has been recorded (tests, shutdown). */
  async flushSnapshots() {
    while (this.snapshots.size) await Promise.all([...this.snapshots]);
  }
  taskDiffInput(t) {
    return { filesChanged: JSON.parse(t.files_changed || '[]'), git: toTask(t).git, createdAt: t.created_at, doneAt: t.done_at, filesNote: t.files_note || null };
  }
  /**
   * T-66: work out which files a task changed from git (see diff.mjs deriveFiles) and record the decision as a
   * hub.task.files event, so replay never re-asks git. Needs a recorded base; a no-op without one or without news.
   */
  async deriveTaskFiles(taskId) {
    const t = this.p.getTask(taskId);
    if (!t || this.closed || !t.git) return null;
    const hints = this.db.all("SELECT summary FROM activity WHERE task_id = ? AND kind = 'tool' ORDER BY id DESC LIMIT 400", taskId).map((r) => r.summary);
    const r = await deriveFiles(this.taskDiffInput(t), { mentions: JSON.parse(t.mentions || '[]'), hints });
    if (r.source === 'none' || this.closed) return null;
    const cur = this.p.getTask(taskId);
    if (!cur) return null;
    const have = new Set(JSON.parse(cur.files_changed || '[]'));
    const fresh = r.files.filter((f) => !have.has(f));
    if (!fresh.length && (r.note === null || (cur.files_note || null) === r.note)) return null;
    return this.tx(() => this.command('hub.task.files', { taskId, files: fresh, mode: 'merge', note: r.note }, this.now()));
  }
  /**
   * POST /v1/tasks/:id/files { files, root?, note?, replace? }: attach files to an existing task by hand (a backfill).
   * Relative paths resolve against `root` (or the task's git root) and must stay inside it. With `root` and no recorded
   * base, the repo's current HEAD becomes the base (a diff against HEAD), decided here and carried in the event.
   */
  async attachTaskFiles(id, body) {
    const t = this.p.getTask(id);
    if (!t) throw notFound('task not found');
    if (!isObj(body) || !Array.isArray(body.files) || !body.files.length || body.files.length > 500 || body.files.some((f) => !isStr(f) || !f || f.includes('\0'))) {
      throw bad('files must be a non-empty array of paths (max 500)');
    }
    if (body.root !== undefined && (!isStr(body.root) || !path.isAbsolute(body.root))) throw bad('root must be an absolute path');
    if (body.note !== undefined && body.note !== null && !isStr(body.note)) throw bad('note must be a string');
    const cur = JSON.parse(t.git || 'null');
    let git = null, root = cur && cur.root ? cur.root : null;
    if (body.root) {
      const h = await repoHead(body.root);
      if (!h) throw bad('root is not a git repository');
      root = h.root;
      if (!cur) git = { root: h.root, base: h.head, head: h.head, at: this.now() };
    }
    const files = [];
    for (const f of body.files) {
      const abs = path.isAbsolute(f) ? path.resolve(f) : root ? path.resolve(root, f) : null;
      if (!abs) throw bad(`relative path without a root: ${f}`);
      if (root && !within(root, abs)) throw bad(`path escapes the repo root: ${f}`);
      files.push(abs);
    }
    const note = body.note === undefined ? 'attached by hand' : body.note;
    const task = this.tx(() => this.command('hub.task.files', { taskId: id, files, mode: body.replace ? 'replace' : 'merge', note, ...(git ? { git } : {}) }, this.now()));
    if (this.autoSnapshot) {
      const p = this.snapshotTask(id).catch((e) => this.log?.warn(`diff snapshot failed for ${id}`, e)).finally(() => this.snapshots.delete(p));
      this.snapshots.add(p);
    }
    return { task };
  }
  /** Compute the task's diff now and record it as a hub.task.diff event. Skips when there is nothing to freeze. */
  async snapshotTask(taskId) {
    let t = this.p.getTask(taskId);
    if (!t || this.closed) return null;
    await this.deriveTaskFiles(taskId).catch((e) => this.log?.warn(`file derivation failed for ${taskId}`, e));
    t = this.p.getTask(taskId);
    if (!t || this.closed) return null;
    const diff = await computeDiff(this.taskDiffInput(t), { now: this.now() });
    if (diff.source === 'none' || this.closed) return null;
    this.tx(() => this.command('hub.task.diff', { taskId, diff }, this.now()));
    return diff;
  }
  /** GET /v1/tasks/:id/diff. Snapshot if there is one (unless refresh), else live / history. */
  async taskDiff(id, { refresh = false } = {}) {
    let t = this.p.getTask(id);
    if (!t) throw notFound('task not found');
    if (!refresh) {
      const s = this.db.get('SELECT diff FROM task_diffs WHERE task_id = ?', id);
      if (s) { try { return { ...JSON.parse(s.diff), source: 'snapshot' }; } catch { /* recompute */ } }
    }
    if (t.git) { await this.deriveTaskFiles(id).catch((e) => this.log?.warn(`file derivation failed for ${id}`, e)); t = this.p.getTask(id); }
    const diff = await computeDiff(this.taskDiffInput(t), { now: this.now() });
    const stat = diffStat(diff);
    if (diff.source !== 'none' && !this.closed) {
      const cur = this.p.getTask(id);
      if (cur && cur.diff_stat !== JSON.stringify(stat)) {
        this.tx(() => this.command('hub.task.diffstat', { taskId: id, diffStat: stat }, this.now()));
      }
    }
    return diff;
  }

  // ------------------------------------------------------------ git branch per task (v0.12)
  /** Run a git operation for one task, one at a time (a second click gets a 409 instead of racing the first). */
  async gitLock(id, fn) {
    if (this.gitBusy.has(id)) throw new HttpError(409, 'another git operation is already running for this task');
    this.gitBusy.add(id);
    try { return await fn(); } finally { this.gitBusy.delete(id); }
  }
  branchOf(t) { try { return t.branch ? JSON.parse(t.branch) : null; } catch { return null; } }
  taskForGit(id) {
    const t = this.p.getTask(id);
    if (!t) throw notFound('task not found');
    return t;
  }
  /** The Task as git code wants it (parsed, with the recap). */
  gitTask(t) {
    const x = toTask(t), a = t.agent_id ? this.p.getAgent(t.agent_id) : null;
    return { id: x.id, title: x.title, recap: x.recap, git: x.git, filesChanged: x.filesChanged, doneAt: x.doneAt ?? (a && a.ended_at) ?? null };
  }
  /** Files that no longer match the diff frozen when the task finished (a live recompute against the snapshot). */
  async driftWarnings(t) {
    try {
      const s = this.db.get('SELECT diff FROM task_diffs WHERE task_id = ?', t.id);
      if (!s) return [];
      const snap = JSON.parse(s.diff);
      const live = await computeDiff(this.taskDiffInput(t), { now: this.now() });
      if (live.source === 'none') return [];
      const key = (f) => `${f.status}|${f.additions}|${f.deletions}|${f.patch}`;
      const a = new Map(snap.files.map((f) => [f.rel, key(f)])), b = new Map(live.files.map((f) => [f.rel, key(f)]));
      const bad = [...new Set([...a.keys(), ...b.keys()])].filter((r) => a.get(r) !== b.get(r));
      return bad.length ? [`${bad.length} file${bad.length === 1 ? '' : 's'} differ from the diff recorded when the task finished: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ', ...' : ''}`] : [];
    } catch { return []; }
  }
  /** GET /v1/tasks/:id/git: what "Create branch" / "Push" would act on (for the preview and the confirm dialog). */
  async gitInfo(id) {
    const t = this.taskForGit(id);
    const task = toTask(t), branch = task.branch;
    const g = task.git;
    const out = { taskId: id, eligible: false, reason: null, root: g ? g.root : null, base: g ? g.head : null, files: [], remotes: [], branch };
    if (!g) out.reason = 'this task was not started inside a git repo';
    else if (!task.filesChanged.length) out.reason = 'this task has no changed files';
    else out.eligible = true;
    const root = g ? g.root : null;
    out.files = task.filesChanged.map((f) => (root && f.startsWith(root + '/') ? f.slice(root.length + 1) : f));
    if (g) { try { out.remotes = await gf.listRemotes(branch ? branch.root : g.root); } catch (e) { out.remotesError = e.message; } }
    return out;
  }
  /** POST /v1/tasks/:id/branch */
  createBranch(id) {
    return this.gitLock(id, async () => {
      const t = this.taskForGit(id);
      if (this.branchOf(t)) throw new HttpError(409, 'this task already has a branch; use Update branch');
      const task = this.gitTask(t);
      const drift = await this.driftWarnings(t);
      const at = this.now();
      const { record, warnings } = await gf.createBranch({ task, home: this.cfg.home, now: at });
      if (this.closed) return null;
      const next = this.tx(() => this.command('hub.task.branch', { taskId: id, branch: { ...record, github: null } }, at));
      return { task: next, branch: next.branch, warnings: [...drift, ...warnings] };
    });
  }
  /** POST /v1/tasks/:id/branch/update: re-copy the task's files and add a commit. */
  updateBranch(id) {
    return this.gitLock(id, async () => {
      const t = this.taskForGit(id);
      const cur = this.branchOf(t);
      if (!cur) throw new HttpError(409, 'this task has no branch yet');
      const task = this.gitTask(t);
      const drift = await this.driftWarnings(t);
      const at = this.now();
      const r = await gf.updateBranch({ task, record: cur, home: this.cfg.home, now: at });
      const warnings = [...drift, ...r.warnings];
      if (this.closed) return null;
      if (r.unchanged) return { task: toTask(this.p.getTask(id)), branch: cur, warnings, unchanged: true };
      const next = this.tx(() => this.command('hub.task.branch', { taskId: id, branch: r.record }, at));
      return { task: next, branch: next.branch, warnings, unchanged: false };
    });
  }
  /** POST /v1/tasks/:id/push { remote?, confirm: true } */
  pushBranch(id, body) {
    return this.gitLock(id, async () => {
      if (!isObj(body)) throw bad('body must be an object');
      if (body.confirm !== true) throw bad('pushing needs { confirm: true } (the dashboard asks first)');
      if (body.remote !== undefined && !isStr(body.remote)) throw bad('remote must be a string');
      const t = this.taskForGit(id);
      const cur = this.branchOf(t);
      if (!cur) throw new HttpError(409, 'this task has no branch yet');
      const task = this.gitTask(t);
      const r = await gf.pushBranch({ task, record: cur, home: this.cfg.home, remote: body.remote || 'origin', now: this.now() });
      if (this.closed) return null;
      const patch = {
        remote: r.remote, remoteUrl: r.remoteUrl, github: r.github, prUrl: r.prUrl, pushedAt: r.pushedAt, pushedCommit: r.pushedCommit, ci: null,
        // a different remote is a different repo: any linked PR belongs to the old one
        ...(cur.remote && cur.remote !== r.remote ? { pr: null } : {}),
      };
      const next = this.tx(() => this.command('hub.task.branch', { taskId: id, patch }, r.pushedAt));
      this.gitSync.per.delete(id);
      return { task: next, branch: next.branch, compareUrl: r.prUrl };
    });
  }
  /** POST /v1/tasks/:id/pr { url } (url null or '' unlinks) */
  linkPr(id, body) {
    if (!isObj(body)) throw bad('body must be an object');
    const t = this.taskForGit(id);
    const cur = this.branchOf(t);
    if (!cur) throw new HttpError(409, 'this task has no branch yet');
    let pr = null;
    if (body.url !== null && body.url !== '' && body.url !== undefined) {
      if (!isStr(body.url)) throw bad('url must be a string');
      const p = gf.parsePrUrl(body.url);
      if (cur.github) {
        const [o, r] = cur.github.split('/');
        if (p.host !== 'github.com' && p.host !== 'www.github.com') throw bad(`expected a github.com pull request URL for ${cur.github}`);
        if (!p.owner || p.owner.toLowerCase() !== o.toLowerCase() || p.repo.toLowerCase() !== r.toLowerCase()) throw bad(`that pull request is not in ${cur.github}`);
      }
      const keep = cur.pr && cur.pr.number === p.number && p.number != null ? cur.pr : null;
      pr = { number: p.number, url: p.url, state: keep ? keep.state : 'open', merged: keep ? keep.merged : false };
    } else if (body.url === undefined) throw bad('url is required (null unlinks)');
    const next = this.tx(() => this.command('hub.task.branch', { taskId: id, patch: { pr } }, this.now()));
    this.gitSync.per.delete(id);
    return { task: next, branch: next.branch };
  }
  /** DELETE /v1/tasks/:id/branch?deleteBranch=1&force=1: remove the worktree, optionally the local branch. Remote branches are never touched. */
  deleteBranch(id, { deleteBranch = false, force = false } = {}) {
    return this.gitLock(id, async () => {
      const t = this.taskForGit(id);
      const cur = this.branchOf(t);
      if (!cur) throw new HttpError(409, 'this task has no branch');
      const at = this.now();
      let r;
      try {
        r = await gf.cleanupBranch({ record: cur, home: this.cfg.home, deleteBranch, force });
      } catch (e) {
        if (e.extra && e.extra.worktreeRemoved && !this.closed) this.tx(() => this.command('hub.task.branch', { taskId: id, patch: { worktree: null } }, at));
        throw e;
      }
      if (this.closed) return null;
      const next = this.tx(() => (r.branchDeleted
        ? this.command('hub.task.branch', { taskId: id, branch: null }, at)
        : this.command('hub.task.branch', { taskId: id, patch: { worktree: null } }, at)));
      this.gitSync.per.delete(id);
      return { task: next, branchDeleted: r.branchDeleted };
    });
  }
  /** POST /v1/tasks/:id/ci/refresh: poll GitHub for this branch now. */
  async refreshCi(id) {
    const t = this.taskForGit(id);
    const cur = this.branchOf(t);
    if (!cur || !cur.pushedAt) throw new HttpError(409, 'this task has no pushed branch');
    if (!cur.github) throw new HttpError(409, 'CI status is only read for GitHub remotes');
    await this.gitSync.refresh(id);
    return { task: toTask(this.p.getTask(id)) };
  }

  /** Apply inside a savepoint: a poisoned event keeps its seq but cannot break the batch. */
  applySafely(ev) {
    this.db.exec('SAVEPOINT ev');
    try {
      this.p.apply(ev);
      this.db.exec('RELEASE ev');
    } catch (e) {
      this.db.exec('ROLLBACK TO ev');
      this.db.exec('RELEASE ev');
      this.log?.error(`apply failed for ${ev.type} ${ev.sessionId}#${ev.seq}`, e);
    }
  }

  // ------------------------------------------------------------ rebuild / dump
  dump() {
    const out = {};
    const orderBy = {
      activity: 'id', late_completions: 'session_id, agent_id', agent_files: 'agent_id, path', conflicts: 'path',
      concept_tasks: 'slug, task_id', concept_keys: 'key',
    };
    for (const t of TABLES) {
      out[t] = this.db.all(`SELECT * FROM ${t} ORDER BY ${orderBy[t] || 'rowid'}`);
    }
    out.counters = this.db.all('SELECT * FROM counters ORDER BY name');
    out.search_docs = this.db.all('SELECT kind, ref, title, body, session_id, task_id, at FROM search_docs ORDER BY kind, ref');
    return JSON.parse(JSON.stringify(out));
  }

  /** Drop every projection and replay the events table. */
  rebuild() {
    const t0 = Date.now();
    let replayed = 0;
    this.inAuto = true; // replay must never emit new events
    this.replaying = true;
    try { this.rebuildInner(() => replayed++); } finally { this.inAuto = false; this.replaying = false; }
    return { replayed, ms: Date.now() - t0 };
  }
  rebuildInner(count) {
    this.tx(() => {
      const floor = this.seqNow() + 1;
      for (const t of [...TABLES, 'search_docs', 'changes', 'counters']) this.db.run(`DELETE FROM ${t}`);
      this.db.run("DELETE FROM sqlite_sequence WHERE name = 'changes'");
      this.db.run("INSERT INTO sqlite_sequence(name, seq) VALUES ('changes', ?)", floor);
      this.db.run("INSERT INTO meta(key, value) VALUES ('resetFloor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(floor));
      let last = 0;
      for (;;) {
        const rows = this.db.all('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500', last);
        if (!rows.length) break;
        for (const r of rows) {
          let data = {};
          try { data = JSON.parse(r.data); } catch { /* keep {} */ }
          this.applySafely({ sessionId: r.session_id, seq: r.seq, type: r.type, at: r.at, data });
          last = r.id;
          count();
        }
      }
      this.db.run('DELETE FROM changes WHERE seq <= ?', this.seqNow() - this.cfg.keepChanges);
    });
    this.lastPushed = this.seqNow();
  }

  // ------------------------------------------------------- auto mode (v0.7)
  /**
   * Start the top Up next task of every project with autoStart on and nothing in progress. The decision (task, session,
   * note text) is made here and carried in the hub.task.autostart event, so replay never re-decides. Returns started ids.
   */
  autoTick(now = this.now()) {
    if (this.inAuto || this.closed) return [];
    this.inAuto = true;
    const started = [];
    try {
      const ids = this.db.all('SELECT id FROM projects WHERE auto_start = 1 AND archived = 0 ORDER BY rowid').map((r) => r.id);
      for (const id of ids) {
        // T-71: keep starting until the project's concurrency is full. Each start note counts as in flight at once,
        // so autoPlan sees the slot taken; the cap only guards against a runaway loop.
        for (let i = 0; i < MAX_AUTO_CONCURRENCY; i++) {
          const plan = this.autoPlan(id, now);
          if (!plan) break;
          this.tx(() => this.command('hub.task.autostart', plan, now));
          started.push(plan.taskId);
        }
      }
    } catch (e) {
      this.log?.error('auto-start failed', e);
    } finally {
      this.inAuto = false;
    }
    this.lastAuto = started;
    return started;
  }
  /**
   * The next auto-start for a project, or null. See CONTRACT v0.7 for the rule; T-71 generalises "nothing in progress"
   * to "fewer than N busy", where busy = in-progress tasks + Up next tasks whose start is still in flight.
   */
  autoPlan(projectId, now) {
    const { autoStartingMs, autoBackoffMs, sendingMs } = this.cfg;
    const limit = this.p.getProject(projectId)?.auto_concurrency || 1;
    let busy = this.db.get(`SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND status = 'in_progress'`, projectId).c;
    if (busy >= limit) return null;
    const next = this.db.all(
      `SELECT * FROM tasks WHERE project_id = ? AND status = 'next' ORDER BY ord, created_at, rowid`, projectId);
    if (!next.length) return null;
    const candidates = [];
    for (const t of next) {
      const n = t.start_note_id ? this.p.getNote(t.start_note_id) : null;
      let inFlight = false;
      if (n && n.state !== 'failed') {
        if (n.state === 'queued' || n.state === 'sending') inFlight = true;          // a start is in flight
        else if (now - n.created_at < autoStartingMs) inFlight = true;               // delivered, agent not up yet
        // Delivered but not answered yet: the session only reads prompts when its current turn ends, which can
        // take longer than autoStartingMs. Until it replies (or 30 min pass), the start is still in flight.
        else if (n.state === 'ran' && !n.replied_at && now - (n.ran_at ?? n.created_at) < 30 * 60_000) inFlight = true;
      }
      if (inFlight) { if (++busy >= limit) return null; continue; }
      if (!this.depsDone(t)) continue;                                               // waits for its dependencies
      if (n && n.state === 'failed') {
        const failedAt = n.ran_at ?? (n.sending_at ? n.sending_at + sendingMs : n.queued_at ?? n.created_at);
        if (now - failedAt < autoBackoffMs) return null;                             // back off; do not skip past it
      }
      candidates.push(t);
    }
    // Nothing may be started while an earlier in-flight start is still unresolved beyond the cap (checked above).
    for (const top of candidates) {
      let plan;
      try { plan = this.startPlan(top); } catch (e) {
        if (e instanceof HttpError) return null;  // no live session: retry when one appears
        throw e;
      }
      return { taskId: top.id, sessionId: plan.sessionId, text: plan.text, noteIds: plan.noteIds,
        reason: limit === 1 ? 'nothing in progress' : `free slot (${busy + 1} of ${limit})` };
    }
    return null;
  }
  /** True when every task this one depends on is done (a dependency that no longer exists counts as done). */
  depsDone(t) {
    let deps; try { deps = JSON.parse(t.depends_on || '[]'); } catch { deps = []; }
    return deps.every((d) => { const x = this.p.getTask(d); return !x || x.status === 'done'; });
  }

  // ---------------------------------------------------------------- sweep
  sweep(now = this.now()) {
    const r = this.sweepCore(now);
    this.autoTick(now); // backoff / starting windows expire with time, not with an event
    safetyNet(this, now); // T-76: a finished task still without a recap gets one
    this.docs.tick(now);
    this.wf.tick(now);  // unclaimed / overdue workflow steps time out, waiting runs are re-evaluated
    return r;
  }
  sweepCore(now) {
    const { stallMs, blockMs, idleMs, sendingMs, jobMs } = this.cfg;
    const stall = this.db.all(
      `SELECT id FROM agents WHERE status = 'running' AND last_activity_at < ? ORDER BY rowid`, now - stallMs).map((r) => r.id);
    const block = this.db.all(
      `SELECT t.id AS taskId, a.id AS agentId FROM agents a JOIN tasks t ON t.id = a.task_id AND t.agent_id = a.id
       WHERE a.status IN ('running','stalled') AND a.last_activity_at < ? AND t.status = 'in_progress' ORDER BY a.rowid`,
      now - blockMs);
    const idle = this.db.all(
      `SELECT id FROM sessions WHERE status = 'active' AND last_seen_at < ? ORDER BY rowid`, now - idleMs).map((r) => r.id);
    // Notes the mod claimed but never reported on. Legacy rows without sending_at fall back to queued_at.
    const sending = this.db.all(
      `SELECT id FROM notes WHERE state = 'sending' AND COALESCE(sending_at, queued_at, created_at) < ? ORDER BY rowid`,
      now - sendingMs).map((r) => r.id);
    // Jobs: a running one the mod never answered, or a queued one nobody claimed (its session is gone).
    const jobs = [
      ...this.db.all(`SELECT id FROM jobs WHERE state = 'running' AND COALESCE(claimed_at, created_at) < ? ORDER BY rowid`, now - jobMs)
        .map((r) => ({ id: r.id, error: JOB_TIMEOUT_ERROR })),
      ...this.db.all(`SELECT id FROM jobs WHERE state = 'queued' AND created_at < ? ORDER BY rowid`, now - jobMs)
        .map((r) => ({ id: r.id, error: JOB_UNCLAIMED_ERROR })),
    ];
    // Conflict radar: touches age out of the 10-minute window with no event to say so.
    const conflicts = this.conflictsStale(now);
    const health = this.healthStale(now, stall);
    if (!stall.length && !block.length && !idle.length && !sending.length && !jobs.length && !conflicts && !health.length) return null;
    this.tx(() => this.command('hub.sweep', { stall, block, idle, sending, jobs, conflicts, health }, now));
    return {
      healthChanged: health.length, stalled: stall.length, blocked: block.length, idle: idle.length, timedOut: sending.length,
      jobsFailed: jobs.length, conflictsChanged: conflicts,
    };
  }
  /**
   * Sessions whose stored health differs from what it would be at `now` (a long idle, a stall the sweep is about to record,
   * a new day). Heartbeats and turns refresh health themselves; this covers what only time changes.
   */
  healthStale(now, stall) {
    const extra = new Map();
    for (const id of stall) {
      const a = this.p.getAgent(id);
      if (a) extra.set(a.session_id, (extra.get(a.session_id) || 0) + 1);
    }
    const out = [];
    for (const r of this.db.all(`${SESSION_SQL} ORDER BY s.rowid`)) {
      const n = extra.get(r.id) || 0;
      const h = computeHealth({ ...r, stalled_n: r.stalled_n + n, running_n: r.running_n - n }, now, this.cfg.costWarnUsd);
      if (h.level !== r.health_level || JSON.stringify(h.reasons) !== r.health_reasons) out.push(r.id);
    }
    return out;
  }
  /** Would recomputing the conflicts at `now` change what is stored? */
  conflictsStale(now) {
    const list = computeConflicts(this.db, now);
    const stored = this.db.all('SELECT path, agents FROM conflicts ORDER BY path');
    return !(stored.length === list.length
      && stored.every((r, i) => r.path === list[i].path && r.agents === JSON.stringify(list[i].agents)));
  }

  // ------------------------------------------------------- session health (v0.14)
  /** GET /v1/sessions/:id/health: the session, its samples (oldest first), agent counts and the cost of the last `hours`. */
  sessionHealth(id, hours = 24, now = this.now()) {
    const row = this.p.getSession(id);
    if (!row) throw notFound('session not found');
    const h = Math.max(1, Math.min(168, Math.floor(hours) || 24));
    const since = now - h * 3600_000;
    const samples = this.db.all(
      'SELECT at, tokens, percent, cost_usd FROM session_samples WHERE session_id = ? AND at >= ? ORDER BY at, id', id, since,
    ).map((r) => ({ at: r.at, tokens: r.tokens, percent: r.percent, costUsd: r.cost_usd }));
    const count = (st, sinceMs) => this.db.get(
      `SELECT COUNT(*) AS n FROM agents WHERE session_id = ? AND status = ?${sinceMs ? ' AND ended_at >= ?' : ''}`,
      ...(sinceMs ? [id, st, sinceMs] : [id, st])).n;
    // spend in the window: current cost minus the cost at its start (0 when the session began inside it)
    let base = 0;
    if (row.started_at < since) {
      const before = this.db.get('SELECT cost_usd FROM session_samples WHERE session_id = ? AND at < ? ORDER BY at DESC LIMIT 1', id, since);
      base = before ? before.cost_usd : (samples[0]?.costUsd ?? row.cost_usd ?? 0);
    }
    return {
      session: toSession(row), samples,
      agents: { running: row.running_n, stalled: row.stalled_n, done24h: count('done', now - 24 * 3600_000) },
      cost24h: Math.max(0, Math.round(((row.cost_usd ?? 0) - base) * 1e6) / 1e6),
    };
  }
  /** GET /v1/health/sessions: one line per active or idle session, worst first, plus the overall level. */
  healthSummary() {
    const sessions = this.db.all(`${SESSION_SQL} WHERE s.status IN ('active','idle') ORDER BY s.rowid`).map((r) => {
      const s = toSession(r);
      return {
        id: s.id, projectId: s.projectId, title: s.title, model: s.model, status: s.status, busy: s.busy,
        contextPercent: s.contextPercent, contextWindow: s.contextWindow, rateLimits: s.rateLimits,
        costUsd: s.costUsd, costToday: s.costToday, runningAgents: s.runningAgents, stalledAgents: s.stalledAgents, health: s.health,
      };
    });
    const rank = { critical: 0, warn: 1, ok: 2 };
    sessions.sort((a, b) => rank[a.health.level] - rank[b.health.level]);
    const counts = { ok: 0, warn: 0, critical: 0 };
    for (const s of sessions) counts[s.health.level]++;
    return { sessions, counts, level: counts.critical ? 'critical' : counts.warn ? 'warn' : 'ok' };
  }

  // -------------------------------------------------------------- queries
  state(projectId) {
    const q = (sql, ...p) => this.db.all(sql, ...p);
    let sessions, agents, tasks, notes, questions, jobs, digests, links;
    const projects = q('SELECT * FROM projects ORDER BY rowid').map(toProject);
    // open / in-flight rows plus a bounded tail of finished ones
    const qSql = (scope) => `SELECT * FROM questions WHERE ${scope} AND (state = 'open' OR rowid IN (
      SELECT rowid FROM questions WHERE ${scope} AND state = 'answered' ORDER BY answered_at DESC, rowid DESC LIMIT 50)) ORDER BY rowid`;
    const jSql = (scope) => `SELECT * FROM jobs WHERE ${scope} AND (state IN ('queued','running') OR rowid IN (
      SELECT rowid FROM jobs WHERE ${scope} AND state IN ('done','failed') ORDER BY done_at DESC, rowid DESC LIMIT 20)) ORDER BY rowid`;
    // acknowledged rows stay in the state (the web hides them) but only the newest few, so it cannot grow without bound
    const agSql = (scope) => `SELECT * FROM agents WHERE ${scope} AND (acknowledged_at IS NULL OR rowid IN (
      SELECT rowid FROM agents WHERE ${scope} AND acknowledged_at IS NOT NULL ORDER BY acknowledged_at DESC, rowid DESC LIMIT ${MAX_ACKED_AGENTS}))`;
    const lkSql = (scope) => `SELECT * FROM links WHERE ${scope} AND (acknowledged_at IS NULL OR rowid IN (
      SELECT rowid FROM links WHERE ${scope} AND acknowledged_at IS NOT NULL ORDER BY acknowledged_at DESC, rowid DESC LIMIT ${MAX_ACKED_LINKS}))`;
    if (projectId) {
      if (!this.p.getProject(projectId)) throw notFound('project not found');
      sessions = q(`${SESSION_SQL} WHERE s.project_id = ? ORDER BY s.rowid`, projectId);
      agents = q(`${agSql('session_id IN (SELECT id FROM sessions WHERE project_id = ?)')} ORDER BY rowid`, projectId, projectId);
      links = q(`${lkSql('(from_project_id = ? OR to_project_id = ?)')} ORDER BY rowid`, projectId, projectId, projectId, projectId);
      tasks = q('SELECT * FROM tasks WHERE project_id = ? ORDER BY ord, rowid', projectId);
      notes = q(
        `SELECT * FROM notes WHERE (target_kind = 'task' AND target_id IN (SELECT id FROM tasks WHERE project_id = ?))
           OR session_id IN (SELECT id FROM sessions WHERE project_id = ?)
           OR (target_kind = 'session' AND target_id IN (SELECT id FROM sessions WHERE project_id = ?)) ORDER BY rowid`,
        projectId, projectId, projectId);
      const qScope = `session_id IN (SELECT id FROM sessions WHERE project_id = ?)`;
      questions = q(qSql(qScope), projectId, projectId);
      jobs = q(jSql(`(project_id = ? OR kind = 'concept_summary')`), projectId, projectId); // concept pages are global
      digests = q('SELECT * FROM digests WHERE project_id = ? ORDER BY date DESC, created_at DESC, rowid DESC LIMIT 14', projectId);
    } else {
      sessions = q(`${SESSION_SQL} ORDER BY s.rowid`);
      agents = q(`${agSql('1 = 1')} ORDER BY rowid`);
      links = q(`${lkSql('1 = 1')} ORDER BY rowid`);
      tasks = q('SELECT * FROM tasks ORDER BY project_id, ord, rowid');
      notes = q('SELECT * FROM notes ORDER BY rowid');
      questions = q(qSql('1 = 1'));
      jobs = q(jSql('1 = 1'));
      digests = q('SELECT * FROM digests ORDER BY date DESC, created_at DESC, rowid DESC LIMIT 14');
    }
    const { workflows, runs } = this.wf.stateSlice(projectId);
    const templates = this.db.all(
      projectId ? 'SELECT * FROM templates WHERE project_id IS NULL OR project_id = ? ORDER BY rowid' : 'SELECT * FROM templates ORDER BY rowid',
      ...(projectId ? [projectId] : [])).map(toTemplate);
    const docs = this.db.all(
      projectId ? 'SELECT * FROM docs WHERE archived = 0 AND project_id = ? ORDER BY updated_at DESC, rowid DESC' : 'SELECT * FROM docs WHERE archived = 0 ORDER BY updated_at DESC, rowid DESC',
      ...(projectId ? [projectId] : [])).map((r) => toDoc(r, { blocks: false }));
    const concepts = this.db.all('SELECT * FROM concepts ORDER BY last_seen_at DESC, slug LIMIT ?', STATE_CONCEPTS).map((r) => toConcept(r));
    return {
      projects, templates, docs, concepts, sessions: sessions.map(toSession), agents: agents.map(toAgent),
      tasks: tasks.map(toTask), notes: notes.map(toNote), questions: questions.map(toQuestion),
      jobs: jobs.map(toJob), digests: digests.map(toDigest), workflows, runs, links: links.map(toLink),
      usageToday: usageToday(this.db, this.now()), seq: this.seqNow(),
    };
  }
  tasks({ sessionId, status, projectId } = {}) {
    const where = [], p = [];
    if (sessionId) { where.push('session_id = ?'); p.push(sessionId); }
    if (projectId) { where.push('project_id = ?'); p.push(projectId); }
    if (status) {
      const st = String(status).split(',').filter(Boolean);
      if (st.some((s) => !TASK_STATUSES.includes(s))) throw bad('invalid status');
      where.push(`status IN (${st.map(() => '?').join(',')})`); p.push(...st);
    }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY project_id, ord, rowid`;
    return this.db.all(sql, ...p).map(toTask);
  }
  taskDetail(id) {
    const t = this.p.getTask(id);
    if (!t) throw notFound('task not found');
    const agent = t.agent_id ? this.p.getAgent(t.agent_id) : null;
    return {
      task: toTask(t), agent: agent ? toAgent(agent) : null,
      activity: this.db.all('SELECT * FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT 200', id).map(toActivity),
      notes: this.db.all(`SELECT * FROM notes WHERE target_kind = 'task' AND target_id = ? ORDER BY rowid`, id).map(toNote),
    };
  }
  sessionActivity(id, limit) {
    return this.db.all('SELECT * FROM activity WHERE session_id = ? ORDER BY id DESC LIMIT ?', id, limit).map(toActivity);
  }
  sessionAgents(id) {
    return this.db.all('SELECT * FROM agents WHERE session_id = ? ORDER BY rowid', id).map(toAgent);
  }
  sessionProject(id) {
    const s = this.p.getSession(id);
    if (!s) throw notFound('session not found');
    return toProject(this.p.getProject(s.project_id));
  }
  /** Current conflicts, read from the projection so it always agrees with Task.conflicts. */
  conflicts() {
    return this.db.all('SELECT path, agents FROM conflicts ORDER BY path').map((r) => ({ path: r.path, agents: JSON.parse(r.agents) }));
  }
  questions({ state } = {}) {
    if (state !== undefined && state !== null && !['open', 'answered'].includes(state)) throw bad('state must be open or answered');
    const rows = state
      ? this.db.all('SELECT * FROM questions WHERE state = ? ORDER BY rowid DESC LIMIT 1000', state)
      : this.db.all('SELECT * FROM questions ORDER BY rowid DESC LIMIT 1000');
    return rows.reverse().map(toQuestion);
  }
  digests({ projectId, limit = 14 } = {}) {
    const rows = projectId
      ? this.db.all('SELECT * FROM digests WHERE project_id = ? ORDER BY date DESC, created_at DESC, rowid DESC LIMIT ?', projectId, limit)
      : this.db.all('SELECT * FROM digests ORDER BY date DESC, created_at DESC, rowid DESC LIMIT ?', limit);
    return rows.map(toDigest);
  }
  usage(days = 7) { return usageSummary(this.db, this.now(), days); }
  usageBreakdown(days = 7) { return usageBreakdown(this.db, this.now(), days); }
  search(q, limit) { return ftsSearch(this.db, q, limit, this.log); }
  learn(projectId) { return ftsLearn(this.db, projectId); }

  // ------------------------------------------------------- concepts (v0.13)
  /** Concepts for the Concepts tab: `q` matches name, slug and aliases (case-insensitive substring); sort recent|count|name. No summaries. */
  concepts({ q, sort = 'recent', limit = 1000 } = {}) {
    if (!['recent', 'count', 'name'].includes(sort)) throw bad('sort must be recent, count or name');
    const order = { recent: 'last_seen_at DESC, slug', count: 'count DESC, last_seen_at DESC, slug', name: 'name COLLATE NOCASE, slug' }[sort];
    let rows = this.db.all(`SELECT * FROM concepts ORDER BY ${order}`).map((r) => toConcept(r));
    const needle = isStr(q) ? q.trim().toLowerCase() : '';
    if (needle) {
      const flat = needle.replace(/[^a-z0-9]+/g, '');
      rows = rows.filter((c) => [c.name, c.slug, ...c.aliases].some((v) => {
        const l = v.toLowerCase();
        return l.includes(needle) || (flat && l.replace(/[^a-z0-9]+/g, '').includes(flat));
      }));
    }
    return { concepts: rows.slice(0, limit) };
  }
  conceptRow(slug) {
    const c = resolveConcept(this.db, slug);
    if (!c) throw notFound('concept not found');
    return c;
  }
  /** One concept with its summary and the tasks that taught it (newest first). */
  conceptDetail(slug) {
    const c = this.conceptRow(slug);
    const tasks = this.db.all(
      `SELECT t.*, ct.at AS c_at FROM concept_tasks ct JOIN tasks t ON t.id = ct.task_id WHERE ct.slug = ? ORDER BY ct.at DESC, ct.rowid DESC`, c.slug)
      .map((r) => {
        const t = toTask(r);
        return {
          id: t.id, title: t.title, projectId: t.projectId, status: t.status,
          what: t.recap?.what ?? '', how: t.recap?.how ?? '', learned: t.recap?.learned ?? '',
          doneAt: t.doneAt, at: r.c_at,
        };
      });
    return { concept: toConcept(c, { summary: true }), tasks };
  }
  updateConcept(slug, body, at = this.now()) {
    if (!isObj(body)) throw bad('body must be an object');
    const c = this.conceptRow(slug);
    const patch = {};
    if (body.name !== undefined) {
      if (!isStr(body.name) || !body.name.trim() || body.name.trim().length > 60) throw bad('name must be 1-60 characters');
      patch.name = body.name.trim();
    }
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== 'boolean') throw bad('pinned must be a boolean');
      patch.pinned = body.pinned;
    }
    if (body.summary !== undefined) {
      if (body.summary !== null && !isStr(body.summary)) throw bad('summary must be a string or null');
      patch.summary = body.summary === null || !body.summary.trim() ? null : body.summary;
    }
    if (body.aliases !== undefined) {
      if (!Array.isArray(body.aliases) || body.aliases.length > MAX_ALIASES || body.aliases.some((a) => !isStr(a))) {
        throw bad(`aliases must be an array of at most ${MAX_ALIASES} strings`);
      }
      const clean = [...new Set(body.aliases.map((a) => a.trim().toLowerCase()).filter(Boolean))];
      for (const a of clean) {
        const k = conceptKey(a);
        if (!k) throw bad(`alias "${a}" has no letters or digits`);
        const owner = this.db.get('SELECT slug FROM concept_keys WHERE key = ?', k.key)?.slug;
        if (owner && owner !== c.slug && getConcept(this.db, owner)) throw new HttpError(409, `"${a}" already belongs to the concept "${owner}": merge them instead`);
      }
      patch.aliases = clean;
    }
    if (!Object.keys(patch).length) throw bad('nothing to change');
    return this.tx(() => ({ concept: this.command('hub.concept.update', { slug: c.slug, patch }, at) }));
  }
  mergeConcepts(body, at = this.now()) {
    if (!isObj(body) || !isStr(body.from) || !isStr(body.into)) throw bad('body must be { from, into }');
    const from = this.conceptRow(body.from), into = this.conceptRow(body.into);
    if (from.slug === into.slug) throw bad('cannot merge a concept into itself');
    return this.tx(() => ({ concept: this.command('hub.concept.merge', { from: from.slug, into: into.slug }, at) }));
  }
  /** Ask a live session (Haiku, via the mod) to write the concept's page. One open job per concept. */
  summarizeConcept(slug, at = this.now()) {
    const c = this.conceptRow(slug);
    const open = this.db.get(
      `SELECT * FROM jobs WHERE kind = 'concept_summary' AND state IN ('queued','running') AND json_extract(input, '$.concept.slug') = ? ORDER BY rowid DESC LIMIT 1`, c.slug);
    if (open) return { job: toJob(open) };
    const sessionId = this.pickJobSession(null, null);
    const concept = toConcept(c);
    const learnedLines = this.db.all(
      `SELECT t.id, t.title, t.recap FROM concept_tasks ct JOIN tasks t ON t.id = ct.task_id WHERE ct.slug = ? ORDER BY ct.at DESC, ct.rowid DESC LIMIT 20`, c.slug)
      .map((r) => {
        const rc = JSON.parse(r.recap || '{}');
        return { taskId: r.id, title: cut(r.title, 200), learned: cut(rc.learned || '', 600), how: cut(rc.how || '', 600) };
      });
    const related = concept.related.map((s) => getConcept(this.db, s)?.name).filter(Boolean);
    const input = {
      concept: { slug: concept.slug, name: concept.name, aliases: concept.aliases, count: concept.count },
      learnedLines, related,
    };
    return this.tx(() => ({
      job: this.command('hub.job.create', { kind: 'concept_summary', sessionId, taskId: null, projectId: null, input }, at),
    }));
  }

  // ------------------------------------------------------- templates (v0.11)
  /** Templates visible to a project (its own plus the global ones), or all of them. Archived ones only on request. */
  templates({ projectId, includeArchived = false } = {}) {
    if (projectId && !this.p.getProject(projectId)) throw notFound('project not found');
    const where = [], p = [];
    if (projectId) { where.push('(project_id IS NULL OR project_id = ?)'); p.push(projectId); }
    if (!includeArchived) where.push('archived = 0');
    return this.db.all(`SELECT * FROM templates ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rowid`, ...p).map(toTemplate);
  }
  /** Validate the optional template fields of a body; only the keys present are returned. */
  cleanTemplateFields(b) {
    const o = {};
    if (b.name !== undefined) o.name = cleanName(b.name);
    if (b.title !== undefined) o.title = cleanTitle(b.title);
    if (b.description !== undefined) o.description = cleanText(b.description, 'description', 20000, true);
    if (b.agent !== undefined) {
      if (!TEMPLATE_AGENTS.includes(b.agent)) throw bad('agent must be builder, scout or auto');
      o.agent = b.agent;
    }
    if (b.checks !== undefined) {
      if (!Array.isArray(b.checks) || b.checks.some((c) => !isStr(c))) throw bad('checks must be an array of strings');
      const list = b.checks.map((c) => c.trim().slice(0, 300)).filter(Boolean);
      if (list.length > MAX_CHECKS) throw bad(`at most ${MAX_CHECKS} checks`);
      o.checks = list;
    }
    if (b.tags !== undefined) {
      if (!Array.isArray(b.tags) || b.tags.some((c) => !isStr(c))) throw bad('tags must be an array of strings');
      o.tags = [...new Set(b.tags.map((c) => c.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, MAX_TAGS);
    }
    if (b.projectId !== undefined) {
      if (b.projectId !== null && (!isStr(b.projectId) || !this.p.getProject(b.projectId))) throw notFound('project not found');
      o.projectId = b.projectId;
    }
    return o;
  }
  createTemplate(body, at = this.now()) {
    if (!isObj(body)) throw bad('body must be an object');
    const f = this.cleanTemplateFields(body);
    let data;
    if (body.fromTaskId !== undefined) {
      if (!isStr(body.fromTaskId)) throw bad('fromTaskId must be a task id');
      const t = this.p.getTask(body.fromTaskId);
      if (!t) throw notFound('task not found');
      const agent = t.agent_id ? this.p.getAgent(t.agent_id) : null;
      data = {
        projectId: t.project_id, name: t.title.slice(0, 200), title: t.title, description: t.description,
        agent: agent ? agentOfSubagent(agent.subagent_type) : 'auto', checks: [], tags: [], ...f,
      };
    } else {
      if (f.name === undefined) throw bad('name must be a non-empty string');
      if (f.title === undefined) throw bad('title must be a non-empty string');
      data = { projectId: null, description: '', agent: 'auto', checks: [], tags: [], ...f };
    }
    return this.tx(() => ({ template: this.command('hub.template.create', data, at) }));
  }
  updateTemplate(id, body, at = this.now()) {
    if (!getTemplate(this.db, id)) throw notFound('template not found');
    if (!isObj(body)) throw bad('body must be an object');
    const patch = this.cleanTemplateFields(body);
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw bad('archived must be a boolean');
      patch.archived = body.archived;
    }
    return this.tx(() => ({ template: this.command('hub.template.update', { id, patch }, at) }));
  }
  archiveTemplate(id, at = this.now()) { return this.updateTemplate(id, { archived: true }, at); }
  /**
   * Make a task from a template: `{{var}}` filled from `vars`, Checks / Preferred agent lines appended. With `start` the task
   * is started by the same rule as /start; if that is refused (409) nothing is created and the usage count does not move.
   */
  useTemplate(id, body, at = this.now()) {
    const tpl = getTemplate(this.db, id);
    if (!tpl) throw notFound('template not found');
    if (tpl.archived) throw new HttpError(409, 'this template is archived');
    const b = body ?? {};
    if (!isObj(b)) throw bad('body must be an object');
    const projectId = b.projectId ?? tpl.project_id;
    if (!isStr(projectId) || !this.p.getProject(projectId)) throw notFound('project not found');
    if (tpl.project_id && tpl.project_id !== projectId) throw bad('this template belongs to another project');
    const vars = b.vars ?? {};
    if (!isObj(vars) || Object.values(vars).some((v) => !isStr(v))) throw bad('vars must be an object of strings');
    if (b.start !== undefined && typeof b.start !== 'boolean') throw bad('start must be a boolean');
    const { title, description } = renderTemplate(toTemplate(tpl), vars);
    return this.tx(() => {
      const task = this.command('hub.task.create', { projectId, title, description, status: 'backlog', dependsOn: [], sessionId: null }, at);
      let out = { task };
      if (b.start === true) {
        const plan = this.startPlan(this.p.getTask(task.id)); // 409 (no live session) rolls the whole command back
        out = this.command('hub.task.start', { id: task.id, ...plan }, at);
      }
      const template = this.command('hub.template.used', { id }, at);
      return { ...out, template };
    });
  }

  // ------------------------------------------------------------- commands
  // `at` is only overridden by the seeder (virtual clock); HTTP callers never pass it.
  createProject(body, at = this.now()) {
    const name = cleanName(body?.name);
    return this.tx(() => ({ project: this.command('hub.project.create', { name }, at) }));
  }
  updateProject(id, body, at = this.now()) {
    if (!this.p.getProject(id)) throw notFound('project not found');
    const data = { id };
    if (body?.name !== undefined) data.name = cleanName(body.name);
    if (body?.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw bad('archived must be a boolean');
      data.archived = body.archived;
    }
    if (body?.autoStart !== undefined) {
      if (typeof body.autoStart !== 'boolean') throw bad('autoStart must be a boolean');
      data.autoStart = body.autoStart;
    }
    if (body?.autoConcurrency !== undefined) {
      const n = body.autoConcurrency;
      if (!Number.isInteger(n) || n < 1 || n > MAX_AUTO_CONCURRENCY) throw bad(`autoConcurrency must be an integer from 1 to ${MAX_AUTO_CONCURRENCY}`);
      data.autoConcurrency = n;
    }
    this.lastAuto = [];
    const project = this.tx(() => this.command('hub.project.update', data, at));
    return { project: this.p.getProject(id) ? toProject(this.p.getProject(id)) : project, autoStarted: this.lastAuto.slice() };
  }
  joinSession(sessionId, body, at = this.now()) {
    if (!this.p.getSession(sessionId)) throw notFound('session not found');
    if (!isStr(body?.projectId) || !this.p.getProject(body.projectId)) throw notFound('project not found');
    return this.tx(() => ({ session: this.command('hub.session.join', { sessionId, projectId: body.projectId }, at) }));
  }
  createTask(body, at = this.now()) {
    if (!isObj(body)) throw bad('body must be an object');
    if (!isStr(body.projectId) || !this.p.getProject(body.projectId)) throw notFound('project not found');
    const title = cleanTitle(body.title);
    const description = body.description === undefined ? '' : cleanText(body.description, 'description', 20000, true);
    const status = body.status === undefined ? 'backlog' : body.status;
    if (!TASK_STATUSES.includes(status)) throw bad('invalid status');
    const dependsOn = this.checkDeps(body.dependsOn ?? [], null);
    let sessionId = null;
    if (body.sessionId !== undefined && body.sessionId !== null) {
      if (!isStr(body.sessionId)) throw bad('sessionId must be a string');
      sessionId = body.sessionId;
    }
    const start = body.start === true;
    const from = this.crossFrom(body.fromSessionId, body.projectId);
    return this.tx(() => {
      const task = this.command('hub.task.create', {
        projectId: body.projectId, title, description, status, dependsOn, sessionId,
        ...(from ? { createdBySessionId: from.id, fromProjectId: from.project_id } : {}),
      }, at);
      if (from) this.command('hub.link.create', this.taskLink(from, body.projectId, task.id, `created ${task.id}: ${cut(task.title, 120)}`), at);
      if (!start) return { task };
      let plan;
      try { plan = this.startPlan(this.p.getTask(task.id)); } catch (e) {
        if (e instanceof HttpError) return { task, error: e.message }; // the task is still created
        throw e;
      }
      return this.command('hub.task.start', { id: task.id, ...plan }, at);
    });
  }
  /** Validate a Start and build its note: { sessionId, text }. Throws 409 when not allowed / no live session. */
  startPlan(t) {
    if (toTask(t).interrupted) return this.resumePlan(t); // T-70: Start on an interrupted card is a Resume
    if (!START_FROM.includes(t.status)) throw new HttpError(409, `cannot start a task that is ${t.status}`);
    const sessionId = this.pickJobSession(t.session_id, t.project_id);
    // Draft notes on the task ride along with Start (v0.8): folded after the Brief, marked ran by the same event.
    const { drafts, notesBlock } = this.draftNotes(t);
    const text = `Start Helm task ${t.id} \u201c${t.title}\u201d.\n\nBrief:\n${t.description}\n\n${notesBlock}`
      + `Create nothing new: delegate this existing task now with the Agent tool (description starting with [helm:${t.id}]), `
      + 'choosing helm:builder for code changes or helm:scout for read-only work, run it in the background, '
      + 'then reply in one line with what you started.';
    return { sessionId, text, noteIds: drafts.map((n) => n.id) };
  }
  draftNotes(t) {
    const drafts = this.db.all(
      `SELECT * FROM notes WHERE target_kind = 'task' AND target_id = ? AND state = 'draft' ORDER BY created_at, rowid`, t.id);
    const folded = drafts.map((n) => {
      const files = JSON.parse(n.attachments || '[]');
      const att = files.length ? `\n  Attached files (open them with the Read tool):\n${files.map((f) => `  - ${f.path}`).join('\n')}` : '';
      return `- ${n.text}${att}`;
    });
    return { drafts, notesBlock: folded.length ? `Notes from the user:\n${folded.join('\n')}\n\n` : '' };
  }
  /** T-70: Resume an interrupted task. Same queue as Start, but the note is a task note the mod turns into a follow-up builder. */
  resumePlan(t) {
    const t2 = toTask(t);
    if (!t2.interrupted) throw new HttpError(409, 'only an interrupted task can be resumed');
    const inflight = t.start_note_id ? this.p.getNote(t.start_note_id) : null;
    if (inflight && (inflight.state === 'queued' || inflight.state === 'sending')) throw new HttpError(409, 'already starting');
    const sessionId = this.pickJobSession(t.session_id, t.project_id);
    const { drafts, notesBlock } = this.draftNotes(t);
    const text = `!${RESUME_MARK} Resume Helm task ${t.id} \u201c${t.title}\u201d: its agent was stopped mid-task.\n\n${notesBlock}`.trimEnd();
    return { sessionId, text, noteIds: drafts.map((n) => n.id), resume: true };
  }
  resumeTask(id, at = this.now()) {
    const t = this.p.getTask(id);
    if (!t) throw notFound('task not found');
    const plan = this.resumePlan(t);
    return this.tx(() => this.command('hub.task.start', { id, ...plan }, at));
  }
  startTask(id, at = this.now()) {
    const t = this.p.getTask(id);
    if (!t) throw notFound('task not found');
    const plan = this.startPlan(t);
    return this.tx(() => this.command('hub.task.start', { id, ...plan }, at));
  }
  /**
   * Choices: create one task per picked choice (linked to the parent), start each when `start` (a 409 is recorded in
   * `errors` and never fails the batch), then mark picked / skipped. Every step is a hub.* event, so replay is exact.
   */
  applyChoices(id, body, at = this.now()) {
    const t = this.p.getTask(id);
    if (!t) throw notFound('task not found');
    if (!isObj(body) || !Array.isArray(body.picked) || body.picked.some((x) => !isStr(x))) throw bad('picked must be an array of choice ids');
    const choices = JSON.parse(t.choices || '[]');
    const byId = new Map(choices.map((c) => [c.id, c]));
    const picked = [...new Set(body.picked)];
    for (const cid of picked) {
      const c = byId.get(cid);
      if (!c) throw bad(`unknown choice: ${cid}`);
      if (c.state !== 'open') throw bad(`choice ${cid} is already ${c.state}`);
    }
    const start = body.start === true;
    const notes = body.notes === undefined || body.notes === null ? {} : body.notes;
    if (!isObj(notes) || Array.isArray(notes) || Object.values(notes).some((v) => !isStr(v) || v.length > 500)) throw bad('notes must be an object of strings (max 500 characters each)');
    if (body.message !== undefined && body.message !== null && (!isStr(body.message) || body.message.length > 1000)) throw bad('message must be a string (max 1000 characters)');
    const message = isStr(body.message) ? body.message.trim() : '';
    return this.tx(() => {
      const tasks = [], errors = [], results = [];
      for (const cid of picked) {
        const c = byId.get(cid);
        const note = isStr(notes[cid]) ? notes[cid].trim() : '';
        const description = `${c.detail ? c.detail + '\n\n' : ''}${note ? `Note: ${note}\n\n` : ''}${message ? `Message: ${message}\n\n` : ''}From ${t.id}.`;
        const task = this.command('hub.task.create', {
          projectId: t.project_id, title: c.title, description, status: 'backlog', dependsOn: [],
          sessionId: t.session_id ?? null, parentTaskId: t.id,
        }, at);
        results.push({ choiceId: cid, taskId: task.id, note, message });
        let out = task;
        if (start) {
          try {
            const plan = this.startPlan(this.p.getTask(task.id));
            out = this.command('hub.task.start', { id: task.id, ...plan }, at).task;
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            errors.push({ choiceId: cid, taskId: task.id, error: e.message, status: e.status });
          }
        }
        tasks.push(out);
      }
      const parent = this.command('hub.task.choices', { id, mode: 'apply', results }, at);
      return { tasks, choices: parent.choices, errors };
    });
  }
  resetChoices(id, at = this.now()) {
    if (!this.p.getTask(id)) throw notFound('task not found');
    return this.tx(() => {
      const task = this.command('hub.task.choices', { id, mode: 'reset' }, at);
      return { task, choices: task.choices };
    });
  }
  updateTask(id, body, at = this.now()) {
    const t = this.p.getTask(id);
    if (!t) throw notFound('task not found');
    if (!isObj(body)) throw bad('body must be an object');
    const patch = {};
    if (body.title !== undefined) patch.title = cleanTitle(body.title);
    if (body.description !== undefined) patch.description = cleanText(body.description, 'description', 20000, true);
    if (body.status !== undefined) {
      if (!TASK_STATUSES.includes(body.status)) throw bad('invalid status');
      patch.status = body.status;
    }
    if (body.order !== undefined) {
      if (typeof body.order !== 'number' || !Number.isFinite(body.order)) throw bad('order must be a number');
      patch.order = body.order;
    }
    if (body.dependsOn !== undefined) patch.dependsOn = this.checkDeps(body.dependsOn, id);
    if (body.blockedReason !== undefined) {
      if (body.blockedReason !== null && !isStr(body.blockedReason)) throw bad('blockedReason must be a string or null');
      patch.blockedReason = body.blockedReason === null ? null : cut(body.blockedReason, 500);
    }
    const from = this.crossFrom(body.fromSessionId, t.project_id);
    if (from && body.work === true) throw new HttpError(403, WORK_MSG); // `work` is for a session's own cards, even the coordinator's
    const out = this.tx(() => {
      const task = this.command('hub.task.update', { id, patch }, at);
      if (from) {
        const what = Object.keys(patch).map((k) => (k === 'status' ? `status \u2192 ${patch.status}` : k)).join(', ');
        this.command('hub.link.create', this.taskLink(from, t.project_id, id, `updated ${id}: ${what}`), at);
      }
      return { task };
    });
    // A task the main loop did itself has no agent.completed to trigger a snapshot: moving it to review/done does.
    if (this.autoSnapshot && t.git && (patch.status === 'review' || patch.status === 'done')) {
      const p = new Promise((r) => setImmediate(r)).then(() => this.snapshotTask(id))
        .catch((e) => this.log?.warn(`diff snapshot failed for ${id}`, e)).finally(() => this.snapshots.delete(p));
      this.snapshots.add(p);
    }
    return out;
  }
  checkDeps(deps, selfId) {
    if (!Array.isArray(deps) || deps.some((d) => !isStr(d))) throw bad('dependsOn must be an array of task ids');
    const uniq = [...new Set(deps)];
    for (const d of uniq) {
      if (d === selfId) throw bad('a task cannot depend on itself');
      if (!this.p.getTask(d)) throw bad(`unknown task in dependsOn: ${d}`);
    }
    if (selfId) {
      // reject cycles: walk from each dependency; reaching selfId means a loop
      const seen = new Set();
      const stack = [...uniq];
      while (stack.length) {
        const cur = stack.pop();
        if (cur === selfId) throw bad('dependsOn would create a cycle');
        if (seen.has(cur)) continue;
        seen.add(cur);
        const row = this.p.getTask(cur);
        if (row) stack.push(...JSON.parse(row.depends_on || '[]'));
      }
    }
    return uniq;
  }

  /** Validate attachment ids on a note: an array of <= 10 distinct ids that all exist. */
  checkAttachments(ids) {
    if (!Array.isArray(ids) || ids.some((a) => !isStr(a))) throw bad('attachments must be an array of attachment ids');
    const uniq = [...new Set(ids)];
    if (uniq.length > MAX_NOTE_ATTACHMENTS) throw bad(`at most ${MAX_NOTE_ATTACHMENTS} attachments per note`);
    for (const a of uniq) if (!this.p.getAttachment(a)) throw bad(`unknown attachment: ${a}`);
    return uniq;
  }
  /**
   * Store an uploaded file: the metadata is an event (so a rebuild reproduces the row), the bytes go to
   * `<home>/attachments/<A-n>/<safe name>`. Both happen in one transaction: a failed write leaves no row.
   */
  addAttachment({ data, name, mime }, at = this.now()) {
    if (!Buffer.isBuffer(data) || !data.length) throw bad('empty body: send the file bytes as the request body');
    const safe = safeFilename(name);
    const type = cleanMime(mime);
    return this.tx(() => {
      const a = this.command('hub.attachment.create', { name: safe, mime: type, size: data.length }, at);
      const dir = path.join(this.cfg.attachDir, a.id);
      fs.rmSync(dir, { recursive: true, force: true }); // a stale dir from a database that was reset
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, safe), data);
      return { attachment: a };
    });
  }
  /** Row + on-disk file for GET /v1/attachments/:id. */
  attachmentFile(id) {
    const r = this.p.getAttachment(id);
    if (!r) throw notFound('attachment not found');
    const a = toAttachment(r, this.cfg.attachDir);
    let st;
    try { st = fs.statSync(a.path); } catch { throw notFound('attachment file is missing on disk'); }
    return { ...a, size: st.size };
  }

  resolveNoteSession(target) {
    if (target.kind === 'session') {
      if (!this.p.getSession(target.id)) throw notFound('target session not found');
      return target.id;
    }
    const t = this.p.getTask(target.id);
    if (!t) throw notFound('target task not found');
    const live = (sid) => {
      const s = sid && this.p.getSession(sid);
      return s && s.status !== 'ended' ? sid : null;
    };
    const agentSession = t.agent_id ? this.p.getAgent(t.agent_id)?.session_id : null;
    const recent = this.db.get(
      `SELECT id FROM sessions WHERE project_id = ? AND status != 'ended' ORDER BY last_seen_at DESC, rowid DESC LIMIT 1`,
      t.project_id)?.id;
    return live(t.session_id) || live(agentSession) || recent || t.session_id || agentSession || '';
  }
  createNote(body, at = this.now()) {
    if (!isObj(body) || !isObj(body.target)) throw bad('target is required');
    const { kind, id } = body.target;
    if (!['session', 'task'].includes(kind) || !isStr(id)) throw bad('target must be { kind: "session"|"task", id }');
    const text = cleanText(body.text, 'text', 10000, false);
    const attachments = body.attachments === undefined ? [] : this.checkAttachments(body.attachments);
    const sessionId = this.resolveNoteSession({ kind, id });
    const execute = body.execute === true;
    if (execute && !sessionId) throw new HttpError(409, 'no session available to deliver this note to');
    return this.tx(() => {
      const note = this.command('hub.note.create', { target: { kind, id }, text, sessionId, attachments }, at);
      if (!execute) return { note };
      const [queued] = this.command('hub.note.execute', { ids: [note.id], sessions: { [note.id]: sessionId } }, at);
      return { note: queued };
    });
  }
  updateNote(id, body, at = this.now()) {
    const n = this.p.getNote(id);
    if (!n) throw notFound('note not found');
    if (n.state !== 'draft') throw new HttpError(409, 'only draft notes can be edited');
    if (!isObj(body)) throw bad('body must be an object');
    if (body.text === undefined && body.attachments === undefined) throw bad('text or attachments is required');
    const data = { id };
    if (body.text !== undefined) data.text = cleanText(body.text, 'text', 10000, false);
    if (body.attachments !== undefined) data.attachments = this.checkAttachments(body.attachments);
    return this.tx(() => ({ note: this.command('hub.note.update', data, at) }));
  }
  deleteNote(id, at = this.now()) {
    const n = this.p.getNote(id);
    if (!n) throw notFound('note not found');
    if (n.state !== 'draft') throw new HttpError(409, 'only draft notes can be deleted');
    this.tx(() => this.command('hub.note.delete', { id }, at));
    return { ok: true };
  }
  executeNotes(body, at = this.now()) {
    if (!isObj(body) || !isObj(body.target)) throw bad('target is required');
    const { kind, id } = body.target;
    if (!['session', 'task'].includes(kind) || !isStr(id)) throw bad('target must be { kind: "session"|"task", id }');
    const sid = this.resolveNoteSession({ kind, id });
    const drafts = this.db.all(
      `SELECT id FROM notes WHERE target_kind = ? AND target_id = ? AND state = 'draft' ORDER BY rowid`, kind, id);
    if (!drafts.length) return { notes: [] };
    if (!sid) throw new HttpError(409, 'no session available to deliver these notes to');
    const sessions = Object.fromEntries(drafts.map((d) => [d.id, sid]));
    return this.tx(() => ({ notes: this.command('hub.note.execute', { ids: drafts.map((d) => d.id), sessions }, at) }));
  }
  retryNote(id, at = this.now()) {
    const n = this.p.getNote(id);
    if (!n) throw notFound('note not found');
    if (n.state !== 'failed') throw new HttpError(409, 'only failed notes can be retried');
    let sessionId = n.session_id;
    if (n.target_kind === 'task') {
      const s = this.p.getSession(sessionId);
      if (!s || s.status === 'ended') sessionId = this.resolveNoteSession({ kind: 'task', id: n.target_id }) || sessionId;
    }
    if (!sessionId) throw new HttpError(409, 'no session available to deliver this note to');
    return this.tx(() => ({ note: this.command('hub.note.retry', { id, sessionId }, at) }));
  }
  /** Atomically move this session's queued notes to `sending` and return them (oldest first). */
  claimInbox(sessionId, at = this.now()) {
    const peek = () => this.db.all(
      `SELECT id FROM notes WHERE session_id = ? AND state = 'queued' ORDER BY queued_at, rowid`, sessionId);
    if (!peek().length) return { notes: [] };
    return this.tx(() => {
      const ids = peek().map((r) => r.id);
      if (!ids.length) return { notes: [] };
      return { notes: this.command('hub.note.claim', { ids, sessionId }, at) };
    });
  }

  dismissQuestion(id, at = this.now()) {
    const q = this.p.getQuestion(id);
    if (!q) throw notFound('question not found');
    if (q.kind === 'approval' && q.state === 'open') throw new HttpError(409, 'this is a workflow gate: approve or reject it instead');
    return this.tx(() => ({ question: this.command('hub.question.dismiss', { id }, at) }));
  }

  // ----------------------------------------------------------------- jobs
  /** Who runs a model job: the task's session, else the project's newest live one, else any active session. */
  pickJobSession(sessionId, projectId) {
    const s = sessionId ? this.p.getSession(sessionId) : null;
    if (s && s.status !== 'ended') return s.id;
    if (projectId) {
      const r = this.db.get(
        `SELECT id FROM sessions WHERE project_id = ? AND status IN ('active','idle') ORDER BY last_seen_at DESC, rowid DESC LIMIT 1`,
        projectId);
      if (r) return r.id;
    }
    const any = this.db.get(`SELECT id FROM sessions WHERE status = 'active' ORDER BY last_seen_at DESC, rowid DESC LIMIT 1`);
    if (any) return any.id;
    throw new HttpError(409, 'no live session');
  }
  /** T-76: give every finished task without a recap one (see hub/recapjobs.mjs). Body: { dryRun, improve, taskIds, reports }. */
  backfillRecaps(body) {
    if (body !== undefined && !isObj(body)) throw bad('body must be an object');
    const b = body || {};
    if (b.reports !== undefined && !isObj(b.reports)) throw bad('reports must be an object of agentId -> report text');
    if (b.taskIds !== undefined && !(Array.isArray(b.taskIds) && b.taskIds.every(isStr))) throw bad('taskIds must be an array of strings');
    return backfillRecapsImpl(this, b);
  }
  explainTask(id, at = this.now()) {
    const t = this.p.getTask(id);
    if (!t) throw notFound('task not found');
    const open = this.db.get(
      `SELECT * FROM jobs WHERE kind = 'explain' AND task_id = ? AND state IN ('queued','running') ORDER BY rowid DESC LIMIT 1`, id);
    if (open) return { job: toJob(open) };
    const sessionId = this.pickJobSession(t.session_id, t.project_id);
    const activity = this.db.all(
      `SELECT summary FROM activity WHERE task_id = ? AND kind = 'tool' ORDER BY id DESC LIMIT 40`, id)
      .map((r) => r.summary).reverse();
    const task = toTask(t);
    const input = {
      title: task.title, description: task.description, recap: task.recap, filesChanged: task.filesChanged, activity,
    };
    return this.tx(() => ({
      job: this.command('hub.job.create', { kind: 'explain', sessionId, taskId: id, projectId: t.project_id, input }, at),
    }));
  }
  requestDigest(body, at = this.now()) {
    if (body !== undefined && !isObj(body)) throw bad('body must be an object');
    const b = body || {};
    let date = localDate(at);
    if (b.date !== undefined && b.date !== null) {
      const m = isStr(b.date) ? DATE_RE.exec(b.date) : null;
      const dt = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
      if (!dt || dt.getFullYear() !== Number(m[1]) || dt.getMonth() !== Number(m[2]) - 1 || dt.getDate() !== Number(m[3])) {
        throw bad('date must be a valid YYYY-MM-DD');
      }
      date = b.date;
    }
    let projectId = null, projectName = null;
    if (b.projectId !== undefined && b.projectId !== null) {
      const p = isStr(b.projectId) ? this.p.getProject(b.projectId) : null;
      if (!p) throw notFound('project not found');
      projectId = p.id; projectName = p.name;
    }
    const sessionId = this.pickJobSession(null, projectId);
    const [y, mo, d] = date.split('-').map(Number);
    const from = new Date(y, mo - 1, d).getTime(), to = new Date(y, mo - 1, d + 1).getTime();
    const scope = projectId ? ' AND project_id = ?' : '';
    const sp = projectId ? [projectId] : [];
    const doneRows = this.db.all(
      `SELECT * FROM tasks WHERE status = 'done' AND done_at >= ? AND done_at < ?${scope} ORDER BY done_at, rowid`, from, to, ...sp);
    const rows = (status) => this.db.all(
      `SELECT * FROM tasks WHERE status = ? AND updated_at >= ? AND updated_at < ?${scope} ORDER BY updated_at, rowid`, status, from, to, ...sp);
    const done = doneRows.map(toTask);
    const concepts = [];
    for (const t of done) {
      for (const c of t.recap?.concepts || []) if (!concepts.some((x) => x.toLowerCase() === c.toLowerCase())) concepts.push(c);
    }
    const input = {
      date, projectName,
      done: done.map((t) => ({ id: t.id, title: t.title, recap: t.recap })),
      blocked: rows('blocked').map((t) => ({ id: t.id, title: t.title, reason: t.blocked_reason ?? '' })),
      inProgress: rows('in_progress').map((t) => ({ id: t.id, title: t.title })),
      concepts,
    };
    return this.tx(() => ({
      job: this.command('hub.job.create', { kind: 'digest', sessionId, taskId: null, projectId, input }, at),
    }));
  }
  /** Atomically move this session's queued jobs to `running` and return them (oldest first). */
  claimJobs(sessionId, at = this.now()) {
    const peek = () => this.db.all(
      `SELECT id FROM jobs WHERE session_id = ? AND state = 'queued' ORDER BY created_at, rowid`, sessionId);
    if (!peek().length) return { jobs: [] };
    return this.tx(() => {
      const ids = peek().map((r) => r.id);
      if (!ids.length) return { jobs: [] };
      return { jobs: this.command('hub.job.claim', { ids, sessionId }, at) };
    });
  }

  // ------------------------------------------- coordinator, links and acknowledge (v0.26)
  /**
   * A mod call made on behalf of a session: the session row when `sessionId` is given and `projectId` is another project's
   * (allowed only from the coordinator project), null when the call stays in the session's own project or names no session.
   */
  crossFrom(sessionId, projectId) {
    if (sessionId === undefined || sessionId === null) return null;
    const s = isStr(sessionId) ? this.p.getSession(sessionId) : null;
    if (!s) throw notFound('session not found');
    if (s.project_id === projectId) return null;
    if (!this.p.getProject(s.project_id)?.coordinator) throw new HttpError(403, COORD_MSG);
    return s;
  }
  taskLink(from, toProjectId, refId, text) {
    return { kind: 'task', fromSessionId: from.id, fromProjectId: from.project_id, toProjectId, toSessionId: null, refId, text };
  }
  /** Projects a reference names: a P-id, a name (case-insensitive) or the last folder of a session's cwd. Archived ones only by id. */
  findProjects(ref) {
    if (!isStr(ref) || !ref.trim()) throw bad('project reference must be a non-empty string');
    const r = ref.trim(), low = r.toLowerCase();
    const byId = this.p.getProject(r);
    if (byId) return [byId];
    const live = this.db.all('SELECT * FROM projects WHERE archived = 0 ORDER BY rowid');
    const tails = new Map();
    for (const x of this.db.all('SELECT project_id, cwd FROM sessions ORDER BY rowid')) {
      const tail = x.cwd.split(/[\\/]+/).filter(Boolean).pop();
      if (tail) tails.set(x.project_id, [...(tails.get(x.project_id) ?? []), tail.toLowerCase()]);
    }
    const by = (pred) => live.filter(pred);
    return by((p) => p.name.toLowerCase() === low).length ? by((p) => p.name.toLowerCase() === low)
      : by((p) => (tails.get(p.id) ?? []).includes(low));
  }
  /** GET /v1/projects/resolve?ref=: exactly one project (404 none, 409 more than one). */
  resolveProject(ref) {
    const found = this.findProjects(ref);
    if (!found.length) throw notFound(`no project matches \u201c${cut(ref, 80)}\u201d`);
    if (found.length > 1) throw new HttpError(409, `\u201c${cut(ref, 80)}\u201d matches several projects: ${found.map((p) => p.id).join(', ')}`);
    return { project: toProject(found[0]) };
  }
  /** Human-only (the route checks the transport): make a project the coordinator, or stop it being one. */
  setCoordinator(projectId, on, at = this.now()) {
    if (!this.p.getProject(projectId)) throw notFound('project not found');
    if (typeof on !== 'boolean') throw bad('on must be a boolean');
    return this.tx(() => ({ project: this.command('hub.project.coordinator', { projectId, on }, at) }));
  }
  /** Mod-only (the /helm coordinator command): the same, for the project of the session that typed it. */
  setSessionCoordinator(sessionId, on, at = this.now()) {
    const s = this.p.getSession(sessionId);
    if (!s) throw notFound('session not found');
    return this.setCoordinator(s.project_id, on, at);
  }
  /**
   * POST /v1/links { kind: 'note', fromSessionId, to, text }: a session sends a note to another project. A spoke may only note
   * the coordinator; the coordinator may note any other project. It goes to the target project's newest live session, or waits
   * (state queued) until one starts. The decision (target session) is carried in the event, so replay never re-decides.
   */
  createLink(body, at = this.now()) {
    if (!isObj(body) || body.kind !== 'note') throw bad('body must be { kind: "note", fromSessionId, to, text }');
    const from = isStr(body.fromSessionId) ? this.p.getSession(body.fromSessionId) : null;
    if (!from) throw notFound('session not found');
    const [target, ...more] = this.findProjects(body.to);
    if (!target) throw notFound(`no project matches \u201c${cut(String(body.to), 80)}\u201d`);
    if (more.length) throw new HttpError(409, `\u201c${cut(String(body.to), 80)}\u201d matches several projects`);
    if (target.id === from.project_id) throw bad('a note goes to another project: this session is already in it');
    const fromIsCoordinator = !!this.p.getProject(from.project_id)?.coordinator;
    if (!fromIsCoordinator && !target.coordinator) {
      throw new HttpError(403, this.db.get('SELECT 1 AS x FROM projects WHERE coordinator = 1')
        ? 'Only the coordinator session can note a project other than the coordinator.'
        : 'No coordinator project is set, so there is nobody to send this to. The user can set one with /helm coordinator on.');
    }
    if (isStr(body.text) && body.text.length > 2000) throw bad('text must be at most 2000 characters');
    const text = cleanText(body.text, 'text', 2000, false);
    return this.tx(() => ({
      link: this.command('hub.link.create', {
        kind: 'note', fromSessionId: from.id, fromProjectId: from.project_id, toProjectId: target.id,
        toSessionId: this.p.pickLive(target.id) ?? null, text,
      }, at),
    }));
  }
  /** After every committed change: hand held link notes to a session that is now live, and rescue ones stranded on an ended session. */
  deliverLinks(at = this.now()) {
    if (this.inLinks || this.replaying || this.closed) return;
    this.inLinks = true;
    try {
      const num = (id) => Number(String(id).slice(2)) || 0; // N-<n>: oldest first (the query has no ORDER BY so the covering index serves it)
      const held = this.db.all(`SELECT ref_id, to_project_id FROM links WHERE kind = 'note' AND state = 'queued'`)
        .map((l) => ({ noteId: l.ref_id, projectId: l.to_project_id })).sort((a, b) => num(a.noteId) - num(b.noteId));
      const stranded = this.db.all(
        `SELECT n.id, n.link_id, l.ref_id, l.to_project_id, l.from_project_id FROM notes n
           JOIN sessions s ON s.id = n.session_id JOIN links l ON l.id = n.link_id
          WHERE n.link_id IS NOT NULL AND n.state = 'queued' AND s.status = 'ended' ORDER BY n.rowid`)
        .map((r) => ({ noteId: r.id, projectId: r.id === r.ref_id ? r.to_project_id : r.from_project_id }));
      for (const j of [...held, ...stranded]) {
        const sessionId = this.p.pickLive(j.projectId);
        if (sessionId) this.tx(() => this.command('hub.link.deliver', { noteId: j.noteId, sessionId }, at));
      }
    } catch (e) {
      this.log?.error('link delivery failed', e);
    } finally {
      this.inLinks = false;
    }
  }
  /** Why a row cannot be acknowledged yet (a string), or null. Throws 404 when it does not exist. */
  ackBlock(kind, id) {
    if (kind === 'agent') {
      const a = this.p.getAgent(id);
      if (!a) throw notFound('agent not found');
      return ['running', 'stalled', 'waiting'].includes(a.status) ? `the agent is ${a.status}` : null;
    }
    if (kind === 'session') {
      const s = this.p.getSession(id);
      if (!s) throw notFound('session not found');
      if (s.status !== 'ended') return 'the session is still live';
      const n = this.db.get(`SELECT COUNT(*) AS n FROM agents WHERE session_id = ? AND status IN ('running','stalled','waiting')`, id).n;
      return n ? `${n} subagent${n === 1 ? '' : 's'} still running` : null;
    }
    const l = this.p.getLink(id);
    if (!l) throw notFound('link not found');
    return l.state === 'answered' ? null : `the link is ${l.state}, not answered yet`;
  }
  ackRow(kind, id) {
    if (kind === 'agent') return { agent: toAgent(this.p.getAgent(id)) };
    if (kind === 'session') return { session: toSession(this.p.getSession(id)) };
    return { link: toLink(this.p.getLink(id)) };
  }
  rowOf(kind, id) { return kind === 'agent' ? this.p.getAgent(id) : kind === 'session' ? this.p.getSession(id) : this.p.getLink(id); }
  /** Human-only. Acknowledge one finished agent, ended session or answered link (409 with the reason otherwise). */
  ack(kind, id, at = this.now()) {
    const why = this.ackBlock(kind, id);
    if (why) throw new HttpError(409, `cannot acknowledge: ${why}`);
    if (!this.rowOf(kind, id).acknowledged_at) this.tx(() => this.command('hub.ack', { kind, id }, at));
    return this.ackRow(kind, id);
  }
  unack(kind, id, at = this.now()) {
    this.ackBlock(kind, id);
    if (this.rowOf(kind, id).acknowledged_at) this.tx(() => this.command('hub.unack', { kind, id }, at));
    return this.ackRow(kind, id);
  }
  /** POST /v1/ack { agentIds?, sessionIds?, linkIds? }: acknowledge what can be; the rest is listed in `refused` and never fails the batch. */
  ackBulk(body, at = this.now()) {
    if (!isObj(body)) throw bad('body must be an object');
    const lists = { agent: body.agentIds, session: body.sessionIds, link: body.linkIds };
    let total = 0;
    for (const v of Object.values(lists)) {
      if (v === undefined) continue;
      if (!Array.isArray(v) || v.some((x) => !isStr(x))) throw bad('agentIds, sessionIds and linkIds must be arrays of ids');
      total += v.length;
    }
    if (total > MAX_ACK_BULK) throw bad(`at most ${MAX_ACK_BULK} ids per request`);
    const acked = [], refused = [];
    this.tx(() => {
      for (const [kind, ids] of Object.entries(lists)) {
        for (const id of [...new Set(ids ?? [])]) {
          let why;
          try { why = this.ackBlock(kind, id); } catch (e) { if (e instanceof HttpError) why = e.message; else throw e; }
          if (why) { refused.push({ id, reason: why }); continue; }
          if (!this.rowOf(kind, id).acknowledged_at) this.command('hub.ack', { kind, id }, at);
          acked.push(id);
        }
      }
    });
    return { acked, refused };
  }

  close() {
    this.closed = true;
    this.subs.clear();
    this.db.close();
  }
}

function cleanName(v) {
  if (!isStr(v) || !v.trim()) throw bad('name must be a non-empty string');
  return v.trim().slice(0, 200);
}
function cleanTitle(v) {
  if (!isStr(v) || !v.trim()) throw bad('title must be a non-empty string');
  return v.trim().slice(0, 300);
}
function cleanText(v, name, max, allowEmpty) {
  if (!isStr(v)) throw bad(`${name} must be a string`);
  if (!allowEmpty && !v.trim()) throw bad(`${name} must not be empty`);
  return v.length > max ? v.slice(0, max) : v;
}

/** A file name that is safe as a single path component: no separators, no leading dots, no control chars, capped. */
export function safeFilename(raw) {
  let n = isStr(raw) ? raw : '';
  n = n.split(/[\\/]+/).filter(Boolean).pop() || ''; // drop any directory part (both separator styles)
  n = n.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_').trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!n) return 'file';
  if (Buffer.byteLength(n) > 120) {
    const ext = path.extname(n);
    const keepExt = ext.length > 0 && ext.length <= 16 ? ext : '';
    let stem = n.slice(0, n.length - keepExt.length);
    while (Buffer.byteLength(stem + keepExt) > 120) stem = stem.slice(0, -1);
    n = (stem || 'file') + keepExt;
  }
  return n;
}
function cleanMime(v) {
  const m = isStr(v) ? v.split(';')[0].trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/.test(m) ? m : 'application/octet-stream';
}
