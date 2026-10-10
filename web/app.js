// app.js — shell: sidebar, topbar telemetry, router wiring, theme, shortcuts.
import { h, $, setText, setClass, setHidden, bus, startTicker } from './dom.js';
import { icon } from './icons.js';
import { state, sel, subscribe, connect, setUI, lsGet, lsSet } from './store.js';
import { fmtTokens, fmtUsd, fmtUsdSmall, fmtClock, plural } from './format.js';
import { toggleMeter } from './meter.js';
import { openMenu, emptyState } from './ui.js';
import { route, onRoute, navigate, VIEWS } from './router.js';
import { createSheet } from './views/sheet.js';
import { createTalkSheet } from './views/talk.js';
import { createSpotlight } from './spotlight.js';
import * as board from './views/board.js';
import * as projects from './views/projects.js';
import * as office from './views/office.js';
import * as threads from './views/threads.js';
import * as learn from './views/learn.js';
import * as inbox from './views/inbox.js';

const VIEW_MODS = { board, projects, office, threads, inbox, learn };
const VIEW_META = {
  board: { label: 'Board', icon: 'board' },
  projects: { label: 'Projects', icon: 'folder' },
  office: { label: 'Office', icon: 'office' },
  threads: { label: 'Threads', icon: 'threads' },
  inbox: { label: 'Inbox', icon: 'inbox' },
  learn: { label: 'Learn', icon: 'learn' },
};

const appEl = $('#app');
const sidebar = $('#sidebar');
const topbar = $('#topbar');
const viewEl = $('#view');

/* ---------- theme + sidebar prefs ---------- */
const THEMES = ['system', 'light', 'dark'];
let theme = lsGet('helm.theme', 'system');
if (!THEMES.includes(theme)) theme = 'system';
function applyTheme() {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
  lsSet('helm.theme', theme === 'system' ? null : theme);
  if (themeBtn) {
    themeBtn.textContent = '';
    themeBtn.append(icon(theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'auto', 18));
    themeBtn.title = `Theme: ${theme} (click to change)`;
    themeBtn.setAttribute('aria-label', `Theme: ${theme}. Switch theme`);
  }
}
function cycleTheme() { theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; applyTheme(); }

let collapsed = lsGet('helm.sidebar') === 'collapsed';
function applySidebar() {
  document.documentElement.setAttribute('data-sidebar', collapsed ? 'collapsed' : 'expanded');
  lsSet('helm.sidebar', collapsed ? 'collapsed' : 'expanded');
  if (collapseBtn) {
    collapseBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    collapseBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
  }
}
function toggleSidebar() { collapsed = !collapsed; applySidebar(); }
bus.on('toggle-theme', cycleTheme);
bus.on('toggle-sidebar', toggleSidebar);

/* ---------- sidebar ---------- */
const spotlight = createSpotlight($('#spotlight-root'));
const sheet = createSheet($('#sheet-root'));
const talk = createTalkSheet($('#sheet-root'));
bus.on('open-talk', (sessionId) => talk.open(typeof sessionId === 'string' ? sessionId : undefined));

const psName = h('span', { class: 'ps-name' }, 'All projects');
const psSub = h('span', { class: 'ps-sub mono' }, '');
const projSwitch = h('button', { class: 'proj-switch', type: 'button', 'aria-haspopup': 'menu', onclick: () => openProjectMenu() },
  h('span', { class: 'ps-glyph' }, icon('folder', 17)),
  h('span', { class: 'ps-text' }, h('span', { class: 'ps-label' }, 'Project'), psName),
  icon('chevrons', 15, 'ps-chev'));
const searchBtn = h('button', { class: 'sb-search', type: 'button', 'aria-label': 'Search (Command K)', onclick: () => spotlight.open() },
  icon('search', 16), h('span', { class: 'sb-label' }, 'Search'), h('kbd', { class: 'kbd sb-label' }, '⌘K'));
const navBadges = {};
const navItems = VIEWS.map((v) => {
  const badge = h('span', { class: 'nav-badge mono', hidden: true });
  navBadges[v] = badge;
  return h('a', { class: 'nav-item', href: `#/${v}`, 'data-view': v, title: VIEW_META[v].label },
    icon(VIEW_META[v].icon, 18), h('span', { class: 'nav-label sb-label' }, VIEW_META[v].label), badge);
});
const themeBtn = h('button', { class: 'icon-btn', type: 'button', onclick: cycleTheme });
const collapseBtn = h('button', { class: 'icon-btn collapse-btn', type: 'button', onclick: toggleSidebar }, icon('sidebar', 18));
sidebar.append(
  h('div', { class: 'sb-brand' }, h('span', { class: 'brand-mark' }, icon('circle', 18)), h('span', { class: 'brand-name sb-label' }, 'Helm')),
  h('div', { class: 'sb-top' }, projSwitch),
  searchBtn,
  h('nav', { class: 'sb-nav', 'aria-label': 'Views' }, navItems),
  h('div', { class: 'sb-foot' }, themeBtn, h('span', { class: 'spacer' }), collapseBtn));

function openProjectMenu() {
  const ps = sel.projects();
  const countSessions = (id) => sel.sessions().filter((s) => s.projectId === id).length;
  const items = [
    { label: 'All projects', sub: plural(state.sessions.size, 'session'), icon: 'folder', active: state.ui.projectId === 'all', onSelect: () => setUI({ projectId: 'all' }) },
    ...(ps.length ? [{ divider: true }] : []),
    ...ps.map((p) => ({ label: p.name, sub: plural(countSessions(p.id), 'session'), icon: 'folder', active: state.ui.projectId === p.id, onSelect: () => setUI({ projectId: p.id }) })),
    { divider: true },
    { label: 'Manage projects…', icon: 'plus', onSelect: () => navigate('projects') },
  ];
  openMenu(projSwitch, items, { minWidth: 248 });
}

/* ---------- topbar + telemetry ---------- */
const titleEl = h('h1', { class: 'tb-title' }, 'Board');
const scopeEl = h('span', { class: 'tb-scope' }, 'All projects');
const connDot = h('span', { class: 'conn-dot' });
const connText = h('span', { class: 'conn-text' }, 'connecting');
const connEl = h('span', { class: 'conn', role: 'status', 'aria-live': 'polite' }, connDot, connText);
const tSess = h('span', { class: 'tele-v' }, '0');
const tAgents = h('span', { class: 'tele-v' }, '0');
const tTok = h('span', { class: 'tele-v' }, '0');
const tCost = h('span', { class: 'tele-v' }, '$0.00');
const tHelm = h('span', { class: 'tele-v' }, '$0.000');
const helmBtn = h('button', {
  class: 'tele tele-helm', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
  title: 'What Helm itself spends today (click for details)', onclick: () => toggleMeter(helmBtn),
}, h('span', { class: 'tele-k' }, 'Helm'), tHelm, h('span', { class: 'tele-k tele-helm-k' }, 'today'));
const tClock = h('span', { class: 'tele-v clock' }, fmtClock());
const telemetry = h('div', { class: 'telemetry mono', 'aria-label': 'Telemetry' },
  connEl,
  h('span', { class: 'tele' }, tSess, h('span', { class: 'tele-k' }, 'sessions')),
  h('span', { class: 'tele' }, tAgents, h('span', { class: 'tele-k' }, 'agents')),
  h('span', { class: 'tele' }, tTok, h('span', { class: 'tele-k' }, 'tokens today')),
  h('span', { class: 'tele tele-cost' }, tCost, h('span', { class: 'tele-k' }, 'today')),
  helmBtn,
  h('span', { class: 'tele' }, tClock));
const talkBtn = h('button', { class: 'btn btn-quiet talk-btn', type: 'button', title: 'Talk to a session (T)', 'aria-label': 'Talk to a session', onclick: () => talk.toggle() },
  icon('chat', 16), h('span', { class: 'sb-label-narrow' }, 'Talk'), h('kbd', { class: 'kbd sb-label-narrow' }, 'T'));
const newTaskBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => newTask() }, icon('plus', 16), h('span', { class: 'sb-label-narrow' }, 'New task'));
topbar.append(h('div', { class: 'tb-left' }, titleEl, scopeEl), h('span', { class: 'spacer' }), telemetry, talkBtn, newTaskBtn);

function newTask() {
  if (route().view !== 'board') navigate('board');
  setTimeout(() => bus.emit('new-task'), 30);
}

function renderChrome() {
  const t = sel.telemetry();
  setText(tSess, String(t.active));
  setText(tAgents, String(t.agents));
  setText(tTok, fmtTokens(t.tokens));
  setText(tCost, fmtUsd(t.cost));
  setText(tHelm, fmtUsdSmall((state.usageToday && state.usageToday.overheadUsd) || 0));
  const proj = sel.scopeProject();
  setText(psName, proj ? proj.name : 'All projects');
  setText(scopeEl, proj ? proj.name : 'All projects');
  connEl.className = `conn ${state.conn}`;
  setText(connText, state.conn === 'live' ? 'live' : state.conn === 'reconnecting' ? 'reconnecting' : 'connecting');
  // nav badges
  const blocked = sel.scopedTasks().filter((x) => x.status === 'blocked').length;
  const running = Array.from(state.agents.values()).filter((a) => a.status === 'running' && (state.ui.projectId === 'all' || (state.sessions.get(a.sessionId) || {}).projectId === state.ui.projectId)).length;
  badge('board', blocked, 'red', `${blocked} blocked`);
  badge('office', running, 'accent', `${running} running`);
  const waiting = sel.openQuestions().length;
  badge('inbox', waiting, 'indigo', `${waiting} waiting for you`);
}
function badge(v, n, tone, title) {
  const b = navBadges[v];
  setHidden(b, !n);
  setText(b, String(n));
  b.className = `nav-badge mono ${tone}`;
  b.title = title;
}

startTicker();
setInterval(() => setText(tClock, fmtClock()), 1000);

/* ---------- views ---------- */
let view = null;
let viewName = null;
const bootEl = h('div', { class: 'boot' }, emptyState({ iconName: 'pulse', title: 'Connecting to Helm…', body: 'Waiting for the local hub on this machine.' }));

function applyRoute(r) {
  if (viewName !== r.view) {
    if (view) { try { view.destroy(); } catch (e) { console.error(e); } }
    viewEl.textContent = '';
    viewEl.setAttribute('data-view', r.view);
    viewEl.scrollTop = 0;
    viewName = r.view;
    try { view = VIEW_MODS[r.view].mount(viewEl, r); }
    catch (e) { console.error(e); view = null; viewEl.appendChild(h('div', { class: 'banner banner-red' }, `Could not render ${r.view}: ${e.message}`)); }
    if (!state.ready) viewEl.appendChild(bootEl);
  }
  if (view && view.setRoute) view.setRoute(r);
  sheet.show(r.task);
  for (const a of navItems) {
    const on = a.getAttribute('data-view') === r.view;
    setClass(a, 'active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  setText(titleEl, VIEW_META[r.view].label);
  document.title = `${VIEW_META[r.view].label} · Helm`;
}

onRoute(applyRoute);

subscribe((changed) => {
  renderChrome();
  if (changed.has('ready') && state.ready) bootEl.remove();
  if (view && view.update) {
    const w = view.watch;
    if (!w || w.some((k) => changed.has(k))) {
      try { view.update(changed); } catch (e) { console.error('[helm] view update failed', e); }
    }
  }
  if (changed.has('conn') && state.conn !== 'live' && !state.ready) {
    setText($('.empty-title', bootEl), state.conn === 'reconnecting' ? 'Can’t reach the Helm hub' : 'Connecting to Helm…');
    setText($('.empty-body', bootEl), state.conn === 'reconnecting' ? 'Retrying with backoff. Start it with: node hub/helmd.mjs' : 'Waiting for the local hub on this machine.');
  }
});

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); spotlight.toggle(); return; }
  const tag = (e.target && e.target.tagName) || '';
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
  if (typing || e.metaKey || e.ctrlKey || e.altKey || spotlight.isOpen) return;
  if (e.key === '/') { e.preventDefault(); spotlight.open(); }
  else if (e.key === 'n') { e.preventDefault(); newTask(); }
  else if (e.key === 't') { e.preventDefault(); talk.toggle(); }
  else if (e.key === '>') { e.preventDefault(); spotlight.open('>'); }
});

/* ---------- boot ---------- */
applyTheme();
applySidebar();
renderChrome();
applyRoute(route());
connect().catch((e) => console.error(e));

/* ---------- self-update: reload when the hub serves newer web files ---------- */
let loadedBuild = null;
async function checkBuild() {
  try {
    const { webBuild } = await fetch('/v1/health', { cache: 'no-store' }).then((r) => r.json());
    if (!webBuild) return;
    if (loadedBuild === null) loadedBuild = webBuild;
    else if (webBuild !== loadedBuild) location.reload();
  } catch { /* hub briefly down: try again next time */ }
}
checkBuild();
setInterval(checkBuild, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkBuild(); });
