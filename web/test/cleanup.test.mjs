// Board filter rule, session names, and the clean-up groups from the hub (v0.27 shapes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneFilter, taskMatches, sessionIdsOfTask, filterFromQuery, filterToQuery, sessionOptions, isActive } from '../boardfilter.js';
import { sessionLabel } from '../format.js';
import { state } from '../store.js';
import { normalizeGroups, dupCount } from '../cleanup.js';

const sessionsOf = (map) => (t) => new Set(map[t.id] || []);
const ctx = (archived = [], map = {}) => ({ projectArchived: (id) => archived.includes(id), sessionsOfTask: sessionsOf(map) });
const f = (o = {}) => ({ projects: [], sessions: [], archived: false, ...o });

test('board filter: default shows every non-archived project; Show archived adds the rest', () => {
  const t = { id: 'T-1', projectId: 'P-9' };
  assert.equal(taskMatches(t, f(), ctx(['P-9'])), false);
  assert.equal(taskMatches(t, f({ archived: true }), ctx(['P-9'])), true);
  assert.equal(taskMatches({ id: 'T-2', projectId: 'P-1' }, f(), ctx(['P-9'])), true);
});

test('board filter: a chosen project wins, even an archived one', () => {
  assert.equal(taskMatches({ id: 'T-1', projectId: 'P-9' }, f({ projects: ['P-9'] }), ctx(['P-9'])), true);
  assert.equal(taskMatches({ id: 'T-1', projectId: 'P-1' }, f({ projects: ['P-9'] }), ctx()), false);
});

test('board filter: a card matches a session through its own session, its creator, or the agents that worked on it', () => {
  const agents = new Map([['T-3', [{ sessionId: 's-worker' }]]]);
  const byId = (id) => (id === 'a-1' ? { sessionId: 's-assigned' } : null);
  assert.deepEqual([...sessionIdsOfTask({ id: 'T-1', sessionId: 's-own', createdBySessionId: 's-boss', agentId: 'a-1' }, agents, byId)].sort(), ['s-assigned', 's-boss', 's-own']);
  assert.deepEqual([...sessionIdsOfTask({ id: 'T-3', sessionId: null, agentId: null }, agents, byId)], ['s-worker']);
  const map = { 'T-1': ['s-own', 's-boss'], 'T-3': ['s-worker'] };
  assert.equal(taskMatches({ id: 'T-1', projectId: 'P-1' }, f({ sessions: ['s-boss'] }), ctx([], map)), true);
  assert.equal(taskMatches({ id: 'T-3', projectId: 'P-1' }, f({ sessions: ['s-boss'] }), ctx([], map)), false);
  assert.equal(taskMatches({ id: 'T-3', projectId: 'P-1' }, f({ sessions: ['s-boss', 's-worker'] }), ctx([], map)), true, 'any chosen session is enough');
  assert.equal(taskMatches({ id: 'T-9', projectId: 'P-1' }, f({ sessions: ['s-x'] }), ctx()), false, 'a card with no session never matches a session filter');
});

test('board filter: the choice round-trips through the URL query', () => {
  const x = f({ projects: ['P-1', 'P-2'], sessions: ['s-1'], archived: true });
  const q = new URLSearchParams(Object.entries(filterToQuery(x)).filter(([, v]) => v));
  assert.deepEqual(filterFromQuery(q), x);
  assert.equal(filterFromQuery(new URLSearchParams('task=T-1')), null);
  assert.deepEqual(filterToQuery(f()), { fp: null, fs: null, fa: null });
  assert.equal(isActive(f()), false);
});

test('board filter: session options come from the chosen projects, live ones first, chosen ones always stay', () => {
  const S = (id, projectId, status, seen) => ({ id, projectId, status, lastSeenAt: seen });
  const all = [S('a', 'P-1', 'ended', 9), S('b', 'P-1', 'active', 1), S('c', 'P-2', 'idle', 5), S('d', 'P-9', 'active', 7)];
  const arch = (id) => id === 'P-9';
  assert.deepEqual(sessionOptions(all, f(), arch).map((s) => s.id), ['c', 'b', 'a']);
  assert.deepEqual(sessionOptions(all, f({ projects: ['P-1'] }), arch).map((s) => s.id), ['b', 'a']);
  assert.deepEqual(sessionOptions(all, f({ projects: ['P-1'], sessions: ['c'] }), arch).map((s) => s.id), ['c', 'b', 'a']);
});

test('sessionLabel: the desktop app title first, then Helm\'s title, then the folder', () => {
  assert.equal(sessionLabel({ id: 's1', appTitle: 'Fix login', title: 'x', cwd: '/a/b' }), 'Fix login');
  assert.equal(sessionLabel({ id: 's1', appTitle: null, title: 'Helm title', cwd: '/a/b' }), 'Helm title');
  assert.equal(sessionLabel({ id: 's1', title: '', cwd: '/work/acme' }), '/work/acme');
  assert.equal(sessionLabel({ id: 's1' }), 's1');
  assert.equal(sessionLabel(null), '');
});

test('clean-up groups: keep the hub\'s recommendedKeep, carry its counts, drop archived and single-project groups', () => {
  state.projects.clear();
  for (const p of [{ id: 'P-1', name: 'fww', createdAt: 1 }, { id: 'P-2', name: 'fww', createdAt: 2 }, { id: 'P-3', name: 'fww', createdAt: 3, archived: true }, { id: 'P-4', name: 'solo', createdAt: 4 }]) state.projects.set(p.id, p);
  const groups = normalizeGroups({ groups: [
    { folder: '/w/fww', suggestedTarget: 'P-2', recommendedKeep: 'P-1', projects: [{ id: 'P-1', liveSessions: 1, tasks: 4, openTasks: 2 }, { id: 'P-2', tasks: 0 }, { id: 'P-3' }] },
    { folder: '/w/solo', recommendedKeep: 'P-4', projects: [{ id: 'P-4' }, { id: 'P-3' }] },
  ] });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keepId, 'P-1', 'recommendedKeep, not suggestedTarget');
  assert.deepEqual(groups[0].projects.map((p) => p.id), ['P-1', 'P-2']);
  assert.equal(groups[0].projects[0].openTasks, 2);
  assert.equal(dupCount(groups), 1);
  assert.deepEqual(normalizeGroups(null), []);
});

test('board filter: ids that no longer exist are dropped; when nothing valid is left it says the filter was cleared', () => {
  const has = (set) => (id) => set.includes(id);
  const r = pruneFilter(f({ projects: ['P-1', 'P-gone'], sessions: ['s-gone'] }), has(['P-1']), has([]));
  assert.deepEqual(r.filter, f({ projects: ['P-1'] }));
  assert.equal(r.changed, true);
  assert.equal(r.cleared, false);
  const all = pruneFilter(f({ projects: ['P-gone'], sessions: ['s-gone'] }), has([]), has([]));
  assert.equal(all.cleared, true);
  assert.equal(pruneFilter(f({ projects: ['P-1'] }), has(['P-1']), has([])).changed, false);
});
