// Configuration: paths, ports, sweep timings. Everything injectable via options or env.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = '0.14.0';

const int = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(o = {}, env = process.env) {
  const home = path.resolve(o.home ?? env.HELM_HOME ?? path.join(os.homedir(), '.helm'));
  return {
    home,
    host: '127.0.0.1',
    port: int(o.port ?? env.HELM_PORT, 7777),
    dbFile: path.join(home, 'helm.db'),
    sockFile: path.join(home, 'helmd.sock'),
    pidFile: path.join(home, 'helmd.pid'),
    portFile: path.join(home, 'helmd.port'),
    attachDir: path.join(home, 'attachments'),
    remoteFile: path.join(home, 'remote.json'), // phone access: { enabled, token } (mode 0600)
    remoteHost: o.remoteHost ?? env.HELM_REMOTE_HOST ?? '0.0.0.0', // narrow it with HELM_REMOTE_HOST
    remotePort: int(o.remotePort ?? env.HELM_REMOTE_PORT, 7778),
    remote: o.remote ?? true, // false: never open the phone-access listener (tests)
    logFile: path.join(home, 'helmd.log'),
    webRoot: path.resolve(o.webRoot ?? env.HELM_WEB ?? path.join(HUB_DIR, '..', 'web')),
    stallMs: int(o.stallMs ?? env.HELM_STALL_MS, 5 * 60_000),
    autoStartingMs: int(o.autoStartingMs ?? env.HELM_AUTO_STARTING_MS, 3 * 60_000), // a delivered start still counts as starting
    autoBackoffMs: int(o.autoBackoffMs ?? env.HELM_AUTO_BACKOFF_MS, 5 * 60_000),   // wait after a failed auto-start
    sendingMs: int(o.sendingMs ?? env.HELM_SENDING_MS, 10 * 60_000), // note stuck in `sending` -> failed
    jobMs: int(o.jobMs ?? env.HELM_JOB_MS, 5 * 60_000), // job claimed (or queued) but never answered -> failed
    stepMs: int(o.stepMs ?? env.HELM_STEP_MS, 60 * 60_000), // workflow step claimed but never answered -> failed (node timeouts extend it)
    blockMs: int(o.blockMs ?? env.HELM_BLOCK_MS, 10 * 60_000),
    idleMs: int(o.idleMs ?? env.HELM_IDLE_MS, 2 * 60_000),
    sweepMs: int(o.sweepMs ?? env.HELM_SWEEP_MS, 30_000),
    keepChanges: int(o.keepChanges ?? env.HELM_CHANGES_KEEP, 5000),
    sseHeartbeatMs: int(o.sseHeartbeatMs ?? env.HELM_SSE_HEARTBEAT_MS, 15_000),
    tcp: o.tcp ?? true,
    unix: o.unix ?? true,
    singleton: o.singleton ?? true,
    sweep: o.sweep ?? true, // run the periodic sweep timer
  };
}
