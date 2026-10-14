// The project brief for a Studio `doc_draft` job (CONTRACT v0.25). Without it the model only sees the user's one-line request
// and invents what the project is. The brief is a compact markdown string built hub-side from what Helm already knows:
// the project name and folder, the README's first lines, the headline of plan.md, the project's top Learn concepts and the
// "what" lines of its latest task recaps. It is capped (about 2.5k tokens) and treated by the model as reference data.
//
// Reading files: only README.md and plan.md in the folder of the project's session, only the first few KB, only a regular file
// that is not a symlink. Anything else (missing, unreadable, a folder) just leaves that section out. No clock, no randomness.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BRIEF_MAX_CHARS = 9000;      // ~2.3k tokens at 4 characters per token; the contract promises "about 2.5k"
export const README_CHARS = 1500;
export const PLAN_CHARS = 600;
export const BRIEF_CONCEPTS = 8;
export const BRIEF_RECAPS = 6;
export const RECAP_CHARS = 200;
const READ_BYTES = 6000;
export const estimateTokens = (s) => Math.ceil(String(s).length / 4);

const cut = (s, n) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : s; };
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

/** First `max` bytes of a regular, non-symlink file as text, or null. Never throws. */
export function readHead(file, max = READ_BYTES) {
  let fd = null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(max, st.size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').replace(/�+$/, '');
  } catch { return null; } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ } }
}

/** README or plan text with badge/image lines, HTML comments and runs of blank lines removed, cut to `max` at a line end where it can. */
export function excerpt(text, max) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n')
    .filter((l) => !/^\s*(\[!\[|!\[|<img\b|<p align)/i.test(l))
    .map((l) => l.replace(/\s+$/, ''));
  const t = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= max) return t;
  const hard = t.slice(0, max);
  const nl = hard.lastIndexOf('\n');
  return (nl > max * 0.6 ? hard.slice(0, nl) : hard).trimEnd() + '\n…';
}
/** The first markdown heading of plan.md, or its first non-empty line. */
export function planHeadline(text) {
  for (const l of String(text || '').split('\n')) { const t = l.trim(); if (t) return t.replace(/^#+\s*/, ''); }
  return '';
}

const tilde = (p) => { const h = os.homedir(); return h && (p === h || p.startsWith(h + path.sep)) ? '~' + p.slice(h.length) : p; };

/**
 * Compose the brief. All parts are optional.
 *   { name, path, readme, plan, concepts: [{name, count}], recaps: [{id, title, what}] }
 * Returns { text, tokens, sections }. The text never exceeds `max` characters: sections are budgeted when they are built, and a
 * final hard cut (with an ellipsis) guards the total.
 */
export function buildBrief({ name, path: dir, readme, plan, concepts = [], recaps = [] } = {}, { max = BRIEF_MAX_CHARS } = {}) {
  const parts = [];
  const sections = [];
  const add = (key, text) => { if (text) { parts.push(text); sections.push(key); } };
  add('project', `Project: ${cut(name || 'unnamed', 120)}${dir ? ` (folder: ${tilde(dir)})` : ''}`);
  const r = excerpt(readme, README_CHARS);
  if (r) add('readme', `README (start of the file):\n${r}`);
  const p = excerpt(plan, PLAN_CHARS);
  if (p) add('plan', `plan.md (headline: ${cut(planHeadline(plan), 120)}):\n${p}`);
  const cs = concepts.slice(0, BRIEF_CONCEPTS).map((c) => `${cut(c.name, 40)}${c.count > 1 ? ` (${c.count} tasks)` : ''}`);
  if (cs.length) add('concepts', `Top Learn concepts in this project: ${cs.join(', ')}`);
  const rs = recaps.slice(0, BRIEF_RECAPS).filter((x) => x.what).map((x) => `- ${x.id}${x.title ? ` ${cut(x.title, 60)}` : ''}: ${cut(x.what, RECAP_CHARS)}`);
  if (rs.length) add('recaps', `Latest finished work (task recaps):\n${rs.join('\n')}`);
  let text = parts.join('\n\n');
  if (text.length > max) text = text.slice(0, Math.max(0, max - 2)).trimEnd() + ' …';
  return { text, tokens: estimateTokens(text), sections };
}

/** The folder to read for a project: the folder of the session that will run the job, else its most recent session with one. */
export function projectFolder(db, projectId, sessionId) {
  const ok = (cwd) => (cwd && path.isAbsolute(cwd) ? cwd : null);
  const own = sessionId ? ok(db.get('SELECT cwd FROM sessions WHERE id = ?', sessionId)?.cwd) : null;
  return own || ok(db.get(`SELECT cwd FROM sessions WHERE project_id = ? AND cwd != '' ORDER BY last_seen_at DESC, rowid DESC LIMIT 1`, projectId)?.cwd);
}

/** Gather everything the hub knows about a project and build its brief. Cheap: two small file reads and two indexed queries. */
export function gatherBrief(db, project, sessionId = null, opts = {}) {
  const dir = projectFolder(db, project.id, sessionId);
  let readme = null, plan = null;
  if (dir) {
    for (const f of ['README.md', 'Readme.md', 'readme.md', 'README']) { readme = readHead(path.join(dir, f)); if (readme) break; }
    plan = readHead(path.join(dir, 'plan.md'));
  }
  const concepts = db.all(
    `SELECT c.name AS name, COUNT(*) AS count FROM concept_tasks ct
       JOIN tasks t ON t.id = ct.task_id JOIN concepts c ON c.slug = ct.slug
      WHERE t.project_id = ? GROUP BY c.slug ORDER BY count DESC, MAX(ct.at) DESC, c.name LIMIT ${BRIEF_CONCEPTS}`, project.id);
  const recaps = db.all(
    `SELECT id, title, recap FROM tasks WHERE project_id = ? AND recap IS NOT NULL ORDER BY recap_at DESC, rowid DESC LIMIT ${BRIEF_RECAPS}`, project.id)
    .map((t) => ({ id: t.id, title: t.title, what: parse(t.recap, null)?.what || '' }));
  return buildBrief({ name: project.name, path: dir, readme, plan, concepts, recaps }, opts);
}
