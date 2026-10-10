// dock.js — v0.5: one manager for the right-hand panels (Talk, Task details, Task chat).
// Panels sit side by side from the right edge: Talk (rightmost), Task details, Task chat (leftmost). Each has its own
// width, header and close button. When the open panels do not fit (viewport − 240px), the least recently used ones
// collapse into a vertical tab rail on the dock's left edge; clicking a tab swaps that panel in. Esc closes the
// focused panel. Panels are non-modal: the page behind stays usable and nothing closes another panel.
import { h, setHidden } from './dom.js';
import { icon } from './icons.js';

const GAP = 8;
const RAIL_W = 38;
const RESERVE = 240; // always leave this much of the viewport to the page behind the dock
const MIN_W = 320; // narrowest a user can drag a panel
const STEP = 16, STEP_BIG = 64; // keyboard resize steps (Shift = big)
const STORE_KEY = 'helm.dock.widths';

function loadWidths() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const out = {};
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (Number.isFinite(v) && v > 0) out[k] = Math.round(v);
    return out;
  } catch { return {}; }
}
function saveWidths(w) { try { localStorage.setItem(STORE_KEY, JSON.stringify(w)); } catch { /* storage blocked: width just won't persist */ } }

export function createDock(root) {
  const el = h('div', { class: 'dock', 'data-open': '0' });
  const rail = h('div', { class: 'dock-rail', role: 'tablist', 'aria-label': 'More panels', 'aria-orientation': 'vertical', hidden: true });
  el.append(rail);
  root.append(el);

  const panels = new Map(); // id -> record
  let mru = []; // open panel ids, most recently used first
  let focusId = null;
  const listeners = new Set();
  let layoutQueued = false;
  let inset = 0; // px kept clear on the right for the minimised-panels shelf
  const vw = () => Math.max(0, window.innerWidth - inset);
  let minHook = null; // the shelf: header "—" buttons go through it so a chip is created
  const saved = loadWidths(); // id -> preferred width (never overwritten by clamping, only by an explicit resize)

  const emit = () => { for (const fn of Array.from(listeners)) { try { fn(); } catch (e) { console.error(e); } } };

  /* ---------- registration ---------- */
  /** cfg: { order, label, icon, width, ariaLabel, onClose?() (user asked to close), onClosed?() (it was hidden), onOpened?() } */
  function register(id, cfg) {
    const panelEl = h('aside', { class: `dock-panel dock-${id}`, role: 'dialog', 'aria-modal': 'false', 'aria-label': cfg.ariaLabel || cfg.label, 'data-panel': id, tabindex: '-1', hidden: true, inert: true });
    const rec = { id, cfg, el: panelEl, grip: null, open: false, visible: false, badge: false, min: false, label: cfg.label, tab: null, prevFocus: null };
    panels.set(id, rec);
    panelEl.addEventListener('focusin', () => { focusId = id; });
    panelEl.addEventListener('pointerdown', () => { focusId = id; }, true);
    // keep DOM order = layout order (left to right)
    const sorted = Array.from(panels.values()).sort((a, b) => a.cfg.order - b.cfg.order);
    for (const p of sorted) el.append(p.el);
    rec.grip = makeGrip(rec);
    panelEl.append(rec.grip);
    // some panels rebuild their contents with textContent = '' — put the grip back if that happens
    new MutationObserver(() => { if (rec.grip.parentNode !== panelEl) panelEl.append(rec.grip); }).observe(panelEl, { childList: true });

    const handle = {
      id,
      el: panelEl,
      get isOpen() { return rec.open; },
      get isVisible() { return rec.open && rec.visible; },
      get isMinimised() { return rec.min; },
      /** The user asked to minimise it (header button): goes via the shelf so a chip appears and the URL follows. */
      requestMinimise: () => (minHook ? minHook(id) : minimise([id])),
      minimise: () => minimise([id]),
      restore: (opts) => restore([id], opts),
      open: (opts) => open(id, opts),
      close: () => close(id),
      toggle: () => (rec.open ? close(id) : open(id)),
      /** The user asked to close it (close button, Esc): lets the owner update URL state first. */
      requestClose: () => (cfg.onClose ? cfg.onClose() : close(id)),
      focus: () => focusPanel(rec),
      setBadge(on) { on = !!on; if (rec.badge !== on) { rec.badge = on; renderRail(); } },
      setLabel(text) { if (rec.label !== text) { rec.label = text; renderRail(); } },
    };
    rec.handle = handle;
    return handle;
  }

  /* ---------- open / close ---------- */
  /** opts: { focus = true (move focus into it), front = true (make it the most recently used) } */
  function open(id, opts = {}) {
    const rec = panels.get(id);
    if (!rec) return;
    const { focus = true, front = true } = opts;
    const wasOpen = rec.open;
    if (!wasOpen) {
      rec.open = true;
      rec.prevFocus = document.activeElement && !el.contains(document.activeElement) ? document.activeElement : null;
      mru = front ? [id, ...mru.filter((x) => x !== id)] : [...mru.filter((x) => x !== id), id];
    } else if (front) {
      mru = [id, ...mru.filter((x) => x !== id)];
    }
    layout();
    if (focus && rec.visible && !rec.min) {
      focusId = id;
      requestAnimationFrame(() => { if (rec.open && rec.visible && (!wasOpen || !rec.el.contains(document.activeElement))) focusPanel(rec); });
    }
    if (!wasOpen && rec.cfg.onOpened) rec.cfg.onOpened();
  }

  function close(id) {
    const rec = panels.get(id);
    if (!rec || !rec.open) return;
    const hadFocus = rec.el.contains(document.activeElement);
    rec.open = false;
    rec.min = false;
    mru = mru.filter((x) => x !== id);
    if (focusId === id) focusId = null;
    layout();
    if (hadFocus) {
      const back = rec.prevFocus && rec.prevFocus.isConnected ? rec.prevFocus : null;
      const next = mru.map((x) => panels.get(x)).find((p) => p && p.visible);
      if (back && !next) back.focus({ preventScroll: true });
      else if (next) { focusId = next.id; focusPanel(next); }
    }
    rec.prevFocus = null;
    if (rec.cfg.onClosed) rec.cfg.onClosed();
  }

  /* ---------- minimise / restore (the panel stays mounted: drafts, scroll and tabs survive) ---------- */
  /** Hide the panels without closing them. They keep their place in the MRU order, so restoring brings the same layout back. */
  function minimise(ids) {
    let any = false, hadFocus = false;
    for (const id of ids) {
      const rec = panels.get(id);
      if (!rec || !rec.open || rec.min) continue;
      if (rec.el.contains(document.activeElement)) hadFocus = true;
      rec.min = true;
      if (focusId === id) focusId = null;
      any = true;
    }
    if (!any) return false;
    layout();
    if (hadFocus) {
      const next = mru.map((x) => panels.get(x)).find((p) => p && p.visible && !p.min);
      if (next) { focusId = next.id; focusPanel(next); }
      else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    }
    return true;
  }
  /** Bring minimised panels back. A panel that is not open (a "ghost" chip after a reload) just loses its flag; its owner opens it. */
  function restore(ids, opts = {}) {
    const { focus = true, front = true } = opts;
    let first = null;
    for (const id of ids) {
      const rec = panels.get(id);
      if (!rec || !rec.min) continue;
      rec.min = false;
      if (rec.open && front) mru = [id, ...mru.filter((x) => x !== id)];
      if (rec.open && !first) first = rec;
    }
    layout();
    if (focus && first) {
      const target = mru.map((x) => panels.get(x)).find((p) => p && p.open && !p.min && p.visible && ids.includes(p.id)) || first;
      if (target.visible) requestAnimationFrame(() => { if (target.open && !target.min && target.visible) { focusId = target.id; focusPanel(target); } });
    }
  }
  /** Mark a panel minimised before it is open (boot: the shelf is restored from storage; the URL may still open it). */
  function setMin(id, on) {
    const rec = panels.get(id);
    if (!rec || rec.min === !!on) return;
    rec.min = !!on;
    layout();
  }

  /** Focus the first meaningful control: the composer if there is one, else the close button. */
  function focusPanel(rec) {
    const t = rec.el.querySelector('[data-autofocus]:not([disabled])') || rec.el.querySelector('textarea:not([disabled]), .dock-close');
    if (t) t.focus({ preventScroll: true });
    else rec.el.focus({ preventScroll: true });
  }

  /* ---------- layout ---------- */
  const cap = () => Math.max(280, vw() - 16); // never wider than the screen
  /** Widest a panel may be: leave RESERVE to the page and MIN_W (+gap) for every other open panel. */
  function maxOf(rec) {
    const others = Array.from(panels.values()).filter((r) => r.open && !r.min && r !== rec).length;
    return Math.max(MIN_W, Math.min(cap(), vw() - RESERVE - others * (MIN_W + GAP)));
  }
  const clampW = (rec, w) => Math.round(Math.min(maxOf(rec), Math.max(Math.min(MIN_W, cap()), w)));
  /** Preferred width (saved or default), clamped to what fits right now. A saved width is only clamped for display. */
  const widthOf = (rec) => (saved[rec.id] != null ? clampW(rec, saved[rec.id]) : Math.min(rec.cfg.width, cap()));

  function syncGrip(rec, w = widthOf(rec)) {
    const g = rec.grip;
    g.setAttribute('aria-valuenow', String(Math.round(w)));
    g.setAttribute('aria-valuemin', String(Math.min(MIN_W, cap())));
    g.setAttribute('aria-valuemax', String(maxOf(rec)));
  }
  function persist(rec, w) {
    if (w == null) delete saved[rec.id]; else saved[rec.id] = Math.round(w);
    saveWidths(saved);
  }
  function makeGrip(rec) {
    const g = h('div', { class: 'dock-grip', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', title: 'Drag to resize, double-click to reset', 'aria-label': `Resize ${rec.cfg.label} panel` });
    let drag = null, raf = 0, nextW = 0;
    const apply = () => { raf = 0; rec.el.style.width = nextW + 'px'; syncGrip(rec, nextW); };
    const endDrag = (e) => {
      if (!drag) return;
      const wasDragging = drag; drag = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      try { g.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      g.classList.remove('dragging');
      document.documentElement.classList.remove('dock-resizing');
      if (wasDragging.moved) { persist(rec, nextW); layout(); }
    };
    g.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      drag = { x: e.clientX, w: rec.el.getBoundingClientRect().width || widthOf(rec), moved: false };
      nextW = clampW(rec, drag.w);
      try { g.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
      g.classList.add('dragging');
      document.documentElement.classList.add('dock-resizing'); // locks user-select + cursor
    });
    g.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.moved = true;
      nextW = clampW(rec, drag.w + (drag.x - e.clientX)); // panel grows leftwards
      if (!raf) raf = requestAnimationFrame(apply);
    });
    g.addEventListener('pointerup', endDrag);
    g.addEventListener('pointercancel', endDrag);
    g.addEventListener('lostpointercapture', endDrag);
    g.addEventListener('dblclick', () => { persist(rec, null); layout(); });
    g.addEventListener('keydown', (e) => {
      const big = e.shiftKey ? STEP_BIG : STEP;
      const cur = widthOf(rec);
      let w = null;
      if (e.key === 'ArrowLeft') w = cur + big; // edge moves left -> wider
      else if (e.key === 'ArrowRight') w = cur - big;
      else if (e.key === 'Home') w = 0;
      else if (e.key === 'End') w = Infinity;
      if (w == null) return;
      e.preventDefault();
      persist(rec, clampW(rec, w));
      layout();
    });
    return g;
  }

  function layout() {
    const open = mru.map((id) => panels.get(id)).filter((r) => r && !r.min);
    const avail = Math.max(0, vw() - RESERVE);
    const fit = (limit) => {
      const set = new Set();
      let used = 0;
      for (const rec of open) {
        const need = widthOf(rec) + (set.size ? GAP : 0);
        if (set.size === 0 || used + need <= limit) { set.add(rec.id); used += need; }
      }
      return set;
    };
    let show = fit(avail);
    if (show.size < open.length) show = fit(avail - RAIL_W - GAP); // the tab rail takes room too
    for (const rec of panels.values()) {
      const vis = rec.open && !rec.min && show.has(rec.id);
      const wasVisible = rec.visible;
      rec.visible = vis;
      rec.el.style.width = widthOf(rec) + 'px';
      syncGrip(rec);
      if (rec.el.hidden === vis) rec.el.hidden = !vis;
      rec.el.inert = !vis;
      if (vis && !wasVisible) {
        rec.el.classList.add('enter');
        setTimeout(() => rec.el.classList.remove('enter'), 340);
      }
      if (!vis && (!rec.open || rec.min)) rec.el.classList.remove('enter');
    }
    el.setAttribute('data-open', String(show.size));
    renderRail();
    emit();
  }
  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => { layoutQueued = false; layout(); });
  }
  window.addEventListener('resize', queueLayout);

  function renderRail() {
    const hiddenRecs = Array.from(panels.values()).filter((r) => r.open && !r.min && !r.visible).sort((a, b) => a.cfg.order - b.cfg.order);
    setHidden(rail, hiddenRecs.length === 0);
    el.classList.toggle('has-rail', hiddenRecs.length > 0);
    // rebuild only when the set / labels / badges change
    const sig = hiddenRecs.map((r) => `${r.id}|${r.label}|${r.badge ? 1 : 0}`).join(';');
    if (rail.__sig === sig) return;
    rail.__sig = sig;
    rail.textContent = '';
    for (const r of hiddenRecs) {
      const tab = h('button', {
        class: ['dock-tab', r.badge && 'has-dot'], type: 'button', role: 'tab', 'aria-selected': 'false',
        title: `Show ${r.label}`, 'aria-label': `Show ${r.label}${r.badge ? ' (new activity)' : ''}`, 'data-tab': r.id,
        onclick: () => open(r.id, { focus: true, front: true }),
      }, icon(r.cfg.icon || 'circle', 16), h('span', { class: 'dock-tab-label' }, r.label), r.badge ? h('span', { class: 'dock-dot', 'aria-hidden': 'true' }) : null);
      rail.append(tab);
    }
  }

  /* ---------- Esc closes the focused panel ---------- */
  function targetForEsc() {
    const active = document.activeElement;
    for (const rec of panels.values()) if (rec.visible && active && rec.el.contains(active)) return rec;
    const f = focusId && panels.get(focusId);
    if (f && f.visible) return f;
    return mru.map((x) => panels.get(x)).find((p) => p && p.visible) || null;
  }
  function onKey(e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.querySelector('.menu, .spotlight-scrim.open')) return;
    const rec = targetForEsc();
    if (!rec) return;
    e.preventDefault();
    rec.handle.requestClose();
  }
  document.addEventListener('keydown', onKey);

  return {
    el, register, open, close,
    isOpen: (id) => !!(panels.get(id) && panels.get(id).open),
    isMinimised: (id) => !!(panels.get(id) && panels.get(id).min),
    /** Open and not minimised: what "minimise all" acts on (includes panels tucked in the tab rail). */
    activeIds: () => Array.from(panels.values()).filter((r) => r.open && !r.min).map((r) => r.id),
    minimise, restore, setMin,
    setMinimiseHook(fn) { minHook = fn; },
    /** Room the shelf takes on the right edge (px); the Dock shifts left and re-fits. */
    setInset(px) { px = Math.max(0, Math.round(px || 0)); if (px === inset) return; inset = px; el.style.right = (8 + px) + 'px'; layout(); },
    isVisible: (id) => !!(panels.get(id) && panels.get(id).open && panels.get(id).visible),
    /** Called after every layout (open/close/resize). */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    relayout: layout,
    destroy() { document.removeEventListener('keydown', onKey); window.removeEventListener('resize', queueLayout); },
  };
}

/** The "—" button next to the close button: minimise this panel into the shelf on the right edge. */
export function panelMinimise(handle, label = 'Minimise') {
  return h('button', {
    class: 'icon-btn dock-min', type: 'button', 'aria-label': label, title: `${label} (M minimises all)`,
    onclick: () => handle.requestMinimise(),
  }, icon('minimize', 18));
}

/** The standard panel header: icon + title slot + right-aligned actions + close button. */
export function panelClose(handle, label = 'Close') {
  return h('button', {
    class: 'icon-btn dock-close', type: 'button', 'aria-label': label, title: `${label} (Esc)`,
    onclick: () => handle.requestClose(),
  }, icon('close', 18));
}
