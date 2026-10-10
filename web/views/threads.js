// views/threads.js — v0.6 Threads at scale.
// Tree (default): one trunk per session, agents hang off it as orthogonal branches, newest first, grouped
// Live / Today (by hour) / Earlier. Timeline (toggle): the same rows against a horizontal time axis with
// duration bars. Both are virtualised: only the rows near the viewport exist in the DOM. The inspector
// (agent detail, tool timeline, scoped prompt) is unchanged and still drives the Dock via task chips.
import { h, reconcile, setText, setClass, setHidden, setAttr, reducedMotion, startTicker, frameBatch, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, onActivity, ingestActivity, lsGet, lsSet } from '../store.js';
import { api } from '../api.js';
import { fmtElapsed, fmtTokens, fmtUsd, fmtTime, fmtAgo, fmtDay, cwdTail, agentLabel, truncate, modelInfo } from '../format.js';
import { avatar, updateAvatar, modelBadge, updateModelBadge, nowDoingLine, emptyState } from '../ui.js';
import { createTimeline } from '../timeline.js';
import { createNotesPanel } from '../notes.js';
import { createTalk } from './talk.js';
import { taskChip } from '../tasklinks.js';
import { navigate, setArgs, openTask } from '../router.js';

const akey = (a) => a.toolUseId || a.id;
const AGENT_STATUS = { running: 'Running', done: 'Done', failed: 'Failed', stalled: 'Stalled', waiting: 'Waiting for you' };
const FILTER_STATUSES = [['running', 'Running'], ['waiting', 'Waiting'], ['stalled', 'Stalled'], ['done', 'Done'], ['failed', 'Failed']];
const LIVE = new Set(['running', 'waiting', 'stalled']);
const isLive = (a) => LIVE.has(a.status);
const HOUR = 3600e3;
const MAX_DEPTH = 6;          // deeper nesting keeps the last indent
const BUF = 480;              // px of rows rendered above/below the viewport
const AXIS_H = 32;            // timeline axis height
const PREFS_KEY = 'helm.threads';

// Row heights (px, 8-pt grid) per view and density. Fixed per row kind so the window maths is a binary search.
const ROW_H = {
  tree: {
    compact: { lane: 48, section: 32, group: 32, hint: 40, agent: 32, agentLive: 48 },
    comfy: { lane: 56, section: 32, group: 40, hint: 48, agent: 72, agentLive: 96 },
  },
  time: {
    compact: { lane: 32, section: 24, group: 24, hint: 32, agent: 24, agentLive: 24 },
    comfy: { lane: 40, section: 32, group: 32, hint: 40, agent: 32, agentLive: 32 },
  },
};
// Guide geometry (px): trunk at X(0); the dot of a depth-d row sits exactly on X(d+1), where its children's spine runs.
const X = (j) => 12 + 20 * j;

/* ---------- pure helpers ---------- */
const startOfHour = (t) => { const d = new Date(t); d.setMinutes(0, 0, 0); return d.getTime(); };
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const pad2 = (n) => String(n).padStart(2, '0');
const hourLabel = (t) => `${pad2(new Date(t).getHours())}:00`;
const endOf = (a, now) => (isLive(a) ? now : (a.endedAt || a.lastActivityAt || a.startedAt));
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${pad2(s % 60)}s`;
  return `${Math.floor(m / 60)}h${pad2(m % 60)}m`;
}

function agentTitle(a) {
  const t = a.taskId ? state.tasks.get(a.taskId) : null;
  return (t && t.title) || a.description || agentLabel(a);
}

function sortNewest(x, y) { return (y.a.startedAt - x.a.startedAt) || (x.a.id < y.a.id ? -1 : 1); }

function mkNode(a, kidsOf, seen, now) {
  seen.add(a.id);
  const node = { a, kids: [], size: 1, live: isLive(a), min: a.startedAt, max: endOf(a, now) };
  for (const c of kidsOf.get(a.id) || []) {
    if (seen.has(c.id)) continue;
    const k = mkNode(c, kidsOf, seen, now);
    node.kids.push(k);
    node.size += k.size;
    node.live = node.live || k.live;
    node.min = Math.min(node.min, k.min);
    node.max = Math.max(node.max, k.max);
  }
  node.kids.sort(sortNewest);
  return node;
}

/** Nodes -> forest + sections for one session. `ctx.pass` filters agents, `ctx.now` is the clock. */
function buildLane(session, ctx) {
  const all = sel.agentsOfSession(session.id);
  const shown = all.filter(ctx.pass);
  const byId = new Map(shown.map((a) => [a.id, a]));
  const kidsOf = new Map();
  const rootAgents = [];
  for (const a of shown) {
    const p = a.parentId;
    if (p && p !== a.id && byId.has(p)) { if (!kidsOf.has(p)) kidsOf.set(p, []); kidsOf.get(p).push(a); } else rootAgents.push(a);
  }
  const seen = new Set();
  const roots = rootAgents.map((a) => mkNode(a, kidsOf, seen, ctx.now));
  for (const a of shown) if (!seen.has(a.id)) roots.push(mkNode(a, kidsOf, seen, ctx.now)); // parent cycles: never lose a row
  roots.sort(sortNewest);

  const live = [], today = new Map(), earlier = new Map();
  for (const n of roots) {
    if (n.live) { live.push(n); continue; }
    const t = n.a.startedAt;
    if (t >= ctx.todayStart) { const k = startOfHour(t); if (!today.has(k)) today.set(k, []); today.get(k).push(n); } else { const k = startOfDay(t); if (!earlier.has(k)) earlier.set(k, []); earlier.get(k).push(n); }
  }
  const groups = (map, label) => Array.from(map.entries()).sort((x, y) => y[0] - x[0]).map(([t, nodes]) => ({
    t, label: label(t), nodes, count: nodes.reduce((s, n) => s + n.size, 0),
    min: Math.min(...nodes.map((n) => n.min)), max: Math.max(...nodes.map((n) => n.max)),
  }));
  const todayG = groups(today, hourLabel), earlierG = groups(earlier, (t) => fmtDay(t));
  return {
    session, all: all.length, total: shown.length, shown, live,
    today: todayG, earlier: earlierG,
    earlierCount: earlierG.reduce((s, g) => s + g.count, 0),
  };
}

/** A time step that gives roughly `want` ticks over `span`. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800].map((s) => s * 1000);
export function niceStep(span, want) {
  const raw = span / Math.max(1, want);
  return STEPS.find((s) => s >= raw) || STEPS[STEPS.length - 1];
}
// Tick steps the zoomable axis snaps to: 10s / 30s / 1m / 5m / 15m / 1h / 3h / 1d.
export const TICK_STEPS = [10e3, 30e3, 60e3, 300e3, 900e3, HOUR, 3 * HOUR, 86400e3];
const MIN_SPAN = 30e3, MAX_SPAN = 7 * 86400e3, FIT_MIN = 120e3, FIT_PAD = 0.05, MIN_BAR_PX = 3;
export function tickStep(span, want) {
  const raw = span / Math.max(1, want);
  return TICK_STEPS.find((s) => s >= raw) || TICK_STEPS[TICK_STEPS.length - 1];
}
/** Exact duration for tooltips: millisecond precision under a minute. */
export function fmtDurExact(ms) {
  ms = Math.max(0, Math.round(ms));
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60e3) return `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s (${ms.toLocaleString('en-US')} ms)`;
  return fmtDur(ms);
}
export function makeTicks(t0, t1, want) {
  const step = tickStep(t1 - t0, want);
  const off = new Date(t0).getTimezoneOffset() * 60000; // align to local clock
  const out = [];
  for (let t = Math.ceil((t0 - off) / step) * step + off; t <= t1 && out.length < 60; t += step) out.push(t);
  const fmt = (t1 - t0) < 120e3 ? (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
    : step < 86400e3 ? (t) => fmtTime(t) : (t) => fmtDay(t);
  return out.map((t) => ({ t, label: fmt(t) }));
}

function loadPrefs() {
  const p = { view: 'tree', density: 'compact', status: [], model: 'all', scopeAll: false, zoom: 'auto' };
  try {
    const j = JSON.parse(lsGet(PREFS_KEY, '{}') || '{}');
    if (j.view === 'tree' || j.view === 'timeline') p.view = j.view;
    if (j.density === 'compact' || j.density === 'comfy') p.density = j.density;
    if (Array.isArray(j.status)) p.status = j.status.filter((x) => FILTER_STATUSES.some((f) => f[0] === x));
    if (typeof j.model === 'string') p.model = j.model;
    p.scopeAll = !!j.scopeAll;
    if (j.zoom === 'manual') p.zoom = 'manual';
  } catch { /* corrupt prefs: use defaults */ }
  return p;
}
function savePrefs(p) {
  try { lsSet(PREFS_KEY, JSON.stringify({ view: p.view, density: p.density, status: p.status, model: p.model, scopeAll: p.scopeAll, zoom: p.zoom })); } catch { /* storage unavailable */ }
}

export function mount(container) {
  let sid = null;
  let selKey = 'main';
  let insp = null; // {key, update, destroy}
  const loaded = new Set();
  const prefs = loadPrefs();
  let query = '';
  const openOv = new Map();      // row key -> user-chosen open/closed (beats the default)
  let cursorKey = null;          // keyboard cursor (row key)
  let items = [];                // flat row descriptors, newest first
  let lanes = [];                // [{ item, y, h }] for the pinned session header
  let totalH = 0;
  let modelVer = 0;
  let scale = { t0: Date.now() - HOUR, t1: Date.now(), span: HOUR };
  let hasLive = false;
  let fitted = false;            // has `scale` been initialised for this mount?
  let fitTimer = null;
  let rid = 0;
  startTicker();

  /* ---------- structure ---------- */
  const picker = h('select', { class: 'select', 'aria-label': 'Session', onchange: () => choose(picker.value) });
  const sessMeta = h('div', { class: 'threads-meta mono' });

  const segBtn = (label, value, group, title) => h('button', { class: 'th-seg-btn', type: 'button', 'data-v': value, 'aria-pressed': 'false', title: title || label, onclick: () => group(value) }, label);
  const viewSeg = h('div', { class: 'th-seg', role: 'group', 'aria-label': 'View' },
    segBtn('Tree', 'tree', (v) => setPref('view', v), 'Tree: trunk and branches'), segBtn('Timeline', 'timeline', (v) => setPref('view', v), 'Timeline: duration bars on a time axis'));
  const densSeg = h('div', { class: 'th-seg', role: 'group', 'aria-label': 'Density' },
    segBtn('Compact', 'compact', (v) => setPref('density', v), 'One line per agent'), segBtn('Cards', 'comfy', (v) => setPref('density', v), 'Comfortable cards'));
  const statusChips = new Map();
  const chipRow = h('div', { class: 'th-chips', role: 'group', 'aria-label': 'Filter by status' },
    FILTER_STATUSES.map(([k, label]) => {
      const n = h('span', { class: 'th-chip-n mono' }, '0');
      const b = h('button', { class: `th-fchip s-${k}`, type: 'button', 'aria-pressed': 'false', onclick: () => toggleStatus(k) }, h('i', { class: 'th-fdot' }), label, n);
      b.__n = n; statusChips.set(k, b);
      return b;
    }));
  const modelSel = h('select', { class: 'select select-sm', 'aria-label': 'Filter by model', onchange: () => setPref('model', modelSel.value) });
  const search = h('input', { type: 'text', class: 'th-search', inputmode: 'search', placeholder: 'Search title, description, task id', 'aria-label': 'Search agents', autocomplete: 'off', spellcheck: 'false' });
  const searchWrap = h('label', { class: 'th-search-wrap' }, icon('search', 14), search, h('kbd', { class: 'th-kbd mono', 'aria-hidden': 'true' }, '/'));
  const zoomBtn = (label, title, fn, cls) => h('button', { class: `th-seg-btn ${cls || ''}`.trim(), type: 'button', title, 'aria-label': title, onclick: fn }, label);
  const zoomSpan = h('span', { class: 'th-zoom-span mono', 'aria-live': 'off' });
  const fitBtn = zoomBtn('Fit', 'Fit the axis to the visible rows (0)', () => fitAxis(), 'th-fit');
  const zoomSeg = h('div', { class: 'th-seg th-zoom', role: 'group', 'aria-label': 'Timeline zoom' },
    zoomBtn('\u2212', 'Zoom out (-)', () => zoomBy(1.6, 0.5)), zoomBtn('+', 'Zoom in (+)', () => zoomBy(1 / 1.6, 0.5)), fitBtn);
  const bar = h('div', { class: 'threads-bar' },
    h('div', { class: 'th-bar-row' }, h('label', { class: 'field-label inline' }, icon('threads', 15), picker), sessMeta, h('span', { class: 'th-grow' }), zoomSpan, zoomSeg, viewSeg, densSeg),
    h('div', { class: 'th-bar-row' }, chipRow, modelSel, searchWrap));

  const sizer = h('div', { class: 'th-sizer' });
  const vp = h('div', { class: 'th-vp', role: 'presentation' });
  const grid = h('div', { class: 'th-grid', 'aria-hidden': 'true' });
  const nowLine = h('i', { class: 'th-nowline' });
  grid.appendChild(nowLine);
  const axisTicks = h('div', { class: 'th-axis-ticks' });
  const axisNow = h('i', { class: 'th-axis-now' }, 'now');
  const axis = h('div', { class: 'th-axis mono', 'aria-hidden': 'true' }, h('div', { class: 'th-axis-l' }, 'Time'), h('div', { class: 'th-axis-plot' }, axisTicks, axisNow));
  const pinHost = h('div', { class: 'th-pin' });
  const sticky = h('div', { class: 'th-sticky' }, axis, pinHost);
  sizer.append(grid, vp);
  const scroller = h('div', { class: 'th-scroll', tabindex: '0', role: 'tree', 'aria-label': 'Agents, newest first' }, sticky, sizer);
  const tip = h('div', { class: 'th-tip mono', role: 'tooltip', hidden: true });
  const legend = h('div', { class: 'th-legend mono' },
    h('span', {}, 'Up Down move'), h('span', {}, 'Enter open'), h('span', {}, 'Left Right fold'), h('span', {}, '/ search'));
  const listPane = h('div', { class: 'th-pane' }, scroller, legend, tip);
  const inspector = h('aside', { class: 'inspector', 'aria-label': 'Inner view' });
  const main = h('div', { class: 'threads-main' }, listPane, inspector);
  const empty = h('div', { class: 'view-empty' }, emptyState({
    iconName: 'threads', title: 'No sessions yet',
    body: 'Start Claude Code with Helm installed. Pick a session here to watch its agents work and step into any of them.',
  }));
  const root = h('div', { class: 'threads' }, bar, main, empty);
  container.appendChild(root);

  /* ---------- preferences + filters ---------- */
  function setPref(k, v) {
    prefs[k] = v;
    savePrefs(prefs);
    if (k === 'view' || k === 'density') { vp.textContent = ''; vp.__keyed = null; pinHost.textContent = ''; pinEl = null; }
    rebuild();
  }
  function toggleStatus(k) {
    const i = prefs.status.indexOf(k);
    if (i >= 0) prefs.status.splice(i, 1); else prefs.status.push(k);
    savePrefs(prefs);
    rebuild();
  }
  search.addEventListener('input', debounce(() => { query = search.value.trim().toLowerCase(); rebuild(); }, 120));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (search.value) { search.value = ''; query = ''; rebuild(); } else scroller.focus(); e.stopPropagation(); }
    else if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); scroller.focus(); }
  });

  const hayOf = (a) => `${agentTitle(a)}\n${a.description || ''}\n${a.taskId || ''}\n${a.subagentType || ''}`.toLowerCase();
  const passBase = (a) => {
    if (prefs.model !== 'all' && modelInfo(a.model).key !== prefs.model) return false;
    if (query && !hayOf(a).includes(query)) return false;
    return true;
  };
  const passAll = (a) => passBase(a) && (!prefs.status.length || prefs.status.includes(a.status));

  /* ---------- selection / routing ---------- */
  function sessionList() {
    const list = sel.scopedSessions();
    if (sid && !list.some((x) => x.id === sid) && state.sessions.has(sid)) list.push(state.sessions.get(sid));
    const order = { active: 0, idle: 1, ended: 2 };
    return list.sort((a, b) => (order[a.status] - order[b.status]) || (b.lastSeenAt - a.lastSeenAt));
  }

  function choose(value) {
    if (value === 'all') { prefs.scopeAll = true; savePrefs(prefs); rebuild(); return; }
    prefs.scopeAll = false; savePrefs(prefs);
    setArgs(value ? [value] : []);
    rebuild();
  }

  function applyRoute(r) {
    const [rs, ra] = r.args;
    const list = sessionList();
    let target = rs && state.sessions.has(rs) ? rs : null;
    if (!target) {
      if (!state.ready) { sid = null; renderAll(); return; }
      const first = list[0];
      if (first) { sid = first.id; selKey = 'main'; setArgs([first.id]); return; }
    }
    const changedSession = target !== sid;
    sid = target;
    if (changedSession) { selKey = 'main'; }
    if (sid) {
      if (ra) {
        const a = sel.agentsOfSession(sid).find((x) => x.id === ra || x.toolUseId === ra);
        selKey = a ? akey(a) : (state.ready ? 'main' : selKey);
        if (a) revealAgent(a);
      } else selKey = 'main';
      ensureActivity(sid);
    }
    renderAll(true);
  }

  async function ensureActivity(id) {
    if (loaded.has(id)) return;
    loaded.add(id);
    try {
      const res = await api.sessionActivity(id, 200);
      ingestActivity(res.activity || []);
    } catch { loaded.delete(id); }
  }

  /* ---------- list model ---------- */
  const isOpen = (key, def) => (openOv.has(key) ? openOv.get(key) : def);
  function toggleKey(key, curOpen) { openOv.set(key, !curOpen); rebuild(); }

  /** Flatten one lane into row descriptors. `forced` = search active, so every fold is open. */
  function flatten(lane, out, forced) {
    const id = lane.session.id;
    const open = (key, def) => (forced ? true : isOpen(key, def));
    const laneKey = `l:${id}`;
    const laneOpen = isOpen(laneKey, true);
    const first = out.length;
    out.push({ kind: 'lane', key: laneKey, sid: id, lane, open: laneOpen });
    if (!laneOpen) return;
    if (!lane.total) { out.push({ kind: 'hint', key: `h:${id}`, text: lane.all ? 'No agents match these filters' : 'No agents in this session yet' }); return; }

    const wrap = (node, depth, anc) => {
      const vd = Math.min(depth, MAX_DEPTH);
      const k = `a:${akey(node.a)}`;
      const kidsOpen = node.kids.length ? open(k, true) : false;
      const row = {
        kind: 'agent', key: k, a: node.a, node, depth: vd, sid: node.a.sessionId, nkids: node.kids.length, hidden: node.size - 1,
        open: kidsOpen, cont: anc.slice(0, vd), last: false, tail: false,
      };
      out.push(row);
      if (kidsOpen) node.kids.forEach((c, i) => { const r = wrap(c, depth + 1, [...anc, i !== node.kids.length - 1]); r.last = i === node.kids.length - 1; });
      return row;
    };
    const trees = (nodes) => { for (const n of nodes) wrap(n, 0, [true]); };

    if (lane.live.length) {
      out.push({ kind: 'section', key: `s:${id}:live`, sid: id, label: 'Live', count: lane.live.reduce((s, n) => s + n.size, 0), tone: 'live', toggle: false });
      trees(lane.live);
    }
    if (lane.today.length) {
      out.push({ kind: 'section', key: `s:${id}:today`, sid: id, label: 'Today', count: lane.today.reduce((s, g) => s + g.count, 0), tone: 'today', toggle: false });
      lane.today.forEach((g, i) => {
        const key = `g:${id}:${g.t}`;
        const o = open(key, i === 0);
        out.push({ kind: 'group', key, sid: id, label: g.label, count: g.count, open: o, min: g.min, max: g.max });
        if (o) trees(g.nodes);
      });
    }
    if (lane.earlier.length) {
      const key = `e:${id}`;
      const o = open(key, false);
      out.push({ kind: 'section', key, sid: id, label: o ? 'Earlier' : 'Show older', count: lane.earlierCount, tone: 'earlier', toggle: true, open: o });
      if (o) lane.earlier.forEach((g) => {
        const gk = `g:${id}:d${g.t}`;
        const go = open(gk, false);
        out.push({ kind: 'group', key: gk, sid: id, label: g.label, count: g.count, open: go, min: g.min, max: g.max });
        if (go) trees(g.nodes);
      });
    }
    // trunk ends at the last agent row of the lane
    const lastRow = out[out.length - 1];
    if (lastRow && lastRow.kind === 'agent' && out.length - 1 > first) lastRow.tail = true;
  }

  const rowH = (it) => {
    const t = ROW_H[prefs.view === 'timeline' ? 'time' : 'tree'][prefs.density];
    if (it.kind === 'agent') return isLive(it.a) ? t.agentLive : t.agent;
    return t[it.kind];
  };
  const topInset = () => (prefs.view === 'timeline' ? AXIS_H : 0);

  function rebuild() {
    modelVer++;
    const now = Date.now();
    const list = prefs.scopeAll ? sessionList() : (sid && state.sessions.has(sid) ? [state.sessions.get(sid)] : []);
    const ctx = { now, todayStart: startOfDay(now), pass: passAll };
    // status counts honour model + search but not the status filter itself
    const counts = { running: 0, waiting: 0, stalled: 0, done: 0, failed: 0 };
    const models = new Set();
    const forced = !!query;
    const out = [];
    let agentsShown = 0, liveShown = 0, laneN = 0;
    for (const ses of list) {
      for (const a of sel.agentsOfSession(ses.id)) { models.add(modelInfo(a.model).key); if (passBase(a) && counts[a.status] != null) counts[a.status]++; }
      const lane = buildLane(ses, ctx);
      if (prefs.scopeAll && !lane.total) continue; // all-sessions view: only lanes that have rows
      laneN++;
      agentsShown += lane.total;
      liveShown += lane.shown.filter(isLive).length;
      flatten(lane, out, forced);
    }
    hasLive = liveShown > 0;
    if (!out.length) out.push({ kind: 'hint', key: 'h:none', text: 'No agents match these filters' });
    // layout
    let y = topInset();
    for (const it of out) { it.y = y; it.h = rowH(it); y += it.h; }
    totalH = y + 24;
    items = out;
    lanes = items.filter((it) => it.kind === 'lane');
    sizer.style.height = `${totalH}px`;
    // time scale
    if (!fitted || prefs.view !== 'timeline') { scale = toScale(fitRange(now)); fitted = prefs.view === 'timeline'; }
    else if (prefs.zoom === 'auto') requestFit(false);
    paintControls(counts, models, agentsShown, laneN, liveShown);
    paintGridChrome();
    renderWindow(true);
  }

  /* ---------- axis range: auto-fit + manual zoom ---------- */
  const toScale = (r) => ({ t0: r.t0, t1: r.t1, span: r.t1 - r.t0 });
  const plotRect = () => { const el = axis.querySelector('.th-axis-plot'); return el ? el.getBoundingClientRect() : { left: 0, width: 0 }; };
  /** Earliest start .. latest end (now for live) of the rows in view, padded 5% a side, at least 2 minutes. */
  function fitRange(now) {
    const st = scroller.scrollTop, vh = scroller.clientHeight || 640;
    const lo = st + topInset(), hi = st + vh;
    let t0 = Infinity, t1 = -Infinity, live = false;
    const take = (list) => {
      for (const it of list) {
        if (it.kind !== 'agent') continue;
        const a = it.a;
        if (a.startedAt < t0) t0 = a.startedAt;
        const e = endOf(a, now);
        if (e > t1) t1 = e;
        if (isLive(a)) live = true;
      }
    };
    let a = 0, b = items.length;
    while (a < b) { const m = (a + b) >> 1; if (items[m].y + items[m].h < lo) a = m + 1; else b = m; }
    const vis = [];
    for (let i = a; i < items.length && items[i].y <= hi; i++) vis.push(items[i]);
    take(vis);
    if (!Number.isFinite(t0)) take(items); // nothing agent-shaped in view: fall back to everything shown
    if (!Number.isFinite(t0)) { t0 = now - HOUR; t1 = now; }
    const pad = (t1 - t0) * FIT_PAD;
    let r0 = t0 - pad, r1 = t1 + pad;
    if (live && hasLive) { r1 = now; r0 = t0 - Math.max(pad, 0); } // live: the right edge IS now
    if (r1 - r0 < FIT_MIN) {
      if (live && hasLive) r0 = r1 - FIT_MIN;
      else { const mid = (r0 + r1) / 2; r0 = mid - FIT_MIN / 2; r1 = mid + FIT_MIN / 2; }
    }
    return { t0: r0, t1: r1 };
  }
  function applyScale(r) {
    scale = toScale(r);
    paintGridChrome();
    renderWindow(true);
  }
  /** Auto-fit, debounced: widen at once (never clip a bar mid-scroll), settle to the tight fit ~150ms after things stop moving. */
  function requestFit(immediate) {
    if (prefs.view !== 'timeline' || prefs.zoom !== 'auto') return;
    const now = Date.now();
    const r = fitRange(now);
    if (immediate || !fitted) { fitted = true; clearTimeout(fitTimer); fitTimer = null; applyScale(r); return; }
    const w = { t0: Math.min(scale.t0, r.t0), t1: Math.max(scale.t1, r.t1) };
    if (w.t0 < scale.t0 - 1 || w.t1 > scale.t1 + 1) applyScale(w);
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      if (prefs.view !== 'timeline' || prefs.zoom !== 'auto') return;
      const f = fitRange(Date.now());
      if (Math.abs(f.t0 - scale.t0) > 500 || Math.abs(f.t1 - scale.t1) > 500) applyScale(f);
    }, 150);
  }
  function setZoomMode(mode) {
    if (prefs.zoom === mode) return;
    prefs.zoom = mode;
    savePrefs(prefs);
  }
  function fitAxis() {
    setZoomMode('auto');
    clearTimeout(fitTimer);
    fitted = true;
    applyScale(fitRange(Date.now()));
  }
  /** Move to an explicit range; this is what makes auto-fit pause. */
  function setManual(t0, span) {
    span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, span));
    clearTimeout(fitTimer); fitTimer = null;
    setZoomMode('manual');
    fitted = true;
    applyScale({ t0, t1: t0 + span });
  }
  /** Zoom by `factor` (>1 zooms out) keeping the time under `frac` (0..1 across the plot) fixed. */
  function zoomBy(factor, frac) {
    const f = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0.5;
    const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, scale.span * factor));
    const anchor = scale.t0 + f * scale.span;
    setManual(anchor - f * span, span);
  }
  function panBy(dt) { setManual(scale.t0 + dt, scale.span); }
  const fracAt = (clientX) => { const r = plotRect(); return r.width > 0 ? (clientX - r.left) / r.width : 0.5; };
  scroller.addEventListener('wheel', (e) => {
    if (prefs.view !== 'timeline') return;
    const dx = e.deltaX, dy = e.deltaY;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(Math.exp(Math.max(-200, Math.min(200, dy)) * 0.004), fracAt(e.clientX)); return; }
    const w = plotRect().width || 600;
    if (e.shiftKey) { e.preventDefault(); panBy(((dx || dy) / w) * scale.span); return; }
    if (Math.abs(dx) > Math.abs(dy) && dx) { e.preventDefault(); panBy((dx / w) * scale.span); }
  }, { passive: false });
  // drag the axis to pan
  let drag = null;
  axis.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || prefs.view !== 'timeline') return;
    drag = { x: e.clientX, t0: scale.t0, w: plotRect().width || 600 };
    e.preventDefault();
  });
  const onDragMove = (e) => { if (drag) setManual(drag.t0 - ((e.clientX - drag.x) / drag.w) * scale.span, scale.span); };
  const onDragEnd = () => { drag = null; };
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);

  function paintControls(counts, models, agentsShown, laneN, liveShown) {
    root.dataset.view = prefs.view;
    root.dataset.density = prefs.density;
    for (const b of viewSeg.children) b.setAttribute('aria-pressed', String(b.dataset.v === prefs.view));
    for (const b of densSeg.children) b.setAttribute('aria-pressed', String(b.dataset.v === prefs.density));
    for (const [k, b] of statusChips) {
      const on = prefs.status.includes(k);
      b.setAttribute('aria-pressed', String(on));
      setText(b.__n, String(counts[k]));
      setClass(b, 'dim', !on && prefs.status.length > 0);
    }
    const msig = Array.from(models).sort().join(',') + '|' + prefs.model;
    if (modelSel.__sig !== msig) {
      modelSel.__sig = msig;
      modelSel.textContent = '';
      modelSel.appendChild(h('option', { value: 'all' }, 'All models'));
      const keys = new Set(models); if (prefs.model !== 'all') keys.add(prefs.model);
      for (const k of ['opus', 'sonnet', 'haiku', 'other']) if (keys.has(k)) modelSel.appendChild(h('option', { value: k }, k === 'other' ? 'Other' : k[0].toUpperCase() + k.slice(1)));
      modelSel.value = prefs.model;
    }
    sessMeta.textContent = '';
    if (prefs.scopeAll) sessMeta.append(h('span', {}, plural(laneN, 'session')), h('span', {}, plural(agentsShown, 'agent')), h('span', {}, `${liveShown} live`));
    else {
      const ses = sid && state.sessions.get(sid);
      if (ses) sessMeta.append(h('span', {}, sel.projectName(ses.projectId)), h('span', {}, cwdTail(ses.cwd, 3)), h('span', {}, plural(sel.agentsOfSession(sid).length, 'agent')), h('span', {}, `${liveShown} live`));
    }
    setAttr(scroller, 'aria-label', `Agents, newest first, ${prefs.view} view`);
    paintZoomUi();
  }

  function paintZoomUi() {
    const tl = prefs.view === 'timeline';
    setHidden(zoomSeg, !tl);
    setHidden(zoomSpan, !tl);
    if (!tl) return;
    const manual = prefs.zoom === 'manual';
    zoomSpan.textContent = `${manual ? 'Manual' : 'Auto'} \u00b7 ${fmtDur(scale.span)}`;
    zoomSeg.dataset.mode = prefs.zoom;
    fitBtn.setAttribute('aria-pressed', String(!manual));
    setClass(fitBtn, 'paused', manual);
    fitBtn.title = manual ? 'Auto-fit is paused. Fit to the visible rows (0)' : 'Fit the axis to the visible rows (0)';
  }

  /* ---------- timeline chrome (ticks, now line) ---------- */
  function paintGridChrome() {
    const tl = prefs.view === 'timeline';
    setHidden(axis, !tl);
    setHidden(grid, !tl);
    if (!tl) return;
    const w = Math.max(300, (scroller.clientWidth || 900) - 260);
    const ticks = makeTicks(scale.t0, scale.t1, Math.max(3, Math.floor(w / 110)));
    const pct = (t) => `${(((t - scale.t0) / scale.span) * 100).toFixed(3)}%`;
    reconcile(axisTicks, ticks, (t) => `t${t.t}`, (t) => h('span', { class: 'th-axis-tick' }, t.label), (el, t) => { el.style.left = pct(t.t); if (el.textContent !== t.label) el.textContent = t.label; });
    // grid lines live in `grid`, after the now line
    const lines = ticks.map((t) => ({ k: `g${t.t}`, t: t.t }));
    for (const el of Array.from(grid.children)) if (el !== nowLine && !lines.some((l) => l.k === el.__k)) el.remove();
    for (const l of lines) {
      let el = Array.from(grid.children).find((c) => c.__k === l.k);
      if (!el) { el = h('i', { class: 'th-gridline' }); el.__k = l.k; grid.insertBefore(el, nowLine); }
      el.style.left = pct(l.t);
    }
    const nowT = Date.now();
    const nowIn = hasLive && nowT >= scale.t0 && nowT <= scale.t1;
    nowLine.style.left = pct(nowT);
    axisNow.style.left = pct(nowT);
    nowLine.hidden = axisNow.hidden = !nowIn;
    setClass(axisNow, 'pinned', prefs.zoom === 'auto' && hasLive);
    paintZoomUi();
  }

  /* ---------- virtual window ---------- */
  let pinEl = null;
  function renderWindow(force) {
    const st = scroller.scrollTop, vh = scroller.clientHeight || 640;
    const lo = st - BUF, hi = st + vh + BUF;
    let a = 0, b = items.length;
    while (a < b) { const m = (a + b) >> 1; if (items[m].y + items[m].h < lo) a = m + 1; else b = m; }
    const vis = [];
    for (let i = a; i < items.length && items[i].y <= hi; i++) vis.push(items[i]);
    reconcile(vp, vis, (it) => it.key, createRow, (el, it) => {
      if (el.__d === it && el.__mv === modelVer && !force) return;
      el.__mv = modelVer;
      updateRow(el, it);
    });
    paintPinned(st);
    scroller.dataset.rows = String(vp.children.length);
  }

  function paintPinned(st) {
    const inset = topInset();
    let cur = null, next = null;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].y <= st + inset) { cur = lanes[i]; next = lanes[i + 1] || null; } else break;
    }
    if (!cur || st + inset <= cur.y + 1) { pinHost.hidden = true; return; }
    pinHost.hidden = false;
    if (!pinEl) { pinEl = createRow(cur); pinHost.appendChild(pinEl); }
    pinEl.__d = null;
    updateRow(pinEl, cur);
    pinEl.style.transform = 'none';
    pinEl.classList.add('pinned');
    let ty = 0;
    if (next) ty = Math.min(0, next.y - (st + inset) - cur.h);
    pinHost.style.top = `${inset}px`;
    pinHost.style.height = `${cur.h}px`;
    pinHost.style.transform = `translateY(${ty}px)`;
  }

  /* ---------- row construction ---------- */
  const mode = () => prefs.view;
  function createRow(it) {
    const el = it.kind === 'lane' ? createLane() : it.kind === 'agent' ? (mode() === 'tree' ? createTreeAgent() : createTlAgent()) : createLabelRow(it.kind);
    el.id = `thr-${++rid}`;
    el.setAttribute('role', 'treeitem');
    return el;
  }

  function createLane() {
    const r = {};
    r.tog = h('span', { class: 'th-tog', 'aria-hidden': 'true' }, icon('chevronDown', 14));
    r.dot = h('span', { class: 'pdot' });
    r.title = h('span', { class: 'th-lane-title' });
    r.badge = modelBadge('');
    r.meta = h('span', { class: 'th-lane-meta mono' });
    const el = h('div', { class: 'th-row th-lane' }, h('span', { class: 'th-node', 'aria-hidden': 'true' }), h('div', { class: 'th-lane-body' }, r.tog, r.dot, r.title, r.badge, r.meta));
    el.__r = r;
    return el;
  }

  function createLabelRow(kind) {
    const r = {};
    r.tog = h('span', { class: 'th-tog', 'aria-hidden': 'true' }, icon('chevronDown', 14));
    r.label = h('span', { class: 'th-label' });
    r.count = h('span', { class: 'th-count mono' });
    r.span = h('i', { class: 'th-gspan' });
    const el = h('div', { class: `th-row th-${kind}` }, h('span', { class: 'th-mark', 'aria-hidden': 'true' }),
      h('div', { class: 'th-lbl-body' }, r.tog, r.label, r.count), h('span', { class: 'th-plot' }, r.span));
    el.__r = r;
    return el;
  }

  function createTreeAgent() {
    const r = {};
    r.guides = h('span', { class: 'th-guides', 'aria-hidden': 'true' });
    r.dot = h('span', { class: 'th-dot', 'aria-hidden': 'true' });
    r.title = h('span', { class: 'th-title' });
    r.kids = h('button', { class: 'th-kids mono', type: 'button', tabindex: '-1' });
    r.badge = modelBadge('');
    r.desc = h('span', { class: 'th-desc' });
    r.type = h('span', { class: 'th-type mono' });
    r.tools = h('span', { class: 'th-tools mono' });
    r.dur = h('span', { class: 'th-dur mono' });
    r.ago = h('span', { class: 'th-ago mono' });
    r.chip = h('span', { class: 'th-chipslot' });
    r.now = nowDoingLine();
    r.now.classList.add('th-now');
    const l1 = h('span', { class: 'th-l1' }, r.dot, r.title, r.kids, r.badge);
    const meta = h('span', { class: 'th-meta' }, r.type, r.tools, r.dur, r.ago, r.chip);
    const el = h('div', { class: 'th-row th-agent' }, r.guides, h('div', { class: 'th-body' }, l1, r.desc, meta, r.now));
    el.__r = r;
    return el;
  }

  function createTlAgent() {
    const r = {};
    r.dot = h('span', { class: 'th-dot', 'aria-hidden': 'true' });
    r.title = h('span', { class: 'th-title' });
    r.dur = h('span', { class: 'th-dur mono' });
    r.bar = h('i', { class: 'th-bar' });
    const el = h('div', { class: 'th-row th-agent th-tl' },
      h('div', { class: 'th-tl-label' }, r.dot, r.title, r.dur), h('span', { class: 'th-plot' }, r.bar));
    el.__r = r;
    return el;
  }

  /* ---------- row updates ---------- */
  const isSelected = (it) => (it.kind === 'agent' ? akey(it.a) === selKey && it.a.sessionId === sid : it.kind === 'lane' ? selKey === 'main' && it.sid === sid : false);
  const pctOf = (t) => ((t - scale.t0) / scale.span) * 100;

  function updateRow(el, it) {
    el.__d = it;
    const r = el.__r;
    if (!el.classList.contains('pinned')) {
      el.style.transform = `translateY(${it.y}px)`;
    }
    const hpx = `${it.h}px`;
    if (el.style.height !== hpx) el.style.height = hpx;
    el.setAttribute('aria-level', String(it.kind === 'agent' ? it.depth + 2 : it.kind === 'lane' ? 1 : 2));
    if (it.kind === 'lane') updateLane(el, r, it);
    else if (it.kind === 'agent') (mode() === 'tree' ? updateTreeAgent : updateTlAgent)(el, r, it);
    else updateLabel(el, r, it);
    paintState(el);
  }

  function paintState(el) {
    const it = el.__d;
    if (!it) return;
    setClass(el, 'selected', isSelected(it));
    setClass(el, 'cursor', cursorKey === it.key);
    el.setAttribute('aria-selected', String(isSelected(it)));
  }
  function paintAllStates() {
    for (const el of vp.children) paintState(el);
    if (pinEl && !pinHost.hidden) paintState(pinEl);
    const cur = cursorKey && vp.__keyed && vp.__keyed.get(cursorKey);
    if (cur) scroller.setAttribute('aria-activedescendant', cur.id); else scroller.removeAttribute('aria-activedescendant');
  }

  function updateLane(el, r, it) {
    const ses = state.sessions.get(it.sid);
    if (!ses) return;
    el.className = `th-row th-lane st-${ses.status}${el.classList.contains('pinned') ? ' pinned' : ''}`;
    setClass(el, 'folded', !it.open);
    r.dot.className = `pdot ${ses.status}`;
    setText(r.title, ses.title || cwdTail(ses.cwd) || ses.id);
    updateModelBadge(r.badge, ses.model);
    const live = it.lane.shown.filter(isLive).length;
    setText(r.meta, `${sel.projectName(ses.projectId)} · ${cwdTail(ses.cwd, 2)} · ${plural(it.lane.all, 'agent')}${live ? ` · ${live} live` : ''}`);
    el.setAttribute('aria-expanded', String(it.open));
    el.setAttribute('aria-label', `Session ${ses.title || ses.id}, ${ses.status}`);
  }

  function updateLabel(el, r, it) {
    const toggle = it.kind === 'group' || it.toggle;
    const cls = `th-row th-${it.kind}${it.tone ? ` tone-${it.tone}` : ''}${toggle ? ' foldable' : ''}`;
    if (el.className.split(' ').filter((c) => !['selected', 'cursor'].includes(c)).join(' ') !== cls) el.className = cls;
    setHidden(r.tog, !toggle);
    setClass(el, 'folded', toggle && !it.open);
    if (it.kind === 'hint') { setText(r.label, it.text); setText(r.count, ''); el.removeAttribute('aria-expanded'); return; }
    if (it.kind === 'section' && it.toggle && !it.open) setText(r.label, `${it.label} (${it.count})`);
    else setText(r.label, it.kind === 'group' ? `${it.label} · ${plural(it.count, 'agent')}` : it.label);
    setText(r.count, it.kind === 'section' && !(it.toggle && !it.open) ? String(it.count) : '');
    if (toggle) el.setAttribute('aria-expanded', String(it.open)); else el.removeAttribute('aria-expanded');
    if (mode() === 'timeline' && it.kind === 'group') {
      r.span.hidden = false;
      r.span.style.left = `${pctOf(it.min)}%`;
      r.span.style.width = `${Math.max(0.2, pctOf(it.max) - pctOf(it.min))}%`;
    } else r.span.hidden = true;
  }

  function paintGuides(r, it) {
    const sig = `${it.depth}|${it.cont.map((c) => (c ? 1 : 0)).join('')}|${it.last ? 1 : 0}|${it.tail ? 1 : 0}`;
    if (r.gsig === sig) return;
    r.gsig = sig;
    r.guides.textContent = '';
    const d = it.depth;
    for (let j = 0; j <= d; j++) {
      let full, half = false;
      if (j === 0) { full = true; half = d === 0 && it.tail; } // the session trunk
      else if (j < d) full = !!it.cont[j];
      else { full = !it.last; half = it.last; }
      if (!full && !half) continue;
      const v = h('i', { class: `gv${half ? ' half' : ''}` });
      v.style.left = `${X(j)}px`;
      r.guides.appendChild(v);
    }
    const br = h('i', { class: 'gh' });
    br.style.left = `${X(d)}px`;
    r.guides.appendChild(br);
  }

  function chipFor(r, a) {
    const k = a.taskId ? `${a.taskId}|${state.tasks.has(a.taskId) ? 1 : 0}` : '';
    if (r.chipKey === k) return;
    r.chipKey = k;
    r.chip.textContent = '';
    const c = a.taskId ? taskChip(a.taskId) : null;
    if (c) { c.tabIndex = -1; r.chip.appendChild(c); }
  }

  function updateTreeAgent(el, r, it) {
    const a = it.a;
    const live = isLive(a);
    const title = agentTitle(a);
    const cls = `th-row th-agent st-${a.status}${live ? ' live' : ''}${a.status === 'running' || a.status === 'waiting' ? ' pulse' : ''}`;
    if (el.__cls !== cls) { el.__cls = cls; el.className = cls; }
    el.style.setProperty('--x', `${X(it.depth)}px`);
    paintGuides(r, it);
    setText(r.title, title);
    el.title = a.description && a.description !== title ? a.description : '';
    const showDesc = a.description && a.description !== title;
    setText(r.desc, showDesc ? a.description : '');
    updateModelBadge(r.badge, a.model);
    setText(r.type, agentLabel(a));
    r.type.title = a.subagentType || 'agent';
    setText(r.tools, `${a.toolCount} tool${a.toolCount === 1 ? '' : 's'}`);
    setHidden(r.kids, !it.nkids);
    if (it.nkids) {
      setText(r.kids, `${it.open ? '▾' : '▸'} ${it.open ? it.nkids : it.hidden}`);
      r.kids.title = it.open ? `Fold ${plural(it.nkids, 'sub-agent')}` : `Unfold ${plural(it.hidden, 'sub-agent')}`;
      r.kids.setAttribute('aria-expanded', String(it.open));
    }
    el.setAttribute('aria-expanded', it.nkids ? String(it.open) : '');
    if (!it.nkids) el.removeAttribute('aria-expanded');
    chipFor(r, a);
    setHidden(r.now, !live);
    if (live) r.now.__set(a.nowDoing, a.status === 'running');
    el.setAttribute('aria-label', `${agentLabel(a)} ${AGENT_STATUS[a.status] || a.status}: ${title}`);
    paintTimes(el);
  }

  function paintTimes(el) {
    const it = el.__d;
    if (!it || it.kind !== 'agent') return;
    const r = el.__r, a = it.a, now = Date.now();
    setText(r.dur, fmtDur(endOf(a, now) - a.startedAt));
    if (r.ago) {
      setText(r.ago, fmtAgo(isLive(a) ? a.startedAt : (a.endedAt || a.lastActivityAt), now));
      r.ago.title = `${isLive(a) ? 'Started' : 'Ended'} ${new Date(isLive(a) ? a.startedAt : (a.endedAt || a.lastActivityAt)).toLocaleString()}`;
    }
  }

  function updateTlAgent(el, r, it) {
    const a = it.a, now = Date.now();
    const live = isLive(a);
    const cls = `th-row th-agent th-tl st-${a.status}${live ? ' live' : ''}`;
    if (el.__cls !== cls) { el.__cls = cls; el.className = cls; }
    setText(r.title, agentTitle(a));
    r.title.style.paddingLeft = `${it.depth * 12}px`;
    const end = endOf(a, now);
    setText(r.dur, fmtDur(end - a.startedAt));
    r.bar.style.left = `${pctOf(a.startedAt).toFixed(3)}%`;
    r.bar.style.width = `${Math.max(0, ((end - a.startedAt) / scale.span) * 100).toFixed(3)}%`;
    r.bar.style.minWidth = `${MIN_BAR_PX}px`; // a sub-second agent stays a visible tick
    el.setAttribute('aria-label', `${agentLabel(a)} ${AGENT_STATUS[a.status] || a.status}: ${agentTitle(a)}, ${fmtDur(end - a.startedAt)}`);
  }

  /* ---------- interaction ---------- */
  function activate(it) {
    if (!it) return;
    cursorKey = it.key;
    if (it.kind === 'agent') { selKey = akey(it.a); setArgs([it.a.sessionId, it.a.id]); paintAllStates(); }
    else if (it.kind === 'lane') { selKey = 'main'; setArgs([it.sid]); paintAllStates(); }
    else if (it.kind === 'group' || (it.kind === 'section' && it.toggle)) toggleKey(it.key, it.open);
  }
  const onRowClick = (e) => {
    const el = e.target.closest('.th-row');
    if (!el || !el.__d) return;
    const it = el.__d;
    if (el.classList.contains('pinned') && it.kind === 'lane') { activate(it); return; }
    if (it.kind === 'agent' && e.target.closest('.th-kids')) { cursorKey = it.key; toggleKey(it.key, it.open); return; }
    if (it.kind === 'lane' && e.target.closest('.th-tog')) { cursorKey = it.key; toggleKey(it.key, it.open); return; }
    scroller.focus({ preventScroll: true });
    activate(it);
  };
  vp.addEventListener('click', onRowClick);
  pinHost.addEventListener('click', onRowClick);

  // tooltip (timeline)
  const showTip = (e) => {
    if (prefs.view !== 'timeline') { tip.hidden = true; return; }
    const el = e.target.closest && e.target.closest('.th-row.th-agent');
    if (!el || !el.__d) { tip.hidden = true; return; }
    const a = el.__d.a, now = Date.now(), end = endOf(a, now);
    tip.textContent = '';
    tip.append(
      h('div', { class: 'th-tip-title' }, truncate(agentTitle(a), 90)),
      h('div', {}, `${AGENT_STATUS[a.status] || a.status} · ${modelInfo(a.model).label} · ${agentLabel(a)}`),
      h('div', {}, `${fmtClockSec(a.startedAt)} → ${isLive(a) ? 'now' : fmtClockSec(end)}`),
      h('div', {}, `Duration ${fmtDurExact(end - a.startedAt)}${isLive(a) ? ' so far' : ''}`),
      h('div', {}, `${plural(a.toolCount, 'tool')}${a.taskId ? ` · ${a.taskId}` : ''}`));
    tip.hidden = false;
    const pr = listPane.getBoundingClientRect();
    const w = tip.offsetWidth || 260, hh = tip.offsetHeight || 80;
    let x = e.clientX - pr.left + 14, y = e.clientY - pr.top + 16;
    if (x + w > pr.width - 8) x = Math.max(8, e.clientX - pr.left - w - 14);
    if (y + hh > pr.height - 8) y = Math.max(8, e.clientY - pr.top - hh - 12);
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  };
  vp.addEventListener('mousemove', showTip);
  vp.addEventListener('mouseleave', () => { tip.hidden = true; });
  function fmtClockSec(t) { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }

  // keyboard: Up/Down move, Enter opens, Left/Right fold
  const navItems = () => items.filter((it) => it.kind === 'agent' || it.kind === 'group' || it.kind === 'lane' || (it.kind === 'section' && it.toggle));
  function ensureVisible(it) {
    const vh = scroller.clientHeight || 640, inset = topInset() + (lanes.length ? lanes[0].h : 0);
    if (it.y < scroller.scrollTop + inset) scroller.scrollTop = Math.max(0, it.y - inset);
    else if (it.y + it.h > scroller.scrollTop + vh) scroller.scrollTop = it.y + it.h - vh + 8;
  }
  function moveCursor(it) {
    if (!it) return;
    cursorKey = it.key;
    ensureVisible(it);
    renderWindow(false);
    paintAllStates();
  }
  const currentItem = () => items.find((it) => it.key === cursorKey) || items.find((it) => isSelected(it)) || null;
  scroller.addEventListener('keydown', (e) => {
    if (e.target !== scroller || e.metaKey || e.ctrlKey || e.altKey) return;
    const nav = navItems();
    if (!nav.length) return;
    const cur = currentItem();
    let i = cur ? nav.indexOf(cur) : -1;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveCursor(nav[Math.min(nav.length - 1, i + 1)]); break;
      case 'ArrowUp': e.preventDefault(); moveCursor(nav[Math.max(0, i < 0 ? 0 : i - 1)]); break;
      case 'Home': e.preventDefault(); moveCursor(nav[0]); break;
      case 'End': e.preventDefault(); moveCursor(nav[nav.length - 1]); break;
      case 'Enter': case ' ': if (cur) { e.preventDefault(); activate(cur); } break;
      case 'ArrowLeft': {
        if (!cur) break;
        e.preventDefault();
        if ((cur.kind === 'group' || cur.kind === 'lane' || (cur.kind === 'section' && cur.toggle) || (cur.kind === 'agent' && cur.nkids)) && cur.open) { toggleKey(cur.key, true); break; }
        // already folded (or a leaf): jump to the enclosing group / parent / lane
        const idx = items.indexOf(cur);
        for (let k = idx - 1; k >= 0; k--) {
          const p = items[k];
          if ((cur.kind === 'agent' && p.kind === 'agent' && p.depth < cur.depth) || (p.kind === 'group') || (p.kind === 'section' && p.toggle) || p.kind === 'lane') { if (p.kind === 'lane' && cur.kind === 'lane') break; moveCursor(p); break; }
        }
        break;
      }
      case 'ArrowRight': {
        if (!cur) break;
        e.preventDefault();
        if ((cur.kind === 'group' || cur.kind === 'lane' || (cur.kind === 'section' && cur.toggle) || (cur.kind === 'agent' && cur.nkids)) && !cur.open) { toggleKey(cur.key, false); break; }
        const nxt = nav[i + 1];
        if (nxt && cur.kind !== 'agent') moveCursor(nxt);
        else if (nxt && cur.kind === 'agent' && cur.nkids && nxt.kind === 'agent' && nxt.depth > cur.depth) moveCursor(nxt);
        break;
      }
      default:
    }
  });
  scroller.addEventListener('focus', () => { if (!cursorKey) { const c = currentItem() || navItems()[0]; if (c) { cursorKey = c.key; paintAllStates(); } } });
  const onDocKey = (e) => {
    if (prefs.view === 'timeline' && root.isConnected && !e.metaKey && !e.ctrlKey && !e.altKey && ['-', '_', '+', '=', '0'].includes(e.key)) {
      const t0 = e.target;
      if (!(t0 && (t0.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t0.tagName)))) {
        e.preventDefault();
        if (e.key === '0') fitAxis(); else if (e.key === '-' || e.key === '_') zoomBy(1.6, 0.5); else zoomBy(1 / 1.6, 0.5);
        return;
      }
    }
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || !root.isConnected) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    search.focus();
    search.select();
  };
  document.addEventListener('keydown', onDocKey);

  /** Make sure the agent's row exists (unfold its hour / lane / parents) and is in view. */
  function revealAgent(a) {
    const g = `g:${a.sessionId}:`;
    if (!isLive(a)) {
      let root0 = a, hops = 0;
      while (root0.parentId && state.agents.has(root0.parentId) && hops++ < 50) { const p = state.agents.get(root0.parentId); if (p.sessionId !== a.sessionId) break; openOv.set(`a:${akey(p)}`, true); root0 = p; }
      const t = root0.startedAt;
      if (root0.startedAt >= startOfDay(Date.now())) openOv.set(`${g}${startOfHour(t)}`, true);
      else { openOv.set(`e:${a.sessionId}`, true); openOv.set(`${g}d${startOfDay(t)}`, true); }
    }
    openOv.set(`l:${a.sessionId}`, true);
    pendingReveal = akey(a);
  }
  let pendingReveal = null;
  function doReveal() {
    if (!pendingReveal) return;
    const it = items.find((x) => x.kind === 'agent' && akey(x.a) === pendingReveal);
    pendingReveal = null;
    if (!it) return;
    cursorKey = it.key;
    ensureVisible(it);
    renderWindow(false);
  }

  /* ---------- scroll / resize / clock ---------- */
  const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
  let framePending = false;
  const schedule = () => {
    if (framePending) return;
    framePending = true;
    raf(() => { framePending = false; renderWindow(false); if (prefs.view === 'timeline' && prefs.zoom === 'auto') requestFit(false); });
  };
  scroller.addEventListener('scroll', schedule, { passive: true });
  let lastW = 0;
  const onResize = () => {
    raf(() => {
      const w = scroller.clientWidth;
      if (prefs.view === 'timeline' && w !== lastW) { lastW = w; paintGridChrome(); }
      renderWindow(false);
    });
  };
  window.addEventListener('resize', onResize);
  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(onResize); ro.observe(scroller); }
  const clock = setInterval(() => {
    if (document.hidden) return;
    if (prefs.view === 'timeline') {
      if (hasLive) {
        if (prefs.zoom === 'auto') { clearTimeout(fitTimer); fitTimer = null; scale = toScale(fitRange(Date.now())); }
        paintGridChrome();
        renderWindow(true);
      }
    } else for (const el of vp.children) paintTimes(el);
  }, 1000);

  /* ---------- live pings ---------- */
  function pulse(a) {
    if (!sid || !vp.__keyed || reducedMotion() || prefs.view !== 'tree') return;
    let key = null;
    if (a.agentId) { const ag = state.agents.get(a.agentId); if (ag) key = `a:${akey(ag)}`; }
    const el = key && vp.__keyed.get(key);
    if (!el) return;
    el.classList.remove('ping'); void el.offsetWidth; el.classList.add('ping');
    setTimeout(() => el.classList.remove('ping'), 700);
  }
  const offActivity = onActivity(pulse);

  /* ---------- inspector ---------- */
  function resolveAgent() {
    if (selKey === 'main' || !sid) return null;
    return sel.agentsOfSession(sid).find((x) => akey(x) === selKey) || null;
  }

  function buildInspector() {
    if (insp) { insp.destroy(); insp = null; }
    inspector.textContent = '';
    if (!sid) return;
    const agent = resolveAgent();
    if (selKey !== 'main' && !agent) selKey = 'main';
    insp = agent ? buildAgentInspector(akey(agent)) : buildMainInspector();
    inspector.appendChild(insp.el);
    insp.update();
    inspector.scrollTop = 0;
  }

  function buildMainInspector() {
    const id = sid;
    const r = {};
    r.pulse = h('span', { class: 'pdot' });
    r.title = h('h2', { class: 'insp-title' });
    r.state = h('span', { class: 'status-pill' });
    r.cwd = h('div', { class: 'insp-sub mono' });
    r.model = modelBadge('');
    r.stats = h('div', { class: 'stat-grid' });
    r.nd = nowDoingLine();
    const tl = createTimeline({ getRows: () => sel.activityForSession(id), empty: 'No activity yet for this session' });
    const talk = createTalk({ sessionId: id, inline: true });
    const el = h('div', { class: 'insp-inner' },
      h('header', { class: 'insp-head' }, h('div', { class: 'insp-kicker mono' }, icon('cpu', 13), 'Main agent'),
        h('div', { class: 'insp-title-row' }, r.pulse, r.title), r.cwd, h('div', { class: 'badge-row' }, r.model, r.state)),
      r.nd, r.stats,
      h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('terminal', 14), 'Session timeline'), tl.el),
      h('section', { class: 'sheet-section talk-section' }, h('h3', { class: 'section-title' }, icon('chat', 14), 'Talk to this session'), talk.el));
    return {
      el,
      update() {
        const ses = state.sessions.get(id);
        if (!ses) return;
        r.pulse.className = `pdot ${ses.status}${ses.busy ? ' busy' : ''}`;
        setText(r.title, ses.title || cwdTail(ses.cwd) || ses.id);
        setText(r.cwd, ses.cwd || '');
        updateModelBadge(r.model, ses.model);
        setText(r.state, ses.busy ? 'Working' : ses.status === 'active' ? 'Active' : ses.status === 'idle' ? 'Idle' : 'Ended');
        r.state.className = `status-pill s-${ses.status}`;
        r.nd.__set(ses.nowDoing, ses.status === 'active' && ses.busy);
        const agents = sel.agentsOfSession(id);
        setStats(r.stats, [
          ['Started', fmtTime(ses.startedAt)],
          ['Agents', `${agents.filter((a) => a.status === 'running').length}/${agents.length}`],
          ['Tokens', fmtTokens(ses.tokens)],
          ['Spend', fmtUsd(ses.costUsd)],
        ]);
        tl.refresh();
      },
      destroy() { talk.destroy(); },
    };
  }

  function setStats(grid, entries) {
    reconcile(grid, entries, (e) => e[0], (e) => {
      const v = h('div', { class: 'stat-v mono' });
      const el = h('div', { class: 'stat' }, v, h('div', { class: 'stat-k' }, e[0]));
      el.__v = v; return el;
    }, (el, e) => setText(el.__v, e[1]));
  }

  function buildAgentInspector(key) {
    const r = {};
    r.av = avatar(null, 'lg');
    r.title = h('h2', { class: 'insp-title' });
    r.type = h('div', { class: 'insp-sub mono' });
    r.model = modelBadge('');
    r.state = h('span', { class: 'status-pill' });
    r.nd = nowDoingLine();
    r.stats = h('div', { class: 'stat-grid' });
    r.brief = h('p', { class: 'brief-text' });
    r.taskChip = h('button', { class: 'task-chip mono', type: 'button', hidden: true });
    r.recap = h('div', { class: 'recap' });
    r.recapWrap = h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('sparkle', 14), 'Recap'), r.recap);
    r.files = h('ul', { class: 'files mono' });
    r.filesWrap = h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('file', 14), 'Files'), r.files);
    r.promptSlot = h('div', {});
    r.needs = h('div', { class: 'needs-you-banner', role: 'status', hidden: true }, h('span', { class: 'needs-ring', 'aria-hidden': 'true' }), h('div', { class: 'needs-col' }, h('strong', {}, 'Waiting for you'), h('span', { class: 'needs-text' })));
    const currentAgent = () => sel.agentsOfSession(sid).find((x) => akey(x) === key) || null;
    const tl = createTimeline({ getRows: () => { const a = currentAgent(); return a ? sel.activityForAgent(a) : []; }, empty: 'Waiting for the first tool call…' });
    let promptTask = null;
    let prompt = null;

    const el = h('div', { class: 'insp-inner' },
      h('header', { class: 'insp-head' },
        h('div', { class: 'insp-kicker mono' }, 'Subagent'),
        h('div', { class: 'insp-title-row' }, r.av, r.title), r.type,
        h('div', { class: 'badge-row' }, r.model, r.state)),
      r.needs, r.nd, r.stats,
      h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, 'Task brief', r.taskChip), r.brief),
      h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('terminal', 14), 'Tool timeline'), tl.el),
      r.filesWrap, r.recapWrap, r.promptSlot);

    return {
      el,
      update() {
        const a = currentAgent();
        if (!a) return;
        const task = a.taskId ? state.tasks.get(a.taskId) : null;
        updateAvatar(r.av, a);
        setText(r.title, truncate(a.description || agentLabel(a), 120));
        setText(r.type, `${a.subagentType || 'agent'} · ${a.id.replace(/^pending:/, 'pending ')}`);
        updateModelBadge(r.model, a.model);
        r.state.className = `status-pill s-${a.status}`;
        setText(r.state, AGENT_STATUS[a.status] || a.status);
        const running = a.status === 'running';
        r.nd.__set(a.nowDoing, running);
        const waiting = a.status === 'waiting';
        setHidden(r.needs, !waiting);
        if (waiting) setText(r.needs.querySelector('.needs-text'), (sel.openQuestionForAgent(a.id) || {}).text || 'This agent is paused until you reply.');
        setStats(r.stats, [
          ['Started', fmtTime(a.startedAt)],
          ['Elapsed', fmtElapsed((running || waiting || a.status === 'stalled' ? Date.now() : (a.endedAt || a.lastActivityAt)) - a.startedAt)],
          ['Tools', String(a.toolCount)],
          ['Tokens', fmtTokens(a.tokens || (task && task.tokens))],
        ]);
        setText(r.brief, (task && task.description) || a.description || 'No brief recorded.');
        setHidden(r.taskChip, !task);
        if (task) { setText(r.taskChip, task.id); r.taskChip.onclick = () => openTask(task.id); }
        // files
        const files = (task && task.filesChanged) || [];
        setHidden(r.filesWrap, files.length === 0);
        reconcile(r.files, files, (f) => f, (f) => h('li', { title: f }, f), null);
        // recap
        const rc = task && task.recap;
        setHidden(r.recapWrap, !rc);
        if (rc) {
          const sig = JSON.stringify(rc);
          if (r.recap.__sig !== sig) {
            r.recap.__sig = sig;
            r.recap.textContent = '';
            for (const [k, v] of [['What', rc.what], ['How', rc.how], ['Learned', rc.learned]]) {
              r.recap.append(h('div', { class: 'recap-row' }, h('div', { class: 'recap-label' }, k), h('p', { class: 'recap-text' }, v || '—')));
            }
            if (rc.concepts && rc.concepts.length) r.recap.append(h('div', { class: 'tags' }, rc.concepts.map((c) => h('button', { class: 'tag', type: 'button', onclick: () => navigate('learn', [], { concept: c }) }, icon('tag', 12), c))));
          }
        }
        // prompt box
        const wantId = task ? task.id : null;
        if (wantId !== promptTask || !prompt && !wantId && !r.promptSlot.firstChild) {
          if (prompt) { prompt.destroy(); prompt = null; }
          r.promptSlot.textContent = '';
          promptTask = wantId;
          if (wantId) {
            prompt = createNotesPanel({ target: { kind: 'task', id: wantId }, mode: 'prompt', title: 'Prompt this task', placeholder: `Prompt ${wantId}…` });
            r.promptSlot.appendChild(prompt.el);
          } else {
            r.promptSlot.appendChild(h('div', { class: 'banner' }, icon('warning', 15), h('span', {}, 'This agent is not linked to a task, so it cannot be prompted from here.')));
          }
        }
        tl.refresh();
      },
      destroy() { if (prompt) prompt.destroy(); },
    };
  }

  /* ---------- render ---------- */
  function renderAll(selectionChanged) {
    const list = sessionList();
    const none = state.ready && list.length === 0;
    setHidden(empty, !none);
    setHidden(bar, none);
    setHidden(main, none);
    if (none || !sid) { if (insp) { insp.destroy(); insp = null; inspector.textContent = ''; } return; }
    // picker: "All sessions" + each session
    const sig = list.map((x) => `${x.id}|${x.title}|${x.status}`).join(';');
    if (picker.__sig !== sig) {
      picker.__sig = sig;
      picker.textContent = '';
      picker.appendChild(h('option', { value: 'all' }, `All sessions  ·  ${list.length}`));
      for (const x of list) {
        picker.appendChild(h('option', { value: x.id }, `${x.title || cwdTail(x.cwd) || x.id}  ·  ${x.status}`));
      }
    }
    const want = prefs.scopeAll ? 'all' : sid;
    if (picker.value !== want && document.activeElement !== picker) picker.value = want;
    rebuild();
    doReveal();
    paintAllStates();
    if (selectionChanged || !insp || (insp.key !== selKey)) {
      buildInspector();
      if (insp) insp.key = selKey;
    } else insp.update();
  }

  const renderSoon = frameBatch(() => renderAll(selKey !== 'main' && !resolveAgent()));

  function onStore(changed) {
    if (!sid && state.ready) { applyRoute(lastRoute); return; }
    if (sid && !state.sessions.has(sid) && state.ready) { applyRoute({ args: [] }); return; }
    const ra = lastRoute.args && lastRoute.args[1];
    if (sid && ra && selKey === 'main' && sel.agentsOfSession(sid).some((x) => x.id === ra || x.toolUseId === ra)) { applyRoute(lastRoute); return; }
    if (changed.has('activity') && !(changed.has('agent') || changed.has('session') || changed.has('task') || changed.has('note'))) {
      if (insp) insp.update();
      return;
    }
    renderSoon();
  }

  let lastRoute = { args: [] };
  return {
    watch: ['session', 'agent', 'task', 'project', 'activity', 'ui', 'ready', 'question'],
    update: onStore,
    setRoute(r) { lastRoute = r; applyRoute(r); },
    destroy() {
      offActivity(); clearInterval(clock); document.removeEventListener('keydown', onDocKey); document.removeEventListener('mousemove', onDragMove); document.removeEventListener('mouseup', onDragEnd); clearTimeout(fitTimer);
      window.removeEventListener('resize', onResize); if (ro) ro.disconnect();
      if (insp) insp.destroy(); root.remove();
    },
  };
}
