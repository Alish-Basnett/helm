// taskmenu.js — the right-click / Shift+F10 menu of a task card (Board, Review queue, Today). Every item calls the same
// action the hover bar or the detail panel already uses, so there is no second code path to keep in sync.
import { openContextMenu } from './contextmenu.js';
import { state } from './store.js';
import { patchTask, setStatus, startTask, canStart, isInterrupted, quickActions, runQuickAction } from './actions.js';
import { openTask, setTaskQuery, buildHash } from './router.js';
import { toast } from './ui.js';
import { STATUS_META } from './format.js';

const MOVE_TO = ['backlog', 'next', 'in_progress', 'review', 'done', 'later'];
const MOVE_LABEL = { backlog: 'Backlog', next: 'Up next', in_progress: 'In progress', review: 'Review', done: 'Done', later: 'Later' };

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`Copied ${what}`, { duration: 1800 }); }
  catch { toast(`Could not copy ${what}`, { kind: 'error' }); }
}
const linkTo = (id) => `${location.origin}${location.pathname}${buildHash({ view: 'board', query: { task: id } })}`;

function openChat(id) {
  openTask(id);
  setTaskQuery({ task: id, chat: '1' });
  setTimeout(() => { const ta = document.querySelector('.talk-input'); if (ta) ta.focus(); }, 160);
}

/** The items for one task. Empty for a task that is still being created. */
export function taskMenuItems(task) {
  if (!task || task.__pending || String(task.id).startsWith('tmp-')) return [];
  const id = task.id;
  const resume = isInterrupted(task); // T-70: an interrupted task says Resume (startTask calls the resume endpoint itself)
  const deps = task.dependsOn || [];
  const depChoices = Array.from(state.tasks.values())
    .filter((t) => t.projectId === task.projectId && t.id !== id && !deps.includes(t.id) && t.status !== 'archived' && t.status !== 'done' && !String(t.id).startsWith('tmp-'))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 12);
  const archive = quickActions(task).find((a) => a.key === 'archive');
  return [
    { label: 'Open', icon: 'arrowRight', hint: '↵', onSelect: () => openTask(id) },
    canStart(task) && { label: resume ? 'Resume' : 'Start', icon: 'play', hint: 'S', onSelect: () => startTask(id) },
    { label: 'Chat', icon: 'chat', hint: 'C', onSelect: () => openChat(id) },
    { label: 'Add note', icon: 'note', onSelect: () => openChat(id) },
    { divider: true },
    { label: 'Move to', icon: 'board', items: MOVE_TO.map((s) => ({
      label: MOVE_LABEL[s] || (STATUS_META[s] || {}).label || s, checked: task.status === s, disabled: task.status === s,
      onSelect: () => setStatus(id, s, 'Could not move task'),
    })) },
    // The hub ignores projectId on PATCH /v1/tasks, so a task cannot change project yet; say so rather than pretend.
    { label: 'Move to project', icon: 'folder', disabled: true, sub: 'Not supported by the hub yet' },
    { label: 'Add dependency', icon: 'link', disabled: depChoices.length === 0, items: [
      { heading: 'Depends on' },
      ...depChoices.map((t) => ({ label: `${t.id} · ${t.title}`, onSelect: () => patchTask(id, { dependsOn: [...deps, t.id] }, 'Could not add dependency') })),
    ] },
    { divider: true },
    { label: 'Copy ID', icon: 'copy', onSelect: () => copy(id, id) },
    { label: 'Copy link', icon: 'link', onSelect: () => copy(linkTo(id), 'link') },
    archive && task.status !== 'archived' && { divider: true },
    archive && task.status !== 'archived' && { label: 'Archive', icon: 'archive', danger: true, onSelect: () => runQuickAction(task, archive) },
  ];
}

/** Open the menu for a task at a point. `from` is the element to give focus back to. */
export function openTaskMenu(task, { x, y, from, focusFirst = false }) {
  const items = taskMenuItems(task);
  if (!items.length) return false;
  openContextMenu({ x, y, items, restoreFocus: from, focusFirst });
  return true;
}

/**
 * Wire an element: right-click opens at the pointer, Shift+F10 / the menu key (while the element itself has focus) opens
 * beside the element. `getTask()` returns the current task row.
 */
export function bindTaskMenu(el, getTask) {
  el.addEventListener('contextmenu', (e) => {
    if (e.target.closest && e.target.closest('input, textarea, [contenteditable="true"], a[href]')) return;
    const task = getTask();
    if (!task || !taskMenuItems(task).length) return;
    e.preventDefault();
    openTaskMenu(task, { x: e.clientX, y: e.clientY, from: el });
  });
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    const task = getTask();
    if (!task) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    openTaskMenu(task, { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(36, r.height / 2), from: el, focusFirst: true });
  });
}
