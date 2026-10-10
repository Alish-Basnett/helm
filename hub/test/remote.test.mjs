// Phone access: opt-in, token-protected LAN listener (hub/remote.mjs). The listener binds 127.0.0.1 on an ephemeral
// port in tests (never 0.0.0.0); everything else is the production code path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { startTest, rawRequest, openStream, sockRequest } from './helpers.mjs';
import { startHub } from '../server.mjs';
import { loadConfig } from '../config.mjs';
import { tokenEquals, lanAddresses, RATE_LIMIT, MAX_FAILS } from '../remote.mjs';
import { qrMatrix } from '../../web/qr.js';

const T = { remoteHost: '127.0.0.1', remotePort: 0 };
const start = (over = {}) => startTest({ ...T, ...over });
const enable = async (h) => {
  const r = await h.api('POST', '/v1/remote', { enabled: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.enabled, true);
  return { port: r.json.port, token: r.json.token, status: r.json };
};
const bearer = (token, extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const call = (port, method, p, headers = {}, body) =>
  rawRequest(port, { method, path: p, headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined });
const connects = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

async function world(h) {
  h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'opus' }));
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 't1', subagentType: 'b', model: 'sonnet', description: 'Refactor auth', prompt: '' }));
  h.send(h.ev('s1', 'agent.completed', { agentId: 'a1', ok: true, summary: 'done' }));
}

test('phone access defaults: off, port 7778 on all interfaces, nothing written', async (t) => {
  const cfg = loadConfig({ home: '/tmp/x-helm' }, {});
  assert.equal(cfg.remotePort, 7778);
  assert.equal(cfg.remoteHost, '0.0.0.0');
  assert.equal(loadConfig({ home: '/tmp/x-helm' }, { HELM_REMOTE_PORT: '7999' }).remotePort, 7999);
  const h = await start(); t.after(h.stop);
  const r = await h.get('/v1/remote');
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false);
  assert.equal(r.json.token, null, 'no token is revealed while off');
  assert.equal(fs.existsSync(path.join(h.home, 'remote.json')), false);
  assert.equal(h.servers.length, 2, 'only the unix socket and the loopback TCP listener');
});

test('enabling requires loopback: not reachable through the phone listener, nor with a foreign Host/Origin', async (t) => {
  const h = await start(); t.after(h.stop);
  // foreign Host / Origin / cross-site on the main listener: the existing guards still refuse
  assert.equal((await rawRequest(h.port, { method: 'POST', path: '/v1/remote', headers: { host: 'evil.example', 'content-type': 'application/json' }, body: '{"enabled":true}' })).status, 403);
  assert.equal((await rawRequest(h.port, { method: 'POST', path: '/v1/remote', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{"enabled":true}' })).status, 403);
  assert.equal((await rawRequest(h.port, { method: 'POST', path: '/v1/remote', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{"enabled":true}' })).status, 403);
  assert.equal(h.remote.status().enabled, false);
  assert.equal((await h.api('POST', '/v1/remote', { enabled: 'yes' })).status, 400);

  const { port, token } = await enable(h);
  // the phone listener never routes /v1/remote, even with a valid token
  for (const m of ['GET', 'POST']) {
    const r = await call(port, m, '/v1/remote', bearer(token, m === 'POST' ? { 'content-type': 'application/json' } : {}), m === 'POST' ? '{"enabled":false}' : undefined);
    assert.equal(r.status, 403, `${m} /v1/remote through the phone listener`);
  }
  assert.equal(h.remote.status().enabled, true, 'still on');
  // the unix socket (the mod) counts as local too
  assert.equal((await sockRequest(h.cfg.sockFile, 'GET', '/v1/remote')).json.enabled, true);
});

test('token required: none or wrong is 401, bearer and cookie work, page shell is public', async (t) => {
  const h = await start(); t.after(h.stop);
  await world(h);
  const { port, token } = await enable(h);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');

  assert.equal((await call(port, 'GET', '/v1/state')).status, 401);
  const wrong = await call(port, 'GET', '/v1/state', bearer('x'.repeat(43)));
  assert.equal(wrong.status, 401);
  assert.equal(JSON.parse(wrong.text).error, 'unauthorized');
  assert.equal((await call(port, 'GET', '/v1/state', { authorization: `Basic ${token}` })).status, 401);
  assert.equal((await call(port, 'GET', '/v1/state', { cookie: 'helm_k=nope' })).status, 401);

  const ok = await call(port, 'GET', '/v1/state', bearer(token));
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(ok.text)).sort(), ['notes', 'projects', 'seq', 'sessions', 'tasks']);
  const viaCookie = await call(port, 'GET', '/v1/state', { cookie: `a=b; helm_k=${encodeURIComponent(token)}` });
  assert.equal(viaCookie.status, 200);

  // the shell (code only) loads before the page can read the hash; it carries no data
  for (const p of ['/m', '/m/', '/m/index.html', '/m/m.js', '/m/m.css']) assert.equal((await call(port, 'GET', p)).status, 200, p);
  assert.match((await call(port, 'GET', '/m/m.js')).headers['content-type'], /javascript/);
});

test('tokenEquals is exact and length-safe', () => {
  assert.equal(tokenEquals('abc', 'abc'), true);
  assert.equal(tokenEquals('abc', 'abd'), false);
  assert.equal(tokenEquals('abc', 'abcd'), false);
  assert.equal(tokenEquals('', ''), false);
  assert.equal(tokenEquals(undefined, 'abc'), false);
});

test('a route outside the allow-list gets 403, with or without the token', async (t) => {
  const h = await start(); t.after(h.stop);
  await world(h);
  const { port, token } = await enable(h);
  const auth = bearer(token, { 'content-type': 'application/json' });
  const deny = [
    ['GET', '/v1/health'], ['POST', '/v1/events'], ['GET', '/v1/tasks'], ['GET', '/v1/tasks/T-1'], ['PATCH', '/v1/tasks/T-1'],
    ['POST', '/v1/tasks/T-1/start'], ['POST', '/v1/projects'], ['POST', '/v1/notes/execute'], ['DELETE', '/v1/notes/N-1'],
    ['GET', '/v1/search?q=a'], ['GET', '/v1/sessions/s1/inbox'], ['GET', '/v1/usage'], ['POST', '/v1/digest'],
    ['GET', '/'], ['GET', '/app.js'], ['GET', '/styles.css'], ['GET', '/mm'], ['GET', '/m/sub/x'],
    ['GET', '/m/..%2fapp.js'], ['GET', '/m/%2e%2e/app.js'], ['GET', '/m/..\\app.js'],
    ['DELETE', '/v1/attachments/A-1'], ['PUT', '/v1/tasks'], ['OPTIONS', '/v1/state'],
  ];
  for (const [m, p] of deny) {
    const withTok = await call(port, m, p, auth, m === 'POST' || m === 'PATCH' ? {} : undefined);
    assert.equal(withTok.status, 403, `${m} ${p} with token`);
    const noTok = await call(port, m, p);
    assert.equal(noTok.status, 403, `${m} ${p} without token`);
  }
  // unknown /m file: allowed path shape, but nothing there (and no SPA fallback to the main app)
  const missing = await call(port, 'GET', '/m/nothing-here', bearer(token));
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.text, /id="app"/);
});

test('allowed routes work end to end: task + start, note + reply, attachment, filtered state, redacted stream', async (t) => {
  const h = await start(); t.after(h.stop);
  await world(h);
  const { port, token } = await enable(h);
  const auth = bearer(token);
  const pid = h.state().projects[0].id;

  // add a task, then add & start
  const plain = await call(port, 'POST', '/v1/tasks', auth, { projectId: pid, title: 'From phone' });
  assert.equal(plain.status, 201);
  const started = await call(port, 'POST', '/v1/tasks', auth, { projectId: pid, title: 'Start me', description: 'brief', start: true });
  assert.equal(started.status, 201);
  const sj = JSON.parse(started.text);
  assert.ok(sj.note, 'start note queued for the live session');
  assert.equal(sj.task.status, 'next');

  // a note with an attachment, delivered immediately
  const up = await rawRequest(port, { method: 'POST', path: '/v1/attachments', headers: { ...auth, 'content-type': 'image/png', 'x-filename': 'cam.png' }, body: 'PNGDATA' });
  assert.equal(up.status, 201);
  const att = JSON.parse(up.text).attachment;
  const nr = await call(port, 'POST', '/v1/notes', auth, { target: { kind: 'session', id: 's1' }, text: 'look at this', execute: true, attachments: [att.id] });
  assert.equal(nr.status, 201);
  const note = JSON.parse(nr.text).note;
  assert.equal(note.state, 'queued');
  const got = await rawRequest(port, { method: 'GET', path: `/v1/attachments/${att.id}`, headers: auth });
  assert.equal(got.status, 200);
  assert.equal(got.text, 'PNGDATA');
  assert.equal((await rawRequest(port, { method: 'GET', path: `/v1/attachments/${att.id}` })).status, 401);

  // the reply flows back through the filtered state
  h.send(h.ev('s1', 'note.result', { noteId: note.id, ok: true, via: 'prompt' }));
  h.send(h.ev('s1', 'note.reply', { noteId: note.id, text: 'looks fine' }));
  const st = JSON.parse((await call(port, 'GET', '/v1/state', auth)).text);
  const mine = st.notes.find((n) => n.id === note.id);
  assert.equal(mine.reply, 'looks fine');
  assert.equal(mine.attachments[0].path, undefined, 'no filesystem paths leak');
  assert.ok(st.notes.some((n) => n.id === sj.note.id), 'the start note is readable too');
  assert.equal(st.sessions[0].cwd, undefined, 'no cwd');
  assert.ok(st.projects.length >= 1);
  assert.equal(st.tasks.some((x) => x.title === 'From phone'), false, 'a plain backlog task does not "need you"');

  // a task in review needs the user, with its reason
  const reviewTask = h.state().tasks.find((x) => x.status === 'review');
  assert.ok(reviewTask, 'the first agent finished -> review');
  const st2 = JSON.parse((await call(port, 'GET', '/v1/state', auth)).text);
  const need = st2.tasks.find((x) => x.id === reviewTask.id);
  assert.ok(need && need.needs.includes('Review'));
  assert.equal(need.description, undefined);

  // the stream carries no row data
  const s = openStream(`http://127.0.0.1:${port}`, auth);
  await s.waitFor((e) => e.comment === 'connected');
  h.send(h.ev('s1', 'session.heartbeat', { tokens: 5 }));
  const ev = await s.waitFor((e) => e.event === 'change');
  assert.equal(ev.data.row, null);
  assert.ok(ev.data.entity);
  s.close();
  assert.equal((await rawRequest(port, { method: 'GET', path: '/v1/stream' })).status, 401);
});

test('browser safety on the phone listener: a cross-site Origin cannot ride the cookie', async (t) => {
  const h = await start(); t.after(h.stop);
  await world(h);
  const { port, token } = await enable(h);
  const pid = h.state().projects[0].id;
  const body = { projectId: pid, title: 'csrf' };
  const evil = await call(port, 'POST', '/v1/tasks', { cookie: `helm_k=${token}`, origin: 'http://evil.example' }, body);
  assert.equal(evil.status, 403);
  const same = await call(port, 'POST', '/v1/tasks', { cookie: `helm_k=${token}`, origin: `http://127.0.0.1:${port}` }, body);
  assert.equal(same.status, 201);
  const xs = await call(port, 'POST', '/v1/tasks', { cookie: `helm_k=${token}`, 'sec-fetch-site': 'cross-site' }, body);
  assert.equal(xs.status, 403);
});

test('rate limit: 60 requests a minute per IP, then 429', async (t) => {
  const h = await start(); t.after(h.stop);
  const { port, token } = await enable(h);
  for (let i = 0; i < RATE_LIMIT; i++) {
    const r = await call(port, 'GET', '/v1/state', bearer(token));
    assert.equal(r.status, 200, `request ${i + 1}`);
  }
  const over = await call(port, 'GET', '/v1/state', bearer(token));
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers['retry-after']) >= 1);
  assert.equal(RATE_LIMIT, 60);
});

test('5 failed auths ban the IP for 10 minutes; a valid token does not get through the ban; it lifts later', async (t) => {
  let clock = 1_000_000;
  const h = await start({ clock: () => clock }); t.after(h.stop);
  const { port, token } = await enable(h);
  for (let i = 1; i < MAX_FAILS; i++) assert.equal((await call(port, 'GET', '/v1/state', bearer('bad' + i))).status, 401, `fail ${i}`);
  assert.equal((await call(port, 'GET', '/v1/state', bearer('bad5'))).status, 401, 'the 5th failure is still a 401 ...');
  const banned = await call(port, 'GET', '/v1/state', bearer(token));
  assert.equal(banned.status, 429, '... and the next request, even with the right token, is banned');
  assert.ok(Number(banned.headers['retry-after']) > 500);
  assert.equal((await call(port, 'GET', '/m/m.js')).status, 429, 'the ban covers the page shell too');
  clock += 9 * 60_000;
  assert.equal((await call(port, 'GET', '/v1/state', bearer(token))).status, 429, 'still banned after 9 minutes');
  clock += 61_000;
  assert.equal((await call(port, 'GET', '/v1/state', bearer(token))).status, 200, 'ban over after 10 minutes');
});

test('disabling closes the listener and rotates the token; the old link stays dead', async (t) => {
  const h = await start(); t.after(h.stop);
  const first = await enable(h);
  assert.equal(await connects(first.port), true);
  const off = await h.api('POST', '/v1/remote', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.enabled, false);
  assert.equal(await connects(first.port), false, 'port closed');
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'remote.json'), 'utf8'));
  assert.equal(saved.enabled, false);
  assert.notEqual(saved.token, first.token, 'token rotated on disable');
  assert.equal((await h.api('POST', '/v1/remote', { enabled: false })).status, 200, 'disable is idempotent');

  const second = await enable(h);
  assert.notEqual(second.token, first.token);
  assert.equal((await call(second.port, 'GET', '/v1/state', bearer(first.token))).status, 401, 'old token is refused');
  assert.equal((await call(second.port, 'GET', '/v1/state', bearer(second.token))).status, 200);
  assert.equal((await h.api('POST', '/v1/remote', { enabled: true })).json.token, second.token, 'enable is idempotent');
});

test('remote.json is mode 0600 and holds { enabled, token }; the hub restores it only if it was enabled', async (t) => {
  const h = await start(); t.after(h.stop);
  const file = path.join(h.home, 'remote.json');
  const { token } = await enable(h);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { enabled: true, token });
  await h.api('POST', '/v1/remote', { enabled: false });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'still 0600 after a rewrite');

  // restart on the same home
  const open = (over = {}) => startHub({ home: h.home, port: 0, singleton: false, sweep: false, ...T, ...over });
  const off = await open();
  assert.equal(off.remote.status().enabled, false, 'was disabled -> stays off');
  assert.equal(off.servers.length, 2);
  const on = await off.remote.enable();
  await off.close();
  assert.equal(on.enabled, true);
  const again = await open();
  t.after(() => again.close());
  const st = again.remote.status();
  assert.equal(st.enabled, true, 'was enabled when the hub stopped -> back on');
  assert.equal(st.token, on.token, 'same token');
  assert.equal((await call(st.port, 'GET', '/v1/state', bearer(on.token))).status, 200);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('remote can be switched off in config (tests, packaging): the saved flag is ignored', async (t) => {
  const h = await start(); t.after(h.stop);
  await enable(h);
  const r = await startHub({ home: h.home, port: 0, singleton: false, sweep: false, ...T, remote: false });
  assert.equal(r.remote.status().enabled, false);
  await r.close();
});

test('a taken port is reported, not swallowed', async (t) => {
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  t.after(() => blocker.close());
  const h = await start({ remotePort: blocker.address().port }); t.after(h.stop);
  const r = await h.api('POST', '/v1/remote', { enabled: true });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already in use/);
  assert.equal(h.remote.status().enabled, false);
  assert.equal(fs.existsSync(path.join(h.home, 'remote.json')), false);
});

test('remote requests are logged (method, path, ip) to helmd.log', async (t) => {
  const h = await start(); t.after(h.stop);
  const { port, token } = await enable(h);
  await call(port, 'GET', '/v1/state', bearer(token));
  await call(port, 'GET', '/v1/health', bearer(token));
  const log = fs.readFileSync(path.join(h.home, 'helmd.log'), 'utf8');
  assert.match(log, /remote GET "\/v1\/state" 200 ip=127\.0\.0\.1/);
  assert.match(log, /remote GET "\/v1\/health" 403 ip=127\.0\.0\.1/);
  assert.doesNotMatch(log, new RegExp(token), 'the token is never logged');
});

test('/m is served on loopback with no token, and the loopback API is unchanged', async (t) => {
  const h = await start(); t.after(h.stop);
  for (const [p, type] of [['/m', /text\/html/], ['/m/', /text\/html/], ['/m/index.html', /text\/html/], ['/m/m.js', /javascript/], ['/m/m.css', /text\/css/]]) {
    const r = await h.get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type, p);
  }
  const page = (await h.get('/m')).text;
  assert.match(page, /<title>Helm quick capture<\/title>/);
  assert.match(page, /\/m\/m\.js/);
  assert.equal((await h.get('/v1/health')).status, 200);
  assert.equal((await h.get('/v1/state')).status, 200);
  assert.equal((await h.get('/')).status, 200);
  assert.match((await rawRequest(h.port, { method: 'GET', path: '/m', headers: { host: 'evil.example' } })).text, /forbidden host/);
});

test('lanAddresses prefers real LAN interfaces and skips loopback, link-local and virtual ones', () => {
  const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal });
  const list = lanAddresses({
    lo0: [v4('127.0.0.1', true)], utun3: [v4('100.64.0.2')], bridge100: [v4('192.168.64.1')],
    en0: [v4('192.168.1.23'), { family: 'IPv6', address: 'fe80::1', internal: false }], en5: [v4('169.254.3.4')],
  });
  assert.deepEqual(list.map((x) => x.address), ['192.168.1.23', '192.168.64.1', '100.64.0.2']);
});

test('QR encoder: structure of a typical pairing link (finders, timing, size) and a size limit', () => {
  const url = 'http://192.168.1.23:7778/m#k=' + 'A'.repeat(43);
  const m = qrMatrix(url);
  assert.equal((m.length - 17) % 4, 0);
  assert.ok(m.length >= 21 && m.length <= 57);
  const finder = (r, c) => { for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
    const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
    assert.equal(m[r + i][c + j], ring !== 2, `finder at ${r},${c} ${i},${j}`);
  } };
  finder(0, 0); finder(0, m.length - 7); finder(m.length - 7, 0);
  for (let i = 8; i < m.length - 8; i++) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
  assert.equal(m[m.length - 8][8], true, 'dark module');
  assert.ok(qrMatrix('x'.repeat(213)), '213 bytes fit (version 10-M)');
  assert.equal(qrMatrix('x'.repeat(214)), null);
  assert.deepEqual(qrMatrix(url), m, 'deterministic');
});
