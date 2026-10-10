// prefs.js — appearance + Talk settings. One source of truth: localStorage (try/catch via lsGet/lsSet) mirrored onto
// <html> as data-* attributes, so CSS custom properties and classes react instantly. theme-init.js applies the same
// attributes before first paint (keep the two in step).
import { lsGet, lsSet } from './store.js';

export const OPTIONS = {
  theme: ['system', 'light', 'dark'],
  accent: ['cyan', 'blue', 'indigo', 'green', 'orange', 'pink'],
  fs: ['s', 'm', 'l'],
  density: ['comfortable', 'compact'],
  code: ['off', 'on'],
  codestyle: ['js', 'ts', 'py'],
};
export const DEFAULTS = { theme: 'system', accent: 'cyan', fs: 'm', density: 'comfortable', code: 'off', codestyle: 'js' };
const KEY = { theme: 'helm.theme', accent: 'helm.accent', fs: 'helm.fs', density: 'helm.density', code: 'helm.code', codestyle: 'helm.codestyle' };

const values = {};
for (const k in KEY) {
  const v = lsGet(KEY[k], DEFAULTS[k]);
  values[k] = OPTIONS[k].includes(v) ? v : DEFAULTS[k];
}
const listeners = new Set();

export const getPref = (k) => values[k];
export const codeOn = () => values.code === 'on';

/** Mirror every preference onto <html>. Defaults remove the attribute so stock CSS is untouched. */
export function applyPrefs() {
  const root = document.documentElement;
  const put = (name, v, def) => { if (v === def) root.removeAttribute(name); else root.setAttribute(name, v); };
  put('data-theme', values.theme, 'system');
  put('data-accent', values.accent, 'cyan');
  put('data-fs', values.fs, 'm');
  put('data-density', values.density, 'comfortable');
  put('data-code', values.code, 'off');
  root.setAttribute('data-codestyle', values.codestyle);
}

export function setPref(k, v) {
  if (!(k in KEY) || !OPTIONS[k].includes(v) || values[k] === v) return;
  values[k] = v;
  lsSet(KEY[k], v === DEFAULTS[k] ? null : v);
  applyPrefs();
  for (const fn of Array.from(listeners)) { try { fn(k, v); } catch (e) { console.error(e); } }
}
export function resetAppearance() { for (const k of ['theme', 'accent', 'fs', 'density']) setPref(k, DEFAULTS[k]); }

/** fn(key, value) after any change. Returns an unsubscribe. */
export function onPrefs(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function cycleTheme() {
  const o = OPTIONS.theme;
  setPref('theme', o[(o.indexOf(values.theme) + 1) % o.length]);
}
