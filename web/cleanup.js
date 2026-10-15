// cleanup.js — "K old duplicate projects for the same folders": a dismissible banner (Office, Projects) and the clean-up dialog.
// Needs the hub's GET /v1/projects/duplicates and the archive / merge routes; on a hub without them the banner never shows.
import { h, setText, setHidden } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { state, sel, subscribe, lsGet, lsSet, refresh } from './store.js';
import { openModal } from './modal.js';
import { toast } from './ui.js';
import { plural } from './format.js';
import { pickKeep, chunk, ACK_CHUNK } from './retire.js';

const DISMISS_KEY = 'helm.cleanup.dismissed';
let info = { supported: false, groups: [] }; // groups: [{ folder, keepId, projects: [row] }] with at least two live projects
const watchers = new Set();
let unsubStore = null, timer = 0, reqId = 0;

const hasLive = (p) => sel.allSessions().some((s) => s.projectId === p.id && (s.status === 'active' || s.status === 'idle'));

/**
 * The hub's reply (v0.27: { groups: [{ folder, suggestedTarget, recommendedKeep, projects: [{ ...project, liveSessions, endedSessions, tasks, openTasks }] }] }),
 * made safe: local, non-archived rows with the hub's counts, at least two per group, and the project to keep (the hub's recommendedKeep).
 */
export function normalizeGroups(res) {
  const raw = Array.isArray(res) ? res : (res && (res.groups || res.duplicates)) || [];
  const idOf = (x) => (typeof x === 'string' ? x : x && x.id);
  const out = [];
  for (const g of raw) {
    const list = (g.projects || []).map((x) => {
      const local = state.projects.get(idOf(x));
      return local && !local.archived ? { ...local, ...(typeof x === 'object' ? x : {}) } : null;
    }).filter(Boolean);
    if (list.length < 2) continue;
    const named = idOf(g.recommendedKeep) || idOf(g.keepId) || idOf(g.keep);
    const keep = list.find((p) => p.id === named) || pickKeep(list, hasLive);
    out.push({ folder: g.folder || keep.name, keepId: keep.id, projects: list });
  }
  return out;
}
export const dupCount = (groups) => groups.reduce((n, g) => n + g.projects.length - 1, 0);

async function probe() {
  const my = ++reqId;
  try {
    const res = await api.duplicates();
    if (my !== reqId) return;
    info = { supported: true, groups: normalizeGroups(res) };
  } catch {
    if (my !== reqId) return;
    info = { supported: false, groups: [] }; // 404 / 405 / unreachable: hide the banner
  }
  for (const fn of Array.from(watchers)) fn(info);
}
function schedule() { clearTimeout(timer); timer = setTimeout(probe, 800); }

function watch(fn) {
  watchers.add(fn);
  if (!unsubStore) unsubStore = subscribe((changed) => { if (changed.has('project') || changed.has('ready')) schedule(); });
  fn(info);
  schedule();
  return () => {
    watchers.delete(fn);
    if (!watchers.size && unsubStore) { unsubStore(); unsubStore = null; clearTimeout(timer); }
  };
}

const signature = (groups) => groups.map((g) => g.projects.map((p) => p.id).sort().join('+')).sort().join('|');

/** The banner. Returns { el, destroy }. */
export function createCleanupBanner() {
  const msg = h('span', { class: 'cl-msg' });
  const review = h('button', { class: 'btn btn-sm btn-accent', type: 'button', onclick: () => openCleanup() }, 'Review & clean up');
  const dismiss = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss until something new turns up', onclick: () => { lsSet(DISMISS_KEY, signature(info.groups)); paint(info); } }, icon('close', 14));
  const el = h('div', { class: 'cl-banner', role: 'region', 'aria-label': 'Project clean-up', hidden: true }, icon('folder', 16), msg, h('span', { class: 'spacer' }), review, dismiss);
  function paint(i) {
    const k = dupCount(i.groups);
    const show = state.ready && i.supported && k > 0 && lsGet(DISMISS_KEY) !== signature(i.groups);
    setHidden(el, !show);
    if (show) setText(msg, `${plural(k, 'old duplicate project')} for the same folders`);
  }
  const off = watch(paint);
  return { el, destroy() { off(); el.remove(); } };
}

/* ---------- dialog ---------- */
let openNow = null;
const ACTIONS = [['merge', 'Merge cards & archive'], ['archive', 'Archive'], ['leave', 'Leave alone']];

export function openCleanup() {
  if (openNow || !info.groups.length) return;
  const groups = info.groups;
  // the choice per old project; default: merge when it has cards, archive when empty
  const choice = new Map();
  const tasksOf = (p) => (p.tasks != null ? p.tasks : sel.tasksOfProject(p.id).length);
  const openOf = (p) => (p.openTasks != null ? p.openTasks : sel.tasksOfProject(p.id).filter((t) => t.status !== 'done').length);
  const liveOf = (p) => (p.liveSessions != null ? p.liveSessions : sel.allSessions().filter((x) => x.projectId === p.id && (x.status === 'active' || x.status === 'idle')).length);
  const keeps = new Map(groups.map((g) => [g.folder, g.keepId])); // the Keep per folder; the owner can change it
  const blockReason = (p) => (p.coordinator ? 'main project: cannot be archived or merged' : liveOf(p) ? `${plural(liveOf(p), 'live session')}: end ${liveOf(p) === 1 ? 'it' : 'them'} first` : null);
  const setDefault = (g) => { for (const p of g.projects) { if (p.id === keeps.get(g.folder)) choice.delete(p.id); else if (!choice.has(p.id) || choice.get(p.id) === 'leave') choice.set(p.id, blockReason(p) ? 'leave' : tasksOf(p) ? 'merge' : 'archive'); } };
  for (const g of groups) setDefault(g);
  const nameOf = (id) => sel.projectName(id);

  const head = h('h2', { id: 'cl-h' }, `Clean up ${plural(dupCount(groups), 'old duplicate project')}`);
  const note = h('p', { class: 'ak-note' }, 'Each folder keeps one project. Merging moves the old project’s cards into it and archives the old one; nothing is deleted, and archived projects can be restored.');
  const body = h('div', { class: 'ak-list' });
  const result = h('div', { class: 'ak-result', hidden: true, role: 'status', 'aria-live': 'polite' });
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel');
  const back = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => step('pick') }, 'Back');
  const go = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (stage === 'pick' ? step('confirm') : run()) });
  const card = h('div', { class: 'md-card ak-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cl-h' }, head, note, body, result, h('div', { class: 'ak-foot' }, cancel, back, go));
  let stage = 'pick';
  let modal = null;

  const plan = () => {
    const merges = [], archives = [];
    for (const g of groups) for (const p of g.projects) {
      if (p.id === keeps.get(g.folder)) continue;
      const c = choice.get(p.id);
      if (c === 'merge') merges.push({ p, into: keeps.get(g.folder) });
      else if (c === 'archive') archives.push({ p });
    }
    return { merges, archives };
  };

  function paintPick() {
    body.textContent = '';
    for (const g of groups) {
      const keepId = keeps.get(g.folder);
      const keep = g.projects.find((p) => p.id === keepId);
      const rows = g.projects.map((p) => {
        const isKeep = p.id === keepId;
        const sub = `${openOf(p)} open / ${tasksOf(p)} cards · ${plural(liveOf(p), 'live session')}${p.coordinator ? ' · main' : ''}`;
        const radio = h('input', { type: 'radio', name: `keep-${g.folder}`, checked: isKeep, 'aria-label': `Keep ${p.name}`, onchange: () => { keeps.set(g.folder, p.id); choice.delete(p.id); setDefault(g); paintPick(); paintGo(); } });
        const lead = h('label', { class: 'cl-lead' }, radio, isKeep ? h('span', { class: 'cl-badge' }, 'Keep') : h('span', { class: 'cl-keepme' }, 'Keep'), h('span', { class: 'cl-name' }, p.name));
        if (isKeep) return h('li', { class: 'cl-row cl-keep' }, lead, h('span', { class: 'ak-n mono' }, sub));
        const why = blockReason(p);
        const selEl = h('select', { class: 'select select-sm', 'aria-label': `What to do with ${p.name}`, onchange: () => { choice.set(p.id, selEl.value); paintGo(); } },
          ACTIONS.map(([v, l]) => h('option', { value: v, disabled: !!why && v !== 'leave' }, v === 'merge' ? `Merge cards into ${keep.name} & archive` : l)));
        selEl.value = why ? 'leave' : choice.get(p.id);
        return h('li', { class: 'cl-row' }, lead, h('span', { class: 'ak-n mono' }, sub), selEl, why ? h('span', { class: 'cl-why' }, why) : null);
      });
      body.append(h('section', { class: 'ak-group' }, h('div', { class: 'ak-ghead' }, icon('folder', 14), h('span', { class: 'ak-gtitle', title: g.folder }, g.folder)), h('ul', { class: 'ak-rows', role: 'list' }, rows)));
    }
  }
  function paintConfirm() {
    const { merges, archives } = plan();
    body.textContent = '';
    const cards = merges.reduce((n, m) => n + tasksOf(m.p), 0);
    body.append(h('p', { class: 'cl-sum' },
      merges.length ? h('span', {}, `Merge ${plural(merges.length, 'project')} (${plural(cards, 'card')}) into the project kept for its folder and archive them. `) : null,
      archives.length ? h('span', {}, `Archive ${plural(archives.length, 'project')} without moving anything.`) : null),
      h('ul', { class: 'ak-rows', role: 'list' }, [
        ...merges.map((m) => h('li', { class: 'cl-row' }, h('span', { class: 'cl-name' }, m.p.name), h('span', { class: 'ak-n mono' }, `→ ${nameOf(m.into)} · ${plural(tasksOf(m.p), 'card')}`))),
        ...archives.map((a) => h('li', { class: 'cl-row' }, h('span', { class: 'cl-name' }, a.p.name), h('span', { class: 'ak-n mono' }, 'archive'))),
      ]));
  }
  function paintGo() {
    const { merges, archives } = plan();
    const n = merges.length + archives.length;
    go.disabled = stage === 'pick' && !n;
    setText(go, stage === 'pick' ? (n ? `Review ${plural(n, 'change')}…` : 'Nothing selected') : `Confirm: ${plural(n, 'change')}`);
  }
  function step(s) {
    stage = s;
    setHidden(back, s === 'pick');
    if (s === 'pick') paintPick(); else paintConfirm();
    paintGo();
    cancel.focus(); // never land on the primary action
  }

  async function run() {
    const { merges, archives } = plan();
    modal.setBusy(true);
    go.disabled = true; cancel.disabled = true; back.disabled = true;
    setText(go, 'Working…');
    const done = [], failed = [];
    for (const m of merges) {
      try {
        const res = await api.mergeProject(m.p.id, m.into);
        const archived = (res && ((res.source && res.source.archived) || (res.project && res.project.archived) || res.archived === true));
        if (!archived) { try { await api.archiveProject(m.p.id); } catch (e) { if (e.status !== 409) throw e; } } // 409: the merge already archived it
        done.push(m.p.name);
      } catch (e) { failed.push({ name: m.p.name, reason: (e && e.message) || 'failed' }); }
    }
    for (const part of chunk(archives, ACK_CHUNK)) {
      try {
        const res = await api.archiveProjects(part.map((a) => a.p.id));
        const bad = new Map(((res && res.refused) || []).map((x) => [x.id, x.reason]));
        for (const a of part) (bad.has(a.p.id) ? failed.push({ name: a.p.name, reason: bad.get(a.p.id) || 'refused' }) : done.push(a.p.name));
      } catch (e) { for (const a of part) failed.push({ name: a.p.name, reason: (e && e.message) || 'failed' }); }
    }
    await refresh();
    probe();
    modal.setBusy(false);
    if (modal.closed) { toast(failed.length ? `Cleaned up ${done.length}; ${failed.length} refused: ${failed[0].reason}` : `Cleaned up ${plural(done.length, 'project')}`, { kind: failed.length ? 'error' : 'success' }); return; }
    if (!failed.length) { toast(`Cleaned up ${plural(done.length, 'project')}`, { kind: 'success' }); close(); return; }
    body.hidden = true; note.hidden = true; go.hidden = true; back.hidden = true;
    setText(head, `${plural(failed.length, 'project')} could not be cleaned up`);
    result.hidden = false;
    result.append(h('p', {}, `${plural(done.length, 'project')} done. The hub refused these:`),
      h('ul', { class: 'ak-refused', role: 'list' }, failed.map((f) => h('li', {}, h('strong', {}, f.name), h('span', { class: 'ak-n mono' }, ` · ${f.reason}`)))));
    cancel.disabled = false;
    setText(cancel, 'Close');
    cancel.focus();
  }

  step('pick');
  modal = openModal(card, { onClose: () => { openNow = null; }, initialFocus: () => cancel });
  function close() { modal.close(); }
  openNow = { close };
}
