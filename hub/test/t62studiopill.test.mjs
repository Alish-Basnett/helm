// T-62: pure logic of the floating Studio pill (status, counts, persisted state, preview scale).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pillStatus, applicableCount, shortTitle, cleanPillState, paperScale, A4_PX } from '../../web/studio/pillmodel.js';

const C = (id, state, jobId = null) => ({ id, state, jobId });
const doc = { id: 'D-1', title: 'T' };

test('applicableCount: open and conflict comments only', () => {
  assert.equal(applicableCount([C('1', 'open'), C('2', 'conflict'), C('3', 'applied'), C('4', 'queued'), C('5', 'orphaned')]), 2);
  assert.equal(applicableCount(null), 0);
});

test('pillStatus: saved, editing, conflicts, missing', () => {
  assert.equal(pillStatus({ doc, comments: [C('1', 'open')] }).kind, 'saved');
  assert.equal(pillStatus({ doc, dirty: true }).kind, 'editing');
  const s = pillStatus({ doc, comments: [C('1', 'conflict'), C('2', 'conflict')] });
  assert.deepEqual([s.kind, s.label], ['conflicts', '2 conflicts']);
  assert.equal(pillStatus({ doc, comments: [C('1', 'conflict')] }).label, '1 conflict');
  assert.equal(pillStatus({}).kind, 'missing');
});

test('pillStatus: drafting from the newest doc_draft job (hub docs only)', () => {
  const jobs = new Map([['J-1', { id: 'J-1', kind: 'doc_draft', state: 'running', input: { docId: 'D-1' }, createdAt: '2026-01-01' }]]);
  assert.equal(pillStatus({ doc, jobs }).kind, 'drafting');
  assert.equal(pillStatus({ doc: { id: 'L-1' }, jobs }).kind, 'saved');
  jobs.get('J-1').state = 'done';
  assert.equal(pillStatus({ doc, jobs }).kind, 'saved');
});

test('pillStatus: applying n/m counts the batch of the first queued comment', () => {
  const s = pillStatus({ doc, comments: [C('1', 'queued', 'J-9'), C('2', 'queued', 'J-9'), C('3', 'applied', 'J-9'), C('4', 'applied', 'J-2')] });
  assert.deepEqual([s.kind, s.label, s.n, s.m, s.busy], ['applying', 'Applying 1/3', 1, 3, true]);
  assert.equal(pillStatus({ doc, comments: [C('1', 'queued')], dirty: true }).label, 'Applying 0/1'); // applying wins over editing
});

test('shortTitle: trims, collapses spaces, ellipsises, falls back', () => {
  assert.equal(shortTitle('  Quarterly   plan '), 'Quarterly plan');
  assert.equal(shortTitle('A very long document title here', 12), 'A very long…');
  assert.equal(shortTitle(''), 'Untitled');
  assert.equal(shortTitle(null), 'Untitled');
});

test('cleanPillState: keeps a valid id, minimised wins over open, junk becomes closed', () => {
  assert.deepEqual(cleanPillState({ docId: 'D-3', open: true }), { docId: 'D-3', open: true, minimised: false });
  assert.deepEqual(cleanPillState({ docId: 'L-2', open: true, minimised: true }), { docId: 'L-2', open: false, minimised: true });
  assert.deepEqual(cleanPillState({ docId: '<img onerror>', open: true }), { docId: null, open: false, minimised: false });
  assert.deepEqual(cleanPillState([]), { docId: null, open: false, minimised: false });
  assert.deepEqual(cleanPillState(undefined), { docId: null, open: false, minimised: false });
});

test('paperScale: fits A4 into the pane, never above 1 or below 0.2', () => {
  assert.equal(paperScale(2000), 1);
  assert.ok(Math.abs(paperScale(400) - (376 / A4_PX)) < 1e-9);
  assert.equal(paperScale(10), 0.2);
  assert.equal(paperScale(NaN), 1);
});
