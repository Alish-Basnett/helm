import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, sockRequest, rawRequest, tmpDir } from './helpers.mjs';
import { toFtsQuery } from '../search.mjs';

async function twoSessions(h) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/alpha', title: 'Alpha', model: 'opus' }));
  h.send(h.ev('s2', 'session.started', { cwd: '/w/beta', title: 'Beta', model: 'sonnet' }));
}

test('health over TCP and the unix socket answer the same router', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const a = await h.get('/v1/health');
  assert.equal(a.status, 200);
  assert.equal(a.json.ok, true);
  assert.equal(a.json.pid, process.pid);
  assert.ok(a.json.startedAt > 0 && a.json.version);
  const b = await sockRequest(h.cfg.sockFile, 'GET', '/v1/health');
  assert.equal(b.status, 200);
  assert.equal(b.json.startedAt, a.json.startedAt);
  const ev = h.ev('s1', 'session.started', { cwd: '/w/alpha', title: 'Alpha', model: 'opus' });
  const posted = await sockRequest(h.cfg.sockFile, 'POST', '/v1/events', { events: [ev] });
  assert.equal(posted.json.accepted, 1);
  assert.equal((await h.get('/v1/state')).json.sessions.length, 1);
  assert.equal((fs.statSync(h.cfg.sockFile).mode & 0o777), 0o600);
});

test('POST /v1/sessions/:id/join moves the session and its tasks', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await twoSessions(h);
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'u1', subagentType: 'b', model: 'sonnet', description: 'Session-owned work', prompt: '' }));
  const manual = await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'Unowned backlog task' });
  assert.equal(h.state().projects.length, 2);
  const j = await h.api('POST', '/v1/sessions/s1/join', { projectId: 'P-2' });
  assert.equal(j.status, 200);
  assert.equal(j.json.session.projectId, 'P-2');
  const st = h.state();
  assert.equal(st.tasks.find((x) => x.title === 'Session-owned work').projectId, 'P-2', 'session task moved');
  assert.equal(st.tasks.find((x) => x.id === manual.json.task.id).projectId, 'P-1', 'unowned task stays');
  assert.equal(st.projects.length, 2, 'P-1 still has a task, so it is kept');
  assert.equal((await h.api('POST', '/v1/sessions/nope/join', { projectId: 'P-2' })).status, 404);
  assert.equal((await h.api('POST', '/v1/sessions/s1/join', { projectId: 'P-9' })).status, 404);
  // a restart of the session does not undo the join
  h.send(h.ev('s1', 'session.started', { cwd: '/w/alpha', title: 'Alpha', model: 'opus' }));
  assert.equal(h.state().sessions.find((s) => s.id === 's1').projectId, 'P-2');
});

test('joining away from an auto-created project leaves no empty shell behind', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await twoSessions(h);
  await h.api('POST', '/v1/sessions/s2/join', { projectId: 'P-1' });
  assert.deepEqual(h.state().projects.map((p) => p.id), ['P-1']);
  const st = await h.api('POST', '/v1/projects', { name: 'Manual' });
  assert.equal(st.json.project.id, 'P-3');
  await h.api('POST', '/v1/sessions/s2/join', { projectId: 'P-3' });
  assert.equal(h.state().projects.length, 2, 'P-1 still has s1');
});

test('project and task CRUD with validation', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const p = await h.api('POST', '/v1/projects', { name: '  Roadmap  ' });
  assert.equal(p.status, 201);
  assert.equal(p.json.project.name, 'Roadmap');
  assert.equal((await h.api('POST', '/v1/projects', { name: '' })).status, 400);
  const up = await h.api('PATCH', '/v1/projects/P-1', { name: 'Renamed', archived: true });
  assert.deepEqual([up.json.project.name, up.json.project.archived], ['Renamed', true]);
  assert.equal((await h.api('PATCH', '/v1/projects/P-9', { name: 'x' })).status, 404);

  const t1 = await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'First', description: 'Do it', status: 'next' });
  const t2 = await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'Second', dependsOn: ['T-1'] });
  assert.equal(t1.json.task.status, 'next');
  assert.equal(t2.json.task.status, 'backlog');
  assert.deepEqual(t2.json.task.dependsOn, ['T-1']);
  assert.equal((await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'x', status: 'wat' })).status, 400);
  assert.equal((await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'x', dependsOn: ['T-77'] })).status, 400);
  assert.equal((await h.api('POST', '/v1/tasks', { projectId: 'P-8', title: 'x' })).status, 404);
  assert.equal((await h.api('POST', '/v1/tasks', { projectId: 'P-1' })).status, 400);

  const moved = await h.api('PATCH', '/v1/tasks/T-2', { status: 'done', order: 2.5 });
  assert.equal(moved.json.task.status, 'done');
  assert.equal(moved.json.task.order, 2.5);
  assert.ok(moved.json.task.doneAt);
  const back = await h.api('PATCH', '/v1/tasks/T-2', { status: 'backlog' });
  assert.equal(back.json.task.doneAt, null);
  assert.equal((await h.api('PATCH', '/v1/tasks/T-2', { dependsOn: ['T-1'] })).status, 200);
  assert.equal((await h.api('PATCH', '/v1/tasks/T-1', { dependsOn: ['T-2'] })).status, 400, 'cycle rejected');
  assert.equal((await h.api('PATCH', '/v1/tasks/T-1', { dependsOn: ['T-1'] })).status, 400);
  assert.equal((await h.api('PATCH', '/v1/tasks/T-1', { title: '' })).status, 400);
  assert.equal((await h.api('PATCH', '/v1/tasks/T-1', { order: 'high' })).status, 400);
  assert.equal((await h.api('PATCH', '/v1/tasks/T-99', { title: 'x' })).status, 404);
  const detail = await h.get('/v1/tasks/T-1');
  assert.equal(detail.json.task.title, 'First');
  assert.equal(detail.json.agent, null);
  assert.equal((await h.get('/v1/tasks/T-99')).status, 404);
  // state filtering
  assert.equal((await h.get('/v1/state?projectId=P-1')).json.tasks.length, 2);
  assert.equal((await h.get('/v1/state?projectId=P-5')).status, 404);
});

test('search: prefix match, <mark> snippets, project/session/task ids', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/ledger', title: 'Ledger rewrite', model: 'opus' }));
  await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'Add JWT refresh rotation', description: 'Rotate tokens on every use' });
  h.send(h.ev('s1', 'tool.called', { tool: 'Bash', toolUseId: 'b', summary: 'Bash: npm test -- jwt' }));
  h.send(h.ev('s1', 'recap.generated', { taskId: 'T-1', what: 'Rotation done', how: 'Added family ids', learned: 'Grace windows matter', concepts: ['auth'] }));
  await h.api('POST', '/v1/notes', { target: { kind: 'task', id: 'T-1' }, text: 'Remember the grace window' });

  const r = await h.get('/v1/search?q=rota');
  assert.equal(r.status, 200);
  const kinds = new Set(r.json.results.map((x) => x.kind));
  assert.ok(kinds.has('task'), 'prefix "rota" finds the task');
  assert.ok(kinds.has('recap'));
  const task = r.json.results.find((x) => x.kind === 'task');
  assert.equal(task.id, 'T-1');
  assert.equal(task.title, 'Add JWT refresh rotation');
  assert.match(task.snippet, /<mark>[Rr]otat\w*<\/mark>/);
  assert.equal(task.projectId, 'P-1');
  assert.equal(task.taskId, 'T-1');

  const jwt = (await h.get('/v1/search?q=jwt')).json.results;
  assert.ok(jwt.some((x) => x.kind === 'activity' && x.sessionId === 's1'));
  assert.ok(jwt.every((x) => /<mark>/.test(x.snippet)));
  assert.ok((await h.get('/v1/search?q=ledg')).json.results.some((x) => x.kind === 'session' && x.id === 's1'));
  assert.ok((await h.get('/v1/search?q=ledg')).json.results.some((x) => x.kind === 'project' && x.id === 'P-1'));
  assert.ok((await h.get('/v1/search?q=grace')).json.results.some((x) => x.kind === 'note'));
  assert.deepEqual((await h.get('/v1/search?q=')).json.results, []);
  assert.equal((await h.get('/v1/search?q=jwt&limit=1')).json.results.length, 1);
  // multi-word AND with a prefix on the last word
  assert.ok((await h.get('/v1/search?q=add%20jwt%20refr')).json.results.some((x) => x.id === 'T-1'));
  // deletes keep the index in sync
  await h.api('DELETE', '/v1/notes/N-1');
  assert.ok(!(await h.get('/v1/search?q=grace')).json.results.some((x) => x.kind === 'note'));
});

test('search output is HTML-safe and hostile queries never 500', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }));
  await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: '<img src=x onerror=alert(1)> payload' });
  const r = (await h.get('/v1/search?q=payload')).json.results[0];
  assert.ok(!r.snippet.includes('<img'));
  assert.ok(r.snippet.includes('&lt;img'));
  assert.match(r.snippet, /<mark>payload<\/mark>/);

  const hostile = ['"', '""', '*', '**', 'AND', 'OR NOT', 'NEAR(', 'NEAR(a b, 2)', 'a:b', 'title:payload', '(((', ')))', '-', '--', '^foo',
    'foo*bar"', '"unclosed', "'; DROP TABLE tasks;--", '\\', '%', 'a OR', '{title}: x', 'col:', '+ -', '😀', 'émoji ünï', 'x'.repeat(5000),
    Array.from({ length: 200 }, (_, i) => 'w' + i).join(' '), '\u0000', '\u0001payload\u0002'];
  for (const q of hostile) {
    const res = await h.get('/v1/search?q=' + encodeURIComponent(q));
    assert.equal(res.status, 200, `query ${JSON.stringify(q).slice(0, 40)} -> ${res.status}`);
    assert.ok(Array.isArray(res.json.results));
  }
  assert.equal((await h.get('/v1/search?q=%FF%FE')).status, 200);
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM tasks').n, 1);
  assert.equal(toFtsQuery('NEAR(a b)'), '"NEAR"* "a"* "b"*');
  assert.equal(toFtsQuery('  '), '');
});

test('static files, SPA fallback, content types and traversal protection', async (t) => {
  const web = tmpDir('helm-web-');
  fs.mkdirSync(path.join(web, 'js'));
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Helm</title><div id=app></div>');
  fs.writeFileSync(path.join(web, 'js', 'app.js'), 'export const x = 1;');
  fs.writeFileSync(path.join(web, 'style.css'), 'body{}');
  const secret = path.join(tmpDir('helm-secret-'), 'secret.txt');
  fs.writeFileSync(secret, 'TOP-SECRET');
  fs.symlinkSync(secret, path.join(web, 'leak.txt'));
  const h = await startTest({ webRoot: web }); t.after(async () => { await h.stop(); fs.rmSync(web, { recursive: true, force: true }); });

  const root = await h.api('GET', '/');
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /text\/html/);
  assert.match(root.text, /id=app/);
  const js = await h.api('GET', '/js/app.js');
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match((await h.api('GET', '/style.css')).headers.get('content-type'), /text\/css/);
  const spa = await h.api('GET', '/some/client/route');
  assert.equal(spa.status, 200);
  assert.match(spa.text, /id=app/);
  assert.equal((await h.api('GET', '/missing.js')).status, 404);
  assert.equal((await h.api('GET', '/v1/nope')).status, 404);

  for (const p of ['/../../../../etc/passwd', '/..%2f..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/js/../../../etc/hosts', '/leak.txt', '/%00', '/..\\..\\etc\\passwd']) {
    const r = await rawRequest(h.port, { path: p });
    assert.ok(!/root:|TOP-SECRET|localhost/.test(r.text.replace(/<[^>]*>/g, '')) || r.text.includes('id=app'), `leak via ${p}`);
    assert.ok(r.status === 404 || r.status === 400 || (r.status === 200 && r.text.includes('id=app')), `${p} -> ${r.status}`);
  }
  assert.equal((await rawRequest(h.port, { path: '/leak.txt' })).status, 404, 'symlink escaping the web root is refused');
  assert.equal((await rawRequest(h.port, { path: '/', method: 'POST' })).status, 405);
  const head = await rawRequest(h.port, { path: '/js/app.js', method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});

test('request hygiene: body limit, bad JSON, wrong method, never crashes', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const big = JSON.stringify({ events: [], pad: 'x'.repeat(1.2 * 1024 * 1024) });
  let status;
  try {
    status = (await rawRequest(h.port, { method: 'POST', path: '/v1/events', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(big) }, body: big })).status;
  } catch (e) { status = e.code; }
  assert.ok(status === 413 || status === 'EPIPE' || status === 'ECONNRESET', `got ${status}`);
  const bad = await rawRequest(h.port, { method: 'POST', path: '/v1/events', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).error, /JSON/);
  assert.equal((await rawRequest(h.port, { method: 'POST', path: '/v1/events', body: '[1,2]' })).status, 400);
  assert.equal((await h.api('DELETE', '/v1/state')).status, 405);
  assert.equal((await h.api('GET', '/v1/sessions/x/nope')).status, 404);
  assert.equal((await h.api('GET', '/v1/tasks/%E0%A4%A')).status, 404);
  assert.equal((await h.get('/v1/health')).status, 200, 'server survived');
  // just under the limit is accepted
  const ok = JSON.stringify({ events: [{ sessionId: 's', seq: 1, type: 'session.heartbeat', at: 1, data: { pad: 'y'.repeat(900 * 1024) } }] });
  assert.equal((await rawRequest(h.port, { method: 'POST', path: '/v1/events', headers: { 'content-type': 'application/json' }, body: ok })).status, 200);
});

test('browser guard: foreign Host/Origin cannot drive the hub; localhost CORS for GET', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const post = (headers) => rawRequest(h.port, { method: 'POST', path: '/v1/projects', headers: { 'content-type': 'application/json', ...headers }, body: '{"name":"x"}' });
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ host: 'rebind.evil.example' })).status, 403);
  assert.equal((await rawRequest(h.port, { path: '/v1/health', headers: { host: 'rebind.evil.example' } })).status, 403);
  assert.equal((await rawRequest(h.port, { path: '/v1/sessions/s1/inbox', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM projects').n, 0);
  assert.equal((await post({ origin: `http://127.0.0.1:${h.port}` })).status, 201);
  const g = await rawRequest(h.port, { path: '/v1/health', headers: { origin: 'http://localhost:5173' } });
  assert.equal(g.headers['access-control-allow-origin'], 'http://localhost:5173');
  const o = await rawRequest(h.port, { method: 'OPTIONS', path: '/v1/state', headers: { origin: 'http://localhost:5173' } });
  assert.equal(o.status, 204);
  assert.match(o.headers['access-control-allow-methods'], /GET/);
  assert.ok(!/POST/.test(o.headers['access-control-allow-methods']));
  const f = await rawRequest(h.port, { path: '/v1/health', headers: { origin: 'https://evil.example' } });
  assert.equal(f.headers['access-control-allow-origin'], undefined);
});

test('activity endpoints: session feed (newest first, limit) and task detail', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }));
  for (let i = 0; i < 12; i++) h.send(h.ev('s1', 'tool.called', { tool: 'Read', toolUseId: 'u' + i, summary: 'Read file' + i }));
  const a = await h.get('/v1/sessions/s1/activity?limit=5');
  assert.equal(a.json.activity.length, 5);
  assert.equal(a.json.activity[0].summary, 'Read file11');
  assert.deepEqual(Object.keys(a.json.activity[0]).sort(), ['agentId', 'at', 'id', 'kind', 'ok', 'sessionId', 'summary', 'taskId', 'tool']);
  assert.equal((await h.get('/v1/sessions/s1/activity')).json.activity.length, 12);
  assert.equal((await h.get('/v1/sessions/zzz/activity')).status, 404);
});
