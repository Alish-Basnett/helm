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

/** The hard-coded phase 1 template: Build -> Test -> Gate -> Review -> Merge, with a Fix step on the fail edge. */
export const TEMPLATES = {
  'build-test-review': () => ({
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
};
