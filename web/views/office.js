// views/office.js — "the floor": each session is a desk, its subagents sit beside it.
import { h, reconcile, setText, setClass, setHidden, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, lsGet, lsSet, showOld } from '../store.js';
import { createOldToggle } from '../oldtoggle.js';
import { createCleanupBanner } from '../cleanup.js';
import { fmtElapsed, fmtTokens, fmtUsd, cwdTail, agentLabel, truncate, plural, sessionLabel } from '../format.js';
import { avatar, updateAvatar, modelBadge, updateModelBadge, nowDoingLine, emptyState } from '../ui.js';
import { navigate, openTask } from '../router.js';
import { api } from '../api.js';
import { ctxRing, ctxText, levelOf, LEVEL_LABEL } from '../health.js';
import { mount as mountFlow } from './officeflow.js';

const CREW_PREVIEW = 8;
const WAIT_LABEL = 'Waiting for you';
const S_ORDER = { active: 0, idle: 1, ended: 2 };

/** Conflict radar strip (v0.2): two agents editing the same file. Shared by both Office views. */
function createRadar() {
  /* ---------- conflict radar strip (v0.2) ---------- */
  const radarCount = h('span', { class: 'radar-count mono' }, '0');
  const radarChips = h('div', { class: 'radar-chips' });
  const radarQuiet = h('span', { class: 'radar-quiet' }, 'No overlapping edits');
  const radarSum = h('span', { class: 'radar-sum' }, 'no overlapping files');
  const radarChev = icon('chevronRight', 14, 'radar-chev');
  let radarOpen = lsGet('helm.office.radar', '0') === '1'; // collapsed to one line by default
  const radarHead = h('button', { class: 'radar-head radar-toggle', type: 'button', 'aria-expanded': 'false', onclick: () => { radarOpen = !radarOpen; lsSet('helm.office.radar', radarOpen ? '1' : '0'); renderRadar(); } },
    icon('radar', 15), h('span', { class: 'radar-title' }, 'Radar'), radarCount, radarSum, radarChev);
  const radar = h('section', { class: 'radar', 'aria-label': 'Conflict radar', hidden: true }, radarHead, radarChips, radarQuiet);
  let conflicts = null; // null = not loaded yet; array once known
  let radarTimer = null;
  let radarReq = 0;

  /** Fallback when /v1/conflicts is unavailable: rebuild the list from each task's `conflicts`. */
  function deriveConflicts() {
    const byPath = new Map();
    for (const t of state.tasks.values()) {
      for (const c of t.conflicts || []) {
        if (!byPath.has(c.path)) byPath.set(c.path, new Map());
        const m = byPath.get(c.path);
        m.set(t.agentId || t.id, { agentId: t.agentId, taskId: t.id, sessionId: t.sessionId, at: t.updatedAt });
        m.set(c.otherAgentId, { agentId: c.otherAgentId, taskId: c.otherTaskId, sessionId: c.otherSessionId, at: t.updatedAt });
      }
    }
    return Array.from(byPath, ([path, m]) => ({ path, agents: Array.from(m.values()) }));
  }
  async function loadRadar() {
    const my = ++radarReq;
    try {
      const res = await api.conflicts();
      if (my !== radarReq) return;
      conflicts = (res && res.conflicts) || [];
    } catch {
      if (my !== radarReq) return;
      conflicts = deriveConflicts();
    }
    renderRadar();
  }
  /** Refresh on task changes: one trailing fetch per window so a busy hub cannot starve it. */
  function scheduleRadar() {
    if (radarTimer) return;
    radarTimer = setTimeout(() => { radarTimer = null; loadRadar(); }, 800);
  }
  const conflictInScope = (c) => state.ui.projectId === 'all' || c.agents.some((a) => (state.sessions.get(a.sessionId) || {}).projectId === state.ui.projectId);
  const shortAgent = (a) => a.taskId || truncate(String(a.agentId || '').replace(/^pending:/, ''), 8);
  function renderRadar() {
    const list = (conflicts || deriveConflicts()).filter(conflictInScope);
    const show = state.ready && state.sessions.size > 0;
    setHidden(radar, !show);
    setClass(radar, 'hot', list.length > 0);
    setText(radarCount, String(list.length));
    setText(radarSum, list.length ? `${list.length} overlapping ${list.length === 1 ? 'file' : 'files'}` : 'no overlapping files');
    radarHead.setAttribute('aria-expanded', String(radarOpen));
    setClass(radar, 'open', radarOpen);
    setHidden(radarQuiet, !radarOpen || list.length > 0);
    setHidden(radarChips, !radarOpen || list.length === 0);
    reconcile(radarChips, list, (c) => c.path, (c) => {
      const b = h('button', { class: 'radar-chip', type: 'button' }, icon('warning', 13), h('span', { class: 'radar-file mono' }), h('span', { class: 'radar-who mono' }));
      return b;
    }, (b, c) => {
      const base = c.path.slice(c.path.lastIndexOf('/') + 1);
      setText(b.children[1], base);
      setText(b.children[2], c.agents.map(shortAgent).join(' ↔ '));
      b.title = `${c.path}\n${c.agents.map((a) => `${a.taskId || a.agentId} (${a.sessionId ? String(a.sessionId).slice(0, 8) : 'session'})`).join('\n')}`;
      b.onclick = () => {
        const withTask = c.agents.find((a) => a.taskId);
        if (withTask) openTask(withTask.taskId);
        else if (c.agents[0] && c.agents[0].sessionId) navigate('threads', [c.agents[0].sessionId, c.agents[0].agentId]);
      };
    });
  }

  return {
    el: radar,
    render: renderRadar,
    load: loadRadar,
    schedule: scheduleRadar,
    destroy() { clearTimeout(radarTimer); radarReq++; radar.remove(); },
  };
}

/** The desks view (the original Office): each session a desk, its subagents beside it. */
function mountDesks(container) {
  const expanded = new Set();
  const floor = h('div', { class: 'floor' });
  const empty = h('div', { class: 'view-empty' }, emptyState({
    iconName: 'office', title: 'No sessions yet',
    body: 'Start Claude Code with Helm installed — every session gets a desk here and its subagents sit beside it.',
  }));
  const oldToggle = createOldToggle('desks');
  const wrap = h('div', { class: 'desks' }, h('div', { class: 'desks-bar' }, oldToggle.el), floor, empty);
  container.appendChild(wrap);

  /* ---------- desk group ---------- */
  function makeGroup(s) {
    const r = {};
    r.pulse = h('span', { class: 'pdot' });
    r.title = h('div', { class: 'desk-title' });
    r.state = h('span', { class: 'desk-state mono' });
    r.cwd = h('div', { class: 'desk-cwd mono' });
    r.model = modelBadge('');
    r.cost = h('span', { class: 'desk-cost mono', title: 'Session spend' });
    r.tokens = h('span', { class: 'desk-tokens mono' });
    r.nd = nowDoingLine();
    r.ring = ctxRing(20, { label: false, strokeW: 3 });
    r.ringWrap = h('span', { class: 'desk-ring' }, r.ring.el);
    r.open = h('button', { class: 'desk-open', type: 'button', 'aria-label': 'Open session thread', onclick: () => navigate('threads', [r.s.id]) });
    r.desk = h('div', { class: 'desk' },
      h('div', { class: 'desk-top' }, r.pulse, r.title, r.ringWrap, r.state),
      r.cwd,
      h('div', { class: 'desk-badges' }, r.model, h('span', { class: 'spacer' }), r.tokens, r.cost),
      r.nd, r.open);
    r.crew = h('div', { class: 'crew' });
    r.more = h('button', { class: 'crew-more', type: 'button', onclick: () => { expanded.has(r.s.id) ? expanded.delete(r.s.id) : expanded.add(r.s.id); render(); } });
    r.crewWrap = h('div', { class: 'crew-wrap' }, r.crew, r.more);
    const g = h('section', { class: 'desk-group' }, r.desk, r.crewWrap);
    g.__r = r;
    return g;
  }

  function updateGroup(g, s) {
    const r = g.__r;
    r.s = s;
    const waiting = sel.sessionWaiting(s.id);
    const lvl = levelOf(s);
    g.className = `desk-group st-${s.status}${s.busy ? ' busy' : ''}${waiting ? ' needs-you' : ''}${lvl !== 'ok' ? ` hl-${lvl}` : ''}`;
    // v0.14: a tiny context ring in the health colour (its text equivalent is the tooltip and the meter's aria-valuetext)
    setHidden(r.ringWrap, s.contextPercent == null || s.status === 'ended');
    r.ring.set(s);
    r.ringWrap.title = `${ctxText(s)}. Health: ${LEVEL_LABEL[lvl].toLowerCase()}${(s.health && s.health.reasons.length) ? ' (' + s.health.reasons.join('; ') + ')' : ''}`;
    r.pulse.className = `pdot ${s.status}${s.busy ? ' busy' : ''}`;
    setText(r.title, sessionLabel(s));
    setText(r.state, waiting ? WAIT_LABEL.toLowerCase() : s.busy ? 'working' : s.status);
    setText(r.cwd, cwdTail(s.cwd, 3));
    r.cwd.title = s.cwd || '';
    updateModelBadge(r.model, s.model);
    setText(r.tokens, `${fmtTokens(s.tokens)} tok`);
    setText(r.cost, fmtUsd(s.costUsd));
    r.nd.__set(s.nowDoing, s.status === 'active' && s.busy);
    // crew
    const all = sel.agentsOfSession(s.id);
    const isLive = (a) => a.status === 'running' || a.status === 'stalled' || a.status === 'waiting';
    const live = all.filter(isLive);
    const rest = all.filter((a) => !isLive(a)).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const ordered = [...live.sort((a, b) => a.startedAt - b.startedAt), ...rest];
    const isExp = expanded.has(s.id);
    const shown = isExp ? ordered : ordered.slice(0, CREW_PREVIEW);
    reconcile(r.crew, shown, (a) => a.toolUseId || a.id, makeAgent, updateAgent);
    setHidden(r.more, ordered.length <= CREW_PREVIEW);
    setText(r.more, isExp ? 'Show fewer' : `+${ordered.length - CREW_PREVIEW} earlier`);
    setClass(r.crewWrap, 'none', ordered.length === 0);
    r.crew.dataset.empty = 'No subagents';
  }

  /* ---------- agent card ---------- */
  function makeAgent(a) {
    const r = {};
    r.status = h('span', { class: 'astat' });
    r.avatar = avatar(a, 'sm');
    r.name = h('span', { class: 'agent-card-name' });
    r.model = modelBadge('');
    r.desc = h('div', { class: 'agent-card-desc' });
    r.nd = nowDoingLine();
    r.tools = h('span', { class: 'mono' });
    r.time = h('span', { class: 'mono' });
    r.stat = h('span', { class: 'mono agent-card-state' });
    const el = h('button', { class: 'agent-card', type: 'button', onclick: () => navigate('threads', [el.__a.sessionId, el.__a.id]) },
      h('div', { class: 'agent-card-top' }, r.avatar, r.name, r.model, h('span', { class: 'spacer' }), r.status),
      r.desc, r.nd,
      h('div', { class: 'agent-card-foot' }, r.stat, h('span', { class: 'spacer' }), r.tools, r.time));
    el.__r = r;
    return el;
  }

  function updateAgent(el, a) {
    const r = el.__r;
    el.__a = a;
    el.className = `agent-card a-${a.status}`;
    updateAvatar(r.avatar, a);
    setText(r.name, agentLabel(a));
    updateModelBadge(r.model, a.model);
    setText(r.desc, truncate(a.description || '', 80));
    r.desc.title = a.description || '';
    const running = a.status === 'running';
    const waiting = a.status === 'waiting';
    r.nd.__set(waiting ? ((sel.openQuestionForAgent(a.id) || {}).text || 'Waiting for your input') : a.nowDoing, running);
    r.status.className = `astat ${a.status}`;
    r.status.textContent = '';
    if (a.status === 'done') r.status.appendChild(icon('check', 13));
    else if (a.status === 'failed') r.status.appendChild(icon('close', 13));
    else if (a.status === 'stalled') r.status.appendChild(icon('clock', 13));
    setText(r.stat, waiting ? WAIT_LABEL : a.status);
    setText(r.tools, `${a.toolCount} tools`);
    if (running || a.status === 'stalled' || waiting) {
      r.time.setAttribute('data-since', a.startedAt);
      setText(r.time, fmtElapsed(Date.now() - a.startedAt));
    } else {
      r.time.removeAttribute('data-since');
      setText(r.time, fmtElapsed((a.endedAt || a.lastActivityAt) - a.startedAt));
    }
    el.setAttribute('aria-label', `${agentLabel(a)} ${waiting ? WAIT_LABEL.toLowerCase() : a.status}: ${a.description || ''}. Open thread`);
  }

  /* ---------- sections ---------- */
  function makeSection(sec) {
    const title = h('h2', { class: 'floor-title' });
    const grid = h('div', { class: 'desk-grid' });
    const el = h('section', { class: 'floor-section' }, title, grid);
    el.__r = { title, grid };
    return el;
  }
  function updateSection(el, sec) {
    const r = el.__r;
    setHidden(r.title, !sec.showTitle);
    setText(r.title, sec.name);
    const sessions = sec.sessions.sort((a, b) => (S_ORDER[a.status] - S_ORDER[b.status]) || (b.lastSeenAt - a.lastSeenAt));
    reconcile(r.grid, sessions, (s) => s.id, makeGroup, updateGroup);
  }

  function render() {
    const sessions = sel.scopedSessions(showOld('desks'));
    oldToggle.set(sel.oldSessionCount());
    const byProject = new Map();
    for (const s of sessions) {
      if (!byProject.has(s.projectId)) byProject.set(s.projectId, []);
      byProject.get(s.projectId).push(s);
    }
    const secs = Array.from(byProject.entries())
      .map(([pid, list]) => ({ key: pid, name: sel.projectName(pid), sessions: list, showTitle: state.ui.projectId === 'all' && byProject.size > 1 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    reconcile(floor, secs, (x) => x.key, makeSection, updateSection);
    setHidden(empty, !(state.ready && sessions.length === 0));
    setHidden(floor, sessions.length === 0);
  }
  render();

  return {
    watch: ['session', 'agent', 'project', 'ui', 'ready', 'question'],
    update() { render(); },
    destroy() { wrap.remove(); },
  };
}

const VIEW_KEY = 'helm.office.view';

export function mount(container) {
  startTicker();
  let mode = lsGet(VIEW_KEY, 'flow') === 'desks' ? 'desks' : 'flow';
  let child = null;
  const radar = createRadar();
  const host = h('div', { class: 'office-host' });
  const segBtn = (label, value, title) => h('button', { class: 'th-seg-btn', type: 'button', 'data-v': value, 'aria-pressed': 'false', title, onclick: () => setMode(value) }, label);
  const seg = h('div', { class: 'th-seg', role: 'group', 'aria-label': 'Office view' },
    segBtn('Flow', 'flow', 'Flow: the main session, the others and their subagents as a live graph'),
    segBtn('Desks', 'desks', 'Desks: every session as a desk with its subagents beside it'));
  const bar = h('div', { class: 'office-bar' }, seg);
  const cleanup = createCleanupBanner();
  const wrap = h('div', { class: 'office', 'data-mode': mode }, cleanup.el, bar, radar.el, host);
  container.appendChild(wrap);

  function setMode(m) {
    if (child && m === mode) return;
    if (child) { try { child.destroy(); } catch (e) { console.error(e); } child = null; }
    host.textContent = '';
    mode = m;
    lsSet(VIEW_KEY, m);
    wrap.setAttribute('data-mode', m);
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === m));
    child = (m === 'flow' ? mountFlow : mountDesks)(host);
  }
  setMode(mode);
  radar.render();
  radar.load();

  return {
    watch: ['session', 'agent', 'project', 'ui', 'ready', 'task', 'question', 'link'],
    update(changed) {
      if (changed.has('task') || changed.has('agent')) radar.schedule();
      // task-only changes only touch the radar strip, not the graph or the desks
      if (['session', 'agent', 'ui', 'ready'].some((k) => changed.has(k))) radar.render();
      const w = child && child.watch;
      if (child && (!w || w.some((k) => changed.has(k)))) child.update(changed);
    },
    setRoute() {},
    destroy() { if (child) child.destroy(); radar.destroy(); cleanup.destroy(); wrap.remove(); },
  };
}
