// v0.21: Studio export. The pure serializer (escaping, every block type, no comments) and the export endpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest } from './helpers.mjs';
import { blocksToHtml, cleanBlocks, PRINT_CSS } from '../docs.mjs';

const CHROME = process.env.HELM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
const hasTextutil = fs.existsSync('/usr/bin/textutil');

const ALL = [
  { id: 'b1', type: 'h1', text: 'Title' }, { id: 'b2', type: 'h2', text: 'Section' }, { id: 'b3', type: 'h3', text: 'Sub' },
  { id: 'b4', type: 'p', text: 'Hello bold it link', marks: [{ s: 6, e: 10, t: 'b' }, { s: 11, e: 13, t: 'i' }, { s: 14, e: 18, t: 'a', href: 'https://a.io/x?a=1&b=2' }] },
  { id: 'b5', type: 'li', text: 'one' }, { id: 'b6', type: 'li', text: 'nested', level: 1 }, { id: 'b7', type: 'li', text: 'num', ordered: true },
  { id: 'b8', type: 'quote', text: 'quoted' }, { id: 'b9', type: 'code', text: 'a < b && c' }, { id: 'b10', type: 'hr' },
  { id: 'b11', type: 'img', text: 'a "chart"', attachmentId: 'att1' }, { id: 'b12', type: 'table', rows: [['h1', 'h2'], ['<i>', '2']] },
];

test('serializer: a standalone A4 document with every block type', () => {
  const html = blocksToHtml(cleanBlocks(ALL).blocks, { title: 'My Doc' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>My Doc<\/title>/);
  assert.match(html, /@page\{size:A4/);
  assert.ok(PRINT_CSS.includes('size:A4'));
  for (const re of [/<h1[^>]*>Title<\/h1>/, /<h2[^>]*>Section<\/h2>/, /<h3[^>]*>Sub<\/h3>/, /<strong>bold<\/strong>/, /<em>it<\/em>/,
    /<a href="https:\/\/a\.io\/x\?a=1&amp;b=2">link<\/a>/, /<ul>[\s\S]*<li[^>]*>one<\/li>/, /<blockquote[^>]*>quoted<\/blockquote>/,
    /<pre[^>]*>a &lt; b &amp;&amp; c<\/pre>/, /<hr>/, /\[image: a &quot;chart&quot;\]/, /<table[^>]*><tr><td>h1<\/td><td>h2<\/td><\/tr>/, /<ol>/]) {
    assert.match(html, re, String(re));
  }
  assert.ok(html.includes('<td>&lt;i&gt;</td>'));
});

test('serializer: all text is escaped and no raw HTML survives', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'&';
  const html = blocksToHtml([
    { id: 'b1', type: 'p', text: evil }, { id: 'b2', type: 'h1', text: evil }, { id: 'b3', type: 'code', text: '</pre><script>x</script>' },
    { id: 'b4', type: 'table', rows: [[evil]] }, { id: 'b5', type: 'quote', text: evil }, { id: 'b6', type: 'li', text: evil },
    { id: 'b7', type: 'p', text: 'x', marks: [{ s: 0, e: 1, t: 'a', href: 'javascript:alert(1)' }] },
  ], { title: evil });
  assert.ok(!/<script/i.test(html), 'no script tag');
  assert.ok(!/<img /i.test(html), 'no img tag from text');
  assert.ok(!html.includes('javascript:'), 'unsafe link dropped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.throws(() => cleanBlocks([{ type: 'p', text: 'x', marks: [{ s: 0, e: 1, t: 'a', href: 'javascript:alert(1)' }] }]), /link marks/);
});

test('serializer: comments never reach the output', () => {
  const blocks = [{ id: 'b1', type: 'p', text: 'Visible text', comments: [{ id: 'C-1', text: 'SECRET NOTE' }], comment: 'SECRET NOTE', anchor: { quote: 'SECRET NOTE' } }];
  for (const b of [blocks, cleanBlocks(blocks).blocks]) {
    const html = blocksToHtml(b, { title: 'T' });
    assert.ok(html.includes('Visible text'));
    assert.ok(!html.includes('SECRET NOTE') && !html.includes('C-1'));
  }
});

async function setup() {
  const h = await startTest();
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }, Date.now()));
  return h;
}

test('endpoint: ?format=html on a hub doc, and a POSTed block tree exports without a stored doc', async (t) => {
  const h = await setup(); t.after(h.stop);
  const pid = h.state().projects[0].id;
  await h.api('POST', '/v1/docs', { projectId: pid, title: 'Plan <1>', markdown: '# Plan\n\nBody & more.' });
  const r = await fetch(`${h.base}/v1/docs/D-1/export?format=html`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  assert.match(r.headers.get('content-disposition'), /filename="Plan _1_\.html"/);
  assert.match(await r.text(), /Body &amp; more\./);
  // a real (POST) export is recorded as hub.doc.export
  const before = h.hub.db.all("SELECT 1 FROM events WHERE type = 'hub.doc.export'").length;
  assert.equal((await h.api('POST', '/v1/docs/D-1/export?format=html', {})).status, 200);
  assert.equal(h.hub.db.all("SELECT 1 FROM events WHERE type = 'hub.doc.export'").length, before + 1);

  // localStorage-only doc: the browser posts the tree
  const res = await fetch(`${h.base}/v1/docs/export`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'html', title: 'Local one', blocks: [{ id: 'b1', type: 'h1', text: 'Hi <b>' }] }),
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1[^>]*>Hi &lt;b&gt;<\/h1>/);
  const tmp = path.join(h.home, 'tmp');
  await new Promise((ok) => setTimeout(ok, 100));
  assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp) : [], [], 'temp files are cleaned up');
  const post = (body) => h.api('POST', '/v1/docs/export', body);
  assert.equal((await post({ format: 'rtf', blocks: [] })).status, 400);
  assert.equal((await post({ format: 'html' })).status, 400);
  assert.equal((await post({ format: 'html', blocks: [{ type: 'script', text: 'x' }] })).status, 400);
});

test('endpoint: a missing Chrome is a 501 with a window.print() hint', async (t) => {
  const h = await setup(); t.after(h.stop);
  const prev = process.env.HELM_CHROME;
  process.env.HELM_CHROME = '/nonexistent/chrome';
  try {
    const r = await h.api('POST', '/v1/docs/export', { format: 'pdf', title: 'x', blocks: [{ id: 'b1', type: 'p', text: 'a' }] });
    assert.equal(r.status, 501);
    assert.match(r.json.error, /Chrome/);
    assert.match(r.json.hint, /window\.print\(\)/);
  } finally { if (prev === undefined) delete process.env.HELM_CHROME; else process.env.HELM_CHROME = prev; }
});

test('endpoint: pdf from a posted block tree', { skip: !hasChrome && 'Chrome not installed' }, async (t) => {
  const h = await setup(); t.after(h.stop);
  const r = await fetch(`${h.base}/v1/docs/export`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'pdf', title: 'P', blocks: ALL }) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
});

test('endpoint: docx from a posted block tree', { skip: !hasTextutil && 'textutil not installed' }, async (t) => {
  const h = await setup(); t.after(h.stop);
  const r = await fetch(`${h.base}/v1/docs/export`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'docx', title: 'W', blocks: ALL }) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /wordprocessingml/);
  assert.match(r.headers.get('content-disposition'), /W\.docx/);
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 2).toString(), 'PK');
});
