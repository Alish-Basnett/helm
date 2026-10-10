// spotlight.js — ⌘K global search + command palette (">" for commands).
import { h, bus, debounce, renderSnippet } from './dom.js';
import { icon } from './icons.js';
import { state, sel, setUI } from './store.js';
import { api } from './api.js';
import { setPref, codeOn } from './prefs.js';
import { setStatus, startTask, canStart, setAutoStart, autoTarget } from './actions.js';
import { navigate, openTask, route, setDiff } from './router.js';
import { diffEntry, ensureDiff, onDiff, taskHasFiles } from './diffs.js';
import { fmtAgo, truncate, STATUS_META } from './format.js';
import { templatesFor, openUseDialog, openTemplateEditor, agentLabel } from './templates.js';

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
  workflow: { label: 'Workflows', icon: 'workflow' },
  template: { label: 'Templates', icon: 'templates' },
  concept: { label: 'Concepts', icon: 'tag' },
};
const KIND_ORDER = ['task', 'concept', 'template', 'question', 'workflow', 'session', 'note', 'recap', 'digest', 'activity', 'project'];

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
    placeholder: 'Search tasks, concepts, questions, notes, recaps, digests…  (type > for commands)', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Search Helm',
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
  function commands(needle = '') {
    const cmds = [
      { title: 'Talk to session', sub: 'Chat with a live session of this project', icon: 'chat', run: () => bus.emit('open-talk') },
      { title: 'Minimise / restore panels', sub: 'Tuck every open panel into the right-edge shelf, or bring them back (M)', icon: 'minimize', run: () => bus.emit('toggle-panels') },
      { title: 'Start task…', sub: 'Pick a task to start in a live session', icon: 'play', stay: true, run: () => { input.value = '>start '; onInput(); input.focus(); } },
      { title: 'Start from template…', sub: 'Pick a saved template, fill in its blanks, create and start', icon: 'templates', stay: true, run: () => { input.value = '>template '; onInput(); input.focus(); } },
      { title: 'Open diff…', sub: 'Show a changed file of the open task in the Diff panel', icon: 'file', stay: true, run: () => { input.value = '>diff '; onInput(); input.focus(); } },
      { title: 'Review choices…', sub: 'Tick which suggestions to turn into tasks', icon: 'checklist', stay: true, run: () => { input.value = '>choices '; onInput(); input.focus(); } },
      { title: 'New task', sub: 'Open the composer on the Board', icon: 'plus', run: () => { navigate('board'); setTimeout(() => bus.emit('new-task'), 60); } },
      { title: 'Go to Board', icon: 'board', run: () => navigate('board') },
      { title: 'Go to Projects', icon: 'folder', run: () => navigate('projects') },
      { title: 'Go to Office', icon: 'office', run: () => navigate('office') },
      { title: 'Session health', sub: 'Context use, rate limits, cost, idle time and stalls for every live session', icon: 'heartPulse', run: () => navigate('health') },
      { title: 'Go to Threads', icon: 'threads', run: () => navigate('threads') },
      { title: 'Today\'s timeline', sub: 'Gantt of everything that ran today, across sessions', icon: 'calendar', run: () => navigate('today') },
      { title: 'Go to Workflows', sub: 'Draw and run a flow of agents, checks and gates', icon: 'workflow', run: () => navigate('workflows') },
      { title: 'Go to Inbox', sub: 'Questions waiting for you', icon: 'inbox', run: () => navigate('inbox') },
      { title: 'Review queue', sub: 'Diff, recap and Approve / Request changes for every task in Review', icon: 'review', run: () => navigate('review') },
      { title: 'Go to Learn', icon: 'learn', run: () => navigate('learn') },
      { title: 'Go to Concepts', sub: 'Everything your recaps taught you, one page per idea', icon: 'tag', run: () => navigate('learn', ['concepts']) },
      { title: 'Go to Templates', sub: 'Saved tasks you start in one click', icon: 'templates', run: () => navigate('templates') },
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
    if (t) cmds.push({ title: 'Save selected task as template…', sub: `${t.id} · ${truncate(t.title, 40)}`, icon: 'bookmark', run: () => openTemplateEditor({ task: t }) });
    if (t && canStart(t)) cmds.push({ title: 'Start selected task', sub: `${t.id} · ${truncate(t.title, 40)}`, icon: 'play', run: () => startTask(t.id) });
    if (/^start\b/.test(needle)) {
      const startable = Array.from(state.tasks.values()).filter((x) => canStart(x) && sel.inScope(x) && !String(x.id).startsWith('tmp-'))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const x of startable) cmds.push({ taskCmd: true, hay: `${x.id} ${x.title}`.toLowerCase(), title: `Start ${x.id} · ${truncate(x.title, 56)}`, sub: `${STATUS_META[x.status].label} · ${sel.projectName(x.projectId)}`, icon: 'play', run: () => startTask(x.id) });
      if (!startable.length) cmds.push({ title: 'Nothing to start', sub: 'Backlog, Up next, Saved for later and Blocked tasks can be started', icon: 'play', disabled: true });
    }
    if (/^templates?\b/.test(needle)) {
      const pid = sel.scopeProject() ? sel.scopeProject().id : null;
      const list = templatesFor(pid);
      for (const x of list) {
        cmds.push({ taskCmd: true, hay: `${x.name} ${x.title} ${(x.tags || []).join(' ')}`.toLowerCase(), title: `Use “${truncate(x.name, 48)}”`, sub: `${truncate(x.title, 60)} · ${agentLabel(x.agent)}${x.usage ? ` · used ${x.usage}×` : ''}`, icon: 'templates', run: () => openUseDialog(x) });
      }
      if (!list.length) cmds.push({ title: 'No templates yet', sub: 'Open a task and choose Save as template', icon: 'templates', disabled: true });
    }
    if (/^diff\b/.test(needle)) {
      const ot = route().task ? state.tasks.get(route().task) : null;
      if (ot && taskHasFiles(ot)) {
        ensureDiff(ot);
        const e = diffEntry(ot.id);
        const files = e && e.data && e.data.files.length ? e.data.files.map((f) => ({ rel: f.rel || f.path, st: f.status, a: f.additions, d: f.deletions }))
          : (ot.filesChanged || []).map((f) => ({ rel: f }));
        for (const f of files) cmds.push({ taskCmd: true, hay: f.rel.toLowerCase(), title: `Diff ${f.rel}`, sub: f.a != null ? `${ot.id} · +${f.a} −${f.d}` : ot.id, icon: 'file', run: () => setDiff(f.rel) });
      } else cmds.push({ title: 'No diff to open', sub: ot ? 'This task has no changed files' : 'Open a task first', icon: 'file', disabled: true });
    }
    if (/^(choices|review)\b/.test(needle)) {
      const ct = sel.choiceTasks();
      for (const x of ct) cmds.push({ taskCmd: true, hay: `${x.id} ${x.title}`.toLowerCase(), title: `Review ${sel.openChoiceCount(x)} choices · ${x.id} ${truncate(x.title, 50)}`, sub: sel.projectName(x.projectId), icon: 'checklist', run: () => openTask(x.id) });
      if (!ct.length) cmds.push({ title: 'No choices waiting', sub: 'When an agent proposes options they appear here', icon: 'checklist', disabled: true });
    }
    const at = autoTarget();
    if (at) cmds.push({ title: 'Toggle auto mode', sub: `${at.name}: ${at.autoStart ? 'Auto → Manual' : 'Manual → Auto'}`, icon: 'play', run: () => setAutoStart(at.id, !at.autoStart) });
    else for (const p of sel.projects()) cmds.push({ title: `Toggle auto mode · ${p.name}`, sub: p.autoStart ? 'Auto → Manual' : 'Manual → Auto', icon: 'play', run: () => setAutoStart(p.id, !p.autoStart) });
    cmds.push({ title: 'Settings', sub: 'Theme, accent, text size, code mode…', icon: 'gear', run: () => navigate('settings') });
    cmds.push({ title: 'Toggle code mode', sub: 'Make Talk look like source code', icon: 'code', run: () => setPref('code', codeOn() ? 'off' : 'on') });
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
      case 'workflow': return navigate('workflows', [r.id]);
      case 'concept': return navigate('learn', ['c', r.id]);
      case 'template': { const tp = state.templates.get(r.id); if (tp) { setTimeout(() => openUseDialog(tp), 0); } return; }
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
    if (it.stay) { it.run(); return; }
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

  onDiff(() => { if (isOpen && /^>\s*diff\b/i.test(input.value)) onInput(); }); // the file list arrives after the fetch

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
      const rest = (/^(?:start|choices|review|diff|templates?)\s+(.*)$/.exec(needle) || [])[1];
      items = commands(needle).filter((c) => (c.taskCmd ? !rest || c.hay.includes(rest) : !needle || c.title.toLowerCase().includes(needle) || (c.sub || '').toLowerCase().includes(needle))).map((c) => ({ ...c, group: 'command' }));
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
