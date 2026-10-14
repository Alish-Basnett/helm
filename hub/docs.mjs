// Studio documents (CONTRACT v0.15): block model, validation, markdown/HTML serializers, patch judge and the deterministic
// reducer for `hub.doc.*` events. Commands, jobs and export live in hub.mjs / docsengine.mjs; this file has no clock and no
// randomness (time is `ev.at`, ids come from the counters table), so `helmd --rebuild` replays documents exactly.
import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';
import { renderDiagramSvg, diagramProblem } from '../web/studio/diagram.js'; // pure module shared with the browser

const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));
const cut = (s, n) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const bad = (m) => new HttpError(400, m);

export const BLOCK_TYPES = ['h1', 'h2', 'h3', 'p', 'li', 'quote', 'code', 'hr', 'img', 'table', 'diagram'];
export const MARK_TYPES = ['b', 'i', 'a'];
export const DOC_KINDS = ['document', 'report', 'letter', 'notes', 'other'];
export const COMMENT_STATES = ['open', 'queued', 'applied', 'conflict', 'orphaned', 'dismissed'];
export const VERSION_CAUSES = ['create', 'draft', 'edit', 'apply', 'revert', 'manual'];
export const EXPORT_FORMATS = ['html', 'md', 'pdf', 'docx'];
export const MAX_BLOCKS = 2000;
export const MAX_TEXT = 20000;
export const MAX_DOC_CHARS = 400000;
export const MAX_VERSIONS = 100;
export const EDIT_COALESCE_MS = 5 * 60_000;
export const MAX_COMMENT = 4000;
const MAX_TABLE_ROWS = 200, MAX_TABLE_COLS = 30, MAX_CELL = 2000, MAX_MARKS = 500, MAX_LEVEL = 6;
const ID_RE = /^b(\d{1,9})$/;
const SAFE_HREF = /^(https?:\/\/|mailto:)[^\s]{1,2000}$/i;

// ------------------------------------------------------------------ mappers
export const toDoc = (r, { blocks = true } = {}) => ({
  id: r.id, projectId: r.project_id, title: r.title, kind: r.kind, version: r.version, sessionId: r.session_id ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at, archived: !!r.archived,
  ...(blocks ? { blocks: parse(r.blocks, []) } : { blockCount: parse(r.blocks, []).length }),
});
export const toDocVersion = (r, { blocks = false } = {}) => ({
  docId: r.doc_id, n: r.n, cause: r.cause, jobId: r.job_id ?? null, at: r.at,
  ...(blocks ? { blocks: parse(r.blocks, []) } : {}),
});
export const toDocComment = (r) => ({
  id: r.id, docId: r.doc_id, blockId: r.block_id ?? null, anchor: parse(r.anchor, null), text: r.text, state: r.state,
  createdAt: r.created_at, appliedVersion: r.applied_version ?? null, jobId: r.job_id ?? null, reason: r.reason ?? null,
});
export const getDoc = (db, id) => db.get('SELECT * FROM docs WHERE id = ?', id);
export const getDocVersion = (db, id, n) => db.get('SELECT * FROM doc_versions WHERE doc_id = ? AND n = ?', id, n);
export const getComment = (db, id) => db.get('SELECT * FROM doc_comments WHERE id = ?', id);

// ------------------------------------------------------------ block validation
export function cleanMarks(marks, len) {
  if (marks === undefined || marks === null) return [];
  if (!Array.isArray(marks)) throw bad('marks must be an array');
  if (marks.length > MAX_MARKS) throw bad(`at most ${MAX_MARKS} marks per block`);
  const out = [];
  for (const m of marks) {
    if (!isObj(m) || !MARK_TYPES.includes(m.t)) throw bad('mark.t must be b, i or a');
    if (!Number.isInteger(m.s) || !Number.isInteger(m.e) || m.s < 0 || m.e > len || m.s >= m.e) throw bad('mark range is outside the text');
    const o = { s: m.s, e: m.e, t: m.t };
    if (m.t === 'a') {
      if (typeof m.href !== 'string' || !SAFE_HREF.test(m.href)) throw bad('link marks need an http(s) or mailto href');
      o.href = m.href;
    }
    out.push(o);
  }
  return out.sort((a, b) => a.s - b.s || a.e - b.e || (a.t < b.t ? -1 : 1));
}

/** Validate one block against the closed vocabulary. `id` may be missing (assigned by the caller). */
export function cleanBlock(b) {
  if (!isObj(b)) throw bad('a block must be an object');
  if (!BLOCK_TYPES.includes(b.type)) throw bad(`block type must be one of ${BLOCK_TYPES.join(', ')}`);
  if (b.id !== undefined && !(typeof b.id === 'string' && ID_RE.test(b.id))) throw bad('block id must look like b12');
  const o = { type: b.type };
  if (b.id !== undefined) o.id = b.id;
  if (b.type === 'hr') { o.text = ''; o.marks = []; return o; }
  if (b.type === 'table') {
    if (!Array.isArray(b.rows) || b.rows.length > MAX_TABLE_ROWS) throw bad(`table rows must be an array of at most ${MAX_TABLE_ROWS} rows`);
    o.rows = b.rows.map((row) => {
      if (!Array.isArray(row) || row.length > MAX_TABLE_COLS || row.some((c) => typeof c !== 'string')) throw bad('table rows must be arrays of strings');
      return row.map((c) => c.slice(0, MAX_CELL));
    });
    o.text = ''; o.marks = [];
    return o;
  }
  const text = b.text === undefined ? '' : b.text;
  if (typeof text !== 'string') throw bad('block text must be a string');
  if (text.length > MAX_TEXT) throw bad(`block text is longer than ${MAX_TEXT} characters`);
  o.text = text;
  o.marks = b.type === 'code' || b.type === 'img' || b.type === 'diagram' ? [] : cleanMarks(b.marks, text.length);
  if (b.type === 'li') {
    const lv = b.level === undefined ? 0 : b.level;
    if (!Number.isInteger(lv) || lv < 0 || lv > MAX_LEVEL) throw bad(`li level must be 0 to ${MAX_LEVEL}`);
    o.level = lv;
    o.ordered = !!b.ordered;
  }
  if (b.type === 'img') {
    if (typeof b.attachmentId !== 'string' || !/^[\w-]{1,64}$/.test(b.attachmentId)) throw bad('img blocks need an attachmentId');
    o.attachmentId = b.attachmentId;
  }
  return o;
}

export const maxBlockNumber = (blocks) => blocks.reduce((m, b) => Math.max(m, Number(ID_RE.exec(b.id || '')?.[1] || 0)), 0);
export const blockChars = (blocks) => blocks.reduce((n, b) => n + (b.text || '').length + (b.rows ? b.rows.flat().join('').length : 0), 0);

/**
 * Validate a list of blocks and give the ones without an id a fresh `b<n>` (n counts up from `next`).
 * Returns { blocks, next }. Duplicate ids and oversized documents are refused.
 */
export function cleanBlocks(list, next = 1) {
  if (!Array.isArray(list)) throw bad('blocks must be an array');
  if (list.length > MAX_BLOCKS) throw bad(`at most ${MAX_BLOCKS} blocks`);
  const seen = new Set();
  let n = Math.max(1, next);
  const out = list.map((raw) => {
    const b = cleanBlock(raw);
    if (b.id) { if (seen.has(b.id)) throw bad(`duplicate block id ${b.id}`); seen.add(b.id); }
    return b;
  });
  for (const b of out) if (b.id) n = Math.max(n, Number(ID_RE.exec(b.id)[1]) + 1);
  const withIds = out.map((b) => {
    if (b.id) return b;
    let id; do { id = `b${n++}`; } while (seen.has(id));
    seen.add(id);
    return { id, ...b };
  });
  if (blockChars(withIds) > MAX_DOC_CHARS) throw bad(`the document is longer than ${MAX_DOC_CHARS} characters`);
  return { blocks: withIds, next: n };
}

/** Plain text of a block (tables join cells), for search, quotes and the model. */
export const blockText = (b) => (b.type === 'table' ? (b.rows || []).map((r) => r.join(' | ')).join('\n') : b.text || '');
export const docText = (blocks) => blocks.map(blockText).filter(Boolean).join('\n');

// ------------------------------------------------------------------ markdown
/** Inline markdown (**bold**, *italic*, _italic_, [text](url)) -> { text, marks }. Anything else stays literal. */
export function parseInline(src) {
  let text = '';
  const marks = [];
  const s = String(src);
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if ((m = /^\*\*([^*]+?)\*\*/.exec(rest))) {
      const inner = parseInline(m[1]);
      const off = text.length;
      text += inner.text;
      marks.push({ s: off, e: text.length, t: 'b' }, ...inner.marks.map((k) => ({ ...k, s: k.s + off, e: k.e + off })));
      i += m[0].length;
    } else if ((m = /^(?:\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_)/.exec(rest))) {
      const inner = parseInline(m[1] ?? m[2]);
      const off = text.length;
      text += inner.text;
      marks.push({ s: off, e: text.length, t: 'i' }, ...inner.marks.map((k) => ({ ...k, s: k.s + off, e: k.e + off })));
      i += m[0].length;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)) && SAFE_HREF.test(m[2])) {
      const off = text.length;
      text += m[1];
      marks.push({ s: off, e: text.length, t: 'a', href: m[2] });
      i += m[0].length;
    } else { text += s[i]; i++; }
  }
  return { text, marks: marks.filter((k) => k.e > k.s) };
}

/** Markdown -> blocks without ids (the model writes markdown; `cleanBlocks` then validates and numbers them). */
export function parseMarkdown(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const { text, marks } = parseInline(para.join(' ').trim());
    if (text) out.push({ type: 'p', text, marks });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/^\s*<!--\s*b\d+\s*-->\s?/, ''); // ids from our own markdown are dropped: the hub numbers blocks
    const line = raw.replace(/\s+$/, '');
    let m;
    if (/^```/.test(line)) {
      flush();
      const info = /^```\s*([A-Za-z]*)/.exec(line)[1].toLowerCase();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push({ type: info === 'diagram' ? 'diagram' : 'code', text: code.join('\n') });
    } else if (!line.trim()) flush();
    else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flush(); const r = parseInline(m[2]); out.push({ type: `h${m[1].length}`, text: r.text, marks: r.marks }); }
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flush(); out.push({ type: 'hr' }); }
    else if ((m = /^>\s?(.*)$/.exec(line))) { flush(); const r = parseInline(m[1]); out.push({ type: 'quote', text: r.text, marks: r.marks }); }
    else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flush();
      const r = parseInline(m[3]);
      out.push({ type: 'li', text: r.text, marks: r.marks, level: Math.min(MAX_LEVEL, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), ordered: /\d/.test(m[2]) });
    } else if (/^\|.*\|$/.test(line.trim())) {
      flush();
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
      }
      i--;
      out.push({ type: 'table', rows });
    } else para.push(line.trim());
  }
  flush();
  return out;
}

function inlineMarkdown(b) {
  const text = b.text || '';
  const pts = new Set([0, text.length]);
  for (const k of b.marks || []) { pts.add(k.s); pts.add(k.e); }
  const cuts = [...pts].sort((a, c) => a - c);
  let out = '';
  for (let i = 0; i < cuts.length - 1; i++) {
    const seg = text.slice(cuts[i], cuts[i + 1]);
    if (!seg) continue;
    const act = (b.marks || []).filter((k) => k.s <= cuts[i] && k.e >= cuts[i + 1]);
    let s = seg;
    if (act.some((k) => k.t === 'i')) s = `*${s}*`;
    if (act.some((k) => k.t === 'b')) s = `**${s}**`;
    const a = act.find((k) => k.t === 'a');
    if (a) s = `[${s}](${a.href})`;
    out += s;
  }
  return out;
}

/** Blocks -> markdown. With `ids` every block is prefixed `<!--bN-->` so the model can refer to blocks. */
export function blocksToMarkdown(blocks, { ids = false } = {}) {
  const lines = [];
  for (const b of blocks) {
    const tag = ids ? `<!--${b.id}--> ` : '';
    switch (b.type) {
      case 'h1': case 'h2': case 'h3': lines.push(`${tag}${'#'.repeat(Number(b.type[1]))} ${inlineMarkdown(b)}`, ''); break;
      case 'p': lines.push(`${tag}${inlineMarkdown(b)}`, ''); break;
      case 'quote': lines.push(`${tag}> ${inlineMarkdown(b)}`, ''); break;
      case 'li': lines.push(`${tag}${'  '.repeat(b.level || 0)}${b.ordered ? '1.' : '-'} ${inlineMarkdown(b)}`); break;
      case 'code': lines.push(`${tag}\`\`\``.trimEnd(), b.text, '```', ''); break;
      case 'diagram': lines.push(`${tag}\`\`\`diagram`, b.text, '```', ''); break;
      case 'hr': lines.push(`${tag}---`, ''); break;
      case 'img': lines.push(`${tag}![${b.text}](attachment:${b.attachmentId})`, ''); break;
      case 'table': {
        const rows = b.rows || [];
        if (!rows.length) break;
        lines.push(`${tag}| ${rows[0].join(' | ')} |`, `| ${rows[0].map(() => '---').join(' | ')} |`);
        for (const r of rows.slice(1)) lines.push(`| ${r.join(' | ')} |`);
        lines.push('');
        break;
      }
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ----------------------------------------------------------------------- HTML
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineHtml(b, mark) {
  const text = b.text || '';
  const pts = new Set([0, text.length]);
  for (const k of b.marks || []) { pts.add(k.s); pts.add(k.e); }
  for (const k of mark || []) { pts.add(k.s); pts.add(k.e); }
  const cuts = [...pts].filter((p) => p >= 0 && p <= text.length).sort((a, c) => a - c);
  let out = '';
  for (let i = 0; i < cuts.length - 1; i++) {
    const seg = text.slice(cuts[i], cuts[i + 1]);
    if (!seg) continue;
    const act = (b.marks || []).filter((k) => k.s <= cuts[i] && k.e >= cuts[i + 1]);
    let h = esc(seg);
    if (act.some((k) => k.t === 'i')) h = `<em>${h}</em>`;
    if (act.some((k) => k.t === 'b')) h = `<strong>${h}</strong>`;
    const a = act.find((k) => k.t === 'a');
    if (a && SAFE_HREF.test(a.href)) h = `<a href="${esc(a.href)}">${h}</a>`;
    if ((mark || []).some((k) => k.s <= cuts[i] && k.e >= cuts[i + 1])) h = `<mark>${h}</mark>`;
    out += h;
  }
  return out;
}

export const PRINT_CSS = `@page{size:A4;margin:22mm 20mm}
*{box-sizing:border-box}
body{font:11pt/1.55 Georgia,'Times New Roman',serif;color:#1a1a1a;margin:0}
h1{font-size:22pt;margin:0 0 .5em}h2{font-size:16pt;margin:1.4em 0 .4em}h3{font-size:13pt;margin:1.2em 0 .3em}
h1,h2,h3{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;line-height:1.25;break-after:avoid}
p{margin:0 0 .8em}ul,ol{margin:0 0 .8em;padding-left:1.4em}li{margin:.15em 0}
blockquote{margin:0 0 .8em;padding-left:1em;border-left:3px solid #bbb;color:#444}
pre{background:#f4f4f4;padding:.7em;border-radius:4px;white-space:pre-wrap;font:9.5pt/1.4 Menlo,monospace;break-inside:avoid}
hr{border:0;border-top:1px solid #ccc;margin:1.2em 0}
table{border-collapse:collapse;margin:0 0 1em;width:100%}td,th{border:1px solid #bbb;padding:.3em .5em;vertical-align:top;font-size:10pt}
tr:first-child td{font-weight:600;background:#f4f4f4}
mark{background:#fff2a8}img{max-width:100%}a{color:#1a4fd6}
figure.diagram{margin:0 0 1em;text-align:center;break-inside:avoid}figure.diagram svg{max-width:100%;height:auto}
figure.diagram pre{text-align:left}.diagram-note{margin:0 0 .4em;font:9.5pt -apple-system,Helvetica,Arial,sans-serif;color:#a33}`;

/** The default HTML for a diagram block: its SVG inline, or a short note plus the source when it cannot be drawn. */
export function diagramFigure(b, idAttr = '') {
  const r = renderDiagramSvg(b.text);
  if (r.svg) return `<figure class="diagram"${idAttr}>${r.svg}</figure>`;
  return diagramOmitted(b, idAttr, r.errors.length ? `line ${r.errors[0].line}: ${r.errors[0].message}` : 'it has no nodes');
}
/** A diagram that is not drawn: the reason, then the source text, so nothing is lost. */
export function diagramOmitted(b, idAttr = '', reason = '') {
  return `<figure class="diagram"${idAttr}><p class="diagram-note">[diagram not drawn${reason ? `: ${esc(reason)}` : ''}]</p><pre>${esc(b.text)}</pre></figure>`;
}

/**
 * Blocks -> a complete HTML document. Every text run is escaped and the vocabulary is closed, so this is string building
 * from validated data, not untrusted HTML. `highlight` is a Map blockId -> [{s,e}] used by the preview variant only.
 */
export function blocksToHtml(blocks, { title = '', highlight = null, imgSrc = null, diagramHtml = null } = {}) {
  const out = [];
  const lists = []; // open list stack: 'ul' | 'ol'
  const closeTo = (n) => { while (lists.length > n) out.push(`</${lists.pop()}>`); };
  for (const b of blocks) {
    if (b.type !== 'li') closeTo(0);
    const mk = highlight?.get(b.id);
    const idAttr = ` data-block="${esc(b.id)}"`;
    switch (b.type) {
      case 'h1': case 'h2': case 'h3': out.push(`<${b.type}${idAttr}>${inlineHtml(b, mk)}</${b.type}>`); break;
      case 'p': out.push(`<p${idAttr}>${inlineHtml(b, mk)}</p>`); break;
      case 'quote': out.push(`<blockquote${idAttr}>${inlineHtml(b, mk)}</blockquote>`); break;
      case 'code': out.push(`<pre${idAttr}>${esc(b.text)}</pre>`); break;
      case 'diagram': out.push((diagramHtml && diagramHtml(b, idAttr)) || diagramFigure(b, idAttr)); break;
      case 'hr': out.push('<hr>'); break;
      case 'img': {
        const src = imgSrc ? imgSrc(b) : null;
        out.push(src ? `<p${idAttr}><img src="${esc(src)}" alt="${esc(b.text)}"></p>` : `<p${idAttr}>[image: ${esc(b.text)}]</p>`);
        break;
      }
      case 'table':
        out.push(`<table${idAttr}>${(b.rows || []).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`);
        break;
      case 'li': {
        const want = (b.level || 0) + 1, kind = b.ordered ? 'ol' : 'ul';
        closeTo(want);
        while (lists.length < want) { lists.push(kind); out.push(`<${kind}>`); }
        if (lists[want - 1] !== kind) { out.push(`</${lists[want - 1]}>`, `<${kind}>`); lists[want - 1] = kind; }
        out.push(`<li${idAttr}>${inlineHtml(b, mk)}</li>`);
        break;
      }
    }
  }
  closeTo(0);
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>\n${out.join('\n')}\n</body></html>\n`;
}

// --------------------------------------------------------------- comment anchors
/** Build the stored anchor for a selection: { blockId, start, end, quote, prefix, suffix }. */
export function makeAnchor(block, start, end) {
  const text = blockText(block);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) throw bad('anchor range is outside the block text');
  return { blockId: block.id, start, end, quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - 24), start), suffix: text.slice(end, end + 24) };
}
/** Re-locate an anchor in the block's current text: trust start/end, else prefix+quote+suffix, else quote alone, else null. */
export function relocate(anchor, text) {
  if (text.slice(anchor.start, anchor.end) === anchor.quote) return anchor;
  const at = (needle, shift) => { const i = text.indexOf(needle); return i === -1 ? null : { ...anchor, start: i + shift, end: i + shift + anchor.quote.length }; };
  return at(anchor.prefix + anchor.quote + anchor.suffix, anchor.prefix.length) || at(anchor.prefix + anchor.quote, anchor.prefix.length) || at(anchor.quote, 0);
}

// ------------------------------------------------------------------- patch judge
/** Short content hash of a block (type, text, marks, structure). The doc_edit job sends it with every block as the patch's base. */
export const blockHash = (b) => createHash('sha256')
  .update(JSON.stringify([b.type, b.text || '', b.marks || [], b.rows || null, b.level ?? 0, !!b.ordered, b.attachmentId || '']))
  .digest('hex').slice(0, 12);
export const RETYPE_TO = ['h1', 'h2', 'h3', 'p', 'quote', 'li', 'code'];
export const PATCH_OPS = ['replace_text', 'replace', 'insert_after', 'delete', 'retype', 'reply'];

/** Replace text[first, end) with `with_`; marks inside the replaced range are dropped, later ones shift. */
function spliceBlock(b, first, end, with_) {
  const text = b.text.slice(0, first) + with_ + b.text.slice(end);
  if (text.length > MAX_TEXT) return null;
  const delta = with_.length - (end - first);
  const marks = (b.marks || []).flatMap((k) => {
    if (k.e <= first) return [k];
    if (k.s >= end) return [{ ...k, s: k.s + delta, e: k.e + delta }];
    return []; // a mark that overlaps the replaced text is dropped
  });
  return { ...b, text, marks };
}

/**
 * Apply the model's patches deterministically. The hub, not the model, decides. A patch becomes a `conflict` (with a reason) unless:
 *  - its op is one of replace_text | replace (find/with) | insert_after | delete | retype (| reply, which is always a "cannot");
 *  - the block exists;
 *  - when `opts.hashes` is given, the block still has the hash it had when the job was queued (an edited block is a conflict);
 *  - when `opts.commentBlocks` is given, it targets the block its own comment is on (a whole-document comment may target any
 *    sent block), except that insert_after may also sit beside a commented block (on it or on its direct neighbour);
 *  - the result passes the block schema and the size caps, and a diagram block (changed or inserted) still parses as the diagram DSL
 *    (otherwise the reason is the parse error, e.g. "line 2: expected a node id").
 * One outcome per comment (the first patch wins). Returns { blocks, next, results:[{commentId,status,reason?}], changed:[blockId] }.
 * `opts`: { hashes: {blockId: hash}, commentBlocks: {commentId: blockId | null} }.
 */
export function judgePatches(blocksIn, next, commentIds, patches, opts = {}) {
  let blocks = blocksIn.map((b) => ({ ...b }));
  let nx = next;
  const results = new Map();
  const changed = new Set();
  const ids = new Set(commentIds);
  const origHash = new Map(blocksIn.map((b) => [b.id, blockHash(b)]));
  const scoped = isObj(opts.commentBlocks);
  const commented = new Set(scoped ? commentIds.map((c) => opts.commentBlocks[c]).filter(Boolean) : []);
  const beside = new Set(); // a commented block and its direct neighbours: where insert_after is allowed
  if (scoped) blocksIn.forEach((b, i) => { if (commented.has(b.id)) { beside.add(b.id); if (i > 0) beside.add(blocksIn[i - 1].id); if (i + 1 < blocksIn.length) beside.add(blocksIn[i + 1].id); } });
  const conflict = (cid, reason) => { if (!results.has(cid)) results.set(cid, { commentId: cid, status: 'conflict', reason }); };
  for (const p of Array.isArray(patches) ? patches : []) {
    if (!isObj(p) || !ids.has(p.commentId)) continue;
    const cid = p.commentId;
    if (results.has(cid)) continue; // one outcome per comment: the first patch wins
    if (p.op === 'reply') { conflict(cid, cut(str(p.text) || 'the model could not make this change', 500)); continue; }
    if (!PATCH_OPS.includes(p.op)) { conflict(cid, `unknown patch op ${cut(str(p.op), 30)}`); continue; }
    const idx = blocks.findIndex((b) => b.id === p.blockId);
    if (idx === -1) { conflict(cid, 'the block no longer exists'); continue; }
    const b = blocks[idx];
    if (scoped) {
      const own = opts.commentBlocks[cid] ?? null;
      const ok = own === null || (p.op === 'insert_after' ? beside.has(b.id) : own === b.id);
      if (!ok) { conflict(cid, 'the patch targets a block this comment is not on'); continue; }
    }
    if (isObj(opts.hashes) && opts.hashes[b.id] !== undefined && origHash.get(b.id) !== opts.hashes[b.id]) {
      conflict(cid, 'the block was edited while the job ran'); continue;
    }
    try {
      if (p.op === 'replace' || p.op === 'replace_text') {
        if (b.type === 'table' || b.type === 'hr' || b.type === 'img') { conflict(cid, `cannot replace text in a ${b.type} block`); continue; }
        let first, end, with_;
        if (p.op === 'replace') {
          if (typeof p.find !== 'string' || !p.find || typeof p.with !== 'string') { conflict(cid, 'the patch has no find/with text'); continue; }
          first = b.text.indexOf(p.find);
          if (first === -1) { conflict(cid, 'the original text was not found (it may have been edited)'); continue; }
          if (b.text.indexOf(p.find, first + 1) !== -1) { conflict(cid, 'the original text appears more than once in the block'); continue; }
          end = first + p.find.length; with_ = p.with;
        } else {
          if (typeof p.text !== 'string') { conflict(cid, 'the patch has no replacement text'); continue; }
          if (changed.has(b.id)) { conflict(cid, 'another comment already changed this block'); continue; }
          // Only the part that differs is replaced, so marks (bold, links) on the untouched text survive.
          let pre = 0;
          while (pre < b.text.length && pre < p.text.length && b.text[pre] === p.text[pre]) pre++;
          let suf = 0;
          while (suf < b.text.length - pre && suf < p.text.length - pre && b.text[b.text.length - 1 - suf] === p.text[p.text.length - 1 - suf]) suf++;
          first = pre; end = b.text.length - suf; with_ = p.text.slice(pre, p.text.length - suf);
          if (first === end && !with_) { conflict(cid, 'the replacement text is the same as the original'); continue; }
        }
        const nb = spliceBlock(b, first, end, with_);
        if (!nb) { conflict(cid, 'the result would be too long'); continue; }
        if (nb.type === 'diagram') { const prob = diagramProblem(nb.text); if (prob) { conflict(cid, `the diagram would not parse (${prob})`); continue; } }
        blocks[idx] = nb;
        changed.add(b.id);
      } else if (p.op === 'retype') {
        if (!RETYPE_TO.includes(p.type)) { conflict(cid, `cannot retype to ${cut(str(p.type), 20)}`); continue; }
        if (!RETYPE_TO.includes(b.type)) { conflict(cid, `cannot retype a ${b.type} block`); continue; }
        if (changed.has(b.id)) { conflict(cid, 'another comment already changed this block'); continue; }
        if (p.type === b.type) { conflict(cid, 'the block already has that type'); continue; }
        const { id, ...rest } = b;
        blocks[idx] = { id, ...cleanBlock({ ...rest, type: p.type }) };
        changed.add(b.id);
      } else if (p.op === 'delete') {
        blocks = blocks.filter((x) => x.id !== b.id);
        changed.add(b.id);
      } else if (p.op === 'insert_after') {
        const c = cleanBlocks((Array.isArray(p.blocks) ? p.blocks : p.text !== undefined ? [{ type: p.type || 'p', text: p.text }] : []).map((x) => ({ ...x, id: undefined })), nx);
        if (!c.blocks.length) { conflict(cid, 'the patch inserts no blocks'); continue; }
        const broken = c.blocks.map((x) => (x.type === 'diagram' ? diagramProblem(x.text) : '')).find(Boolean);
        if (broken) { conflict(cid, `the inserted diagram would not parse (${broken})`); continue; }
        if (blocks.length + c.blocks.length > MAX_BLOCKS) { conflict(cid, 'the document has too many blocks'); continue; }
        const at = blocks.findIndex((x) => x.id === b.id);
        blocks.splice(at + 1, 0, ...c.blocks);
        nx = c.next;
        for (const x of c.blocks) changed.add(x.id);
      }
      results.set(cid, { commentId: cid, status: 'applied' });
    } catch (e) {
      if (e instanceof HttpError) conflict(cid, e.message); else throw e;
    }
  }
  for (const cid of commentIds) conflict(cid, 'the model returned no change for this comment');
  return { blocks, next: nx, results: commentIds.map((c) => results.get(c)), changed: [...changed] };
}

// ------------------------------------------------------------------- reducer
function writeVersion(p, doc, blocks, cause, jobId, at, { coalesce = false } = {}) {
  const json = JSON.stringify(blocks);
  const latest = getDocVersion(p.db, doc.id, doc.version);
  let n = doc.version;
  if (coalesce && latest && latest.cause === 'edit' && at - latest.at < EDIT_COALESCE_MS) {
    p.db.run('UPDATE doc_versions SET blocks = ? WHERE doc_id = ? AND n = ?', json, doc.id, n);
  } else {
    n = doc.version + 1;
    p.db.run('INSERT INTO doc_versions(doc_id, n, blocks, cause, job_id, at) VALUES (?, ?, ?, ?, ?, ?)', doc.id, n, json, cause, jobId ?? null, at);
    // Keep the history bounded: drop the oldest `edit` snapshots first and never the sealed ones (apply / manual / revert / draft / create).
    const count = p.db.get('SELECT COUNT(*) AS c FROM doc_versions WHERE doc_id = ?', doc.id).c;
    if (count > MAX_VERSIONS) {
      p.db.run(
        `DELETE FROM doc_versions WHERE doc_id = ? AND n IN (SELECT n FROM doc_versions WHERE doc_id = ? AND cause = 'edit' AND n < ? ORDER BY n LIMIT ?)`,
        doc.id, doc.id, n, count - MAX_VERSIONS);
    }
  }
  return n;
}
function indexDoc(p, id) {
  const d = getDoc(p.db, id);
  if (!d) return;
  if (d.archived) { p.delDoc('doc', id); return; }
  p.setDoc('doc', id, d.title, docText(parse(d.blocks, [])), { at: d.updated_at });
}
const pushDoc = (p, id) => { const r = getDoc(p.db, id); if (r) p.emit('doc', 'upsert', toDoc(r, { blocks: false })); };
const pushComment = (p, id) => { const r = getComment(p.db, id); if (r) p.emit('doc_comment', 'upsert', toDocComment(r)); };

/** After a text change: re-locate the anchors of live comments on the changed blocks; lost ones become orphaned, found ones recover. */
function reanchor(p, docId, blocks, only) {
  const rows = p.db.all(`SELECT * FROM doc_comments WHERE doc_id = ? AND block_id IS NOT NULL AND state IN ('open','orphaned')`, docId);
  for (const c of rows) {
    if (only && !only.has(c.block_id)) continue;
    const b = blocks.find((x) => x.id === c.block_id);
    const anchor = parse(c.anchor, null);
    const loc = b && anchor ? relocate(anchor, blockText(b)) : null;
    if (loc) {
      if (c.state === 'orphaned' || loc.start !== anchor.start) {
        p.db.run(`UPDATE doc_comments SET anchor = ?, state = 'open' WHERE id = ?`, JSON.stringify(loc), c.id);
        pushComment(p, c.id);
      }
    } else if (c.state === 'open') {
      p.db.run(`UPDATE doc_comments SET state = 'orphaned' WHERE id = ?`, c.id);
      pushComment(p, c.id);
    }
  }
}

function applyOps(blocks, ops) {
  let out = blocks.map((b) => ({ ...b }));
  const touched = new Set();
  for (const o of ops) {
    if (o.op === 'delete') { out = out.filter((b) => b.id !== o.blockId); touched.add(o.blockId); }
    else if (o.op === 'insert') {
      const at = o.after == null ? -1 : out.findIndex((b) => b.id === o.after);
      out.splice(at + 1, 0, o.block);
      touched.add(o.block.id);
    } else {
      const i = out.findIndex((b) => b.id === o.blockId);
      if (i === -1) continue;
      out[i] = { id: out[i].id, ...o.patch }; // the patch is the whole validated block, so no stale fields survive a type change
      touched.add(o.blockId);
    }
  }
  return { blocks: out, touched };
}

/** Seal the newest snapshot so later typing starts a new one (used by manual save, export and apply). */
function seal(p, doc, at) {
  const latest = getDocVersion(p.db, doc.id, doc.version);
  if (latest && latest.cause === 'edit') p.db.run(`UPDATE doc_versions SET cause = 'manual' WHERE doc_id = ? AND n = ?`, doc.id, latest.n);
}

export function applyDoc(p, ev) {
  const d = ev.data, at = ev.at;
  const need = (id) => { const r = getDoc(p.db, id); if (!r) throw new Error('doc not found'); return r; };
  switch (ev.type) {
    case 'hub.doc.create': {
      const id = p.nextId('D');
      const blocks = d.blocks || [];
      p.db.run(
        `INSERT INTO docs(id, project_id, title, kind, blocks, version, next_block, session_id, created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0)`,
        id, d.projectId, cut(str(d.title), 300), DOC_KINDS.includes(d.kind) ? d.kind : 'document', JSON.stringify(blocks),
        d.nextBlock || maxBlockNumber(blocks) + 1, d.sessionId ?? null, at, at);
      p.db.run(`INSERT INTO doc_versions(doc_id, n, blocks, cause, job_id, at) VALUES (?, 0, ?, 'create', NULL, ?)`, id, JSON.stringify(blocks), at);
      indexDoc(p, id); pushDoc(p, id);
      return toDoc(getDoc(p.db, id));
    }
    case 'hub.doc.rename': {
      const doc = need(d.id);
      p.upd('docs', doc.id, { title: cut(str(d.title), 300), updated_at: at });
      indexDoc(p, doc.id); pushDoc(p, doc.id);
      return toDoc(getDoc(p.db, doc.id));
    }
    case 'hub.doc.archive': {
      const doc = need(d.id);
      p.upd('docs', doc.id, { archived: d.archived === false ? 0 : 1, updated_at: at });
      indexDoc(p, doc.id); pushDoc(p, doc.id);
      return toDoc(getDoc(p.db, doc.id));
    }
    case 'hub.doc.edit': {
      const doc = need(d.id);
      const { blocks, touched } = applyOps(parse(doc.blocks, []), d.ops || []);
      const n = writeVersion(p, doc, blocks, 'edit', null, at, { coalesce: true });
      p.upd('docs', doc.id, { blocks: JSON.stringify(blocks), version: n, next_block: Math.max(doc.next_block, d.nextBlock || 0), updated_at: at });
      reanchor(p, doc.id, blocks, touched);
      indexDoc(p, doc.id); pushDoc(p, doc.id);
      return toDoc(getDoc(p.db, doc.id));
    }
    case 'hub.doc.save': { // manual "save version" and export: freeze what is there
      const doc = need(d.id);
      seal(p, doc, at);
      pushDoc(p, doc.id);
      return toDoc(getDoc(p.db, doc.id));
    }
    case 'hub.doc.export': {
      const doc = need(d.docId);
      seal(p, doc, at);
      pushDoc(p, doc.id);
      return { docId: doc.id, version: d.version, format: d.format, at };
    }
    case 'hub.doc.drafted': { // the model's first draft (markdown -> blocks, judged by the hub)
      const doc = need(d.docId);
      const n = writeVersion(p, doc, d.blocks, 'draft', d.jobId, at);
      p.upd('docs', doc.id, { blocks: JSON.stringify(d.blocks), version: n, next_block: Math.max(doc.next_block, d.nextBlock || 0), updated_at: at });
      reanchor(p, doc.id, d.blocks, null);
      indexDoc(p, doc.id); pushDoc(p, doc.id);
      return toDoc(getDoc(p.db, doc.id));
    }
    case 'hub.doc.comment.add': {
      const doc = need(d.docId);
      const id = p.nextId('C');
      p.db.run(
        `INSERT INTO doc_comments(id, doc_id, block_id, anchor, text, state, created_at, applied_version, job_id, reason)
         VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL)`,
        id, doc.id, d.anchor?.blockId ?? null, d.anchor ? JSON.stringify(d.anchor) : null, cut(str(d.text), MAX_COMMENT), at);
      pushComment(p, id);
      return toDocComment(getComment(p.db, id));
    }
    case 'hub.doc.comment.update': {
      const c = getComment(p.db, d.id);
      if (!c) throw new Error('comment not found');
      const f = {}, x = d.patch || {};
      if (x.text !== undefined) f.text = cut(str(x.text), MAX_COMMENT);
      if (x.state !== undefined) { f.state = x.state; if (x.state === 'open') { f.job_id = null; f.reason = null; } }
      if (x.anchor !== undefined) { f.anchor = x.anchor ? JSON.stringify(x.anchor) : null; f.block_id = x.anchor?.blockId ?? null; if (x.state === undefined && c.state === 'orphaned') f.state = 'open'; }
      p.upd('doc_comments', c.id, f);
      pushComment(p, c.id);
      return toDocComment(getComment(p.db, c.id));
    }
    case 'hub.doc.comment.delete': {
      const c = getComment(p.db, d.id);
      if (!c) return null;
      p.db.run('DELETE FROM doc_comments WHERE id = ?', c.id);
      p.emit('doc_comment', 'delete', { id: c.id, docId: c.doc_id });
      return { id: c.id };
    }
    case 'hub.doc.apply': { // the user asked for these comments to be applied: they wait for the doc_edit job
      for (const id of d.commentIds) {
        const c = getComment(p.db, id);
        if (!c || c.doc_id !== d.docId || (c.state !== 'open' && c.state !== 'conflict')) continue;
        p.upd('doc_comments', id, { state: 'queued', job_id: d.jobId ?? null, reason: null });
        pushComment(p, id);
      }
      return p.db.all('SELECT * FROM doc_comments WHERE doc_id = ? AND job_id = ? ORDER BY rowid', d.docId, d.jobId ?? null).map(toDocComment);
    }
    case 'hub.doc.applied': {
      const doc = need(d.docId);
      let version = doc.version;
      if (d.blocks) {
        seal(p, doc, at);
        const fresh = getDoc(p.db, doc.id);
        version = writeVersion(p, fresh, d.blocks, 'apply', d.jobId, at);
        p.upd('docs', doc.id, { blocks: JSON.stringify(d.blocks), version, next_block: Math.max(doc.next_block, d.nextBlock || 0), updated_at: at });
        reanchor(p, doc.id, d.blocks, new Set(d.changed || []));
      }
      for (const r of d.results || []) {
        const c = getComment(p.db, r.commentId);
        if (!c || c.doc_id !== doc.id || c.state !== 'queued') continue; // dismissed or deleted while the job ran
        p.upd('doc_comments', c.id, {
          state: r.status === 'applied' ? 'applied' : 'conflict', applied_version: r.status === 'applied' ? version : null,
          reason: r.status === 'applied' ? null : cut(str(r.reason), 500), job_id: d.jobId ?? c.job_id,
        });
        pushComment(p, c.id);
      }
      indexDoc(p, doc.id); pushDoc(p, doc.id);
      return toDoc(getDoc(p.db, doc.id));
    }
    case 'hub.doc.revert': {
      const doc = need(d.docId);
      const old = getDocVersion(p.db, doc.id, d.toVersion);
      if (!old) throw new Error('version not found');
      seal(p, doc, at);
      const blocks = parse(old.blocks, []);
      // Going back past an Apply all undoes it: those comments are open again, so they can be applied (or dismissed) anew.
      for (const c of p.db.all(`SELECT id FROM doc_comments WHERE doc_id = ? AND state = 'applied' AND applied_version > ?`, doc.id, d.toVersion)) {
        p.db.run(`UPDATE doc_comments SET state = 'open', applied_version = NULL, job_id = NULL, reason = NULL WHERE id = ?`, c.id);
        pushComment(p, c.id);
      }
      const n = writeVersion(p, getDoc(p.db, doc.id), blocks, 'revert', null, at);
      p.upd('docs', doc.id, { blocks: JSON.stringify(blocks), version: n, next_block: Math.max(doc.next_block, maxBlockNumber(blocks) + 1), updated_at: at });
      reanchor(p, doc.id, blocks, null);
      indexDoc(p, doc.id); pushDoc(p, doc.id);
      return toDoc(getDoc(p.db, doc.id));
    }
    default:
      p.log?.warn(`unknown doc event ignored: ${ev.type}`);
      return null;
  }
}
