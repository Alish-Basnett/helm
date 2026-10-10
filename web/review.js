// review.js — logic for the Review queue (no DOM): the queue and its order, the "Checks:" list parsed from a task
// description, locally ticked checks, the "Reviewed today" counter and the Request changes template.
// Ticks and the counter are UI only: they live in localStorage and never reach the hub.
import { state, sel, lsGet, lsSet } from './store.js';

/* ---------- queue ---------- */
/** When the task entered Review: its agent finished then. Falls back to the last update (a gate card has no agent). */
export function reviewSince(t) {
  const a = t && t.agentId ? state.agents.get(t.agentId) : null;
  return (a && a.status !== 'running' && a.endedAt) || (t && t.updatedAt) || 0;
}

const idNum = (id) => { const m = /(\d+)$/.exec(String(id)); return m ? Number(m[1]) : 0; };

/** Every task in Review inside the project scope. 'oldest' = longest waiting first; 'newest' = most recent first. */
export function reviewQueue(order = 'oldest', scoped = true) {
  const list = sel.reviewTasks(scoped);
  const dir = order === 'newest' ? -1 : 1;
  return list.sort((a, b) => dir * (reviewSince(a) - reviewSince(b)) || dir * (idNum(a.id) - idNum(b.id)));
}

/* ---------- "Checks:" in the description (templates append one) ---------- */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
export function parseChecks(description) {
  const lines = String(description || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:#{1,6}\s*)?\**checks\**\s*:\s*\**\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    // "Checks: a; b" on one line is allowed too
    if (m[1].trim()) for (const part of m[1].split(/;\s*/)) if (part.trim()) out.push(part.trim());
    for (let j = i + 1; j < lines.length; j++) {
      const li = LIST_ITEM.exec(lines[j]);
      if (li) { out.push(li[1].replace(/^\[[ xX]\]\s*/, '')); continue; }
      if (!lines[j].trim() && !out.length) continue;
      break;
    }
    break;
  }
  return out.slice(0, 40);
}

/* ---------- ticked checks, per task, in localStorage ---------- */
const TICKS = 'helm.review.checks.';
export function loadTicks(taskId) {
  try { const v = JSON.parse(lsGet(TICKS + taskId, '[]')); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []); } catch { return new Set(); }
}
export function saveTicks(taskId, set) {
  lsSet(TICKS + taskId, set.size ? JSON.stringify([...set]) : null);
}

/* ---------- reviewed today ---------- */
const TODAY = 'helm.review.today';
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function readToday() {
  try {
    const v = JSON.parse(lsGet(TODAY, 'null'));
    if (v && v.day === dayKey() && Array.isArray(v.ids)) return v;
  } catch { /* fall through */ }
  return { day: dayKey(), ids: [] };
}
export const reviewedToday = () => readToday().ids.length;
export function markReviewed(id) {
  const v = readToday();
  if (!v.ids.includes(id)) { v.ids.push(id); lsSet(TODAY, JSON.stringify(v)); }
  return v.ids.length;
}
export function unmarkReviewed(id) {
  const v = readToday();
  if (v.ids.includes(id)) { v.ids = v.ids.filter((x) => x !== id); lsSet(TODAY, JSON.stringify(v)); }
  return v.ids.length;
}

/* ---------- Request changes ---------- */
export const CHANGE_TEMPLATE = 'Please change:\n- ';
export const CHANGE_CHIPS = ['Add tests', 'Fix lint', 'Update docs', 'Simplify'];
/** Add a chip's line to the composer text, replacing an empty trailing "- " bullet. */
export function withChip(text, chip) {
  let t = String(text || '');
  if (!t.trim()) t = CHANGE_TEMPLATE;
  t = t.replace(/(^|\n)- ?$/, '$1');
  if (t && !t.endsWith('\n')) t += '\n';
  return `${t}- ${chip}\n- `;
}
/** Anything beyond the bare template? */
export function hasChangeText(text) {
  return String(text || '').replace(/^\s*Please change:\s*/i, '').replace(/^[\s-]+$/gm, '').trim().length > 0;
}
/** The note the hub gets: `!` skips the cheap-answer path, so the agent (or a follow-up builder) always receives it. */
export const changeNoteText = (text) => `!${String(text).trim()}`;
