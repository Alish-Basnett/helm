// studio/pill.js — the floating Studio pill: the current document as a draggable A4 preview that follows you around Helm.
// It reuses floating.js (window) and shelf.js (minimised chip). Data comes from two places: a live snapshot the Studio screen
// broadcasts while it is open (bus 'studio-live', so typing shows at once), and the store/SSE doc + job rows otherwise.
// Everything is built with DOM calls (textContent); document text never goes through innerHTML.
import { h, bus, setText } from '../dom.js';
import { icon } from '../icons.js';
import { state, subscribe } from '../store.js';
import { toast, toastError } from '../ui.js';
import { navigate } from '../router.js';
import { createFloating, loadFloat, saveFloat } from '../floating.js';
import { studioStore } from './store.js';
import { buildPaper } from './paper.js';
import { jobActive, docJobs } from './sync.js';
import { pillStatus, applicableCount, shortTitle, cleanPillState, paperScale } from './pillmodel.js';

const KEY = 'helm.studio.pill';

export function createStudioPill() {
  const saved = cleanPillState(loadFloat(KEY));
  let docId = saved.docId;
  let doc = null;         // { id, title, version }
  let blocks = [];
  let comments = [];
  let dirty = false;
  let open = false;       // the window is showing
  let minimised = saved.minimised;
  let fetching = false;
  let fetchTimer = 0;
  let staleTimer = 0;
  let paintTimer = 0;
  let live = false;       // the last data came from the Studio screen's snapshot

  /* ---------- window ---------- */
  const dot = h('span', { class: 'sp-dot', 'aria-hidden': 'true' });
  const titleEl = h('span', { class: 'sp-title' }, 'Studio');
  const statusEl = h('span', { class: 'sp-status', role: 'status', 'aria-live': 'polite' }, '');
  const minBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Minimise to the shelf', title: 'Minimise to the shelf', onclick: () => bus.emit('shelf-minimise', 'studio') }, icon('minimize', 18));
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close the Studio pill', title: 'Close', onclick: () => dismiss() }, icon('close', 16));
  const head = h('header', { class: 'sp-head', 'data-float-drag': '' },
    dot, h('div', { class: 'sp-headtext' }, titleEl, statusEl), minBtn, closeBtn);

  const paperHost = h('div', { class: 'sp-paper' });
  const note = h('p', { class: 'sp-note', hidden: true });
  const scroller = h('div', { class: 'sp-scroll' }, note, paperHost);
  const applyBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: true, onclick: () => applyAll() }, 'Apply all');
  const editLink = h('a', { class: 'btn btn-sm sp-link', href: '#/studio', onclick: (e) => { e.preventDefault(); if (docId) navigate('studio', [docId]); } }, icon('external', 13), 'Open in Studio');
  const foot = h('footer', { class: 'sp-foot' }, editLink, h('span', { class: 'spacer' }), applyBtn);

  let win = null;
  function ensureWin() {
    if (win) return win;
    win = createFloating({
      storeKey: KEY, label: 'Studio', ariaLabel: 'Studio document preview (floating window)', className: 'float-studio',
      defaultRect: ({ vw }) => ({ w: 440, h: 600, x: Math.max(16, vw - 480), y: 72 }),
    });
    win.body.append(head, scroller, foot);
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => scalePaper()).observe(scroller);
    return win;
  }

  /* ---------- painting ---------- */
  const status = () => pillStatus({ doc, comments, jobs: state.jobs, dirty });
  const openCount = () => applicableCount(comments);
  function scalePaper() {
    const p = paperHost.firstChild;
    if (p) p.style.zoom = String(paperScale(scroller.clientWidth));
  }
  function paintMeta() {
    const s = status();
    const n = openCount();
    setText(titleEl, doc ? doc.title || 'Untitled' : 'Studio');
    setText(statusEl, doc ? `${s.label}${n ? ` · ${n} open comment${n === 1 ? '' : 's'}` : ''}` : '');
    dot.dataset.kind = s.kind;
    const queued = comments.some((c) => c.state === 'queued');
    applyBtn.textContent = n ? `Apply all (${n})` : 'Apply all';
    applyBtn.disabled = !n || queued || dirty || s.kind === 'drafting';
    editLink.setAttribute('href', docId ? `#/studio/${docId}` : '#/studio');
    api.onChange && api.onChange();
  }
  function paintPaper() {
    paperHost.textContent = '';
    if (!doc) { note.hidden = false; setText(note, fetching ? 'Loading…' : 'This document is not available.'); return; }
    const empty = !blocks.length;
    note.hidden = !empty;
    if (empty) setText(note, status().kind === 'drafting' ? 'Sonnet is writing the first draft…' : 'This document is empty.');
    paperHost.appendChild(buildPaper(blocks, 'st-paper st-pill-paper'));
    scalePaper();
  }
  // Re-rendering on every keystroke event would rebuild the page needlessly: coalesce to one paint per ~120 ms.
  function schedulePaint() {
    if (paintTimer) return;
    paintTimer = setTimeout(() => { paintTimer = 0; paintMeta(); if (open || win && win.isVisible) paintPaper(); }, 120);
  }

  /* ---------- data ---------- */
  function adopt(d, b, c) {
    doc = { id: d.id, title: d.title, version: d.version || 0 };
    blocks = b.map((x) => ({ ...x }));
    comments = c.map((x) => ({ ...x }));
    schedulePaint();
  }
  async function load() {
    if (!docId || fetching) return;
    fetching = true;
    try {
      const r = await studioStore.getDoc(docId);
      if (r.doc.id === docId) { dirty = false; live = false; adopt(r.doc, r.doc.blocks, r.comments); }
    } catch (e) {
      if (e && e.status === 404) { doc = null; blocks = []; comments = []; schedulePaint(); }
    } finally { fetching = false; }
  }
  const scheduleLoad = () => { clearTimeout(fetchTimer); fetchTimer = setTimeout(load, 250); };

  // The Studio screen broadcasts its current state while it is mounted (its blocks include unsaved typing).
  const offLive = bus.on('studio-live', (p) => {
    if (!p || !docId) return;
    if (p.replaces && p.replaces === docId) { docId = p.id; saveFloat(KEY, { docId }); }
    if (p.id !== docId) return;
    live = true; dirty = !!p.dirty;
    clearTimeout(staleTimer);
    // if the Studio screen goes away mid-edit it cannot say "saved": fall back to the stored copy
    if (dirty) staleTimer = setTimeout(() => { dirty = false; load(); }, 6000);
    adopt({ id: p.id, title: p.title, version: p.version }, p.blocks || [], p.comments || []);
  });
  bus.on('studio-popout', (p) => { if (p && p.id) openDoc(p.id, p.title); });

  // SSE-driven changes: the hub's copy moved, or a job we wait for has finished.
  const offStore = subscribe((changed) => {
    if (!docId || !doc || (!changed.has('doc') && !changed.has('job'))) return;
    paintMeta();
    if (studioStore.isLocal(docId)) return;
    const row = state.docs.get(docId);
    const jobs = state.jobs;
    const finished = comments.some((c) => c.state === 'queued' && c.jobId && jobs.has(c.jobId) && !jobActive(jobs.get(c.jobId)));
    const draft = docJobs(jobs, docId).draft;
    const draftDone = !blocks.length && draft && !jobActive(draft);
    if ((row && row.version !== doc.version && !dirty) || finished || draftDone) scheduleLoad();
  });

  /* ---------- actions ---------- */
  async function applyAll() {
    if (!docId || applyBtn.disabled) return;
    applyBtn.disabled = true;
    try {
      const r = await studioStore.applyAll(docId);
      if (!r.ok) toast(r.reason, { kind: 'info' });
      else await load();
    } catch (e) { toastError(e, 'Apply all failed'); }
    finally { paintMeta(); }
  }

  function persist() { saveFloat(KEY, { docId, open, minimised }); }
  function openDoc(id, title) {
    const w = ensureWin();
    if (id !== docId || !doc) {
      docId = id; doc = title ? { id, title, version: 0 } : null; blocks = []; comments = []; dirty = false;
      paintMeta(); paintPaper(); load();
    }
    open = true; minimised = false;
    w.show();
    scalePaper();
    persist();
    api.onChange && api.onChange();
  }
  function minimise() {
    if (!open || minimised) return false;
    minimised = true; open = false;
    if (win) win.hide();
    persist();
    return true;
  }
  function restore(opts = {}) {
    if (!minimised || !docId) return;
    minimised = false; open = true;
    ensureWin().show();
    paintMeta(); paintPaper(); scalePaper();
    if (opts.focus) win.el.focus({ preventScroll: true });
    persist();
  }
  function dismiss() {
    open = false; minimised = false;
    if (win) win.hide();
    docId = null; doc = null; blocks = []; comments = [];
    persist();
    api.onChange && api.onChange();
  }

  const api = {
    onChange: null,
    open: openDoc, minimise, restore, dismiss,
    get docId() { return docId; },
    get isOpen() { return open || minimised; },
    get isMinimised() { return minimised; },
    /** For the shelf chip. */
    chipInfo() {
      const s = status();
      return { title: shortTitle(doc && doc.title), count: openCount(), kind: s.kind, label: s.label };
    },
    destroy() { offLive(); offStore(); clearTimeout(fetchTimer); clearTimeout(paintTimer); if (win) win.destroy(); },
  };
  /* ---------- reload: bring the window back where it was ---------- */
  if (docId) {
    if (saved.open) { ensureWin(); open = true; win.show(); }
    paintMeta(); paintPaper(); load();
  }

  return api;
}
