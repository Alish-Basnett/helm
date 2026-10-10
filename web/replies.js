// replies.js — v0.3 shared bits: reply bubble, "waiting for reply…" line, and a task's Start status.
// Reply text is model output, so it only ever goes through markdown.js (DOM nodes, never HTML).
import { h, setText, setHidden, setClass } from './dom.js';
import { icon } from './icons.js';
import { state, sel } from './store.js';
import { setMarkdown } from './markdown.js';
import { taskLinker } from './tasklinks.js';
import { modelInfo, fmtAgo } from './format.js';
import { startTask } from './actions.js';

export const REPLY_WAIT_MS = 15 * 60 * 1000;
export const COLLAPSE_LINES = 8;

/** A ran note whose reply has not arrived yet (and is still inside the 15 minute window). */
export function replyPending(n, now = Date.now()) {
  if (!n || n.state !== 'ran' || n.__pending) return false;
  if (n.reply || n.repliedAt) return false;
  return now - (n.ranAt || n.queuedAt || n.createdAt || 0) < REPLY_WAIT_MS;
}
export function replyDeadline(n) { return (n.ranAt || n.queuedAt || n.createdAt || Date.now()) + REPLY_WAIT_MS; }

/** The model that most likely produced a note's reply, or '' when unknown. */
export function replyModel(n) {
  if (!n) return '';
  if (n.via === 'answer') return 'claude-haiku-5-5'; // cheap answers come from one Haiku call
  if (n.target && n.target.kind === 'task') {
    const t = state.tasks.get(n.target.id);
    const a = t && sel.agentOfTask(t);
    if (a && a.model) return a.model;
  }
  const s = state.sessions.get(n.sessionId || (n.target && n.target.kind === 'session' ? n.target.id : ''));
  return (s && s.model) || '';
}

/** Rough visual line count (long unwrapped lines count as several). */
export function visualLines(text) {
  return String(text || '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 78)), 0);
}

export const SHORT_MAX = 160;
const DONE_RE = /^\s*(?:[-*>]\s+)?(?:\*\*|__)?DONE(?:\s*:\s*(?:\*\*|__)?|(?:\*\*|__)\s*:)\s*(.+?)\s*$/i;
const BLOCK_START = /^\s*(?:#{1,6}\s|[-*+•]\s|\d{1,3}[.)]\s|```|~~~|>\s)/;

/**
 * The compact first line of a reply: the `DONE:` line's content if there is one, otherwise the first
 * sentence; at most `max` characters. `more` says whether the full reply holds anything beyond it.
 * Inline markdown (`code`, **bold**) is kept so the line renders like the full text.
 */
export function shortAnswer(reply, max = SHORT_MAX) {
  const lines = String(reply || '').replace(/\r\n?/g, '\n').split('\n');
  let short = '';
  let used = new Set();
  let cut = false;
  const di = lines.findIndex((l) => DONE_RE.test(l));
  if (di >= 0) {
    short = DONE_RE.exec(lines[di])[1].replace(/(\*\*|__)$/, '').trim();
    used.add(di);
  } else {
    let i = 0;
    let fence = false;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
      if (!fence && l.trim()) break;
    }
    if (i < lines.length) {
      const first = lines[i].replace(/^\s*(?:#{1,6}\s+|[-*+•]\s+|\d{1,3}[.)]\s+|>\s+)/, '').trim();
      const bits = [first];
      used.add(i);
      // a wrapped paragraph continues until a blank line or the next block
      if (!BLOCK_START.test(lines[i])) {
        for (let j = i + 1; j < lines.length && lines[j].trim() && !BLOCK_START.test(lines[j]); j++) { bits.push(lines[j].trim()); used.add(j); }
      }
      const para = bits.join(' ');
      const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(para);
      short = m ? m[0].trim() : para;
      if (short.length < para.length) cut = true;
    }
  }
  if (short.length > max) {
    const at = short.lastIndexOf(' ', max - 1);
    short = short.slice(0, at > max * 0.6 ? at : max - 1).replace(/[\s,;:.\-–—]+$/, '') + '…';
    cut = true;
  }
  const more = cut || lines.some((l, i) => !used.has(i) && l.trim());
  return { short, more };
}

/**
 * Indented reply bubble: "Claude" label, model, relative time, then a compact first line (DONE: content or
 * first sentence) with a "Show full" toggle that expands to the full markdown. Short replies show in full.
 */
export function createReply() {
  let open = false;
  let more = false;
  const model = h('span', { class: 'reply-model mono' });
  const when = h('span', { class: 'reply-when mono' });
  const short = h('div', { class: 'reply-short' });
  const body = h('div', { class: 'reply-body', hidden: true });
  const toggle = h('button', { class: 'link-btn reply-toggle', type: 'button', hidden: true, 'aria-expanded': 'false' }, 'Show full');
  const el = h('div', { class: 'reply-bubble', hidden: true },
    h('div', { class: 'reply-head' }, icon('sparkle', 11), h('span', { class: 'reply-who' }, 'Claude'), model, when),
    short, body, toggle);
  const apply = () => {
    const showFull = open || !more;
    setHidden(short, showFull);
    setHidden(body, !showFull);
    setHidden(toggle, !more);
    toggle.setAttribute('aria-expanded', String(open));
    setText(toggle, open ? 'Show less' : 'Show full');
  };
  toggle.addEventListener('click', () => { open = !open; apply(); });
  function update(n) {
    const has = !!(n && n.reply);
    setHidden(el, !has);
    if (!has) return;
    const sa = shortAnswer(n.reply);
    more = sa.more && !!sa.short;
    setMarkdown(short, sa.short, taskLinker);
    setMarkdown(body, n.reply, taskLinker);
    const m = replyModel(n);
    setText(model, m ? modelInfo(m).label : '');
    setHidden(model, !m);
    const at = n.repliedAt || n.ranAt || n.createdAt;
    if (at) { when.setAttribute('data-ago', at); setText(when, ''); }
    apply();
  }
  return { el, update };
}

/** Subtle shimmering "waiting for reply…" line (typing = animated dots, for chat). */
export function createWaitLine({ typing = false } = {}) {
  const el = h('div', { class: ['reply-wait', typing && 'typing'], role: 'status', hidden: true },
    typing ? h('span', { class: 'typing-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')) : null,
    h('span', { class: 'reply-wait-text' }, 'waiting for reply…'));
  function update(n) {
    const on = replyPending(n);
    setHidden(el, !on);
    if (on) el.setAttribute('data-expire', String(replyDeadline(n)));
    else el.removeAttribute('data-expire');
  }
  return { el, update };
}

/* ---------- Start status ---------- */
const HIDE_STATUS = new Set(['in_progress', 'review', 'done', 'archived']);

/** What to show for a task's start note: null | {phase:'starting'|'sent'|'failed', note, ...}. */
export function startInfo(task) {
  if (!task || !task.startNoteId || HIDE_STATUS.has(task.status)) return null;
  const id = String(task.startNoteId);
  const note = state.notes.get(id) || null;
  if (!note) return id.startsWith('tmp-') ? { phase: 'starting', note: null } : null;
  if (note.state === 'queued' || note.state === 'sending' || note.state === 'draft') return { phase: 'starting', note };
  if (note.state === 'failed') return { phase: 'failed', note, error: note.error || '' };
  return { phase: 'sent', note };
}

/**
 * Start status block for a card (compact) or the sheet (full reply bubble).
 * Starting… (shimmer) → Sent to session (+ reply when it arrives) → failed with Retry.
 */
export function createStartStatus({ full = false } = {}) {
  let taskId = null;
  const text = h('span', { class: 'ss-text' });
  const retry = h('button', { class: 'link-btn ss-retry', type: 'button', hidden: true, onclick: (e) => { e.stopPropagation(); if (taskId) startTask(taskId); } }, 'Retry');
  const line = h('div', { class: 'ss-line' }, h('span', { class: 'ss-icon' }), text, retry);
  const reply = full ? createReply() : null;
  const compact = full ? null : h('div', { class: 'ss-reply', hidden: true });
  const wait = createWaitLine();
  const el = h('div', { class: 'start-status', role: 'status', hidden: true }, line, reply ? reply.el : compact, wait.el);
  function update(task) {
    taskId = task ? task.id : null;
    const info = startInfo(task);
    setHidden(el, !info);
    if (!info) return;
    el.className = `start-status ss-${info.phase}`;
    const ic = line.firstChild;
    const want = info.phase === 'sent' ? 'checkCircle' : info.phase === 'failed' ? 'warning' : 'play';
    if (ic.__k !== want) { ic.__k = want; ic.textContent = ''; ic.append(icon(want, 13)); }
    setText(text, info.phase === 'starting' ? 'Starting…' : info.phase === 'sent' ? 'Sent to session' : `Couldn’t send${info.error ? `: ${info.error}` : ''}`);
    setHidden(retry, info.phase !== 'failed');
    const n = info.note;
    if (reply) reply.update(info.phase === 'sent' ? n : null);
    else {
      const has = info.phase === 'sent' && !!(n && n.reply);
      setHidden(compact, !has);
      if (has) setMarkdown(compact, shortAnswer(n.reply).short || n.reply, taskLinker);
    }
    wait.update(info.phase === 'sent' ? n : null);
  }
  return { el, update };
}
