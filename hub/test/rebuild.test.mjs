import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, tmpDir, spawnDaemon, waitHealthy, freePort, HELMD } from './helpers.mjs';
import { seed } from '../seed.mjs';
import { Hub } from '../hub.mjs';
import { loadConfig } from '../config.mjs';
import { spawnSync } from 'node:child_process';

test('seed produces the advertised demo data through the real code paths', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const r = seed(h.hub);
  assert.equal(r.skipped, false);
  const st = h.state();
  assert.equal(st.projects.length, 2);
  assert.equal(st.sessions.length, 3);
  assert.deepEqual(st.sessions.map((s) => s.status).sort(), ['active', 'ended', 'idle']);
  assert.ok(st.sessions.find((s) => s.status === 'active').busy);
  assert.ok(st.agents.length >= 8);
  for (const s of ['running', 'done', 'failed', 'stalled']) assert.ok(st.agents.some((a) => a.status === s), 'agent ' + s);
  assert.ok(st.agents.some((a) => a.model === 'haiku') && st.agents.some((a) => a.model === 'sonnet'));
  for (const s of ['backlog', 'next', 'in_progress', 'review', 'done', 'later', 'blocked', 'archived']) {
    assert.ok(st.tasks.some((x) => x.status === s), 'task ' + s);
  }
  assert.ok(st.tasks.length >= 16);
  assert.ok(st.tasks.filter((x) => ['done', 'review'].includes(x.status)).every((x) => x.recap), 'recaps on done/review');
  assert.ok(st.tasks.some((x) => x.dependsOn.length) && st.tasks.some((x) => x.filesChanged.length));
  for (const s of ['draft', 'queued', 'sending', 'ran', 'failed']) assert.ok(st.notes.some((n) => n.state === s), 'note ' + s);
  assert.ok(h.hub.db.get('SELECT COUNT(*) AS n FROM activity').n >= 120);
  assert.ok(st.sessions.every((s) => s.costUsd >= 0.4 && s.costUsd <= 6.8));
  assert.ok(st.sessions.some((s) => s.costUsd === 6.8));
  assert.ok(h.hub.search('jwt').length > 0);
  assert.ok(h.hub.learn().length > 0);
  // v0.2 extras: two conflicts, three questions (one from a waiting agent), a done explain job, two digests
  assert.equal(h.hub.conflicts().length, 2);
  assert.equal(st.tasks.filter((x) => x.conflicts.length).length, 4);
  assert.deepEqual(st.questions.map((q) => [q.kind, q.state]), [['ask', 'answered'], ['waiting', 'open'], ['ask', 'open']]);
  assert.equal(st.agents.filter((a) => a.status === 'waiting').length, 1);
  assert.deepEqual(st.jobs.map((j) => [j.kind, j.state]).sort(), [['digest', 'done'], ['digest', 'done'], ['explain', 'done']]);
  assert.match(st.tasks.find((x) => x.explainer).explainer, /^## What this task did/);
  assert.equal(st.digests.length, 2);
  assert.ok(h.hub.search('hand-rolled').some((r) => r.kind === 'question'));
  assert.equal(seed(h.hub).skipped, true, 'seeding twice is a no-op');
});

test('replaying events into an empty projection reproduces identical state (--rebuild)', async (t) => {
  const h = await startTest(); t.after(h.stop);
  seed(h.hub);
  // add live-ish traffic and commands on top of the seed
  await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'Post-seed task', dependsOn: ['T-1'] });
  await h.api('POST', '/v1/notes', { target: { kind: 'task', id: 'T-1' }, text: 'post seed note' });
  h.send(h.ev('demo-meridian-auth', 'tool.called', { tool: 'Read', toolUseId: 'zz', summary: 'Read after seed' }));
  const before = h.hub.dump();
  const stateBefore = h.state();
  const info = h.hub.rebuild();
  assert.ok(info.replayed > 200);
  assert.deepEqual(h.hub.dump(), before, 'projection tables identical');
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
  assert.ok(h.hub.seqNow() > stateBefore.seq, 'change sequence stays monotonic across a rebuild');
  assert.ok(h.hub.search('jwt').length > 0, 'FTS rebuilt');
  assert.ok(h.hub.search('post seed').length > 0);
  // old SSE positions are told to refetch
  assert.equal(h.hub.changesSince(stateBefore.seq).reset, true);
  assert.equal(h.hub.changesSince(h.hub.seqNow()).reset, false);
  // and the rebuilt hub keeps working
  await h.api('POST', '/v1/tasks', { projectId: 'P-1', title: 'after rebuild' });
  assert.equal(h.state().tasks.find((x) => x.title === 'after rebuild').id, `T-${before.counters.find((c) => c.name === 'T').n + 1}`);
});

test('node hub/helmd.mjs --rebuild works on a stopped database and refuses while running', async (t) => {
  const home = tmpDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();
  const d = spawnDaemon(home, port, ['--seed']);
  await waitHealthy(home, port);
  const refuse = spawnSync(process.execPath, [HELMD, '--home', home, '--port', String(port), '--rebuild'], { encoding: 'utf8' });
  assert.equal(refuse.status, 2);
  assert.match(refuse.stderr, /stop it/);
  d.kill('SIGTERM');
  assert.equal((await d.exited).code, 0);
  const out = spawnSync(process.execPath, [HELMD, '--home', home, '--port', String(port), '--rebuild'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout.trim());
  assert.equal(j.identical, true);
  assert.ok(j.replayed > 200);
  assert.match(j.sha256, /^[0-9a-f]{64}$/);
  // the rebuilt DB is still servable
  const d2 = spawnDaemon(home, port, []);
  await waitHealthy(home, port);
  const st = await (await fetch(`http://127.0.0.1:${port}/v1/state`)).json();
  assert.equal(st.projects.length, 2);
  d2.kill('SIGTERM');
  await d2.exited;
});
