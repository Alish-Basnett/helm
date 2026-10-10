// views/board.js — kanban: 5 columns + collapsible Later/Blocked lanes, drag & drop, inline composer.
import { h, reconcile, setText, setClass, setHidden, setAttr, bus, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, lsGet, lsSet, setUI } from '../store.js';
import { patchTask, createTask, quickActions, runQuickAction } from '../actions.js';
import { fmtElapsed, fmtTokens, truncate, agentLabel, STATUS_META, MAIN_COLUMNS, LANES, plural } from '../format.js';
import { avatar, updateAvatar, modelBadge, updateModelBadge, nowDoingLine, statusDot, toast } from '../ui.js';
import { openTask, navigate } from '../router.js';

const DONE_LIMIT = 30;
const cmp = (a, b) => (a.order - b.order) || (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id));
const cmpDone = (a, b) => (b.doneAt || b.updatedAt || 0) - (a.doneAt || a.updatedAt || 0);

export function mount(container) {
  let composerCol = null;
  let dragId = null;
  let needsRender = false;
  let doneExpanded = false;
  const cols = {}; // status -> {el, body, count, composer, ...}

  startTicker();

  /* ---------- structure ---------- */
  const banner = h('div', { class: 'board-banner', hidden: true });
  const colsEl = h('div', { class: 'board-cols' });
  const lanesEl = h('div', { class: 'board-lanes' });
  const root = h('div', { class: 'board' }, banner, colsEl, lanesEl);
  container.appendChild(root);

  for (const status of MAIN_COLUMNS) colsEl.appendChild(buildColumn(status));
  for (const status of LANES) lanesEl.appendChild(buildLane(status));

  function buildColumn(status) {
    const meta = STATUS_META[status];
    const count = h('span', { class: 'col-count mono' }, '0');
    const addBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': `Add task to ${meta.label}`, title: `Add to ${meta.label}`, onclick: () => openComposer(status) }, icon('plus', 16));
    const body = h('div', { class: 'col-body', 'data-status': status, 'data-layout': 'v', 'data-empty': status === 'done' ? 'Nothing done yet' : 'Drop tasks here' });
    const more = h('button', { class: 'col-more', type: 'button', hidden: true, onclick: () => { doneExpanded = !doneExpanded; render(); } });
    const composer = buildComposer(status);
    const el = h('section', { class: `col col-${status}`, 'aria-label': meta.label },
      h('header', { class: 'col-head' }, statusDot(status), h('h3', { class: 'col-title' }, meta.label), count, h('span', { class: 'spacer' }), addBtn),
      composer.el, body, more);
    wireDrop(body);
    cols[status] = { el, body, count, composer, more };
    return el;
  }

  function buildLane(status) {
    const meta = STATUS_META[status];
    const key = `helm.lane.${status}`;
    const count = h('span', { class: 'col-count mono' }, '0');
    const body = h('div', { class: 'lane-body', 'data-status': status, 'data-layout': 'grid', 'data-empty': status === 'later' ? 'Park tasks here to come back to them' : 'Nothing is blocked' });
    const toggle = h('button', { class: 'lane-toggle', type: 'button', 'aria-expanded': 'true' },
      icon('chevronDown', 14, 'lane-chev'), statusDot(status), h('span', { class: 'col-title' }, meta.label), count);
    const el = h('section', { class: `lane lane-${status}`, 'aria-label': meta.label }, toggle, body);
    const apply = (open) => { setClass(el, 'collapsed', !open); toggle.setAttribute('aria-expanded', String(open)); };
    let open = lsGet(key) !== '0';
    apply(open);
    toggle.addEventListener('click', () => { open = !open; lsSet(key, open ? '1' : '0'); apply(open); });
    wireDrop(body);
    cols[status] = { el, body, count, toggle, forceOpen: () => { if (!open) { open = true; apply(true); } }, isOpen: () => open, apply };
    return el;
  }

  function buildComposer(status) {
    const input = h('input', { class: 'composer-input', type: 'text', placeholder: 'New task title…', 'aria-label': `New task title for ${STATUS_META[status].label}`, autocomplete: 'off' });
    const proj = h('select', { class: 'select select-sm', 'aria-label': 'Project' });
    const add = h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Add');
    const cancel = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => closeComposer() }, 'Done');
    const el = h('form', { class: 'composer', hidden: true, onsubmit: async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      const projectId = proj.hidden ? defaultProject() : proj.value;
      if (!projectId) { toast('Create a project first', { kind: 'error' }); navigate('projects'); return; }
      if (!proj.hidden) lsSet('helm.composer.project', projectId);
      input.value = '';
      input.focus();
      await createTask({ projectId, title, status });
    } }, input, h('div', { class: 'composer-row' }, proj, h('span', { class: 'spacer' }), cancel, add));
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeComposer(); } });
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
  function createCard(t) {
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
    r.actions = h('div', { class: 'card-actions' });
    const el = h('article', { class: 'card', tabindex: '0', draggable: 'true', 'data-id': t.id, role: 'group' },
      r.actions, r.title, h('div', { class: 'card-sub' }, r.id, r.proj, r.conflict), r.agent, r.blocked, r.meta);
    el.__r = r;
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
    setAttr(el, 'aria-label', `${t.id} ${t.title}`);
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
    const acts = t.__pending ? [] : quickActions(t);
    reconcile(r.actions, acts, (a) => a.key, (a) => {
      const b = h('button', { class: `qa qa-${a.key}`, type: 'button', title: a.label, 'aria-label': `${a.label} ${t.id}`,
        onclick: (e) => { e.stopPropagation(); runQuickAction(el.__task, b.__a); } }, icon(a.icon, 15));
      return b;
    }, (b, a) => { b.__a = a; });
  }

  function onCardKey(e, el) {
    const t = el.__task;
    if (e.target !== el) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(t.id); return; }
    if (!e.altKey) return;
    const idx = MAIN_COLUMNS.indexOf(t.status);
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && idx >= 0) {
      const next = MAIN_COLUMNS[idx + (e.key === 'ArrowRight' ? 1 : -1)];
      if (next) { e.preventDefault(); placeTask(t.id, next, columnTasks(next, t.id).length).then(() => refocus(t.id)); }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const list = columnTasks(t.status, null);
      const i = list.findIndex((x) => x.id === t.id);
      const j = i + (e.key === 'ArrowDown' ? 1 : -1);
      if (i < 0 || j < 0 || j >= list.length) return;
      // index within the list excluding self
      placeTask(t.id, t.status, j).then(() => refocus(t.id));
    }
  }
  function refocus(id) {
    requestAnimationFrame(() => { const el = root.querySelector(`.card[data-id="${CSS.escape(id)}"]`); el && el.focus({ preventScroll: false }); });
  }

  /* ---------- ordering + dnd ---------- */
  function columnTasks(status, excludeId) {
    const list = sel.scopedTasks().filter((t) => t.status === status && t.id !== excludeId);
    return list.sort(status === 'done' ? cmpDone : cmp);
  }

  async function placeTask(id, status, index) {
    const t = state.tasks.get(id);
    if (!t) return;
    if (status === 'done') { // done column is ordered by completion time, so only the status changes
      if (t.status !== status) await patchTask(id, { status }, 'Could not move task');
      return;
    }
    const col = columnTasks(status, id);
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
      const { index } = dropIndex(body, e.clientX, e.clientY);
      clearDropMarks();
      dragId = null;
      root.classList.remove('is-dragging');
      const status = body.dataset.status;
      placeTask(id, status, index);
    });
  }

  /* ---------- render ---------- */
  function render() {
    if (dragId) { needsRender = true; return; }
    needsRender = false;
    const tasks = sel.scopedTasks();
    const byStatus = {};
    for (const t of tasks) (byStatus[t.status] ||= []).push(t);
    for (const status of [...MAIN_COLUMNS, ...LANES]) {
      let list = (byStatus[status] || []).sort(status === 'done' ? cmpDone : cmp);
      const c = cols[status];
      const total = list.length;
      if (status === 'done' && !doneExpanded) list = list.slice(0, DONE_LIMIT);
      reconcile(c.body, list, (t) => t.id, createCard, updateCard);
      setText(c.count, String(total));
      if (status === 'done') {
        setHidden(c.more, total <= DONE_LIMIT);
        setText(c.more, doneExpanded ? 'Show fewer' : `Show ${total - DONE_LIMIT} more`);
      }
    }
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

  const offNew = bus.on('new-task', () => openComposer('backlog'));
  render();
  if (state.ui.pendingNewTask) { setUI({ pendingNewTask: false }); openComposer('backlog'); }

  return {
    watch: ['task', 'agent', 'project', 'session', 'ui', 'ready', 'question'],
    update: render,
    setRoute() {},
    destroy() { offNew(); root.remove(); },
  };
}
