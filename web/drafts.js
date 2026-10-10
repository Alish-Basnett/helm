// Composer drafts survive reloads and re-renders: what you type is kept per target until it is sent.
const KEY = 'helm.drafts';

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}
function writeAll(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage blocked: keep in memory only */ }
}

/**
 * Restore the saved draft into `ta` and keep saving it as the user types.
 * opts.base: the text the box starts from when it is editing something that already exists (a task description):
 * a saved draft then replaces it, and text equal to `base` is not worth keeping.
 */
export function bindDraft(ta, key, opts = {}) {
  const base = opts.base;
  const saved = readAll()[key];
  if (saved && (base != null ? saved !== base : !ta.value)) {
    ta.value = saved;
    // let auto-grow and the code-mode highlight layer catch up
    queueMicrotask(() => ta.dispatchEvent(new Event('input', { bubbles: true })));
  }
  let t = 0;
  ta.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const all = readAll();
      if (ta.value.trim() && ta.value !== base) all[key] = ta.value; else delete all[key];
      writeAll(all);
    }, 250);
  });
}

/** The saved draft text for `key`, or ''. */
export function getDraft(key) { return readAll()[key] || ''; }

export function clearDraft(key) {
  const all = readAll();
  if (key in all) { delete all[key]; writeAll(all); }
}

/** True when any composer on screen holds unsent text or has focus: never reload under the user's hands. */
export function userIsBusy() {
  const el = document.activeElement;
  if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return true;
  return [...document.querySelectorAll('textarea')].some((t) => t.value.trim());
}
