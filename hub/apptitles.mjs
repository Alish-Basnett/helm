// v0.27: the Claude desktop app's own title for each Code session. Read-only: the app writes
// <root>/<a>/<b>/local_<uuid>.json ({ sessionId, cliSessionId, title, ... }); we only read those fields and never write.
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE = 1_000_000;
const MAX_DEPTH = 4;
const MAX_FILES = 5000;

/** One line, no control characters, at most 200 characters. */
export const cleanAppTitle = (v) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

export class AppTitles {
  constructor({ dir, hub, log, debounceMs = 500, rescanMs = 60_000, maxFiles = MAX_FILES }) {
    this.maxFiles = maxFiles;
    this.dir = dir; this.hub = hub; this.log = log; this.debounceMs = debounceMs; this.rescanMs = rescanMs;
    this.cache = new Map(); this.watcher = null; this.timer = null; this.rescan = null; this.stopped = false;
  }
  start() {
    if (!this.dir || this.stopped) return;
    this.watch();
    this.scan();
    this.rescan = setInterval(() => { if (!this.watcher) this.watch(); this.scan(); }, this.rescanMs);
    this.rescan.unref?.();
  }
  watch() {
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, () => this.later());
      this.watcher.on('error', () => { try { this.watcher?.close(); } catch { /* ignore */ } this.watcher = null; });
      this.watcher.unref?.();
    } catch { this.watcher = null; } // missing directory or no recursive watch on this OS: the rescan still runs
  }
  later() {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; this.scan(); }, this.debounceMs);
    this.timer.unref?.();
  }
  /**
   * Record the sessions whose title (or app session id) differs from the hub's. Files are cached by path + mtime + size, so only
   * changed ones are read again; when several files name the same cliSessionId the newest mtime wins (one update per session).
   * At most MAX_FILES files are looked at per scan. Returns how many sessions changed.
   */
  scan() {
    if (this.stopped || this.hub.closed) return 0;
    const seen = new Map(), best = new Map();
    let count = 0;
    for (const f of this.files(this.dir, 0)) {
      if (++count > this.maxFiles) { this.log?.warn(`app titles: more than ${this.maxFiles} session files under ${this.dir}; the rest are ignored`); break; }
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      let c = this.cache.get(f);
      if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
        c = { mtimeMs: st.mtimeMs, size: st.size, rec: null };
        try {
          const j = st.size <= MAX_FILE ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
          if (j && typeof j.cliSessionId === 'string' && typeof j.title === 'string') {
            const title = cleanAppTitle(j.title);
            if (title) c.rec = { cli: j.cliSessionId, title, app: typeof j.sessionId === 'string' ? cleanAppTitle(j.sessionId) || null : null };
          }
        } catch { /* not JSON */ }
      }
      seen.set(f, c);
      const b = c.rec && best.get(c.rec.cli);
      if (c.rec && (!b || c.mtimeMs >= b.mtimeMs)) best.set(c.rec.cli, { mtimeMs: c.mtimeMs, ...c.rec });
    }
    this.cache = seen;
    let n = 0;
    for (const r of best.values()) {
      try { if (this.hub.setAppTitle(r.cli, r.title, r.app)) n++; } catch (e) { this.log?.warn('app title failed', e); }
    }
    return n;
  }
  *files(dir, depth) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < MAX_DEPTH) yield* this.files(p, depth + 1);
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) yield p;
    }
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.rescan) clearInterval(this.rescan);
    try { this.watcher?.close(); } catch { /* ignore */ }
  }
}
