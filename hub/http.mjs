// HTTP router (shared by the unix socket and TCP listeners), SSE and static files.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './hub.mjs';
import { VERSION } from './config.mjs';

const MAX_BODY = 1024 * 1024;
export const MAX_UPLOAD = 20 * 1024 * 1024;
const fmtLimit = (n) => `${n / (1024 * 1024)} MiB`;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
};

const STREAM = Symbol('stream');
const CREATED = Symbol('created');
const FILE = Symbol('file');
const created = (o) => ({ [CREATED]: o });

// ------------------------------------------------------------------ routes
const routes = [];
function route(method, pattern, fn) {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  routes.push({ method, re, names, fn });
}
const intParam = (v, d, min, max) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

// Newest mtime across web/: an open dashboard compares it and reloads itself after an update.
function webBuild(root) {
  let max = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else max = Math.max(max, fs.statSync(full).mtimeMs);
    }
  };
  try { walk(root); } catch { /* no web dir */ }
  return Math.round(max);
}

route('GET', '/v1/health', ({ hub, cfg, boot }) => ({
  ok: true, version: VERSION, pid: process.pid, startedAt: hub.startedAt, port: boot.port ?? cfg.port,
  webBuild: webBuild(cfg.webRoot),
}));
route('GET', '/v1/state', ({ hub, query }) => hub.state(query.get('projectId') || undefined));
route('GET', '/v1/stream', () => STREAM);
route('POST', '/v1/events', async ({ hub, json }) => {
  const body = await json();
  if (!Array.isArray(body.events)) throw new HttpError(400, 'body must be { events: [...] }');
  const r = hub.ingest(body.events);
  return { accepted: r.accepted, duplicates: r.duplicates, lastSeq: r.lastSeq, rejected: r.rejected, lastSeqBySession: r.lastSeqBySession };
});
route('GET', '/v1/projects', ({ hub }) => ({ projects: hub.state().projects }));
route('POST', '/v1/projects', async ({ hub, json }) => created(hub.createProject(await json())));
route('PATCH', '/v1/projects/:id', async ({ hub, params, json }) => hub.updateProject(params.id, await json()));
route('GET', '/v1/tasks', ({ hub, query }) => ({
  tasks: hub.tasks({
    sessionId: query.get('sessionId') || undefined, status: query.get('status') || undefined,
    projectId: query.get('projectId') || undefined,
  }),
}));
route('POST', '/v1/tasks', async ({ hub, json }) => created(hub.createTask(await json())));
route('GET', '/v1/tasks/:id', ({ hub, params }) => hub.taskDetail(params.id));
route('PATCH', '/v1/tasks/:id', async ({ hub, params, json }) => hub.updateTask(params.id, await json()));
route('GET', '/v1/sessions/:id/inbox', ({ hub, params }) => hub.claimInbox(params.id));
route('GET', '/v1/sessions/:id/jobs', ({ hub, params }) => hub.claimJobs(params.id));
route('GET', '/v1/sessions/:id/agents', ({ hub, params }) => ({ agents: hub.sessionAgents(params.id) }));
route('GET', '/v1/sessions/:id/project', ({ hub, params }) => ({ project: hub.sessionProject(params.id) }));
route('GET', '/v1/sessions/:id/activity', ({ hub, params, query }) => {
  if (!hub.p.getSession(params.id)) throw new HttpError(404, 'session not found');
  return { activity: hub.sessionActivity(params.id, intParam(query.get('limit'), 200, 1, 2000)) };
});
route('POST', '/v1/sessions/:id/join', async ({ hub, params, json }) => hub.joinSession(params.id, await json()));
route('GET', '/v1/tasks/:id/diff', ({ hub, params, query }) => hub.taskDiff(params.id, { refresh: /^(1|true|yes)$/i.test(query.get('refresh') || '') }));
route('POST', '/v1/tasks/:id/start', ({ hub, params }) => hub.startTask(params.id));
route('POST', '/v1/tasks/:id/choices/apply', async ({ hub, params, json }) => hub.applyChoices(params.id, await json()));
route('POST', '/v1/tasks/:id/choices/reset', ({ hub, params }) => hub.resetChoices(params.id));
route('POST', '/v1/tasks/:id/explain', ({ hub, params }) => hub.explainTask(params.id));
route('POST', '/v1/digest', async ({ hub, json }) => hub.requestDigest(await json()));
route('GET', '/v1/digests', ({ hub, query }) => ({
  digests: hub.digests({ projectId: query.get('projectId') || undefined, limit: intParam(query.get('limit'), 14, 1, 200) }),
}));
route('GET', '/v1/conflicts', ({ hub }) => ({ conflicts: hub.conflicts() }));
route('GET', '/v1/questions', ({ hub, query }) => ({ questions: hub.questions({ state: query.get('state') || undefined }) }));
route('POST', '/v1/questions/:id/dismiss', ({ hub, params }) => hub.dismissQuestion(params.id));
route('POST', '/v1/notes', async ({ hub, json }) => created(hub.createNote(await json())));
route('POST', '/v1/notes/execute', async ({ hub, json }) => hub.executeNotes(await json()));
route('PATCH', '/v1/notes/:id', async ({ hub, params, json }) => hub.updateNote(params.id, await json()));
route('DELETE', '/v1/notes/:id', ({ hub, params }) => hub.deleteNote(params.id));
route('POST', '/v1/notes/:id/retry', ({ hub, params }) => hub.retryNote(params.id));
route('GET', '/v1/search', ({ hub, query }) => ({
  results: hub.search(query.get('q') || '', intParam(query.get('limit'), 30, 1, 100)),
}));
route('POST', '/v1/attachments', async ({ hub, raw, req }) => {
  let name = req.headers['x-filename'];
  if (Array.isArray(name)) name = name[0];
  try { name = name ? decodeURIComponent(name) : ''; } catch { /* keep the undecoded header */ }
  return created(hub.addAttachment({ data: await raw(MAX_UPLOAD), name, mime: req.headers['content-type'] }));
});
route('GET', '/v1/attachments/:id', ({ hub, params }) => {
  const a = hub.attachmentFile(params.id);
  return { [FILE]: a };
});
route('GET', '/v1/usage', ({ hub, query }) => hub.usage(intParam(query.get('days'), 7, 1, 90)));
route('GET', '/v1/usage/breakdown', ({ hub, query }) => hub.usageBreakdown(intParam(query.get('days'), 7, 1, 90)));
route('GET', '/v1/learn', ({ hub, query }) => ({ concepts: hub.learn(query.get('projectId') || undefined) }));

// ------------------------------------------------------------------- helpers
function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', ...headers,
  });
  res.end(body);
}

/** Read the request body into a Buffer, refusing (413) anything over `limit` bytes. */
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    const tooBig = () => new HttpError(413, `request body too large (limit ${fmtLimit(limit)})`);
    if (declared > limit) { reject(tooBig()); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        chunks.length = 0;
        reject(tooBig());
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const text = (await readBody(req)).toString('utf8');
  if (!text.trim()) return {};
  let v;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, 'invalid JSON body'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'JSON body must be an object');
  return v;
}

/** CSRF / DNS-rebinding guard: the hub can inject prompts into sessions, so browsers must not drive it cross-site. */
function guard(req, viaTcp, mutating) {
  if (viaTcp) {
    const host = req.headers.host;
    if (host && !LOCAL_HOST.test(host)) throw new HttpError(403, 'forbidden host');
  }
  if (mutating) {
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) throw new HttpError(403, 'forbidden origin');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-site request refused');
  }
}

// ---------------------------------------------------------------- attachments
/**
 * Uploaded files are untrusted content served from the hub's own origin, so only raster images render inline;
 * everything else (html, svg, ...) is a download, and a sandbox CSP + nosniff stop it running as a page.
 */
function sendAttachment(req, res, a, cors) {
  const inline = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(a.mime);
  const ascii = a.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    ...cors,
    'Content-Type': a.mime, 'Content-Length': a.size, 'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:",
  });
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(a.path);
  rs.on('error', () => res.destroy());
  rs.pipe(res);
}

// ----------------------------------------------------------------------- SSE
function handleStream(hub, cfg, req, res, query, sseClients) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n: connected\n\n');
  const send = (rows) => {
    for (const r of rows) {
      res.write(`id: ${r.seq}\nevent: change\ndata: {"entity":"${r.entity}","op":"${r.op}","row":${r.row}}\n\n`);
    }
    if (res.writableLength > 8 * 1024 * 1024) res.destroy(); // client not reading
  };
  const last = req.headers['last-event-id'] ?? query.get('lastEventId') ?? query.get('since');
  if (last !== undefined && last !== null && last !== '') {
    const r = hub.changesSince(Number(last));
    if (r.reset) res.write(`id: ${hub.seqNow()}\nevent: reset\ndata: {"seq":${hub.seqNow()}}\n\n`);
    else send(r.rows);
  }
  const unsub = hub.subscribe(send);
  const hb = setInterval(() => res.write(': hb\n\n'), cfg.sseHeartbeatMs);
  const entry = { res };
  sseClients.add(entry);
  const cleanup = () => { clearInterval(hb); unsub(); sseClients.delete(entry); };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// -------------------------------------------------------------------- static
function serveStatic(cfg, req, res, pathname) {
  const root = cfg.webRoot;
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return sendJson(res, 400, { error: 'bad path' }); }
  if (rel.includes('\0')) return sendJson(res, 400, { error: 'bad path' });
  rel = path.posix.normalize('/' + rel);
  const tryFile = (p) => {
    try {
      const real = fs.realpathSync(p);
      let realRoot;
      try { realRoot = fs.realpathSync(root); } catch { return null; }
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null; // traversal / symlink escape
      const st = fs.statSync(real);
      if (st.isDirectory()) return tryFile(path.join(real, 'index.html'));
      return st.isFile() ? { real, st } : null;
    } catch { return null; }
  };
  let hit = tryFile(path.join(root, rel));
  if (!hit && !path.extname(rel)) hit = tryFile(path.join(root, 'index.html')); // SPA fallback
  if (!hit) {
    if (!path.extname(rel) || rel === '/') {
      const body = '<!doctype html><meta charset="utf-8"><title>Helm hub</title><body style="font:16px system-ui;padding:2rem">'
        + '<h1>Helm hub is running</h1><p>The web UI is not installed (no <code>web/index.html</code> found). '
        + 'The API is available under <code>/v1/</code>.</p></body>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    return sendJson(res, 404, { error: 'not found' });
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(hit.real).toLowerCase()] || 'application/octet-stream',
    'Content-Length': hit.st.size, 'Cache-Control': 'no-store', // tiny local files: never let a browser mix stale modules with new ones
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(hit.real);
  rs.on('error', () => res.destroy());
  rs.pipe(res);
}

// -------------------------------------------------------------------- handler
export function createHandler({ hub, cfg, log, boot = {}, viaTcp, sseClients }) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const method = req.method;
      const origin = req.headers.origin;
      const cors = origin && LOCAL_ORIGIN.test(origin)
        ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};

      if (method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '600' });
        return res.end();
      }

      if (!pathname.startsWith('/v1/') && pathname !== '/v1') {
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
        guard(req, viaTcp, false);
        return serveStatic(cfg, req, res, pathname);
      }

      let matched = null;
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
        const params = {};
        r.names.forEach((n, i) => {
          try { params[n] = decodeURIComponent(m[i + 1]); } catch { params[n] = m[i + 1]; }
        });
        matched = { r, params };
        break;
      }
      if (!matched) {
        return sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'method not allowed' : 'not found' }, cors);
      }
      const isInbox = /\/(inbox|jobs)$/.test(pathname); // GETs that claim (mutate) rows get the CSRF guard too
      guard(req, viaTcp, method !== 'GET' && method !== 'HEAD' || isInbox);

      const ctx = {
        hub, cfg, boot, params: matched.params, query: url.searchParams, req, res,
        json: () => parseJsonBody(req),
        raw: (limit) => readBody(req, limit),
      };
      const out = await matched.r.fn(ctx);
      if (out === STREAM) return handleStream(hub, cfg, req, res, url.searchParams, sseClients);
      if (out && out[FILE]) return sendAttachment(req, res, out[FILE], cors);
      if (out && out[CREATED]) return sendJson(res, 201, out[CREATED], cors);
      return sendJson(res, 200, out, cors);
    } catch (e) {
      if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
      if (e instanceof HttpError) {
        const headers = e.status === 413 ? { Connection: 'close' } : {};
        return sendJson(res, e.status, { error: e.message }, headers);
      }
      log?.error(`unhandled error for ${req.method} ${req.url}`, e);
      return sendJson(res, 500, { error: 'internal error' });
    }
  };
}
