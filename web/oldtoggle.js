// oldtoggle.js — the small "Show old (N)" switch every picker gets. One flag per picker, remembered in localStorage (store.js).
import { h, setText, setHidden } from './dom.js';
import { showOld, setShowOld } from './store.js';

/** name: the picker's key ('threads', 'desks', 'talk', ...). Returns { el, set(count) }; call set() on every render. */
export function createOldToggle(name, label = 'old') {
  const btn = h('button', { class: 'old-toggle', type: 'button', 'aria-pressed': 'false', onclick: () => setShowOld(name, !showOld(name)) });
  let n = 0;
  const paint = () => {
    const on = showOld(name);
    setText(btn, on ? `Hide ${label} (${n})` : `Show ${label} (${n})`);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? `Hide the ${n} ${label} ones again` : `${n} ${label} ones are hidden: ended sessions that were acknowledged, or that belong to archived or duplicate projects`;
    setHidden(btn, n === 0 && !on);
  };
  paint();
  return { el: btn, set(count) { n = count; paint(); } };
}
