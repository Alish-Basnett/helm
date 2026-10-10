// diffview.js — the diff viewer's rendering core, shared by the Diff panel (views/diffpanel.js) and the Review queue
// (views/review.js): language by extension, tiny lexers, syntax-coloured hunks, unified/split row models, copy helper and
// `renderDiffBody` (one file → scroller element; long diffs render in chunks as you scroll). No panel, no store: pure DOM.
// Everything from git ends up in text nodes.
import { h, setHidden } from './dom.js';
import { tokenize, splitLines } from './code.js';
import { parsePatch } from './diffs.js';

const MINUS = '−';
const CHUNK = 500; // rows per chunk once a diff is long
const CHUNK_AT = 3000; // rows above which rendering is chunked

/* ---------- language by extension ---------- */
const EXT = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', json: 'js', ts: 'ts', tsx: 'ts', py: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', css: 'css', html: 'html', htm: 'html', md: 'md', markdown: 'md' };
export function langOf(rel) {
  const m = /\.([A-Za-z0-9]+)$/.exec(rel || '');
  return (m && EXT[m[1].toLowerCase()]) || null;
}

/** Tiny lexers for the languages code.js does not know. Same token shape: { c, v } with classes k s c n f t v p i. */
function lexLite(lang, src) {
  const out = [];
  const push = (c, v) => { if (v) out.push({ c, v }); };
  if (lang === 'css') {
    const re = /\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|#[0-9a-fA-F]{3,8}\b|-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|%|vh|vw|ms|s|deg|fr|ch)?\b|@[\w-]+|--?[A-Za-z][\w-]*(?=\s*:)|[\w-]+(?=\()|[.#][A-Za-z_][\w-]*/g;
    let i = 0, m;
    while ((m = re.exec(src))) {
      push('i', src.slice(i, m.index));
      const v = m[0], c0 = v[0];
      push(c0 === '/' ? 'c' : c0 === '"' || c0 === "'" ? 's' : c0 === '@' ? 'k' : c0 === '#' && /^#[0-9a-fA-F]{3,8}$/.test(v) ? 'n' : /^[.#]/.test(v) ? 't' : /^-?[\d.]/.test(v) ? 'n' : /\($/.test(src.slice(m.index + v.length, m.index + v.length + 1)) ? 'f' : 't', v);
      i = m.index + v.length;
    }
    push('i', src.slice(i));
  } else if (lang === 'html') {
    const re = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][\w:-]*|\/?>|"[^"\n]*"?|'[^'\n]*'?|[\w:@.-]+(?==)/g;
    let i = 0, m, inTag = false;
    while ((m = re.exec(src))) {
      const v = m[0];
      const isTagOpen = v[0] === '<' && v[1] !== '!';
      if (!inTag && !isTagOpen && v[0] !== '<') { continue; } // quotes / attr-ish words outside a tag are text
      push('i', src.slice(i, m.index));
      if (v[0] === '<' && v[1] === '!') push('c', v);
      else if (isTagOpen) { push('k', v); inTag = true; }
      else if (v === '>' || v === '/>') { push('k', v); inTag = false; }
      else if (v[0] === '"' || v[0] === "'") push('s', v);
      else push('t', v);
      i = m.index + v.length;
    }
    push('i', src.slice(i));
  } else if (lang === 'md') {
    let fence = false;
    const lines = src.split('\n');
    lines.forEach((ln, k) => {
      if (k) push('i', '\n');
      if (/^\s*(```|~~~)/.test(ln)) { fence = !fence; push('c', ln); return; }
      if (fence) { push('s', ln); return; }
      if (/^#{1,6}\s/.test(ln)) { push('k', ln); return; }
      if (/^\s*>/.test(ln)) { push('c', ln); return; }
      const lead = /^(\s*(?:[-*+]|\d+\.)\s+)/.exec(ln);
      let rest = ln;
      if (lead) { push('p', lead[1]); rest = ln.slice(lead[1].length); }
      const re = /`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]*\)/g;
      let i = 0, m;
      while ((m = re.exec(rest))) {
        push('i', rest.slice(i, m.index));
        push(m[0][0] === '`' ? 's' : m[0][0] === '*' ? 't' : 'f', m[0]);
        i = m.index + m[0].length;
      }
      push('i', rest.slice(i));
    });
  } else push('i', src);
  return out;
}
const lexLines = (lang, text) => (lang === 'css' || lang === 'html' || lang === 'md' ? splitLines(lexLite(lang, text)) : splitLines(tokenize(text, lang)));

/** Highlight a hunk with context: tokenise the new side (ctx + add) and the old side (ctx + del) as two snippets. */
function hunkTokens(hk, lang) {
  if (hk.tok !== undefined) return hk.tok;
  hk.tok = null;
  if (!lang) return null;
  try {
    const newL = hk.lines.filter((l) => l.t === 'ctx' || l.t === 'add');
    const oldL = hk.lines.filter((l) => l.t === 'ctx' || l.t === 'del');
    const nt = lexLines(lang, newL.map((l) => l.text).join('\n'));
    const ot = lexLines(lang, oldL.map((l) => l.text).join('\n'));
    const map = new Map();
    newL.forEach((l, i) => map.set(l, nt[i] || []));
    oldL.forEach((l, i) => { if (l.t === 'del') map.set(l, ot[i] || []); });
    hk.tok = map;
  } catch { hk.tok = null; }
  return hk.tok;
}
function codeNodes(l, hk, lang) {
  if (l.text === '') return ['​'];
  const map = lang ? hunkTokens(hk, lang) : null;
  const toks = map && map.get(l);
  if (!toks || !toks.length) return [l.text];
  return toks.map((t) => (t.c === 'i' || t.c === 'w' ? t.v : h('span', { class: `cm-${t.c}` }, t.v)));
}

/* ---------- row models ---------- */
function unifiedRows(hunks) {
  const rows = [];
  for (const hk of hunks) {
    rows.push({ k: 'hunk', hk });
    for (const l of hk.lines) rows.push({ k: 'line', hk, l });
  }
  return rows;
}
/** Pair deletions with the additions that follow them; the shorter side gets blank fillers. */
function splitRows(hunks) {
  const rows = [];
  for (const hk of hunks) {
    rows.push({ k: 'hunk', hk });
    const ls = hk.lines;
    let i = 0;
    while (i < ls.length) {
      const l = ls[i];
      if (l.t === 'ctx') { rows.push({ k: 'pair', hk, a: l, b: l }); i++; continue; }
      if (l.t === 'meta') { rows.push({ k: 'meta', hk, l }); i++; continue; }
      const dels = [], adds = [];
      while (i < ls.length && ls[i].t === 'del') dels.push(ls[i++]);
      while (i < ls.length && ls[i].t === 'add') adds.push(ls[i++]);
      if (!dels.length && !adds.length) { i++; continue; }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) rows.push({ k: 'pair', hk, a: dels[k] || null, b: adds[k] || null, block: true });
    }
  }
  return rows;
}
const hunkRange = (hk) => (/^@@ [^@]+@@/.exec(hk.header) || [hk.header])[0];

export async function copyText(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through to the legacy path */ }
  try {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0', pointerEvents: 'none' }, 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch { return false; }
}

export function dvNote(text, cls = '') { return h('div', { class: `dp-note mono ${cls}` }, text); }
const relOf = (f) => f.rel || f.path;

/**
 * One file of the hub's diff response → { el, scroller, more, hasMore, total }. `mode` is 'unified' or 'split'.
 * `scroller` is null for binary / empty diffs (el is then a plain note).
 */
export function renderDiffBody(f, lang, mode, onScroll) {
  const wrapper = h('div', { class: 'dp-diff' });
  if (f.binary) return { el: dvNote('Binary file — no textual diff'), scroller: null };
  const hunks = parsePatch(f.patch);
  if (!hunks.length) {
    return { el: note(f.truncated ? 'Diff truncated — nothing readable fits in the size cap' : 'No textual changes (mode change, rename or empty file)'), scroller: null };
  }
  const rows = mode === 'split' ? splitRows(hunks) : unifiedRows(hunks);
  const chunked = rows.length > CHUNK_AT;
  let shown = 0;
  let scroller, left, right, lines, moreBtn;

  const unifiedRow = (r) => {
    if (r.k === 'hunk') return h('div', { class: 'dp-hunk' }, h('span', { class: 'dp-hunk-range' }, hunkRange(r.hk)), r.hk.ctx ? h('span', { class: 'dp-hunk-ctx' }, r.hk.ctx) : null);
    const l = r.l;
    return h('div', { class: `dp-row k-${l.t}` },
      h('span', { class: 'dp-n', 'aria-hidden': 'true' }, l.o == null ? '' : String(l.o)),
      h('span', { class: 'dp-n', 'aria-hidden': 'true' }, l.n == null ? '' : String(l.n)),
      h('span', { class: 'dp-sign', 'aria-hidden': 'true' }, l.t === 'add' ? '+' : l.t === 'del' ? MINUS : ''),
      h('span', { class: 'dp-code' }, ...codeNodes(l, r.hk, lang)));
  };
  const cell = (l, side, r) => {
    if (!l) return h('div', { class: 'dp-row dp-fill' }, h('span', { class: 'dp-n' }), h('span', { class: 'dp-sign' }), h('span', { class: 'dp-code' }, '​'));
    const num = side === 'a' ? l.o : l.n;
    const kind = l.t === 'ctx' ? 'k-ctx' : side === 'a' ? 'k-del' : 'k-add';
    return h('div', { class: `dp-row ${kind}` },
      h('span', { class: 'dp-n', 'aria-hidden': 'true' }, num == null ? '' : String(num)),
      h('span', { class: 'dp-sign', 'aria-hidden': 'true' }, kind === 'k-add' ? '+' : kind === 'k-del' ? MINUS : ''),
      h('span', { class: 'dp-code' }, ...codeNodes(l, r.hk, lang)));
  };
  const splitPair = (r) => {
    if (r.k === 'hunk') {
      const a = h('div', { class: 'dp-hunk' }, h('span', { class: 'dp-hunk-range' }, hunkRange(r.hk)));
      const b = h('div', { class: 'dp-hunk' }, r.hk.ctx ? h('span', { class: 'dp-hunk-ctx' }, r.hk.ctx) : '​');
      return [a, b];
    }
    if (r.k === 'meta') return [h('div', { class: 'dp-row k-meta' }, h('span', { class: 'dp-n' }), h('span', { class: 'dp-sign' }), h('span', { class: 'dp-code' }, r.l.text)), cell(null, 'b', r)];
    return [cell(r.a, 'a', r), cell(r.b, 'b', r)];
  };

  const appendChunk = () => {
    const end = chunked ? Math.min(rows.length, shown + CHUNK) : rows.length;
    if (mode === 'split') {
      const fa = document.createDocumentFragment(), fb = document.createDocumentFragment();
      for (let i = shown; i < end; i++) { const [a, b] = splitPair(rows[i]); fa.append(a); fb.append(b); }
      left.firstChild.append(fa); right.firstChild.append(fb);
    } else {
      const frag = document.createDocumentFragment();
      for (let i = shown; i < end; i++) frag.append(unifiedRow(rows[i]));
      lines.append(frag);
    }
    shown = end;
    if (moreBtn) {
      setHidden(moreBtn, shown >= rows.length);
      moreBtn.textContent = `Show ${Math.min(CHUNK, rows.length - shown).toLocaleString()} more lines (${(rows.length - shown).toLocaleString()} left)`;
    }
  };
  const more = () => { if (shown < rows.length) appendChunk(); };

  if (mode === 'split') {
    left = h('div', { class: 'dp-pane dp-pane-a', tabindex: '0', role: 'region', 'aria-label': `Old version of ${relOf(f)}` }, h('div', { class: 'dp-lines' }));
    right = h('div', { class: 'dp-pane dp-pane-b', tabindex: '0', role: 'region', 'aria-label': `New version of ${relOf(f)}` }, h('div', { class: 'dp-lines' }));
    let lock = false;
    const mirror = (from, to) => () => {
      if (lock) return;
      lock = true;
      to.scrollTop = from.scrollTop; to.scrollLeft = from.scrollLeft;
      requestAnimationFrame ? requestAnimationFrame(() => { lock = false; }) : (lock = false);
    };
    left.addEventListener('scroll', mirror(left, right));
    right.addEventListener('scroll', mirror(right, left));
    scroller = left;
    wrapper.classList.add('is-split');
    wrapper.append(left, right);
  } else {
    lines = h('div', { class: 'dp-lines' });
    scroller = h('div', { class: 'dp-scroll', tabindex: '0', role: 'region', 'aria-label': `Diff of ${relOf(f)}` }, lines);
    wrapper.append(scroller);
  }
  if (chunked) {
    moreBtn = h('button', { class: 'dp-more mono', type: 'button', onclick: more });
    wrapper.append(moreBtn);
    const near = (el) => { if (el.scrollTop + el.clientHeight > el.scrollHeight - 600) more(); };
    scroller.addEventListener('scroll', () => near(scroller));
    if (right) right.addEventListener('scroll', () => near(right));
  }
  appendChunk();
  if (onScroll) scroller.addEventListener('scroll', () => onScroll(scroller));
  const out = h('div', { class: 'dp-wrapcol' }, wrapper);
  if (f.truncated) out.append(dvNote('Truncated — this diff was cut at the size cap; open the file for the rest', 'dp-trunc'));
  return { el: out, scroller, more, hasMore: () => shown < rows.length, total: rows.length };
}
