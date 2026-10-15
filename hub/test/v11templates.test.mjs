// v0.11: task templates (CRUD, capture from a task, use with vars/checks/agent, start + 409, scope, usage, rebuild, migration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, tmpDir } from './helpers.mjs';
import { seed } from '../seed.mjs';
import { templateVars, fillVars, renderTemplate } from '../templates.mjs';

const T0 = 1_800_000_000_000;
async function setup({ session = true } = {}) {
  const h = await startTest();
  const clock = { t: T0 };
  h.hub.setClock(() => clock.t);
  if (session) h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }, clock.t));
  else h.hub.createProject({ name: 'proj' }, clock.t);
  return { h, clock, pid: h.state().projects[0].id };
}

test('pure helpers: templateVars, fillVars (missing falls back to the name), renderTemplate', () => {
  assert.deepEqual(templateVars('Fix {{area}} in {{ module }}', 'again {{area}}'), ['area', 'module']);
  assert.equal(fillVars('Fix {{area}} / {{other}}', { area: ' auth ' }), 'Fix auth / other');
  assert.equal(fillVars('{{a}}', { a: '   ' }), 'a');
  const r = renderTemplate({ name: 'n', title: 'T {{x}}', description: 'D', checks: ['c1'], agent: 'scout' }, { x: '1' });
  assert.deepEqual(r, { title: 'T 1', description: 'D\n\nChecks:\n- c1\n\nPreferred agent: helm:scout' });
  assert.equal(renderTemplate({ name: 'n', title: 't', description: '', checks: [], agent: 'auto' }, {}).description, '');
});

test('CRUD: create validates, patch edits, DELETE archives, GET hides archived; FTS and SSE entity', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const seen = [];
  h.hub.subscribe((rows) => seen.push(...rows.filter((r) => r.entity === 'template')));
  assert.equal((await h.api('POST', '/v1/templates', { title: 'x' })).status, 400);
  assert.equal((await h.api('POST', '/v1/templates', { name: 'x' })).status, 400);
  assert.equal((await h.api('POST', '/v1/templates', { name: 'x', title: 'y', agent: 'wizard' })).status, 400);
  assert.equal((await h.api('POST', '/v1/templates', { name: 'x', title: 'y', checks: 'no' })).status, 400);
  assert.equal((await h.api('POST', '/v1/templates', { name: 'x', title: 'y', projectId: 'P-99' })).status, 404);
  const r = await h.api('POST', '/v1/templates', {
    name: 'Release notes', title: 'Write release notes for {{version}}', description: 'Summarise merged work',
    agent: 'scout', checks: [' lint passes ', '', 'no console errors'], tags: ['Docs', 'docs', ' release '], projectId: pid,
  });
  assert.equal(r.status, 201, r.text);
  const tpl = r.json.template;
  assert.deepEqual(
    { id: tpl.id, projectId: tpl.projectId, agent: tpl.agent, checks: tpl.checks, tags: tpl.tags, usage: tpl.usage, lastUsedAt: tpl.lastUsedAt, archived: tpl.archived },
    { id: 'TT-1', projectId: pid, agent: 'scout', checks: ['lint passes', 'no console errors'], tags: ['docs', 'release'], usage: 0, lastUsedAt: null, archived: false });
  assert.equal(seen.at(-1).op, 'upsert');
  // defaults
  const d = (await h.api('POST', '/v1/templates', { name: 'Plain', title: 'Plain' })).json.template;
  assert.deepEqual([d.projectId, d.agent, d.checks, d.description], [null, 'auto', [], '']);
  // patch
  const p = await h.api('PATCH', `/v1/templates/${tpl.id}`, { name: 'Release notes v2', agent: 'builder', checks: ['one'], projectId: null });
  assert.equal(p.status, 200);
  assert.deepEqual([p.json.template.name, p.json.template.agent, p.json.template.checks, p.json.template.projectId], ['Release notes v2', 'builder', ['one'], null]);
  assert.equal((await h.api('PATCH', '/v1/templates/TT-99', { name: 'z' })).status, 404);
  assert.equal((await h.api('PATCH', `/v1/templates/${tpl.id}`, { archived: 'yes' })).status, 400);
  // FTS over names
  assert.ok(h.hub.search('release').some((x) => x.kind === 'template' && x.id === tpl.id));
  assert.ok(h.hub.search('Release notes v2').some((x) => x.kind === 'template'));
  // archive
  const del = await h.api('DELETE', `/v1/templates/${tpl.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.template.archived, true);
  assert.deepEqual((await h.get('/v1/templates')).json.templates.map((x) => x.id), [d.id]);
  assert.equal((await h.get('/v1/templates?includeArchived=1')).json.templates.length, 2);
  assert.ok(!h.hub.search('release').some((x) => x.kind === 'template'), 'archived templates leave search');
  assert.equal(seen.at(-1).op, 'upsert');
  assert.equal(JSON.parse(seen.at(-1).row).archived, true);
  assert.equal((await h.api('POST', `/v1/templates/${tpl.id}/use`, { projectId: pid })).status, 409, 'archived cannot be used');
  // /v1/state carries templates (archived included so the manager can restore)
  assert.equal(h.state().templates.length, 2);
  // un-archive
  assert.equal((await h.api('PATCH', `/v1/templates/${tpl.id}`, { archived: false })).json.template.archived, false);
  assert.ok(h.hub.search('release').some((x) => x.kind === 'template'));
});

test('capture from a task: title, description and the agent type of its last agent', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const tk = (await h.api('POST', '/v1/tasks', { projectId: pid, title: 'Audit deps', description: 'Look for outdated packages' })).json.task;
  assert.equal((await h.api('POST', '/v1/templates', { fromTaskId: 'T-99' })).status, 404);
  const none = (await h.api('POST', '/v1/templates', { fromTaskId: tk.id })).json.template;
  assert.deepEqual([none.name, none.title, none.description, none.agent, none.projectId], ['Audit deps', 'Audit deps', 'Look for outdated packages', 'auto', pid]);
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu', taskId: tk.id, subagentType: 'helm:scout', model: 'haiku', description: 'x', prompt: '' }, T0));
  const withAgent = (await h.api('POST', '/v1/templates', { fromTaskId: tk.id, name: 'Audit', checks: ['report written'], projectId: null })).json.template;
  assert.deepEqual([withAgent.name, withAgent.agent, withAgent.checks, withAgent.projectId], ['Audit', 'scout', ['report written'], null]);
  const over = (await h.api('POST', '/v1/templates', { fromTaskId: tk.id, agent: 'builder', title: 'Audit {{pkg}}' })).json.template;
  assert.deepEqual([over.agent, over.title], ['builder', 'Audit {{pkg}}']);
});

test('use: vars fill title and description, missing vars fall back to the name, checks and agent lines are appended', async (t) => {
  const { h, pid } = await setup({ session: false }); t.after(h.stop);
  const tpl = (await h.api('POST', '/v1/templates', {
    name: 'Fix', title: 'Fix a bug in {{area}}', description: 'Reproduce {{area}}. Symptom: {{symptom}}',
    agent: 'builder', checks: ['npm test passes', 'no console errors in {{area}}'],
  })).json.template;
  const r = await h.api('POST', `/v1/templates/${tpl.id}/use`, { projectId: pid, vars: { area: 'login' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.task.title, 'Fix a bug in login');
  assert.equal(r.json.task.status, 'backlog');
  assert.equal(r.json.task.description,
    'Reproduce login. Symptom: symptom\n\nChecks:\n- npm test passes\n- no console errors in login\n\nPreferred agent: helm:builder');
  assert.equal(r.json.note, undefined);
  // auto agent: no preferred-agent line; no checks: no Checks block
  const auto = (await h.api('POST', '/v1/templates', { name: 'A', title: 'Plain job', description: 'Do it' })).json.template;
  assert.equal((await h.api('POST', `/v1/templates/${auto.id}/use`, { projectId: pid })).json.task.description, 'Do it');
  // validation
  assert.equal((await h.api('POST', `/v1/templates/${tpl.id}/use`, {})).status, 404, 'a global template needs a projectId');
  assert.equal((await h.api('POST', `/v1/templates/${tpl.id}/use`, { projectId: 'P-99' })).status, 404);
  assert.equal((await h.api('POST', `/v1/templates/${tpl.id}/use`, { projectId: pid, vars: { a: 1 } })).status, 400);
  assert.equal((await h.api('POST', '/v1/templates/TT-99/use', { projectId: pid })).status, 404);
});

test('use with start: a queued start note carries the rendered brief; no live session holds the start for the project', async (t) => {
  const { h, pid } = await setup({ session: false }); t.after(h.stop);
  const tpl = (await h.api('POST', '/v1/templates', {
    name: 'Tests', title: 'Add tests for {{module}}', description: 'Cover it', agent: 'scout', checks: ['npm test passes'],
  })).json.template;
  const no = await h.api('POST', `/v1/templates/${tpl.id}/use`, { projectId: pid, vars: { module: 'db' }, start: true });
  assert.equal(no.status, 201, no.text);
  assert.equal(no.json.task.status, 'next');
  assert.deepEqual(no.json.note.target, { kind: 'project', id: pid }, 'held for the project');
  assert.equal(no.json.template.usage, 1);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }));
  const pid2 = h.state().projects.find((p) => p.name === 'proj').id;
  const ok = await h.api('POST', `/v1/templates/${tpl.id}/use`, { projectId: pid2, vars: { module: 'db' }, start: true });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.task.id, 'T-2');
  assert.equal(ok.json.task.status, 'next');
  assert.equal(ok.json.note.state, 'queued');
  assert.equal(ok.json.task.startNoteId, ok.json.note.id);
  assert.match(ok.json.note.text, /Start Helm task T-2 “Add tests for db”/);
  assert.match(ok.json.note.text, /Cover it\n\nChecks:\n- npm test passes\n\nPreferred agent: helm:scout/);
  assert.equal(ok.json.template.usage, 2);
});

test('scope: GET ?projectId= returns global plus that project; a project template cannot be used elsewhere', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const other = h.hub.createProject({ name: 'other' }).project.id;
  const g = (await h.api('POST', '/v1/templates', { name: 'Global', title: 'g' })).json.template;
  const a = (await h.api('POST', '/v1/templates', { name: 'Mine', title: 'a', projectId: pid })).json.template;
  const b = (await h.api('POST', '/v1/templates', { name: 'Theirs', title: 'b', projectId: other })).json.template;
  const ids = async (q) => (await h.get(`/v1/templates${q}`)).json.templates.map((x) => x.id);
  assert.deepEqual(await ids(''), [g.id, a.id, b.id]);
  assert.deepEqual(await ids(`?projectId=${pid}`), [g.id, a.id]);
  assert.deepEqual(await ids(`?projectId=${other}`), [g.id, b.id]);
  assert.equal((await h.get('/v1/templates?projectId=P-99')).status, 404);
  assert.deepEqual(h.hub.state(pid).templates.map((x) => x.id), [g.id, a.id]);
  assert.equal((await h.api('POST', `/v1/templates/${b.id}/use`, { projectId: pid })).status, 400);
  assert.equal((await h.api('POST', `/v1/templates/${a.id}/use`, {})).status, 201, 'a project template defaults to its own project');
  assert.equal((await h.api('POST', `/v1/templates/${g.id}/use`, { projectId: other })).status, 201);
});

test('usage counters: each use increments usage and sets lastUsedAt', async (t) => {
  const { h, clock, pid } = await setup(); t.after(h.stop);
  const tpl = (await h.api('POST', '/v1/templates', { name: 'U', title: 'u' })).json.template;
  clock.t += 1000;
  await h.api('POST', `/v1/templates/${tpl.id}/use`, { projectId: pid });
  clock.t += 5000;
  const r = await h.api('POST', `/v1/templates/${tpl.id}/use`, { projectId: pid });
  assert.deepEqual([r.json.template.usage, r.json.template.lastUsedAt], [2, T0 + 6000]);
  assert.equal(h.state().templates[0].usage, 2);
  // editing does not touch usage
  assert.equal((await h.api('PATCH', `/v1/templates/${tpl.id}`, { name: 'U2' })).json.template.usage, 2);
});

test('seed adds the three starter templates; rebuild replays templates, usage and archive exactly', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  seed(h.hub);
  assert.deepEqual(h.state().templates.map((x) => x.title),
    ['Fix a bug in {{area}}', 'Add tests for {{module}}', 'Polish UI of {{screen}}']);
  assert.ok(h.hub.search('Polish').some((x) => x.kind === 'template'));
  const pid1 = h.state().projects[0].id;
  await h.api('POST', '/v1/templates/TT-1/use', { projectId: pid1, vars: { area: 'auth' } });
  await h.api('POST', '/v1/templates/TT-1/use', { projectId: pid1, vars: { area: 'ui' }, start: true });
  await h.api('POST', '/v1/templates', { name: 'Custom', title: 'c', checks: ['x'], projectId: pid1 });
  await h.api('DELETE', '/v1/templates/TT-2');
  const before = h.hub.dump();
  const stateBefore = h.state();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
  assert.equal(h.state().templates.find((x) => x.id === 'TT-1').usage, 2);
  assert.ok(h.hub.search('Custom').some((x) => x.kind === 'template'));
  assert.ok(!h.hub.search('Add tests for').some((x) => x.kind === 'template'), 'archived stays out of FTS after replay');
  assert.equal((await h.api('POST', '/v1/templates', { name: 'After', title: 'a' })).json.template.id, 'TT-5');
  void pid;
});

test('opening a pre-v0.11 database adds the templates table and index; idempotent, data kept', async (t) => {
  const { Db } = await import('../db.mjs');
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'helm.db');
  let db = new Db(file);
  db.run(`INSERT INTO tasks(id, project_id, title, status, created_at, updated_at) VALUES ('T-1','P-1','keep me','done',1,2)`);
  db.exec('DROP TABLE templates');
  db.close();
  for (let i = 0; i < 2; i++) {
    db = new Db(file);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM templates').n, 0);
    assert.ok(db.all(`PRAGMA index_list(templates)`).some((x) => x.name === 'templates_project'));
    assert.equal(db.get('SELECT title FROM tasks').title, 'keep me');
    db.close();
  }
  const { Hub } = await import('../hub.mjs');
  const { loadConfig } = await import('../config.mjs');
  const hub = new Hub(loadConfig({ home: dir }), null);
  assert.deepEqual(hub.state().templates, []);
  const r = hub.createTemplate({ name: 'n', title: 't' });
  assert.equal(r.template.id, 'TT-1');
  hub.close();
});
