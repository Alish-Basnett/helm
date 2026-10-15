// startdialogs.js — v0.28: the small confirm before a Start that will wait or leave the project on screen, the "Move to…" dialog,
// and a cache of where each card's Start would go (GET /v1/tasks/:id/start-target).
import { h } from './dom.js';
import { api } from './api.js';
import { state, sel } from './store.js';
import { openModal } from './modal.js';
import { startTargetKey, startTargetText, moveTargets } from './startqueue.js';

/** Resolves true when the owner confirms. */
export function confirmStart(tg, verb) {
  return new Promise((resolve) => {
    let answer = false;
    const ok = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { answer = true; modal.close(); } }, verb);
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel');
    const why = tg.held ? 'No session of that project is live, so it will be held until one starts.' : 'It is not the project you are looking at.';
    const card = h('div', { class: 'md-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sc-h' },
      h('h2', { id: 'sc-h' }, startTargetText(verb, tg)), h('p', {}, why), h('div', { class: 'ak-foot' }, cancel, ok));
    const modal = openModal(card, { onClose: () => resolve(answer), initialFocus: () => cancel });
  });
}

/** "Move T-n to…": pick a project (coordinator first), confirm, then `onMove(projectId)` runs. */
export function openMoveDialog(task, onMove) {
  const targets = moveTargets(sel.projects(), task.projectId);
  if (!targets.length) return null;
  const pick = h('select', { class: 'select', 'aria-label': 'Move to project' },
    targets.map((p) => h('option', { value: p.id }, p.coordinator ? `${p.name} (coordinator)` : p.name)));
  const go = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { const id = pick.value; modal.close(); onMove(id); } }, 'Move');
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel');
  const card = h('div', { class: 'md-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mv-h' },
    h('h2', { id: 'mv-h' }, `Move ${task.id} to…`),
    h('p', {}, `Now in ${sel.projectName(task.projectId)}. The card keeps its notes and links. Its session link is dropped unless that session is in the new project, and a waiting Start goes with it.`),
    pick, h('div', { class: 'ak-foot' }, cancel, go));
  const modal = openModal(card, { initialFocus: () => pick });
  return modal;
}

const cache = new Map(); // task id -> { key, value }
const loading = new Set();
/** The cached start target for a card, or null while it loads or when the hub could not say (`onLoad` runs when it arrives). */
export function cachedStartTarget(task, onLoad) {
  const key = startTargetKey(task, Array.from(state.sessions.values()));
  const hit = cache.get(task.id);
  if (hit && hit.key === key) return hit.value;
  const lk = `${task.id}|${key}`;
  if (!loading.has(lk)) {
    loading.add(lk);
    api.startTarget(task.id).then((value) => cache.set(task.id, { key, value })).catch(() => cache.set(task.id, { key, value: null })).finally(() => { loading.delete(lk); if (onLoad) onLoad(); });
  }
  return null;
}
