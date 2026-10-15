// views/today.js — Today: a Gantt of everything that ran on one day, across sessions, on a single time axis.
// Swimlane group per session (agents as bars), a Workflows group (runs with node-step ticks), task-event markers along the
// top, a summary strip, zoom/pan/Fit shared with the Threads timeline (axis.js), drag-to-select a range, and 1 fps live growth.
// Rows are virtualised: only the rows near the viewport exist in the DOM. Data comes from the store; per-session activity
// (markers, busy spans) is fetched once from /v1/sessions/:id/activity and then kept fresh by the SSE stream.
import { h, reconcile, setText, setClass, setHidden, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, ingestActivity } from '../store.js';
import { api } from '../api.js';
import { fmtUsd, fmtUsdSmall, fmtTokens, cwdTail, agentLabel, truncate, modelInfo, plural, sessionLabel } from '../format.js';
import { updateModelBadge, emptyState } from '../ui.js';
import { openTask, navigate, setArgs, route } from '../router.js';
import { bindTaskMenu } from '../taskmenu.js';
import {
  HOUR, FIT_MIN, fmtDur, fmtDurExact, fmtClockSec, toScale, pctOf, zoomedRange, paddedFit, paintTicks, attachPanZoom, MIN_SPAN,
} from '../axis.js';
import { buildDay, summarize, startOfDay, nextDay, dayKey, parseDayKey, isLiveAgent } from '../todaymodel.js';

const TOP = 56;                   // axis (32) + marker lane (24)
const BUF = 400;                  // px of rows rendered beyond the viewport
const ROW_H = { session: 48, agent: 28, wfhead: 32, run: 32, hint: 28 };
const AGENT_STATUS = { running: 'Running', done: 'Done', failed: 'Failed', stalled: 'Stalled', waiting: 'Waiting for you' };
const MARK = { done: 'Done', review: 'Review', blocked: 'Blocked', auto: 'Auto-started' };
const RUN_STATUS = { running: 'Running', waiting: 'Waiting', paused: 'Paused', done: 'Done', failed: 'Failed', aborted: 'Aborted' };
const MODEL_ORDER = ['sonnet', 'haiku', 'opus', 'other'];
const MODEL_LABEL = { sonnet: 'Sonnet', haiku: 'Haiku', opus: 'Opus', other: 'other' };
const dayLabel = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

export function mount(container, initialRoute) {
  startTicker();
  let dayStart = startOfDay(Date.now());
  let isTodayRoute = true;
  let day = null;
  let items = [];                 // flat virtual rows { key, kind, y, h, ... }
  let totalH = TOP + 16;
  let mode = 'fit';               // fit | day | manual
  let scale = { t0: Date.now() - HOUR, t1: Date.now(), span: HOUR };
  const folded = new Set();       // row keys folded by the user
  const fetched = new Set();      // session ids whose activity has been loaded
  let fetching = false;
  let rangeSel = null;            // { a, b } selected time range
  let agentSig = '';
  let lastPaint = 0;
  let paintTimer = null;
  let destroyed = false;

  /* ---------- structure ---------- */
  const prevBtn = h('button', { class: 'td-btn', type: 'button', title: 'Previous day', 'aria-label': 'Previous day', onclick: () => stepDay(-1) }, icon('chevronLeft', 14));
  const nextBtn = h('button', { class: 'td-btn', type: 'button', title: 'Next day', 'aria-label': 'Next day', onclick: () => stepDay(1) }, icon('chevronRight', 14));
  const daySel = h('select', { class: 'select select-sm td-day', 'aria-label': 'Day', onchange: () => gotoKey(daySel.value) });
  const todayBtn = h('button', { class: 'td-btn td-today', type: 'button', title: 'Jump to today', onclick: () => gotoKey(dayKey(Date.now())) }, 'Today');
  const zoomSpan = h('span', { class: 'td-zoom-span mono', 'aria-live': 'off' });
  const zbtn = (label, title, fn, cls) => h('button', { class: `td-seg-btn ${cls || ''}`.trim(), type: 'button', title, 'aria-label': title, onclick: fn }, label);
  const fitBtn = zbtn('Fit', 'Fit the axis to the first and last activity (0)', () => fitAxis(), 'td-fit');
  const dayBtn = zbtn('Day', 'Show the whole day, midnight to now', () => showDay(), 'td-dayb');
  const nowBtn = zbtn('Now', 'Jump to now (N)', () => jumpNow(), 'td-nowb');
  const zoomSeg = h('div', { class: 'td-seg', role: 'group', 'aria-label': 'Timeline zoom' },
    zbtn('−', 'Zoom out (-)', () => zoomBy(1.6, 0.5)), zbtn('+', 'Zoom in (+)', () => zoomBy(1 / 1.6, 0.5)), fitBtn, dayBtn, nowBtn);
  const scopeNote = h('span', { class: 'td-scope mono' });
  const bar = h('div', { class: 'td-bar' },
    h('div', { class: 'td-bar-row' },
      h('span', { class: 'td-heading' }, icon('calendar', 16), h('span', {}, 'Today')),
      h('div', { class: 'td-days' }, prevBtn, daySel, nextBtn, todayBtn), scopeNote, h('span', { class: 'td-grow' }), zoomSpan, zoomSeg));

  const tiles = {};
  const tile = (key, label, wide) => {
    const v = h('span', { class: 'td-tile-v mono' }, '0');
    const sub = h('span', { class: 'td-tile-sub mono' });
    const el = h('div', { class: `td-tile${wide ? ' wide' : ''}`, 'data-k': key }, h('span', { class: 'td-tile-k' }, label), v, sub);
    tiles[key] = { el, v, sub };
    return el;
  };
  const summaryEl = h('div', { class: 'td-summary', role: 'group', 'aria-label': 'Day summary' },
    tile('agents', 'Agents run'), tile('time', 'Agent time'), tile('peak', 'Peak concurrency'), tile('done', 'Tasks done'),
    tile('cost', 'Helm overhead'), tile('longest', 'Longest task', true));

  const axisTicks = h('div', { class: 'td-axis-ticks' });
  const axisNow = h('i', { class: 'td-axis-now' }, 'now');
  const axisPlot = h('div', { class: 'td-axis-plot' }, axisTicks, axisNow);
  const axis = h('div', { class: 'td-axis mono', 'aria-hidden': 'true' }, h('div', { class: 'td-axis-l' }, 'Time'), axisPlot);
  const mkLane = h('div', { class: 'td-mk-plot' });
  const mkRow = h('div', { class: 'td-mk mono', role: 'group', 'aria-label': 'Task events' }, h('div', { class: 'td-axis-l' }, 'Task events'), mkLane);
  const sticky = h('div', { class: 'td-sticky' }, axis, mkRow);
  const grid = h('div', { class: 'td-grid', 'aria-hidden': 'true' });
  const nowLine = h('i', { class: 'td-nowline' });
  grid.appendChild(nowLine);
  const over = h('div', { class: 'td-over', 'aria-hidden': 'true' });
  const rangeEl = h('div', { class: 'td-range', hidden: true });
  over.appendChild(rangeEl);
  const vp = h('div', { class: 'td-vp', role: 'list', 'aria-label': 'Sessions and agents' });
  const sizer = h('div', { class: 'td-sizer' }, grid, vp, over);
  const scroller = h('div', { class: 'td-scroll', tabindex: '0', 'aria-label': 'Day timeline' }, sticky, sizer);
  const tip = h('div', { class: 'td-tip mono', role: 'tooltip', hidden: true });
  const rsum = h('div', { class: 'td-rsum', role: 'status', hidden: true });
  const emptyEl = h('div', { class: 'td-empty', hidden: true }, emptyState({ iconName: 'calendar', title: 'Nothing ran on this day', body: 'Agents, workflow runs and task events show up here as they happen.' }));
  const legend = h('div', { class: 'td-legend mono' },
    h('span', {}, '← → pan'), h('span', {}, '+ − zoom'), h('span', {}, '0 fit'), h('span', {}, 'N now'), h('span', {}, 'drag to select a range'),
    h('span', { class: 'td-grow' }),
    h('span', { class: 'td-key done' }, '◆ done'), h('span', { class: 'td-key review' }, '◆ review'), h('span', { class: 'td-key blocked' }, '◆ blocked'), h('span', { class: 'td-key auto' }, '◇ auto-start'));
  const pane = h('div', { class: 'td-pane' }, scroller, emptyEl, rsum, tip);
  const root = h('div', { class: 'today' }, bar, summaryEl, pane, legend);
  root.__today = { scale: () => scale, day: () => day, mode: () => mode, range: () => rangeSel }; // read-only peek for tests
  container.appendChild(root);

  /* ---------- helpers ---------- */
  const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
  const plotRect = () => axisPlot.getBoundingClientRect();
  const plotWidth = () => { const w = plotRect().width; return w > 0 ? w : Math.max(300, (scroller.clientWidth || 900) - 264); };
  const pct = (t) => `${pctOf(scale, t).toFixed(3)}%`;
  const todayStart = () => startOfDay(Date.now());
  const isToday = () => dayStart === todayStart();

  /* ---------- day + routing ---------- */
  function readDay(r) {
    const arg = r && r.args && r.args[0];
    const p = arg ? parseDayKey(arg) : null;
    isTodayRoute = !p;
    return p == null ? todayStart() : p;
  }
  function gotoKey(key) {
    if (key === dayKey(Date.now())) setArgs([]); else setArgs([key]);
  }
  function stepDay(dir) {
    const d = new Date(dayStart);
    d.setDate(d.getDate() + dir);
    const t = d.getTime();
    if (t > todayStart()) return;
    gotoKey(dayKey(t));
  }

  /* ---------- data ---------- */
  function collect(now) {
    const sessions = sel.scopedSessions();
    const agents = Array.from(state.agents.values());
    const tasks = Array.from(state.tasks.values()).filter((t) => sel.inScope(t) && !String(t.id).startsWith('tmp-'));
    const runs = Array.from(state.runs.values()).filter(sel.inScope);
    const a = dayStart, b = nextDay(dayStart);
    const activity = [];
    for (const r of state.activity.values()) if (r.at >= a && r.at < b) activity.push(r);
    return buildDay({ dayStart, now, sessions, agents, tasks, runs, activity });
  }

  function knownDays() {
    const keys = new Map();
    const add = (t) => { if (!t) return; const k = dayKey(t); keys.set(k, (keys.get(k) || 0) + 1); };
    for (const a of state.agents.values()) add(a.startedAt);
    for (const r of state.runs.values()) add(r.startedAt);
    const now = Date.now();
    if (!keys.has(dayKey(now))) keys.set(dayKey(now), 0);
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (!keys.has(dayKey(y.getTime()))) keys.set(dayKey(y.getTime()), 0);
    if (!keys.has(dayKey(dayStart))) keys.set(dayKey(dayStart), 0);
    return Array.from(keys.entries()).sort((x, y2) => (x[0] < y2[0] ? 1 : -1));
  }

  async function loadActivity() {
    if (fetching || destroyed) return;
    const a = dayStart, b = nextDay(dayStart);
    const withAgents = new Set();
    for (const g of day ? day.groups : []) if (g.rows.length) withAgents.add(g.session.id);
    const cand = sel.scopedSessions()
      .filter((s) => !fetched.has(s.id) && (s.lastSeenAt || 0) >= a && (s.startedAt || 0) < b)
      .sort((x, y) => (withAgents.has(y.id) ? 1 : 0) - (withAgents.has(x.id) ? 1 : 0) || (y.lastSeenAt || 0) - (x.lastSeenAt || 0))
      .slice(0, 40);
    if (!cand.length) return;
    fetching = true;
    try {
      for (let i = 0; i < cand.length; i += 4) {
        const batch = cand.slice(i, i + 4);
        for (const s of batch) fetched.add(s.id);
        const res = await Promise.all(batch.map((s) => api.sessionActivity(s.id, 1000).catch(() => null)));
        if (destroyed) return;
        const rows = [];
        for (const r of res) if (r && Array.isArray(r.activity)) rows.push(...r.activity);
        if (rows.length) ingestActivity(rows, false);
      }
    } finally { fetching = false; }
    if (!destroyed) requestPaint(true);
  }

  /* ---------- scale: fit / day / manual ---------- */
  function fitRange(now) {
    if (day && day.range) {
      return paddedFit(day.range.first, day.range.last, now, day.isToday && day.live);
    }
    return dayRange(now);
  }
  function dayRange(now) {
    const end = nextDay(dayStart);
    if (isToday()) return { t0: dayStart, t1: Math.max(now, dayStart + FIT_MIN) };
    return { t0: dayStart, t1: end };
  }
  function applyScale(r) { scale = toScale(r); paintChrome(); renderWindow(true); }
  function setMode(m) { mode = m; paintZoomUi(); }
  function setManual(t0, span) {
    span = Math.max(MIN_SPAN, Math.min(7 * 86400e3, span));
    setMode('manual');
    applyScale({ t0, t1: t0 + span });
  }
  function zoomBy(factor, frac) { const z = zoomedRange(scale, factor, frac); setManual(z.t0, z.span); }
  function panBy(frac) { setManual(scale.t0 + frac * scale.span, scale.span); }
  function fitAxis() { setMode('fit'); applyScale(fitRange(Date.now())); }
  function showDay() { setMode('day'); applyScale(dayRange(Date.now())); }
  function jumpNow() {
    if (!isToday()) { setArgs([]); return; }
    const now = Date.now();
    setManual(now - scale.span * 0.5, scale.span);
  }
  const detachPanZoom = attachPanZoom({
    scroller, axisEl: axis,
    api: { getScale: () => scale, setManual, zoomBy, plotRect, enabled: () => true },
  });

  /* ---------- rows ---------- */
  function buildItems() {
    items = [];
    let y = TOP;
    const push = (it) => { it.y = y; it.h = ROW_H[it.kind]; y += it.h; items.push(it); };
    for (const g of day.groups) {
      const key = `s:${g.session.id}`;
      const open = !folded.has(key);
      push({ key, kind: 'session', g, open });
      if (!open) continue;
      if (!g.rows.length) push({ key: `${key}:none`, kind: 'hint', text: day.isToday ? 'No agents yet today' : 'No agents ran' });
      for (const r of g.rows) push({ key: `a:${r.agent.id}`, kind: 'agent', r });
    }
    if (day.runRows.length) {
      const key = 'wf';
      const open = !folded.has(key);
      push({ key, kind: 'wfhead', count: day.runRows.length, open });
      if (open) for (const r of day.runRows) push({ key: `r:${r.run.id}`, kind: 'run', r });
    }
    totalH = y + 16;
    sizer.style.height = `${totalH}px`;
  }

  const modelOf = (a) => modelInfo(a.model).key;
  const taskTitle = (a) => {
    const t = a.taskId ? state.tasks.get(a.taskId) : null;
    return (t && t.title) || a.description || agentLabel(a);
  };

  function makeRow(it) {
    const r = {};
    let el;
    if (it.kind === 'session') {
      r.tog = h('span', { class: 'td-tog', 'aria-hidden': 'true' }, icon('chevronDown', 14));
      r.dot = h('span', { class: 'pdot' });
      r.title = h('span', { class: 'td-s-title' });
      r.badge = h('span', { class: 'badge' });
      r.sub = h('span', { class: 'td-s-sub mono' });
      r.spans = h('div', { class: 'td-spans' });
      el = h('div', { class: 'td-row td-session', role: 'listitem' },
        h('div', { class: 'td-lbl' }, r.tog, r.dot, h('span', { class: 'td-s-text' }, h('span', { class: 'td-s-l1' }, r.title, r.badge), r.sub)),
        h('div', { class: 'td-plot' }, r.spans));
    } else if (it.kind === 'agent') {
      r.dot = h('span', { class: 'td-dot', 'aria-hidden': 'true' });
      r.tid = h('button', { class: 'td-tid mono', type: 'button' }, h('span', { class: 'sdot', 'aria-hidden': 'true' }), h('span', { class: 'td-tid-t' }));
      bindTaskMenu(r.tid, () => state.tasks.get(r.tid.__task));
      r.title = h('span', { class: 'td-title' });
      r.badge = h('span', { class: 'badge' });
      r.bar = h('i', { class: 'td-bar-el' });
      el = h('div', { class: 'td-row td-agent', role: 'listitem' },
        h('div', { class: 'td-lbl' }, r.dot, r.tid, r.title, r.badge), h('div', { class: 'td-plot' }, r.bar));
    } else if (it.kind === 'wfhead') {
      r.tog = h('span', { class: 'td-tog', 'aria-hidden': 'true' }, icon('chevronDown', 14));
      r.label = h('span', { class: 'td-w-label' });
      el = h('div', { class: 'td-row td-wfhead', role: 'listitem' }, h('div', { class: 'td-lbl' }, r.tog, icon('workflow', 14), r.label), h('div', { class: 'td-plot' }));
    } else if (it.kind === 'run') {
      r.dot = h('span', { class: 'td-dot', 'aria-hidden': 'true' });
      r.id = h('span', { class: 'td-rid mono' });
      r.title = h('span', { class: 'td-title' });
      r.bar = h('i', { class: 'td-bar-el run' });
      r.ticks = h('div', { class: 'td-ticks' });
      el = h('div', { class: 'td-row td-run', role: 'listitem' }, h('div', { class: 'td-lbl' }, r.dot, r.id, r.title), h('div', { class: 'td-plot' }, r.bar, r.ticks));
    } else {
      r.text = h('span', {});
      el = h('div', { class: 'td-row td-hint', role: 'listitem' }, h('div', { class: 'td-lbl' }, r.text), h('div', { class: 'td-plot' }));
    }
    el.__r = r;
    return el;
  }

  function setBar(bar, t0, t1) {
    bar.style.left = `${pctOf(scale, t0).toFixed(3)}%`;
    bar.style.width = `${Math.max(0, ((t1 - t0) / scale.span) * 100).toFixed(3)}%`;
  }

  function updateRow(el, it) {
    el.__d = it;
    const r = el.__r;
    el.style.transform = `translateY(${it.y}px)`;
    const hpx = `${it.h}px`;
    if (el.style.height !== hpx) el.style.height = hpx;
    const now = Date.now();
    if (it.kind === 'session') {
      const s = it.g.session;
      setClass(el, 'folded', !it.open);
      el.setAttribute('aria-expanded', String(it.open));
      r.dot.className = `pdot ${s.status}`;
      setText(r.title, sessionLabel(s));
      updateModelBadge(r.badge, s.model);
      const cost = Number(s.costUsd) || 0;
      const costTxt = day.isToday ? (cost ? `${fmtUsd(cost)} today` : '') : (cost ? `${fmtUsd(cost)} session total` : '');
      const n = it.g.rows.length;
      setText(r.sub, [sel.projectName(s.projectId), costTxt, n ? plural(n, 'agent') : ''].filter(Boolean).join(' · '));
      // active spans: when the main session was busy
      const spans = it.g.spans;
      while (r.spans.children.length > spans.length) r.spans.lastChild.remove();
      while (r.spans.children.length < spans.length) r.spans.appendChild(h('i', { class: 'td-span' }));
      spans.forEach((sp, i) => {
        const c = r.spans.children[i];
        setBar(c, sp.t0, sp.t1);
        c.__tip = { kind: 'span', sp, s };
      });
    } else if (it.kind === 'agent') {
      const a = it.r.agent;
      const live = it.r.live;
      el.className = `td-row td-agent st-${a.status}${live ? ' live' : ''}`;
      el.dataset.sid = a.sessionId;
      setClass(el, 'selected', !!a.taskId && route().task === a.taskId);
      setText(r.title, truncate(taskTitle(a), 80));
      updateModelBadge(r.badge, a.model);
      const t = a.taskId ? state.tasks.get(a.taskId) : null;
      r.tid.hidden = !t;
      if (t) {
        r.tid.firstChild.className = `sdot st-${t.status}`;
        setText(r.tid.lastChild, t.id);
        r.tid.title = `${t.id} · ${t.title} — open details and chat`;
        r.tid.__task = t.id;
      }
      setBar(r.bar, it.r.t0, it.r.t1);
      r.bar.className = `td-bar-el m-${modelOf(a)}`;
      el.setAttribute('aria-label', `${agentLabel(a)} ${AGENT_STATUS[a.status] || a.status}: ${taskTitle(a)}, ${fmtDur(it.r.t1 - it.r.t0)}`);
    } else if (it.kind === 'wfhead') {
      setClass(el, 'folded', !it.open);
      el.setAttribute('aria-expanded', String(it.open));
      setText(r.label, `Workflows · ${plural(it.count, 'run')}`);
    } else if (it.kind === 'run') {
      const run = it.r.run;
      el.className = `td-row td-run rs-${run.status}${it.r.live ? ' live' : ''}`;
      const wf = state.workflows.get(run.workflowId);
      setText(r.id, run.id);
      setText(r.title, truncate((wf && wf.name) || run.workflowId, 60));
      setBar(r.bar, it.r.t0, it.r.t1);
      const nodes = it.r.nodes;
      while (r.ticks.children.length > nodes.length) r.ticks.lastChild.remove();
      while (r.ticks.children.length < nodes.length) r.ticks.appendChild(h('i', { class: 'td-tick' }));
      nodes.forEach((n, i) => {
        const c = r.ticks.children[i];
        c.className = `td-tick ns-${n.node.state}`;
        c.style.left = pct(n.t0);
        c.style.width = n.t1 > n.t0 ? `${Math.max(0, ((n.t1 - n.t0) / scale.span) * 100).toFixed(3)}%` : '';
        c.__tip = { kind: 'node', n, run };
      });
      el.setAttribute('aria-label', `Workflow run ${run.id} ${RUN_STATUS[run.status] || run.status}`);
    } else {
      setText(r.text, it.text);
    }
    void now;
  }

  function renderWindow(force) {
    if (!day) return;
    const st = scroller.scrollTop, vh = scroller.clientHeight || 640;
    const lo = st - BUF, hi = st + vh + BUF;
    let a = 0, b = items.length;
    while (a < b) { const m = (a + b) >> 1; if (items[m].y + items[m].h < lo) a = m + 1; else b = m; }
    const vis = [];
    for (let i = a; i < items.length && items[i].y <= hi; i++) vis.push(items[i]);
    reconcile(vp, vis, (it) => it.key, (it) => makeRow(it), (el, it) => updateRow(el, it));
    void force;
  }

  /* ---------- chrome: axis, grid, markers, summary ---------- */
  function paintChrome() {
    if (!day) return;
    paintTicks({ ticksEl: axisTicks, gridEl: grid, beforeEl: nowLine, scale, width: plotWidth(), tickClass: 'td-axis-tick', gridClass: 'td-gridline' });
    const nowT = Date.now();
    const nowIn = day.isToday && nowT >= scale.t0 && nowT <= scale.t1;
    nowLine.style.left = pct(nowT);
    axisNow.style.left = pct(nowT);
    nowLine.hidden = axisNow.hidden = !nowIn;
    setClass(axisNow, 'pinned', mode === 'fit' && day.live);
    // markers in view (plus a small margin so a diamond does not pop at the edge)
    const m0 = scale.t0 - scale.span * 0.02, m1 = scale.t1 + scale.span * 0.02;
    const ms = day.markers.filter((m) => m.t >= m0 && m.t <= m1);
    reconcile(mkLane, ms, (m) => m.key, (m) => {
      const el = h('button', { class: `td-diamond k-${m.kind}`, type: 'button' });
      el.addEventListener('click', (e) => { e.stopPropagation(); if (el.__m) openTask(el.__m.taskId); });
      return el;
    }, (el, m) => {
      el.__m = m;
      el.__tip = { kind: 'marker', m };
      el.style.left = pct(m.t);
      const t = state.tasks.get(m.taskId);
      el.setAttribute('aria-label', `${m.taskId} ${MARK[m.kind]}${t ? ': ' + t.title : ''}`);
    });
    paintRange();
    paintZoomUi();
  }

  function paintZoomUi() {
    const names = { fit: 'Fit', day: 'Day', manual: 'Manual' };
    zoomSpan.textContent = `${names[mode]} · ${fmtDur(scale.span)}`;
    zoomSeg.dataset.mode = mode;
    fitBtn.setAttribute('aria-pressed', String(mode === 'fit'));
    dayBtn.setAttribute('aria-pressed', String(mode === 'day'));
    setClass(fitBtn, 'paused', mode === 'manual');
    nowBtn.hidden = !isToday();
  }

  function longestChip(lg) {
    if (!lg) return [h('span', { class: 'td-dim' }, '—')];
    const t = lg.taskId ? state.tasks.get(lg.taskId) : null;
    if (!t) return [h('span', {}, truncate(lg.taskId || 'agent', 32))];
    const b = h('button', { class: 'td-tid mono', type: 'button', title: `${t.id} · ${t.title} — open details and chat`, onclick: () => openTask(t.id) },
      h('span', { class: `sdot st-${t.status}`, 'aria-hidden': 'true' }), t.id);
    bindTaskMenu(b, () => state.tasks.get(t.id));
    return [b, h('span', { class: 'td-long-t' }, truncate(t.title, 44))];
  }

  function paintSummary() {
    const sm = day.summary;
    setText(tiles.agents.v, String(sm.count));
    setText(tiles.agents.sub, MODEL_ORDER.filter((k) => sm.byModel[k]).map((k) => `${sm.byModel[k]} ${MODEL_LABEL[k]}`).join(' · ') || 'none');
    setText(tiles.time.v, fmtDur(sm.ms));
    setText(tiles.time.sub, 'summed across agents');
    setText(tiles.peak.v, String(sm.peak));
    setText(tiles.peak.sub, sm.peak ? `at ${fmtClockSec(sm.peakAt)}${sm.peakUntil && sm.peakUntil - sm.peakAt >= 1000 ? ` for ${fmtDur(sm.peakUntil - sm.peakAt)}` : ''}` : 'no agents');
    setText(tiles.done.v, String(sm.tasksDone));
    setText(tiles.done.sub, day.isToday ? 'today' : dayLabel(dayStart));
    const u = state.usageToday || {};
    if (day.isToday) {
      setText(tiles.cost.v, fmtUsdSmall(u.overheadUsd || 0));
      setText(tiles.cost.sub, `${fmtUsdSmall(u.requestedUsd || 0)} requested`);
    } else { setText(tiles.cost.v, '—'); setText(tiles.cost.sub, 'cost is tracked for today'); }
    const lg = sm.longest;
    setText(tiles.longest.v, lg ? fmtDur(lg.ms) : '—');
    tiles.longest.sub.textContent = '';
    tiles.longest.sub.append(...longestChip(lg));
    setText(tiles.agents.el.firstChild, day.isToday ? 'Agents run today' : 'Agents run');
  }

  function paintDays() {
    const days = knownDays();
    const sig = days.map((d) => `${d[0]}:${d[1]}`).join('|') + '@' + dayKey(dayStart);
    if (daySel.__sig !== sig) {
      daySel.__sig = sig;
      daySel.textContent = '';
      const nowKey = dayKey(Date.now());
      const y = new Date(); y.setDate(y.getDate() - 1);
      for (const [k, n] of days) {
        const t = parseDayKey(k);
        const lbl = k === nowKey ? 'Today' : k === dayKey(y.getTime()) ? 'Yesterday' : dayLabel(t);
        daySel.appendChild(h('option', { value: k }, `${lbl} · ${dayLabel(t)}${n ? ` · ${plural(n, 'agent')}` : ''}`));
      }
    }
    if (document.activeElement !== daySel) daySel.value = dayKey(dayStart);
    nextBtn.disabled = dayStart >= todayStart();
    setHidden(todayBtn, isToday());
    const p = sel.scopeProject();
    setText(scopeNote, p ? p.name : 'All projects');
  }

  /* ---------- paint orchestration ---------- */
  function paintNow() {
    if (destroyed) return;
    lastPaint = Date.now();
    const now = Date.now();
    dayStart = isTodayRoute ? startOfDay(now) : dayStart;
    day = collect(now);
    agentSig = `${state.agents.size}|${Array.from(state.agents.values()).filter(isLiveAgent).length}|${state.runs.size}`;
    if (mode === 'fit') scale = toScale(fitRange(now));
    else if (mode === 'day') scale = toScale(dayRange(now));
    buildItems();
    paintDays();
    paintSummary();
    const none = state.ready && !day.groups.length && !day.runRows.length && !day.markers.length;
    setHidden(emptyEl, !none);
    if (none) setText(emptyEl.querySelector('.empty-title'), isToday() ? 'Nothing has run today yet' : `Nothing ran on ${dayLabel(dayStart)}`);
    paintChrome();
    renderWindow(true);
    paintRangeSummary();
    loadActivity();
  }
  /** Immediate repaint (new agents, user actions) or at most ~1 fps while only growth/ticks are happening. */
  function requestPaint(immediate) {
    if (immediate) { clearTimeout(paintTimer); paintTimer = null; paintNow(); return; }
    const wait = 1000 - (Date.now() - lastPaint);
    if (wait <= 0) paintNow();
    else if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = null; paintNow(); }, wait);
  }

  /* ---------- range selection ---------- */
  const timeAt = (clientX) => {
    const r = plotRect();
    const f = r.width > 0 ? (clientX - r.left) / r.width : 0.5;
    return scale.t0 + Math.min(1, Math.max(0, f)) * scale.span;
  };
  function paintRange() {
    if (!rangeSel) { rangeEl.hidden = true; return; }
    rangeEl.hidden = false;
    const l = pctOf(scale, rangeSel.a), r = pctOf(scale, rangeSel.b);
    rangeEl.style.left = `${l.toFixed(3)}%`;
    rangeEl.style.width = `${Math.max(0, r - l).toFixed(3)}%`;
  }
  function paintRangeSummary() {
    if (!rangeSel || !day) { rsum.hidden = true; return; }
    const { a, b } = rangeSel;
    const doneAt = day.markers.filter((m) => m.kind === 'done').map((m) => m.t);
    const sm = summarize({ agents: day.items, doneAt, a, b });
    const mk = day.markers.filter((m) => m.t >= a && m.t <= b);
    const models = MODEL_ORDER.filter((k) => sm.byModel[k]).map((k) => `${sm.byModel[k]} ${MODEL_LABEL[k]}`).join(' · ');
    const kv = (k, v) => h('div', { class: 'td-rs-kv' }, h('span', { class: 'td-rs-k' }, k), h('span', { class: 'td-rs-v mono' }, v));
    rsum.textContent = '';
    rsum.append(
      h('div', { class: 'td-rs-head' },
        h('span', { class: 'td-rs-title mono' }, `${fmtClockSec(a)} → ${fmtClockSec(b)}`),
        h('span', { class: 'td-rs-dur mono' }, fmtDur(b - a)),
        h('button', { class: 'td-btn', type: 'button', title: 'Zoom to this range', 'aria-label': 'Zoom to this range', onclick: () => { const r2 = rangeSel; clearRange(); if (r2) setManual(r2.a, r2.b - r2.a); } }, icon('fit', 14)),
        h('button', { class: 'td-btn', type: 'button', title: 'Clear selection (Esc)', 'aria-label': 'Clear selection', onclick: clearRange }, icon('close', 14))),
      kv('Agents', `${sm.count}${models ? ` (${models})` : ''}`),
      kv('Agent time', fmtDur(sm.ms)),
      kv('Peak concurrency', sm.peak ? `${sm.peak} at ${fmtClockSec(sm.peakAt)}` : '0'),
      kv('Tasks done', String(sm.tasksDone)),
      kv('Task events', String(mk.length)));
    rsum.hidden = false;
  }
  function clearRange() { rangeSel = null; paintRange(); paintRangeSummary(); }

  let selDrag = null;
  scroller.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (t.closest && t.closest('.td-sticky, .td-bar-el, .td-tid, .td-tick, .td-diamond, button, select, input, .td-lbl')) return;
    const r = plotRect();
    if (e.clientX < r.left || e.clientX > r.left + r.width) return;
    e.preventDefault();
    scroller.focus({ preventScroll: true });
    selDrag = { x: e.clientX, t: timeAt(e.clientX), moved: false };
  });
  const onSelMove = (e) => {
    if (!selDrag) return;
    if (!selDrag.moved && Math.abs(e.clientX - selDrag.x) < 4) return;
    selDrag.moved = true;
    const t = timeAt(e.clientX);
    rangeSel = { a: Math.min(selDrag.t, t), b: Math.max(selDrag.t, t) };
    paintRange();
    tip.hidden = true;
  };
  const onSelEnd = () => {
    if (!selDrag) return;
    const moved = selDrag.moved;
    selDrag = null;
    if (!moved) { clearRange(); return; }
    if (rangeSel && rangeSel.b - rangeSel.a < 1000) { clearRange(); return; }
    paintRangeSummary();
  };
  document.addEventListener('mousemove', onSelMove);
  document.addEventListener('mouseup', onSelEnd);

  /* ---------- interaction: click, tooltip, keyboard ---------- */
  vp.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('.td-row');
    if (!el || !el.__d) return;
    const it = el.__d;
    if (it.kind === 'session' || it.kind === 'wfhead') {
      if (folded.has(it.key)) folded.delete(it.key); else folded.add(it.key);
      requestPaint(true);
    } else if (it.kind === 'agent') {
      const id = it.r.agent.taskId;
      if (id && state.tasks.has(id)) openTask(id);
    } else if (it.kind === 'run') {
      navigate('workflows', [], { run: it.r.run.id });
    }
  });

  const fmtTimes = (t0, t1, live) => `${fmtClockSec(t0)} → ${live ? 'now' : fmtClockSec(t1)}`;
  function tipFor(target) {
    const spanEl = target.closest && target.closest('.td-span, .td-tick, .td-diamond');
    if (spanEl && spanEl.__tip) {
      const t = spanEl.__tip;
      if (t.kind === 'span') {
        return [h('div', { class: 'td-tip-title' }, 'Main session busy'), h('div', {}, `${fmtClockSec(t.sp.t0)} → ${fmtClockSec(t.sp.t1)}`), h('div', {}, `Duration ${fmtDur(t.sp.t1 - t.sp.t0)} · from tool calls of the main session`)];
      }
      if (t.kind === 'node') {
        const n = t.n.node;
        return [h('div', { class: 'td-tip-title' }, `${t.run.id} · ${n.nodeId}`), h('div', {}, `${n.state}${n.attempt > 1 ? ` · attempt ${n.attempt}` : ''}`),
          h('div', {}, fmtTimes(t.n.t0, t.n.t1, n.state === 'running')), n.costUsd ? h('div', {}, `${fmtUsdSmall(n.costUsd)}`) : null, n.error ? h('div', {}, truncate(n.error, 100)) : null];
      }
      if (t.kind === 'marker') {
        const tk = state.tasks.get(t.m.taskId);
        return [h('div', { class: 'td-tip-title' }, `${t.m.taskId} · ${MARK[t.m.kind]}`), tk ? h('div', {}, truncate(tk.title, 100)) : null, h('div', {}, fmtClockSec(t.m.t))];
      }
    }
    const rowEl = target.closest && target.closest('.td-row');
    if (!rowEl || !rowEl.__d) return null;
    const it = rowEl.__d;
    if (it.kind === 'agent' && target.closest('.td-plot, .td-lbl')) {
      const a = it.r.agent;
      const t = a.taskId ? state.tasks.get(a.taskId) : null;
      const recap = t && t.recap && t.recap.what ? truncate(t.recap.what, 160) : '';
      return [
        h('div', { class: 'td-tip-title' }, truncate(taskTitle(a), 90)),
        h('div', {}, `${AGENT_STATUS[a.status] || a.status} · ${modelInfo(a.model).label} · ${agentLabel(a)}${a.taskId ? ` · ${a.taskId}` : ''}`),
        h('div', {}, fmtTimes(it.r.t0, it.r.t1, it.r.live)),
        h('div', {}, `Duration ${fmtDurExact(it.r.t1 - it.r.t0)}${it.r.live ? ' so far' : ''}`),
        h('div', {}, `${plural(a.toolCount || 0, 'tool')} · ${fmtTokens(a.tokens || 0)} tokens`),
        recap ? h('div', { class: 'td-tip-recap' }, recap) : null,
      ];
    }
    if (it.kind === 'run') {
      const run = it.r.run;
      return [h('div', { class: 'td-tip-title' }, `${run.id} · ${RUN_STATUS[run.status] || run.status}`), h('div', {}, fmtTimes(it.r.t0, it.r.t1, it.r.live)),
        h('div', {}, `Duration ${fmtDurExact(it.r.t1 - it.r.t0)}${it.r.live ? ' so far' : ''}`), h('div', {}, `${plural(run.nodes.length, 'step')}${run.costUsd ? ` · ${fmtUsdSmall(run.costUsd)}` : ''}`)];
    }
    return null;
  }
  const showTip = (e) => {
    if (selDrag && selDrag.moved) { tip.hidden = true; return; }
    const body = tipFor(e.target);
    if (!body) { tip.hidden = true; return; }
    tip.textContent = '';
    tip.append(...body.filter(Boolean));
    tip.hidden = false;
    const pr = pane.getBoundingClientRect();
    const w = tip.offsetWidth || 260, hh = tip.offsetHeight || 80;
    let x = e.clientX - pr.left + 14, y = e.clientY - pr.top + 16;
    if (x + w > pr.width - 8) x = Math.max(8, e.clientX - pr.left - w - 14);
    if (y + hh > pr.height - 8) y = Math.max(8, e.clientY - pr.top - hh - 12);
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  };
  scroller.addEventListener('mousemove', showTip);
  scroller.addEventListener('mouseleave', () => { tip.hidden = true; });
  vp.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.td-tid');
    if (b && b.__task) { e.stopPropagation(); openTask(b.__task); }
  }, true);

  const typingTarget = (t) => !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
  // Capture phase for the view's own keys. N jumps to now (t / T stay Talk's, app-wide).
  const onKey = (e) => {
    if (!root.isConnected || e.metaKey || e.ctrlKey || e.altKey || typingTarget(e.target)) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': panBy(-0.15); break;
      case 'ArrowRight': panBy(0.15); break;
      case '+': case '=': zoomBy(1 / 1.6, 0.5); break;
      case '-': case '_': zoomBy(1.6, 0.5); break;
      case '0': fitAxis(); break;
      case 'n': case 'N': jumpNow(); break;
      case 'Escape': if (rangeSel) clearRange(); else handled = false; break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };
  document.addEventListener('keydown', onKey, true);

  /* ---------- scroll / resize / clock ---------- */
  let framePending = false;
  scroller.addEventListener('scroll', () => {
    if (framePending) return;
    framePending = true;
    raf(() => { framePending = false; renderWindow(false); });
  }, { passive: true });
  let lastW = 0;
  const onResize = () => raf(() => { const w = scroller.clientWidth; if (w !== lastW) { lastW = w; paintChrome(); } renderWindow(false); });
  window.addEventListener('resize', onResize);
  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(onResize); ro.observe(scroller); }
  const clock = setInterval(() => { if (!document.hidden && day && (day.isToday || isTodayRoute)) requestPaint(false); }, 1000);

  /* ---------- lifecycle ---------- */
  function applyRoute(r) {
    const prev = dayStart;
    dayStart = readDay(r);
    if (prev !== dayStart) { mode = 'fit'; rangeSel = null; folded.clear(); fetched.clear(); }
    requestPaint(true);
  }
  // a click on the label of an agent row selects the row too
  root.addEventListener('keydown', (e) => {
    if (e.target === scroller && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
  });

  applyRoute(initialRoute || route());
  return {
    watch: ['session', 'agent', 'task', 'project', 'run', 'workflow', 'activity', 'usage', 'ui', 'ready'],
    update(changed) {
      const sig = `${state.agents.size}|${Array.from(state.agents.values()).filter(isLiveAgent).length}|${state.runs.size}`;
      const structural = sig !== agentSig || changed.has('ui') || changed.has('ready') || changed.has('project') || changed.has('run');
      requestPaint(structural);
    },
    setRoute(r) { applyRoute(r); },
    destroy() {
      destroyed = true;
      clearInterval(clock); clearTimeout(paintTimer);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousemove', onSelMove);
      document.removeEventListener('mouseup', onSelEnd);
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
      detachPanZoom();
      root.remove();
    },
  };
}
