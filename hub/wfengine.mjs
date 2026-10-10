// Workflow engine: the DECISIONS. Everything it decides is recorded as a `wf.*` / `hub.task.create` event (session `_hub`)
// before it takes effect, and hub/workflows.mjs applies those events. So `helmd --rebuild` replays the same run without
// ever calling this file's planner. The engine reads the projection, picks the next action, records it, and repeats until
// nothing is left to decide ("settles"). It holds no timers: waits live in the data and the sweep re-evaluates.
import { HttpError } from './errors.mjs';
import { validateGraph, TEMPLATES, SCHEMA } from './wfgraph.mjs';
import {
  toWorkflow, toVersion, toRun, toStep, getWorkflow, getVersion, getRun, runNodeRows, getRunNode, getStep, runRow,
  RUN_TERMINAL, NODE_TERMINAL,
} from './workflows.mjs';

const bad = (m, extra) => new HttpError(400, m, extra);
const notFound = (m) => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);
const isStr = (v) => typeof v === 'string';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const cut = (s, n) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const tailStr = (s, n) => (s.length > n ? '…' + s.slice(s.length - n + 1) : s);

const ACTIVE_NODE = ['ready', 'queued', 'running', 'waiting_gate'];
const UNCLAIMED_ERROR = 'not picked up by a live session';
const REF_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Fill {{params.key}} and {{inputs.node.key}}. Unknown references become the empty string. */
export function renderTemplate(text, params, outputs) {
  const fmt = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  return String(text ?? '').replace(REF_RE, (m, path) => {
    const parts = path.split('.');
    if (parts[0] === 'params' && parts.length === 2) return fmt(params[parts[1]]);
    if (parts[0] === 'inputs' && parts.length === 3) return cut(fmt(outputs.get(parts[1])?.[parts[2]]), 8000);
    return m;
  });
}

/** `VERDICT: PASS` / `VERDICT: CHANGES` (the last one wins); null when the text does not say. */
export function parseVerdict(text) {
  let v = null;
  for (const m of String(text ?? '').matchAll(/VERDICT:\s*(PASS|CHANGES)/gi)) v = m[1].toLowerCase();
  return v;
}

export class WfEngine {
  constructor(hub) {
    this.hub = hub;
    this.graphs = new Map(); // `${workflowId}@${version}` -> graph (versions are immutable)
    this.ticking = false;
  }
  get db() { return this.hub.db; }
  get p() { return this.hub.p; }
  cmd(type, data, at) { return this.hub.command(type, data, at); }
  now() { return this.hub.now(); }

  graphOf(workflowId, version) {
    const key = `${workflowId}@${version}`;
    let g = this.graphs.get(key);
    if (!g) {
      const v = getVersion(this.db, workflowId, version);
      if (!v) throw notFound('workflow version not found');
      g = parse(v.graph, { nodes: [], edges: [] });
      this.graphs.set(key, g);
    }
    return g;
  }

  // ============================================================ workflows (store)
  listWorkflows({ projectId } = {}) {
    const rows = projectId
      ? this.db.all('SELECT * FROM workflows WHERE project_id = ? ORDER BY rowid', projectId)
      : this.db.all('SELECT * FROM workflows ORDER BY rowid');
    return rows.map(toWorkflow);
  }
  workflowDetail(id) {
    const w = getWorkflow(this.db, id);
    if (!w) throw notFound('workflow not found');
    const versions = this.db.all('SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC', id).map(toVersion);
    return { workflow: toWorkflow(w), versions };
  }
  validate(graph) {
    const r = validateGraph(graph);
    return { ok: r.ok, issues: r.issues };
  }
  /** Validate or throw 400 { error, issues }. Returns the normalised graph. */
  validOrThrow(graph, name) {
    const g = isObj(graph) && name ? { ...graph, name } : graph;
    const r = validateGraph(g);
    if (!r.ok) {
      const first = r.issues.find((i) => i.level === 'error');
      throw bad(`invalid workflow graph: ${first.message}`, { issues: r.issues });
    }
    return r.graph;
  }
  createWorkflow(body, at = this.now()) {
    if (!isObj(body)) throw bad('body must be an object');
    if (!isStr(body.projectId) || !this.p.getProject(body.projectId)) throw notFound('project not found');
    let graph, name, summary = 'Created';
    if (body.template !== undefined && body.template !== null) {
      const tpl = TEMPLATES[body.template];
      if (!tpl) throw bad(`unknown template: ${String(body.template)}`);
      const t = tpl();
      graph = t.graph; name = isStr(body.name) && body.name.trim() ? body.name.trim() : t.name; summary = 'From template';
    } else if (body.graph !== undefined) {
      graph = body.graph;
      name = isStr(body.name) && body.name.trim() ? body.name.trim() : isObj(graph) && isStr(graph.name) && graph.name.trim() ? graph.name.trim() : 'Untitled workflow';
    } else {
      name = isStr(body.name) && body.name.trim() ? body.name.trim() : 'Untitled workflow';
      graph = { schema: SCHEMA, name, nodes: [], edges: [] };
    }
    name = name.slice(0, 200);
    const norm = this.validOrThrow(graph, name);
    const author = body.author === 'model' ? 'model' : 'user';
    return this.hub.tx(() => ({
      workflow: this.cmd('wf.created', { projectId: body.projectId, name, graph: norm, author, summary }, at),
    }));
  }
  saveWorkflow(id, body, at = this.now()) {
    const w = getWorkflow(this.db, id);
    if (!w) throw notFound('workflow not found');
    if (!isObj(body) || !isObj(body.graph)) throw bad('graph is required');
    if (body.summary !== undefined && body.summary !== null && !isStr(body.summary)) throw bad('summary must be a string');
    const norm = this.validOrThrow(body.graph, w.name);
    const cur = getVersion(this.db, id, w.current_version);
    if (cur && cur.graph === JSON.stringify(norm)) {
      return { workflow: toWorkflow(w), version: toVersion(cur), unchanged: true };
    }
    const summary = cut((body.summary || '').trim() || 'Edited', 300);
    return this.hub.tx(() => {
      const version = this.cmd('wf.saved', { workflowId: id, graph: norm, author: 'user', summary }, at);
      return { workflow: toWorkflow(getWorkflow(this.db, id)), version };
    });
  }
  restoreVersion(id, body, at = this.now()) {
    const w = getWorkflow(this.db, id);
    if (!w) throw notFound('workflow not found');
    const n = Number(body?.version);
    if (!Number.isInteger(n)) throw bad('version must be an integer');
    const v = getVersion(this.db, id, n);
    if (!v) throw notFound('version not found');
    const graph = this.validOrThrow(parse(v.graph, {}), w.name);
    return this.hub.tx(() => {
      const version = this.cmd('wf.saved', { workflowId: id, graph, author: 'user', summary: `Restored v${n}`, parentVersion: n }, at);
      return { workflow: toWorkflow(getWorkflow(this.db, id)), version };
    });
  }
  updateWorkflow(id, body, at = this.now()) {
    if (!getWorkflow(this.db, id)) throw notFound('workflow not found');
    if (!isObj(body)) throw bad('body must be an object');
    const data = { workflowId: id };
    if (body.name !== undefined) {
      if (!isStr(body.name) || !body.name.trim()) throw bad('name must be a non-empty string');
      data.name = body.name.trim().slice(0, 200);
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw bad('archived must be a boolean');
      data.archived = body.archived;
    }
    return this.hub.tx(() => ({ workflow: this.cmd('wf.updated', data, at) }));
  }

  // ====================================================================== runs
  runDetail(id) {
    const r = getRun(this.db, id);
    if (!r) throw notFound('run not found');
    const nodes = runNodeRows(this.db, id);
    const run = toRun(r, nodes);
    const steps = this.db.all('SELECT * FROM steps WHERE run_id = ? ORDER BY created_at, rowid', id).map(toStep);
    return { run, nodes: run.nodes, steps };
  }
  listRuns({ workflowId, status } = {}) {
    const where = [], p = [];
    if (workflowId) { where.push('workflow_id = ?'); p.push(workflowId); }
    if (status) {
      const st = String(status).split(',').filter(Boolean);
      if (st.some((s) => !['running', 'paused', 'waiting', 'done', 'failed', 'aborted'].includes(s))) throw bad('invalid status');
      where.push(`status IN (${st.map(() => '?').join(',')})`); p.push(...st);
    }
    const rows = this.db.all(`SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rowid DESC LIMIT 200`, ...p);
    return rows.map((r) => toRun(r, runNodeRows(this.db, r.id)));
  }
  /** /v1/state: every workflow, and the runs that matter (active plus the last 20 finished), nodes inlined. */
  stateSlice(projectId) {
    const scope = projectId ? ' AND project_id = ?' : '';
    const sp = projectId ? [projectId] : [];
    const workflows = this.db.all(`SELECT * FROM workflows WHERE 1 = 1${scope} ORDER BY rowid`, ...sp).map(toWorkflow);
    const active = this.db.all(`SELECT * FROM runs WHERE status IN ('running','waiting','paused')${scope} ORDER BY rowid`, ...sp);
    const done = this.db.all(
      `SELECT * FROM runs WHERE status IN ('done','failed','aborted')${scope} ORDER BY ended_at DESC, rowid DESC LIMIT 20`, ...sp);
    const seen = new Set();
    const rows = [...active, ...done].filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
    rows.sort((a, b) => a.started_at - b.started_at || Number(a.id.slice(2)) - Number(b.id.slice(2)));
    return { workflows, runs: rows.map((r) => toRun(r, runNodeRows(this.db, r.id))) };
  }

  runWorkflow(id, body, at = this.now()) {
    const w = getWorkflow(this.db, id);
    if (!w) throw notFound('workflow not found');
    if (body !== undefined && body !== null && !isObj(body)) throw bad('body must be an object');
    const b = body || {};
    if (w.archived) throw conflict('this workflow is archived');
    const version = b.version === undefined || b.version === null ? w.current_version : Number(b.version);
    const v = Number.isInteger(version) ? getVersion(this.db, id, version) : null;
    if (!v) throw notFound('version not found');
    const graph = parse(v.graph, { nodes: [], edges: [] });
    const chk = validateGraph(graph);
    if (!chk.ok) throw bad(`this version has problems: ${chk.issues.find((i) => i.level === 'error').message}`, { issues: chk.issues });
    if (!graph.nodes.some((n) => n.type !== 'note')) throw bad('add at least one step before running');
    // params
    const spec = graph.params || [];
    const given = b.params === undefined || b.params === null ? {} : b.params;
    if (!isObj(given) || Object.values(given).some((x) => !isStr(x))) throw bad('params must be an object of strings');
    for (const k of Object.keys(given)) if (!spec.some((s) => s.key === k)) throw bad(`unknown param: ${k}`);
    const params = {};
    for (const s of spec) {
      const val = given[s.key] !== undefined ? given[s.key] : s.default;
      if (s.required && (!isStr(val) || !val.trim())) throw bad(`param "${s.key}" is required`);
      if (isStr(val)) params[s.key] = val.slice(0, 20000);
    }
    // driver session
    let driver;
    if (b.sessionId !== undefined && b.sessionId !== null && b.sessionId !== '') {
      if (!isStr(b.sessionId)) throw bad('sessionId must be a string');
      const s = this.p.getSession(b.sessionId);
      if (!s) throw notFound('session not found');
      if (s.status === 'ended') throw conflict('that session is not running');
      driver = s.id;
    } else {
      driver = this.hub.pickJobSession(null, w.project_id); // 409 { error: 'no live session' }
    }
    let budgetUsd = null;
    if (b.budgetUsd !== undefined && b.budgetUsd !== null) {
      if (typeof b.budgetUsd !== 'number' || !Number.isFinite(b.budgetUsd) || b.budgetUsd <= 0) throw bad('budgetUsd must be a positive number');
      budgetUsd = b.budgetUsd;
    }
    return this.hub.tx(() => {
      const run = this.cmd('wf.run.started', {
        workflowId: id, version, projectId: w.project_id, params, driverSessionId: driver, budgetUsd,
      }, at);
      this.evaluate(run.id, at);
      return { run: runRow(this.db, run.id) };
    });
  }

  // ------------------------------------------------------------ run controls
  needRun(id) {
    const r = getRun(this.db, id);
    if (!r) throw notFound('run not found');
    return r;
  }
  pauseRun(id, at = this.now()) {
    const r = this.needRun(id);
    if (r.status !== 'running' && r.status !== 'waiting') throw conflict(`cannot pause a run that is ${r.status}`);
    return this.hub.tx(() => { this.cmd('wf.run.status', { runId: id, status: 'paused', error: null }, at); return { run: runRow(this.db, id) }; });
  }
  resumeRun(id, at = this.now()) {
    const r = this.needRun(id);
    if (r.status !== 'paused') throw conflict(`cannot resume a run that is ${r.status}`);
    return this.hub.tx(() => {
      const data = { runId: id, status: 'running', error: null };
      if (r.budget_usd != null && r.cost_usd >= r.budget_usd) data.budgetUsd = null; // "continue anyway" lifts the limit
      this.cmd('wf.run.status', data, at);
      this.evaluate(id, at);
      return { run: runRow(this.db, id) };
    });
  }
  abortRun(id, at = this.now()) {
    const r = this.needRun(id);
    if (RUN_TERMINAL.includes(r.status)) throw conflict(`cannot abort a run that is ${r.status}`);
    return this.hub.tx(() => {
      this.stopWork(r, at, 'run aborted');
      this.cmd('wf.run.finished', { runId: id, status: 'aborted', error: null }, at);
      return { run: runRow(this.db, id) };
    });
  }
  /** Mark every in-flight node abandoned and fail its steps (abort / run failure). */
  stopWork(run, at, why) {
    for (const rn of runNodeRows(this.db, run.id)) {
      if (!ACTIVE_NODE.includes(rn.state)) continue;
      this.cmd('wf.node.state', { runId: run.id, nodeId: rn.node_id, state: 'abandoned', attempt: rn.attempt, error: why }, at);
    }
    for (const s of this.db.all(`SELECT id FROM steps WHERE run_id = ? AND state IN ('queued','running') ORDER BY rowid`, run.id)) {
      this.cmd('wf.step.failed', { stepId: s.id, error: why }, at);
    }
  }
  needNode(runId, nodeId) {
    const run = this.needRun(runId);
    const rn = getRunNode(this.db, runId, nodeId);
    if (!rn) throw notFound('node not found in this run');
    return { run, rn };
  }
  /** No later step may have started: a retry or skip only makes sense while everything after the node is still pending. */
  downstreamUntouched(run, nodeId) {
    const g = this.graphOf(run.workflow_id, run.version);
    return g.edges.filter((e) => e.from === nodeId).every((e) => {
      const t = getRunNode(this.db, run.id, e.to);
      return !t || t.state === 'pending';
    });
  }
  reopen(run, at) {
    if (run.status === 'failed') this.cmd('wf.run.status', { runId: run.id, status: 'running', error: null, reopen: true }, at);
  }
  retryNode(runId, nodeId, at = this.now()) {
    const { run, rn } = this.needNode(runId, nodeId);
    if (run.status === 'aborted' || run.status === 'done') throw conflict(`cannot retry in a run that is ${run.status}`);
    if (rn.state !== 'failed' && rn.state !== 'abandoned') throw conflict(`only a failed step can be retried (this one is ${rn.state})`);
    if (!this.downstreamUntouched(run, nodeId)) throw conflict('later steps have already started, so this one cannot be retried');
    return this.hub.tx(() => {
      this.reopen(run, at);
      this.cmd('wf.node.state', { runId, nodeId, state: 'pending', attempt: rn.attempt, output: null, error: null }, at);
      this.evaluate(runId, at);
      return { run: runRow(this.db, runId) };
    });
  }
  skipNode(runId, nodeId, at = this.now()) {
    const { run, rn } = this.needNode(runId, nodeId);
    if (run.status === 'aborted' || run.status === 'done') throw conflict(`cannot skip in a run that is ${run.status}`);
    if (!['failed', 'abandoned', 'pending', 'ready'].includes(rn.state)) throw conflict(`cannot skip a step that is ${rn.state}`);
    if (rn.state !== 'pending' && rn.state !== 'ready' && !this.downstreamUntouched(run, nodeId)) throw conflict('later steps have already started, so this one cannot be skipped');
    return this.hub.tx(() => {
      this.reopen(run, at);
      this.cmd('wf.node.state', { runId, nodeId, state: 'skipped', attempt: rn.attempt, output: { skipped: true }, error: null }, at);
      this.evaluate(runId, at);
      return { run: runRow(this.db, runId) };
    });
  }
  decideGate(runId, nodeId, body, at = this.now()) {
    const { run, rn } = this.needNode(runId, nodeId);
    if (!isObj(body)) throw bad('body must be an object');
    if (body.decision !== 'approve' && body.decision !== 'reject') throw bad('decision must be approve or reject');
    if (body.comment !== undefined && body.comment !== null && (!isStr(body.comment) || body.comment.length > 1000)) throw bad('comment must be a string (max 1000 characters)');
    if (RUN_TERMINAL.includes(run.status)) throw conflict(`this run is ${run.status}`);
    if (rn.state !== 'waiting_gate') throw conflict('this gate is not waiting for a decision');
    return this.hub.tx(() => {
      this.cmd('wf.gate.decided', { runId, nodeId, decision: body.decision, comment: isStr(body.comment) ? body.comment.trim() : '' }, at);
      this.evaluate(runId, at);
      return { run: runRow(this.db, runId) };
    });
  }

  // ---------------------------------------------------------------- the mod pull
  /** Atomically claim this session's due, queued steps (oldest first). Steps of paused/finished runs are left alone. */
  claimSteps(sessionId, at = this.now()) {
    const peek = () => this.db.all(
      `SELECT s.id FROM steps s JOIN runs r ON r.id = s.run_id
       WHERE s.session_id = ? AND s.state = 'queued' AND r.status IN ('running','waiting') AND COALESCE(s.not_before, 0) <= ?
       ORDER BY s.created_at, s.rowid`, sessionId, at);
    if (!peek().length) return { steps: [] };
    return this.hub.tx(() => {
      const ids = peek().map((r) => r.id);
      if (!ids.length) return { steps: [] };
      return { steps: this.cmd('wf.step.claimed', { ids, sessionId }, at) };
    });
  }

  // ========================================================================= tick
  /**
   * After every committed ingest/command and in every sweep: fail steps nobody will finish (session gone, never claimed,
   * overdue), then settle every live run. Cheap when no run is live.
   */
  tick(now = this.now()) {
    if (this.ticking || this.hub.closed || this.hub.replaying) return;
    const live = this.db.all(`SELECT id FROM runs WHERE status IN ('running','waiting','paused') ORDER BY rowid`);
    if (!live.length) return;
    this.ticking = true;
    try {
      const stale = this.staleSteps(now);
      if (stale.length) {
        this.hub.tx(() => { for (const s of stale) this.cmd('wf.step.failed', { stepId: s.id, error: s.error }, now); });
      }
      for (const r of live) this.evaluate(r.id, now);
    } catch (e) {
      this.hub.log?.error('workflow tick failed', e);
    } finally {
      this.ticking = false;
    }
  }
  staleSteps(now) {
    const { jobMs, stepMs } = this.hub.cfg;
    const out = [];
    const rows = this.db.all(
      `SELECT s.*, r.status AS run_status, r.workflow_id AS wf_id, r.version AS wf_version FROM steps s JOIN runs r ON r.id = s.run_id
       WHERE s.state IN ('queued','running') ORDER BY s.rowid`);
    for (const s of rows) {
      const ses = this.p.getSession(s.session_id);
      if (!ses || ses.status === 'ended') { out.push({ id: s.id, error: 'session ended' }); continue; }
      if (s.run_status === 'paused') continue;
      if (s.state === 'queued') {
        if (Math.max(s.created_at, s.not_before ?? 0) + jobMs < now) out.push({ id: s.id, error: UNCLAIMED_ERROR });
        continue;
      }
      const gn = this.graphOf(s.wf_id, s.wf_version).nodes.find((n) => n.id === s.node_id);
      const own = gn?.timeoutMs ?? (gn?.type === 'shell' ? gn.config.timeoutMs : null);
      const limit = own != null ? own + 60_000 : stepMs;
      if ((s.claimed_at ?? s.created_at) + limit < now) out.push({ id: s.id, error: 'timed out' });
    }
    return out;
  }

  // ===================================================================== planner
  /** Settle a run: plan an action, record it, plan again. Opens a transaction only when there is something to do. */
  evaluate(runId, at = this.now()) {
    let act = this.plan(runId, at);
    if (!act) return false;
    this.hub.tx(() => {
      for (let i = 0; i < 500 && act; i++) {
        act();
        act = this.plan(runId, at);
      }
      if (act) this.hub.log?.error(`workflow run ${runId} did not settle`);
    });
    return true;
  }

  latestStep(runId, nodeId) {
    return this.db.get('SELECT * FROM steps WHERE run_id = ? AND node_id = ? ORDER BY attempt DESC, rowid DESC LIMIT 1', runId, nodeId);
  }
  outputsOf(runId) {
    const m = new Map();
    for (const r of runNodeRows(this.db, runId)) {
      const o = parse(r.output, null);
      if (o) m.set(r.node_id, o);
    }
    return m;
  }
  /** Outcome that decides which edges leave a finished node; null for a dead (skipped by routing) node. */
  outcomeOf(rn, gn) {
    if (rn.state === 'abandoned') return null;
    if (rn.state === 'skipped') return parse(rn.output, null)?.skipped === true ? (gn.type === 'gate' ? 'approved' : 'ok') : null;
    if (rn.state === 'ok') return gn.type === 'gate' ? 'approved' : 'ok';
    if (rn.state === 'failed') return gn.type === 'gate' ? 'rejected' : 'fail';
    return null;
  }

  plan(runId, at) {
    const run = getRun(this.db, runId);
    if (!run || RUN_TERMINAL.includes(run.status)) return null;
    const graph = this.graphOf(run.workflow_id, run.version);
    const gmap = new Map(graph.nodes.map((n) => [n.id, n]));
    const exec = graph.nodes.filter((n) => n.type !== 'note');
    const rows = new Map(runNodeRows(this.db, runId).map((r) => [r.node_id, r]));

    // 1. a finished step becomes a node outcome
    for (const gn of exec) {
      const rn = rows.get(gn.id);
      if (!rn || (rn.state !== 'queued' && rn.state !== 'running')) continue;
      const st = this.latestStep(runId, gn.id);
      if (st && (st.state === 'done' || st.state === 'failed')) return () => this.settle(run, gn, rn, st, at);
    }
    // 2. a failure nobody handles ends the run
    for (const gn of exec) {
      const rn = rows.get(gn.id);
      if (!rn || rn.state !== 'failed') continue;
      const outcome = this.outcomeOf(rn, gn);
      if (!graph.edges.some((e) => e.from === gn.id && e.when === outcome)) return () => this.failRun(run, gn, rn, at);
    }
    // 3. pending nodes whose incoming edges are all resolved become ready (or are skipped as unreachable)
    for (const gn of exec) {
      const rn = rows.get(gn.id);
      if (!rn || rn.state !== 'pending') continue;
      const inc = graph.edges.filter((e) => e.to === gn.id);
      let unresolved = false, taken = !inc.length;
      for (const e of inc) {
        const src = rows.get(e.from);
        if (!src || !NODE_TERMINAL.includes(src.state)) { unresolved = true; break; }
        if (this.outcomeOf(src, gmap.get(e.from)) === e.when) taken = true;
      }
      if (unresolved) continue;
      return taken
        ? () => this.cmd('wf.node.state', { runId, nodeId: gn.id, state: 'ready', attempt: rn.attempt }, at)
        : () => this.cmd('wf.node.state', { runId, nodeId: gn.id, state: 'skipped', attempt: rn.attempt, output: null }, at);
    }
    // 4. nothing left to do and nothing in flight: the run is done
    const states = exec.map((n) => rows.get(n.id)?.state);
    if (!states.some((s) => ACTIVE_NODE.includes(s) || s === 'pending')) {
      return () => this.cmd('wf.run.finished', { runId, status: 'done', error: null }, at);
    }
    // 5. launch ready nodes (not while paused)
    let noSession = false;
    if (run.status !== 'paused') {
      for (const gn of exec) {
        const rn = rows.get(gn.id);
        if (!rn || rn.state !== 'ready') continue;
        if (run.budget_usd != null && run.cost_usd >= run.budget_usd) {
          return () => this.cmd('wf.run.status', { runId, status: 'paused', error: `budget reached ($${run.budget_usd})` }, at);
        }
        if (gn.type === 'gate') return () => this.openGate(run, graph, gn, rn, at);
        const pick = this.chooseSession(run, gn);
        if (pick.fail) return () => this.failNode(run, gn, rn, pick.fail, { ok: false }, null, at);
        if (!pick.sessionId) { noSession = true; continue; }
        return () => this.queueStep(run, graph, gn, rn, pick, at);
      }
    }
    // 6. keep Run.status honest
    if (run.status === 'paused') return null;
    let want;
    let err = null;
    if (states.some((s) => s === 'queued' || s === 'running')) want = 'running';
    else if (noSession) { want = 'waiting'; err = 'waiting for a live session'; }
    else if (states.includes('waiting_gate')) want = 'waiting';
    else want = 'running';
    if (run.status !== want || (run.error ?? null) !== err) return () => this.cmd('wf.run.status', { runId, status: want, error: err }, at);
    return null;
  }

  // ----------------------------------------------------------------- actions
  /** Turn a finished step into a node state: ok, retry (back to ready) or failed. */
  settle(run, gn, rn, st, at) {
    const j = this.judge(gn, st);
    if (j.ok) {
      this.cmd('wf.node.state', { runId: run.id, nodeId: gn.id, state: 'ok', attempt: rn.attempt, output: j.output, error: null }, at);
    } else if (st.attempt <= (gn.retry?.max || 0)) {
      this.cmd('wf.node.state', {
        runId: run.id, nodeId: gn.id, state: 'ready', attempt: rn.attempt, output: j.output, error: cut(`attempt ${st.attempt} failed: ${j.error}`, 500),
      }, at);
    } else {
      this.failNode(run, gn, rn, j.error, j.output, st.session_id, at);
    }
  }
  /** Terminal failure of a node. Non-agent nodes get a blocked card so the failure shows on the Board. */
  failNode(run, gn, rn, error, output, sessionId, at) {
    let taskId = rn.task_id || null;
    if (!taskId) {
      const t = this.cmd('hub.task.create', {
        projectId: run.project_id, sessionId: sessionId || run.driver_session_id || null, title: cut(`${gn.label} failed`, 300),
        description: cut(`Run ${run.id}, step ${gn.id}.\n\n${error}`, 2000), status: 'blocked', dependsOn: [], runId: run.id, nodeId: gn.id,
      }, at);
      taskId = t.id;
    }
    this.cmd('wf.node.state', { runId: run.id, nodeId: gn.id, state: 'failed', attempt: rn.attempt, output, error: cut(error, 500), taskId }, at);
  }
  failRun(run, gn, rn, at) {
    this.stopWork(run, at, 'run failed');
    this.cmd('wf.run.finished', { runId: run.id, status: 'failed', error: cut(`${gn.label} failed${rn.error ? ': ' + rn.error : ''}`, 500) }, at);
  }

  /** What a finished step means for its node. */
  judge(gn, st) {
    const res = parse(st.result, null);
    if (!res) return { ok: false, error: st.error || 'step failed', output: { ok: false } };
    switch (gn.type) {
      case 'agent': {
        const ok = res.ok !== false;
        const output = { ok };
        if (res.text !== undefined) output.text = res.text;
        if (res.filesChanged) output.filesChanged = res.filesChanged;
        if (res.agentId) output.agentId = res.agentId;
        output.taskId = res.taskId || st.task_id || undefined;
        return { ok, output, error: ok ? null : res.error || st.error || 'agent failed' };
      }
      case 'shell': {
        const c = res.check || {};
        let passed;
        if (typeof c.exitCode === 'number' && !c.timedOut) {
          if (gn.config.passIf === 'regex') {
            let re = null;
            try { re = new RegExp(gn.config.pattern); } catch { /* validated at save time */ }
            passed = !!re && re.test(`${c.stdout || ''}\n${c.stderr || ''}`);
          } else passed = c.exitCode === 0;
        } else passed = typeof c.passed === 'boolean' ? c.passed : res.ok !== false;
        if (c.timedOut) passed = false;
        const text = res.text !== undefined ? res.text : tailStr(`${c.stdout || ''}${c.stderr ? '\n' + c.stderr : ''}`.trim(), 4000);
        const output = { ok: passed, check: { ...c, passed }, text };
        const error = passed ? null : c.timedOut ? 'timed out' : typeof c.exitCode === 'number' ? (gn.config.passIf === 'regex' ? 'output did not match the pass pattern' : `exit code ${c.exitCode}`) : res.error || st.error || 'check failed';
        return { ok: passed, output, error };
      }
      case 'review': {
        const verdict = res.verdict || parseVerdict(res.text);
        const ran = res.ok !== false;
        const ok = ran && verdict === 'pass';
        const output = { ok, verdict: verdict || null };
        if (res.text !== undefined) output.text = res.text;
        output.findings = res.findings !== undefined ? res.findings : res.text ? res.text.replace(/VERDICT:\s*(PASS|CHANGES)\s*$/i, '').trim() : '';
        const error = ok ? null : !ran ? res.error || st.error || 'review failed' : verdict === 'changes' ? 'review asked for changes' : 'review gave no verdict';
        return { ok, output, error };
      }
      default:
        return { ok: res.ok !== false, output: { ok: res.ok !== false }, error: res.error || null };
    }
  }

  liveSession(id) {
    const s = id ? this.p.getSession(id) : null;
    return s && s.status !== 'ended' ? s : null;
  }
  /** Session for a step: the node's pinned one, else the run's driver, else the newest live one. A retry prefers a different session. */
  chooseSession(run, gn) {
    if (gn.sessionId) {
      return this.liveSession(gn.sessionId) ? { sessionId: gn.sessionId, pinned: true } : { fail: `session ${gn.sessionId} is not running` };
    }
    const prev = this.latestStep(run.id, gn.id);
    const avoid = prev && prev.state === 'failed' ? prev.session_id : null;
    let sid = this.liveSession(run.driver_session_id) ? run.driver_session_id : null;
    if (sid && avoid && sid === avoid) {
      const alt = this.db.get(
        `SELECT id FROM sessions WHERE status IN ('active','idle') AND id != ? AND project_id = ? ORDER BY last_seen_at DESC, rowid DESC LIMIT 1`,
        avoid, run.project_id) || this.db.get(`SELECT id FROM sessions WHERE status = 'active' AND id != ? ORDER BY last_seen_at DESC, rowid DESC LIMIT 1`, avoid);
      if (alt) sid = alt.id;
    }
    if (!sid) {
      try { sid = this.hub.pickJobSession(null, run.project_id); } catch (e) { if (e instanceof HttpError) return {}; throw e; }
    }
    return { sessionId: sid };
  }

  ancestorIds(graph, id) {
    const parents = new Map();
    for (const e of graph.edges) { if (!parents.has(e.to)) parents.set(e.to, []); parents.get(e.to).push(e.from); }
    const seen = new Set(), stack = [...(parents.get(id) || [])];
    while (stack.length) { const c = stack.pop(); if (seen.has(c)) continue; seen.add(c); stack.push(...(parents.get(c) || [])); }
    return graph.nodes.filter((n) => seen.has(n.id)).map((n) => n.id); // graph order
  }

  queueStep(run, graph, gn, rn, pick, at) {
    const prev = this.latestStep(run.id, gn.id);
    const attempt = (prev?.attempt || 0) + 1;
    const params = parse(run.params, {});
    const outputs = this.outputsOf(run.id);
    const R = (s) => renderTemplate(s, params, outputs);
    const cfg = gn.config;
    let taskId = rn.task_id || null;
    if (gn.type === 'agent' && !taskId) {
      const deps = graph.edges.filter((e) => e.to === gn.id).map((e) => getRunNode(this.db, run.id, e.from)?.task_id).filter(Boolean);
      const t = this.cmd('hub.task.create', {
        projectId: run.project_id, sessionId: pick.sessionId, title: cut(gn.label, 300),
        description: cut(`${R(cfg.prompt)}\n\n(Workflow run ${run.id}, step ${gn.id})`, 4000), status: 'in_progress',
        dependsOn: [...new Set(deps)], runId: run.id, nodeId: gn.id,
      }, at);
      taskId = t.id;
    }
    const base = { runId: run.id, nodeId: gn.id, attempt, label: gn.label };
    let input;
    if (gn.type === 'agent') {
      input = {
        ...base, agent: cfg.agent, subagentType: `helm:${cfg.agent}`, model: cfg.agent === 'scout' ? 'haiku' : 'sonnet',
        prompt: R(cfg.prompt), description: `[helm:${taskId}] ${gn.label}`, taskId,
        ...(cfg.cwd ? { cwd: R(cfg.cwd) } : {}), ...(cfg.isolation ? { isolation: cfg.isolation } : {}),
      };
    } else if (gn.type === 'shell') {
      input = {
        ...base, ...(cfg.argv ? { argv: cfg.argv.map(R) } : { script: R(cfg.script) }), ...(cfg.cwd ? { cwd: R(cfg.cwd) } : {}),
        timeoutMs: cfg.timeoutMs, passIf: cfg.passIf, ...(cfg.passIf === 'regex' ? { pattern: cfg.pattern } : {}),
      };
    } else {
      input = { ...base, ...this.reviewInput(run, graph, gn, params, outputs) };
    }
    const backoff = attempt > 1 ? gn.retry?.backoffMs || 0 : 0;
    this.cmd('wf.step.created', {
      stepId: `${run.id}:${gn.id}:${attempt}`, runId: run.id, nodeId: gn.id, attempt, kind: gn.type, sessionId: pick.sessionId, input, taskId,
      notBefore: backoff ? at + backoff : null,
      ...(!pick.pinned && pick.sessionId !== run.driver_session_id ? { driverSessionId: pick.sessionId } : {}),
    }, at);
  }

  reviewInput(run, graph, gn, params, outputs) {
    const cfg = gn.config;
    const want = new Set(cfg.inputs || ['text', 'files']);
    const lines = [`Workflow run ${run.id}.`];
    const pk = Object.entries(params);
    if (pk.length) lines.push('', '## Brief', ...pk.map(([k, v]) => `${k}: ${cut(v, 3000)}`));
    for (const id of this.ancestorIds(graph, gn.id)) {
      const n = graph.nodes.find((x) => x.id === id);
      const o = outputs.get(id);
      if (!n || !o || n.type === 'note') continue;
      lines.push('', `## ${n.label} (${n.type}${o.ok === false ? ', failed' : ''})`);
      if (want.has('text') && o.text) lines.push(cut(o.text, 3000));
      if (want.has('files') && o.filesChanged?.length) lines.push('Files changed:', ...o.filesChanged.slice(0, 60).map((f) => `- ${f}`));
      if (want.has('check') && o.check) lines.push(`Check: exit code ${o.check.exitCode ?? '?'}, ${o.check.passed ? 'passed' : 'failed'}`);
    }
    const system = `You are a strict code reviewer. Judge the work against this rubric:\n\n${R2(cfg.rubric, params, outputs)}\n\n`
      + 'Reply with your findings as short bullet points, most important first. End with a final line that is exactly "VERDICT: PASS" '
      + 'if the work is acceptable, or "VERDICT: CHANGES" if it needs changes.';
    return { model: 'opus', system, prompt: lines.join('\n'), maxTokens: 4096, timeoutMs: gn.timeoutMs || 180_000, rubric: cfg.rubric };
  }

  openGate(run, graph, gn, rn, at) {
    const params = parse(run.params, {});
    const outputs = this.outputsOf(run.id);
    const message = renderTemplate(gn.config.message, params, outputs);
    const anc = this.ancestorIds(graph, gn.id);
    const taskIds = [], files = [];
    for (const id of anc) {
      const r = getRunNode(this.db, run.id, id);
      if (r?.task_id && !taskIds.includes(r.task_id)) taskIds.push(r.task_id);
      for (const f of outputs.get(id)?.filesChanged || []) if (!files.includes(f) && files.length < 200) files.push(f);
    }
    let taskId = rn.task_id || null;
    if (!taskId) {
      const t = this.cmd('hub.task.create', {
        projectId: run.project_id, sessionId: run.driver_session_id || null, title: cut(`Approve: ${gn.label}`, 300),
        description: cut(`${message}\n\n(Workflow run ${run.id}, step ${gn.id})`, 4000), status: 'review',
        dependsOn: taskIds.slice(0, 20), runId: run.id, nodeId: gn.id,
      }, at);
      taskId = t.id;
    }
    this.cmd('wf.gate.opened', { runId: run.id, nodeId: gn.id, message, show: gn.config.show, taskId, taskIds, files }, at);
  }
}

function R2(text, params, outputs) { return renderTemplate(text, params, outputs); }
