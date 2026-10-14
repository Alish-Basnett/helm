// Studio documents (CONTRACT v0.15): commands (create, edit, comment, apply, revert, save), the hub-side judge for the
// `doc_draft` / `doc_edit` model jobs, and export (html / md / pdf / docx). Same shape as WfEngine: the hub never calls a
// model; a mod answers a job with job.result and `tick` judges the raw reply and records the real `hub.doc.*` events.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HttpError } from './errors.mjs';
import { extractJson } from './wfgraph.mjs';
import { gatherBrief } from './docbrief.mjs';
import { embedDiagrams, diagramToken } from './zipedit.mjs';
import { renderDiagramSvg, diagramLabel } from '../web/studio/diagram.js';
import {
  toDoc, toDocVersion, toDocComment, getDoc, getDocVersion, getComment, cleanBlock, cleanBlocks, blocksToHtml, blocksToMarkdown,
  parseMarkdown, makeAnchor, diagramOmitted, judgePatches, blockText, maxBlockNumber, blockChars, blockHash,
  DOC_KINDS, COMMENT_STATES, EXPORT_FORMATS, MAX_BLOCKS, MAX_DOC_CHARS, MAX_COMMENT,
} from './docs.mjs';

const bad = (m) => new HttpError(400, m);
const notFound = (m) => new HttpError(404, m);
const isStr = (v) => typeof v === 'string';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const cut = (s, n) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const PROMPT_MAX = 8000;
const EDIT_INPUT_CAP = 30000; // characters of block text sent to the model in one doc_edit job
const PDF_TIMEOUT_MS = 60_000;
const PNG_TIMEOUT_MS = 30_000;
const MAX_DIAGRAM_PNGS = 10; // one Chrome run each; a document with more keeps the rest as source text in its docx
const PNG_SCALE = 2;
/**
 * Run headless Chrome until `out` is written, then stop it. On some machines Chrome writes the PDF and then lingers for
 * minutes (updater / crash handler), so the finished file, not the exit code, is the signal: it counts once its size has
 * stopped changing for ~300 ms.
 */
const chromePdf = (chrome, args, out, timeout) => new Promise((resolve, reject) => {
  const child = spawn(chrome, args, { stdio: 'ignore', detached: false });
  let done = false, last = -1, stable = 0;
  const finish = (err) => {
    if (done) return;
    done = true; clearInterval(poll); clearTimeout(timer);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    err ? reject(err) : resolve();
  };
  const poll = setInterval(() => {
    let size = -1;
    try { size = fs.statSync(out).size; } catch { /* not yet */ }
    if (size > 0 && size === last) { if (++stable >= 2) finish(); } else stable = 0;
    last = size;
  }, 150);
  const timer = setTimeout(() => finish(new Error('Chrome did not produce a PDF in time')), timeout);
  child.on('error', (e) => finish(e));
  child.on('exit', (code) => { if (!done) { if (fs.existsSync(out)) finish(); else finish(new Error(`Chrome exited with code ${code} before writing the PDF`)); } });
});

const MIME = {
  html: ['text/html; charset=utf-8', 'html'], md: ['text/markdown; charset=utf-8', 'md'], pdf: ['application/pdf', 'pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
};
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const TEXTUTIL = '/usr/bin/textutil';
const FALLBACK = { hint: 'Use the browser instead: open the HTML export or the Studio preview and press window.print() (Save as PDF).' };
const safeName = (t) => String(t).replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'document';
const run = (file, args, timeout) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout, windowsHide: true }, (err, _out, stderr) => (err ? reject(new Error(`${path.basename(file)}: ${String(stderr || err.message).slice(0, 300)}`)) : resolve()));
});

/**
 * The doc_draft reply -> unnumbered blocks. The mod asks for JSON ({"blocks":[...]} in a fence or bare); a reply that opens with
 * `{` is JSON and must parse (a truncated or broken one fails the job instead of being stored as text). Anything else is read as
 * markdown, the older reply format. Ids from the model are ignored: the hub numbers the blocks.
 */
export function draftBlocks(reply) {
  const text = String(reply ?? '').trim();
  const fence = /^```([A-Za-z]*)[ \t]*\n([\s\S]*?)\n?```$/.exec(text);
  const body = fence ? fence[2].trim() : text;
  if (body.startsWith('{') || (fence && /^json$/i.test(fence[1]))) {
    let v;
    try { v = JSON.parse(body); } catch { throw new Error('the reply was not valid JSON'); }
    const list = Array.isArray(v) ? v : isObj(v) ? v.blocks : null;
    if (!Array.isArray(list)) throw new Error('the reply has no "blocks" list');
    return list.map((b) => (isObj(b) ? { ...b, id: undefined } : b));
  }
  return parseMarkdown(body);
}

export class DocsEngine {
  constructor(hub) { this.hub = hub; this.exporting = new Map(); this.ticking = false; }
  get db() { return this.hub.db; }
  get p() { return this.hub.p; }
  cmd(type, data, at) { return this.hub.command(type, data, at); }
  now() { return this.hub.now(); }

  // ---------------------------------------------------------------- queries
  list({ projectId, includeArchived = false } = {}) {
    if (projectId && !this.p.getProject(projectId)) throw notFound('project not found');
    const where = [], args = [];
    if (projectId) { where.push('project_id = ?'); args.push(projectId); }
    if (!includeArchived) where.push('archived = 0');
    return this.db.all(`SELECT * FROM docs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC, rowid DESC`, ...args)
      .map((r) => toDoc(r, { blocks: false }));
  }
  need(id) {
    const r = isStr(id) ? getDoc(this.db, id) : null;
    if (!r) throw notFound('document not found');
    return r;
  }
  detail(id) {
    const r = this.need(id);
    return {
      doc: toDoc(r),
      versions: this.db.all('SELECT * FROM doc_versions WHERE doc_id = ? ORDER BY n DESC', id).map((v) => toDocVersion(v)),
      comments: this.db.all('SELECT * FROM doc_comments WHERE doc_id = ? ORDER BY rowid', id).map(toDocComment),
    };
  }
  version(id, n) {
    this.need(id);
    const v = getDocVersion(this.db, id, Number(n));
    if (!v) throw notFound('version not found');
    return { version: toDocVersion(v, { blocks: true }) };
  }

  // --------------------------------------------------------------- commands
  /** POST /v1/docs. `blocks` or `markdown` seed the content; `prompt` also queues a doc_draft job when a session is live. */
  create(body, at = this.now()) {
    if (!isObj(body)) throw bad('body must be an object');
    const project = isStr(body.projectId) ? this.p.getProject(body.projectId) : null;
    if (!project) throw notFound('project not found');
    if (!isStr(body.title) || !body.title.trim()) throw bad('title must be a non-empty string');
    const kind = body.kind === undefined ? 'document' : body.kind;
    if (!DOC_KINDS.includes(kind)) throw bad(`kind must be one of ${DOC_KINDS.join(', ')}`);
    let prompt = '';
    if (body.prompt !== undefined && body.prompt !== null) {
      if (!isStr(body.prompt)) throw bad('prompt must be a string');
      if (body.prompt.length > PROMPT_MAX) throw bad(`prompt is longer than ${PROMPT_MAX} characters`);
      prompt = body.prompt.trim();
    }
    if (body.blocks !== undefined && body.markdown !== undefined) throw bad('send blocks or markdown, not both');
    let seed = [];
    if (body.markdown !== undefined) { if (!isStr(body.markdown)) throw bad('markdown must be a string'); seed = parseMarkdown(body.markdown); }
    else if (body.blocks !== undefined) seed = body.blocks;
    const { blocks, next } = cleanBlocks(seed, 1);
    let sessionId = null, draftError = null, brief = '';
    if (prompt) {
      try { sessionId = this.hub.pickJobSession(null, project.id); } catch (e) { if (e instanceof HttpError && e.status === 409) draftError = e.message; else throw e; }
      // what Helm knows about the project (README, plan, concepts, recaps), so the draft is about the project and not about Studio
      if (sessionId) { try { brief = gatherBrief(this.db, project, sessionId).text; } catch (e) { this.hub.log?.warn('project brief failed', e); } }
    }
    return this.hub.tx(() => {
      const doc = this.cmd('hub.doc.create', {
        projectId: project.id, title: body.title.trim().slice(0, 300), kind, blocks, nextBlock: next, sessionId,
      }, at);
      let job = null;
      if (prompt && sessionId) {
        job = this.cmd('hub.job.create', {
          kind: 'doc_draft', sessionId, taskId: null, projectId: project.id,
          input: { docId: doc.id, baseVersion: doc.version, title: doc.title, kind, prompt, projectName: project.name, brief, existing: blocks.length ? blocksToMarkdown(blocks) : '' },
        }, at);
      }
      return { doc, job, ...(draftError ? { draftError } : {}) };
    });
  }
  update(id, body, at = this.now()) {
    const doc = this.need(id);
    if (!isObj(body)) throw bad('body must be an object');
    return this.hub.tx(() => {
      let out = toDoc(doc);
      if (body.title !== undefined) {
        if (!isStr(body.title) || !body.title.trim()) throw bad('title must be a non-empty string');
        out = this.cmd('hub.doc.rename', { id, title: body.title.trim().slice(0, 300) }, at);
      }
      if (body.archived !== undefined) {
        if (typeof body.archived !== 'boolean') throw bad('archived must be a boolean');
        out = this.cmd('hub.doc.archive', { id, archived: body.archived }, at);
      }
      return { doc: out };
    });
  }
  /**
   * POST /v1/docs/:id/edit { baseVersion?, ops:[{blockId, text?, marks?, type?, level?, ordered?, rows?} | {op:'insert', after, block} | {op:'delete', blockId}] }.
   * A stale baseVersion (someone applied or reverted meanwhile) is a 409 carrying the current version.
   */
  edit(id, body, at = this.now()) {
    const doc = this.need(id);
    if (!isObj(body)) throw bad('body must be an object');
    if (doc.archived) throw new HttpError(409, 'this document is archived');
    if (body.baseVersion !== undefined && body.baseVersion !== doc.version) {
      throw new HttpError(409, 'the document changed since you loaded it', { version: doc.version });
    }
    if (!Array.isArray(body.ops) || !body.ops.length) throw bad('ops must be a non-empty array');
    if (body.ops.length > 500) throw bad('at most 500 ops per edit');
    let blocks = parse(doc.blocks, []).map((b) => ({ ...b }));
    let next = doc.next_block;
    const ops = [];
    for (const o of body.ops) {
      if (!isObj(o)) throw bad('an op must be an object');
      if (o.op === 'delete') {
        if (!blocks.some((b) => b.id === o.blockId)) throw notFound(`block ${o.blockId} not found`);
        blocks = blocks.filter((b) => b.id !== o.blockId);
        ops.push({ op: 'delete', blockId: o.blockId });
      } else if (o.op === 'insert') {
        if (o.after != null && !blocks.some((b) => b.id === o.after)) throw notFound(`block ${o.after} not found`);
        // The browser numbers the blocks it creates (b<n>) so its comments keep pointing at them; the id is kept when it is free.
        const want = isObj(o.block) && typeof o.block.id === 'string' && /^b\d{1,9}$/.test(o.block.id) && !blocks.some((x) => x.id === o.block.id) ? o.block.id : undefined;
        const c = cleanBlocks([{ ...o.block, id: want }], next);
        next = c.next;
        const at2 = o.after == null ? -1 : blocks.findIndex((b) => b.id === o.after);
        blocks.splice(at2 + 1, 0, c.blocks[0]);
        ops.push({ op: 'insert', after: o.after ?? null, block: c.blocks[0] });
      } else if (o.op === undefined || o.op === 'set') {
        const i = blocks.findIndex((b) => b.id === o.blockId);
        if (i === -1) throw notFound(`block ${o.blockId} not found`);
        const { blockId, op, ...patch } = o;
        const merged = cleanBlock({ ...blocks[i], ...patch, id: blocks[i].id, marks: patch.marks !== undefined ? patch.marks : (patch.text !== undefined ? [] : blocks[i].marks) });
        const { id: _drop, ...fields } = merged;
        blocks[i] = merged;
        ops.push({ op: 'set', blockId: o.blockId, patch: fields });
      } else throw bad('op must be set, insert or delete');
    }
    if (blocks.length > MAX_BLOCKS) throw bad(`at most ${MAX_BLOCKS} blocks`);
    if (blockChars(blocks) > MAX_DOC_CHARS) throw bad(`the document is longer than ${MAX_DOC_CHARS} characters`);
    return this.hub.tx(() => ({ doc: this.cmd('hub.doc.edit', { id, ops, nextBlock: next }, at) }));
  }
  /** Freeze the current text as a version people can come back to ("Save version"). */
  save(id, at = this.now()) {
    this.need(id);
    return this.hub.tx(() => ({ doc: this.cmd('hub.doc.save', { id }, at) }));
  }
  revert(id, body, at = this.now()) {
    const doc = this.need(id);
    if (!isObj(body) || !Number.isInteger(body.toVersion)) throw bad('toVersion must be an integer');
    if (!getDocVersion(this.db, id, body.toVersion)) throw notFound('version not found');
    if (doc.archived) throw new HttpError(409, 'this document is archived');
    return this.hub.tx(() => ({ doc: this.cmd('hub.doc.revert', { docId: id, toVersion: body.toVersion }, at) }));
  }

  // --------------------------------------------------------------- comments
  /** Body: { blockId, start, end, text } for a selection, or { text } for a whole-document comment. */
  addComment(id, body, at = this.now()) {
    const doc = this.need(id);
    if (!isObj(body)) throw bad('body must be an object');
    const text = this.cleanComment(body.text);
    let anchor = null;
    if (body.blockId !== undefined && body.blockId !== null) {
      const b = parse(doc.blocks, []).find((x) => x.id === body.blockId);
      if (!b) throw notFound('block not found');
      anchor = makeAnchor(b, body.start, body.end);
    }
    return this.hub.tx(() => ({ comment: this.cmd('hub.doc.comment.add', { docId: id, anchor, text }, at) }));
  }
  cleanComment(t) {
    if (!isStr(t) || !t.trim()) throw bad('text must be a non-empty string');
    if (t.length > MAX_COMMENT) throw bad(`text is longer than ${MAX_COMMENT} characters`);
    return t.trim();
  }
  needComment(id, cid) {
    this.need(id);
    const c = isStr(cid) ? getComment(this.db, cid) : null;
    if (!c || c.doc_id !== id) throw notFound('comment not found');
    return c;
  }
  /** PATCH: { text }, or { state: 'open'|'dismissed' } (a queued comment is owned by its job; 'dismissed' withdraws it). */
  updateComment(id, cid, body, at = this.now()) {
    const c = this.needComment(id, cid);
    if (!isObj(body)) throw bad('body must be an object');
    const patch = {};
    if (body.text !== undefined) patch.text = this.cleanComment(body.text);
    if (body.state !== undefined) {
      if (!['open', 'dismissed'].includes(body.state)) throw bad('state can only be set to open or dismissed');
      if (c.state === 'queued' && body.state === 'open') throw new HttpError(409, 'this comment is waiting for a job');
      patch.state = body.state;
    }
    if (body.anchor !== undefined) {
      const doc = this.need(id);
      const b = parse(doc.blocks, []).find((x) => x.id === body.anchor?.blockId);
      if (!b) throw notFound('block not found');
      patch.anchor = makeAnchor(b, body.anchor.start, body.anchor.end);
    }
    if (!Object.keys(patch).length) throw bad('nothing to change');
    return this.hub.tx(() => ({ comment: this.cmd('hub.doc.comment.update', { id: cid, patch }, at) }));
  }
  deleteComment(id, cid, at = this.now()) {
    this.needComment(id, cid);
    this.hub.tx(() => this.cmd('hub.doc.comment.delete', { id: cid }, at));
    return { ok: true };
  }

  // ------------------------------------------------------------------ apply
  /** POST /v1/docs/:id/apply { commentIds? } -> one doc_edit job for the open comments (all of them when ids are omitted). */
  apply(id, body, at = this.now()) {
    const doc = this.need(id);
    if (body !== undefined && !isObj(body)) throw bad('body must be an object');
    if (doc.archived) throw new HttpError(409, 'this document is archived');
    const all = this.db.all(`SELECT * FROM doc_comments WHERE doc_id = ? AND state IN ('open','conflict') ORDER BY rowid`, id);
    let chosen = all;
    if (body?.commentIds !== undefined) {
      if (!Array.isArray(body.commentIds) || body.commentIds.some((c) => !isStr(c))) throw bad('commentIds must be an array of comment ids');
      chosen = body.commentIds.map((cid) => {
        const c = getComment(this.db, cid);
        if (!c || c.doc_id !== id) throw notFound(`comment ${cid} not found`);
        if (c.state === 'queued') throw new HttpError(409, `comment ${cid} is already waiting for a job`);
        if (c.state !== 'open' && c.state !== 'conflict') throw bad(`comment ${cid} is ${c.state}, only open comments can be applied`);
        return c;
      });
    }
    if (!chosen.length) throw bad('there are no open comments to apply');
    const blocks = parse(doc.blocks, []);
    const send = new Set();
    let wholeDoc = false;
    for (const c of chosen) {
      const idx = c.block_id ? blocks.findIndex((b) => b.id === c.block_id) : -1;
      if (idx === -1) { wholeDoc = true; continue; }
      send.add(idx);
      if (idx > 0) send.add(idx - 1);                      // one neighbour each side, for context
      if (idx + 1 < blocks.length) send.add(idx + 1);
    }
    const pick = wholeDoc ? blocks.map((_, i) => i) : [...send].sort((a, b) => a - b);
    const chars = pick.reduce((n, i) => n + blockText(blocks[i]).length, 0);
    if (chars > EDIT_INPUT_CAP) {
      throw bad(wholeDoc ? 'the document is too long for a whole-document comment; anchor the comment to a section' : 'the commented sections are too long for one job; apply fewer comments at a time');
    }
    const sessionId = this.hub.pickJobSession(doc.session_id, doc.project_id); // 409 when there is no live session
    const input = {
      docId: id, baseVersion: doc.version, title: doc.title, kind: doc.kind,
      outline: blocks.filter((b) => /^h[123]$/.test(b.type)).map((b) => ({ id: b.id, type: b.type, text: b.text })),
      // `hash` is the base the hub checks each patch against: a block edited while the job ran is a conflict, not a silent overwrite
      blocks: pick.map((i) => ({ id: blocks[i].id, type: blocks[i].type, text: blocks[i].type === 'table' ? blockText(blocks[i]) : blocks[i].text, hash: blockHash(blocks[i]) })),
      comments: chosen.map((c) => ({ id: c.id, blockId: c.block_id ?? null, quote: parse(c.anchor, null)?.quote ?? null, text: c.text })),
      commentIds: chosen.map((c) => c.id),
    };
    return this.hub.tx(() => {
      const job = this.cmd('hub.job.create', { kind: 'doc_edit', sessionId, taskId: null, projectId: doc.project_id, input }, at);
      const comments = this.cmd('hub.doc.apply', { docId: id, commentIds: input.commentIds, jobId: job.id }, at);
      return { job, comments };
    });
  }

  // ------------------------------------------------------------ job judging
  pending() {
    return this.db.all(`SELECT * FROM jobs WHERE kind IN ('doc_draft','doc_edit') AND state = 'running' AND result IS NOT NULL ORDER BY rowid`);
  }
  /** Called after every committed command/ingest and each sweep (never during a rebuild): judge replies that have arrived. */
  tick(now = this.now()) {
    if (this.ticking || this.hub.closed || this.hub.replaying) return;
    // A doc_edit job the sweep timed out (or that failed) frees its comments, so they can be applied again.
    const stuck = this.db.all(`SELECT c.id FROM doc_comments c JOIN jobs j ON j.id = c.job_id WHERE c.state = 'queued' AND j.state = 'failed'`);
    if (stuck.length) {
      this.ticking = true;
      try { this.hub.tx(() => { for (const c of stuck) this.cmd('hub.doc.comment.update', { id: c.id, patch: { state: 'open' } }, now); }); } finally { this.ticking = false; }
    }
    const jobs = this.pending();
    if (!jobs.length) return;
    this.ticking = true;
    try {
      for (const j of jobs) {
        try { if (j.kind === 'doc_draft') this.finishDraft(j, now); else this.finishEdit(j, now); } catch (e) {
          this.hub.log?.error('doc job failed', e);
          this.hub.tx(() => {
            this.cmd('hub.job.finish', { jobId: j.id, state: 'failed', error: 'could not process the reply', result: null }, now);
            this.releaseComments(j, 'could not process the reply', now);
          });
        }
      }
    } finally { this.ticking = false; }
  }
  /** Comments queued on a job that failed go back to open (they can be applied again). */
  releaseComments(j, reason, at) {
    for (const c of this.db.all(`SELECT id FROM doc_comments WHERE job_id = ? AND state = 'queued'`, j.id)) {
      this.cmd('hub.doc.comment.update', { id: c.id, patch: { state: 'open' } }, at);
    }
  }
  fail(j, error, at) {
    return this.hub.tx(() => {
      this.cmd('hub.job.finish', { jobId: j.id, state: 'failed', error: cut(error, 500), result: null }, at);
      if (j.kind === 'doc_edit') this.releaseComments(j, error, at);
    });
  }
  finishDraft(j, at) {
    const input = parse(j.input, {});
    const doc = getDoc(this.db, input.docId);
    if (!doc) return this.fail(j, 'the document no longer exists', at);
    if (doc.version !== input.baseVersion) return this.fail(j, 'the document changed while the draft was being written, so the draft was discarded', at);
    let c;
    try { c = cleanBlocks(draftBlocks(j.result), doc.next_block); } catch (e) { return this.fail(j, `the draft was not usable: ${e.message}`, at); }
    if (!c.blocks.length) return this.fail(j, 'the draft was empty', at);
    return this.hub.tx(() => {
      this.cmd('hub.doc.drafted', { docId: doc.id, jobId: j.id, blocks: c.blocks, nextBlock: c.next }, at);
      return this.cmd('hub.job.finish', { jobId: j.id, state: 'done', result: JSON.stringify({ docId: doc.id, blocks: c.blocks.length }) }, at);
    });
  }
  finishEdit(j, at) {
    const input = parse(j.input, {});
    const doc = getDoc(this.db, input.docId);
    if (!doc) return this.fail(j, 'the document no longer exists', at);
    const ex = extractJson(j.result);
    const patches = ex.error ? null : (Array.isArray(ex.value) ? ex.value : ex.value.patches);
    if (!Array.isArray(patches)) return this.fail(j, ex.error || 'the reply had no "patches" list', at);
    // Only comments still waiting on this job are judged (a dismissed or deleted one is left alone).
    const ids = (input.commentIds || []).filter((cid) => getComment(this.db, cid)?.state === 'queued');
    const hashes = {}, commentBlocks = {};
    for (const b of input.blocks || []) if (b.hash) hashes[b.id] = b.hash;
    for (const c of input.comments || []) commentBlocks[c.id] = c.blockId ?? null;
    const r = judgePatches(parse(doc.blocks, []), doc.next_block, ids, patches, {
      hashes: Object.keys(hashes).length ? hashes : undefined, commentBlocks: input.comments ? commentBlocks : undefined,
    });
    const appliedAny = r.results.some((x) => x.status === 'applied');
    return this.hub.tx(() => {
      this.cmd('hub.doc.applied', {
        docId: doc.id, jobId: j.id, baseVersion: input.baseVersion, results: r.results,
        blocks: appliedAny ? r.blocks : null, nextBlock: r.next, changed: r.changed,
      }, at);
      return this.cmd('hub.job.finish', { jobId: j.id, state: 'done', result: JSON.stringify({ docId: doc.id, applied: r.results.filter((x) => x.status === 'applied').length, conflicts: r.results.filter((x) => x.status !== 'applied').length }) }, at);
    });
  }

  // ----------------------------------------------------------------- export
  chrome() {
    const env = process.env.HELM_CHROME;
    if (env) return fs.existsSync(env) ? env : null;
    return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || null;
  }
  /**
   * Write `<stem>.html` (the document with its diagrams as inline SVG) and convert it to `<stem>.pdf|docx`. Missing tools are a
   * 501 with a browser-print hint. PDF goes through Chrome, which draws the SVG. textutil cannot take SVG and its docx writer drops
   * every image, so for docx each diagram is drawn to a PNG by headless Chrome, a text placeholder stands in for it while textutil
   * writes the docx, and the PNGs are then put in by editing the docx zip (zipedit.mjs). Without Chrome, or if the zip step fails,
   * the docx gets a "diagram not drawn" note and the diagram's source text instead.
   */
  async renderBinary(format, stem, blocks, title) {
    const out = `${stem}.${format}`;
    const html = blocksToHtml(blocks, { title });
    fs.writeFileSync(`${stem}.html`, html);
    if (format === 'pdf') {
      const chrome = this.chrome();
      if (!chrome) throw new HttpError(501, 'PDF export needs Chrome (or set HELM_CHROME to a Chromium-based browser)', FALLBACK);
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-pdf-'));
      try {
        fs.rmSync(out, { force: true });
        await chromePdf(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update',
          '--disable-extensions', '--no-pdf-header-footer', `--user-data-dir=${profile}`, `--print-to-pdf=${out}`, `file://${stem}.html`], out, PDF_TIMEOUT_MS);
      } catch (e) { throw new HttpError(502, `PDF export failed: ${e.message}`, FALLBACK); }
      finally { fs.rmSync(profile, { recursive: true, force: true }); }
      if (!fs.existsSync(out)) throw new HttpError(502, 'PDF export failed: no file was written', FALLBACK);
    } else {
      if (!fs.existsSync(TEXTUTIL)) throw new HttpError(501, '.docx export needs macOS textutil, which is not on this machine', FALLBACK);
      const src = `${stem}.docx.html`;
      const convert = async (drawn, reasons) => {
        fs.writeFileSync(src, blocksToHtml(blocks, {
          title,
          diagramHtml: (b, idAttr) => (drawn.has(b.id) ? `<p${idAttr}>${diagramToken(drawn.get(b.id).n)}</p>` : diagramOmitted(b, idAttr, reasons.get(b.id) || 'it could not be drawn')),
        }));
        await run(TEXTUTIL, ['-convert', 'docx', '-output', out, src], 30_000);
      };
      try {
        const { drawn, reasons } = await this.rasterizeDiagrams(blocks, stem);
        await convert(drawn, reasons);
        if (drawn.size) {
          try { fs.writeFileSync(out, embedDiagrams(fs.readFileSync(out), [...drawn.values()])); }
          catch (e) { // the zip step failed: keep the text of every diagram instead of leaving placeholders in the file
            this.hub.log?.warn('docx diagram embedding failed', e);
            await convert(new Map(), new Map([...drawn.keys()].map((id) => [id, 'the picture could not be added to the Word file'])));
          }
        }
      } catch (e) { throw new HttpError(502, `docx export failed: ${e.message}`, FALLBACK); }
      finally { fs.rmSync(src, { force: true }); }
    }
  }
  /**
   * Draw every drawable diagram in `blocks` to a PNG with headless Chrome (one run each, at most MAX_DIAGRAM_PNGS).
   * Returns { drawn: Map(blockId -> { n, png, w, h, alt }), reasons: Map(blockId -> why it was not drawn) }; never throws.
   */
  async rasterizeDiagrams(blocks, stem) {
    const drawn = new Map(), reasons = new Map();
    const chrome = blocks.some((b) => b.type === 'diagram') ? this.chrome() : null;
    let n = 0;
    for (const b of blocks) {
      if (b.type !== 'diagram') continue;
      const r = renderDiagramSvg(b.text);
      if (!r.svg) { reasons.set(b.id, r.errors.length ? `line ${r.errors[0].line}: ${r.errors[0].message}` : 'it has no nodes'); continue; }
      if (!chrome) { reasons.set(b.id, 'drawing it needs Chrome (set HELM_CHROME)'); continue; }
      if (n >= MAX_DIAGRAM_PNGS) { reasons.set(b.id, `only the first ${MAX_DIAGRAM_PNGS} diagrams of a document are drawn in Word files`); continue; }
      n++;
      const page = `${stem}.d${n}.html`, png = `${stem}.d${n}.png`;
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-png-'));
      try {
        fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}svg{display:block}</style>${r.svg}`);
        fs.rmSync(png, { force: true });
        await chromePdf(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-extensions',
          '--hide-scrollbars', `--force-device-scale-factor=${PNG_SCALE}`, `--window-size=${Math.ceil(r.width)},${Math.ceil(r.height)}`,
          `--user-data-dir=${profile}`, `--screenshot=${png}`, pathToFileURL(page).href], png, PNG_TIMEOUT_MS);
        const data = fs.readFileSync(png);
        if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
        drawn.set(b.id, { n, png: data, w: data.readUInt32BE(16) / PNG_SCALE, h: data.readUInt32BE(20) / PNG_SCALE, alt: diagramLabel(r.parsed) });
      } catch (e) { reasons.set(b.id, `Chrome could not draw it (${String(e.message).slice(0, 80)})`); }
      finally { fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(page, { force: true }); fs.rmSync(png, { force: true }); }
    }
    return { drawn, reasons };
  }
  /**
   * Export a block tree that the hub does not store (a Studio document that still lives in the browser's localStorage).
   * Validates like any write, renders in a throwaway directory under $HELM_HOME/tmp and removes it once the response is sent.
   * Nothing is recorded: there is no hub document to attach a hub.doc.export event to.
   */
  async exportBlocks({ format = 'html', title = 'Document', blocks } = {}) {
    if (!EXPORT_FORMATS.includes(format)) throw bad(`format must be one of ${EXPORT_FORMATS.join(', ')}`);
    if (!Array.isArray(blocks)) throw bad('blocks must be an array');
    const clean = cleanBlocks(blocks).blocks;
    const name = cut(isStr(title) && title.trim() ? title.trim() : 'Document', 200);
    const root = path.join(this.hub.cfg.home, 'tmp');
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, 'export-'));
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
      const stem = path.join(dir, 'doc');
      const [mime, ext] = MIME[format];
      if (format === 'html') fs.writeFileSync(`${stem}.html`, blocksToHtml(clean, { title: name }));
      else if (format === 'md') fs.writeFileSync(`${stem}.md`, blocksToMarkdown(clean));
      else await this.renderBinary(format, stem, clean, name);
      const file = `${stem}.${ext}`;
      return { path: file, mime, name: `${safeName(name)}.${ext}`, size: fs.statSync(file).size, noStore: true, cleanup };
    } catch (e) { cleanup(); throw e; }
  }

  /**
   * Render a version to a file under $HELM_HOME/studio/<doc>/ and describe it for the file responder.
   * `record` writes a hub.doc.export event (a real download); a preview (GET) does not change anything.
   */
  async export(id, { format = 'pdf', version, record = false } = {}, at = this.now()) {
    const doc = this.need(id);
    if (!EXPORT_FORMATS.includes(format)) throw bad(`format must be one of ${EXPORT_FORMATS.join(', ')}`);
    let n = doc.version;
    if (version !== undefined && version !== null && version !== '') {
      n = Number(version);
      if (!Number.isInteger(n)) throw bad('v must be an integer');
    }
    const row = getDocVersion(this.db, id, n);
    if (!row) throw notFound('version not found');
    const blocks = parse(row.blocks, []);
    const dir = path.join(this.hub.cfg.home, 'studio', doc.id);
    fs.mkdirSync(dir, { recursive: true });
    const stem = path.join(dir, String(n));
    const html = blocksToHtml(blocks, { title: doc.title });
    // An old version never changes; the newest one is re-rendered when the file is older than the last edit.
    const upToDate = (f) => { try { const st = fs.statSync(f); return st.size > 0 && (n !== doc.version || st.mtimeMs >= doc.updated_at); } catch { return false; } };
    const key = `${id}:${n}:${format}`;
    const make = async () => {
      if (format === 'html') { fs.writeFileSync(`${stem}.html`, html); return; }
      if (format === 'md') { fs.writeFileSync(`${stem}.md`, blocksToMarkdown(blocks)); return; }
      const out = `${stem}.${format}`;
      if (upToDate(out)) return;
      await this.renderBinary(format, stem, blocks, doc.title);
    };
    // One render at a time per (doc, version, format): a double click shares the Chrome run.
    let p = this.exporting.get(key);
    if (!p) { p = make().finally(() => this.exporting.delete(key)); this.exporting.set(key, p); }
    await p;
    const [mime, ext] = MIME[format];
    const file = `${stem}.${ext}`;
    if (record) this.hub.tx(() => this.cmd('hub.doc.export', { docId: id, version: n, format }, at));
    return { path: file, mime, name: `${safeName(doc.title)}.${ext}`, size: fs.statSync(file).size, inline: format === 'pdf' && !record, noStore: true };
  }
}
