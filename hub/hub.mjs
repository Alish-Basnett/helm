// Hub core: ingest, commands, queries, sweep, rebuild. Transport-agnostic (http.mjs wraps it).
import fs from 'node:fs';
import path from 'node:path';
import { Db } from './db.mjs';
import {
  Projector, HUB_SESSION, TASK_STATUSES, JOB_TIMEOUT_ERROR, JOB_UNCLAIMED_ERROR, cut, computeConflicts,
  localDate, usageSummary, usageBreakdown, usageToday, toAttachment, MAX_NOTE_ATTACHMENTS,
  toProject, toSession, toAgent, toTask, toNote, toActivity, toQuestion, toJob, toDigest,
} from './projections.mjs';
import { computeDiff, diffStat } from './diff.mjs';
import { search as ftsSearch, learn as ftsLearn } from './search.mjs';
import { WfEngine } from './wfengine.mjs';
import { toTemplate, getTemplate, renderTemplate, agentOfSubagent, TEMPLATE_AGENTS, MAX_CHECKS, MAX_TAGS } from './templates.mjs';

import { HttpError } from './errors.mjs';
export { HttpError };
const bad = (m) => new HttpError(400, m);
const notFound = (m) => new HttpError(404, m);

const isStr = (v) => typeof v === 'string';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const TABLES = [
  'projects', 'sessions', 'agents', 'tasks', 'notes', 'activity', 'late_completions',
  'agent_files', 'conflicts', 'questions', 'jobs', 'digests', 'attachments', 'usage', 'task_diffs',
  'workflows', 'workflow_versions', 'runs', 'run_nodes', 'steps', 'templates',
];
const START_FROM = ['backlog', 'next', 'later', 'blocked'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export { localDate };

export class Hub {
  constructor(cfg, log, { clock = Date.now } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.clock = clock;
    this.db = new Db(cfg.dbFile);
    this.p = new Projector(this.db, { log, attachDir: cfg.attachDir, clock: () => this.clock() });
    this.subs = new Set();
    this.startedAt = clock();
    this.lastPushed = this.seqNow();
    this.trimmedTo = 0;
    this.autoSnapshot = true;       // snapshot a task's diff when its agent completes (the seed switches this off)
    this.snapshots = new Set();     // in-flight snapshot promises (see flushSnapshots)
    this.closed = false;
    this.inAuto = false;            // re-entrancy guard for autoTick (also held during rebuild)
    this.lastAuto = [];             // task ids the most recent autoTick started
    this.replaying = false;         // true during rebuild(): replay applies recorded workflow events and never decides
    this.wf = new WfEngine(this);   // v0.9 workflows: decisions + commands (the reducer lives in workflows.mjs)
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
    if (outer) { this.autoTick(); this.wf.tick(); } // v0.9: results/steps/sessions may have unblocked a workflow run
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

  ingest(events) {
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
    return { filesChanged: JSON.parse(t.files_changed || '[]'), git: toTask(t).git, createdAt: t.created_at, doneAt: t.done_at };
  }
  /** Compute the task's diff now and record it as a hub.task.diff event. Skips when there is nothing to freeze. */
  async snapshotTask(taskId) {
    const t = this.p.getTask(taskId);
    if (!t || this.closed) return null;
    const diff = await computeDiff(this.taskDiffInput(t), { now: this.now() });
    if (diff.source === 'none' || this.closed) return null;
    this.tx(() => this.command('hub.task.diff', { taskId, diff }, this.now()));
    return diff;
  }
  /** GET /v1/tasks/:id/diff. Snapshot if there is one (unless refresh), else live / history. */
  async taskDiff(id, { refresh = false } = {}) {
    const t = this.p.getTask(id);
    if (!t) throw notFound('task not found');
    if (!refresh) {
      const s = this.db.get('SELECT diff FROM task_diffs WHERE task_id = ?', id);
      if (s) { try { return { ...JSON.parse(s.diff), source: 'snapshot' }; } catch { /* recompute */ } }
    }
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
    const orderBy = { activity: 'id', late_completions: 'session_id, agent_id', agent_files: 'agent_id, path', conflicts: 'path' };
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
        const plan = this.autoPlan(id, now);
        if (!plan) continue;
        this.tx(() => this.command('hub.task.autostart', plan, now));
        started.push(plan.taskId);
      }
    } catch (e) {
      this.log?.error('auto-start failed', e);
    } finally {
      this.inAuto = false;
    }
    this.lastAuto = started;
    return started;
  }
  /** The next auto-start for a project, or null. See CONTRACT v0.7 for the rule. */
  autoPlan(projectId, now) {
    const { autoStartingMs, autoBackoffMs, sendingMs } = this.cfg;
    if (this.db.get(`SELECT 1 AS x FROM tasks WHERE project_id = ? AND status = 'in_progress' LIMIT 1`, projectId)) return null;
    const next = this.db.all(
      `SELECT * FROM tasks WHERE project_id = ? AND status = 'next' ORDER BY ord, created_at, rowid`, projectId);
    if (!next.length) return null;
    for (const t of next) {
      const n = t.start_note_id ? this.p.getNote(t.start_note_id) : null;
      if (!n || n.state === 'failed') continue;
      if (n.state === 'queued' || n.state === 'sending') return null;   // a start is in flight
      if (now - n.created_at < autoStartingMs) return null;              // delivered, agent not up yet
      // Delivered but not answered yet: the session only reads prompts when its current turn ends, which can
      // take longer than autoStartingMs. Until it replies (or 30 min pass), the start is still in flight.
      if (n.state === 'ran' && !n.replied_at && now - (n.ran_at ?? n.created_at) < 30 * 60_000) return null;
    }
    const top = next[0];
    const n = top.start_note_id ? this.p.getNote(top.start_note_id) : null;
    if (n && n.state === 'failed') {
      const failedAt = n.ran_at ?? (n.sending_at ? n.sending_at + sendingMs : n.queued_at ?? n.created_at);
      if (now - failedAt < autoBackoffMs) return null;
    }
    let plan;
    try { plan = this.startPlan(top); } catch (e) {
      if (e instanceof HttpError) return null;  // no live session: retry when one appears
      throw e;
    }
    return { taskId: top.id, sessionId: plan.sessionId, text: plan.text, noteIds: plan.noteIds, reason: 'nothing in progress' };
  }

  // ---------------------------------------------------------------- sweep
  sweep(now = this.now()) {
    const r = this.sweepCore(now);
    this.autoTick(now); // backoff / starting windows expire with time, not with an event
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
    if (!stall.length && !block.length && !idle.length && !sending.length && !jobs.length && !conflicts) return null;
    this.tx(() => this.command('hub.sweep', { stall, block, idle, sending, jobs, conflicts }, now));
    return {
      stalled: stall.length, blocked: block.length, idle: idle.length, timedOut: sending.length,
      jobsFailed: jobs.length, conflictsChanged: conflicts,
    };
  }
  /** Would recomputing the conflicts at `now` change what is stored? */
  conflictsStale(now) {
    const list = computeConflicts(this.db, now);
    const stored = this.db.all('SELECT path, agents FROM conflicts ORDER BY path');
    return !(stored.length === list.length
      && stored.every((r, i) => r.path === list[i].path && r.agents === JSON.stringify(list[i].agents)));
  }

  // -------------------------------------------------------------- queries
  state(projectId) {
    const q = (sql, ...p) => this.db.all(sql, ...p);
    let sessions, agents, tasks, notes, questions, jobs, digests;
    const projects = q('SELECT * FROM projects ORDER BY rowid').map(toProject);
    // open / in-flight rows plus a bounded tail of finished ones
    const qSql = (scope) => `SELECT * FROM questions WHERE ${scope} AND (state = 'open' OR rowid IN (
      SELECT rowid FROM questions WHERE ${scope} AND state = 'answered' ORDER BY answered_at DESC, rowid DESC LIMIT 50)) ORDER BY rowid`;
    const jSql = (scope) => `SELECT * FROM jobs WHERE ${scope} AND (state IN ('queued','running') OR rowid IN (
      SELECT rowid FROM jobs WHERE ${scope} AND state IN ('done','failed') ORDER BY done_at DESC, rowid DESC LIMIT 20)) ORDER BY rowid`;
    if (projectId) {
      if (!this.p.getProject(projectId)) throw notFound('project not found');
      sessions = q('SELECT * FROM sessions WHERE project_id = ? ORDER BY rowid', projectId);
      agents = q('SELECT * FROM agents WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?) ORDER BY rowid', projectId);
      tasks = q('SELECT * FROM tasks WHERE project_id = ? ORDER BY ord, rowid', projectId);
      notes = q(
        `SELECT * FROM notes WHERE (target_kind = 'task' AND target_id IN (SELECT id FROM tasks WHERE project_id = ?))
           OR session_id IN (SELECT id FROM sessions WHERE project_id = ?)
           OR (target_kind = 'session' AND target_id IN (SELECT id FROM sessions WHERE project_id = ?)) ORDER BY rowid`,
        projectId, projectId, projectId);
      const qScope = `session_id IN (SELECT id FROM sessions WHERE project_id = ?)`;
      questions = q(qSql(qScope), projectId, projectId);
      jobs = q(jSql('project_id = ?'), projectId, projectId);
      digests = q('SELECT * FROM digests WHERE project_id = ? ORDER BY date DESC, created_at DESC, rowid DESC LIMIT 14', projectId);
    } else {
      sessions = q('SELECT * FROM sessions ORDER BY rowid');
      agents = q('SELECT * FROM agents ORDER BY rowid');
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
    return {
      projects, templates, sessions: sessions.map(toSession), agents: agents.map(toAgent),
      tasks: tasks.map(toTask), notes: notes.map(toNote), questions: questions.map(toQuestion),
      jobs: jobs.map(toJob), digests: digests.map(toDigest), workflows, runs,
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
    return this.tx(() => {
      const task = this.command('hub.task.create', { projectId: body.projectId, title, description, status, dependsOn, sessionId }, at);
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
    if (!START_FROM.includes(t.status)) throw new HttpError(409, `cannot start a task that is ${t.status}`);
    const sessionId = this.pickJobSession(t.session_id, t.project_id);
    // Draft notes on the task ride along with Start (v0.8): folded after the Brief, marked ran by the same event.
    const drafts = this.db.all(
      `SELECT * FROM notes WHERE target_kind = 'task' AND target_id = ? AND state = 'draft' ORDER BY created_at, rowid`, t.id);
    const folded = drafts.map((n) => {
      const files = JSON.parse(n.attachments || '[]');
      const att = files.length ? `\n  Attached files (open them with the Read tool):\n${files.map((f) => `  - ${f.path}`).join('\n')}` : '';
      return `- ${n.text}${att}`;
    });
    const notesBlock = folded.length ? `Notes from the user:\n${folded.join('\n')}\n\n` : '';
    const text = `Start Helm task ${t.id} \u201c${t.title}\u201d.\n\nBrief:\n${t.description}\n\n${notesBlock}`
      + `Create nothing new: delegate this existing task now with the Agent tool (description starting with [helm:${t.id}]), `
      + 'choosing helm:builder for code changes or helm:scout for read-only work, run it in the background, '
      + 'then reply in one line with what you started.';
    return { sessionId, text, noteIds: drafts.map((n) => n.id) };
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
    return this.tx(() => ({ task: this.command('hub.task.update', { id, patch }, at) }));
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
