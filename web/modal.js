// modal.js — one accessible dialog shell: scrim, focus trap, a single stack (Escape closes only the top one), busy lock,
// focus restored to whatever opened it (or the main region when that is gone).
import { h } from './dom.js';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const stack = [];

/**
 * card: a node with role="dialog". Returns { close, setBusy, el }. While busy, Escape and a click on the scrim do nothing
 * (a running bulk request must not be abandoned). `onClose` runs once, whichever way it closed. `initialFocus` should
 * return Cancel or the list, never the primary action.
 */
export function openModal(card, { onClose, initialFocus } = {}) {
  const opener = document.activeElement;
  const scrim = h('div', { class: 'md-scrim' }, card);
  const visible = (el) => !el.closest('[hidden]') && el.getClientRects().length > 0;
  const focusables = () => Array.from(card.querySelectorAll(FOCUSABLE)).filter(visible);
  let closed = false, busy = false;
  const self = { close, setBusy(b) { busy = !!b; }, get closed() { return closed; }, el: scrim };
  const onKey = (e) => {
    if (stack[stack.length - 1] !== self) return; // only the top modal reacts
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) close(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) { e.preventDefault(); return; }
    const i = f.indexOf(document.activeElement);
    if (i < 0) { e.preventDefault(); f[0].focus(); }
    else if (e.shiftKey && i === 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  };
  // caught on the document so focus that sits outside the dialog cannot escape the trap
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim && !busy && stack[stack.length - 1] === self) close(); });
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    const i = stack.indexOf(self);
    if (i >= 0) stack.splice(i, 1);
    scrim.remove();
    const back = opener && opener.isConnected ? opener : document.getElementById('view') || document.querySelector('main');
    if (back) { if (!back.matches('button, input, select, a, [tabindex]')) back.setAttribute('tabindex', '-1'); back.focus({ preventScroll: true }); }
    if (onClose) onClose();
  }
  stack.push(self);
  document.body.append(scrim);
  const first = (initialFocus && initialFocus()) || focusables()[0];
  if (first) first.focus();
  return self;
}
