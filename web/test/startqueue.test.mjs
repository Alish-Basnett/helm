import test from 'node:test';
import assert from 'node:assert/strict';
import { isHeldStart, waitingText } from '../startqueue.js';

test('a start note is held only while queued with a project target', () => {
  assert.equal(isHeldStart({ state: 'queued', target: { kind: 'project', id: 'P-1' } }), true);
  assert.equal(isHeldStart({ state: 'queued', target: { kind: 'session', id: 's1' } }), false, 'delivered to a session');
  assert.equal(isHeldStart({ state: 'queued', target: { kind: 'task', id: 'T-1' } }), false, 'a delivered resume');
  assert.equal(isHeldStart({ state: 'failed', target: { kind: 'project', id: 'P-1' } }), false, 'cancelled or superseded');
  assert.equal(isHeldStart(null), false);
  assert.equal(isHeldStart({ state: 'queued' }), false);
});

test('the waiting text names the project', () => {
  assert.equal(waitingText('Trips'), 'Queued — waiting for a Trips session');
  assert.equal(waitingText(''), 'Queued — waiting for a session');
});
