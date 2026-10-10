// todaymodel.js — pure data model for the Today (day Gantt) view. No DOM: everything here takes plain rows and returns
// plain objects, so it can be unit-tested and reused. Times are epoch ms.
import { modelInfo } from './format.js';

export const LIVE_STATUSES = new Set(['running', 'waiting', 'stalled']);
export const isLiveAgent = (a) => LIVE_STATUSES.has(a.status);
export const MAIN_GAP_MS = 90e3;   // main-session tool calls closer than this belong to one busy span
export const BUSY_STALE_MS = 5 * 60e3;

/** Local midnight of the day containing `t`. */
export function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
/** Local midnight after `dayStart` (DST-safe: 23h and 25h days come out right). */
export function nextDay(dayStart) { const d = new Date(dayStart); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d.getTime(); }
export function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
/** "2026-10-09" → local midnight, or null when malformed. */
export function parseDayKey(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
  return Number.isNaN(d.getTime()) || dayKey(d.getTime()) !== s ? null : d.getTime();
}

/** Where an agent's bar runs: startedAt .. now while live, else endedAt (or its last activity). */
export function agentSpan(a, now) {
  const live = isLiveAgent(a);
  const t0 = a.startedAt || 0;
  const t1 = live ? Math.max(now, t0) : Math.max(t0, a.endedAt || a.lastActivityAt || t0);
  return { t0, t1, live };
}

/**
 * Peak concurrency over [{t0, t1}] intervals: the most that overlap at once, when it first happens and until when.
 * Intervals are half-open, so one that ends at the instant another starts does not overlap it. Zero-length ones count as 1 ms.
 */
export function peakConcurrency(intervals) {
  const ev = [];
  for (const iv of intervals) {
    const t1 = Math.max(iv.t1, iv.t0 + 1);
    ev.push([iv.t0, 1], [t1, -1]);
  }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // at the same instant, ends (-1) before starts (+1)
  let cur = 0, peak = 0, at = null, until = null;
  for (let i = 0; i < ev.length; i++) {
    cur += ev[i][1];
    if (cur > peak) { peak = cur; at = ev[i][0]; until = null; }
    else if (cur < peak && at !== null && until === null && ev[i][1] < 0 && cur === peak - 1) until = ev[i][0];
  }
  if (peak > 0 && until === null) until = at;
  return { peak, at, until };
}

/**
 * Summarise agents (already reduced to {id, model, taskId, t0, t1}) over the window [a, b]: counts by model, summed agent time
 * clipped to the window, peak concurrency, tasks done (timestamps in `doneAt`) and the longest task.
 */
export function summarize({ agents, doneAt = [], a, b }) {
  const inWin = [];
  for (const g of agents) {
    if (g.t1 < a || g.t0 > b) continue;
    inWin.push({ ...g, c0: Math.max(g.t0, a), c1: Math.min(g.t1, b) });
  }
  const byModel = {};
  let ms = 0;
  const perTask = new Map();
  for (const g of inWin) {
    const k = modelInfo(g.model).key;
    byModel[k] = (byModel[k] || 0) + 1;
    const d = g.c1 - g.c0;
    ms += d;
    const key = g.taskId || `agent:${g.id}`;
    const e = perTask.get(key) || { taskId: g.taskId || null, agentId: g.id, ms: 0 };
    e.ms += d;
    perTask.set(key, e);
  }
  let longest = null;
  for (const e of perTask.values()) if (!longest || e.ms > longest.ms) longest = e;
  const pk = peakConcurrency(inWin.map((g) => ({ t0: g.c0, t1: g.c1 })));
  const tasksDone = doneAt.filter((t) => t >= a && t <= b).length;
  return { count: inWin.length, byModel, ms, peak: pk.peak, peakAt: pk.at, peakUntil: pk.until, tasksDone, longest };
}

/** Busy spans of the main session from its own (agentless) tool calls; the last one runs to `now` while the session is busy. */
export function mainSpans(rows, session, a, b, now, gap = MAIN_GAP_MS) {
  const ts = [];
  for (const r of rows) {
    if (r.agentId || (r.kind !== 'tool' && r.kind !== 'tool_done') || r.at < a || r.at >= b) continue;
    ts.push(r.at);
  }
  ts.sort((x, y) => x - y);
  const out = [];
  for (const t of ts) {
    const last = out[out.length - 1];
    if (last && t - last.t1 <= gap) last.t1 = t;
    else out.push({ t0: t, t1: t });
  }
  if (session && session.busy && now >= a && now < b) {
    const last = out[out.length - 1];
    if (last && now - last.t1 <= BUSY_STALE_MS) last.t1 = now;
  }
  return out;
}

const RE_FINISHED = /^Agent finished/;
const RE_BLOCKED = /^(Task blocked|Agent failed)/;
const RE_AUTO = /^Auto-started/;

/** Task event markers inside [a, b): done (task.doneAt), review / blocked / auto-start (from activity). Sorted by time. */
export function taskMarkers({ tasks, activity, a, b }) {
  const out = [];
  for (const t of tasks) {
    if (t.doneAt && t.doneAt >= a && t.doneAt < b) out.push({ t: t.doneAt, kind: 'done', taskId: t.id, key: `d:${t.id}` });
  }
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  for (const r of activity) {
    if (r.kind !== 'status' || !r.taskId || r.at < a || r.at >= b) continue;
    const task = taskById.get(r.taskId);
    if (!task) continue;
    let kind = null;
    if (RE_AUTO.test(r.summary)) kind = 'auto';
    else if (RE_BLOCKED.test(r.summary) || (RE_FINISHED.test(r.summary) && r.ok === false)) kind = 'blocked';
    else if (RE_FINISHED.test(r.summary) && r.ok !== false && !task.runId) kind = 'review';
    if (kind) out.push({ t: r.at, kind, taskId: r.taskId, key: `${kind}:${r.id}` });
  }
  return out.sort((x, y) => x.t - y.t || (x.key < y.key ? -1 : 1));
}

/**
 * Everything the view draws for one day.
 * in: { dayStart, now, sessions, agents, tasks, runs, workflows?, activity }; every list is already scope-filtered by the caller.
 */
export function buildDay({ dayStart, now, sessions, agents, tasks, runs, activity }) {
  const dayEnd = nextDay(dayStart);
  const winEnd = Math.min(dayEnd, Math.max(now, dayStart));         // nothing has happened after "now"
  const isToday = now >= dayStart && now < dayEnd;
  const sessById = new Map(sessions.map((s) => [s.id, s]));
  const actBySession = new Map();
  for (const r of activity) {
    if (!actBySession.has(r.sessionId)) actBySession.set(r.sessionId, []);
    actBySession.get(r.sessionId).push(r);
  }

  const items = []; // flat reduced agents for the summary
  const bySession = new Map();
  for (const a of agents) {
    const s = sessById.get(a.sessionId);
    if (!s) continue;
    const sp = agentSpan(a, now);
    if (sp.t1 < dayStart || sp.t0 >= dayEnd) continue;
    const row = { agent: a, t0: sp.t0, t1: sp.t1, live: sp.live };
    items.push({ id: a.id, model: a.model, taskId: a.taskId, t0: sp.t0, t1: sp.t1 });
    if (!bySession.has(s.id)) bySession.set(s.id, []);
    bySession.get(s.id).push(row);
  }

  const groups = [];
  for (const s of sessions) {
    const rows = (bySession.get(s.id) || []).sort((x, y) => x.t0 - y.t0 || (x.agent.id < y.agent.id ? -1 : 1));
    const spans = mainSpans(actBySession.get(s.id) || [], s, dayStart, dayEnd, now);
    const seenToday = (s.lastSeenAt || 0) >= dayStart && (s.startedAt || 0) < dayEnd;
    const showEmpty = isToday && s.status === 'active';
    if (!rows.length && !spans.length && !showEmpty && !(seenToday && s.status === 'active')) continue;
    groups.push({ session: s, rows, spans, last: rows.length ? Math.max(...rows.map((r) => r.t1)) : (s.lastSeenAt || 0) });
  }
  groups.sort((x, y) => (y.last - x.last) || (x.session.id < y.session.id ? -1 : 1));

  const runRows = [];
  for (const r of runs) {
    const t0 = r.startedAt || 0;
    const live = ['running', 'waiting', 'paused'].includes(r.status);
    const t1 = live ? Math.max(now, t0) : Math.max(t0, r.endedAt || t0);
    if (t1 < dayStart || t0 >= dayEnd) continue;
    const nodes = (r.nodes || []).filter((n) => n.startedAt || n.endedAt).map((n) => ({
      node: n, t0: n.startedAt || n.endedAt, t1: n.endedAt || (n.state === 'running' ? now : n.startedAt),
    }));
    runRows.push({ run: r, t0, t1, live, nodes });
  }
  runRows.sort((x, y) => x.t0 - y.t0);

  const doneAt = tasks.filter((t) => t.doneAt && t.doneAt >= dayStart && t.doneAt < dayEnd).map((t) => t.doneAt);
  const markers = taskMarkers({ tasks, activity, a: dayStart, b: dayEnd });
  const summary = summarize({ agents: items, doneAt, a: dayStart, b: dayEnd });

  let first = Infinity, last = -Infinity, live = false;
  const take = (t0, t1, lv) => { if (t0 < first) first = t0; if (t1 > last) last = t1; if (lv) live = true; };
  for (const g of groups) {
    for (const r of g.rows) take(Math.max(r.t0, dayStart), Math.min(r.t1, dayEnd), r.live);
    for (const sp of g.spans) take(sp.t0, sp.t1, false);
  }
  for (const r of runRows) take(Math.max(r.t0, dayStart), Math.min(r.t1, dayEnd), r.live);
  for (const m of markers) take(m.t, m.t, false);
  return {
    dayStart, dayEnd, now, isToday, groups, runRows, markers, summary, items,
    range: Number.isFinite(first) ? { first, last } : null, live,
    agentCount: items.length,
  };
}
