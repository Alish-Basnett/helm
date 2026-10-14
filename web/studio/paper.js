// studio/paper.js — builds the printable page from blocks with DOM calls only (textContent, never innerHTML).
import { h } from '../dom.js';
import { buildDiagram } from './diagramdom.js';

const TAG = { h1: 'h1', h2: 'h2', h3: 'h3', p: 'p', quote: 'blockquote', code: 'pre' };

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
/** Text plus b/i/a marks as DOM nodes (textContent only). */
function fillInline(el, b, empty = '') {
  const text = b.text || '';
  const marks = b.type === 'code' ? [] : b.marks || [];
  if (!marks.length) { el.textContent = text || empty; return; }
  const pts = new Set([0, text.length]);
  for (const m of marks) { pts.add(m.s); pts.add(m.e); }
  const cuts = [...pts].filter((p) => p >= 0 && p <= text.length).sort((a, c) => a - c);
  for (let i = 0; i < cuts.length - 1; i++) {
    const seg = text.slice(cuts[i], cuts[i + 1]);
    if (!seg) continue;
    const act = marks.filter((m) => m.s <= cuts[i] && m.e >= cuts[i + 1]);
    let node = document.createTextNode(seg);
    const wrap = (tag, attrs) => { const w = document.createElement(tag); for (const k in attrs || {}) w.setAttribute(k, attrs[k]); w.appendChild(node); node = w; };
    if (act.some((m) => m.t === 'i')) wrap('em');
    if (act.some((m) => m.t === 'b')) wrap('strong');
    const a = act.find((m) => m.t === 'a' && SAFE_HREF.test(m.href || ''));
    if (a) wrap('a', { href: a.href, rel: 'noopener' });
    el.appendChild(node);
  }
}

/** A diagram block on the page: its drawing, or (when the source does not parse) a note with the source text. */
function diagramFigure(b) {
  const r = buildDiagram(b.text);
  const fig = h('figure', { class: 'st-diagram' });
  if (r.svg && !r.errors.length) { fig.appendChild(r.svg); return fig; }
  const why = r.errors.length ? `line ${r.errors[0].line}: ${r.errors[0].message}` : 'it is empty';
  fig.append(h('p', { class: 'st-diagram-note' }, `[diagram not drawn: ${why}]`), h('pre', null, b.text || ''));
  return fig;
}

/** Returns an element holding the document as semantic HTML: consecutive list items share one <ul>. */
export function buildPaper(blocks, cls = 'st-paper') {
  const page = h('article', { class: cls });
  let list = null;
  for (const b of blocks) {
    if (b.type === 'li') {
      if (!list) { list = h('ul'); page.appendChild(list); }
      const li = h('li'); fillInline(li, b, ' '); list.appendChild(li);
      continue;
    }
    list = null;
    if (b.type === 'diagram') { page.appendChild(diagramFigure(b)); continue; }
    const el = document.createElement(TAG[b.type] || 'p');
    fillInline(el, b);
    if (!b.text && b.type !== 'code') el.classList.add('st-blank');
    page.appendChild(el);
  }
  return page;
}
