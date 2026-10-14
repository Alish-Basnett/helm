// T-76: recaps the hub makes sure exist. Two entry points share one decision:
//   * safetyNet(hub, now)   from the sweep: a task in review or done whose agent finished more than recapGraceMs ago and still has
//                           no recap gets one (derived from the stored final report, else a Haiku `recap` job).
//   * backfill(hub, opts)   POST /v1/recaps/backfill and `helmd --backfill-recaps`: the same, on demand, for every affected task.
// Everything is recorded as events (`recap.generated`, `hub.agent.report`, `hub.job.create`) so `helmd --rebuild` replays it.
import { recapFromReport, looksDegraded } from './recap.mjs';

const MAX_JOBS_PER_TASK = 3;
const SHOWN = ['review', 'done', 'in_progress', 'blocked'];

/** The input a Haiku recap job gets: the brief, what the agent did (tool trail), the files, how it ended. */
function jobInput(hub, t) {
  const rows = hub.db.all(`SELECT kind, summary FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT 60`, t.id).reverse();
  return {
    title: t.title, description: String(t.description || '').slice(0, 1500),
    filesChanged: JSON.parse(t.files_changed || '[]').slice(0, 40),
    tools: rows.filter((r) => r.kind === 'tool').map((r) => r.summary).slice(-30),
    notes: rows.filter((r) => r.kind !== 'tool' && r.kind !== 'tool_done' && r.kind !== 'recap').map((r) => r.summary).slice(-8),
  };
}
const hasTrail = (hub, t) => JSON.parse(t.files_changed || '[]').length > 0
  || !!hub.db.get(`SELECT 1 FROM activity WHERE task_id = ? AND kind = 'tool' LIMIT 1`, t.id);

/** The latest agent of a task that finished successfully, or undefined. */
function doneAgent(hub, taskId) {
  return hub.db.get(`SELECT * FROM agents WHERE task_id = ? AND status = 'done' ORDER BY COALESCE(ended_at, 0) DESC, rowid DESC LIMIT 1`, taskId);
}

function openJobs(hub, taskId) {
  return hub.db.get(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'recap' AND task_id = ? AND state IN ('queued','running')`, taskId).n;
}
function allJobs(hub, taskId) {
  return hub.db.get(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'recap' AND task_id = ?`, taskId).n;
}

/** Decide and (unless dryRun) record the recap for one task. Returns a result row. */
function handle(hub, t, { agent, report, provided, dryRun, at, auto }) {
  const parsed = report ? recapFromReport(report) : null;
  const base = { taskId: t.id, status: t.status, agentId: agent?.id ?? null };
  if (parsed) {
    const source = provided ? 'report:transcript' : 'report:stored';
    if (!dryRun) {
      hub.tx(() => {
        if (provided && agent && !agent.report) hub.command('hub.agent.report', { agentId: agent.id, report }, at);
        hub.command('recap.generated', { taskId: t.id, ...parsed, source: `${auto ? 'sweep' : 'backfill'}:${source}`, agentId: agent?.id ?? null }, at);
      });
    }
    return { ...base, source, recap: parsed };
  }
  if (openJobs(hub, t.id)) return { ...base, source: 'skipped', reason: 'a recap job is already queued' };
  if (allJobs(hub, t.id) >= MAX_JOBS_PER_TASK) return { ...base, source: 'skipped', reason: `${MAX_JOBS_PER_TASK} recap jobs already tried` };
  if (!hasTrail(hub, t)) return { ...base, source: 'skipped', reason: 'no stored report, activity or files to summarise' };
  if (dryRun) return { ...base, source: 'haiku-job', reason: report ? 'report has no DONE/LEARNED' : 'no stored report' };
  let sessionId;
  try { sessionId = hub.pickJobSession(t.session_id, t.project_id); } catch { return { ...base, source: 'skipped', reason: 'no live session to run the Haiku job' }; }
  const job = hub.tx(() => hub.command('hub.job.create', { kind: 'recap', sessionId, taskId: t.id, projectId: t.project_id, input: jobInput(hub, t) }, at));
  return { ...base, source: 'haiku-job', jobId: job.id, reason: report ? 'report has no DONE/LEARNED' : 'no stored report' };
}

/** From the sweep: tasks whose agent finished a while ago without a recap. Never throws. */
export function safetyNet(hub, now) {
  const out = [];
  try {
    const grace = hub.cfg.recapGraceMs;
    if (!(grace >= 0)) return out;
    // T-53: a parked (later / user-blocked) card keeps its status when its agent finishes, but still gets its recap.
    const tasks = hub.db.all(`SELECT * FROM tasks WHERE (status IN ('review','done') OR (status = 'later')
      OR (status = 'blocked' AND blocked_by = 'user')) AND recap IS NULL ORDER BY rowid`);
    for (const t of tasks) {
      const agent = doneAgent(hub, t.id);
      if (!agent || (t.status !== 'review' && t.status !== 'done' && t.agent_id !== agent.id)) continue;
      if (!agent || (agent.ended_at ?? now) + grace > now) continue;
      out.push(handle(hub, t, { agent, report: agent.report, at: now, auto: true }));
    }
  } catch (e) { hub.log?.warn('recap safety net failed', e); }
  return out;
}

/**
 * opts: { dryRun, improve (also replace recaps cut off by the old parser), taskIds, reports: { [agentId]: finalReportText } }
 * A report passed in `reports` is stored on the agent (hub.agent.report) when the agent has none, then parsed.
 */
export function backfill(hub, opts = {}) {
  const now = hub.now();
  const reports = opts.reports && typeof opts.reports === 'object' ? opts.reports : {};
  const only = Array.isArray(opts.taskIds) && opts.taskIds.length ? new Set(opts.taskIds) : null;
  const results = [];
  const tasks = hub.db.all(`SELECT * FROM tasks WHERE status IN (${SHOWN.map(() => '?').join(',')}) ORDER BY rowid`, ...SHOWN);
  for (const t of tasks) {
    if (only && !only.has(t.id)) continue;
    const recap = t.recap ? JSON.parse(t.recap) : null;
    if (recap && !(opts.improve && looksDegraded(recap))) continue;
    const agent = doneAgent(hub, t.id);
    if (!agent && (t.status === 'in_progress' || t.status === 'blocked')) continue; // still being worked on
    const provided = agent && typeof reports[agent.id] === 'string' && reports[agent.id].trim() ? reports[agent.id] : null;
    const report = provided || agent?.report || null;
    const r = handle(hub, t, { agent, report, provided: !!provided && !agent.report, dryRun: !!opts.dryRun, at: now });
    // An improvement that finds nothing better leaves the old recap alone.
    if (recap && r.source !== 'report:stored' && r.source !== 'report:transcript') continue;
    results.push({ ...r, replaced: !!recap });
  }
  const counts = {};
  for (const r of results) counts[r.source] = (counts[r.source] || 0) + 1;
  return { dryRun: !!opts.dryRun, counts, results };
}
