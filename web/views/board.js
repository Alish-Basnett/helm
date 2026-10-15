// views/board.js — kanban: 5 columns + collapsible Later/Blocked lanes, drag & drop, inline composer.
import { ciSummary, prChip } from '../git.js';
import { h, reconcile, setText, setClass, setHidden, setAttr, bus, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, lsGet, lsSet, setUI } from '../store.js';
import { cachedStartTarget } from '../startdialogs.js';
import { startTargetText } from '../startqueue.js';
import { patchTask, createTask, quickActions, runQuickAction, startTask, canStart, startDrafts, setAutoStart, setAutoConcurrency, decideGate } from '../actions.js';
import { createStartStatus } from '../replies.js';
import { fmtElapsed, fmtTokens, truncate, agentLabel, modelInfo, STATUS_META, MAIN_COLUMNS, LANES, plural } from '../format.js';
import { avatar, updateAvatar, modelBadge, updateModelBadge, nowDoingLine, statusDot, toast, openMenu } from '../ui.js';
import { openTask, navigate, route } from '../router.js';
import { createBoardFilter, applyFilter, filterFromQuery, filterToQuery, loadFilter, saveFilter } from '../boardfilter.js';
import { openTemplatePopover } from '../templates.js';
import { bindTaskMenu } from '../taskmenu.js';
import {
  GROUPS, SORTS, defaultView, normalizeView, isDefaultView, activeFilterCount, filterTasks, sortTasks, groupTasks, laneOf, canDropAcross,
  laneStatuses, autoHeader, projectCount, normalizeSaved, saveView, removeView, matchingView, describeView,
} from '../boardview.js';

const DONE_LIMIT = 30;
const cmp = (a, b) => (a.order - b.order) || (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id));
const needsOf = (t) => sel.needsYou(t).length > 0;
const cmpDone = (a, b) => (b.doneAt || b.updatedAt || 0) - (a.doneAt || a.updatedAt || 0);

export function mount(container) {
  let composerCol = null;
  let dragId = null;
  let needsRender = false;
  let doneExpanded = false;
  const readJSON = (key, fallback) => { try { const raw = lsGet(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };
  // v0.22 View: group / sort / filters in one object, remembered per browser. The old "Needs me" key seeds the first load.
  let view = normalizeView(readJSON('helm.board.view', { ...defaultView(), needs: lsGet('helm.board.needsMe') === '1' }));
  let saved = normalizeSaved(readJSON('helm.board.views', []));
  const collapsedLanes = new Set(readJSON('helm.board.lanesCollapsed', []));
  let dragLane = null; // the lane the dragged card came from: drops are only allowed inside it
  let groupByRun = lsGet('helm.board.groupRun') === '1'; // v0.9: cards made by a workflow run sit under one header per run
  const collapsedRuns = new Set((() => { try { return JSON.parse(lsGet('helm.board.runsCollapsed') || '[]'); } catch { return []; } })());
  const cols = {}; // status -> {el, body, count, composer, ...}
  let showChips = false; // v0.28: the board mixes projects, so cards wear a project chip
  let nextUpIds = new Set(); // v0.7: the top Up next card of every project that is on Auto

  startTicker();

  /* ---------- structure ---------- */
  const banner = h('div', { class: 'board-banner', hidden: true });
  const colsEl = h('div', { class: 'board-cols' });
  const lanesEl = h('div', { class: 'board-lanes' });
  const needsBtnCount = h('span', { class: 'needs-toggle-count mono', hidden: true }, '0');
  const needsBtn = h('button', { class: 'needs-toggle', type: 'button', 'aria-pressed': String(view.needs), title: 'Show only cards waiting for you (y jumps to the next one)',
    onclick: () => setView({ needs: !view.needs }) },
  h('span', { class: 'needs-dot', 'aria-hidden': 'true' }), h('span', {}, 'Needs me'), needsBtnCount);
  const groupBtn = h('button', { class: 'needs-toggle board-group', type: 'button', 'aria-pressed': String(groupByRun), title: 'Put the cards of each workflow run under one header',
    onclick: () => { groupByRun = !groupByRun; lsSet('helm.board.groupRun', groupByRun ? '1' : '0'); render(); } },
  icon('workflow', 14), h('span', {}, 'Group by run'));
  const viewLabel = h('span', { class: 'view-btn-sum' });
  const viewBtn = h('button', { class: 'needs-toggle view-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Group, filter and sort the board',
    onclick: () => (viewPanel ? closeViewPanel() : openViewPanel()) }, icon('board', 14), h('span', {}, 'View'), viewLabel);
  const savedEl = h('div', { class: 'view-saved', role: 'group', 'aria-label': 'Saved views' });
  const laneHint = h('span', { class: 'lane-hint', hidden: true },
    h('button', { class: 'lane-hint-go', type: 'button', onclick: () => setView({ group: 'project' }) }),
    h('button', { class: 'lane-hint-x', type: 'button', 'aria-label': 'Hide this hint', title: 'Hide this hint', onclick: () => { lsSet('helm.board.laneHint', '0'); render(); } }, icon('close', 12)));
  const startFilter = filterFromQuery(route().query) || loadFilter();
  const boardFilter = createBoardFilter({ initial: startFilter, onChange: (f) => {
    saveFilter(f);
    const q = {}; for (const [k, v] of route().query) q[k] = v;
    Object.assign(q, filterToQuery(f));
    navigate('board', route().args, q, { replace: true });
    render();
  } });
  const filterRow = h('div', { class: 'board-filters' }, boardFilter.el);
  const bar = h('div', { class: 'board-bar' }, needsBtn, groupBtn, viewBtn, savedEl, h('span', { class: 'spacer' }), laneHint);
  const swimEl = h('div', { class: 'board-swim', hidden: true });
  const root = h('div', { class: 'board' }, bar, filterRow, banner, colsEl, lanesEl, swimEl);
  let viewPanel = null;
  container.appendChild(root);

  for (const status of MAIN_COLUMNS) colsEl.appendChild(buildColumn(status));
  for (const status of LANES) lanesEl.appendChild(buildLane(status));

  function buildColumn(status) {
    const meta = STATUS_META[status];
    const count = h('span', { class: 'col-count mono' }, '0');
    const need = h('span', { class: 'col-need mono', hidden: true });
    const addBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': `Add task to ${meta.label}`, title: `Add to ${meta.label}`, onclick: () => openComposer(status) }, icon('plus', 16));
    const body = h('div', { class: 'col-body', 'data-status': status, 'data-layout': 'v', 'data-empty': status === 'done' ? 'Nothing done yet' : 'Drop tasks here' });
    const more = h('button', { class: 'col-more', type: 'button', hidden: true, onclick: () => { doneExpanded = !doneExpanded; render(); } });
    const composer = buildComposer(status);
    const el = h('section', { class: `col col-${status}`, 'aria-label': meta.label },
      h('header', { class: 'col-head' }, statusDot(status), h('h3', { class: 'col-title' }, meta.label), count, need, h('span', { class: 'spacer' }), addBtn),
      composer.el, body, more);
    wireDrop(body);
    cols[status] = { el, body, count, need, composer, more };
    if (status === 'next') attachAutoControls(cols[status]);
    return el;
  }

  /**
   * v0.7 / T-71 / T-96: the Auto controls of one Up next header. One factory serves the Status column and every lane's
   * Up next column, so no grouping can lose them again. `update(spec)` takes boardview.autoHeader()'s answer:
   * a 'switch' (Manual | Auto + xN, bound to ONE project) or a 'picker' (compact popover over several projects).
   */
  function buildAutoControls() {
    let spec = { kind: 'none' };
    const proj = () => (spec.kind === 'switch' ? state.projects.get(spec.projectId) || null : null);
    const manual = h('button', { class: 'auto-seg-btn', type: 'button', 'data-mode': 'manual', onclick: () => setMode(false) }, 'Manual');
    const auto = h('button', { class: 'auto-seg-btn', type: 'button', 'data-mode': 'auto', onclick: () => setMode(true) }, 'Auto');
    const glyph = h('span', { class: 'auto-glyph', 'aria-hidden': 'true', hidden: true, title: 'Auto mode is on' }, '⟳');
    const seg = h('div', { class: 'auto-seg', role: 'group', 'aria-label': 'Up next mode' }, manual, auto);
    const pick = h('button', { class: 'auto-pick', type: 'button', 'aria-haspopup': 'menu', title: 'Choose which projects start their Up next automatically (pick one project for “how many at once”)',
      onclick: () => openMenu(pick, pickProjects().map((p) => ({
        label: p.name, sub: p.autoStart ? `Auto \u00d7${p.autoConcurrency || 1}` : 'Manual', active: !!p.autoStart, icon: p.autoStart ? 'play' : undefined,
        onSelect: () => setAutoStart(p.id, !p.autoStart),
      })), { minWidth: 240 }) }, h('span', {}, 'Auto'), h('span', { class: 'auto-pick-n mono' }));
    // T-71: how many Up next tasks Auto keeps running at once (1-5), per project.
    const conc = h('button', { class: 'auto-conc mono', type: 'button', 'aria-haspopup': 'menu', hidden: true,
      title: 'How many tasks Auto keeps in progress at once',
      onclick: () => { const t = proj(); if (t) openMenu(conc, [1, 2, 3, 4, 5].map((n) => ({
        label: n === 1 ? '1 at a time' : `${n} at a time`, active: (t.autoConcurrency || 1) === n,
        onSelect: () => setAutoConcurrency(t.id, n),
      })), { minWidth: 160 }); } });
    const wrap = h('div', { class: 'auto-ctl' }, glyph, seg, conc, pick);
    const hint = h('div', { class: 'auto-hint', hidden: true }, 'Auto: next task starts when a slot is free');
    function pickProjects() { return (spec.projectIds || []).map((id) => state.projects.get(id)).filter(Boolean); }
    function setMode(on) { const t = proj(); if (t) setAutoStart(t.id, on); }
    function update(next) {
      spec = next || { kind: 'none' };
      const t = proj();
      const ps = spec.kind === 'picker' ? pickProjects() : [];
      setHidden(wrap, spec.kind === 'none' || (spec.kind === 'switch' && !t) || (spec.kind === 'picker' && !ps.length));
      setHidden(seg, !t);
      setHidden(pick, spec.kind !== 'picker');
      setHidden(conc, !(t && t.autoStart));
      let on;
      if (t) {
        setText(conc, `\u00d7${t.autoConcurrency || 1}`);
        setClass(auto, 'on', !!t.autoStart); setClass(manual, 'on', !t.autoStart);
        auto.setAttribute('aria-pressed', String(!!t.autoStart)); manual.setAttribute('aria-pressed', String(!t.autoStart));
        on = !!t.autoStart;
        wrap.dataset.project = t.id;
        seg.setAttribute('aria-label', `Up next mode for ${t.name}`);
      } else {
        delete wrap.dataset.project;
        const n = ps.filter((p) => p.autoStart).length;
        setText(pick.lastChild, n ? `${n}/${ps.length}` : '');
        setClass(pick, 'on', n > 0);
        on = n > 0;
      }
      setHidden(glyph, !on);
      setHidden(hint, !on);
    }
    return { wrap, hint, update };
  }
  function attachAutoControls(c) {
    const ctl = buildAutoControls();
    const head = c.el.querySelector('.col-head');
    head.insertBefore(ctl.wrap, head.querySelector('.icon-btn'));
    c.el.insertBefore(ctl.hint, c.body);
    c.auto = ctl;
  }
  /** What the Up next headers need to decide: the pure rule lives in boardview.autoHeader. */
  const autoSpec = (group, laneTasks) => autoHeader({
    group, projectIds: sel.projects().map((p) => p.id), scopeProjectId: (sel.scopeProject() || {}).id,
    filterProjects: view.projects, laneProjectIds: laneTasks ? laneTasks.map((t) => t.projectId) : [],
  });
  function renderAutoControls() {
    const c = cols.next && cols.next.auto;
    if (!c) return;
    c.update(autoSpec('status'));
    // the card the hub will start next, per project on Auto
    const tops = new Map();
    for (const t of sel.scopedTasks()) {
      const p = state.projects.get(t.projectId);
      if (t.status !== 'next' || !p || !p.autoStart || String(t.id).startsWith('tmp-')) continue;
      const cur = tops.get(t.projectId);
      if (!cur || cmp(t, cur) < 0) tops.set(t.projectId, t);
    }
    nextUpIds = new Set(Array.from(tops.values(), (t) => t.id));
  }

  function buildLane(status) {
    const meta = STATUS_META[status];
    const key = `helm.lane.${status}`;
    const count = h('span', { class: 'col-count mono' }, '0');
    const need = h('span', { class: 'col-need mono', hidden: true });
    const body = h('div', { class: 'lane-body', 'data-status': status, 'data-layout': 'grid', 'data-empty': status === 'later' ? 'Park tasks here to come back to them' : 'Nothing is blocked' });
    const toggle = h('button', { class: 'lane-toggle', type: 'button', 'aria-expanded': 'true' },
      icon('chevronDown', 14, 'lane-chev'), statusDot(status), h('span', { class: 'col-title' }, meta.label), count, need);
    const el = h('section', { class: `lane lane-${status}`, 'aria-label': meta.label }, toggle, body);
    const apply = (open) => { setClass(el, 'collapsed', !open); toggle.setAttribute('aria-expanded', String(open)); };
    let open = lsGet(key) !== '0';
    apply(open);
    toggle.addEventListener('click', () => { open = !open; lsSet(key, open ? '1' : '0'); apply(open); });
    wireDrop(body);
    cols[status] = { el, body, count, need, toggle, forceOpen: () => { if (!open) { open = true; apply(true); } }, isOpen: () => open, apply };
    return el;
  }

  function buildComposer(status) {
    const input = h('input', { class: 'composer-input', type: 'text', placeholder: 'New task title…', 'aria-label': `New task title for ${STATUS_META[status].label}`, autocomplete: 'off' });
    const proj = h('select', { class: 'select select-sm', 'aria-label': 'Project' });
    const add = h('button', { class: 'btn btn-primary btn-sm', type: 'submit', title: 'Create (↵)' }, 'Create');
    const canGo = status === 'backlog' || status === 'next';
    const go = h('button', { class: 'btn btn-accent btn-sm composer-start', type: 'button', hidden: !canGo, title: 'Create and start now (⌘↵)', onclick: () => submit(true) },
      icon('play', 13), 'Create & start', h('kbd', { class: 'kbd' }, '⌘↵'));
    const cancel = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => closeComposer() }, 'Done');
    const tpl = h('button', { class: 'btn btn-quiet btn-sm composer-tpl', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Start from a saved template',
      onclick: () => openTemplatePopover(tpl, { getProject: () => (proj.hidden ? defaultProject() : proj.value) }) }, icon('templates', 14), 'Templates');
    async function submit(start) {
      const title = input.value.trim();
      if (!title) return;
      const projectId = proj.hidden ? defaultProject() : proj.value;
      if (!projectId) { toast('Create a project first', { kind: 'error' }); navigate('projects'); return; }
      if (!proj.hidden) lsSet('helm.composer.project', projectId);
      input.value = '';
      input.focus();
      await createTask({ projectId, title, status, start: start && canGo });
    }
    const el = h('form', { class: 'composer', hidden: true, onsubmit: (e) => { e.preventDefault(); submit(false); } },
      input, h('div', { class: 'composer-row' }, proj, tpl, h('span', { class: 'spacer' }), cancel, add, go));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeComposer(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); if (canGo) submit(true); }
    });
    return { el, input, proj };
  }

  function defaultProject() {
    const scope = sel.scopeProject();
    if (scope) return scope.id;
    const remembered = lsGet('helm.composer.project');
    const ps = sel.projects();
    if (remembered && ps.some((p) => p.id === remembered)) return remembered;
    return ps[0] ? ps[0].id : null;
  }

  function syncComposerProjects(status) {
    const c = cols[status].composer;
    const ps = sel.projects();
    const multi = state.ui.projectId === 'all' && ps.length > 1;
    setHidden(c.proj, !multi);
    if (multi) {
      const sig = ps.map((p) => p.id + p.name).join('|');
      if (c.proj.__sig !== sig) {
        const cur = c.proj.value;
        c.proj.__sig = sig;
        c.proj.textContent = '';
        ps.forEach((p) => c.proj.appendChild(h('option', { value: p.id }, p.name)));
        c.proj.value = ps.some((p) => p.id === cur) ? cur : defaultProject();
      }
    }
  }

  function openComposer(status = 'backlog') {
    composerCol = status;
    for (const s of MAIN_COLUMNS) setHidden(cols[s].composer.el, s !== status);
    syncComposerProjects(status);
    const inp = cols[status].composer.input;
    inp.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    inp.focus();
  }
  function closeComposer() {
    composerCol = null;
    for (const s of MAIN_COLUMNS) setHidden(cols[s].composer.el, true);
  }

  /* ---------- cards ---------- */
  function createCard(t, animate) {
    const r = {};
    r.title = h('h4', { class: 'card-title' });
    r.id = h('span', { class: 'task-id mono' });
    r.proj = h('span', { class: 'proj-chip' });
    r.stat = h('span', { class: 'status-chip', hidden: true }); // only in the flat "None" grouping, where the column is gone
    r.conflict = h('span', { class: 'conflict-chip mono', hidden: true }, icon('warning', 12), h('span', {}));
    r.avatar = avatar(null, 'sm');
    r.model = modelBadge('');
    r.agentName = h('span', { class: 'card-agent-name' });
    r.nd = nowDoingLine();
    r.agent = h('div', { class: 'card-agent' }, r.avatar, h('div', { class: 'card-agent-col' }, h('div', { class: 'card-agent-line' }, r.agentName, r.model), r.nd));
    r.blocked = h('div', { class: 'card-blocked' }, icon('blocked', 13), h('span', {}));
    r.elapsed = h('span', { class: 'meta-item elapsed' }, icon('clock', 13), h('span', { class: 'mono' }));
    r.tokens = h('span', { class: 'meta-item' }, icon('bolt', 13), h('span', { class: 'mono' }));
    r.files = h('span', { class: 'meta-item' }, icon('file', 13), h('span', { class: 'mono' }));
    r.dep = h('span', { class: 'dep-badge mono' }, icon('link', 12), h('span', {}));
    r.git = h('span', { class: 'meta-item git-glyph', hidden: true }, icon('branch', 13), h('span', { class: 'ci-dot', 'aria-hidden': 'true' }));
    r.meta = h('div', { class: 'card-meta' }, r.elapsed, r.tokens, r.files, r.git, r.dep);
    r.run = h('button', { class: 'run-chip', type: 'button', hidden: true });
    r.run.addEventListener('click', (e) => { e.stopPropagation(); const rid = r.run.__run; const run = state.runs.get(rid); if (run) navigate('workflows', [run.workflowId], { run: rid }); });
    r.approve = h('button', { class: 'card-approve', type: 'button' }, icon('check', 14), 'Approve');
    r.approve.addEventListener('click', (e) => { e.stopPropagation(); const g = sel.gateOfTask(el.__task); if (g) decideGate(g.run.id, g.node.nodeId, 'approve'); });
    r.nextUp = h('span', { class: 'next-up-chip', hidden: true, title: 'Auto mode starts this task next, once nothing is in progress' }, h('span', { 'aria-hidden': 'true' }, '⟳'), h('span', {}, 'Next up'));
    r.choices = h('button', { class: 'choices-chip', type: 'button', hidden: true }, h('span', { 'aria-hidden': 'true' }, '◆'), h('span', {}));
    r.choices.addEventListener('click', (e) => { e.stopPropagation(); openTask(r.choices.__task); });
    r.need = h('span', { class: 'need-pill', hidden: true }, h('span', { class: 'need-pill-dot', 'aria-hidden': 'true' }), h('span', {}));
    r.start = createStartStatus();
    r.actions = h('div', { class: 'card-actions' });
    const el = h('article', { class: 'card', tabindex: '0', draggable: 'true', 'data-id': t.id, role: 'group' },
      r.actions, r.need, r.title, h('div', { class: 'card-sub' }, r.id, r.stat, r.proj, r.run, r.conflict, r.choices, r.nextUp), r.agent, r.blocked, r.start.el, r.meta, r.approve);
    el.__r = r;
    el.__animate = !!animate;
    el.__needs = null; // unknown until first update; a card created already waiting pulses once when the board has rendered before
    el.addEventListener('click', (e) => { if (!e.target.closest('.card-actions') && !el.__task.__pending) openTask(el.__task.id); });
    el.addEventListener('focus', () => { if (state.ui.selectedTaskId !== el.__task.id) setUI({ selectedTaskId: el.__task.id }); });
    el.addEventListener('keydown', (e) => onCardKey(e, el));
    bindTaskMenu(el, () => el.__task); // right-click, Shift+F10 or the menu key
    el.addEventListener('dragstart', (e) => {
      if (String(el.__task.id).startsWith('tmp-')) { e.preventDefault(); return; }
      dragId = el.__task.id;
      const laneEl = el.closest('[data-lane]');
      dragLane = laneEl ? laneEl.dataset.lane : null;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragId); } catch { /* noop */ }
      setTimeout(() => el.classList.add('dragging'), 0);
      root.classList.add('is-dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      root.classList.remove('is-dragging');
      clearDropMarks();
      dragId = null;
      dragLane = null;
      if (needsRender) render();
    });
    return el;
  }

  function updateCard(el, t) {
    const r = el.__r;
    el.__task = t;
    const needs = sel.needsYou(t);
    const isNeed = needs.length > 0;
    setAttr(el, 'aria-label', `${t.id} ${t.title}${isNeed ? ` — needs you: ${needs.map((n) => n.label).join(', ')}` : ''}`);
    setClass(el, 'needs-you', isNeed);
    setHidden(r.need, !isNeed);
    if (isNeed) {
      setText(r.need.lastChild, `Needs you · ${needs[0].label}${needs.length > 1 ? ` +${needs.length - 1}` : ''}`);
      r.need.title = needs.map((n) => n.label).join(' · ');
    }
    if (isNeed && el.__needs === false || (isNeed && el.__needs === null && el.__animate)) {
      el.classList.remove('needs-pulse'); void el.offsetWidth; el.classList.add('needs-pulse');
      const done = () => el.classList.remove('needs-pulse');
      el.addEventListener('animationend', done, { once: true });
      setTimeout(done, 1600);
    }
    el.__needs = isNeed;
    setClass(el, 'pending', !!t.__pending);
    setText(r.title, t.title);
    setText(r.id, String(t.id).startsWith('tmp-') ? '…' : t.id);
    const showProj = showChips;
    const flat = view.group === 'none';
    setHidden(r.stat, !flat);
    if (flat) { setText(r.stat, (STATUS_META[t.status] || {}).label || t.status); setAttr(r.stat, 'data-status', t.status); }
    setHidden(r.proj, !showProj);
    if (showProj) setText(r.proj, sel.projectName(t.projectId));
    const agent = sel.agentOfTask(t);
    setHidden(r.agent, !agent);
    if (agent) {
      updateAvatar(r.avatar, agent);
      updateModelBadge(r.model, agent.model);
      setText(r.agentName, agentLabel(agent));
      r.nd.__set(agent.status === 'waiting' ? ((sel.openQuestionForAgent(agent.id) || {}).text || 'Waiting for you') : agent.nowDoing, agent.status === 'running');
      setClass(el, 'stalled', agent.status === 'stalled');
      setClass(el, 'waiting', agent.status === 'waiting');
    } else { setClass(el, 'stalled', false); setClass(el, 'waiting', false); }
    // v0.2 conflict radar chip
    const conflicts = t.conflicts || [];
    setHidden(r.conflict, conflicts.length === 0);
    if (conflicts.length) {
      setText(r.conflict.lastChild, plural(conflicts.length, 'file'));
      r.conflict.title = conflicts.map((c) => `${c.path} → ${c.otherTaskId || 'another agent'}`).join('\n');
    }
    // v0.9: workflow run chip + the green Approve of a waiting gate
    const run = t.runId ? state.runs.get(t.runId) : null;
    setHidden(r.run, !t.runId);
    if (t.runId) { r.run.__run = t.runId; setText(r.run, `${t.runId} · ${t.nodeId || 'run'}`); r.run.title = run ? `Open ${t.runId} on the canvas` : t.runId; }
    const gate = sel.gateOfTask(t);
    setClass(el, 'is-gate', !!gate);
    setHidden(r.nextUp, !(t.status === 'next' && nextUpIds.has(t.id)));
    const nChoices = sel.openChoiceCount(t);
    setHidden(r.choices, nChoices === 0);
    if (nChoices) {
      r.choices.__task = t.id;
      setText(r.choices.lastChild, nChoices === 1 ? '1 choice' : `${nChoices} choices`);
      r.choices.title = `${nChoices} suggestion${nChoices === 1 ? '' : 's'} waiting for you to tick — open ${t.id}`;
      r.choices.setAttribute('aria-label', `${nChoices} open choices on ${t.id}. Open to review`);
    }
    const showBlocked = t.status === 'blocked' && !!t.blockedReason;
    setHidden(r.blocked, !showBlocked);
    if (showBlocked) setText(r.blocked.lastChild, t.blockedReason);
    // elapsed
    if (t.status === 'in_progress') {
      const since = (agent && agent.startedAt) || t.updatedAt;
      setHidden(r.elapsed, false);
      r.elapsed.lastChild.setAttribute('data-since', since);
      setText(r.elapsed.lastChild, fmtElapsed(Date.now() - since));
    } else if ((t.status === 'done' || t.status === 'review') && agent && agent.startedAt) {
      setHidden(r.elapsed, false);
      r.elapsed.lastChild.removeAttribute('data-since');
      setText(r.elapsed.lastChild, fmtElapsed((agent.endedAt || t.doneAt || t.updatedAt) - agent.startedAt));
    } else setHidden(r.elapsed, true);
    const tokens = t.tokens || (agent && agent.tokens) || 0;
    setHidden(r.tokens, !tokens);
    if (tokens) setText(r.tokens.lastChild, fmtTokens(tokens));
    // v0.12: a branch glyph, with a CI dot once the branch is pushed and GitHub has said something
    const br = t.branch || null;
    setHidden(r.git, !br);
    if (br) {
      const ci = ciSummary(br.ci);
      const pc = prChip(br.pr);
      r.git.className = `meta-item git-glyph${ci ? ` tone-${ci.tone}` : ''}`;
      r.git.title = [br.name, br.pushedAt ? `pushed to ${br.remote}` : 'local branch', pc && `PR ${pc.text}`, ci && ci.label].filter(Boolean).join(' · ');
      r.git.setAttribute('aria-label', r.git.title);
      r.git.lastChild.hidden = !ci;
    }
    const nf = (t.filesChanged || []).length;
    setHidden(r.files, !nf);
    if (nf) setText(r.files.lastChild, String(nf));
    const deps = t.dependsOn || [];
    setHidden(r.dep, deps.length === 0);
    if (deps.length) {
      const unmet = deps.filter((d) => { const dt = state.tasks.get(d); return dt && dt.status !== 'done' && dt.status !== 'archived'; });
      setText(r.dep.lastChild, deps.length > 1 ? `${deps[0]} +${deps.length - 1}` : deps[0]);
      setClass(r.dep, 'unmet', unmet.length > 0);
      r.dep.title = unmet.length ? `Waiting on ${unmet.join(', ')}` : `Depends on ${deps.join(', ')} (met)`;
    }
    setHidden(r.meta, r.elapsed.hidden && r.tokens.hidden && r.files.hidden && r.dep.hidden);
    // quick actions
    r.start.update(t);
    const acts = t.__pending ? [] : [...(canStart(t) ? [t.interrupted ? { key: 'resume', label: 'Resume', icon: 'replay' } : { key: 'start', label: 'Start', icon: 'play' }] : []), ...quickActions(t)];
    reconcile(r.actions, acts, (a) => a.key, (a) => {
      const isStart = a.key === 'start' || a.key === 'resume'; // Resume wears the Start button's layout (T-57)
      const b = h('button', { class: `qa qa-${a.key}${isStart ? ' qa-start' : ''}`, type: 'button', title: isStart ? `${a.label} (S)` : a.label, 'aria-label': `${a.label} ${t.id}`,
        onclick: (e) => { e.stopPropagation(); if (isStart) startTask(el.__task.id, { scopeProjectId: boardScope() }); else runQuickAction(el.__task, b.__a); } },
      icon(a.icon, isStart ? 13 : 15), isStart ? h('span', { class: 'qa-label' }, a.label) : null, isStart ? h('span', { class: 'qa-badge', hidden: true }) : null);
      if (isStart) { // v0.28: say where this Start would go, looked up when the owner points at the button
        const where = () => paintStartTitle(b, el.__task);
        b.addEventListener('pointerenter', where); b.addEventListener('focus', where);
      }
      return b;
    }, (b, a) => {
      b.__a = a;
      if (a.key !== 'start' && a.key !== 'resume') return;
      const k = startDrafts(t.id).length;
      const verb = a.label;
      const badge = b.querySelector('.qa-badge');
      setText(badge, k ? String(k) : '');
      setHidden(badge, !k);
      b.title = k ? `${verb} (S) — sends ${k} draft note${k === 1 ? '' : 's'} with it` : `${verb} (S)`;
    });
  }

  /** The board's current project: a single project picked in the board filter, else the project scope. */
  function boardScope() {
    const v = effectiveView();
    return v.projects.length === 1 ? v.projects[0] : state.ui.projectId;
  }
  /** "Start in <project> · <session>" as the button's tooltip, once the hub has said where it goes. */
  function paintStartTitle(b, t) {
    const verb = b.__a ? b.__a.label : 'Start';
    const tg = cachedStartTarget(t, () => { if (b.isConnected && b.__a) paintStartTitle(b, state.tasks.get(t.id) || t); });
    if (!tg) return;
    const k = startDrafts(t.id).length;
    b.title = `${startTargetText(verb, tg)} (S)${k ? ` — sends ${k} draft note${k === 1 ? '' : 's'} with it` : ''}`;
  }

  function onCardKey(e, el) {
    const t = el.__task;
    if (e.target !== el) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(t.id); return; }
    if ((e.key === 's' || e.key === 'S') && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (canStart(t)) { e.preventDefault(); startTask(t.id, { scopeProjectId: boardScope() }); }
      return;
    }
    if (!e.altKey) return;
    const idx = MAIN_COLUMNS.indexOf(t.status);
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && idx >= 0) {
      const next = MAIN_COLUMNS[idx + (e.key === 'ArrowRight' ? 1 : -1)];
      if (next) { e.preventDefault(); const lane = laneKeyOf(t); placeTask(t.id, next, columnTasks(next, t.id, lane).length, lane).then(() => refocus(t.id)); }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const grp = needsOf(t);
      if (view.sort !== 'manual') return; // a sorted view has no manual order to change
      const lane = laneKeyOf(t);
      const list = columnTasks(t.status, null, lane).filter((x) => needsOf(x) === grp); // moves stay inside the card's group
      const i = list.findIndex((x) => x.id === t.id);
      const down = e.key === 'ArrowDown';
      const target = list[i + (down ? 1 : -1)];
      if (i < 0 || !target) return;
      const k = columnTasks(t.status, t.id, lane).findIndex((x) => x.id === target.id);
      placeTask(t.id, t.status, down ? k + 1 : k, lane).then(() => refocus(t.id));
    }
  }
  function refocus(id) {
    requestAnimationFrame(() => { const el = root.querySelector(`.card[data-id="${CSS.escape(id)}"]`); el && el.focus({ preventScroll: false }); });
  }

  /* ---------- v0.9: group by run ---------- */
  function withRunHeads(list) {
    const out = [];
    const done = new Set();
    for (const t of list) {
      if (!t.runId) { out.push({ key: t.id, t }); continue; }
      if (done.has(t.runId)) continue;
      done.add(t.runId);
      const group = list.filter((x) => x.runId === t.runId);
      const collapsed = collapsedRuns.has(t.runId);
      out.push({ key: `run:${t.runId}`, head: true, runId: t.runId, count: group.length, collapsed });
      if (!collapsed) for (const g of group) out.push({ key: g.id, t: g });
    }
    return out;
  }
  function createRunHead(it) {
    const el = h('button', { class: 'run-head', type: 'button', 'aria-expanded': 'true' },
      icon('chevronDown', 14), h('span', { class: 'run-head-id' }), h('span', { class: 'run-head-t' }), h('span', { class: 'run-head-n' }));
    el.addEventListener('click', () => {
      const id = el.__it.runId;
      if (collapsedRuns.has(id)) collapsedRuns.delete(id); else collapsedRuns.add(id);
      lsSet('helm.board.runsCollapsed', JSON.stringify([...collapsedRuns]));
      render();
    });
    return el;
  }
  function updateRunHead(el, it) {
    el.__it = it;
    const run = state.runs.get(it.runId);
    const wf = run ? state.workflows.get(run.workflowId) : null;
    const nodes = run ? run.nodes : [];
    const doneN = nodes.filter((n) => n.state === 'ok' || n.state === 'skipped').length;
    setClass(el, 'collapsed', it.collapsed);
    el.setAttribute('aria-expanded', String(!it.collapsed));
    setText(el.children[1], it.runId);
    setText(el.children[2], wf ? wf.name : 'Workflow run');
    setText(el.children[3], run ? `(${doneN}/${nodes.length}) · ${it.count} here` : `${it.count} here`);
    el.title = it.collapsed ? 'Show these cards' : 'Hide these cards';
  }

  /* ---------- ordering + dnd ---------- */
  /** Needs-you cards first; the user's manual order (cmp) applies inside each group. */
  function sortNeedsFirst(list) {
    const flag = new Map(list.map((t) => [t.id, needsOf(t)]));
    return list.sort((a, b) => (flag.get(b.id) - flag.get(a.id)) || cmp(a, b));
  }

  /** The lane a task sits in under the current grouping (null in the plain kanban). */
  const laneKeyOf = (t) => { const l = view.group === 'status' ? null : laneOf(t, view.group, viewCtx()); return l ? l.key : null; };

  /** Manual order of one column; inside a lane only that lane's cards count. */
  function columnTasks(status, excludeId, lane = null) {
    const list = sel.scopedTasks().filter((t) => t.status === status && t.id !== excludeId && (lane == null || laneKeyOf(t) === lane));
    return status === 'done' ? list.sort(cmpDone) : sortNeedsFirst(list);
  }

  async function placeTask(id, status, index, lane = null) {
    const t = state.tasks.get(id);
    if (!t) return;
    if (status === 'done' || view.sort !== 'manual') { // done is ordered by completion time, a sorted view by its sort: only the status changes
      if (t.status !== status) await patchTask(id, { status }, 'Could not move task');
      return;
    }
    // `index` is a position in the displayed column (needs-you group first); orders only matter within a group,
    // so translate it to a position among the cards that share this card's group.
    const grp = needsOf(t);
    const display = columnTasks(status, id, lane);
    const gIndex = display.slice(0, index).filter((x) => needsOf(x) === grp).length;
    const col = display.filter((x) => needsOf(x) === grp);
    index = gIndex;
    const prev = col[index - 1], next = col[index];
    let order;
    if (prev && next) order = (prev.order + next.order) / 2;
    else if (prev) order = prev.order + 1;
    else if (next) order = next.order - 1;
    else order = 1;
    const tie = prev && next && !(order > prev.order && order < next.order);
    if (!tie) {
      if (t.status === status && t.order === order) return;
      await patchTask(id, { status, order }, 'Could not move task');
      return;
    }
    // neighbours share an order value: renumber the column
    const seq = col.slice(); seq.splice(index, 0, t);
    await Promise.all(seq.map((x, i) => {
      const o = (i + 1) * 100;
      if (x.id === id) return patchTask(id, { status, order: o }, 'Could not move task');
      return x.order !== o ? patchTask(x.id, { order: o }, 'Could not reorder') : null;
    }));
  }

  function dropIndex(body, clientX, clientY) {
    const cards = Array.from(body.children).filter((c) => c.classList.contains('card') && !c.classList.contains('dragging'));
    const grid = body.dataset.layout === 'grid';
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (grid) {
        if (clientY < r.top || (clientY <= r.bottom && clientX < r.left + r.width / 2)) return { index: i, before: cards[i] };
      } else if (clientY < r.top + r.height / 2) return { index: i, before: cards[i] };
    }
    return { index: cards.length, before: null };
  }

  function clearDropMarks() {
    root.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    root.querySelectorAll('.drop-end, .drop-over').forEach((x) => x.classList.remove('drop-end', 'drop-over'));
  }

  function wireDrop(body) {
    body.addEventListener('dragover', (e) => {
      if (!dragId || !body.dataset.status || !canDropAcross(dragLane, body.dataset.lane || null)) return; // not a target: cursor shows no-drop
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      body.classList.add('drop-over');
      const { before } = dropIndex(body, e.clientX, e.clientY);
      if (before) before.classList.add('drop-before'); else body.classList.add('drop-end');
    });
    body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) { body.classList.remove('drop-over', 'drop-end'); } });
    body.addEventListener('drop', (e) => {
      if (!dragId || !body.dataset.status || !canDropAcross(dragLane, body.dataset.lane || null)) return;
      e.preventDefault();
      const id = dragId;
      const { before } = dropIndex(body, e.clientX, e.clientY);
      clearDropMarks();
      dragId = null;
      dragLane = null;
      root.classList.remove('is-dragging');
      const status = body.dataset.status;
      const lane = body.dataset.lane || null;
      const col = columnTasks(status, id, lane); // unfiltered, so the "Needs me" filter cannot skew the position
      const k = before && before.__task ? col.findIndex((x) => x.id === before.__task.id) : -1;
      placeTask(id, status, k >= 0 ? k : col.length, lane);
    });
  }

  /* ---------- view (group / filter / sort / saved) ---------- */
  const viewCtx = () => ({
    needs: needsOf, agent: (t) => sel.agentOfTask(t), model: (a) => modelInfo(a.model),
    projectName: (id) => sel.projectName(id), projectOrder: sel.projects().map((p) => p.id),
  });
  /** The view as it applies right now: a project that no longer exists cannot filter everything away. */
  function effectiveView() {
    if (!view.projects.length || !state.ready) return view;
    const known = view.projects.filter((id) => state.projects.has(id));
    return known.length === view.projects.length ? view : { ...view, projects: known };
  }
  function setView(patch) {
    view = normalizeView({ ...view, ...patch });
    lsSet('helm.board.view', JSON.stringify(view));
    lsSet('helm.board.needsMe', view.needs ? '1' : '0');
    render();
    paintViewPanel();
  }
  function setSaved(next) { saved = next; lsSet('helm.board.views', JSON.stringify(saved)); render(); paintViewPanel(); }
  const orderList = (list, status) => {
    if (view.sort === 'manual') return status === 'done' ? list.sort(cmpDone) : sortNeedsFirst(list);
    return sortTasks(list, view.sort, cmp, viewCtx());
  };

  function paintViewBar() {
    const v = effectiveView();
    const n = activeFilterCount(v);
    const custom = !isDefaultView(v);
    setClass(viewBtn, 'on', custom);
    setText(viewLabel, custom ? describeView(v).replace(/^Status( · )?/, '') : '');
    setHidden(viewLabel, !custom || describeView(v) === 'Status');
    viewBtn.title = custom ? `View: ${describeView(v)}` : 'Group, filter and sort the board';
    const match = matchingView(saved, v);
    reconcile(savedEl, saved.slice(0, 5), (e) => e.name, (e) => h('button', { class: 'view-pill', type: 'button' }),
      (el, e) => {
        el.__view = e.view;
        setText(el, e.name);
        setClass(el, 'on', !!match && match.name === e.name);
        el.setAttribute('aria-pressed', String(!!match && match.name === e.name));
        el.title = `Switch to “${e.name}” (${describeView(e.view)})`;
        el.onclick = () => setView(el.__view);
      });
    return n;
  }

  /* the View popover */
  function closeViewPanel() {
    if (!viewPanel) return;
    const { el, off } = viewPanel;
    viewPanel = null;
    off();
    el.remove();
    viewBtn.setAttribute('aria-expanded', 'false');
  }
  function openViewPanel() {
    const el = h('div', { class: 'view-pop', role: 'dialog', 'aria-label': 'Board view' });
    document.body.appendChild(el);
    const place = () => {
      const r = viewBtn.getBoundingClientRect();
      el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
      el.style.top = Math.min(r.bottom + 6, Math.max(8, innerHeight - el.offsetHeight - 8)) + 'px';
    };
    const onDown = (e) => { if (!el.contains(e.target) && !viewBtn.contains(e.target)) closeViewPanel(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeViewPanel(); viewBtn.focus(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeViewPanel);
    viewPanel = { el, place, off: () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', closeViewPanel); } };
    viewBtn.setAttribute('aria-expanded', 'true');
    paintViewPanel();
    const first = el.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }
  function paintViewPanel() {
    if (!viewPanel) return;
    const { el } = viewPanel;
    const keep = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    el.textContent = '';
    const seg = (items, cur, onPick, label) => h('div', { class: 'view-seg', role: 'radiogroup', 'aria-label': label },
      ...items.map((it) => h('button', { class: ['view-seg-btn', cur === it.key && 'on'], type: 'button', role: 'radio', 'aria-checked': String(cur === it.key), title: it.hint || it.label,
        'data-k': `seg-${label}-${it.key}`, onclick: () => onPick(it.key) }, it.label)));
    const chip = (label, on, onClick, k, dot) => h('button', { class: ['view-chip', on && 'on'], type: 'button', 'aria-pressed': String(on), 'data-k': k, onclick: onClick },
      dot ? h('span', { class: 'view-chip-dot', style: { background: `var(--st-${dot})` }, 'aria-hidden': 'true' }) : null, label);
    const toggleIn = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
    const ps = sel.projects();
    const statuses = [...MAIN_COLUMNS, ...LANES];
    const nameInput = h('input', { class: 'input view-name', type: 'text', placeholder: 'Name this view…', maxlength: '32', 'aria-label': 'Name for the saved view', autocomplete: 'off', 'data-k': 'name' });
    const doSave = () => { const nm = nameInput.value.trim(); if (!nm) { nameInput.focus(); return; } setSaved(saveView(saved, nm, view)); toast(`Saved view “${nm}”`, { duration: 2000 }); };
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } e.stopPropagation(); });
    el.append(
      h('div', { class: 'view-sec' }, h('div', { class: 'view-h' }, 'Group by'),
        seg(GROUPS, view.group, (k) => setView({ group: k }), 'Group by')),
      h('div', { class: 'view-sec' }, h('div', { class: 'view-h' }, 'Sort'),
        seg(SORTS, view.sort, (k) => setView({ sort: k }), 'Sort')),
      h('div', { class: 'view-sec' }, h('div', { class: 'view-h' }, 'Show'),
        h('div', { class: 'view-chips' },
          chip('Needs you', view.needs, () => setView({ needs: !view.needs }), 'needs'),
          chip('Has agent', view.hasAgent, () => setView({ hasAgent: !view.hasAgent }), 'agent'))),
      h('div', { class: 'view-sec' }, h('div', { class: 'view-h' }, 'Status'),
        h('div', { class: 'view-chips' }, ...statuses.map((st) => chip(STATUS_META[st].label, view.statuses.includes(st), () => setView({ statuses: toggleIn(view.statuses, st) }), `st-${st}`, st)))),
      ps.length > 1 ? h('div', { class: 'view-sec' }, h('div', { class: 'view-h' }, 'Project'),
        h('div', { class: 'view-chips' }, ...ps.map((p) => chip(p.name, view.projects.includes(p.id), () => setView({ projects: toggleIn(view.projects, p.id) }), `pr-${p.id}`)))) : null,
      h('div', { class: 'view-sec view-saved-sec' }, h('div', { class: 'view-h' }, 'Saved views'),
        saved.length ? h('div', { class: 'view-list' }, ...saved.map((e) => h('div', { class: 'view-row' },
          h('button', { class: 'view-row-go', type: 'button', 'data-k': `sv-${e.name}`, onclick: () => setView(e.view) }, h('span', { class: 'view-row-name' }, e.name), h('span', { class: 'view-row-sum' }, describeView(e.view))),
          h('button', { class: 'view-row-x', type: 'button', 'aria-label': `Delete view ${e.name}`, title: 'Delete', onclick: () => setSaved(removeView(saved, e.name)) }, icon('close', 12))))) : h('div', { class: 'view-none' }, 'None yet. Set up the board the way you like it, then save it.'),
        h('div', { class: 'view-save' }, nameInput, h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: doSave }, 'Save'))),
      h('div', { class: 'view-foot' },
        h('button', { class: 'btn btn-quiet btn-sm', type: 'button', disabled: isDefaultView(view), onclick: () => setView(defaultView()) }, 'Reset')));
    viewPanel.place();
    if (keep) { const again = el.querySelector(`[data-k="${CSS.escape(keep)}"]`); if (again) again.focus({ preventScroll: true }); }
  }

  /* ---------- swimlanes (Project / Agent / None) ---------- */
  function persistLanes() { lsSet('helm.board.lanesCollapsed', JSON.stringify([...collapsedLanes])); }
  function createLane(lane) {
    const count = h('span', { class: 'col-count mono' }, '0');
    const need = h('span', { class: 'col-need mono', hidden: true });
    const name = h('span', { class: 'col-title' });
    const toggle = h('button', { class: 'lane-toggle swim-toggle', type: 'button', 'aria-expanded': 'true' }, icon('chevronDown', 14, 'lane-chev'), name, count, need);
    const cols2 = h('div', { class: 'swim-cols' });
    const el = h('section', { class: 'swim-lane', 'data-lane': lane.key }, toggle, cols2);
    toggle.addEventListener('click', () => {
      const key = el.__lane.key;
      if (collapsedLanes.has(key)) collapsedLanes.delete(key); else collapsedLanes.add(key);
      persistLanes();
      setClass(el, 'collapsed', collapsedLanes.has(key));
      toggle.setAttribute('aria-expanded', String(!collapsedLanes.has(key)));
    });
    el.__r = { name, count, need, cols: cols2, toggle };
    return el;
  }
  function createLaneCol(status, laneKey) {
    const meta = STATUS_META[status];
    const count = h('span', { class: 'col-count mono' }, '0');
    const body = h('div', { class: 'col-body', 'data-status': status, 'data-lane': laneKey, 'data-layout': 'v', 'data-empty': 'Drop tasks here' });
    wireDrop(body);
    const el = h('section', { class: `col col-${status}`, 'aria-label': meta.label }, h('header', { class: 'col-head' }, statusDot(status), h('h3', { class: 'col-title' }, meta.label), count), body);
    el.__r = { body, count };
    if (status === 'next') { // T-96: Auto lives in every Up next header, scoped to the lane's project
      const ctl = buildAutoControls();
      el.querySelector('.col-head').appendChild(ctl.wrap);
      el.insertBefore(ctl.hint, body);
      el.__r.auto = ctl;
    }
    return el;
  }
  function renderLanes(list) {
    const ctx = viewCtx();
    const lanes = groupTasks(list, view.group, ctx);
    const rank = Object.fromEntries([...MAIN_COLUMNS, ...LANES].map((st, i) => [st, i]));
    reconcile(swimEl, lanes, (l) => l.key, (l) => createLane(l), (el, lane) => {
      const r = el.__r;
      el.__lane = lane;
      const collapsed = collapsedLanes.has(lane.key);
      setClass(el, 'collapsed', collapsed);
      r.toggle.setAttribute('aria-expanded', String(!collapsed));
      setText(r.name, lane.label);
      setText(r.count, String(lane.tasks.length));
      const nNeed = lane.tasks.filter(needsOf).length;
      setHidden(r.need, nNeed === 0);
      setText(r.need, nNeed === 1 ? '1 needs you' : `${nNeed} need you`);
      if (view.group === 'none') { // one flat list, status shown on the card
        const sorted = sortTasks(lane.tasks, view.sort, view.sort === 'manual' ? (a, b) => (rank[a.status] - rank[b.status]) || cmp(a, b) : cmp, ctx);
        let body = r.cols.firstChild;
        if (!body) { body = h('div', { class: 'lane-body swim-flat', 'data-lane': lane.key, 'data-layout': 'grid', 'data-empty': 'Nothing matches this view' }); r.cols.appendChild(body); }
        reconcile(body, sorted.map((t) => ({ key: t.id, t })), (it) => it.key, (it, animate) => createCard(it.t, animate), (c, it) => updateCard(c, it.t));
        return;
      }
      const sts = laneStatuses(lane.tasks, MAIN_COLUMNS, LANES, view.statuses);
      reconcile(r.cols, sts, (st) => st, (st) => createLaneCol(st, lane.key), (colEl, st) => {
        const cr = colEl.__r;
        if (cr.auto) cr.auto.update(autoSpec(view.group, lane.tasks));
        const here = orderList(lane.tasks.filter((t) => t.status === st), st);
        setText(cr.count, String(here.length));
        reconcile(cr.body, here.map((t) => ({ key: t.id, t })), (it) => it.key, (it, animate) => createCard(it.t, animate), (c, it) => updateCard(c, it.t));
      });
    });
  }

  /* ---------- render ---------- */
  function render() {
    if (dragId) { needsRender = true; return; }
    needsRender = false;
    renderAutoControls();
    if (state.ready) {
      const pr = boardFilter.prune();
      if (pr.changed) { saveFilter(boardFilter.get()); const q = {}; for (const [k, v] of route().query) q[k] = v; Object.assign(q, filterToQuery(boardFilter.get())); navigate('board', route().args, q, { replace: true }); }
    }
    boardFilter.refresh();
    const tasks = applyFilter(sel.scopedTasks(), boardFilter.get());
    const v = effectiveView();
    const ctx = viewCtx();
    const lanesMode = v.group !== 'status';
    // everything but "needs you": the needs filter keeps its own count so the button can still show how many are waiting
    const base = filterTasks(tasks, { ...v, needs: false }, ctx);
    const byStatus = {};
    for (const t of base) (byStatus[t.status] ||= []).push(t);
    setAttr(needsBtn, 'aria-pressed', String(v.needs));
    setAttr(groupBtn, 'aria-pressed', String(groupByRun));
    setClass(groupBtn, 'on', groupByRun);
    setClass(needsBtn, 'on', v.needs);
    setHidden(groupBtn, lanesMode);
    root.dataset.group = v.group;
    setHidden(colsEl, lanesMode);
    setHidden(lanesEl, lanesMode);
    setHidden(swimEl, !lanesMode);
    paintViewBar();
    // a nudge, not a switch: several projects on one board and still plain columns
    const nProj = projectCount(base);
    showChips = nProj > 1 && v.group !== 'project'; // v0.28: a project chip on every card while the board mixes projects
    const hint = !lanesMode && state.ui.projectId === 'all' && nProj > 1 && lsGet('helm.board.laneHint') !== '0';
    setHidden(laneHint, !hint);
    if (hint) setText(laneHint.firstChild, `${nProj} projects here · group by project`);
    // only one layout holds cards at a time, so refocus() and the y key never find a hidden twin
    if (lanesMode) {
      for (const status of [...MAIN_COLUMNS, ...LANES]) if (cols[status].body.__keyed && cols[status].body.__keyed.size) reconcile(cols[status].body, [], (x) => x.key);
      renderLanes(v.needs ? base.filter(needsOf) : base);
    } else if (swimEl.__keyed && swimEl.__keyed.size) reconcile(swimEl, [], (x) => x.key);
    if (!lanesMode) for (const status of [...MAIN_COLUMNS, ...LANES]) {
      let list = orderList(byStatus[status] || [], status);
      const c = cols[status];
      const nNeed = list.filter(needsOf).length;
      setHidden(c.need, nNeed === 0);
      setText(c.need, nNeed === 1 ? '1 needs you' : `${nNeed} need you`);
      setHidden(c.el, v.statuses.length > 0 && !v.statuses.includes(status));
      if (v.needs) list = list.filter(needsOf);
      const total = list.length;
      if (status === 'done' && !doneExpanded) list = list.slice(0, DONE_LIMIT);
      const items = groupByRun ? withRunHeads(list) : list.map((t) => ({ key: t.id, t }));
      reconcile(c.body, items, (it) => it.key, (it, animate) => (it.head ? createRunHead(it) : createCard(it.t, animate)),
        (el, it) => (it.head ? updateRunHead(el, it) : updateCard(el, it.t)));
      c.body.setAttribute('data-empty', v.needs ? 'Nothing here needs you' : (status === 'done' ? 'Nothing done yet' : status === 'later' ? 'Park tasks here to come back to them' : status === 'blocked' ? 'Nothing is blocked' : 'Drop tasks here'));
      setText(c.count, String(total));
      if (status === 'done') {
        setHidden(c.more, total <= DONE_LIMIT);
        setText(c.more, doneExpanded ? 'Show fewer' : `Show ${total - DONE_LIMIT} more`);
      }
    }
    const needTotal = tasks.filter(needsOf).length; // every card waiting for you, whatever the filters
    setHidden(needsBtnCount, needTotal === 0);
    setText(needsBtnCount, String(needTotal));
    setClass(needsBtn, 'has-items', needTotal > 0);
    // blocked lane draws attention
    setClass(cols.blocked.el, 'has-items', !!(byStatus.blocked && byStatus.blocked.length));
    setClass(cols.later.el, 'has-items', !!(byStatus.later && byStatus.later.length));
    if (composerCol) syncComposerProjects(composerCol);

    // banner / empty states
    const noProjects = sel.projects().length === 0;
    if (!state.ready) { setHidden(banner, true); }
    else if (noProjects && state.sessions.size === 0) {
      showBanner('No sessions yet', 'Start Claude Code with Helm installed and your work lands here automatically.');
    } else if (tasks.length === 0) {
      showBanner('No tasks yet', 'Tasks appear when agents start work. You can also add one yourself with New task.', { label: 'New task', onClick: () => openComposer('backlog') });
    } else setHidden(banner, true);
  }

  function showBanner(title, body, action) {
    const sig = title + body;
    setHidden(banner, false);
    if (banner.__sig === sig) return;
    banner.__sig = sig;
    banner.textContent = '';
    banner.append(
      h('div', { class: 'empty-icon' }, icon('board', 24)),
      h('div', { class: 'board-banner-text' }, h('strong', {}, title), h('span', {}, body)),
      action ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: action.onClick }, action.label) : null);
  }

  function onYKey(e) {
    if (e.key !== 'y' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    const cards = Array.from(root.querySelectorAll('.card.needs-you'));
    if (!cards.length) return;
    e.preventDefault();
    const cur = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.card') : null;
    const i = cards.indexOf(cur);
    const next = cards[(i + 1) % cards.length];
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  document.addEventListener('keydown', onYKey);

  const offNew = bus.on('new-task', () => openComposer('backlog'));
  render();
  if (state.ui.pendingNewTask) { setUI({ pendingNewTask: false }); openComposer('backlog'); }

  return {
    watch: ['task', 'agent', 'project', 'session', 'ui', 'ready', 'question', 'note', 'run', 'workflow'],
    update: render,
    setRoute(r) { const f = filterFromQuery(r.query); if (f && JSON.stringify(f) !== JSON.stringify(boardFilter.get())) { boardFilter.setFilter(f); saveFilter(f); render(); } },
    destroy() { offNew(); boardFilter.destroy(); closeViewPanel(); document.removeEventListener('keydown', onYKey); root.remove(); },
  };
}
