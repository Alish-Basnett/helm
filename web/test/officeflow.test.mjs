// Office flow model (web/officemodel.js): which things show, which wait for the owner's OK, how links resolve, and the layout settles.
// Run: node --test web/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, Sim, classify, fitTransform, linkControl, quadAt, GRACE_MS, roleOf } from '../officemodel.js';

const NOW = 1_000_000_000_000;
const P = (id, name, o = {}) => ({ id, name, archived: false, coordinator: false, ...o });
const S = (id, projectId, o = {}) => ({ id, projectId, status: 'active', busy: false, startedAt: NOW - 1e6, lastSeenAt: NOW - 1e3, acknowledgedAt: null, ...o });
const A = (id, sessionId, o = {}) => ({ id, sessionId, status: 'running', subagentType: 'helm:builder', parentId: null, startedAt: NOW - 5e5, endedAt: null, lastActivityAt: NOW - 1e3, acknowledgedAt: null, ...o });
const L = (id, o = {}) => ({ id, kind: 'note', fromSessionId: 's-spoke', fromProjectId: 'P-2', toProjectId: 'P-1', toSessionId: 's-main', state: 'delivered', acknowledgedAt: null, createdAt: NOW - 1e4, answeredAt: null, ...o });
const projects = [P('P-1', 'Admin', { coordinator: true }), P('P-2', 'Client'), P('P-3', 'Trips')];
const base = { projects, sessions: [S('s-main', 'P-1'), S('s-spoke', 'P-2')], agents: [], links: [], caps: { ack: true }, now: NOW };
const keys = (m) => m.nodes.map((n) => n.key);

test('classify: live always shows; finished waits for OK; acked is archived; no-ack hubs age out', () => {
  assert.equal(classify({ live: true }, { ack: true }, NOW), 'live');
  assert.equal(classify({ live: false, ackedAt: null, endedAt: 1 }, { ack: true }, NOW), 'finished');
  assert.equal(classify({ live: false, ackedAt: 5, endedAt: 1 }, { ack: true }, NOW), 'archived');
  assert.equal(classify({ live: false, endedAt: NOW - 1000 }, { ack: false }, NOW), 'soft');
  assert.equal(classify({ live: false, endedAt: NOW - GRACE_MS - 1 }, { ack: false }, NOW), 'hidden');
});

test('the coordinator project owns the main node; other sessions are spokes joined to it', () => {
  const m = buildModel(base);
  assert.equal(m.main.key, 's:s-main');
  assert.equal(m.main.kind, 'main');
  assert.deepEqual(m.edges.filter((e) => e.kind === 'struct').map((e) => [e.a, e.b]), [['s:s-main', 's:s-spoke']]);
});

test('no coordinator: no main, no structural edges; coordinator without a live session: a ghost main', () => {
  const none = buildModel({ ...base, projects: projects.map((p) => ({ ...p, coordinator: false })) });
  assert.equal(none.main, null);
  assert.equal(none.edges.length, 0);
  const idle = buildModel({ ...base, sessions: [S('s-spoke', 'P-2')] });
  assert.equal(idle.main.ghost, true);
  assert.equal(idle.main.key, 'g:P-1');
});

test('subagents branch from their parent agent, else their session, parents first', () => {
  const agents = [A('a2', 's-spoke', { parentId: 'a1', startedAt: NOW - 1e5 }), A('a1', 's-spoke', { startedAt: NOW - 4e5 }), A('a3', 's-main')];
  const m = buildModel({ ...base, agents });
  const br = Object.fromEntries(m.edges.filter((e) => e.kind === 'branch').map((e) => [e.b, e.a]));
  assert.equal(br['a:a2'], 'a:a1');
  assert.equal(br['a:a1'], 's:s-spoke');
  assert.equal(br['a:a3'], 's:s-main');
  assert.ok(keys(m).indexOf('a:a1') < keys(m).indexOf('a:a2'));
  assert.equal(roleOf({ subagentType: 'helm:scout' }), 'scout');
  assert.equal(roleOf({ subagentType: 'Explore' }), 'agent');
});

test('finished agents stay and need your OK until acknowledged; then they are archived and hidden', () => {
  const agents = [A('a1', 's-spoke', { status: 'done', endedAt: NOW - 1e4 }), A('a2', 's-spoke', { status: 'failed', endedAt: NOW - 1e4 }), A('a3', 's-spoke')];
  let m = buildModel({ ...base, agents });
  assert.equal(m.pending.agents.length, 2);
  assert.ok(m.byKey.get('a:a1').needsOk);
  assert.ok(!m.byKey.get('a:a3').needsOk, 'running agents never ask for an OK');
  m = buildModel({ ...base, agents: agents.map((a) => (a.id === 'a1' ? { ...a, acknowledgedAt: NOW } : a)) });
  assert.ok(!m.byKey.has('a:a1'));
  assert.equal(m.archivedCount, 1);
  assert.equal(m.pending.agents.length, 1);
  m = buildModel({ ...base, showArchived: true, agents: agents.map((a) => (a.id === 'a1' ? { ...a, acknowledgedAt: NOW } : a)) });
  assert.ok(m.byKey.get('a:a1').archived);
  assert.ok(!m.byKey.get('a:a1').needsOk);
});

test('an ended session stays until acknowledged; acknowledging it archives its subagents too', () => {
  const ended = S('s-old', 'P-3', { status: 'ended', lastSeenAt: NOW - 5 * 3600e3 });
  const agents = [A('a1', 's-old', { status: 'done', endedAt: NOW - 5 * 3600e3 })];
  let m = buildModel({ ...base, sessions: [...base.sessions, ended], agents });
  assert.ok(m.byKey.get('s:s-old').needsOk);
  assert.ok(m.byKey.has('a:a1'));
  m = buildModel({ ...base, sessions: [...base.sessions, { ...ended, acknowledgedAt: NOW }], agents });
  assert.ok(!m.byKey.has('s:s-old') && !m.byKey.has('a:a1'));
  assert.equal(m.archivedCount, 2);
});

test('a hub that cannot acknowledge: finished things show for a while without asking, then drop off', () => {
  const caps = { ack: false };
  const agents = [A('a1', 's-spoke', { status: 'done', endedAt: NOW - 1e4 }), A('a2', 's-spoke', { status: 'done', endedAt: NOW - GRACE_MS - 5 })];
  const m = buildModel({ ...base, caps, agents });
  assert.ok(m.byKey.has('a:a1') && !m.byKey.has('a:a2'));
  assert.ok(!m.byKey.get('a:a1').needsOk);
  assert.equal(m.pending.agents.length, 0);
});

test('links: edge between the two sessions; queued links to a project with no session get a ghost node', () => {
  const links = [L('L-1'), L('L-2', { fromSessionId: 's-main', fromProjectId: 'P-1', toProjectId: 'P-3', toSessionId: null, state: 'queued' })];
  const m = buildModel({ ...base, links });
  const e1 = m.edges.find((e) => e.key === 'l:L-1');
  assert.deepEqual([e1.a, e1.b], ['s:s-spoke', 's:s-main']);
  const e2 = m.edges.find((e) => e.key === 'l:L-2');
  assert.equal(e2.b, 'g:P-3');
  assert.equal(m.byKey.get('g:P-3').ghost, true);
});

test('an answered link needs your OK until acknowledged; an unanswered one has no ack', () => {
  let m = buildModel({ ...base, links: [L('L-1', { state: 'answered', answeredAt: NOW - 100 }), L('L-2')] });
  assert.equal(m.pending.links.length, 1);
  assert.ok(m.edges.find((e) => e.key === 'l:L-1').needsOk);
  assert.ok(!m.edges.find((e) => e.key === 'l:L-2').needsOk);
  m = buildModel({ ...base, links: [L('L-1', { state: 'answered', answeredAt: NOW - 100, acknowledgedAt: NOW })] });
  assert.equal(m.edges.filter((e) => e.kind === 'link').length, 0);
  assert.equal(m.archivedCount, 1);
});

test('links between parallel pairs bend apart', () => {
  const m = buildModel({ ...base, links: [L('L-1'), L('L-2', { fromSessionId: 's-main', fromProjectId: 'P-1', toProjectId: 'P-2', toSessionId: 's-spoke' })] });
  const [a, b] = m.edges.filter((e) => e.kind === 'link');
  assert.notEqual(a.off, b.off);
});

test('the project filter hides other spokes but never the main session', () => {
  const m = buildModel({ ...base, sessions: [...base.sessions, S('s-3', 'P-3')], scope: (pid) => pid === 'P-3' });
  assert.deepEqual(keys(m).sort(), ['s:s-3', 's:s-main']);
});

test('layout settles, stays finite, keeps the main node near the middle and starts a new branch at its parent', () => {
  const agents = Array.from({ length: 60 }, (_, i) => A(`a${i}`, i % 2 ? 's-spoke' : 's-main', { status: i % 3 ? 'done' : 'running', endedAt: NOW - 1e4 }));
  const m = buildModel({ ...base, agents });
  const sim = new Sim();
  sim.sync(m.nodes, m.edges);
  assert.ok(sim.settle() < 500, 'cools down');
  const pts = [...sim.p.values()];
  assert.ok(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  const mp = sim.p.get('s:s-main');
  assert.ok(Math.hypot(mp.x, mp.y) < 60);
  const b = sim.bounds();
  assert.ok(b.x1 - b.x0 < 1500 && b.y1 - b.y0 < 1500, 'no node flies away');
  const next = buildModel({ ...base, agents: [...agents, A('fresh', 's-spoke', { parentId: 'a1' })] });
  const { added } = sim.sync(next.nodes, next.edges);
  assert.deepEqual(added, ['a:fresh']);
  const par = sim.p.get('a:a1'), kid = sim.p.get('a:fresh');
  assert.ok(Math.hypot(par.x - kid.x, par.y - kid.y) < 6, 'pops out of its parent');
  assert.ok(sim.active, 'adding a node wakes the layout');
  const gone = buildModel({ ...base, agents: [] });
  const { removed } = sim.sync(gone.nodes, gone.edges);
  assert.ok(removed.length > 60 && removed.every((r) => Number.isFinite(r.x)));
});

test('fitTransform centres the bounds; link curves leave on the same side whichever way the link points', () => {
  const t = fitTransform({ x0: 0, y0: 0, x1: 100, y1: 100 }, 400, 300);
  assert.ok(Math.abs(t.x + 50 * t.k - 200) < 1e-6 && Math.abs(t.y + 50 * t.k - 150) < 1e-6);
  assert.deepEqual(fitTransform(null, 400, 300), { x: 200, y: 150, k: 1 });
  const a = { x: 0, y: 0 }, b = { x: 100, y: 0 };
  const c1 = linkControl('a', a, 'b', b, 30), c2 = linkControl('b', b, 'a', a, 30);
  assert.deepEqual(c1, c2);
  assert.deepEqual(quadAt(a, c1, b, 0), a);
  assert.deepEqual(quadAt(a, c1, b, 1), b);
});

test('a running subagent never disappears: its ended session is blocked from acknowledging and stays as its parent', () => {
  const ended = S('s-old', 'P-3', { status: 'ended', lastSeenAt: NOW - 3600e3 });
  const agents = [A('live', 's-old'), A('done', 's-old', { status: 'done', endedAt: NOW - 1e4 })];
  const m = buildModel({ ...base, sessions: [...base.sessions, ended], agents });
  const n = m.byKey.get('s:s-old');
  assert.equal(n.blocked, 'it still has running subagents');
  assert.ok(!n.needsOk);
  assert.equal(m.pending.sessions.length, 0, 'left out of the bulk list');
  assert.equal(m.pending.agents.length, 1, 'only the finished child is offered');
  assert.ok(m.byKey.has('a:live') && m.byKey.get('a:live').cls === 'live');
});

test('an archived session with a running child stays on the graph, dimmed, and the child stays live', () => {
  const archived = S('s-old', 'P-3', { status: 'ended', lastSeenAt: NOW - 3600e3, acknowledgedAt: NOW - 10 });
  const agents = [A('live', 's-old', { status: 'waiting' }), A('done', 's-old', { status: 'done', endedAt: NOW - 1e4 })];
  const m = buildModel({ ...base, sessions: [...base.sessions, archived], agents });
  assert.ok(m.byKey.get('s:s-old').archived);
  assert.equal(m.byKey.get('a:live').cls, 'live');
  assert.ok(!m.byKey.get('a:live').archived);
  assert.ok(!m.byKey.has('a:done'), 'its finished sibling is archived and hidden');
  const edge = m.edges.find((e) => e.b === 'a:live');
  assert.equal(edge.a, 's:s-old');
  assert.equal(m.archivedCount, 2, 'the session and its finished sibling count; the running child does not');
});

test('a hub without ack still keeps a session that has a running child', () => {
  const ended = S('s-old', 'P-3', { status: 'ended', lastSeenAt: NOW - GRACE_MS - 1e5 });
  const m = buildModel({ ...base, caps: { ack: false }, sessions: [...base.sessions, ended], agents: [A('live', 's-old')] });
  assert.ok(m.byKey.has('s:s-old') && m.byKey.has('a:live'));
});

test('layout with the bucketed repulsion (150 nodes) stays finite and does not overlap', () => {
  const agents = Array.from({ length: 150 }, (_, i) => A(`a${i}`, i % 2 ? 's-spoke' : 's-main', { parentId: i > 8 && i % 3 === 0 ? `a${i - 7}` : null }));
  const m = buildModel({ ...base, agents });
  const sim = new Sim();
  sim.sync(m.nodes, m.edges);
  assert.ok(sim.settle(300) <= 301, 'work is capped');
  const pts = [...sim.p.values()];
  assert.ok(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  let overlaps = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < (pts[i].r + pts[j].r) * 0.8) overlaps++;
  assert.ok(overlaps < 5, `overlaps: ${overlaps}`);
});
