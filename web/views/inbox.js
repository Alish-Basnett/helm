// views/inbox.js — questions inbox: what agents are asking or waiting on, plus a collapsed Answered list.
import { h, reconcile, setText, setClass, setHidden, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, lsGet, lsSet } from '../store.js';
import { dismissQuestion } from '../actions.js';
import { fmtAgo, cwdTail, truncate } from '../format.js';
import { emptyState } from '../ui.js';
import { createNotesPanel } from '../notes.js';
import { navigate, openTask } from '../router.js';

const KIND = {
  ask: { icon: 'question', label: 'Asked you' },
  waiting: { icon: 'pause', label: 'Waiting for you' },
};

export function mount(container) {
  startTicker();
  let answeredOpen = lsGet('helm.inbox.answered') === '1';
  let focusId = null;
  const panels = new Map(); // question id -> notes panel (Reply via note)

  /* ---------- structure ---------- */
  const openList = h('div', { class: 'q-list', role: 'list', 'aria-label': 'Open questions' });
  const openCount = h('span', { class: 'panel-count mono' });
  const clear = h('div', { class: 'q-clear' }, icon('checkCircle', 22), h('div', {}, h('strong', {}, 'Nothing needs you'), h('span', {}, 'When an agent asks a question or waits for input, it lands here.')));
  const answeredList = h('div', { class: 'q-list answered', role: 'list', 'aria-label': 'Answered questions' });
  const answeredCount = h('span', { class: 'panel-count mono' });
  const answeredToggle = h('button', { class: 'q-toggle', type: 'button', 'aria-expanded': String(answeredOpen), onclick: () => { answeredOpen = !answeredOpen; lsSet('helm.inbox.answered', answeredOpen ? '1' : '0'); render(); } },
    icon('chevronDown', 14, 'q-chev'), h('span', { class: 'section-title-text' }, 'Answered'), answeredCount);
  const answeredWrap = h('section', { class: 'q-section q-answered', 'aria-label': 'Answered' }, answeredToggle, answeredList);
  const empty = h('div', { class: 'view-empty' }, emptyState({
    iconName: 'inbox', title: 'Inbox is empty',
    body: 'Questions from your agents show up here — either something they asked you, or an agent that is waiting for input.',
  }));
  const choiceList = h('div', { class: 'q-list choices-waiting', role: 'list', 'aria-label': 'Choices waiting' });
  const choiceCount = h('span', { class: 'panel-count mono' });
  const choiceWrap = h('section', { class: 'q-section', 'aria-label': 'Choices waiting', hidden: true },
    h('h2', { class: 'section-title' }, icon('checklist', 14), 'Choices waiting', choiceCount), choiceList);
  const root = h('div', { class: 'inbox' },
    choiceWrap,
    h('section', { class: 'q-section' }, h('h2', { class: 'section-title' }, icon('inbox', 14), 'Needs you', openCount), openList, clear),
    answeredWrap, empty);
  container.appendChild(root);

  /* ---------- rows ---------- */
  function makeRow(q) {
    const r = {};
    r.kind = h('span', { class: 'q-kind' });
    r.label = h('span', { class: 'q-label mono' });
    r.text = h('div', { class: 'q-text' });
    r.sess = h('span', { class: 'q-sess' });
    r.task = h('button', { class: 'task-chip mono', type: 'button' });
    r.age = h('span', { class: 'q-age mono' });
    r.thread = h('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, icon('threads', 14), 'Open thread');
    r.reply = h('button', { class: 'btn btn-accent btn-sm', type: 'button', 'aria-expanded': 'false' }, icon('note', 14), 'Reply via note');
    r.dismiss = h('button', { class: 'btn btn-quiet btn-sm q-dismiss', type: 'button' }, icon('close', 14), 'Dismiss');
    r.actions = h('div', { class: 'q-actions' }, r.thread, r.reply, r.dismiss);
    r.panelSlot = h('div', { class: 'q-panel', hidden: true });
    const el = h('article', { class: 'q-row', role: 'listitem', 'data-id': q.id },
      r.kind,
      h('div', { class: 'q-main' },
        h('div', { class: 'q-head' }, r.label, r.age),
        r.text,
        h('div', { class: 'q-meta' }, r.sess, r.task),
        r.actions, r.panelSlot));
    el.__r = r;
    r.thread.addEventListener('click', () => {
      const x = el.__q;
      navigate('threads', x.agentId ? [x.sessionId, x.agentId] : [x.sessionId]);
    });
    r.task.addEventListener('click', () => el.__q.taskId && openTask(el.__q.taskId));
    r.dismiss.addEventListener('click', () => dismissQuestion(el.__q.id));
    r.reply.addEventListener('click', () => togglePanel(el));
    return el;
  }

  /* ---------- v0.6: tasks whose agent proposed choices (derived from Task.choices, not a question row) ---------- */
  function makeChoiceRow(t) {
    const r = {};
    r.text = h('div', { class: 'q-text' });
    r.meta = h('div', { class: 'q-meta' });
    r.open = h('button', { class: 'btn btn-accent btn-sm', type: 'button' }, icon('checklist', 14), 'Review choices');
    const el = h('article', { class: 'q-row k-choices', role: 'listitem', 'data-task': t.id },
      h('span', { class: 'q-kind' }, icon('checklist', 18)),
      h('div', { class: 'q-main' }, h('div', { class: 'q-head' }, h('span', { class: 'q-label mono' }, 'Choices'), (r.age = h('span', { class: 'q-age mono' }))), r.text, r.meta,
        h('div', { class: 'q-actions' }, r.open)));
    el.__r = r;
    r.open.addEventListener('click', () => openTask(el.__t.id));
    return el;
  }
  function updateChoiceRow(el, t) {
    const r = el.__r;
    el.__t = t;
    const n = sel.openChoiceCount(t);
    setText(r.text, `${t.title}`);
    setText(r.meta, `${t.id} · ${n} ${n === 1 ? 'suggestion' : 'suggestions'} to tick${state.ui.projectId === 'all' && state.projects.size > 1 ? ' · ' + sel.projectName(t.projectId) : ''}`);
    r.age.setAttribute('data-ago', t.updatedAt);
    setText(r.age, fmtAgo(t.updatedAt));
    r.open.setAttribute('aria-label', `Review ${n} choices on ${t.id}`);
  }

  function target(q) { return q.taskId && state.tasks.has(q.taskId) ? { kind: 'task', id: q.taskId } : { kind: 'session', id: q.sessionId }; }

  function togglePanel(el, force) {
    const q = el.__q, r = el.__r;
    const want = force != null ? force : !panels.has(q.id);
    if (want && !panels.has(q.id)) {
      const t = target(q);
      const panel = createNotesPanel({
        target: t, title: t.kind === 'task' ? `Notes for ${t.id}` : 'Session notes',
        placeholder: 'Reply to the agent…',
      });
      panels.set(q.id, panel);
      r.panelSlot.textContent = '';
      r.panelSlot.append(panel.el);
      setTimeout(() => panel.focus(), 0);
    } else if (!want && panels.has(q.id)) {
      panels.get(q.id).destroy();
      panels.delete(q.id);
      r.panelSlot.textContent = '';
    }
    setHidden(r.panelSlot, !panels.has(q.id));
    r.reply.setAttribute('aria-expanded', String(panels.has(q.id)));
    setClass(r.reply, 'on', panels.has(q.id));
  }

  function updateRow(el, q) {
    const r = el.__r;
    el.__q = q;
    const info = KIND[q.kind] || KIND.ask;
    const answered = q.state === 'answered';
    el.className = `q-row k-${q.kind || 'ask'}${answered ? ' answered' : ''}${focusId === q.id ? ' focus' : ''}`;
    if (r.kind.__k !== info.icon) { r.kind.__k = info.icon; r.kind.textContent = ''; r.kind.append(icon(info.icon, 18)); }
    setText(r.label, info.label);
    setText(r.text, q.text || (q.kind === 'waiting' ? 'Waiting for input' : 'Question'));
    const s = state.sessions.get(q.sessionId);
    const sessName = s ? (s.title || cwdTail(s.cwd) || s.id) : truncate(q.sessionId || 'unknown session', 16);
    const proj = s && state.ui.projectId === 'all' && state.projects.size > 1 ? ` · ${sel.projectName(s.projectId)}` : '';
    setText(r.sess, truncate(sessName, 44) + proj);
    setHidden(r.task, !q.taskId);
    if (q.taskId) {
      setText(r.task, q.taskId);
      const t = state.tasks.get(q.taskId);
      r.task.title = t ? t.title : `Open ${q.taskId}`;
    }
    const at = answered ? (q.answeredAt || q.createdAt) : q.createdAt;
    r.age.setAttribute('data-ago', at);
    r.age.setAttribute('data-ago-prefix', answered ? 'answered ' : '');
    setText(r.age, (answered ? 'answered ' : '') + fmtAgo(at));
    setHidden(r.thread, !s);
    setHidden(r.reply, answered);
    setHidden(r.dismiss, answered);
    if (answered && panels.has(q.id)) togglePanel(el, false);
  }

  function render() {
    const open = sel.openQuestions();
    const answered = sel.answeredQuestions();
    const choices = sel.choiceTasks();
    reconcile(choiceList, choices, (t) => t.id, makeChoiceRow, updateChoiceRow);
    setHidden(choiceWrap, choices.length === 0);
    setText(choiceCount, choices.length ? String(choices.length) : '');
    reconcile(openList, open, (q) => q.id, makeRow, updateRow);
    reconcile(answeredList, answered, (q) => q.id, makeRow, updateRow);
    // free panels whose row has gone
    for (const id of Array.from(panels.keys())) {
      if (!openList.__keyed.has(id) && !answeredList.__keyed.has(id)) { panels.get(id).destroy(); panels.delete(id); }
    }
    setText(openCount, open.length ? String(open.length) : '');
    setText(answeredCount, answered.length ? String(answered.length) : '');
    setHidden(answeredWrap, answered.length === 0);
    setHidden(answeredList, !answeredOpen);
    setClass(answeredWrap, 'open', answeredOpen);
    answeredToggle.setAttribute('aria-expanded', String(answeredOpen));
    setHidden(empty, !(state.ready && open.length === 0 && answered.length === 0 && choices.length === 0));
    setHidden(clear, !(state.ready && open.length === 0 && answered.length > 0 && choices.length === 0));
  }

  function focusRow(id) {
    focusId = id || null;
    if (!focusId) { render(); return; }
    const q = state.questions.get(focusId);
    if (q && q.state === 'answered' && !answeredOpen) answeredOpen = true;
    render();
    requestAnimationFrame(() => {
      const el = openList.__keyed.get(focusId) || answeredList.__keyed.get(focusId);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
    setTimeout(() => { if (focusId === id) { focusId = null; render(); } }, 2600);
  }

  render();

  return {
    watch: ['question', 'session', 'project', 'task', 'ui', 'ready'],
    update: render,
    setRoute(r) { const id = r.args[0] || null; if (id !== focusId) focusRow(id); },
    destroy() { for (const p of panels.values()) p.destroy(); panels.clear(); root.remove(); },
  };
}
