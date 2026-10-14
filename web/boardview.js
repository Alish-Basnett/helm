// boardview.js — the board's "View" model (v0.22): group by, filters, sort and saved views. Pure functions only (no DOM,
// no store), so node can test them. board.js owns the rendering and the persistence.
//
//   view = { group: 'status'|'project'|'agent'|'none', sort: 'manual'|'newest'|'updated',
//            projects: [id…], statuses: [status…], hasAgent: bool, needs: bool }
//   An empty `projects` / `statuses` list means "no restriction".

export const GROUPS = [
  { key: 'status', label: 'Status', hint: 'Kanban columns' },
  { key: 'project', label: 'Project', hint: 'One lane per project' },
  { key: 'agent', label: 'Agent', hint: 'One lane per model' },
  { key: 'none', label: 'None', hint: 'A flat list' },
];
export const SORTS = [
  { key: 'manual', label: 'Manual' },
  { key: 'newest', label: 'Newest' },
  { key: 'updated', label: 'Updated' },
];
const GROUP_KEYS = new Set(GROUPS.map((g) => g.key));
const SORT_KEYS = new Set(SORTS.map((s) => s.key));

export const defaultView = () => ({ group: 'status', sort: 'manual', projects: [], statuses: [], hasAgent: false, needs: false });

const strList = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))] : []);

/** Whatever came out of localStorage -> a valid view. Unknown groups / sorts fall back to the defaults. */
export function normalizeView(v) {
  const d = defaultView();
  if (!v || typeof v !== 'object') return d;
  return {
    group: GROUP_KEYS.has(v.group) ? v.group : d.group,
    sort: SORT_KEYS.has(v.sort) ? v.sort : d.sort,
    projects: strList(v.projects),
    statuses: strList(v.statuses),
    hasAgent: v.hasAgent === true,
    needs: v.needs === true,
  };
}

const sameList = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
export function viewsEqual(a, b) {
  a = normalizeView(a); b = normalizeView(b);
  return a.group === b.group && a.sort === b.sort && a.hasAgent === b.hasAgent && a.needs === b.needs
    && sameList(a.projects, b.projects) && sameList(a.statuses, b.statuses);
}
export const isDefaultView = (v) => viewsEqual(v, defaultView());

/** How many filters are active (group and sort do not count). */
export function activeFilterCount(v) {
  v = normalizeView(v);
  return (v.projects.length ? 1 : 0) + (v.statuses.length ? 1 : 0) + (v.hasAgent ? 1 : 0) + (v.needs ? 1 : 0);
}

/**
 * Apply the filter chips. ctx.needs(task) -> bool, ctx.agent(task) -> agent | null.
 * Returns a new array; the input is untouched.
 */
export function filterTasks(tasks, view, ctx = {}) {
  const v = normalizeView(view);
  const projects = v.projects.length ? new Set(v.projects) : null;
  const statuses = v.statuses.length ? new Set(v.statuses) : null;
  return tasks.filter((t) => {
    if (projects && !projects.has(t.projectId)) return false;
    if (statuses && !statuses.has(t.status)) return false;
    if (v.hasAgent && !(ctx.agent && ctx.agent(t))) return false;
    if (v.needs && !(ctx.needs && ctx.needs(t))) return false;
    return true;
  });
}

/**
 * Sort a copy of `tasks`. Cards waiting for you always come first (they are the point of the board), then the chosen
 * order: manual = `manualCmp`, newest = createdAt descending, updated = updatedAt descending. Ties fall back to manualCmp.
 */
export function sortTasks(tasks, sort, manualCmp, ctx = {}) {
  const needs = new Map(tasks.map((t) => [t.id, ctx.needs ? (ctx.needs(t) ? 1 : 0) : 0]));
  const key = sort === 'newest' ? (t) => t.createdAt || 0 : sort === 'updated' ? (t) => t.updatedAt || 0 : null;
  return tasks.slice().sort((a, b) => (needs.get(b.id) - needs.get(a.id))
    || (key ? key(b) - key(a) : 0)
    || manualCmp(a, b));
}

/** The lane a task sits in for a grouping, as { key, label, order }. Status grouping has no lanes (null). */
export function laneOf(task, group, ctx = {}) {
  if (group === 'project') {
    const name = ctx.projectName ? ctx.projectName(task.projectId) : task.projectId;
    return { key: `p:${task.projectId}`, label: name || task.projectId || 'No project', order: 0, sortName: String(name || '') };
  }
  if (group === 'agent') {
    const a = ctx.agent ? ctx.agent(task) : null;
    if (!a) return { key: 'a:none', label: 'No agent', order: 9, sortName: '' };
    const info = ctx.model ? ctx.model(a) : { key: 'other', label: 'Agent' };
    const rank = { opus: 0, sonnet: 1, haiku: 2 }[info.key];
    return { key: `a:${info.key === 'other' ? info.label : info.key}`, label: info.label, order: rank == null ? 3 : rank, sortName: info.label };
  }
  if (group === 'none') return { key: 'all', label: 'All tasks', order: 0, sortName: '' };
  return null;
}

/**
 * Split tasks into lanes: [{ key, label, tasks }]. `none` is one lane. Lanes with no tasks are left out, so a filter
 * never leaves a row of empty swimlanes. `projectOrder` (ids) keeps project lanes in the sidebar order.
 */
export function groupTasks(tasks, group, ctx = {}) {
  if (group !== 'project' && group !== 'agent' && group !== 'none') return [{ key: '*', label: 'All', tasks: tasks.slice() }];
  const lanes = new Map();
  for (const t of tasks) {
    const l = laneOf(t, group, ctx);
    if (!lanes.has(l.key)) lanes.set(l.key, { key: l.key, label: l.label, order: l.order, sortName: l.sortName, tasks: [] });
    lanes.get(l.key).tasks.push(t);
  }
  const rank = new Map((ctx.projectOrder || []).map((id, i) => [`p:${id}`, i]));
  return Array.from(lanes.values()).sort((a, b) => (a.order - b.order)
    || ((rank.has(a.key) ? rank.get(a.key) : 1e6) - (rank.has(b.key) ? rank.get(b.key) : 1e6))
    || a.sortName.localeCompare(b.sortName)).map(({ key, label, tasks: ts }) => ({ key, label, tasks: ts }));
}

/**
 * May a card dragged out of lane `from` be dropped into lane `to`? Only inside the same lane: the hub cannot move a task
 * to another project (PATCH /v1/tasks ignores projectId) and an agent is not something you reassign by dragging.
 */
export const canDropAcross = (from, to) => (from || null) === (to || null);

/** Which columns a lane shows: the five main ones, plus Later / Blocked only when the lane has cards there. */
export function laneStatuses(tasks, main, extra, statusFilter = []) {
  const have = new Set(tasks.map((t) => t.status));
  const list = [...main, ...extra.filter((s) => have.has(s))];
  return statusFilter.length ? list.filter((s) => statusFilter.includes(s)) : list;
}

/** Number of distinct projects among some tasks. */
export const projectCount = (tasks) => new Set(tasks.map((t) => t.projectId)).size;

/**
 * T-96: what the Up next header shows for Auto mode, for every grouping. Pure so node can test it.
 *   ctx = { group, projectIds: [ids that exist], scopeProjectId, filterProjects: [ids], laneProjectIds: [ids in this lane] }
 *   -> { kind: 'switch', projectId }   one project: the Manual | Auto switch plus the xN picker
 *      { kind: 'picker', projectIds }  several projects: the compact "Auto n/m" popover (per-project toggles)
 *      { kind: 'none' }                no Up next column here (flat list) or no projects at all
 * Auto mode and concurrency belong to a project, so a project lane always gets its own switch; a lane that mixes projects
 * (agent lanes) or the "All projects" status board gets the popover instead.
 */
export function autoHeader(ctx = {}) {
  const known = new Set(ctx.projectIds || []);
  const only = (ids) => { const u = [...new Set((ids || []).filter((id) => known.has(id)))]; return u.length === 1 ? u[0] : null; };
  if (!known.size || ctx.group === 'none') return { kind: 'none' };
  if (ctx.group === 'project' || ctx.group === 'agent') {
    const ids = [...new Set((ctx.laneProjectIds || []).filter((id) => known.has(id)))];
    if (!ids.length) return { kind: 'none' };
    return ids.length === 1 ? { kind: 'switch', projectId: ids[0] } : { kind: 'picker', projectIds: ids };
  }
  const one = (ctx.scopeProjectId && known.has(ctx.scopeProjectId) ? ctx.scopeProjectId : null) || only(ctx.filterProjects) || only([...known]);
  if (one) return { kind: 'switch', projectId: one };
  const filtered = (ctx.filterProjects || []).filter((id) => known.has(id));
  return { kind: 'picker', projectIds: filtered.length ? filtered : [...known] };
}

/* ---------- saved views ---------- */
const cleanName = (n) => String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, 32);

/** Normalise whatever was stored: [{ name, view }] with unique, non-empty names (max 12). */
export function normalizeSaved(list) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    const name = cleanName(e && e.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, view: normalizeView(e.view) });
  }
  return out.slice(0, 12);
}
/** Add or replace (by name, case-insensitive). Returns a new list. */
export function saveView(list, name, view) {
  name = cleanName(name);
  if (!name) return normalizeSaved(list);
  const rest = normalizeSaved(list).filter((e) => e.name.toLowerCase() !== name.toLowerCase());
  return normalizeSaved([...rest, { name, view: normalizeView(view) }]);
}
export const removeView = (list, name) => normalizeSaved(list).filter((e) => e.name.toLowerCase() !== String(name).toLowerCase());
/** The saved view that equals `view`, if any. */
export const matchingView = (list, view) => normalizeSaved(list).find((e) => viewsEqual(e.view, view)) || null;

/** A short summary for the bar: "Project · 2 filters". */
export function describeView(v) {
  v = normalizeView(v);
  const parts = [GROUPS.find((g) => g.key === v.group).label];
  if (v.sort !== 'manual') parts.push(SORTS.find((s) => s.key === v.sort).label);
  const n = activeFilterCount(v);
  if (n) parts.push(n === 1 ? '1 filter' : `${n} filters`);
  return parts.join(' · ');
}
