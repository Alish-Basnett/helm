import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTest, tmpDir } from './helpers.mjs';
import { Hub } from '../hub.mjs';
import { loadConfig } from '../config.mjs';
import { seed } from '../seed.mjs';
import { computeHealth } from '../projections.mjs';

const MIN = 60_000;
const T0 = new Date(2026, 5, 10, 9, 0, 0).getTime(); // local 09:00 so "resets 15:00" is the same local day
const session = (h, id = 's1') => h.state().sessions.find((s) => s.id === id);
const start = (h, t = T0) => h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'S', model: 'opus' }, t));
const beat = (h, data, at) => h.send(h.ev('s1', 'session.heartbeat', data, at));

test('heartbeat stores contextWindow, contextPercent and rateLimits (latest wins) and drops junk', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  beat(h, {
    tokens: 5000, costUsd: 1.5, contextWindow: 200000, contextPercent: 42.5,
    rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: new Date(T0 + 3 * 3600_000).toISOString() }, { kind: 'x' }, null,
      { kind: 'seven_day', percentUsed: 12, resetsAt: 'not a date' }],
  }, T0 + MIN);
  let s = session(h);
  assert.equal(s.contextWindow, 200000);
  assert.equal(s.contextPercent, 42.5);
  assert.equal(s.rateLimits.length, 2);
  assert.equal(s.rateLimits[0].kind, 'five_hour');
  assert.equal(s.rateLimits[1].resetsAt, null);
  assert.deepEqual(s.health, { level: 'ok', reasons: [] });
  // a heartbeat without the new fields keeps the last values; an empty list clears the limits
  beat(h, { tokens: 6000 }, T0 + 2 * MIN);
  s = session(h);
  assert.equal(s.contextPercent, 42.5);
  assert.equal(s.rateLimits.length, 2);
  beat(h, { rateLimits: [], contextPercent: 250 }, T0 + 3 * MIN);
  s = session(h);
  assert.deepEqual(s.rateLimits, []);
  assert.equal(s.contextPercent, 100, 'clamped');
});

test('turns set busySince and lastTurnAt', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  h.send(h.ev('s1', 'turn.started', {}, T0 + MIN));
  assert.equal(session(h).busySince, T0 + MIN);
  h.send(h.ev('s1', 'turn.started', {}, T0 + 2 * MIN));
  assert.equal(session(h).busySince, T0 + MIN, 'a second start does not move it');
  h.send(h.ev('s1', 'turn.completed', { ok: true }, T0 + 5 * MIN));
  const s = session(h);
  assert.equal(s.busy, false);
  assert.equal(s.busySince, null);
  assert.equal(s.lastTurnAt, T0 + 5 * MIN);
});

test('samples are appended at most once a minute and pruned to 7 days', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  const n = () => h.hub.db.get('SELECT COUNT(*) AS n FROM session_samples').n;
  beat(h, { tokens: 1, costUsd: 0.1, contextPercent: 10 }, T0);
  beat(h, { tokens: 2, costUsd: 0.2, contextPercent: 11 }, T0 + 20_000);
  beat(h, { tokens: 3, costUsd: 0.3, contextPercent: 12 }, T0 + 59_000);
  assert.equal(n(), 1, 'three heartbeats inside a minute make one sample');
  beat(h, { tokens: 4, costUsd: 0.4, contextPercent: 13 }, T0 + 61_000);
  assert.equal(n(), 2);
  const rows = h.hub.db.all('SELECT * FROM session_samples ORDER BY at');
  assert.deepEqual(rows.map((r) => [r.tokens, r.percent, r.cost_usd]), [[1, 10, 0.1], [4, 13, 0.4]]);
  // a heartbeat 8 days later prunes the old rows (and only its own session's)
  h.send(h.ev('s2', 'session.started', { cwd: '/w/other', title: 'O', model: 'm' }, T0));
  h.send(h.ev('s2', 'session.heartbeat', { tokens: 9 }, T0));
  beat(h, { tokens: 5 }, T0 + 8 * 24 * 60 * MIN);
  assert.deepEqual(h.hub.db.all("SELECT at FROM session_samples WHERE session_id = 's1'").map((r) => r.at), [T0 + 8 * 24 * 60 * MIN]);
  assert.equal(h.hub.db.get("SELECT COUNT(*) AS n FROM session_samples WHERE session_id = 's2'").n, 1, 'other session untouched');
});

test('context rule: 70 is ok, above 70 warns, above 85 is critical', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  const lvl = (pct, at) => { beat(h, { contextPercent: pct }, at); return session(h).health; };
  assert.equal(lvl(70, T0 + MIN).level, 'ok');
  assert.deepEqual(lvl(71, T0 + 2 * MIN), { level: 'warn', reasons: ['Context 71%'] });
  assert.equal(lvl(85, T0 + 3 * MIN).level, 'warn');
  assert.deepEqual(lvl(86, T0 + 4 * MIN), { level: 'critical', reasons: ['Context 86%'] });
  assert.equal(lvl(20, T0 + 5 * MIN).level, 'ok', 'recovers after /compact');
});

test('rate-limit rule: 80 ok, above 80 warn, above 95 critical; names the limit and the reset time', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  const reset = new Date(2026, 5, 10, 15, 0, 0).toISOString();
  const lvl = (five, seven, at) => {
    beat(h, { rateLimits: [{ kind: 'five_hour', percentUsed: five, resetsAt: reset }, { kind: 'seven_day', percentUsed: seven, resetsAt: null }] }, at);
    return session(h).health;
  };
  assert.equal(lvl(80, 80, T0 + MIN).level, 'ok');
  assert.deepEqual(lvl(92, 10, T0 + 2 * MIN), { level: 'warn', reasons: ['5-hour limit 92%, resets 15:00'] });
  assert.equal(lvl(95, 10, T0 + 3 * MIN).level, 'warn');
  assert.deepEqual(lvl(96, 81, T0 + 4 * MIN), { level: 'critical', reasons: ['5-hour limit 96%, resets 15:00', '7-day limit 81%'] });
});

test('stalled agents warn, and the warning clears when the agent shows life', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu1', subagentType: 'b', model: 'sonnet', description: 'Long job', prompt: '' }, T0));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: 'ag1' }, T0));
  assert.equal(session(h).health.level, 'ok');
  assert.equal(session(h).runningAgents, 1);
  h.hub.sweep(T0 + 6 * MIN);
  const s = session(h);
  assert.equal(s.stalledAgents, 1);
  assert.equal(s.health.level, 'warn');
  assert.ok(s.health.reasons.includes('1 stalled agent'));
  h.send(h.ev('s1', 'tool.called', { agentId: 'ag1', toolUseId: 'x', tool: 'Read', summary: 'Read it' }, T0 + 7 * MIN));
  assert.equal(session(h).stalledAgents, 0);
  assert.equal(session(h).health.level, 'ok');
});

test('idle over 30 minutes with agents running warns; busy or no agents does not', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  h.send(h.ev('s1', 'turn.started', {}, T0));
  h.send(h.ev('s1', 'turn.completed', { ok: true }, T0 + MIN));
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu1', subagentType: 'b', model: 'sonnet', description: 'bg', prompt: '' }, T0 + MIN));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: 'ag1' }, T0 + MIN));
  beat(h, {}, T0 + 31 * MIN);
  assert.equal(session(h).health.level, 'ok', 'exactly 30 min idle is not over');
  beat(h, {}, T0 + 32 * MIN);
  assert.deepEqual(session(h).health, { level: 'warn', reasons: ['Idle over 30 min with 1 agent running'] });
  h.send(h.ev('s1', 'turn.started', {}, T0 + 33 * MIN));
  assert.equal(session(h).health.level, 'ok', 'a new turn clears it');
  h.send(h.ev('s1', 'turn.completed', { ok: true }, T0 + 34 * MIN));
  h.send(h.ev('s1', 'agent.completed', { agentId: 'ag1', ok: true, summary: 'done' }, T0 + 35 * MIN));
  beat(h, {}, T0 + 90 * MIN);
  assert.equal(session(h).health.level, 'ok', 'idle with nothing running is fine');
});

test('the sweep alone moves health over time (no heartbeat needed)', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu1', subagentType: 'b', model: 'sonnet', description: 'bg', prompt: '' }, T0));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: 'ag1' }, T0));
  const r = h.hub.sweep(T0 + 40 * MIN);
  assert.ok(r.healthChanged >= 1);
  const reasons = session(h).health.reasons;
  assert.ok(reasons.some((x) => /^Idle over 30 min/.test(x)), JSON.stringify(reasons));
  assert.ok(reasons.includes('1 stalled agent'));
  assert.equal(h.hub.sweep(T0 + 41 * MIN)?.healthChanged ?? 0, 0, 'stable text: no churn');
});

test('cost rule uses HELM_COST_WARN_USD (default 25) on cost today', async (t) => {
  const h = await startTest(); t.after(h.stop);
  assert.equal(h.hub.cfg.costWarnUsd, 25);
  start(h);
  beat(h, { costUsd: 25 }, T0 + MIN);
  assert.equal(session(h).health.level, 'ok', 'exactly the limit is not over');
  beat(h, { costUsd: 25.5 }, T0 + 2 * MIN);
  assert.deepEqual(session(h).health, { level: 'warn', reasons: ['Cost today $25.50 (over $25)'] });
  assert.equal(session(h).costToday, 25.5);
  // the next local day starts counting from what it had already cost
  beat(h, { costUsd: 27 }, T0 + 24 * 60 * MIN);
  assert.equal(session(h).costToday, 1.5, 'only the spend since the new day started');
  assert.equal(session(h).health.level, 'ok');

  const low = await startTest({ costWarnUsd: 2 }); t.after(low.stop);
  low.send(low.ev('s1', 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }, T0));
  low.send(low.ev('s1', 'session.heartbeat', { costUsd: 3 }, T0 + MIN));
  assert.equal(low.state().sessions[0].health.level, 'warn');
  assert.equal(loadConfig({ home: '/tmp/x' }, { HELM_COST_WARN_USD: '40' }).costWarnUsd, 40);
});

test('computeHealth combines reasons and takes the worst level; ended sessions are ok', () => {
  const row = { status: 'active', busy: 0, started_at: 0, context_percent: 90, rate_limits: '[{"kind":"seven_day","percentUsed":82,"resetsAt":null}]', stalled_n: 2, running_n: 0, cost_usd: 0, cost_base: 0 };
  const h = computeHealth(row, 1000);
  assert.equal(h.level, 'critical');
  assert.deepEqual(h.reasons, ['Context 90%', '7-day limit 82%', '2 stalled agents']);
  assert.deepEqual(computeHealth({ ...row, status: 'ended' }, 1000), { level: 'ok', reasons: [] });
});

test('a session upsert is pushed when the level changes, not for an unchanged level on a sweep', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  const seen = [];
  h.hub.subscribe((rows) => { for (const r of rows) if (r.entity === 'session') seen.push(JSON.parse(r.row).health.level); });
  beat(h, { contextPercent: 50 }, T0 + MIN);
  beat(h, { contextPercent: 90 }, T0 + 2 * MIN);
  beat(h, { contextPercent: 20 }, T0 + 3 * MIN);
  assert.deepEqual(seen, ['ok', 'critical', 'ok']);
  const before = h.hub.seqNow();
  h.hub.sweep(T0 + 3 * MIN + 1000);
  const after = h.hub.db.all('SELECT entity FROM changes WHERE seq > ?', before).filter((r) => r.entity === 'session');
  assert.equal(after.length, 0, 'no health change -> no session push');
});

test('GET /v1/sessions/:id/health returns session, samples, agent counts and cost24h', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const now = Date.now();
  h.hub.setClock(() => now);
  start(h, now - 3 * 3600_000);
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu1', subagentType: 'b', model: 'sonnet', description: 'one', prompt: '' }, now - 2 * 3600_000));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tu1', agentId: 'ag1' }, now - 2 * 3600_000));
  h.send(h.ev('s1', 'agent.completed', { agentId: 'ag1', ok: true, summary: 'ok' }, now - 3600_000));
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tu2', subagentType: 'b', model: 'sonnet', description: 'two', prompt: '' }, now - 1800_000));
  beat(h, { tokens: 1000, costUsd: 1, contextWindow: 200000, contextPercent: 10 }, now - 2 * 3600_000);
  beat(h, { tokens: 3000, costUsd: 2.5, contextWindow: 200000, contextPercent: 30 }, now - 3600_000 - 5000);
  beat(h, { tokens: 5000, costUsd: 4, contextWindow: 200000, contextPercent: 50 }, now - 60_000);
  const r = await h.get('/v1/sessions/s1/health?hours=24');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['agents', 'cost24h', 'samples', 'session']);
  assert.equal(r.json.session.id, 's1');
  assert.deepEqual(r.json.samples.map((x) => [x.tokens, x.percent, x.costUsd]), [[1000, 10, 1], [3000, 30, 2.5], [5000, 50, 4]]);
  assert.deepEqual(r.json.agents, { running: 1, stalled: 0, done24h: 1 });
  assert.equal(r.json.cost24h, 4, 'session began inside the window');
  const narrow = await h.get('/v1/sessions/s1/health?hours=1');
  assert.deepEqual(narrow.json.samples.map((x) => x.tokens), [5000]);
  assert.equal(narrow.json.cost24h, 1.5, 'cost since the last sample before the window');
  assert.equal((await h.get('/v1/sessions/nope/health')).status, 404);
});

test('GET /v1/health/sessions lists active and idle sessions, worst first', async (t) => {
  const h = await startTest(); t.after(h.stop);
  start(h);
  h.send(h.ev('s2', 'session.started', { cwd: '/w/b', title: 'B', model: 'm' }, T0));
  h.send(h.ev('s3', 'session.started', { cwd: '/w/c', title: 'C', model: 'm' }, T0));
  h.send(h.ev('s3', 'session.ended', {}, T0 + MIN));
  h.send(h.ev('s1', 'session.heartbeat', { contextPercent: 50 }, T0 + MIN));
  h.send(h.ev('s2', 'session.heartbeat', { contextPercent: 90, contextWindow: 200000 }, T0 + MIN));
  const r = await h.get('/v1/health/sessions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sessions.map((s) => s.id), ['s2', 's1']);
  assert.deepEqual(r.json.counts, { ok: 1, warn: 0, critical: 1 });
  assert.equal(r.json.level, 'critical');
  const s2 = r.json.sessions[0];
  for (const k of ['id', 'title', 'model', 'status', 'busy', 'contextPercent', 'contextWindow', 'rateLimits', 'costUsd', 'costToday', 'runningAgents', 'stalledAgents', 'health']) assert.ok(k in s2, k);
  assert.deepEqual(s2.health.reasons, ['Context 90%']);
});

test('the seed has one critical session and varied context, limits and cost', async (t) => {
  const h = await startTest(); t.after(h.stop);
  seed(h.hub);
  const sess = h.state().sessions;
  assert.equal(sess.filter((s) => s.health.level === 'critical').length, 1);
  const crit = sess.find((s) => s.health.level === 'critical');
  assert.ok(crit.contextPercent > 85 && crit.health.reasons[0].startsWith('Context'));
  assert.ok(sess.some((s) => s.health.level === 'warn'), 'a warn session too');
  assert.ok(new Set(sess.map((s) => s.contextPercent)).size === sess.length);
  assert.ok(sess.every((s) => s.rateLimits.length === 0 || s.rateLimits.every((l) => l.resetsAt)));
  const r = await h.get(`/v1/sessions/${crit.id}/health`);
  assert.ok(r.json.samples.length > 3);
});

test('rebuild reproduces health, samples and cost days exactly', async (t) => {
  const h = await startTest(); t.after(h.stop);
  seed(h.hub);
  start(h);
  beat(h, { contextPercent: 90, costUsd: 30, rateLimits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: null }] }, T0 + MIN);
  h.hub.sweep(T0 + 50 * MIN);
  const before = h.hub.dump(), stateBefore = h.state();
  assert.ok(before.session_samples.length > 5);
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
});

test('migration: a database from before v0.14 gains the health columns and samples table, idempotently', async (t) => {
  const home = tmpDir('helm-mig14-'); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cfg = loadConfig({ home, port: 0, singleton: false, sweep: false, remote: false });
  const quiet = { info() {}, warn() {}, error() {} };
  let hub = new Hub(cfg, quiet);
  hub.ingest([{ sessionId: 's1', seq: 1, type: 'session.started', at: T0, data: { cwd: '/w/p', title: 'S', model: 'm' } }]);
  hub.close();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(cfg.dbFile);
  for (const c of ['context_window', 'context_percent', 'rate_limits', 'busy_since', 'last_turn_at', 'health_level', 'health_reasons', 'cost_day', 'cost_base']) {
    raw.exec(`ALTER TABLE sessions DROP COLUMN ${c}`);
  }
  raw.exec('DROP TABLE session_samples');
  raw.close();
  for (let i = 0; i < 2; i++) { // second open proves idempotence
    hub = new Hub(cfg, quiet);
    const s = hub.state().sessions[0];
    assert.equal(s.contextPercent, null);
    assert.deepEqual(s.rateLimits, []);
    assert.deepEqual(s.health, { level: 'ok', reasons: [] });
    if (i === 0) hub.close();
  }
  hub.ingest([{ sessionId: 's1', seq: 2, type: 'session.heartbeat', at: T0 + MIN, data: { contextPercent: 91, tokens: 5 } }]);
  assert.equal(hub.state().sessions[0].health.level, 'critical');
  assert.equal(hub.db.get('SELECT COUNT(*) AS n FROM session_samples').n, 1);
  hub.close();
});
