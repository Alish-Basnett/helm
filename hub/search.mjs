// FTS5 search + learn aggregation.
import { toTask } from './projections.mjs';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** Turn arbitrary user text into a safe FTS5 expression: every word becomes a quoted prefix term. */
export function toFtsQuery(q) {
  const words = String(q ?? '').match(/[\p{L}\p{N}_]+/gu) || [];
  const terms = words.slice(0, 12).map((w) => `"${w.slice(0, 64)}"*`);
  return terms.join(' ');
}

const SQL = `
SELECT d.kind AS kind, d.ref AS ref, d.title AS title, d.session_id AS session_id, d.task_id AS task_id,
       d.at AS at,
       snippet(search, -1, char(1), char(2), '…', 14) AS snip,
       COALESCE(CASE d.kind WHEN 'project' THEN d.ref END, t.project_id, s.project_id, dg.project_id, wf.project_id, tt.project_id, dc.project_id) AS project_id
FROM search
JOIN search_docs d ON d.id = search.rowid
LEFT JOIN tasks t ON t.id = d.task_id
LEFT JOIN sessions s ON s.id = d.session_id
LEFT JOIN digests dg ON d.kind = 'digest' AND dg.id = d.ref
LEFT JOIN workflows wf ON d.kind = 'workflow' AND wf.id = d.ref
LEFT JOIN templates tt ON d.kind = 'template' AND tt.id = d.ref
LEFT JOIN docs dc ON d.kind = 'doc' AND dc.id = d.ref
WHERE search MATCH ?
ORDER BY bm25(search, 5.0, 1.0), d.at DESC
LIMIT ?`;

export function search(db, q, limit = 30, log) {
  const expr = toFtsQuery(q);
  if (!expr) return [];
  let rows;
  try {
    rows = db.all(SQL, expr, limit);
  } catch (e) {
    log?.warn(`search failed for ${JSON.stringify(expr)}: ${e.message}`);
    return [];
  }
  return rows.map((r) => ({
    kind: r.kind,
    id: r.ref,
    title: r.title,
    // text is HTML-escaped; the only markup is <mark>…</mark>, so it is safe for innerHTML
    snippet: escapeHtml(r.snip || '').replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>'),
    projectId: r.project_id ?? null,
    sessionId: r.session_id ?? null,
    taskId: r.task_id ?? null,
    at: r.at,
  }));
}

export function learn(db, projectId) {
  const rows = projectId
    ? db.all('SELECT * FROM tasks WHERE recap IS NOT NULL AND project_id = ? ORDER BY recap_at DESC, rowid DESC', projectId)
    : db.all('SELECT * FROM tasks WHERE recap IS NOT NULL ORDER BY recap_at DESC, rowid DESC');
  const map = new Map();
  for (const r of rows) {
    const t = toTask(r);
    for (const c of t.recap.concepts || []) {
      const key = c.toLowerCase();
      let e = map.get(key);
      if (!e) { e = { name: c, count: 0, recaps: [] }; map.set(key, e); }
      e.count++;
      e.recaps.push({
        taskId: t.id, title: t.title, what: t.recap.what, how: t.recap.how, learned: t.recap.learned,
        at: r.recap_at ?? t.updatedAt,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
