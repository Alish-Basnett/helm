// v0.25 (T-74): the Studio `diagram` block. Parser, layout, string serializer (escaping), judging of diagram patches, the markdown
// round trip, the zip editor behind the docx export, and the export itself (html always; pdf/docx when Chrome and textutil exist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTest } from './helpers.mjs';
import {
  parseDiagram, layoutDiagram, renderDiagramSvg, diagramSvgString, diagramProblem, wrapLabel, DIAGRAM_STARTER,
  MAX_NODES, MAX_EDGES, DIAGRAM_MAX_SOURCE,
} from '../../web/studio/diagram.js';
import { cleanBlocks, cleanBlock, blocksToHtml, blocksToMarkdown, parseMarkdown, judgePatches, BLOCK_TYPES } from '../docs.mjs';
import { readZip, writeZip, embedDiagrams, diagramToken } from '../zipedit.mjs';
import { keepsNewlines, setType, mergeBack, pasteText } from '../../web/studio/blocks.js';

const EXAMPLE = 'dir LR\ngroup "Hub" { a[Mod] -> b[Hub] }\nb -> c[(DB)] : events';
const ok = (src) => { const p = parseDiagram(src); assert.deepEqual(p.errors, [], `unexpected errors for ${JSON.stringify(src)}`); return p; };
const errs = (src) => parseDiagram(src).errors;

// ------------------------------------------------------------------------------ parser
test('parser: the example from the contract parses into nodes, shapes, edges, a group and a direction', () => {
  const p = ok(EXAMPLE);
  assert.equal(p.dir, 'LR');
  assert.deepEqual(p.nodes, [
    { id: 'a', label: 'Mod', shape: 'box', group: 'g1' }, { id: 'b', label: 'Hub', shape: 'box', group: 'g1' }, { id: 'c', label: 'DB', shape: 'db', group: null },
  ]);
  assert.deepEqual(p.edges, [{ from: 'a', to: 'b', label: '', dashed: false }, { from: 'b', to: 'c', label: 'events', dashed: false }]);
  assert.deepEqual(p.groups, [{ id: 'g1', title: 'Hub', nodes: ['a', 'b'] }]);
});

test('parser: all four shapes, bare ids, chains (label on the last edge), dashed edges, quoted labels, comments and semicolons', () => {
  const p = ok('# a comment\na[Box]; b(Round); c[(Store)]; d{Choice}\ne\n// another\nA -> B -> C : last\nx --> y\nq["a [b] (c)"] -> r["say \\"hi\\""] : "go; now"');
  const shape = Object.fromEntries(p.nodes.map((n) => [n.id, n.shape]));
  assert.deepEqual([shape.a, shape.b, shape.c, shape.d, shape.e], ['box', 'round', 'db', 'diamond', 'box']);
  assert.equal(p.nodes.find((n) => n.id === 'e').label, 'e');
  assert.deepEqual(p.edges.slice(0, 2).map((e) => [e.from, e.to, e.label]), [['A', 'B', ''], ['B', 'C', 'last']]);
  assert.equal(p.edges.find((e) => e.from === 'x').dashed, true);
  assert.equal(p.nodes.find((n) => n.id === 'q').label, 'a [b] (c)');
  assert.equal(p.nodes.find((n) => n.id === 'r').label, 'say "hi"');
  assert.equal(p.edges.at(-1).label, 'go; now');
  assert.equal(ok('dir TD\na -> b').dir, 'TB');
  assert.equal(ok('a -> b').dir, 'TB');
});

test('parser: a node written later with a label, a multi-line group, and the same label written twice are fine', () => {
  const p = ok('a -> b\nb[Second]\ngroup "Two" {\n  b\n  c[Third] -> d\n}\nc[Third]');
  assert.equal(p.nodes.find((n) => n.id === 'b').label, 'Second');
  assert.deepEqual(p.groups[0].nodes, ['b', 'c', 'd']);
  assert.equal(p.nodes.find((n) => n.id === 'a').group, null);
});

test('parser: dir and group stay usable as node ids; CRLF and a self loop work; "#" inside a label is text', () => {
  const p = ok('dir -> group\r\ngroup -> dir : issue #5\r\ndir -> dir');
  assert.deepEqual(p.nodes.map((n) => n.id), ['dir', 'group']);
  assert.equal(p.edges[1].label, 'issue #5');
  assert.deepEqual(p.edges[2], { from: 'dir', to: 'dir', label: '', dashed: false });
});

test('parser: errors say what and on which line, and parsing goes on after a bad statement', () => {
  const e = errs('a -> b\nc[oops\n-> d\ne -> f\ndir sideways\ngroup "G" {\n  g\n');
  const lines = e.map((x) => x.line);
  assert.ok(e.some((x) => x.line === 2 && /missing \] to close the label/.test(x.message)), JSON.stringify(e));
  assert.ok(e.some((x) => x.line === 3 && /expected a node id/.test(x.message)), JSON.stringify(e));
  assert.ok(e.some((x) => x.line === 5 && /dir must be TB or LR, not "sideways"/.test(x.message)), JSON.stringify(e));
  assert.ok(e.some((x) => x.line === 6 && /group "G" is not closed/.test(x.message)), JSON.stringify(e));
  assert.ok(lines.every((n) => Number.isInteger(n) && n >= 1));
  const p = parseDiagram('a -> b\nc[oops\ne -> f');
  assert.ok(p.nodes.some((n) => n.id === 'e') && p.edges.some((x) => x.from === 'e'), 'valid statements after the error are kept');
});

test('parser: specific mistakes are refused', () => {
  const msg = (src) => errs(src).map((x) => x.message).join(' | ');
  assert.match(msg(''), /no nodes/);
  assert.match(msg('   \n# only a comment'), /no nodes/);
  assert.match(msg('a -> '), /expected a node id/);
  assert.match(msg('a ->> b'), /expected a node id/);
  assert.match(msg('a : just a label'), /needs an edge/);
  assert.match(msg('a[One]\na[Two]'), /already defined/);
  assert.match(msg('a[X]\na(X)'), /already defined/);
  assert.match(msg('group "A" { x }\ngroup "B" { x }'), /two groups/);
  assert.match(msg('group "A" { x group "B" { y } }'), /cannot be nested|not closed|unexpected/);
  assert.match(msg('group "E" { }'), /empty/);
  assert.match(msg('group "A" { x }\n}'), /unexpected }/);
  assert.match(msg('group A { x }'), /expected a node id|unexpected/);
  assert.match(msg('a["open'), /unterminated/);
  assert.match(msg('a -> b : "open'), /unterminated/);
  assert.match(msg('a -> b junk'), /unexpected "junk"/);
  assert.match(msg('1bad -> b'), /expected a node id/);
});

test('parser: size limits (nodes, edges, source) are errors, never a hang or a throw', () => {
  const many = Array.from({ length: MAX_NODES + 5 }, (_, i) => `n${i}`).join('\n');
  assert.match(errs(many).map((x) => x.message).join(), /too many nodes/);
  const edges = Array.from({ length: MAX_EDGES + 5 }, (_, i) => `a -> b${i % 40}`).join('\n');
  assert.match(errs(edges).map((x) => x.message).join(), /too many edges/);
  assert.match(errs('a -> b\n'.repeat(DIAGRAM_MAX_SOURCE)).map((x) => x.message).join(), /longer than/);
  assert.ok(errs('a['.repeat(3000)).length <= 20, 'the error list is capped');
});

test('parser: garbage never throws and always returns the same shape', () => {
  const junk = ['', ' ', '\n\n', '}}}{{{', '->->->', '[[[[', '"""', 'group', 'group "', 'dir', 'a[(', 'a[(x)', 'a{', '\u0000\u0001', '😀 -> 🙂', 'a -> b -> ', ';;;;', 'x'.repeat(500) + ' -> y', 'a\\', '#', '//'];
  for (const j of junk) {
    const p = parseDiagram(j);
    assert.ok(Array.isArray(p.nodes) && Array.isArray(p.edges) && Array.isArray(p.groups) && Array.isArray(p.errors), JSON.stringify(j));
    assert.ok(['TB', 'LR'].includes(p.dir));
  }
  assert.deepEqual(parseDiagram(null).errors.map((x) => x.line), [1]);
  assert.ok(parseDiagram(DIAGRAM_STARTER).errors.length === 0, 'the starter text is a valid diagram');
});

test('wrapLabel: long labels break at spaces into at most three lines', () => {
  assert.deepEqual(wrapLabel('Hub'), ['Hub']);
  assert.deepEqual(wrapLabel('Ingest events and project them'), ['Ingest events and', 'project them']);
  const w = wrapLabel('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen');
  assert.equal(w.length, 3);
  assert.ok(w[2].endsWith('…'));
});

// ------------------------------------------------------------------------------ layout
const rects = (l) => l.nodes.map((n) => ({ id: n.id, x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h }));
function overlaps(l) {
  const r = rects(l), bad = [];
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
    if (r[i].x0 < r[j].x1 && r[j].x0 < r[i].x1 && r[i].y0 < r[j].y1 && r[j].y0 < r[i].y1) bad.push([r[i].id, r[j].id]);
  }
  return bad;
}
const CASES = {
  chain: 'a -> b -> c -> d',
  fan: 'a -> b\na -> c\na -> d\na -> e\na -> f',
  merge: 'a -> d\nb -> d\nc -> d',
  diamond: 'a -> b\na -> c\nb -> d\nc -> d',
  cycle: 'a -> b -> c -> a',
  skip: 'a -> b -> c -> d\na -> d : long way\nb -> d',
  loops: 'a -> a : retry\na -> b\nb -> b',
  disconnected: 'a -> b\nx -> y\nsolo',
  groups: 'group "One" { a -> b }\ngroup "Two" { c -> d }\na -> c\nb -> d\ne -> a',
  mixed: 'dir LR\ngroup "Claude Code" { mod[Helm mod] -> hooks(Hooks) }\ngroup "Hub" { ingest[Ingest events] -> proj[Projector]\n proj -> db[(SQLite)]\n jobs[Job queue] -> engine[Docs engine] }\nhooks -> ingest : events\nproj -> sse(SSE stream) : push\nsse -> web[Web UI]\nweb -> jobs : create doc\nengine --> mod : doc_draft job\nweb --> proj\ndb -> web',
};
// 25 nodes, deterministic pseudo-random edges
{
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const lines = [];
  for (let i = 0; i < 25; i++) lines.push(`n${i}[Node number ${i}]`);
  for (let i = 0; i < 40; i++) lines.push(`n${Math.floor(rnd() * 25)} -> n${Math.floor(rnd() * 25)}${rnd() < 0.3 ? ' : link' : ''}`);
  CASES.random25 = lines.join('\n');
  CASES.random25lr = 'dir LR\n' + lines.join('\n');
}

test('layout: deterministic (same source, same numbers and same SVG string, twice)', () => {
  for (const [name, src] of Object.entries(CASES)) {
    const a = renderDiagramSvg(src), b = renderDiagramSvg(src);
    assert.deepEqual(a.errors, [], name);
    assert.equal(a.svg, b.svg, name);
    assert.deepEqual(layoutDiagram(parseDiagram(src)), layoutDiagram(parseDiagram(src)), name);
  }
});

test('layout: no two nodes overlap, in either direction, for simple and 25-node graphs', () => {
  for (const [name, src] of Object.entries(CASES)) {
    for (const forced of [null, 'dir TB\n', 'dir LR\n']) {
      const text = forced ? forced + src.replace(/^dir (TB|LR)\n/, '') : src;
      const p = parseDiagram(text);
      assert.deepEqual(p.errors, [], name);
      const l = layoutDiagram(p);
      assert.deepEqual(overlaps(l), [], `${name} (${forced || 'as written'}) has overlapping nodes`);
    }
  }
});

test('layout: everything stays inside the canvas and every number is finite', () => {
  for (const [name, src] of Object.entries(CASES)) {
    const l = layoutDiagram(parseDiagram(src));
    assert.ok(l.width > 0 && l.height > 0 && Number.isFinite(l.width + l.height), name);
    for (const n of l.nodes) assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= l.width + 0.01 && n.y + n.h <= l.height + 0.01, `${name}: node ${n.id} outside`);
    for (const e of l.edges) for (const p of e.pts) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= l.width && p.y <= l.height, `${name}: edge point outside`);
    for (const g of l.groups) assert.ok(g.x >= 0 && g.y >= 0 && g.x + g.w <= l.width + 0.01 && g.y + g.h <= l.height + 0.01, `${name}: group outside`);
  }
});

test('layout: edges flow with the direction (TB: down, LR: right) and a group box contains its members', () => {
  const tb = layoutDiagram(parseDiagram('a -> b -> c\na -> c'));
  const y = Object.fromEntries(tb.nodes.map((n) => [n.id, n.y]));
  assert.ok(y.a < y.b && y.b < y.c);
  const lr = layoutDiagram(parseDiagram('dir LR\na -> b -> c'));
  const x = Object.fromEntries(lr.nodes.map((n) => [n.id, n.x]));
  assert.ok(x.a < x.b && x.b < x.c);
  const g = layoutDiagram(parseDiagram(CASES.groups));
  for (const grp of g.groups) {
    const members = parseDiagram(CASES.groups).groups.find((q) => q.id === grp.id).nodes;
    for (const id of members) { const n = g.nodes.find((q) => q.id === id); assert.ok(n.x >= grp.x && n.y >= grp.y && n.x + n.w <= grp.x + grp.w && n.y + n.h <= grp.y + grp.h, `${id} outside ${grp.title}`); }
  }
  assert.equal(g.groups.length, 2);
});

test('layout: a cycle still lays out (one edge is drawn backwards) and an empty diagram gives an empty layout', () => {
  const l = layoutDiagram(parseDiagram(CASES.cycle));
  assert.equal(l.nodes.length, 3);
  assert.equal(l.edges.length, 3);
  assert.deepEqual(layoutDiagram({ nodes: [], edges: [], groups: [] }).nodes, []);
  assert.equal(renderDiagramSvg('nonsense ->').svg, '');
});

// ------------------------------------------------------------------------------ string serializer
test('serializer: every label, group title, edge label and the aria name is escaped; no raw markup survives', () => {
  const evil = '<script>alert(1)</script>';
  const src = `group "${evil}" { a["${evil}"] -> b["x & y"] : "${evil}" }\nb -> c(it's "q") : <b>bold</b>`;
  const { svg, errors } = renderDiagramSvg(src);
  assert.deepEqual(errors, []);
  assert.ok(svg.startsWith('<svg '));
  assert.ok(!/<script/i.test(svg) && !/<b>/i.test(svg), 'no raw tag from a label');
  assert.ok(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(svg.includes('x &amp; y'));
  assert.ok(svg.includes('it&#39;s &quot;q&quot;') || svg.includes('it&#39;s "q"'), 'quotes in text are safe');
  assert.ok(svg.includes('&lt;b&gt;bold&lt;/b&gt;'));
  // every attribute value is quoted and escaped: a quote in a label can not end an attribute early
  const p = parseDiagram('a["x\\" onload=\\"alert(1)"] -> b');
  const out = diagramSvgString(layoutDiagram(p), p);
  assert.ok(!/ onload=/.test(out.replace(/&quot;/g, '')) || out.includes('&quot; onload=&quot;'), 'onload cannot become an attribute');
  assert.ok(!/"\s+onload=/.test(out));
});

test('serializer: a diagram block in a document becomes inline SVG; a broken one becomes a note with the escaped source', () => {
  const html = blocksToHtml(cleanBlocks([
    { type: 'p', text: 'before' }, { type: 'diagram', text: EXAMPLE }, { type: 'diagram', text: 'a -> <script>' }, { type: 'diagram', text: '' },
  ]).blocks, { title: 'T' });
  assert.match(html, /<figure class="diagram" data-block="b2"><svg [^>]*viewBox="0 0 \d/);
  assert.match(html, /<text[^>]*>events<\/text>/);
  assert.match(html, /\[diagram not drawn: line 1: [^\]]*\]<\/p><pre>a -&gt; &lt;script&gt;<\/pre>/);
  assert.match(html, /\[diagram not drawn: it has no nodes|line 1: the diagram has no nodes/);
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('figure.diagram{'), 'print css covers diagrams');
});

test('docs: diagram is a block type; marks and extra fields are dropped; markdown round trip uses a diagram fence', () => {
  assert.ok(BLOCK_TYPES.includes('diagram'));
  const b = cleanBlock({ type: 'diagram', text: EXAMPLE, marks: [{ s: 0, e: 2, t: 'b' }], level: 3 });
  assert.deepEqual(b, { type: 'diagram', text: EXAMPLE, marks: [] });
  const blocks = cleanBlocks([{ type: 'p', text: 'x' }, { type: 'diagram', text: EXAMPLE }, { type: 'code', text: 'plain' }]).blocks;
  const md = blocksToMarkdown(blocks);
  assert.match(md, /```diagram\ndir LR\n/);
  const back = parseMarkdown(md);
  assert.deepEqual(back.map((x) => [x.type, x.text]), [['p', 'x'], ['diagram', EXAMPLE], ['code', 'plain']]);
});

// ------------------------------------------------------------------------------ judging
const dBlocks = () => cleanBlocks([{ type: 'p', text: 'Intro' }, { type: 'diagram', text: 'a[One] -> b[Two]' }]).blocks; // b1 p, b2 diagram
const judge = (patches, opts) => judgePatches(dBlocks(), 3, patches.map((p) => p.commentId), patches, opts);

test('judge: replace_text on a diagram applies when the result still parses and keeps the diagram type', () => {
  const r = judge([{ commentId: 'C-1', blockId: 'b2', op: 'replace_text', text: 'a[One] -> b[Two] -> c[(Three)] : saved' }]);
  assert.equal(r.results[0].status, 'applied');
  assert.equal(r.blocks[1].type, 'diagram');
  assert.equal(r.blocks[1].text, 'a[One] -> b[Two] -> c[(Three)] : saved');
  const f = judge([{ commentId: 'C-1', blockId: 'b2', op: 'replace', find: 'Two', with: 'Second' }]);
  assert.equal(f.results[0].status, 'applied');
  assert.equal(f.blocks[1].text, 'a[One] -> b[Second]');
});

test('judge: a diagram patch that would not parse is a conflict whose reason is the parse error', () => {
  const r = judge([{ commentId: 'C-1', blockId: 'b2', op: 'replace_text', text: 'a[One] -> b[Two\nc -> ' }]);
  assert.equal(r.results[0].status, 'conflict');
  assert.match(r.results[0].reason, /^the diagram would not parse \(line 1: missing \] to close the label\)/);
  assert.equal(r.blocks[1].text, 'a[One] -> b[Two]', 'the block is unchanged');
  const e = judge([{ commentId: 'C-1', blockId: 'b2', op: 'replace_text', text: 'just some prose' }]); // a lone word is a valid node; prose with spaces is not
  assert.equal(e.results[0].status, 'conflict');
  assert.match(e.results[0].reason, /would not parse \(line 1: unexpected "some prose"/);
  const z = judge([{ commentId: 'C-1', blockId: 'b2', op: 'replace_text', text: '# nothing left' }]);
  assert.match(z.results[0].reason, /no nodes/);
});

test('judge: inserted diagrams must parse too; retype to or from diagram is refused; delete works', () => {
  const good = judge([{ commentId: 'C-1', blockId: 'b1', op: 'insert_after', blocks: [{ type: 'diagram', text: 'x -> y' }, { type: 'p', text: 'caption' }] }]);
  assert.equal(good.results[0].status, 'applied');
  assert.deepEqual(good.blocks.map((b) => b.type), ['p', 'diagram', 'p', 'diagram']);
  const bad = judge([{ commentId: 'C-1', blockId: 'b1', op: 'insert_after', blocks: [{ type: 'diagram', text: 'x -> ' }] }]);
  assert.equal(bad.results[0].status, 'conflict');
  assert.match(bad.results[0].reason, /inserted diagram would not parse \(line 1: expected a node id/);
  assert.equal(bad.blocks.length, 2);
  const to = judge([{ commentId: 'C-1', blockId: 'b1', op: 'retype', type: 'diagram' }]);
  assert.match(to.results[0].reason, /cannot retype to diagram/);
  const from = judge([{ commentId: 'C-1', blockId: 'b2', op: 'retype', type: 'p' }]);
  assert.match(from.results[0].reason, /cannot retype a diagram block/);
  const del = judge([{ commentId: 'C-1', blockId: 'b2', op: 'delete' }]);
  assert.equal(del.results[0].status, 'applied');
  assert.equal(del.blocks.length, 1);
});

test('judge: a diagram comment may only change its own block (scope still applies)', () => {
  const r = judge([{ commentId: 'C-1', blockId: 'b2', op: 'replace_text', text: 'a -> b' }], { commentBlocks: { 'C-1': 'b1' } });
  assert.equal(r.results[0].status, 'conflict');
  assert.match(r.results[0].reason, /not on/);
});

// ------------------------------------------------------------------------------ web block helpers
test('web blocks: a new diagram starts from the starter text, Enter keeps lines, Backspace does not glue a diagram onto a paragraph', () => {
  assert.ok(keepsNewlines('diagram') && keepsNewlines('code') && !keepsNewlines('p'));
  const blocks = [{ id: 'b1', type: 'p', text: 'x' }, { id: 'b2', type: 'p', text: '' }];
  assert.equal(setType(blocks, 'b2', 'diagram')[1].text, DIAGRAM_STARTER);
  assert.equal(setType([{ id: 'b1', type: 'p', text: 'keep' }], 'b1', 'diagram')[0].text, 'keep');
  const d = [{ id: 'b1', type: 'p', text: 'x' }, { id: 'b2', type: 'diagram', text: 'a -> b' }];
  assert.equal(mergeBack(d, 'b2'), null);
  assert.equal(mergeBack([d[0], { id: 'b2', type: 'diagram', text: '' }], 'b2').blocks.length, 1);
  const pasted = pasteText([{ id: 'b1', type: 'diagram', text: '' }], 'b1', 0, 0, 'a -> b\nb -> c');
  assert.equal(pasted.blocks.length, 1);
  assert.equal(pasted.blocks[0].text, 'a -> b\nb -> c');
});

// ------------------------------------------------------------------------------ zip editing
test('zip: write then read gives the same files; embedDiagrams needs its placeholder', () => {
  const files = new Map([['[Content_Types].xml', Buffer.from('<Types></Types>')], ['a/b.txt', Buffer.from('hello '.repeat(50))], ['bin', Buffer.from([0, 1, 2, 255])]]);
  const back = readZip(writeZip(files));
  assert.deepEqual([...back.keys()], [...files.keys()]);
  for (const [k, v] of files) assert.ok(back.get(k).equals(v), k);
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /not a zip/);
  const docx = writeZip(new Map([
    ['[Content_Types].xml', Buffer.from('<?xml?><Types xmlns="x"><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/_rels/document.xml.rels', Buffer.from('<Relationships xmlns="r"></Relationships>')],
    ['word/document.xml', Buffer.from(`<w:document><w:body><w:p><w:r><w:rPr/><w:t xml:space="preserve">${diagramToken(1)}</w:t></w:r></w:p></w:body></w:document>`)],
  ]));
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const out = readZip(embedDiagrams(docx, [{ n: 1, png, w: 200, h: 100, alt: 'a "diagram" <x>' }]));
  const xml = out.get('word/document.xml').toString();
  assert.ok(!xml.includes('[[helm-diagram'), 'placeholder replaced');
  assert.match(xml, /<w:drawing>.*r:embed="rIdHelmDiagram1".*<\/w:drawing>/);
  assert.ok(xml.includes('descr="a &quot;diagram&quot; &lt;x&gt;"'), 'alt text escaped');
  assert.ok(out.get('word/media/diagram-1.png').equals(png));
  assert.match(out.get('word/_rels/document.xml.rels').toString(), /Target="media\/diagram-1\.png"/);
  assert.match(out.get('[Content_Types].xml').toString(), /Extension="png"/);
  assert.throws(() => embedDiagrams(docx, [{ n: 2, png, w: 1, h: 1, alt: '' }]), /placeholder not found/);
});

// ------------------------------------------------------------------------------ hub: draft, edit and export end to end
const CHROME = process.env.HELM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
const hasTextutil = fs.existsSync('/usr/bin/textutil');

async function setup() {
  const h = await startTest();
  h.send(h.ev('s1', 'session.started', { cwd: '/w/proj', title: 'Main', model: 'm' }, Date.now()));
  return { h, pid: h.state().projects[0].id };
}
const modAnswer = (h, jobId, text) => {
  h.hub.claimJobs('s1', Date.now());
  h.send(h.ev('s1', 'job.result', { jobId, ok: true, text }, Date.now()));
};

test('hub: a drafted diagram block is stored, searched and exported; a diagram patch is judged on the real route', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const created = await h.api('POST', '/v1/docs', { projectId: pid, title: 'Picture', prompt: 'a page about the hub, mostly diagrams' });
  modAnswer(h, created.json.job.id, '```json\n' + JSON.stringify({ blocks: [
    { type: 'h1', text: 'Hub' }, { type: 'diagram', text: EXAMPLE }, { type: 'p', text: 'The hub stores events.' },
  ] }) + '\n```');
  const id = created.json.doc.id;
  const doc = (await h.get(`/v1/docs/${id}`)).json.doc;
  assert.deepEqual(doc.blocks.map((b) => b.type), ['h1', 'diagram', 'p']);
  assert.equal(doc.blocks[1].text, EXAMPLE);

  const exp = await h.api('POST', `/v1/docs/${id}/export`, { format: 'html' });
  assert.equal(exp.status, 200);
  assert.match(exp.text, /<figure class="diagram" data-block="b2"><svg /);

  // comment on the diagram, Apply all, the model breaks it: conflict with the parse error; then fixes it: applied
  const c = await h.api('POST', `/v1/docs/${id}/comments`, { blockId: 'b2', start: 0, end: 3, text: 'add a cache node' });
  assert.equal(c.status, 201);
  let apply = await h.api('POST', `/v1/docs/${id}/apply`, {});
  assert.equal(apply.json.job.input.blocks.find((b) => b.id === 'b2').type, 'diagram');
  assert.equal(apply.json.job.input.blocks.find((b) => b.id === 'b2').text, EXAMPLE);
  modAnswer(h, apply.json.job.id, JSON.stringify({ patches: [{ commentId: c.json.comment.id, blockId: 'b2', op: 'replace_text', text: EXAMPLE + '\nc -> cache[(Cache' }] }));
  let comments = (await h.get(`/v1/docs/${id}`)).json.comments;
  assert.equal(comments[0].state, 'conflict');
  assert.match(comments[0].reason, /the diagram would not parse \(line 4: missing \)\] to close the label\)/);
  assert.equal((await h.get(`/v1/docs/${id}`)).json.doc.blocks[1].text, EXAMPLE, 'unchanged');
  apply = await h.api('POST', `/v1/docs/${id}/apply`, {});
  modAnswer(h, apply.json.job.id, JSON.stringify({ patches: [{ commentId: c.json.comment.id, blockId: 'b2', op: 'replace_text', text: EXAMPLE + '\nc -> cache[(Cache)]' }] }));
  comments = (await h.get(`/v1/docs/${id}`)).json.comments;
  assert.equal(comments[0].state, 'applied');
  assert.match((await h.get(`/v1/docs/${id}`)).json.doc.blocks[1].text, /cache\[\(Cache\)\]$/);
});

test('hub: browser edits may save a diagram that does not parse yet (it is the author typing), and it is exported as a note', async (t) => {
  const { h, pid } = await setup(); t.after(h.stop);
  const created = await h.api('POST', '/v1/docs', { projectId: pid, title: 'WIP', blocks: [{ type: 'diagram', text: 'a -> ' }] });
  assert.equal(created.status, 201);
  const exp = await h.api('POST', `/v1/docs/${created.json.doc.id}/export`, { format: 'html' });
  assert.match(exp.text, /\[diagram not drawn: line 1:/);
  assert.match(exp.text, /<pre>a -&gt; <\/pre>/);
});

test('export: docx has the diagram as a PNG picture (Chrome + textutil), pdf draws it, html inlines it', { skip: !(hasChrome && hasTextutil) && 'needs Chrome and textutil' }, async (t) => {
  const { h } = await setup(); t.after(h.stop);
  const blocks = [{ type: 'h1', text: 'Doc' }, { type: 'diagram', text: EXAMPLE }, { type: 'diagram', text: 'a -> ' }, { type: 'p', text: 'end' }];
  const post = async (format) => {
    const r = await fetch(h.base + '/v1/docs/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format, title: 'D', blocks }) });
    return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  };
  const docx = await post('docx');
  assert.equal(docx.status, 200);
  const z = readZip(docx.buf);
  const png = z.get('word/media/diagram-1.png');
  assert.ok(png && png.readUInt32BE(0) === 0x89504e47, 'the first diagram is a PNG in the docx');
  assert.ok(!z.has('word/media/diagram-2.png'), 'the broken diagram is not drawn');
  const xml = z.get('word/document.xml').toString();
  assert.match(xml, /<w:drawing>/);
  assert.ok(!xml.includes('helm-diagram'), 'no placeholder left behind');
  assert.match(xml, /diagram not drawn: line 1: /);
  assert.match(xml, /a -&gt; /);
  const pdf = await post('pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF');
});

test('export: without Chrome the docx keeps the diagram as a note plus its source (HELM_CHROME pointing nowhere)', { skip: !hasTextutil && 'needs textutil' }, async (t) => {
  const prev = process.env.HELM_CHROME;
  process.env.HELM_CHROME = '/nonexistent/chrome';
  const { h } = await setup();
  t.after(async () => { await h.stop(); if (prev === undefined) delete process.env.HELM_CHROME; else process.env.HELM_CHROME = prev; });
  const r = await fetch(h.base + '/v1/docs/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'docx', title: 'D', blocks: [{ type: 'diagram', text: EXAMPLE }] }) });
  assert.equal(r.status, 200);
  const z = readZip(Buffer.from(await r.arrayBuffer()));
  assert.ok(![...z.keys()].some((k) => k.startsWith('word/media/')));
  const xml = z.get('word/document.xml').toString();
  assert.match(xml, /diagram not drawn: drawing it needs Chrome/);
  assert.match(xml, /group "Hub" \{ a\[Mod\] -&gt; b\[Hub\] \}/, 'the source text is kept');
});
