// floating.js — a draggable, edge-resizable HUD window that floats above the app (and above the Dock).
// Generic: callers mount any content into `win.body` and mark their header with `data-float-drag` (that is the
// drag handle; double-click toggles a compact, header-only height). Geometry lives in JS (never read back from the
// DOM) and is persisted under one localStorage key together with whatever extra fields the owner keeps there.
//   z-index: Dock 61 < floating 80..89 < menus 100 < meter 120 < Spotlight 150 < toasts 200 < lightbox 300.
import { h } from './dom.js';

export const MIN_W = 320;
export const MIN_H = 260;
export const COMPACT_H = 128; // header-only height when compacted
export const KEEP = 48; // px of the header that must stay on screen
const STEP = 16;
const Z_BASE = 80, Z_MAX = 89;
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [contenteditable="true"]';

/* ---------- persistence: one JSON object per key, merged field by field ---------- */
export function loadFloat(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
export function saveFloat(key, patch) {
  try { localStorage.setItem(key, JSON.stringify({ ...loadFloat(key), ...patch })); } catch { /* storage blocked: it just won't persist */ }
}

const num = (v) => (Number.isFinite(v) ? v : null);
const raf = (fn) => (window.requestAnimationFrame ? window.requestAnimationFrame(fn) : setTimeout(fn, 16));
const caf = (id) => (window.cancelAnimationFrame ? window.cancelAnimationFrame(id) : clearTimeout(id));

/** Pure: keep a rect usable on a viewport of vw × vh. Size first, then position (>= KEEP px of the header on screen). */
export function clampRect(r, vw, vh, compact = false) {
  const minW = Math.min(MIN_W, vw), minH = Math.min(MIN_H, vh);
  const w = Math.round(Math.min(Math.max(r.w, minW), vw));
  const h2 = Math.round(Math.min(Math.max(r.h, minH), vh));
  const effH = compact ? COMPACT_H : h2;
  const keep = Math.min(KEEP, w);
  const x = Math.round(Math.min(Math.max(r.x, keep - w), vw - keep));
  const y = Math.round(Math.min(Math.max(r.y, 0), Math.max(0, vh - Math.min(KEEP, effH))));
  return { x, y, w, h: h2 };
}

const stack = []; // open floating windows, back to front
function restack() { stack.forEach((f, i) => { f.style.zIndex = String(Math.min(Z_MAX, Z_BASE + i)); }); }

const EDGES = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};

/**
 * opts: { storeKey, label, ariaLabel?, className?, defaultRect?({vw,vh}) → {x,y,w,h}, onChange?(state), onFocusIn?() }
 * → { el, body, show, hide, front, destroy, isVisible, rect, compact, setRect, toggleCompact }
 */
export function createFloating(opts) {
  const { storeKey } = opts;
  const body = h('div', { class: 'float-body' });
  const inner = h('div', { class: 'float-inner' }, body);
  const el = h('div', {
    class: ['float-win', opts.className], role: 'dialog', 'aria-modal': 'false', 'aria-label': opts.ariaLabel || opts.label,
    tabindex: '-1', hidden: true, inert: true,
  }, inner);
  const handles = {};
  for (const [edge, cursor] of Object.entries(EDGES)) {
    const hd = h('div', { class: `fw-h fw-${edge}`, 'data-edge': edge, 'aria-hidden': 'true' });
    hd.style.cursor = cursor;
    handles[edge] = hd;
    el.append(hd);
  }
  document.body.append(el);

  const vp = () => ({ vw: window.innerWidth || 1024, vh: window.innerHeight || 768 });
  const saved = loadFloat(storeKey);
  let compact = !!saved.compact;
  let rect;
  {
    const { vw, vh } = vp();
    const d = opts.defaultRect ? opts.defaultRect({ vw, vh }) : { w: 420, h: 560, x: vw - 444, y: 72 };
    const src = {
      x: num(saved.x) ?? d.x, y: num(saved.y) ?? d.y,
      w: num(saved.w) ?? d.w, h: num(saved.h) ?? d.h,
    };
    rect = clampRect(src, vw, vh, compact);
  }
  let visible = false;

  function paint() {
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = (compact ? COMPACT_H : rect.h) + 'px';
    el.classList.toggle('compact', compact);
  }
  function snapshot() { return { x: rect.x, y: rect.y, w: rect.w, h: rect.h, compact }; }
  function commit(persist = true) {
    paint();
    if (persist) saveFloat(storeKey, snapshot());
    if (opts.onChange) opts.onChange(snapshot());
  }
  /** Set part of the rect (clamped to the viewport). */
  function setRect(patch, persist = true) {
    const { vw, vh } = vp();
    rect = clampRect({ ...rect, ...patch }, vw, vh, compact);
    commit(persist);
  }
  function toggleCompact() {
    compact = !compact;
    const { vw, vh } = vp();
    rect = clampRect(rect, vw, vh, compact);
    commit(true);
  }

  /* ---------- stacking + focus ---------- */
  function front() {
    const i = stack.indexOf(el);
    if (i !== stack.length - 1) { if (i >= 0) stack.splice(i, 1); stack.push(el); restack(); }
    el.classList.add('focused');
  }
  el.addEventListener('pointerdown', () => { if (visible) front(); }, true);
  el.addEventListener('focusin', () => { if (visible) front(); if (opts.onFocusIn) opts.onFocusIn(); });
  el.addEventListener('focusout', (e) => { if (!e.relatedTarget || !el.contains(e.relatedTarget)) el.classList.remove('focused'); });

  /* ---------- one pointer gesture: capture, rAF-throttled move, flush on release ---------- */
  function gesture(e, cap, startFn, moveFn, cls) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, rect: { ...rect } };
    startFn && startFn();
    try { cap.setPointerCapture(e.pointerId); } catch { /* unsupported / synthetic */ }
    el.classList.add(cls);
    document.documentElement.classList.add('float-gesture');
    document.documentElement.style.setProperty('--float-cursor', cap.style.cursor || 'move');
    let pending = null, frame = 0, moved = false;
    const flush = () => {
      frame = 0;
      if (!pending) return;
      moveFn(start, pending.x, pending.y);
      pending = null;
      moved = true;
    };
    const onMove = (ev) => {
      pending = { x: ev.clientX, y: ev.clientY };
      if (!frame) frame = raf(flush);
    };
    const end = (ev) => {
      if (frame) { caf(frame); frame = 0; }
      flush();
      try { cap.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
      cap.removeEventListener('pointermove', onMove);
      cap.removeEventListener('pointerup', end);
      cap.removeEventListener('pointercancel', end);
      cap.removeEventListener('lostpointercapture', end);
      el.classList.remove(cls);
      document.documentElement.classList.remove('float-gesture');
      if (moved) saveFloat(storeKey, snapshot());
    };
    cap.addEventListener('pointermove', onMove);
    cap.addEventListener('pointerup', end);
    cap.addEventListener('pointercancel', end);
    cap.addEventListener('lostpointercapture', end);
  }

  /* drag by the header */
  el.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest && e.target.closest('[data-float-drag]');
    if (!grip || !el.contains(grip)) return;
    const hit = e.target.closest(INTERACTIVE);
    if (hit && grip.contains(hit)) return;
    gesture(e, grip, null, (s, x, y) => {
      const { vw, vh } = vp();
      rect = clampRect({ ...s.rect, x: s.rect.x + (x - s.x), y: s.rect.y + (y - s.y) }, vw, vh, compact);
      commit(false);
    }, 'dragging');
  });
  el.addEventListener('dblclick', (e) => {
    const grip = e.target.closest && e.target.closest('[data-float-drag]');
    if (!grip || !el.contains(grip)) return;
    const hit = e.target.closest(INTERACTIVE);
    if (hit && grip.contains(hit)) return;
    toggleCompact();
  });

  /* resize from the 4 edges + 4 corners */
  for (const [edge, hd] of Object.entries(handles)) {
    hd.addEventListener('pointerdown', (e) => {
      gesture(e, hd, null, (s, x, y) => {
        const { vw, vh } = vp();
        const dx = x - s.x, dy = y - s.y;
        let left = s.rect.x, top = s.rect.y, right = s.rect.x + s.rect.w, bottom = s.rect.y + s.rect.h;
        const minW = Math.min(MIN_W, vw), minH = Math.min(MIN_H, vh);
        // the dragged edge follows the pointer, stays inside the viewport and never shrinks past the minimum
        if (edge.includes('w')) left = Math.min(Math.max(left + dx, Math.min(0, s.rect.x)), right - minW);
        if (edge.includes('e')) right = Math.max(Math.min(right + dx, Math.max(vw, s.rect.x + s.rect.w)), left + minW);
        if (edge.includes('n')) top = Math.min(Math.max(top + dy, Math.min(0, s.rect.y)), bottom - minH);
        if (edge.includes('s')) bottom = Math.max(Math.min(bottom + dy, Math.max(vh, s.rect.y + s.rect.h)), top + minH);
        rect = clampRect({ x: left, y: top, w: right - left, h: bottom - top }, vw, vh, compact);
        commit(false);
      }, 'resizing');
    });
  }

  /* ---------- keyboard: Alt+arrows move, Alt+Shift+arrows resize; Esc never closes it ---------- */
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); return; } // dock.js ignores a defaultPrevented Esc: no accidental close
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    // inside a text field Alt+arrows keep their usual meaning (word jumps), so the window only moves from elsewhere
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    const k = e.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) return;
    e.preventDefault();
    e.stopPropagation();
    const dx = k === 'ArrowLeft' ? -STEP : k === 'ArrowRight' ? STEP : 0;
    const dy = k === 'ArrowUp' ? -STEP : k === 'ArrowDown' ? STEP : 0;
    if (e.shiftKey) setRect({ w: rect.w + dx, h: compact ? rect.h : rect.h + dy });
    else setRect({ x: rect.x + dx, y: rect.y + dy });
  });

  /* ---------- keep it on screen when the browser window changes ---------- */
  let queued = 0;
  const onWinResize = () => {
    if (queued) return;
    queued = raf(() => {
      queued = 0;
      const { vw, vh } = vp();
      rect = clampRect(rect, vw, vh, compact);
      paint(); // display only: the saved geometry keeps the user's intent for a bigger screen
    });
  };
  window.addEventListener('resize', onWinResize);

  paint();

  return {
    el, body,
    get isVisible() { return visible; },
    get rect() { return { ...rect }; },
    get compact() { return compact; },
    setRect, toggleCompact, front,
    show() {
      if (visible) { front(); return; }
      visible = true;
      const { vw, vh } = vp();
      rect = clampRect(rect, vw, vh, compact);
      paint();
      el.hidden = false;
      el.inert = false;
      if (!stack.includes(el)) stack.push(el);
      restack();
      front();
      el.classList.add('enter');
      setTimeout(() => el.classList.remove('enter'), 260);
    },
    hide() {
      visible = false;
      el.hidden = true;
      el.inert = true;
      el.classList.remove('focused', 'dragging', 'resizing');
      const i = stack.indexOf(el);
      if (i >= 0) stack.splice(i, 1);
      restack();
    },
    destroy() {
      window.removeEventListener('resize', onWinResize);
      const i = stack.indexOf(el);
      if (i >= 0) stack.splice(i, 1);
      el.remove();
    },
  };
}
