// ui.js — toasts, popover menus, small shared widgets.
import { h, setText } from './dom.js';
import { icon } from './icons.js';
import { modelInfo, agentLabel, STATUS_META } from './format.js';

/* ---------- toast ---------- */
export function toast(message, opts = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const kind = opts.kind || 'info';
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'warning' : kind === 'success' ? 'checkCircle' : 'pulse', 16),
    h('span', { class: 'toast-msg' }, message),
    opts.action && h('button', {
      class: 'toast-action', type: 'button',
      onclick: () => { try { opts.action.onClick(); } finally { dismiss(); } },
    }, opts.action.label),
  );
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  root.appendChild(el);
  while (root.children.length > 4) root.firstChild.remove();
  timer = setTimeout(dismiss, opts.duration || (kind === 'error' ? 6000 : 4000));
  return dismiss;
}
export const toastError = (e, prefix) => toast(`${prefix ? prefix + ': ' : ''}${e && e.message ? e.message : e}`, { kind: 'error' });

/* ---------- menu (popover) ---------- */
let openMenuState = null;
export function closeMenu(restoreFocus = true) {
  if (!openMenuState) return;
  const { el, anchor, off } = openMenuState;
  openMenuState = null;
  off();
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 120);
  if (restoreFocus && anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
}

/**
 * items: { label, sub?, icon?, active?, danger?, disabled?, onSelect } | { heading } | { divider:true }
 */
export function openMenu(anchor, items, opts = {}) {
  closeMenu(false);
  const buttons = [];
  const el = h('div', { class: 'menu', role: 'menu', style: { minWidth: (opts.minWidth || 220) + 'px' } });
  for (const it of items) {
    if (it.divider) { el.appendChild(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (it.heading) { el.appendChild(h('div', { class: 'menu-heading' }, it.heading)); continue; }
    const b = h('button', {
      class: ['menu-item', it.active && 'active', it.danger && 'danger'], type: 'button', role: 'menuitem',
      disabled: it.disabled, tabindex: '-1',
      onclick: () => { closeMenu(); it.onSelect && it.onSelect(); },
    },
      it.icon ? icon(it.icon, 16) : h('span', { class: 'menu-icon-pad' }),
      h('span', { class: 'menu-label' }, it.label, it.sub && h('span', { class: 'menu-sub' }, it.sub)),
      it.active && icon('check', 14, 'menu-check'),
    );
    buttons.push(b);
    el.appendChild(b);
  }
  document.body.appendChild(el);
  // position
  const r = anchor.getBoundingClientRect();
  const mw = el.offsetWidth, mh = el.offsetHeight;
  let left = opts.align === 'right' ? r.right - mw : r.left;
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  el.style.left = left + 'px';
  el.style.top = top + 'px';

  const focusAt = (i) => {
    const enabled = buttons.filter((b) => !b.disabled);
    if (!enabled.length) return;
    const idx = (i + enabled.length) % enabled.length;
    enabled[idx].focus();
  };
  const onKey = (e) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const cur = enabled.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(cur + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(cur < 0 ? -1 : cur - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(-1); }
    else if (e.key === 'Tab') { closeMenu(false); }
  };
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(false); };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', () => closeMenu(false), { once: true });
  const off = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
  };
  openMenuState = { el, anchor, off };
  requestAnimationFrame(() => {
    el.classList.add('in');
    const act = buttons.find((b) => b.classList.contains('active') && !b.disabled);
    (act || buttons.find((b) => !b.disabled))?.focus({ preventScroll: true });
  });
  return el;
}

/* ---------- shared widgets ---------- */
export function modelBadge(model) {
  const m = modelInfo(model);
  return h('span', { class: `badge model-${m.key}`, title: model || 'unknown model' }, m.label);
}
export function updateModelBadge(el, model) {
  const m = modelInfo(model);
  const cls = `badge model-${m.key}`;
  if (el.className !== cls) el.className = cls;
  setText(el, m.label);
  el.title = model || 'unknown model';
}

export function avatar(agent, size = 'md') {
  const m = modelInfo(agent && agent.model);
  const letter = (agentLabel(agent)[0] || 'A').toUpperCase();
  return h('span', { class: `avatar avatar-${size} model-${m.key}`, 'aria-hidden': 'true', title: agent ? agentLabel(agent) : 'unassigned' }, letter);
}
export function updateAvatar(el, agent) {
  const m = modelInfo(agent && agent.model);
  const base = el.className.split(' ').filter((c) => !c.startsWith('model-')).join(' ');
  const cls = `${base} model-${m.key}`;
  if (el.className !== cls) el.className = cls;
  setText(el, (agentLabel(agent)[0] || 'A').toUpperCase());
}

export function statusDot(status) { return h('span', { class: `sdot st-${status}`, title: (STATUS_META[status] || {}).label || status }); }

export function emptyState({ iconName = 'inbox', title, body, action }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName, 28)),
    h('h2', { class: 'empty-title' }, title),
    body && h('p', { class: 'empty-body' }, body),
    action && h('button', { class: 'btn btn-primary', type: 'button', onclick: action.onClick }, action.label),
  );
}

/** Caret that blinks at the end of live "now doing" text. */
export function nowDoingLine() {
  const text = h('span', { class: 'nd-text' });
  const caret = h('span', { class: 'caret', 'aria-hidden': 'true' });
  const el = h('div', { class: 'now-doing mono' }, text, caret);
  el.__set = (value, live) => {
    setText(text, value || (live ? 'working…' : '—'));
    caret.hidden = !live;
    el.classList.toggle('dim', !live);
  };
  return el;
}
