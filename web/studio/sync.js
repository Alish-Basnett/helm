// studio/sync.js — pure helpers for talking to the hub's /v1/docs (no DOM, no fetch, so node:test can load it).
// The editor works on plain { id, type, text } blocks; the hub stores richer blocks (marks, levels, tables). These helpers
// translate in both directions without ever overwriting what the editor cannot show.
import { BLOCK_TYPES } from './blocks.js';

/** What the editor shows for a hub block: its type if the editor knows it, and plain text (tables and images are flattened). */
export function toEditorBlock(b) {
  const type = BLOCK_TYPES.includes(b.type) ? b.type : 'p';
  let text = typeof b.text === 'string' ? b.text : '';
  if (b.type === 'table') text = (b.rows || []).map((r) => r.join(' | ')).join('\n').replace(/\n/g, ' / ');
  else if (b.type === 'img') text = `[image] ${text}`.trim();
  return { id: b.id, type, text };
}
export const toEditorBlocks = (list) => (Array.isArray(list) ? list : []).map(toEditorBlock);

/**
 * Edit ops (POST /v1/docs/:id/edit) that turn `base` (the editor-view of the hub's blocks) into `next` (the editor's blocks).
 * Only what changed is sent: a type change keeps the hub block's marks; a text change sends the text; untouched blocks
 * (including the tables and images the editor shows as flat text) are never written. Deletes come first, inserts are
 * placed after the block that precedes them in the editor and keep the id the editor gave them.
 */
export function diffBlocks(base, next) {
  const ops = [];
  const baseById = new Map(base.map((b) => [b.id, b]));
  const nextIds = new Set(next.map((b) => b.id));
  for (const b of base) if (!nextIds.has(b.id)) ops.push({ op: 'delete', blockId: b.id });
  let prev = null;
  for (const b of next) {
    const old = baseById.get(b.id);
    if (!old) ops.push({ op: 'insert', after: prev, block: { id: b.id, type: b.type, text: b.text } });
    else if (old.type !== b.type || old.text !== b.text) {
      const o = { op: 'set', blockId: b.id };
      if (old.type !== b.type) o.type = b.type;
      if (old.text !== b.text) o.text = b.text;
      ops.push(o);
    }
    prev = b.id;
  }
  return ops;
}

/** Hub comment -> the shape the Studio screen uses. */
export function toLocalComment(c) {
  const a = c.anchor || {};
  return {
    id: c.id, blockId: c.blockId ?? a.blockId ?? null, start: a.start ?? 0, end: a.end ?? 0, quote: a.quote ?? '',
    text: c.text, state: c.state, createdAt: c.createdAt, reason: c.reason ?? null, appliedVersion: c.appliedVersion ?? null, jobId: c.jobId ?? null,
  };
}

const LOCAL_ID = /^c\d+$/;
/**
 * What to send so the hub's comments match the screen's: comments with a local id (c1) are created, hub comments that are gone
 * from the screen are deleted (a queued one belongs to its job, so it is left alone), edited text is patched.
 */
export function diffComments(hub, local) {
  const hubById = new Map(hub.map((c) => [c.id, c]));
  const localIds = new Set(local.map((c) => c.id));
  const create = local.filter((c) => LOCAL_ID.test(c.id) && c.blockId);
  const del = hub.filter((c) => !localIds.has(c.id) && c.state !== 'queued').map((c) => c.id);
  const patch = local.filter((c) => hubById.has(c.id) && hubById.get(c.id).text !== c.text).map((c) => ({ id: c.id, text: c.text }));
  return { create, del, patch };
}

/** The newest doc_draft and doc_edit jobs for a document, from the jobs Map the store keeps. */
export function docJobs(jobs, docId) {
  let draft = null;
  for (const j of jobs.values ? jobs.values() : jobs) {
    if (!j || j.kind !== 'doc_draft' || !j.input || j.input.docId !== docId) continue;
    if (!draft || String(j.createdAt) > String(draft.createdAt) || (j.createdAt === draft.createdAt && j.id > draft.id)) draft = j;
  }
  return { draft };
}
export const jobActive = (j) => !!j && (j.state === 'queued' || j.state === 'running');

/** Plain-words progress for a running job: "Waiting for a Claude Code session…" or "Sonnet is working… 12 s". */
export function jobProgress(j, now, label = 'Sonnet is working') {
  if (!j) return '';
  if (j.state === 'queued') return 'Waiting for a Claude Code session to pick it up…';
  if (j.state === 'running') {
    const s = Math.max(0, Math.round((now - (j.claimedAt || j.createdAt || now)) / 1000));
    return `${label}… ${s} s`;
  }
  return '';
}

/** The comments the last Apply all applied, if the document is still exactly at that version (so Undo cannot lose later edits). */
export function undoableBatch(comments, version) {
  const done = comments.filter((c) => c.state === 'applied' && c.appliedVersion != null && c.appliedVersion === version);
  return done.length ? done : null;
}
