// Phone access: an opt-in, token-protected LAN listener in front of a tiny allow-list of the hub's routes.
//
// The main hub only listens on 127.0.0.1 and refuses non-local Host / Origin because it can inject prompts into
// Claude sessions. A phone needs LAN access, so this is deliberately narrow and off by default:
//   * POST /v1/remote { enabled } (loopback only) starts a listener on 0.0.0.0:${HELM_REMOTE_PORT:-7778}.
//   * Every request is rate limited per IP, must be on the allow-list (403 otherwise) and carry the token (401).
//   * The token is 32 random bytes, kept in $HELM_HOME/remote.json (0600) and rotated whenever access is switched off.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './hub.mjs';

export const RATE_LIMIT = 60;            // requests per IP per minute
export const RATE_WINDOW_MS = 60_000;
export const MAX_FAILS = 5;              // failed auths from one IP ...
export const FAIL_WINDOW_MS = 10 * 60_000;
export const BAN_MS = 10 * 60_000;       // ... earn this ban

const GET = 'GET';
/** Route allow-list for the remote listener: method + path pattern. Anything else is 403. */
const ALLOW = [
  [GET, /^\/m(\/[A-Za-z0-9._-]*)?$/],
  [GET, /^\/v1\/state$/],
  [GET, /^\/v1\/stream$/],
  ['POST', /^\/v1\/tasks$/],
  ['POST', /^\/v1\/notes$/],
  ['POST', /^\/v1\/attachments$/],
  [GET, /^\/v1\/attachments\/[^/]+$/],
];
/** The page shell is code, not data: it must load before the page can read the token from the URL hash. */
const SHELL = /^\/m(\/(index\.html|m\.js|m\.css)?)?$/;

const newToken = () => crypto.randomBytes(32).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
/** Constant-time string compare (hashing first makes the lengths equal and hides the real length). */
export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return crypto.timingSafeEqual(sha(a), sha(b));
}
const cleanIp = (a) => String(a || 'unknown').replace(/^::ffff:/i, '');
export const isLoopback = (a) => a === undefined || a === null || /^(127\.|::1$|::ffff:127\.)/i.test(String(a));

function readCookie(header, name) {
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}
function bearer(req) {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m ? m[1] : '';
}

/** IPv4 addresses of this machine's LAN interfaces, likeliest first (Wi-Fi/ethernet before virtual ones). */
export function lanAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const virtual = /^(utun|awdl|llw|bridge|vmnet|vboxnet|docker|veth|gif|stf|ap)/i.test(name);
      const rank = (virtual ? 100 : 0) + (/^en\d/.test(name) ? 0 : 10)
        + (/^(192\.168\.|10\.)/.test(a.address) ? 0 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 1 : 5);
      out.push({ name, address: a.address, rank });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || (a.address < b.address ? -1 : 1)).map(({ name, address }) => ({ name, address }));
}

/** Why a task is waiting on the user (same sources as the web app's needsYou), as short labels. */
function needsYou(task, st) {
  if (task.status === 'done' || task.status === 'archived') return [];
  const out = [];
  const add = (l) => { if (!out.includes(l)) out.push(l); };
  const nc = Array.isArray(task.choices) ? task.choices.filter((c) => c.state === 'open').length : 0;
  if (nc) add(nc === 1 ? '1 choice' : `${nc} choices`);
  const agent = task.agentId ? st.agents.find((a) => a.id === task.agentId) : null;
  for (const q of st.questions) {
    if (q.state === 'open' && (q.taskId === task.id || (agent && q.agentId === agent.id))) add(q.kind === 'waiting' ? 'Waiting for you' : 'Question');
  }
  if (agent && agent.status === 'waiting') add('Waiting for you');
  if (st.notes.some((n) => n.state === 'failed' && n.target && n.target.kind === 'task' && n.target.id === task.id)) add('Note failed');
  if (task.status === 'next' && task.autoStartedAt) {
    const sn = task.startNoteId && st.notes.find((n) => n.id === task.startNoteId);
    if (sn && sn.state === 'failed') add('Auto-start failed');
  }
  if (task.status === 'review') add('Review');
  return out;
}

export function createRemote({ cfg, hub, log }) {
  let server = null;
  let boundPort = null;
  let inner = null;                 // the real router, set by server.mjs
  let token = null;
  const hits = new Map();           // ip -> request timestamps (last minute)
  const fails = new Map();          // ip -> failed-auth timestamps
  const bans = new Map();           // ip -> ban expiry
  const sentNotes = new Set();      // notes created through the phone listener (their replies may be shown back)
  const now = () => hub.now();

  /* ----- persistence ----- */
  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(cfg.remoteFile, 'utf8'));
      return { enabled: j && j.enabled === true, token: j && typeof j.token === 'string' && j.token.length >= 32 ? j.token : null };
    } catch { return { enabled: false, token: null }; }
  }
  function persist(enabled) {
    const tmp = `${cfg.remoteFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ enabled, token }) + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
    fs.renameSync(tmp, cfg.remoteFile);
  }

  /* ----- abuse controls ----- */
  const recent = (map, ip, windowMs, t) => {
    const arr = (map.get(ip) || []).filter((x) => t - x < windowMs);
    map.set(ip, arr);
    return arr;
  };
  function prune(t) {
    if (hits.size + fails.size + bans.size < 2000) return;
    for (const [ip, arr] of hits) if (!arr.some((x) => t - x < RATE_WINDOW_MS)) hits.delete(ip);
    for (const [ip, arr] of fails) if (!arr.some((x) => t - x < FAIL_WINDOW_MS)) fails.delete(ip);
    for (const [ip, until] of bans) if (until <= t) bans.delete(ip);
  }

  const send = (res, status, obj, headers = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };

  /** What the phone may see of /v1/state: projects, sessions, tasks that need the user (with reasons) and their notes. */
  function publicState(projectId) {
    const st = hub.state(projectId || undefined);
    const tasks = st.tasks.map((t) => ({ t, needs: needsYou(t, st) })).filter((x) => x.needs.length);
    const ids = new Set(tasks.map((x) => x.t.id));
    const note = (n) => ({
      id: n.id, target: n.target, sessionId: n.sessionId, text: n.text, state: n.state, createdAt: n.createdAt, ranAt: n.ranAt,
      error: n.error, reply: n.reply, repliedAt: n.repliedAt,
      attachments: (n.attachments || []).map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size })),
    });
    return {
      projects: st.projects.map((p) => ({ id: p.id, name: p.name, archived: p.archived })),
      sessions: st.sessions.map((s) => ({ id: s.id, projectId: s.projectId, title: s.title, model: s.model, status: s.status, busy: s.busy, nowDoing: s.nowDoing, lastSeenAt: s.lastSeenAt })),
      tasks: tasks.map(({ t, needs }) => ({ id: t.id, projectId: t.projectId, title: t.title, status: t.status, updatedAt: t.updatedAt, needs })),
      notes: st.notes.filter((n) => sentNotes.has(n.id) || (n.target && n.target.kind === 'task' && ids.has(n.target.id))).map(note),
      seq: st.seq,
    };
  }

  /* ----- the gate in front of the router ----- */
  async function gate(req, res) {
    const t = now();
    const ip = cleanIp(req.socket.remoteAddress);
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    const method = req.method;
    res.on('finish', () => log.info(`remote ${method} ${JSON.stringify(pathname)} ${res.statusCode} ip=${ip}`));
    prune(t);

    const banUntil = bans.get(ip);
    if (banUntil && banUntil > t) {
      return send(res, 429, { error: 'too many failed attempts; try again later' }, { 'Retry-After': String(Math.ceil((banUntil - t) / 1000)) });
    }
    const h = recent(hits, ip, RATE_WINDOW_MS, t);
    if (h.length >= RATE_LIMIT) {
      return send(res, 429, { error: 'rate limit exceeded' }, { 'Retry-After': String(Math.max(1, Math.ceil((RATE_WINDOW_MS - (t - h[0])) / 1000))) });
    }
    h.push(t);

    // allow-list. A path that changes under decoding / normalisation (.., %2f, backslash) is never one of ours.
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { decoded = null; }
    const clean = decoded !== null && !decoded.includes('\\') && !decoded.includes('\0') && path.posix.normalize(decoded) === decoded;
    const allowed = clean && ALLOW.some(([m, re]) => m === method && re.test(pathname));
    if (!allowed) return send(res, 403, { error: 'forbidden' });

    if (method === GET && SHELL.test(pathname)) return inner(req, res);

    const presented = bearer(req) || readCookie(req.headers.cookie, 'helm_k');
    if (!tokenEquals(presented, token)) {
      const f = recent(fails, ip, FAIL_WINDOW_MS, t);
      f.push(t);
      if (f.length >= MAX_FAILS) {
        bans.set(ip, t + BAN_MS);
        fails.delete(ip);
        log.warn(`remote: banned ${ip} for ${BAN_MS / 60000} min after ${MAX_FAILS} failed auths`);
      }
      return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }

    if (method === 'GET' && pathname === '/v1/state') {
      try { return send(res, 200, publicState(url.searchParams.get('projectId'))); } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message });
        log.error('remote state failed', e);
        return send(res, 500, { error: 'internal error' });
      }
    }
    return inner(req, res);
  }

  /* ----- lifecycle ----- */
  const urls = () => {
    if (!server || boundPort == null) return [];
    return lanAddresses().map((a) => ({ name: a.name, address: a.address, url: `http://${a.address}:${boundPort}/m#k=${token}` }));
  };
  const status = () => {
    const enabled = !!server;
    const u = urls();
    return { enabled, port: enabled ? boundPort : cfg.remotePort, token: enabled ? token : null, url: u[0] ? u[0].url : null, urls: u };
  };

  async function enable() {
    if (server) return status();
    if (!inner) throw new Error('remote handler not set');
    const saved = load();
    token = saved.token || newToken();
    const s = http.createServer(gate);
    s.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ } });
    try {
      await new Promise((resolve, reject) => {
        s.once('error', reject);
        s.listen({ port: cfg.remotePort, host: cfg.remoteHost }, () => { s.off('error', reject); resolve(); });
      });
    } catch (e) {
      throw new HttpError(409, e.code === 'EADDRINUSE' ? `port ${cfg.remotePort} is already in use (set HELM_REMOTE_PORT)` : `could not open the phone listener: ${e.message}`);
    }
    server = s;
    boundPort = s.address().port;
    persist(true);
    log.info(`remote: phone access ON, listening on ${cfg.remoteHost}:${boundPort}`);
    return status();
  }

  async function stopListener() {
    const s = server;
    server = null;
    boundPort = null;
    if (!s) return;
    await new Promise((resolve) => { s.close(() => resolve()); try { s.closeAllConnections(); } catch { /* ignore */ } });
  }

  async function disable() {
    const was = !!server;
    if (!was && !load().enabled) return status();
    await stopListener();
    token = newToken(); // the old link must never work again
    hits.clear(); fails.clear(); bans.clear(); sentNotes.clear();
    persist(false);
    if (was) log.info('remote: phone access OFF (listener closed, token rotated)');
    return status();
  }

  return {
    setInner(fn) { inner = fn; },
    status,
    enable,
    disable,
    /** Re-open after a hub restart, only if it was enabled when the hub stopped. */
    async init() {
      if (!cfg.remote) return;
      if (!load().enabled) return;
      try { await enable(); } catch (e) { log.warn(`remote: could not re-enable phone access: ${e.message}`); }
    },
    /** Shutdown: close the listener but keep remote.json as it is. */
    close: stopListener,
    trackNote(id) {
      sentNotes.add(id);
      if (sentNotes.size > 500) sentNotes.delete(sentNotes.values().next().value);
    },
    publicState,
  };
}
