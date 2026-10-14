// officemodel.js — pure model + force layout for the Office "flow" graph. No DOM, so it can be unit-tested.
// buildModel() turns store rows into nodes and edges; Sim keeps their positions (springs, repulsion, gravity, cooling).

/** Finished things without an acknowledge feature on the hub stay this long (a hub that cannot archive must not pile them up). */
export const GRACE_MS = 15 * 60e3;
export const NODE_R = { main: 34, session: 22, builder: 11.5, scout: 8.5, agent: 10, ghost: 15 };

const FINISHED = new Set(['done', 'failed']);
export const isFinishedAgent = (a) => FINISHED.has(a.status);
export const isLiveSession = (s) => s.status === 'active' || s.status === 'idle';
export function roleOf(a) {
  const t = String(a.subagentType || '').split(':').pop();
  return t === 'builder' || t === 'scout' ? t : 'agent';
}

/**
 * Classify a finishable thing: 'live' (always shown), 'finished' (waiting for the owner's OK), 'soft' (finished, shown for a while
 * because the hub cannot acknowledge), 'archived' (acknowledged), 'hidden'.
 */
export function classify({ live, ackedAt, endedAt }, caps, now) {
  if (live) return 'live';
  if (caps.ack) return ackedAt ? 'archived' : 'finished';
  return now - (endedAt || 0) < GRACE_MS ? 'soft' : 'hidden';
}

/** The best live session of a project: busy first, then active, then most recently seen. */
function bestSession(list) {
  return list.slice().sort((a, b) => (b.busy ? 1 : 0) - (a.busy ? 1 : 0) || (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)
    || (b.lastSeenAt || 0) - (a.lastSeenAt || 0) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

/**
 * input: { projects, sessions, agents, links (arrays), caps: { ack }, now, showArchived, scope(projectId) -> bool }
 * Returns { nodes, edges, byKey, main, coordinator, pending: { agents, sessions, links }, archivedCount }.
 */
export function buildModel({ projects = [], sessions = [], agents = [], links = [], caps = {}, now = Date.now(), showArchived = false, scope = () => true }) {
  const coordinator = projects.find((p) => p.coordinator && !p.archived) || null;
  const nodes = [];
  const byKey = new Map();
  const edges = [];
  const pending = { agents: [], sessions: [], links: [] };
  let archivedCount = 0;
  const add = (n) => { nodes.push(n); byKey.set(n.key, n); return n; };
  const pname = (id) => (projects.find((p) => p.id === id) || {}).name || '';

  /* ----- sessions ----- */
  const sessCls = new Map();
  const kept = [];
  const liveKids = new Set(agents.filter((a) => !isFinishedAgent(a)).map((a) => a.sessionId)); // a session with a running subagent never leaves the graph
  for (const s of sessions) {
    let cls = classify({ live: isLiveSession(s), ackedAt: s.acknowledgedAt, endedAt: s.lastSeenAt }, caps, now);
    if (cls === 'hidden' && liveKids.has(s.id)) cls = 'soft';
    const isCoordLive = coordinator && s.projectId === coordinator.id && cls === 'live';
    if (!isCoordLive && !scope(s.projectId)) continue;
    sessCls.set(s.id, cls);
    if (cls === 'archived') archivedCount++;
    if (cls === 'hidden' || (cls === 'archived' && !showArchived && !liveKids.has(s.id))) continue;
    kept.push(s);
  }
  const mainRow = coordinator ? bestSession(kept.filter((s) => s.projectId === coordinator.id && sessCls.get(s.id) === 'live')) : null;
  let main = null;
  if (mainRow) {
    main = add({ key: `s:${mainRow.id}`, kind: 'main', id: mainRow.id, projectId: mainRow.projectId, row: mainRow, cls: 'live', r: NODE_R.main, archived: false, needsOk: false });
  } else if (coordinator) {
    main = add({ key: `g:${coordinator.id}`, kind: 'main', ghost: true, id: null, projectId: coordinator.id, row: null, cls: 'live', r: NODE_R.main, archived: false, needsOk: false });
  }
  const sessionNode = new Map();
  if (mainRow) sessionNode.set(mainRow.id, main);
  for (const s of kept) {
    if (mainRow && s.id === mainRow.id) continue;
    const cls = sessCls.get(s.id);
    const blocked = cls === 'finished' && liveKids.has(s.id) ? 'it still has running subagents' : null; // the hub refuses it too
    const n = add({ key: `s:${s.id}`, kind: 'session', id: s.id, projectId: s.projectId, row: s, cls, r: NODE_R.session, archived: cls === 'archived', needsOk: cls === 'finished' && !blocked, blocked });
    sessionNode.set(s.id, n);
    if (cls === 'finished' && !blocked) pending.sessions.push(n);
    if (main) edges.push({ key: `st:${n.key}`, kind: 'struct', a: main.key, b: n.key });
  }

  /* ----- agents (parents before children) ----- */
  const byId = new Map(agents.map((a) => [a.id, a]));
  const depth = (a) => { let d = 0; const seen = new Set([a.id]); for (let p = byId.get(a.parentId); p && !seen.has(p.id); p = byId.get(p.parentId)) { seen.add(p.id); d++; } return d; };
  const ordered = agents.filter((a) => sessionNode.has(a.sessionId)).map((a) => [a, depth(a)])
    .sort((x, y) => x[1] - y[1] || (x[0].startedAt || 0) - (y[0].startedAt || 0) || String(x[0].id).localeCompare(String(y[0].id)));
  for (const a of agents) {
    const sc = sessCls.get(a.sessionId);
    if (sc === 'archived' && !sessionNode.has(a.sessionId) && isFinishedAgent(a)) archivedCount++; // its session is archived and hidden
  }
  for (const [a] of ordered) {
    const sn = sessionNode.get(a.sessionId);
    let cls = classify({ live: !isFinishedAgent(a), ackedAt: a.acknowledgedAt, endedAt: a.endedAt || a.lastActivityAt || a.startedAt }, caps, now);
    if (sn.cls === 'archived' && cls !== 'live') cls = 'archived'; // a running child stays visible under its dimmed, archived parent
    if (cls === 'archived') archivedCount++;
    if (cls === 'hidden' || (cls === 'archived' && !showArchived)) continue;
    const role = roleOf(a);
    const parent = a.parentId && a.parentId !== a.id && byKeyAgent(a.parentId) || sn;
    const n = add({ key: `a:${a.id}`, kind: 'agent', role, id: a.id, sessionId: a.sessionId, projectId: sn.projectId, row: a, cls, r: NODE_R[role], parentKey: parent.key, archived: cls === 'archived', needsOk: cls === 'finished' });
    if (cls === 'finished') pending.agents.push(n);
    edges.push({ key: `br:${n.key}`, kind: 'branch', a: parent.key, b: n.key });
  }
  function byKeyAgent(id) { return byKey.get(`a:${id}`); }

  /* ----- links ----- */
  const ghost = (projectId) => {
    if (!projectId || !(scope(projectId) || (coordinator && projectId === coordinator.id))) return null;
    return byKey.get(`g:${projectId}`) || add({ key: `g:${projectId}`, kind: 'ghost', ghost: true, id: null, projectId, row: null, cls: 'live', r: NODE_R.ghost, archived: false, needsOk: false });
  };
  const endpoint = (sessionId, projectId) => {
    if (sessionId && sessionNode.has(sessionId)) return sessionNode.get(sessionId);
    if (coordinator && projectId === coordinator.id && main) return main;
    const live = kept.filter((s) => s.projectId === projectId && sessionNode.has(s.id) && sessCls.get(s.id) === 'live');
    const best = bestSession(live) || bestSession(kept.filter((s) => s.projectId === projectId && sessionNode.has(s.id)));
    return best ? sessionNode.get(best.id) : ghost(projectId);
  };
  const pairs = new Map();
  for (const L of links) {
    const cls = L.state === 'answered'
      ? classify({ live: false, ackedAt: L.acknowledgedAt, endedAt: L.answeredAt || L.createdAt }, caps, now)
      : 'live';
    const inScope = scope(L.fromProjectId) || scope(L.toProjectId) || (coordinator && (L.fromProjectId === coordinator.id || L.toProjectId === coordinator.id));
    if (!inScope) continue;
    if (cls === 'archived') archivedCount++;
    if (cls === 'hidden' || (cls === 'archived' && !showArchived)) continue;
    const from = endpoint(L.fromSessionId, L.fromProjectId);
    const to = endpoint(L.toSessionId, L.toProjectId);
    if (!from || !to || from === to) continue;
    const pk = [from.key, to.key].sort().join('|');
    const idx = pairs.get(pk) || 0;
    pairs.set(pk, idx + 1);
    const e = { key: `l:${L.id}`, kind: 'link', a: from.key, b: to.key, link: L, cls, archived: cls === 'archived', needsOk: cls === 'finished', off: 26 + 26 * idx };
    edges.push(e);
    if (cls === 'finished') pending.links.push(e);
  }
  for (const n of nodes) n.label = n.kind === 'agent' ? '' : pname(n.projectId);
  return { nodes, edges, byKey, main, coordinator, pending, archivedCount };
}

/* ---------- force layout ---------- */
const hash = (str) => { let x = 2166136261; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0) / 4294967296; };
export const easeOutBack = (t) => { const c1 = 1.9, c3 = c1 + 1; const u = Math.min(1, Math.max(0, t)) - 1; return 1 + c3 * u * u * u + c1 * u * u; };

export class Sim {
  constructor() {
    this.p = new Map();
    this.edges = [];
    this.alpha = 0;
    this.alphaMin = 0.012;
    this.decay = 0.986;
    this.aspect = 1; // stage width / height: the layout spreads wider on a wide stage
    this.ring = 0; // spokes placed so far, spreads their starting angles
  }

  reheat(a = 0.6) { if (a > this.alpha) this.alpha = a; }

  /** nodes: model nodes (parents first). Returns { added, removed: [{key,x,y}] }. */
  sync(nodes, edges) {
    const added = [];
    const removed = [];
    const seen = new Set();
    for (const n of nodes) {
      seen.add(n.key);
      let p = this.p.get(n.key);
      if (!p) {
        p = { key: n.key, x: 0, y: 0, vx: 0, vy: 0, r: n.r, pin: false, kind: n.kind, parent: n.parentKey || null };
        const par = p.parent && this.p.get(p.parent);
        if (par) { const ang = hash(n.key) * Math.PI * 2; p.x = par.x + Math.cos(ang) * 4; p.y = par.y + Math.sin(ang) * 4; }
        else if (n.kind === 'main') { p.x = 0; p.y = 0; }
        else { const ang = this.ring++ * 2.399963 + hash(n.key); const rad = 200 + (this.ring % 3) * 40; p.x = Math.cos(ang) * rad; p.y = Math.sin(ang) * rad; }
        this.p.set(n.key, p);
        added.push(n.key);
      }
      p.r = n.r; p.kind = n.kind; p.parent = n.parentKey || null;
    }
    for (const [k, p] of this.p) if (!seen.has(k)) { removed.push({ key: k, x: p.x, y: p.y }); this.p.delete(k); }
    this.edges = [];
    for (const e of edges) {
      const a = this.p.get(e.a), b = this.p.get(e.b);
      if (a && b) this.edges.push({ a, b, kind: e.kind });
    }
    if (added.length) this.reheat(0.7);
    else if (removed.length) this.reheat(0.25);
    return { added, removed };
  }

  get active() { return this.alpha >= this.alphaMin; }

  tick() {
    if (!this.active) return false;
    const a = this.alpha;
    const P = Array.from(this.p.values());
    const n = P.length;
    const repel = (pi, pj) => {
      let dx = pj.x - pi.x, dy = pj.y - pi.y;
      let d2 = dx * dx + dy * dy;
      if (d2 > 250000) return;
      if (d2 < 0.01) { dx = hash(pi.key + pj.key) - 0.5; dy = hash(pj.key + pi.key) - 0.5; d2 = dx * dx + dy * dy + 0.01; }
      const d = Math.sqrt(d2);
      const min = pi.r + pj.r + 12;
      let f = 4200 * (pi.r / 10) * (pj.r / 10) / Math.max(d2, min * min);
      if (d < min) f += (min - d) * 0.35;
      const fx = dx / d * f, fy = dy / d * f;
      pi.vx -= fx * a; pi.vy -= fy * a;
      pj.vx += fx * a; pj.vy += fy * a;
    };
    if (n <= 80) {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) repel(P[i], P[j]);
    } else { // bucket into 500px cells (the repulsion cut-off): each pair is only looked at from one side
      const cells = new Map();
      for (const p of P) { const k = `${Math.floor(p.x / 500)},${Math.floor(p.y / 500)}`; (cells.get(k) || cells.set(k, []).get(k)).push(p); }
      for (const [k, list] of cells) {
        const [cx, cy] = k.split(',').map(Number);
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) repel(list[i], list[j]);
        for (const [ox, oy] of [[1, -1], [1, 0], [1, 1], [0, 1]]) {
          const other = cells.get(`${cx + ox},${cy + oy}`);
          if (other) for (const p of list) for (const q of other) repel(p, q);
        }
      }
    }
    for (const e of this.edges) {
      const { a: p, b: q } = e;
      const dx = q.x - p.x, dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      let rest, k;
      if (e.kind === 'struct') { rest = 250 + p.r + q.r; k = 0.05; }
      else if (e.kind === 'branch') { rest = p.r + q.r + 62; k = 0.12; }
      else { rest = 300; k = 0.004; }
      const f = (d - rest) * k;
      const fx = dx / d * f, fy = dy / d * f;
      p.vx += fx * a; p.vy += fy * a;
      q.vx -= fx * a; q.vy -= fy * a;
      if (e.kind === 'branch') { // fan branches outward, away from where their parent hangs
        const ref = (p.parent && this.p.get(p.parent)) || { x: 0, y: 0 };
        const ox = p.x - ref.x, oy = p.y - ref.y, od = Math.hypot(ox, oy) || 1;
        q.vx += ox / od * 1.6 * a; q.vy += oy / od * 1.6 * a;
      }
    }
    for (const p of P) {
      const g = p.kind === 'main' ? 0.9 : 0.012;
      p.vx -= p.x * g * a / Math.pow(this.aspect, 1.4); p.vy -= p.y * g * a * this.aspect;
      if (p.pin) { p.vx = 0; p.vy = 0; continue; }
      p.vx = Math.max(-24, Math.min(24, p.vx * 0.7)); p.vy = Math.max(-24, Math.min(24, p.vy * 0.7));
      p.x += p.vx; p.y += p.vy;
    }
    this.alpha *= this.decay;
    return true;
  }

  /** Run to rest without animating (reduced motion, tests). */
  settle(max = 300) { let i = 0; while (this.active && i++ < max) this.tick(); return i; }

  bounds(pad = 0) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of this.p.values()) { x0 = Math.min(x0, p.x - p.r); y0 = Math.min(y0, p.y - p.r); x1 = Math.max(x1, p.x + p.r); y1 = Math.max(y1, p.y + p.r); }
    if (x0 === Infinity) return null;
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  }
}

/** View transform that fits `b` inside a w x h stage. */
export function fitTransform(b, w, h, { pad = 80, maxK = 1.3, minK = 0.12 } = {}) {
  if (!b || w <= 0 || h <= 0) return { x: w / 2, y: h / 2, k: 1 };
  const bw = Math.max(1, b.x1 - b.x0) + pad * 2, bh = Math.max(1, b.y1 - b.y0) + pad * 2;
  const k = Math.max(minK, Math.min(maxK, w / bw, h / bh));
  return { k, x: w / 2 - ((b.x0 + b.x1) / 2) * k, y: h / 2 - ((b.y0 + b.y1) / 2) * k };
}

/** Point on the quadratic curve a -> c -> b at t. */
export function quadAt(a, c, b, t) {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}
/** Control point for a link edge: the same side of the pair's canonical line whichever way the link points. */
export function linkControl(keyA, A, keyB, B, off) {
  const [lo, hi] = keyA < keyB ? [A, B] : [B, A];
  const dx = hi.x - lo.x, dy = hi.y - lo.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return { x: (A.x + B.x) / 2 - (dy / len) * off, y: (A.y + B.y) / 2 + (dx / len) * off };
}
