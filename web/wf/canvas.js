// wf/canvas.js — the workflow canvas: pan/zoom world, HTML node cards, SVG edges, connecting, marquee, clipboard,
// minimap and the live run overlay. No libraries. One `div.wf-world` carries `translate(x,y) scale(k)`; nodes live in an
// HTML layer and edges in an SVG layer of the same world, so both zoom together.
import { h, s, setText, setClass, setHidden, reconcile, reducedMotion } from '../dom.js';
import { icon } from '../icons.js';
import { modelBadge, openMenu } from '../ui.js';
import { renderMarkdown } from '../markdown.js';
import { fmtElapsed, fmtUsdSmall, truncate } from '../format.js';
import {
  PALETTE, TYPE_META, GRID, NODE_W, snap, clone, makeNode, kindsFor, defaultKind, wouldCycle, summarize, modelOf, isExec, EDGE_LABEL, autoLayout,
} from './graph.js';

export const STATE_LABEL = {
  pending: 'Waiting', ready: 'Ready', queued: 'Queued', running: 'Running', ok: 'Done', failed: 'Failed',
  skipped: 'Skipped', waiting_gate: 'Needs you', abandoned: 'Stopped',
};
const PORT_Y = 28; // port height from the top of a card (world px)
const MIN_K = 0.25, MAX_K = 2;
const clampK = (k) => Math.min(MAX_K, Math.max(MIN_K, k));
const TERMINAL = new Set(['ok', 'failed', 'skipped', 'abandoned']);

/** Which outgoing edge kind a finished run node takes; null when it takes none (skipped by routing, abandoned). */
export function outcomeOf(node, rn) {
  if (!rn) return null;
  if (rn.state === 'ok') return node.type === 'gate' ? 'approved' : 'ok';
  if (rn.state === 'failed') return node.type === 'gate' ? 'rejected' : 'fail';
  if (rn.state === 'skipped') return rn.output && rn.output.skipped ? (node.type === 'gate' ? 'approved' : 'ok') : null;
  return null;
}

export function createCanvas({ onSelection, onViewport, onAdd, onGate, onNodeAction, onOpenNode } = {}) {
  let doc = null;
  let readOnly = true;
  let tool = 'hand'; // hand: drag pans, ⇧-drag selects | select: drag selects
  let spaceDown = false;
  const view = { x: 0, y: 0, k: 1 };
  const selection = { nodes: new Set(), edge: null };
  const sizes = new Map(); // node id -> {w,h}
  let run = null; // live run overlay: Run row with nodes inlined
  let prevStates = new Map();
  let issues = new Map(); // node id -> [message]
  let clipboard = null;
  let pasteCount = 0;
  let unsub = null;
  let rafMini = 0;
  let animTimer = 0;

  /* ---------------------------------------------------------------- structure */
  const nodesLayer = h('div', { class: 'wf-nodes' });
  const labelsLayer = h('div', { class: 'wf-labels' });
  const edgesG = s('g', { class: 'wf-edges' });
  const wireG = s('g', { class: 'wf-wiring' });
  const defs = s('defs', {});
  for (const k of ['ok', 'fail', 'approved', 'rejected', 'idle']) {
    defs.append(s('marker', { id: `wf-arr-${k}`, viewBox: '0 0 10 10', refX: '8.5', refY: '5', markerWidth: '9', markerHeight: '9', orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' },
      s('path', { d: 'M1 1.5 L8.5 5 L1 8.5 z', class: `wf-arrow k-${k}` })));
  }
  const svg = s('svg', { class: 'wf-svg', width: '1', height: '1', 'aria-hidden': 'true' }, defs, edgesG, wireG);
  const world = h('div', { class: 'wf-world' }, svg, labelsLayer, nodesLayer);
  const marquee = h('div', { class: 'wf-marquee', hidden: true });
  const viewport = h('div', { class: 'wf-viewport', 'data-tool': tool }, world, marquee);

  // controls (bottom-left) + minimap (bottom-right)
  const zoomLabel = h('button', { class: 'wf-zoom-val mono', type: 'button', title: 'Reset to 100%', onclick: () => zoomTo(1) }, '100%');
  const btn = (ic, label, fn) => h('button', { class: 'wf-ctl-btn', type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(ic, 16));
  const handBtn = h('button', { class: 'wf-ctl-btn on', type: 'button', 'aria-label': 'Hand tool: drag to pan (H)', title: 'Hand: drag pans, ⇧-drag selects (H)', 'aria-pressed': 'true', onclick: () => setTool('hand') }, icon('hand', 16));
  const selBtn = h('button', { class: 'wf-ctl-btn', type: 'button', 'aria-label': 'Select tool: drag to select (V)', title: 'Select: drag draws a box (V)', 'aria-pressed': 'false', onclick: () => setTool('select') }, icon('pointer', 16));
  const controls = h('div', { class: 'wf-controls', role: 'toolbar', 'aria-label': 'Canvas controls' },
    handBtn, selBtn, h('span', { class: 'wf-ctl-sep' }),
    btn('minus', 'Zoom out', () => zoomBy(1 / 1.25)), zoomLabel, btn('plus', 'Zoom in', () => zoomBy(1.25)),
    h('span', { class: 'wf-ctl-sep' }),
    h('button', { class: 'wf-ctl-text', type: 'button', title: 'Fit everything (0)', onclick: () => fit() }, icon('fit', 15), 'Fit'),
    h('button', { class: 'wf-ctl-text', type: 'button', title: 'Zoom to 100% (1)', onclick: () => zoomTo(1) }, '100%'));
  const mmSvg = s('svg', { class: 'wf-mm-svg', viewBox: '0 0 160 100', preserveAspectRatio: 'xMidYMid meet' });
  const minimap = h('div', { class: 'wf-minimap', role: 'img', 'aria-label': 'Minimap' }, mmSvg);
  const empty = h('div', { class: 'wf-empty', hidden: true },
    h('div', { class: 'wf-empty-ic' }, icon('workflow', 26)),
    h('strong', {}, 'An empty canvas'),
    h('span', {}, 'Drag a step from the palette, or double-click anywhere.'));
  const root = h('div', { class: 'wf-canvas', tabindex: '0', role: 'application', 'aria-label': 'Workflow canvas' }, viewport, empty, controls, minimap);

  /* ------------------------------------------------------------ view transform */
  function applyView(animate = false) {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    const gs = GRID * view.k;
    viewport.style.backgroundSize = `${gs}px ${gs}px`;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
    viewport.style.setProperty('--wf-k', String(view.k));
    if (animate && !reducedMotion()) {
      world.classList.add('animating');
      clearTimeout(animTimer);
      animTimer = setTimeout(() => world.classList.remove('animating'), 280);
    }
    setText(zoomLabel, `${Math.round(view.k * 100)}%`);
    drawMini();
    if (onViewport) onViewport({ ...view });
  }
  const rectOf = () => viewport.getBoundingClientRect();
  function toWorld(cx, cy) {
    const r = rectOf();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  }
  function zoomAt(k2, cx, cy, animate = false) {
    k2 = clampK(k2);
    const r = rectOf();
    const px = cx - r.left, py = cy - r.top;
    view.x = px - ((px - view.x) / view.k) * k2;
    view.y = py - ((py - view.y) / view.k) * k2;
    view.k = k2;
    applyView(animate);
  }
  function zoomBy(f) { const r = rectOf(); zoomAt(view.k * f, r.left + r.width / 2, r.top + r.height / 2, true); }
  function zoomTo(k) { const r = rectOf(); zoomAt(k, r.left + r.width / 2, r.top + r.height / 2, true); }
  function boundsOf(ids) {
    const list = doc ? doc.graph.nodes.filter((n) => !ids || ids.has(n.id)) : [];
    if (!list.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of list) {
      const sz = sizes.get(n.id) || { w: NODE_W, h: 96 };
      x0 = Math.min(x0, n.position.x); y0 = Math.min(y0, n.position.y);
      x1 = Math.max(x1, n.position.x + sz.w); y1 = Math.max(y1, n.position.y + sz.h);
    }
    return { x0, y0, x1, y1 };
  }
  function fit(ids = null, animate = true) {
    const b = boundsOf(ids);
    const r = rectOf();
    if (!b || !r.width) { view.x = 80; view.y = 80; view.k = 1; applyView(); return; }
    const pad = 72;
    const k = clampK(Math.min((r.width - pad * 2) / Math.max(1, b.x1 - b.x0), (r.height - pad * 2) / Math.max(1, b.y1 - b.y0), 1.15));
    view.k = k;
    view.x = (r.width - (b.x1 - b.x0) * k) / 2 - b.x0 * k;
    view.y = (r.height - (b.y1 - b.y0) * k) / 2 - b.y0 * k;
    applyView(animate);
  }
  function centerOn(id) {
    const n = doc && doc.node(id);
    if (!n) return;
    const sz = sizes.get(id) || { w: NODE_W, h: 96 };
    const r = rectOf();
    view.x = r.width / 2 - (n.position.x + sz.w / 2) * view.k;
    view.y = r.height / 2 - (n.position.y + sz.h / 2) * view.k;
    applyView(true);
  }
  function setTool(t) {
    tool = t;
    viewport.setAttribute('data-tool', t);
    setClass(handBtn, 'on', t === 'hand'); setClass(selBtn, 'on', t === 'select');
    handBtn.setAttribute('aria-pressed', String(t === 'hand')); selBtn.setAttribute('aria-pressed', String(t === 'select'));
  }

  /* ----------------------------------------------------------------- selection */
  function emitSelection() { if (onSelection) onSelection({ nodes: [...selection.nodes], edge: selection.edge }); }
  function select(ids, edge = null, silent = false) {
    selection.nodes = new Set(ids);
    selection.edge = edge;
    paintSelection();
    if (!silent) emitSelection();
  }
  function paintSelection() {
    for (const el of nodesLayer.children) setClass(el, 'selected', selection.nodes.has(el.__id));
    for (const g of edgesG.children) setClass(g, 'selected', g.__id === selection.edge);
    for (const l of labelsLayer.children) setClass(l, 'selected', l.__id === selection.edge);
    drawMini();
  }

  /* --------------------------------------------------------------- node cards */
  function createNodeEl(n) {
    const r = {};
    r.icon = h('span', { class: 'wf-n-icon' });
    r.title = h('span', { class: 'wf-n-title' });
    r.badge = h('span', { class: 'wf-n-badge' });
    r.body = h('div', { class: 'wf-n-body' });
    r.stDot = h('span', { class: 'wf-n-dot', 'aria-hidden': 'true' });
    r.stText = h('span', { class: 'wf-n-st' });
    r.time = h('span', { class: 'wf-n-time mono' });
    r.cost = h('span', { class: 'wf-n-cost mono' });
    r.foot = h('div', { class: 'wf-n-foot', hidden: true }, r.stDot, r.stText, h('span', { class: 'spacer' }), r.time, r.cost);
    r.err = h('div', { class: 'wf-n-err', hidden: true });
    r.comment = h('input', { class: 'wf-n-comment', type: 'text', placeholder: 'Comment (optional)', 'aria-label': 'Comment for the decision', maxlength: '1000', autocomplete: 'off' });
    r.approve = h('button', { class: 'wf-n-btn approve', type: 'button' }, icon('check', 14), 'Approve');
    r.reject = h('button', { class: 'wf-n-btn reject', type: 'button' }, icon('close', 13), 'Reject');
    r.gate = h('div', { class: 'wf-n-gate', hidden: true }, r.comment, h('div', { class: 'wf-n-gate-row' }, r.approve, r.reject));
    r.retry = h('button', { class: 'wf-n-btn', type: 'button', title: 'Run this step again' }, icon('retry', 13), 'Retry');
    r.skip = h('button', { class: 'wf-n-btn', type: 'button', title: 'Skip this step and carry on' }, icon('skip', 13), 'Skip');
    r.ctl = h('div', { class: 'wf-n-ctl', hidden: true }, r.retry, r.skip);
    r.issue = h('span', { class: 'wf-n-issue', hidden: true }, icon('warning', 13));
    r.pin = h('span', { class: 'wf-port in', 'data-port': 'in', title: 'Drop a connection here' });
    r.pout = h('span', { class: 'wf-port out', 'data-port': 'out', title: 'Drag to connect' });
    const el = h('article', { class: 'wf-node', tabindex: '0', role: 'group', 'data-id': n.id },
      r.pin, r.pout, h('div', { class: 'wf-n-head' }, r.icon, r.title, r.badge, r.issue), r.body, r.foot, r.err, r.gate, r.ctl);
    el.__r = r;
    el.__id = n.id;
    r.approve.addEventListener('click', (e) => { e.stopPropagation(); gateDecide(el, 'approve'); });
    r.reject.addEventListener('click', (e) => { e.stopPropagation(); gateDecide(el, 'reject'); });
    r.comment.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); gateDecide(el, 'approve'); } });
    r.retry.addEventListener('click', (e) => { e.stopPropagation(); onNodeAction && onNodeAction('retry', el.__id); });
    r.skip.addEventListener('click', (e) => { e.stopPropagation(); onNodeAction && onNodeAction('skip', el.__id); });
    el.addEventListener('dblclick', (e) => { if (e.target.closest('input,button,.wf-port')) return; e.stopPropagation(); onOpenNode && onOpenNode(el.__id); });
    return el;
  }
  function gateDecide(el, decision) {
    if (!run || !onGate) return;
    onGate(run.id, el.__id, decision, el.__r.comment.value.trim());
    el.__r.comment.value = '';
  }

  function updateNodeEl(el, n) {
    const r = el.__r;
    el.__node = n;
    const meta = TYPE_META[n.type] || TYPE_META.agent;
    el.className = `wf-node t-${meta.tone}${selection.nodes.has(n.id) ? ' selected' : ''}`;
    if (r.icon.__i !== meta.icon) { r.icon.__i = meta.icon; r.icon.textContent = ''; r.icon.append(icon(meta.icon, 15)); }
    setText(r.title, n.label);
    const model = modelOf(n);
    if (r.badge.__m !== model) { r.badge.__m = model; r.badge.textContent = ''; if (model) r.badge.append(modelBadge(model)); }
    if (n.type === 'note') {
      const t = (n.config && n.config.text) || '';
      if (r.body.__t !== t) { r.body.__t = t; r.body.textContent = ''; r.body.append(renderMarkdown(t)); }
    } else {
      const t = summarize(n);
      if (r.body.__t !== t) { r.body.__t = t; setText(r.body, t || 'Not configured yet'); }
      setClass(r.body, 'empty', !t);
    }
    el.style.transform = `translate(${n.position.x}px, ${n.position.y}px)`;
    const note = n.type === 'note';
    setHidden(r.pin, note); setHidden(r.pout, note);
    const rt = n.retry && n.retry.max > 0;
    setClass(el, 'has-retry', !!rt);
    el.setAttribute('aria-label', `${n.label}, ${n.type}${run ? `, ${STATE_LABEL[stateOf(n.id)] || ''}` : ''}`);
    const iss = issues.get(n.id);
    setHidden(r.issue, !iss || !iss.length);
    r.issue.title = iss ? iss.join('\n') : '';
    setClass(el, 'has-issue', !!(iss && iss.length));
    paintRunNode(el, n);
  }

  const stateOf = (id) => {
    const rn = run && run.nodes.find((x) => x.nodeId === id);
    return rn ? rn.state : '';
  };

  function paintRunNode(el, n) {
    const r = el.__r;
    const rn = run && isExec(n) ? run.nodes.find((x) => x.nodeId === n.id) : null;
    const st = rn ? rn.state : '';
    el.setAttribute('data-state', st);
    setClass(el, 'live', !!run && isExec(n));
    setHidden(r.foot, !rn);
    if (!rn) { setHidden(r.gate, true); setHidden(r.ctl, true); setHidden(r.err, true); return; }
    setText(r.stText, STATE_LABEL[st] || st);
    const done = rn.endedAt && rn.startedAt ? rn.endedAt - rn.startedAt : null;
    if (st === 'running' || st === 'queued' || st === 'waiting_gate') {
      if (rn.startedAt) { r.time.setAttribute('data-since', rn.startedAt); setText(r.time, fmtElapsed(Date.now() - rn.startedAt)); } else { r.time.removeAttribute('data-since'); setText(r.time, ''); }
    } else {
      r.time.removeAttribute('data-since');
      setText(r.time, done != null ? fmtElapsed(done) : '');
    }
    setText(r.cost, rn.costUsd > 0 ? fmtUsdSmall(rn.costUsd) : '');
    if (rn.attempt > 1) r.stText.title = `Attempt ${rn.attempt}`;
    const showErr = (st === 'failed' || st === 'abandoned' || (st === 'ready' && rn.attempt > 0)) && rn.error;
    setHidden(r.err, !showErr);
    if (showErr) setText(r.err, truncate(rn.error, 140));
    const waiting = st === 'waiting_gate' && n.type === 'gate' && run.status !== 'done' && run.status !== 'aborted' && run.status !== 'failed';
    setHidden(r.gate, !waiting);
    setHidden(r.ctl, !((st === 'failed' || st === 'abandoned') && run.status !== 'aborted' && run.status !== 'done'));
  }

  /* -------------------------------------------------------------------- edges */
  const portOut = (n) => ({ x: n.position.x + NODE_W, y: n.position.y + PORT_Y });
  const portIn = (n) => ({ x: n.position.x, y: n.position.y + PORT_Y });
  function pathD(a, b) {
    const fwd = b.x >= a.x + 8;
    const dx = fwd ? Math.max(56, (b.x - a.x) * 0.5) : Math.max(96, Math.min(260, (a.x - b.x) * 0.4 + 80));
    return `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
  }
  const bezierMid = (a, b) => {
    const fwd = b.x >= a.x + 8;
    const dx = fwd ? Math.max(56, (b.x - a.x) * 0.5) : Math.max(96, Math.min(260, (a.x - b.x) * 0.4 + 80));
    const c1 = { x: a.x + dx, y: a.y }, c2 = { x: b.x - dx, y: b.y };
    return { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 };
  };
  function edgeRun(e) {
    // 'taken' | 'dead' | 'idle' relative to the run overlay
    if (!run) return { cls: '', flow: false };
    const src = doc.node(e.from), rn = run.nodes.find((x) => x.nodeId === e.from);
    if (!src || !rn || !TERMINAL.has(rn.state)) return { cls: 'idle', flow: false };
    const oc = outcomeOf(src, rn);
    if (oc === e.when) {
      const tgt = run.nodes.find((x) => x.nodeId === e.to);
      return { cls: 'taken', flow: !!tgt && ['ready', 'queued', 'running'].includes(tgt.state) };
    }
    return { cls: 'dead', flow: false };
  }
  function createEdgeG(e) {
    const hit = s('path', { class: 'wf-e-hit' });
    const line = s('path', { class: 'wf-e-line' });
    const flow = s('path', { class: 'wf-e-flow', pathLength: '100' });
    const g = s('g', { class: 'wf-edge', 'data-id': e.id }, hit, line, flow);
    g.__id = e.id; g.__p = { hit, line, flow };
    return g;
  }
  function createLabelEl(e) {
    const el = h('button', { class: 'wf-elabel', type: 'button', 'data-id': e.id }, h('span', {}));
    el.__id = e.id;
    el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      select([], el.__id);
      if (!readOnly) openKindMenu(el.__id, ev.clientX, ev.clientY);
    });
    return el;
  }
  function drawEdges() {
    if (!doc) { reconcile(edgesG, [], (x) => x.id, createEdgeG, null); reconcile(labelsLayer, [], (x) => x.id, createLabelEl, null); return; }
    const edges = doc.graph.edges.filter((e) => doc.node(e.from) && doc.node(e.to));
    reconcile(edgesG, edges, (e) => e.id, createEdgeG, (g, e) => {
      const a = portOut(doc.node(e.from)), b = portIn(doc.node(e.to));
      const d = pathD(a, b);
      const st = edgeRun(e);
      g.setAttribute('class', `wf-edge k-${e.when} ${st.cls}${g.__id === selection.edge ? ' selected' : ''}${st.flow ? ' flowing' : ''}${g.__pulse ? ' pulse' : ''}`);
      g.__p.hit.setAttribute('d', d); g.__p.line.setAttribute('d', d); g.__p.flow.setAttribute('d', d);
      g.__p.line.setAttribute('marker-end', `url(#wf-arr-${st.cls === 'dead' || st.cls === 'idle' ? 'idle' : e.when})`);
    });
    reconcile(labelsLayer, edges, (e) => e.id, createLabelEl, (el, e) => {
      const m = bezierMid(portOut(doc.node(e.from)), portIn(doc.node(e.to)));
      el.style.transform = `translate(${m.x}px, ${m.y}px) translate(-50%, -50%)`;
      el.className = `wf-elabel k-${e.when}${el.__id === selection.edge ? ' selected' : ''}${edgeRun(e).cls ? ' ' + edgeRun(e).cls : ''}`;
      setText(el.firstChild, EDGE_LABEL[e.when]);
      el.title = readOnly ? `${e.from} → ${e.to} on ${e.when}` : `${e.from} → ${e.to} on ${e.when} (click to change)`;
      el.setAttribute('aria-label', `Connection from ${e.from} to ${e.to}, on ${e.when}`);
    });
  }

  /* ------------------------------------------------------------- render + measure */
  function render() {
    if (!doc) { reconcile(nodesLayer, [], (n) => n.id, createNodeEl, null); drawEdges(); drawMini(); setHidden(empty, true); return; }
    reconcile(nodesLayer, doc.graph.nodes, (n) => n.id, createNodeEl, updateNodeEl);
    measure();
    drawEdges();
    drawMini();
    setHidden(empty, doc.graph.nodes.length > 0);
    // keep selection to nodes that still exist
    let changed = false;
    for (const id of [...selection.nodes]) if (!doc.node(id)) { selection.nodes.delete(id); changed = true; }
    if (selection.edge && !doc.edge(selection.edge)) { selection.edge = null; changed = true; }
    if (changed) emitSelection();
  }
  function measure() {
    sizes.clear();
    for (const el of nodesLayer.children) sizes.set(el.__id, { w: el.offsetWidth || NODE_W, h: el.offsetHeight || 96 });
  }
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { measure(); drawMini(); });
  }
  function observeNodes() { if (ro) for (const el of nodesLayer.children) ro.observe(el); }
  new MutationObserver(observeNodes).observe(nodesLayer, { childList: true });

  /* -------------------------------------------------------------------- minimap */
  function drawMini() {
    if (rafMini) return;
    const run1 = () => { rafMini = 0; paintMini(); };
    if (typeof requestAnimationFrame === 'function') rafMini = requestAnimationFrame(run1); else rafMini = setTimeout(run1, 16);
  }
  const MM_W = 160, MM_H = 100;
  let mmMap = null;
  function paintMini() {
    mmSvg.textContent = '';
    const r = rectOf();
    const nodes = doc ? doc.graph.nodes : [];
    const vw = { x0: -view.x / view.k, y0: -view.y / view.k, x1: (r.width - view.x) / view.k, y1: (r.height - view.y) / view.k };
    let x0 = vw.x0, y0 = vw.y0, x1 = vw.x1, y1 = vw.y1;
    for (const n of nodes) {
      const sz = sizes.get(n.id) || { w: NODE_W, h: 96 };
      x0 = Math.min(x0, n.position.x - 20); y0 = Math.min(y0, n.position.y - 20);
      x1 = Math.max(x1, n.position.x + sz.w + 20); y1 = Math.max(y1, n.position.y + sz.h + 20);
    }
    if (!isFinite(x0) || x1 <= x0 || y1 <= y0) return;
    const sc = Math.min(MM_W / (x1 - x0), MM_H / (y1 - y0));
    const ox = (MM_W - (x1 - x0) * sc) / 2 - x0 * sc, oy = (MM_H - (y1 - y0) * sc) / 2 - y0 * sc;
    mmMap = { sc, ox, oy };
    if (doc) {
      for (const e of doc.graph.edges) {
        const a = doc.node(e.from), b = doc.node(e.to);
        if (!a || !b) continue;
        const pa = portOut(a), pb = portIn(b);
        mmSvg.append(s('line', { class: `wf-mm-edge k-${e.when}`, x1: pa.x * sc + ox, y1: pa.y * sc + oy, x2: pb.x * sc + ox, y2: pb.y * sc + oy }));
      }
    }
    for (const n of nodes) {
      const sz = sizes.get(n.id) || { w: NODE_W, h: 96 };
      mmSvg.append(s('rect', {
        class: `wf-mm-node t-${(TYPE_META[n.type] || {}).tone}${selection.nodes.has(n.id) ? ' selected' : ''}`, 'data-state': stateOf(n.id),
        x: n.position.x * sc + ox, y: n.position.y * sc + oy, width: Math.max(3, sz.w * sc), height: Math.max(2, sz.h * sc), rx: 1.5,
      }));
    }
    mmSvg.append(s('rect', { class: 'wf-mm-view', x: vw.x0 * sc + ox, y: vw.y0 * sc + oy, width: (vw.x1 - vw.x0) * sc, height: (vw.y1 - vw.y0) * sc, rx: 2 }));
  }
  minimap.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const move = (ev) => {
      if (!mmMap) return;
      const mr = mmSvg.getBoundingClientRect();
      const px = ((ev.clientX - mr.left) / mr.width) * MM_W, py = ((ev.clientY - mr.top) / mr.height) * MM_H;
      const wx = (px - mmMap.ox) / mmMap.sc, wy = (py - mmMap.oy) / mmMap.sc;
      const r = rectOf();
      view.x = r.width / 2 - wx * view.k; view.y = r.height / 2 - wy * view.k;
      applyView();
    };
    move(e);
    try { minimap.setPointerCapture(e.pointerId); } catch { /* no capture */ }
    const up = () => { minimap.removeEventListener('pointermove', move); minimap.removeEventListener('pointerup', up); minimap.removeEventListener('pointercancel', up); };
    minimap.addEventListener('pointermove', move); minimap.addEventListener('pointerup', up); minimap.addEventListener('pointercancel', up);
  });

  /* ------------------------------------------------------------- pointer: pan / marquee / node drag / connect */
  const pointers = new Map(); // active touch/pen pointers on the background for pinch
  let gesture = null;

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button > 1) return;
    const portEl = e.target.closest && e.target.closest('.wf-port.out');
    const nodeEl = e.target.closest && e.target.closest('.wf-node');
    if (portEl && nodeEl && !readOnly) { startConnect(e, nodeEl); return; }
    if (nodeEl) {
      if (e.target.closest('input,button,textarea,select')) return;
      startNodeDrag(e, nodeEl);
      return;
    }
    if (e.target.closest && e.target.closest('.wf-elabel')) return;
    // background
    root.focus({ preventScroll: true });
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && e.pointerType !== 'mouse') { startPinch(); return; }
    const wantMarquee = e.shiftKey || tool === 'select';
    if (e.button === 1 || spaceDown || !wantMarquee) startPan(e);
    else startMarquee(e);
  });

  // Listeners live on the window rather than using pointer capture: with capture a browser retargets the click that follows
  // to the viewport, which would swallow double-clicks on cards and clicks on edges.
  function capture(e, move, up) {
    const end = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      pointers.delete(e.pointerId);
      up(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  function startPan(e) {
    const sx = e.clientX, sy = e.clientY, vx = view.x, vy = view.y;
    let moved = false;
    viewport.classList.add('panning');
    capture(e, (ev) => {
      if (pointers.size >= 2) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      view.x = vx + dx; view.y = vy + dy;
      applyView();
    }, () => {
      viewport.classList.remove('panning');
      if (!moved && (selection.nodes.size || selection.edge)) select([]);
    });
  }
  function startPinch() {
    const pts = [...pointers.values()];
    let d0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    let k0 = view.k;
    const move = (ev) => {
      if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      zoomAt(k0 * (d / d0), (a.x + b.x) / 2, (a.y + b.y) / 2);
    };
    const up = (ev) => {
      pointers.delete(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    gesture = { d0, k0 };
  }

  function startMarquee(e) {
    const r = rectOf();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const base = e.metaKey || e.ctrlKey || e.shiftKey ? new Set(selection.nodes) : new Set();
    let moved = false;
    capture(e, (ev) => {
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      if (!moved && Math.hypot(x - sx, y - sy) < 3) return;
      moved = true;
      const l = Math.min(sx, x), t = Math.min(sy, y), w = Math.abs(x - sx), hh = Math.abs(y - sy);
      marquee.hidden = false;
      marquee.style.cssText = `left:${l}px;top:${t}px;width:${w}px;height:${hh}px`;
      const wa = { x: (l - view.x) / view.k, y: (t - view.y) / view.k }, wb = { x: (l + w - view.x) / view.k, y: (t + hh - view.y) / view.k };
      const hits = new Set(base);
      for (const n of doc ? doc.graph.nodes : []) {
        const sz = sizes.get(n.id) || { w: NODE_W, h: 96 };
        if (n.position.x < wb.x && n.position.x + sz.w > wa.x && n.position.y < wb.y && n.position.y + sz.h > wa.y) hits.add(n.id);
      }
      select(hits);
    }, () => {
      marquee.hidden = true;
      if (!moved) select([]);
    });
  }

  function startNodeDrag(e, nodeEl) {
    const id = nodeEl.__id;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive) {
      const next = new Set(selection.nodes);
      if (next.has(id)) next.delete(id); else next.add(id);
      select(next);
      if (!next.has(id)) return;
    } else if (!selection.nodes.has(id)) select([id]);
    const collapseOnClick = !additive && selection.nodes.size > 1; // a plain click inside a group narrows it to this node
    root.focus({ preventScroll: true });
    if (readOnly || !doc) { if (collapseOnClick) { const up = () => { window.removeEventListener('pointerup', up); select([id]); }; window.addEventListener('pointerup', up); } return; }
    const ids = [...selection.nodes];
    const start = new Map(ids.map((i) => [i, { ...doc.node(i).position }]));
    const pre = JSON.stringify(doc.graph);
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    nodeEl.classList.add('dragging');
    capture(e, (ev) => {
      const dx = (ev.clientX - sx) / view.k, dy = (ev.clientY - sy) / view.k;
      if (!moved && Math.hypot(dx * view.k, dy * view.k) < 3) return;
      moved = true;
      // snap the group by the node being dragged, so the others keep their offsets
      const o = start.get(id);
      let ddx = dx, ddy = dy;
      if (!ev.altKey) { ddx = snap(o.x + dx) - o.x; ddy = snap(o.y + dy) - o.y; }
      for (const [i, p] of start) {
        const n = doc.node(i);
        n.position = { x: p.x + ddx, y: p.y + ddy };
      }
      for (const el of nodesLayer.children) if (start.has(el.__id)) el.style.transform = `translate(${doc.node(el.__id).position.x}px, ${doc.node(el.__id).position.y}px)`;
      drawEdges();
      drawMini();
    }, () => {
      nodeEl.classList.remove('dragging');
      if (moved) doc.commitFrom(pre);
      else if (collapseOnClick) select([id]);
    });
  }

  /* -------- connecting -------- */
  function startConnect(e, fromEl) {
    e.preventDefault();
    const from = doc.node(fromEl.__id);
    const a = portOut(from);
    const wire = s('path', { class: 'wf-wire' });
    wireG.append(wire);
    root.classList.add('connecting');
    const bad = new Set();
    for (const n of doc.graph.nodes) if (n.type === 'note' || wouldCycle(doc.graph, from.id, n.id)) bad.add(n.id);
    for (const el of nodesLayer.children) { setClass(el, 'can-drop', !bad.has(el.__id)); setClass(el, 'no-drop', bad.has(el.__id) && el.__id !== from.id); }
    let hover = null;
    const draw = (ev) => {
      const w = toWorld(ev.clientX, ev.clientY);
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      const tn = t && t.closest ? t.closest('.wf-node') : null;
      const id = tn && !bad.has(tn.__id) ? tn.__id : null;
      if (id !== hover) { hover = id; for (const el of nodesLayer.children) setClass(el, 'drop-hot', el.__id === id); }
      const end = id ? portIn(doc.node(id)) : w;
      wire.setAttribute('d', pathD(a, end));
    };
    draw(e);
    capture(e, draw, (ev) => {
      wire.remove();
      root.classList.remove('connecting');
      for (const el of nodesLayer.children) { el.classList.remove('can-drop', 'no-drop', 'drop-hot'); }
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      const tn = t && t.closest ? t.closest('.wf-node') : null;
      if (tn && tn.__id !== from.id) {
        if (!bad.has(tn.__id)) connect(from.id, tn.__id, ev.clientX, ev.clientY);
        return;
      }
      if (!tn && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 24) {
        const r = rectOf();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) openQuickAdd(ev.clientX, ev.clientY, { connectFrom: from.id });
      }
    });
  }
  function connect(from, to, cx, cy) {
    const f = doc.node(from);
    let kind = defaultKind(f.type);
    // a second edge from the same step defaults to the other kind (ok then fail)
    const used = doc.graph.edges.filter((e) => e.from === from).map((e) => e.when);
    const free = kindsFor(f.type).filter((k) => !used.includes(k));
    if (used.includes(kind) && free.length) kind = free[0];
    if (doc.graph.edges.some((e) => e.from === from && e.to === to && e.when === kind)) return;
    const id = doc.freshEdgeId();
    doc.mutate((g) => { g.edges.push({ id, from, to, when: kind }); });
    select([], id);
    // the kind is a choice: the default is already in place, the menu lets you change it
    openKindMenu(id, cx, cy);
  }
  function virtualAnchor(cx, cy) {
    return { getBoundingClientRect: () => ({ left: cx, right: cx, top: cy, bottom: cy, width: 0, height: 0 }), contains: () => false, focus: () => root.focus({ preventScroll: true }) };
  }
  function openKindMenu(edgeId, cx, cy) {
    const e = doc && doc.edge(edgeId);
    if (!e || readOnly) return;
    const src = doc.node(e.from);
    const items = [{ heading: `${e.from} → ${e.to}` }, ...kindsFor(src.type).map((k) => ({
      label: k === 'ok' ? 'On success (ok)' : k === 'fail' ? 'On failure (fail)' : k === 'approved' ? 'When approved' : 'When rejected',
      active: e.when === k, onSelect: () => setEdgeKind(edgeId, k),
    })), { divider: true }, { label: 'Delete connection', icon: 'trash', danger: true, onSelect: () => deleteSelection(edgeId) }];
    openMenu(virtualAnchor(cx, cy), items, { minWidth: 220 });
  }
  function setEdgeKind(edgeId, kind) {
    const e = doc.edge(edgeId);
    if (!e || e.when === kind) return;
    if (doc.graph.edges.some((x) => x.id !== edgeId && x.from === e.from && x.to === e.to && x.when === kind)) return;
    doc.mutate((g) => { g.edges.find((x) => x.id === edgeId).when = kind; });
  }

  /* ----------------------------------------------------------- wheel + keyboard */
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01));
      zoomAt(view.k * f, e.clientX, e.clientY);
    } else {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      view.x -= dx; view.y -= dy;
      applyView();
    }
  }, { passive: false });

  viewport.addEventListener('dblclick', (e) => {
    if (readOnly || e.target.closest('.wf-node,.wf-elabel,.wf-edge')) return;
    openQuickAdd(e.clientX, e.clientY, {});
  });
  // edges are selected by clicking their (wide, invisible) hit path
  viewport.addEventListener('click', (e) => {
    const g = e.target.closest && e.target.closest('.wf-edge');
    if (g) { select([], g.__id); }
  });

  function openQuickAdd(cx, cy, { connectFrom = null } = {}) {
    if (readOnly) return;
    const world = toWorld(cx, cy);
    const items = [{ heading: connectFrom ? 'Add a step and connect it' : 'Add a step here' }, ...PALETTE.map((p) => ({
      label: p.label, sub: p.hint, icon: p.icon, onSelect: () => { const id = addNode(p, world); if (connectFrom && id && p.type !== 'note') { connect(connectFrom, id, cx, cy); } },
    }))];
    openMenu(virtualAnchor(cx, cy), items, { minWidth: 260 });
  }

  function addNode(entry, pos, center = true) {
    if (readOnly || !doc) return null;
    const taken = new Set(doc.graph.nodes.map((n) => n.id));
    const at = center ? { x: pos.x - NODE_W / 2, y: pos.y - 28 } : pos;
    const node = makeNode(entry, at, taken);
    doc.mutate((g) => { g.nodes.push(node); });
    select([node.id]);
    requestAnimationFrame(() => { const el = nodesLayer.querySelector(`[data-id="${CSS.escape(node.id)}"]`); if (el) el.focus({ preventScroll: true }); });
    return node.id;
  }
  /** Add at the middle of the visible canvas (palette click). */
  function addAtCenter(entry) {
    const r = rectOf();
    const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    // fan out so repeated clicks do not stack
    const n = doc ? doc.graph.nodes.length : 0;
    return addNode(entry, { x: c.x + (n % 5) * 24, y: c.y + (n % 5) * 24 });
  }
  /** Palette drop: returns true when the point is over the canvas. */
  function dropAt(entry, cx, cy) {
    const r = rectOf();
    if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return false;
    addNode(entry, toWorld(cx, cy));
    return true;
  }

  function deleteSelection(edgeId = null) {
    if (readOnly || !doc) return;
    if (edgeId || (selection.edge && !selection.nodes.size)) {
      const id = edgeId || selection.edge;
      doc.mutate((g) => { g.edges = g.edges.filter((e) => e.id !== id); });
      select([]);
      return;
    }
    const ids = new Set(selection.nodes);
    if (!ids.size) return;
    doc.mutate((g) => {
      g.nodes = g.nodes.filter((n) => !ids.has(n.id));
      g.edges = g.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
    });
    select([]);
  }
  function copySelection() {
    if (!doc || !selection.nodes.size) return false;
    const ids = new Set(selection.nodes);
    clipboard = {
      nodes: clone(doc.graph.nodes.filter((n) => ids.has(n.id))),
      edges: clone(doc.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to))),
    };
    pasteCount = 0;
    return true;
  }
  function paste(offset = 32) {
    if (readOnly || !doc || !clipboard || !clipboard.nodes.length) return;
    pasteCount++;
    const taken = new Set(doc.graph.nodes.map((n) => n.id));
    const idMap = new Map();
    const nodes = clipboard.nodes.map((n) => {
      const copy = clone(n);
      const id = (() => { let base = n.id.replace(/\d+$/, '') || n.type; let i = 2; let c = base; while (taken.has(c)) c = `${base}${i++}`; taken.add(c); return c; })();
      idMap.set(n.id, id);
      copy.id = id;
      copy.position = { x: snap(n.position.x + offset * pasteCount), y: snap(n.position.y + offset * pasteCount) };
      return copy;
    });
    const used = new Set(doc.graph.edges.map((e) => e.id));
    let ei = doc.graph.edges.length + 1;
    const edges = clipboard.edges.map((e) => { while (used.has(`e${ei}`)) ei++; const id = `e${ei}`; used.add(id); return { ...e, id, from: idMap.get(e.from), to: idMap.get(e.to) }; });
    doc.mutate((g) => { g.nodes.push(...nodes); g.edges.push(...edges); });
    select(nodes.map((n) => n.id));
  }
  function duplicateSelection() { if (copySelection()) paste(); }
  function nudge(dx, dy) {
    if (readOnly || !doc || !selection.nodes.size) return;
    doc.mutate((g) => { for (const n of g.nodes) if (selection.nodes.has(n.id)) n.position = { x: n.position.x + dx, y: n.position.y + dy }; }, 'nudge');
  }
  function tidy() {
    if (readOnly || !doc || !doc.graph.nodes.length) return;
    const pos = autoLayout(doc.graph);
    doc.mutate((g) => { for (const n of g.nodes) if (pos[n.id]) n.position = pos[n.id]; });
    requestAnimationFrame(() => fit(null, true));
  }

  root.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    const meta = e.metaKey || e.ctrlKey;
    const key = e.key;
    if (e.target && e.target.closest && e.target.closest('button')) return; // let a focused button handle Space / Enter itself
    if (key === ' ') { if (!spaceDown) { spaceDown = true; viewport.classList.add('space'); } e.preventDefault(); return; }
    if (meta && (key === 'c' || key === 'C')) { if (copySelection()) e.preventDefault(); return; }
    if (meta && (key === 'v' || key === 'V')) { e.preventDefault(); paste(); return; }
    if (meta && (key === 'd' || key === 'D')) { e.preventDefault(); duplicateSelection(); return; }
    if (meta && (key === 'a' || key === 'A')) { e.preventDefault(); if (doc) select(doc.graph.nodes.map((n) => n.id)); return; }
    if (meta) return;
    if (key === 'Delete' || key === 'Backspace') { if (!readOnly) { e.preventDefault(); deleteSelection(); } return; }
    if (key === 'Escape') { if (selection.nodes.size || selection.edge) { e.preventDefault(); select([]); } return; }
    if (key === '0') { e.preventDefault(); fit(); return; }
    if (key === '1') { e.preventDefault(); zoomTo(1); return; }
    if (key === '+' || key === '=') { e.preventDefault(); zoomBy(1.25); return; }
    if (key === '-' || key === '_') { e.preventDefault(); zoomBy(1 / 1.25); return; }
    if (key === 'h' || key === 'H') { setTool('hand'); return; }
    if (key === 'v' || key === 'V') { setTool('select'); return; }
    if (key === '/') { e.preventDefault(); const r = rectOf(); openQuickAdd(r.left + r.width / 2, r.top + r.height / 3, {}); return; }
    if (key.startsWith('Arrow')) {
      if (!selection.nodes.size) return;
      e.preventDefault();
      const d = e.shiftKey ? 32 : 8;
      nudge(key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0, key === 'ArrowUp' ? -d : key === 'ArrowDown' ? d : 0);
      return;
    }
    if (key === 'Enter' && selection.nodes.size === 1 && onOpenNode) { e.preventDefault(); onOpenNode([...selection.nodes][0]); }
  });
  root.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; viewport.classList.remove('space'); } });
  root.addEventListener('blur', () => { spaceDown = false; viewport.classList.remove('space'); }, true);

  /* ------------------------------------------------------------------- run overlay */
  function setRun(r) {
    run = r;
    const nextStates = new Map();
    if (r) for (const n of r.nodes) nextStates.set(n.nodeId, n.state);
    // one-shot pulse on the edges that just got taken
    if (doc && r && prevStates.size) {
      for (const [id, st] of nextStates) {
        const was = prevStates.get(id);
        if (was === st || !TERMINAL.has(st)) continue;
        for (const e of doc.graph.edges) {
          if (e.from !== id) continue;
          const g = edgesG.querySelector(`[data-id="${CSS.escape(e.id)}"]`);
          const rn = r.nodes.find((x) => x.nodeId === id);
          if (g && outcomeOf(doc.node(id), rn) === e.when) {
            g.__pulse = true;
            setTimeout(() => { g.__pulse = false; g.classList.remove('pulse'); }, 1500);
          }
        }
      }
    }
    prevStates = nextStates;
    if (!doc) return;
    for (const el of nodesLayer.children) if (el.__node) { updateNodeEl(el, el.__node); }
    measure();
    drawEdges();
    drawMini();
  }

  /* --------------------------------------------------------------------- public */
  function setDoc(d, { keepView = false } = {}) {
    if (unsub) { unsub(); unsub = null; }
    doc = d;
    select([], null, true);
    if (doc) unsub = doc.on((kind) => { render(); if (kind !== 'saved') void 0; });
    prevStates = new Map();
    render();
    if (!keepView) requestAnimationFrame(() => fit(null, false));
  }
  function setReadOnly(ro2) {
    readOnly = !!ro2;
    root.classList.toggle('readonly', readOnly);
    root.toggleAttribute('data-readonly', readOnly);
    render();
  }
  function setIssues(map) {
    issues = map || new Map();
    for (const el of nodesLayer.children) if (el.__node) updateNodeEl(el, el.__node);
  }

  return {
    el: root,
    setDoc, setReadOnly, setRun, setIssues, render, fit, zoomTo, zoomBy, centerOn, select, tidy,
    get view() { return { ...view }; },
    set view(v) { Object.assign(view, v); applyView(); },
    get selection() { return { nodes: [...selection.nodes], edge: selection.edge }; },
    deleteSelection: () => deleteSelection(), copy: copySelection, paste: () => paste(), duplicate: duplicateSelection,
    addAtCenter, dropAt, openQuickAdd, setTool,
    nodeEl: (id) => nodesLayer.querySelector(`[data-id="${CSS.escape(id)}"]`),
    get currentDoc() { return doc; },
    get gesture() { return gesture; },
    destroy() { if (unsub) unsub(); if (ro) ro.disconnect(); root.remove(); },
  };
}
