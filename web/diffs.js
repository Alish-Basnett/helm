// diffs.js — v0.5 "Files changed": a collapsed disclosure of one row per file (status badge, path, +a −d) that
// expands into a unified diff viewer. The diff comes from GET /v1/tasks/:id/diff, fetched lazily the first time the
// section is open, cached per task until a task upsert changes `diffStat`, and refreshable (?refresh=1). Hubs that
// predate the endpoint answer 404; the section then falls back to the plain file list.
// Everything from git ends up in text nodes (h() never parses HTML).
import { h, reconcile, setText, setHidden, setClass } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { plural } from './format.js';

const STATUS_TITLE = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', '?': 'Untracked' };
const SOURCE_LABEL = { snapshot: 'snapshot', live: 'live', history: 'approximate', none: 'no diff' };
const MINUS = '−';

/* ---------- parsing ---------- */
/**
 * Unified diff text → hunks of typed lines with old/new line numbers.
 * Anything before the first `@@` of a file (diff --git, index, ---/+++ headers, commit headers) is skipped.
 */
export function parsePatch(patch) {
  const hunks = [];
  if (!patch) return hunks;
  const lines = String(patch).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let cur = null;
  let oldN = 0, newN = 0;
  for (const raw of lines) {
    if (raw.startsWith('diff --git ') || raw.startsWith('diff --cc ')) { cur = null; continue; }
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
    if (hm) {
      oldN = Number(hm[1]); newN = Number(hm[2]);
      cur = { header: raw, ctx: hm[3] || '', lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // file header noise
    const c = raw[0];
    if (c === '+') cur.lines.push({ t: 'add', o: null, n: newN++, text: raw.slice(1) });
    else if (c === '-') cur.lines.push({ t: 'del', o: oldN++, n: null, text: raw.slice(1) });
    else if (c === '\\') cur.lines.push({ t: 'meta', o: null, n: null, text: raw.slice(1).trim() });
    else cur.lines.push({ t: 'ctx', o: oldN++, n: newN++, text: c === ' ' ? raw.slice(1) : raw });
  }
  return hunks;
}

/* ---------- rendering ---------- */
function note(text) { return h('div', { class: 'dv-note mono' }, text); }

/** The unified diff viewer for one file entry of the hub response. */
export function renderDiff(file) {
  const root = h('div', { class: 'dv' });
  if (file.binary) { root.append(note('Binary file')); return root; }
  const hunks = parsePatch(file.patch);
  if (!hunks.length) {
    root.append(note(file.truncated ? 'Diff truncated — nothing readable fits in the size cap' : 'No textual changes (mode change, rename or empty file)'));
    return root;
  }
  const lines = h('div', { class: 'dv-lines' });
  for (const hk of hunks) {
    lines.append(h('div', { class: 'dv-hunk' }, h('span', { class: 'dv-hunk-range' }, (/^@@ [^@]+@@/.exec(hk.header) || [hk.header])[0]), hk.ctx ? h('span', { class: 'dv-hunk-ctx' }, hk.ctx) : null));
    for (const l of hk.lines) {
      lines.append(h('div', { class: `dv-line k-${l.t}` },
        h('span', { class: 'dv-n', 'aria-hidden': 'true' }, l.o == null ? '' : String(l.o)),
        h('span', { class: 'dv-n', 'aria-hidden': 'true' }, l.n == null ? '' : String(l.n)),
        h('span', { class: 'dv-sign', 'aria-hidden': 'true' }, l.t === 'add' ? '+' : l.t === 'del' ? MINUS : ''),
        h('span', { class: 'dv-code' }, l.text === '' ? '​' : l.text)));
    }
  }
  root.append(h('div', { class: 'dv-scroll', tabindex: '0', role: 'region', 'aria-label': `Diff of ${file.rel || file.path}` }, lines));
  if (file.truncated) root.append(note('Truncated — this diff was cut at the size cap; open the file for the rest'));
  return root;
}

const dirOf = (f) => { const i = f.lastIndexOf('/'); return i > 0 ? f.slice(0, i + 1) : ''; };
const baseOf = (f) => f.slice(f.lastIndexOf('/') + 1);

function statNodes(a, d) {
  return [h('span', { class: 'df-add' }, `+${a}`), ' ', h('span', { class: 'df-del' }, `${MINUS}${d}`)];
}
function bar(a, d) {
  const total = a + d;
  const el = h('span', { class: 'fc-bar', 'aria-hidden': 'true' });
  const adds = total ? Math.round((5 * a) / total) : 0;
  const dels = total ? Math.min(5 - adds, Math.max(d ? 1 : 0, Math.round((5 * d) / total))) : 0;
  for (let i = 0; i < 5; i++) el.append(h('i', { class: i < adds ? 'a' : i < adds + dels ? 'd' : '' }));
  return el;
}

/* ---------- per-task cache (module level: survives the sheet being rebuilt) ---------- */
const cache = new Map(); // taskId -> { status: 'loading' | 'ok' | 'none' | 'error', data, sig, at, error, inflight }
const statEq = (x, y) => !!x && !!y && x.files === y.files && x.additions === y.additions && x.deletions === y.deletions;
const sigOf = (t) => JSON.stringify(t.diffStat || null);

/**
 * opts: { getTask(): Task | null }
 * → { el, update(task), destroy }
 */
export function createFilesChanged(opts) {
  let taskId = null;
  let open = true; // the section itself; rows inside start collapsed
  const expanded = new Set();

  const label = h('span', { class: 'fc-label' }, 'Files changed');
  const count = h('span', { class: 'panel-count mono fc-count' });
  const chev = h('span', { class: 'fc-chev-lg' }, icon('chevronDown', 14));
  const toggle = h('button', { class: 'fc-toggle', type: 'button', 'aria-expanded': 'true', onclick: () => { open = !open; apply(); if (open) ensureFetched(); } }, chev, icon('file', 14), label, count);
  const refreshBtn = h('button', { class: 'icon-btn sm fc-refresh', type: 'button', 'aria-label': 'Recompute the diff now', title: 'Recompute from the working tree', onclick: () => fetchDiff(true) }, icon('retry', 14));
  const title = h('h3', { class: 'section-title fc-title' }, toggle, refreshBtn);
  const source = h('div', { class: 'fc-source mono', hidden: true });
  const status = h('div', { class: 'fc-status mono', hidden: true, role: 'status' });
  const list = h('ul', { class: 'fc-list' });
  const plain = h('ul', { class: 'files mono fc-plain', hidden: true });
  const body = h('div', { class: 'fc-body' }, source, status, list, plain);
  const el = h('section', { class: 'sheet-section files-section', hidden: true }, title, body);

  function apply() {
    toggle.setAttribute('aria-expanded', String(open));
    setClass(el, 'collapsed', !open);
    setHidden(body, !open);
    setHidden(refreshBtn, !open);
  }

  /* ----- fetching ----- */
  function ensureFetched() {
    const t = opts.getTask();
    if (!t || !hasFiles(t)) return;
    const e = cache.get(t.id);
    if (!e) fetchDiff(false);
    else if (e.status === 'ok' && stale(e, t)) fetchDiff(false);
  }
  function stale(e, t) {
    if (e.sig === sigOf(t) || statEq(t.diffStat, e.data && e.data.totals)) return false;
    return Date.now() - e.at > 1500;
  }
  async function fetchDiff(refresh) {
    const t = opts.getTask();
    if (!t) return;
    const id = t.id;
    const prev = cache.get(id);
    if (prev && prev.inflight) return;
    const entry = { ...(prev || {}), status: 'loading', inflight: true, sig: sigOf(t), at: Date.now() };
    cache.set(id, entry);
    render();
    try {
      const data = await api.taskDiff(id, refresh);
      const cur = opts.getTask();
      cache.set(id, { status: 'ok', data: normalize(data), sig: cur && cur.id === id ? sigOf(cur) : entry.sig, at: Date.now(), inflight: false });
    } catch (e) {
      cache.set(id, e && e.status === 404
        ? { status: 'none', data: null, sig: entry.sig, at: Date.now(), inflight: false }
        : { status: 'error', data: prev && prev.data, sig: entry.sig, at: Date.now(), inflight: false, error: (e && e.message) || 'Could not load the diff' });
    }
    if (taskId === id) render();
  }
  const normalize = (d) => ({
    source: (d && d.source) || 'none', root: (d && d.root) || '', base: d && d.base,
    totals: (d && d.totals) || { files: ((d && d.files) || []).length, additions: 0, deletions: 0 },
    files: Array.isArray(d && d.files) ? d.files : [], note: d && d.note,
  });

  const hasFiles = (t) => (t.filesChanged || []).length > 0 || !!(t.diffStat && t.diffStat.files);

  /* ----- rows ----- */
  function makeItem(f) {
    const chevron = h('span', { class: 'fc-chev' }, icon('chevronRight', 13));
    const badge = h('span', { class: 'fc-badge mono' });
    const path = h('span', { class: 'fc-path mono' }, h('span', { class: 'file-dir' }), h('span', { class: 'file-name' }));
    const stat = h('span', { class: 'fc-stat mono' });
    const bars = h('span', { class: 'fc-bar-wrap' });
    const row = h('button', { class: 'fc-row', type: 'button', 'aria-expanded': 'false' }, chevron, badge, path, stat, bars);
    const diff = h('div', { class: 'fc-diff', hidden: true });
    const li = h('li', { class: 'fc-item' }, row, diff);
    li.__r = { row, badge, path, stat, bars, diff };
    row.addEventListener('click', () => {
      const f2 = li.__f;
      if (!f2) return;
      if (expanded.has(f2.path)) expanded.delete(f2.path); else expanded.add(f2.path);
      paintItem(li);
    });
    return li;
  }
  function updateItem(li, f) {
    li.__f = f;
    const r = li.__r;
    const st = STATUS_TITLE[f.status] ? f.status : '?';
    if (r.badge.textContent !== st) r.badge.textContent = st;
    r.badge.className = `fc-badge mono s-${st === '?' ? 'u' : st}`;
    r.badge.title = STATUS_TITLE[st];
    const rel = f.rel || f.path || '';
    setText(r.path.firstChild, dirOf(rel));
    setText(r.path.lastChild, baseOf(rel));
    r.row.title = f.path || rel;
    const sig = `${f.additions}|${f.deletions}|${f.binary ? 1 : 0}`;
    if (r.stat.__sig !== sig) {
      r.stat.__sig = sig;
      r.stat.textContent = '';
      if (f.binary) r.stat.append(h('span', { class: 'df-bin' }, 'binary'));
      else r.stat.append(...statNodes(f.additions || 0, f.deletions || 0));
      r.bars.textContent = '';
      if (!f.binary) r.bars.append(bar(f.additions || 0, f.deletions || 0));
    }
    paintItem(li);
  }
  function paintItem(li) {
    const f = li.__f;
    const r = li.__r;
    const on = expanded.has(f.path);
    r.row.setAttribute('aria-expanded', String(on));
    setClass(li, 'open', on);
    setHidden(r.diff, !on);
    if (on) {
      const sig = `${f.patch ? f.patch.length : 0}|${f.truncated ? 1 : 0}|${f.binary ? 1 : 0}|${(f.patch || '').slice(0, 64)}`;
      if (r.diff.__sig !== sig) { r.diff.__sig = sig; r.diff.textContent = ''; r.diff.append(renderDiff(f)); }
    }
  }

  /* ----- render ----- */
  function render() {
    const t = opts.getTask();
    if (!t) return;
    const e = cache.get(t.id);
    const ok = e && e.data && (e.status === 'ok' || e.status === 'loading' || e.status === 'error') ? e.data : null;
    const names = t.filesChanged || [];

    // label: task.diffStat, else the fetched totals, else the plain file count
    const stat = t.diffStat || (ok && ok.totals) || null;
    count.textContent = '';
    if (stat) count.append('· ', plural(stat.files, 'file'), ' ', ...statNodes(stat.additions || 0, stat.deletions || 0));
    else if (names.length) count.append('· ', plural(names.length, 'file'));
    else count.append('');

    const loading = !!(e && e.status === 'loading');
    setClass(refreshBtn, 'spinning', loading);
    refreshBtn.disabled = loading;
    refreshBtn.hidden = !open || (e && e.status === 'none');

    // source line
    if (ok) {
      source.textContent = '';
      source.append(h('span', { class: `fc-src src-${ok.source}` }, SOURCE_LABEL[ok.source] || ok.source));
      if (ok.note) source.append(h('span', { class: 'fc-src-note' }, ok.note));
    }
    setHidden(source, !ok);

    // status line
    let msg = '';
    if (!e && open && hasFiles(t)) msg = 'Loading diff…';
    else if (e && e.status === 'loading' && !ok) msg = 'Loading diff…';
    else if (e && e.status === 'error') msg = `Could not load the diff: ${e.error}`;
    setText(status, msg);
    setHidden(status, !msg);
    setClass(status, 'err', !!(e && e.status === 'error'));

    const diffFiles = ok && ok.files.length ? ok.files : null;
    setHidden(list, !diffFiles);
    if (diffFiles) reconcile(list, diffFiles, (f) => f.path, makeItem, updateItem);
    else { list.textContent = ''; list.__keyed = null; list.__rendered = false; }

    // plain list: before the diff arrives, when the hub has no diff endpoint, or when git found nothing
    const showPlain = !diffFiles && names.length > 0;
    setHidden(plain, !showPlain);
    if (showPlain) reconcile(plain, names, (f) => f, (f) => h('li', { title: f }, h('span', { class: 'file-dir' }, dirOf(f)), h('span', { class: 'file-name' }, baseOf(f))), null);
  }

  function update(task) {
    if (!task) return;
    if (taskId !== task.id) { taskId = task.id; expanded.clear(); }
    const any = hasFiles(task);
    setHidden(el, !any);
    apply();
    if (any && open) ensureFetched();
    render();
  }

  return { el, update, refresh: () => fetchDiff(true), destroy() { /* cache is module level */ } };
}
