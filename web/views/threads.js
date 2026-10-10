// views/threads.js — live SVG graph (main → subagents) + inner view for the selected node.
import { h, s, reconcile, setText, setClass, setHidden, reducedMotion, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, onActivity, ingestActivity } from '../store.js';
import { api } from '../api.js';
import { fmtElapsed, fmtTokens, fmtUsd, fmtTime, cwdTail, agentLabel, truncate, modelInfo } from '../format.js';
import { avatar, updateAvatar, modelBadge, updateModelBadge, nowDoingLine, emptyState } from '../ui.js';
import { createTimeline } from '../timeline.js';
import { createNotesPanel } from '../notes.js';
import { navigate, setArgs, openTask } from '../router.js';

const W = 580, NODE_W = 236, NODE_H = 62, GAP = 14, PAD = 20, MAIN_X = 16, AGENT_X = W - NODE_W - 16, MAX_AGENTS = 40;
const akey = (a) => a.toolUseId || a.id;
const AGENT_STATUS = { running: 'Running', done: 'Done', failed: 'Failed', stalled: 'Stalled', waiting: 'Waiting for you' };

export function mount(container) {
  let sid = null;
  let selKey = 'main';
  let insp = null; // {key, update, destroy}
  const loaded = new Set();
  startTicker();

  /* ---------- structure ---------- */
  const picker = h('select', { class: 'select', 'aria-label': 'Session', onchange: () => choose(picker.value) });
  const sessMeta = h('div', { class: 'threads-meta mono' });
  const bar = h('div', { class: 'threads-bar' }, h('label', { class: 'field-label inline' }, icon('threads', 15), picker), sessMeta);

  const edgesG = s('g', { class: 'edges' });
  const pulsesG = s('g', { class: 'pulses' });
  const nodesG = s('g', { class: 'nodes' });
  const svg = s('svg', { class: 'graph', viewBox: `0 0 ${W} 240`, width: W, height: 240, role: 'group', 'aria-label': 'Agent graph' }, edgesG, pulsesG, nodesG);
  const legend = h('div', { class: 'graph-legend mono' },
    h('span', {}, h('i', { class: 'ldot running' }), 'running'), h('span', {}, h('i', { class: 'ldot waiting' }), 'waiting for you'), h('span', {}, h('i', { class: 'ldot stalled' }), 'stalled'),
    h('span', {}, h('i', { class: 'ldot failed' }), 'failed'), h('span', {}, h('i', { class: 'ldot done' }), 'done'));
  const graphPane = h('div', { class: 'graph-pane' }, svg, legend);
  const inspector = h('aside', { class: 'inspector', 'aria-label': 'Inner view' });
  const main = h('div', { class: 'threads-main' }, graphPane, inspector);
  const empty = h('div', { class: 'view-empty' }, emptyState({
    iconName: 'threads', title: 'No sessions yet',
    body: 'Start Claude Code with Helm installed. Pick a session here to watch its agents work and step into any of them.',
  }));
  const root = h('div', { class: 'threads' }, bar, main, empty);
  container.appendChild(root);

  /* ---------- selection ---------- */
  function sessionList() {
    const list = sel.scopedSessions();
    if (sid && !list.some((x) => x.id === sid) && state.sessions.has(sid)) list.push(state.sessions.get(sid));
    const order = { active: 0, idle: 1, ended: 2 };
    return list.sort((a, b) => (order[a.status] - order[b.status]) || (b.lastSeenAt - a.lastSeenAt));
  }

  function choose(newSid, nodeId) {
    setArgs(newSid ? (nodeId ? [newSid, nodeId] : [newSid]) : []);
  }

  function applyRoute(r) {
    const [rs, ra] = r.args;
    const list = sessionList();
    let target = rs && state.sessions.has(rs) ? rs : null;
    if (!target && rs && !state.ready) target = null;
    if (!target) {
      if (!state.ready) { sid = null; renderAll(); return; }
      const first = list[0];
      if (first) { sid = first.id; selKey = 'main'; setArgs([first.id]); return; }
    }
    const changedSession = target !== sid;
    sid = target;
    if (changedSession) { selKey = 'main'; }
    if (sid) {
      if (ra) {
        const a = sel.agentsOfSession(sid).find((x) => x.id === ra || x.toolUseId === ra);
        selKey = a ? akey(a) : (state.ready ? 'main' : selKey);
      } else selKey = 'main';
      ensureActivity(sid);
    }
    renderAll(true);
  }

  async function ensureActivity(id) {
    if (loaded.has(id)) return;
    loaded.add(id);
    try {
      const res = await api.sessionActivity(id, 200);
      ingestActivity(res.activity || []);
    } catch { loaded.delete(id); }
  }

  /* ---------- graph ---------- */
  const edgeEls = new Map();
  function pathFor(cy1, cy2) {
    const x1 = MAIN_X + NODE_W, x2 = AGENT_X;
    const mx = (x1 + x2) / 2;
    return `M${x1} ${cy1} C${mx} ${cy1} ${mx} ${cy2} ${x2} ${cy2}`;
  }

  function renderGraph() {
    const session = sid && state.sessions.get(sid);
    if (!session) return;
    const all = sel.agentsOfSession(sid);
    const agents = all.slice(-MAX_AGENTS);
    const n = agents.length;
    const H = Math.max(240, PAD * 2 + n * (NODE_H + GAP) - GAP);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', String(H));
    const mainCy = H / 2;
    const rows = [{ key: 'main', kind: 'main', session, y: mainCy - NODE_H / 2, x: MAIN_X, cy: mainCy }];
    const total = n * (NODE_H + GAP) - GAP;
    const top = (H - total) / 2;
    agents.forEach((a, i) => {
      const y = top + i * (NODE_H + GAP);
      rows.push({ key: akey(a), kind: 'agent', agent: a, y, x: AGENT_X, cy: y + NODE_H / 2 });
    });
    reconcile(nodesG, rows, (r) => r.key, makeNode, updateNode);
    reconcile(edgesG, rows.filter((r) => r.kind === 'agent'), (r) => r.key, (r) => {
      const p = s('path', { class: 'edge' });
      edgeEls.set(r.key, p);
      return p;
    }, (p, r) => {
      p.setAttribute('d', pathFor(mainCy, r.cy));
      p.setAttribute('class', `edge a-${r.agent.status}${selKey === r.key ? ' selected' : ''}`);
    });
    for (const k of Array.from(edgeEls.keys())) if (!rows.some((r) => r.key === k)) edgeEls.delete(k);
    graphPane.classList.toggle('no-agents', n === 0);
  }

  function makeNode(r) {
    const bg = s('rect', { class: 'node-bg', width: NODE_W, height: NODE_H, rx: 12 });
    const dot = s('circle', { class: 'node-dot', cx: 20, cy: 22, r: 4.5 });
    const ring = s('circle', { class: 'node-ring', cx: 20, cy: 22, r: 4.5 });
    const title = s('text', { class: 'node-title', x: 34, y: 26 });
    const sub = s('text', { class: 'node-sub', x: 16, y: 47 });
    const g = s('g', { class: 'gnode', tabindex: '0', role: 'button' }, bg, ring, dot, title, sub);
    g.__r = { title, sub, dot };
    const activate = () => {
      const row = g.__row;
      selKey = row.key;
      const rt = row.kind === 'agent' ? [sid, row.agent.id] : [sid];
      setArgs(rt);
    };
    g.addEventListener('click', activate);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
    return g;
  }

  function updateNode(g, r) {
    g.__row = r;
    const x = r.x, y = r.y;
    g.setAttribute('transform', `translate(${x} ${y})`);
    const isSel = selKey === r.key;
    const t = g.__r;
    if (r.kind === 'main') {
      const ses = r.session;
      g.setAttribute('class', `gnode main st-${ses.status}${ses.busy ? ' busy' : ''}${isSel ? ' selected' : ''}`);
      t.title.textContent = truncate(ses.title || cwdTail(ses.cwd) || ses.id, 26);
      t.sub.textContent = `${modelInfo(ses.model).label} · ${ses.busy ? 'working' : ses.status} · ${fmtTokens(ses.tokens)} tok`;
      g.setAttribute('aria-label', `Main agent, ${ses.status}`);
    } else {
      const a = r.agent;
      g.setAttribute('class', `gnode a-${a.status}${isSel ? ' selected' : ''}`);
      t.title.textContent = truncate(a.description || agentLabel(a), 26);
      t.sub.textContent = `${modelInfo(a.model).label} · ${a.status === 'waiting' ? 'waiting for you' : agentLabel(a)} · ${a.toolCount} tools`;
      g.setAttribute('aria-label', `${agentLabel(a)} ${a.status}: ${a.description}`);
    }
    g.setAttribute('aria-pressed', String(isSel));
  }

  function pulse(a) {
    if (!sid || a.sessionId !== sid) return;
    if (!a.agentId) { pingNode('main'); return; }
    const ag = sel.agentsOfSession(sid).find((x) => x.id === a.agentId);
    if (!ag) { pingNode('main'); return; }
    const key = akey(ag);
    const edge = edgeEls.get(key);
    pingNode(key);
    if (!edge) return;
    edge.classList.add('hot');
    setTimeout(() => edge.classList.remove('hot'), 800);
    if (reducedMotion()) return;
    const d = edge.getAttribute('d');
    const back = a.kind === 'tool_done';
    const c = s('circle', { class: `pulse${back ? ' back' : ''}`, r: 3.6 });
    const am = s('animateMotion', { dur: '0.85s', begin: 'indefinite', repeatCount: '1', fill: 'freeze', path: d, calcMode: 'linear', keyTimes: '0;1', keyPoints: back ? '1;0' : '0;1' });
    c.appendChild(am);
    pulsesG.appendChild(c);
    try { am.beginElement(); } catch { /* animation unsupported */ }
    setTimeout(() => c.remove(), 1000);
  }
  function pingNode(key) {
    for (const g of nodesG.children) {
      if (g.__key === key) {
        g.classList.remove('ping'); void g.getBoundingClientRect(); g.classList.add('ping');
        setTimeout(() => g.classList.remove('ping'), 800);
      }
    }
  }
  const offActivity = onActivity(pulse);

  /* ---------- inspector ---------- */
  function resolveAgent() {
    if (selKey === 'main' || !sid) return null;
    return sel.agentsOfSession(sid).find((x) => akey(x) === selKey) || null;
  }

  function buildInspector() {
    if (insp) { insp.destroy(); insp = null; }
    inspector.textContent = '';
    if (!sid) return;
    const agent = resolveAgent();
    if (selKey !== 'main' && !agent) selKey = 'main';
    insp = agent ? buildAgentInspector(akey(agent)) : buildMainInspector();
    inspector.appendChild(insp.el);
    insp.update();
    inspector.scrollTop = 0;
  }

  function buildMainInspector() {
    const id = sid;
    const r = {};
    r.pulse = h('span', { class: 'pdot' });
    r.title = h('h2', { class: 'insp-title' });
    r.state = h('span', { class: 'status-pill' });
    r.cwd = h('div', { class: 'insp-sub mono' });
    r.model = modelBadge('');
    r.stats = h('div', { class: 'stat-grid' });
    r.nd = nowDoingLine();
    const tl = createTimeline({ getRows: () => sel.activityForSession(id), empty: 'No activity yet for this session' });
    const notes = createNotesPanel({ target: { kind: 'session', id }, title: 'Session notes' });
    const el = h('div', { class: 'insp-inner' },
      h('header', { class: 'insp-head' }, h('div', { class: 'insp-kicker mono' }, icon('cpu', 13), 'Main agent'),
        h('div', { class: 'insp-title-row' }, r.pulse, r.title), r.cwd, h('div', { class: 'badge-row' }, r.model, r.state)),
      r.nd, r.stats,
      h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('terminal', 14), 'Session timeline'), tl.el),
      notes.el);
    return {
      el,
      update() {
        const ses = state.sessions.get(id);
        if (!ses) return;
        r.pulse.className = `pdot ${ses.status}${ses.busy ? ' busy' : ''}`;
        setText(r.title, ses.title || cwdTail(ses.cwd) || ses.id);
        setText(r.cwd, ses.cwd || '');
        updateModelBadge(r.model, ses.model);
        setText(r.state, ses.busy ? 'Working' : ses.status === 'active' ? 'Active' : ses.status === 'idle' ? 'Idle' : 'Ended');
        r.state.className = `status-pill s-${ses.status}`;
        r.nd.__set(ses.nowDoing, ses.status === 'active' && ses.busy);
        const agents = sel.agentsOfSession(id);
        setStats(r.stats, [
          ['Started', fmtTime(ses.startedAt)],
          ['Agents', `${agents.filter((a) => a.status === 'running').length}/${agents.length}`],
          ['Tokens', fmtTokens(ses.tokens)],
          ['Spend', fmtUsd(ses.costUsd)],
        ]);
        tl.refresh();
      },
      destroy() { notes.destroy(); },
    };
  }

  function setStats(grid, entries) {
    reconcile(grid, entries, (e) => e[0], (e) => {
      const v = h('div', { class: 'stat-v mono' });
      const el = h('div', { class: 'stat' }, v, h('div', { class: 'stat-k' }, e[0]));
      el.__v = v; return el;
    }, (el, e) => setText(el.__v, e[1]));
  }

  function buildAgentInspector(key) {
    const r = {};
    r.av = avatar(null, 'lg');
    r.title = h('h2', { class: 'insp-title' });
    r.type = h('div', { class: 'insp-sub mono' });
    r.model = modelBadge('');
    r.state = h('span', { class: 'status-pill' });
    r.nd = nowDoingLine();
    r.stats = h('div', { class: 'stat-grid' });
    r.brief = h('p', { class: 'brief-text' });
    r.taskChip = h('button', { class: 'task-chip mono', type: 'button', hidden: true });
    r.recap = h('div', { class: 'recap' });
    r.recapWrap = h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('sparkle', 14), 'Recap'), r.recap);
    r.files = h('ul', { class: 'files mono' });
    r.filesWrap = h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('file', 14), 'Files'), r.files);
    r.promptSlot = h('div', {});
    r.needs = h('div', { class: 'needs-you-banner', role: 'status', hidden: true }, h('span', { class: 'needs-ring', 'aria-hidden': 'true' }), h('div', { class: 'needs-col' }, h('strong', {}, 'Waiting for you'), h('span', { class: 'needs-text' })));
    const currentAgent = () => sel.agentsOfSession(sid).find((x) => akey(x) === key) || null;
    const tl = createTimeline({ getRows: () => { const a = currentAgent(); return a ? sel.activityForAgent(a) : []; }, empty: 'Waiting for the first tool call…' });
    let promptTask = null;
    let prompt = null;

    const el = h('div', { class: 'insp-inner' },
      h('header', { class: 'insp-head' },
        h('div', { class: 'insp-kicker mono' }, 'Subagent'),
        h('div', { class: 'insp-title-row' }, r.av, r.title), r.type,
        h('div', { class: 'badge-row' }, r.model, r.state)),
      r.needs, r.nd, r.stats,
      h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, 'Task brief', r.taskChip), r.brief),
      h('section', { class: 'sheet-section' }, h('h3', { class: 'section-title' }, icon('terminal', 14), 'Tool timeline'), tl.el),
      r.filesWrap, r.recapWrap, r.promptSlot);

    return {
      el,
      update() {
        const a = currentAgent();
        if (!a) return;
        const task = a.taskId ? state.tasks.get(a.taskId) : null;
        updateAvatar(r.av, a);
        setText(r.title, truncate(a.description || agentLabel(a), 120));
        setText(r.type, `${a.subagentType || 'agent'} · ${a.id.replace(/^pending:/, 'pending ')}`);
        updateModelBadge(r.model, a.model);
        r.state.className = `status-pill s-${a.status}`;
        setText(r.state, AGENT_STATUS[a.status] || a.status);
        const running = a.status === 'running';
        r.nd.__set(a.nowDoing, running);
        const waiting = a.status === 'waiting';
        setHidden(r.needs, !waiting);
        if (waiting) setText(r.needs.querySelector('.needs-text'), (sel.openQuestionForAgent(a.id) || {}).text || 'This agent is paused until you reply.');
        setStats(r.stats, [
          ['Started', fmtTime(a.startedAt)],
          ['Elapsed', fmtElapsed((running || waiting || a.status === 'stalled' ? Date.now() : (a.endedAt || a.lastActivityAt)) - a.startedAt)],
          ['Tools', String(a.toolCount)],
          ['Tokens', fmtTokens(a.tokens || (task && task.tokens))],
        ]);
        setText(r.brief, (task && task.description) || a.description || 'No brief recorded.');
        setHidden(r.taskChip, !task);
        if (task) { setText(r.taskChip, task.id); r.taskChip.onclick = () => openTask(task.id); }
        // files
        const files = (task && task.filesChanged) || [];
        setHidden(r.filesWrap, files.length === 0);
        reconcile(r.files, files, (f) => f, (f) => h('li', { title: f }, f), null);
        // recap
        const rc = task && task.recap;
        setHidden(r.recapWrap, !rc);
        if (rc) {
          const sig = JSON.stringify(rc);
          if (r.recap.__sig !== sig) {
            r.recap.__sig = sig;
            r.recap.textContent = '';
            for (const [k, v] of [['What', rc.what], ['How', rc.how], ['Learned', rc.learned]]) {
              r.recap.append(h('div', { class: 'recap-row' }, h('div', { class: 'recap-label' }, k), h('p', { class: 'recap-text' }, v || '—')));
            }
            if (rc.concepts && rc.concepts.length) r.recap.append(h('div', { class: 'tags' }, rc.concepts.map((c) => h('button', { class: 'tag', type: 'button', onclick: () => navigate('learn', [], { concept: c }) }, icon('tag', 12), c))));
          }
        }
        // prompt box
        const wantId = task ? task.id : null;
        if (wantId !== promptTask || !prompt && !wantId && !r.promptSlot.firstChild) {
          if (prompt) { prompt.destroy(); prompt = null; }
          r.promptSlot.textContent = '';
          promptTask = wantId;
          if (wantId) {
            prompt = createNotesPanel({ target: { kind: 'task', id: wantId }, mode: 'prompt', title: 'Prompt this task', placeholder: `Prompt ${wantId}…` });
            r.promptSlot.appendChild(prompt.el);
          } else {
            r.promptSlot.appendChild(h('div', { class: 'banner' }, icon('warning', 15), h('span', {}, 'This agent is not linked to a task, so it cannot be prompted from here.')));
          }
        }
        tl.refresh();
      },
      destroy() { if (prompt) prompt.destroy(); },
    };
  }

  /* ---------- render ---------- */
  function renderAll(selectionChanged) {
    const list = sessionList();
    const none = state.ready && list.length === 0;
    setHidden(empty, !none);
    setHidden(bar, none);
    setHidden(main, none);
    if (none || !sid) { if (insp) { insp.destroy(); insp = null; inspector.textContent = ''; } return; }
    // picker
    const sig = list.map((x) => `${x.id}|${x.title}|${x.status}`).join(';');
    if (picker.__sig !== sig) {
      picker.__sig = sig;
      picker.textContent = '';
      for (const x of list) {
        picker.appendChild(h('option', { value: x.id }, `${x.title || cwdTail(x.cwd) || x.id}  ·  ${x.status}`));
      }
    }
    if (picker.value !== sid && document.activeElement !== picker) picker.value = sid;
    const ses = state.sessions.get(sid);
    if (ses) {
      sessMeta.textContent = '';
      sessMeta.append(h('span', {}, sel.projectName(ses.projectId)), h('span', {}, cwdTail(ses.cwd, 3)),
        h('span', {}, `${sel.agentsOfSession(sid).length} agents`));
    }
    renderGraph();
    if (selectionChanged || !insp || (insp.key !== selKey)) {
      buildInspector();
      if (insp) insp.key = selKey;
    } else insp.update();
  }

  function onStore(changed) {
    if (!sid && state.ready) { applyRoute(lastRoute); return; }
    if (sid && !state.sessions.has(sid) && state.ready) { applyRoute({ args: [] }); return; }
    const ra = lastRoute.args && lastRoute.args[1];
    if (sid && ra && selKey === 'main' && sel.agentsOfSession(sid).some((x) => x.id === ra || x.toolUseId === ra)) { applyRoute(lastRoute); return; }
    if (changed.has('activity') && !(changed.has('agent') || changed.has('session') || changed.has('task') || changed.has('note'))) {
      if (insp) insp.update();
      return;
    }
    // if the selected agent was renamed/removed, fall back
    renderAll(selKey !== 'main' && !resolveAgent());
  }

  let lastRoute = { args: [] };
  return {
    watch: ['session', 'agent', 'task', 'project', 'activity', 'ui', 'ready', 'question'],
    update: onStore,
    setRoute(r) { lastRoute = r; applyRoute(r); },
    destroy() { offActivity(); if (insp) insp.destroy(); root.remove(); },
  };
}
