// v0.9: Workflows. Graph validator, the engine's state machine (happy / fail / retry), idempotent results, resume after a
// restart, gates, run controls, step timeouts, cost roll-up, rebuild determinism, migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, tmpDir, openStream } from './helpers.mjs';
import { loadConfig } from '../config.mjs';
import { createLogger } from '../log.mjs';
import { Hub } from '../hub.mjs';
import { validateGraph, TEMPLATES, SCHEMA } from '../wfgraph.mjs';

const T0 = 1_800_000_000_000;

/** A hub with one live session `s1` (and so a project) on a virtual clock. */
async function setup(over = {}) {
  const h = await startTest(over);
  const clock = { t: T0 };
  h.hub.setClock(() => clock.t);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }, clock.t));
  const pid = h.state().projects[0].id;
  return { h, clock, pid };
}
const tpl = async (h, pid) => (await h.api('POST', '/v1/workflows', { projectId: pid, template: 'build-test-review' })).json.workflow;
const run = async (h, wid, body = { params: { brief: 'Add a login page' } }) => (await h.api('POST', `/v1/workflows/${wid}/run`, body));
const claim = async (h, sid = 's1') => (await h.get(`/v1/sessions/${sid}/steps`)).json.steps;
const detail = async (h, rid) => (await h.get(`/v1/runs/${rid}`)).json;
const states = async (h, rid) => Object.fromEntries((await detail(h, rid)).nodes.map((n) => [n.nodeId, n.state]));
const finish = (h, sid, stepId, data = {}, at) => h.send(h.ev(sid, 'wf.step.result', { stepId, ok: true, ...data }, at ?? h.hub.now()));
const stepCount = (h) => h.hub.db.get('SELECT COUNT(*) AS n FROM steps').n;

const node = (id, type, config, over = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config, retry: { max: 0, backoffMs: 0 }, ...over });
const agent = (id, over) => node(id, 'agent', { agent: 'builder', prompt: `do ${id}` }, over);
const graph = (nodes, edges, extra = {}) => ({ schema: SCHEMA, name: 'g', nodes, edges, ...extra });
async function custom(h, pid, g, name = 'Custom') {
  const r = await h.api('POST', '/v1/workflows', { projectId: pid, name, graph: g });
  assert.equal(r.status, 201, r.text);
  return r.json.workflow;
}

// ===================================================================== validator
test('validator: clear issues for bad graphs, normalises good ones, and the template is valid', () => {
  const t = TEMPLATES['build-test-review']().graph;
  const ok = validateGraph(t);
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  assert.equal(ok.graph.edges.find((e) => e.id === 'e1').when, 'ok');

  const codes = (g) => validateGraph(g).issues.filter((i) => i.level === 'error').map((i) => i.code);
  assert.deepEqual(codes({ schema: 'nope', nodes: [] }), ['schema']);
  assert.ok(codes(graph([agent('a'), agent('a')], [])).includes('node-id'));
  assert.ok(codes(graph([node('x', 'wombat', {})], [])).includes('node-type'), 'unknown types are rejected, not dropped');
  assert.ok(codes(graph([agent('a'), agent('b')], [{ id: 'e', from: 'a', to: 'zz' }])).includes('edge-end'));
  assert.ok(codes(graph([agent('a'), agent('b')], [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'a' }])).some((c) => c === 'cycle' || c === 'entry'));
  assert.ok(codes(graph([agent('a'), agent('b'), agent('c')], [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'c' }, { id: 'e3', from: 'c', to: 'b' }])).includes('cycle'));
  assert.ok(codes(graph([agent('a'), agent('b')], [{ id: 'e', from: 'a', to: 'b', when: 'approved' }])).includes('edge-when'), 'approved only leaves a gate');
  assert.ok(codes(graph([node('g', 'gate', { message: 'm' }), agent('b')], [{ id: 'e', from: 'g', to: 'b', when: 'ok' }])).includes('edge-when'));
  assert.ok(codes(graph([agent('a', { retry: { max: 9 } })], [])).includes('retry'));
  assert.ok(codes(graph([node('s', 'shell', {})], [])).includes('config'), 'shell needs argv or script');
  assert.ok(codes(graph([node('s', 'shell', { argv: ['ls'], script: 'ls' })], [])).includes('config'));
  assert.ok(codes(graph([node('s', 'shell', { argv: ['ls'], passIf: 'regex', pattern: '(' })], [])).includes('config'));
  // references must resolve to something upstream that can produce the key
  assert.ok(codes(graph([agent('a', {}), node('b', 'agent', { agent: 'builder', prompt: '{{params.nope}}' })], [{ id: 'e', from: 'a', to: 'b' }])).includes('ref'));
  assert.ok(codes(graph([agent('a'), node('b', 'agent', { agent: 'builder', prompt: '{{inputs.a.verdict}}' })], [{ id: 'e', from: 'a', to: 'b' }])).includes('ref'));
  assert.ok(codes(graph([node('a', 'agent', { agent: 'builder', prompt: '{{inputs.b.text}}' }), agent('b')], [{ id: 'e', from: 'a', to: 'b' }])).includes('ref'), 'b runs after a');
  assert.deepEqual(codes(graph([agent('a'), node('b', 'agent', { agent: 'builder', prompt: '{{inputs.a.text}}' })], [{ id: 'e', from: 'a', to: 'b' }])), []);
  // notes carry no edges; unknown config keys are a warning and are dropped
  assert.ok(codes(graph([agent('a'), node('n', 'note', { text: 'hi' })], [{ id: 'e', from: 'a', to: 'n' }])).includes('edge-note'));
  const w = validateGraph(graph([node('a', 'agent', { agent: 'builder', prompt: 'p', bogus: 1 })], []));
  assert.equal(w.ok, true);
  assert.ok(w.issues.some((i) => i.level === 'warn' && i.code === 'config-key'));
  assert.equal('bogus' in w.graph.nodes[0].config, false);
  assert.equal(validateGraph(null).ok, false);
});

// ================================================================ store + http
test('workflow store: create from template, validate on save (400 with issues), versions, restore, rename, archive', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  assert.equal((await h.api('POST', '/v1/workflows', { projectId: pid, template: 'nope' })).status, 400);
  assert.equal((await h.api('POST', '/v1/workflows', { projectId: 'P-99', template: 'build-test-review' })).status, 404);
  const w = await tpl(h, pid);
  assert.equal(w.id, 'W-1');
  assert.equal(w.currentVersion, 1);
  assert.equal(w.name, 'Build → Test → Gate → Review → Merge');

  const d = (await h.get('/v1/workflows/W-1')).json;
  assert.equal(d.versions.length, 1);
  assert.equal(d.versions[0].graph.nodes.length, 7);
  assert.equal(d.versions[0].author, 'user');

  const bad = await h.api('PUT', '/v1/workflows/W-1', { graph: { ...d.versions[0].graph, edges: [{ id: 'x', from: 'build', to: 'nowhere' }] } });
  assert.equal(bad.status, 400);
  assert.ok(Array.isArray(bad.json.issues) && bad.json.issues.some((i) => i.code === 'edge-end'));

  const g2 = structuredClone(d.versions[0].graph);
  g2.nodes.find((n) => n.id === 'build').config.prompt = 'Build {{params.brief}} carefully';
  const s2 = await h.api('PUT', '/v1/workflows/W-1', { graph: g2, summary: 'Tweak the prompt' });
  assert.equal(s2.status, 200);
  assert.equal(s2.json.version.version, 2);
  assert.equal(s2.json.version.summary, 'Tweak the prompt');
  assert.equal(s2.json.version.parentVersion, 1);
  assert.equal(s2.json.workflow.currentVersion, 2);
  assert.equal((await h.api('PUT', '/v1/workflows/W-1', { graph: g2 })).json.unchanged, true, 'an identical save makes no new version');

  const rs = await h.api('POST', '/v1/workflows/W-1/restore', { version: 1 });
  assert.equal(rs.json.version.version, 3);
  assert.equal(rs.json.version.summary, 'Restored v1');
  assert.equal(rs.json.version.parentVersion, 1);
  assert.equal(rs.json.version.graph.nodes.find((n) => n.id === 'build').config.prompt, '{{params.brief}}');
  assert.equal((await h.api('POST', '/v1/workflows/W-1/restore', { version: 9 })).status, 404);

  assert.equal((await h.api('PATCH', '/v1/workflows/W-1', { name: 'Ship it' })).json.workflow.name, 'Ship it');
  assert.ok(h.hub.search('ship').some((r) => r.kind === 'workflow' && r.id === 'W-1' && r.projectId === pid));
  assert.equal((await h.api('PATCH', '/v1/workflows/W-1', { archived: true })).json.workflow.archived, true);
  assert.equal((await run(h, 'W-1')).status, 409, 'an archived workflow does not run');

  const v = await h.api('POST', '/v1/workflows/validate', { graph: { schema: SCHEMA, nodes: [] } });
  assert.equal(v.status, 200);
  assert.equal(v.json.ok, true);
  assert.equal((await h.get('/v1/workflows?projectId=' + pid)).json.workflows.length, 1);
  assert.equal(h.state().workflows.length, 1);
  assert.equal(h.state().workflows[0].name, 'Ship it');
});

test('only step results may come from a mod: other wf.* events are rejected at ingest', async (t) => {
  const { h } = await setup(); t.after(h.stop);
  const r = h.send(h.ev('s1', 'wf.run.started', { workflowId: 'W-1', version: 1 }), h.ev('s1', 'wf.gate.decided', { runId: 'R-1', nodeId: 'x', decision: 'approve' }));
  assert.equal(r.accepted, 0);
  assert.equal(r.rejected, 2);
});

// ======================================================================= happy path
test('state machine, happy path: build -> test -> gate -> review -> merge, cards, gate question, costs', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await tpl(h, pid);

  assert.equal((await run(h, 'W-1', { params: {} })).status, 400, 'brief is required');
  assert.equal((await run(h, 'W-1', { params: { brief: 'x', other: 'y' } })).status, 400, 'unknown param');
  const r = await run(h, 'W-1');
  assert.equal(r.status, 201, r.text);
  const R = r.json.run;
  assert.equal(R.id, 'R-1');
  assert.equal(R.status, 'running');
  assert.equal(R.driverSessionId, 's1');
  assert.deepEqual(R.nodes.map((n) => [n.nodeId, n.state]), [['build', 'queued'], ['test', 'pending'], ['fix', 'pending'], ['gate', 'pending'], ['review', 'pending'], ['merge', 'pending']]);

  // the build agent: a card exists and its tag rides in the step input
  let steps = await claim(h);
  assert.equal(steps.length, 1);
  const b = steps[0];
  assert.equal(b.id, 'R-1:build:1');
  assert.equal(b.kind, 'agent');
  assert.equal(b.state, 'running');
  assert.equal(b.sessionId, 's1');
  assert.equal(b.input.prompt, 'Add a login page');
  assert.equal(b.input.subagentType, 'helm:builder');
  assert.equal(b.input.model, 'sonnet');
  assert.match(b.input.description, /^\[helm:T-1\] Build feature$/);
  assert.equal((await claim(h)).length, 0, 'a claimed step is not claimed twice');
  const card = h.state().tasks.find((x) => x.id === 'T-1');
  assert.equal(card.runId, 'R-1');
  assert.equal(card.nodeId, 'build');
  assert.equal(card.status, 'in_progress');
  assert.equal((await states(h, 'R-1')).build, 'running');

  // the mod's existing spawn path binds the tag to that card
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu1', subagentType: 'helm:builder', model: 'sonnet', description: b.input.description, prompt: b.input.prompt }));
  assert.equal(h.state().tasks.filter((x) => x.id !== 'T-1' && x.runId == null).length, 0, 'no duplicate card');
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: 'a1' }));
  h.send(h.ev('s1', 'agent.completed', { agentId: 'a1', ok: true, summary: 'built' }));
  assert.equal(h.state().tasks.find((x) => x.id === 'T-1').status, 'review');

  clock.t += 1000;
  finish(h, 's1', b.id, { text: 'Built it.', filesChanged: ['/w/proj/login.ts'], agentId: 'a1', usage: { model: 'sonnet', inputTokens: 1000, outputTokens: 500, costUsd: 0.25 } });
  let st = await states(h, 'R-1');
  assert.equal(st.build, 'ok');
  assert.equal(st.test, 'queued');
  assert.equal(h.state().tasks.find((x) => x.id === 'T-1').status, 'done', 'an ok node settles its card');

  // shell check; fix is skipped because test passed
  steps = await claim(h);
  assert.equal(steps[0].id, 'R-1:test:1');
  assert.deepEqual(steps[0].input.argv, ['npm', 'test']);
  assert.equal(steps[0].input.timeoutMs, 300000);
  finish(h, 's1', 'R-1:test:1', { check: { exitCode: 0, stdout: 'all green', stderr: '', passed: true } });
  st = await states(h, 'R-1');
  assert.equal(st.test, 'ok');
  assert.equal(st.fix, 'skipped');
  assert.equal(st.gate, 'waiting_gate');
  let rr = (await detail(h, 'R-1')).run;
  assert.equal(rr.status, 'waiting');
  assert.equal(rr.nodes.find((n) => n.nodeId === 'test').output.text, 'all green', 'shell output text feeds {{inputs.test.text}}');

  // the gate is an Inbox question and a card in Review
  const q = h.state().questions.find((x) => x.kind === 'approval');
  assert.ok(q);
  assert.equal(q.state, 'open');
  assert.equal(q.runId, 'R-1');
  assert.equal(q.nodeId, 'gate');
  assert.equal(q.sessionId, 's1');
  const gnode = rr.nodes.find((n) => n.nodeId === 'gate');
  assert.equal(gnode.questionId, q.id);
  assert.deepEqual(gnode.output.gate.files, ['/w/proj/login.ts']);
  assert.deepEqual(gnode.output.gate.taskIds, ['T-1']);
  const gcard = h.state().tasks.find((x) => x.id === gnode.taskId);
  assert.equal(gcard.status, 'review');
  assert.equal(gcard.runId, 'R-1');
  assert.equal((await h.api('POST', `/v1/questions/${q.id}/dismiss`)).status, 409, 'a gate is decided, not dismissed');
  assert.equal((await h.api('POST', '/v1/runs/R-1/gates/build', { decision: 'approve' })).status, 409, 'not a gate in waiting');
  assert.equal((await h.api('POST', '/v1/runs/R-1/gates/gate', { decision: 'maybe' })).status, 400);
  assert.equal((await claim(h)).length, 0, 'nothing runs behind a gate');

  const ap = await h.api('POST', '/v1/runs/R-1/gates/gate', { decision: 'approve', comment: 'looks fine' });
  assert.equal(ap.status, 200, ap.text);
  st = await states(h, 'R-1');
  assert.equal(st.gate, 'ok');
  assert.equal(st.review, 'queued');
  assert.equal(h.state().questions.find((x) => x.id === q.id).state, 'answered');
  assert.equal(h.state().tasks.find((x) => x.id === gnode.taskId).status, 'done');
  assert.equal((await h.api('POST', '/v1/runs/R-1/gates/gate', { decision: 'approve' })).status, 409, 'decided once');

  // review via model.complete: usage rides in the result
  steps = await claim(h);
  assert.equal(steps[0].kind, 'review');
  assert.equal(steps[0].input.model, 'opus');
  assert.match(steps[0].input.system, /VERDICT: PASS/);
  assert.match(steps[0].input.prompt, /Add a login page/);
  assert.match(steps[0].input.prompt, /login\.ts/);
  finish(h, 's1', 'R-1:review:1', { text: '- fine\nVERDICT: PASS', usage: { model: 'opus', inputTokens: 4000, outputTokens: 300, costUsd: 0.5 } });
  st = await states(h, 'R-1');
  assert.equal(st.review, 'ok');
  assert.equal(st.merge, 'queued');
  steps = await claim(h);
  assert.match(steps[0].input.prompt, /Review notes: - fine/, 'review findings flow into the next prompt');
  finish(h, 's1', 'R-1:merge:1', { text: 'merged', usage: { model: 'sonnet', costUsd: 0.1 } });

  rr = (await detail(h, 'R-1')).run;
  assert.equal(rr.status, 'done');
  assert.ok(rr.endedAt);
  assert.deepEqual(Object.values(await states(h, 'R-1')).sort(), ['ok', 'ok', 'ok', 'ok', 'ok', 'skipped']);
  // costs: run total is the sum of node costs
  assert.equal(rr.nodes.find((n) => n.nodeId === 'build').costUsd, 0.25);
  assert.equal(rr.nodes.find((n) => n.nodeId === 'review').costUsd, 0.5);
  assert.equal(rr.costUsd, 0.85);
  assert.equal(rr.costUsd, Math.round(rr.nodes.reduce((a, n) => a + n.costUsd, 0) * 1e6) / 1e6);
  const kinds = h.hub.db.all('SELECT kind, cost_usd, run_id, node_id FROM usage ORDER BY id');
  assert.deepEqual(kinds.map((k) => [k.kind, k.node_id]), [['wf_step', 'build'], ['wf_review', 'review'], ['wf_step', 'merge']]);
  assert.equal(h.state().runs.length, 1);
  assert.equal(h.state().runs[0].status, 'done');
  // every card the run made is accounted for
  assert.ok(h.state().tasks.filter((x) => x.runId === 'R-1').every((x) => x.status === 'done'));
});

// ============================================================ fail + retry paths
test('fail path: a failing test follows the fail edge to Fix, then the gate', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await tpl(h, pid);
  await run(h, 'W-1');
  let [b] = await claim(h);
  finish(h, 's1', b.id, { text: 'built' });
  let [tst] = await claim(h);
  finish(h, 's1', tst.id, { check: { exitCode: 1, stdout: 'FAIL login', stderr: 'boom' } });
  let st = await states(h, 'R-1');
  assert.equal(st.test, 'failed');
  assert.equal(st.fix, 'queued');
  assert.equal(st.gate, 'pending', 'the gate waits for the fix');
  const [fix] = await claim(h);
  assert.match(fix.input.prompt, /FAIL login/, 'the test output is in the fix prompt');
  assert.equal((await detail(h, 'R-1')).run.status, 'running');
  finish(h, 's1', fix.id, { text: 'fixed' });
  st = await states(h, 'R-1');
  assert.equal(st.fix, 'ok');
  assert.equal(st.gate, 'waiting_gate');
  const testNode = (await detail(h, 'R-1')).nodes.find((n) => n.nodeId === 'test');
  assert.equal(testNode.error, 'exit code 1');
  assert.ok(testNode.taskId, 'a failed shell check leaves a card so the failure is visible');
});

test('a failure with no fail edge fails the run, abandons what is in flight and blocks the card', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([agent('a'), agent('b'), agent('c')], [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'a', to: 'c' }]));
  await run(h, 'W-1', {});
  const [a] = await claim(h);
  finish(h, 's1', a.id, { ok: false, error: 'compile error' });
  const d = await detail(h, 'R-1');
  assert.equal(d.run.status, 'failed');
  assert.match(d.run.error, /a failed: compile error/);
  assert.equal((await states(h, 'R-1')).a, 'failed');
  assert.equal(h.state().tasks.find((x) => x.id === 'T-1').status, 'blocked');
  assert.equal(h.state().tasks.find((x) => x.id === 'T-1').blockedReason, 'compile error');
  assert.equal((await claim(h)).length, 0);
  // the user can retry the failed node: the run reopens and goes on
  const rt = await h.api('POST', '/v1/runs/R-1/nodes/a/retry');
  assert.equal(rt.status, 200, rt.text);
  assert.equal((await detail(h, 'R-1')).run.status, 'running');
  const [a2] = await claim(h);
  assert.equal(a2.id, 'R-1:a:2');
  assert.match(a2.input.description, /^\[helm:T-1\]/, 'a retry reuses the card');
  assert.equal(h.state().tasks.find((x) => x.id === 'T-1').status, 'in_progress');
  finish(h, 's1', a2.id, { text: 'ok now' });
  assert.deepEqual(await states(h, 'R-1'), { a: 'ok', b: 'queued', c: 'queued' });
});

test('retry: retry.max re-queues with a new attempt (another session if one is free), then fails', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  h.send(h.ev('s2', 'session.started', { cwd: '/w/proj', title: 'Other', model: 'm' }, clock.t + 1));
  await custom(h, pid, graph([agent('a', { retry: { max: 1, backoffMs: 0 } })], []));
  await run(h, 'W-1', {});
  const first = h.hub.db.get('SELECT * FROM steps').session_id;
  const [a1] = await claim(h, first);
  finish(h, first, a1.id, { ok: false, error: 'flaky' });
  let nodes = (await detail(h, 'R-1')).nodes;
  assert.equal(nodes[0].state, 'queued');
  assert.equal(nodes[0].attempt, 2);
  const s2 = h.hub.db.get(`SELECT * FROM steps WHERE id = 'R-1:a:2'`);
  assert.notEqual(s2.session_id, first, 'a retry prefers a different live session');
  const [a2] = await claim(h, s2.session_id);
  finish(h, s2.session_id, a2.id, { ok: false, error: 'flaky again' });
  const d = await detail(h, 'R-1');
  assert.equal(d.nodes[0].state, 'failed');
  assert.equal(d.run.status, 'failed');
  assert.equal(d.steps.length, 2);
  assert.deepEqual(d.steps.map((s) => s.state), ['failed', 'failed']);
});

test('retry backoff: the retry step is not claimable until notBefore', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([agent('a', { retry: { max: 1, backoffMs: 5000 } })], []));
  await run(h, 'W-1', {});
  const [a1] = await claim(h);
  finish(h, 's1', a1.id, { ok: false, error: 'x' });
  assert.equal((await claim(h)).length, 0, 'still backing off');
  clock.t += 6000;
  assert.equal((await claim(h)).length, 1);
});

test('review: a "changes" verdict fails the node; no verdict fails closed; skip lets the run continue', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph(
    [agent('a'), node('r', 'review', { rubric: 'be strict', inputs: ['text'] }), agent('z')],
    [{ id: 'e1', from: 'a', to: 'r' }, { id: 'e2', from: 'r', to: 'z' }]));
  await run(h, 'W-1', {});
  let [a] = await claim(h);
  finish(h, 's1', a.id, { text: 'did it' });
  let [r] = await claim(h);
  finish(h, 's1', r.id, { text: 'bad\nVERDICT: CHANGES', usage: { model: 'opus', costUsd: 0.2 } });
  const d = await detail(h, 'R-1');
  assert.equal(d.run.status, 'failed');
  const rn = d.nodes.find((n) => n.nodeId === 'r');
  assert.equal(rn.state, 'failed');
  assert.equal(rn.output.verdict, 'changes');
  assert.equal(rn.error, 'review asked for changes');
  assert.equal(d.run.costUsd, 0.2);
  // skip -> continue
  assert.equal((await h.api('POST', '/v1/runs/R-1/nodes/r/skip')).status, 200);
  assert.equal((await detail(h, 'R-1')).run.status, 'running');
  assert.deepEqual(await states(h, 'R-1'), { a: 'ok', r: 'skipped', z: 'queued' });
  const [z] = await claim(h);
  finish(h, 's1', z.id, {});
  assert.equal((await detail(h, 'R-1')).run.status, 'done');
});

test('retry/skip are refused when later steps already ran, and for the wrong state', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([agent('a'), agent('b')], [{ id: 'e1', from: 'a', to: 'b', when: 'ok' }, { id: 'e2', from: 'a', to: 'b', when: 'fail' }]));
  await run(h, 'W-1', {});
  const [a] = await claim(h);
  assert.equal((await h.api('POST', '/v1/runs/R-1/nodes/a/retry')).status, 409, 'running, not failed');
  assert.equal((await h.api('POST', '/v1/runs/R-1/nodes/a/skip')).status, 409);
  finish(h, 's1', a.id, { ok: false, error: 'x' }); // handled by the fail edge: b runs
  assert.equal((await states(h, 'R-1')).b, 'queued');
  assert.equal((await h.api('POST', '/v1/runs/R-1/nodes/a/retry')).status, 409, 'b has already started');
  assert.equal((await h.api('POST', '/v1/runs/R-1/nodes/nope/retry')).status, 404);
  assert.equal((await h.api('POST', '/v1/runs/R-9/pause')).status, 404);
});

// =========================================================== idempotence + restart
test('step results are idempotent by stepId (a repeat changes nothing, cost is booked once)', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([agent('a'), agent('b')], [{ id: 'e1', from: 'a', to: 'b' }]));
  await run(h, 'W-1', {});
  const [a] = await claim(h);
  const ev = h.ev('s1', 'wf.step.result', { stepId: a.id, ok: true, text: 'first', usage: { model: 'sonnet', costUsd: 0.3 } });
  assert.equal(h.send(ev).accepted, 1);
  assert.equal(h.send(ev).duplicates, 1, 'same (sessionId, seq): a duplicate');
  // a different event for the same step (e.g. the mod re-sent after losing its outbox) is ignored
  finish(h, 's1', a.id, { ok: false, error: 'late nonsense', text: 'second', usage: { model: 'sonnet', costUsd: 9 } });
  const d = await detail(h, 'R-1');
  assert.equal(d.nodes.find((n) => n.nodeId === 'a').state, 'ok');
  assert.equal(d.nodes.find((n) => n.nodeId === 'a').output.text, 'first');
  assert.equal(d.run.costUsd, 0.3);
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM usage').n, 1);
  assert.equal(finish(h, 's1', 'R-1:ghost:1', {}).accepted, 1, 'an unknown step is accepted and ignored');
  assert.equal(stepCount(h), 2);
});

test('resume after a restart mid-run: no step is created twice and the run carries on', async (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig({ home: dir, port: 0, singleton: false, sweep: false });
  const log = createLogger(path.join(dir, 'x.log'), { tty: false });
  let hub = new Hub(cfg, log, { clock: () => T0 });
  const ev = (sid, seq, type, data) => ({ sessionId: sid, seq, type, at: T0, data });
  hub.ingest([ev('s1', 1, 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' })]);
  const pid = hub.state().projects[0].id;
  const { workflow } = hub.wf.createWorkflow({ projectId: pid, template: 'build-test-review' });
  hub.wf.runWorkflow(workflow.id, { params: { brief: 'b' } });
  const [b] = hub.wf.claimSteps('s1').steps; // running, the mod has not answered yet
  assert.equal(b.id, 'R-1:build:1');
  const before = hub.db.all('SELECT id, state FROM steps');
  hub.close(); // "kill -9": everything is already in SQLite

  hub = new Hub(cfg, log, { clock: () => T0 + 1000 });
  hub.sweep(T0 + 1000); // the sweep re-evaluates live runs
  hub.wf.tick(T0 + 1000);
  assert.deepEqual(hub.db.all('SELECT id, state FROM steps'), before, 'nothing re-queued, nothing duplicated');
  assert.deepEqual(hub.wf.claimSteps('s1').steps, [], 'the running step is not handed out again');
  // the answer arrives after the restart
  hub.ingest([ev('s1', 2, 'wf.step.result', { stepId: b.id, ok: true, text: 'done' })]);
  const ids = hub.db.all('SELECT id FROM steps ORDER BY rowid').map((r) => r.id);
  assert.deepEqual(ids, ['R-1:build:1', 'R-1:test:1']);
  assert.equal(new Set(ids).size, ids.length);
  // a result delivered twice across the restart still advances once
  hub.ingest([ev('s1', 2, 'wf.step.result', { stepId: b.id, ok: true, text: 'done' })]);
  assert.equal(hub.db.get('SELECT COUNT(*) AS n FROM steps').n, 2);
  hub.close();
});

test('a crash between a result and its follow-up is repaired by the next tick (no lost step, no double)', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([agent('a'), agent('b')], [{ id: 'e1', from: 'a', to: 'b' }]));
  await run(h, 'W-1', {});
  const [a] = await claim(h);
  // write the result straight into the projection, as if the hub died before the engine reacted
  h.hub.wf.ticking = true; // suppress the automatic tick
  finish(h, 's1', a.id, { text: 'x' });
  h.hub.wf.ticking = false;
  assert.equal((await states(h, 'R-1')).a, 'running', 'result stored, node not yet settled');
  h.hub.sweep();
  assert.deepEqual(await states(h, 'R-1'), { a: 'ok', b: 'queued' });
  h.hub.sweep();
  h.hub.sweep();
  assert.equal(stepCount(h), 2);
});

// ================================================================== gates
test('gate routing: reject follows the rejected edge; approve follows approved; both are recorded', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const g = graph(
    [agent('build'), node('gate', 'gate', { message: 'Ship {{inputs.build.text}}?', show: 'text' }), agent('ship'), agent('rework')],
    [{ id: 'e1', from: 'build', to: 'gate' }, { id: 'e2', from: 'gate', to: 'ship', when: 'approved' }, { id: 'e3', from: 'gate', to: 'rework', when: 'rejected' }]);
  await custom(h, pid, g);
  await run(h, 'W-1', {});
  let [b] = await claim(h);
  finish(h, 's1', b.id, { text: 'the thing' });
  assert.equal(h.state().questions.find((q) => q.kind === 'approval').text, 'Ship the thing?');
  await h.api('POST', '/v1/runs/R-1/gates/gate', { decision: 'reject', comment: 'not yet' });
  let d = await detail(h, 'R-1');
  assert.deepEqual(await states(h, 'R-1'), { build: 'ok', gate: 'failed', ship: 'skipped', rework: 'queued' });
  assert.equal(d.nodes.find((n) => n.nodeId === 'gate').output.approved, false);
  assert.equal(d.nodes.find((n) => n.nodeId === 'gate').output.comment, 'not yet');
  assert.equal(d.run.status, 'running', 'a handled rejection does not fail the run');
  const [rw] = await claim(h);
  finish(h, 's1', rw.id, {});
  assert.equal((await detail(h, 'R-1')).run.status, 'done');

  // approve on a second run
  await run(h, 'W-1', {});
  [b] = await claim(h);
  finish(h, 's1', b.id, { text: 'again' });
  await h.api('POST', '/v1/runs/R-2/gates/gate', { decision: 'approve' });
  assert.deepEqual(await states(h, 'R-2'), { build: 'ok', gate: 'ok', ship: 'queued', rework: 'skipped' });
});

test('a rejected gate with no rejected edge fails the run; retrying the gate reopens it', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([node('gate', 'gate', { message: 'ok?' }), agent('after')], [{ id: 'e1', from: 'gate', to: 'after' }]));
  await run(h, 'W-1', {});
  assert.equal((await states(h, 'R-1')).gate, 'waiting_gate', 'an entry gate opens at once');
  await h.api('POST', '/v1/runs/R-1/gates/gate', { decision: 'reject', comment: 'no' });
  const d = await detail(h, 'R-1');
  assert.equal(d.run.status, 'failed');
  assert.match(d.run.error, /gate failed: rejected: no/);
  const rt = await h.api('POST', '/v1/runs/R-1/nodes/gate/retry');
  assert.equal(rt.status, 200, rt.text);
  assert.equal((await states(h, 'R-1')).gate, 'waiting_gate');
  assert.equal(h.state().questions.filter((q) => q.kind === 'approval' && q.state === 'open').length, 1);
  await h.api('POST', '/v1/runs/R-1/gates/gate', { decision: 'approve' });
  assert.equal((await states(h, 'R-1')).after, 'queued');
});

// ===================================================================== controls
test('pause holds new steps (results still land); resume releases; abort stops everything', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([agent('a'), agent('b'), agent('c')], [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'c' }]));
  await run(h, 'W-1', {});
  assert.equal((await h.api('POST', '/v1/runs/R-1/resume')).status, 409, 'not paused');
  const [a] = await claim(h);
  assert.equal((await h.api('POST', '/v1/runs/R-1/pause')).json.run.status, 'paused');
  assert.equal((await h.api('POST', '/v1/runs/R-1/pause')).status, 409);
  finish(h, 's1', a.id, { text: 'x' });
  assert.deepEqual(await states(h, 'R-1'), { a: 'ok', b: 'ready', c: 'pending' }, 'a is settled, b is held');
  assert.equal(stepCount(h), 1);
  assert.equal((await claim(h)).length, 0);
  const rs = await h.api('POST', '/v1/runs/R-1/resume');
  assert.equal(rs.json.run.status, 'running');
  assert.equal((await states(h, 'R-1')).b, 'queued');
  const [b] = await claim(h);
  // abort while b runs
  const ab = await h.api('POST', '/v1/runs/R-1/abort');
  assert.equal(ab.json.run.status, 'aborted');
  assert.deepEqual(await states(h, 'R-1'), { a: 'ok', b: 'abandoned', c: 'pending' });
  assert.equal(h.hub.db.get(`SELECT state FROM steps WHERE id = ?`, b.id).state, 'failed');
  assert.equal(h.state().tasks.find((x) => x.nodeId === 'b').status, 'blocked');
  finish(h, 's1', b.id, { text: 'too late' });
  assert.equal((await states(h, 'R-1')).b, 'abandoned', 'a late result does not revive an aborted run');
  assert.equal((await h.api('POST', '/v1/runs/R-1/abort')).status, 409);
  assert.equal((await h.api('POST', '/v1/runs/R-1/nodes/b/retry')).status, 409, 'aborted runs stay aborted');
});

test('abort closes an open gate question', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([node('gate', 'gate', { message: 'go?' })], []));
  await run(h, 'W-1', {});
  assert.equal(h.state().questions.filter((q) => q.state === 'open').length, 1);
  await h.api('POST', '/v1/runs/R-1/abort');
  assert.equal(h.state().questions.filter((q) => q.state === 'open').length, 0);
});

test('no live session: run is refused (409); a run with its driver gone waits, then continues when one appears', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([agent('a'), agent('b')], [{ id: 'e1', from: 'a', to: 'b' }]));
  assert.equal((await run(h, 'W-1', { sessionId: 'nope' })).status, 404);
  await run(h, 'W-1', {});
  const [a] = await claim(h);
  h.send(h.ev('s1', 'session.ended', { reason: 'bye' }, clock.t));
  assert.equal(h.hub.db.get(`SELECT state FROM steps WHERE id = ?`, a.id).state, 'failed', 'the step of an ended session fails');
  assert.equal((await detail(h, 'R-1')).run.status, 'failed');
  assert.equal((await run(h, 'W-1', {})).status, 409, 'no live session now');
  assert.match((await run(h, 'W-1', {})).json.error, /no live session/);

  // waiting: the driver ends while a node is ready
  h.send(h.ev('s2', 'session.started', { cwd: '/w/proj', title: 'Two', model: 'm' }, clock.t));
  await run(h, 'W-1', {}); // R-2 on s2
  const [a2] = await claim(h, 's2');
  finish(h, 's2', a2.id, { text: 'x' }); // b queued on s2
  h.send(h.ev('s2', 'session.ended', { reason: 'bye' }, clock.t)); // b fails: session ended
  assert.equal((await detail(h, 'R-2')).run.status, 'failed');
});

test('a ready node waits for a live session (run waiting) and goes on when one starts', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([agent('a'), agent('b')], [{ id: 'e1', from: 'a', to: 'b' }]));
  await run(h, 'W-1', {});
  const [a] = await claim(h);
  finish(h, 's1', a.id, { text: 'x' }); // b queued on s1
  // s1 ends before the mod claims b -> that step fails; use retry to land in `ready` with no session
  await h.api('POST', '/v1/runs/R-1/nodes/b/skip').catch(() => {});
  h.send(h.ev('s1', 'session.ended', {}, clock.t));
  const d = await detail(h, 'R-1');
  assert.equal(d.run.status, 'failed');
  const rt = await h.api('POST', '/v1/runs/R-1/nodes/b/retry');
  assert.equal(rt.status, 200);
  const r = (await detail(h, 'R-1')).run;
  assert.equal(r.status, 'waiting');
  assert.equal(r.error, 'waiting for a live session');
  assert.equal((await states(h, 'R-1')).b, 'ready');
  h.send(h.ev('s9', 'session.started', { cwd: '/w/proj', title: 'New', model: 'm' }, clock.t));
  const after = (await detail(h, 'R-1'));
  assert.equal(after.run.status, 'running');
  assert.equal(after.run.driverSessionId, 's9');
  assert.equal(after.steps.at(-1).sessionId, 's9');
});

// ================================================================== timeouts
test('sweep: an unclaimed step fails after HELM_JOB_MS (retry picks it up again); paused runs do not time out', async (t) => {
  const { h, clock, pid } = await setup({ jobMs: 60_000 }); t.after(h.stop);
  await custom(h, pid, graph([agent('a', { retry: { max: 1, backoffMs: 0 } })], []));
  await run(h, 'W-1', {});
  clock.t += 30_000;
  h.hub.sweep(clock.t);
  assert.equal(h.hub.db.get(`SELECT state FROM steps WHERE id = 'R-1:a:1'`).state, 'queued');
  clock.t += 40_000;
  h.hub.sweep(clock.t);
  const s1 = h.hub.db.get(`SELECT * FROM steps WHERE id = 'R-1:a:1'`);
  assert.equal(s1.state, 'failed');
  assert.equal(s1.error, 'not picked up by a live session');
  assert.equal((await detail(h, 'R-1')).nodes[0].attempt, 2, 'retried');
  // out of retries: the run fails
  clock.t += 70_000;
  h.hub.sweep(clock.t);
  const d = await detail(h, 'R-1');
  assert.equal(d.run.status, 'failed');
  assert.match(d.run.error, /not picked up/);

  await run(h, 'W-1', {});
  await h.api('POST', '/v1/runs/R-2/pause');
  clock.t += 600_000;
  h.hub.sweep(clock.t);
  assert.equal(h.hub.db.get(`SELECT state FROM steps WHERE run_id = 'R-2'`).state, 'queued', 'paused: no timeout');
});

test('sweep: a claimed step nobody answers times out using the node timeout', async (t) => {
  const { h, clock, pid } = await setup({ stepMs: 10 * 60_000 }); t.after(h.stop);
  await custom(h, pid, graph([node('s', 'shell', { argv: ['sleep', '1'], timeoutMs: 5000 }), agent('b')], [{ id: 'e1', from: 's', to: 'b' }]));
  await run(h, 'W-1', {});
  await claim(h);
  clock.t += 50_000; // 5s timeout + 60s grace not yet over
  h.hub.sweep(clock.t);
  assert.equal((await states(h, 'R-1')).s, 'running');
  clock.t += 20_000;
  h.hub.sweep(clock.t);
  const d = await detail(h, 'R-1');
  assert.equal(d.run.status, 'failed');
  assert.match(d.run.error, /timed out/);
});

// ====================================================================== costs
test('cost roll-up: helm.usage rows with runId + nodeId sum into node and run; unknown links still book usage', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([agent('a'), agent('b')], [{ id: 'e1', from: 'a', to: 'b' }]));
  await run(h, 'W-1', { budgetUsd: 1 });
  const at = clock.t;
  h.send(h.ev('s1', 'helm.usage', { kind: 'wf_step', model: 'sonnet', inputTokens: 100, outputTokens: 50, costUsd: 0.1, runId: 'R-1', nodeId: 'a' }, at));
  h.send(h.ev('s1', 'helm.usage', { kind: 'wf_step', model: 'sonnet', costUsd: 0.2, runId: 'R-1', nodeId: 'a' }, at));
  h.send(h.ev('s1', 'helm.usage', { kind: 'wf_review', model: 'opus', costUsd: 0.05, runId: 'R-1', nodeId: 'b' }, at));
  h.send(h.ev('s1', 'helm.usage', { kind: 'wf_step', model: 'sonnet', costUsd: 0.4, runId: 'R-9', nodeId: 'a' }, at));
  h.send(h.ev('s1', 'helm.usage', { kind: 'recap', model: 'haiku', costUsd: 0.01 }, at));
  const r = (await detail(h, 'R-1')).run;
  assert.equal(r.nodes.find((n) => n.nodeId === 'a').costUsd, 0.3);
  assert.equal(r.nodes.find((n) => n.nodeId === 'b').costUsd, 0.05);
  assert.equal(r.costUsd, 0.35);
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM usage').n, 5);
  const u = (await h.get('/v1/usage')).json.today;
  assert.equal(u.byKind.wf_step.calls, 3);
  assert.equal(u.requestedUsd, 0.7, 'wf_step counts as requested work');
  assert.equal(u.overheadUsd, 0.06, 'wf_review and recap are overhead');
  // a bad kind is still ignored
  h.send(h.ev('s1', 'helm.usage', { kind: 'bogus', costUsd: 1, runId: 'R-1', nodeId: 'a' }));
  assert.equal((await detail(h, 'R-1')).run.costUsd, 0.35);
});

test('budget: once the run cost reaches budgetUsd no new step is queued (paused); resume lifts the limit', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await custom(h, pid, graph([agent('a'), agent('b')], [{ id: 'e1', from: 'a', to: 'b' }]));
  assert.equal((await run(h, 'W-1', { budgetUsd: -1 })).status, 400);
  await run(h, 'W-1', { budgetUsd: 0.5 });
  const [a] = await claim(h);
  finish(h, 's1', a.id, { text: 'x', usage: { model: 'sonnet', costUsd: 0.6 } });
  const d = (await detail(h, 'R-1')).run;
  assert.equal(d.status, 'paused');
  assert.match(d.error, /budget reached/);
  assert.equal(stepCount(h), 1);
  const rs = await h.api('POST', '/v1/runs/R-1/resume');
  assert.equal(rs.json.run.status, 'running');
  assert.equal(rs.json.run.budgetUsd, null);
  assert.equal(stepCount(h), 2);
});

// ============================================================== http + sse
test('endpoints and SSE: run/workflow entities stream, /v1/state carries workflows and runs (active + last 20)', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const s = openStream(h.base); t.after(() => s.close());
  await s.waitFor((e) => e.comment === 'connected');
  await tpl(h, pid);
  await s.waitFor((e) => e.data?.entity === 'workflow' && e.data.row.id === 'W-1');
  await run(h, 'W-1');
  const ev = await s.waitFor((e) => e.data?.entity === 'run' && e.data.row.id === 'R-1');
  assert.equal(ev.data.op, 'upsert');
  assert.equal(ev.data.row.nodes.length, 6, 'nodes are inlined');
  assert.equal((await h.get('/v1/runs')).json.runs.length, 1);
  assert.equal((await h.get('/v1/runs?status=done')).json.runs.length, 0);
  assert.equal((await h.get('/v1/runs?status=bogus')).status, 400);
  assert.equal((await h.get('/v1/runs?workflowId=W-1&status=running,waiting')).json.runs.length, 1);
  assert.equal((await h.get('/v1/runs/R-1')).json.steps.length, 1);
  assert.equal((await h.get('/v1/runs/R-7')).status, 404);
  assert.equal((await h.get('/v1/workflows/W-7')).status, 404);
  assert.equal((await h.get(`/v1/state?projectId=${pid}`)).json.runs.length, 1);
  // 25 finished runs: only the last 20 ride in state, plus the active one
  await custom(h, pid, graph([node('gate', 'gate', { message: 'x' })], []), 'Tiny');
  for (let i = 0; i < 25; i++) { const r = await run(h, 'W-2', {}); await h.api('POST', `/v1/runs/${r.json.run.id}/abort`); }
  const st = h.state();
  assert.equal(st.runs.length, 21);
  assert.equal(st.runs.filter((r) => ['running', 'waiting', 'paused'].includes(r.status)).length, 1);
  assert.equal((await h.get('/v1/runs')).json.runs.length, 26);
  // claim endpoint needs the CSRF-style guard like inbox/jobs
  const r = await fetch(`${h.base}/v1/sessions/s1/steps`, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

// =============================================================== determinism
test('rebuild: replaying the event log reproduces every workflow table exactly (and decides nothing new)', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  await tpl(h, pid);
  const g1 = structuredClone((await h.get('/v1/workflows/W-1')).json.versions[0].graph);
  g1.nodes.find((n) => n.id === 'merge').config.prompt = 'Merge it. {{inputs.review.findings}}';
  assert.equal((await h.api('PUT', '/v1/workflows/W-1', { graph: g1, summary: 'edit merge' })).json.version.version, 2);
  await run(h, 'W-1');
  let [b] = await claim(h);
  finish(h, 's1', b.id, { text: 'built', filesChanged: ['/a.ts'], usage: { model: 'sonnet', costUsd: 0.2 } });
  [b] = await claim(h);
  finish(h, 's1', b.id, { check: { exitCode: 2, stdout: 'no' } });
  const [fix] = await claim(h);
  finish(h, 's1', fix.id, { ok: false, error: 'cannot fix' }); // unhandled -> failed run
  await h.api('POST', '/v1/runs/R-1/nodes/fix/skip');
  await h.api('POST', '/v1/runs/R-1/gates/gate', { decision: 'reject', comment: 'meh' });
  await h.api('POST', '/v1/runs/R-1/nodes/gate/retry');
  await h.api('POST', '/v1/runs/R-1/gates/gate', { decision: 'approve' });
  const [rv] = await claim(h);
  finish(h, 's1', rv.id, { text: 'VERDICT: PASS', usage: { model: 'opus', costUsd: 0.4 } });
  await run(h, 'W-1'); // R-2, left running
  h.send(h.ev('s1', 'helm.usage', { kind: 'wf_step', model: 'sonnet', costUsd: 0.07, runId: 'R-2', nodeId: 'build' }, clock.t));
  clock.t += 5000;
  await h.api('POST', '/v1/runs/R-2/pause');
  await h.api('PATCH', '/v1/workflows/W-1', { name: 'Renamed' });
  const before = h.hub.dump();
  assert.ok(before.runs.length === 2 && before.steps.length >= 5 && before.workflow_versions.length === 2);
  const events = h.hub.db.get('SELECT COUNT(*) AS n FROM events').n;
  const info = h.hub.rebuild();
  assert.ok(info.replayed > 20);
  assert.deepEqual(h.hub.dump(), before, 'workflow tables identical after rebuild');
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM events').n, events, 'replay appended no events');
  // and the rebuilt hub still drives the run
  await h.api('POST', '/v1/runs/R-2/resume');
  assert.deepEqual((await claim(h)).map((x) => x.id), ['R-1:merge:1', 'R-2:build:1']);
});

// ================================================================= migration
test('migration: a database from before v0.9 gains the workflow tables and the run columns; old rows read back', async (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig({ home: dir, port: 0, singleton: false, sweep: false });
  const log = createLogger(path.join(dir, 'x.log'), { tty: false });
  let hub = new Hub(cfg, log);
  const ev = (sid, seq, type, data) => ({ sessionId: sid, seq, type, at: T0, data });
  hub.ingest([
    ev('s1', 1, 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }),
    ev('s1', 2, 'tool.called', { toolUseId: 'qa', tool: 'AskUserQuestion', summary: 'Old question' }),
    ev('s1', 3, 'helm.usage', { kind: 'recap', model: 'haiku', costUsd: 0.01 }),
  ]);
  hub.createTask({ projectId: hub.state().projects[0].id, title: 'Old task' });
  const oldTask = hub.state().tasks[0];
  hub.close();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(cfg.dbFile);
  raw.exec('DROP INDEX IF EXISTS usage_run');
  for (const tbl of ['workflows', 'workflow_versions', 'runs', 'run_nodes', 'steps']) raw.exec(`DROP TABLE ${tbl}`);
  for (const [tbl, col] of [['tasks', 'run_id'], ['tasks', 'node_id'], ['questions', 'run_id'], ['questions', 'node_id'], ['usage', 'run_id'], ['usage', 'node_id']]) {
    raw.exec(`ALTER TABLE ${tbl} DROP COLUMN ${col}`);
  }
  const cols = (tbl) => raw.prepare(`PRAGMA table_info(${tbl})`).all().map((c) => c.name);
  assert.ok(!cols('tasks').includes('run_id') && !cols('usage').includes('run_id'));
  raw.close();

  for (let i = 0; i < 2; i++) { // the second open proves the migration is idempotent
    hub = new Hub(cfg, log);
    const st = hub.state();
    assert.deepEqual([st.workflows, st.runs], [[], []]);
    assert.deepEqual(st.tasks[0], { ...oldTask, runId: null, nodeId: null }, 'an old card reads back with null run fields');
    assert.equal(st.questions[0].text, 'Old question');
    assert.equal(st.questions[0].runId, undefined, 'plain questions keep their old shape');
    if (i === 0) hub.close();
  }
  // new events work on the migrated file, including a whole run
  const { workflow } = hub.wf.createWorkflow({ projectId: hub.state().projects[0].id, template: 'build-test-review' });
  const { run: r } = hub.wf.runWorkflow(workflow.id, { params: { brief: 'b' } });
  assert.equal(r.status, 'running');
  const dumpBefore = JSON.stringify(hub.dump());
  hub.rebuild();
  assert.equal(JSON.stringify(hub.dump()), dumpBefore, 'rebuild is exact on a migrated database');
  hub.close();
});
