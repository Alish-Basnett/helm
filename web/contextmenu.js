// contextmenu.js — a reusable right-click / Shift+F10 menu (v0.22).
//
//   openContextMenu({ x, y, items, restoreFocus, onClose })
//   items: { label, icon?, hint?, sub?, danger?, disabled?, checked?, onSelect?, items?: [...] }  (a nested `items` is a submenu)
//          | { divider: true } | { heading: 'Text' } | a falsy value (skipped, so `cond && item` works)
//
// Opens at the pointer, clamped to the viewport. Keyboard: arrows, Home/End, Enter/Space, Right/Left for submenus,
// Esc, type-ahead. Closes on outside click, scroll, resize and window blur. The pure helpers at the top (normalizeItems,
// clampToViewport, submenuOrigin, stepIndex, typeAheadIndex) touch no DOM, so node can test them.
import { h } from './dom.js';
import { icon } from './icons.js';

/* ---------- pure helpers ---------- */
const isSep = (it) => !!it && (it.divider === true);

/** Drop falsy entries and make dividers sane: none first, none last, never two in a row; a heading with nothing under it goes. */
export function normalizeItems(items) {
  const tidy = (list) => {
    const out = [];
    for (const it of list) {
      if (!it) continue;
      if (isSep(it)) { if (out.length && !isSep(out[out.length - 1])) out.push(it); continue; }
      out.push(it);
    }
    while (out.length && isSep(out[out.length - 1])) out.pop();
    return out;
  };
  const first = tidy(items || []);
  // a heading followed by nothing, a divider or another heading is dropped; then tidy again so no two dividers touch
  return tidy(first.filter((it, i) => !(it.heading && (i === first.length - 1 || isSep(first[i + 1]) || first[i + 1].heading))));
}

/** Top-left for a w x h box wanted at (x, y), kept `margin` inside a vw x vh viewport. Flips above/left when it would overflow. */
export function clampToViewport({ x, y, w, h: hh, vw, vh, margin = 8 }) {
  let left = x, top = y;
  if (left + w > vw - margin) left = x - w; // flip to the left of the pointer
  if (top + hh > vh - margin) top = y - hh; // flip above the pointer
  left = Math.max(margin, Math.min(left, vw - w - margin));
  top = Math.max(margin, Math.min(top, vh - hh - margin));
  return { left, top };
}

/** Where a submenu goes relative to its parent item rect: to the right, or to the left when there is no room. */
export function submenuOrigin({ rect, w, h: hh, vw, vh, margin = 8, overlap = 4 }) {
  let left = rect.right - overlap;
  if (left + w > vw - margin) left = rect.left - w + overlap;
  left = Math.max(margin, left);
  let top = rect.top - 6;
  if (top + hh > vh - margin) top = vh - hh - margin;
  return { left, top: Math.max(margin, top) };
}

/** Next enabled index from `cur` in direction dir (+1/-1), wrapping. `enabled` is an array of booleans. -1 when none. */
export function stepIndex(enabled, cur, dir) {
  const n = enabled.length;
  if (!enabled.some(Boolean)) return -1;
  let i = cur;
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
    if (enabled[i]) return i;
  }
  return -1;
}

/** Type-ahead: the next enabled label starting with `query` (case-insensitive), searching after `cur` first and wrapping. */
export function typeAheadIndex(labels, enabled, cur, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return -1;
  const n = labels.length;
  // a repeated single letter ("ss") cycles through the items that start with that letter
  const cycle = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = cycle ? q[0] : q;
  const start = cycle || q.length === 1 ? cur + 1 : Math.max(cur, 0);
  for (let k = 0; k < n; k++) {
    const i = (start + k + n) % n;
    if (enabled[i] && String(labels[i]).toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/* ---------- component ---------- */
let current = null; // { levels: [{ el, rows: [{ btn, item }], parentRow }], opts, off }

export const isContextMenuOpen = () => !!current;

export function closeContextMenu({ restore = true } = {}) {
  if (!current) return;
  const { levels, off, opts } = current;
  current = null;
  off();
  for (const lv of levels) { lv.el.classList.remove('in'); lv.el.classList.add('leaving'); const el = lv.el; setTimeout(() => el.remove(), 110); }
  try { opts.onClose && opts.onClose(); } catch (e) { console.error(e); }
  const back = opts.restoreFocus;
  if (restore && back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
}

function buildLevel(items, depth) {
  const rows = [];
  const el = h('div', { class: 'cm', role: 'menu', 'data-depth': String(depth) });
  for (const it of normalizeItems(items)) {
    if (isSep(it)) { el.appendChild(h('div', { class: 'cm-sep', role: 'separator' })); continue; }
    if (it.heading) { el.appendChild(h('div', { class: 'cm-heading', role: 'presentation' }, it.heading)); continue; }
    const hasSub = Array.isArray(it.items) && it.items.length > 0;
    const btn = h('button', {
      class: ['cm-item', it.danger && 'danger', it.checked && 'checked'], type: 'button', tabindex: '-1',
      role: it.checked != null ? 'menuitemradio' : 'menuitem', 'aria-disabled': it.disabled ? 'true' : null,
      'aria-checked': it.checked != null ? String(!!it.checked) : null, 'aria-haspopup': hasSub ? 'menu' : null,
    },
    it.icon ? icon(it.icon, 15) : h('span', { class: 'cm-icon-pad' }),
    h('span', { class: 'cm-label' }, it.label, it.sub ? h('span', { class: 'cm-sub' }, it.sub) : null),
    it.checked ? icon('check', 14, 'cm-check') : null,
    it.hint ? h('kbd', { class: 'cm-hint' }, it.hint) : null,
    hasSub ? icon('chevronRight', 14, 'cm-chev') : null);
    const row = { btn, item: it, hasSub, enabled: !it.disabled };
    btn.__row = row;
    rows.push(row);
    el.appendChild(btn);
  }
  return { el, rows, depth };
}

/** Open the menu. Returns a close function. A menu that is already open is replaced. */
export function openContextMenu(opts) {
  closeContextMenu({ restore: false });
  const state = { levels: [], opts, off: () => {} };
  let typed = '', typedTimer = 0, hoverTimer = 0;

  const place = (lv, pos) => { lv.el.style.left = pos.left + 'px'; lv.el.style.top = pos.top + 'px'; };
  const reveal = (lv) => { requestAnimationFrame(() => lv.el.classList.add('in')); };

  function openLevel(items, depth, position) {
    const lv = buildLevel(items, depth);
    lv.el.style.visibility = 'hidden';
    document.body.appendChild(lv.el);
    const pos = position(lv.el.offsetWidth, lv.el.offsetHeight);
    place(lv, pos);
    lv.el.style.visibility = '';
    // a menu taller than the viewport scrolls instead of being cut off
    lv.el.style.maxHeight = Math.max(160, innerHeight - 16) + 'px';
    reveal(lv);
    lv.el.addEventListener('pointermove', (e) => {
      const btn = e.target.closest && e.target.closest('.cm-item');
      if (!btn || !lv.el.contains(btn)) return;
      const row = btn.__row;
      if (!row.enabled) return;
      if (document.activeElement !== btn) btn.focus({ preventScroll: true });
      clearTimeout(hoverTimer);
      if (row.hasSub) {
        if (!subOpenFor(lv, row)) hoverTimer = setTimeout(() => openSub(lv, row, false), 120);
      } else closeAbove(lv.depth);
    });
    lv.el.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.cm-item');
      if (!btn || !lv.el.contains(btn)) return;
      e.preventDefault(); e.stopPropagation();
      activate(btn.__row, lv);
    });
    state.levels.push(lv);
    return lv;
  }

  const subOpenFor = (lv, row) => state.levels[lv.depth + 1] && state.levels[lv.depth + 1].parentRow === row;
  function closeAbove(depth) {
    while (state.levels.length > depth + 1) {
      const lv = state.levels.pop();
      lv.el.classList.remove('in'); lv.el.classList.add('leaving');
      setTimeout(() => lv.el.remove(), 110);
    }
    const top = state.levels[state.levels.length - 1];
    if (top) for (const r of top.rows) r.btn.classList.toggle('sub-open', false);
  }
  function openSub(lv, row, focusFirst) {
    closeAbove(lv.depth);
    row.btn.classList.add('sub-open');
    const rect = row.btn.getBoundingClientRect();
    const sub = openLevel(row.item.items, lv.depth + 1,
      (w, hh) => submenuOrigin({ rect, w, h: hh, vw: innerWidth, vh: innerHeight }));
    sub.parentRow = row;
    if (focusFirst) focusRow(sub, stepIndex(sub.rows.map((r) => r.enabled), -1, 1));
  }
  function focusRow(lv, i) {
    if (i < 0 || !lv.rows[i]) return;
    lv.rows[i].btn.focus({ preventScroll: true });
    lv.rows[i].btn.scrollIntoView({ block: 'nearest' });
  }
  const activeLevel = () => state.levels[state.levels.length - 1];
  function activeIndex(lv) { return lv.rows.findIndex((r) => r.btn === document.activeElement); }

  function activate(row, lv) {
    if (!row.enabled) return;
    if (row.hasSub) { openSub(lv, row, true); return; }
    const fn = row.item.onSelect;
    closeContextMenu({ restore: opts.restoreOnSelect !== false });
    try { fn && fn(); } catch (e) { console.error(e); }
  }

  function onKey(e) {
    const lv = activeLevel();
    if (!lv) return;
    const k = e.key;
    const swallow = () => { e.preventDefault(); e.stopPropagation(); };
    const enabled = lv.rows.map((r) => r.enabled);
    const cur = activeIndex(lv);
    if (k === 'Escape') { swallow(); if (state.levels.length > 1) { const parent = lv.parentRow; closeAbove(lv.depth - 1); parent && parent.btn.focus({ preventScroll: true }); } else closeContextMenu(); }
    else if (k === 'ArrowDown') { swallow(); focusRow(lv, stepIndex(enabled, cur, 1)); }
    else if (k === 'ArrowUp') { swallow(); focusRow(lv, stepIndex(enabled, cur, -1)); }
    else if (k === 'Home') { swallow(); focusRow(lv, stepIndex(enabled, -1, 1)); }
    else if (k === 'End') { swallow(); focusRow(lv, stepIndex(enabled, -1, -1)); }
    else if (k === 'ArrowRight') { swallow(); const r = lv.rows[cur]; if (r && r.hasSub && r.enabled) openSub(lv, r, true); }
    else if (k === 'ArrowLeft') { swallow(); if (state.levels.length > 1) { const parent = lv.parentRow; closeAbove(lv.depth - 1); parent && parent.btn.focus({ preventScroll: true }); } }
    else if (k === 'Enter' || k === ' ') { swallow(); const r = lv.rows[cur]; if (r) activate(r, lv); }
    else if (k === 'Tab') { swallow(); closeContextMenu(); }
    else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      swallow();
      typed += k;
      clearTimeout(typedTimer);
      typedTimer = setTimeout(() => { typed = ''; }, 700);
      focusRow(lv, typeAheadIndex(lv.rows.map((r) => r.item.label), enabled, cur, typed));
    } else if (e.metaKey || e.ctrlKey) swallow(); // no app shortcuts leak through while a menu is open
  }
  const inside = (t) => state.levels.some((lv) => lv.el.contains(t));
  const onDown = (e) => { if (!inside(e.target)) closeContextMenu({ restore: false }); };
  const onCtx = (e) => { if (!inside(e.target)) closeContextMenu({ restore: false }); else e.preventDefault(); };
  const onScroll = (e) => { if (!inside(e.target)) closeContextMenu({ restore: false }); };
  const onBlur = () => closeContextMenu({ restore: false });
  const onResize = () => closeContextMenu({ restore: false });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('contextmenu', onCtx, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('wheel', onScroll, { capture: true, passive: true });
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onResize);
  state.off = () => {
    clearTimeout(typedTimer); clearTimeout(hoverTimer);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('contextmenu', onCtx, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('wheel', onScroll, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onResize);
  };
  current = state;

  const root = openLevel(opts.items, 0, (w, hh) => clampToViewport({ x: opts.x, y: opts.y, w, h: hh, vw: innerWidth, vh: innerHeight }));
  // keyboard-opened menus focus the first item at once; pointer-opened ones wait for the first arrow key, like macOS
  if (opts.focusFirst !== false) requestAnimationFrame(() => { if (current === state) focusRow(root, stepIndex(root.rows.map((r) => r.enabled), -1, 1)); });
  return () => { if (current === state) closeContextMenu(); };
}
