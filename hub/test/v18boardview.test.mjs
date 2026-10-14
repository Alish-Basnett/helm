// Board View (T-67): grouping, filtering, sorting and saved views are pure; the context menu's geometry and keyboard
// helpers are pure too. No DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultView, normalizeView, isDefaultView, viewsEqual, activeFilterCount, filterTasks, sortTasks, groupTasks, laneOf,
  canDropAcross, laneStatuses, projectCount, normalizeSaved, saveView, removeView, matchingView, describeView,
} from '../../web/boardview.js';
import { normalizeItems, clampToViewport, submenuOrigin, stepIndex, typeAheadIndex } from '../../web/contextmenu.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const T = (id, o = {}) => ({ id, projectId: 'P-1', status: 'next', order: 1, createdAt: 1, updatedAt: 1, agentId: null, ...o });
const manual = (a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id));
const agents = { A1: { id: 'A1', model: 'claude-opus-4' }, A2: { id: 'A2', model: 'claude-sonnet-4' }, A3: { id: 'A3', model: 'claude-haiku-4' } };
const ctx = {
  agent: (t) => (t.agentId ? agents[t.agentId] || null : null),
  model: (a) => { const m = a.model; return m.includes('opus') ? { key: 'opus', label: 'Opus' } : m.includes('sonnet') ? { key: 'sonnet', label: 'Sonnet' } : m.includes('haiku') ? { key: 'haiku', label: 'Haiku' } : { key: 'other', label: m }; },
  needs: (t) => !!t.needs,
  projectName: (id) => ({ 'P-1': 'Helm', 'P-2': 'ClearFlow', 'P-3': 'Alpha' }[id]),
  projectOrder: ['P-1', 'P-2', 'P-3'],
};

test('normalizeView repairs junk and defaults are recognised', () => {
  assert.deepEqual(normalizeView(null), defaultView());
  assert.deepEqual(normalizeView({ group: 'bogus', sort: 7, projects: ['a', 'a', 3, ''], statuses: 'x', needs: 'yes' }),
    { ...defaultView(), projects: ['a'] });
  assert.ok(isDefaultView({}));
  assert.ok(!isDefaultView({ group: 'project' }));
  assert.ok(viewsEqual({ projects: ['a', 'b'] }, { projects: ['b', 'a'] }));
});

test('filters combine with AND; empty lists mean no restriction', () => {
  const ts = [T('T-1', { agentId: 'A1' }), T('T-2', { projectId: 'P-2', needs: true }), T('T-3', { status: 'done', agentId: 'A2', needs: true }), T('T-4')];
  const ids = (v) => filterTasks(ts, v, ctx).map((t) => t.id);
  assert.deepEqual(ids({}), ['T-1', 'T-2', 'T-3', 'T-4']);
  assert.deepEqual(ids({ projects: ['P-2'] }), ['T-2']);
  assert.deepEqual(ids({ statuses: ['done', 'next'], hasAgent: true }), ['T-1', 'T-3']);
  assert.deepEqual(ids({ needs: true }), ['T-2', 'T-3']);
  assert.deepEqual(ids({ needs: true, hasAgent: true, statuses: ['done'] }), ['T-3']);
  assert.equal(activeFilterCount({ needs: true, hasAgent: true, projects: ['a'], statuses: [] }), 3);
});

test('sort: needs-you cards stay first; newest/updated order the rest; manual breaks ties', () => {
  const ts = [T('T-1', { order: 2, createdAt: 10, updatedAt: 50 }), T('T-2', { order: 1, createdAt: 30, updatedAt: 20 }), T('T-3', { order: 3, createdAt: 20, updatedAt: 90, needs: true })];
  const ids = (s) => sortTasks(ts, s, manual, ctx).map((t) => t.id);
  assert.deepEqual(ids('manual'), ['T-3', 'T-2', 'T-1']);
  assert.deepEqual(ids('newest'), ['T-3', 'T-2', 'T-1']);
  assert.deepEqual(ids('updated'), ['T-3', 'T-1', 'T-2']);
  assert.deepEqual(ts.map((t) => t.id), ['T-1', 'T-2', 'T-3'], 'input is not mutated');
});

test('group by project: lanes follow the project order, empty lanes are not made', () => {
  const ts = [T('T-1', { projectId: 'P-3' }), T('T-2', { projectId: 'P-2' }), T('T-3', { projectId: 'P-3' })];
  const g = groupTasks(ts, 'project', ctx);
  assert.deepEqual(g.map((l) => [l.key, l.label, l.tasks.map((t) => t.id)]), [['p:P-2', 'ClearFlow', ['T-2']], ['p:P-3', 'Alpha', ['T-1', 'T-3']]]);
  assert.equal(projectCount(ts), 2);
});

test('group by agent: opus, sonnet, haiku, then other models, with "No agent" last', () => {
  agents.A4 = { id: 'A4', model: 'gpt-x' };
  const ts = [T('T-1'), T('T-2', { agentId: 'A3' }), T('T-3', { agentId: 'A1' }), T('T-4', { agentId: 'A4' }), T('T-5', { agentId: 'A2' }), T('T-6', { agentId: 'GONE' })];
  const g = groupTasks(ts, 'agent', ctx);
  assert.deepEqual(g.map((l) => l.label), ['Opus', 'Sonnet', 'Haiku', 'gpt-x', 'No agent']);
  assert.deepEqual(g[4].tasks.map((t) => t.id), ['T-1', 'T-6']);
  assert.equal(laneOf(T('x'), 'status', ctx), null);
});

test('group none is one flat lane; status grouping is not lane-based', () => {
  const ts = [T('T-1'), T('T-2')];
  assert.deepEqual(groupTasks(ts, 'none', ctx).map((l) => [l.key, l.tasks.length]), [['all', 2]]);
  assert.equal(groupTasks(ts, 'status', ctx).length, 1);
  assert.deepEqual(groupTasks([], 'project', ctx), []);
});

test('drops are allowed only inside one lane (the hub cannot move a task between projects)', () => {
  assert.ok(canDropAcross('p:P-1', 'p:P-1'));
  assert.ok(!canDropAcross('p:P-1', 'p:P-2'));
  assert.ok(canDropAcross(null, undefined));
});

test('lane columns: the five main ones, plus Later / Blocked only when used, minus filtered-out statuses', () => {
  const main = ['backlog', 'next', 'in_progress', 'review', 'done'];
  assert.deepEqual(laneStatuses([T('a', { status: 'later' })], main, ['later', 'blocked']), [...main, 'later']);
  assert.deepEqual(laneStatuses([], main, ['later', 'blocked'], ['next', 'later']), ['next']);
});

test('saved views: names are unique case-insensitively, capped, and match by content', () => {
  let list = saveView([], '  Review   day ', { group: 'project', needs: true });
  assert.equal(list[0].name, 'Review day');
  list = saveView(list, 'review DAY', { group: 'agent' });
  assert.equal(list.length, 1);
  assert.equal(list[0].view.group, 'agent');
  assert.equal(matchingView(list, { group: 'agent' }).name, 'review DAY');
  assert.equal(matchingView(list, { group: 'none' }), null);
  assert.deepEqual(saveView(list, '   ', {}), list);
  assert.deepEqual(removeView(list, 'REVIEW day'), []);
  assert.equal(normalizeSaved([{ name: 'a' }, { name: 'A' }, null, { name: '' }, 'x']).length, 1);
  let big = [];
  for (let i = 0; i < 20; i++) big = saveView(big, `v${i}`, {});
  assert.equal(big.length, 12);
  assert.equal(describeView({ group: 'project', sort: 'newest', needs: true }), 'Project · Newest · 1 filter');
});

/* ---------- context menu helpers ---------- */
test('normalizeItems drops falsy entries and tidies dividers and orphan headings', () => {
  const out = normalizeItems([{ divider: true }, false, { label: 'A' }, { divider: true }, { divider: true }, null, { heading: 'H' }, { divider: true }, { label: 'B' }, { divider: true }]);
  assert.deepEqual(out.map((i) => i.label || '-'), ['A', '-', 'B']);
});
test('normalizeItems: a heading with nothing under it is removed', () => {
  assert.deepEqual(normalizeItems([{ label: 'A' }, { heading: 'H' }]).map((i) => i.label), ['A']);
});

test('menu placement stays inside the viewport and flips when there is no room', () => {
  assert.deepEqual(clampToViewport({ x: 100, y: 100, w: 200, h: 300, vw: 1000, vh: 800 }), { left: 100, top: 100 });
  assert.deepEqual(clampToViewport({ x: 950, y: 700, w: 200, h: 300, vw: 1000, vh: 800 }), { left: 750, top: 400 });
  const tiny = clampToViewport({ x: 5, y: 5, w: 900, h: 900, vw: 400, vh: 400 });
  assert.ok(tiny.left >= 8 && tiny.top >= 8);
  const sm = submenuOrigin({ rect: { left: 700, right: 900, top: 100 }, w: 200, h: 100, vw: 1000, vh: 800 });
  assert.ok(sm.left + 200 <= 1000 - 8, 'flips left of the parent when the right side overflows');
  const low = submenuOrigin({ rect: { left: 100, right: 300, top: 780 }, w: 200, h: 200, vw: 1000, vh: 800 });
  assert.ok(low.top + 200 <= 800 - 8);
});

test('arrow stepping skips disabled rows and wraps; type-ahead cycles by first letter', () => {
  const en = [true, false, true, true];
  assert.equal(stepIndex(en, -1, 1), 0);
  assert.equal(stepIndex(en, 0, 1), 2);
  assert.equal(stepIndex(en, 3, 1), 0);
  assert.equal(stepIndex(en, 0, -1), 3);
  assert.equal(stepIndex(en, -1, -1), 3);
  assert.equal(stepIndex([false, false], 0, 1), -1);
  const labels = ['Open', 'Start', 'Chat', 'Copy ID', 'Copy link'];
  const all = labels.map(() => true);
  assert.equal(typeAheadIndex(labels, all, -1, 'c'), 2);
  assert.equal(typeAheadIndex(labels, all, 2, 'c'), 3);
  assert.equal(typeAheadIndex(labels, all, 3, 'copy l'), 4);
  assert.equal(typeAheadIndex(labels, all, 0, 'zz'), -1);
  assert.equal(typeAheadIndex(labels, [true, true, false, true, true], -1, 'ch'), -1);
});

test('web sources for the menu and the board view never use innerHTML', () => {
  for (const f of ['contextmenu.js', 'taskmenu.js', 'boardview.js', 'views/board.js']) {
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(fs.readFileSync(path.join(root, f), 'utf8')), f);
  }
});

// T-96: the Auto toggle and its xN picker must show in every Up next header, whatever the grouping.
import { autoHeader } from '../../web/boardview.js';
const PIDS = ['P-1', 'P-2', 'P-3'];
const hdr = (o) => autoHeader({ projectIds: PIDS, ...o });

test('autoHeader: status grouping shows a switch for a selected project, a picker for All projects', () => {
  assert.deepEqual(hdr({ group: 'status', scopeProjectId: 'P-2' }), { kind: 'switch', projectId: 'P-2' });
  assert.deepEqual(hdr({ group: 'status' }), { kind: 'picker', projectIds: PIDS });
  assert.deepEqual(hdr({ group: 'status', filterProjects: ['P-3'] }), { kind: 'switch', projectId: 'P-3' });
  assert.deepEqual(hdr({ group: 'status', filterProjects: ['P-1', 'P-3'] }), { kind: 'picker', projectIds: ['P-1', 'P-3'] });
  assert.deepEqual(autoHeader({ group: 'status', projectIds: ['P-9'] }), { kind: 'switch', projectId: 'P-9' }, 'the only project');
});

test('autoHeader: every project lane gets a switch bound to its own project, in All projects too', () => {
  for (const scope of [undefined, 'P-1', 'P-2']) {
    for (const id of PIDS) {
      assert.deepEqual(hdr({ group: 'project', scopeProjectId: scope, laneProjectIds: [id, id] }), { kind: 'switch', projectId: id });
    }
  }
});

test('autoHeader: agent lanes show a switch for a one-project lane and a picker for a mixed lane', () => {
  assert.deepEqual(hdr({ group: 'agent', laneProjectIds: ['P-2'] }), { kind: 'switch', projectId: 'P-2' });
  assert.deepEqual(hdr({ group: 'agent', laneProjectIds: ['P-1', 'P-2', 'P-1'] }), { kind: 'picker', projectIds: ['P-1', 'P-2'] });
});

test('autoHeader: the flat list has no Up next column, and no projects means nothing to control', () => {
  assert.deepEqual(hdr({ group: 'none', scopeProjectId: 'P-1' }), { kind: 'none' });
  assert.deepEqual(autoHeader({ group: 'status', projectIds: [] }), { kind: 'none' });
  assert.deepEqual(hdr({ group: 'project', laneProjectIds: ['P-gone'] }), { kind: 'none' }, 'archived or unknown project');
});

test('autoHeader: wherever an Up next column shows, some Auto control shows (matrix)', () => {
  for (const group of ['status', 'project', 'agent']) {
    for (const scopeProjectId of [undefined, 'P-1']) {
      for (const laneProjectIds of [['P-1'], ['P-1', 'P-2']]) {
        const r = hdr({ group, scopeProjectId, laneProjectIds });
        assert.ok(r.kind === 'switch' || r.kind === 'picker', `${group}/${scopeProjectId}/${laneProjectIds}`);
      }
    }
  }
});

test('board.js builds the Auto controls for the Status column and for every lane Up next column', () => {
  const src = fs.readFileSync(path.join(root, 'views/board.js'), 'utf8');
  assert.match(src, /function buildAutoControls\(/);
  assert.match(src, /attachAutoControls\(cols\[status\]\)/, 'status column');
  assert.match(src, /status === 'next'\) \{[^}]*buildAutoControls\(\)/s, 'lane column');
  assert.match(src, /cr\.auto\.update\(autoSpec\(view\.group, lane\.tasks\)\)/, 'lane update');
});
