// shelf.js — the minimised-panels shelf: a slim vibrancy bar fixed to the right edge, one chip per minimised panel.
// A minimised panel is NOT destroyed: its component stays mounted (drafts, scroll, diff tab) and the Dock simply lays it
// out as hidden (dock.js `min`); the floating Talk window is hidden the same way. Chips are remembered in
// localStorage (`helm.shelf`) so a reload keeps the shelf, but never reopens the panels: after a reload a chip is a
// "ghost" and restoring it opens the panel fresh through the URL. Minimised panels are not in the URL; restoring puts
// task / chat / diff back (router.setTaskQuery).
import { h, bus } from './dom.js';
import { icon } from './icons.js';
import { lsGet, lsSet, sel, subscribe } from './store.js';
import { onIntent, setTaskQuery } from './router.js';
import { chatActivity } from './views/taskchat.js';
import { replyPending } from './replies.js';

const STORE_KEY = 'helm.shelf';
const SHELF_W = 40; // bar width
const SHELF_EDGE = 8; // gap to the screen edge (and to the Dock)
const KINDS = {
  talk: { order: 0, icon: 'chat' },
  details: { order: 1, icon: 'file', panel: 'details' },
  chat: { order: 2, icon: 'chat', panel: 'chat' },
  diff: { order: 3, icon: 'diff', panel: 'diff' },
  studio: { order: 4, icon: 'file' }, // the floating Studio pill (studio/pill.js): no task, no Dock panel
};
const KIND_OF_PANEL = { details: 'details', chat: 'chat', diff: 'diff', talk: 'talk' };
const NO_TASK = new Set(['talk', 'studio']);
const baseOf = (rel) => String(rel || '').slice(String(rel || '').lastIndexOf('/') + 1);

function labelOf(c, studio) {
  if (c.kind === 'talk') return 'Talk';
  if (c.kind === 'studio') return (studio && studio.chipInfo().title) || 'Studio';
  if (c.kind === 'details') return `${c.task} · Details`;
  if (c.kind === 'chat') return `${c.task} · Chat`;
  return `Diff · ${baseOf(c.rel) || c.task}`;
}

function loadChips() {
  try {
    const raw = JSON.parse(lsGet(STORE_KEY, '[]'));
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const c of raw) {
      if (!c || !KINDS[c.kind] || seen.has(c.kind)) continue;
      if (!NO_TASK.has(c.kind) && typeof c.task !== 'string') continue;
      if (c.kind === 'diff' && typeof c.rel !== 'string') continue;
      seen.add(c.kind);
      out.push({ kind: c.kind, task: c.task || null, rel: c.rel || null, sid: c.sid || null, since: Number(c.since) || Date.now() });
    }
    return out.sort((a, b) => KINDS[a.kind].order - KINDS[b.kind].order);
  } catch { return []; }
}

/** deps: { dock, talk, sheet, taskChat, diffPanel, studio } */
export function createShelf({ dock, talk, sheet, taskChat, diffPanel, studio }) {
  let chips = loadChips();
  const labelOf_ = (c) => labelOf(c, studio);
  // the Studio pill owns its own persisted state: the chip exists exactly while the pill is minimised
  chips = chips.filter((c) => c.kind !== 'studio');
  if (studio && studio.isMinimised) chips.push({ kind: 'studio', task: null, rel: null, sid: null, since: Date.now() });
  chips.sort((a, b) => KINDS[a.kind].order - KINDS[b.kind].order);
  const el = h('div', { class: 'shelf', role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': 'Minimised panels', hidden: true });
  document.body.append(el);
  let shown = false;
  let hideTimer = 0;
  let sig = null;

  const save = () => { try { lsSet(STORE_KEY, chips.length ? JSON.stringify(chips) : null); } catch { /* storage blocked: the shelf just won't persist */ } };
  const owners = { details: sheet, chat: taskChat, diff: diffPanel };

  /* ---------- what is open right now ---------- */
  function describe(kind) {
    if (kind === 'studio') return studio && studio.isOpen && !studio.isMinimised ? { kind, since: Date.now() } : null;
    if (kind === 'talk') return talk.isOpen && !talk.isMinimised ? { kind, sid: talk.sessionId, since: Date.now() } : null;
    const panel = KINDS[kind].panel;
    if (!dock.isOpen(panel) || dock.isMinimised(panel)) return null;
    const o = owners[kind];
    if (!o.taskId) return null;
    if (kind === 'diff') return o.rel ? { kind, task: o.taskId, rel: o.rel, since: Date.now() } : null;
    return { kind, task: o.taskId, since: Date.now() };
  }
  const active = () => Object.keys(KINDS).map(describe).filter(Boolean);

  /** The URL carries only what is open and showing: minimised panels drop out of it. */
  function fixUrl() {
    const d = describe('details'), c = describe('chat'), f = describe('diff');
    const task = (d && d.task) || (c && c.task) || (f && f.task) || null;
    setTaskQuery({ task, chat: c ? '1' : null, diff: f ? f.rel : null });
  }

  /* ---------- state changes ---------- */
  function setChips(next) {
    chips = next.sort((a, b) => KINDS[a.kind].order - KINDS[b.kind].order);
    save();
    render();
  }

  function minimise(kind) {
    const d = describe(kind);
    if (!d) return false;
    return minimiseMany([d]);
  }
  function minimiseMany(descs) {
    if (!descs.length) return false;
    const panelIds = descs.filter((d) => KINDS[d.kind].panel).map((d) => KINDS[d.kind].panel);
    if (panelIds.length) dock.minimise(panelIds);
    if (descs.some((d) => d.kind === 'talk')) talk.minimise();
    if (descs.some((d) => d.kind === 'studio')) studio.minimise();
    const kinds = new Set(descs.map((d) => d.kind));
    setChips([...chips.filter((c) => !kinds.has(c.kind)), ...descs]);
    fixUrl();
    return true;
  }
  const minimiseAll = () => minimiseMany(active());

  /** Un-minimise chips (no URL work). Ghosts (not mounted after a reload) just lose their flag; the URL then opens them. */
  function reveal(list, opts) {
    const ids = list.filter((c) => KINDS[c.kind].panel).map((c) => KINDS[c.kind].panel);
    if (ids.length) dock.restore(ids, opts);
    if (list.some((c) => c.kind === 'talk')) talk.restore(opts);
    if (list.some((c) => c.kind === 'studio')) studio.restore(opts);
    const gone = new Set(list.map((c) => c.kind));
    setChips(chips.filter((c) => !gone.has(c.kind)));
  }
  function urlFor(list) {
    const withTask = list.filter((c) => c.task);
    if (!withTask.length) return;
    const task = withTask[0].task;
    const patch = { task };
    for (const c of withTask) {
      if (c.task !== task) continue;
      if (c.kind === 'chat') patch.chat = '1';
      if (c.kind === 'diff') patch.diff = c.rel;
    }
    setTaskQuery(patch);
  }
  function restore(kind) {
    const c = chips.find((x) => x.kind === kind);
    if (!c) return;
    reveal([c], { focus: true, front: true });
    urlFor([c]);
  }
  function restoreAll() {
    if (!chips.length) return;
    const list = chips.slice();
    const task = (list.find((c) => c.task) || {}).task;
    const rest = list.filter((c) => c.task && c.task !== task); // chips of another task cannot share one URL
    for (const c of rest) drop(c);
    const keep = list.filter((c) => !rest.includes(c));
    reveal(keep, { focus: true, front: false });
    urlFor(keep);
  }
  /** Close a chip's panel for real (no URL work). */
  function drop(c) {
    const panel = KINDS[c.kind].panel;
    if (c.kind === 'talk') talk.dismiss();
    else if (c.kind === 'studio') studio.dismiss();
    else if (dock.isOpen(panel)) { dock.setMin(panel, false); owners[c.kind].show(null); } // the owner closes + resets itself
    else dock.setMin(panel, false);
    setChips(chips.filter((x) => x.kind !== c.kind));
  }
  function dismiss(kind) {
    const c = chips.find((x) => x.kind === kind);
    if (!c) return;
    drop(c);
    fixUrl();
  }
  function toggleAll() {
    if (active().length) minimiseAll();
    else if (chips.length) restoreAll();
  }

  /* ---------- router hooks ---------- */
  // openTask / setChat(true) / setDiff(rel): restore what the user is asking for, drop chips that belong to another task
  onIntent((kind, arg) => {
    if (kind === 'task') {
      let restored = false;
      for (const c of chips.slice()) if (c.task && c.task !== arg) drop(c);
      const mine = chips.filter((c) => c.task === arg);
      if (mine.length) {
        reveal(mine, { focus: true, front: true });
        urlFor(mine);
        restored = true;
      }
      return restored;
    }
    const c = chips.find((x) => x.kind === kind);
    if (c) reveal([c], { focus: true, front: true });
    return false;
  });
  /** Called at the top of every route change: chips of a different task than the URL's are stale. */
  function beforeRoute(r) {
    if (!r.task) return;
    for (const c of chips.slice()) if (c.task && c.task !== r.task) drop(c);
  }

  /* ---------- render ---------- */
  function activityOf(c) {
    if (c.kind === 'chat') { const a = chatActivity(c.task); return a.unread ? 'unread' : a.pending ? 'pending' : ''; }
    if (c.kind === 'talk' && c.sid) {
      const notes = sel.notesFor('session', c.sid);
      if (notes.some((n) => n.reply && (n.repliedAt || 0) > c.since)) return 'unread';
      if (notes.some((n) => !n.__pending && (n.state === 'queued' || n.state === 'sending' || replyPending(n)))) return 'pending';
    }
    return '';
  }
  function paintDots() {
    for (const item of el.querySelectorAll('.shelf-item')) {
      const c = chips.find((x) => x.kind === item.getAttribute('data-kind'));
      if (!c) continue;
      const btn = item.firstChild;
      if (c.kind === 'studio') { // always-on status dot (saved / working / conflicts) plus the open comment count
        const info = studio.chipInfo();
        item.classList.add('has-dot');
        item.classList.toggle('pending', info.kind === 'drafting' || info.kind === 'applying');
        item.dataset.status = info.kind;
        const cnt = item.querySelector('.shelf-count');
        if (cnt) { cnt.textContent = info.count ? String(info.count) : ''; cnt.hidden = !info.count; }
        btn.setAttribute('aria-label', `Restore Studio: ${info.title}, ${info.label}${info.count ? `, ${info.count} open comment${info.count === 1 ? '' : 's'}` : ''}`);
        continue;
      }
      const a = activityOf(c);
      item.classList.toggle('has-dot', !!a);
      item.classList.toggle('pending', a === 'pending');
      btn.setAttribute('aria-label', `Restore ${labelOf_(c)}${a === 'unread' ? ' (new reply)' : a === 'pending' ? ' (waiting for a reply)' : ''}`);
    }
  }

  function setShown(on) {
    if (on === shown) return;
    shown = on;
    clearTimeout(hideTimer);
    const px = on ? SHELF_W + SHELF_EDGE : 0;
    document.documentElement.style.setProperty('--shelf-w', px + 'px');
    dock.setInset(px);
    if (on) {
      el.hidden = false;
      void el.offsetWidth; // commit the hidden state so the slide-in transitions
      requestAnimationFrame(() => { if (shown) el.classList.add('in'); });
      setTimeout(() => { if (shown) el.classList.add('in'); }, 30);
    } else {
      el.classList.remove('in');
      hideTimer = setTimeout(() => { if (!shown) el.hidden = true; }, 260);
    }
  }

  function render() {
    const nextSig = chips.map((c) => `${c.kind}|${labelOf_(c)}`).join(';');
    if (nextSig !== sig) {
      sig = nextSig;
      const hadFocus = el.contains(document.activeElement);
      el.textContent = '';
      chips.forEach((c, i) => {
        const label = labelOf_(c);
        const n = i + 1;
        const btn = h('button', {
          class: 'shelf-chip', type: 'button', tabindex: i === 0 ? '0' : '-1', 'data-kind': c.kind,
          title: `${label} · click to restore (${n <= 9 ? `⌥${n}` : 'no shortcut'}), middle-click to close`,
          'aria-label': `Restore ${label}`, 'aria-keyshortcuts': n <= 9 ? `Alt+${n}` : null,
          onclick: () => restore(c.kind),
          onmousedown: (e) => { if (e.button === 1) e.preventDefault(); },
          onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); dismiss(c.kind); } },
        }, icon(KINDS[c.kind].icon, 16), h('span', { class: 'shelf-label' }, label), c.kind === 'studio' ? h('span', { class: 'shelf-count mono', 'aria-hidden': 'true', hidden: true }) : null, h('span', { class: 'shelf-dot', 'aria-hidden': 'true' }), n <= 9 ? h('span', { class: 'shelf-n mono', 'aria-hidden': 'true' }, String(n)) : null);
        const x = h('button', { class: 'shelf-x', type: 'button', tabindex: '-1', 'aria-label': `Close ${label}`, title: `Close ${label}`, onclick: (e) => { e.stopPropagation(); dismiss(c.kind); } }, icon('close', 11));
        el.append(h('div', { class: 'shelf-item', 'data-kind': c.kind }, btn, x));
      });
      if (hadFocus && chips.length) { const b = el.querySelector('.shelf-chip'); if (b) b.focus(); }
    }
    paintDots();
    setShown(chips.length > 0);
  }

  /* toolbar keyboard: arrows move between chips (roving tabindex); Delete closes the focused one */
  const chipBtns = () => Array.from(el.querySelectorAll('.shelf-chip'));
  el.addEventListener('focusin', (e) => {
    if (!e.target.classList || !e.target.classList.contains('shelf-chip')) return;
    for (const b of chipBtns()) b.tabIndex = b === e.target ? 0 : -1;
  });
  el.addEventListener('keydown', (e) => {
    const btns = chipBtns();
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    let to = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') to = btns[(i + 1) % btns.length];
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') to = btns[(i - 1 + btns.length) % btns.length];
    else if (e.key === 'Home') to = btns[0];
    else if (e.key === 'End') to = btns[btns.length - 1];
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); dismiss(btns[i].getAttribute('data-kind')); return; }
    if (to) { e.preventDefault(); to.focus(); }
  });

  /* ⌥1..⌥9 restores chip N (e.code, because ⌥ changes e.key on a Mac) */
  const onKey = (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
    if (!m) return;
    const c = chips[Number(m[1]) - 1];
    if (!c) return;
    e.preventDefault();
    restore(c.kind);
  };
  document.addEventListener('keydown', onKey);

  const offBusA = bus.on('shelf-minimise', (kind) => { minimise(kind); });
  const offBusB = bus.on('shelf-restore', (kind) => { restore(kind); });
  dock.setMinimiseHook((panelId) => minimise(KIND_OF_PANEL[panelId]));
  const offStore = subscribe(() => { if (chips.length) paintDots(); });
  const offDock = dock.subscribe(() => { if (chips.length) paintDots(); });

  /* boot: chips come back from storage as ghosts. The Dock is told now, so a URL that still names the task cannot pop the panel up. */
  if (studio) {
    // the pill can open, change or close itself (Pop out, its X, a title edit): keep the chip in step with it
    studio.onChange = () => {
      const has = chips.some((c) => c.kind === 'studio');
      if (studio.isMinimised && !has) setChips([...chips, { kind: 'studio', task: null, rel: null, sid: null, since: Date.now() }]);
      else if (!studio.isMinimised && has) setChips(chips.filter((c) => c.kind !== 'studio'));
      else if (chips.length) render();
    };
  }
  for (const c of chips) {
    if (c.kind === 'studio') continue;
    if (c.kind === 'talk') talk.setGhost(true);
    else dock.setMin(KINDS[c.kind].panel, true);
  }
  render();

  return {
    minimise, minimiseAll, restore, restoreAll, dismiss, toggleAll, beforeRoute,
    get chips() { return chips.map((c) => ({ ...c, label: labelOf_(c) })); },
    get hasPanels() { return active().length > 0; },
    destroy() { document.removeEventListener('keydown', onKey); offBusA(); offBusB(); offStore(); offDock(); el.remove(); },
  };
}
