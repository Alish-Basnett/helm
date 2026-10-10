// wf/pop.js — one anchored popover at a time (save, run, versions, runs, new workflow). Closes on outside click and Escape.
import { h } from '../dom.js';

let cur = null;
export function closePop(restore = true) {
  if (!cur) return;
  const { el, off, anchor, onClose } = cur;
  cur = null;
  off();
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 110);
  if (onClose) { try { onClose(); } catch (e) { console.error(e); } }
  if (restore && anchor && anchor.isConnected && anchor.focus) anchor.focus({ preventScroll: true });
}
export const isPopOpen = () => !!cur;

/** content: Node. opts: { align: 'left' | 'right', width, onClose, cls } → { el, close } */
export function openPop(anchor, content, { align = 'left', width = 340, onClose, cls = '' } = {}) {
  closePop(false);
  const el = h('div', { class: `wf-pop ${cls}`, role: 'dialog', style: { width: width + 'px' } }, content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const mh = el.offsetHeight;
  let left = align === 'right' ? r.right - width : r.left;
  let top = r.bottom + 8;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 8);
  left = Math.max(8, Math.min(left, innerWidth - width - 8));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); } };
  const onDown = (e) => {
    if (el.contains(e.target) || (anchor.contains && anchor.contains(e.target))) return;
    if (e.target.closest && e.target.closest('.menu')) return;
    closePop(false);
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  const off = () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true); };
  cur = { el, off, anchor, onClose };
  requestAnimationFrame(() => {
    el.classList.add('in');
    const f = el.querySelector('[data-autofocus]') || el.querySelector('textarea,input,select,button');
    if (f) f.focus({ preventScroll: true });
  });
  return { el, close: () => closePop() };
}
