// T-55: web/markdown.js inline() must not drop the tail of a paragraph with more than 500 spans.
import test from 'node:test';
import assert from 'node:assert/strict';

// Tiny fake DOM, just enough for web/dom.js h() and markdown.js.
class FNode {}
class FText extends FNode {
  constructor(t) { super(); this.data = t; }
  get textContent() { return this.data; }
}
class FEl extends FNode {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.attrs = {}; this.style = { setProperty() {} }; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.children.push(typeof c === 'string' ? new FText(c) : c); }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = v ? [new FText(String(v))] : []; }
}
globalThis.Node = FNode;
globalThis.document = { createElement: (t) => new FEl(t), createTextNode: (t) => new FText(t) };

const { renderMarkdown } = await import('../../web/markdown.js');

test('a paragraph with more than 500 spans keeps all of its text', () => {
  const N = 600;
  let src = '';
  let expected = '';
  for (let i = 0; i < N; i++) {
    src += i % 2 ? `**b${i}** ` : `\`c${i}\` `;
    expected += i % 2 ? `b${i} ` : `c${i} `;
  }
  src += 'TAIL-MARKER';
  expected += 'TAIL-MARKER';
  const p = renderMarkdown(src).children[0];
  assert.equal(p.tag, 'p');
  assert.ok(p.textContent.includes('TAIL-MARKER'));
  // spans up to the guard are parsed; the rest is plain text, so only markup characters differ
  const stripped = p.textContent.replace(/[`*]/g, '');
  assert.equal(stripped, expected);
  assert.ok(p.children.some((c) => c.tag === 'strong'));
});
