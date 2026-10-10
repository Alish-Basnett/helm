// router.js — hash router: #/<view>/<arg…>?task=T-1  (the sheet is a query param so it is linkable).
export const VIEWS = ['board', 'projects', 'office', 'threads', 'inbox', 'learn'];

export function parseHash(hash = location.hash) {
  const raw = (hash || '').replace(/^#/, '') || '/board';
  const [pathPart, queryPart = ''] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  const view = VIEWS.includes(segs[0]) ? segs[0] : 'board';
  const query = new URLSearchParams(queryPart);
  return { view, args: segs.slice(1), query, task: query.get('task') || null };
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
export function openTask(id) {
  const r = current;
  const query = {}; r.query.forEach((v, k) => { query[k] = v; });
  query.task = id;
  go(buildHash({ view: r.view, args: r.args, query }), false);
}
export function closeTask() {
  const r = current;
  const query = {}; r.query.forEach((v, k) => { if (k !== 'task') query[k] = v; });
  go(buildHash({ view: r.view, args: r.args, query }), true);
}
export function setArgs(args, opts = {}) {
  const r = current;
  const query = {}; r.query.forEach((v, k) => { query[k] = v; });
  go(buildHash({ view: r.view, args, query }), opts.replace !== false);
}

window.addEventListener('hashchange', handle);
window.addEventListener('popstate', handle);
