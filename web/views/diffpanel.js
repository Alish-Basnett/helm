// views/diffpanel.js — T-26 Diff panel: one changed file of the open task as a code diff, in its own Dock panel.
// Opens from a Files changed row (URL state `&diff=<rel path>`, so a refresh restores it). Header = task chip, totals,
// source badge, refresh. File tabs (a real tablist; ←/→, [ and ] switch), unified or split view (remembered), line
// numbers, syntax colours from code.js (plus tiny css/html/md lexers here), wrap toggle, copy path / patch, editor link.
// Long diffs (> CHUNK_AT rows) render in chunks as you scroll. Everything from git ends up in text nodes.
import { h, setHidden, setClass } from '../dom.js';
import { icon } from '../icons.js';
import { state, subscribe, lsGet, lsSet } from '../store.js';
import { panelClose, panelMinimise } from '../dock.js';
import { setDiff } from '../router.js';
import { toast } from '../ui.js';
import { tokenize, splitLines } from '../code.js';
import { parsePatch, onDiff, diffEntry, ensureDiff, loadDiff, statNodes, dirOf, baseOf, STATUS_TITLE, SOURCE_LABEL } from '../diffs.js';

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

async function copyText(text) {
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

export function createDiffPanel(dock) {
  let taskId = null;
  let cur = null; // rel path of the shown file
  let mode = lsGet('helm.diff.view', 'unified') === 'split' ? 'split' : 'unified';
  let wrap = lsGet('helm.diff.wrap', '1') !== '0';
  const scrollMem = new Map(); // `${rel}|${mode}` -> { top, left } for the open task
  let bodySig = '';
  let tabsSig = '';
  let focusTabNext = false;
  let tabSeq = 0;
  let body = null; // { scroller, more() } of the rendered diff

  const panel = dock.register('diff', {
    order: 0.5, width: 760, label: 'Diff', icon: 'diff', ariaLabel: 'File diff',
    onClose: () => setDiff(null),
  });

  /* ----- header ----- */
  const titleEl = h('h2', { class: 'talk-title dp-title' }, icon('diff', 16), h('span', { class: 'dp-title-text' }, 'Diff'));
  const chipId = h('span', { class: 'mono dp-chip-id' });
  const chipTitle = h('span', { class: 'dp-chip-title' });
  const chip = h('span', { class: 'task-chip dp-chip' }, chipId, chipTitle);
  const totals = h('span', { class: 'dp-totals mono' });
  const srcBadge = h('span', { class: 'fc-src mono dp-src', hidden: true });
  const srcNote = h('span', { class: 'dp-srcnote mono', hidden: true });
  const refreshBtn = h('button', { class: 'icon-btn sm dp-refresh', type: 'button', 'aria-label': 'Recompute the diff now', title: 'Recompute from the working tree', onclick: () => { const t = state.tasks.get(taskId); if (t) loadDiff(t, true); } }, icon('retry', 14));
  const head = h('header', { class: 'sheet-head dp-head' },
    h('div', { class: 'sheet-head-top' }, titleEl, h('span', { class: 'spacer' }), panelMinimise(panel, 'Minimise diff'), panelClose(panel, 'Close diff')),
    h('div', { class: 'dp-meta' }, chip),
    h('div', { class: 'dp-meta dp-meta2' }, totals, srcBadge, srcNote, h('span', { class: 'spacer' }), refreshBtn));

  /* ----- toolbar ----- */
  const segUnified = h('button', { class: 'dp-seg', type: 'button', role: 'radio', title: 'Unified view', onclick: () => setMode('unified') }, icon('rows', 14), 'Unified');
  const segSplit = h('button', { class: 'dp-seg', type: 'button', role: 'radio', title: 'Split view: old on the left, new on the right', onclick: () => setMode('split') }, icon('columns', 14), 'Split');
  const seg = h('div', { class: 'dp-segs', role: 'radiogroup', 'aria-label': 'Diff layout' }, segUnified, segSplit);
  const wrapBtn = h('button', { class: 'dp-tool', type: 'button', 'aria-pressed': 'true', title: 'Wrap long lines', onclick: () => { wrap = !wrap; lsSet('helm.diff.wrap', wrap ? '1' : '0'); bodySig = ''; render(); } }, icon('wrap', 14), h('span', { class: 'dp-tool-l' }, 'Wrap'));
  const copyPathBtn = h('button', { class: 'dp-tool', type: 'button', title: 'Copy the absolute path', onclick: () => copyOf('path') }, icon('copy', 14), h('span', { class: 'dp-tool-l' }, 'Copy path'));
  const copyDiffBtn = h('button', { class: 'dp-tool', type: 'button', title: 'Copy this file’s patch', onclick: () => copyOf('patch') }, icon('diff', 14), h('span', { class: 'dp-tool-l' }, 'Copy diff'));
  const editorLink = h('a', { class: 'dp-tool', title: 'Open in VS Code (vscode:// link, nothing leaves your machine)', target: '_self' }, icon('external', 14), h('span', { class: 'dp-tool-l' }, 'Editor'));
  const toolbar = h('div', { class: 'dp-toolbar' }, seg, h('span', { class: 'spacer' }), wrapBtn, copyPathBtn, copyDiffBtn, editorLink);

  /* ----- tabs + path + body ----- */
  const tabs = h('div', { class: 'dp-tabs', role: 'tablist', 'aria-label': 'Changed files', 'aria-orientation': 'horizontal' });
  const pathBar = h('div', { class: 'dp-pathbar mono' });
  const bodyEl = h('div', { class: 'dp-body', id: 'dp-body', role: 'tabpanel' });
  panel.el.append(head, toolbar, tabs, pathBar, bodyEl);

  /* ----- helpers ----- */
  const task = () => (taskId ? state.tasks.get(taskId) : null);
  const data = () => { const e = taskId && diffEntry(taskId); return e && e.data ? e.data : null; };
  const filesOf = () => (data() ? data().files : []);
  const fileOf = () => filesOf().find((f) => f.rel === cur || f.path === cur) || null;
  const relOf = (f) => f.rel || f.path;

  function setMode(m) {
    if (m === mode) return;
    saveScroll();
    mode = m;
    lsSet('helm.diff.view', m);
    bodySig = '';
    render();
  }
  async function copyOf(what) {
    const f = fileOf();
    if (!f) return;
    const text = what === 'path' ? (f.path || f.rel) : (f.patch || '');
    if (!text) { toast('Nothing to copy', { kind: 'error' }); return; }
    const ok = await copyText(text);
    if (ok) toast(what === 'path' ? 'Copied path' : 'Copied diff', { kind: 'success', duration: 2200 });
    else toast('Could not copy: clipboard blocked', { kind: 'error' });
  }
  function go(delta, abs) {
    const fs = filesOf();
    if (!fs.length) return;
    let i = fs.findIndex((f) => relOf(f) === cur || f.path === cur);
    i = abs === 'first' ? 0 : abs === 'last' ? fs.length - 1 : Math.min(fs.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta));
    if (relOf(fs[i]) !== cur) { saveScroll(); setDiff(relOf(fs[i])); }
  }

  /* ----- scroll memory ----- */
  const scrollKey = () => `${cur}|${mode}`;
  function saveScroll() {
    if (!body || !cur) return;
    scrollMem.set(scrollKey(), { top: body.scroller.scrollTop, left: body.scroller.scrollLeft });
  }

  /* ----- body rendering ----- */
  function note(text, cls = '') { return h('div', { class: `dp-note mono ${cls}` }, text); }

  function renderBody(f, lang) {
    const wrapper = h('div', { class: 'dp-diff' });
    if (f.binary) return { el: note('Binary file — no textual diff'), scroller: null };
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
    scroller.addEventListener('scroll', () => saveScroll());
    const out = h('div', { class: 'dp-wrapcol' }, wrapper);
    if (f.truncated) out.append(note('Truncated — this diff was cut at the size cap; open the file for the rest', 'dp-trunc'));
    return { el: out, scroller, more, hasMore: () => shown < rows.length, total: rows.length };
  }

  function paintBody() {
    const d = data();
    const e = taskId && diffEntry(taskId);
    const f = fileOf();
    let sig;
    if (f) sig = `${taskId}|${cur}|${mode}|${wrap ? 1 : 0}|${f.additions}|${f.deletions}|${f.binary ? 1 : 0}|${f.truncated ? 1 : 0}|${(f.patch || '').length}|${(f.patch || '').slice(0, 80)}`;
    else sig = `none|${e ? e.status : 'x'}|${d ? d.files.length : 0}|${e && e.error || ''}`;
    if (sig === bodySig) return;
    if (body) saveScroll();
    bodySig = sig;
    body = null;
    bodyEl.textContent = '';
    bodyEl.removeAttribute('aria-labelledby');
    bodyEl.classList.remove('wrap', 'split');
    if (!f) {
      if (!e || (e.status === 'loading' && !d)) bodyEl.append(note('Loading diff…'));
      else if (e.status === 'error') bodyEl.append(note(`Could not load the diff: ${e.error}`, 'err'), h('button', { class: 'btn btn-quiet dp-retry', type: 'button', onclick: () => { const t = task(); if (t) loadDiff(t, true); } }, 'Try again'));
      else if (e.status === 'none') bodyEl.append(note('This hub has no diff endpoint, so only file names are known.'));
      else if (d && d.files.length && cur) bodyEl.append(note(`${cur} is not in this task’s diff.`));
      else bodyEl.append(note(d && d.note ? `No diff: ${d.note}` : 'No changed files to show.'));
      return;
    }
    const lang = langOf(relOf(f));
    bodyEl.classList.toggle('wrap', wrap && mode === 'unified');
    bodyEl.classList.toggle('split', mode === 'split');
    const r = renderBody(f, lang);
    bodyEl.append(r.el);
    body = r.scroller ? r : null;
    if (body) {
      const mem = scrollMem.get(scrollKey());
      if (mem) {
        let guard = 0;
        while (body.hasMore && body.hasMore() && body.scroller.clientHeight > 0 && body.scroller.scrollHeight < mem.top + body.scroller.clientHeight && guard++ < 200) body.more();
        body.scroller.scrollTop = mem.top; body.scroller.scrollLeft = mem.left;
        if (mode === 'split') { const other = body.scroller.nextSibling; if (other) { other.scrollTop = mem.top; other.scrollLeft = mem.left; } }
      }
    }
  }

  /* ----- tabs ----- */
  function tabFor(f) {
    const rel = relOf(f);
    const st = STATUS_TITLE[f.status] ? f.status : '?';
    const t = h('button', { class: 'dp-tab', type: 'button', role: 'tab', id: `dp-tab-${++tabSeq}`, 'aria-controls': 'dp-body', 'data-rel': rel, title: f.path || rel, onclick: () => { if (rel !== cur) { saveScroll(); setDiff(rel); } } },
      h('span', { class: `fc-badge mono s-${st === '?' ? 'u' : st}`, title: STATUS_TITLE[st] }, st),
      h('span', { class: 'dp-tab-name mono' }, baseOf(rel)),
      f.binary ? h('span', { class: 'df-bin mono' }, 'bin') : h('span', { class: 'dp-tab-stat mono' }, ...statNodes(f.additions || 0, f.deletions || 0)));
    return t;
  }
  function paintTabs() {
    const fs = filesOf();
    const sig = fs.map((f) => `${relOf(f)}|${f.status}|${f.additions}|${f.deletions}|${f.binary ? 1 : 0}`).join(';');
    if (sig !== tabsSig) {
      tabsSig = sig;
      tabs.textContent = '';
      for (const f of fs) tabs.append(tabFor(f));
    }
    setHidden(tabs, fs.length === 0);
    for (const t of tabs.children) {
      const cf = fileOf();
      const on = !!cf && t.getAttribute('data-rel') === relOf(cf);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      setClass(t, 'active', on);
      if (on) { t.setAttribute('data-autofocus', ''); bodyEl.setAttribute('aria-labelledby', t.id); } else t.removeAttribute('data-autofocus');
    }
    if (!tabs.querySelector('[aria-selected="true"]') && tabs.firstChild) tabs.firstChild.tabIndex = 0;
    const act = tabs.querySelector('[aria-selected="true"]');
    if (act) {
      if (focusTabNext) { act.focus({ preventScroll: true }); }
      if (typeof act.scrollIntoView === 'function') { try { act.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* old engines */ } }
    }
    focusTabNext = false;
  }

  /* ----- header / toolbar paint ----- */
  function paintHead() {
    const t = task();
    const d = data();
    chipId.textContent = taskId || '';
    chipTitle.textContent = t ? t.title : '';
    chip.title = t ? `${taskId} · ${t.title}` : '';
    titleEl.lastChild.textContent = `Diff · ${taskId || ''}`;
    panel.setLabel(taskId ? `Diff · ${taskId}` : 'Diff');
    const stat = d ? d.totals : t && t.diffStat;
    totals.textContent = '';
    if (stat) totals.append(`${stat.files} file${stat.files === 1 ? '' : 's'} `, ...statNodes(stat.additions || 0, stat.deletions || 0));
    if (d) {
      srcBadge.textContent = SOURCE_LABEL[d.source] || d.source;
      srcBadge.className = `fc-src mono dp-src src-${d.source}`;
      srcBadge.title = d.source === 'snapshot' ? 'Frozen when the agent finished' : d.source === 'live' ? 'Computed from the working tree just now' : d.source === 'history' ? 'Approximate: no base commit was recorded' : '';
      srcNote.textContent = d.note || '';
    }
    setHidden(srcBadge, !d);
    setHidden(srcNote, !(d && d.note));
    const e = taskId && diffEntry(taskId);
    const loading = !!(e && e.status === 'loading');
    setClass(refreshBtn, 'spinning', loading);
    refreshBtn.disabled = loading;
    setHidden(refreshBtn, !!(e && e.status === 'none'));

    const f = fileOf();
    segUnified.setAttribute('aria-checked', String(mode === 'unified')); setClass(segUnified, 'on', mode === 'unified');
    segSplit.setAttribute('aria-checked', String(mode === 'split')); setClass(segSplit, 'on', mode === 'split');
    segUnified.tabIndex = mode === 'unified' ? 0 : -1; segSplit.tabIndex = mode === 'split' ? 0 : -1;
    wrapBtn.setAttribute('aria-pressed', String(wrap && mode === 'unified'));
    wrapBtn.disabled = mode === 'split';
    wrapBtn.title = mode === 'split' ? 'Split view scrolls sideways in step instead of wrapping' : 'Wrap long lines';
    copyPathBtn.disabled = !f; copyDiffBtn.disabled = !f || !f.patch;
    const abs = f && f.path && f.path.startsWith('/') ? f.path : null;
    if (abs) { editorLink.setAttribute('href', `vscode://file${encodeURI(abs)}`); editorLink.removeAttribute('aria-disabled'); }
    else { editorLink.removeAttribute('href'); editorLink.setAttribute('aria-disabled', 'true'); }
    setHidden(editorLink, !abs);

    pathBar.textContent = '';
    if (f) {
      const rel = relOf(f);
      pathBar.append(h('span', { class: 'dp-prompt', 'aria-hidden': 'true' }, '$ git diff '), h('span', { class: 'dp-path-dir' }, dirOf(rel)), h('span', { class: 'dp-path-base' }, baseOf(rel)));
      pathBar.title = f.path || rel;
    }
    setHidden(pathBar, !f);
  }

  function render() {
    if (!taskId) return;
    // a ?diff= that names no file of the loaded diff falls back to the first file
    const fs = filesOf();
    if (fs.length && !fileOf()) {
      const e = diffEntry(taskId);
      if (e && e.status !== 'loading') { setDiff(relOf(fs[0])); return; }
    }
    paintHead();
    paintTabs();
    paintBody();
  }

  /* ----- route-driven ----- */
  function show(id, rel) {
    if (!id || !rel) {
      if (panel.isMinimised) return;
      taskId = null; cur = null; tabsSig = ''; bodySig = ''; body = null;
      if (panel.isOpen) panel.close();
      return;
    }
    const changedTask = id !== taskId;
    if (changedTask) { scrollMem.clear(); tabsSig = ''; bodySig = ''; body = null; }
    taskId = id; cur = rel;
    ensureDiff(state.tasks.get(id));
    const was = panel.isOpen;
    if (!was) panel.open({ focus: state.ready, front: true });
    else if (!panel.isVisible) panel.open({ focus: false, front: true });
    render();
  }

  /* keys: ←/→ (tab strip or the panel chrome) and [ ] (anywhere inside, even over the code) switch files */
  panel.el.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const tg = e.target;
    if (tg.closest && (tg.closest('.dock-grip') || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
    const inTabs = !!(tg.closest && tg.closest('.dp-tabs'));
    const inCode = !!(tg.closest && tg.closest('.dp-scroll, .dp-pane'));
    let handled = true;
    focusTabNext = inTabs;
    if (e.key === ']' || (e.key === 'ArrowRight' && !inCode && !tg.closest('.dp-segs'))) go(1);
    else if (e.key === '[' || (e.key === 'ArrowLeft' && !inCode && !tg.closest('.dp-segs'))) go(-1);
    else if (inTabs && e.key === 'Home') go(0, 'first');
    else if (inTabs && e.key === 'End') go(0, 'last');
    else handled = false;
    if (handled) e.preventDefault(); else focusTabNext = false;
  });
  // roving radiogroup for Unified / Split
  seg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const m = mode === 'unified' ? 'split' : 'unified'; setMode(m); (m === 'split' ? segSplit : segUnified).focus(); }
  });

  const off = subscribe((changed) => {
    if (!taskId) return;
    if (changed.has('task') || changed.has('ready')) { ensureDiff(task()); paintHead(); }
  });
  const offDiff = onDiff((id) => { if (id === taskId) render(); });
  const offDock = dock.subscribe(() => { if (taskId) panel.setLabel(`Diff · ${taskId}`); });

  return { show, get taskId() { return taskId; }, get rel() { return cur; }, destroy() { off(); offDiff(); offDock(); } };
}
