import test from 'node:test';
import assert from 'node:assert/strict';
import { startTargetText, needsStartConfirm, startTargetKey, moveTargets } from '../startqueue.js';

const live = { held: false, projectId: 'P-12', projectName: 'Trips', sessionId: 's1', sessionLabel: 'Trips app session' };
const held = { held: true, projectId: 'P-12', projectName: 'Trips', sessionId: null, sessionLabel: null };

test('the Start label names the project and the session, or says it will wait', () => {
  assert.equal(startTargetText('Start', live), 'Start in Trips · Trips app session');
  assert.equal(startTargetText('Resume', live), 'Resume in Trips · Trips app session');
  assert.equal(startTargetText('Start', held), 'Start in Trips · will wait for a session');
  assert.equal(startTargetText('Start', null), 'Start');
  assert.equal(startTargetText('Start', { held: false, projectName: 'Trips', sessionLabel: null }), 'Start in Trips · will wait for a session');
});

test('Start asks only when held, or when the project differs from the one on screen', () => {
  assert.equal(needsStartConfirm(held, 'all'), true);
  assert.equal(needsStartConfirm(held, 'P-12'), true);
  assert.equal(needsStartConfirm(live, 'all'), false, 'all projects: nothing to differ from');
  assert.equal(needsStartConfirm(live, 'P-12'), false);
  assert.equal(needsStartConfirm(live, 'P-10'), true);
  assert.equal(needsStartConfirm(live, undefined), false);
  assert.equal(needsStartConfirm(null, 'P-10'), false, 'no answer: start directly');
});

test('the cached target is keyed by the card and the live sessions of its project', () => {
  const t = { id: 'T-1', projectId: 'P-1', sessionId: null };
  const a = { id: 's1', projectId: 'P-1', status: 'active', title: 'A' };
  const k = startTargetKey(t, [a]);
  assert.notEqual(k, startTargetKey(t, [a, { id: 's2', projectId: 'P-1', status: 'idle', title: 'B' }]), 'a session joins');
  assert.notEqual(k, startTargetKey(t, [{ ...a, status: 'idle' }]), 'a session goes idle');
  assert.notEqual(k, startTargetKey({ ...t, projectId: 'P-2' }, [a]), 'the card moves');
  assert.equal(k, startTargetKey(t, [a, { id: 's9', projectId: 'P-2', status: 'active', title: 'X' }, { id: 's8', projectId: 'P-1', status: 'ended', title: 'Y' }]), 'other projects and ended sessions do not matter');
});

test('move targets: not archived, not the current project, coordinator first, then by name', () => {
  const ps = [
    { id: 'P-1', name: 'Trips' }, { id: 'P-2', name: 'Client' }, { id: 'P-3', name: 'Admin', coordinator: true },
    { id: 'P-4', name: 'Old', archived: true }, { id: 'P-5', name: 'KBank' },
  ];
  assert.deepEqual(moveTargets(ps, 'P-1').map((p) => p.name), ['Admin', 'Client', 'KBank']);
  assert.deepEqual(moveTargets(ps, 'P-3').map((p) => p.name), ['Client', 'KBank', 'Trips']);
});
