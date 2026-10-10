// spotlight.js — ⌘K global search + command palette (">" for commands).
import { h, bus, debounce, renderSnippet } from './dom.js';
import { icon } from './icons.js';
import { state, sel, setUI } from './store.js';
import { api } from './api.js';
import { setStatus } from './actions.js';
import { navigate, openTask } from './router.js';
import { fmtAgo, truncate } from './format.js';

const KIND = {
  task: { label: 'Tasks', icon: 'board' },
  session: { label: 'Sessions', icon: 'threads' },
  note: { label: 'Notes', icon: 'note' },
  recap: { label: 'Recaps', icon: 'sparkle' },
  activity: { label: 'Activity', icon: 'terminal' },
  project: { label: 'Projects', icon: 'folder' },
  command: { label: 'Commands', icon: 'command' },
  recent: { label: 'Recent tasks', icon: 'clock' },
  question: { label: 'Questions', icon: 'question' },
  digest: { label: 'Digests', icon: 'calendar' },
};
const KIND_ORDER = ['task', 'question', 'session', 'note', 'recap', 'digest', 'activity', 'project'];

export function createSpotlight(root) {
  let isOpen = false;
  let prevFocus = null;
  let items = [];
  let active = 0;
  let abort = null;
  let reqSeq = 0;
  let loading = false;
  let errorMsg = '';
  let lastQuery = '';

  const input = h('input', {
    class: 'spot-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'spot-list', 'aria-autocomplete': 'list',
    placeholder: 'Search tasks, questions, notes, recaps, digests…  (type > for commands)', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Search Helm',
  });
  const mode = h('span', { class: 'spot-mode mono', hidden: true }, 'COMMAND');
  const list = h('div', { class: 'spot-list', id: 'spot-list', role: 'listbox', 'aria-label': 'Results' });
  const foot = h('footer', { class: 'spot-foot mono' },
    h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' navigate'), h('span', {}, h('kbd', {}, '↵'), ' open'),
    h('span', {}, h('kbd', {}, '>'), ' commands'), h('span', {}, h('kbd', {}, 'esc'), ' close'));
  const panel = h('div', { class: 'spot-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Spotlight search' },
    h('div', { class: 'spot-field' }, icon('search', 18), input, mode), list, foot);
  const scrim = h('div', { class: 'spotlight-scrim', hidden: true, onmousedown: (e) => { if (e.target === scrim) close(); } }, panel);
  root.appendChild(scrim);

  /* ---------- commands ---------- */
  function commands() {
    const cmds = [
      { title: 'New task', sub: 'Open the composer on the Board', icon: 'plus', run: () => { navigate('board'); setTimeout(() => bus.emit('new-task'), 60); } },
      { title: 'Go to Board', icon: 'board', run: () => navigate('board') },
      { title: 'Go to Projects', icon: 'folder', run: () => navigate('projects') },
      { title: 'Go to Office', icon: 'office', run: () => navigate('office') },
      { title: 'Go to Threads', icon: 'threads', run: () => navigate('threads') },
      { title: 'Go to Inbox', sub: 'Questions waiting for you', icon: 'inbox', run: () => navigate('inbox') },
      { title: 'Go to Learn', icon: 'learn', run: () => navigate('learn') },
      { title: 'Switch project: All projects', sub: state.ui.projectId === 'all' ? 'current' : '', icon: 'folder', run: () => setUI({ projectId: 'all' }) },
      ...sel.projects().map((p) => ({ title: `Switch project: ${p.name}`, sub: state.ui.projectId === p.id ? 'current' : '', icon: 'folder', run: () => setUI({ projectId: p.id }) })),
    ];
    const t = sel.selectedTask();
    if (t) {
      const lbl = `${t.id} · ${truncate(t.title, 40)}`;
      if (t.status !== 'done') cmds.push({ title: 'Move selected task to Done', sub: lbl, icon: 'check', run: () => setStatus(t.id, 'done') });
      if (t.status !== 'later') cmds.push({ title: 'Move selected task to Saved for later', sub: lbl, icon: 'bookmark', run: () => setStatus(t.id, 'later') });
    } else {
      cmds.push({ title: 'Move selected task to Done', sub: 'Select a task first', icon: 'check', disabled: true });
      cmds.push({ title: 'Move selected task to Saved for later', sub: 'Select a task first', icon: 'bookmark', disabled: true });
    }
    cmds.push({ title: 'Toggle theme', sub: 'System · Light · Dark', icon: 'sun', run: () => bus.emit('toggle-theme') });
    cmds.push({ title: 'Toggle sidebar', icon: 'sidebar', run: () => bus.emit('toggle-sidebar') });
    return cmds.map((c, i) => ({ ...c, kind: 'command', id: 'cmd' + i }));
  }

  /* ---------- result opening ---------- */
  function openResult(r) {
    switch (r.kind) {
      case 'task': case 'recap': return openTask(r.taskId || r.id);
      case 'note': if (r.taskId) return openTask(r.taskId); if (r.sessionId) return navigate('threads', [r.sessionId]); return;
      case 'session': return navigate('threads', [r.sessionId || r.id]);
      case 'activity': if (r.taskId) return openTask(r.taskId); if (r.sessionId) return navigate('threads', [r.sessionId]); return;
      case 'question': return navigate('inbox', r.id ? [r.id] : []);
      case 'digest': return navigate('learn', [], r.id ? { digest: r.id } : {});
      case 'project': setUI({ projectId: r.id }); return navigate('board');
      default:
    }
  }

  /* ---------- render ---------- */
  function render() {
    list.textContent = '';
    if (errorMsg) { list.appendChild(h('div', { class: 'spot-empty' }, errorMsg)); return; }
    if (!items.length) {
      const q = input.value.trim();
      list.appendChild(h('div', { class: 'spot-empty' },
        loading ? 'Searching…' : q && !q.startsWith('>') ? `No results for “${truncate(q, 40)}”` : q ? 'No matching command' : 'Start typing to search across every session'));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    let lastGroup = null;
    items.forEach((it, i) => {
      if (it.group !== lastGroup) {
        lastGroup = it.group;
        list.appendChild(h('div', { class: 'spot-group', role: 'presentation' }, (KIND[it.group] || { label: it.group }).label));
      }
      const info = KIND[it.kind] || KIND.task;
      const row = h('div', {
        class: ['spot-item', i === active && 'active', it.disabled && 'disabled'], id: `spot-${i}`, role: 'option', 'aria-selected': String(i === active),
        onmousemove: () => { if (active !== i) { active = i; markActive(); } },
        onclick: () => run(i),
      },
        h('span', { class: `spot-icon k-${it.kind}` }, icon(it.icon || info.icon, 16)),
        h('div', { class: 'spot-text' },
          h('div', { class: 'spot-title' }, it.title),
          (it.snippet || it.sub) ? h('div', { class: 'spot-sub' }, it.snippet ? renderSnippet(it.snippet) : it.sub) : null),
        it.meta ? h('span', { class: 'spot-meta mono' }, it.meta) : null);
      list.appendChild(row);
    });
    input.setAttribute('aria-activedescendant', `spot-${active}`);
  }

  function markActive() {
    list.querySelectorAll('.spot-item').forEach((el, i) => {
      const on = i === active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
    input.setAttribute('aria-activedescendant', `spot-${active}`);
  }

  function run(i) {
    const it = items[i];
    if (!it || it.disabled) return;
    close(false);
    if (it.kind === 'command') it.run();
    else openResult(it);
  }

  /* ---------- querying ---------- */
  function recentItems() {
    return Array.from(state.tasks.values()).filter((t) => t.status !== 'archived' && !String(t.id).startsWith('tmp-'))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 6)
      .map((t) => ({ kind: 'task', group: 'recent', id: t.id, taskId: t.id, title: t.title, sub: `${t.id} · ${sel.projectName(t.projectId)}`, meta: fmtAgo(t.updatedAt) }));
  }

  function onInput() {
    const raw = input.value;
    const q = raw.trim();
    const cmdMode = raw.startsWith('>');
    mode.hidden = !cmdMode;
    errorMsg = '';
    active = 0;
    if (abort) abort.abort();
    search.cancel();
    if (cmdMode) {
      const needle = raw.slice(1).trim().toLowerCase();
      items = commands().filter((c) => !needle || c.title.toLowerCase().includes(needle) || (c.sub || '').toLowerCase().includes(needle)).map((c) => ({ ...c, group: 'command' }));
      loading = false;
      render();
      return;
    }
    if (!q) { items = recentItems(); loading = false; render(); return; }
    loading = true;
    if (!items.length || lastQuery === '') { items = []; }
    render();
    search(q);
  }

  const search = debounce(async (q) => {
    const my = ++reqSeq;
    abort = new AbortController();
    try {
      const res = await api.search(q, 30, { signal: abort.signal });
      if (my !== reqSeq) return;
      const results = res.results || [];
      const groups = new Map();
      for (const r of results) {
        const k = KIND[r.kind] ? r.kind : 'task';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      items = [];
      for (const k of [...KIND_ORDER, ...Array.from(groups.keys()).filter((x) => !KIND_ORDER.includes(x))]) {
        for (const r of groups.get(k) || []) {
          items.push({
            ...r, kind: k, group: k,
            title: r.title || r.id,
            snippet: r.snippet || '',
            sub: [r.taskId && r.kind !== 'task' ? r.taskId : r.id, r.projectId ? sel.projectName(r.projectId) : ''].filter(Boolean).join(' · '),
            meta: r.at ? fmtAgo(r.at) : '',
          });
        }
      }
      lastQuery = q;
      loading = false;
      active = 0;
      errorMsg = '';
      render();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      if (my !== reqSeq) return;
      loading = false;
      items = [];
      errorMsg = `Search failed: ${e.message}`;
      render();
    }
  }, 160);

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { active = (active + 1) % items.length; markActive(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { active = (active - 1 + items.length) % items.length; markActive(); } }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); }
  });

  function open(initial = '') {
    if (isOpen) { input.focus(); input.select(); return; }
    isOpen = true;
    prevFocus = document.activeElement;
    scrim.hidden = false;
    input.value = initial;
    onInput();
    requestAnimationFrame(() => { scrim.classList.add('open'); input.focus(); });
  }
  function close(restore = true) {
    if (!isOpen) return;
    isOpen = false;
    if (abort) abort.abort();
    search.cancel();
    reqSeq++;
    scrim.classList.remove('open');
    setTimeout(() => { if (!isOpen) scrim.hidden = true; }, 200);
    if (restore && prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
    prevFocus = null;
  }

  return { open, close, toggle: () => (isOpen ? close() : open()), get isOpen() { return isOpen; } };
}
