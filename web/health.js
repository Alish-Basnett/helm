// health.js — v0.14 session health: shared pieces for the Health screen, the Office desks, the header dot and the Inbox.
// The hub decides the level (Session.health). This file only turns it into words, colours and small gauges.
import { h, s, setText, setAttr } from './dom.js';
import { fmtTokens, fmtTime } from './format.js';

export const LEVEL_LABEL = { ok: 'Healthy', warn: 'Warning', critical: 'Critical' };
export const LEVEL_RANK = { critical: 0, warn: 1, ok: 2 };
const CTX = { warn: 70, critical: 85 };
const RATE = { warn: 80, critical: 95 };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const levelOf = (sess) => (sess && sess.health && sess.health.level) || 'ok';
export const isLiveSession = (sess) => sess && (sess.status === 'active' || sess.status === 'idle');
export const ctxLevel = (pct) => (pct == null ? 'none' : pct > CTX.critical ? 'critical' : pct > CTX.warn ? 'warn' : 'ok');
export const rateLevel = (pct) => (pct == null ? 'none' : pct > RATE.critical ? 'critical' : pct > RATE.warn ? 'warn' : 'ok');
/** Tokens in the context window right now, estimated from the percent and the window size. */
export const ctxTokens = (sess) => (sess.contextPercent != null && sess.contextWindow ? Math.round(sess.contextPercent / 100 * sess.contextWindow) : null);
export const rateLabel = (kind) => (kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? '7-day' : String(kind || 'limit').replace(/_/g, '-'));

/** "15:00", or "Tue 15:00" when the reset is not today. */
export function fmtReset(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const same = new Date(t).toDateString() === new Date(now).toDateString();
  return same ? fmtTime(t) : `${DAYS[new Date(t).getDay()]} ${fmtTime(t)}`;
}

/** Text for the gauge: "Context 88% used, 880k of 1M tokens". */
export function ctxText(sess) {
  if (sess.contextPercent == null) return 'Context: no data yet';
  const tk = ctxTokens(sess);
  return `Context ${Math.round(sess.contextPercent)}% used${tk != null ? `, ${fmtTokens(tk)} of ${fmtTokens(sess.contextWindow)} tokens` : ''}`;
}

/**
 * Turn the hub's reasons into chips: { key, level, text, advice }. The level of each chip comes from its own number,
 * so a critical session can still show an amber chip for a second, milder problem.
 */
export function reasonChips(sess) {
  const reasons = (sess.health && sess.health.reasons) || [];
  return reasons.map((r, i) => {
    let m;
    if ((m = /^Context (\d+)%/.exec(r))) {
      const crit = Number(m[1]) > CTX.critical;
      return { key: `ctx${i}`, level: crit ? 'critical' : 'warn', text: r, advice: crit ? 'compact now or start a fresh session' : 'compact or start a fresh session soon' };
    }
    if ((m = /^(.+? limit) (\d+)%(?:, resets (.+))?$/.exec(r))) {
      const crit = Number(m[2]) > RATE.critical;
      const reset = m[3] ? `resets ${m[3]}` : 'reset time unknown';
      return { key: `rate${i}`, level: crit ? 'critical' : 'warn', text: `${m[1]} ${m[2]}%`, advice: crit ? `${reset}; hold off on new work until then` : reset };
    }
    if (/stalled agent/.test(r)) return { key: `stall${i}`, level: 'warn', text: r, advice: 'open Threads to nudge or stop them' };
    if (/^Idle over/.test(r)) return { key: `idle${i}`, level: 'warn', text: r, advice: 'check the agents are not stuck' };
    if (/^Cost today/.test(r)) return { key: `cost${i}`, level: 'warn', text: r, advice: 'review what is spending' };
    return { key: `r${i}`, level: 'warn', text: r, advice: '' };
  });
}

/** Sessions that need attention (warn or critical), worst first. Live sessions only. */
export function summarize(sessions) {
  const live = sessions.filter(isLiveSession);
  const counts = { ok: 0, warn: 0, critical: 0 };
  for (const x of live) counts[levelOf(x)]++;
  const level = counts.critical ? 'critical' : counts.warn ? 'warn' : 'ok';
  return { live, counts, level };
}
export const sortSessions = (list) => list.slice().sort((a, b) =>
  (LEVEL_RANK[levelOf(a)] - LEVEL_RANK[levelOf(b)]) || ((b.contextPercent ?? -1) - (a.contextPercent ?? -1)) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
export function summaryText({ counts, live }) {
  if (!live.length) return 'No live sessions';
  if (!counts.critical && !counts.warn) return live.length === 1 ? 'Session healthy' : 'All sessions healthy';
  const parts = [];
  if (counts.critical) parts.push(`${counts.critical} critical`);
  if (counts.warn) parts.push(`${counts.warn} warning`);
  return parts.join(', ');
}

/* ---------- gauges ---------- */
const TAU = 2 * Math.PI;
/**
 * Context ring. `el` is an SVG with role="meter" so assistive tech reads "Context 88% used…"; the number inside is the visible text.
 * set(sess) repaints it.
 */
export function ctxRing(size = 56, { label = true, strokeW } = {}) {
  const sw = strokeW || (size >= 40 ? 6 : 3);
  const r = (size - sw) / 2, c = size / 2, circ = TAU * r;
  const track = s('circle', { class: 'ring-track', cx: c, cy: c, r, fill: 'none', 'stroke-width': sw });
  const arc = s('circle', { class: 'ring-arc', cx: c, cy: c, r, fill: 'none', 'stroke-width': sw, 'stroke-linecap': 'round',
    'stroke-dasharray': `0 ${circ}`, transform: `rotate(-90 ${c} ${c})` });
  const txt = label ? s('text', { class: 'ring-text', x: c, y: c, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, '') : null;
  const el = s('svg', { class: 'ring', viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100 }, track, arc, txt);
  return {
    el,
    set(sess) {
      const pct = sess.contextPercent;
      const lvl = ctxLevel(pct);
      el.setAttribute('class', `ring lv-${lvl}`);
      const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
      arc.setAttribute('stroke-dasharray', `${(circ * v / 100).toFixed(2)} ${circ.toFixed(2)}`);
      if (txt) setText(txt, pct == null ? '–' : `${Math.round(pct)}%`);
      setAttr(el, 'aria-valuenow', pct == null ? null : Math.round(pct));
      setAttr(el, 'aria-valuetext', ctxText(sess));
      setAttr(el, 'aria-label', 'Context window');
    },
  };
}

/** Horizontal usage bar with the same text equivalent. `set(pct, level, valueText)`. */
export function usageBar(label) {
  const fill = h('span', { class: 'bar-fill' });
  const el = h('div', { class: 'bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': label }, fill);
  return {
    el,
    set(pct, level, valueText) {
      el.className = `bar lv-${level}`;
      fill.style.width = `${pct == null ? 0 : Math.max(0, Math.min(100, pct))}%`;
      setAttr(el, 'aria-valuenow', pct == null ? null : Math.round(pct));
      setAttr(el, 'aria-valuetext', valueText);
    },
  };
}

/** Tiny area+line chart of one numeric series. Draws nothing meaningful under two points but stays a valid, labelled image. */
export function sparkline(points, { w = 132, hgt = 30, max, min = 0, label = '', cls = '' } = {}) {
  const pts = points.filter((p) => p && Number.isFinite(p.v));
  const svg = s('svg', { class: `spark ${cls}`.trim(), viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, role: 'img', 'aria-label': label });
  if (pts.length < 2) {
    svg.append(s('line', { class: 'spark-flat', x1: 0, x2: w, y1: hgt - 2, y2: hgt - 2 }));
    return svg;
  }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const hi = max != null ? max : Math.max(...pts.map((p) => p.v), min + 1e-9);
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (w - 2) + 1;
  const y = (v) => hgt - 2 - ((v - min) / Math.max(1e-9, hi - min)) * (hgt - 5);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const area = `${d} L${x(t1).toFixed(1)} ${hgt - 1} L${x(t0).toFixed(1)} ${hgt - 1} Z`;
  svg.append(s('path', { class: 'spark-area', d: area }), s('path', { class: 'spark-line', d, fill: 'none' }),
    s('circle', { class: 'spark-dot', cx: x(t1).toFixed(1), cy: y(pts[pts.length - 1].v).toFixed(1), r: 2 }));
  return svg;
}
