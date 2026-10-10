// Server lifecycle: single-instance lock, listeners (unix socket + TCP), sweep timer, shutdown.
import fs from 'node:fs';
import http from 'node:http';
import { loadConfig } from './config.mjs';
import { createLogger } from './log.mjs';
import { Hub } from './hub.mjs';
import { createHandler } from './http.mjs';
import { createRemote } from './remote.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function probeHealth({ sockFile, port, timeout = 1500 }) {
  const attempt = (opts) => new Promise((resolve) => {
    const req = http.get({ ...opts, path: '/v1/health', timeout }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { const j = JSON.parse(b); resolve(j && j.ok ? j : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
  return (async () => {
    if (sockFile && fs.existsSync(sockFile)) {
      const r = await attempt({ socketPath: sockFile });
      if (r) return r;
    }
    if (port > 0) return attempt({ host: '127.0.0.1', port });
    return null;
  })();
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Returns 'acquired' or 'running'. */
async function acquireSingleton(cfg, log) {
  for (let i = 0; i < 6; i++) {
    try {
      const fd = fs.openSync(cfg.pidFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return 'acquired';
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let pid = NaN;
    try { pid = parseInt(fs.readFileSync(cfg.pidFile, 'utf8'), 10); } catch { /* raced */ }
    if (pid && pid !== process.pid && alive(pid)) {
      const h = await probeHealth(cfg);
      if (h && h.pid === pid) return 'running';
      // alive but silent: it may still be starting up. Give it a moment before calling it stale.
      if (i < 3) { await sleep(400); continue; }
    }
    log.info(`removing stale pid file (pid ${pid || '?'})`);
    try { fs.unlinkSync(cfg.pidFile); } catch { /* raced */ }
  }
  throw new Error('could not acquire pid file ' + cfg.pidFile);
}

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, () => { server.off('error', reject); resolve(); });
  });
}

export async function startHub(opts = {}) {
  const cfg = loadConfig(opts);
  fs.mkdirSync(cfg.home, { recursive: true });
  const log = opts.log ?? createLogger(cfg.logFile, { tty: !!opts.tty });

  if (cfg.singleton) {
    const r = await acquireSingleton(cfg, log);
    if (r === 'running') return { alreadyRunning: true, cfg };
  }
  const ownsPid = cfg.singleton;
  const hub = new Hub(cfg, log, { clock: opts.clock, fetch: opts.fetch });
  const boot = { port: cfg.port };
  const sseClients = new Set();
  const remote = createRemote({ cfg, hub, log });
  remote.setInner(createHandler({ hub, cfg, log, boot, viaTcp: true, sseClients, remote, remoteListener: true }));
  const servers = [];
  const cleanupFiles = () => {
    for (const f of [cfg.sockFile, cfg.portFile]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    if (ownsPid) {
      try {
        if (parseInt(fs.readFileSync(cfg.pidFile, 'utf8'), 10) === process.pid) fs.unlinkSync(cfg.pidFile);
      } catch { /* gone */ }
    }
  };

  const mk = (viaTcp) => {
    const s = http.createServer(createHandler({ hub, cfg, log, boot, viaTcp, sseClients, remote }));
    s.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ } });
    servers.push(s);
    return s;
  };

  try {
    if (cfg.unix) {
      if (Buffer.byteLength(cfg.sockFile) > 100) {
        log.warn(`socket path too long for AF_UNIX (${cfg.sockFile}); skipping the unix socket`);
      } else {
        try { fs.unlinkSync(cfg.sockFile); } catch { /* none */ }
        const u = mk(false);
        await listen(u, cfg.sockFile);
        try { fs.chmodSync(cfg.sockFile, 0o600); } catch { /* best effort */ }
      }
    }
    if (cfg.tcp) {
      const t = mk(true);
      await listen(t, { port: cfg.port, host: cfg.host });
      boot.port = t.address().port;
      fs.writeFileSync(cfg.portFile, String(boot.port));
    }
  } catch (e) {
    for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
    hub.close();
    cleanupFiles();
    throw e;
  }

  await remote.init(); // phone access comes back only if it was on when the hub last stopped
  try { hub.wf.tick(); } catch (e) { log.error('workflow resume failed', e); } // v0.9: runs in flight when the hub stopped carry on

  let timer = null;
  if (cfg.sweep) {
    timer = setInterval(() => {
      try {
        const r = hub.sweep();
        if (r) log.info(`sweep: ${JSON.stringify(r)}`);
      } catch (e) { log.error('sweep failed', e); }
    }, cfg.sweepMs);
  }

  let gitTimer = null;
  if (cfg.sweep) { // v0.12: poll GitHub for PRs and CI of pushed task branches (each branch has its own 2 minute schedule)
    gitTimer = setInterval(() => { hub.gitSync.tick().catch((e) => log.warn('git sync failed', e)); }, cfg.gitPollMs);
    gitTimer.unref?.();
  }

  log.info(`helmd ready pid=${process.pid} tcp=${cfg.tcp ? `${cfg.host}:${boot.port}` : 'off'} sock=${cfg.unix ? cfg.sockFile : 'off'} db=${cfg.dbFile}`);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    if (gitTimer) clearInterval(gitTimer);
    for (const c of sseClients) { try { c.res.end(); } catch { /* ignore */ } }
    await remote.close();
    await Promise.all(servers.map((s) => new Promise((r) => {
      s.close(() => r());
      try { s.closeAllConnections(); } catch { /* ignore */ }
    })));
    hub.close();
    cleanupFiles();
    log.info('helmd stopped');
  }
  return { hub, cfg, log, port: boot.port, close, servers, remote, alreadyRunning: false };
}
