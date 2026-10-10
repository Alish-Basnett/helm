// v0.10: workflows by prompt (wf_draft jobs), templates, and rebuild determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';
import { validateGraph, TEMPLATES, SCHEMA, listTemplates, extractJson, layoutGraph } from '../wfgraph.mjs';

const T0 = 1_800_000_000_000;
async function setup() {
  const h = await startTest();
  const clock = { t: T0 };
  h.hub.setClock(() => clock.t);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }, clock.t));
  return { h, clock, pid: h.state().projects[0].id };
}
const good = (name = 'Drafted') => ({
  name,
  nodes: [
    { id: 'a', type: 'agent', label: 'Build', config: { agent: 'builder', prompt: 'do it' } },
    { id: 'b', type: 'shell', label: 'Test', config: { argv: ['npm', 'test'] } },
    { id: 'c', type: 'gate', label: 'OK?', config: { message: 'merge?' } },
  ],
  edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
});
const claimJobs = async (h) => (await h.get('/v1/sessions/s1/jobs')).json.jobs;
const answer = (h, job, text, extra = {}) => h.send(h.ev('s1', 'job.result', { jobId: job.id, ok: true, text, ...extra }));
const jobOf = async (h, id) => h.hub.state().jobs.find((j) => j.id === id);

test('draft: creates a wf_draft job with the full input; 409 without a session; validates the body', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  assert.equal((await h.api('POST', '/v1/workflows/draft', { projectId: pid, prompt: '  ' })).status, 400);
  assert.equal((await h.api('POST', '/v1/workflows/draft', { projectId: 'P-99', prompt: 'x' })).status, 404);
  assert.equal((await h.api('POST', '/v1/workflows/draft', { projectId: pid, prompt: 'x', workflowId: 'W-9' })).status, 404);
  const r = await h.api('POST', '/v1/workflows/draft', { projectId: pid, prompt: 'Build, test, ask me before merge' });
  assert.equal(r.status, 200, r.text);
  const [job] = await claimJobs(h);
  assert.equal(job.kind, 'wf_draft');
  assert.equal(job.id, r.json.job.id);
  const i = job.input;
  assert.equal(i.prompt, 'Build, test, ask me before merge');
  assert.match(i.schema, /helm\.workflow\/1/);
  assert.deepEqual(i.nodeTypes.map((n) => n.type), ['agent', 'shell', 'gate', 'review', 'note']);
  assert.equal(i.examples.length, 2);
  assert.ok(i.examples.every((g) => validateGraph(g).ok));
  assert.equal(i.current, undefined);
  assert.equal(i.attempt, 1);
  h.send(h.ev('s1', 'session.ended', {}));
  assert.equal((await h.api('POST', '/v1/workflows/draft', { projectId: pid, prompt: 'x' })).status, 409);
});

test('draft: a valid reply (fenced, with prose, no positions) creates a model workflow and links it in Job.result', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const { json } = await h.api('POST', '/v1/workflows/draft', { projectId: pid, prompt: 'Build a feature, run tests, ask me before merging' });
  const [job] = await claimJobs(h);
  answer(h, job, 'Here you go:\n```json\n' + JSON.stringify(good('My flow')) + '\n```\nEnjoy.');
  const j = await jobOf(h, json.job.id);
  assert.equal(j.state, 'done');
  const link = JSON.parse(j.result);
  assert.deepEqual(link, { workflowId: 'W-1', version: 1 });
  const d = (await h.get('/v1/workflows/W-1')).json;
  assert.equal(d.workflow.name, 'My flow');
  assert.equal(d.versions[0].author, 'model');
  assert.match(d.versions[0].summary, /^Build a feature/);
  const g = d.versions[0].graph;
  assert.equal(g.schema, SCHEMA);
  const xs = g.nodes.map((n) => n.position.x);
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2], 'laid out left to right');
  assert.ok(h.hub.db.get(`SELECT 1 AS x FROM events WHERE type = 'wf.created'`));
  assert.ok(h.hub.db.get(`SELECT 1 AS x FROM events WHERE type = 'hub.job.finish'`));
});

test('draft: an invalid reply triggers exactly one fix-up job, then fails clearly with the issues', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const { json } = await h.api('POST', '/v1/workflows/draft', { projectId: pid, prompt: 'Make something' });
  const [j1] = await claimJobs(h);
  const bad = good(); bad.nodes[1].type = 'teleport';
  answer(h, j1, JSON.stringify(bad));
  const first = await jobOf(h, json.job.id);
  assert.equal(first.state, 'done');
  const { retryJobId, issues } = JSON.parse(first.result);
  assert.ok(issues.length && issues[0].code === 'node-type');
  const [j2] = await claimJobs(h);
  assert.equal(j2.id, retryJobId);
  assert.equal(j2.input.attempt, 2);
  assert.ok(j2.input.fixIssues.some((i) => /teleport/.test(i.message)));
  assert.ok(j2.input.previousText.includes('teleport'));
  answer(h, j2, 'sorry, no JSON here');
  const second = await jobOf(h, retryJobId);
  assert.equal(second.state, 'failed');
  assert.match(second.error, /invalid after a retry/);
  assert.ok(JSON.parse(second.result).issues.length);
  assert.equal((await claimJobs(h)).length, 0, 'no third attempt');
  assert.equal((await h.get('/v1/workflows')).json.workflows.length, 0);
});

test('draft: a fix-up reply that is valid creates the workflow', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await h.api('POST', '/v1/workflows/draft', { projectId: pid, prompt: 'p' });
  const [j1] = await claimJobs(h);
  answer(h, j1, '{ "nope": true }');
  const [j2] = await claimJobs(h);
  answer(h, j2, JSON.stringify(good()));
  assert.deepEqual(JSON.parse((await jobOf(h, j2.id)).result), { workflowId: 'W-1', version: 1 });
});

test('draft: modify mode passes `current` and saves a new model version (unchanged graph adds none)', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const w = (await h.api('POST', '/v1/workflows', { projectId: pid, template: 'research-build' })).json.workflow;
  assert.equal((await h.api('POST', '/v1/workflows/draft', { projectId: pid, workflowId: w.id, prompt: 'x' })).status, 200);
  const [job] = await claimJobs(h);
  assert.equal(job.input.workflowId, w.id);
  assert.equal(job.input.current.name, 'Research, then build');
  const g = structuredClone(job.input.current);
  g.name = 'Ignored rename';
  g.nodes.push({ id: 'lint', type: 'shell', label: 'Lint', position: { x: 1040, y: 160 }, config: { argv: ['npm', 'run', 'lint'] } });
  g.edges.push({ id: 'e9', from: 'build', to: 'lint', when: 'ok' });
  answer(h, job, JSON.stringify(g));
  assert.deepEqual(JSON.parse((await jobOf(h, job.id)).result), { workflowId: w.id, version: 2 });
  const d = (await h.get(`/v1/workflows/${w.id}`)).json;
  assert.equal(d.workflow.name, 'Research, then build');
  assert.equal(d.versions[0].author, 'model');
  assert.equal(d.versions[0].parentVersion, 1);
  // same graph again: no new version
  await h.api('POST', '/v1/workflows/draft', { projectId: pid, workflowId: w.id, prompt: 'nothing' });
  const [job2] = await claimJobs(h);
  answer(h, job2, JSON.stringify(job2.input.current));
  const r2 = JSON.parse((await jobOf(h, job2.id)).result);
  assert.equal(r2.version, 2);
  assert.equal(r2.unchanged, true);
});

test('draft: a mod error fails the job without a retry', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await h.api('POST', '/v1/workflows/draft', { projectId: pid, prompt: 'p' });
  const [job] = await claimJobs(h);
  h.send(h.ev('s1', 'job.result', { jobId: job.id, ok: false, error: 'model unavailable' }));
  assert.equal((await jobOf(h, job.id)).state, 'failed');
  assert.equal((await claimJobs(h)).length, 0);
});

test('templates: all five are valid, listed with title/description/icon, and creatable', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const list = (await h.get('/v1/workflows/templates')).json.templates;
  assert.deepEqual(list.map((x) => x.id), ['build-test-review', 'fix-bug', 'research-build', 'parallel-refactor', 'safe-migration']);
  for (const x of list) {
    assert.ok(x.title && x.description && x.icon, x.id);
    const r = validateGraph(x.graph);
    assert.ok(r.ok, `${x.id}: ${r.issues.map((i) => i.message)}`);
    assert.deepEqual(r.issues.filter((i) => i.level === 'warn'), [], x.id);
    const c = await h.api('POST', '/v1/workflows', { projectId: pid, template: x.id });
    assert.equal(c.status, 201, c.text);
  }
  assert.match(list.find((x) => x.id === 'parallel-refactor').description, /after another/);
  assert.equal(listTemplates().length, Object.keys(TEMPLATES).length);
});

test('helpers: extractJson and layoutGraph', () => {
  assert.deepEqual(extractJson('x {"nodes": [], "a": "}"} y').value, { nodes: [], a: '}' });
  assert.ok(extractJson('no json').error);
  const g = layoutGraph({ nodes: [{ id: 'a', type: 'agent' }, { id: 'b', type: 'agent' }, { id: 'c', type: 'agent' }, { id: 'n', type: 'note' }], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] });
  assert.equal(g.nodes[1].position.x, g.nodes[2].position.x);
  assert.notEqual(g.nodes[1].position.y, g.nodes[2].position.y);
  assert.ok(g.nodes[3].position.y > g.nodes[2].position.y);
});

test('rebuild: draft jobs, retries and created workflows replay exactly', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  await h.api('POST', '/v1/workflows/draft', { projectId: pid, prompt: 'one' });
  let [job] = await claimJobs(h);
  answer(h, job, '{"nodes": 3}');            // invalid -> retry job
  [job] = await claimJobs(h);
  answer(h, job, JSON.stringify(good()));     // W-1
  await h.api('POST', '/v1/workflows/draft', { projectId: pid, prompt: 'two', workflowId: 'W-1' });
  [job] = await claimJobs(h);
  const g = structuredClone(job.input.current); g.nodes[0].label = 'Renamed';
  answer(h, job, JSON.stringify(g));          // W-1 v2
  const before = h.hub.dump();
  assert.equal(before.workflow_versions.length, 2);
  const events = h.hub.db.get('SELECT COUNT(*) AS n FROM events').n;
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM events').n, events);
});
