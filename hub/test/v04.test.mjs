// v0.4: attachments, the usage meter, and the `answer` note delivery type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, tmpDir, rawRequest, openStream } from './helpers.mjs';
import { seed, tinyPng } from '../seed.mjs';
import { safeFilename } from '../hub.mjs';

const S1 = { kind: 'session', id: 's1' };
const world = (h) => h.send(h.ev('s1', 'session.started', { cwd: '/w/p', title: 'Main', model: 'opus' }));
const upload = (h, bytes, { name, type = 'application/octet-stream' } = {}) => fetch(h.base + '/v1/attachments', {
  method: 'POST', headers: { 'content-type': type, ...(name !== undefined ? { 'x-filename': encodeURIComponent(name) } : {}) }, body: bytes,
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const MIN = 60_000;
const at = (dayOffset, hour) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, hour).getTime(); };

test('upload and get round trip keeps binary bytes intact; image inline, other types download', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
  const up = await upload(h, bytes, { name: 'données 1.bin' });
  assert.equal(up.status, 201);
  const a = up.json.attachment;
  assert.deepEqual([a.id, a.name, a.mime, a.size], ['A-1', 'données 1.bin', 'application/octet-stream', 4096]);
  assert.equal(a.path, path.join(h.home, 'attachments', 'A-1', 'données 1.bin'));
  assert.ok(Buffer.from(fs.readFileSync(a.path)).equals(bytes), 'bytes on disk');
  assert.equal(typeof a.createdAt, 'number');

  const got = await fetch(h.base + '/v1/attachments/A-1');
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/octet-stream');
  assert.match(got.headers.get('content-disposition'), /^attachment; filename="/);
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(bytes), 'bytes over HTTP');

  const png = tinyPng();
  const img = (await upload(h, png, { name: 'shot.png', type: 'image/png' })).json.attachment;
  assert.equal(img.id, 'A-2');
  const r2 = await fetch(h.base + '/v1/attachments/A-2');
  assert.equal(r2.headers.get('content-type'), 'image/png');
  assert.match(r2.headers.get('content-disposition'), /^inline; filename="shot.png"/);
  assert.ok(Buffer.from(await r2.arrayBuffer()).equals(png));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // svg / html are untrusted: never rendered inline on the hub's origin
  await upload(h, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { name: 'x.svg', type: 'image/svg+xml' });
  assert.match((await fetch(h.base + '/v1/attachments/A-3')).headers.get('content-disposition'), /^attachment/);

  assert.equal((await h.get('/v1/attachments/A-99')).status, 404);
  assert.equal((await upload(h, Buffer.alloc(0), { name: 'e.txt' })).status, 400, 'empty body');
  // an upload is a hub event, so it shows in the log
  assert.equal(h.hub.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'hub.attachment.create'").n, 3);
});

test('filenames are sanitised: traversal, separators, leading dots, control chars, length', async (t) => {
  const h = await startTest(); t.after(h.stop);
  for (const [raw, want] of [
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\evil.exe', 'evil.exe'],
    ['/abs/path/photo.jpg', 'photo.jpg'],
    ['.hidden', 'hidden'],
    ['...', 'file'],
    ['', 'file'],
    ['a\u0000b\nc.txt', 'a_b_c.txt'],
    ['what?*<>|.txt', 'what_____.txt'],
  ]) assert.equal(safeFilename(raw), want, JSON.stringify(raw));
  const long = safeFilename('n'.repeat(500) + '.png');
  assert.ok(Buffer.byteLength(long) <= 120 && long.endsWith('.png'));

  const up = await upload(h, Buffer.from('pwned'), { name: '../../../outside.txt' });
  assert.equal(up.json.attachment.name, 'outside.txt');
  const base = path.join(h.home, 'attachments');
  assert.equal(up.json.attachment.path, path.join(base, 'A-1', 'outside.txt'));
  assert.ok(!fs.existsSync(path.join(h.home, '..', 'outside.txt')) && !fs.existsSync(path.join(h.home, 'outside.txt')));
  // a raw header with a bad percent escape does not crash
  const bad = await fetch(h.base + '/v1/attachments', { method: 'POST', headers: { 'x-filename': '%E0%A4%A' }, body: 'x' });
  assert.equal(bad.status, 201);
  assert.ok(!(await bad.json()).attachment.name.includes('/'));
  // no x-filename and no content-type
  const bare = await fetch(h.base + '/v1/attachments', { method: 'POST', body: 'y' });
  assert.deepEqual([(await bare.json()).attachment.name], ['file']);
});

test('the upload limit is 20 MiB (413), JSON routes keep 1 MiB', async (t) => {
  const h = await startTest(); t.after(h.stop);
  // declared too large: refused before the body is read
  const r = await rawRequest(h.port, {
    method: 'POST', path: '/v1/attachments', headers: { 'content-type': 'image/png', 'content-length': 20 * 1024 * 1024 + 1 }, body: 'x',
  }).catch((e) => ({ status: e.code }));
  assert.equal(r.status, 413);
  assert.match(JSON.parse(r.text).error, /20 MiB/);
  // a real oversize body streamed in
  const big = Buffer.alloc(21 * 1024 * 1024, 1);
  let status;
  try { status = (await upload(h, big, { name: 'big.bin' })).status; } catch (e) { status = e.cause?.code ?? e.code ?? 'reset'; }
  assert.ok(status === 413 || ['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET', 'reset'].includes(status), `got ${status}`);
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM attachments').n, 0);
  // 3 MiB is fine for an upload but not for JSON
  assert.equal((await upload(h, Buffer.alloc(3 * 1024 * 1024, 7), { name: 'ok.bin' })).status, 201);
  const j = await rawRequest(h.port, {
    method: 'POST', path: '/v1/projects', headers: { 'content-type': 'application/json', 'content-length': 2 * 1024 * 1024 }, body: '{}',
  }).catch((e) => ({ status: e.code }));
  assert.equal(j.status, 413);
});

test('uploads obey the same origin guard as other mutating routes', async (t) => {
  const h = await startTest(); t.after(h.stop);
  const r = await rawRequest(h.port, { method: 'POST', path: '/v1/attachments', headers: { origin: 'https://evil.example', 'content-length': 1 }, body: 'x' });
  assert.equal(r.status, 403);
  const r2 = await rawRequest(h.port, { path: '/v1/attachments/A-1', headers: { host: 'evil.example' } });
  assert.equal(r2.status, 403);
});

test('notes carry attachments: create, patch, validation, defaults', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h);
  const ids = [];
  for (let i = 0; i < 11; i++) ids.push((await upload(h, Buffer.from('f' + i), { name: `f${i}.txt`, type: 'text/plain' })).json.attachment.id);

  const plain = (await h.api('POST', '/v1/notes', { target: S1, text: 'no files' })).json.note;
  assert.deepEqual(plain.attachments, []);

  const c = await h.api('POST', '/v1/notes', { target: S1, text: 'with files', attachments: [ids[0], ids[1], ids[0]] });
  assert.equal(c.status, 201);
  assert.deepEqual(c.json.note.attachments.map((a) => [a.id, a.name, a.mime, a.size]), [['A-1', 'f0.txt', 'text/plain', 2], ['A-2', 'f1.txt', 'text/plain', 2]]);
  assert.equal(c.json.note.attachments[0].path, path.join(h.home, 'attachments', 'A-1', 'f0.txt'));
  assert.ok(!('createdAt' in c.json.note.attachments[0]));
  assert.deepEqual(h.state().notes.find((n) => n.id === c.json.note.id).attachments, c.json.note.attachments);

  // unknown id / bad shape / too many -> 400, nothing created
  const before = h.state().notes.length;
  for (const bad of [['A-999'], 'A-1', [1], [ids[0], 'nope']]) {
    assert.equal((await h.api('POST', '/v1/notes', { target: S1, text: 'x', attachments: bad })).status, 400, JSON.stringify(bad));
  }
  const eleven = await h.api('POST', '/v1/notes', { target: S1, text: 'x', attachments: ids });
  assert.equal(eleven.status, 400);
  assert.match(eleven.json.error, /at most 10/);
  assert.equal((await h.api('POST', '/v1/notes', { target: S1, text: 'x', attachments: ids.slice(0, 10) })).status, 201);
  assert.equal(h.state().notes.length, before + 1);

  // patch: attachments only, text only, both, clear
  const id = c.json.note.id;
  let p = await h.api('PATCH', `/v1/notes/${id}`, { attachments: [ids[2]] });
  assert.deepEqual([p.status, p.json.note.text, p.json.note.attachments.map((a) => a.id)], [200, 'with files', ['A-3']]);
  p = await h.api('PATCH', `/v1/notes/${id}`, { text: 'edited' });
  assert.deepEqual([p.json.note.text, p.json.note.attachments.map((a) => a.id)], ['edited', ['A-3']], 'text patch keeps files');
  p = await h.api('PATCH', `/v1/notes/${id}`, { text: 'both', attachments: [ids[4], ids[5]] });
  assert.deepEqual(p.json.note.attachments.map((a) => a.id), ['A-5', 'A-6']);
  assert.equal((await h.api('PATCH', `/v1/notes/${id}`, { attachments: ['A-404'] })).status, 400);
  assert.equal((await h.api('PATCH', `/v1/notes/${id}`, {})).status, 400);
  p = await h.api('PATCH', `/v1/notes/${id}`, { attachments: [] });
  assert.deepEqual(p.json.note.attachments, []);

  // survives the inbox claim as part of the note
  await h.api('PATCH', `/v1/notes/${id}`, { attachments: [ids[0]] });
  await h.api('POST', '/v1/notes/execute', { target: S1 });
  const inbox = (await h.get('/v1/sessions/s1/inbox')).json.notes;
  assert.ok(inbox.find((n) => n.id === id).attachments.length === 1);
});

test('note.result accepts via: answer', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h);
  h.send(h.ev('s1', 'turn.started', {}));
  const task = (await h.api('POST', '/v1/tasks', { projectId: h.state().projects[0].id, title: 'Q' })).json.task;
  const n = (await h.api('POST', '/v1/notes', { target: { kind: 'task', id: task.id }, text: 'Why is it slow?', execute: true })).json.note;
  h.send(h.ev('s1', 'note.result', { noteId: n.id, ok: true, via: 'answer' }), h.ev('s1', 'note.reply', { noteId: n.id, text: 'Because of the N+1.' }));
  const got = h.state().notes.find((x) => x.id === n.id);
  assert.deepEqual([got.state, got.via, got.reply], ['ran', 'answer', 'Because of the N+1.']);
  assert.match(h.hub.db.get("SELECT summary FROM activity WHERE kind = 'note' AND summary LIKE '%delivered%'").summary, /via answer/);
  // unknown vias are still dropped
  const n2 = (await h.api('POST', '/v1/notes', { target: S1, text: 'x', execute: true })).json.note;
  h.send(h.ev('s1', 'note.result', { noteId: n2.id, ok: true, via: 'telepathy' }));
  assert.equal(h.state().notes.find((x) => x.id === n2.id).via, null);
});

test('usage: aggregation by local day, overhead vs requested split, byKind, state and SSE', async (t) => {
  const h = await startTest(); t.after(h.stop);
  world(h);
  const now = at(0, 12);
  h.hub.setClock(() => now);
  const u = (when, kind, costUsd, extra = {}) => h.ev('s1', 'helm.usage', { kind, model: 'haiku-5-5', inputTokens: 100, outputTokens: 10, costUsd, ...extra }, when);
  assert.deepEqual((await h.get('/v1/usage')).json.today, { overheadUsd: 0, requestedUsd: 0, byKind: {} });
  const es = openStream(h.base);
  await es.waitFor((e) => e.comment === 'connected');
  h.send(
    u(at(0, 9), 'recap', 0.1), u(at(0, 10), 'answer', 0.2), u(at(0, 10) + MIN, 'answer', 0.05), u(at(0, 11), 'explain', 0.3),
    u(at(0, 11) + MIN, 'digest', 0.4), u(at(0, 11) + 2 * MIN, 'note_turn', 1.5, { taskId: 'T-1', noteId: 'N-1', cacheReadTokens: 900 }),
    u(at(-1, 15), 'note_turn', 2), u(at(-1, 16), 'recap', 0.25), u(at(-3, 8), 'digest', 0.5),
    u(at(-30, 8), 'recap', 99), // outside any window asked for
  );
  const ev = await es.waitFor((e) => e.data?.entity === 'usage');
  assert.equal(ev.data.op, 'upsert');
  assert.equal(typeof ev.data.row.overheadUsd, 'number');
  es.close();

  const r = (await h.get('/v1/usage?days=7')).json;
  assert.deepEqual(r.today, {
    overheadUsd: 1.05, requestedUsd: 1.5,
    byKind: { recap: { calls: 1, costUsd: 0.1 }, answer: { calls: 2, costUsd: 0.25 }, explain: { calls: 1, costUsd: 0.3 }, digest: { calls: 1, costUsd: 0.4 }, note_turn: { calls: 1, costUsd: 1.5 } },
  });
  assert.equal(r.days.length, 7);
  assert.deepEqual(r.days.map((d) => d.date), [...r.days.map((d) => d.date)].sort(), 'oldest first');
  const dt = (off) => r.days.find((d) => d.date === new Date(at(off, 12)).toLocaleDateString('sv-SE'));
  assert.deepEqual([dt(0).overheadUsd, dt(0).requestedUsd], [1.05, 1.5]);
  assert.deepEqual([dt(-1).overheadUsd, dt(-1).requestedUsd], [0.25, 2]);
  assert.deepEqual([dt(-2).overheadUsd, dt(-2).requestedUsd], [0, 0], 'empty days are present');
  assert.deepEqual([dt(-3).overheadUsd, dt(-3).requestedUsd], [0.5, 0]);
  assert.equal(r.days.at(-1).date, dt(0).date);
  assert.equal((await h.get('/v1/usage?days=2')).json.days.length, 2);
  assert.equal((await h.get('/v1/usage?days=1')).json.days.length, 1);
  assert.equal((await h.get('/v1/usage')).json.days.length, 7, 'default 7');
  assert.equal((await h.get('/v1/usage?days=500')).json.days.length, 90, 'clamped');

  assert.deepEqual(h.state().usageToday, { overheadUsd: 1.05, requestedUsd: 1.5 });
  const row = h.hub.db.get("SELECT * FROM usage WHERE kind = 'note_turn' AND task_id = 'T-1'");
  assert.deepEqual([row.note_id, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.model], ['N-1', 100, 10, 900, 'haiku-5-5']);

  // bad events are ignored, not stored
  h.send(u(at(0, 12), 'bogus', 1), u(at(0, 12), 'recap', -1), u(at(0, 12), 'recap', 'free'));
  assert.equal(h.hub.db.get('SELECT COUNT(*) AS n FROM usage').n, 10);
});

test('v0.4 rows rebuild deterministically; files stay on disk; ids continue', async (t) => {
  const h = await startTest(); t.after(h.stop);
  seed(h.hub);
  const a = (await upload(h, Buffer.from('after seed'), { name: 'late.txt', type: 'text/plain' })).json.attachment;
  await h.api('POST', '/v1/notes', { target: { kind: 'session', id: 'demo-meridian-auth' }, text: 'late note', attachments: [a.id] });
  const before = h.hub.dump();
  const stateBefore = h.state();
  assert.ok(before.attachments.length >= 2 && before.usage.length >= 10);
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before, 'attachments, usage and notes identical');
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...stateBefore, seq: 0 });
  assert.ok(fs.existsSync(a.path), 'file untouched');
  const next = (await upload(h, Buffer.from('n'), { name: 'n.txt' })).json.attachment;
  assert.equal(next.id, `A-${before.attachments.length + 1}`);
});

test('seed: an image attachment on one note, and usage across kinds for today and yesterday', async (t) => {
  const h = await startTest(); t.after(h.stop);
  seed(h.hub);
  const withFile = h.state().notes.filter((n) => n.attachments.length);
  assert.equal(withFile.length, 1);
  const att = withFile[0].attachments[0];
  assert.equal(att.mime, 'image/png');
  const bytes = fs.readFileSync(att.path);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 48, 'IHDR width');
  const served = await fetch(h.base + `/v1/attachments/${att.id}`);
  assert.equal(served.headers.get('content-type'), 'image/png');
  const r = (await h.get('/v1/usage?days=2')).json;
  assert.equal(r.days.length, 2);
  assert.ok(r.days.every((d) => d.overheadUsd > 0 && d.requestedUsd > 0), JSON.stringify(r.days));
  assert.deepEqual(Object.keys(r.today.byKind).sort(), ['answer', 'digest', 'explain', 'note_turn', 'recap']);
  assert.deepEqual(h.state().usageToday, { overheadUsd: r.today.overheadUsd, requestedUsd: r.today.requestedUsd });
});

test('opening a pre-v0.4 database adds notes.attachments; new tables appear; idempotent', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Db } = await import('../db.mjs');
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'helm.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, queued_at INTEGER, ran_at INTEGER, via TEXT, error TEXT, sending_at INTEGER,
    reply TEXT, replied_at INTEGER)`);
  old.exec(`INSERT INTO notes VALUES ('N-1','session','s1','s1','keep me','ran',1,2,3,'prompt',NULL,NULL,NULL,NULL)`);
  old.close();
  for (let i = 0; i < 2; i++) {
    const db = new Db(file);
    assert.ok(db.all('PRAGMA table_info(notes)').some((c) => c.name === 'attachments'));
    assert.equal(db.get('SELECT attachments, text FROM notes').attachments, '[]');
    assert.equal(db.get('SELECT text FROM notes').text, 'keep me');
    for (const tbl of ['attachments', 'usage']) assert.equal(db.get(`SELECT COUNT(*) AS n FROM ${tbl}`).n, 0);
    db.close();
  }
  // and a full hub opens it and reads the old note with an empty attachments array
  const { Hub } = await import('../hub.mjs');
  const { loadConfig } = await import('../config.mjs');
  const hub = new Hub(loadConfig({ home: dir }), null);
  const n = hub.state().notes[0];
  assert.deepEqual([n.id, n.text, n.attachments], ['N-1', 'keep me', []]);
  assert.deepEqual(hub.state().usageToday, { overheadUsd: 0, requestedUsd: 0 });
  hub.close();
});
