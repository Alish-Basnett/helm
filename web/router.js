// router.js — hash router: #/<view>/<arg…>?task=T-1&chat=1  (task details + chat are query params so they are linkable).
import { lsGet, lsSet } from './store.js';
export const VIEWS = ['board', 'projects', 'office', 'threads', 'workflows', 'inbox', 'review', 'learn', 'templates', 'settings'];

export function parseHash(hash = location.hash) {
  const raw = (hash || '').replace(/^#/, '') || '/board';
  const [pathPart, queryPart = ''] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  const view = VIEWS.includes(segs[0]) ? segs[0] : 'board';
  const query = new URLSearchParams(queryPart);
  const task = query.get('task') || null;
  return { view, args: segs.slice(1), query, task, chat: !!task && query.get('chat') === '1', diff: (task && query.get('diff')) || null };
}

export function buildHash({ view, args = [], query = {} }) {
  const path = '/' + [view, ...args].map(encodeURIComponent).join('/');
  const q = new URLSearchParams();
  for (const k in query) if (query[k] != null && query[k] !== '') q.set(k, query[k]);
  const qs = q.toString();
  return '#' + path + (qs ? '?' + qs : '');
}

const listeners = new Set();
let current = parseHash();
let lastHash = location.hash;

export const route = () => current;
export function onRoute(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function handle() {
  if (location.hash === lastHash && current) return;
  lastHash = location.hash;
  const prev = current;
  current = parseHash();
  for (const fn of Array.from(listeners)) { try { fn(current, prev); } catch (e) { console.error(e); } }
}

function go(hash, replace) {
  if (hash === location.hash) return;
  try {
    if (replace) history.replaceState(null, '', hash); else history.pushState(null, '', hash);
  } catch { location.hash = hash; }
  handle();
}

export function navigate(view, args = [], query = {}, opts = {}) { go(buildHash({ view, args, query }), !!opts.replace); }
/** Whether opening a task should also open its chat (remembered, on by default). */
export const chatPref = () => lsGet('helm.chat', '1') !== '0';

/* Intent hooks: the minimised-panels shelf hears "the user wants this task / chat / diff" before the URL changes, so it can
   restore a minimised panel (or drop chips that belong to another task). A hook returns true if it restored something. */
const intentHooks = new Set();
export function onIntent(fn) { intentHooks.add(fn); return () => intentHooks.delete(fn); }
function intent(kind, arg) {
  let restored = false;
  for (const fn of Array.from(intentHooks)) { try { if (fn(kind, arg)) restored = true; } catch (e) { console.error(e); } }
  return restored;
}

/** Open a task's details, plus its chat when the remembered preference says so. */
export function openTask(id) {
  const restored = intent('task', id); // may restore minimised panels of this task (and rewrite the URL)
  const r = current;
  const query = {}; r.query.forEach((v, k) => { query[k] = v; });
  query.task = id;
  if (!restored) {
    delete query.diff; // a diff belongs to one task
    if (chatPref()) query.chat = '1'; else delete query.chat;
  } else if (chatPref()) query.chat = '1';
  go(buildHash({ view: r.view, args: r.args, query }), false);
}
export function closeTask() {
  const r = current;
  const query = {}; r.query.forEach((v, k) => { if (k !== 'task' && k !== 'chat' && k !== 'diff') query[k] = v; });
  go(buildHash({ view: r.view, args: r.args, query }), true);
}
/** Show/hide the open task's chat panel; remembers the choice for the next task. */
export function setChat(on) {
  const r = current;
  lsSet('helm.chat', on ? '1' : '0');
  if (on) intent('chat');
  if (!r.task) return;
  const query = {}; r.query.forEach((v, k) => { if (k !== 'chat') query[k] = v; });
  if (on) query.chat = '1';
  go(buildHash({ view: r.view, args: r.args, query }), true);
}
/** Open the Diff panel on a file (repo-relative path) of the open task, or close it with null. */
export function setDiff(rel) {
  if (rel) intent('diff', rel);
  const r = current;
  if (!r.task) return;
  const query = {}; r.query.forEach((v, k) => { if (k !== 'diff') query[k] = v; });
  if (rel) query.diff = rel;
  go(buildHash({ view: r.view, args: r.args, query }), !!r.diff);
}
/** Patch the task-related query keys at once (task, chat, diff): null removes one, undefined keeps it. No task = no chat/diff. */
export function setTaskQuery(patch) {
  const r = current;
  const query = {}; r.query.forEach((v, k) => { query[k] = v; });
  for (const k of ['task', 'chat', 'diff']) {
    if (!(k in patch) || patch[k] === undefined) continue;
    if (patch[k] == null) delete query[k]; else query[k] = patch[k];
  }
  if (!query.task) { delete query.chat; delete query.diff; }
  go(buildHash({ view: r.view, args: r.args, query }), true);
}
/** Patch arbitrary query keys of the current route (null removes one). Used by Workflows for `?run=R-3`. */
export function setQuery(patch, opts = {}) {
  const r = current;
  const query = {}; r.query.forEach((v, k) => { query[k] = v; });
  for (const k in patch) { if (patch[k] == null || patch[k] === '') delete query[k]; else query[k] = patch[k]; }
  go(buildHash({ view: r.view, args: r.args, query }), opts.replace !== false);
}
export function setArgs(args, opts = {}) {
  const r = current;
  const query = {}; r.query.forEach((v, k) => { query[k] = v; });
  go(buildHash({ view: r.view, args, query }), opts.replace !== false);
}

window.addEventListener('hashchange', handle);
window.addEventListener('popstate', handle);
