// axis.js — shared time-axis maths and wiring (Threads timeline + Today). Pure helpers first, then small DOM helpers.
// A "scale" is { t0, t1, span } in epoch ms. Nothing here owns state: callers keep their scale and call setManual().
import { h, reconcile } from './dom.js';
import { fmtTime, fmtDay } from './format.js';

export const HOUR = 3600e3;
export const pad2 = (n) => String(n).padStart(2, '0');
export const MIN_SPAN = 30e3, MAX_SPAN = 7 * 86400e3, FIT_MIN = 120e3, FIT_PAD = 0.05;
// Tick steps the zoomable axis snaps to: 10s / 30s / 1m / 5m / 15m / 1h / 3h / 1d.
export const TICK_STEPS = [10e3, 30e3, 60e3, 300e3, 900e3, HOUR, 3 * HOUR, 86400e3];

export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${pad2(s % 60)}s`;
  return `${Math.floor(m / 60)}h${pad2(m % 60)}m`;
}

/** Exact duration for tooltips: millisecond precision under a minute. */
export function fmtDurExact(ms) {
  ms = Math.max(0, Math.round(ms));
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60e3) return `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s (${ms.toLocaleString('en-US')} ms)`;
  return fmtDur(ms);
}

export function fmtClockSec(t) { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }

export function tickStep(span, want) {
  const raw = span / Math.max(1, want);
  return TICK_STEPS.find((s) => s >= raw) || TICK_STEPS[TICK_STEPS.length - 1];
}

export function makeTicks(t0, t1, want) {
  const step = tickStep(t1 - t0, want);
  const off = new Date(t0).getTimezoneOffset() * 60000; // align to local clock
  const out = [];
  for (let t = Math.ceil((t0 - off) / step) * step + off; t <= t1 && out.length < 60; t += step) out.push(t);
  const fmt = (t1 - t0) < 120e3 ? fmtClockSec : step < 86400e3 ? (t) => fmtTime(t) : (t) => fmtDay(t);
  return out.map((t) => ({ t, label: fmt(t) }));
}

export const toScale = (r) => ({ t0: r.t0, t1: r.t1, span: r.t1 - r.t0 });
export const clampSpan = (span) => Math.min(MAX_SPAN, Math.max(MIN_SPAN, span));
/** Position of `t` on the scale, in percent of the plot width. */
export const pctOf = (scale, t) => ((t - scale.t0) / scale.span) * 100;

/** The range you get by zooming `scale` by `factor` (>1 zooms out) while keeping the time under `frac` (0..1) fixed. */
export function zoomedRange(scale, factor, frac) {
  const f = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0.5;
  const span = clampSpan(scale.span * factor);
  const anchor = scale.t0 + f * scale.span;
  return { t0: anchor - f * span, span };
}

/** Pad [t0, t1] by FIT_PAD a side and widen to at least FIT_MIN. `rightEdgeNow` pins t1 to `now` (live fit). */
export function paddedFit(t0, t1, now, rightEdgeNow) {
  const pad = (t1 - t0) * FIT_PAD;
  let r0 = t0 - pad, r1 = t1 + pad;
  if (rightEdgeNow) { r1 = now; r0 = t0 - Math.max(pad, 0); }
  if (r1 - r0 < FIT_MIN) {
    if (rightEdgeNow) r0 = r1 - FIT_MIN;
    else { const mid = (r0 + r1) / 2; r0 = mid - FIT_MIN / 2; r1 = mid + FIT_MIN / 2; }
  }
  return { t0: r0, t1: r1 };
}

/**
 * Paint tick labels into `ticksEl` and hairline gridlines into `gridEl` (inserted before `beforeEl`, usually the now line).
 * Returns the ticks. Class names are caller-supplied so Threads and Today keep their own look.
 */
export function paintTicks({ ticksEl, gridEl, beforeEl = null, scale, width, tickClass, gridClass }) {
  const ticks = makeTicks(scale.t0, scale.t1, Math.max(3, Math.floor(width / 110)));
  const pct = (t) => `${pctOf(scale, t).toFixed(3)}%`;
  reconcile(ticksEl, ticks, (t) => `t${t.t}`, (t) => h('span', { class: tickClass }, t.label), (el, t) => { el.style.left = pct(t.t); if (el.textContent !== t.label) el.textContent = t.label; });
  const want = new Set(ticks.map((t) => `g${t.t}`));
  const have = new Map();
  for (const el of Array.from(gridEl.children)) {
    if (el === beforeEl || el.__k === undefined) continue;
    if (!want.has(el.__k)) el.remove(); else have.set(el.__k, el);
  }
  for (const t of ticks) {
    const k = `g${t.t}`;
    let el = have.get(k);
    if (!el) { el = h('i', { class: gridClass }); el.__k = k; gridEl.insertBefore(el, beforeEl); }
    el.style.left = pct(t.t);
  }
  return ticks;
}

/**
 * Wheel zoom/pan and axis-drag pan. `api` = { getScale, setManual(t0, span), zoomBy(factor, frac), plotRect(), enabled() }.
 * Ctrl/Cmd+wheel zooms around the pointer, Shift+wheel or a horizontal wheel pans. Returns a detach function.
 */
export function attachPanZoom({ scroller, axisEl, api }) {
  const fracAt = (clientX) => { const r = api.plotRect(); return r.width > 0 ? (clientX - r.left) / r.width : 0.5; };
  const onWheel = (e) => {
    if (!api.enabled()) return;
    const dx = e.deltaX, dy = e.deltaY, scale = api.getScale();
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); api.zoomBy(Math.exp(Math.max(-200, Math.min(200, dy)) * 0.004), fracAt(e.clientX)); return; }
    const w = api.plotRect().width || 600;
    if (e.shiftKey) { e.preventDefault(); api.setManual(scale.t0 + ((dx || dy) / w) * scale.span, scale.span); return; }
    if (Math.abs(dx) > Math.abs(dy) && dx) { e.preventDefault(); api.setManual(scale.t0 + (dx / w) * scale.span, scale.span); }
  };
  scroller.addEventListener('wheel', onWheel, { passive: false });
  let drag = null;
  const onDown = (e) => {
    if (e.button !== 0 || !api.enabled()) return;
    drag = { x: e.clientX, t0: api.getScale().t0, w: api.plotRect().width || 600 };
    e.preventDefault();
  };
  const onMove = (e) => { if (drag) { const s = api.getScale(); api.setManual(drag.t0 - ((e.clientX - drag.x) / drag.w) * s.span, s.span); } };
  const onUp = () => { drag = null; };
  axisEl.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  return () => {
    scroller.removeEventListener('wheel', onWheel);
    axisEl.removeEventListener('mousedown', onDown);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
}
