// Workflows: row mappers and the deterministic reducer for `wf.*` events (CONTRACT v0.9).
//
// The split that keeps `helmd --rebuild` exact:
//   * this file only APPLIES events (state transitions that the event data fully determines);
//   * every DECISION (which node runs next, retry vs fail, which session) is made first by hub/wfengine.mjs,
//     which reads the projection, then records the outcome as an event (session `_hub`). Replay never decides.
// No wall clock and no randomness here: time is `ev.at`, ids come from the counters table.

const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cut = (s, n) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const money = (n) => Math.round(n * 1e6) / 1e6;

export const RUN_STATUSES = ['running', 'paused', 'waiting', 'done', 'failed', 'aborted'];
export const RUN_TERMINAL = ['done', 'failed', 'aborted'];
export const NODE_STATES = ['pending', 'ready', 'queued', 'running', 'ok', 'failed', 'skipped', 'waiting_gate', 'abandoned'];
export const NODE_TERMINAL = ['ok', 'failed', 'skipped', 'abandoned'];
export const WF_RESULT_TYPE = 'wf.step.result';
export const RESULT_TEXT_CAP = 8000;
export const MAX_FILES = 200;

// ---------------------------------------------------------------- row mappers
export const toWorkflow = (r) => ({
  id: r.id, projectId: r.project_id, name: r.name, currentVersion: r.current_version,
  createdAt: r.created_at, updatedAt: r.updated_at, archived: !!r.archived,
});
export const toVersion = (r) => ({
  workflowId: r.workflow_id, version: r.version, graph: parse(r.graph, null), author: r.author,
  summary: r.summary, parentVersion: r.parent_version ?? null, createdAt: r.created_at,
});
export const toRunNode = (r) => ({
  runId: r.run_id, nodeId: r.node_id, state: r.state, attempt: r.attempt, taskId: r.task_id ?? null,
  agentId: r.agent_id ?? null, startedAt: r.started_at ?? null, endedAt: r.ended_at ?? null,
  output: parse(r.output, null), error: r.error ?? null, costUsd: money(r.cost_usd ?? 0), questionId: r.question_id ?? null,
});
export const toStep = (r) => ({
  id: r.id, runId: r.run_id, nodeId: r.node_id, attempt: r.attempt, kind: r.kind, sessionId: r.session_id, state: r.state,
  input: parse(r.input, {}), result: parse(r.result, null), error: r.error ?? null, taskId: r.task_id ?? null,
  createdAt: r.created_at, claimedAt: r.claimed_at ?? null, doneAt: r.done_at ?? null, notBefore: r.not_before ?? null,
});
/** Run row with its nodes inlined (the SSE `run` entity and the /v1/state shape). */
export const toRun = (r, nodeRows) => ({
  id: r.id, workflowId: r.workflow_id, version: r.version, projectId: r.project_id, status: r.status,
  params: parse(r.params, {}), driverSessionId: r.driver_session_id ?? null, budgetUsd: r.budget_usd ?? null,
  costUsd: money(r.cost_usd ?? 0), startedAt: r.started_at, endedAt: r.ended_at ?? null, error: r.error ?? null,
  nodes: nodeRows.map(toRunNode),
});

// ------------------------------------------------------------------- queries
export const getWorkflow = (db, id) => db.get('SELECT * FROM workflows WHERE id = ?', id);
export const getVersion = (db, id, version) => db.get('SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?', id, version);
export const getRun = (db, id) => db.get('SELECT * FROM runs WHERE id = ?', id);
export const runNodeRows = (db, runId) => db.all('SELECT * FROM run_nodes WHERE run_id = ? ORDER BY rowid', runId);
export const getRunNode = (db, runId, nodeId) => db.get('SELECT * FROM run_nodes WHERE run_id = ? AND node_id = ?', runId, nodeId);
export const getStep = (db, id) => db.get('SELECT * FROM steps WHERE id = ?', id);
export const runRow = (db, id) => { const r = getRun(db, id); return r ? toRun(r, runNodeRows(db, id)) : null; };

function pushWorkflow(p, id) { const r = getWorkflow(p.db, id); if (r) p.emit('workflow', 'upsert', toWorkflow(r)); }
function pushRun(p, id) { const r = runRow(p.db, id); if (r) p.emit('run', 'upsert', r); }

function indexWorkflow(p, id, at) {
  const w = getWorkflow(p.db, id);
  const v = getVersion(p.db, id, w.current_version);
  const g = parse(v?.graph, { nodes: [] });
  const body = (g.nodes || []).map((n) => `${n.label}${n.config?.prompt ? ': ' + cut(n.config.prompt, 200) : n.config?.rubric ? ': ' + cut(n.config.rubric, 200) : ''}`).join('\n');
  p.setDoc('workflow', id, w.name, body, { at });
}

const usageKindFor = (stepKind) => (stepKind === 'review' ? 'wf_review' : 'wf_step');

/** Book one usage row against a run node and refresh the run total. `run_nodes.cost_usd` is the source of the sum. */
export function bookRunUsage(p, { at, sessionId, kind, model, inputTokens, outputTokens, cacheReadTokens, costUsd, taskId, noteId, runId, nodeId }) {
  const tok = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
  p.db.run(
    `INSERT INTO usage(at, session_id, kind, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, task_id, note_id, run_id, node_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    at, sessionId, kind, cut(str(model), 100), tok(inputTokens), tok(outputTokens), tok(cacheReadTokens), costUsd,
    taskId == null ? null : str(taskId), noteId == null ? null : str(noteId), runId ?? null, nodeId ?? null);
  if (runId && nodeId && getRunNode(p.db, runId, nodeId)) {
    p.db.run('UPDATE run_nodes SET cost_usd = cost_usd + ? WHERE run_id = ? AND node_id = ?', costUsd, runId, nodeId);
    p.db.run('UPDATE runs SET cost_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM run_nodes WHERE run_id = ?) WHERE id = ?', runId, runId);
    pushRun(p, runId);
  }
}

function setTaskFor(p, taskId, status, at, reason) {
  const t = taskId ? p.getTask(taskId) : null;
  if (!t || t.status === 'archived') return;
  if (status === 'done' && t.status === 'done') return;
  p.setTaskStatus(t, status, at, reason);
  p.upd('tasks', t.id, { updated_at: at });
  p.pushTask(t.id);
}

function answerApproval(p, questionId, at) {
  if (!questionId) return;
  const q = p.getQuestion(questionId);
  if (q && q.state === 'open') {
    p.db.run(`UPDATE questions SET state = 'answered', answered_at = ? WHERE id = ?`, at, q.id);
    p.pushQuestion(q.id);
  }
}

const cleanFiles = (v) => (Array.isArray(v) ? v.filter((f) => typeof f === 'string' && f).slice(0, MAX_FILES).map((f) => cut(f, 1000)) : undefined);
function cleanCheck(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return undefined;
  const out = {};
  if (isNum(c.exitCode)) out.exitCode = Math.trunc(c.exitCode);
  if (typeof c.stdout === 'string') out.stdout = tail(c.stdout, 4000);
  if (typeof c.stderr === 'string') out.stderr = tail(c.stderr, 4000);
  if (typeof c.passed === 'boolean') out.passed = c.passed;
  if (typeof c.timedOut === 'boolean') out.timedOut = c.timedOut;
  return out;
}
const tail = (s, n) => (s.length > n ? '…' + s.slice(s.length - n + 1) : s);

// ============================================================== the reducer
export function applyWf(p, ev) {
  switch (ev.type) {
    case 'wf.created': return created(p, ev);
    case 'wf.saved': return saved(p, ev);
    case 'wf.updated': return updated(p, ev);
    case 'wf.run.started': return runStarted(p, ev);
    case 'wf.run.status': return runStatus(p, ev);
    case 'wf.run.finished': return runFinished(p, ev);
    case 'wf.node.state': return nodeState(p, ev);
    case 'wf.step.created': return stepCreated(p, ev);
    case 'wf.step.claimed': return stepClaimed(p, ev);
    case 'wf.step.failed': return stepFailed(p, ev);
    case 'wf.step.result': return stepResult(p, ev);
    case 'wf.gate.opened': return gateOpened(p, ev);
    case 'wf.gate.decided': return gateDecided(p, ev);
    default:
      p.log?.warn(`unknown workflow event ignored: ${ev.type}`);
      return null;
  }
}

function created(p, ev) {
  const d = ev.data;
  const id = p.nextId('W');
  p.db.run(
    'INSERT INTO workflows(id, project_id, name, current_version, created_at, updated_at, archived) VALUES (?, ?, ?, 1, ?, ?, 0)',
    id, d.projectId, cut(str(d.name), 200), ev.at, ev.at);
  p.db.run(
    `INSERT INTO workflow_versions(workflow_id, version, graph, author, summary, parent_version, created_at) VALUES (?, 1, ?, ?, ?, NULL, ?)`,
    id, JSON.stringify(d.graph), d.author === 'model' ? 'model' : 'user', cut(str(d.summary), 300), ev.at);
  indexWorkflow(p, id, ev.at);
  pushWorkflow(p, id);
  return toWorkflow(getWorkflow(p.db, id));
}

function saved(p, ev) {
  const d = ev.data;
  const w = getWorkflow(p.db, d.workflowId);
  if (!w) throw new Error('workflow not found');
  const version = w.current_version + 1;
  p.db.run(
    `INSERT INTO workflow_versions(workflow_id, version, graph, author, summary, parent_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    w.id, version, JSON.stringify(d.graph), d.author === 'model' ? 'model' : 'user', cut(str(d.summary), 300),
    isNum(d.parentVersion) ? d.parentVersion : w.current_version, ev.at);
  const f = { current_version: version, updated_at: ev.at };
  if (typeof d.name === 'string' && d.name.trim()) f.name = cut(d.name.trim(), 200);
  p.upd('workflows', w.id, f);
  indexWorkflow(p, w.id, ev.at);
  pushWorkflow(p, w.id);
  return toVersion(getVersion(p.db, w.id, version));
}

function updated(p, ev) {
  const d = ev.data;
  const w = getWorkflow(p.db, d.workflowId);
  if (!w) throw new Error('workflow not found');
  const f = { updated_at: ev.at };
  if (d.name !== undefined) f.name = cut(str(d.name), 200);
  if (d.archived !== undefined) f.archived = d.archived ? 1 : 0;
  p.upd('workflows', w.id, f);
  indexWorkflow(p, w.id, ev.at);
  pushWorkflow(p, w.id);
  return toWorkflow(getWorkflow(p.db, w.id));
}

function runStarted(p, ev) {
  const d = ev.data;
  const v = getVersion(p.db, d.workflowId, d.version);
  if (!v) throw new Error('workflow version not found');
  const graph = parse(v.graph, { nodes: [] });
  const id = p.nextId('R');
  p.db.run(
    `INSERT INTO runs(id, workflow_id, version, project_id, status, params, driver_session_id, budget_usd, cost_usd, started_at, ended_at, error)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, 0, ?, NULL, NULL)`,
    id, d.workflowId, d.version, d.projectId, JSON.stringify(d.params || {}), d.driverSessionId ?? null,
    isNum(d.budgetUsd) ? d.budgetUsd : null, ev.at);
  for (const n of graph.nodes || []) {
    if (n.type === 'note') continue;
    p.db.run(`INSERT INTO run_nodes(run_id, node_id, state, attempt, cost_usd) VALUES (?, ?, 'pending', 0, 0)`, id, n.id);
  }
  pushRun(p, id);
  return runRow(p.db, id);
}

function runStatus(p, ev) {
  const d = ev.data;
  const r = getRun(p.db, d.runId);
  if (!r) throw new Error('run not found');
  if (RUN_TERMINAL.includes(r.status) && !d.reopen) return null;
  const f = { status: d.status };
  if (Object.prototype.hasOwnProperty.call(d, 'error')) f.error = d.error == null ? null : cut(str(d.error), 500);
  if (Object.prototype.hasOwnProperty.call(d, 'budgetUsd')) f.budget_usd = isNum(d.budgetUsd) ? d.budgetUsd : null;
  if (d.reopen) f.ended_at = null;
  p.upd('runs', r.id, f);
  pushRun(p, r.id);
  return runRow(p.db, r.id);
}

function runFinished(p, ev) {
  const d = ev.data;
  const r = getRun(p.db, d.runId);
  if (!r) throw new Error('run not found');
  if (RUN_TERMINAL.includes(r.status)) return null;
  p.upd('runs', r.id, { status: d.status, ended_at: ev.at, error: d.error == null ? null : cut(str(d.error), 500) });
  pushRun(p, r.id);
  return runRow(p.db, r.id);
}

/** wf.node.state: the engine's decision about a node. Terminal states stamp endedAt and settle the node's card. */
function nodeState(p, ev) {
  const d = ev.data;
  const rn = getRunNode(p.db, d.runId, d.nodeId);
  if (!rn) throw new Error('run node not found');
  const f = { state: d.state };
  if (isNum(d.attempt)) f.attempt = d.attempt;
  if (Object.prototype.hasOwnProperty.call(d, 'output')) f.output = d.output == null ? null : JSON.stringify(d.output);
  if (Object.prototype.hasOwnProperty.call(d, 'error')) f.error = d.error == null ? null : cut(str(d.error), 500);
  if (d.taskId) f.task_id = d.taskId;
  const terminal = NODE_TERMINAL.includes(d.state);
  f.ended_at = terminal ? ev.at : null;
  if (d.state === 'pending') { f.started_at = null; f.question_id = null; }
  else if (['queued', 'running', 'waiting_gate'].includes(d.state) && rn.started_at == null) f.started_at = ev.at;
  p.db.run(`UPDATE run_nodes SET ${Object.keys(f).map((k) => k + ' = ?').join(', ')} WHERE run_id = ? AND node_id = ?`,
    ...Object.values(f), d.runId, d.nodeId);
  const taskId = f.task_id ?? rn.task_id;
  if (terminal && taskId) {
    const userSkip = d.state === 'skipped' && d.output && d.output.skipped === true;
    if (d.state === 'ok' || userSkip) setTaskFor(p, taskId, 'done', ev.at);
    else if (d.state === 'failed') setTaskFor(p, taskId, 'blocked', ev.at, cut(str(d.error) || 'step failed', 500));
    else if (d.state === 'abandoned') setTaskFor(p, taskId, 'blocked', ev.at, 'run stopped');
  }
  if (terminal) answerApproval(p, rn.question_id, ev.at);
  pushRun(p, d.runId);
  return toRunNode(getRunNode(p.db, d.runId, d.nodeId));
}

function stepCreated(p, ev) {
  const d = ev.data;
  const rn = getRunNode(p.db, d.runId, d.nodeId);
  if (!rn) throw new Error('run node not found');
  p.db.run(
    `INSERT INTO steps(id, run_id, node_id, attempt, kind, session_id, state, input, result, error, task_id, created_at, claimed_at, done_at, not_before)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, ?, NULL, NULL, ?)`,
    d.stepId, d.runId, d.nodeId, d.attempt, d.kind, d.sessionId, JSON.stringify(d.input || {}), d.taskId ?? null, ev.at,
    isNum(d.notBefore) && d.notBefore > ev.at ? d.notBefore : null);
  p.db.run(
    `UPDATE run_nodes SET state = 'queued', attempt = ?, task_id = COALESCE(?, task_id), error = NULL, output = NULL, ended_at = NULL,
       started_at = COALESCE(started_at, ?) WHERE run_id = ? AND node_id = ?`,
    d.attempt, d.taskId ?? null, ev.at, d.runId, d.nodeId);
  if (d.driverSessionId) p.db.run('UPDATE runs SET driver_session_id = ? WHERE id = ?', d.driverSessionId, d.runId);
  if (d.taskId && d.attempt > 1) setTaskFor(p, d.taskId, 'in_progress', ev.at);
  pushRun(p, d.runId);
  return toStep(getStep(p.db, d.stepId));
}

function stepClaimed(p, ev) {
  const out = [];
  const touched = new Set();
  for (const id of ev.data.ids || []) {
    const s = getStep(p.db, id);
    if (!s || s.state !== 'queued') continue;
    p.db.run(`UPDATE steps SET state = 'running', claimed_at = ? WHERE id = ?`, ev.at, id);
    p.db.run(
      `UPDATE run_nodes SET state = 'running', started_at = COALESCE(started_at, ?) WHERE run_id = ? AND node_id = ? AND state = 'queued'`,
      ev.at, s.run_id, s.node_id);
    touched.add(s.run_id);
    out.push(toStep(getStep(p.db, id)));
  }
  for (const r of touched) pushRun(p, r);
  return out;
}

function stepFailed(p, ev) {
  const s = getStep(p.db, str(ev.data.stepId));
  if (!s || (s.state !== 'queued' && s.state !== 'running')) return null;
  p.db.run(`UPDATE steps SET state = 'failed', error = ?, done_at = ? WHERE id = ?`, cut(str(ev.data.error) || 'step failed', 500), ev.at, s.id);
  pushRun(p, s.run_id);
  return toStep(getStep(p.db, s.id));
}

/** wf.step.result (from the mod): idempotent by stepId. A result for a step that already ended is ignored. */
function stepResult(p, ev) {
  const d = ev.data;
  const s = getStep(p.db, str(d.stepId));
  if (!s) { p.log?.warn(`wf.step.result for unknown step ${d.stepId}`); return null; }
  if (s.state === 'done' || s.state === 'failed') return null;
  const ok = d.ok !== false && d.ok !== 0;
  const result = { ok };
  if (typeof d.text === 'string') result.text = tail(d.text, RESULT_TEXT_CAP);
  const files = cleanFiles(d.filesChanged); if (files) result.filesChanged = files;
  const check = cleanCheck(d.check); if (check) result.check = check;
  if (d.verdict === 'pass' || d.verdict === 'changes') result.verdict = d.verdict;
  if (typeof d.findings === 'string') result.findings = cut(d.findings, 4000);
  if (typeof d.agentId === 'string' && d.agentId) result.agentId = cut(d.agentId, 200);
  if (typeof d.taskId === 'string' && d.taskId) result.taskId = cut(d.taskId, 40);
  if (typeof d.error === 'string' && d.error) result.error = cut(d.error, 500);
  p.db.run(`UPDATE steps SET state = ?, result = ?, error = ?, done_at = ? WHERE id = ?`,
    ok ? 'done' : 'failed', JSON.stringify(result), ok ? null : cut(str(d.error) || 'step failed', 500), ev.at, s.id);
  if (result.agentId) p.db.run('UPDATE run_nodes SET agent_id = ? WHERE run_id = ? AND node_id = ?', result.agentId, s.run_id, s.node_id);
  const u = d.usage;
  if (u && typeof u === 'object' && isNum(u.costUsd) && u.costUsd >= 0) {
    bookRunUsage(p, {
      at: ev.at, sessionId: ev.sessionId, kind: usageKindFor(s.kind), model: u.model, inputTokens: u.inputTokens,
      outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, costUsd: u.costUsd, taskId: s.task_id, runId: s.run_id, nodeId: s.node_id,
    });
  }
  pushRun(p, s.run_id);
  return toStep(getStep(p.db, s.id));
}

function gateOpened(p, ev) {
  const d = ev.data;
  const rn = getRunNode(p.db, d.runId, d.nodeId);
  const run = getRun(p.db, d.runId);
  if (!rn || !run) throw new Error('run node not found');
  const message = cut(str(d.message), 2000);
  const qid = p.createQuestion({
    sessionId: run.driver_session_id || '', agentId: null, taskId: d.taskId ?? null, kind: 'approval', text: message,
    toolUseId: null, at: ev.at, runId: d.runId, nodeId: d.nodeId, hint: message,
  });
  const gate = { message, show: str(d.show) || 'files', taskIds: Array.isArray(d.taskIds) ? d.taskIds.slice(0, 20) : [], files: cleanFiles(d.files) || [] };
  p.db.run(
    `UPDATE run_nodes SET state = 'waiting_gate', attempt = attempt + 1, question_id = ?, task_id = COALESCE(?, task_id),
       output = ?, error = NULL, ended_at = NULL, started_at = COALESCE(started_at, ?) WHERE run_id = ? AND node_id = ?`,
    qid, d.taskId ?? null, JSON.stringify({ gate }), ev.at, d.runId, d.nodeId);
  if (d.taskId) setTaskFor(p, d.taskId, 'review', ev.at);
  pushRun(p, d.runId);
  return toRunNode(getRunNode(p.db, d.runId, d.nodeId));
}

function gateDecided(p, ev) {
  const d = ev.data;
  const rn = getRunNode(p.db, d.runId, d.nodeId);
  if (!rn || rn.state !== 'waiting_gate') return null;
  const approved = d.decision === 'approve';
  const prev = parse(rn.output, {}) || {};
  const comment = cut(str(d.comment), 1000);
  const output = { ...prev, approved, ...(comment ? { comment } : {}) };
  p.db.run(
    `UPDATE run_nodes SET state = ?, output = ?, error = ?, ended_at = ? WHERE run_id = ? AND node_id = ?`,
    approved ? 'ok' : 'failed', JSON.stringify(output), approved ? null : cut(comment ? `rejected: ${comment}` : 'rejected at the gate', 500),
    ev.at, d.runId, d.nodeId);
  answerApproval(p, rn.question_id, ev.at);
  setTaskFor(p, rn.task_id, 'done', ev.at);
  pushRun(p, d.runId);
  return toRunNode(getRunNode(p.db, d.runId, d.nodeId));
}

