import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { tmpDir, freePort, spawnDaemon, waitHealthy, waitUntil, sockRequest, sleep, HELMD } from './helpers.mjs';

const post = (port, events) => fetch(`http://127.0.0.1:${port}/v1/events`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }),
}).then((r) => r.json());
const getJson = (port, p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.json());

test('daemon: single instance, both listeners, clean SIGTERM shutdown', async (t) => {
  const home = tmpDir(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();
  const a = spawnDaemon(home, port);
  const h = await waitHealthy(home, port);
  assert.equal(h.pid, a.pid);
  const pidFile = path.join(home, 'helmd.pid'), sock = path.join(home, 'helmd.sock');
  assert.equal(fs.readFileSync(pidFile, 'utf8'), String(a.pid));
  assert.ok(fs.existsSync(sock));
  assert.equal((await sockRequest(sock, 'GET', '/v1/health')).json.pid, a.pid);
  assert.equal((await getJson(port, '/v1/health')).pid, a.pid);

  // a second start with the same home exits 0 and leaves the first one alone
  const b = spawnDaemon(home, port);
  const bx = await b.exited;
  assert.equal(bx.code, 0);
  assert.match(b.output(), /already running/);
  assert.equal((await getJson(port, '/v1/health')).pid, a.pid);

  // --status / --stop CLI
  const st = spawnSync(process.execPath, [HELMD, '--home', home, '--port', String(port), '--status'], { encoding: 'utf8' });
  assert.equal(st.status, 0);
  assert.equal(JSON.parse(st.stdout).pid, a.pid);

  a.kill('SIGTERM');
  const ax = await a.exited;
  assert.equal(ax.code, 0);
  assert.ok(!fs.existsSync(sock), 'socket removed');
  assert.ok(!fs.existsSync(pidFile), 'pid file removed');
  assert.ok(fs.readFileSync(path.join(home, 'helmd.log'), 'utf8').includes('shutting down'));
  // WAL was checkpointed on the way out
  const wal = path.join(home, 'helm.db-wal');
  assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0);
});

test('daemon: stale socket and pid file from a dead process are cleaned up', async (t) => {
  const home = tmpDir(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();
  fs.writeFileSync(path.join(home, 'helmd.pid'), '999999');
  fs.writeFileSync(path.join(home, 'helmd.sock'), 'not a socket');
  const d = spawnDaemon(home, port);
  const h = await waitHealthy(home, port);
  assert.equal(h.pid, d.pid);
  d.kill('SIGINT');
  assert.equal((await d.exited).code, 0);
});

test('daemon: a busy TCP port is a clear startup failure, not a hang', async (t) => {
  const home = tmpDir(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const net = await import('node:net');
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const d = spawnDaemon(home, blocker.address().port);
  const x = await d.exited;
  blocker.close();
  assert.equal(x.code, 1);
  assert.match(d.output(), /already in use/);
});

test('daemon: HELM_STALL_MS / HELM_BLOCK_MS / HELM_IDLE_MS / HELM_SWEEP_MS drive the sweep', async (t) => {
  const home = tmpDir(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();
  const d = spawnDaemon(home, port, [], { HELM_STALL_MS: '200', HELM_BLOCK_MS: '400', HELM_IDLE_MS: '300', HELM_SWEEP_MS: '60' });
  t.after(() => d.kill('SIGKILL'));
  await waitHealthy(home, port);
  const now = Date.now();
  await post(port, [
    { sessionId: 's1', seq: 1, type: 'session.started', at: now, data: { cwd: '/w/p', title: 'S', model: 'm' } },
    { sessionId: 's1', seq: 2, type: 'agent.spawned', at: now, data: { toolUseId: 'u', subagentType: 'b', model: 'sonnet', description: 'job', prompt: '' } },
  ]);
  await waitUntil(async () => {
    const st = await getJson(port, '/v1/state');
    return st.agents[0].status === 'stalled' && st.tasks[0].status === 'blocked' && st.sessions[0].status === 'idle';
  }, 5000);
});

test('daemon: kill -9 mid-run loses no committed events, and it restarts over the stale files', async (t) => {
  const home = tmpDir(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();
  const a = spawnDaemon(home, port);
  await waitHealthy(home, port);
  await post(port, [{ sessionId: 's1', seq: 1, type: 'session.started', at: Date.now(), data: { cwd: '/w/crash', title: 'S', model: 'm' } }]);

  // hammer the ingest endpoint; kill -9 while requests are still being issued
  let seq = 1, acked = 0, inFlightMax = 0;
  const batch = () => Array.from({ length: 5 }, () => ({
    sessionId: 's1', seq: ++seq, type: 'tool.called', at: Date.now(), data: { toolUseId: 't' + seq, tool: 'Read', summary: 'Read ' + seq },
  }));
  let killed = false;
  const worker = (async () => {
    while (!killed) {
      const events = batch();
      try {
        const r = await post(port, events);
        if (r.accepted === 5) { acked += 5; inFlightMax = Math.max(inFlightMax, seq); }
      } catch { break; }
    }
  })();
  await waitUntil(() => acked >= 150, 8000);
  process.kill(a.pid, 'SIGKILL');
  killed = true;
  await a.exited;
  await worker;
  assert.ok(acked >= 150);
  assert.ok(fs.existsSync(path.join(home, 'helmd.pid')), 'a crash leaves the pid file behind');

  const b = spawnDaemon(home, port);
  t.after(() => b.kill('SIGKILL'));
  const h = await waitHealthy(home, port);
  assert.equal(h.pid, b.pid);
  const st = await getJson(port, '/v1/state');
  assert.equal(st.sessions.length, 1);

  // every acknowledged event is in the events table and was projected into activity
  const db = new DatabaseSync(path.join(home, 'helm.db'), { readOnly: true });
  const stored = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'tool.called'").get().n;
  const acts = db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'tool'").get().n;
  const have = new Set(db.prepare("SELECT seq FROM events WHERE session_id = 's1'").all().map((r) => r.seq));
  db.close();
  assert.ok(stored >= acked, `stored ${stored} >= acked ${acked}`);
  assert.equal(acts, stored, 'projection and event log committed atomically');
  for (let s = 1; s <= 1 + acked; s++) assert.ok(have.has(s), `seq ${s} missing`);

  // the outbox replay after the restart is idempotent
  const replay = await post(port, [{ sessionId: 's1', seq: 2, type: 'tool.called', at: Date.now(), data: { toolUseId: 't2', tool: 'Read', summary: 'Read 2' } }]);
  assert.equal(replay.duplicates, 1);
  b.kill('SIGTERM');
  assert.equal((await b.exited).code, 0);
});

test('daemon: --seed serves the demo data over TCP and the unix socket; --detach / --stop work', async (t) => {
  const home = tmpDir(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();
  const run = (...args) => spawnSync(process.execPath, [HELMD, '--home', home, '--port', String(port), ...args], { encoding: 'utf8' });
  const started = run('--detach', '--seed');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.match(started.stdout, /started pid/);
  t.after(() => run('--stop'));
  assert.match(run('--detach').stdout, /already running/);
  const sock = path.join(home, 'helmd.sock');
  const viaTcp = await getJson(port, '/v1/state');
  const viaSock = (await sockRequest(sock, 'GET', '/v1/state')).json;
  assert.deepEqual(viaTcp, viaSock);
  assert.equal(viaTcp.projects.length, 2);
  assert.equal(viaTcp.sessions.length, 3);
  const found = await getJson(port, '/v1/search?q=jwt');
  assert.ok(found.results.length > 0);
  const stopped = run('--stop');
  assert.match(stopped.stdout, /stopped pid/);
  assert.equal(run('--status').status, 1);
  assert.ok(!fs.existsSync(sock));
});

test('daemon: --demo-live emits a changing stream the SSE feed can watch', async (t) => {
  const home = tmpDir(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const port = await freePort();
  const d = spawnDaemon(home, port, ['--demo-live']);
  t.after(() => d.kill('SIGKILL'));
  await waitHealthy(home, port);
  const before = (await getJson(port, '/v1/state')).seq;
  await waitUntil(async () => (await getJson(port, '/v1/state')).seq >= before + 6, 12000);
  const st = await getJson(port, '/v1/state');
  assert.ok(st.sessions.find((s) => s.id === 'demo-meridian-auth').status === 'active');
  d.kill('SIGTERM');
  assert.equal((await d.exited).code, 0);
});
