// views/board.js — kanban: 5 columns + collapsible Later/Blocked lanes, drag & drop, inline composer.
import { h, reconcile, setText, setClass, setHidden, setAttr, bus, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, lsGet, lsSet, setUI } from '../store.js';
import { patchTask, createTask, quickActions, runQuickAction, startTask, canStart, startDrafts, setAutoStart, autoTarget } from '../actions.js';
import { createStartStatus } from '../replies.js';
import { fmtElapsed, fmtTokens, truncate, agentLabel, STATUS_META, MAIN_COLUMNS, LANES, plural } from '../format.js';
import { avatar, updateAvatar, modelBadge, updateModelBadge, nowDoingLine, statusDot, toast, openMenu } from '../ui.js';
import { openTask, navigate } from '../router.js';

const DONE_LIMIT = 30;
const cmp = (a, b) => (a.order - b.order) || (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id));
const needsOf = (t) => sel.needsYou(t).length > 0;
const cmpDone = (a, b) => (b.doneAt || b.updatedAt || 0) - (a.doneAt || a.updatedAt || 0);

export function mount(container) {
  let composerCol = null;
  let dragId = null;
  let needsRender = false;
  let doneExpanded = false;
  let onlyNeeds = lsGet('helm.board.needsMe') === '1';
  const cols = {}; // status -> {el, body, count, composer, ...}
  let nextUpIds = new Set(); // v0.7: the top Up next card of every project that is on Auto

  startTicker();

  /* ---------- structure ---------- */
  const banner = h('div', { class: 'board-banner', hidden: true });
  const colsEl = h('div', { class: 'board-cols' });
  const lanesEl = h('div', { class: 'board-lanes' });
  const needsBtnCount = h('span', { class: 'needs-toggle-count mono', hidden: true }, '0');
  const needsBtn = h('button', { class: 'needs-toggle', type: 'button', 'aria-pressed': String(onlyNeeds), title: 'Show only cards waiting for you (y jumps to the next one)',
    onclick: () => { onlyNeeds = !onlyNeeds; lsSet('helm.board.needsMe', onlyNeeds ? '1' : '0'); render(); } },
  h('span', { class: 'needs-dot', 'aria-hidden': 'true' }), h('span', {}, 'Needs me'), needsBtnCount);
  const bar = h('div', { class: 'board-bar' }, needsBtn);
  const root = h('div', { class: 'board' }, bar, banner, colsEl, lanesEl);
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

  /** v0.7: Manual | Auto switch in the Up next header (a project popover in All projects) plus the hint line. */
  function attachAutoControls(c) {
    const manual = h('button', { class: 'auto-seg-btn', type: 'button', 'data-mode': 'manual', onclick: () => setMode(false) }, 'Manual');
    const auto = h('button', { class: 'auto-seg-btn', type: 'button', 'data-mode': 'auto', onclick: () => setMode(true) }, 'Auto');
    const glyph = h('span', { class: 'auto-glyph', 'aria-hidden': 'true', hidden: true, title: 'Auto mode is on' }, '⟳');
    const seg = h('div', { class: 'auto-seg', role: 'group', 'aria-label': 'Up next mode' }, manual, auto);
    const pick = h('button', { class: 'auto-pick', type: 'button', 'aria-haspopup': 'menu', title: 'Choose which projects start their Up next automatically',
      onclick: () => openMenu(pick, sel.projects().map((p) => ({
        label: p.name, sub: p.autoStart ? 'Auto' : 'Manual', active: !!p.autoStart, icon: p.autoStart ? 'play' : undefined,
        onSelect: () => setAutoStart(p.id, !p.autoStart),
      })), { minWidth: 240 }) }, h('span', {}, 'Auto'), h('span', { class: 'auto-pick-n mono' }));
    const wrap = h('div', { class: 'auto-ctl' }, glyph, seg, pick);
    const hint = h('div', { class: 'auto-hint', hidden: true }, 'Auto: next task starts when nothing is in progress');
    const head = c.el.querySelector('.col-head');
    head.insertBefore(wrap, head.querySelector('.icon-btn'));
    c.el.insertBefore(hint, c.body);
    function setMode(on) { const t = autoTarget(); if (t) setAutoStart(t.id, on); }
    c.auto = { wrap, manual, auto, glyph, seg, pick, hint };
  }
  function renderAutoControls() {
    const c = cols.next && cols.next.auto;
    if (!c) return;
    const ps = sel.projects();
    const target = autoTarget();
    const anyOn = ps.some((p) => p.autoStart);
    setHidden(c.wrap, ps.length === 0);
    setHidden(c.seg, !target);
    setHidden(c.pick, !!target);
    if (target) {
      setClass(c.auto, 'on', !!target.autoStart); setClass(c.manual, 'on', !target.autoStart);
      c.auto.setAttribute('aria-pressed', String(!!target.autoStart)); c.manual.setAttribute('aria-pressed', String(!target.autoStart));
    } else {
      const n = ps.filter((p) => p.autoStart).length;
      setText(c.pick.lastChild, n ? `${n}/${ps.length}` : '');
      setClass(c.pick, 'on', n > 0);
    }
    setHidden(c.glyph, !(target ? target.autoStart : anyOn));
    setHidden(c.hint, !(target ? target.autoStart : anyOn));
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
      input, h('div', { class: 'composer-row' }, proj, h('span', { class: 'spacer' }), cancel, add, go));
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
    r.meta = h('div', { class: 'card-meta' }, r.elapsed, r.tokens, r.files, r.dep);
    r.nextUp = h('span', { class: 'next-up-chip', hidden: true, title: 'Auto mode starts this task next, once nothing is in progress' }, h('span', { 'aria-hidden': 'true' }, '⟳'), h('span', {}, 'Next up'));
    r.choices = h('button', { class: 'choices-chip', type: 'button', hidden: true }, h('span', { 'aria-hidden': 'true' }, '◆'), h('span', {}));
    r.choices.addEventListener('click', (e) => { e.stopPropagation(); openTask(r.choices.__task); });
    r.need = h('span', { class: 'need-pill', hidden: true }, h('span', { class: 'need-pill-dot', 'aria-hidden': 'true' }), h('span', {}));
    r.start = createStartStatus();
    r.actions = h('div', { class: 'card-actions' });
    const el = h('article', { class: 'card', tabindex: '0', draggable: 'true', 'data-id': t.id, role: 'group' },
      r.actions, r.need, r.title, h('div', { class: 'card-sub' }, r.id, r.proj, r.conflict, r.choices, r.nextUp), r.agent, r.blocked, r.start.el, r.meta);
    el.__r = r;
    el.__animate = !!animate;
    el.__needs = null; // unknown until first update; a card created already waiting pulses once when the board has rendered before
    el.addEventListener('click', (e) => { if (!e.target.closest('.card-actions') && !el.__task.__pending) openTask(el.__task.id); });
    el.addEventListener('focus', () => { if (state.ui.selectedTaskId !== el.__task.id) setUI({ selectedTaskId: el.__task.id }); });
    el.addEventListener('keydown', (e) => onCardKey(e, el));
    el.addEventListener('dragstart', (e) => {
      if (String(el.__task.id).startsWith('tmp-')) { e.preventDefault(); return; }
      dragId = el.__task.id;
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
    const showProj = state.ui.projectId === 'all' && state.projects.size > 1;
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
    const acts = t.__pending ? [] : [...(canStart(t) ? [{ key: 'start', label: 'Start', icon: 'play' }] : []), ...quickActions(t)];
    reconcile(r.actions, acts, (a) => a.key, (a) => {
      const isStart = a.key === 'start';
      const b = h('button', { class: `qa qa-${a.key}`, type: 'button', title: isStart ? 'Start (S)' : a.label, 'aria-label': `${a.label} ${t.id}`,
        onclick: (e) => { e.stopPropagation(); if (isStart) startTask(el.__task.id); else runQuickAction(el.__task, b.__a); } },
      icon(a.icon, isStart ? 13 : 15), isStart ? h('span', { class: 'qa-label' }, 'Start') : null, isStart ? h('span', { class: 'qa-badge', hidden: true }) : null);
      return b;
    }, (b, a) => {
      b.__a = a;
      if (a.key !== 'start') return;
      const k = startDrafts(t.id).length;
      const badge = b.querySelector('.qa-badge');
      setText(badge, k ? String(k) : '');
      setHidden(badge, !k);
      b.title = k ? `Start (S) — sends ${k} draft note${k === 1 ? '' : 's'} with it` : 'Start (S)';
    });
  }

  function onCardKey(e, el) {
    const t = el.__task;
    if (e.target !== el) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(t.id); return; }
    if ((e.key === 's' || e.key === 'S') && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (canStart(t)) { e.preventDefault(); startTask(t.id); }
      return;
    }
    if (!e.altKey) return;
    const idx = MAIN_COLUMNS.indexOf(t.status);
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && idx >= 0) {
      const next = MAIN_COLUMNS[idx + (e.key === 'ArrowRight' ? 1 : -1)];
      if (next) { e.preventDefault(); placeTask(t.id, next, columnTasks(next, t.id).length).then(() => refocus(t.id)); }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const grp = needsOf(t);
      const list = columnTasks(t.status, null).filter((x) => needsOf(x) === grp); // moves stay inside the card's group
      const i = list.findIndex((x) => x.id === t.id);
      const down = e.key === 'ArrowDown';
      const target = list[i + (down ? 1 : -1)];
      if (i < 0 || !target) return;
      const k = columnTasks(t.status, t.id).findIndex((x) => x.id === target.id);
      placeTask(t.id, t.status, down ? k + 1 : k).then(() => refocus(t.id));
    }
  }
  function refocus(id) {
    requestAnimationFrame(() => { const el = root.querySelector(`.card[data-id="${CSS.escape(id)}"]`); el && el.focus({ preventScroll: false }); });
  }

  /* ---------- ordering + dnd ---------- */
  /** Needs-you cards first; the user's manual order (cmp) applies inside each group. */
  function sortNeedsFirst(list) {
    const flag = new Map(list.map((t) => [t.id, needsOf(t)]));
    return list.sort((a, b) => (flag.get(b.id) - flag.get(a.id)) || cmp(a, b));
  }

  function columnTasks(status, excludeId) {
    const list = sel.scopedTasks().filter((t) => t.status === status && t.id !== excludeId);
    return status === 'done' ? list.sort(cmpDone) : sortNeedsFirst(list);
  }

  async function placeTask(id, status, index) {
    const t = state.tasks.get(id);
    if (!t) return;
    if (status === 'done') { // done column is ordered by completion time, so only the status changes
      if (t.status !== status) await patchTask(id, { status }, 'Could not move task');
      return;
    }
    // `index` is a position in the displayed column (needs-you group first); orders only matter within a group,
    // so translate it to a position among the cards that share this card's group.
    const grp = needsOf(t);
    const display = columnTasks(status, id);
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
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      body.classList.add('drop-over');
      const { before } = dropIndex(body, e.clientX, e.clientY);
      if (before) before.classList.add('drop-before'); else body.classList.add('drop-end');
    });
    body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) { body.classList.remove('drop-over', 'drop-end'); } });
    body.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const id = dragId;
      const { before } = dropIndex(body, e.clientX, e.clientY);
      clearDropMarks();
      dragId = null;
      root.classList.remove('is-dragging');
      const status = body.dataset.status;
      const col = columnTasks(status, id); // unfiltered, so the "Needs me" filter cannot skew the position
      const k = before && before.__task ? col.findIndex((x) => x.id === before.__task.id) : -1;
      placeTask(id, status, k >= 0 ? k : col.length);
    });
  }

  /* ---------- render ---------- */
  function render() {
    if (dragId) { needsRender = true; return; }
    needsRender = false;
    renderAutoControls();
    const tasks = sel.scopedTasks();
    const byStatus = {};
    for (const t of tasks) (byStatus[t.status] ||= []).push(t);
    let needTotal = 0;
    setAttr(needsBtn, 'aria-pressed', String(onlyNeeds));
    setClass(needsBtn, 'on', onlyNeeds);
    for (const status of [...MAIN_COLUMNS, ...LANES]) {
      let list = status === 'done' ? (byStatus[status] || []).sort(cmpDone) : sortNeedsFirst(byStatus[status] || []);
      const c = cols[status];
      const nNeed = list.filter(needsOf).length;
      needTotal += nNeed;
      setHidden(c.need, nNeed === 0);
      setText(c.need, nNeed === 1 ? '1 needs you' : `${nNeed} need you`);
      if (onlyNeeds) list = list.filter(needsOf);
      const total = list.length;
      if (status === 'done' && !doneExpanded) list = list.slice(0, DONE_LIMIT);
      reconcile(c.body, list, (t) => t.id, createCard, updateCard);
      c.body.setAttribute('data-empty', onlyNeeds ? 'Nothing here needs you' : (status === 'done' ? 'Nothing done yet' : status === 'later' ? 'Park tasks here to come back to them' : status === 'blocked' ? 'Nothing is blocked' : 'Drop tasks here'));
      setText(c.count, String(total));
      if (status === 'done') {
        setHidden(c.more, total <= DONE_LIMIT);
        setText(c.more, doneExpanded ? 'Show fewer' : `Show ${total - DONE_LIMIT} more`);
      }
    }
    setHidden(needsBtnCount, needTotal === 0);
    setText(needsBtnCount, String(needTotal));
    setClass(needsBtn, 'has-items', needTotal > 0);
    // blocked lane draws attention
    if (byStatus.blocked && byStatus.blocked.length) setClass(cols.blocked.el, 'has-items', true); else setClass(cols.blocked.el, 'has-items', false);
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
    watch: ['task', 'agent', 'project', 'session', 'ui', 'ready', 'question', 'note'],
    update: render,
    setRoute() {},
    destroy() { offNew(); document.removeEventListener('keydown', onYKey); root.remove(); },
  };
}
