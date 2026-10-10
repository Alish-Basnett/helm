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

  const emit = () => { for (const fn of Array.from(listeners)) { try { fn(); } catch (e) { console.error(e); } } };

  /* ---------- registration ---------- */
  /** cfg: { order, label, icon, width, ariaLabel, onClose?() (user asked to close), onClosed?() (it was hidden), onOpened?() } */
  function register(id, cfg) {
    const panelEl = h('aside', { class: `dock-panel dock-${id}`, role: 'dialog', 'aria-modal': 'false', 'aria-label': cfg.ariaLabel || cfg.label, 'data-panel': id, tabindex: '-1', hidden: true, inert: true });
    const rec = { id, cfg, el: panelEl, open: false, visible: false, badge: false, label: cfg.label, tab: null, prevFocus: null };
    panels.set(id, rec);
    panelEl.addEventListener('focusin', () => { focusId = id; });
    panelEl.addEventListener('pointerdown', () => { focusId = id; }, true);
    // keep DOM order = layout order (left to right)
    const sorted = Array.from(panels.values()).sort((a, b) => a.cfg.order - b.cfg.order);
    for (const p of sorted) el.append(p.el);

    const handle = {
      id,
      el: panelEl,
      get isOpen() { return rec.open; },
      get isVisible() { return rec.open && rec.visible; },
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
    if (focus && rec.visible) {
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

  /** Focus the first meaningful control: the composer if there is one, else the close button. */
  function focusPanel(rec) {
    const t = rec.el.querySelector('[data-autofocus]:not([disabled])') || rec.el.querySelector('textarea:not([disabled]), .dock-close');
    if (t) t.focus({ preventScroll: true });
    else rec.el.focus({ preventScroll: true });
  }

  /* ---------- layout ---------- */
  const widthOf = (rec) => Math.min(rec.cfg.width, Math.max(280, window.innerWidth - 16));

  function layout() {
    const open = mru.map((id) => panels.get(id)).filter(Boolean);
    const avail = Math.max(0, window.innerWidth - RESERVE);
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
      const vis = rec.open && show.has(rec.id);
      const wasVisible = rec.visible;
      rec.visible = vis;
      rec.el.style.width = widthOf(rec) + 'px';
      if (rec.el.hidden === vis) rec.el.hidden = !vis;
      rec.el.inert = !vis;
      if (vis && !wasVisible) {
        rec.el.classList.add('enter');
        setTimeout(() => rec.el.classList.remove('enter'), 340);
      }
      if (!vis && !rec.open) rec.el.classList.remove('enter');
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
    const hiddenRecs = Array.from(panels.values()).filter((r) => r.open && !r.visible).sort((a, b) => a.cfg.order - b.cfg.order);
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
    isVisible: (id) => !!(panels.get(id) && panels.get(id).open && panels.get(id).visible),
    /** Called after every layout (open/close/resize). */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    relayout: layout,
    destroy() { document.removeEventListener('keydown', onKey); window.removeEventListener('resize', queueLayout); },
  };
}

/** The standard panel header: icon + title slot + right-aligned actions + close button. */
export function panelClose(handle, label = 'Close') {
  return h('button', {
    class: 'icon-btn dock-close', type: 'button', 'aria-label': label, title: `${label} (Esc)`,
    onclick: () => handle.requestClose(),
  }, icon('close', 18));
}
