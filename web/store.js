// store.js — in-memory entity store fed by /v1/state + SSE change messages.
import { api } from './api.js';
import { frameBatch } from './dom.js';
import { startOfToday } from './format.js';

export function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch { return fallback; }
}
export function lsSet(key, value) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

const KEYS = {
  project: 'projects', session: 'sessions', agent: 'agents', task: 'tasks', note: 'notes',
  question: 'questions', job: 'jobs', digest: 'digests', // v0.2 (missing keys from an older hub are treated as empty)
  workflow: 'workflows', run: 'runs', // v0.9
  template: 'templates', // v0.11
};

export const state = {
  projects: new Map(),
  sessions: new Map(),
  agents: new Map(),
  tasks: new Map(),
  notes: new Map(),
  questions: new Map(),
  jobs: new Map(),
  digests: new Map(),
  workflows: new Map(),
  runs: new Map(), // Run rows with `nodes` inlined
  templates: new Map(), // v0.11 task templates (archived ones included; selectors filter)
  activity: new Map(), // id -> Activity (bounded)
  usageToday: { overheadUsd: 0, requestedUsd: 0 }, // v0.4 Helm overhead meter
  seq: 0,
  conn: 'connecting', // connecting | live | reconnecting
  ready: false,
  ui: {
    projectId: lsGet('helm.project', 'all'),
    selectedTaskId: null,
    pendingNewTask: false,
  },
};

const ver = { project: 0, session: 0, agent: 0, task: 0, note: 0, question: 0, job: 0, digest: 0, workflow: 0, run: 0, template: 0, activity: 0, usage: 0 };

/* ---------- subscriptions ---------- */
const listeners = new Set();
const activityListeners = new Set();
let dirty = new Set();
const flush = frameBatch(() => {
  const changed = dirty;
  dirty = new Set();
  for (const fn of Array.from(listeners)) {
    try { fn(changed); } catch (e) { console.error('[helm] listener failed', e); }
  }
});
function mark(key) { dirty.add(key); ver[key] !== undefined && ver[key]++; flush(); }

/** Subscribe to batched change sets (Set of entity names, plus 'ui' and 'conn'). */
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Subscribe to every new live Activity row as it arrives (not history loads). */
export function onActivity(fn) { activityListeners.add(fn); return () => activityListeners.delete(fn); }

/* ---------- mutation ---------- */
/** v0.3 fields default to null so the UI works against a hub that predates them. */
export function normalizeRow(entity, row) {
  if (!row) return row;
  if (entity === 'note') {
    if (row.reply === undefined) row.reply = null;
    if (row.repliedAt === undefined) row.repliedAt = null;
    if (!Array.isArray(row.attachments)) row.attachments = []; // v0.4
  } else if (entity === 'task') {
    if (row.startNoteId === undefined) row.startNoteId = null;
    if (!Array.isArray(row.choices)) row.choices = []; // v0.6 Choices
    if (row.parentTaskId === undefined) row.parentTaskId = null;
    if (row.autoStartedAt === undefined) row.autoStartedAt = null; // v0.7
  } else if (entity === 'project') {
    if (row.autoStart === undefined) row.autoStart = false; // v0.7 Up next auto mode
  } else if (entity === 'run') {
    if (!Array.isArray(row.nodes)) row.nodes = []; // v0.9
  } else if (entity === 'workflow') {
    if (row.archived === undefined) row.archived = false;
  } else if (entity === 'template') {
    if (!Array.isArray(row.checks)) row.checks = []; // v0.11
    if (!Array.isArray(row.tags)) row.tags = [];
    if (!row.agent) row.agent = 'auto';
    if (row.projectId === undefined) row.projectId = null;
    if (!row.usage) row.usage = 0;
    if (row.lastUsedAt === undefined) row.lastUsedAt = null;
    if (row.archived === undefined) row.archived = false;
  }
  if (entity === 'task') {
    if (row.runId === undefined) row.runId = null; // v0.9: a workflow run made this card
    if (row.nodeId === undefined) row.nodeId = null;
  }
  return row;
}

/** v0.4: the SSE `usage` row IS the new usageToday (no id). Missing numbers count as 0. */
export function setUsageToday(u) {
  state.usageToday = { overheadUsd: Number(u && u.overheadUsd) || 0, requestedUsd: Number(u && u.requestedUsd) || 0 };
  mark('usage');
}

export function upsert(entity, row) {
  if (entity === 'usage') { setUsageToday(row); return; }
  if (!row || row.id == null) return;
  normalizeRow(entity, row);
  if (entity === 'activity') { ingestActivity([row], true); return; }
  const map = state[KEYS[entity]];
  if (!map) return;
  map.set(row.id, row);
  mark(entity);
}
export function remove(entity, id) {
  const map = state[KEYS[entity]];
  if (!map || !map.has(id)) return;
  map.delete(id);
  mark(entity);
}

export function ingestActivity(rows, live = false) {
  let added = false;
  for (const a of rows) {
    if (a == null || a.id == null) continue;
    const isNew = !state.activity.has(a.id);
    state.activity.set(a.id, a);
    if (isNew) {
      added = true;
      if (live) for (const fn of Array.from(activityListeners)) { try { fn(a); } catch (e) { console.error(e); } }
    }
  }
  if (state.activity.size > 5000) {
    let drop = state.activity.size - 4000;
    for (const k of state.activity.keys()) { if (drop-- <= 0) break; state.activity.delete(k); }
  }
  if (added) mark('activity');
}

export function setUI(patch) {
  Object.assign(state.ui, patch);
  if ('projectId' in patch) lsSet('helm.project', patch.projectId);
  mark('ui');
}

function setConn(c) {
  if (state.conn !== c) { state.conn = c; mark('conn'); }
}

function replaceAll(s) {
  for (const k in KEYS) {
    const map = state[KEYS[k]];
    map.clear();
    for (const row of s[KEYS[k]] || []) map.set(row.id, normalizeRow(k, row));
    mark(k);
  }
  setUsageToday(s.usageToday);
  state.seq = s.seq || 0;
  state.ready = true;
  mark('ready');
  // If the persisted project no longer exists, fall back to all.
  if (state.ui.projectId !== 'all' && !state.projects.has(state.ui.projectId)) setUI({ projectId: 'all' });
}

export function applyChange(msg) {
  if (!msg || !msg.entity) return;
  if (msg.entity === 'activity') {
    if (msg.op !== 'delete') ingestActivity([msg.row], true);
    return;
  }
  if (msg.entity === 'usage') { if (msg.op !== 'delete') setUsageToday(msg.row); return; }
  if (msg.op === 'delete') remove(msg.entity, msg.row && msg.row.id);
  else upsert(msg.entity, msg.row);
}

/* ---------- selectors ---------- */
const memo = new Map();
function memoize(name, deps, fn) {
  const sig = deps.map((d) => ver[d]).join(',');
  const hit = memo.get(name);
  if (hit && hit.sig === sig) return hit.val;
  const val = fn();
  memo.set(name, { sig, val });
  return val;
}

const byCreated = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);

export const sel = {
  projects(includeArchived = false) {
    return Array.from(state.projects.values()).filter((p) => includeArchived || !p.archived).sort(byCreated);
  },
  project: (id) => state.projects.get(id),
  projectName: (id) => (state.projects.get(id) || {}).name || '—',
  inScope(row) { return state.ui.projectId === 'all' || row.projectId === state.ui.projectId; },
  scopeProject() { return state.ui.projectId === 'all' ? null : state.projects.get(state.ui.projectId) || null; },
  sessions() {
    return Array.from(state.sessions.values());
  },
  scopedSessions() {
    return sel.sessions().filter(sel.inScope);
  },
  agentsOfSession(sid) {
    const idx = memoize('agentsBySession', ['agent'], () => {
      const m = new Map();
      for (const a of state.agents.values()) {
        if (!m.has(a.sessionId)) m.set(a.sessionId, []);
        m.get(a.sessionId).push(a);
      }
      for (const arr of m.values()) arr.sort((x, y) => x.startedAt - y.startedAt);
      return m;
    });
    return idx.get(sid) || [];
  },
  agentOfTask(task) { return task && task.agentId ? state.agents.get(task.agentId) || null : null; },
  taskAgents(taskId) {
    return Array.from(state.agents.values()).filter((a) => a.taskId === taskId);
  },
  scopedTasks() {
    return Array.from(state.tasks.values()).filter((t) => sel.inScope(t) && t.status !== 'archived');
  },
  /** v0.12: tasks waiting in Review (unsorted; review.js orders them). */
  reviewTasks(scoped = true) {
    return Array.from(state.tasks.values()).filter((t) => t.status === 'review' && !String(t.id).startsWith('tmp-') && (!scoped || sel.inScope(t)));
  },
  tasksOfProject(pid) {
    return Array.from(state.tasks.values()).filter((t) => t.projectId === pid && t.status !== 'archived');
  },
  notesFor(kind, id) {
    return Array.from(state.notes.values())
      .filter((n) => n.target && n.target.kind === kind && n.target.id === id)
      .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  },
  activityRows(pred) {
    const out = [];
    for (const a of state.activity.values()) if (pred(a)) out.push(a);
    return out.sort((a, b) => a.id - b.id);
  },
  activityForTask(task) {
    const agent = sel.agentOfTask(task);
    return sel.activityRows((a) => a.taskId === task.id || (agent && a.agentId === agent.id));
  },
  activityForAgent(agent) {
    return sel.activityRows((a) => a.agentId === agent.id || (agent.taskId && a.taskId === agent.taskId && a.sessionId === agent.sessionId));
  },
  activityForSession(sid) {
    return sel.activityRows((a) => a.sessionId === sid);
  },
  selectedTask() { return state.ui.selectedTaskId ? state.tasks.get(state.ui.selectedTaskId) : null; },

  /* ----- v0.6: choices (tick-to-run checklists) ----- */
  openChoiceCount(t) { return t && Array.isArray(t.choices) ? t.choices.filter((c) => c.state === 'open').length : 0; },
  /** Tasks with at least one open choice, newest activity first. */
  choiceTasks(scoped = true) {
    return Array.from(state.tasks.values())
      .filter((t) => !String(t.id).startsWith('tmp-') && sel.openChoiceCount(t) > 0 && (!scoped || sel.inScope(t)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },

  /* ----- v0.2: questions inbox ----- */
  questionProject(q) { const s = state.sessions.get(q.sessionId); return s ? s.projectId : null; },
  questionInScope(q) { return state.ui.projectId === 'all' || sel.questionProject(q) === state.ui.projectId; },
  /** Open questions, newest first. */
  openQuestions(scoped = true) {
    return Array.from(state.questions.values())
      .filter((q) => q.state === 'open' && (!scoped || sel.questionInScope(q)))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  },
  answeredQuestions(scoped = true) {
    return Array.from(state.questions.values())
      .filter((q) => q.state === 'answered' && (!scoped || sel.questionInScope(q)))
      .sort((a, b) => (b.answeredAt || b.createdAt || 0) - (a.answeredAt || a.createdAt || 0));
  },
  openQuestionForAgent(agentId) {
    if (!agentId) return null;
    let best = null;
    for (const q of state.questions.values()) {
      if (q.state === 'open' && q.agentId === agentId && (!best || q.createdAt > best.createdAt)) best = q;
    }
    return best;
  },
  /**
   * Why a task is waiting on the user: [{key, label}] in priority order, or [] when nothing is.
   * Same sources as the Inbox (open choices, open questions, waiting agents) plus failed notes and review.
   */
  needsYou(task) {
    if (!task || task.status === 'done' || task.status === 'archived' || String(task.id).startsWith('tmp-')) return [];
    const out = [];
    const add = (key, label) => { if (!out.some((r) => r.key === key)) out.push({ key, label }); };
    const nc = sel.openChoiceCount(task);
    if (nc) add('choices', nc === 1 ? '1 choice' : `${nc} choices`);
    const agent = sel.agentOfTask(task);
    for (const q of state.questions.values()) {
      if (q.state !== 'open' || q.kind === 'approval') continue; // a gate is shown as `gate` below
      if (q.taskId === task.id || (agent && q.agentId === agent.id)) add(q.kind === 'waiting' ? 'waiting' : 'question', q.kind === 'waiting' ? 'Waiting for you' : 'Question');
    }
    if (agent && agent.status === 'waiting') add('waiting', 'Waiting for you');
    for (const n of state.notes.values()) {
      if (n.state === 'failed' && n.target && n.target.kind === 'task' && n.target.id === task.id) { add('note', 'Note failed'); break; }
    }
    // v0.7: the hub's auto-start of this task failed (its start note failed); it retries after a 5 minute back-off
    if (task.status === 'next' && task.autoStartedAt) {
      const sn = task.startNoteId && state.notes.get(task.startNoteId);
      if (sn && sn.state === 'failed') add('autostart', 'Auto-start failed');
    }
    // v0.9: a workflow gate waiting for a decision (its card sits in Review with an Approve button)
    if (sel.gateOfTask(task)) add('gate', 'Approval needed');
    else if (task.status === 'review') add('review', 'Review');
    return out;
  },
  /* ----- v0.9: workflows + runs ----- */
  workflows(includeArchived = false) {
    return Array.from(state.workflows.values()).filter((w) => includeArchived || !w.archived)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  },
  scopedWorkflows(includeArchived = false) { return sel.workflows(includeArchived).filter(sel.inScope); },
  /** Runs of one workflow, newest first. */
  runsOf(workflowId) {
    return Array.from(state.runs.values()).filter((r) => r.workflowId === workflowId)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || String(b.id).localeCompare(String(a.id), undefined, { numeric: true }));
  },
  activeRuns(scoped = true) {
    return Array.from(state.runs.values()).filter((r) => ['running', 'waiting', 'paused'].includes(r.status) && (!scoped || sel.inScope(r)));
  },
  runOfTask(task) { return task && task.runId ? state.runs.get(task.runId) || null : null; },
  /** { run, node } when this card is the card of a gate that is waiting for a decision, else null. */
  gateOfTask(task) {
    const run = sel.runOfTask(task);
    if (!run || run.status === 'done' || run.status === 'failed' || run.status === 'aborted') return null;
    const node = run.nodes.find((n) => n.nodeId === task.nodeId && n.state === 'waiting_gate');
    return node ? { run, node } : null;
  },
  sessionWaiting(sid) { return sel.agentsOfSession(sid).some((a) => a.status === 'waiting'); },

  /* ----- v0.11: task templates ----- */
  /** Live templates visible in the current scope (global ones plus the selected project's), most used first, then most recent. */
  templates({ scoped = true, includeArchived = false } = {}) {
    const pid = state.ui.projectId;
    return Array.from(state.templates.values())
      .filter((t) => (includeArchived || !t.archived) && (!scoped || pid === 'all' || t.projectId == null || t.projectId === pid))
      .sort((a, b) => (b.usage || 0) - (a.usage || 0) || (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0)
        || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  },

  /* ----- v0.2: jobs + digests ----- */
  /** Freshest known view of a task's explain job: the jobs map beats the (possibly older) task.explainJob stub. */
  explainJob(task) {
    const j = task && task.explainJob;
    if (!j) return null;
    return { ...j, ...(state.jobs.get(j.id) || {}) };
  },
  /** Newest digest job for a scope (projectId or null = all). */
  digestJob(projectId) {
    let best = null;
    for (const j of state.jobs.values()) {
      if (j.kind !== 'digest' || (j.projectId || null) !== (projectId || null)) continue;
      if (!best || (j.createdAt || 0) > (best.createdAt || 0)) best = j;
    }
    return best;
  },
  /** Digests for a scope, newest date first. Scope 'all' prefers the all-projects digests, falling back to everything. */
  digestsFor(projectId) {
    const all = Array.from(state.digests.values());
    let list = projectId && projectId !== 'all' ? all.filter((d) => d.projectId === projectId) : all.filter((d) => !d.projectId);
    if (!list.length && (!projectId || projectId === 'all')) list = all;
    return list.sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0));
  },
  /* ----- v0.3: Talk ----- */
  /** Sessions you can talk to: active and idle, in the current project scope, most recently seen first. */
  talkSessions() {
    return sel.scopedSessions().filter((x) => x.status === 'active' || x.status === 'idle')
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  },
  telemetry() {
    const sessions = sel.sessions();
    const today = startOfToday();
    let active = 0, tokens = 0, agents = 0, cost = 0;
    for (const s of sessions) {
      if (s.status === 'active') active++;
      if ((s.lastSeenAt || 0) >= today) { tokens += s.tokens || 0; cost += Number(s.costUsd) || 0; }
    }
    for (const a of state.agents.values()) if (a.status === 'running') agents++;
    return { active, agents, tokens, cost };
  },
};

/* ---------- connection: state + SSE ---------- */
let es = null;
let retry = 0;
let retryTimer = null;
let syncing = false;
let buffer = [];
let synced = false;
let lastSync = 0;

async function resync() {
  syncing = true;
  synced = false;
  buffer = [];
  try {
    const s = await api.state();
    replaceAll(s);
    lastSync = Date.now();
    synced = true;
    const pending = buffer;
    buffer = [];
    for (const m of pending) if (!m.id || m.id > state.seq) applyAndAdvance(m);
    return true;
  } finally {
    syncing = false;
  }
}

function applyAndAdvance(m) {
  applyChange(m);
  if (m.id && m.id > state.seq) state.seq = m.id;
}

function scheduleReconnect() {
  if (retryTimer) return;
  setConn('reconnecting');
  const delay = Math.min(15000, 500 * 2 ** retry) * (0.8 + Math.random() * 0.4);
  retry++;
  retryTimer = setTimeout(() => { retryTimer = null; openStream(); }, delay);
}

function openStream() {
  if (es) { try { es.close(); } catch { /* noop */ } es = null; }
  let source;
  try { source = new EventSource('/v1/stream'); } catch { scheduleReconnect(); return; }
  es = source;
  source.addEventListener('open', async () => {
    try {
      await resync();
      retry = 0;
      setConn('live');
    } catch {
      try { source.close(); } catch { /* noop */ }
      scheduleReconnect();
    }
  });
  source.addEventListener('change', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    msg.id = Number(e.lastEventId) || 0;
    if (!synced) { buffer.push(msg); return; }
    if (msg.id && msg.id <= state.seq) return;
    applyAndAdvance(msg);
  });
  source.addEventListener('reset', async () => {
    try { await resync(); setConn('live'); } catch { try { source.close(); } catch { /* noop */ } scheduleReconnect(); }
  });
  source.addEventListener('error', () => {
    try { source.close(); } catch { /* noop */ }
    if (es === source) es = null;
    scheduleReconnect();
  });
}

export async function connect() {
  // Fast first paint over REST, then attach the live stream (which resyncs on open).
  try { await resync(); lastSync = Date.now(); } catch { /* stream open will retry */ }
  openStream();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !syncing && Date.now() - lastSync > 30000 && state.conn === 'live') {
      resync().catch(() => {});
    }
  });
}

/** Force a refetch (used after errors where local state may be stale). */
export function refresh() { return resync().catch(() => {}); }
