// Office flow model (web/officemodel.js): which things show, which wait for the owner's OK, how links resolve, and the layout settles.
// Run: node --test web/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, Sim, classify, fitTransform, linkControl, quadAt, GRACE_MS, roleOf, bundleWidth, FINISHED_CAP } from '../officemodel.js';
import { retiredSessionIds, oldProjectIds, splitAckBody, chunk, pickKeep } from '../retire.js';

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

test('links: one edge between the two sessions; queued links to a live project with no session get a ghost node', () => {
  const links = [L('L-1'), L('L-2', { fromSessionId: 's-main', fromProjectId: 'P-1', toProjectId: 'P-3', toSessionId: null, state: 'queued' })];
  const m = buildModel({ ...base, links });
  const e1 = m.edges.find((e) => e.kind === 'link' && e.bundle.items[0].link.id === 'L-1');
  assert.deepEqual([e1.a, e1.b], ['s:s-spoke', 's:s-main']);
  const e2 = m.edges.find((e) => e.kind === 'link' && e.bundle.items[0].link.id === 'L-2');
  assert.equal(e2.b, 'g:P-3');
  assert.equal(m.byKey.get('g:P-3').ghost, true);
});

test('an answered link needs your OK until acknowledged; an unanswered one has no ack', () => {
  let m = buildModel({ ...base, links: [L('L-1', { state: 'answered', answeredAt: NOW - 100 }), L('L-2')] });
  assert.equal(m.pending.links.length, 1);
  assert.equal(m.pending.links[0].link.id, 'L-1');
  const e = m.edges.find((x) => x.kind === 'link');
  assert.equal(e.n, 2, 'both links share the one edge');
  assert.ok(e.needsOk && e.bundle.counts.needOk === 1);
  m = buildModel({ ...base, links: [L('L-1', { state: 'answered', answeredAt: NOW - 100, acknowledgedAt: NOW })] });
  assert.equal(m.edges.filter((x) => x.kind === 'link').length, 0);
  assert.equal(m.archivedCount, 1);
});

test('117 links between the same two sessions are ONE edge with one purple flag and a log-scale thickness', () => {
  const links = Array.from({ length: 117 }, (_, i) => L(`L-${i}`, { kind: 'task', state: i % 5 === 0 ? 'delivered' : 'answered', answeredAt: NOW - 100 - i, createdAt: NOW - 1e4 + (117 - i), refId: `T-${i}` }));
  const m = buildModel({ ...base, links });
  const link = m.edges.filter((e) => e.kind === 'link');
  assert.equal(link.length, 1);
  assert.equal(link[0].n, 117);
  assert.equal(link[0].bundle.counts.answered + link[0].bundle.counts.delivered, 117);
  assert.equal(link[0].bundle.counts.needOk, 93);
  assert.equal(m.pending.links.length, 93);
  assert.ok(link[0].needsOk);
  assert.ok(link[0].width <= 6.5 && link[0].width > bundleWidth(1));
  assert.ok(bundleWidth(1) < bundleWidth(4) && bundleWidth(4) < bundleWidth(12) && bundleWidth(10000) === 6.5);
  assert.equal(link[0].bundle.items[0].link.id, 'L-0', 'newest first');
});

test('links in opposite directions share the edge and keep their direction counts; other pairs get their own', () => {
  const links = [L('L-1'), L('L-2'), L('L-3', { fromSessionId: 's-main', fromProjectId: 'P-1', toProjectId: 'P-2', toSessionId: 's-spoke' }), L('L-4', { fromSessionId: 's-main', fromProjectId: 'P-1', toProjectId: 'P-3', toSessionId: null, state: 'queued' })];
  const m = buildModel({ ...base, links });
  const es = m.edges.filter((e) => e.kind === 'link');
  assert.equal(es.length, 2);
  const pair = es.find((e) => e.n === 3);
  assert.equal(pair.bundle.ab + pair.bundle.ba, 3);
  assert.ok(pair.bundle.ab > 0 && pair.bundle.ba > 0);
});

test('a link whose project is archived or has no queued link draws no ghost node, but stays acknowledgeable', () => {
  const ps = [...projects.slice(0, 2), P('P-3', 'Trips', { archived: true })];
  const answered = L('L-1', { fromSessionId: 's-main', fromProjectId: 'P-1', toProjectId: 'P-3', toSessionId: null, state: 'answered', answeredAt: NOW - 5 });
  let m = buildModel({ ...base, projects: ps, links: [answered] });
  assert.ok(!m.byKey.has('g:P-3'));
  assert.equal(m.edges.filter((e) => e.kind === 'link').length, 0);
  assert.equal(m.pending.links.length, 1, 'counted in the pending list');
  assert.equal(m.bundles[0].drawn, false);
  m = buildModel({ ...base, projects: ps, links: [{ ...answered, state: 'queued', answeredAt: null }] });
  assert.ok(!m.byKey.has('g:P-3'), 'archived project: no ghost even when queued');
  m = buildModel({ ...base, links: [{ ...answered, state: 'delivered', answeredAt: null }] });
  assert.ok(!m.byKey.has('g:P-3'), 'not queued: no ghost');
});

test('old sessions are not drawn: ended + (acknowledged | archived project | newer sibling project of the same folder)', () => {
  const ps = [P('P-1', 'Admin', { coordinator: true, createdAt: 1 }), P('P-2', 'fww-student', { folder: '/w/fww', createdAt: 10 }), P('P-3', 'fww student dup', { folder: '/w/fww', createdAt: 20 }), P('P-4', 'Gone', { archived: true, createdAt: 5 })];
  const ended = (id, pid, o = {}) => S(id, pid, { status: 'ended', lastSeenAt: NOW - 3600e3, ...o });
  const sessions = [S('s-main', 'P-1'), ended('s-old2', 'P-2'), ended('s-new3', 'P-3'), ended('s-arch', 'P-4'), ended('s-acked', 'P-3', { acknowledgedAt: NOW - 5 }), S('s-live2', 'P-2')];
  assert.deepEqual([...retiredSessionIds(sessions, ps)].sort(), ['s-acked', 's-arch', 's-old2']);
  assert.deepEqual([...oldProjectIds(ps)].sort(), ['P-2', 'P-4']);
  const agents = [A('a1', 's-old2', { status: 'done', endedAt: NOW - 1e4 }), A('a2', 's-new3', { status: 'done', endedAt: NOW - 1e4 })];
  let m = buildModel({ ...base, projects: ps, sessions, agents });
  assert.ok(!m.byKey.has('s:s-old2') && !m.byKey.has('s:s-arch') && !m.byKey.has('a:a1'), 'retired sessions and their finished subagents are not drawn');
  assert.ok(m.byKey.has('s:s-new3') && m.byKey.has('s:s-live2') && m.byKey.has('a:a2'), 'the newest sibling and a live session stay');
  assert.equal(m.oldCount, 2);
  assert.deepEqual(m.pending.sessions.map((n) => n.id).sort(), ['s-arch', 's-new3', 's-old2'], 'hidden ones still count so acknowledge-all clears them');
  assert.ok(m.pending.agents.some((n) => n.id === 'a1' && n.hiddenOld));
  m = buildModel({ ...base, projects: ps, sessions, agents, showOld: true });
  assert.ok(m.byKey.has('s:s-old2') && m.byKey.has('a:a1'));
});

test('without a folder field the project name decides; different folders never match', () => {
  const a = P('P-5', 'same', { createdAt: 1 }), b = P('P-6', 'Same', { createdAt: 2 });
  assert.deepEqual([...oldProjectIds([a, b])], ['P-5']);
  const c = P('P-7', 'x', { folder: '/a', createdAt: 1 }), d = P('P-8', 'x', { folder: '/b', createdAt: 2 });
  assert.equal(oldProjectIds([c, d]).size, 0);
  assert.equal(pickKeep([a, b]).id, 'P-6');
  assert.equal(pickKeep([a, { ...b, createdAt: 3 }, P('P-9', 'same', { coordinator: true, createdAt: 0 })]).id, 'P-9');
});

test('more than 12 finished subagents per session: the newest 12 are drawn, the rest wait behind a chip and still count as pending', () => {
  const agents = Array.from({ length: 30 }, (_, i) => A(`a${i}`, 's-spoke', { status: 'done', endedAt: NOW - 1e4 - i * 1000 }));
  agents.push(A('live', 's-spoke'));
  const m = buildModel({ ...base, agents });
  const drawn = m.nodes.filter((n) => n.kind === 'agent');
  assert.equal(drawn.length, FINISHED_CAP + 1);
  assert.ok(m.byKey.has('a:a0') && !m.byKey.has('a:a29') && m.byKey.has('a:live'));
  assert.equal(m.byKey.get('s:s-spoke').more.length, 30 - FINISHED_CAP);
  assert.equal(m.pending.agents.length, 30, 'all of them are acknowledgeable at once');
});

test('ack bodies are split into chunks of at most 500 ids, nothing lost or repeated', () => {
  const ids = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const parts = splitAckBody({ agentIds: ids('a', 700), sessionIds: ids('s', 40), linkIds: ids('l', 300) });
  assert.equal(parts.length, 3);
  for (const p of parts) assert.ok((p.agentIds || []).length + (p.sessionIds || []).length + (p.linkIds || []).length <= 500);
  const all = parts.flatMap((p) => [...(p.agentIds || []), ...(p.sessionIds || []), ...(p.linkIds || [])]);
  assert.equal(all.length, 1040);
  assert.equal(new Set(all).size, 1040);
  assert.deepEqual(splitAckBody({}), []);
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

test('the project filter hides other spokes but never the main session', () => {
  const m = buildModel({ ...base, sessions: [...base.sessions, S('s-3', 'P-3')], scope: (pid) => pid === 'P-3' });
  assert.deepEqual(keys(m).sort(), ['s:s-3', 's:s-main']);
});

test('layout settles, stays finite, keeps the main node near the middle and starts a new branch at its parent', () => {
  const agents = Array.from({ length: 60 }, (_, i) => A(`a${i}`, i % 2 ? 's-spoke' : 's-main', { status: i % 3 ? 'stalled' : 'running', endedAt: NOW - 1e4 }));
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

test('the coordinator project is never old; a project is old when a newer or coordinator sibling for the same folder exists', () => {
  const ps = [P('P-1', 'Admin', { coordinator: true, folder: '/w/a', createdAt: 1 }), P('P-2', 'Admin new', { folder: '/w/a', createdAt: 9 }), P('P-3', 'Old one', { folder: '/w/b', createdAt: 1 }), P('P-4', 'Coord b', { folder: '/w/b', coordinator: true, createdAt: 0 })];
  assert.deepEqual([...oldProjectIds(ps)].sort(), ['P-2', 'P-3'], 'P-1 is the coordinator and stays; the others have a coordinator sibling');
});

test('folders match exactly like the hub; the name fallback only applies when a project has no folder', () => {
  const a = P('P-1', 'same', { folder: '/w/x', createdAt: 1 }), b = P('P-2', 'same', { folder: '/w/X', createdAt: 2 }), c = P('P-3', 'same', { folder: '/w/x/', createdAt: 3 });
  assert.equal(oldProjectIds([a, b, c]).size, 0, 'different folders never match, even with the same name');
  const d = P('P-4', 'same', { createdAt: 4 });
  assert.deepEqual([...oldProjectIds([a, d])], ['P-1'], 'one without a folder: the name decides');
});

test('an active or idle session is never retired, whatever its project; only ended ones are', () => {
  const ps = [P('P-1', 'Admin', { coordinator: true, folder: '/w/a', createdAt: 1 }), P('P-2', 'Dup', { folder: '/w/d', createdAt: 1, archived: true })];
  const sessions = [S('live', 'P-2'), S('idle', 'P-2', { status: 'idle' }), S('ended', 'P-2', { status: 'ended' }), S('main', 'P-1', { status: 'ended' })];
  assert.deepEqual([...retiredSessionIds(sessions, ps)], ['ended']);
  const m = buildModel({ ...base, projects: ps, sessions: [S('s-main', 'P-1'), ...sessions.filter((x) => x.id !== 'main')] });
  assert.ok(m.byKey.has('s:live') && m.byKey.has('s:idle') && !m.byKey.has('s:ended'));
});
