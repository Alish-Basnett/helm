// studio/pillmodel.js — pure logic for the floating Studio pill (no DOM, so node can test it).
import { docJobs, jobActive } from './sync.js';

/** Comments that "Apply all" would send: open ones, and conflicts (the user may have fixed the text and wants a retry). */
export const applicableCount = (comments) => (comments || []).filter((c) => c.state === 'open' || c.state === 'conflict').length;

/**
 * { kind, label, busy, n, m } for the pill header and the shelf dot.
 *   kind: 'missing' | 'drafting' | 'applying' | 'editing' | 'conflicts' | 'saved'
 * "applying n/m": m = comments in the running batch (same jobId as the first queued one), n = those the hub has already settled.
 */
export function pillStatus({ doc, comments = [], jobs = new Map(), dirty = false } = {}) {
  if (!doc) return { kind: 'missing', label: 'Not found', busy: false, n: 0, m: 0 };
  const hub = !/^L-/.test(String(doc.id));
  if (hub && jobActive(docJobs(jobs, doc.id).draft)) return { kind: 'drafting', label: 'Drafting', busy: true, n: 0, m: 0 };
  const queued = comments.filter((c) => c.state === 'queued');
  if (queued.length) {
    const jobId = queued[0].jobId;
    const batch = jobId ? comments.filter((c) => c.jobId === jobId) : queued;
    const m = batch.length, n = batch.filter((c) => c.state !== 'queued').length;
    return { kind: 'applying', label: `Applying ${n}/${m}`, busy: true, n, m };
  }
  if (dirty) return { kind: 'editing', label: 'Editing', busy: false, n: 0, m: 0 };
  const conflicts = comments.filter((c) => c.state === 'conflict').length;
  if (conflicts) return { kind: 'conflicts', label: conflicts === 1 ? '1 conflict' : `${conflicts} conflicts`, busy: false, n: conflicts, m: 0 };
  return { kind: 'saved', label: 'Saved', busy: false, n: 0, m: 0 };
}

/** A title short enough for a shelf chip. */
export function shortTitle(title, max = 16) {
  const t = String(title || '').replace(/\s+/g, ' ').trim() || 'Untitled';
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

/** Persisted pill state: only what a reload needs. Anything malformed becomes "nothing open". */
export function cleanPillState(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const docId = typeof o.docId === 'string' && /^[A-Za-z]-\d+$/.test(o.docId) ? o.docId : null;
  if (!docId) return { docId: null, open: false, minimised: false };
  const minimised = !!o.minimised;
  return { docId, open: !!o.open && !minimised, minimised };
}

/** The scale that fits an A4 sheet (210 mm = 793.7 px wide) into a pane `width` px wide, never enlarging past 1. */
export const A4_PX = 794;
export function paperScale(width, pad = 12) {
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0) return 1;
  return Math.max(0.2, Math.min(1, (w - pad * 2) / A4_PX));
}
