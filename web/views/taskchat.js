// views/taskchat.js — v0.5 Task chat: the task's notes as a chat, in its own Dock panel (leftmost).
// It reuses Talk's chat component (bubbles by note state, replies short-first, attachments, drop and paste) pointed
// at a task target. URL state: `?task=T-n&chat=1`; the open/closed choice is remembered for the next task.
import { h, setText } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, subscribe } from '../store.js';
import { STATUS_META } from '../format.js';
import { statusDot } from '../ui.js';
import { createTalk } from './talk.js';
import { replyPending } from '../replies.js';
import { panelClose } from '../dock.js';
import { route, setChat } from '../router.js';

const bootAt = Date.now();
const seenAt = new Map(); // taskId -> when the chat was last visible

/** What the Chat button / dock tab should flag for a task: replies you have not seen, or notes still in flight. */
export function chatActivity(taskId) {
  const notes = sel.notesFor('task', taskId);
  const seen = seenAt.get(taskId) || bootAt;
  const pending = notes.some((n) => !n.__pending && (n.state === 'queued' || n.state === 'sending' || replyPending(n)));
  const unread = notes.some((n) => n.reply && (n.repliedAt || 0) > seen);
  return { pending, unread };
}

let inst = null;
/** Toggle the open task's chat (button, `c`). Closed → open + focus; open but tucked in the rail → swap in. */
export function toggleChat() { if (inst) inst.toggle(); }

export function createTaskChat(dock) {
  let taskId = null;
  let chat = null;
  let focusNext = false;

  const idEl = h('span', { class: 'task-id mono' });
  const pill = h('span', { class: 'status-pill' }, statusDot('backlog'), h('span', {}, ''));
  const title = h('div', { class: 'chat-task-title' });

  const panel = dock.register('chat', {
    order: 0, width: 400, label: 'Chat', icon: 'chat', ariaLabel: 'Task chat',
    onClose: () => setChat(false),
    onClosed: () => { markSeen(); unmount(); },
  });
  const head = h('header', { class: 'sheet-head chat-head' },
    h('div', { class: 'sheet-head-top' }, h('h2', { class: 'talk-title' }, icon('chat', 16), 'Chat'), idEl, pill, h('span', { class: 'spacer' }), panelClose(panel, 'Close chat')),
    title);
  const bodyEl = h('div', { class: 'talk-body' });
  panel.el.append(head, bodyEl);

  function markSeen() { if (taskId) seenAt.set(taskId, Date.now()); }
  function unmount() { if (chat) { chat.destroy(); chat = null; } bodyEl.textContent = ''; }
  function mount() {
    unmount();
    if (!taskId) return;
    chat = createTalk({ target: { kind: 'task', id: taskId } });
    bodyEl.append(chat.el);
    requestAnimationFrame(() => { if (chat) chat.scrollToEnd(); });
  }

  function paintHead() {
    const t = taskId && state.tasks.get(taskId);
    setText(idEl, taskId || '');
    setText(title, t ? t.title : '');
    title.title = t ? t.title : '';
    const st = t ? t.status : 'backlog';
    pill.firstChild.className = `sdot st-${st}`;
    setText(pill.lastChild, (STATUS_META[st] || { label: st }).label);
    panel.setLabel(taskId ? `Chat ${taskId}` : 'Chat');
    panel.setBadge(!!taskId && !panel.isVisible && (chatActivity(taskId).unread || chatActivity(taskId).pending));
  }

  /** Route drives it: a task id (with chat=1 in the URL) shows the panel, null hides it. */
  function show(id) {
    if (!id) { taskId = null; if (panel.isOpen) panel.close(); return; }
    const changed = id !== taskId;
    taskId = id;
    if (changed) mount();
    const wasOpen = panel.isOpen;
    if (!wasOpen) panel.open({ focus: focusNext, front: focusNext });
    else if (focusNext) panel.open({ focus: true, front: true });
    if (focusNext && chat) requestAnimationFrame(() => chat && chat.focus());
    focusNext = false;
    markSeen();
    paintHead();
  }

  function toggle() {
    const r = route();
    if (!r.task) return;
    if (panel.isOpen && panel.isVisible && r.chat) { setChat(false); return; }
    focusNext = true;
    if (panel.isOpen && r.chat) { panel.open({ focus: true, front: true }); if (chat) chat.focus(); focusNext = false; return; }
    setChat(true);
  }
  inst = { toggle };

  const off = subscribe((changed) => {
    if (!taskId) return;
    if (changed.has('task') || changed.has('note') || changed.has('ready')) {
      if (panel.isVisible) markSeen();
      paintHead();
    }
  });
  const offDock = dock.subscribe(() => { if (taskId) { if (panel.isVisible) markSeen(); paintHead(); } });

  return { show, toggle, get taskId() { return taskId; }, destroy() { off(); offDock(); inst = null; } };
}
