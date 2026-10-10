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
  activity: new Map(), // id -> Activity (bounded)
  seq: 0,
  conn: 'connecting', // connecting | live | reconnecting
  ready: false,
  ui: {
    projectId: lsGet('helm.project', 'all'),
    selectedTaskId: null,
    pendingNewTask: false,
  },
};

const ver = { project: 0, session: 0, agent: 0, task: 0, note: 0, question: 0, job: 0, digest: 0, activity: 0 };

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
export function upsert(entity, row) {
  if (!row || row.id == null) return;
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
    for (const row of s[KEYS[k]] || []) map.set(row.id, row);
    mark(k);
  }
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
  sessionWaiting(sid) { return sel.agentsOfSession(sid).some((a) => a.status === 'waiting'); },

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
