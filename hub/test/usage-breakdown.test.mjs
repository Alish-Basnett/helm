// Cost analytics: GET /v1/usage/breakdown — spend per day, project, model and task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest } from './helpers.mjs';

const at = (dayOffset, hour) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, hour).getTime(); };

test('usage breakdown: per day, project, model, task; window and clamping', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.hub.setClock(() => at(0, 12));
  h.send(
    h.ev('s1', 'session.started', { cwd: '/w/alpha', title: 'A', model: 'opus' }),
    h.ev('s2', 'session.started', { cwd: '/w/beta', title: 'B', model: 'opus' }),
  );
  const u = (sid, when, model, costUsd, extra = {}) =>
    h.ev(sid, 'helm.usage', { kind: 'note_turn', model, inputTokens: 100, outputTokens: 10, costUsd, ...extra }, when);
  h.send(
    u('s1', at(0, 9), 'opus-5-5', 1, { taskId: 'T-1' }),
    u('s1', at(0, 10), 'haiku-5-5', 0.25, { taskId: 'T-1' }),
    u('s2', at(-1, 9), 'opus-5-5', 2, { taskId: 'T-2' }),
    u('s1', at(-1, 10), 'haiku-5-5', 0.5),                 // no task
    u('s1', at(-30, 9), 'opus-5-5', 99, { taskId: 'T-9' }), // outside window
  );
  const r = (await h.get('/v1/usage/breakdown?days=7')).json;
  assert.equal(r.totalUsd, 3.75);
  assert.equal(r.perDay.length, 7);
  assert.equal(r.perDay.at(-1).costUsd, 1.25);
  assert.equal(r.perDay.at(-2).costUsd, 2.5);
  assert.deepEqual(r.perModel.map((m) => [m.model, m.costUsd, m.calls]), [['opus-5-5', 3, 2], ['haiku-5-5', 0.75, 2]]);
  assert.deepEqual(r.perTask.map((x) => [x.taskId, x.costUsd]), [['T-2', 2], ['T-1', 1.25]]);
  assert.equal(r.perProject.length, 2);
  assert.equal(r.perProject.reduce((a, p) => a + p.costUsd, 0), 3.75);
  assert.ok(r.perProject[0].costUsd >= r.perProject[1].costUsd, 'sorted by cost desc');
  assert.equal((await h.get('/v1/usage/breakdown?days=1')).json.perDay.length, 1);
  assert.equal((await h.get('/v1/usage/breakdown?days=500')).json.perDay.length, 90);
  assert.equal((await h.get('/v1/usage/breakdown')).json.perDay.length, 7);
});
