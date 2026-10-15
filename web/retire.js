// retire.js — which sessions and projects are "old" (hidden by default everywhere), and how bulk acknowledges are split. Pure: no DOM, unit-tested.

/** Hub limit for one POST /v1/ack is 1000 ids in all; we stay at half of it. */
export const ACK_CHUNK = 500;

export function chunk(list, n = ACK_CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** { agentIds, sessionIds, linkIds } -> several bodies of at most `size` ids in all, same order, nothing lost or repeated. */
export function splitAckBody(body, size = ACK_CHUNK) {
  const flat = [];
  for (const k of ['agentIds', 'sessionIds', 'linkIds']) for (const id of body[k] || []) flat.push([k, id]);
  return chunk(flat, size).map((part) => {
    const b = {};
    for (const [k, id] of part) (b[k] = b[k] || []).push(id);
    return b;
  });
}

const norm = (s) => String(s || '').trim().toLowerCase();
const idNum = (id) => { const m = /(\d+)$/.exec(String(id)); return m ? Number(m[1]) : 0; };

/** Same folder: exact match of `project.folder` (like the hub) when both have one; only when one has none (a hub that predates the field) the name decides. */
export function sameFolder(a, b) {
  if (a.folder && b.folder) return a.folder === b.folder;
  return !!norm(a.name) && norm(a.name) === norm(b.name);
}

/** b is newer than a: later createdAt, ties broken by the number in the id. */
const newerThan = (b, a) => { const d = (b.createdAt || 0) - (a.createdAt || 0); return d !== 0 ? d > 0 : idNum(b.id) > idNum(a.id); };

/**
 * Project ids that are old: archived, or a non-coordinator project with a newer-or-coordinator non-archived sibling for the same folder.
 * The coordinator project is never old (unless archived).
 */
export function oldProjectIds(projects) {
  const live = projects.filter((p) => !p.archived);
  const old = new Set();
  for (const p of projects) {
    if (p.archived) { old.add(p.id); continue; }
    if (p.coordinator) continue;
    if (live.some((q) => q.id !== p.id && sameFolder(p, q) && (q.coordinator || newerThan(q, p)))) old.add(p.id);
  }
  return old;
}

/** THE definition of an old session (store, Office model, every picker): it has ended AND (acknowledged, or its project is old). Live sessions are never old. */
export function retiredSessionIds(sessions, projects) {
  const old = oldProjectIds(projects);
  const out = new Set();
  for (const s of sessions) if (s.status === 'ended' && (s.acknowledgedAt || old.has(s.projectId))) out.add(s.id);
  return out;
}

/** The project to keep in a group of duplicates: the coordinator, else one with a live session, else the newest. */
export function pickKeep(projects, hasLive = () => false) {
  const rank = (p) => (p.coordinator ? 2 : 0) + (hasLive(p) ? 1 : 0);
  return projects.slice().sort((a, b) => rank(b) - rank(a) || (newerThan(b, a) ? 1 : -1))[0] || null;
}
