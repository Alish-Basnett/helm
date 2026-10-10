// wf/graph.js — the pure workflow model used by the canvas: node catalogue, edge rules, the editable Doc (with undo/redo and
// dirty tracking), auto layout and a change summary. No DOM here. The hub (hub/wfgraph.mjs) is the authority on validity;
// this file only knows enough to make editing pleasant (ids, defaults, cycle check, which edge kinds leave which node).

export const SCHEMA = 'helm.workflow/1';
export const GRID = 16;
export const NODE_W = 232;

/** What can be dropped on the canvas. `key` is the palette entry, `type` the graph node type. */
export const PALETTE = [
  { key: 'builder', type: 'agent', label: 'Builder', hint: 'Sonnet agent that writes code', icon: 'cpu', model: 'sonnet', group: 'Run' },
  { key: 'scout', type: 'agent', label: 'Scout', hint: 'Haiku agent that reads and reports', icon: 'search', model: 'haiku', group: 'Run' },
  { key: 'shell', type: 'shell', label: 'Shell check', hint: 'Run a command and pass or fail', icon: 'terminal', model: null, group: 'Run' },
  { key: 'review', type: 'review', label: 'Opus review', hint: 'Opus judges the work against a rubric', icon: 'sparkle', model: 'opus', group: 'Run' },
  { key: 'gate', type: 'gate', label: 'Gate', hint: 'Stop until you approve', icon: 'gate', model: null, group: 'Human' },
  { key: 'note', type: 'note', label: 'Note', hint: 'Documentation on the canvas', icon: 'note', model: null, group: 'Doc' },
];
export const TYPE_META = {
  agent: { icon: 'cpu', tone: 'agent' },
  shell: { icon: 'terminal', tone: 'shell' },
  gate: { icon: 'gate', tone: 'gate' },
  review: { icon: 'sparkle', tone: 'review' },
  note: { icon: 'note', tone: 'note' },
};
export const EDGE_KINDS = ['ok', 'fail', 'approved', 'rejected'];
export const EDGE_LABEL = { ok: 'ok', fail: 'fail', approved: 'approved', rejected: 'rejected' };
export const kindsFor = (type) => (type === 'gate' ? ['approved', 'rejected'] : ['ok', 'fail']);
export const defaultKind = (type) => (type === 'gate' ? 'approved' : 'ok');
export const isExec = (n) => n.type !== 'note';

const DEFAULT_CONFIG = {
  builder: () => ({ agent: 'builder', prompt: 'Describe what this step should do.' }),
  scout: () => ({ agent: 'scout', prompt: 'Describe what this step should look into.' }),
  shell: () => ({ argv: ['npm', 'test'], timeoutMs: 30000, passIf: 'exit0' }),
  review: () => ({ rubric: 'Correctness, security and scope creep.', inputs: ['text', 'files'] }),
  gate: () => ({ message: 'Look over the changes before continuing.', show: 'files' }),
  note: () => ({ text: 'Write a note for whoever reads this workflow.' }),
};
export const labelFor = (entry) => entry.label;

export const clone = (o) => JSON.parse(JSON.stringify(o));
/** JSON with sorted keys: a stable string to compare graphs by. */
export function canon(o) {
  if (Array.isArray(o)) return `[${o.map(canon).join(',')}]`;
  if (o && typeof o === 'object') return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  return JSON.stringify(o);
}
export const snap = (v, step = GRID) => Math.round(v / step) * step;

export function emptyGraph(name = 'Untitled workflow') { return { schema: SCHEMA, name, nodes: [], edges: [] }; }

export function uniqueId(base, taken) {
  const root = String(base || 'node').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'node';
  if (!taken.has(root)) return root;
  let i = 2;
  while (taken.has(`${root}${i}`)) i++;
  return `${root}${i}`;
}

export function makeNode(entry, pos, taken) {
  const id = uniqueId(entry.key, taken);
  const node = {
    id, type: entry.type, label: entry.label, position: { x: snap(pos.x), y: snap(pos.y) }, config: DEFAULT_CONFIG[entry.key](),
  };
  if (entry.type !== 'note') node.retry = { max: 0, backoffMs: 0 };
  return node;
}
export const entryOf = (node) => PALETTE.find((p) => p.type === node.type && (p.type !== 'agent' || (node.config && node.config.agent) === p.key))
  || PALETTE.find((p) => p.type === node.type);

/** Short model name for the badge, or null. */
export function modelOf(node) {
  if (node.type === 'agent') return node.config && node.config.agent === 'scout' ? 'haiku' : 'sonnet';
  if (node.type === 'review') return 'opus';
  return null;
}

export function joinArgs(argv) {
  return (argv || []).map((a) => (a === '' ? "''" : /[\s"'\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' ');
}
const firstLine = (s, n = 110) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
/** One line saying what the node does, for the card body. */
export function summarize(node) {
  const c = node.config || {};
  switch (node.type) {
    case 'agent': return firstLine(c.prompt);
    case 'shell': return firstLine(c.argv ? joinArgs(c.argv) : c.script);
    case 'gate': return firstLine(c.message);
    case 'review': return firstLine(c.rubric);
    case 'note': return String(c.text || '');
    default: return '';
  }
}

export function wouldCycle(graph, from, to) {
  if (from === to) return true;
  const out = new Map();
  for (const e of graph.edges) { if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e.to); }
  const seen = new Set();
  const stack = [to];
  while (stack.length) {
    const c = stack.pop();
    if (c === from) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    stack.push(...(out.get(c) || []));
  }
  return false;
}

/** A layered layout: x by rank (longest path from an entry), y by barycentre order inside the rank. Returns { id: {x,y} }. */
export function autoLayout(graph, { gapX = 320, gapY = 176, x0 = 80, y0 = 80 } = {}) {
  const exec = graph.nodes.filter(isExec);
  const rank = new Map(exec.map((n) => [n.id, 0]));
  for (let pass = 0; pass < exec.length; pass++) {
    let moved = false;
    for (const e of graph.edges) {
      if (rank.has(e.from) && rank.has(e.to) && rank.get(e.to) < rank.get(e.from) + 1) { rank.set(e.to, rank.get(e.from) + 1); moved = true; }
    }
    if (!moved) break;
  }
  const cols = new Map();
  for (const n of exec) { const r = rank.get(n.id); if (!cols.has(r)) cols.set(r, []); cols.get(r).push(n.id); }
  const order = new Map();
  [...cols.keys()].sort((a, b) => a - b).forEach((r) => {
    const ids = cols.get(r);
    const bary = (id) => {
      const ps = graph.edges.filter((e) => e.to === id && order.has(e.from)).map((e) => order.get(e.from));
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
    };
    ids.sort((a, b) => (bary(a) - bary(b)) || exec.findIndex((n) => n.id === a) - exec.findIndex((n) => n.id === b));
    ids.forEach((id, i) => order.set(id, i));
  });
  const pos = {};
  for (const n of exec) pos[n.id] = { x: x0 + rank.get(n.id) * gapX, y: y0 + order.get(n.id) * gapY };
  let ny = y0 + Math.max(0, ...[...order.values()]) * gapY + gapY;
  for (const n of graph.nodes.filter((x) => !isExec(x))) { pos[n.id] = { x: x0, y: ny }; ny += 120; }
  return pos;
}

/** "Added 2 steps, changed 1 step, removed 1 connection" between two graphs. */
export function summarizeChange(a, b) {
  const byId = (g) => new Map(g.nodes.map((n) => [n.id, n]));
  const A = byId(a), B = byId(b);
  let added = 0, removed = 0, changed = 0, moved = 0;
  for (const [id, n] of B) {
    const o = A.get(id);
    if (!o) added++;
    else if (canon({ ...n, position: 0 }) !== canon({ ...o, position: 0 })) changed++;
    else if (n.position.x !== o.position.x || n.position.y !== o.position.y) moved++;
  }
  for (const id of A.keys()) if (!B.has(id)) removed++;
  const ek = (e) => `${e.from}>${e.to}`;
  const EA = new Map(a.edges.map((e) => [ek(e), e])), EB = new Map(b.edges.map((e) => [ek(e), e]));
  let eAdded = 0, eRemoved = 0, eChanged = 0;
  for (const [k, e] of EB) { const o = EA.get(k); if (!o) eAdded++; else if (o.when !== e.when) eChanged++; }
  for (const k of EA.keys()) if (!EB.has(k)) eRemoved++;
  const bits = [];
  const word = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (added) bits.push(`Added ${word(added, 'step', 'steps')}`);
  if (changed) bits.push(`${bits.length ? 'changed' : 'Changed'} ${word(changed, 'step', 'steps')}`);
  if (removed) bits.push(`${bits.length ? 'removed' : 'Removed'} ${word(removed, 'step', 'steps')}`);
  if (eAdded) bits.push(`${bits.length ? 'added' : 'Added'} ${word(eAdded, 'connection', 'connections')}`);
  if (eChanged) bits.push(`${bits.length ? 'changed' : 'Changed'} ${word(eChanged, 'connection', 'connections')}`);
  if (eRemoved) bits.push(`${bits.length ? 'removed' : 'Removed'} ${word(eRemoved, 'connection', 'connections')}`);
  if (!bits.length && moved) bits.push(`Moved ${word(moved, 'step', 'steps')}`);
  if (canon(a.params || []) !== canon(b.params || [])) bits.push(`${bits.length ? 'edited' : 'Edited'} inputs`);
  return bits.join(', ') || 'No changes';
}

/**
 * The editable document. `graph` is mutated in place by `mutate`; every mutation pushes an undo checkpoint
 * (consecutive mutations with the same `key` inside 900 ms share one, so typing in a field is one undo step).
 */
export class Doc {
  constructor(graph) {
    this.load(graph);
    this.listeners = new Set();
  }
  load(graph) {
    this.graph = clone(graph);
    this.savedGraph = clone(graph);
    this.savedKey = canon(this.graph);
    this.undoStack = [];
    this.redoStack = [];
    this.lastKey = null;
    this.lastAt = 0;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind) { for (const fn of Array.from(this.listeners)) { try { fn(kind); } catch (e) { console.error(e); } } }
  get dirty() { return canon(this.graph) !== this.savedKey; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  node(id) { return this.graph.nodes.find((n) => n.id === id) || null; }
  edge(id) { return this.graph.edges.find((e) => e.id === id) || null; }
  mutate(fn, key = null) {
    const now = Date.now();
    if (!(key && key === this.lastKey && now - this.lastAt < 900)) {
      this.undoStack.push(JSON.stringify(this.graph));
      if (this.undoStack.length > 120) this.undoStack.shift();
    }
    this.redoStack = [];
    this.lastKey = key;
    this.lastAt = now;
    fn(this.graph);
    this.emit('change');
  }
  /** A drag changed the graph in place; record the pre-drag JSON as one undo step. */
  commitFrom(preJson) {
    if (preJson === JSON.stringify(this.graph)) return;
    this.undoStack.push(preJson);
    if (this.undoStack.length > 120) this.undoStack.shift();
    this.redoStack = [];
    this.lastKey = null;
    this.emit('change');
  }
  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.graph));
    this.graph = JSON.parse(this.undoStack.pop());
    this.lastKey = null;
    this.emit('history');
    return true;
  }
  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.graph));
    this.graph = JSON.parse(this.redoStack.pop());
    this.lastKey = null;
    this.emit('history');
    return true;
  }
  /** After a successful save: adopt the hub's normalised graph as the clean state (history is kept). */
  markSaved(graph) {
    this.graph = clone(graph);
    this.savedGraph = clone(graph);
    this.savedKey = canon(this.graph);
    this.lastKey = null;
    this.emit('saved');
  }
  /** Replace the whole graph as one undoable step (restore a version, tidy). */
  replace(graph) { this.mutate((g) => { g.nodes = clone(graph.nodes); g.edges = clone(graph.edges); if (graph.params) g.params = clone(graph.params); else delete g.params; }); }
  freshId(entryKey) { return uniqueId(entryKey, new Set(this.graph.nodes.map((n) => n.id))); }
  freshEdgeId() {
    const taken = new Set(this.graph.edges.map((e) => e.id));
    let i = this.graph.edges.length + 1;
    while (taken.has(`e${i}`)) i++;
    return `e${i}`;
  }
}
