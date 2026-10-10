// timeline.js — mono activity timeline: newest at bottom, auto-scroll when pinned, type-on for fresh lines.
import { h, reconcile, setText, setClass, typeOn } from './dom.js';
import { icon } from './icons.js';
import { fmtClock } from './format.js';
import { state } from './store.js';

const CLIP = 96; // summaries longer than this (or cut by the hub with …) collapse to one line and expand on click
const NOTE_REF = /^(?:Reply to|Note) (N-\d+)/;

/** The fullest text we have for a row: the note's reply / text when the hub cut the summary, else the summary. */
function fullText(a) {
  const m = a.kind === 'note' ? NOTE_REF.exec(a.summary || '') : null;
  const n = m && state.notes.get(m[1]);
  if (n) {
    if (/^Reply to/.test(a.summary) && n.reply) return `Reply to ${n.id}: ${n.reply}`;
    if (/^Note/.test(a.summary) && n.text && n.text.length > 150) return a.summary.replace(/:\s.*$/s, '') + `: ${n.text}`;
  }
  return a.summary || '';
}
const clippable = (a) => { const t = a.summary || ''; return t.length > CLIP || /…$|\.\.\.$/.test(t) || fullText(a).length > t.length; };

const KIND_MARK = { tool: '▸', tool_done: '✓', status: '●', note: '✎', recap: '★' };

/**
 * opts.getRows(): Activity[] ascending.
 * opts.currentId?(): id of a row to highlight (used by the replay scrubber).
 */
export function createTimeline(opts) {
  const list = h('div', { class: 'tl-list', role: 'log', 'aria-live': 'off' });
  const jump = h('button', { class: 'tl-jump', type: 'button', hidden: true, onclick: () => scrollToEnd(true) }, icon('chevronDown', 14), 'Latest');
  const empty = h('div', { class: 'tl-empty mono' }, opts.empty || 'No activity yet');
  const el = h('div', { class: 'timeline' }, list, empty, jump);
  let pinned = true;
  let first = true;
  const seen = new Set();
  // Only lines that arrive live (recent timestamp) type on; history loads render instantly.
  const isLive = (a) => !first && Date.now() - (a.at || 0) < 8000;

  const atEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight < 28;
  list.addEventListener('scroll', () => { pinned = atEnd(); jump.hidden = pinned; }, { passive: true });
  function scrollToEnd(force) {
    if (pinned || force) { list.scrollTop = list.scrollHeight; pinned = true; jump.hidden = true; }
  }

  function make(a, animate) {
    const sum = h('span', { class: 'tl-sum' });
    const row = h('div', { class: ['tl-row', `k-${a.kind}`, animate && 'fresh'] },
      h('span', { class: 'tl-time' }, fmtClock(a.at)),
      h('span', { class: 'tl-mark' }, KIND_MARK[a.kind] || '·'),
      h('span', { class: 'tl-tool' }, a.tool || a.kind),
      sum,
    );
    row.__sum = sum;
    row.__text = null;
    row.__open = false;
    row.addEventListener('click', () => {
      const a = row.__row;
      if (!a || !row.classList.contains('clip') || getSelection().toString()) return;
      row.__open = !row.__open;
      paintOpen(row);
    });
    row.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && row.classList.contains('clip') && e.target === row) { e.preventDefault(); row.click(); }
    });
    return row;
  }

  function paintOpen(row) {
    const a = row.__row;
    setClass(row, 'open', row.__open);
    row.setAttribute('aria-expanded', String(row.__open));
    const t = row.__open ? fullText(a) : (a.summary || '');
    row.__text = t;
    row.__sum.textContent = t;
  }

  function update(row, a, animateFresh) {
    row.__row = a;
    setClass(row, 'ok', a.kind === 'tool_done' && a.ok === true);
    setClass(row, 'fail', a.kind === 'tool_done' && a.ok === false);
    const mark = a.kind === 'tool_done' ? (a.ok === false ? '✗' : '✓') : KIND_MARK[a.kind] || '·';
    const markEl = row.children[1];
    if (markEl.textContent !== mark) markEl.textContent = mark;
    const clip = clippable(a);
    setClass(row, 'clip', clip);
    if (clip) { row.tabIndex = 0; row.setAttribute('role', 'button'); if (!row.hasAttribute('aria-expanded')) row.setAttribute('aria-expanded', 'false'); }
    else { row.removeAttribute('tabindex'); row.removeAttribute('role'); row.removeAttribute('aria-expanded'); row.__open = false; setClass(row, 'open', false); }
    if (row.__open && clip) { const t = fullText(a); if (row.__sum.textContent !== t) row.__sum.textContent = t; row.__text = t; return; }
    const text = (a.summary || '');
    if (row.__text !== text) {
      row.__text = text;
      if (animateFresh) typeOn(row.__sum, text, () => scrollToEnd());
      else setText(row.__sum, text);
    }
  }

  function refresh() {
    const rows = (opts.getRows() || []).slice(-300);
    empty.hidden = rows.length > 0;
    list.hidden = rows.length === 0;
    const wasPinned = pinned || atEnd();
    const curId = opts.currentId ? opts.currentId() : null;
    reconcile(list, rows, (a) => a.id,
      (a, animate) => make(a, animate && isLive(a)),
      (row, a) => { const fresh = !seen.has(a.id) && isLive(a); seen.add(a.id); update(row, a, fresh); setClass(row, 'replay-cur', curId != null && a.id === curId); });
    first = false;
    if (wasPinned) { pinned = true; list.scrollTop = list.scrollHeight; }
    else jump.hidden = false;
  }
  refresh();
  return { el, refresh, scrollToEnd: () => scrollToEnd(true) };
}
