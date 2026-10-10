// git.js — pure helpers for the branch / PR / CI feature (no DOM): the CI summary used by the board glyph, the Git
// section and needsYou; safe links; the branch name the hub will pick. Keeps text from git and GitHub out of markup.

/** Same slug as the hub (hub/gitflow.mjs slugify): the preview shows the name before the branch exists. */
export function slugify(title) {
  const s = String(title || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'task';
}
export const branchNameFor = (taskId, title) => `helm/${taskId}-${slugify(title)}`;
export const shortSha = (s) => String(s || '').slice(0, 8);

/** Only http(s) links are ever put in an href. */
export function safeHref(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
}

/** { tone: 'ok'|'bad'|'wait'|'none'|'unknown', label } for a Task.branch.ci, or null when there is nothing to show. */
export function ciSummary(ci) {
  if (!ci || !ci.state) return null;
  const n = (ci.checks || []).length;
  switch (ci.state) {
    case 'success': return { tone: 'ok', label: n === 1 ? 'CI passing' : `CI passing · ${n}` };
    case 'failure': {
      const bad = (ci.checks || []).filter((c) => c.conclusion && !['success', 'neutral', 'skipped'].includes(c.conclusion)).length;
      return { tone: 'bad', label: bad > 1 ? `CI failing · ${bad}` : 'CI failing' };
    }
    case 'pending': return { tone: 'wait', label: 'CI running' };
    case 'none': return { tone: 'none', label: 'No checks yet' };
    default: return { tone: 'unknown', label: 'CI unknown' };
  }
}
/** Tone of one check run. */
export function checkTone(c) {
  if (!c) return 'none';
  if (c.status !== 'completed') return 'wait';
  if (['success', 'neutral', 'skipped'].includes(c.conclusion)) return 'ok';
  return 'bad';
}
export const checkLabel = (c) => (c.status !== 'completed' ? c.status.replace('_', ' ') : c.conclusion || 'done');

/** The PR chip: "#123 open" / "merged" / "closed", or a bare "PR" when the URL had no number. */
export function prChip(pr) {
  if (!pr) return null;
  const state = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
  return { state, text: `${pr.number != null ? '#' + pr.number : 'PR'} ${state}` };
}
/** Commits made after the last push. */
export const unpushed = (b) => !!b && !!b.commit && (!b.pushedCommit || b.pushedCommit !== b.commit);
