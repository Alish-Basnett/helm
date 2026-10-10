// router.js — hash router: #/<view>/<arg…>?task=T-1&chat=1  (task details + chat are query params so they are linkable).
import { lsGet, lsSet } from './store.js';
export const VIEWS = ['board', 'projects', 'office', 'threads', 'inbox', 'learn', 'settings'];

export function parseHash(hash = location.hash) {
  const raw = (hash || '').replace(/^#/, '') || '/board';
  const [pathPart, queryPart = ''] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  const view = VIEWS.includes(segs[0]) ? segs[0] : 'board';
  const query = new URLSearchParams(queryPart);
  const task = query.get('task') || null;
  return { view, args: segs.slice(1), query, task, chat: !!task && query.get('chat') === '1' };
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
/** Open a task's details, plus its chat when the remembered preference says so. */
export function openTask(id) {
  const r = current;
  const query = {}; r.query.forEach((v, k) => { query[k] = v; });
  query.task = id;
  if (chatPref()) query.chat = '1'; else delete query.chat;
  go(buildHash({ view: r.view, args: r.args, query }), false);
}
export function closeTask() {
  const r = current;
  const query = {}; r.query.forEach((v, k) => { if (k !== 'task' && k !== 'chat') query[k] = v; });
  go(buildHash({ view: r.view, args: r.args, query }), true);
}
/** Show/hide the open task's chat panel; remembers the choice for the next task. */
export function setChat(on) {
  const r = current;
  lsSet('helm.chat', on ? '1' : '0');
  if (!r.task) return;
  const query = {}; r.query.forEach((v, k) => { if (k !== 'chat') query[k] = v; });
  if (on) query.chat = '1';
  go(buildHash({ view: r.view, args: r.args, query }), true);
}
export function setArgs(args, opts = {}) {
  const r = current;
  const query = {}; r.query.forEach((v, k) => { query[k] = v; });
  go(buildHash({ view: r.view, args, query }), opts.replace !== false);
}

window.addEventListener('hashchange', handle);
window.addEventListener('popstate', handle);
