// Projections: deterministic reducers from events -> projection tables (+ changes + FTS docs).
//
// Rules that keep replay (--rebuild) byte-identical:
//   * never read the wall clock or Math.random(); time always comes from event.at
//   * every state change (mod events, user commands, sweeps) is an event applied through apply()
//   * decisions that depend on "now" (sweeps, command validation) are made BEFORE the event is
//     recorded and are carried in the event data
import path from 'node:path';
import { applyWf, bookRunUsage } from './workflows.mjs';
import { applyTemplate } from './templates.mjs';
import { applyDoc } from './docs.mjs';
import { applyConcept, conceptsOnRecap, storeSummary } from './concepts.mjs';
import { recapFromJson } from './recap.mjs';

export const STALL_REASON = 'no activity for 10 min';
export const SENDING_TIMEOUT_ERROR = 'delivery unconfirmed — retry';
export const JOB_TIMEOUT_ERROR = 'timed out';
export const JOB_UNCLAIMED_ERROR = 'not picked up by a live session';
export const TASK_STATUSES = ['backlog', 'next', 'in_progress', 'review', 'done', 'later', 'blocked', 'archived'];
export const HUB_SESSION = '_hub';
export const MAX_CHOICES = 30;
const REPORT_MAX = 16000; // T-76: longest final report kept per agent
export const CONFLICT_WINDOW_MS = 10 * 60_000; // a finished agent's file touch still counts for this long
const LIVE = ['running', 'stalled', 'waiting'];
const TOOL_EDIT_CAP = 50; // files per tool.called
const UNASSIGNED = 'Unassigned';
const TAG_RE = /\[helm:(T-\d+)\]/i;

const GIT_REV_RE = /^[0-9a-f]{7,64}$/i;
const statOf = (diff) => {
  const t = (diff && diff.totals) || {};
  const n = (v) => (isNum(v) && v >= 0 ? v : 0);
  return { files: n(t.files), additions: n(t.additions), deletions: n(t.deletions) };
};
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
export const cut = (s, n) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));
/** Collapse line breaks and defuse the "Helm note" marker, so text from another session cannot pose as a note header. */
export const plainLine = (s) => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/Helm(\s+)note/gi, 'Helm-note');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const baseName = (p) => {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
};

// ---------------------------------------------------------------- row mappers
export const toProject = (r) => ({ id: r.id, name: r.name, createdAt: r.created_at, archived: !!r.archived, autoStart: !!r.auto_start, autoConcurrency: r.auto_concurrency || 1, coordinator: !!r.coordinator });
export const toSession = (r) => ({
  id: r.id, projectId: r.project_id, cwd: r.cwd, title: r.title, model: r.model,
  startedAt: r.started_at, lastSeenAt: r.last_seen_at, status: r.status, busy: !!r.busy,
  nowDoing: r.now_doing, tokens: r.tokens, costUsd: r.cost_usd ?? 0,
  // v0.14 session health
  contextWindow: r.context_window ?? null, contextPercent: r.context_percent ?? null, rateLimits: parse(r.rate_limits, []),
  busySince: r.busy_since ?? null, lastTurnAt: r.last_turn_at ?? null,
  runningAgents: r.running_n ?? 0, stalledAgents: r.stalled_n ?? 0, costToday: costToday(r),
  health: { level: r.health_level || 'ok', reasons: parse(r.health_reasons, []) },
  // v0.26: derived from the session's project; acknowledged-to-archive time
  coordinator: !!r.coordinator, acknowledgedAt: r.acknowledged_at ?? null,
});
/** SELECT for a session row plus its live agent counts (what toSession needs). Append a WHERE / ORDER BY. */
export const SESSION_SQL = `SELECT s.*, (SELECT p.coordinator FROM projects p WHERE p.id = s.project_id) AS coordinator,
  (SELECT COUNT(*) FROM agents a WHERE a.session_id = s.id AND a.status = 'running') AS running_n,
  (SELECT COUNT(*) FROM agents a WHERE a.session_id = s.id AND a.status = 'stalled') AS stalled_n FROM sessions s`;

// ---------------------------------------------------------------- session health (v0.14)
export const HEALTH = {
  contextWarn: 70, contextCritical: 85, rateWarn: 80, rateCritical: 95, idleMs: 30 * 60_000,
  sampleEveryMs: 60_000, keepSamplesMs: 7 * 24 * 3600_000, defaultCostWarnUsd: 25,
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const rateLabel = (kind) => (kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? '7-day' : String(kind).replace(/_/g, '-'));
/** "15:00", or "Tue 15:00" when the reset is not on the same local day as `at`. */
function clockText(iso, at) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return localDate(t) === localDate(at) ? hm : `${DAYS[d.getDay()]} ${hm}`;
}
/** Cost since local midnight: the session cost minus what it had already cost when today's first heartbeat arrived. */
export function costToday(r, at) {
  if (at !== undefined && r.cost_day !== localDate(at)) return 0;
  return Math.max(0, money((r.cost_usd ?? 0) - (r.cost_base ?? 0)));
}
/**
 * Derive { level, reasons } from a session row (with running_n / stalled_n) as of event time `at`.
 * Pure: reads no clock, so heartbeats, sweeps and a rebuild all reach the same answer.
 */
export function computeHealth(r, at, costWarnUsd = HEALTH.defaultCostWarnUsd) {
  if (r.status === 'ended') return { level: 'ok', reasons: [] };
  const reasons = [];
  let rank = 0;
  const bump = (n) => { if (n > rank) rank = n; };
  const pct = r.context_percent;
  if (isNum(pct) && pct > HEALTH.contextWarn) {
    reasons.push(`Context ${Math.round(pct)}%`);
    bump(pct > HEALTH.contextCritical ? 2 : 1);
  }
  for (const l of parse(r.rate_limits, [])) {
    if (!l || !isNum(l.percentUsed) || l.percentUsed <= HEALTH.rateWarn) continue;
    const when = l.resetsAt ? clockText(l.resetsAt, at) : '';
    reasons.push(`${rateLabel(l.kind)} limit ${Math.round(l.percentUsed)}%${when ? `, resets ${when}` : ''}`);
    bump(l.percentUsed > HEALTH.rateCritical ? 2 : 1);
  }
  const stalled = r.stalled_n || 0, running = (r.running_n || 0) + stalled; // a stalled agent is still alive
  if (stalled > 0) { reasons.push(`${stalled} stalled agent${stalled === 1 ? '' : 's'}`); bump(1); }
  const idleRef = r.last_turn_at ?? r.started_at;
  if (!r.busy && running > 0 && isNum(idleRef) && at - idleRef > HEALTH.idleMs) {
    reasons.push(`Idle over 30 min with ${running} agent${running === 1 ? '' : 's'} running`);
    bump(1);
  }
  const cost = costToday(r, at);
  if (cost > costWarnUsd) { reasons.push(`Cost today $${cost.toFixed(2)} (over $${costWarnUsd})`); bump(1); }
  return { level: ['ok', 'warn', 'critical'][rank], reasons };
}
const cleanLimits = (v) => v.filter((l) => l && typeof l === 'object' && typeof l.kind === 'string' && isNum(l.percentUsed))
  .slice(0, 8).map((l) => ({
    kind: cut(l.kind, 40), percentUsed: Math.max(0, Math.min(1000, l.percentUsed)),
    resetsAt: typeof l.resetsAt === 'string' && Number.isFinite(Date.parse(l.resetsAt)) ? cut(l.resetsAt, 40) : null,
  }));
export const toAgent = (r) => ({
  id: r.id, sessionId: r.session_id, taskId: r.task_id ?? null, toolUseId: r.tool_use_id,
  subagentType: r.subagent_type, model: r.model, description: r.description, status: r.status,
  startedAt: r.started_at, endedAt: r.ended_at ?? null, lastActivityAt: r.last_activity_at,
  nowDoing: r.now_doing, toolCount: r.tool_count, tokens: r.tokens, parentId: r.parent_id ?? null,
  acknowledgedAt: r.acknowledged_at ?? null,
});
export const toTask = (r) => ({
  id: r.id, projectId: r.project_id, sessionId: r.session_id ?? null, title: r.title,
  description: r.description, status: r.status, agentId: r.agent_id ?? null, order: r.ord,
  blockedReason: r.blocked_reason ?? null, dependsOn: parse(r.depends_on, []),
  filesChanged: parse(r.files_changed, []), tokens: r.tokens, recap: parse(r.recap, null),
  createdAt: r.created_at, updatedAt: r.updated_at, doneAt: r.done_at ?? null,
  conflicts: parse(r.conflicts, []), explainer: r.explainer ?? null, explainJob: parse(r.explain_job, null),
  startNoteId: r.start_note_id ?? null, git: parse(r.git, null), diffStat: parse(r.diff_stat, null),
  choices: parse(r.choices, []), parentTaskId: r.parent_task_id ?? null, autoStartedAt: r.auto_started_at ?? null,
  runId: r.run_id ?? null, nodeId: r.node_id ?? null, branch: parse(r.branch, null),
  filesNote: r.files_note ?? null,
  // v0.26: set on cards a coordinator session created in another project
  createdBySessionId: r.created_by_session_id ?? null, fromProjectId: r.from_project_id ?? null,
  // T-70: the latest agent ended without success and the card is not finished: the UI offers Resume instead of Start.
  interrupted: !!r.interrupted && r.status !== 'done' && r.status !== 'archived',
  lastAgentId: r.agent_id ?? null,
});
export const toNote = (r) => ({
  id: r.id, target: { kind: r.target_kind, id: r.target_id }, sessionId: r.session_id, text: r.text,
  state: r.state, createdAt: r.created_at, queuedAt: r.queued_at ?? null, ranAt: r.ran_at ?? null,
  via: r.via ?? null, error: r.error ?? null, reply: r.reply ?? null, repliedAt: r.replied_at ?? null,
  attachments: parse(r.attachments, []), linkId: r.link_id ?? null,
});
export const toLink = (r) => ({
  id: r.id, kind: r.kind, fromSessionId: r.from_session_id, fromProjectId: r.from_project_id, toProjectId: r.to_project_id,
  toSessionId: r.to_session_id ?? null, refId: r.ref_id ?? null, text: r.text, state: r.state, reply: r.reply ?? null,
  createdAt: r.created_at, deliveredAt: r.delivered_at ?? null, answeredAt: r.answered_at ?? null, acknowledgedAt: r.acknowledged_at ?? null,
});
export const toActivity = (r) => ({
  id: r.id, sessionId: r.session_id, agentId: r.agent_id ?? null, taskId: r.task_id ?? null,
  kind: r.kind, tool: r.tool ?? null, summary: r.summary, ok: r.ok == null ? null : !!r.ok, at: r.at,
});

export const toQuestion = (r) => ({
  id: r.id, sessionId: r.session_id, agentId: r.agent_id ?? null, taskId: r.task_id ?? null, kind: r.kind,
  text: r.text, toolUseId: r.tool_use_id ?? null, state: r.state, createdAt: r.created_at, answeredAt: r.answered_at ?? null,
  ...(r.kind === 'approval' ? { runId: r.run_id ?? null, nodeId: r.node_id ?? null } : {}), // v0.9: only approvals carry a run link
});
export const toJob = (r) => ({
  id: r.id, kind: r.kind, sessionId: r.session_id, taskId: r.task_id ?? null, projectId: r.project_id ?? null,
  state: r.state, input: parse(r.input, {}), result: r.result ?? null, error: r.error ?? null,
  createdAt: r.created_at, claimedAt: r.claimed_at ?? null, doneAt: r.done_at ?? null,
});
export const toDigest = (r) => ({
  id: r.id, date: r.date, projectId: r.project_id ?? null, text: r.text, createdAt: r.created_at,
});

export const USAGE_KINDS = ['recap', 'answer', 'explain', 'digest', 'note_turn', 'wf_step', 'wf_review', 'wf_draft', 'concept_summary', 'doc_draft', 'doc_edit'];
/** Kinds that count as work the user asked for (the rest is Helm's own overhead). */
export const REQUESTED_KINDS = ['note_turn', 'wf_step', 'doc_draft', 'doc_edit'];
export const NOTE_VIAS = ['prompt', 'send_message', 'followup_spawn', 'answer', 'start', 'compact'];
export const MAX_NOTE_ATTACHMENTS = 10;
const pad2 = (n) => String(n).padStart(2, '0');
/** Local calendar date (YYYY-MM-DD) of an epoch-ms time. */
export const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const money = (n) => Math.round(n * 1e6) / 1e6; // keep float noise out of the sums

/**
 * Cost meter. Local-date buckets for the last `days` days ending on `now`'s date (oldest first, empty days included).
 * `overheadUsd` = every kind except note_turn (Helm's own work); `requestedUsd` = note_turn (work the user asked for).
 */
export function usageSummary(db, now, days = 7) {
  const d0 = new Date(now);
  const start = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - (days - 1)).getTime();
  const end = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1).getTime();
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    buckets.set(localDate(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - i).getTime()), { overheadUsd: 0, requestedUsd: 0 });
  }
  const today = localDate(now);
  const byKind = {};
  let tOver = 0, tReq = 0;
  for (const r of db.all('SELECT at, kind, cost_usd FROM usage WHERE at >= ? AND at < ? ORDER BY id', start, end)) {
    const date = localDate(r.at);
    const b = buckets.get(date);
    if (!b) continue;
    const req = REQUESTED_KINDS.includes(r.kind);
    if (req) b.requestedUsd += r.cost_usd; else b.overheadUsd += r.cost_usd;
    if (date === today) {
      if (req) tReq += r.cost_usd; else tOver += r.cost_usd;
      const k = (byKind[r.kind] ||= { calls: 0, costUsd: 0 });
      k.calls++; k.costUsd += r.cost_usd;
    }
  }
  for (const k of Object.values(byKind)) k.costUsd = money(k.costUsd);
  return {
    today: { overheadUsd: money(tOver), requestedUsd: money(tReq), byKind },
    days: [...buckets].map(([date, b]) => ({ date, overheadUsd: money(b.overheadUsd), requestedUsd: money(b.requestedUsd) })),
  };
}
/**
 * Cost analytics over the last `days` local days: spend per day, per project, per model and per task.
 * Project comes from the usage row's session (sessions.project_id); rows with a missing session group under project null.
 * `sessionCostUsd` is the cost the session projection holds for sessions started in the window, per project.
 */
export function usageBreakdown(db, now, days = 7) {
  const d0 = new Date(now);
  const start = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - (days - 1)).getTime();
  const end = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1).getTime();
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i--) byDay.set(localDate(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - i).getTime()), 0);
  const byProject = {}, byModel = {}, byTask = {};
  const add = (m, key, r) => {
    const e = (m[key] ||= { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    e.calls++; e.costUsd += r.cost_usd; e.inputTokens += r.input_tokens; e.outputTokens += r.output_tokens; e.cacheReadTokens += r.cache_read_tokens;
  };
  let total = 0;
  const rows = db.all(
    `SELECT u.at, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cost_usd, u.task_id, s.project_id
       FROM usage u LEFT JOIN sessions s ON s.id = u.session_id WHERE u.at >= ? AND u.at < ? ORDER BY u.id`, start, end);
  for (const r of rows) {
    const date = localDate(r.at);
    if (!byDay.has(date)) continue;
    byDay.set(date, byDay.get(date) + r.cost_usd);
    total += r.cost_usd;
    add(byProject, r.project_id ?? '', r);
    add(byModel, r.model || 'unknown', r);
    if (r.task_id) add(byTask, r.task_id, r);
  }
  const names = Object.fromEntries(db.all('SELECT id, name FROM projects').map((p) => [p.id, p.name]));
  const titles = Object.fromEntries(db.all('SELECT id, title FROM tasks').map((t) => [t.id, t.title]));
  const sessionCost = Object.fromEntries(db.all(
    'SELECT project_id, SUM(cost_usd) AS c FROM sessions WHERE started_at >= ? AND started_at < ? GROUP BY project_id', start, end,
  ).map((r) => [r.project_id, money(r.c ?? 0)]));
  const list = (m, shape) => Object.entries(m)
    .map(([k, e]) => ({ ...shape(k), calls: e.calls, costUsd: money(e.costUsd), inputTokens: e.inputTokens, outputTokens: e.outputTokens, cacheReadTokens: e.cacheReadTokens }))
    .sort((a, b) => b.costUsd - a.costUsd);
  return {
    totalUsd: money(total),
    perDay: [...byDay].map(([date, c]) => ({ date, costUsd: money(c) })),
    perProject: list(byProject, (k) => ({ projectId: k || null, name: names[k] ?? null, sessionCostUsd: sessionCost[k] ?? 0 })),
    perModel: list(byModel, (k) => ({ model: k })),
    perTask: list(byTask, (k) => ({ taskId: k, title: titles[k] ?? null })),
  };
}
export function usageToday(db, now) {
  const { overheadUsd, requestedUsd } = usageSummary(db, now, 1).today;
  return { overheadUsd, requestedUsd };
}
export const toAttachment = (r, dir) => ({
  id: r.id, name: r.name, mime: r.mime, size: r.size, path: path.join(dir, r.id, r.name), createdAt: r.created_at,
});

/** Current conflicts at time `at`: paths touched by >= 2 distinct agents that are each live or touched it recently. */
export function computeConflicts(db, at) {
  const rows = db.all(
    `SELECT f.path AS path, f.agent_id AS agentId, f.at AS at, a.task_id AS taskId, a.session_id AS sessionId, a.status AS status
     FROM agent_files f JOIN agents a ON a.id = f.agent_id ORDER BY f.path, f.agent_id`);
  const byPath = new Map();
  for (const r of rows) {
    if (!LIVE.includes(r.status) && r.at < at - CONFLICT_WINDOW_MS) continue;
    let list = byPath.get(r.path);
    if (!list) byPath.set(r.path, (list = []));
    list.push({ agentId: r.agentId, taskId: r.taskId ?? null, sessionId: r.sessionId, at: r.at });
  }
  const out = [];
  for (const [path, agents] of byPath) {
    if (agents.length < 2) continue;
    agents.sort((x, y) => x.at - y.at || (x.agentId < y.agentId ? -1 : x.agentId > y.agentId ? 1 : 0));
    out.push({ path, agents });
  }
  return out; // rows were ordered by path
}

export class Projector {
  constructor(db, { log, attachDir = '', clock = Date.now, costWarnUsd = HEALTH.defaultCostWarnUsd } = {}) {
    this.costWarnUsd = costWarnUsd;
    this.db = db;
    this.log = log;
    this.attachDir = attachDir;
    this.clock = clock;
    this.dirty = false; // set when this transaction appended to `changes`
  }

  // ------------------------------------------------------------ small helpers
  nextId(prefix) {
    const r = this.db.get(
      'INSERT INTO counters(name, n) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1 RETURNING n', prefix);
    return `${prefix}-${r.n}`;
  }
  upd(table, id, f) {
    const keys = Object.keys(f);
    if (!keys.length) return;
    this.db.run(`UPDATE ${table} SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`,
      ...keys.map((k) => f[k]), id);
  }
  emit(entity, op, row) {
    this.db.run('INSERT INTO changes(entity, op, row) VALUES (?, ?, ?)', entity, op, JSON.stringify(row));
    this.dirty = true;
  }
  getProject(id) { return this.db.get('SELECT * FROM projects WHERE id = ?', id); }
  getSession(id) { return this.db.get(`${SESSION_SQL} WHERE s.id = ?`, id); }
  getAgent(id) { return this.db.get('SELECT * FROM agents WHERE id = ?', id); }
  getTask(id) { return id ? this.db.get('SELECT * FROM tasks WHERE id = ?', id) : undefined; }
  getNote(id) { return this.db.get('SELECT * FROM notes WHERE id = ?', id); }
  getQuestion(id) { return this.db.get('SELECT * FROM questions WHERE id = ?', id); }
  getAttachment(id) { return this.db.get('SELECT * FROM attachments WHERE id = ?', id); }
  getJob(id) { return this.db.get('SELECT * FROM jobs WHERE id = ?', id); }
  getLink(id) { return this.db.get('SELECT * FROM links WHERE id = ?', id); }
  /** The most recently active live session of a project, or undefined. */
  pickLive(projectId) {
    return this.db.get(`SELECT id FROM sessions WHERE project_id = ? AND status IN ('active','idle') ORDER BY last_seen_at DESC, rowid DESC LIMIT 1`, projectId)?.id;
  }
  pushProject(id) { const r = this.getProject(id); if (r) this.emit('project', 'upsert', toProject(r)); }
  pushSession(id) { const r = this.getSession(id); if (r) this.emit('session', 'upsert', toSession(r)); }
  pushAgent(id) { const r = this.getAgent(id); if (r) this.emit('agent', 'upsert', toAgent(r)); }
  pushTask(id) { const r = this.getTask(id); if (r) this.emit('task', 'upsert', toTask(r)); }
  pushNote(id) { const r = this.getNote(id); if (r) this.emit('note', 'upsert', toNote(r)); }
  pushQuestion(id) { const r = this.getQuestion(id); if (r) this.emit('question', 'upsert', toQuestion(r)); }
  pushLink(id) { const r = this.getLink(id); if (r) this.emit('link', 'upsert', toLink(r)); }
  pushJob(id) { const r = this.getJob(id); if (r) this.emit('job', 'upsert', toJob(r)); }
  endOrder(projectId, status) {
    return this.db.get('SELECT COALESCE(MAX(ord), 0) + 1 AS o FROM tasks WHERE project_id = ? AND status = ?',
      projectId, status).o;
  }

  // ---------------------------------------------------------------- search docs
  setDoc(kind, ref, title, body, { sessionId = null, taskId = null, at = 0 } = {}) {
    this.db.run(
      `INSERT INTO search_docs(kind, ref, title, body, session_id, task_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, ref) DO UPDATE SET title = excluded.title, body = excluded.body,
         session_id = excluded.session_id, task_id = excluded.task_id, at = excluded.at`,
      kind, ref, cut(title, 400), cut(body, 8000), sessionId, taskId, at);
  }
  delDoc(kind, ref) { this.db.run('DELETE FROM search_docs WHERE kind = ? AND ref = ?', kind, ref); }
  indexTask(t) {
    const body = t.explainer ? `${cut(t.description, 3000)}\n${t.explainer}` : t.description;
    this.setDoc('task', t.id, t.title, body, { sessionId: t.session_id, taskId: t.id, at: t.updated_at });
  }
  indexRecap(t) {
    const r = parse(t.recap, null);
    if (!r) return;
    this.setDoc('recap', t.id, t.title,
      [r.what, r.how, r.learned, (r.concepts || []).join(' ')].filter(Boolean).join('\n'),
      { sessionId: t.session_id, taskId: t.id, at: t.recap_at ?? t.updated_at });
  }
  indexNote(n) {
    let label = '';
    if (n.target_kind === 'task') label = this.getTask(n.target_id)?.title || '';
    else label = this.getSession(n.target_id)?.title || '';
    const body = n.reply ? `${cut(n.text, 3000)}\n${n.reply}` : n.text;
    this.setDoc('note', n.id, `Note for ${label || n.target_id}`, body, {
      sessionId: n.session_id || null, taskId: n.target_kind === 'task' ? n.target_id : null,
      at: n.ran_at ?? n.queued_at ?? n.created_at,
    });
  }

  // ------------------------------------------------------------------- activity
  addActivity({ sessionId, agentId = null, taskId = null, kind, tool = null, summary, ok = null, at }) {
    const sum = cut(summary, 600);
    const r = this.db.run(
      'INSERT INTO activity(session_id, agent_id, task_id, kind, tool, summary, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      sessionId, agentId, taskId, kind, tool ? cut(tool, 80) : null, sum, ok, at);
    const id = Number(r.lastInsertRowid);
    if (kind !== 'recap') {
      this.setDoc('activity', String(id), tool ? cut(tool, 80) : kind, sum, { sessionId, taskId, at });
    }
    this.emit('activity', 'upsert', toActivity(this.db.get('SELECT * FROM activity WHERE id = ?', id)));
    return id;
  }

  // ------------------------------------------------------------------- projects
  createProject(name, at, auto) {
    const id = this.nextId('P');
    this.db.run('INSERT INTO projects(id, name, created_at, archived, auto) VALUES (?, ?, ?, 0, ?)',
      id, cut(name, 200), at, auto ? 1 : 0);
    this.setDoc('project', id, cut(name, 200), '', { at });
    this.pushProject(id);
    return this.getProject(id);
  }
  autoProjectFor(cwd, at) {
    const base = baseName(cwd);
    if (!base) {
      const ex = this.db.get('SELECT * FROM projects WHERE name = ? AND archived = 0 ORDER BY rowid LIMIT 1', UNASSIGNED);
      if (ex) return ex;
      return this.createProject(UNASSIGNED, at, true);
    }
    return this.createProject(base, at, true);
  }
  ensureSession(sid, at) {
    let s = this.getSession(sid);
    if (s) return s;
    // Event for a session we never saw start (hub restarted fresh / outbox trimmed): make a stub.
    const p = this.autoProjectFor('', at);
    this.db.run(
      `INSERT INTO sessions(id, project_id, cwd, title, model, started_at, last_seen_at, status, busy, now_doing, tokens)
       VALUES (?, ?, '', ?, '', ?, ?, 'active', 0, '', 0)`, sid, p.id, `Session ${sid.slice(0, 8)}`, at, at);
    s = this.getSession(sid);
    this.setDoc('session', sid, s.title, '', { sessionId: sid, at });
    this.pushSession(sid);
    return s;
  }
  /** Mark session alive. Quiet (no change row) unless the status flips idle -> active. */
  touchSession(sid, at) {
    const s = this.getSession(sid);
    if (!s) return;
    const wasIdle = s.status === 'idle';
    this.db.run(
      `UPDATE sessions SET last_seen_at = MAX(last_seen_at, ?), status = CASE WHEN status = 'idle' THEN 'active' ELSE status END WHERE id = ?`,
      at, sid);
    if (wasIdle) this.pushSession(sid);
  }

  // ---------------------------------------------------------------------- tasks
  createTask({ projectId, sessionId = null, title, description = '', status = 'backlog', dependsOn = [], at }) {
    const id = this.nextId('T');
    this.db.run(
      `INSERT INTO tasks(id, project_id, session_id, title, description, status, agent_id, ord, blocked_reason,
         depends_on, files_changed, tokens, recap, recap_at, created_at, updated_at, done_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, '[]', 0, NULL, NULL, ?, ?, ?)`,
      id, projectId, sessionId, cut(title, 300), cut(description, 20000), status,
      this.endOrder(projectId, status), JSON.stringify(dependsOn), at, at, status === 'done' ? at : null);
    this.indexTask(this.getTask(id));
    this.pushTask(id);
    return this.getTask(id);
  }
  /** Move a task to `status`, maintaining order / blockedReason / doneAt. */
  setTaskStatus(t, status, at, reason, order, by) {
    const changed = t.status !== status;
    const ord = order !== undefined && order !== null ? order : changed ? this.endOrder(t.project_id, status) : t.ord;
    let br = null;
    if (status === 'blocked') br = reason !== undefined ? reason : t.status === 'blocked' ? t.blocked_reason : null;
    // T-53: who set a block. Only a user PATCH passes by='user'; every other block (agent failure, stall, workflow, dependency)
    // is hub-made (null). Re-saving an existing block without naming a source keeps whoever set it.
    const bb = status !== 'blocked' ? null : by !== undefined ? by : t.status === 'blocked' ? t.blocked_by ?? null : null;
    this.upd('tasks', t.id, {
      status, ord, blocked_reason: br, blocked_by: bb, updated_at: at,
      done_at: status === 'done' ? (t.done_at ?? at) : null,
    });
  }

  // -------------------------------------------------------------------- agents
  /** Resolve an agentId from an event to a hub agent. Lazily binds a sole pending agent. */
  resolveAgent(sid, agentId, at) {
    if (!agentId) return null;
    const a = this.getAgent(agentId);
    if (a) return a;
    const pend = this.db.all(
      `SELECT * FROM agents WHERE session_id = ? AND id LIKE 'pending:%' AND status IN ('running','stalled')`, sid);
    if (pend.length === 1) {
      this.bindAgent(pend[0], agentId, at);
      return this.getAgent(agentId);
    }
    return null;
  }
  /** Several pending agents and an unattributable event: keep every pending agent alive. */
  bumpPending(sid, at) {
    const pend = this.db.all(
      `SELECT * FROM agents WHERE session_id = ? AND id LIKE 'pending:%' AND status IN ('running','stalled')`, sid);
    for (const a of pend) this.recoverAgent(a, at, { quietIfRunning: true });
  }
  /** lastActivity bump; stalled -> running; stall-blocked task -> in_progress. */
  recoverAgent(a, at, { quietIfRunning = false, nowDoing = undefined, countTool = false } = {}) {
    const f = { last_activity_at: Math.max(a.last_activity_at, at) };
    if (nowDoing !== undefined) f.now_doing = cut(nowDoing, 300);
    if (countTool) f.tool_count = a.tool_count + 1;
    const wasStalled = a.status === 'stalled';
    if (wasStalled) f.status = 'running';
    this.upd('agents', a.id, f);
    if (wasStalled) this.unstallTask(a, at);
    if (!quietIfRunning || wasStalled) this.pushAgent(a.id);
    if (wasStalled && this.refreshHealth(a.session_id, at)) this.pushSession(a.session_id); // the stall warning clears
  }
  /** A stall-blocked task returns to in_progress when its agent shows life (or starts waiting for input). */
  unstallTask(a, at) {
    if (!a.task_id) return;
    const t = this.getTask(a.task_id);
    if (t && t.status === 'blocked' && t.blocked_reason === STALL_REASON) {
      this.setTaskStatus(t, 'in_progress', at, null);
      this.pushTask(t.id);
    }
  }
  /** Agent is blocked on the user (reconcile said so): never stalls, and gets an open `waiting` question. */
  enterWaiting(a, at) {
    if (a.status === 'waiting') return;
    this.upd('agents', a.id, { status: 'waiting', last_activity_at: Math.max(a.last_activity_at, at) });
    if (a.status === 'stalled') this.unstallTask(a, at);
    this.pushAgent(a.id);
    if (!this.db.get(`SELECT 1 AS x FROM questions WHERE agent_id = ? AND kind = 'waiting' AND state = 'open'`, a.id)) {
      const t = this.getTask(a.task_id);
      this.createQuestion({
        sessionId: a.session_id, agentId: a.id, taskId: a.task_id, kind: 'waiting', text: 'Waiting for input',
        toolUseId: null, at, hint: t ? t.title : a.description,
      });
    }
  }
  /** waiting -> running. last_activity is refreshed so the agent does not stall the instant it resumes. */
  leaveWaiting(a, at, extra = {}) {
    this.upd('agents', a.id, { status: 'running', last_activity_at: Math.max(a.last_activity_at, at), ...extra });
    this.answerQuestions({ agentId: a.id, kind: 'waiting' }, at);
    this.pushAgent(a.id);
  }
  completeAgent(a, ok, summary, tokens, at) {
    if (a.status === 'done' || a.status === 'failed') return;
    const f = {
      status: ok ? 'done' : 'failed', ended_at: at,
      last_activity_at: Math.max(a.last_activity_at, at), now_doing: '',
    };
    if (isNum(tokens)) f.tokens = tokens;
    this.upd('agents', a.id, f);
    this.pushAgent(a.id);
    this.answerQuestions({ agentId: a.id }, at); // a finished agent cannot be waiting for anyone
    this.recomputeConflicts(at);
    const t = this.getTask(a.task_id);
    let keptBlocked = false;
    if (t) {
      const mine = !t.agent_id || t.agent_id === a.id;
      if (mine && t.status !== 'done' && t.status !== 'archived') {
        // T-53: a card the user parked (later) or blocked keeps its status and reason; the rest of this method still records
        // the end, tokens, interrupted flag and activity, and the caller keeps the report, files and recap.
        const parked = t.status === 'later' || (t.status === 'blocked' && t.blocked_by === 'user');
        if (parked) keptBlocked = t.status === 'blocked';
        else if (ok) this.setTaskStatus(t, 'review', at, null);
        else this.setTaskStatus(t, 'blocked', at, cut(summary, 500) || 'agent failed');
      }
      if (mine) this.upd('tasks', t.id, { interrupted: ok ? 0 : 1 });
      if (isNum(tokens) && tokens > 0) this.upd('tasks', t.id, { tokens: t.tokens + tokens });
      this.upd('tasks', t.id, { updated_at: at });
      this.pushTask(t.id);
    }
    this.addActivity({
      sessionId: a.session_id, agentId: a.id, taskId: a.task_id, kind: 'status',
      summary: ok && keptBlocked ? 'Agent finished; card kept blocked by user'
        : `${ok ? 'Agent finished' : 'Agent failed'}: ${cut(summary, 300) || a.description}`, ok, at,
    });
  }
  /** Rename a pending agent id to its real id everywhere. */
  bindAgent(pending, agentId, at) {
    const old = pending.id;
    if (old === agentId) return;
    const existing = this.getAgent(agentId);
    const sid = pending.session_id;
    const actRows = this.db.all('SELECT id FROM activity WHERE agent_id = ?', old).map((r) => r.id);
    if (existing) {
      // The real agent was created first (reconcile); fold the pending one into it.
      this.upd('agents', agentId, {
        task_id: existing.task_id ?? pending.task_id, tool_use_id: pending.tool_use_id,
        subagent_type: pending.subagent_type, model: pending.model || existing.model,
        description: pending.description, started_at: Math.min(existing.started_at, pending.started_at),
        parent_id: pending.parent_id ?? existing.parent_id ?? null,
      });
      this.db.run('DELETE FROM agents WHERE id = ?', old);
    } else {
      this.db.run('UPDATE agents SET id = ? WHERE id = ?', agentId, old);
    }
    this.db.run('UPDATE activity SET agent_id = ? WHERE agent_id = ?', agentId, old);
    // v0.6: children that pointed at the pending id now point at the bound id.
    const kids = this.db.all('SELECT id FROM agents WHERE parent_id = ?', old).map((r) => r.id);
    if (kids.length) this.db.run('UPDATE agents SET parent_id = ? WHERE parent_id = ?', agentId, old);
    this.db.run('UPDATE tasks SET agent_id = ? WHERE agent_id = ?', agentId, old);
    this.db.run('UPDATE questions SET agent_id = ? WHERE agent_id = ?', agentId, old);
    for (const f of this.db.all('SELECT path, at FROM agent_files WHERE agent_id = ? ORDER BY path', old)) {
      this.db.run(
        `INSERT INTO agent_files(agent_id, path, at) VALUES (?, ?, ?)
         ON CONFLICT(agent_id, path) DO UPDATE SET at = MAX(at, excluded.at)`, agentId, f.path, f.at);
    }
    this.db.run('DELETE FROM agent_files WHERE agent_id = ?', old);
    // Orphan activity (tool calls seen before the bind) -> attach to the task and the agent counters.
    const orphans = this.db.all(
      `SELECT * FROM activity WHERE agent_id = ? AND session_id = ? AND task_id IS NULL ORDER BY id`, agentId, sid);
    const merged = this.getAgent(agentId);
    if (orphans.length) {
      if (merged.task_id) {
        this.db.run('UPDATE activity SET task_id = ? WHERE agent_id = ? AND session_id = ? AND task_id IS NULL',
          merged.task_id, agentId, sid);
      }
      const tools = orphans.filter((o) => o.kind === 'tool');
      const lastTool = tools[tools.length - 1];
      this.upd('agents', agentId, {
        tool_count: merged.tool_count + tools.length,
        last_activity_at: Math.max(merged.last_activity_at, orphans[orphans.length - 1].at),
        now_doing: lastTool ? cut(lastTool.summary, 300) : merged.now_doing,
      });
      for (const o of orphans) if (!actRows.includes(o.id)) actRows.push(o.id);
    }
    if (old !== agentId) this.emit('agent', 'delete', toAgent(pending));
    this.pushAgent(agentId);
    for (const k of kids) this.pushAgent(k);
    for (const t of this.db.all('SELECT id FROM tasks WHERE agent_id = ?', agentId)) this.pushTask(t.id);
    this.recomputeConflicts(at); // conflict entries name agents by id
    for (const id of actRows) {
      const r = this.db.get('SELECT * FROM activity WHERE id = ?', id);
      if (r) this.emit('activity', 'upsert', toActivity(r));
    }
    // A completion that beat the bind.
    const late = this.db.get('SELECT * FROM late_completions WHERE session_id = ? AND agent_id = ?', sid, agentId);
    if (late) {
      this.db.run('DELETE FROM late_completions WHERE session_id = ? AND agent_id = ?', sid, agentId);
      this.completeAgent(this.getAgent(agentId), !!late.ok, late.summary, late.tokens, late.at);
      this.keepReport(agentId, late.report);
    }
  }

  // ===================================================================== apply
  apply(ev) {
    switch (ev.type) {
      case 'session.started': return this.onSessionStarted(ev);
      case 'session.heartbeat': return this.onHeartbeat(ev);
      case 'session.ended': return this.onSessionEnded(ev);
      case 'turn.started': return this.onTurn(ev, true);
      case 'turn.completed': return this.onTurn(ev, false);
      case 'agent.spawned': return this.onAgentSpawned(ev);
      case 'agent.bound': return this.onAgentBound(ev);
      case 'agent.git': return this.onAgentGit(ev);
      case 'task.git': return this.onTaskGit(ev);
      case 'hub.task.files': return this.hTaskFiles(ev);
      case 'tool.called': return this.onToolCalled(ev);
      case 'tool.finished': return this.onToolFinished(ev);
      case 'agent.completed': return this.onAgentCompleted(ev);
      case 'recap.generated': return this.onRecap(ev);
      case 'hub.agent.report': return this.hAgentReport(ev);
      case 'note.result': return this.onNoteResult(ev);
      case 'note.reply': return this.onNoteReply(ev);
      case 'reconcile': return this.onReconcile(ev);
      case 'job.result': return this.onJobResult(ev);
      case 'helm.usage': return this.onUsage(ev);
      case 'hub.project.create': return this.hProjectCreate(ev);
      case 'hub.project.update': return this.hProjectUpdate(ev);
      case 'hub.project.coordinator': return this.hProjectCoordinator(ev);
      case 'hub.link.create': return this.hLinkCreate(ev);
      case 'hub.link.deliver': return this.hLinkDeliver(ev);
      case 'hub.ack': case 'hub.unack': return this.hAck(ev);
      case 'hub.session.join': return this.hSessionJoin(ev);
      case 'hub.task.create': return this.hTaskCreate(ev);
      case 'hub.task.update': return this.hTaskUpdate(ev);
      case 'hub.attachment.create': return this.hAttachmentCreate(ev);
      case 'hub.note.create': return this.hNoteCreate(ev);
      case 'hub.note.update': return this.hNoteUpdate(ev);
      case 'hub.note.delete': return this.hNoteDelete(ev);
      case 'hub.note.execute': return this.hNoteExecute(ev);
      case 'hub.note.retry': return this.hNoteRetry(ev);
      case 'hub.note.claim': return this.hNoteClaim(ev);
      case 'hub.task.start': return this.hTaskStart(ev);
      case 'hub.task.autostart': return this.hTaskStart({ ...ev, data: { ...ev.data, id: ev.data.taskId } }, ev.data.reason || 'auto');
      case 'hub.question.dismiss': return this.hQuestionDismiss(ev);
      case 'hub.job.create': return this.hJobCreate(ev);
      case 'hub.job.claim': return this.hJobClaim(ev);
      case 'hub.job.finish': return this.hJobFinish(ev);
      case 'hub.sweep': return this.hSweep(ev);
      case 'hub.task.diff': return this.hTaskDiff(ev);
      case 'hub.task.diffstat': return this.hTaskDiffStat(ev);
      case 'hub.task.branch': return this.hTaskBranch(ev);
      case 'hub.task.ci': return this.hTaskCi(ev);
      case 'task.choices': return this.onTaskChoices(ev);
      case 'hub.task.choices': return this.hTaskChoices(ev);
      case 'hub.template.create': case 'hub.template.update': case 'hub.template.used': return applyTemplate(this, ev);
      case 'hub.doc.create': case 'hub.doc.rename': case 'hub.doc.archive': case 'hub.doc.edit': case 'hub.doc.save': case 'hub.doc.export':
      case 'hub.doc.drafted': case 'hub.doc.comment.add': case 'hub.doc.comment.update': case 'hub.doc.comment.delete':
      case 'hub.doc.apply': case 'hub.doc.applied': case 'hub.doc.revert': return applyDoc(this, ev);
      case 'hub.concept.update': case 'hub.concept.merge': return applyConcept(this, ev);
      default:
        if (ev.type.startsWith('wf.')) return applyWf(this, ev);
        this.log?.warn(`unknown event type ignored: ${ev.type}`);
        return null;
    }
  }

  // -------------------------------------------------------------- session events
  onSessionStarted(ev) {
    const d = ev.data, sid = ev.sessionId, at = ev.at;
    const cwd = str(d.cwd), model = str(d.model);
    const base = baseName(cwd);
    let s = this.getSession(sid);
    if (!s) {
      const p = this.autoProjectFor(cwd, at);
      const title = str(d.title) || base || `Session ${sid.slice(0, 8)}`;
      this.db.run(
        `INSERT INTO sessions(id, project_id, cwd, title, model, started_at, last_seen_at, status, busy, now_doing, tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, '', 0)`, sid, p.id, cwd, cut(title, 300), model, at, at);
    } else {
      // A stub (made when events arrived before session.started, e.g. after a hub restart)
      // moves into its real project the moment it reports a folder.
      const p = this.getProject(s.project_id);
      if (cwd && !s.cwd && p && p.name === UNASSIGNED) this.moveSession(sid, this.autoProjectFor(cwd, at).id, at);
      s = this.getSession(sid);
      const f = { status: 'active', busy: 0, last_seen_at: Math.max(s.last_seen_at, at) };
      if (cwd) f.cwd = cwd;
      if (str(d.title)) f.title = cut(str(d.title), 300);
      if (model) f.model = model;
      this.upd('sessions', sid, f);
    }
    s = this.getSession(sid);
    this.setDoc('session', sid, s.title, s.cwd, { sessionId: sid, at });
    this.pushSession(sid);
  }
  onHeartbeat(ev) {
    const sid = ev.sessionId, d = ev.data;
    this.ensureSession(sid, ev.at);
    const s = this.getSession(sid);
    const f = { status: 'active', last_seen_at: Math.max(s.last_seen_at, ev.at) };
    if (isNum(d.tokens)) f.tokens = d.tokens;
    if (isNum(d.costUsd)) f.cost_usd = d.costUsd;
    if (isNum(d.contextWindow) && d.contextWindow > 0) f.context_window = Math.round(d.contextWindow);
    if (isNum(d.contextPercent)) f.context_percent = Math.max(0, Math.min(100, d.contextPercent));
    if (Array.isArray(d.rateLimits)) f.rate_limits = JSON.stringify(cleanLimits(d.rateLimits));
    // a new local day starts "cost today" from what the session had already cost
    if (s.cost_day !== localDate(ev.at)) {
      f.cost_day = localDate(ev.at);
      // A session that started today has spent everything today: its baseline is 0, not its cost at this heartbeat.
      f.cost_base = localDate(s.started_at) === localDate(ev.at) ? 0 : (s.cost_usd ?? 0);
    }
    this.upd('sessions', sid, f);
    this.sampleSession(sid, ev.at);
    this.refreshHealth(sid, ev.at);
    this.pushSession(sid);
  }
  /** Append a session_samples row at most once a minute per session; drop anything older than 7 days. */
  sampleSession(sid, at) {
    const last = this.db.get('SELECT MAX(at) AS m FROM session_samples WHERE session_id = ?', sid).m;
    if (last != null && at - last < HEALTH.sampleEveryMs) return false;
    const s = this.getSession(sid);
    this.db.run('INSERT INTO session_samples(session_id, at, tokens, percent, cost_usd) VALUES (?, ?, ?, ?, ?)',
      sid, at, s.tokens, s.context_percent ?? null, s.cost_usd ?? 0);
    this.db.run('DELETE FROM session_samples WHERE session_id = ? AND at < ?', sid, at - HEALTH.keepSamplesMs);
    return true;
  }
  /** Recompute the stored health. Returns true when the level or the reasons changed (the caller pushes). */
  refreshHealth(sid, at) {
    const s = this.getSession(sid);
    if (!s) return false;
    const h = computeHealth(s, at, this.costWarnUsd);
    const reasons = JSON.stringify(h.reasons);
    if (h.level === s.health_level && reasons === s.health_reasons) return false;
    this.upd('sessions', sid, { health_level: h.level, health_reasons: reasons });
    return true;
  }
  onSessionEnded(ev) {
    const sid = ev.sessionId;
    this.ensureSession(sid, ev.at);
    const s = this.getSession(sid);
    this.upd('sessions', sid, { status: 'ended', busy: 0, busy_since: null, last_seen_at: Math.max(s.last_seen_at, ev.at) });
    this.refreshHealth(sid, ev.at);
    for (const a of this.db.all(`SELECT * FROM agents WHERE session_id = ? AND status IN ('running','stalled','waiting')`, sid)) {
      this.completeAgent(a, false, 'session ended', undefined, ev.at);
    }
    this.answerQuestions({ sessionId: sid }, ev.at); // main-session questions nobody can answer any more
    this.addActivity({
      sessionId: sid, kind: 'status', summary: `Session ended${ev.data.reason ? ': ' + str(ev.data.reason) : ''}`,
      at: ev.at,
    });
    this.pushSession(sid);
  }
  onTurn(ev, started) {
    const sid = ev.sessionId, d = ev.data;
    this.ensureSession(sid, ev.at);
    this.touchSession(sid, ev.at);
    const agentId = str(d.agentId);
    if (agentId) {
      const a = this.resolveAgent(sid, agentId, ev.at);
      if (a && (a.status === 'running' || a.status === 'stalled')) this.recoverAgent(a, ev.at);
      else if (a && a.status === 'waiting') this.upd('agents', a.id, { last_activity_at: Math.max(a.last_activity_at, ev.at) });
      else if (!a) this.bumpPending(sid, ev.at);
      return;
    }
    const cur = this.getSession(sid);
    this.upd('sessions', sid, started
      ? { busy: 1, busy_since: cur.busy ? (cur.busy_since ?? ev.at) : ev.at }
      : { busy: 0, busy_since: null, last_turn_at: Math.max(cur.last_turn_at ?? 0, ev.at) });
    this.refreshHealth(sid, ev.at);
    if (!started && d.ok === false) {
      this.addActivity({ sessionId: sid, kind: 'status', summary: `Turn failed${d.error ? ': ' + str(d.error) : ''}`, ok: false, at: ev.at });
    }
    this.pushSession(sid);
  }

  // --------------------------------------------------------------- agent events
  onAgentSpawned(ev) {
    const d = ev.data, sid = ev.sessionId, at = ev.at;
    const toolUseId = str(d.toolUseId);
    if (!toolUseId) throw new Error('agent.spawned: toolUseId required');
    const s = this.ensureSession(sid, at);
    if (this.db.get('SELECT id FROM agents WHERE tool_use_id = ? AND session_id = ?', toolUseId, sid)) return;
    this.touchSession(sid, at);
    const description = str(d.description);
    const subagentType = str(d.subagentType) || 'general-purpose';
    let task = d.taskId ? this.getTask(str(d.taskId)) : undefined;
    if (!task) {
      const m = TAG_RE.exec(description);
      if (m) task = this.getTask(m[1].toUpperCase());
    }
    if (!task) {
      task = this.createTask({
        projectId: s.project_id, sessionId: sid, title: description.trim() || subagentType,
        description: cut(str(d.prompt), 600), status: 'in_progress', at,
      });
    }
    const id = `pending:${toolUseId}`;
    this.db.run(
      `INSERT INTO agents(id, session_id, task_id, tool_use_id, subagent_type, model, description, status,
         started_at, ended_at, last_activity_at, now_doing, tool_count, tokens, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL, ?, 'starting', 0, 0, ?)`,
      id, sid, task.id, toolUseId, subagentType, str(d.model), cut(description, 500), at, at, str(d.parentAgentId) || null);
    this.setTaskStatus(task, 'in_progress', at, null);
    this.upd('tasks', task.id, { agent_id: id, interrupted: 0, updated_at: at, session_id: task.session_id ?? sid });
    this.indexTask(this.getTask(task.id));
    this.pushTask(task.id);
    this.pushAgent(id);
    this.addActivity({
      sessionId: sid, agentId: id, taskId: task.id, kind: 'status',
      summary: `Spawned ${subagentType} agent: ${cut(description.replace(TAG_RE, '').trim(), 200)}`, at,
    });
  }
  onAgentBound(ev) {
    const d = ev.data, sid = ev.sessionId;
    const toolUseId = str(d.toolUseId), agentId = str(d.agentId);
    if (!toolUseId || !agentId) throw new Error('agent.bound: toolUseId and agentId required');
    const a = this.db.get('SELECT * FROM agents WHERE tool_use_id = ? AND session_id = ?', toolUseId, sid);
    if (!a) { this.log?.warn(`agent.bound for unknown toolUseId ${toolUseId}`); return; }
    this.bindAgent(a, agentId, ev.at);
  }
  /** agent.git: the repo state when the agent was spawned. Matched by toolUseId (survives the pending -> bound rename), then agentId. */
  onAgentGit(ev) {
    const d = ev.data, sid = ev.sessionId;
    const toolUseId = str(d.toolUseId), agentId = str(d.agentId);
    const root = str(d.root), base = str(d.base), head = str(d.head);
    if (!root || !path.isAbsolute(root)) { this.log?.warn('agent.git: root must be an absolute path'); return; }
    if (!GIT_REV_RE.test(base) || !GIT_REV_RE.test(head)) { this.log?.warn('agent.git: base/head must be commit ids'); return; }
    let a = toolUseId ? this.db.get('SELECT * FROM agents WHERE tool_use_id = ? AND session_id = ?', toolUseId, sid) : undefined;
    if (!a && agentId) a = this.getAgent(agentId);
    if (!a) { this.log?.warn(`agent.git for unknown agent (toolUseId ${toolUseId || '-'}, agentId ${agentId || '-'})`); return; }
    if (d.discovered === true && a.git) return; // T-66: a late base taken for an agent found by reconcile never replaces a real one
    const at = isNum(d.at) ? d.at : ev.at;
    const git = { root, base, head, at };
    this.upd('agents', a.id, { git: JSON.stringify({ cwd: str(d.cwd), ...git }) });
    this.pushAgent(a.id);
    const t = this.getTask(a.task_id);
    if (t && !t.git) { // the first base wins; a follow-up agent never moves it
      this.upd('tasks', t.id, { git: JSON.stringify(git) });
      this.pushTask(t.id);
    }
  }
  /** task.git (T-66): the repo state when the main loop started working on a task itself (tool action "work"). First base wins. */
  onTaskGit(ev) {
    const d = ev.data;
    const root = str(d.root), base = str(d.base), head = str(d.head);
    if (!root || !path.isAbsolute(root)) { this.log?.warn('task.git: root must be an absolute path'); return; }
    if (!GIT_REV_RE.test(base) || !GIT_REV_RE.test(head)) { this.log?.warn('task.git: base/head must be commit ids'); return; }
    const t = this.getTask(str(d.taskId));
    if (!t) { this.log?.warn(`task.git for unknown task ${d.taskId}`); return; }
    if (t.status !== 'in_progress') return; // the card moved on before the base arrived: the main loop is no longer on it (T-51)
    if (t.git) return;
    this.upd('tasks', t.id, { git: JSON.stringify({ root, base, head, at: isNum(d.at) ? d.at : ev.at }) });
    this.pushTask(t.id);
  }
  /** Remember paths a task's own tool calls mentioned (Edit/Write targets, paths inside Bash commands). Silent: nothing shows them. */
  addMentions(taskId, list) {
    const paths = Array.isArray(list) ? list.filter((f) => typeof f === 'string' && f && f.length <= 400) : [];
    const t = paths.length && taskId ? this.getTask(taskId) : undefined;
    if (!t) return;
    const cur = parse(t.mentions, []);
    let changed = false;
    for (const f of paths) if (cur.length < 800 && !cur.includes(f)) { cur.push(f); changed = true; }
    if (changed) this.upd('tasks', t.id, { mentions: JSON.stringify(cur) });
  }
  /**
   * hub.task.files (T-66): { taskId, files, mode?: 'merge'|'replace', note?, git?: {root, base, head, at} }.
   * The hub's decision about which files a task changed (derived from git, or attached by hand for a backfill).
   * `note` labels how (null = precise). `git` is applied only when the task has no base yet.
   */
  hTaskFiles(ev) {
    const d = ev.data;
    const t = this.getTask(str(d.taskId));
    if (!t) throw new Error('task not found');
    const files = (Array.isArray(d.files) ? d.files : []).filter((f) => typeof f === 'string' && f && !f.includes('\0'));
    const cur = d.mode === 'replace' ? [] : parse(t.files_changed, []);
    for (const f of files) if (!cur.includes(f) && cur.length < 500) cur.push(f);
    const f = { files_changed: JSON.stringify(cur), files_note: d.note ? cut(str(d.note), 300) : null };
    const g = d.git;
    if (!t.git && g && path.isAbsolute(str(g.root)) && GIT_REV_RE.test(str(g.base)) && GIT_REV_RE.test(str(g.head))) {
      f.git = JSON.stringify({ root: str(g.root), base: str(g.base), head: str(g.head), at: isNum(g.at) ? g.at : ev.at });
    }
    this.upd('tasks', t.id, f);
    this.pushTask(t.id);
    return toTask(this.getTask(t.id));
  }
  /** hub.task.diff: freeze a diff for the task and take its stat. */
  hTaskDiff(ev) {
    const { taskId, diff } = ev.data;
    const t = this.getTask(taskId);
    if (!t) throw new Error('task not found');
    this.db.run(
      `INSERT INTO task_diffs(task_id, diff, at) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET diff = excluded.diff, at = excluded.at`, taskId, JSON.stringify(diff), ev.at);
    this.upd('tasks', taskId, { diff_stat: JSON.stringify(statOf(diff)) });
    this.pushTask(taskId);
  }
  /** hub.task.diffstat: a client asked for a live diff; only the stat is kept (the snapshot stays frozen). */
  hTaskDiffStat(ev) {
    const { taskId, diffStat } = ev.data;
    const t = this.getTask(taskId);
    if (!t) throw new Error('task not found');
    this.upd('tasks', taskId, { diff_stat: JSON.stringify(statOf({ totals: diffStat })) });
    this.pushTask(taskId);
  }
  /**
   * hub.task.branch (v0.12): { taskId, branch } replaces Task.branch (null clears it); { taskId, patch } merges fields into it.
   * Everything the hub decided (names, commits, urls, times) is carried in the event, so replay never touches git or the network.
   */
  hTaskBranch(ev) {
    const { taskId } = ev.data;
    const t = this.getTask(taskId);
    if (!t) throw new Error('task not found');
    let next;
    if (ev.data.branch !== undefined) next = ev.data.branch;
    else {
      const cur = parse(t.branch, null);
      if (!cur) throw new Error('task has no branch');
      next = { ...cur, ...ev.data.patch };
    }
    this.upd('tasks', taskId, { branch: next ? JSON.stringify(next) : null });
    this.pushTask(taskId);
    return toTask(this.getTask(taskId));
  }
  /** hub.task.ci (v0.12): { taskId, ci } sets Task.branch.ci. Ignored when the branch is gone (a late poll result). */
  hTaskCi(ev) {
    const { taskId, ci } = ev.data;
    const t = this.getTask(taskId);
    if (!t) throw new Error('task not found');
    const cur = parse(t.branch, null);
    if (!cur) return null;
    this.upd('tasks', taskId, { branch: JSON.stringify({ ...cur, ci: ci ?? null }) });
    this.pushTask(taskId);
    return toTask(this.getTask(taskId));
  }
  /**
   * The task a main-loop event (tool.called / tool.finished / task.git) may be attributed to (T-51). The mod tags main-loop
   * calls with the card it was told to "work" on, but a person can move that card on in the web UI at any time. The tag counts
   * only while that task is in_progress when the event is projected. Projection runs in event order, so a rebuild reaches the
   * same answer. Returns the task id, or null (the event stays session-level).
   */
  mainLoopTask(d) {
    const id = str(d.taskId);
    const t = id ? this.getTask(id) : undefined;
    return t && t.status === 'in_progress' ? t.id : null;
  }
  onToolCalled(ev) {
    const d = ev.data, sid = ev.sessionId, at = ev.at;
    this.ensureSession(sid, at);
    this.touchSession(sid, at);
    const summary = cut(str(d.summary) || str(d.tool), 300);
    const tool = str(d.tool);
    const agentId = str(d.agentId);
    const a = agentId ? this.resolveAgent(sid, agentId, at) : null;
    const mainTask = agentId ? null : this.mainLoopTask(d);
    this.addActivity({
      sessionId: sid, agentId: a ? a.id : agentId || null, taskId: a ? a.task_id : mainTask,
      kind: 'tool', tool, summary, at,
    });
    if (a) {
      if (a.status === 'running' || a.status === 'stalled') {
        this.recoverAgent(a, at, { nowDoing: summary, countTool: true });
      } else if (a.status === 'waiting') {
        // A new tool call (other than the question itself) means the user answered: the agent is working again.
        if (tool === 'AskUserQuestion') this.upd('agents', a.id, { last_activity_at: Math.max(a.last_activity_at, at) });
        else this.leaveWaiting(a, at, { now_doing: summary, tool_count: a.tool_count + 1 });
      }
    } else if (agentId) {
      this.bumpPending(sid, at);
    } else {
      this.upd('sessions', sid, { now_doing: summary });
      this.pushSession(sid);
    }
    if (tool === 'AskUserQuestion') {
      const toolUseId = str(d.toolUseId) || null;
      const dup = toolUseId && this.db.get(
        'SELECT 1 AS x FROM questions WHERE session_id = ? AND tool_use_id = ?', sid, toolUseId);
      if (!dup) {
        this.createQuestion({
          sessionId: sid, agentId: a ? a.id : agentId || null, taskId: a ? a.task_id : null, kind: 'ask',
          text: cut(str(d.summary) || 'Question', 2000), toolUseId, at,
        });
      }
    }
    if (a && Array.isArray(d.files)) this.touchFiles(a, d.files, at);
    if (Array.isArray(d.paths)) this.addMentions(a ? a.task_id : mainTask, d.paths);
  }
  onToolFinished(ev) {
    const d = ev.data, sid = ev.sessionId, at = ev.at;
    this.ensureSession(sid, at);
    this.touchSession(sid, at);
    const agentId = str(d.agentId);
    const a = agentId ? this.resolveAgent(sid, agentId, at) : null;
    const mainTask = agentId ? null : this.mainLoopTask(d);
    this.addActivity({
      sessionId: sid, agentId: a ? a.id : agentId || null, taskId: a ? a.task_id : mainTask, kind: 'tool_done',
      tool: str(d.tool), summary: cut(str(d.summary) || str(d.tool), 300),
      ok: d.ok === undefined ? null : d.ok !== false, at,
    });
    if (a) {
      if (a.status === 'running' || a.status === 'stalled') this.recoverAgent(a, at);
      else if (a.status === 'waiting') this.upd('agents', a.id, { last_activity_at: Math.max(a.last_activity_at, at) });
      this.addFiles(a.task_id, d.files, at);
    } else if (agentId) {
      this.bumpPending(sid, at);
    } else if (mainTask) {
      this.addFiles(mainTask, d.files, at);
    }
    // The user answered (or the call ended some other way): the matching question is no longer open.
    const toolUseId = str(d.toolUseId);
    if (toolUseId) this.answerQuestions({ sessionId: sid, toolUseId, kind: 'ask' }, at);
  }
  /** Append files (deduped, capped) to a task's filesChanged. */
  addFiles(taskId, list, at) {
    const files = Array.isArray(list) ? list.filter((f) => typeof f === 'string' && f) : [];
    const t = files.length ? this.getTask(taskId) : undefined;
    if (!t) return;
    const cur = parse(t.files_changed, []);
    let changed = false;
    for (const f of files) if (!cur.includes(f) && cur.length < 500) { cur.push(f); changed = true; }
    if (changed) {
      this.upd('tasks', t.id, { files_changed: JSON.stringify(cur), updated_at: Math.max(t.updated_at, at) });
      this.pushTask(t.id);
    }
  }
  onAgentCompleted(ev) {
    const d = ev.data, sid = ev.sessionId, at = ev.at;
    this.ensureSession(sid, at);
    this.touchSession(sid, at);
    const agentId = str(d.agentId);
    if (!agentId) throw new Error('agent.completed: agentId required');
    const ok = d.ok !== false && d.ok !== 0;
    const a = this.resolveAgent(sid, agentId, at);
    if (!a) {
      this.db.run(
        `INSERT OR REPLACE INTO late_completions(session_id, agent_id, ok, summary, tokens, at, report) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        sid, agentId, ok ? 1 : 0, cut(str(d.summary), 1000), isNum(d.tokens) ? d.tokens : null, at, d.report ? cut(str(d.report), REPORT_MAX) : null);
      return;
    }
    this.completeAgent(a, ok, str(d.summary), isNum(d.tokens) ? d.tokens : undefined, at);
    // T-76: the full final report is kept so a recap can always be rebuilt from it (never replaced by a later empty one).
    this.keepReport(a.id, d.report);
    // Files the agent reported in its final message (edits made through Bash never pass Edit/Write).
    this.addFiles(a.task_id, d.files, at);
  }
  onRecap(ev) {
    const d = ev.data;
    this.applyRecap(str(d.taskId), d, ev.at, ev.sessionId);
  }
  /** Set a task's recap (recap.generated, the recap job's result, a backfill). */
  applyRecap(taskId, d, at, sessionId) {
    const t = this.getTask(taskId);
    if (!t) { this.log?.warn(`recap.generated for unknown task ${taskId}`); return; }
    const concepts = [];
    for (const c of Array.isArray(d.concepts) ? d.concepts : []) {
      const v = cut(str(c).trim(), 60);
      if (v && !concepts.some((x) => x.toLowerCase() === v.toLowerCase()) && concepts.length < 12) concepts.push(v);
    }
    const recap = { what: str(d.what), how: str(d.how), learned: str(d.learned), concepts };
    this.upd('tasks', t.id, { recap: JSON.stringify(recap), recap_at: at, updated_at: Math.max(t.updated_at, at) });
    this.indexRecap(this.getTask(t.id));
    conceptsOnRecap(this, t.id, concepts, at);
    this.pushTask(t.id);
    this.ensureSession(sessionId, at);
    this.addActivity({
      sessionId: t.session_id || sessionId, agentId: t.agent_id, taskId: t.id, kind: 'recap',
      summary: cut(recap.what || 'Recap generated', 400), at,
    });
  }
  /** Store an agent's final report once (the first non-empty one wins; a recovered completion carries none). */
  keepReport(agentId, report) {
    const text = typeof report === 'string' ? report.trim() : '';
    const a = text ? this.getAgent(agentId) : null;
    if (a && !a.report) this.upd('agents', a.id, { report: cut(text, REPORT_MAX) });
  }
  /** hub.agent.report (T-76): attach a final report recovered from elsewhere (a transcript) to an agent that has none. */
  hAgentReport(ev) {
    this.keepReport(str(ev.data.agentId), ev.data.report);
  }
  onNoteResult(ev) {
    const d = ev.data, at = ev.at;
    const n = this.getNote(str(d.noteId));
    if (!n) { this.log?.warn(`note.result for unknown note ${d.noteId}`); return; }
    // A note the sweep timed out (failed + SENDING_TIMEOUT_ERROR) is still open to its real result:
    // ran / failed wins over the timeout. Any other terminal state is final.
    const timedOut = n.state === 'failed' && n.error === SENDING_TIMEOUT_ERROR;
    if (n.state !== 'sending' && n.state !== 'queued' && !timedOut) return;
    const ok = d.ok !== false;
    const via = NOTE_VIAS.includes(d.via) ? d.via : null;
    this.upd('notes', n.id, {
      state: ok ? 'ran' : 'failed', ran_at: at, via, error: ok ? null : cut(str(d.error) || 'delivery failed', 500),
    });
    this.indexNote(this.getNote(n.id));
    this.pushNote(n.id);
    this.addActivity({
      sessionId: n.session_id || ev.sessionId, taskId: n.target_kind === 'task' ? n.target_id : null, kind: 'note',
      summary: ok ? `Note ${n.id} delivered${via ? ' via ' + via : ''}: ${cut(n.text, 160)}`
        : `Note ${n.id} failed: ${cut(str(d.error) || 'delivery failed', 160)}`,
      ok, at,
    });
    if (!ok && n.link_id) this.onLinkReply(n, `Not delivered: ${cut(str(d.error) || 'delivery failed', 200)}`, at);
  }
  onNoteReply(ev) {
    const d = ev.data;
    const n = this.getNote(str(d.noteId));
    if (!n) { this.log?.warn(`note.reply for unknown note ${d.noteId}`); return; }
    const text = cut(str(d.text).trim(), 8000);
    if (!text) return;
    this.upd('notes', n.id, { reply: text, replied_at: ev.at });
    this.indexNote(this.getNote(n.id));
    this.pushNote(n.id);
    this.addActivity({
      sessionId: n.session_id || ev.sessionId, taskId: n.target_kind === 'task' ? n.target_id : null, kind: 'note',
      summary: `Reply to ${n.id}: ${cut(text, 160)}`, at: ev.at,
    });
    if (n.link_id) this.onLinkReply(n, text, ev.at);
  }
  onReconcile(ev) {
    const sid = ev.sessionId, at = ev.at;
    this.ensureSession(sid, at);
    this.touchSession(sid, at);
    const report = (Array.isArray(ev.data.agents) ? ev.data.agents : [])
      .filter((a) => a && typeof a.agentId === 'string' && ['running', 'waiting', 'done', 'failed'].includes(a.status));
    const reported = new Map(report.map((a) => [a.agentId, a.status]));
    const alive = (st) => st === 'running' || st === 'waiting';
    const live = () => this.db.all(`SELECT * FROM agents WHERE session_id = ? AND status IN ('running','stalled','waiting')`, sid);
    // 1. engine has a live agent the hub doesn't know -> bind to the sole pending one, else create.
    const unknown = report.filter((a) => alive(a.status) && !this.getAgent(a.agentId));
    const pendings = live().filter((a) => a.id.startsWith('pending:'));
    for (const u of unknown) {
      if (pendings.length === 1 && unknown.length === 1) {
        this.bindAgent(pendings[0], u.agentId, at);
        continue;
      }
      this.db.run(
        `INSERT INTO agents(id, session_id, task_id, tool_use_id, subagent_type, model, description, status,
           started_at, ended_at, last_activity_at, now_doing, tool_count, tokens)
         VALUES (?, ?, NULL, ?, ?, '', ?, 'running', ?, NULL, ?, '', 0, 0)`,
        u.agentId, sid, `reconcile:${u.agentId}`, str(u.type) || 'unknown',
        cut(str(u.description).replace(TAG_RE, '').trim(), 500) || 'Agent discovered by reconcile', at, at);
      this.pushAgent(u.agentId);
      this.addActivity({ sessionId: sid, agentId: u.agentId, kind: 'status', summary: 'Agent discovered by reconcile', at });
    }
    // 1b. a discovered agent whose description carries [helm:T-n] belongs to that card (spawns the mod made itself).
    for (const r of report) {
      const m = alive(r.status) && TAG_RE.exec(str(r.description));
      const a = m && this.getAgent(r.agentId);
      if (!a || a.task_id) continue;
      const task = this.getTask(m[1].toUpperCase());
      if (!task) continue;
      this.upd('agents', a.id, { task_id: task.id });
      if (a.status === 'stalled') this.upd('agents', a.id, { status: 'running' });
      this.setTaskStatus(task, 'in_progress', at, null);
      this.upd('tasks', task.id, { agent_id: a.id, interrupted: 0, updated_at: at });
      this.db.run('UPDATE activity SET task_id = ? WHERE agent_id = ? AND task_id IS NULL', task.id, a.id);
      this.pushTask(task.id);
      this.pushAgent(a.id);
    }
    // 2. hub says live but the engine says finished / has no such agent.
    for (const a of live()) {
      if (a.id.startsWith('pending:')) {
        // not bound yet: only give up on it if the report offers no candidate and it is not brand new
        if (unknown.length === 0 && at - a.started_at > 60_000 && !reported.has(a.id)) {
          this.completeAgent(a, false, 'not running in session (reconciled)', undefined, at);
        }
        continue;
      }
      const st = reported.get(a.id);
      if (alive(st)) continue;
      if (st === 'done') this.completeAgent(a, true, 'finished (reconciled)', undefined, at);
      else if (st === 'failed') this.completeAgent(a, false, 'failed (reconciled)', undefined, at);
      else this.completeAgent(a, false, 'missing from session (reconciled)', undefined, at);
    }
    // 3. running <-> waiting transitions (the engine is the authority on whether an agent waits for the user).
    for (const r of report) {
      if (!alive(r.status)) continue;
      const a = this.getAgent(r.agentId);
      if (!a || a.session_id !== sid || a.id.startsWith('pending:')) continue;
      if (r.status === 'waiting' && (a.status === 'running' || a.status === 'stalled')) this.enterWaiting(a, at);
      else if (r.status === 'running' && a.status === 'waiting') this.leaveWaiting(a, at);
    }
  }
  onJobResult(ev) {
    const d = ev.data, at = ev.at;
    const j = this.getJob(str(d.jobId));
    if (!j) { this.log?.warn(`job.result for unknown job ${d.jobId}`); return; }
    // queued/running accept a result; a job the sweep timed out may still be rescued by its real answer.
    const timedOut = j.state === 'failed' && j.error === JOB_TIMEOUT_ERROR;
    if (j.state !== 'running' && j.state !== 'queued' && !timedOut) return;
    const text = typeof d.text === 'string' ? d.text : '';
    const ok = d.ok !== false && !!text.trim();
    if (!ok) {
      this.failJob(j, cut(d.ok === false ? str(d.error) || 'job failed' : 'empty result', 500), at);
      return;
    }
    if (j.kind === 'explain') {
      const t = this.getTask(j.task_id);
      // a late answer for an older job must not overwrite a newer explanation
      if (t && (!t.explain_job || parse(t.explain_job, {}).id === j.id)) {
        this.upd('tasks', t.id, { explainer: cut(text, 20000) });
        this.indexTask(this.getTask(t.id));
      }
    } else if (j.kind === 'wf_draft') {
      // v0.10: keep the raw reply on a still-running job; the workflow engine judges it right after this commit
      // (hub/wfengine.mjs finishDraft) and ends the job with a hub.job.finish event.
      this.upd('jobs', j.id, { state: 'running', claimed_at: j.claimed_at ?? at, result: cut(text, 20000), error: null, done_at: null });
      this.pushJob(j.id);
      return;
    } else if (j.kind === 'doc_draft' || j.kind === 'doc_edit') {
      // v0.15: like wf_draft, keep the raw reply on a still-running job; hub/docsengine.mjs judges it right after this commit.
      this.upd('jobs', j.id, { state: 'running', claimed_at: j.claimed_at ?? at, result: cut(text, 40000), error: null, done_at: null });
      this.pushJob(j.id);
      return;
    } else if (j.kind === 'concept_summary') {
      // v0.13: the page becomes Concept.summary (the slug may have been merged away since the job was made)
      storeSummary(this, str(parse(j.input, {}).concept?.slug), text, at);
    } else if (j.kind === 'recap') {
      // T-76: a Haiku recap built from the task's activity trail (the safety net / backfill when no report is stored)
      const r = recapFromJson(text);
      if (!r) { this.failJob(j, 'recap reply was not the expected JSON', at); return; }
      if (this.getTask(j.task_id)) this.applyRecap(j.task_id, r, at, ev.sessionId);
    } else if (j.kind === 'digest') {
      this.createDigest({ date: str(parse(j.input, {}).date), projectId: j.project_id, text: cut(text, 20000), at });
    }
    this.upd('jobs', j.id, { state: 'done', result: cut(text, 20000), error: null, done_at: at });
    this.noteJobState(j.id);
    this.pushJob(j.id);
  }
  failJob(j, error, at) {
    this.upd('jobs', j.id, { state: 'failed', error, done_at: at });
    this.noteJobState(j.id);
    this.pushJob(j.id);
  }
  /** Mirror an explain job's state onto its task (Task.explainJob) and push the task. */
  noteJobState(jobId) {
    const j = this.getJob(jobId);
    if (!j || j.kind !== 'explain' || !j.task_id) return;
    const t = this.getTask(j.task_id);
    if (!t) return;
    const cur = parse(t.explain_job, null);
    if (cur && cur.id !== j.id && Number(cur.id.slice(2)) > Number(j.id.slice(2))) {
      this.pushTask(t.id); // an older job finished; the task keeps pointing at the newer one (explainer may have changed)
      return;
    }
    this.upd('tasks', t.id, { explain_job: JSON.stringify({ id: j.id, state: j.state }) });
    this.pushTask(t.id);
  }
  createDigest({ date, projectId, text, at }) {
    const id = this.nextId('D');
    this.db.run('INSERT INTO digests(id, date, project_id, text, created_at) VALUES (?, ?, ?, ?, ?)',
      id, date, projectId ?? null, text, at);
    const p = projectId ? this.getProject(projectId) : null;
    this.setDoc('digest', id, `Digest ${date}${p ? ' · ' + p.name : ''}`, text, { at });
    this.emit('digest', 'upsert', toDigest(this.db.get('SELECT * FROM digests WHERE id = ?', id)));
    return id;
  }

  // ------------------------------------------------------------------ questions
  createQuestion({ sessionId, agentId, taskId, kind, text, toolUseId, at, hint = '', runId = null, nodeId = null }) {
    const id = this.nextId('Q');
    this.db.run(
      `INSERT INTO questions(id, session_id, agent_id, task_id, kind, text, tool_use_id, state, created_at, answered_at, run_id, node_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, ?, ?)`, id, sessionId, agentId, taskId, kind, text, toolUseId, at, runId, nodeId);
    const title = kind === 'ask' ? cut(text, 120) : kind === 'approval' ? `Approval: ${cut(text, 100)}` : 'Waiting for input';
    this.setDoc('question', id, title, kind === 'ask' ? text : hint, { sessionId, taskId, at });
    this.pushQuestion(id);
    return id;
  }
  /** Mark matching open questions answered. Filters: agentId, sessionId, toolUseId, kind. */
  answerQuestions(f, at) {
    const where = [`state = 'open'`], p = [];
    if (!f.kind) where.push(`kind != 'approval'`); // a workflow gate is only ever answered by a decision, never by session churn
    if (f.agentId) { where.push('agent_id = ?'); p.push(f.agentId); }
    if (f.sessionId) { where.push('session_id = ?'); p.push(f.sessionId); }
    if (f.toolUseId) { where.push('tool_use_id = ?'); p.push(f.toolUseId); }
    if (f.kind) { where.push('kind = ?'); p.push(f.kind); }
    for (const q of this.db.all(`SELECT id FROM questions WHERE ${where.join(' AND ')} ORDER BY rowid`, ...p)) {
      this.db.run(`UPDATE questions SET state = 'answered', answered_at = ? WHERE id = ?`, at, q.id);
      this.pushQuestion(q.id);
    }
  }

  // ------------------------------------------------------------- conflict radar
  /** Record files an agent is about to edit, then refresh conflicts. */
  touchFiles(a, list, at) {
    const files = [...new Set(list.filter((f) => typeof f === 'string' && f))].slice(0, TOOL_EDIT_CAP);
    if (!files.length) return;
    for (const f of files) {
      this.db.run(
        `INSERT INTO agent_files(agent_id, path, at) VALUES (?, ?, ?)
         ON CONFLICT(agent_id, path) DO UPDATE SET at = MAX(at, excluded.at)`, a.id, cut(f, 1000), at);
    }
    this.recomputeConflicts(at);
  }
  /** Rebuild the `conflicts` table and every Task.conflicts from agent_files; pushes only tasks that changed. */
  recomputeConflicts(at) {
    // rows that can never matter again (agent finished and the window passed) are dropped
    this.db.run(
      `DELETE FROM agent_files WHERE at < ? AND agent_id NOT IN (SELECT id FROM agents WHERE status IN ('running','stalled','waiting'))`,
      at - CONFLICT_WINDOW_MS);
    const list = computeConflicts(this.db, at);
    const stored = this.db.all('SELECT path, agents FROM conflicts ORDER BY path');
    const same = stored.length === list.length
      && stored.every((r, i) => r.path === list[i].path && r.agents === JSON.stringify(list[i].agents));
    if (!same) {
      this.db.run('DELETE FROM conflicts');
      for (const c of list) this.db.run('INSERT INTO conflicts(path, agents) VALUES (?, ?)', c.path, JSON.stringify(c.agents));
    }
    const byTask = new Map();
    for (const c of list) {
      for (const x of c.agents) {
        if (!x.taskId) continue;
        for (const y of c.agents) {
          if (y.agentId === x.agentId || y.taskId === x.taskId) continue;
          let arr = byTask.get(x.taskId);
          if (!arr) byTask.set(x.taskId, (arr = []));
          if (!arr.some((e) => e.path === c.path && e.otherAgentId === y.agentId)) {
            arr.push({ path: c.path, otherTaskId: y.taskId, otherAgentId: y.agentId, otherSessionId: y.sessionId });
          }
        }
      }
    }
    for (const arr of byTask.values()) {
      arr.sort((p, q) => (p.path < q.path ? -1 : p.path > q.path ? 1 : p.otherAgentId < q.otherAgentId ? -1 : p.otherAgentId > q.otherAgentId ? 1 : 0));
    }
    const ids = new Set(byTask.keys());
    for (const r of this.db.all(`SELECT id FROM tasks WHERE conflicts != '[]'`)) ids.add(r.id);
    for (const id of [...ids].sort()) {
      const t = this.getTask(id);
      if (!t) continue;
      const next = JSON.stringify(byTask.get(id) || []);
      if (t.conflicts === next) continue;
      this.upd('tasks', id, { conflicts: next });
      this.pushTask(id);
    }
  }

  // ------------------------------------------------------------ hub commands
  hProjectCreate(ev) {
    return toProject(this.createProject(str(ev.data.name), ev.at, false));
  }
  hProjectUpdate(ev) {
    const d = ev.data, p = this.getProject(d.id);
    if (!p) throw new Error('project not found');
    const f = {};
    if (d.name !== undefined) { f.name = cut(str(d.name), 200); f.auto = 0; }
    if (d.archived !== undefined) f.archived = d.archived ? 1 : 0;
    if (d.autoStart !== undefined) f.auto_start = d.autoStart ? 1 : 0;
    if (d.autoConcurrency !== undefined) f.auto_concurrency = Math.min(5, Math.max(1, d.autoConcurrency | 0));
    this.upd('projects', p.id, f);
    const np = this.getProject(p.id);
    this.setDoc('project', np.id, np.name, '', { at: ev.at });
    this.pushProject(p.id);
    return toProject(np);
  }
  /** hub.project.coordinator { projectId, on }: at most one coordinator; turning one on clears the other. Sessions derive the flag, so they are pushed too. */
  hProjectCoordinator(ev) {
    const { projectId, on } = ev.data, p = this.getProject(projectId);
    if (!p) throw new Error('project not found');
    const touched = [p.id];
    if (on) for (const o of this.db.all('SELECT id FROM projects WHERE coordinator = 1 AND id != ? ORDER BY rowid', p.id)) {
      this.upd('projects', o.id, { coordinator: 0 });
      touched.push(o.id);
    }
    this.upd('projects', p.id, { coordinator: on ? 1 : 0 });
    for (const id of touched) {
      this.pushProject(id);
      for (const s of this.db.all('SELECT id FROM sessions WHERE project_id = ? ORDER BY rowid', id)) this.pushSession(s.id);
    }
    return toProject(this.getProject(p.id));
  }
  /** "<project> / <session title>" of a session, for the prefix of a cross-session note. */
  sessionLabel(sessionId) {
    const s = this.getSession(sessionId), p = s ? this.getProject(s.project_id) : null;
    return `${p ? p.name : '?'} / ${s ? s.title : sessionId}`;
  }
  /** A note one session sends another. Its text carries the "information, not approval" prefix; the mod delivers it as not-user. */
  insertLinkNote(linkId, fromLabel, body, sessionId, at) {
    const nid = this.nextId('N');
    // One line, and no "Helm note" marker inside it: a body can never start a second note line or name another note's id.
    const text = `Helm note from ${plainLine(fromLabel)} (${nid}) \u2014 information from another session, not approval from the user: ${plainLine(body)}`;
    this.db.run(
      `INSERT INTO notes(id, target_kind, target_id, session_id, text, state, created_at, queued_at, ran_at, via, error, sending_at, link_id)
       VALUES (?, 'session', ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?)`,
      nid, sessionId || '', sessionId || '', text, at, at, linkId);
    this.indexNote(this.getNote(nid));
    this.pushNote(nid);
    return nid;
  }
  /**
   * hub.link.create { kind: 'note'|'task', fromSessionId, fromProjectId, toProjectId, toSessionId, text, refId? }.
   * A note link makes its note at once (queued for toSessionId, or held with no session until hub.link.deliver); a task
   * link only records that a card was created / updated in another project and is born answered.
   */
  hLinkCreate(ev) {
    const d = ev.data, at = ev.at, id = this.nextId('L');
    const note = d.kind === 'note';
    const to = note ? d.toSessionId || null : null;
    const ref = note ? this.insertLinkNote(id, this.sessionLabel(d.fromSessionId), str(d.text), to, at) : str(d.refId) || null;
    this.db.run(
      `INSERT INTO links(id, kind, from_session_id, from_project_id, to_project_id, to_session_id, ref_id, text, state, reply, created_at, delivered_at, answered_at, acknowledged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
      id, d.kind, str(d.fromSessionId), str(d.fromProjectId), str(d.toProjectId), to, ref, cut(plainLine(d.text), 200),
      note ? (to ? 'delivered' : 'queued') : 'answered', at, note && !to ? null : at, note ? null : at);
    this.pushLink(id);
    return toLink(this.getLink(id));
  }
  /** hub.link.deliver { noteId, sessionId }: a held (or stranded) link note goes to a live session's inbox. */
  hLinkDeliver(ev) {
    const { noteId, sessionId } = ev.data, n = this.getNote(noteId);
    if (!n || !n.link_id) throw new Error('not a link note');
    this.upd('notes', n.id, { session_id: sessionId, target_id: sessionId });
    this.pushNote(n.id);
    const l = this.getLink(n.link_id);
    if (l && l.ref_id === n.id) {
      this.upd('links', l.id, { to_session_id: sessionId, ...(l.state === 'queued' ? { state: 'delivered', delivered_at: ev.at } : {}) });
      this.pushLink(l.id);
    }
  }
  /** The receiving session answered a link note (or it could not be delivered): store it on the link and tell the sender once. */
  onLinkReply(n, text, at) {
    const l = this.getLink(n.link_id);
    if (!l || l.ref_id !== n.id) return;
    const failed = (t) => /^Not delivered:/.test(t ?? '');
    // tell the sender on the first answer, and again when a real reply follows a "Not delivered" one
    const first = l.state !== 'answered' || (failed(l.reply) && !failed(text));
    this.upd('links', l.id, { reply: cut(text, 500), ...(l.state !== 'answered' ? { state: 'answered', answered_at: at } : {}) });
    this.pushLink(l.id);
    if (!first) return;
    const from = this.getSession(l.from_session_id);
    const sid = from && from.status !== 'ended' ? from.id : this.pickLive(l.from_project_id) || l.from_session_id;
    this.insertLinkNote(l.id, this.sessionLabel(n.session_id), `Reply to your note ${l.id} (\u201c${cut(l.text, 80)}\u201d): ${cut(text, 500)}`, sid, at);
  }
  /** hub.ack / hub.unack { kind: 'agent'|'session'|'link', id }: archive a finished row (or restore it). */
  hAck(ev) {
    const { kind, id } = ev.data, table = { agent: 'agents', session: 'sessions', link: 'links' }[kind];
    if (!table || !this.db.get(`SELECT 1 AS x FROM ${table} WHERE id = ?`, id)) throw new Error(`${kind} not found`);
    this.upd(table, id, { acknowledged_at: ev.type === 'hub.ack' ? ev.at : null });
    if (kind === 'agent') this.pushAgent(id); else if (kind === 'session') this.pushSession(id); else this.pushLink(id);
  }
  hSessionJoin(ev) {
    const { sessionId, projectId } = ev.data;
    if (!this.getSession(sessionId)) throw new Error('session not found');
    this.moveSession(sessionId, projectId, ev.at);
    this.pushSession(sessionId);
    return toSession(this.getSession(sessionId));
  }
  /** Move a session and its tasks to another project; drop an auto-created project left empty. */
  moveSession(sessionId, projectId, at) {
    const s = this.getSession(sessionId);
    const old = s.project_id;
    const ev = { at };
    if (old !== projectId) {
      this.upd('sessions', sessionId, { project_id: projectId });
      const moved = this.db.all('SELECT id FROM tasks WHERE session_id = ? AND project_id != ?', sessionId, projectId);
      this.db.run('UPDATE tasks SET project_id = ?, updated_at = MAX(updated_at, ?) WHERE session_id = ? AND project_id != ?',
        projectId, ev.at, sessionId, projectId);
      for (const t of moved) this.pushTask(t.id);
      // an auto-created project that the join left completely empty is just noise: drop it
      const op = this.getProject(old);
      if (op && op.auto
        && !this.db.get('SELECT 1 AS x FROM sessions WHERE project_id = ? LIMIT 1', old)
        && !this.db.get('SELECT 1 AS x FROM tasks WHERE project_id = ? LIMIT 1', old)) {
        this.db.run('DELETE FROM projects WHERE id = ?', old);
        this.delDoc('project', old);
        this.emit('project', 'delete', toProject(op));
      }
    }
  }
  hTaskCreate(ev) {
    const d = ev.data;
    const t = this.createTask({
      projectId: d.projectId, sessionId: d.sessionId ?? null, title: str(d.title), description: str(d.description),
      status: d.status || 'backlog', dependsOn: d.dependsOn || [], at: ev.at,
    });
    const extra = {};
    if (d.parentTaskId) extra.parent_task_id = str(d.parentTaskId);
    if (d.createdBySessionId) { extra.created_by_session_id = str(d.createdBySessionId); extra.from_project_id = str(d.fromProjectId) || null; }
    if (d.runId) { extra.run_id = str(d.runId); extra.node_id = str(d.nodeId) || null; } // v0.9: a workflow run created this card
    if (Object.keys(extra).length) { this.upd('tasks', t.id, extra); this.pushTask(t.id); return toTask(this.getTask(t.id)); }
    return toTask(t);
  }
  // ----------------------------------------------------------------- choices (v0.6)
  /** task.choices (mod event): replace the task's choice set, keeping state / taskId of ids that still exist. */
  onTaskChoices(ev) {
    const t = this.getTask(str(ev.data.taskId));
    if (!t) return null;
    const old = new Map(parse(t.choices, []).map((c) => [c.id, c]));
    const seen = new Set();
    const list = [];
    for (const raw of Array.isArray(ev.data.choices) ? ev.data.choices : []) {
      if (!raw || typeof raw !== 'object' || list.length >= MAX_CHOICES) continue;
      const title = cut(str(raw.title).trim(), 300);
      if (!title) continue;
      let id = cut(str(raw.id).trim(), 64) || `c${list.length + 1}`;
      if (seen.has(id)) id = `c${list.length + 1}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const prev = old.get(id);
      list.push({
        id, title, detail: cut(str(raw.detail), 4000),
        effort: ['S', 'M', 'L'].includes(raw.effort) ? raw.effort : null,
        value: ['low', 'medium', 'high'].includes(raw.value) ? raw.value : null,
        state: prev ? prev.state : 'open', taskId: prev ? prev.taskId : null,
        ...(prev && prev.note ? { note: prev.note } : {}), ...(prev && prev.message ? { message: prev.message } : {}),
      });
    }
    this.db.run('UPDATE tasks SET choices = ?, updated_at = ? WHERE id = ?', JSON.stringify(list), ev.at, t.id);
    this.pushTask(t.id);
    return toTask(this.getTask(t.id));
  }
  /**
   * hub.task.choices: { id, mode: 'apply', results: [{ choiceId, taskId }] } marks those picked (with their new task)
   * and every other open choice skipped; { id, mode: 'reset' } puts every choice back to open (created tasks stay).
   */
  hTaskChoices(ev) {
    const { id, mode } = ev.data;
    const t = this.getTask(id);
    if (!t) throw new Error('task not found');
    const results = new Map((ev.data.results || []).map((r) => [r.choiceId, r]));
    const list = parse(t.choices, []).map((c) => {
      if (mode === 'reset') { const { note, message, ...rest } = c; return { ...rest, state: 'open', taskId: null }; }
      if (c.state !== 'open') return c;
      if (!results.has(c.id)) return { ...c, state: 'skipped' };
      const r = results.get(c.id);
      const out = { ...c, state: 'picked', taskId: r.taskId };
      if (r.note) out.note = cut(str(r.note), 500);
      if (r.message) out.message = cut(str(r.message), 1000);
      return out;
    });
    this.db.run('UPDATE tasks SET choices = ?, updated_at = ? WHERE id = ?', JSON.stringify(list), ev.at, id);
    this.pushTask(id);
    return toTask(this.getTask(id));
  }
  hTaskUpdate(ev) {
    const { id, patch: p } = ev.data;
    const t = this.getTask(id);
    if (!t) throw new Error('task not found');
    const f = {};
    if (p.title !== undefined) f.title = cut(str(p.title), 300);
    if (p.description !== undefined) f.description = cut(str(p.description), 20000);
    if (p.dependsOn !== undefined) f.depends_on = JSON.stringify(p.dependsOn);
    f.updated_at = ev.at;
    this.upd('tasks', id, f);
    if (p.status !== undefined || p.order !== undefined || p.blockedReason !== undefined) {
      const cur = this.getTask(id);
      const status = p.status ?? cur.status;
      // T-53: this event is the user's PATCH, so a block it sets (status 'blocked' or a non-null reason) is the user's.
      const by = status === 'blocked' && (p.status === 'blocked' || (p.blockedReason !== undefined && p.blockedReason !== null)) ? 'user' : undefined;
      this.setTaskStatus(cur, status, ev.at, p.blockedReason, p.order, by);
    }
    const nt = this.getTask(id);
    this.indexTask(nt);
    if (nt.recap) this.indexRecap(nt);
    this.pushTask(id);
    return toTask(nt);
  }
  /** Attachment ids -> the JSON stored on a note (full metadata, so a note reads back without a join). */
  attachmentsJson(ids) {
    const list = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const a = this.getAttachment(id);
      if (a) list.push(toAttachment(a, this.attachDir));
    }
    return JSON.stringify(list.map(({ createdAt, ...rest }) => rest));
  }
  hAttachmentCreate(ev) {
    const d = ev.data;
    const id = this.nextId('A');
    this.db.run('INSERT INTO attachments(id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?)',
      id, str(d.name), str(d.mime, 'application/octet-stream'), Number(d.size) || 0, ev.at);
    return toAttachment(this.getAttachment(id), this.attachDir);
  }
  onUsage(ev) {
    const d = ev.data;
    const kind = str(d.kind);
    const cost = Number(d.costUsd);
    if (!USAGE_KINDS.includes(kind) || !Number.isFinite(cost) || cost < 0) {
      this.log?.warn(`helm.usage ignored: bad kind/costUsd (${kind}, ${d.costUsd})`);
      return;
    }
    // v0.9: rows that carry runId + nodeId also roll up into that run node (and so the run total).
    bookRunUsage(this, {
      at: ev.at, sessionId: ev.sessionId, kind, model: d.model, inputTokens: d.inputTokens, outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens, costUsd: cost, taskId: d.taskId, noteId: d.noteId,
      runId: d.runId == null ? null : str(d.runId), nodeId: d.nodeId == null ? null : str(d.nodeId),
    });
    // The pushed row uses the wall clock ("today"), but only the SSE `changes` feed depends on it, never a projection table.
    this.emit('usage', 'upsert', usageToday(this.db, this.clock()));
  }
  hNoteCreate(ev) {
    const d = ev.data;
    const id = this.nextId('N');
    this.db.run(
      `INSERT INTO notes(id, target_kind, target_id, session_id, text, state, created_at, queued_at, ran_at, via, error, sending_at, attachments)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
      id, d.target.kind, d.target.id, d.sessionId || '', d.text, ev.at, this.attachmentsJson(d.attachments));
    this.indexNote(this.getNote(id));
    this.pushNote(id);
    return toNote(this.getNote(id));
  }
  hNoteUpdate(ev) {
    const n = this.getNote(ev.data.id);
    if (!n || n.state !== 'draft') throw new Error('note not editable');
    const f = {};
    if (ev.data.text !== undefined) f.text = ev.data.text;
    if (ev.data.attachments !== undefined) f.attachments = this.attachmentsJson(ev.data.attachments);
    this.upd('notes', n.id, f);
    this.indexNote(this.getNote(n.id));
    this.pushNote(n.id);
    return toNote(this.getNote(n.id));
  }
  hNoteDelete(ev) {
    const n = this.getNote(ev.data.id);
    if (!n || n.state !== 'draft') throw new Error('note not deletable');
    this.db.run('DELETE FROM notes WHERE id = ?', n.id);
    this.delDoc('note', n.id);
    this.emit('note', 'delete', toNote(n));
    return toNote(n);
  }
  hNoteExecute(ev) {
    const out = [];
    for (const id of ev.data.ids) {
      const n = this.getNote(id);
      if (!n || n.state !== 'draft') continue;
      const sid = ev.data.sessions[id] || n.session_id;
      this.upd('notes', id, { state: 'queued', queued_at: ev.at, session_id: sid, error: null });
      const nn = this.getNote(id);
      this.indexNote(nn);
      this.pushNote(id);
      this.addActivity({
        sessionId: sid, taskId: nn.target_kind === 'task' ? nn.target_id : null, kind: 'note',
        summary: `Note ${id} queued: ${cut(nn.text, 200)}`, at: ev.at,
      });
      out.push(toNote(nn));
    }
    return out;
  }
  hNoteRetry(ev) {
    const n = this.getNote(ev.data.id);
    if (!n || n.state !== 'failed') throw new Error('note not retryable');
    this.upd('notes', n.id, {
      state: 'queued', queued_at: ev.at, ran_at: null, via: null, error: null, sending_at: null,
      session_id: ev.data.sessionId || n.session_id,
    });
    const nn = this.getNote(n.id);
    this.indexNote(nn);
    this.pushNote(n.id);
    this.addActivity({
      sessionId: nn.session_id, taskId: nn.target_kind === 'task' ? nn.target_id : null, kind: 'note',
      summary: `Note ${n.id} re-queued`, at: ev.at,
    });
    return toNote(nn);
  }
  /** Start a task from the dashboard: a queued session note carrying the delegation prompt, task -> next. */
  hTaskStart(ev, autoReason = null) {
    const { id, sessionId, text } = ev.data;
    const t = this.getTask(id);
    if (!t) throw new Error('task not found');
    // Draft notes folded into the start text (v0.8): ran, via start, in this same event.
    for (const fid of Array.isArray(ev.data.noteIds) ? ev.data.noteIds : []) {
      const dn = this.getNote(fid);
      if (!dn || dn.state !== 'draft') continue;
      this.upd('notes', fid, { state: 'ran', ran_at: ev.at, via: 'start', error: null });
      this.indexNote(this.getNote(fid));
      this.pushNote(fid);
    }
    const nid = this.nextId('N');
    // T-70 Resume: a task-targeted note, so the mod spawns the follow-up builder itself (see register.ts runNote).
    const resume = ev.data.resume === true;
    this.db.run(
      `INSERT INTO notes(id, target_kind, target_id, session_id, text, state, created_at, queued_at, ran_at, via, error, sending_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL)`,
      nid, resume ? 'task' : 'session', resume ? id : sessionId, sessionId, text, ev.at, ev.at);
    this.indexNote(this.getNote(nid));
    this.pushNote(nid);
    this.addActivity({
      sessionId, taskId: id, kind: 'note', summary: `Note ${nid} queued: ${cut(text, 200)}`, at: ev.at,
    });
    this.setTaskStatus(t, 'next', ev.at, null);
    this.upd('tasks', id, { start_note_id: nid, auto_started_at: autoReason ? ev.at : null });
    if (autoReason) {
      this.addActivity({ sessionId, taskId: id, kind: 'status', summary: `Auto-started: ${cut(autoReason, 120)}`, at: ev.at });
    }
    this.indexTask(this.getTask(id));
    this.pushTask(id);
    return { note: toNote(this.getNote(nid)), task: toTask(this.getTask(id)) };
  }
  hNoteClaim(ev) {
    const out = [];
    for (const id of ev.data.ids) {
      const n = this.getNote(id);
      if (!n || n.state !== 'queued') continue;
      this.upd('notes', id, { state: 'sending', sending_at: ev.at });
      this.pushNote(id);
      out.push(toNote(this.getNote(id)));
    }
    return out;
  }
  hQuestionDismiss(ev) {
    const q = this.getQuestion(ev.data.id);
    if (!q) throw new Error('question not found');
    if (q.state === 'open') {
      this.db.run(`UPDATE questions SET state = 'answered', answered_at = ? WHERE id = ?`, ev.at, q.id);
      this.pushQuestion(q.id);
    }
    return toQuestion(this.getQuestion(q.id));
  }
  hJobCreate(ev) {
    const d = ev.data;
    const id = this.nextId('J');
    this.db.run(
      `INSERT INTO jobs(id, kind, session_id, task_id, project_id, state, input, result, error, created_at, claimed_at, done_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, NULL, NULL)`,
      id, d.kind, d.sessionId, d.taskId ?? null, d.projectId ?? null, JSON.stringify(d.input || {}), ev.at);
    this.noteJobState(id);
    this.pushJob(id);
    return toJob(this.getJob(id));
  }
  hJobClaim(ev) {
    const out = [];
    for (const id of ev.data.ids) {
      const j = this.getJob(id);
      if (!j || j.state !== 'queued') continue;
      this.upd('jobs', id, { state: 'running', claimed_at: ev.at });
      this.noteJobState(id);
      this.pushJob(id);
      out.push(toJob(this.getJob(id)));
    }
    return out;
  }
  /** hub.job.finish (v0.10): the hub ends a job it judged itself (wf_draft). */
  hJobFinish(ev) {
    const d = ev.data;
    const j = this.getJob(str(d.jobId));
    if (!j) return null;
    this.upd('jobs', j.id, {
      state: d.state === 'done' ? 'done' : 'failed', result: d.result == null ? null : str(d.result),
      error: d.state === 'done' ? null : cut(str(d.error) || 'job failed', 500), done_at: ev.at,
    });
    this.noteJobState(j.id);
    this.pushJob(j.id);
    return toJob(this.getJob(j.id));
  }
  hSweep(ev) {
    const d = ev.data, at = ev.at;
    for (const id of d.stall || []) {
      const a = this.getAgent(id);
      if (!a || a.status !== 'running') continue;
      this.upd('agents', id, { status: 'stalled' });
      this.pushAgent(id);
      this.addActivity({
        sessionId: a.session_id, agentId: id, taskId: a.task_id, kind: 'status',
        summary: 'Agent stalled: no activity for 5 min', ok: false, at,
      });
    }
    for (const b of d.block || []) {
      const t = this.getTask(b.taskId);
      if (!t || t.status !== 'in_progress') continue;
      this.setTaskStatus(t, 'blocked', at, STALL_REASON);
      this.pushTask(t.id);
      const a = this.getAgent(b.agentId);
      this.addActivity({
        sessionId: a?.session_id || t.session_id || HUB_SESSION, agentId: b.agentId, taskId: t.id, kind: 'status',
        summary: `Task blocked: ${STALL_REASON}`, ok: false, at,
      });
    }
    for (const id of d.sending || []) {
      const n = this.getNote(id);
      if (!n || n.state !== 'sending') continue;
      this.upd('notes', id, { state: 'failed', error: SENDING_TIMEOUT_ERROR });
      this.indexNote(this.getNote(id));
      this.pushNote(id);
      this.addActivity({
        sessionId: n.session_id || HUB_SESSION, taskId: n.target_kind === 'task' ? n.target_id : null, kind: 'note',
        summary: `Note ${id} failed: ${SENDING_TIMEOUT_ERROR}`, ok: false, at,
      });
      if (n.link_id) this.onLinkReply(n, `Not delivered: ${SENDING_TIMEOUT_ERROR}`, at);
    }
    for (const id of d.idle || []) {
      const s = this.getSession(id);
      if (!s || s.status !== 'active') continue;
      this.upd('sessions', id, { status: 'idle' });
      this.refreshHealth(id, at);
      this.pushSession(id);
    }
    for (const id of d.health || []) { // v0.14: time-driven health changes (long idle, new stalls, a new day)
      if (this.getSession(id) && this.refreshHealth(id, at)) this.pushSession(id);
    }
    for (const x of d.jobs || []) {
      const j = this.getJob(x.id);
      if (!j || (j.state !== 'queued' && j.state !== 'running')) continue;
      this.failJob(j, x.error, at);
    }
    if (d.conflicts) this.recomputeConflicts(at); // the 10-minute window moved
  }
}
