// boardfilter.js — the Board's filter bar: Project (multi-select) and Session (multi-select), plus "Show archived" and "Clear".
// The rule is pure (taskMatches) and unit-tested; the bar keeps its choice in the URL query (fp, fs, fa) and in localStorage.
import { h, setText, setHidden } from './dom.js';
import { icon } from './icons.js';
import { state, sel, lsGet, lsSet } from './store.js';
import { sessionLabel } from './format.js';

export const RULE_TEXT = 'A card matches when it belongs to a chosen project, and (if sessions are chosen) when its session, the session that created it, or the session of the agent assigned to or working on it is one of them.';
const STORE_KEY = 'helm.board.filter';
export const EMPTY = Object.freeze({ projects: [], sessions: [], archived: false });
const csv = (v) => (v ? String(v).split(',').filter(Boolean) : []);

export const isActive = (f) => f.projects.length > 0 || f.sessions.length > 0 || f.archived;

/** URL query -> filter, or null when the query holds no filter keys. */
export function filterFromQuery(q) {
  if (!q || !(q.has('fp') || q.has('fs') || q.has('fa'))) return null;
  return { projects: csv(q.get('fp')), sessions: csv(q.get('fs')), archived: q.get('fa') === '1' };
}
export function filterToQuery(f) {
  return { fp: f.projects.join(',') || null, fs: f.sessions.join(',') || null, fa: f.archived ? '1' : null };
}
export function loadFilter() {
  try { const o = JSON.parse(lsGet(STORE_KEY) || 'null'); if (o) return { projects: o.projects || [], sessions: o.sessions || [], archived: !!o.archived }; } catch { /* corrupt */ }
  return { ...EMPTY, projects: [], sessions: [] };
}
export function saveFilter(f) { lsSet(STORE_KEY, isActive(f) ? JSON.stringify(f) : null); }

/** Drop ids that no longer exist. cleared: something was chosen and nothing valid is left. */
export function pruneFilter(f, hasProject, hasSession) {
  const next = { ...f, projects: f.projects.filter(hasProject), sessions: f.sessions.filter(hasSession) };
  const changed = next.projects.length !== f.projects.length || next.sessions.length !== f.sessions.length;
  return { filter: next, changed, cleared: changed && !isActive(next) };
}

/**
 * ctx: { projectArchived(id) -> bool, sessionsOfTask(task) -> Set<sessionId> }.
 * Projects: the chosen ones, or every non-archived project (every project with "Show archived").
 */
export function taskMatches(task, f, ctx) {
  if (f.projects.length) { if (!f.projects.includes(task.projectId)) return false; }
  else if (!f.archived && ctx.projectArchived(task.projectId)) return false;
  if (f.sessions.length) {
    const have = ctx.sessionsOfTask(task);
    if (!f.sessions.some((id) => have.has(id))) return false;
  }
  return true;
}
/** Every session a card is tied to: its own, its creator's, and the sessions of the agents that worked on it. */
export function sessionIdsOfTask(task, agentsByTask, agentById) {
  const out = new Set();
  if (task.sessionId) out.add(task.sessionId);
  if (task.createdBySessionId) out.add(task.createdBySessionId);
  const a = task.agentId && agentById(task.agentId);
  if (a && a.sessionId) out.add(a.sessionId);
  for (const x of agentsByTask.get(task.id) || []) if (x.sessionId) out.add(x.sessionId);
  return out;
}
export function makeCtx() {
  const byTask = new Map();
  for (const a of state.agents.values()) if (a.taskId) (byTask.get(a.taskId) || byTask.set(a.taskId, []).get(a.taskId)).push(a);
  const memo = new Map();
  return {
    projectArchived: (id) => { const p = state.projects.get(id); return !!(p && p.archived); },
    sessionsOfTask: (t) => memo.get(t.id) || memo.set(t.id, sessionIdsOfTask(t, byTask, (id) => state.agents.get(id))).get(t.id),
  };
}
export function applyFilter(tasks, f) {
  if (!isActive(f)) { const ctx = makeCtx(); return tasks.filter((t) => !ctx.projectArchived(t.projectId)); }
  const ctx = makeCtx();
  return tasks.filter((t) => taskMatches(t, f, ctx));
}
/** Sessions to offer: those of the chosen projects (all non-archived ones if none chosen), live first. Chosen ones always stay in the list. */
export function sessionOptions(sessions, f, isArchived) {
  const live = (s) => (s.status === 'active' || s.status === 'idle' ? 0 : 1);
  return sessions.filter((s) => f.sessions.includes(s.id) || (f.projects.length ? f.projects.includes(s.projectId) : f.archived || !isArchived(s.projectId)))
    .sort((a, b) => live(a) - live(b) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
}

/* ---------- UI ---------- */
function multiSelect({ label, options, selected, onChange, emptyText }) {
  const btn = h('button', { class: 'bf-btn', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
  const pop = h('div', { class: 'bf-pop', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': label, hidden: true });
  const el = h('div', { class: 'bf-ms' }, btn, pop);
  let open = false;
  const close = (focus) => { open = false; setHidden(pop, true); btn.setAttribute('aria-expanded', 'false'); if (focus) btn.focus(); };
  const paintPop = () => {
    pop.textContent = '';
    const opts = options();
    if (!opts.length) pop.append(h('div', { class: 'bf-none' }, emptyText));
    const sels = new Set(selected());
    for (const o of opts) {
      const cb = h('input', { type: 'checkbox', checked: sels.has(o.id) });
      cb.addEventListener('change', () => { const cur = new Set(selected()); cb.checked ? cur.add(o.id) : cur.delete(o.id); onChange(Array.from(cur)); });
      pop.append(h('label', { class: 'bf-opt', role: 'option', 'aria-selected': String(sels.has(o.id)) }, cb, h('span', { class: ['bf-dot', o.live && 'live'] }), h('span', { class: 'bf-ol' }, o.label), o.sub ? h('span', { class: 'bf-os' }, o.sub) : null));
    }
  };
  btn.addEventListener('click', () => { open = !open; if (open) { paintPop(); setHidden(pop, false); btn.setAttribute('aria-expanded', 'true'); const f = pop.querySelector('input'); if (f) f.focus(); } else close(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(true); } });
  const onDoc = (e) => { if (open && !el.contains(e.target)) close(); };
  document.addEventListener('pointerdown', onDoc);
  return { el, btn, destroy() { document.removeEventListener('pointerdown', onDoc); } };
}

/** The bar. `onChange(filter)` runs after every change; the owner of the bar writes the URL (see board.js). */
export function createBoardFilter({ initial, onChange }) {
  let f = { projects: [...initial.projects], sessions: [...initial.sessions], archived: !!initial.archived };
  const set = (patch) => { f = { ...f, ...patch }; notice.hidden = true; paint(); onChange(f); };
  const projects = multiSelect({
    label: 'Project', emptyText: 'No projects',
    options: () => sel.projects(f.archived).map((p) => ({ id: p.id, label: p.name, sub: p.archived ? 'archived' : '' })),
    selected: () => f.projects, onChange: (ids) => set({ projects: ids, sessions: f.sessions.filter((sid) => { const s = state.sessions.get(sid); return !s || !ids.length || ids.includes(s.projectId); }) }),
  });
  const sessions = multiSelect({
    label: 'Session', emptyText: 'No sessions in these projects',
    options: () => sessionOptions(sel.allSessions().filter((x) => !sel.isOld(x) || f.sessions.includes(x.id)), f, (id) => { const p = state.projects.get(id); return !!(p && p.archived); })
      .map((s) => ({ id: s.id, label: sessionLabel(s), sub: s.status === 'ended' ? 'ended' : '', live: s.status === 'active' || s.status === 'idle' })),
    selected: () => f.sessions, onChange: (ids) => set({ sessions: ids }),
  });
  const arch = h('label', { class: 'bf-arch', title: 'Include projects that were archived' }, h('input', { type: 'checkbox', onchange: (e) => set({ archived: e.target.checked }) }), 'Show archived');
  const clear = h('button', { class: 'bf-clear', type: 'button', onclick: () => set({ projects: [], sessions: [], archived: false }) }, icon('close', 12), 'Clear');
  const info = h('span', { class: 'bf-info', title: RULE_TEXT, tabindex: '0', role: 'img', 'aria-label': `Filter rule. ${RULE_TEXT}` }, icon('question', 14));
  const notice = h('span', { class: 'bf-notice', role: 'status', hidden: true }, 'Filter cleared: those projects/sessions no longer exist');
  const el = h('div', { class: 'bf', role: 'group', 'aria-label': 'Board filters' }, projects.el, sessions.el, arch, clear, info, notice);
  function names(ids, nameOf) { return ids.length === 1 ? nameOf(ids[0]) : `${ids.length} chosen`; }
  function paint() {
    const setBtn = (ms, label, text, n) => { ms.btn.textContent = ''; ms.btn.append(h('span', { class: 'bf-k' }, label), h('span', { class: ['bf-v', n && 'on'] }, text), icon('chevronDown', 12)); };
    setBtn(projects, 'Project', f.projects.length ? names(f.projects, sel.projectName) : 'All', f.projects.length);
    setBtn(sessions, 'Session', f.sessions.length ? names(f.sessions, (id) => sessionLabel(state.sessions.get(id)) || id) : 'All', f.sessions.length);
    arch.firstChild.checked = f.archived;
    setHidden(clear, !isActive(f));
    projects.btn.setAttribute('aria-label', `Project filter: ${f.projects.length ? f.projects.map(sel.projectName).join(', ') : 'all non-archived'}`);
  }
  paint();
  return {
    el,
    get: () => f,
    /** Take a filter from outside (URL change). */
    setFilter(next) { f = { projects: [...next.projects], sessions: [...next.sessions], archived: !!next.archived }; paint(); },
    /** Once the store is ready: forget ids that no longer exist. Returns { changed }; the caller saves it and updates the URL. */
    prune() {
      const r = pruneFilter(f, (id) => state.projects.has(id), (id) => state.sessions.has(id));
      if (!r.changed) return r;
      f = r.filter;
      if (r.cleared) notice.hidden = false;
      paint();
      return r;
    },
    /** Names and options can change under the bar. */
    refresh: paint,
    destroy() { projects.destroy(); sessions.destroy(); el.remove(); },
  };
}
