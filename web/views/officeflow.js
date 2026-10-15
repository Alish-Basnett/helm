// views/officeflow.js — Office "Flow": the main session in the middle, the other sessions around it, every subagent a branch.
// Canvas 2D with a hand-written force layout (officemodel.js). Finished things stay on the graph, marked "Needs your OK",
// until the owner acknowledges them; then they fade out and live under "Archived". Nothing here hides on its own
// (except on a hub that cannot acknowledge: there finished things drop off after a while).
import { h, setText, setHidden, reconcile, reducedMotion, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, upsert, onActivity, showOld } from '../store.js';
import { api } from '../api.js';
import { ackBulk } from '../actions.js';
import { openAckAll, openBundleAck, openAckDialog } from '../ackdialog.js';
import { createOldToggle } from '../oldtoggle.js';
import { onPrefs } from '../prefs.js';
import { fmtElapsed, fmtTokens, fmtUsd, fmtAgo, agentLabel, truncate, plural, cwdTail, sessionLabel } from '../format.js';
import { modelBadge, nowDoingLine, toast, toastError } from '../ui.js';
import { navigate, openTask } from '../router.js';
import { ctxText, ctxLevel, LEVEL_LABEL, levelOf } from '../health.js';
import { buildModel, Sim, fitTransform, quadAt, linkControl, easeOutBack, FINISHED_CAP } from '../officemodel.js';

const AGENT_STATUS = { running: 'Running', done: 'Done', failed: 'Failed', stalled: 'Stalled', waiting: 'Waiting for you' };
const POP_MS = 520;
const FADE_MS = 340;
const COLORS = {
  bg: '--bg', bg2: '--bg-2', label: '--label', label2: '--label-2', label3: '--label-3', sep: '--separator-strong',
  accent: '--accent', green: '--green', orange: '--orange', red: '--red', indigo: '--indigo', purple: '--purple', gray: '--gray', blue: '--blue',
};
const LINK_STATE_LABEL = { queued: 'Queued', delivered: 'Delivered', answered: 'Answered' };
const BUNDLE_ROWS = 60;
const TIP_ID = 'of-tip';

const errReason = (e) => (e && (e.status === 404 || e.status === 405) ? 'Update the hub to acknowledge' : (e && e.data && e.data.reason) || (e && e.message) || 'Could not acknowledge');
const pname = (id) => (state.projects.get(id) || {}).name || '';

export function mount(container) {
  startTicker();
  let destroyed = false;
  let showArchived = false;
  let projFilter = 'all';
  let selectedKey = null;
  let hoverKey = null;
  let model = null;
  let pendingAll = { agents: [], sessions: [], links: [] };
  let oldIsOn = false;
  let primed = false;
  let autoFit = true;
  let listPinned = false;
  const vp = { x: 0, y: 0, k: 1 };
  const sim = new Sim();
  const vn = new Map();        // key -> view node (model node + born time + its sim point)
  const dying = [];            // nodes that left the model: shrinking and fading
  const edgeByKey = new Map();
  const particles = [];
  const linkStates = new Map();
  const linkEdge = new Map();   // link id -> its bundle edge
  const lastBundle = new Map(); // bundle key -> last time a particle ran along it
  let chipHits = [];            // screen boxes of the "+N more" chips drawn last frame
  let bundleRows = BUNDLE_ROWS;
  const lastStruct = new Map(); // session key -> last time a structural particle left main for it
  let C = {};
  let colorsDirty = true;
  let W = 0, Hh = 0, dpr = 1;
  let raf = 0, slowTimer = 0;
  let dragging = null;  // a node (or link badge) under the pointer: { key, moved, ... }
  let panning = null;   // the background under the pointer
  let pinch = null;
  const pointers = new Map();

  /* ---------- structure ---------- */
  const mainSel = h('select', { class: 'select select-sm', 'aria-label': 'Main project', onchange: () => setMain(mainSel.value) });
  const mainHint = h('span', { class: 'of-hint', hidden: true }, 'Update the hub to choose a main session');
  const projSel = h('select', { class: 'select select-sm', 'aria-label': 'Filter by project', onchange: () => { projFilter = projSel.value; refresh(); } });
  const pendingN = h('span', { class: 'of-count mono' }, '0');
  const pendingLbl = h('span', { class: 'of-pending-lbl' }, 'need your OK');
  const pendingIc = h('span', { class: 'of-pend-ic', 'aria-hidden': 'true' }, icon('checkCircle', 15));
  const ackAllBtn = h('button', { class: 'btn btn-sm btn-accent', type: 'button', 'aria-label': 'Acknowledge all finished…', onclick: () => openAckAll() }, icon('checkCircle', 14), h('span', {}, 'Acknowledge all…'));
  const pendingBox = h('div', { class: 'of-pending', role: 'status' }, pendingIc, pendingN, pendingLbl, ackAllBtn);
  const oldToggle = createOldToggle('flow');
  const archN = h('span', { class: 'of-count mono' }, '0');
  const archBtn = h('button', { class: 'th-seg-btn of-arch', type: 'button', 'aria-pressed': 'false', title: 'Show acknowledged nodes, dimmed, with Restore', onclick: () => { showArchived = !showArchived; refresh(); } }, icon('archive', 14), h('span', { class: 'of-t' }, 'Archived'), archN);
  archBtn.setAttribute('aria-label', 'Archived');
  const listBtn = h('button', { class: 'th-seg-btn', type: 'button', 'aria-pressed': 'false', title: 'List of every node: keyboard and screen reader friendly', onclick: () => { listPinned = !listPinned; paintList(); } }, icon('rows', 14), h('span', { class: 'of-t' }, 'List'));
  listBtn.setAttribute('aria-label', 'List of nodes');
  const zoomBtn = (label, title, fn) => h('button', { class: 'th-seg-btn', type: 'button', title, 'aria-label': title, onclick: fn }, label);
  const zoomSeg = h('div', { class: 'th-seg', role: 'group', 'aria-label': 'Zoom' },
    h('span', { class: 'of-zoombtns' }, zoomBtn('−', 'Zoom out (-)', () => zoomBy(1 / 1.3)), zoomBtn('+', 'Zoom in (+)', () => zoomBy(1.3))), zoomBtn('Fit', 'Fit the whole graph (0)', () => fit()));
  const toolbar = h('div', { class: 'of-toolbar' }, pendingBox,
    h('label', { class: 'of-field' }, h('span', { class: 'of-field-k' }, 'Main'), mainSel), mainHint,
    h('label', { class: 'of-field' }, h('span', { class: 'of-field-k' }, 'Project'), projSel),
    h('span', { class: 'spacer' }), oldToggle.el,
    h('div', { class: 'th-seg' }, archBtn, listBtn), zoomSeg);

  const legendItem = (swatch, text) => h('li', { class: 'of-leg' }, swatch, h('span', {}, text));
  const dot = (cls) => h('i', { class: `of-sw ${cls}`, 'aria-hidden': 'true' });
  const legend = h('ul', { class: 'of-legend', 'aria-label': 'Legend', role: 'list' },
    legendItem(dot('sw-main'), 'Main session'), legendItem(dot('sw-session'), 'Session'), legendItem(dot('sw-builder'), 'Builder'), legendItem(dot('sw-scout'), 'Scout'),
    legendItem(dot('sw-run'), 'Running'), legendItem(dot('sw-wait'), 'Waiting for you'), legendItem(dot('sw-done'), 'Done'), legendItem(dot('sw-fail'), 'Failed'),
    legendItem(dot('sw-ok'), 'Needs your OK'), legendItem(dot('sw-link'), 'Link'), legendItem(dot('sw-queued'), 'Queued link'));

  const keysHelp = h('p', { id: 'of-keys', class: 'of-sr' }, 'Flow graph of the main session, other sessions and their subagents. Plus and minus zoom, zero fits the whole graph, arrow keys pan, Escape closes details. Use the List button to inspect and acknowledge nodes.');
  const live = h('div', { class: 'of-sr', role: 'status', 'aria-live': 'polite' });
  const canvas = h('canvas', { class: 'of-canvas', tabindex: '0', role: 'application', 'aria-roledescription': 'flow graph', 'aria-label': 'Office flow graph', 'aria-describedby': 'of-keys' });
  const ctx = canvas.getContext('2d');
  const probe = h('span', { class: 'of-probe', 'aria-hidden': 'true' });
  const tipTitle = h('div', { class: 'of-tip-title' });
  const tipStatus = h('div', { class: 'of-tip-status' });
  const tipElapsed = h('span', { class: 'mono' });
  const tipMeta = h('div', { class: 'of-tip-meta mono' });
  const tipNd = nowDoingLine();
  const tip = h('div', { class: 'of-tip', id: TIP_ID, role: 'tooltip', hidden: true }, tipTitle, tipStatus, tipElapsed, tipNd, tipMeta);
  const pickSel = h('select', { class: 'select', 'aria-label': 'Main project', onchange: () => { if (pickSel.value) setMain(pickSel.value); } });
  const pickCard = h('div', { class: 'of-pick', hidden: true },
    h('strong', {}, 'Pick the main project'),
    h('p', {}, 'The main session is the one you steer from. Its project sits in the middle of the graph.'), pickSel);
  const empty = h('div', { class: 'of-empty', hidden: true }, h('strong', {}, 'No sessions yet'), h('p', {}, 'Start Claude Code with Helm installed. Every session becomes a node here and every subagent a branch.'));
  const listUl = h('ul', { class: 'of-list', role: 'list' });
  const listBox = h('section', { class: 'of-listbox', 'aria-label': 'Nodes' }, h('h2', { class: 'of-listhead' }, 'Nodes'), listUl);
  const stage = h('div', { class: 'of-stage' }, canvas, keysHelp, live, empty, pickCard, tip, listBox, probe);
  const panel = h('aside', { class: 'of-panel', hidden: true, tabindex: '-1', 'aria-label': 'Node details' });
  const body = h('div', { class: 'of-body' }, stage, panel);
  const dialogHost = h('div', { class: 'of-dialog-host' });
  const wrap = h('div', { class: 'of-flow' }, toolbar, legend, body, dialogHost);
  container.appendChild(wrap);

  /* ---------- colours (read from the live theme tokens) ---------- */
  const FONT = getComputedStyle(document.body).fontFamily;
  function readColors() {
    for (const k in COLORS) { probe.style.color = `var(${COLORS[k]})`; C[k] = getComputedStyle(probe).color; }
    colorsDirty = false;
  }
  const dirtyColors = () => { colorsDirty = true; kick(); };
  const offPrefs = onPrefs((k) => { if (k === 'theme' || k === 'accent') dirtyColors(); });
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) mq.addEventListener('change', dirtyColors);

  /* ---------- helpers on rows ---------- */
  const toneColor = (tone) => C[tone] || C.gray;
  function sessionStatus(row) {
    if (!row) return { text: 'No live session', tone: 'gray' };
    if (row.status === 'ended') return { text: 'Ended', tone: 'gray' };
    if (sel.sessionWaiting(row.id)) return { text: 'Waiting for you', tone: 'indigo' };
    if (row.status === 'idle') return { text: 'Idle', tone: 'orange' };
    if (row.busy) return { text: row.nowDoing ? `Working: ${truncate(String(row.nowDoing).split(/[:\s]/)[0], 14)}` : 'Thinking', tone: 'accent' };
    return { text: 'Idle', tone: 'green' };
  }
  function agentStatusTone(a) { return { running: 'accent', waiting: 'indigo', stalled: 'orange', done: 'green', failed: 'red' }[a.status] || 'gray'; }
  function nodeTitle(v) {
    if (v.kind === 'agent') return agentLabel(v.row) + (v.row.taskId ? ` · ${v.row.taskId}` : '');
    return pname(v.projectId) || 'Project';
  }
  function nodeSub(v) {
    if (v.kind === 'agent') return v.row.description ? truncate(v.row.description.replace(/^\[helm:T-\d+\]\s*/, ''), 60) : '';
    if (v.row) return truncate(sessionLabel(v.row), 40);
    return v.kind === 'main' ? 'No live session in this project' : 'No live session';
  }
  function nodeStatus(v) {
    if (v.kind === 'agent') return { text: AGENT_STATUS[v.row.status] || v.row.status, tone: agentStatusTone(v.row) };
    return sessionStatus(v.row);
  }
  const linkText = (L) => `${L.kind === 'task' ? 'Task' : 'Note'}: ${truncate(L.text || '', 80)}`;
  const bundleTitle = (e) => `${pname(e.bundle.fromProjectId) || 'session'} ${e.bundle.ab && e.bundle.ba ? '↔' : '→'} ${pname(e.bundle.toProjectId) || 'session'}`;
  const countsText = (c) => [c.answered && `${c.answered} answered`, c.delivered && `${c.delivered} delivered`, c.queued && `${c.queued} queued`, c.archived && `${c.archived} archived`].filter(Boolean).join(' · ');
  function nodeSince(v) {
    const r = v.row;
    if (!r) return null;
    if (v.kind === 'agent') return r.status === 'done' || r.status === 'failed' ? null : r.startedAt;
    return r.status === 'ended' ? null : r.startedAt;
  }
  function nodeDuration(v) {
    const r = v.row;
    if (!r) return '';
    if (v.kind === 'agent') return fmtElapsed((r.endedAt || r.lastActivityAt || Date.now()) - r.startedAt);
    return fmtElapsed((r.lastSeenAt || Date.now()) - r.startedAt);
  }
  function agentNow(a) {
    if (a.status === 'waiting') return (sel.openQuestionForAgent(a.id) || {}).text || 'Waiting for your input';
    return a.nowDoing;
  }
  const isLiveNode = (v) => v.cls === 'live';

  /* ---------- model + layout ---------- */
  const inScope = (pid) => (state.ui.projectId === 'all' || pid === state.ui.projectId) && (projFilter === 'all' || pid === projFilter);

  function refresh() {
    if (destroyed) return;
    const now = Date.now();
    if (projFilter !== 'all' && !sel.project(projFilter)) projFilter = 'all'; // the filtered project was archived or removed
    else if (projFilter !== 'all' && sel.project(projFilter).archived) projFilter = 'all';
    oldIsOn = showOld('flow');
    const m = buildModel({
      projects: sel.projects(true), sessions: Array.from(state.sessions.values()), agents: Array.from(state.agents.values()),
      links: Array.from(state.links.values()), caps: state.caps, now, showArchived, showOld: oldIsOn, scope: inScope,
    });
    // "need your OK" counts every project and the things not drawn too: a filter must not hide what is waiting for you elsewhere
    pendingAll = sel.pendingAck();
    model = m;
    const t = performance.now();
    const calm = reducedMotion();
    const { removed } = sim.sync(m.nodes, m.edges);
    for (const n of m.nodes) {
      let v = vn.get(n.key);
      if (!v) { v = { born: primed && !calm ? t : -1e9 }; vn.set(n.key, v); }
      Object.assign(v, n);
      v.p = sim.p.get(n.key);
    }
    for (const r of removed) {
      const v = vn.get(r.key);
      vn.delete(r.key);
      if (v && !calm) dying.push({ ...v, p: null, x: r.x, y: r.y, dieAt: t });
    }
    edgeByKey.clear();
    linkEdge.clear();
    for (const e of m.edges) {
      edgeByKey.set(e.key, e);
      if (e.kind === 'link') for (const it of e.bundle.items) linkEdge.set(it.link.id, e);
    }
    trackLinks(t);
    if (calm) sim.settle();
    if (selectedKey && !viewOf(selectedKey)) closePanel(false);
    paintChrome();
    paintList();
    paintPanel(false);
    if (!primed && state.ready) primed = true;
    if (calm && autoFit) fit(true);
    kick();
  }

  /** One particle per bundle (not per link) when a link in it is created, delivered (sender to receiver) or answered (back). */
  function trackLinks(t) {
    const touched = new Map();
    for (const L of state.links.values()) {
      const prev = linkStates.get(L.id);
      linkStates.set(L.id, L.state);
      if (!primed || reducedMotion()) continue;
      const e = linkEdge.get(L.id);
      if (!e || (prev !== undefined && prev === L.state)) continue;
      const back = prev !== undefined && L.state === 'answered';
      if (!touched.has(e.key) || !back) touched.set(e.key, back);
    }
    for (const [ekey, back] of touched) {
      if (t - (lastBundle.get(ekey) || -1e9) < 900) continue;
      lastBundle.set(ekey, t);
      particles.push({ kind: 'link', ekey, rev: back, t0: t, dur: 1100, color: back ? 'green' : 'accent' });
    }
    for (const id of Array.from(linkStates.keys())) if (!state.links.has(id)) linkStates.delete(id);
    for (const k of Array.from(lastBundle.keys())) if (!edgeByKey.has(k)) lastBundle.delete(k);
  }

  /* ---------- chrome: counts, selects, prompt, empty ---------- */
  function paintChrome() {
    const m = model;
    const pend = pendingAll.sessions.length + pendingAll.agents.length + pendingAll.links.length;
    setText(pendingN, String(pend));
    ackAllBtn.disabled = !pend || !state.caps.ack;
    ackAllBtn.title = state.caps.ack ? (pend ? 'Review and archive everything that has finished, in every project' : 'Nothing to acknowledge') : 'Update the hub to acknowledge';
    pendingBox.title = 'Counted across all projects, whatever the filter, including old things that are not drawn';
    pendingBox.classList.toggle('has', pend > 0);
    setHidden(pendingBox, !state.caps.ack);
    oldToggle.set(m.oldCount);
    archBtn.setAttribute('aria-pressed', String(showArchived));
    setText(archN, String(m.archivedCount));
    setHidden(archBtn, !state.caps.ack);
    // selects
    const projects = sel.projects();
    const sig = projects.map((p) => `${p.id}:${p.name}:${p.coordinator ? 1 : 0}`).join('|');
    if (mainSel.__sig !== sig) {
      mainSel.__sig = sig;
      mainSel.textContent = '';
      mainSel.append(h('option', { value: '' }, 'None'), ...projects.map((p) => h('option', { value: p.id }, p.name)));
      projSel.textContent = '';
      projSel.append(h('option', { value: 'all' }, 'All projects'), ...projects.map((p) => h('option', { value: p.id }, p.name)));
      pickSel.textContent = '';
      pickSel.append(h('option', { value: '' }, 'Choose a project…'), ...projects.map((p) => h('option', { value: p.id }, p.name)));
    }
    mainSel.value = m.coordinator ? m.coordinator.id : '';
    projSel.value = projFilter;
    mainSel.disabled = !state.caps.coordinator;
    setHidden(mainHint, state.caps.coordinator || !state.ready);
    const noSessions = state.ready && state.sessions.size === 0;
    setHidden(empty, !noSessions);
    setHidden(pickCard, !(state.ready && state.caps.coordinator && !m.coordinator && state.sessions.size > 0));
  }

  async function setMain(pid) {
    const cur = model && model.coordinator;
    try {
      if (!pid) { if (cur) await api.setCoordinator(cur.id, false); }
      else await api.setCoordinator(pid, true);
      for (const p of Array.from(state.projects.values())) if (!!p.coordinator !== (p.id === pid)) upsert('project', { ...p, coordinator: p.id === pid });
    } catch (e) { toastError(e && (e.status === 404 || e.status === 405) ? 'Update the hub to choose a main session' : e); refresh(); }
  }

  /* ---------- acknowledge ---------- */
  const MAPS = { agent: 'agents', session: 'sessions', link: 'links' };
  function patchAck(entity, id, at) {
    const row = state[MAPS[entity]].get(id);
    if (row) upsert(entity, { ...row, acknowledgedAt: at });
  }
  async function ackOne(v, on) {
    const isLink = v.type === 'link';
    const entity = isLink ? 'link' : v.kind === 'agent' ? 'agent' : 'session';
    const id = isLink ? v.link.id : v.id;
    const fn = { agent: [api.ackAgent, api.unackAgent], session: [api.ackSession, api.unackSession], link: [api.ackLink, api.unackLink] }[entity][on ? 0 : 1];
    try { await fn(id); patchAck(entity, id, on ? Date.now() : null); } catch (e) { toastError(errReason(e)); }
  }
  const finishedKidsOf = (sessionId) => (model ? model.pending.agents.filter((n) => n.sessionId === sessionId) : []);

  /* ---------- panel ---------- */
  function select(key, fromList) {
    selectedKey = key;
    paintPanel(true);
    kick();
    const v = viewOf(key);
    if (v) {
      const what = v.type === 'bundle' ? `${bundleTitle(v)}, ${plural(v.n, 'link')}` : v.type === 'more' ? `${nodeTitle(v.node)}, ${plural(v.rows.length, 'more finished subagent')}` : `${nodeTitle(v)}, ${nodeStatus(v).text}`;
      setText(live, `Selected ${what}${v.needsOk ? ', needs your OK' : ''}. Details panel opened.`);
    }
    if (fromList) panel.focus({ preventScroll: true }); // keyboard and screen-reader users land in the details
  }
  function closePanel(refocus = true) {
    selectedKey = null;
    setHidden(panel, true);
    panel.textContent = '';
    panel.__sig = null;
    kick();
    if (refocus && !destroyed) canvas.focus({ preventScroll: true });
  }
  const chip = (text, tone) => h('span', { class: `of-chip tone-${tone || 'gray'}` }, text);
  const kv = (k, v) => h('div', { class: 'of-row' }, h('span', { class: 'of-k' }, k), v instanceof Node ? v : h('span', { class: 'of-v' }, v));
  function sinceNode(since, done) {
    const el = h('span', { class: 'of-v mono' }, since ? fmtElapsed(Date.now() - since) : done);
    if (since) el.setAttribute('data-since', since);
    return el;
  }
  function ackNote(text) { return h('p', { class: 'of-note' }, text); }

  /** What the owner can do about a node or link: { actions: [Node], note } */
  function ackControls(v) {
    const isLink = v.type === 'link';
    const label = isLink ? 'link' : v.kind === 'agent' ? 'subagent' : 'session';
    const out = { actions: [], note: null };
    const btn = (text, cls, fn, act, iconName) => h('button', { class: `btn btn-sm ${cls}`, type: 'button', 'data-act': act, onclick: fn }, icon(iconName || 'checkCircle', 14), text);
    if (v.cls === 'live') {
      out.note = isLink ? 'Not answered yet. You can acknowledge it once it has been answered.' : v.kind === 'agent' ? 'Still running. You can acknowledge it once it has finished.' : 'Still live. You can acknowledge it once it has ended.';
    } else if (v.cls === 'soft') {
      out.note = 'Update the hub to acknowledge. This drops off the graph by itself after a while.';
    } else if (v.blocked) {
      out.note = `Cannot be acknowledged yet: ${v.blocked}. Acknowledge or wait for them first.`;
    } else if (v.cls === 'finished') {
      out.actions.push(btn(`Acknowledge ${label}`, 'btn-primary', () => ackOne(v, true), 'ack'));
      if (!isLink && v.kind !== 'agent') {
        const kids = finishedKidsOf(v.id);
        if (kids.length) out.actions.push(btn(`Acknowledge session + ${plural(kids.length, 'finished subagent')}`, 'btn-accent', () => {
          openAckDialog({
            title: `Acknowledge this session and ${plural(kids.length, 'finished subagent')}?`, note: `${nodeTitle(v)}. They are archived and leave the graph.`,
            groups: [
              { id: 'sessions', title: 'Session', iconName: 'terminal', entries: [{ id: `s:${v.id}`, label: nodeTitle(v), items: [{ kind: 'session', id: v.id, title: nodeTitle(v) }] }] },
              { id: 'agents', title: 'Finished subagents', iconName: 'check', entries: [{ id: `k:${v.id}`, label: nodeTitle(v), items: kids.map((k) => ({ kind: 'agent', id: k.id, title: agentLabel(k.row) })) }] },
            ],
          });
        }, 'ack-all'));
      }
    } else if (v.cls === 'archived') {
      out.actions.push(btn(`Restore ${label}`, '', () => ackOne(v, false), 'restore', 'undo'));
    }
    return out;
  }

  function viewOf(key) {
    const v = vn.get(key);
    if (v) return v;
    const e = edgeByKey.get(key);
    if (e && e.kind === 'link') return { ...e, type: 'bundle' };
    if (key && key.startsWith('m:')) {
      const node = vn.get(key.slice(2));
      if (node && node.more && node.more.length) return { type: 'more', key, node, rows: node.more };
    }
    return null;
  }

  /** A collection in the side panel: a link bundle, or the finished subagents behind a "+N more" chip. */
  function paintCollection(v, force) {
    const bundle = v.type === 'bundle';
    const items = bundle ? v.bundle.items : v.rows;
    const sig = JSON.stringify([v.type, bundle ? [v.bundle.counts, bundleRows] : 0, items.map((i) => (bundle ? [i.link.id, i.link.state, i.link.reply, !!i.link.acknowledgedAt] : [i.id, i.row.status, !!i.row.acknowledgedAt])), state.caps.ack]);
    if (!force && panel.__sig === sig) return;
    panel.__sig = sig;
    const focusAct = panel.contains(document.activeElement) ? document.activeElement.getAttribute('data-act') : null;
    const keepScroll = panel.scrollTop;
    panel.textContent = '';
    const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close details', 'data-act': 'close', onclick: () => closePanel() }, icon('close', 16));
    const btn = (text, cls, fn, act, iconName) => h('button', { class: `btn btn-sm ${cls}`, type: 'button', 'data-act': act, onclick: fn }, icon(iconName || 'checkCircle', 14), text);
    let kicker, title, chips, actions = [], rows, note = null;
    if (bundle) {
      const B = v.bundle, c = B.counts;
      kicker = 'Link bundle';
      title = bundleTitle(v);
      chips = [chip(plural(B.n, 'link'), 'accent')];
      if (c.needOk) chips.push(chip(`${c.needOk} need your OK`, 'purple'));
      if (c.queued) chips.push(chip(`${c.queued} queued`, 'orange'));
      if (c.delivered) chips.push(chip(`${c.delivered} delivered`, 'accent'));
      if (c.answered) chips.push(chip(`${c.answered} answered`, 'green'));
      if (c.archived) chips.push(chip(`${c.archived} archived`, 'gray'));
      if (c.needOk && state.caps.ack) actions.push(btn(`Acknowledge all ${c.needOk} in this bundle`, 'btn-primary', () => { const cur = edgeByKey.get(v.key); if (cur) openBundleAck(cur.bundle); }, 'ack-bundle'));
      else if (c.needOk) note = 'Update the hub to acknowledge.';
      rows = [];
      const shown = items.slice(0, bundleRows);
      const ul = h('ul', { class: 'of-blist', role: 'list', 'aria-label': 'Links in this bundle' }, shown.map((it) => {
        const L = it.link;
        const ackBtn = it.needsOk ? btn('Acknowledge', 'btn-accent', () => ackOne({ type: 'link', link: L }, true), `ack-${L.id}`)
          : it.archived ? btn('Restore', '', () => ackOne({ type: 'link', link: L }, false), `restore-${L.id}`, 'undo') : null;
        if (ackBtn) ackBtn.setAttribute('aria-label', `${it.archived ? 'Restore' : 'Acknowledge'} ${linkText(L)}`);
        const task = /^T-\d+$/.test(L.refId || '') && state.tasks.has(L.refId)
          ? h('button', { class: 'btn btn-sm', type: 'button', 'data-act': `task-${L.id}`, onclick: () => openTask(L.refId) }, icon('file', 14), L.refId) : null;
        return h('li', { class: 'of-bl' },
          h('div', { class: 'of-bl-top' }, chip(L.kind === 'task' ? 'Task' : 'Note', L.kind === 'task' ? 'accent' : 'gray'),
            chip(LINK_STATE_LABEL[L.state] || L.state, L.state === 'answered' ? 'green' : L.state === 'queued' ? 'orange' : 'accent'),
            it.needsOk ? chip('Needs OK', 'purple') : null, it.archived ? chip('Archived', 'gray') : null,
            h('span', { class: 'of-bl-t mono' }, fmtAgo(L.createdAt))),
          h('div', { class: 'of-bl-text', title: L.text || '' }, L.text || '—'),
          L.reply ? h('div', { class: 'of-bl-reply' }, `Reply: ${truncate(L.reply, 100)}`) : null,
          ackBtn || task ? h('div', { class: 'of-actions' }, task, ackBtn) : null);
      }));
      rows.push(ul);
      if (items.length > shown.length) rows.push(btn(`Show ${Math.min(BUNDLE_ROWS, items.length - shown.length)} more of ${items.length - shown.length} left`, '', () => { bundleRows += BUNDLE_ROWS; paintPanel(true); }, 'more-rows', 'chevronRight'));
    } else {
      const n = v.node;
      kicker = 'Finished subagents';
      title = `${nodeTitle(n)} · ${v.rows.length} more`;
      chips = [chip(`${v.rows.length} need your OK`, 'purple'), chip(`only the newest ${FINISHED_CAP} are drawn`, 'gray')];
      const groupFor = () => ({ id: 'agents', title: 'Finished subagents', iconName: 'check', entries: [{ id: `more:${n.key}`, label: nodeTitle(n), items: v.rows.map((r) => ({ kind: 'agent', id: r.id, title: agentLabel(r.row) })) }] });
      if (state.caps.ack) actions.push(btn(`Acknowledge all ${v.rows.length}`, 'btn-primary', () => openAckDialog({ title: `Acknowledge ${plural(v.rows.length, 'finished subagent')}?`, note: `${nodeTitle(n)}. They are archived and leave the graph.`, groups: [groupFor()] }), 'ack-more'));
      rows = [h('ul', { class: 'of-blist', role: 'list', 'aria-label': 'More finished subagents' }, v.rows.slice(0, bundleRows).map((r) => {
        const a = r.row;
        const ackBtn = btn('Acknowledge', 'btn-accent', () => ackOne(r, true), `ack-${r.id}`);
        ackBtn.setAttribute('aria-label', `Acknowledge ${agentLabel(a)}`);
        return h('li', { class: 'of-bl' },
          h('div', { class: 'of-bl-top' }, chip(AGENT_STATUS[a.status] || a.status, a.status === 'failed' ? 'red' : 'green'), h('span', { class: 'of-bl-t mono' }, fmtAgo(a.endedAt || a.lastActivityAt))),
          h('div', { class: 'of-bl-text', title: a.description || '' }, `${agentLabel(a)}${a.taskId ? ` · ${a.taskId}` : ''}`),
          h('div', { class: 'of-actions' }, ackBtn, h('button', { class: 'btn btn-sm', type: 'button', 'data-act': `thread-${r.id}`, onclick: () => navigate('threads', [a.sessionId, a.id]) }, icon('threads', 14), 'Open thread')));
      }))];
      if (v.rows.length > bundleRows) rows.push(btn('Show more', '', () => { bundleRows += BUNDLE_ROWS; paintPanel(true); }, 'more-rows', 'chevronRight'));
    }
    panel.append(...[
      h('div', { class: 'of-p-head' }, h('div', { class: 'of-p-titles' }, h('div', { class: 'of-kicker' }, kicker), h('h2', { class: 'of-p-title' }, title)), closeBtn),
      h('div', { class: 'of-chips' }, chips),
      actions.length ? h('div', { class: 'of-actions of-ack' }, actions) : null,
      note ? ackNote(note) : null,
      h('div', { class: 'of-rows' }, rows),
    ].filter(Boolean));
    setHidden(panel, false);
    panel.scrollTop = keepScroll;
    if (focusAct) { const el = panel.querySelector(`[data-act="${focusAct}"]`); if (el) el.focus({ preventScroll: true }); }
  }

  function paintPanel(force) {
    if (!selectedKey) return;
    const v = viewOf(selectedKey);
    if (!v) return;
    if (v.type === 'bundle' || v.type === 'more') { paintCollection(v, force); return; }
    const nd = v.kind === 'agent' ? agentNow(v.row) : v.row && v.row.nowDoing;
    const sig = JSON.stringify([v.cls, v.blocked, v.row && [v.row.status, v.row.busy, v.row.title, v.row.model, v.row.tokens, v.row.costUsd, v.row.contextPercent, v.row.acknowledgedAt], nd, v.kind === 'agent' ? null : finishedKidsOf(v.id).length, model.main && model.main.key === v.key, state.caps.coordinator]);
    if (!force && panel.__sig === sig) return;
    panel.__sig = sig;
    const focusAct = panel.contains(document.activeElement) ? document.activeElement.getAttribute('data-act') : null;
    const keepScroll = panel.scrollTop;
    panel.textContent = '';
    const controls = ackControls(v);
    const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close details', 'data-act': 'close', onclick: () => closePanel() }, icon('close', 16));
    let kicker, title, chips, rows, links = [];
    {
      const st = nodeStatus(v);
      const r = v.row;
      const isMain = v.kind === 'main';
      kicker = v.kind === 'agent' ? (v.role === 'builder' ? 'Builder subagent' : v.role === 'scout' ? 'Scout subagent' : 'Subagent') : isMain ? 'Main session' : v.ghost ? 'Project' : 'Session';
      title = nodeTitle(v);
      chips = [chip(st.text, st.tone)];
      if (v.needsOk) chips.push(chip('Needs your OK', 'purple'));
      if (v.archived) chips.push(chip('Archived', 'gray'));
      const lvl = r && v.kind !== 'agent' ? levelOf(r) : 'ok';
      if (lvl !== 'ok') chips.push(chip(LEVEL_LABEL[lvl], lvl === 'critical' ? 'red' : 'orange'));
      const nowEl = nowDoingLine();
      nowEl.__set(nd, !!r && isLiveNode(v) && (v.kind === 'agent' ? r.status === 'running' : r.busy));
      rows = [];
      if (r) {
        rows.push(kv('Doing', nowEl));
        if (v.kind !== 'agent') rows.push(kv('Session', nodeSub(v)));
        else if (r.description) rows.push(kv('Brief', h('span', { class: 'of-v of-pre' }, truncate(r.description.replace(/^\[helm:T-\d+\]\s*/, ''), 240))));
        rows.push(kv('Model', modelBadge(r.model)));
        rows.push(kv(v.kind === 'agent' ? 'Elapsed' : 'Up for', sinceNode(nodeSince(v), nodeDuration(v))));
        if (v.kind !== 'agent' && r.contextPercent != null) rows.push(kv('Context', ctxText(r).replace(/^Context /, '')));
        if (r.tokens) rows.push(kv('Tokens', fmtTokens(r.tokens)));
        if (r.costUsd) rows.push(kv('Spend', fmtUsd(r.costUsd)));
        rows.push(kv('Last activity', h('span', { class: 'of-v mono', 'data-ago': r.lastActivityAt || r.lastSeenAt || 0 }, fmtAgo(r.lastActivityAt || r.lastSeenAt))));
        if (v.kind === 'agent') rows.push(kv('Project', pname(v.projectId)));
        else rows.push(kv('Folder', h('span', { class: 'of-v mono', title: r.cwd || '' }, cwdTail(r.cwd, 3))));
      } else rows.push(kv('Doing', 'Nothing running here right now.'));
      if (r && v.kind === 'agent') {
        if (r.taskId && state.tasks.has(r.taskId)) links.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-act': 'task', onclick: () => openTask(r.taskId) }, icon('file', 14), `Open ${r.taskId}`));
        links.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-act': 'thread', onclick: () => navigate('threads', [r.sessionId, r.id]) }, icon('threads', 14), 'Open thread'));
      } else if (r) {
        links.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-act': 'thread', onclick: () => navigate('threads', [r.id]) }, icon('threads', 14), 'Open thread'));
        if (state.caps.coordinator && !isMain && (!model.coordinator || model.coordinator.id !== v.projectId)) {
          links.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-act': 'main', onclick: () => setMain(v.projectId) }, icon('pointer', 14), 'Make this the main project'));
        }
      }
    }
    panel.append(...[
      h('div', { class: 'of-p-head' }, h('div', { class: 'of-p-titles' }, h('div', { class: 'of-kicker' }, kicker), h('h2', { class: 'of-p-title' }, title)), closeBtn),
      h('div', { class: 'of-chips' }, chips),
      h('div', { class: 'of-rows' }, rows.filter(Boolean)),
      links.length ? h('div', { class: 'of-actions' }, links) : null,
      h('div', { class: 'of-actions of-ack' }, controls.actions),
      controls.note ? ackNote(controls.note) : null,
    ].filter(Boolean));
    setHidden(panel, false);
    panel.scrollTop = keepScroll;
    if (focusAct) { const el = panel.querySelector(`[data-act="${focusAct}"]`); if (el) el.focus({ preventScroll: true }); }
  }

  /* ---------- accessible list ---------- */
  function paintList() {
    wrap.classList.toggle('list-open', listPinned);
    listBtn.setAttribute('aria-pressed', String(listPinned));
    if (!model) return;
    const items = [
      ...model.nodes.filter((n) => n.kind !== 'agent').map((n) => ({ key: n.key, v: n })),
      ...model.nodes.filter((n) => n.kind === 'agent').map((n) => ({ key: n.key, v: n })),
      ...model.edges.filter((e) => e.kind === 'link').map((e) => ({ key: e.key, v: { ...e, type: 'bundle' } })),
      ...model.nodes.filter((n) => n.more && n.more.length).map((n) => ({ key: `m:${n.key}`, v: { type: 'more', node: n, rows: n.more } })),
    ];
    reconcile(listUl, items, (it) => it.key, (it) => {
      const r = {};
      r.pick = h('button', { class: 'of-li-pick', type: 'button' });
      r.title = h('span', { class: 'of-li-t' });
      r.sub = h('span', { class: 'of-li-s' });
      r.pick.append(r.title, r.sub);
      r.ack = h('button', { class: 'btn btn-sm of-li-ack', type: 'button' });
      const li = h('li', { class: 'of-li' }, r.pick, r.ack);
      li.__r = r;
      return li;
    }, (li, it) => {
      const r = li.__r;
      const v = it.v;
      const coll = v.type === 'bundle' || v.type === 'more';
      let kind, status, title;
      if (v.type === 'bundle') { kind = 'Link bundle'; status = `${plural(v.n, 'link')}${v.needsOk ? `, ${v.bundle.counts.needOk} need your OK` : ''}`; title = bundleTitle(v); }
      else if (v.type === 'more') { kind = 'Finished subagents'; status = `${v.rows.length} more, need your OK`; title = nodeTitle(v.node); }
      else { kind = v.kind === 'agent' ? 'Subagent' : v.kind === 'main' ? 'Main session' : v.ghost ? 'Project' : 'Session'; status = nodeStatus(v).text; title = nodeTitle(v); }
      setText(r.title, title);
      setText(r.sub, coll ? `${kind}, ${status}` : `${kind}, ${status}${v.needsOk ? ', needs your OK' : ''}${v.archived ? ', archived' : ''}${v.kind === 'agent' ? ` — ${pname(v.projectId)}` : ''}`);
      li.classList.toggle('sel', selectedKey === it.key);
      r.pick.setAttribute('aria-pressed', String(selectedKey === it.key));
      r.pick.onclick = () => select(it.key, true);
      const can = !coll && ((v.cls === 'finished' && !v.blocked) || v.cls === 'archived');
      setHidden(r.ack, !can);
      if (can) {
        setText(r.ack, v.cls === 'archived' ? 'Restore' : 'Acknowledge');
        r.ack.setAttribute('aria-label', `${v.cls === 'archived' ? 'Restore' : 'Acknowledge'} ${title}`);
        r.ack.onclick = () => ackOne(v, v.cls !== 'archived');
      }
    });
  }

  /* ---------- camera ---------- */
  function fit(instant) {
    autoFit = true;
    const b = sim.bounds(40);
    const target = fitTransform(b, W, Hh, { pad: W < 500 ? 56 : 36, maxK: 1.7 });
    if (instant || reducedMotion()) Object.assign(vp, target);
    kick();
  }
  function zoomAt(f, lx, ly) {
    const k = Math.max(0.12, Math.min(3, vp.k * f));
    const r = k / vp.k;
    vp.x = lx - (lx - vp.x) * r;
    vp.y = ly - (ly - vp.y) * r;
    vp.k = k;
    autoFit = false;
    kick();
  }
  const zoomBy = (f) => zoomAt(f, W / 2, Hh / 2);
  function easeCamera() {
    if (!autoFit || reducedMotion()) return false;
    const t = fitTransform(sim.bounds(40), W, Hh, { pad: W < 500 ? 56 : 36, maxK: 1.7 });
    const dx = t.x - vp.x, dy = t.y - vp.y, dk = t.k - vp.k;
    if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4 && Math.abs(dk) < 0.001) { Object.assign(vp, t); return false; }
    vp.x += dx * 0.14; vp.y += dy * 0.14; vp.k += dk * 0.14;
    return true;
  }

  /* ---------- drawing ---------- */
  const posOf = (key) => { const v = vn.get(key); return v && v.p; };
  function nodeScale(v, t) {
    if (v.dieAt != null) return Math.max(0, 1 - (t - v.dieAt) / FADE_MS);
    if (v.born < -1e8) return 1;
    const u = (t - v.born) / POP_MS;
    return u >= 1 ? 1 : Math.max(0.001, easeOutBack(u));
  }
  const fadeOf = (v, t) => (v.dieAt != null ? Math.max(0, 1 - (t - v.dieAt) / FADE_MS) : v.born < -1e8 ? 1 : Math.min(1, (t - v.born) / 160));
  const nodeAlpha = (v) => (v.archived ? 0.42 : v.kind === 'session' && v.row && v.row.status === 'ended' ? 0.78 : 1);

  function linkGeom(e) {
    const a = vn.get(e.a), b = vn.get(e.b);
    if (!a || !b || !a.p || !b.p) return null;
    const c = linkControl(e.a, a.p, e.b, b.p, e.off);
    const ua = unit(c.x - a.p.x, c.y - a.p.y), ub = unit(c.x - b.p.x, c.y - b.p.y);
    const s = { x: a.p.x + ua.x * (a.r + 3), y: a.p.y + ua.y * (a.r + 3) };
    const tt = { x: b.p.x + ub.x * (b.r + 6), y: b.p.y + ub.y * (b.r + 6) };
    return { s, c, t: tt, mid: quadAt(s, c, tt, 0.5) };
  }
  const unit = (x, y) => { const d = Math.hypot(x, y) || 1; return { x: x / d, y: y / d }; };

  function stroke(color, px, alpha = 1, dash) {
    ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = px / vp.k;
    ctx.setLineDash(dash ? dash.map((d) => d / vp.k) : []);
  }
  function arrow(tip, from, color, alpha) {
    const d = unit(tip.x - from.x, tip.y - from.y);
    const L = 9 / vp.k, w = 4.5 / vp.k;
    ctx.globalAlpha = alpha; ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - d.x * L - d.y * w, tip.y - d.y * L + d.x * w);
    ctx.lineTo(tip.x - d.x * L + d.y * w, tip.y - d.y * L - d.x * w);
    ctx.closePath(); ctx.fill();
  }

  function drawEdges(t) {
    ctx.lineCap = 'round';
    for (const e of model.edges) {
      if (e.kind === 'link') continue;
      const a = vn.get(e.a), b = vn.get(e.b);
      if (!a || !b || !a.p || !b.p) continue;
      const grow = Math.min(nodeScale(a, t), nodeScale(b, t));
      const live = e.kind === 'struct' ? !!(b.row && b.row.busy) : !!(b.row && b.row.status === 'running');
      if (e.kind === 'struct') stroke(live ? C.accent : C.sep, 1.6, (live ? 0.55 : 0.7) * Math.min(grow, 1) * Math.min(nodeAlpha(b), 1));
      else stroke(live ? C.accent : C.label3, 1.2, (live ? 0.8 : 0.5) * Math.min(grow, 1) * (b.archived ? 0.5 : 1));
      ctx.beginPath(); ctx.moveTo(a.p.x, a.p.y); ctx.lineTo(b.p.x, b.p.y); ctx.stroke();
    }
    for (const e of model.edges) {
      if (e.kind !== 'link') continue;
      const g = linkGeom(e);
      if (!g) continue;
      const c = e.bundle.counts;
      const dominant = c.answered >= c.delivered && c.answered >= c.queued ? 'answered' : c.delivered >= c.queued ? 'delivered' : 'queued';
      const col = dominant === 'answered' ? C.green : dominant === 'queued' ? C.orange : C.accent;
      const al = e.archived ? 0.35 : 1;
      const focus = e.key === selectedKey || e.key === hoverKey;
      stroke(col, e.width + (focus ? 1.5 : 0), 0.85 * al, dominant === 'queued' ? [6, 5] : null);
      ctx.beginPath(); ctx.moveTo(g.s.x, g.s.y); ctx.quadraticCurveTo(g.c.x, g.c.y, g.t.x, g.t.y); ctx.stroke();
      if (e.bundle.ab) arrow(g.t, g.c, col, 0.9 * al);
      if (e.bundle.ba) arrow(g.s, g.c, col, 0.9 * al);
    }
    ctx.setLineDash([]);
  }

  function drawParticles(t) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i];
      const u = (t - q.t0) / q.dur;
      if (u >= 1) { particles.splice(i, 1); continue; }
      let pt;
      if (q.kind === 'link') {
        const e = edgeByKey.get(q.ekey);
        const g = e && linkGeom(e);
        if (!g) { particles.splice(i, 1); continue; }
        const uu = q.rev ? 1 - u : u;
        pt = quadAt(g.s, g.c, g.t, uu);
      } else {
        const a = posOf(q.a), b = posOf(q.b);
        if (!a || !b) { particles.splice(i, 1); continue; }
        pt = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
      }
      const col = C[q.color] || C.accent;
      const fade = Math.sin(Math.min(1, u) * Math.PI);
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.25 * fade; ctx.beginPath(); ctx.arc(pt.x, pt.y, 8 / vp.k, 0, 6.2832); ctx.fill();
      ctx.globalAlpha = 0.95 * Math.min(1, fade * 1.6); ctx.beginPath(); ctx.arc(pt.x, pt.y, 3.6 / vp.k, 0, 6.2832); ctx.fill();
    }
  }

  function pulse(x, y, r, color, t) {
    if (reducedMotion()) { ctx.globalAlpha = 0.45; ctx.strokeStyle = color; ctx.lineWidth = 1.5 / vp.k; ctx.beginPath(); ctx.arc(x, y, r * 1.35, 0, 6.2832); ctx.stroke(); return; }
    const ph = (t % 1600) / 1600;
    ctx.globalAlpha = (1 - ph) * 0.7; ctx.strokeStyle = color; ctx.lineWidth = 1.5 / vp.k;
    ctx.beginPath(); ctx.arc(x, y, r * (1 + 0.9 * ph), 0, 6.2832); ctx.stroke();
  }
  const circle = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, Math.max(0.1, r), 0, 6.2832); };

  function drawSession(v, x, y, r, t, al) {
    const st = nodeStatus(v);
    const col = toneColor(st.tone);
    const main = v.kind === 'main';
    ctx.setLineDash([]);
    if (v.ghost) {
      ctx.globalAlpha = al * 0.9; ctx.fillStyle = C.bg2; circle(x, y, r); ctx.fill();
      stroke(main ? C.accent : C.label3, 2, al, [5, 4]); circle(x, y, r); ctx.stroke(); ctx.setLineDash([]);
      return;
    }
    const busy = v.row && v.row.busy && v.row.status !== 'ended';
    const waiting = st.tone === 'indigo';
    if (main && busy && !waiting) {
      const ar = r + 17, a0 = reducedMotion() ? 0 : ((t % 1800) / 1800) * 6.2832;
      stroke(C.accent, 1.5, al * 0.2); circle(x, y, ar); ctx.stroke();
      stroke(C.accent, 2.6, al * 0.85); ctx.beginPath(); ctx.arc(x, y, ar, a0, a0 + 1.7); ctx.stroke();
    } else if (busy || waiting) pulse(x, y, r, col, t);
    if (main) { ctx.globalAlpha = al * 0.16; ctx.fillStyle = C.accent; circle(x, y, r + 11); ctx.fill(); }
    ctx.globalAlpha = al; ctx.fillStyle = C.bg2; circle(x, y, r); ctx.fill();
    stroke(col, main ? 3.5 : 2.5, al); circle(x, y, r); ctx.stroke();
    if (main) { stroke(C.accent, 1.5, al * 0.7); circle(x, y, r + 11); ctx.stroke(); }
    if (v.row && v.row.contextPercent != null && v.row.status !== 'ended') {
      const lvl = ctxLevel(v.row.contextPercent);
      const rr = r + (main ? 6 : 4.5);
      stroke(C.label3, 3, al * 0.22); circle(x, y, rr); ctx.stroke();
      stroke(lvl === 'critical' ? C.red : lvl === 'warn' ? C.orange : C.green, 3, al);
      ctx.beginPath(); ctx.arc(x, y, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, v.row.contextPercent / 100)); ctx.stroke();
    }
    ctx.globalAlpha = al; ctx.fillStyle = C.label; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(r * 0.95)}px ${FONT}`;
    ctx.fillText((pname(v.projectId)[0] || 'S').toUpperCase(), x, y + r * 0.04);
  }

  function drawAgent(v, x, y, r, t, al) {
    const a = v.row;
    const col = toneColor(agentStatusTone(a));
    ctx.setLineDash([]);
    if (a.status === 'running' || a.status === 'waiting') pulse(x, y, r, col, t);
    const solid = a.status === 'done' || a.status === 'failed' || a.status === 'waiting';
    ctx.globalAlpha = al; ctx.fillStyle = solid ? col : C.bg2; circle(x, y, r); ctx.fill();
    if (!solid) { stroke(col, 2.2, al, a.status === 'stalled' ? [3, 2.5] : null); circle(x, y, r); ctx.stroke(); ctx.setLineDash([]); }
    const g = r * 0.5;
    ctx.strokeStyle = C.bg; ctx.fillStyle = C.bg; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(1.4, r * 0.2);
    ctx.globalAlpha = al;
    ctx.beginPath();
    if (a.status === 'done') { ctx.moveTo(x - g * 0.85, y + g * 0.05); ctx.lineTo(x - g * 0.2, y + g * 0.7); ctx.lineTo(x + g * 0.95, y - g * 0.6); ctx.stroke(); }
    else if (a.status === 'failed') { ctx.moveTo(x - g * 0.7, y - g * 0.7); ctx.lineTo(x + g * 0.7, y + g * 0.7); ctx.moveTo(x + g * 0.7, y - g * 0.7); ctx.lineTo(x - g * 0.7, y + g * 0.7); ctx.stroke(); }
    else if (a.status === 'waiting') { ctx.moveTo(x, y - g * 0.95); ctx.lineTo(x, y + g * 0.15); ctx.stroke(); circle(x, y + g * 0.78, Math.max(0.9, r * 0.12)); ctx.fill(); }
    else if (a.status === 'running') { ctx.fillStyle = col; circle(x, y, r * 0.38); ctx.fill(); }
    else if (a.status === 'stalled') { ctx.strokeStyle = col; ctx.moveTo(x - g * 0.4, y - g * 0.7); ctx.lineTo(x - g * 0.4, y + g * 0.7); ctx.moveTo(x + g * 0.4, y - g * 0.7); ctx.lineTo(x + g * 0.4, y + g * 0.7); ctx.stroke(); }
  }

  function okDot(x, y, rad, al) {
    ctx.setLineDash([]);
    ctx.globalAlpha = al; ctx.fillStyle = C.purple; circle(x, y, rad); ctx.fill();
    stroke(C.bg2, 1.6, al); circle(x, y, rad); ctx.stroke();
  }
  let drawOrder = [];
  function draw(t) {
    if (colorsDirty) readColors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, Hh);
    if (!model) return;
    ctx.save();
    ctx.translate(vp.x, vp.y); ctx.scale(vp.k, vp.k);
    drawEdges(t);
    drawParticles(t);
    drawOrder = Array.from(vn.values());
    drawOrder.sort((a, b) => (a.kind === 'agent') - (b.kind === 'agent') || (a.kind === 'main') - (b.kind === 'main'));
    const all = dying.length ? drawOrder.concat(dying) : drawOrder;
    for (let i = dying.length - 1; i >= 0; i--) if (t - dying[i].dieAt > FADE_MS) dying.splice(i, 1);
    for (const v of all) {
      const sc = nodeScale(v, t);
      if (sc <= 0.01) continue;
      const p = v.p || v;
      const r = v.r * sc;
      const al = nodeAlpha(v) * fadeOf(v, t);
      if (v.key === selectedKey || v.key === hoverKey) {
        ctx.setLineDash([]);
        stroke(C.accent, 2, v.key === selectedKey ? 0.95 : 0.5, v.key === selectedKey ? [4, 3] : null);
        circle(p.x, p.y, r + (v.kind === 'main' ? 17 : 8)); ctx.stroke(); ctx.setLineDash([]);
      }
      if (v.kind === 'agent') drawAgent(v, p.x, p.y, r, t, al); else drawSession(v, p.x, p.y, r, t, al);
      if (v.needsOk && !v.archived) okDot(p.x + r * 0.78, p.y - r * 0.78, Math.max(3.5, r * 0.27), al);
    }
    ctx.restore();
    ctx.setLineDash([]);
    drawLabels(all, t);
  }

  const wcache = new Map();
  /** Text width in the current ctx.font, cached (labels repeat every frame). */
  function tw(text) {
    const k = `${ctx.font}\n${text}`;
    let w = wcache.get(k);
    if (w === undefined) { w = ctx.measureText(text).width; if (wcache.size > 3000) wcache.clear(); wcache.set(k, w); }
    return w;
  }
  function pill(text, x, y, bg, fg, size) {
    ctx.font = `700 ${size}px ${FONT}`;
    const w = tw(text) + 10, hh = size + 6;
    ctx.fillStyle = bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - hh / 2, w, hh, hh / 2); else ctx.rect(x - w / 2, y - hh / 2, w, hh);
    ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
    return [x - w / 2, y - hh / 2, x + w / 2, y + hh / 2];
  }

  /** Labels in priority order: Main and sessions always, then link pills, then subagent labels (hover/selection, or zoomed in). Lower ones are skipped when they would overlap. */
  function drawLabels(all, t) {
    const grid = new Map(); // boxes bucketed in 80px cells, so a clash check is not a scan of every label
    const eachCell = (b, fn) => { for (let x = Math.floor(b[0] / 80); x <= Math.floor(b[2] / 80); x++) for (let y = Math.floor(b[1] / 80); y <= Math.floor(b[3] / 80); y++) if (fn(`${x},${y}`)) return true; return false; };
    const addBox = (b) => { eachCell(b, (k) => { (grid.get(k) || grid.set(k, []).get(k)).push(b); return false; }); };
    const clash = (b) => eachCell(b, (k) => (grid.get(k) || []).some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]));
    const vis = [];
    for (const v of all) {
      const sc = nodeScale(v, t);
      if (sc <= 0.3) continue;
      const p = v.p || v;
      const sx = vp.x + p.x * vp.k, sy = vp.y + p.y * vp.k, rr = v.r * sc * vp.k;
      if (sx < -140 || sy < -90 || sx > W + 140 || sy > Hh + 90) continue;
      vis.push({ v, sx, sy, rr, al: nodeAlpha(v) * fadeOf(v, t) });
      addBox([sx - rr - 2, sy - rr - 2, sx + rr + 2, sy + rr + 2]);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    // 1. Main, sessions, ghosts
    for (const { v, sx, sy, rr, al } of vis) {
      if (v.kind === 'agent') continue;
      const st = nodeStatus(v);
      const main = v.kind === 'main';
      ctx.globalAlpha = al;
      let y = sy + rr + (main ? 26 : 17);
      let w = 0;
      if (main) { ctx.fillStyle = C.accent; ctx.font = `700 10px ${FONT}`; ctx.fillText('MAIN', sx, sy - rr - (v.ghost ? 12 : 22)); }
      ctx.fillStyle = C.label; ctx.font = `650 ${main ? 14 : 12.5}px ${FONT}`;
      const title = truncate(nodeTitle(v), 22);
      ctx.fillText(title, sx, y); w = tw(title);
      let lines = 1;
      if (v.ghost || vp.k >= 0.4) {
        ctx.fillStyle = v.ghost ? C.label3 : C.label2; ctx.font = `500 11px ${FONT}`;
        const sub = truncate(nodeSub(v), 30);
        ctx.fillText(sub, sx, y + 14); w = Math.max(w, tw(sub)); lines = 2;
      }
      if (!v.ghost && vp.k >= 0.4) {
        ctx.fillStyle = toneColor(st.tone); ctx.font = `650 ${main ? 11.5 : 10.5}px ${FONT}`;
        const line = truncate(`${st.text}${v.row && v.row.model ? ` · ${modelWord(v.row.model)}` : ''}`, 34);
        ctx.fillText(line, sx, y + 28); w = Math.max(w, tw(line)); lines = 3;
      }
      addBox([sx - w / 2 - 3, y - 13, sx + w / 2 + 3, y + 14 * (lines - 1) + 4]);
    }
    // 2. link bundles: ONE badge with the count per edge, one small purple dot when any member needs your OK
    for (const e of model.edges) {
      if (e.kind !== 'link') continue;
      const g = linkGeom(e);
      if (!g) continue;
      const mx = vp.x + g.mid.x * vp.k, my = vp.y + g.mid.y * vp.k;
      if (mx < -40 || my < -40 || mx > W + 40 || my > Hh + 40) continue;
      const focus = e.key === selectedKey || e.key === hoverKey;
      ctx.globalAlpha = e.archived ? 0.45 : 1;
      const box = pill(String(e.n), mx, my, C.bg2, C.label, 10.5);
      ctx.setLineDash([]); ctx.strokeStyle = e.needsOk ? C.purple : C.sep; ctx.lineWidth = focus ? 2 : 1.2;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(box[0], box[1], box[2] - box[0], box[3] - box[1], 99); else ctx.rect(box[0], box[1], box[2] - box[0], box[3] - box[1]); ctx.stroke();
      if (e.needsOk) { ctx.fillStyle = C.purple; ctx.beginPath(); ctx.arc(box[2] - 1, box[1] + 1, 4.5, 0, 6.2832); ctx.fill(); ctx.strokeStyle = C.bg2; ctx.lineWidth = 1.4; ctx.stroke(); }
      addBox(box);
      if (focus && e.needsOk) { const b = pill(`${e.bundle.counts.needOk} need OK`, mx, my - 18, C.bg2, C.purple, 9.5); addBox(b); }
    }
    // 2b. "+N more" chips on sessions that hold back finished subagents
    chipHits = [];
    for (const { v, sx, sy, rr, al } of vis) {
      if (!v.more || !v.more.length) continue;
      ctx.globalAlpha = al;
      const key = `m:${v.key}`;
      const b = pill(`+${v.more.length} more`, sx + rr + 26, sy + rr * 0.6, key === selectedKey || key === hoverKey ? C.accent : C.bg2, key === selectedKey || key === hoverKey ? C.bg : C.purple, 10);
      chipHits.push({ key, box: b });
    }
    // 3. subagent labels: hover / selection, or zoomed in past a threshold
    for (const { v, sx, sy, rr, al } of vis) {
      if (v.kind !== 'agent') continue;
      const focus = v.key === selectedKey || v.key === hoverKey;
      if (!focus && vp.k < 1.4) continue;
      ctx.globalAlpha = al; ctx.font = `${focus ? 650 : 500} 11px ${FONT}`;
      const text = nodeTitle(v), w = tw(text);
      const b = [sx - w / 2 - 2, sy + rr + 3, sx + w / 2 + 2, sy + rr + 17];
      if (!focus && clash(b)) continue;
      ctx.fillStyle = focus ? C.label : C.label2; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, sx, sy + rr + 14);
      addBox(b);
    }
    ctx.globalAlpha = 1;
  }
  const modelWord = (m) => { const s = String(m).toLowerCase(); return s.includes('opus') ? 'Opus' : s.includes('sonnet') ? 'Sonnet' : s.includes('haiku') ? 'Haiku' : truncate(String(m).replace(/^claude-?/i, ''), 10); };

  /* ---------- loop ---------- */
  function animating(t) {
    if (sim.active || particles.length || dying.length || dragging) return 'fast';
    for (const v of vn.values()) if (v.born > -1e8 && t - v.born < POP_MS + 40) return 'fast';
    if (easeCamera()) return 'fast';
    if (reducedMotion()) return null;
    for (const v of vn.values()) {
      if (v.kind === 'agent' ? (v.row.status === 'running' || v.row.status === 'waiting') : (v.row && v.row.status !== 'ended' && (v.row.busy || sel.sessionWaiting(v.row.id)))) return 'slow';
    }
    return null;
  }
  function frame() {
    raf = 0;
    if (destroyed || document.hidden) return;
    const t = performance.now();
    if (sim.active) sim.tick();
    draw(t);
    const mode = animating(t);
    if (mode === 'fast') raf = requestAnimationFrame(frame);
    else if (mode === 'slow' && !slowTimer) slowTimer = setTimeout(() => { slowTimer = 0; kick(); }, 40);
  }
  function kick() { if (!raf && !destroyed && !document.hidden) raf = requestAnimationFrame(frame); }
  const onVis = () => { if (!document.hidden) kick(); };
  document.addEventListener('visibilitychange', onVis);

  /* ---------- sizing ---------- */
  function resize() {
    const r = stage.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), hh = Math.max(1, Math.floor(r.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === W && hh === Hh && canvas.width === Math.floor(w * dpr)) return;
    const first = W === 0;
    W = w; Hh = hh;
    const asp = Math.max(0.4, Math.min(2.4, w / hh));
    if (Math.abs(asp - sim.aspect) > 0.15) { sim.aspect = asp; sim.reheat(0.6); } // a different stage shape re-spreads the layout
    canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(Hh * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${Hh}px`;
    if (first) fit(true);
    if (model) draw(performance.now()); // a resize clears the canvas: repaint now, not on the next frame
    kick();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(stage);
  else window.addEventListener('resize', resize);

  /* ---------- pointer: hover, click, drag, pan, pinch ---------- */
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function hitTest(lx, ly) {
    const t = performance.now();
    for (const c of chipHits) if (lx >= c.box[0] - 3 && lx <= c.box[2] + 3 && ly >= c.box[1] - 3 && ly <= c.box[3] + 3) return c.key;
    for (let i = drawOrder.length - 1; i >= 0; i--) {
      const v = drawOrder[i];
      if (!v.p) continue;
      const rad = Math.max(v.r * nodeScale(v, t) * vp.k, 11) + 3;
      const dx = vp.x + v.p.x * vp.k - lx, dy = vp.y + v.p.y * vp.k - ly;
      if (dx * dx + dy * dy <= rad * rad) return v.key;
    }
    let best = null, bd = 15 * 15;
    if (model) {
      for (const e of model.edges) {
        if (e.kind !== 'link') continue;
        const g = linkGeom(e);
        if (!g) continue;
        const dx = vp.x + g.mid.x * vp.k - lx, dy = vp.y + g.mid.y * vp.k - ly;
        if (dx * dx + dy * dy <= bd) { bd = dx * dx + dy * dy; best = e.key; }
      }
    }
    return best;
  }
  canvas.addEventListener('pointerdown', (e) => {
    const p = local(e);
    pointers.set(e.pointerId, p);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    hideTip();
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      dragging = null; panning = null; autoFit = false;
      return;
    }
    const key = hitTest(p.x, p.y);
    const v = key && vn.get(key);
    if (v && v.p) { dragging = { key, moved: false, sx: p.x, sy: p.y, ox: v.p.x - (p.x - vp.x) / vp.k, oy: v.p.y - (p.y - vp.y) / vp.k }; }
    else if (key) { dragging = { key, moved: false, sx: p.x, sy: p.y, link: true }; }
    else panning = { moved: false, sx: p.x, sy: p.y, lx: p.x, ly: p.y };
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = Array.from(pointers.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      zoomAt(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch.d = d;
      return;
    }
    if (dragging) {
      if (!dragging.moved && Math.hypot(p.x - dragging.sx, p.y - dragging.sy) > 4) {
        dragging.moved = true;
        const v = vn.get(dragging.key);
        if (v && v.p) { v.p.pin = true; autoFit = false; }
      }
      if (dragging.moved && !dragging.link) {
        const v = vn.get(dragging.key);
        if (v && v.p) { v.p.x = dragging.ox + (p.x - vp.x) / vp.k; v.p.y = dragging.oy + (p.y - vp.y) / vp.k; sim.reheat(0.3); }
        kick();
      }
      return;
    }
    if (panning) {
      if (!panning.moved && Math.hypot(p.x - panning.sx, p.y - panning.sy) > 4) { panning.moved = true; autoFit = false; }
      if (panning.moved) { vp.x += p.x - panning.lx; vp.y += p.y - panning.ly; kick(); }
      panning.lx = p.x; panning.ly = p.y;
      return;
    }
    if (e.pointerType === 'mouse') hover(p.x, p.y);
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size) return;
    if (dragging) {
      const v = vn.get(dragging.key);
      if (v && v.p) v.p.pin = false;
      if (!dragging.moved) select(dragging.key);
      else sim.reheat(0.25);
      dragging = null; kick();
    } else if (panning) {
      if (!panning.moved) closePanel(false);
      panning = null;
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { if (!dragging) hideTip(); });
  canvas.addEventListener('dblclick', (e) => { const p = local(e); if (!hitTest(p.x, p.y)) fit(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016)), p.x, p.y);
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const pan = (dx, dy) => { vp.x += dx; vp.y += dy; autoFit = false; kick(); };
    if (e.key === '+' || e.key === '=') zoomBy(1.3);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.3);
    else if (e.key === '0') fit();
    else if (e.key === 'ArrowLeft') pan(48, 0);
    else if (e.key === 'ArrowRight') pan(-48, 0);
    else if (e.key === 'ArrowUp') pan(0, 48);
    else if (e.key === 'ArrowDown') pan(0, -48);
    else if (e.key === 'Escape' && selectedKey) closePanel();
    else return;
    e.preventDefault();
  });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } });

  /* ---------- tooltip ---------- */
  function hover(lx, ly) {
    const key = hitTest(lx, ly);
    canvas.style.cursor = key ? 'pointer' : '';
    if (key !== hoverKey) { hoverKey = key; kick(); }
    if (!key) { hideTip(); return; }
    paintTip(key);
    const w = tip.offsetWidth || 220, hh = tip.offsetHeight || 90;
    tip.style.left = `${Math.max(8, Math.min(W - w - 8, lx + 16))}px`;
    tip.style.top = `${Math.max(8, Math.min(Hh - hh - 8, ly + 16))}px`;
    setHidden(tip, false);
  }
  function hideTip() { if (hoverKey) { hoverKey = null; kick(); } setHidden(tip, true); canvas.style.cursor = ''; }
  function paintTip(key) {
    const v = viewOf(key);
    if (!v) return;
    if (v.type === 'bundle') {
      const c = v.bundle.counts;
      setText(tipTitle, bundleTitle(v));
      setText(tipStatus, plural(v.n, 'link'));
      tipElapsed.removeAttribute('data-since'); setText(tipElapsed, countsText(c));
      tipNd.__set(c.needOk ? `${c.needOk} need your OK` : '', false);
      setText(tipMeta, v.bundle.items[0] ? truncate(v.bundle.items[0].link.text || '', 70) : '');
      return;
    }
    if (v.type === 'more') {
      setText(tipTitle, `${nodeTitle(v.node)}: ${plural(v.rows.length, 'more finished subagent')}`);
      setText(tipStatus, 'Need your OK. Click to list them');
      tipElapsed.removeAttribute('data-since'); setText(tipElapsed, '');
      tipNd.__set('', false); setText(tipMeta, '');
      return;
    }
    const st = nodeStatus(v);
    const r = v.row;
    setText(tipTitle, nodeTitle(v));
    setText(tipStatus, `${v.kind === 'main' ? 'Main · ' : ''}${st.text}${v.needsOk ? ' · Needs your OK' : ''}${r && r.model ? ` · ${modelWord(r.model)}` : ''}`);
    const since = nodeSince(v);
    if (since) { tipElapsed.setAttribute('data-since', since); setText(tipElapsed, fmtElapsed(Date.now() - since)); }
    else { tipElapsed.removeAttribute('data-since'); setText(tipElapsed, r ? `Took ${nodeDuration(v)}` : ''); }
    tipNd.__set(v.kind === 'agent' ? agentNow(r) : r && r.nowDoing, !!r && isLiveNode(v) && (v.kind === 'agent' ? r.status === 'running' : r.busy));
    setText(tipMeta, r ? [r.tokens ? `${fmtTokens(r.tokens)} tok` : '', r.costUsd ? fmtUsd(r.costUsd) : ''].filter(Boolean).join(' · ') : '');
  }

  /* ---------- live feed: a faint particle main -> session while that session is busy ---------- */
  const offAct = onActivity((a) => {
    if (reducedMotion() || !model || !model.main || !a.sessionId || document.hidden) return;
    const key = `s:${a.sessionId}`;
    if (key === model.main.key || !vn.has(key)) return;
    const t = performance.now();
    if (t - (lastStruct.get(key) || 0) < 900) return;
    lastStruct.set(key, t);
    particles.push({ kind: 'struct', a: model.main.key, b: key, t0: t, dur: 900, color: 'accent' });
    kick();
  });

  /* ---------- boot ---------- */
  const staleTimer = setInterval(() => { if (!state.caps.ack) refresh(); }, 30000);
  refresh();
  requestAnimationFrame(resize);

  return {
    watch: ['session', 'agent', 'project', 'ui', 'ready', 'question', 'link'],
    update() { refresh(); },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf); clearTimeout(slowTimer); clearInterval(staleTimer);
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
      if (mq && mq.removeEventListener) mq.removeEventListener('change', dirtyColors);
      offPrefs(); offAct();
      wrap.remove();
    },
  };
}
