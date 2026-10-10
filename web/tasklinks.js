// tasklinks.js — v0.5: every known `T-<n>` token becomes a small chip "T-12 · short title" with a status dot.
// Chips are built as DOM nodes (never HTML) and go through markdown.js's opt-in linkifier hook. A click opens
// that task's details + chat in the Dock, so Talk stays open. Unknown ids stay plain text.
import { h, setText } from './dom.js';
import { state, subscribe } from './store.js';
import { openTask } from './router.js';
import { truncate, STATUS_META } from './format.js';

const TOKEN = /(?<![A-Za-z0-9_])T-(\d+)(?![A-Za-z0-9_])/g;
const SHORT = 28;

const known = (id) => state.tasks.has(id) && !String(id).startsWith('tmp-');

function paint(chip, t) {
  const dot = chip.firstChild;
  const cls = `sdot st-${t.status}`;
  if (dot.className !== cls) dot.className = cls;
  const label = chip.lastChild;
  setText(label, `${t.id} · ${truncate(t.title || '', SHORT)}`);
  const st = (STATUS_META[t.status] || {}).label || t.status;
  chip.title = `${t.id} · ${t.title} (${st}) — open details and chat`;
}

/** A single chip for a known task id, or null. */
export function taskChip(id) {
  const t = state.tasks.get(id);
  if (!t || !known(id)) return null;
  const chip = h('button', { class: 'task-link', type: 'button', 'data-task': id },
    h('span', { class: 'sdot st-backlog', 'aria-hidden': 'true' }), h('span', { class: 'task-link-text' }));
  chip.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openTask(id); });
  paint(chip, t);
  return chip;
}

/** Linkifier hook for markdown.js: text → (string | Node)[], or null when nothing in it is a known task. */
export function linkifyTasks(text) {
  if (!text || text.indexOf('T-') < 0) return null;
  let out = null;
  let last = 0;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) {
    const chip = taskChip(`T-${m[1]}`);
    if (!chip) continue;
    out = out || [];
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(chip);
    last = m.index + m[0].length;
  }
  if (!out) return null;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Changes whenever a mentioned task appears/disappears, so cached markdown re-renders with chips. */
export function taskLinkSig(text) {
  if (!text || text.indexOf('T-') < 0) return '';
  const ids = [];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) { const id = `T-${m[1]}`; if (known(id)) ids.push(id); }
  return ids.join(',');
}

/** Pass as the last argument of setMarkdown / renderMarkdown to turn task ids into chips. */
export const taskLinker = { linkify: linkifyTasks, sig: taskLinkSig };

/** Plain-text variant: set `el` to `text` with chips for known tasks (no-op rewrite when unchanged). */
export function setLinked(el, text) {
  text = text == null ? '' : String(text);
  const sig = taskLinkSig(text);
  const key = text + '\u0000' + sig;
  if (el.__linked === key) return;
  el.__linked = key;
  const parts = sig ? linkifyTasks(text) : null;
  el.textContent = '';
  if (parts) el.append(...parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : p)));
  else el.textContent = text;
}

/** Keep every chip on the page in step with its task (title, status dot). */
let started = false;
export function startTaskLinks() {
  if (started) return;
  started = true;
  subscribe((changed) => {
    if (!changed.has('task')) return;
    for (const chip of document.querySelectorAll('.task-link[data-task]')) {
      const t = state.tasks.get(chip.getAttribute('data-task'));
      if (t) paint(chip, t);
    }
  });
}
startTaskLinks();
