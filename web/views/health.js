// views/health.js — v0.14 Session health: one card per live session, critical first.
// Context gauge + 24h sparkline, 5-hour / 7-day limit bars, cost today, busy / idle, agent counts, and reason chips with advice.
import { h, reconcile, setText, setClass, setHidden, setAttr, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel } from '../store.js';
import { api } from '../api.js';
import { fmtTokens, fmtUsd, cwdTail, plural, sessionLabel } from '../format.js';
import { modelBadge, updateModelBadge, emptyState } from '../ui.js';
import { navigate } from '../router.js';
import {
  LEVEL_LABEL, levelOf, ctxLevel, rateLevel, ctxText, ctxTokens, rateLabel, fmtReset, reasonChips,
  summarize, sortSessions, summaryText, ctxRing, usageBar, sparkline,
} from '../health.js';

const REFRESH_MS = 60_000;
const LEVEL_ICON = { ok: 'checkCircle', warn: 'warning', critical: 'warning' };

export function mount(container) {
  startTicker();
  const history = new Map(); // session id -> { at, data }  (GET /v1/sessions/:id/health)
  const inflight = new Set();
  let timer = null;

  const sum = h('p', { class: 'hl-sum', role: 'status' });
  const sumDot = h('span', { class: 'hl-sum-dot' });
  const head = h('div', { class: 'hl-head' },
    h('h2', { class: 'hl-title' }, icon('heartPulse', 18), 'Session health'),
    h('span', { class: 'hl-summary' }, sumDot, sum),
    h('span', { class: 'hl-hint' }, 'Context, limits, spend and stalls for every live session. Warnings show before you hit a wall.'));
  const grid = h('div', { class: 'hl-grid' });
  const empty = h('div', { class: 'view-empty' }, emptyState({
    iconName: 'heartPulse', title: 'No live sessions',
    body: 'When a Claude Code session is running with Helm installed, its context use, rate limits and cost show up here.',
  }));
  const root = h('div', { class: 'health' }, head, grid, empty);
  container.appendChild(root);

  /* ---------- card ---------- */
  function makeCard(sess) {
    const r = {};
    r.pdot = h('span', { class: 'pdot' });
    r.title = h('div', { class: 'hc-title' });
    r.sub = h('div', { class: 'hc-sub mono' });
    r.model = modelBadge('');
    r.pill = h('span', { class: 'hc-pill' }, h('span', { class: 'hc-pill-icon' }), h('span', { class: 'hc-pill-text' }));
    r.chips = h('ul', { class: 'hc-chips', 'aria-label': 'Warnings' });

    // context
    r.ring = ctxRing(64);
    r.ctxBig = h('div', { class: 'hc-big mono' });
    r.ctxSub = h('div', { class: 'hc-subtle mono' });
    r.ctxSpark = h('div', { class: 'hc-spark' });
    const ctxBox = h('section', { class: 'hc-box hc-ctx', 'aria-label': 'Context window' },
      h('h3', { class: 'hc-k' }, 'Context'),
      h('div', { class: 'hc-ctx-row' }, r.ring.el, h('div', { class: 'hc-ctx-text' }, r.ctxBig, r.ctxSub)),
      r.ctxSpark);

    // limits
    r.limits = h('div', { class: 'hc-limits' });
    r.limitsEmpty = h('div', { class: 'hc-subtle' }, 'No rate-limit data yet');
    const limBox = h('section', { class: 'hc-box', 'aria-label': 'Rate limits' }, h('h3', { class: 'hc-k' }, 'Usage limits'), r.limits, r.limitsEmpty);

    // cost
    r.cost = h('div', { class: 'hc-big mono' });
    r.costSub = h('div', { class: 'hc-subtle mono' });
    r.costSpark = h('div', { class: 'hc-spark' });
    const costBox = h('section', { class: 'hc-box', 'aria-label': 'Cost' },
      h('h3', { class: 'hc-k' }, 'Cost today'), r.cost, r.costSub, r.costSpark);

    // footer
    r.state = h('span', { class: 'hc-state mono' });
    r.agents = h('button', { class: 'hc-agents btn btn-quiet btn-sm', type: 'button' }, icon('threads', 14), h('span', { class: 'hc-agents-text' }));
    const foot = h('footer', { class: 'hc-foot' }, r.state, h('span', { class: 'spacer' }), r.agents);

    const el = h('article', { class: 'hc', 'data-id': sess.id },
      h('header', { class: 'hc-head' }, r.pdot, h('div', { class: 'hc-ttl' }, r.title, r.sub), r.model, r.pill),
      r.chips,
      h('div', { class: 'hc-metrics' }, ctxBox, limBox, costBox),
      foot);
    el.__r = r;
    r.agents.addEventListener('click', () => navigate('threads', [el.__s.id]));
    r.bars = new Map(); // limit kind -> { row, bar, label, reset }
    return el;
  }

  function seriesOf(samples, pick) {
    return (samples || []).map((p) => ({ t: p.at, v: pick(p) })).filter((p) => p.v != null);
  }

  function updateCard(el, sess) {
    const r = el.__r;
    el.__s = sess;
    const lvl = levelOf(sess);
    el.className = `hc lv-${lvl}${sess.status === 'idle' ? ' is-idle' : ''}`;
    el.toggleAttribute('data-busy', !!sess.busy);
    r.pdot.className = `pdot ${sess.status}${sess.busy ? ' busy' : ''}`;
    setText(r.title, sessionLabel(sess));
    setText(r.sub, `${sel.projectName(sess.projectId)}${sess.cwd ? ' · ' + cwdTail(sess.cwd, 2) : ''}`);
    updateModelBadge(r.model, sess.model);
    r.pill.className = `hc-pill lv-${lvl}`;
    r.pill.firstChild.textContent = '';
    r.pill.firstChild.append(icon(LEVEL_ICON[lvl], 13));
    setText(r.pill.lastChild, LEVEL_LABEL[lvl]);

    // reason chips with one-line advice
    const chips = reasonChips(sess);
    setHidden(r.chips, chips.length === 0);
    reconcile(r.chips, chips, (c) => c.key, () => h('li', { class: 'hc-chip' }, h('span', { class: 'hc-chip-icon' }), h('strong', { class: 'hc-chip-text' }), h('span', { class: 'hc-chip-advice' })),
      (li, c) => {
        li.className = `hc-chip lv-${c.level}`;
        if (li.__ic !== c.level) { li.__ic = c.level; li.firstChild.textContent = ''; li.firstChild.append(icon('warning', 14)); }
        setText(li.children[1], c.text);
        setText(li.children[2], c.advice ? `: ${c.advice}` : '');
        li.title = c.advice ? `${c.text}: ${c.advice}` : c.text;
      });

    // context
    r.ring.set(sess);
    const tk = ctxTokens(sess);
    setText(r.ctxBig, sess.contextPercent == null ? 'No data' : `${Math.round(sess.contextPercent)}%`);
    setText(r.ctxSub, tk != null ? `${fmtTokens(tk)} / ${fmtTokens(sess.contextWindow)} tokens` : `${fmtTokens(sess.tokens)} tokens in total`);
    setAttr(r.ctxBig, 'data-level', ctxLevel(sess.contextPercent));

    // limits
    const kindRank = (k) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2);
    const limits = (sess.rateLimits || []).slice().sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
    setHidden(r.limitsEmpty, limits.length > 0);
    reconcile(r.limits, limits, (l) => l.kind, (l) => {
      const label = h('span', { class: 'hc-lim-label' });
      const pct = h('span', { class: 'hc-lim-pct mono' });
      const reset = h('span', { class: 'hc-lim-reset mono' });
      const bar = usageBar(`${rateLabel(l.kind)} limit`);
      const row = h('div', { class: 'hc-lim' }, h('div', { class: 'hc-lim-top' }, label, pct), bar.el, reset);
      row.__p = { label, pct, reset, bar };
      return row;
    }, (row, l) => {
      const p = row.__p;
      const lv = rateLevel(l.percentUsed);
      const rs = l.resetsAt ? fmtReset(l.resetsAt) : '';
      setText(p.label, `${rateLabel(l.kind)} limit`);
      setText(p.pct, `${Math.round(l.percentUsed)}%`);
      setText(p.reset, rs ? `resets ${rs}` : 'reset time unknown');
      p.bar.set(l.percentUsed, lv, `${Math.round(l.percentUsed)}% used${rs ? `, resets ${rs}` : ''}`);
    });

    // cost
    setText(r.cost, fmtUsd(sess.costToday ?? sess.costUsd));
    const data = (history.get(sess.id) || {}).data;
    setText(r.costSub, data ? `${fmtUsd(data.cost24h)} in 24h · ${fmtUsd(sess.costUsd)} session` : `${fmtUsd(sess.costUsd)} session`);

    // state
    if (sess.busy) {
      if (r.state.dataset.mode !== 'busy') { r.state.textContent = ''; r.state.dataset.mode = 'busy'; r.state.append('Working for ', h('span', {}, '')); }
      r.state.lastChild.setAttribute('data-since', sess.busySince || sess.lastSeenAt);
    } else {
      const ref = sess.lastTurnAt || sess.startedAt;
      if (r.state.dataset.mode !== 'idle') { r.state.textContent = ''; r.state.dataset.mode = 'idle'; r.state.append(h('span', { 'data-ago': ref, 'data-ago-prefix': 'Idle · last turn ' }, '')); }
      const span = r.state.firstChild; span.setAttribute('data-ago', ref);
      if (!sess.lastTurnAt) span.setAttribute('data-ago-prefix', 'Idle · started ');
    }

    // agents
    const agents = sel.agentsOfSession(sess.id);
    const running = agents.filter((a) => a.status === 'running').length;
    const stalled = agents.filter((a) => a.status === 'stalled').length;
    const txt = `${running} running${stalled ? ` · ${stalled} stalled` : ''}`;
    setText(r.agents.lastChild, txt);
    setClass(r.agents, 'has-stalled', stalled > 0);
    r.agents.setAttribute('aria-label', `${plural(running, 'agent')} running, ${stalled} stalled. Open Threads for this session`);

    paintSparks(el, sess);
  }

  function paintSparks(el, sess) {
    const r = el.__r;
    const data = (history.get(sess.id) || {}).data;
    const samples = data ? data.samples : [];
    const key = `${samples.length}:${samples.length ? samples[samples.length - 1].at : 0}:${sess.contextPercent}:${sess.costToday}`;
    if (r.sparkKey === key) return;
    r.sparkKey = key;
    const pcts = seriesOf(samples, (p) => p.percent);
    const costs = seriesOf(samples, (p) => p.costUsd);
    const first = pcts[0], last = pcts[pcts.length - 1];
    r.ctxSpark.textContent = '';
    r.ctxSpark.append(sparkline(pcts, {
      max: 100, label: pcts.length > 1 ? `Context over the last 24 hours: from ${Math.round(first.v)}% to ${Math.round(last.v)}%` : 'Context over the last 24 hours: not enough samples yet',
      cls: `lv-${ctxLevel(sess.contextPercent)}`,
    }), h('span', { class: 'hc-spark-k mono' }, '24h'));
    r.costSpark.textContent = '';
    r.costSpark.append(sparkline(costs, {
      min: costs.length ? Math.min(...costs.map((p) => p.v)) : 0, cls: 'neutral',
      label: costs.length > 1 ? `Session cost over the last 24 hours: from ${fmtUsd(costs[0].v)} to ${fmtUsd(costs[costs.length - 1].v)}` : 'Session cost over the last 24 hours: not enough samples yet',
    }), h('span', { class: 'hc-spark-k mono' }, '24h'));
  }

  /* ---------- data ---------- */
  async function loadHistory(id) {
    if (inflight.has(id)) return;
    inflight.add(id);
    try {
      const data = await api.sessionHealth(id, 24);
      history.set(id, { at: Date.now(), data });
      const el = grid.__keyed && grid.__keyed.get(id);
      const sess = state.sessions.get(id);
      if (el && sess) updateCard(el, sess);
    } catch { /* the card still shows live numbers without a sparkline */ }
    finally { inflight.delete(id); }
  }
  function refreshStale(force) {
    const now = Date.now();
    for (const sess of sel.scopedSessions()) {
      if (!(sess.status === 'active' || sess.status === 'idle')) continue;
      const hit = history.get(sess.id);
      if (force || !hit || now - hit.at >= REFRESH_MS) loadHistory(sess.id);
    }
  }

  function render() {
    const scoped = sel.scopedSessions();
    const { live, counts, level } = summarize(scoped);
    const list = sortSessions(live);
    reconcile(grid, list, (x) => x.id, makeCard, updateCard);
    setHidden(grid, list.length === 0);
    setHidden(empty, !(state.ready && list.length === 0));
    setHidden(head, list.length === 0 && !state.ready);
    sumDot.className = `hl-sum-dot lv-${level}`;
    setText(sum, summaryText({ counts, live }));
    refreshStale(false);
  }
  render();
  timer = setInterval(() => refreshStale(true), REFRESH_MS);

  return {
    watch: ['session', 'agent', 'project', 'ui', 'ready'],
    update: render,
    setRoute() {},
    destroy() { clearInterval(timer); root.remove(); },
  };
}
