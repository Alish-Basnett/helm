import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTest, asSession } from './helpers.mjs';

// v0.28.1: a note to the coordinator is filed for the dashboard unless it is an ask; replies to the coordinator are not injected.

async function three(h) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/alpha', title: 'Alpha main', model: 'opus' }));
  h.send(h.ev('s2', 'session.started', { cwd: '/w/beta', title: 'Beta main', model: 'opus' }));
  h.send(h.ev('s3', 'session.started', { cwd: '/w/gamma', title: 'Gamma main', model: 'opus' }));
  await h.api('POST', '/v1/projects/P-1/coordinator', { on: true });
}
const inbox = (h, sid) => h.hub.claimInbox(sid).notes;
const who = async (h, sid) => ((h._as ??= {})[sid] ??= await asSession(h, sid));
const note = async (h, from, to, text, extra = {}) => (await who(h, from))('POST', '/v1/links', { kind: 'note', to, text, ...extra });
const FILED = 'Filed for the dashboard: not sent to the coordinator session (no ask).';

test('a spoke note to the coordinator without ask is filed, not sent', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await three(h);
  const r = await note(h, 's2', 'alpha', 'fyi: done');
  assert.equal(r.status, 201);
  const l = r.json.link;
  assert.equal(l.state, 'answered');
  assert.equal(l.reply, FILED);
  assert.equal(l.refId, null);
  assert.equal(l.toSessionId, null);
  assert.equal(l.deliveredAt, l.answeredAt);
  assert.ok(l.deliveredAt > 0);
  assert.deepEqual(inbox(h, 's1'), []);
  assert.equal(h.state().notes.filter((n) => n.linkId).length, 0, 'no session note exists');
  assert.equal((await note(h, 's2', 'alpha', 'again', { ask: false })).json.link.state, 'answered', 'ask:false is the same as absent');
  h.hub.deliverLinks();
  assert.deepEqual(inbox(h, 's1'), []);
});

test('with ask:true the note is delivered as before', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await three(h);
  const r = await note(h, 's2', 'alpha', 'need a decision', { ask: true });
  assert.equal(r.json.link.state, 'delivered');
  assert.equal(r.json.link.toSessionId, 's1');
  const [n] = inbox(h, 's1');
  assert.match(n.text, /need a decision$/);
  assert.equal(n.linkId, r.json.link.id);
});

test('a reply to a note the coordinator sent is stored but not injected back', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await three(h);
  await note(h, 's1', 'beta', 'are the tests green?');
  const [n] = inbox(h, 's2');
  h.send(h.ev('s2', 'note.reply', { noteId: n.id, text: 'all green' }));
  const l = h.state().links[0];
  assert.equal(l.state, 'answered');
  assert.equal(l.reply, 'all green');
  assert.deepEqual(inbox(h, 's1'), []);
});

test('notes between non-coordinator senders and targets behave as before', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await three(h);
  assert.equal((await note(h, 's2', 'gamma', 'x', { ask: true })).status, 403, 'spoke to spoke is still refused');
  const c = await note(h, 's1', 'gamma', 'ping');
  assert.equal(c.json.link.state, 'delivered', 'ask is ignored for a non-coordinator target');
  const [n] = inbox(h, 's3');
  h.send(h.ev('s3', 'note.reply', { noteId: n.id, text: 'pong' }));
  // a spoke sender is still told of the reply
  await note(h, 's2', 'alpha', 'question', { ask: true });
  const [q] = inbox(h, 's1');
  h.send(h.ev('s1', 'note.reply', { noteId: q.id, text: 'yes' }));
  const back = inbox(h, 's2');
  assert.equal(back.length, 1);
  assert.match(back[0].text, /Reply to your note L-2 /);
});

test('a "Not delivered:" reply still reaches the coordinator', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await three(h);
  await note(h, 's1', 'beta', 'one');
  const [n] = inbox(h, 's2');
  h.send(h.ev('s2', 'note.result', { noteId: n.id, ok: false, via: null, error: 'engine said no' }));
  const back = inbox(h, 's1');
  assert.equal(back.length, 1);
  assert.match(back[0].text, /Reply to your note L-1 .*Not delivered: engine said no/);
});

test('rebuild reproduces quiet notes and silent replies exactly', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await three(h);
  await note(h, 's2', 'alpha', 'fyi');
  await note(h, 's1', 'beta', 'question');
  const [n] = inbox(h, 's2');
  h.send(h.ev('s2', 'note.reply', { noteId: n.id, text: 'answer' }));
  await note(h, 's3', 'alpha', 'ask', { ask: true });
  const before = h.hub.dump();
  const stateBefore = h.state();
  assert.equal(before.links.length, 3);
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
});

test('ask must be a boolean', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await three(h);
  for (const ask of ['true', 1, null, {}]) {
    const r = await note(h, 's2', 'alpha', 'x', { ask });
    assert.equal(r.status, 400, JSON.stringify(ask));
  }
  assert.equal(h.state().links.length, 0);
});

test('a filed note keeps its full text; a delivered link text stays cut at 200', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await three(h);
  const long = 'word '.repeat(380).trim();
  const q = await note(h, 's2', 'alpha', long);
  assert.equal(q.json.link.text, long);
  assert.equal(h.state().links[0].text.length, long.length);
  const d = await note(h, 's2', 'alpha', long, { ask: true });
  assert.equal(d.json.link.text.length, 200);
});

test('a coordinator note with ask:true gets its reply injected; without ask it does not', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await three(h);
  const a = await note(h, 's1', 'beta', 'do you have the answer?', { ask: true });
  assert.equal(a.json.link.state, 'delivered');
  const [n] = inbox(h, 's2');
  h.send(h.ev('s2', 'note.reply', { noteId: n.id, text: 'yes, 42' }));
  const back = inbox(h, 's1');
  assert.equal(back.length, 1);
  assert.match(back[0].text, /Reply to your note L-1 .*yes, 42/);
  await note(h, 's1', 'gamma', 'fyi only');
  const [m] = inbox(h, 's3');
  h.send(h.ev('s3', 'note.reply', { noteId: m.id, text: 'ok' }));
  assert.deepEqual(inbox(h, 's1'), []);
  assert.equal(h.state().links[1].reply, 'ok');
  // a spoke's ask:true does not set wantReply (the coordinator never replies-to-itself path)
  assert.equal((await note(h, 's2', 'alpha', 'q', { ask: true })).status, 201);
});

test('rebuild reproduces want_reply and the full filed text exactly', async (t) => {
  const h = await startTest(); t.after(h.stop);
  await three(h);
  await note(h, 's1', 'beta', 'wanted', { ask: true });
  await note(h, 's1', 'gamma', 'not wanted');
  await note(h, 's2', 'alpha', 'long '.repeat(300));
  for (const [sid, id] of [['s2', 's2'], ['s3', 's3']]) {
    const [n] = inbox(h, sid);
    h.send(h.ev(sid, 'note.reply', { noteId: n.id, text: 'r' }));
  }
  const before = h.hub.dump();
  const stateBefore = h.state();
  assert.deepEqual(before.links.map((l) => l.want_reply ?? null), [1, null, null]);
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
  assert.equal(inbox(h, 's1').length, 1, 'only the wanted reply was injected');
});
