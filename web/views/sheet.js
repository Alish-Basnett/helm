// views/sheet.js — task detail sheet (slides in from the right).
import { h, setText, setAttr, setClass, setHidden, reconcile, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, subscribe, upsert, ingestActivity, setUI } from '../store.js';
import { api } from '../api.js';
import { patchTask, quickActions, runQuickAction, startTask, canStart } from '../actions.js';
import { createStartStatus } from '../replies.js';
import { fmtTokens, fmtElapsed, fmtAgo, STATUS_META, ALL_STATUSES, agentLabel, truncate, cwdTail } from '../format.js';
import { toast, toastError, avatar, updateAvatar, modelBadge, updateModelBadge, nowDoingLine, statusDot } from '../ui.js';
import { createTimeline } from '../timeline.js';
import { createNotesPanel } from '../notes.js';
import { createReplay } from '../replay.js';
import { createExplain } from '../explain.js';
import { openTask, closeTask, navigate } from '../router.js';

const AGENT_STATUS = { running: 'Running', done: 'Done', failed: 'Failed', stalled: 'Stalled', waiting: 'Waiting for you' };

export function createSheet(root) {
  const scrim = h('div', { class: 'scrim', onclick: () => closeTask() });
  const sheet = h('aside', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Task detail', 'aria-hidden': 'true', inert: true });
  root.append(scrim, sheet);

  let taskId = null;
  let ctx = null; // per-open component refs
  let prevFocus = null;

  function destroyCtx() {
    if (!ctx) return;
    ctx.timeline = null;
    ctx.replay && ctx.replay.destroy();
    ctx.notes && ctx.notes.destroy();
    ctx = null;
    sheet.textContent = '';
  }

  /* ---------- build ---------- */
  function build(id) {
    const c = {};
    c.id = h('span', { class: 'task-id mono' }, id);
    c.pill = h('span', { class: 'status-pill' }, statusDot('backlog'), h('span', {}, ''));
    c.close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => closeTask() }, icon('close', 18));
    c.title = h('input', {
      class: 'sheet-title', type: 'text', 'aria-label': 'Task title', spellcheck: 'false',
      onblur: () => commitTitle(), onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); c.title.blur(); }
        else if (e.key === 'Escape') { e.stopPropagation(); const t = state.tasks.get(id); c.title.value = t ? t.title : ''; c.title.blur(); }
      },
    });
    c.blocked = h('div', { class: 'banner banner-red', role: 'status', hidden: true }, icon('blocked', 16), h('span', {}));
    c.startBtn = h('button', { class: 'btn btn-primary btn-sm sheet-start', type: 'button', hidden: true, title: 'Start this task in a live session', onclick: () => startTask(id) }, icon('play', 13), 'Start');
    c.startStatus = createStartStatus({ full: true });
    // status control
    c.select = h('select', { class: 'select', 'aria-label': 'Status', onchange: () => patchTask(id, { status: c.select.value }, 'Could not change status') },
      ALL_STATUSES.map((s) => h('option', { value: s }, STATUS_META[s].label)));
    c.quick = h('div', { class: 'quick-actions' });
    // agent
    c.agentWrap = h('section', { class: 'sheet-section agent-box' });
    c.avatar = avatar(null, 'lg');
    c.agentName = h('div', { class: 'agent-name' });
    c.agentModel = modelBadge('');
    c.agentStatus = h('span', { class: 'agent-status mono' });
    c.nd = nowDoingLine();
    c.agentOpen = h('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, icon('threads', 14), 'Thread');
    c.agentMeta = h('div', { class: 'agent-meta mono' });
    c.agentWrap.append(
      h('div', { class: 'agent-top' }, c.avatar,
        h('div', { class: 'agent-id' }, h('div', { class: 'agent-line' }, c.agentName, c.agentModel), c.agentStatus), c.agentOpen),
      c.nd, c.agentMeta);
    // description
    c.desc = h('div', { class: 'desc-text', tabindex: '0', role: 'button', 'aria-label': 'Edit description', onclick: () => editDesc(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editDesc(); } } });
    c.descWrap = h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, 'Description', h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Edit description', onclick: () => editDesc() }, icon('pencil', 14))), c.desc);
    // conflicts (v0.2 radar)
    c.conflictList = h('ul', { class: 'conflict-list' });
    c.conflictCount = h('span', { class: 'panel-count mono' });
    c.conflictsWrap = h('section', { class: 'sheet-section conflicts-box', hidden: true },
      h('h3', { class: 'section-title' }, icon('warning', 14), 'Conflicts', c.conflictCount), c.conflictList);
    // recap
    c.recapBody = h('div', { class: 'recap' });
    c.explain = createExplain({ getTask: () => state.tasks.get(id) || null });
    c.recapWrap = h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('sparkle', 14), 'Recap'), c.recapBody, c.explain.el);
    // files
    c.filesList = h('ul', { class: 'files mono' });
    c.filesCount = h('span', { class: 'panel-count mono' });
    c.filesWrap = h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('file', 14), 'Files changed', c.filesCount), c.filesList);
    // deps
    c.depsList = h('div', { class: 'dep-chips' });
    c.depAdd = h('select', { class: 'select select-sm', 'aria-label': 'Add dependency', onchange: () => addDep() });
    c.depsWrap = h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('link', 14), 'Dependencies'), c.depsList, c.depAdd);
    // timeline
    const allRows = () => { const t = state.tasks.get(id); return t ? sel.activityForTask(t) : []; };
    c.replay = createReplay({
      getRows: allRows,
      onChange: () => { if (!c.timeline) return; c.timeline.refresh(); if (c.replay.active) c.timeline.scrollToEnd(); },
    });
    c.timeline = createTimeline({
      getRows: () => (c.replay.active ? c.replay.visibleRows() : allRows()),
      currentId: () => c.replay.currentId(),
      empty: 'No activity yet',
    });
    c.replayBtn = h('button', {
      class: 'btn btn-quiet btn-sm replay-toggle', type: 'button', 'aria-pressed': 'false', title: 'Scrub through this task’s activity',
      onclick: () => { const on = !c.replay.active; c.replay.setActive(on); c.replayBtn.setAttribute('aria-pressed', String(on)); setClass(c.replayBtn, 'on', on); setClass(c.tlWrap, 'replaying', on); },
    }, icon('replay', 14), 'Replay');
    c.tlWrap = h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('terminal', 14), 'Activity', c.replayBtn), c.replay.el, c.timeline.el);
    // notes
    c.notes = createNotesPanel({ target: { kind: 'task', id } });

    const head = h('header', { class: 'sheet-head' },
      h('div', { class: 'sheet-head-top' }, c.id, c.pill, h('span', { class: 'spacer' }), c.startBtn, c.close),
      c.title);
    const body = h('div', { class: 'sheet-body' },
      c.blocked, c.startStatus.el,
      h('section', { class: 'sheet-section status-row' }, h('label', { class: 'field-label' }, 'Status', c.select), c.quick),
      c.agentWrap, c.conflictsWrap, c.descWrap, c.recapWrap, c.filesWrap, c.depsWrap, c.tlWrap, c.notes.el);
    sheet.append(head, body);
    return c;
  }

  /* ---------- editing ---------- */
  function commitTitle() {
    const t = state.tasks.get(taskId);
    if (!t || !ctx) return;
    const v = ctx.title.value.trim();
    if (!v) { ctx.title.value = t.title; return; }
    if (v !== t.title) patchTask(taskId, { title: v }, 'Could not rename task');
  }

  function editDesc() {
    const t = state.tasks.get(taskId);
    if (!t || !ctx || ctx.editingDesc) return;
    ctx.editingDesc = true;
    const ta = h('textarea', { class: 'desc-edit', rows: '4', 'aria-label': 'Description' });
    ta.value = t.description || '';
    const done = (save) => {
      if (!ctx || !ctx.editingDesc) return;
      ctx.editingDesc = false;
      const v = ta.value;
      wrap.remove();
      ctx.desc.hidden = false;
      if (save && v.trim() !== (t.description || '').trim()) patchTask(taskId, { description: v.trim() }, 'Could not save description');
    };
    const wrap = h('div', { class: 'desc-editor' }, ta,
      h('div', { class: 'desc-editor-actions' },
        h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => done(true) }, 'Save')));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); done(true); }
    });
    ctx.desc.hidden = true;
    ctx.desc.after(wrap);
    ta.focus();
  }

  function addDep() {
    const v = ctx.depAdd.value;
    ctx.depAdd.value = '';
    const t = state.tasks.get(taskId);
    if (!v || !t || t.dependsOn.includes(v)) return;
    patchTask(taskId, { dependsOn: [...t.dependsOn, v] }, 'Could not add dependency');
  }

  /* ---------- update ---------- */
  function update() {
    if (!ctx) return;
    const t = state.tasks.get(taskId);
    if (!t) return;
    const c = ctx;
    const agent = sel.agentOfTask(t);
    setText(c.id, t.id);
    const st = STATUS_META[t.status] || { label: t.status };
    c.pill.firstChild.className = `sdot st-${t.status}`;
    setText(c.pill.lastChild, st.label);
    if (document.activeElement !== c.title && c.title.value !== t.title) c.title.value = t.title;
    setHidden(c.blocked, !(t.status === 'blocked' && t.blockedReason));
    setText(c.blocked.lastChild, t.blockedReason || '');
    if (document.activeElement !== c.select && c.select.value !== t.status) c.select.value = t.status;

    setHidden(c.startBtn, !canStart(t));
    c.startStatus.update(t);

    // quick actions
    const acts = quickActions(t);
    reconcile(c.quick, acts, (a) => a.key,
      (a) => h('button', { class: `btn btn-quiet btn-sm qa-${a.key}`, type: 'button', onclick: () => runQuickAction(state.tasks.get(taskId), c.quick.__keyed.get(a.key).__a) }, icon(a.icon, 14), h('span', {}, a.label)),
      (el, a) => { el.__a = a; });

    // agent
    setHidden(c.agentWrap, !agent && !t.agentId);
    if (agent) {
      updateAvatar(c.avatar, agent);
      setText(c.agentName, agentLabel(agent));
      updateModelBadge(c.agentModel, agent.model);
      const running = agent.status === 'running';
      c.agentStatus.className = `agent-status mono s-${agent.status}`;
      setText(c.agentStatus, AGENT_STATUS[agent.status] || agent.status);
      c.nd.__set(agent.status === 'waiting' ? ((sel.openQuestionForAgent(agent.id) || {}).text || 'Waiting for your input') : agent.nowDoing, running);
      c.agentMeta.textContent = '';
      c.agentMeta.append(
        h('span', {}, `${agent.toolCount} tools`),
        h('span', {}, `${fmtTokens(agent.tokens || t.tokens)} tok`),
        running
          ? h('span', { 'data-since': agent.startedAt }, fmtElapsed(Date.now() - agent.startedAt))
          : h('span', {}, fmtElapsed((agent.endedAt || agent.lastActivityAt) - agent.startedAt)));
      c.agentOpen.onclick = () => navigate('threads', [agent.sessionId, agent.id]);
    } else if (t.agentId) {
      setText(c.agentName, t.agentId);
      c.nd.__set('', false);
    }

    // description
    const d = (t.description || '').trim();
    setText(c.desc, d || 'Add a description…');
    setClass(c.desc, 'placeholder', !d);

    // recap
    const r = t.recap;
    if (!r) {
      c.recapBody.textContent = '';
      c.recapBody.append(h('p', { class: 'dim' }, 'The recap — what, how, learned — appears here when the task finishes.'));
      c.recapBody.__sig = null;
    } else {
      const sig = JSON.stringify(r);
      if (c.recapBody.__sig !== sig) {
        c.recapBody.__sig = sig;
        c.recapBody.textContent = '';
        c.recapBody.append(
          recapRow('What', r.what), recapRow('How', r.how), recapRow('Learned', r.learned),
          r.concepts && r.concepts.length
            ? h('div', { class: 'tags' }, r.concepts.map((cn) => h('button', { class: 'tag', type: 'button', onclick: () => navigate('learn', [], { concept: cn }) }, icon('tag', 12), cn)))
            : null);
      }
    }

    c.explain.update();

    // conflicts
    const conflicts = t.conflicts || [];
    setHidden(c.conflictsWrap, conflicts.length === 0);
    setText(c.conflictCount, conflicts.length ? String(conflicts.length) : '');
    reconcile(c.conflictList, conflicts, (x) => `${x.path}\u0000${x.otherAgentId}`, makeConflictRow, updateConflictRow);

    // files
    const files = t.filesChanged || [];
    setHidden(c.filesWrap, files.length === 0);
    setText(c.filesCount, files.length ? String(files.length) : '');
    reconcile(c.filesList, files, (f) => f, (f) => h('li', { title: f }, h('span', { class: 'file-dir' }, dirOf(f)), h('span', { class: 'file-name' }, baseOf(f))), null);

    // deps
    const deps = t.dependsOn || [];
    reconcile(c.depsList, deps, (d2) => d2, (d2) => {
      const chip = h('span', { class: 'dep-chip' },
        h('button', { class: 'dep-open', type: 'button', onclick: () => openTask(d2) }, statusDot('backlog'), h('span', { class: 'mono dep-id' }, d2), h('span', { class: 'dep-title' })),
        h('button', { class: 'dep-x', type: 'button', 'aria-label': `Remove dependency ${d2}`, onclick: () => { const cur = state.tasks.get(taskId); if (cur) patchTask(taskId, { dependsOn: cur.dependsOn.filter((x) => x !== d2) }, 'Could not remove dependency'); } }, icon('close', 12)));
      return chip;
    }, (chip, d2) => {
      const dt = state.tasks.get(d2);
      const btn = chip.firstChild;
      btn.firstChild.className = `sdot st-${dt ? dt.status : 'backlog'}`;
      setText(btn.lastChild, dt ? truncate(dt.title, 38) : 'unknown task');
      setClass(chip, 'unmet', !!dt && dt.status !== 'done' && dt.status !== 'archived');
    });
    if (!deps.length && !c.depsList.querySelector('.dim')) { /* css :empty handles the none label */ }
    const candidates = sel.tasksOfProject(t.projectId).filter((x) => x.id !== t.id && !deps.includes(x.id) && !String(x.id).startsWith('tmp-'));
    const sig = candidates.map((x) => x.id).join(',');
    if (c.depAdd.__sig !== sig) {
      c.depAdd.__sig = sig;
      c.depAdd.textContent = '';
      c.depAdd.append(h('option', { value: '' }, 'Add dependency…'), ...candidates.map((x) => h('option', { value: x.id }, `${x.id} · ${truncate(x.title, 40)}`)));
      c.depAdd.value = '';
    }
    c.replay.refresh();
    c.timeline.refresh();
  }

  function makeConflictRow() {
    const path = h('span', { class: 'conflict-path mono' });
    const other = h('button', { class: 'conflict-other', type: 'button' }, icon('link', 12), h('span', { class: 'mono' }));
    const row = h('li', { class: 'conflict-row' }, path, h('span', { class: 'conflict-also' }, 'also edited by'), other);
    row.__r = { path, other };
    return row;
  }
  function updateConflictRow(row, x) {
    const r = row.__r;
    r.path.textContent = '';
    r.path.append(h('span', { class: 'file-dir' }, dirOf(x.path)), h('span', { class: 'file-name' }, baseOf(x.path)));
    row.title = x.path;
    const ot = x.otherTaskId ? state.tasks.get(x.otherTaskId) : null;
    setText(r.other.lastChild, x.otherTaskId ? x.otherTaskId : `agent ${truncate(String(x.otherAgentId || '').replace(/^pending:/, ''), 10)}`);
    r.other.title = ot ? `${ot.id} · ${ot.title}` : x.otherTaskId ? `Open ${x.otherTaskId}` : 'Open this agent in Threads';
    r.other.onclick = () => {
      if (x.otherTaskId) openTask(x.otherTaskId);
      else if (x.otherSessionId) { closeTask(); navigate('threads', [x.otherSessionId, x.otherAgentId]); }
    };
  }

  function recapRow(label, text) {
    return h('div', { class: 'recap-row' }, h('div', { class: 'recap-label' }, label), h('p', { class: 'recap-text' }, text || '—'));
  }
  const dirOf = (f) => { const i = f.lastIndexOf('/'); return i > 0 ? f.slice(0, i + 1) : ''; };
  const baseOf = (f) => f.slice(f.lastIndexOf('/') + 1);

  /* ---------- show/hide ---------- */
  async function load(id) {
    try {
      const res = await api.task(id);
      if (taskId !== id) return;
      if (res.task) upsert('task', res.task);
      if (res.agent) upsert('agent', res.agent);
      (res.notes || []).forEach((n) => upsert('note', n));
      if (res.activity) ingestActivity(res.activity);
    } catch (e) {
      if (taskId !== id) return;
      if (!state.tasks.get(id)) { toastError(e, `Task ${id} not found`); closeTask(); }
    }
  }

  function onKey(e) {
    if (!taskId) return;
    if (document.querySelector('.talk-sheet.open')) return; // the Talk sheet is on top and owns Esc / Tab
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.menu, .spotlight-scrim.open')) {
      e.preventDefault();
      closeTask();
    } else if (e.key === 'Tab') {
      const f = Array.from(sheet.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!sheet.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey);

  function show(id) {
    if (id === taskId) { update(); return; }
    const opening = !taskId && id;
    if (opening) prevFocus = document.activeElement;
    destroyCtx();
    taskId = id || null;
    if (!taskId) {
      sheet.classList.remove('open'); scrim.classList.remove('open');
      sheet.setAttribute('aria-hidden', 'true'); sheet.inert = true;
      if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
      prevFocus = null;
      setUI({ selectedTaskId: state.ui.selectedTaskId });
      return;
    }
    startTicker();
    setUI({ selectedTaskId: taskId });
    ctx = build(taskId);
    update();
    sheet.inert = false;
    sheet.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      sheet.classList.add('open'); scrim.classList.add('open');
      if (opening) ctx && ctx.close.focus({ preventScroll: true });
    });
    load(taskId);
  }

  const off = subscribe((changed) => {
    if (!taskId) return;
    const t = state.tasks.get(taskId);
    if (!t && state.ready && !String(taskId).startsWith('tmp-')) {
      // task disappeared (deleted) — only close if hub has no such task after load attempt
      return;
    }
    update();
  });

  return { show, update, get taskId() { return taskId; }, destroy() { off(); document.removeEventListener('keydown', onKey); } };
}
