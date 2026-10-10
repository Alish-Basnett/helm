// v0.13: concepts built from recaps (slugs, aliases, merge, related, summary job, FTS, rebuild, migration back-fill).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTest, tmpDir } from './helpers.mjs';
import { seed } from '../seed.mjs';
import { slugify, conceptKey } from '../concepts.mjs';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
async function setup() {
  const h = await startTest();
  const clock = { t: T0 };
  h.hub.setClock(() => clock.t);
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }, clock.t));
  const pid = h.state().projects[0].id;
  let n = 0;
  /** A task with a recap carrying `concepts`, generated `daysAgo` days before T0. */
  const recap = (title, concepts, daysAgo = 0) => {
    const { task } = h.hub.createTask({ projectId: pid, title }, T0 - daysAgo * DAY);
    h.send(h.ev('s1', 'recap.generated', {
      taskId: task.id, what: `What ${title}`, how: `How ${title}`, learned: `Learned ${title}`, concepts,
    }, T0 - daysAgo * DAY + ++n));
    return task.id;
  };
  return { h, clock, pid, recap };
}

test('pure helpers: slugify and conceptKey (plural, js, sql-lite, c++)', () => {
  assert.equal(slugify('Node.js'), 'node-js');
  assert.equal(slugify('  C++ / C# '), 'c-plus-plus-c-sharp');
  assert.equal(slugify('???'), '');
  assert.equal(conceptKey('tests').key, conceptKey('Test').key);
  assert.equal(conceptKey('SQL-lite').key, conceptKey('sqlite').key);
  assert.equal(conceptKey('JS').key, conceptKey('javascript').key);
  assert.equal(conceptKey('JS').name, 'javascript');
  assert.equal(conceptKey('postgres').key, conceptKey('PostgreSQL').key);
  assert.equal(conceptKey('toString').name, null, 'no prototype lookups');
  assert.equal(conceptKey('css').key, 'css', 'ss is not a plural');
});

test('built from recaps: slug, count, first/last seen, tasks; plural, sql-lite and the built-in map merge variants', async (t) => {
  const { h, recap } = await setup(); t.after(h.stop);
  const t1 = recap('One', ['SQLite', 'Tests', 'JS'], 5);
  const t2 = recap('Two', ['sql-lite', 'test', 'javascript'], 2);
  const t3 = recap('Three', ['SQLite'], 0);
  const list = (await h.get('/v1/concepts?sort=name')).json.concepts;
  assert.deepEqual(list.map((c) => c.slug), ['javascript', 'sqlite', 'tests']);
  const sql = list.find((c) => c.slug === 'sqlite');
  assert.equal(sql.count, 3);
  assert.deepEqual(sql.taskIds, [t3, t2, t1], 'newest first');
  assert.ok(sql.firstSeenAt < sql.lastSeenAt);
  assert.deepEqual(sql.aliases, ['sql-lite']);
  assert.equal(sql.summary, null);
  assert.equal(sql.needsSummary, true, '3 tasks and no page');
  const js = list.find((c) => c.slug === 'javascript');
  assert.equal(js.name, 'javascript');
  assert.equal(js.needsSummary, false);
  assert.equal(list.find((c) => c.slug === 'tests').count, 2);
  // detail: tasks with what/how/learned/doneAt; an alias resolves
  const d = (await h.get('/v1/concepts/sql-lite')).json;
  assert.equal(d.concept.slug, 'sqlite');
  assert.deepEqual(d.tasks.map((x) => x.id), [t3, t2, t1]);
  for (const k of ['id', 'title', 'what', 'how', 'learned', 'doneAt']) assert.ok(k in d.tasks[0], k);
  assert.equal(d.tasks[0].learned, 'Learned Three');
  assert.equal((await h.get('/v1/concepts/nope')).status, 404);
  // query and sorts
  assert.deepEqual((await h.get('/v1/concepts?q=SQL%20LITE')).json.concepts.map((c) => c.slug), ['sqlite']);
  assert.equal((await h.get('/v1/concepts?sort=count')).json.concepts[0].slug, 'sqlite');
  assert.equal((await h.get('/v1/concepts?sort=weird')).status, 400);
  // state carries them without summaries
  assert.equal(h.state().concepts.length, 3);
  assert.ok(h.state().concepts.every((c) => c.summary === null));
  // a regenerated recap replaces the task's links
  h.send(h.ev('s1', 'recap.generated', { taskId: t1, what: 'w', how: 'h', learned: 'l', concepts: ['sqlite'] }, T0 + 99));
  const after = (await h.get('/v1/concepts')).json.concepts;
  assert.equal(after.find((c) => c.slug === 'sqlite').count, 3);
  assert.equal(after.find((c) => c.slug === 'javascript').count, 1, 'JS lost one task');
  assert.equal(after.find((c) => c.slug === 'tests').count, 1);
});

test('related: co-occurrence within a task, top 5, strongest first', async (t) => {
  const { h, recap } = await setup(); t.after(h.stop);
  recap('A', ['core', 'x1', 'x2'], 3);
  recap('B', ['core', 'x1', 'x3'], 2);
  recap('C', ['core', 'x1', 'x4', 'x5', 'x6'], 1);
  recap('D', ['solo'], 0);
  const core = (await h.get('/v1/concepts/core')).json.concept;
  assert.equal(core.related.length, 5);
  assert.equal(core.related[0], 'x1', 'seen together in 3 tasks');
  assert.deepEqual((await h.get('/v1/concepts/solo')).json.concept.related, []);
  assert.deepEqual((await h.get('/v1/concepts/x2')).json.concept.related, ['core', 'x1']);
});

test('PATCH: rename, pin, aliases (conflict is 409), validation; an alias catches later recaps', async (t) => {
  const { h, recap } = await setup(); t.after(h.stop);
  recap('A', ['react', 'hooks'], 1);
  const seen = [];
  h.hub.subscribe((rows) => seen.push(...rows.filter((r) => r.entity === 'concept')));
  const p = await h.api('PATCH', '/v1/concepts/react', { name: 'React', pinned: true, aliases: ['reactjs ', 'React JS', 'REACTJS'] });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.concept.name, 'React');
  assert.equal(p.json.concept.pinned, true);
  assert.deepEqual(p.json.concept.aliases, ['reactjs', 'react js']);
  assert.equal(seen.at(-1).op, 'upsert');
  assert.equal((await h.api('PATCH', '/v1/concepts/react', { aliases: ['hooks'] })).status, 409);
  assert.equal((await h.api('PATCH', '/v1/concepts/react', {})).status, 400);
  assert.equal((await h.api('PATCH', '/v1/concepts/react', { name: ' ' })).status, 400);
  assert.equal((await h.api('PATCH', '/v1/concepts/react', { pinned: 'yes' })).status, 400);
  assert.equal((await h.api('PATCH', '/v1/concepts/nope', { pinned: true })).status, 404);
  recap('B', ['React JS'], 0);
  assert.equal((await h.get('/v1/concepts/react')).json.concept.count, 2);
  assert.ok(h.hub.search('react js').some((r) => r.kind === 'concept' && r.id === 'react'));
});

test('merge: tasks and aliases move, the old name keeps resolving, new recaps follow, related is rewritten', async (t) => {
  const { h, recap } = await setup(); t.after(h.stop);
  const seen = [];
  h.hub.subscribe((rows) => seen.push(...rows.filter((r) => r.entity === 'concept')));
  const a = recap('A', ['auth', 'jwt'], 3);
  const b = recap('B', ['logins', 'session'], 2);
  recap('C', ['session', 'jwt'], 1);
  await h.api('PATCH', '/v1/concepts/auth', { pinned: true });
  assert.equal((await h.api('POST', '/v1/concepts/merge', { from: 'auth', into: 'auth' })).status, 400);
  assert.equal((await h.api('POST', '/v1/concepts/merge', { from: 'auth', into: 'nope' })).status, 404);
  assert.equal((await h.api('POST', '/v1/concepts/merge', { from: 'auth' })).status, 400);
  const m = await h.api('POST', '/v1/concepts/merge', { from: 'logins', into: 'auth' });
  assert.equal(m.status, 200, m.text);
  assert.equal(m.json.concept.slug, 'auth');
  assert.equal(m.json.concept.count, 2);
  assert.deepEqual(m.json.concept.taskIds.slice().sort(), [a, b].sort());
  assert.ok(m.json.concept.aliases.includes('logins'));
  assert.equal(m.json.concept.pinned, true);
  assert.ok(seen.some((r) => r.op === 'delete' && JSON.parse(r.row).slug === 'logins'));
  const list = (await h.get('/v1/concepts')).json.concepts;
  assert.ok(!list.some((c) => c.slug === 'logins'));
  assert.equal((await h.get('/v1/concepts/logins')).json.concept.slug, 'auth', 'old name resolves');
  assert.deepEqual(list.find((c) => c.slug === 'session').related.slice().sort(), ['auth', 'jwt']);
  assert.ok(!h.hub.search('logins').some((r) => r.kind === 'concept' && r.id === 'logins'));
  recap('D', ['Logins'], 0);
  assert.equal((await h.get('/v1/concepts/auth')).json.concept.count, 3);
});

test('summary job: input, one open job per concept, the result becomes Concept.summary, FTS, 409 without a live session', async (t) => {
  const { h, recap, clock } = await setup(); t.after(h.stop);
  recap('Alpha', ['caching'], 3); recap('Beta', ['caching', 'cdn'], 2); recap('Gamma', ['caching'], 1);
  assert.equal((await h.get('/v1/concepts/caching')).json.concept.needsSummary, true);
  const r = await h.api('POST', '/v1/concepts/caching/summarize');
  assert.equal(r.status, 200, r.text);
  const job = r.json.job;
  assert.equal(job.kind, 'concept_summary');
  assert.equal(job.sessionId, 's1');
  assert.equal(job.taskId, null);
  assert.deepEqual(Object.keys(job.input).sort(), ['concept', 'learnedLines', 'related']);
  assert.deepEqual(job.input.concept, { slug: 'caching', name: 'caching', aliases: [], count: 3 });
  assert.deepEqual(job.input.learnedLines.map((l) => l.title), ['Gamma', 'Beta', 'Alpha']);
  assert.deepEqual(Object.keys(job.input.learnedLines[0]).sort(), ['how', 'learned', 'taskId', 'title']);
  assert.equal(job.input.learnedLines[0].learned, 'Learned Gamma');
  assert.deepEqual(job.input.related, ['cdn']);
  assert.equal((await h.api('POST', '/v1/concepts/caching/summarize')).json.job.id, job.id, 'open job is reused');
  assert.ok(h.state().jobs.some((j) => j.id === job.id));
  assert.equal((await h.api('POST', '/v1/concepts/nope/summarize')).status, 404);
  const claimed = (await h.get('/v1/sessions/s1/jobs')).json.jobs;
  assert.deepEqual(claimed.map((j) => j.id), [job.id]);
  const md = '## What it is\nCaching keeps hot data close.\n\n## How you used it\nT-1 added it.\n\n## Pitfalls\nStale data.\n\n## Go deeper\nRead about TTLs.';
  h.send(h.ev('s1', 'job.result', { jobId: job.id, ok: true, text: md }, clock.t + 5));
  const d = (await h.get('/v1/concepts/caching')).json.concept;
  assert.equal(d.summary, md);
  assert.equal(d.summaryAt, clock.t + 5);
  assert.equal(d.needsSummary, false);
  assert.equal(d.hasSummary, true);
  assert.equal(h.state().concepts.find((c) => c.slug === 'caching').summary, null, 'state carries no summary');
  assert.equal(h.state().jobs.find((j) => j.id === job.id).state, 'done');
  assert.ok(h.hub.search('hot data').some((x) => x.kind === 'concept' && x.id === 'caching'), 'summary is searchable');
  // a failed job leaves the page alone
  const j2 = (await h.api('POST', '/v1/concepts/caching/summarize')).json.job;
  await h.get('/v1/sessions/s1/jobs');
  h.send(h.ev('s1', 'job.result', { jobId: j2.id, ok: false, error: 'boom' }, clock.t + 9));
  assert.equal((await h.get('/v1/concepts/caching')).json.concept.summary, md);
  assert.equal(h.state().jobs.find((j) => j.id === j2.id).state, 'failed');
  h.send(h.ev('s1', 'helm.usage', { kind: 'concept_summary', model: 'haiku', costUsd: 0.001 }, clock.t + 10));
  assert.ok(h.hub.usage(1), 'usage of the new kind is accepted');
  h.send(h.ev('s1', 'session.ended', { reason: 'x' }, clock.t + 20));
  assert.equal((await h.api('POST', '/v1/concepts/cdn/summarize')).status, 409);
});

test('FTS indexes names, aliases and summaries', async (t) => {
  const { h, recap } = await setup(); t.after(h.stop);
  recap('A', ['websockets', 'ws'], 1);
  assert.ok(h.hub.search('websocket').some((r) => r.kind === 'concept' && r.id === 'websockets'));
  await h.api('PATCH', '/v1/concepts/websockets', { aliases: ['socket-io'] });
  assert.ok(h.hub.search('socket').some((r) => r.kind === 'concept'));
  await h.api('PATCH', '/v1/concepts/websockets', { summary: 'A persistent duplex channel over TCP.' });
  assert.ok(h.hub.search('duplex').some((r) => r.kind === 'concept' && r.title === 'websockets'));
});

test('rebuild replays recaps, merges, renames, pins and summaries exactly', async (t) => {
  const { h, recap, clock } = await setup(); t.after(h.stop);
  seed(h.hub);
  recap('A', ['x-one', 'x-two', 'shared'], 3); recap('B', ['x-1', 'shared'], 2); recap('C', ['shared', 'x-two'], 1);
  await h.api('POST', '/v1/concepts/merge', { from: 'x-1', into: 'x-one' });
  await h.api('PATCH', '/v1/concepts/shared', { name: 'Shared!', pinned: true, aliases: ['common'] });
  const job = (await h.api('POST', '/v1/concepts/shared/summarize')).json.job;
  await h.get(`/v1/sessions/${job.sessionId}/jobs`);
  h.send(h.ev(job.sessionId, 'job.result', { jobId: job.id, ok: true, text: '## What it is\nShared.' }, clock.t + 3));
  const before = h.hub.dump();
  const stateBefore = h.state();
  assert.ok(before.concepts.length > 5 && before.concept_tasks.length > 10 && before.concept_keys.length > 5);
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
  assert.equal((await h.get('/v1/concepts/common')).json.concept.summary, '## What it is\nShared.');
});

test('seed recaps become concepts', async (t) => {
  const { h } = await setup(); t.after(h.stop);
  seed(h.hub);
  const list = (await h.get('/v1/concepts')).json.concepts;
  assert.ok(list.length >= 8);
  const a11y = list.find((c) => c.slug === 'accessibility');
  assert.ok(a11y, 'a11y maps to accessibility via the built-in alias map');
  assert.ok(a11y.aliases.includes('a11y'));
  assert.ok(list.every((c) => c.count === c.taskIds.length && c.taskAts.length === c.count));
});

test('migration: a database from before concepts is back-filled from its recaps, once', async (t) => {
  const { Hub } = await import('../hub.mjs');
  const { loadConfig } = await import('../config.mjs');
  const home = tmpDir(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cfg = loadConfig({ home, port: 0 });
  let hub = new Hub(cfg, null, { clock: () => T0 });
  hub.createProject({ name: 'proj' }, T0);
  const pid = hub.state().projects[0].id;
  const t1 = hub.createTask({ projectId: pid, title: 'Old one' }, T0).task.id;
  const t2 = hub.createTask({ projectId: pid, title: 'Old two' }, T0).task.id;
  hub.ingest([
    { sessionId: 's1', seq: 1, type: 'session.started', at: T0, data: { cwd: '/w/p', title: 't', model: 'm' } },
    { sessionId: 's1', seq: 2, type: 'recap.generated', at: T0 + 1, data: { taskId: t1, what: 'w', how: 'h', learned: 'l', concepts: ['cache', 'ttl'] } },
    { sessionId: 's1', seq: 3, type: 'recap.generated', at: T0 + 2, data: { taskId: t2, what: 'w', how: 'h', learned: 'l', concepts: ['Caches'] } },
  ]);
  assert.equal(hub.concepts().concepts.length, 2);
  // downgrade: drop the concept tables and the flag, as in a v0.12 database
  hub.db.exec('DROP TABLE concepts; DROP TABLE concept_tasks; DROP TABLE concept_keys');
  hub.db.run("DELETE FROM meta WHERE key = 'concepts_backfilled'");
  hub.close();
  for (let i = 0; i < 2; i++) { // the second open must not redo or duplicate anything
    hub = new Hub(cfg, null, { clock: () => T0 });
    const list = hub.concepts({ sort: 'name' }).concepts;
    assert.deepEqual(list.map((c) => [c.slug, c.count]), [['cache', 2], ['ttl', 1]]);
    assert.deepEqual(list[0].aliases, ['caches']);
    assert.ok(hub.search('ttl').some((r) => r.kind === 'concept'));
    hub.close();
  }
});
