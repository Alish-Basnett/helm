// Workflow graph validator for schema `helm.workflow/1`. Pure, no dependencies, safe to import anywhere.
//
//   const { ok, issues, graph } = validateGraph(input)
//
// `issues` is a list of { level: 'error' | 'warn', code, message, nodeId?, edgeId?, field? }. `ok` is true when there is no
// error (warnings never block). `graph` is the normalised copy that is stored: defaults filled, unknown config keys
// dropped (each one reported as a warning), edge `when` defaulted by source type (ok for work nodes, approved for a gate).
// Unknown node types are an error, never dropped silently.

export const SCHEMA = 'helm.workflow/1';
export const NODE_TYPES = ['agent', 'shell', 'gate', 'review', 'note'];
export const EXEC_TYPES = ['agent', 'shell', 'gate', 'review'];
export const EDGE_KINDS = ['ok', 'fail', 'approved', 'rejected'];
export const AGENT_KINDS = ['builder', 'scout'];
export const OUTPUT_KEYS = {
  agent: ['text', 'ok', 'filesChanged', 'taskId'],
  shell: ['text', 'ok', 'check'],
  review: ['text', 'ok', 'verdict', 'findings'],
  gate: ['approved', 'comment'],
};
export const LIMITS = { nodes: 60, edges: 200, bytes: 256 * 1024, text: 20000, label: 120, name: 200 };
export const SHELL_TIMEOUT = { min: 1000, max: 600_000, def: 30_000 };

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PARAM_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const REF_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const isStr = (v) => typeof v === 'string';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Template references found in a string: [{ kind: 'params', key } | { kind: 'inputs', nodeId, key }, ...]. */
export function templateRefs(text) {
  const out = [];
  if (!isStr(text)) return out;
  for (const m of text.matchAll(REF_RE)) {
    const parts = m[1].split('.');
    if (parts[0] === 'params' && parts.length === 2) out.push({ kind: 'params', key: parts[1], raw: m[0] });
    else if (parts[0] === 'inputs' && parts.length === 3) out.push({ kind: 'inputs', nodeId: parts[1], key: parts[2], raw: m[0] });
    else out.push({ kind: 'bad', raw: m[0] });
  }
  return out;
}

/** Default edge kind for an edge leaving a node of this type. */
export const defaultWhen = (type) => (type === 'gate' ? 'approved' : 'ok');
export const allowedWhen = (type) => (type === 'gate' ? ['approved', 'rejected'] : ['ok', 'fail']);

export function validateGraph(input) {
  const issues = [];
  const err = (code, message, extra = {}) => issues.push({ level: 'error', code, message, ...extra });
  const warn = (code, message, extra = {}) => issues.push({ level: 'warn', code, message, ...extra });
  const done = (graph = null) => ({ ok: !issues.some((i) => i.level === 'error'), issues, graph });

  if (!isObj(input)) { err('graph', 'graph must be an object'); return done(); }
  let size = 0;
  try { size = JSON.stringify(input).length; } catch { err('graph', 'graph is not serialisable'); return done(); }
  if (size > LIMITS.bytes) { err('size', `graph is too large (${size} bytes, limit ${LIMITS.bytes})`); return done(); }
  if (input.schema !== SCHEMA) err('schema', `schema must be "${SCHEMA}"`, { field: 'schema' });

  let name = '';
  if (input.name !== undefined) {
    if (!isStr(input.name)) err('name', 'name must be a string', { field: 'name' });
    else name = input.name.trim().slice(0, LIMITS.name);
  }

  // ------------------------------------------------------------------ params
  const params = [];
  if (input.params !== undefined) {
    if (!Array.isArray(input.params)) err('params', 'params must be an array', { field: 'params' });
    else {
      const seen = new Set();
      input.params.forEach((p, i) => {
        if (!isObj(p) || !isStr(p.key) || !PARAM_RE.test(p.key)) { err('param', `params[${i}].key must match ${PARAM_RE}`, { field: 'params' }); return; }
        if (seen.has(p.key)) { err('param', `duplicate param "${p.key}"`, { field: 'params' }); return; }
        seen.add(p.key);
        const type = p.type === 'line' ? 'line' : 'text';
        const out = { key: p.key, label: isStr(p.label) && p.label.trim() ? p.label.trim().slice(0, 120) : p.key, type };
        if (p.default !== undefined) { if (isStr(p.default)) out.default = p.default.slice(0, LIMITS.text); else err('param', `param "${p.key}" default must be a string`, { field: 'params' }); }
        if (p.required !== undefined) out.required = p.required === true;
        params.push(out);
      });
    }
  }
  const paramKeys = new Set(params.map((p) => p.key));

  // ------------------------------------------------------------------- nodes
  const nodes = [];
  const byId = new Map();
  if (!Array.isArray(input.nodes)) { err('nodes', 'nodes must be an array', { field: 'nodes' }); return done(); }
  if (input.nodes.length > LIMITS.nodes) err('nodes', `at most ${LIMITS.nodes} nodes`, { field: 'nodes' });
  input.nodes.slice(0, LIMITS.nodes).forEach((n, i) => {
    if (!isObj(n)) { err('node', `nodes[${i}] must be an object`); return; }
    const id = n.id;
    if (!isStr(id) || !ID_RE.test(id)) { err('node-id', `nodes[${i}].id must match ${ID_RE}`, { field: 'id' }); return; }
    if (byId.has(id)) { err('node-id', `duplicate node id "${id}"`, { nodeId: id }); return; }
    if (!NODE_TYPES.includes(n.type)) { err('node-type', `unknown node type "${String(n.type)}" on "${id}"`, { nodeId: id, field: 'type' }); return; }
    const node = { id, type: n.type, label: '', position: { x: 0, y: 0 }, config: {} };
    if (n.label !== undefined && !isStr(n.label)) err('label', `"${id}": label must be a string`, { nodeId: id, field: 'label' });
    node.label = (isStr(n.label) && n.label.trim() ? n.label.trim() : n.type[0].toUpperCase() + n.type.slice(1)).slice(0, LIMITS.label);
    if (isObj(n.position) && isNum(n.position.x) && isNum(n.position.y)) {
      node.position = { x: Math.round(n.position.x * 10) / 10, y: Math.round(n.position.y * 10) / 10 };
    } else err('position', `"${id}": position must be { x, y } numbers`, { nodeId: id, field: 'position' });

    const cfg = isObj(n.config) ? n.config : {};
    if (n.config !== undefined && !isObj(n.config)) err('config', `"${id}": config must be an object`, { nodeId: id, field: 'config' });
    node.config = checkConfig(node, cfg, err, warn);

    if (n.type !== 'note') {
      const r = isObj(n.retry) ? n.retry : {};
      if (n.retry !== undefined && !isObj(n.retry)) err('retry', `"${id}": retry must be { max, backoffMs }`, { nodeId: id, field: 'retry' });
      const max = r.max === undefined ? 0 : r.max;
      const backoff = r.backoffMs === undefined ? 0 : r.backoffMs;
      if (!Number.isInteger(max) || max < 0 || max > 5) err('retry', `"${id}": retry.max must be an integer from 0 to 5`, { nodeId: id, field: 'retry' });
      if (!Number.isInteger(backoff) || backoff < 0 || backoff > 600_000) err('retry', `"${id}": retry.backoffMs must be 0 to 600000`, { nodeId: id, field: 'retry' });
      node.retry = { max: Number.isInteger(max) ? Math.min(5, Math.max(0, max)) : 0, backoffMs: Number.isInteger(backoff) ? Math.min(600_000, Math.max(0, backoff)) : 0 };
      if (n.timeoutMs !== undefined && n.timeoutMs !== null) {
        if (!Number.isInteger(n.timeoutMs) || n.timeoutMs < 1000 || n.timeoutMs > 6 * 3600_000) err('timeout', `"${id}": timeoutMs must be 1000 to 21600000`, { nodeId: id, field: 'timeoutMs' });
        else node.timeoutMs = n.timeoutMs;
      }
      if (n.sessionId !== undefined && n.sessionId !== null && n.sessionId !== '') {
        if (!isStr(n.sessionId) || n.sessionId.length > 200) err('session', `"${id}": sessionId must be a string`, { nodeId: id, field: 'sessionId' });
        else if (n.type !== 'gate') node.sessionId = n.sessionId;
      }
    } else if (n.retry !== undefined || n.timeoutMs !== undefined) {
      warn('note-extra', `"${id}": notes are never executed; retry and timeout are ignored`, { nodeId: id });
    }
    byId.set(id, node);
    nodes.push(node);
  });

  // ------------------------------------------------------------------- edges
  const edges = [];
  const edgeIds = new Set();
  const edgeKeys = new Set();
  if (input.edges !== undefined && !Array.isArray(input.edges)) err('edges', 'edges must be an array', { field: 'edges' });
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  if (rawEdges.length > LIMITS.edges) err('edges', `at most ${LIMITS.edges} edges`, { field: 'edges' });
  rawEdges.slice(0, LIMITS.edges).forEach((e, i) => {
    if (!isObj(e)) { err('edge', `edges[${i}] must be an object`); return; }
    const id = e.id;
    if (!isStr(id) || !ID_RE.test(id)) { err('edge-id', `edges[${i}].id must match ${ID_RE}`, { field: 'id' }); return; }
    if (edgeIds.has(id)) { err('edge-id', `duplicate edge id "${id}"`, { edgeId: id }); return; }
    edgeIds.add(id);
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from) { err('edge-end', `edge "${id}": unknown source "${String(e.from)}"`, { edgeId: id }); return; }
    if (!to) { err('edge-end', `edge "${id}": unknown target "${String(e.to)}"`, { edgeId: id }); return; }
    if (from.id === to.id) { err('edge-self', `edge "${id}" connects "${from.id}" to itself`, { edgeId: id }); return; }
    if (from.type === 'note' || to.type === 'note') { err('edge-note', `edge "${id}": note nodes have no edges`, { edgeId: id }); return; }
    const when = e.when === undefined || e.when === null ? defaultWhen(from.type) : e.when;
    if (!EDGE_KINDS.includes(when)) { err('edge-when', `edge "${id}": when must be one of ${EDGE_KINDS.join(', ')}`, { edgeId: id, field: 'when' }); return; }
    if (!allowedWhen(from.type).includes(when)) {
      err('edge-when', `edge "${id}": a ${from.type} node can only leave on ${allowedWhen(from.type).join(' or ')}, not ${when}`, { edgeId: id, field: 'when' });
      return;
    }
    const key = `${from.id}>${to.id}>${when}`;
    if (edgeKeys.has(key)) { err('edge-dup', `edge "${id}" duplicates another ${when} edge ${from.id} to ${to.id}`, { edgeId: id }); return; }
    edgeKeys.add(key);
    edges.push({ id, from: from.id, to: to.id, when });
  });

  // ------------------------------------------------------- structure checks
  const exec = nodes.filter((n) => n.type !== 'note');
  if (!exec.length) warn('empty', 'add at least one step (agent, shell check, gate or review) before running');
  const incoming = new Map(exec.map((n) => [n.id, 0]));
  const out = new Map(exec.map((n) => [n.id, []]));
  for (const e of edges) { incoming.set(e.to, (incoming.get(e.to) || 0) + 1); out.get(e.from)?.push(e.to); }
  if (exec.length && !exec.some((n) => !incoming.get(n.id))) err('entry', 'no entry node: every step has an incoming edge');
  // cycles (phase 1 has no loops)
  const color = new Map();
  let cyc = null;
  const visit = (id, trail) => {
    color.set(id, 1);
    for (const t of out.get(id) || []) {
      if (cyc) return;
      if (color.get(t) === 1) { cyc = [...trail.slice(trail.indexOf(t)), t]; return; }
      if (!color.get(t)) visit(t, [...trail, t]);
    }
    color.set(id, 2);
  };
  for (const n of exec) if (!color.get(n.id) && !cyc) visit(n.id, [n.id]);
  if (cyc) err('cycle', `the graph has a cycle (${cyc.join(' → ')}); loops are not supported yet`);

  // ancestors, for {{inputs.x.y}} checks
  const parents = new Map(exec.map((n) => [n.id, []]));
  for (const e of edges) parents.get(e.to)?.push(e.from);
  const ancestors = (id) => {
    const seen = new Set();
    const stack = [...(parents.get(id) || [])];
    while (stack.length) { const c = stack.pop(); if (seen.has(c)) continue; seen.add(c); stack.push(...(parents.get(c) || [])); }
    return seen;
  };
  for (const n of exec) {
    const texts = n.type === 'agent' ? [n.config.prompt, n.config.cwd]
      : n.type === 'review' ? [n.config.rubric] : n.type === 'gate' ? [n.config.message]
        : [n.config.script, n.config.cwd, ...(n.config.argv || [])];
    let anc = null;
    for (const t of texts) {
      for (const ref of templateRefs(t)) {
        if (ref.kind === 'bad') { err('ref', `"${n.id}": unknown reference ${ref.raw} (use {{params.key}} or {{inputs.node.key}})`, { nodeId: n.id }); continue; }
        if (ref.kind === 'params') {
          if (!paramKeys.has(ref.key)) err('ref', `"${n.id}": ${ref.raw} refers to a param that is not declared`, { nodeId: n.id });
          continue;
        }
        const src = byId.get(ref.nodeId);
        if (!src || src.type === 'note') { err('ref', `"${n.id}": ${ref.raw} refers to a step that does not exist`, { nodeId: n.id }); continue; }
        anc ||= ancestors(n.id);
        if (!anc.has(src.id)) { err('ref', `"${n.id}": ${ref.raw} refers to "${src.id}", which does not run before it`, { nodeId: n.id }); continue; }
        if (!OUTPUT_KEYS[src.type].includes(ref.key)) {
          err('ref', `"${n.id}": ${ref.raw}: a ${src.type} step does not produce "${ref.key}" (it produces ${OUTPUT_KEYS[src.type].join(', ')})`, { nodeId: n.id });
        }
      }
    }
  }
  // helpful, non-blocking hints
  for (const n of exec) {
    if (n.type === 'review' && !(parents.get(n.id) || []).length) warn('review-orphan', `"${n.id}": a review with no upstream step has nothing to review`, { nodeId: n.id });
  }

  const graph = { schema: SCHEMA, name, nodes, edges };
  if (params.length) graph.params = params;
  return done(graph);
}

function checkConfig(node, cfg, err, warn) {
  const id = node.id;
  const known = {
    agent: ['agent', 'prompt', 'cwd', 'isolation'],
    shell: ['argv', 'script', 'cwd', 'passIf', 'pattern', 'timeoutMs'],
    gate: ['message', 'show'],
    review: ['rubric', 'inputs'],
    note: ['text'],
  }[node.type];
  for (const k of Object.keys(cfg)) if (!known.includes(k)) warn('config-key', `"${id}": unknown config key "${k}" was dropped`, { nodeId: id, field: k });
  const text = (key, { required = false, max = LIMITS.text } = {}) => {
    const v = cfg[key];
    if (v === undefined || v === null || v === '') {
      if (required) err('config', `"${id}": ${key} is required`, { nodeId: id, field: key });
      return undefined;
    }
    if (!isStr(v)) { err('config', `"${id}": ${key} must be a string`, { nodeId: id, field: key }); return undefined; }
    if (required && !v.trim()) { err('config', `"${id}": ${key} is required`, { nodeId: id, field: key }); return undefined; }
    if (v.length > max) err('config', `"${id}": ${key} is longer than ${max} characters`, { nodeId: id, field: key });
    return v.slice(0, max);
  };
  const out = {};
  switch (node.type) {
    case 'agent': {
      const a = cfg.agent === undefined ? 'builder' : cfg.agent;
      if (!AGENT_KINDS.includes(a)) err('config', `"${id}": agent must be builder or scout`, { nodeId: id, field: 'agent' });
      out.agent = AGENT_KINDS.includes(a) ? a : 'builder';
      out.prompt = text('prompt', { required: true }) ?? '';
      const cwd = text('cwd', { max: 1000 }); if (cwd !== undefined) out.cwd = cwd;
      if (cfg.isolation !== undefined && cfg.isolation !== null) {
        if (cfg.isolation === 'worktree' || cfg.isolation === 'none') { if (cfg.isolation === 'worktree') out.isolation = 'worktree'; }
        else err('config', `"${id}": isolation must be worktree or none`, { nodeId: id, field: 'isolation' });
      }
      break;
    }
    case 'shell': {
      const hasArgv = cfg.argv !== undefined && cfg.argv !== null, hasScript = cfg.script !== undefined && cfg.script !== null && cfg.script !== '';
      if (hasArgv && hasScript) err('config', `"${id}": give argv or script, not both`, { nodeId: id, field: 'argv' });
      else if (!hasArgv && !hasScript) err('config', `"${id}": argv or script is required`, { nodeId: id, field: 'argv' });
      if (hasArgv) {
        if (!Array.isArray(cfg.argv) || !cfg.argv.length || cfg.argv.length > 100 || cfg.argv.some((x) => !isStr(x) || x.length > 4000)) {
          err('config', `"${id}": argv must be a non-empty array of strings`, { nodeId: id, field: 'argv' });
        } else if (!cfg.argv[0].trim()) err('config', `"${id}": argv[0] (the program) must not be empty`, { nodeId: id, field: 'argv' });
        else out.argv = cfg.argv.slice();
      } else if (hasScript) {
        const s = text('script'); if (s !== undefined) out.script = s;
      }
      const cwd = text('cwd', { max: 1000 }); if (cwd !== undefined) out.cwd = cwd;
      const t = cfg.timeoutMs === undefined || cfg.timeoutMs === null ? SHELL_TIMEOUT.def : cfg.timeoutMs;
      if (!Number.isInteger(t) || t < SHELL_TIMEOUT.min || t > SHELL_TIMEOUT.max) {
        err('config', `"${id}": timeoutMs must be ${SHELL_TIMEOUT.min} to ${SHELL_TIMEOUT.max}`, { nodeId: id, field: 'timeoutMs' });
      }
      out.timeoutMs = Number.isInteger(t) ? Math.min(SHELL_TIMEOUT.max, Math.max(SHELL_TIMEOUT.min, t)) : SHELL_TIMEOUT.def;
      const pass = cfg.passIf === undefined || cfg.passIf === null ? 'exit0' : cfg.passIf;
      if (pass !== 'exit0' && pass !== 'regex') err('config', `"${id}": passIf must be exit0 or regex`, { nodeId: id, field: 'passIf' });
      out.passIf = pass === 'regex' ? 'regex' : 'exit0';
      if (out.passIf === 'regex') {
        const pat = text('pattern', { required: true, max: 500 });
        if (pat) { try { new RegExp(pat); out.pattern = pat; } catch (e) { err('config', `"${id}": pattern is not a valid regex (${e.message})`, { nodeId: id, field: 'pattern' }); } }
      }
      break;
    }
    case 'gate': {
      out.message = text('message', { required: true, max: 2000 }) ?? '';
      const show = cfg.show === undefined || cfg.show === null ? 'files' : cfg.show;
      if (!['diff', 'files', 'text', 'none'].includes(show)) err('config', `"${id}": show must be diff, files, text or none`, { nodeId: id, field: 'show' });
      out.show = ['diff', 'files', 'text', 'none'].includes(show) ? show : 'files';
      break;
    }
    case 'review': {
      out.rubric = text('rubric', { required: true, max: 8000 }) ?? '';
      const inputs = cfg.inputs === undefined || cfg.inputs === null ? ['text', 'files'] : cfg.inputs;
      if (!Array.isArray(inputs) || inputs.some((x) => !['text', 'files', 'check'].includes(x))) {
        err('config', `"${id}": inputs must be a list of text, files or check`, { nodeId: id, field: 'inputs' });
        out.inputs = ['text', 'files'];
      } else out.inputs = [...new Set(inputs)];
      break;
    }
    case 'note': {
      out.text = text('text') ?? '';
      break;
    }
  }
  return out;
}

/** Entry nodes and a stable topological order (ties by array order) of the executable nodes. */
export function topoOrder(graph) {
  const exec = graph.nodes.filter((n) => n.type !== 'note');
  const indeg = new Map(exec.map((n) => [n.id, 0]));
  for (const e of graph.edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  const order = [];
  const queue = exec.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const e of graph.edges) {
      if (e.from !== id) continue;
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  return order;
}

/**
 * Built-in templates (CONTRACT v0.10). Each is `() => ({ name, title, description, icon, graph })`; the graph is an ordinary
 * `helm.workflow/1` graph that is validated like any other (a test checks all of them). Phase 1 has no loops, so a "loop back"
 * is unrolled with the fail edge going to a fresh step.
 */
const st = (id, label, x, y, argv, over = {}) => ({
  id, type: 'shell', label, position: { x, y }, config: { argv, timeoutMs: 300000, passIf: 'exit0' }, retry: { max: 0, backoffMs: 0 }, ...over,
});
const ag = (id, label, x, y, agent, prompt, over = {}) => ({
  id, type: 'agent', label, position: { x, y }, config: { agent, prompt }, retry: { max: 0, backoffMs: 0 }, ...over,
});
const gt = (id, label, x, y, message, show = 'files') => ({ id, type: 'gate', label, position: { x, y }, config: { message, show } });
const ed = (n, from, to, when) => ({ id: `e${n}`, from, to, when });
const BRIEF = { key: 'brief', label: 'What to build', type: 'text', required: true };

const part = (id, label, x, prompt) => ag(id, label, x, 160, 'builder', prompt, { config: { agent: 'builder', prompt, isolation: 'worktree' } });

export const TEMPLATES = {
  'build-test-review': () => ({
    title: 'Build, test gate, review, merge',
    description: 'Build it, run the tests, pause for your OK, get an Opus review, then merge.',
    icon: '▣',
    name: 'Build → Test → Gate → Review → Merge',
    graph: {
      schema: SCHEMA,
      name: 'Build → Test → Gate → Review → Merge',
      params: [{ key: 'brief', label: 'What to build', type: 'text', required: true }],
      nodes: [
        { id: 'build', type: 'agent', label: 'Build feature', position: { x: 80, y: 160 },
          config: { agent: 'builder', prompt: '{{params.brief}}' }, retry: { max: 1, backoffMs: 5000 } },
        { id: 'test', type: 'shell', label: 'Run tests', position: { x: 400, y: 160 },
          config: { argv: ['npm', 'test'], timeoutMs: 300000, passIf: 'exit0' }, retry: { max: 0, backoffMs: 0 } },
        { id: 'fix', type: 'agent', label: 'Fix failures', position: { x: 400, y: 340 },
          config: { agent: 'builder', prompt: 'The tests failed after this change. Fix them.\n\nTest output:\n{{inputs.test.text}}\n\nOriginal brief: {{params.brief}}' },
          retry: { max: 0, backoffMs: 0 } },
        { id: 'gate', type: 'gate', label: 'Safety check', position: { x: 720, y: 160 },
          config: { message: 'Tests are done. Look over the changes before the review.', show: 'files' } },
        { id: 'review', type: 'review', label: 'Opus review', position: { x: 1040, y: 160 },
          config: { rubric: 'Correctness, security, and scope creep. Is the change what the brief asked for and nothing more?', inputs: ['text', 'files', 'check'] },
          retry: { max: 0, backoffMs: 0 } },
        { id: 'merge', type: 'agent', label: 'Merge', position: { x: 1360, y: 160 },
          config: { agent: 'builder', prompt: 'Merge the finished work into the main branch. Review notes: {{inputs.review.findings}}' },
          retry: { max: 0, backoffMs: 0 } },
        { id: 'note1', type: 'note', label: 'About this flow', position: { x: 80, y: 340 },
          config: { text: 'A failing test goes to **Fix failures** instead of the gate. Edit any step in the inspector, then Save.' } },
      ],
      edges: [
        { id: 'e1', from: 'build', to: 'test', when: 'ok' },
        { id: 'e2', from: 'test', to: 'gate', when: 'ok' },
        { id: 'e3', from: 'test', to: 'fix', when: 'fail' },
        { id: 'e4', from: 'fix', to: 'gate', when: 'ok' },
        { id: 'e5', from: 'gate', to: 'review', when: 'approved' },
        { id: 'e6', from: 'review', to: 'merge', when: 'ok' },
      ],
    },
  }),
  'fix-bug': () => ({
    title: 'Fix a bug',
    description: 'A scout reproduces it, a builder fixes it, the tests check. A failing test loops back to the builder, at most 2 more times.',
    icon: '✱',
    name: 'Fix a bug',
    graph: {
      schema: SCHEMA, name: 'Fix a bug',
      params: [{ key: 'bug', label: 'What is broken', type: 'text', required: true }],
      nodes: [
        ag('repro', 'Reproduce the bug', 80, 160, 'scout', 'Reproduce this bug and report the exact steps, the failing behaviour and the files most likely involved. Do not change any code.\n\nBug: {{params.bug}}'),
        ag('fix', 'Fix it', 400, 160, 'builder', 'Fix this bug and add a test that would have caught it.\n\nBug: {{params.bug}}\n\nReproduction report:\n{{inputs.repro.text}}', { retry: { max: 1, backoffMs: 5000 } }),
        st('test', 'Run tests', 720, 160, ['npm', 'test']),
        ag('fix2', 'Fix again (try 2)', 720, 340, 'builder', 'The tests still fail after your fix. Fix them.\n\nBug: {{params.bug}}\n\nTest output:\n{{inputs.test.text}}'),
        st('test2', 'Run tests again', 1040, 340, ['npm', 'test']),
        ag('fix3', 'Fix again (last try)', 1040, 520, 'builder', 'The tests still fail on the second try. This is the last attempt. Fix them.\n\nBug: {{params.bug}}\n\nTest output:\n{{inputs.test2.text}}'),
        st('test3', 'Final test run', 1360, 520, ['npm', 'test']),
        { id: 'note1', type: 'note', label: 'About this flow', position: { x: 80, y: 340 },
          config: { text: 'Loops are unrolled: a failing test sends the work back to a builder, at most 2 times. If the last run still fails, the run stops red.' } },
      ],
      edges: [
        ed(1, 'repro', 'fix', 'ok'), ed(2, 'fix', 'test', 'ok'),
        ed(3, 'test', 'fix2', 'fail'), ed(4, 'fix2', 'test2', 'ok'),
        ed(5, 'test2', 'fix3', 'fail'), ed(6, 'fix3', 'test3', 'ok'),
      ],
    },
  }),
  'research-build': () => ({
    title: 'Research, then build',
    description: 'A scout reports on how to do it, you approve the plan, then a builder does the work.',
    icon: '◎',
    name: 'Research, then build',
    graph: {
      schema: SCHEMA, name: 'Research, then build',
      params: [BRIEF],
      nodes: [
        ag('research', 'Research and plan', 80, 160, 'scout', 'Investigate the codebase for this task and write a short plan: the files to touch, the approach, and any risks. Do not change any code.\n\nTask: {{params.brief}}'),
        gt('approve', 'Approve the plan', 400, 160, 'Read the scout\'s plan. Approve to let the builder start.', 'text'),
        ag('build', 'Build it', 720, 160, 'builder', 'Do this task, following the approved plan.\n\nTask: {{params.brief}}\n\nPlan:\n{{inputs.research.text}}'),
      ],
      edges: [ed(1, 'research', 'approve', 'ok'), ed(2, 'approve', 'build', 'approved')],
    },
  }),
  'parallel-refactor': () => ({
    title: 'Parallel refactor',
    description: 'Three builders refactor one area each, then tests and a review. Runs one builder after another for now, because parallel branches and a join step are not available yet.',
    icon: '⫴',
    name: 'Parallel refactor',
    graph: {
      schema: SCHEMA, name: 'Parallel refactor',
      params: [{ key: 'goal', label: 'What to refactor', type: 'text', required: true }],
      nodes: [
        part('part1', 'Refactor part 1', 80, 'Refactor the first third of this change. Keep behaviour identical and stay inside your part.\n\nGoal: {{params.goal}}'),
        part('part2', 'Refactor part 2', 400, 'Refactor the second third of this change. Keep behaviour identical and stay inside your part.\n\nGoal: {{params.goal}}'),
        part('part3', 'Refactor part 3', 720, 'Refactor the last third of this change. Keep behaviour identical and stay inside your part.\n\nGoal: {{params.goal}}'),
        st('test', 'Run tests', 1040, 160, ['npm', 'test']),
        { id: 'review', type: 'review', label: 'Opus review', position: { x: 1360, y: 160 },
          config: { rubric: 'Behaviour unchanged, no scope creep, no half-finished moves between files.', inputs: ['text', 'files', 'check'] },
          retry: { max: 0, backoffMs: 0 } },
        { id: 'note1', type: 'note', label: 'Sequential for now', position: { x: 80, y: 340 },
          config: { text: 'Parallel branches and a join step are not available yet, so the three builders run one after another. Reshape this when they arrive.' } },
      ],
      edges: [ed(1, 'part1', 'part2', 'ok'), ed(2, 'part2', 'part3', 'ok'), ed(3, 'part3', 'test', 'ok'), ed(4, 'test', 'review', 'ok')],
    },
  }),
  'safe-migration': () => ({
    title: 'Safe migration',
    description: 'A builder writes the migration, you check it, a dry run proves it, you confirm again, then it is applied.',
    icon: '⛨',
    name: 'Safe migration',
    graph: {
      schema: SCHEMA, name: 'Safe migration',
      params: [{ key: 'change', label: 'What should change in the data', type: 'text', required: true }],
      nodes: [
        ag('write', 'Write the migration', 80, 160, 'builder', 'Write a migration for this change. Do not run it.\n\nChange: {{params.change}}'),
        gt('review1', 'Check the migration', 400, 160, 'Read the migration before anything runs against data.', 'diff'),
        st('dryrun', 'Dry run', 720, 160, ['npm', 'run', 'migrate:dry-run']),
        gt('review2', 'Confirm apply', 1040, 160, 'The dry run passed. Approve to apply the migration for real.', 'text'),
        ag('apply', 'Apply it', 1360, 160, 'builder', 'Apply the migration that was written and checked, then confirm it ran cleanly.\n\nDry run output:\n{{inputs.dryrun.text}}'),
      ],
      edges: [ed(1, 'write', 'review1', 'ok'), ed(2, 'review1', 'dryrun', 'approved'), ed(3, 'dryrun', 'review2', 'ok'), ed(4, 'review2', 'apply', 'approved')],
    },
  }),
};

/** Public list for GET /v1/workflows/templates: [{ id, title, description, icon, name, graph }]. */
export function listTemplates() {
  return Object.entries(TEMPLATES).map(([id, fn]) => {
    const t = fn();
    return { id, title: t.title, description: t.description, icon: t.icon, name: t.name, graph: t.graph };
  });
}

// ============================================================ drafting by prompt (CONTRACT v0.10)

/** Left-to-right layered layout. Fills `position` for nodes that lack a valid one (all nodes, if any is missing). */
export function layoutGraph(input) {
  if (!isObj(input) || !Array.isArray(input.nodes)) return input;
  const nodes = input.nodes.filter(isObj);
  const hasPos = (n) => isObj(n.position) && isNum(n.position.x) && isNum(n.position.y);
  if (nodes.every(hasPos)) return input;
  const exec = nodes.filter((n) => n.type !== 'note' && typeof n.id === 'string');
  const ids = new Set(exec.map((n) => n.id));
  const edges = (Array.isArray(input.edges) ? input.edges : []).filter((e) => isObj(e) && ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  // longest-path depth, capped so a stray cycle can never loop forever (validation reports cycles separately)
  const depth = new Map(exec.map((n) => [n.id, 0]));
  for (let pass = 0; pass < exec.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const d = depth.get(e.from) + 1;
      if (d > depth.get(e.to) && d <= exec.length) { depth.set(e.to, d); changed = true; }
    }
    if (!changed) break;
  }
  const rows = new Map();
  const pos = new Map();
  for (const n of exec) {
    const d = depth.get(n.id), r = rows.get(d) || 0;
    rows.set(d, r + 1);
    pos.set(n.id, { x: 80 + d * 320, y: 160 + r * 180 });
  }
  const bottom = 160 + Math.max(0, ...rows.values()) * 180;
  let noteRow = 0;
  const out = nodes.map((n) => {
    if (typeof n.id !== 'string') return n;
    if (n.type === 'note') return { ...n, position: { x: 80 + (noteRow++) * 320, y: bottom } };
    return { ...n, position: pos.get(n.id) };
  });
  return { ...input, nodes: out };
}

/**
 * Pull one JSON object out of a model reply (plain, or inside ``` fences, or surrounded by prose).
 * Returns { value } or { error }.
 */
export function extractJson(text) {
  if (!isStr(text) || !text.trim()) return { error: 'the reply was empty' };
  const tries = [];
  for (const m of text.matchAll(/```[A-Za-z]*\s*\n?([\s\S]*?)```/g)) tries.push(m[1].trim());
  tries.push(text.trim());
  // balanced-brace scan of the whole reply, for prose around a bare object
  for (let i = text.indexOf('{'); i !== -1 && tries.length < 40; i = text.indexOf('{', i + 1)) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = j; break; }
    }
    if (end !== -1) { tries.push(text.slice(i, end + 1)); i = end; }
  }
  let firstObj = null;
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (isObj(v) && (Array.isArray(v.nodes) || v.schema)) return { value: v };
      if (isObj(v) && !firstObj) firstObj = v;
    } catch { /* try the next candidate */ }
  }
  if (firstObj) return { value: firstObj };
  return { error: 'the reply did not contain a JSON object' };
}

/**
 * Turn a model's JSON into a stored-quality graph: fill the `schema` tag, edge ids and positions it left out, then validate.
 * Returns { ok, issues, graph }.
 */
export function prepareDraft(raw) {
  if (!isObj(raw)) return validateGraph(raw);
  let g = { ...raw };
  if (g.schema === undefined) g.schema = SCHEMA;
  if (Array.isArray(g.edges)) {
    const used = new Set(g.edges.filter(isObj).map((e) => e.id).filter(isStr));
    let n = 0;
    g.edges = g.edges.map((e) => {
      if (!isObj(e) || e.id !== undefined) return e;
      let id; do { id = `e${++n}`; } while (used.has(id));
      used.add(id);
      return { ...e, id };
    });
  }
  g = layoutGraph(g);
  return validateGraph(g);
}

/** The node types as the model sees them. */
export const NODE_CATALOGUE = [
  { type: 'agent', summary: 'A Claude Code agent does a piece of work.', config: { agent: '"builder" (edits code, default) or "scout" (read only research)', prompt: 'string, required; may use {{params.key}} and {{inputs.nodeId.key}}', isolation: '"worktree" to work in a separate git worktree (optional)', cwd: 'string (optional)' }, outputs: OUTPUT_KEYS.agent },
  { type: 'shell', summary: 'Runs a command; fails on a non-zero exit.', config: { argv: 'array of strings, e.g. ["npm","test"] (or "script": a shell string; give one, not both)', timeoutMs: '1000 to 600000, default 30000', passIf: '"exit0" (default) or "regex" with "pattern"', cwd: 'string (optional)' }, outputs: OUTPUT_KEYS.shell },
  { type: 'gate', summary: 'Stops and waits for the person to approve or reject.', config: { message: 'string, required', show: '"diff" | "files" | "text" | "none"' }, outputs: OUTPUT_KEYS.gate },
  { type: 'review', summary: 'A strong model reviews the work against a rubric and answers pass or changes.', config: { rubric: 'string, required', inputs: 'subset of ["text","files","check"]' }, outputs: OUTPUT_KEYS.review },
  { type: 'note', summary: 'A sticky note on the canvas. Never runs, has no edges.', config: { text: 'string' }, outputs: [] },
];

/** A compact text description of `helm.workflow/1` for the drafting prompt. */
export const DRAFT_SCHEMA_TEXT = [
  `A workflow is ONE JSON object with schema "${SCHEMA}". Reply with that JSON and nothing else (a single \`\`\`json fence is fine).`,
  '',
  '{ "schema": "helm.workflow/1", "name": "short title", "params": [...], "nodes": [...], "edges": [...] }',
  '',
  'nodes[]: { "id": unique [A-Za-z0-9_-]{1,40}, "type": "agent"|"shell"|"gate"|"review"|"note", "label": "short name",',
  '           "position": { "x": number, "y": number }, "config": {...per type...},',
  '           "retry": { "max": 0-5, "backoffMs": 0-600000 } (optional, not for notes), "timeoutMs": 1000-21600000 (optional) }',
  'Config fields: agent { agent: "builder"|"scout", prompt, isolation?: "worktree", cwd? }; shell { argv: [..] or script, timeoutMs?, passIf?: "exit0"|"regex", pattern?, cwd? };',
  '  gate { message, show?: "diff"|"files"|"text"|"none" }; review { rubric, inputs?: ["text","files","check"] }; note { text }.',
  'Positions: x grows to the right (about 320 per step), y about 160 per row. You may omit "position" and Helm will lay the graph out left to right.',
  '',
  'edges[]: { "id": unique, "from": nodeId, "to": nodeId, "when": kind }. Work nodes (agent, shell, review) leave on "ok" or "fail"; gates leave on "approved" or "rejected".',
  '  Omit "when" for the default (ok, or approved for a gate). Notes have no edges. No self edges. At least one entry node (no incoming edge).',
  '  The graph must NOT contain cycles: there are no loops yet. To retry after a failure, add a new fix step on the "fail" edge (unrolled), or use retry on the node.',
  '',
  'params[]: { "key": [A-Za-z][A-Za-z0-9_]*, "label": "shown to the person", "type": "text"|"line", "default"?: string, "required"?: boolean }.',
  'Templates inside prompt, message, rubric, argv: {{params.key}} (must be declared) and {{inputs.nodeId.key}}, where nodeId runs BEFORE this node (is an ancestor).',
  `Output keys: agent ${OUTPUT_KEYS.agent.join(', ')}; shell ${OUTPUT_KEYS.shell.join(', ')}; review ${OUTPUT_KEYS.review.join(', ')}; gate ${OUTPUT_KEYS.gate.join(', ')}.`,
  'Defaults to prefer: a build step is an agent "builder"; research is an agent "scout"; tests are a shell step ["npm","test"]; ask the person before anything risky (merge, migration, deploy) with a gate.',
  'If a current workflow is given, return the COMPLETE modified graph (keep ids of unchanged nodes), not a patch.',
].join('\n');

/** The two example graphs sent with every draft job. */
export function draftExamples() {
  return ['build-test-review', 'research-build'].map((id) => TEMPLATES[id]().graph);
}
