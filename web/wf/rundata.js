// wf/rundata.js — full run detail (steps with inputs/results) for the run being looked at. The store's `run` rows carry
// nodes; the steps (attempts, per-attempt errors) come from GET /v1/runs/:id, refreshed when the run row changes.
import { api } from '../api.js';

const cache = new Map(); // runId -> { sig, data, at }
const listeners = new Set();
const timers = new Map();

const sigOf = (run) => `${run.status}|${run.costUsd}|${run.nodes.map((n) => `${n.nodeId}:${n.state}:${n.attempt}`).join(',')}`;
export const detailOf = (runId) => (cache.get(runId) || {}).data || null;
export function onDetail(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Make sure the detail for this run row is fresh (debounced; cheap to call on every store update). */
export function ensureDetail(run) {
  if (!run) return;
  const hit = cache.get(run.id);
  const sig = sigOf(run);
  if (hit && hit.sig === sig) return;
  clearTimeout(timers.get(run.id));
  timers.set(run.id, setTimeout(async () => {
    try {
      const data = await api.run(run.id);
      cache.set(run.id, { sig, data, at: Date.now() });
      for (const fn of Array.from(listeners)) { try { fn(run.id); } catch (e) { console.error(e); } }
    } catch { /* hub briefly down: the next store update retries */ }
  }, hit ? 250 : 0));
  if (!hit) cache.set(run.id, { sig: '', data: null, at: 0 });
}
