// Store: the hub's abilities (acknowledge, main project) are learned from rows the hub sent, never from our own optimistic patches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { state, applyChange, upsert, normalizeRow } from '../store.js';

test('an optimistic local upsert never flips caps.ack; a row from the hub does', () => {
  state.caps.ack = false;
  upsert('session', { id: 's1', projectId: 'P-1', acknowledgedAt: Date.now() }); // our own patch
  assert.equal(state.caps.ack, false);
  normalizeRow('agent', { id: 'a1', acknowledgedAt: 5 });
  assert.equal(state.caps.ack, false, 'normalizing does not teach us anything either');
  applyChange({ entity: 'agent', op: 'upsert', row: { id: 'a1', sessionId: 's1', status: 'done', acknowledgedAt: null } });
  assert.equal(state.caps.ack, true);
});

test('rows from a hub that predates the feature get safe defaults and leave caps alone', () => {
  state.caps.ack = false; state.caps.coordinator = false;
  const s = normalizeRow('session', { id: 's2' });
  const a = normalizeRow('agent', { id: 'a2' });
  const p = normalizeRow('project', { id: 'P-9' });
  assert.deepEqual([s.acknowledgedAt, s.coordinator, a.acknowledgedAt, a.parentId, p.coordinator], [null, false, null, null, false]);
  assert.deepEqual(state.caps, { ack: false, coordinator: false });
});

test('a project row carrying `coordinator` from the hub turns the main-project picker on', () => {
  state.caps.coordinator = false;
  applyChange({ entity: 'project', op: 'upsert', row: { id: 'P-1', name: 'Admin', coordinator: true } });
  assert.equal(state.caps.coordinator, true);
});
