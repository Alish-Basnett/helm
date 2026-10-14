// studio/store.js — persistence for Studio documents behind one small async interface.
//
// Two backends with the same methods. The HUB backend (the /v1/docs routes, v0.15) is used when the hub is reachable and the
// document has a project; the LOCAL backend (localStorage, wrapped in try/catch, memory fallback) is the fallback and keeps
// working with no hub. Local ids look like L-1, hub ids like D-1, so each call goes to the right place by id alone.
//   createDoc({projectId,title,prompt}) -> POST /v1/docs                      (queues the doc_draft job; the result arrives as a job + doc event)
//   saveBlocks(id, blocks)              -> POST /v1/docs/:id/edit { ops }      (a block-level diff, see sync.js)
//   saveComments(id, comments)          -> POST|PATCH|DELETE /v1/docs/:id/comments[/:cid]
//   applyAll(id)                        -> POST /v1/docs/:id/apply             (ONE doc_edit job; the hub judges the patches)
//   undoApply(id, toVersion)            -> POST /v1/docs/:id/revert            (one version back = the whole batch undone)
// A local document is moved to the hub the first time it is saved while the hub is up (migrateLocal).
import { lsGet, lsSet } from '../store.js';
import { cleanBlocks, titleFrom } from './blocks.js';
import { toEditorBlocks, diffBlocks, toLocalComment, diffComments } from './sync.js';

const KEY = 'helm.studio.v1';
let memory = null; // used only if localStorage cannot be written

function readAll() {
  const raw = lsGet(KEY, null);
  if (raw == null) return memory || { seq: 0, docs: {}, comments: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && v.docs && v.comments) return v;
  } catch { /* corrupt: start clean */ }
  return { seq: 0, docs: {}, comments: {} };
}
function writeAll(data) {
  memory = data;
  lsSet(KEY, JSON.stringify(data));
}

const now = () => new Date().toISOString();
const err = (m) => Object.assign(new Error(m), { status: 400 });

export function localBackend() {
  return {
    name: 'local',
    async listDocs() {
      const d = readAll();
      return Object.values(d.docs).filter((x) => !x.archived).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map(({ blocks, ...meta }) => ({ ...meta, blockCount: blocks.length }));
    },
    async getDoc(id) {
      const d = readAll();
      const doc = d.docs[id];
      if (!doc) throw Object.assign(new Error('Document not found'), { status: 404 });
      return { doc: { ...doc, blocks: cleanBlocks(doc.blocks) }, comments: d.comments[id] || [] };
    },
    async createDoc({ projectId = null, title, prompt = '' }) {
      const d = readAll();
      const id = `L-${++d.seq}`;
      const t = (title || '').trim() || titleFrom(prompt);
      // Local documents are never drafted by the model (that needs the hub and a project): they start as the title plus the
      // description, ready to edit by hand.
      const blocks = [{ id: 'b1', type: 'h1', text: t }];
      if (prompt.trim()) blocks.push({ id: 'b2', type: 'quote', text: prompt.trim().slice(0, 4000) });
      blocks.push({ id: `b${blocks.length + 1}`, type: 'p', text: '' });
      const doc = { id, projectId, title: t, kind: 'free', prompt: prompt.trim(), state: 'ready', version: 1, createdAt: now(), updatedAt: now(), blocks, archived: false };
      d.docs[id] = doc;
      d.comments[id] = [];
      writeAll(d);
      return { doc };
    },
    async saveBlocks(id, blocks, title) {
      const d = readAll();
      const doc = d.docs[id];
      if (!doc) throw err('Document not found');
      doc.blocks = cleanBlocks(blocks);
      if (typeof title === 'string' && title.trim()) doc.title = title.trim().slice(0, 300);
      doc.version += 1;
      doc.updatedAt = now();
      writeAll(d);
      return { version: doc.version };
    },
    async renameDoc(id, title) {
      const d = readAll();
      if (!d.docs[id]) throw err('Document not found');
      d.docs[id].title = String(title).trim().slice(0, 300) || d.docs[id].title;
      d.docs[id].updatedAt = now();
      writeAll(d);
    },
    async deleteDoc(id) {
      const d = readAll();
      if (d.docs[id]) { d.docs[id].archived = true; writeAll(d); }
    },
    async saveComments(id, comments) {
      const d = readAll();
      if (!d.docs[id]) throw err('Document not found');
      d.comments[id] = comments;
      writeAll(d);
    },
    async applyAll() {
      return { ok: false, reason: 'Apply all needs the hub and a project: this document only exists in this browser. Saving it to a project moves it to the hub.' };
    },
    async markMigrated(id, to) {
      const d = readAll();
      if (d.docs[id]) { d.docs[id].archived = true; d.docs[id].migratedTo = to; writeAll(d); }
    },
  };
}

/** Comment ids are local; the hub issues its own (C-n) when the hub backend is used. */
export function newCommentId(comments) {
  let n = 0;
  for (const c of comments) { const m = /^c(\d+)$/.exec(c.id); if (m) n = Math.max(n, +m[1]); }
  return `c${n + 1}`;
}

/* ----------------------------------------------------------------- hub backend */
const netErr = () => Object.assign(new Error('Hub unreachable'), { network: true });
async function hubReq(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw netErr(); }
  let data = null;
  try { data = JSON.parse(await res.text()); } catch { /* empty or not JSON */ }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `${method} ${path} failed (${res.status})`), { status: res.status, data });
  return data;
}
const enc = encodeURIComponent;

export function hubBackend(req = hubReq) {
  const base = new Map();      // docId -> { version, blocks }: the editor-view of the hub's blocks, what diffs are made against
  const hubComments = new Map(); // docId -> hub comments as last seen
  const meta = (d) => ({ id: d.id, title: d.title, projectId: d.projectId, kind: d.kind, version: d.version, updatedAt: d.updatedAt, createdAt: d.createdAt, archived: !!d.archived });
  const remember = (doc, comments) => {
    base.set(doc.id, { version: doc.version, title: doc.title, blocks: toEditorBlocks(doc.blocks) });
    if (comments) hubComments.set(doc.id, comments.map(toLocalComment));
  };
  return {
    name: 'hub',
    async listDocs() {
      const r = await req('GET', '/v1/docs');
      return (r.docs || []).map((d) => ({ ...meta(d), blockCount: d.blockCount ?? 0 }));
    },
    async getDoc(id) {
      const r = await req('GET', `/v1/docs/${enc(id)}`);
      remember(r.doc, r.comments);
      const comments = r.comments.map(toLocalComment);
      return { doc: { ...meta(r.doc), blocks: toEditorBlocks(r.doc.blocks) }, comments, versions: r.versions || [] };
    },
    async createDoc({ projectId, title, prompt = '' }) {
      const t = (title || '').trim() || titleFrom(prompt);
      const r = await req('POST', '/v1/docs', { projectId, title: t, kind: 'document', prompt: prompt.trim() });
      return { doc: { ...meta(r.doc), blocks: [] }, job: r.job || null, draftError: r.draftError || null };
    },
    async saveBlocks(id, blocks, title) {
      const known = base.get(id);
      if (!known) throw new Error('Open the document before saving it');
      const ops = diffBlocks(known.blocks, blocks);
      let version = known.version;
      if (ops.length) {
        const r = await req('POST', `/v1/docs/${enc(id)}/edit`, { ops });
        version = r.doc.version;
        known.version = version;
        known.blocks = blocks.map((b) => ({ id: b.id, type: b.type, text: b.text }));
      }
      if (typeof title === 'string' && title.trim() && title.trim() !== known.title) {
        await req('PATCH', `/v1/docs/${enc(id)}`, { title: title.trim().slice(0, 300) });
        known.title = title.trim();
      }
      return { version };
    },
    async renameDoc(id, title) { await req('PATCH', `/v1/docs/${enc(id)}`, { title: String(title).trim().slice(0, 300) }); },
    async deleteDoc(id) { await req('DELETE', `/v1/docs/${enc(id)}`); },
    async saveComments(id, comments) {
      const { create, del, patch } = diffComments(hubComments.get(id) || [], comments);
      const idMap = {};
      for (const c of create) {
        try {
          const r = await req('POST', `/v1/docs/${enc(id)}/comments`, { blockId: c.blockId, start: c.start, end: c.end, text: c.text });
          idMap[c.id] = r.comment.id;
        } catch (e) { if (e.network) throw e; /* the block moved or is gone: the comment stays on screen and is retried */ }
      }
      for (const cid of del) await req('DELETE', `/v1/docs/${enc(id)}/comments/${enc(cid)}`).catch((e) => { if (e.network) throw e; });
      for (const p of patch) await req('PATCH', `/v1/docs/${enc(id)}/comments/${enc(p.id)}`, { text: p.text }).catch((e) => { if (e.network) throw e; });
      const keep = comments.map((c) => ({ ...c, id: idMap[c.id] || c.id })).filter((c) => !LOCAL.test(c.id));
      hubComments.set(id, keep);
      return { idMap };
    },
    async applyAll(id) {
      try {
        const r = await req('POST', `/v1/docs/${enc(id)}/apply`, {});
        return { ok: true, job: r.job, count: (r.comments || []).length };
      } catch (e) {
        if (e.network) throw e;
        return { ok: false, reason: e.status === 409 ? `${e.message}. Open Claude Code with the Helm mod in this project, then try again.` : e.message };
      }
    },
    async undoApply(id, toVersion) {
      const r = await req('POST', `/v1/docs/${enc(id)}/revert`, { toVersion });
      return { doc: { ...meta(r.doc), blocks: toEditorBlocks(r.doc.blocks) } };
    },
    /** Move a browser-only document to the hub (needs a project). Returns { id, idMap } for the new document. */
    async importLocal(local, comments) {
      const r = await req('POST', '/v1/docs', { projectId: local.projectId, title: local.title, kind: 'document', blocks: local.blocks.map((b) => ({ id: b.id, type: b.type, text: b.text })) });
      const id = r.doc.id;
      const idMap = {};
      const made = [];
      for (const c of comments) {
        if (c.state === 'orphaned' || !c.blockId) continue;
        try {
          const nid = (await req('POST', `/v1/docs/${enc(id)}/comments`, { blockId: c.blockId, start: c.start, end: c.end, text: c.text })).comment.id;
          idMap[c.id] = nid; made.push({ ...c, id: nid, state: 'open' });
        } catch (e) { if (e.network) throw e; }
      }
      base.set(id, { version: r.doc.version, title: r.doc.title, blocks: toEditorBlocks(r.doc.blocks) });
      hubComments.set(id, made);
      return { id, idMap, version: r.doc.version };
    },
  };
}
const LOCAL = /^c\d+$/;

/**
 * The store the screen uses. Each call picks the backend by document id, so local and hub documents sit side by side:
 * the list shows both, and a local document with a project moves to the hub on its first save while the hub is reachable.
 */
export function createStudioStore(local = localBackend(), hub = hubBackend(), probe = defaultProbe) {
  let up = null;       // last probe result
  let probedAt = 0;
  async function hubUp() {
    if (up !== null && Date.now() - probedAt < (up ? 30_000 : 10_000)) return up;
    try { up = await probe(); } catch { up = false; }
    probedAt = Date.now();
    return up;
  }
  const isLocal = (id) => /^L-/.test(String(id));
  const pick = (id) => (isLocal(id) ? local : hub);
  // A hub call that fails because the hub went away flips the flag, so the next call re-probes soon.
  const guard = async (fn) => { try { return await fn(); } catch (e) { if (e && e.network) { up = false; probedAt = Date.now(); } throw e; } };
  return {
    isLocal,
    hubUp,
    get backend() { return up ? 'hub' : 'local'; },
    async listDocs() {
      const mine = await local.listDocs();
      if (!(await hubUp())) return mine;
      try {
        const theirs = await guard(() => hub.listDocs());
        return theirs.concat(mine).sort((a, b) => (Date.parse(b.updatedAt) || Number(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || Number(a.updatedAt) || 0));
      } catch { return mine; }
    },
    getDoc: (id) => (isLocal(id) ? local.getDoc(id) : guard(() => hub.getDoc(id))),
    async createDoc(o) {
      if (o.projectId && (await hubUp())) {
        try { return await guard(() => hub.createDoc(o)); } catch (e) { if (!e.network) throw e; }
      }
      return local.createDoc(o);
    },
    /** Resolves { version, id?, idMap? }: `id` is set when a browser-only document just moved to the hub. */
    async saveBlocks(id, blocks, title) {
      if (!isLocal(id)) return guard(() => hub.saveBlocks(id, blocks, title));
      const r = await local.saveBlocks(id, blocks, title);
      const { doc, comments } = await local.getDoc(id);
      if (!doc.projectId || !(await hubUp())) return r;
      try {
        const moved = await guard(() => hub.importLocal(doc, comments));
        await local.markMigrated(id, moved.id);
        return { version: moved.version, id: moved.id, idMap: moved.idMap };
      } catch { return r; } // the hub said no (project gone?) or vanished: the document stays here and is retried next time
    },
    renameDoc: (id, t) => (isLocal(id) ? local.renameDoc(id, t) : guard(() => hub.renameDoc(id, t))),
    deleteDoc: (id) => (isLocal(id) ? local.deleteDoc(id) : guard(() => hub.deleteDoc(id))),
    saveComments: (id, c) => (isLocal(id) ? local.saveComments(id, c).then(() => ({ idMap: {} })) : guard(() => hub.saveComments(id, c))),
    applyAll: (id) => (isLocal(id) ? local.applyAll(id) : guard(() => hub.applyAll(id))),
    undoApply: (id, v) => guard(() => hub.undoApply(id, v)),
  };
}
async function defaultProbe() {
  const r = await fetch('/v1/docs', { method: 'GET' });
  return r.ok;
}

export const studioStore = createStudioStore();
