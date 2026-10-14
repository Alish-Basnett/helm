// studio/blocks.js — pure helpers for the block tree (no DOM, so node:test can load it).
// A block is { id, type, text }. Types follow docs/PLAN-studio.md: h1 h2 h3 p li quote code, plus `diagram` (text is the diagram DSL, see diagram.js).
import { DIAGRAM_STARTER } from './diagram.js';
export const BLOCK_TYPES = ['p', 'h1', 'h2', 'h3', 'li', 'quote', 'code', 'diagram'];
export const TYPE_LABEL = { p: 'Paragraph', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', li: 'List item', quote: 'Quote', code: 'Code', diagram: 'Diagram' };
/** Blocks whose text is literal lines (Enter adds a line instead of splitting the block, newlines survive). */
export const keepsNewlines = (type) => type === 'code' || type === 'diagram';
export const MAX_BLOCKS = 2000;
export const MAX_TEXT = 20000;

/** Next unused block id ("b1", "b2", …), stable for the life of the doc. */
export function nextBlockId(blocks) {
  let n = 0;
  for (const b of blocks) { const m = /^b(\d+)$/.exec(b.id); if (m) n = Math.max(n, +m[1]); }
  return `b${n + 1}`;
}

/** Defensive copy that drops unknown types and caps lengths (data may come from storage or, later, the hub). */
export function cleanBlocks(list) {
  const out = [];
  const seen = new Set();
  for (const b of Array.isArray(list) ? list : []) {
    if (!b || typeof b !== 'object') continue;
    const type = BLOCK_TYPES.includes(b.type) ? b.type : 'p';
    const text = typeof b.text === 'string' ? b.text.slice(0, MAX_TEXT) : '';
    let id = typeof b.id === 'string' && /^b\d+$/.test(b.id) && !seen.has(b.id) ? b.id : nextBlockId(out.concat([...seen].map((s) => ({ id: s }))));
    seen.add(id);
    out.push({ id, type, text });
    if (out.length >= MAX_BLOCKS) break;
  }
  return out.length ? out : [{ id: 'b1', type: 'p', text: '' }];
}

/** Type of the block created when Enter splits a block of type `t`. */
export function followType(t) { return t === 'li' || t === 'quote' ? t : 'p'; }

/**
 * Enter at `offset`: the block keeps text[0..offset), a new block gets the rest.
 * Enter on an empty list item or quote just ends the list/quote (the block becomes a paragraph, no new block).
 */
export function splitBlock(blocks, id, offset) {
  const i = blocks.findIndex((b) => b.id === id);
  if (i < 0) return null;
  const b = blocks[i];
  if (!b.text && (b.type === 'li' || b.type === 'quote')) {
    const next = blocks.map((x) => (x.id === id ? { ...x, type: 'p' } : x));
    return { blocks: next, focusId: id, offset: 0, created: null };
  }
  const o = Math.max(0, Math.min(offset, b.text.length));
  const created = { id: nextBlockId(blocks), type: followType(b.type), text: b.text.slice(o) };
  const next = blocks.slice();
  next[i] = { ...b, text: b.text.slice(0, o) };
  next.splice(i + 1, 0, created);
  return { blocks: next, focusId: created.id, offset: 0, created: created.id };
}

/**
 * Backspace at offset 0: first block of a non-paragraph type becomes a paragraph; otherwise merge into the previous block.
 * The surviving block is the previous one (its id is the stable anchor); the caret lands at the join.
 */
export function mergeBack(blocks, id) {
  const i = blocks.findIndex((b) => b.id === id);
  if (i < 0) return null;
  const b = blocks[i];
  if (i === 0) {
    if (b.type === 'p') return null;
    return { blocks: blocks.map((x) => (x.id === id ? { ...x, type: 'p' } : x)), focusId: id, offset: 0, removed: null };
  }
  if (b.type === 'diagram' && b.text) return null; // a diagram's source is not glued onto the paragraph above; empty it first
  const prev = blocks[i - 1];
  const next = blocks.slice();
  next[i - 1] = { ...prev, text: prev.text + b.text };
  next.splice(i, 1);
  return { blocks: next, focusId: prev.id, offset: prev.text.length, removed: id };
}

export function setType(blocks, id, type) {
  if (!BLOCK_TYPES.includes(type)) return blocks;
  // an empty block that becomes a diagram starts from a small example, so there is something to edit
  return blocks.map((b) => (b.id === id ? { ...b, type, ...(type === 'diagram' && !b.text.trim() ? { text: DIAGRAM_STARTER } : {}) } : b));
}

/** Markdown-ish typing shortcuts: "# " "## " "### " "- " "> " "``` " at the start of a paragraph. */
const SHORTCUTS = [['# ', 'h1'], ['## ', 'h2'], ['### ', 'h3'], ['- ', 'li'], ['* ', 'li'], ['> ', 'quote'], ['``` ', 'code']];
export function shortcutFor(b) {
  if (b.type !== 'p') return null;
  for (const [prefix, type] of SHORTCUTS) if (b.text.startsWith(prefix)) return { type, text: b.text.slice(prefix.length) };
  return null;
}

/**
 * Plain-text paste into block `id` over [start, end). Lines become extra blocks (not in code blocks, which keep newlines).
 * Returns the new list plus where the caret goes.
 */
export function pasteText(blocks, id, start, end, pasted) {
  const i = blocks.findIndex((b) => b.id === id);
  if (i < 0) return null;
  const b = blocks[i];
  const text = String(pasted).replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const head = b.text.slice(0, start);
  const tail = b.text.slice(end);
  if (keepsNewlines(b.type) || !text.includes('\n')) {
    const flat = text;
    const t = (head + flat + tail).slice(0, MAX_TEXT);
    const next = blocks.slice();
    next[i] = { ...b, text: t };
    return { blocks: next, focusId: id, offset: Math.min(head.length + flat.length, t.length), created: [] };
  }
  const lines = text.split('\n');
  const next = blocks.slice();
  next[i] = { ...b, text: (head + lines[0]).slice(0, MAX_TEXT) };
  const created = [];
  let all = next;
  let lastId = id;
  for (let k = 1; k < lines.length; k++) {
    const nb = { id: nextBlockId(all), type: followType(b.type), text: lines[k].slice(0, MAX_TEXT) };
    all = all.slice();
    all.splice(all.findIndex((x) => x.id === lastId) + 1, 0, nb);
    created.push(nb.id);
    lastId = nb.id;
  }
  const lastIdx = all.findIndex((x) => x.id === lastId);
  const lastBlock = all[lastIdx];
  all[lastIdx] = { ...lastBlock, text: lastBlock.text + tail };
  return { blocks: all, focusId: lastId, offset: lines[lines.length - 1].length, created };
}

/* ---------- comment anchors: { blockId, start, end, quote } ---------- */

/** Where does the quote live now? Same offsets if still valid, else the nearest exact match, else null (orphaned). */
export function reanchor(c, text) {
  if (!c.quote) return null;
  if (text.slice(c.start, c.end) === c.quote) return { start: c.start, end: c.end };
  let best = -1;
  let from = 0;
  for (;;) {
    const at = text.indexOf(c.quote, from);
    if (at < 0) break;
    if (best < 0 || Math.abs(at - c.start) < Math.abs(best - c.start)) best = at;
    from = at + 1;
  }
  return best < 0 ? null : { start: best, end: best + c.quote.length };
}

/** Re-evaluate every open comment against the current blocks (merge removes ids: pass `moved` {oldId:newId, shift}). */
export function reanchorAll(comments, blocks) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let changed = false;
  const out = comments.map((c) => {
    if (c.state !== 'open' && c.state !== 'orphaned') return c;
    if (!c.blockId) return c; // a whole-document comment has no text to find
    const b = byId.get(c.blockId);
    const r = b ? reanchor(c, b.text) : null;
    if (!r) { if (c.state === 'orphaned') return c; changed = true; return { ...c, state: 'orphaned' }; }
    if (c.state === 'open' && r.start === c.start && r.end === c.end) return c;
    changed = true;
    return { ...c, state: 'open', start: r.start, end: r.end };
  });
  return changed ? out : comments;
}

/** Title for a new doc from the description: first line, trimmed to 60 chars. */
export function titleFrom(prompt) {
  const line = String(prompt || '').trim().split('\n')[0].replace(/\s+/g, ' ');
  if (!line) return 'Untitled';
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
}

/** After a merge, comments pinned to the removed block follow their text into the surviving block. */
export function moveComments(comments, fromId, toId, shift) {
  if (!comments.some((c) => c.blockId === fromId)) return comments;
  return comments.map((c) => (c.blockId === fromId ? { ...c, blockId: toId, start: c.start + shift, end: c.end + shift } : c));
}
