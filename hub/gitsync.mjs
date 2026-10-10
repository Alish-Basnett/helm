// Background sync with GitHub for pushed task branches (v0.12): link the PR and follow its CI, unauthenticated.
//
// Public repos only (no tokens): `GET /repos/<o>/<r>/pulls?head=<o>:<branch>&state=all` and
// `GET /repos/<o>/<r>/commits/<sha>/check-runs`, every 2 minutes while there is something to learn. A 403/429 backs the whole
// poller off (exponential, honouring Retry-After / X-RateLimit-Reset). A private or missing repo (404) records
// `ci = { state: 'unknown', reason }` and stops polling that branch. Results are recorded as hub events so rebuild replays them.
// The timer lives in server.mjs; tests call tick() / refresh() directly with an injected fetch.
import { summariseChecks } from './gitflow.mjs';

const API = 'https://api.github.com';
export const POLL_MS = 2 * 60_000;
export const LINKED_POLL_MS = 10 * 60_000;     // an already linked PR only needs the occasional open -> merged refresh
export const NONE_GIVE_UP_MS = 15 * 60_000;    // a push with no checks at all stops being polled after this long
export const BACKOFF_MIN_MS = 5 * 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
const MAX_NETWORK_FAILS = 3;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stripTime = (ci) => (ci ? { ...ci, updatedAt: 0 } : ci);

export class GitSync {
  constructor(hub, { fetchImpl, timeoutMs = 10_000 } = {}) {
    this.hub = hub;
    this.fetchImpl = fetchImpl || null;   // tests replace this; null = the global fetch
    this.timeoutMs = timeoutMs;
    this.per = new Map();                 // taskId -> { nextPr, nextCi, fails, prDone }
    this.backoffUntil = 0;
    this.backoffStep = 0;
    this.running = false;
  }
  state(id) { let s = this.per.get(id); if (!s) { s = { nextPr: 0, nextCi: 0, fails: 0, prDone: false }; this.per.set(id, s); } return s; }

  async gh(path) {
    const f = this.fetchImpl || globalThis.fetch;
    const res = await f(API + path, {
      headers: { 'User-Agent': 'helm-local', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json, headers: res.headers };
  }
  rateLimited(res, now) {
    const h = (n) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(n) : null);
    let wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.backoffStep);
    this.backoffStep = Math.min(this.backoffStep + 1, 6);
    const ra = Number(h('retry-after')), reset = Number(h('x-ratelimit-reset'));
    if (Number.isFinite(ra) && ra > 0) wait = Math.max(wait, ra * 1000);
    else if (Number.isFinite(reset) && reset * 1000 > now) wait = Math.max(wait, Math.min(BACKOFF_MAX_MS, reset * 1000 - now));
    this.backoffUntil = now + wait;
    this.hub.log?.warn(`github api rate limited; backing off ${Math.round(wait / 1000)}s`);
  }

  /** Pushed GitHub branches that might still change. */
  candidates() {
    const out = [];
    for (const r of this.hub.db.all('SELECT id, branch FROM tasks WHERE branch IS NOT NULL ORDER BY rowid')) {
      let b; try { b = JSON.parse(r.branch); } catch { continue; }
      if (b && b.pushedAt && b.github && /^[\w.-]+\/[\w.-]+$/.test(b.github)) out.push({ id: r.id, b });
    }
    return out;
  }
  current(id) {
    const t = this.hub.p.getTask(id);
    try { return t && t.branch ? JSON.parse(t.branch) : null; } catch { return null; }
  }

  /** Poll everything that is due. Never throws. */
  async tick(now = this.hub.now()) {
    if (this.running || this.hub.closed || this.hub.replaying) return { polled: 0 };
    this.running = true;
    let polled = 0;
    try {
      for (const { id, b } of this.candidates()) {
        if (this.hub.closed || now < this.backoffUntil) break;
        const s = this.state(id);
        if (now >= s.nextCi && this.wantsCi(b, now)) { polled++; await this.pollCi(id, now); }
        if (this.hub.closed || now < this.backoffUntil) break;
        const cur = this.current(id) || b;
        if (now >= s.nextPr && !s.prDone && this.wantsPr(cur)) { polled++; await this.pollPr(id, now); }
      }
    } catch (e) { this.hub.log?.warn('git sync failed', e); } finally { this.running = false; }
    return { polled };
  }
  /** Poll one task right now (a user asked). Clears "unknown" so it can recover. */
  async refresh(id, now = this.hub.now()) {
    const b = this.current(id);
    if (!b || !b.pushedAt || !b.github) return { polled: 0 };
    this.per.delete(id);
    this.backoffUntil = 0;
    if (b.ci && b.ci.state === 'unknown') this.record(id, null, b.pushedCommit, now);
    await this.pollCi(id, now);
    await this.pollPr(id, now);
    return { polled: 2 };
  }

  wantsCi(b, now) {
    if (!b.pushedCommit) return false;
    const st = b.ci && b.ci.state;
    if (st === 'success' || st === 'failure' || st === 'unknown') return false;
    if (st === 'none' && now - b.pushedAt > NONE_GIVE_UP_MS) return false;
    return true;
  }
  wantsPr(b) { return !(b.pr && (b.pr.merged || b.pr.state === 'closed')); }

  record(id, ci, sha, now) {
    const cur = this.current(id);
    if (!cur || this.hub.closed || cur.pushedCommit !== sha) return;           // branch gone or re-pushed while we waited
    if (same(stripTime(cur.ci), stripTime(ci))) return;                         // nothing new: keep the log small
    this.hub.tx(() => this.hub.command('hub.task.ci', { taskId: id, ci }, now));
  }

  async pollCi(id, now) {
    const b = this.current(id);
    if (!b || !b.github || !b.pushedCommit) return;
    const s = this.state(id);
    s.nextCi = now + POLL_MS;
    const sha = b.pushedCommit;
    let res;
    try { res = await this.gh(`/repos/${b.github}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`); } catch (e) {
      s.fails++;
      if (s.fails >= MAX_NETWORK_FAILS) this.record(id, { state: 'unknown', reason: `GitHub could not be reached (${String(e && e.message || e).slice(0, 80)})`, updatedAt: now }, sha, now);
      return;
    }
    if (res.status === 403 || res.status === 429) return this.rateLimited(res, now);
    this.backoffStep = 0;
    if (res.status === 200 && res.json) { s.fails = 0; return this.record(id, summariseChecks(res.json, now), sha, now); }
    if (res.status === 404 || res.status === 401 || res.status === 410 || res.status === 422) {
      return this.record(id, { state: 'unknown', reason: 'repository is private or not found (checks are only read from public GitHub repos)', updatedAt: now }, sha, now);
    }
    s.fails++;
    if (s.fails >= MAX_NETWORK_FAILS) this.record(id, { state: 'unknown', reason: `GitHub answered ${res.status}`, updatedAt: now }, sha, now);
  }

  async pollPr(id, now) {
    const b = this.current(id);
    if (!b || !b.github) return;
    const s = this.state(id);
    const linked = !!(b.pr && b.pr.number);
    s.nextPr = now + (linked ? LINKED_POLL_MS : POLL_MS);
    const [owner] = b.github.split('/');
    let res;
    try {
      res = await this.gh(linked
        ? `/repos/${b.github}/pulls/${b.pr.number}`
        : `/repos/${b.github}/pulls?head=${encodeURIComponent(`${owner}:${b.name}`)}&state=all&per_page=5`);
    } catch { return; }
    if (res.status === 403 || res.status === 429) return this.rateLimited(res, now);
    this.backoffStep = 0;
    if (res.status === 404 || res.status === 401 || res.status === 410) { s.prDone = true; return; }
    if (res.status !== 200 || !res.json) return;
    const pr = linked ? res.json : (Array.isArray(res.json) ? res.json[0] : null);
    if (!pr || typeof pr.number !== 'number') return;
    const next = {
      number: pr.number, url: typeof pr.html_url === 'string' ? pr.html_url : (b.pr && b.pr.url) || null,
      state: pr.state === 'closed' ? 'closed' : 'open', merged: !!(pr.merged || pr.merged_at),
    };
    const cur = this.current(id);
    if (!cur || this.hub.closed || same(cur.pr, next)) return;
    this.hub.tx(() => this.hub.command('hub.task.branch', { taskId: id, patch: { pr: next } }, now));
  }
}
