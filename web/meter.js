// meter.js — v0.4 overhead meter popover: what Helm itself spends vs. work you asked for through Helm.
// Quiet on purpose: reassurance, not an alarm.
import { h, s } from './dom.js';
import { api } from './api.js';
import { state } from './store.js';
import { fmtUsdSmall } from './format.js';

const KIND_LABEL = {
  recap: 'Recaps', answer: 'Cheap answers', explain: 'Explanations', digest: 'Digests', note_turn: 'Turns you asked for',
};
const dayLabel = (d) => {
  const t = new Date(`${d}T00:00:00`);
  return isNaN(t) ? String(d) : t.toLocaleDateString(undefined, { weekday: 'short' });
};

let open = null;
export function closeMeter(restoreFocus = false) {
  if (!open) return;
  const { el, anchor, off } = open;
  open = null;
  off();
  el.classList.remove('in');
  setTimeout(() => el.remove(), 120);
  anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
}

/** Seven small bars, overhead per day; today is the accent one. */
export function sparkline(days) {
  const W = 168, H = 34, gap = 6;
  const list = (days || []).slice(-7);
  const max = Math.max(...list.map((d) => Number(d.overheadUsd) || 0), 0.0001);
  const bw = list.length ? (W - gap * (list.length - 1)) / list.length : 0;
  const svg = s('svg', { class: 'meter-spark', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Helm overhead, last ${list.length} days` });
  list.forEach((d, i) => {
    const v = Number(d.overheadUsd) || 0;
    const bh = v > 0 ? Math.max(2, (v / max) * (H - 4)) : 1.5;
    svg.append(s('rect', {
      class: i === list.length - 1 ? 'spark-bar today' : 'spark-bar', x: i * (bw + gap), y: H - bh, width: bw, height: bh, rx: 1.5,
    }, s('title', {}, `${dayLabel(d.date)} ${d.date}: ${fmtUsdSmall(v)} overhead`)));
  });
  return svg;
}

const BREAKDOWN_TABS = [
  { id: 'perDay', label: 'Day', name: (r) => dayLabel(r.date) + ' ' + String(r.date).slice(5) },
  { id: 'perProject', label: 'Project', name: (r) => r.name || (r.projectId ? r.projectId : 'No project') },
  { id: 'perModel', label: 'Model', name: (r) => r.model },
  { id: 'perTask', label: 'Task', name: (r) => (r.title ? `${r.taskId} ${r.title}` : r.taskId) },
];

/** Spend analytics: one tabbed list (day / project / model / task) over the last 7 days. */
export function breakdownView(data) {
  let tab = 'perProject';
  const list = h('ul', { class: 'meter-kinds meter-break' });
  const tabs = h('div', { class: 'meter-tabs', role: 'tablist' });
  const render = () => {
    const def = BREAKDOWN_TABS.find((x) => x.id === tab);
    const rows = (data && Array.isArray(data[tab])) ? data[tab] : [];
    const max = Math.max(...rows.map((r) => Number(r.costUsd) || 0), 0.0001);
    list.textContent = '';
    if (!rows.length) list.append(h('li', { class: 'meter-none' }, 'Nothing recorded yet.'));
    for (const r of rows.slice(0, 8)) {
      const c = Number(r.costUsd) || 0;
      list.append(h('li', { title: def.name(r) },
        h('span', { class: 'meter-k meter-break-name' }, def.name(r)),
        h('span', { class: 'meter-v mono' }, fmtUsdSmall(c)),
        h('span', { class: 'meter-break-bar', style: { width: `${Math.round((c / max) * 100)}%` } })));
    }
    if (rows.length > 8) list.append(h('li', { class: 'meter-none' }, `+${rows.length - 8} more`));
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  };
  for (const x of BREAKDOWN_TABS) {
    tabs.append(h('button', { type: 'button', role: 'tab', class: 'meter-tab', 'data-tab': x.id, onclick: () => { tab = x.id; render(); } }, x.label));
  }
  render();
  return h('div', { class: 'meter-week' },
    h('div', { class: 'meter-title' }, `Spend, last 7 days: ${fmtUsdSmall(Number(data && data.totalUsd) || 0)}`),
    tabs, list);
}

function body(data) {
  const t = (data && data.today) || {};
  const over = Number(t.overheadUsd) || 0;
  const req = Number(t.requestedUsd) || 0;
  const total = over + req;
  const kinds = Object.entries(t.byKind || {}).map(([k, v]) => ({ k, calls: Number(v && v.calls) || 0, cost: Number(v && v.costUsd) || 0 }))
    .sort((a, b) => (a.k === 'note_turn') - (b.k === 'note_turn') || b.cost - a.cost);
  const days = (data && data.days) || [];
  const weekSum = days.reduce((a, d) => a + (Number(d.overheadUsd) || 0), 0);
  return [
    h('div', { class: 'meter-rows' },
      h('div', { class: 'meter-row' }, h('span', { class: 'meter-k' }, 'Helm overhead'), h('span', { class: 'meter-v mono' }, fmtUsdSmall(over))),
      h('div', { class: 'meter-row' }, h('span', { class: 'meter-k' }, 'Requested via Helm'), h('span', { class: 'meter-v mono' }, fmtUsdSmall(req)))),
    h('div', { class: 'meter-bar', role: 'img', 'aria-label': `Overhead ${fmtUsdSmall(over)} of ${fmtUsdSmall(total)} total today` },
      h('span', { class: 'meter-bar-over', style: { width: total > 0 ? `${Math.max(2, (over / total) * 100)}%` : '0%' } })),
    kinds.length
      ? h('ul', { class: 'meter-kinds' }, kinds.map((x) => h('li', { class: x.k === 'note_turn' ? 'requested' : '' },
        h('span', { class: 'meter-k' }, KIND_LABEL[x.k] || x.k), h('span', { class: 'meter-calls mono' }, `${x.calls}×`), h('span', { class: 'meter-v mono' }, fmtUsdSmall(x.cost)))))
      : h('div', { class: 'meter-none' }, 'Nothing spent yet today.'),
    days.length ? h('div', { class: 'meter-week' },
      sparkline(days),
      h('div', { class: 'meter-week-cap mono' }, h('span', {}, dayLabel(days[Math.max(0, days.length - 7)].date)), h('span', {}, `${fmtUsdSmall(weekSum)} this week`), h('span', {}, 'today'))) : null,
  ];
}

/** Toggle the popover under `anchor` (the telemetry item). */
export function toggleMeter(anchor) {
  if (open && open.anchor === anchor) { closeMeter(); return; }
  closeMeter();
  const content = h('div', { class: 'meter-content' }, h('div', { class: 'meter-none' }, 'Loading…'));
  const el = h('div', { class: 'meter-pop', role: 'dialog', 'aria-label': 'Helm overhead' },
    h('div', { class: 'meter-title' }, 'Helm overhead today'),
    h('p', { class: 'meter-sub' }, 'What Helm’s own helpers cost, kept apart from the work you ask for.'),
    content);
  document.body.appendChild(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const mw = el.offsetWidth || 280;
    el.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
    el.style.top = (r.bottom + 8) + 'px';
  };
  place();
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMeter(true); } };
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMeter(); };
  const onResize = () => closeMeter();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', onResize);
  const off = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('resize', onResize);
  };
  open = { el, anchor, off };
  anchor.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => el.classList.add('in'));
  const mine = open;
  Promise.all([api.usage(7), api.usageBreakdown(7).catch(() => null)]).then(([data, brk]) => {
    if (open !== mine) return;
    content.textContent = '';
    content.append(...body(data));
    if (brk) content.append(breakdownView(brk));
    place();
  }).catch((e) => {
    if (open !== mine) return;
    content.textContent = '';
    const u = state.usageToday || {};
    content.append(...(e && (e.status === 404 || e.status === 405)
      ? [h('div', { class: 'meter-rows' },
        h('div', { class: 'meter-row' }, h('span', { class: 'meter-k' }, 'Helm overhead'), h('span', { class: 'meter-v mono' }, fmtUsdSmall(u.overheadUsd))),
        h('div', { class: 'meter-row' }, h('span', { class: 'meter-k' }, 'Requested via Helm'), h('span', { class: 'meter-v mono' }, fmtUsdSmall(u.requestedUsd)))),
      h('div', { class: 'meter-none' }, 'Breakdown needs a newer hub.')]
      : [h('div', { class: 'meter-none' }, `Could not load usage: ${e && e.message ? e.message : 'unknown error'}`)]));
    place();
  });
}

