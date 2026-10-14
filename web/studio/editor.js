// studio/editor.js — the block editor: one contenteditable per block, DOM calls only.
//
// HARD RULES (docs/PLAN-studio.md section 3):
//  - Nothing here ever sets innerHTML / outerHTML / insertAdjacentHTML. Block text goes in with textContent only.
//  - Paste is plain text only (clipboard 'text/plain', never 'text/html'); rich drops are refused.
//  - Enter splits a block, Backspace at the start merges into the previous one (pure logic lives in blocks.js).
import { h } from '../dom.js';
import { TYPE_LABEL, splitBlock, mergeBack, setType, shortcutFor, pasteText, keepsNewlines } from './blocks.js';
import { buildDiagram } from './diagramdom.js';

// 'plaintext-only' keeps the browser from generating markup; older engines fall back to 'true' (we still intercept everything).
const EDIT_MODE = (() => { const t = document.createElement('div'); try { t.contentEditable = 'plaintext-only'; } catch { /* old engine */ } return t.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'; })();

function textNodes(el) {
  const out = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n);
  return out;
}
/** A DOM Range covering [start, end) of a block's text. */
export function rangeFor(el, start, end) {
  const r = document.createRange();
  let pos = 0;
  let s = false;
  for (const n of textNodes(el)) {
    const len = n.nodeValue.length;
    if (!s && start <= pos + len) { r.setStart(n, start - pos); s = true; }
    if (s && end <= pos + len) { r.setEnd(n, end - pos); return r; }
    pos += len;
  }
  r.selectNodeContents(el);
  r.collapse(false);
  return r;
}
function offsetIn(el, node, off) {
  const r = document.createRange();
  r.selectNodeContents(el);
  try { r.setEnd(node, off); } catch { return 0; }
  return r.toString().length;
}
/** {start,end} of the current selection inside `el`, or null when the selection is elsewhere. */
export function selectionIn(el) {
  const s = window.getSelection();
  if (!s || !s.rangeCount) return null;
  const r = s.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  return { start: offsetIn(el, r.startContainer, r.startOffset), end: offsetIn(el, r.endContainer, r.endOffset) };
}
/**
 * Literal-line blocks (code, diagram) keep their text as ONE text node with real "\n" characters. Chrome's own Enter in a
 * contenteditable would wrap the new line in a <div>, and textContent would then lose the line break, so Enter and paste are done by
 * hand (see replaceText). A "\n" at the very end is invisible in a pre-wrap block, so a trailing <br> is kept while the text ends in one.
 */
function fixTail(el) {
  const last = el.lastChild;
  const br = last && last.nodeName === 'BR' ? last : null;
  const need = (el.textContent || '').endsWith('\n');
  if (need && !br) el.appendChild(document.createElement('br'));
  else if (!need && br) br.remove();
}
function setCaret(el, offset) {
  const sel = window.getSelection();
  const r = rangeFor(el, offset, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

export function createEditor({ onChange, onSelection, onFocusBlock, getComments }) {
  let blocks = [];
  const els = new Map();        // block id -> the contenteditable .blk
  const tops = new Map();       // block id -> its wrapper, for diagram blocks (source + errors on one side, live drawing on the other)
  const shells = new Map();     // block id -> { preview, errs, last } of a diagram wrapper
  let focusedId = null;
  let activeCommentId = null;
  let readOnly = false;
  const root = h('div', { class: 'st-blocks', role: 'group', 'aria-label': 'Document blocks' });

  const idOf = (el) => (el && el.dataset ? el.dataset.id : null);
  const blockEl = (node) => (node && (node.nodeType === 1 ? node : node.parentElement) ? (node.nodeType === 1 ? node : node.parentElement).closest('.blk') : null);

  function paint(el, b) {
    if (el.textContent !== b.text) el.textContent = b.text; // textContent: the only way text enters the DOM
    if (keepsNewlines(b.type)) fixTail(el);
    if (el.dataset.type !== b.type) {
      el.dataset.type = b.type;
      el.setAttribute('aria-label', `${TYPE_LABEL[b.type]} block`);
    }
    el.classList.toggle('is-empty', !b.text);
  }
  /** Give a diagram block its wrapper (and take it away again when the block stops being a diagram). */
  function shell(b, el) {
    let top = tops.get(b.id);
    if (b.type !== 'diagram') {
      if (top) { top.replaceWith(el); tops.delete(b.id); shells.delete(b.id); }
      return;
    }
    if (!top) {
      const errs = h('ul', { class: 'dg-errors', role: 'list', 'aria-label': 'Diagram errors' });
      const preview = h('div', { class: 'dg-preview', role: 'group', 'aria-label': 'Diagram preview' });
      const source = h('div', { class: 'dg-source' });
      top = h('div', { class: 'blk-diagram', 'data-id': b.id }, source, preview);
      if (el.parentNode === root) root.insertBefore(top, el);
      source.append(el, errs);
      tops.set(b.id, top);
      shells.set(b.id, { preview, errs, last: null });
    }
    drawDiagram(b.id, b.text);
  }
  /** Redraw a diagram block from its source (skipped when the text has not changed). The drawing and the error list are DOM calls only. */
  function drawDiagram(id, text) {
    const s = shells.get(id);
    if (!s || s.last === text) return;
    s.last = text;
    const r = buildDiagram(text);
    s.preview.textContent = '';
    s.preview.dataset.state = r.svg ? (r.errors.length ? 'partial' : 'ok') : 'empty';
    if (r.svg) s.preview.appendChild(r.svg);
    else s.preview.appendChild(h('p', { class: 'dg-hint' }, r.empty ? 'Write nodes and arrows on the left, for example: a[Mod] -> b[Hub]' : 'Nothing to draw yet. Fix the errors below.'));
    s.errs.textContent = '';
    for (const e of r.errors) s.errs.appendChild(h('li', { class: 'dg-error' }, `line ${e.line}: ${e.message}`));
  }
  function makeEl(b) {
    const el = h('div', { class: 'blk', contenteditable: readOnly ? 'false' : EDIT_MODE, role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true', 'data-id': b.id });
    els.set(b.id, el);
    return el;
  }
  function render() {
    const keep = new Set();
    blocks.forEach((b, i) => {
      const el = els.get(b.id) || makeEl(b);
      keep.add(b.id);
      paint(el, b);
      shell(b, el);
      const top = tops.get(b.id) || el;
      if (root.children[i] !== top) root.insertBefore(top, root.children[i] || null);
    });
    for (const [id, el] of els) if (!keep.has(id)) { (tops.get(id) || el).remove(); els.delete(id); tops.delete(id); shells.delete(id); }
    refreshHighlights();
  }
  function commit(next, focus) {
    blocks = next;
    render();
    if (focus) focusAt(focus.id, focus.offset);
    onChange(blocks, focus ? { structural: true } : {});
  }
  function focusAt(id, offset = 0) {
    const el = els.get(id);
    if (!el) return;
    el.focus();
    setCaret(el, Math.min(offset, (el.textContent || '').length));
    el.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- reading edits back from the DOM ---------- */
  function syncFromDom(el) {
    const b = blocks.find((x) => x.id === idOf(el));
    if (!b) return;
    let text = el.textContent || '';
    if (keepsNewlines(b.type)) fixTail(el); else text = text.replace(/\n/g, ' ');
    let next = { ...b, text };
    el.classList.toggle('is-empty', !text);
    if (b.type === 'diagram') drawDiagram(b.id, text);
    const sc = shortcutFor(next);
    if (sc) {
      const caret = selectionIn(el); // the whole "- text" can arrive in one input event, so keep the caret where it was, minus the prefix
      const prefix = text.length - sc.text.length;
      next = { ...next, type: sc.type, text: sc.text };
      blocks = blocks.map((x) => (x.id === b.id ? next : x));
      paint(el, next);
      setCaret(el, caret ? Math.max(0, caret.end - prefix) : sc.text.length);
      onChange(blocks, { structural: true });
      onFocusBlock && onFocusBlock(next);
      return;
    }
    blocks = blocks.map((x) => (x.id === b.id ? next : x));
    onChange(blocks, { id: b.id });
  }

  /** Replace [start, end) of a literal-line block with `insert` (plain text, newlines kept) and put the caret after it. */
  function replaceText(el, start, end, insert) {
    const text = el.textContent || '';
    el.textContent = text.slice(0, start) + insert + text.slice(end);
    fixTail(el);
    setCaret(el, start + insert.length);
    syncFromDom(el);
  }

  /* ---------- keyboard ---------- */
  function onKeydown(e) {
    const el = blockEl(e.target);
    if (!el || e.isComposing || e.keyCode === 229) return;
    const id = idOf(el);
    const b = blocks.find((x) => x.id === id);
    if (!b) return;
    const sel = selectionIn(el);
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter') {
      if (keepsNewlines(b.type) && !mod) { e.preventDefault(); if (sel) replaceText(el, sel.start, sel.end, '\n'); return; }
      e.preventDefault();
      if (e.shiftKey && !mod) return; // blocks are paragraphs of one logical line; Shift+Enter does nothing
      if (!sel) return;
      const text = b.text.slice(0, sel.start) + b.text.slice(sel.end);
      const base = blocks.map((x) => (x.id === id ? { ...x, text } : x));
      const r = splitBlock(base, id, sel.start);
      if (r) commit(r.blocks, { id: r.focusId, offset: r.offset });
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && sel && sel.start === sel.end && !mod && !e.altKey) {
      const i = blocks.findIndex((x) => x.id === id);
      if (e.key === 'Backspace' && sel.start === 0) {
        const r = mergeBack(blocks, id);
        e.preventDefault();
        if (r) { if (r.removed) moveComments(id, r.focusId, blocks[i - 1].text.length); commit(r.blocks, { id: r.focusId, offset: r.offset }); }
        return;
      }
      if (e.key === 'Delete' && sel.start === b.text.length && blocks[i + 1]) {
        e.preventDefault();
        const nextId = blocks[i + 1].id;
        const r = mergeBack(blocks, nextId);
        if (r) { moveComments(nextId, id, b.text.length); commit(r.blocks, { id: r.focusId, offset: r.offset }); }
        return;
      }
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') && sel && sel.start === 0 && sel.end === 0 && !e.shiftKey && !mod && !e.altKey) {
      const i = blocks.findIndex((x) => x.id === id);
      if (i > 0) { e.preventDefault(); const p = blocks[i - 1]; focusAt(p.id, p.text.length); }
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && sel && sel.start === b.text.length && sel.end === b.text.length && !e.shiftKey && !mod && !e.altKey) {
      const i = blocks.findIndex((x) => x.id === id);
      if (blocks[i + 1]) { e.preventDefault(); focusAt(blocks[i + 1].id, 0); }
    }
  }
  // comments pinned to a merged-away block follow their text; the view owns the list, so ask it through getComments()
  let moveHook = null;
  function moveComments(fromId, toId, shift) { if (moveHook) moveHook(fromId, toId, shift); }

  /* ---------- paste / drop: plain text only ---------- */
  function onPaste(e) {
    const el = blockEl(e.target);
    if (!el) return;
    e.preventDefault();
    const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    if (!text) return;
    const id = idOf(el);
    const b = blocks.find((x) => x.id === id);
    const sel = selectionIn(el);
    if (!b || !sel) return;
    if (keepsNewlines(b.type)) { replaceText(el, sel.start, sel.end, text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')); return; }
    const multi = /[\r\n]/.test(text);
    if (!multi) {
      const flat = text.replace(/\s*\n\s*/g, ' ');
      if (document.execCommand('insertText', false, flat)) return; // keeps the browser's own undo for this block
    }
    const r = pasteText(blocks, id, sel.start, sel.end, text);
    if (r) commit(r.blocks, { id: r.focusId, offset: r.offset });
  }
  function onDrop(e) {
    const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
    if (types.includes('Files') || types.includes('text/html') || EDIT_MODE !== 'plaintext-only') e.preventDefault();
  }
  function onBeforeInput(e) {
    // block rich formatting (Cmd+B / Cmd+I in engines that fall back to contenteditable="true")
    if (e.inputType && e.inputType.startsWith('format')) e.preventDefault();
    // a phone keyboard may send a line break without a keydown Enter: in a code or diagram block it is a "\n" in the text
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
      const el = blockEl(e.target);
      const b = el && blocks.find((x) => x.id === idOf(el));
      const sel = el && selectionIn(el);
      if (b && keepsNewlines(b.type) && sel) { e.preventDefault(); replaceText(el, sel.start, sel.end, '\n'); }
    }
  }

  /* ---------- selection -> comment anchor ---------- */
  function currentAnchor() {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    const a = blockEl(r.startContainer);
    const z = blockEl(r.endContainer);
    if (!a || a !== z || !root.contains(a)) return null;
    const sel = selectionIn(a);
    if (!sel || sel.start === sel.end) return null;
    const text = a.textContent || '';
    const quote = text.slice(sel.start, sel.end);
    if (!quote.trim()) return null;
    return { blockId: idOf(a), start: sel.start, end: sel.end, quote: quote.slice(0, 500), rect: r.getBoundingClientRect() };
  }
  function onSelectionChange() {
    const a = currentAnchor();
    onSelection && onSelection(a);
    const fe = blockEl(document.activeElement);
    const fid = fe && root.contains(fe) ? idOf(fe) : null;
    if (fid && fid !== focusedId) { focusedId = fid; onFocusBlock && onFocusBlock(blocks.find((x) => x.id === fid)); }
  }

  /* ---------- comment highlights (CSS Custom Highlight API; no extra DOM inside editable text) ---------- */
  function refreshHighlights() {
    if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
    const all = []; const active = [];
    for (const c of (getComments ? getComments() : [])) {
      if (c.state !== 'open') continue;
      const el = els.get(c.blockId);
      if (!el || !el.textContent) continue;
      const r = rangeFor(el, c.start, c.end);
      (c.id === activeCommentId ? active : all).push(r);
    }
    CSS.highlights.set('st-comment', new Highlight(...all));
    CSS.highlights.set('st-comment-active', new Highlight(...active));
  }

  root.addEventListener('keydown', onKeydown);
  root.addEventListener('input', (e) => { const el = blockEl(e.target); if (el) syncFromDom(el); });
  root.addEventListener('paste', onPaste);
  root.addEventListener('drop', onDrop);
  root.addEventListener('beforeinput', onBeforeInput);
  root.addEventListener('focusin', (e) => {
    const el = blockEl(e.target);
    if (el) { focusedId = idOf(el); onFocusBlock && onFocusBlock(blocks.find((x) => x.id === focusedId)); }
  });
  document.addEventListener('selectionchange', onSelectionChange);

  return {
    el: root,
    mode: EDIT_MODE,
    onMoveComments(fn) { moveHook = fn; },
    setBlocks(list) { blocks = list.map((b) => ({ ...b })); render(); },
    /** Lock the page while the model drafts it (typing then would make the draft stale and discard it). */
    setReadOnly(v) {
      readOnly = !!v;
      root.dataset.readonly = readOnly ? 'true' : 'false';
      for (const el of els.values()) el.setAttribute('contenteditable', readOnly ? 'false' : EDIT_MODE);
    },
    getBlocks: () => blocks,
    focusedId: () => focusedId,
    focusAt,
    focusFirst() { if (blocks[0]) focusAt(blocks[0].id, blocks[0].text.length); },
    /** Change the type of the focused block (toolbar / shortcuts). */
    setFocusedType(type) {
      const id = focusedId || (blocks[0] && blocks[0].id);
      if (!id) return;
      const sel = els.get(id) && selectionIn(els.get(id));
      blocks = setType(blocks, id, type);
      render();
      onChange(blocks, { structural: true });
      focusAt(id, sel ? sel.end : 0);
      onFocusBlock && onFocusBlock(blocks.find((x) => x.id === id));
    },
    currentAnchor,
    refreshHighlights,
    setActiveComment(id) { activeCommentId = id; refreshHighlights(); },
    /** Select a comment's quoted text and scroll it into view. */
    reveal(c) {
      const el = els.get(c.blockId);
      if (!el) return false;
      el.focus();
      const r = rangeFor(el, c.start, c.end);
      const s = window.getSelection();
      s.removeAllRanges(); s.addRange(r);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    },
    destroy() {
      document.removeEventListener('selectionchange', onSelectionChange);
      if (window.CSS && CSS.highlights) { CSS.highlights.delete('st-comment'); CSS.highlights.delete('st-comment-active'); }
    },
  };
}
