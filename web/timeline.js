// timeline.js — mono activity timeline: newest at bottom, auto-scroll when pinned, type-on for fresh lines.
import { h, reconcile, setText, setClass, typeOn } from './dom.js';
import { icon } from './icons.js';
import { fmtClock } from './format.js';

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
    return row;
  }

  function update(row, a, animateFresh) {
    row.__row = a;
    setClass(row, 'ok', a.kind === 'tool_done' && a.ok === true);
    setClass(row, 'fail', a.kind === 'tool_done' && a.ok === false);
    const mark = a.kind === 'tool_done' ? (a.ok === false ? '✗' : '✓') : KIND_MARK[a.kind] || '·';
    const markEl = row.children[1];
    if (markEl.textContent !== mark) markEl.textContent = mark;
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
