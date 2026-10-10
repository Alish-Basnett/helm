// wf/labels.js — step names and types for a run, remembered from the graph version the run was started on, so the run
// panel can say "Run tests" instead of "test" without fetching the workflow itself.
const byRun = new Map(); // runId -> { labels: Map, types: Map }
const listeners = new Set();
export function noteGraph(runId, graph) {
  const labels = new Map(), types = new Map();
  for (const n of graph.nodes) { labels.set(n.id, n.label); types.set(n.id, n.type); }
  byRun.set(runId, { labels, types });
  for (const fn of Array.from(listeners)) { try { fn(runId); } catch (e) { console.error(e); } }
}
export const labelsOf = (runId) => (byRun.get(runId) || {}).labels || new Map();
export const typesOf = (runId) => (byRun.get(runId) || {}).types || new Map();
export const hasGraph = (runId) => byRun.has(runId);
export function onLabels(fn) { listeners.add(fn); return () => listeners.delete(fn); }
