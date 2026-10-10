// wf/palette.js — the step palette: drag a type onto the canvas, or click / press Enter to add it at the middle.
import { h, setClass } from '../dom.js';
import { icon } from '../icons.js';
import { PALETTE } from './graph.js';

export function createPalette(canvas) {
  let disabled = false;
  const el = h('div', { class: 'wf-palette', role: 'toolbar', 'aria-label': 'Add a step', 'aria-orientation': 'vertical' });
  let lastGroup = null;
  for (const p of PALETTE) {
    if (p.group !== lastGroup) { lastGroup = p.group; el.append(h('div', { class: 'wf-pal-group' }, p.group)); }
    const chip = h('button', { class: `wf-pal-chip t-${p.type}`, type: 'button', title: `${p.label}: ${p.hint}. Drag onto the canvas, or click to add.`, 'aria-label': `Add ${p.label}` },
      h('span', { class: 'wf-pal-ic' }, icon(p.icon, 15)), h('span', { class: 'wf-pal-l' }, p.label), h('span', { class: 'wf-pal-grip' }, icon('grip', 12)));
    chip.addEventListener('pointerdown', (e) => {
      if (disabled || (e.button != null && e.button !== 0)) return;
      const sx = e.clientX, sy = e.clientY;
      let ghost = null;
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        moved = true;
        if (!ghost) {
          ghost = h('div', { class: 'wf-ghost' }, icon(p.icon, 15), p.label);
          document.body.append(ghost);
          document.documentElement.classList.add('wf-dragging-pal');
        }
        ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        document.documentElement.classList.remove('wf-dragging-pal');
        if (ghost) ghost.remove();
        if (moved) canvas.dropAt(p, ev.clientX, ev.clientY);
        else canvas.addAtCenter(p);
      };
      const cancel = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); document.documentElement.classList.remove('wf-dragging-pal'); if (ghost) ghost.remove(); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    });
    chip.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !disabled) { e.preventDefault(); canvas.addAtCenter(p); } });
    el.append(chip);
  }
  return {
    el,
    setDisabled(on) { disabled = !!on; setClass(el, 'disabled', disabled); for (const b of el.querySelectorAll('button')) b.disabled = disabled; },
  };
}
