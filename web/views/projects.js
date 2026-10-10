// views/projects.js — project grid: counts, segmented task bar, sessions with "Move to project…".
import { h, reconcile, setText, setClass, setHidden, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, setUI } from '../store.js';
import { createProject, patchProject, archiveProject, joinSession } from '../actions.js';
import { fmtAgo, cwdTail, plural, STATUS_META } from '../format.js';
import { emptyState } from '../ui.js';
import { navigate } from '../router.js';

const SEG = ['backlog', 'next', 'in_progress', 'review', 'done', 'later', 'blocked'];
const SESSION_PREVIEW = 4;

export function mount(container) {
  let showArchived = false;
  let creating = false;
  const expanded = new Set();
  startTicker();

  const grid = h('div', { class: 'proj-grid' });
  const empty = h('div', { class: 'view-empty' }, emptyState({
    iconName: 'folder', title: 'No projects yet',
    body: 'Projects appear automatically when a Claude Code session starts with Helm installed. You can also create one now.',
    action: { label: 'New project', onClick: () => startCreate() },
  }));
  const archToggle = h('label', { class: 'switch-row' },
    h('input', { type: 'checkbox', onchange: (e) => { showArchived = e.target.checked; render(); } }), h('span', {}, 'Show archived'));
  const newBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => startCreate() }, icon('plus', 16), 'New project');
  const bar = h('div', { class: 'view-toolbar' }, h('p', { class: 'view-sub' }, 'Each Claude Code session joins a project. Move sessions between projects to group their work.'), h('span', { class: 'spacer' }), archToggle, newBtn);
  const createCard = h('form', { class: 'proj-card proj-new', hidden: true, onsubmit: async (e) => {
    e.preventDefault();
    const name = nameIn.value.trim();
    if (!name) return;
    creating = false; createCard.hidden = true; nameIn.value = '';
    await createProject(name);
  } });
  const nameIn = h('input', { class: 'composer-input', type: 'text', placeholder: 'Project name', 'aria-label': 'New project name', autocomplete: 'off' });
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); creating = false; createCard.hidden = true; } });
  createCard.append(h('h3', { class: 'proj-name' }, 'New project'), nameIn,
    h('div', { class: 'composer-row' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => { creating = false; createCard.hidden = true; } }, 'Cancel'),
      h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Create')));
  const wrap = h('div', { class: 'projects' }, bar, createCard, grid, empty);
  container.appendChild(wrap);

  function startCreate() {
    creating = true; createCard.hidden = false; nameIn.focus();
    createCard.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- card ---------- */
  function makeCard(p) {
    const r = {};
    r.name = h('h3', { class: 'proj-name' });
    r.nameBtn = h('button', { class: 'proj-open', type: 'button', onclick: () => open(r.p) }, r.name);
    r.active = h('span', { class: 'badge badge-accent', hidden: true }, 'Current');
    r.edit = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Rename project', title: 'Rename', onclick: () => rename(card) }, icon('pencil', 14));
    r.arch = h('button', { class: 'icon-btn sm', type: 'button', onclick: () => toggleArchive(r.p) }, icon('archive', 14));
    r.stats = h('div', { class: 'proj-stats mono' });
    r.bar = h('div', { class: 'seg-bar', role: 'img' });
    r.legend = h('div', { class: 'seg-legend mono' });
    r.sessions = h('ul', { class: 'sess-list' });
    r.more = h('button', { class: 'link-btn', type: 'button', onclick: () => { expanded.has(r.p.id) ? expanded.delete(r.p.id) : expanded.add(r.p.id); render(); } });
    r.noSess = h('div', { class: 'dim sess-none' }, 'No sessions in this project yet');
    const card = h('article', { class: 'proj-card' },
      h('header', { class: 'proj-head' }, r.nameBtn, r.active, h('span', { class: 'spacer' }), r.edit, r.arch),
      r.stats, r.bar, r.legend,
      h('div', { class: 'sess-head' }, 'Sessions'), r.sessions, r.noSess, r.more);
    card.__r = r;
    return card;
  }

  function open(p) {
    setUI({ projectId: p.id });
    navigate('board');
  }

  function rename(card) {
    const r = card.__r, p = r.p;
    if (r.editing) return;
    r.editing = true;
    const input = h('input', { class: 'composer-input rename-input', type: 'text', 'aria-label': 'Project name' });
    input.value = p.name;
    r.nameBtn.hidden = true;
    r.nameBtn.after(input);
    const done = (save) => {
      if (!r.editing) return;
      r.editing = false;
      const v = input.value.trim();
      input.remove(); r.nameBtn.hidden = false;
      if (save && v && v !== p.name) patchProject(p.id, { name: v }, 'Could not rename project');
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    });
    input.addEventListener('blur', () => done(true));
    input.focus(); input.select();
  }

  function toggleArchive(p) {
    if (!p.archived && state.ui.projectId === p.id) setUI({ projectId: 'all' });
    archiveProject(p.id, !p.archived);
  }

  function updateCard(card, p) {
    const r = card.__r;
    r.p = p;
    setClass(card, 'archived', !!p.archived);
    setClass(card, 'pending', !!p.__pending);
    if (!r.editing) setText(r.name, p.name);
    setHidden(r.active, state.ui.projectId !== p.id);
    r.arch.setAttribute('aria-label', p.archived ? 'Restore project' : 'Archive project');
    r.arch.title = p.archived ? 'Restore' : 'Archive';
    const sessions = sel.sessions().filter((s) => s.projectId === p.id).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const tasks = sel.tasksOfProject(p.id);
    const counts = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    const active = sessions.filter((s) => s.status === 'active').length;
    const last = Math.max(0, ...sessions.map((s) => s.lastSeenAt || 0), ...tasks.map((t) => t.updatedAt || 0));
    r.stats.textContent = '';
    r.stats.append(
      h('span', {}, plural(sessions.length, 'session')), active ? h('span', { class: 'live-count' }, `${active} active`) : null,
      h('span', {}, plural(tasks.length, 'task')),
      last ? h('span', { class: 'proj-last', 'data-ago': last, 'data-ago-prefix': 'last activity ' }, `last activity ${fmtAgo(last)}`) : h('span', { class: 'dim' }, 'no activity'));
    // segmented bar
    const total = tasks.length;
    const segs = SEG.filter((k) => counts[k]);
    reconcile(r.bar, segs, (k) => k, (k) => h('span', { class: `seg st-${k}` }), (el, k) => {
      el.style.flexGrow = String(counts[k]);
      el.title = `${STATUS_META[k].label}: ${counts[k]}`;
    });
    setClass(r.bar, 'empty', total === 0);
    r.bar.setAttribute('aria-label', segs.map((k) => `${counts[k]} ${STATUS_META[k].label}`).join(', ') || 'No tasks');
    r.legend.textContent = '';
    for (const k of segs) r.legend.append(h('span', { class: 'legend-item' }, h('i', { class: `sdot st-${k}` }), `${counts[k]} ${STATUS_META[k].short.toLowerCase()}`));
    // sessions
    const isExp = expanded.has(p.id);
    const shown = isExp ? sessions : sessions.slice(0, SESSION_PREVIEW);
    reconcile(r.sessions, shown, (s) => s.id, makeSession, updateSession);
    setHidden(r.noSess, sessions.length > 0);
    setHidden(r.more, sessions.length <= SESSION_PREVIEW);
    setText(r.more, isExp ? 'Show fewer' : `Show all ${sessions.length}`);
  }

  function makeSession(s) {
    const dot = h('span', { class: 'pdot' });
    const title = h('span', { class: 'sess-title' });
    const sub = h('span', { class: 'sess-sub mono' });
    const sel_ = h('select', { class: 'select select-sm move-select', 'aria-label': 'Move to project', onchange: () => {
      const v = sel_.value; sel_.value = '';
      if (v) joinSession(row.__s.id, v);
    } });
    const link = h('button', { class: 'sess-link', type: 'button', onclick: () => navigate('threads', [row.__s.id]) }, dot, h('span', { class: 'sess-text' }, title, sub));
    const row = h('li', { class: 'sess-row' }, link, sel_);
    row.__r = { dot, title, sub, sel: sel_ };
    return row;
  }
  function updateSession(row, s) {
    const r = row.__r;
    row.__s = s;
    r.dot.className = `pdot ${s.status}${s.busy ? ' busy' : ''}`;
    setText(r.title, s.title || cwdTail(s.cwd) || s.id);
    setText(r.sub, `${cwdTail(s.cwd)} · ${s.status}`);
    const others = sel.projects().filter((p) => p.id !== s.projectId);
    const sig = others.map((p) => p.id + p.name).join('|');
    if (r.sel.__sig !== sig) {
      r.sel.__sig = sig;
      r.sel.textContent = '';
      r.sel.append(h('option', { value: '' }, 'Move to project…'), ...others.map((p) => h('option', { value: p.id }, p.name)));
      r.sel.value = '';
    }
    r.sel.disabled = others.length === 0;
  }

  function render() {
    const ps = sel.projects(showArchived).sort((a, b) => (a.archived - b.archived) || (a.createdAt - b.createdAt));
    reconcile(grid, ps, (p) => p.id, makeCard, updateCard);
    setHidden(empty, !(state.ready && sel.projects(true).length === 0 && !creating));
    setHidden(grid, ps.length === 0);
  }
  render();

  return { watch: ['project', 'session', 'task', 'ui', 'ready'], update: render, setRoute() {}, destroy() { wrap.remove(); } };
}
