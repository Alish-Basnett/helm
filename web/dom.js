// dom.js — tiny DOM toolkit: hyperscript, keyed list reconcile, tickers, event bus.
import { fmtElapsed, fmtAgo } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProps(el, props) {
  if (!props) return;
  for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'style' && typeof v === 'object') {
      for (const sk in v) {
        if (sk.startsWith('--')) el.style.setProperty(sk, v[sk]);
        else el.style[sk] = v[sk];
      }
    } else if (k === 'ref') v(el);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** h('div', {class:'x'}, child…) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

/** SVG variant */
export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function setText(el, text) {
  text = text == null ? '' : String(text);
  if (el.textContent !== text) el.textContent = text;
}
export function setAttr(el, name, value) {
  if (value == null || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else {
    const v = value === true ? '' : String(value);
    if (el.getAttribute(name) !== v) el.setAttribute(name, v);
  }
}
export function setClass(el, name, on) {
  if (el.classList.contains(name) !== !!on) el.classList.toggle(name, !!on);
}
export function setHidden(el, hidden) {
  if (el.hidden !== !!hidden) el.hidden = !!hidden;
}

export const reducedMotion = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/**
 * Keyed list reconcile. `parent` must hold only keyed children.
 * create(item, animate) → element ; update(el, item, index)
 */
export function reconcile(parent, items, keyFn, create, update) {
  let map = parent.__keyed;
  if (!map) map = parent.__keyed = new Map();
  const animate = !!parent.__rendered;
  const wanted = new Set();
  for (const it of items) wanted.add(keyFn(it));
  for (const [k, el] of map) {
    if (!wanted.has(k)) { el.remove(); map.delete(k); }
  }
  let ref = parent.firstChild;
  let i = 0;
  for (const it of items) {
    const key = keyFn(it);
    let el = map.get(key);
    if (!el) {
      el = create(it, animate);
      el.__key = key;
      map.set(key, el);
    }
    if (update) update(el, it, i);
    if (el === ref) ref = ref.nextSibling;
    else parent.insertBefore(el, ref);
    i++;
  }
  parent.__rendered = true;
  return map;
}

/** Simple pub/sub bus. */
const handlers = new Map();
export const bus = {
  on(evt, fn) {
    if (!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt).add(fn);
    return () => handlers.get(evt)?.delete(fn);
  },
  emit(evt, payload) {
    const set = handlers.get(evt);
    if (set) for (const fn of Array.from(set)) { try { fn(payload); } catch (e) { console.error(e); } }
  },
};

/** Schedule once per frame; falls back to a timeout when rAF is throttled. */
export function frameBatch(fn) {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    let done = false;
    const run = () => { if (done) return; done = true; scheduled = false; fn(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    setTimeout(run, 80);
  };
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Type a string into an element, quickly. Honours reduced motion. */
export function typeOn(el, text, onStep) {
  text = String(text ?? '');
  if (reducedMotion() || document.hidden || text.length < 3) { el.textContent = text; onStep && onStep(); return; }
  const n = text.length;
  const dur = Math.min(650, n * 14);
  const t0 = performance.now();
  el.textContent = '';
  el.classList.add('typing');
  const step = (now) => {
    if (!el.isConnected) return;
    const k = Math.min(n, Math.ceil(((now - t0) / dur) * n));
    el.textContent = text.slice(0, k);
    onStep && onStep();
    if (k < n) requestAnimationFrame(step);
    else el.classList.remove('typing');
  };
  requestAnimationFrame(step);
  setTimeout(() => { if (el.textContent !== text) { el.textContent = text; el.classList.remove('typing'); onStep && onStep(); } }, dur + 400);
}

/** Render snippet text with <mark> only — everything else stays text. */
export function renderSnippet(snippet) {
  const frag = document.createDocumentFragment();
  const parts = String(snippet ?? '').split(/(<mark>|<\/mark>)/i);
  let mark = null;
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === '<mark>') { mark = document.createElement('mark'); continue; }
    if (low === '</mark>') { if (mark) frag.appendChild(mark); mark = null; continue; }
    if (!p) continue;
    (mark || frag).appendChild(document.createTextNode(p));
  }
  if (mark) frag.appendChild(mark);
  return frag;
}

/** 1 Hz ticker for live elapsed / relative-time labels. */
let tickerStarted = false;
export function startTicker() {
  if (tickerStarted) return;
  tickerStarted = true;
  const tick = () => {
    const now = Date.now();
    for (const el of document.querySelectorAll('[data-since]')) {
      const t = Number(el.getAttribute('data-since'));
      if (t) setText(el, fmtElapsed(now - t));
    }
    for (const el of document.querySelectorAll('[data-ago]')) {
      const t = Number(el.getAttribute('data-ago'));
      if (t) setText(el, (el.getAttribute('data-ago-prefix') || '') + fmtAgo(t, now));
    }
  };
  setInterval(tick, 1000);
  tick();
}
