// Shared test helpers (not a test file itself).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHub, probeHealth } from '../server.mjs';

export const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HELMD = path.join(HUB, 'helmd.mjs');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function tmpDir(prefix = 'helm-t-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

/** In-process hub on a temp HELM_HOME and an ephemeral port. */
export async function startTest(over = {}) {
  const home = tmpDir();
  const s = await startHub({ home, port: 0, singleton: false, sweep: false, ...over });
  const base = `http://127.0.0.1:${s.port}`;
  const api = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method, headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const seqs = {};
  const ev = (sessionId, type, data = {}, at = Date.now()) => ({
    sessionId, seq: (seqs[sessionId] = (seqs[sessionId] || 0) + 1), type, at, data,
  });
  const send = (...events) => s.hub.ingest(events);
  const stop = async () => { await s.close(); fs.rmSync(home, { recursive: true, force: true }); };
  return { ...s, home, base, api, ev, send, stop, get: (p) => api('GET', p), state: () => s.hub.state() };
}

/** Request over the unix socket. */
export function sockRequest(sockFile, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      socketPath: sockFile, method, path: p,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { let json; try { json = JSON.parse(b); } catch { /* */ } resolve({ status: res.statusCode, json, text: b }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Raw request with a verbatim path / headers (no URL normalisation). */
export function rawRequest(port, { method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Minimal SSE client. */
export function openStream(base, headers = {}, p = '/v1/stream') {
  const events = [];
  let buf = '';
  let waiters = [];
  const url = new URL(base + p);
  const req = http.get({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = { id: null, event: 'message', data: null, comment: null };
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) ev.id = Number(line.slice(4));
          else if (line.startsWith('event: ')) ev.event = line.slice(7);
          else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          else if (line.startsWith(':')) ev.comment = line.slice(1).trim();
        }
        events.push(ev);
        waiters = waiters.filter((w) => !w());
      }
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  const waitFor = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const check = () => { const f = events.find(pred); if (f) { resolve(f); return true; } return false; };
    if (check()) return;
    waiters.push(check);
    setTimeout(() => reject(new Error('SSE timeout; got ' + JSON.stringify(events.slice(-5)))), ms).unref();
  });
  return { events, waitFor, close: () => req.destroy() };
}

/** Spawn a real helmd process. */
export function spawnDaemon(home, port, args = [], env = {}) {
  const child = spawn(process.execPath, [HELMD, '--home', home, '--port', String(port), ...args], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  child.output = () => out;
  child.exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
  return child;
}

export async function waitHealthy(home, port, ms = 8000) {
  const sockFile = path.join(home, 'helmd.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const h = await probeHealth({ sockFile, port });
    if (h) return h;
    await sleep(80);
  }
  throw new Error('daemon not healthy');
}

export async function waitUntil(fn, ms = 4000, step = 25) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitUntil timed out');
    await sleep(step);
  }
}
