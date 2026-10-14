#!/usr/bin/env node
// helmd — local hub daemon for Helm.
//   node hub/helmd.mjs [--port 7777] [--home DIR] [--seed] [--demo-live]
//   node hub/helmd.mjs --detach      start in the background (returns once healthy)
//   node hub/helmd.mjs --stop        SIGTERM the running daemon
//   node hub/helmd.mjs --status      print health JSON (exit 1 when not running)
//   node hub/helmd.mjs --backfill-recaps [--dry-run] [--improve] [--reports FILE.json]  record recap.generated for finished tasks without one
//   node hub/helmd.mjs --rebuild     drop projections and replay the events table (daemon must be stopped)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createLogger } from './log.mjs';
import { startHub, probeHealth } from './server.mjs';

const SELF = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const o = { flags: new Set(), port: undefined, home: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
    else if (a === '--home') o.home = argv[++i];
    else if (a.startsWith('--home=')) o.home = a.slice(7);
    else if (a === '--reports') o.reports = argv[++i];
    else if (a.startsWith('--')) o.flags.add(a.slice(2));
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const opts = {};
  if (args.port !== undefined && Number.isFinite(args.port)) opts.port = args.port;
  if (args.home) opts.home = args.home;
  const cfg = loadConfig(opts);
  const tty = !!process.stdout.isTTY;

  if (args.flags.has('status')) {
    const h = await probeHealth(cfg);
    console.log(h ? JSON.stringify(h) : 'not running');
    process.exit(h ? 0 : 1);
  }

  if (args.flags.has('stop')) {
    let pid = NaN;
    try { pid = parseInt(fs.readFileSync(cfg.pidFile, 'utf8'), 10); } catch { /* none */ }
    if (!pid) { console.log('not running'); process.exit(0); }
    try { process.kill(pid, 'SIGTERM'); } catch { console.log('not running (stale pid file)'); process.exit(0); }
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { process.kill(pid, 0); } catch { console.log(`stopped pid ${pid}`); process.exit(0); }
    }
    console.error(`pid ${pid} did not exit within 5s`);
    process.exit(1);
  }

  if (args.flags.has('detach')) {
    const existing = await probeHealth(cfg);
    if (existing) { console.log(`already running (pid ${existing.pid})`); process.exit(0); }
    fs.mkdirSync(cfg.home, { recursive: true });
    const out = fs.openSync(cfg.logFile, 'a');
    const childArgs = process.argv.slice(2).filter((a) => a !== '--detach');
    const child = spawn(process.execPath, [SELF, ...childArgs], {
      detached: true, stdio: ['ignore', out, out], env: process.env,
    });
    child.unref();
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const h = await probeHealth(cfg);
      if (h) { console.log(`started pid ${h.pid}, http://127.0.0.1:${h.port ?? cfg.port}, socket ${cfg.sockFile}`); process.exit(0); }
    }
    console.error(`daemon did not become healthy in 8s; see ${cfg.logFile}`);
    process.exit(1);
  }

  if (args.flags.has('backfill-recaps')) {
    // T-76: through the running daemon when there is one, else straight on the database.
    const body = { dryRun: args.flags.has('dry-run'), improve: args.flags.has('improve') };
    if (args.reports) body.reports = JSON.parse(fs.readFileSync(args.reports, 'utf8'));
    const live = await probeHealth(cfg);
    let out;
    if (live) {
      const r = await fetch(`http://127.0.0.1:${live.port ?? cfg.port}/v1/recaps/backfill`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) { console.error(`backfill failed: ${r.status} ${await r.text()}`); process.exit(1); }
      out = await r.json();
    } else {
      const { Hub } = await import('./hub.mjs');
      const hub = new Hub(cfg, createLogger(cfg.logFile, { tty }));
      out = hub.backfillRecaps(body);
      hub.close();
    }
    console.log(JSON.stringify(out, null, 1));
    process.exit(0);
  }

  if (args.flags.has('rebuild')) {
    const live = await probeHealth(cfg);
    if (live) { console.error(`daemon is running (pid ${live.pid}); stop it before --rebuild`); process.exit(2); }
    const { Hub } = await import('./hub.mjs');
    const log = createLogger(cfg.logFile, { tty });
    const hub = new Hub(cfg, log);
    const digest = () => crypto.createHash('sha256').update(JSON.stringify(hub.dump())).digest('hex');
    const before = digest();
    const r = hub.rebuild();
    const after = digest();
    hub.close();
    console.log(JSON.stringify({ replayed: r.replayed, ms: r.ms, identical: before === after, sha256: after }));
    process.exit(before === after ? 0 : 3);
  }

  let started;
  try {
    started = await startHub({ ...opts, tty });
  } catch (e) {
    const msg = e.code === 'EADDRINUSE' ? `port ${cfg.port} is already in use` : e.message;
    console.error(`helmd failed to start: ${msg}`);
    process.exit(1);
  }
  if (started.alreadyRunning) {
    console.log('helmd already running');
    process.exit(0);
  }
  const { hub, log } = started;

  let stopDemo = null;
  if (args.flags.has('seed') || args.flags.has('demo-live')) {
    const { seed, startDemoLive } = await import('./seed.mjs');
    const r = seed(hub, log);
    if (r.gitTaskId) hub.snapshotTask(r.gitTaskId).catch((e) => log.warn('seed diff snapshot failed', e));
    log.info(r.skipped ? 'seed skipped: database already seeded' : `seeded demo data: ${JSON.stringify(r.counts)}`);
    if (args.flags.has('demo-live')) stopDemo = startDemoLive(hub, log);
  }

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log.info(`received ${sig}, shutting down`);
    if (stopDemo) stopDemo();
    const force = setTimeout(() => process.exit(1), 4000);
    force.unref();
    try { await started.close(); } catch (e) { log.error('shutdown error', e); }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => { /* detached daemon: ignore terminal hangup */ });
  process.on('uncaughtException', (e) => log.error('uncaughtException', e));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
}

main().catch((e) => { console.error(e); process.exit(1); });
