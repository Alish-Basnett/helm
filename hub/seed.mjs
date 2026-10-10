// Demo data for UI work: `node hub/helmd.mjs --seed` (+ `--demo-live` for a running stream).
// Everything goes through hub.ingest() (mod events) and the hub command methods, never raw SQL inserts,
// so seeding also exercises the projections. A virtual clock lets history be spread over the last ~3 hours.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { localDate } from './hub.mjs';

const MIN = 60_000;
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']; // tools whose calls announce `files` (conflict radar)

/** A valid w x h RGB PNG with a diagonal gradient (built by hand so the seed needs no binary asset). */
export function tinyPng(w = 48, h = 32) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1); // filter byte 0
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = 40 + Math.round((x / w) * 120);
      raw[o + 2 + x * 3] = 90 + Math.round((y / h) * 100);
      raw[o + 3 + x * 3] = 200;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SESS_A = 'demo-meridian-auth';   // busy
const SESS_B = 'demo-orbit-charts';    // idle
const SESS_C = 'demo-meridian-ci';     // ended

export function seed(hub, log) {
  if (hub.db.get("SELECT value FROM meta WHERE key = 'seeded'")) return { skipped: true };

  const rnd = mulberry32(20261010);
  const NOW = Date.now();
  let clock = NOW - 180 * MIN;
  hub.setClock(() => clock);
  const prevSnap = hub.autoSnapshot;
  hub.autoSnapshot = false; // no async diff snapshots while seeding; helmd snapshots the git demo task afterwards

  const seqs = {};
  const emit = (sid, type, data, at = clock) => {
    seqs[sid] = (seqs[sid] || 0) + 1;
    const r = hub.ingest([{ sessionId: sid, seq: seqs[sid], type, at, data }]);
    if (r.accepted !== 1) throw new Error(`seed event rejected: ${type}`);
  };

  const actions = []; // { t, fn } executed in time order
  const atMin = (minAgo, fn) => actions.push({ t: NOW - minAgo * MIN, fn });
  const atMs = (t, fn) => actions.push({ t, fn });
  const ids = {};     // symbolic name -> task/note id
  const val = (v) => (typeof v === 'function' ? v() : v);

  // ------------------------------------------------------------- sessions & projects
  atMin(176, () => emit(SESS_A, 'session.started', { cwd: '/Users/dev/code/meridian-api', title: 'Auth hardening', model: 'opus' }));
  atMin(175, () => { ids.P1 = hub.p.getSession(SESS_A).project_id; hub.updateProject(ids.P1, { name: 'Meridian API' }, clock); });
  atMin(174, () => emit(SESS_B, 'session.started', { cwd: '/Users/dev/code/orbit-dashboard', title: 'Chart rework', model: 'sonnet' }));
  atMin(173, () => { ids.P2 = hub.p.getSession(SESS_B).project_id; hub.updateProject(ids.P2, { name: 'Orbit Dashboard' }, clock); });
  atMin(120, () => emit(SESS_C, 'session.started', { cwd: '/Users/dev/code/meridian-api', title: 'Fix flaky CI', model: 'sonnet' }));
  // the CI session first lands in its own auto-created project; joining moves it (and drops the empty shell)
  atMin(119, () => hub.joinSession(SESS_C, { projectId: ids.P1 }, clock));

  // ----------------------------------------------------------------------- tasks
  const mk = (key, project, title, description, status, extra = {}) =>
    atMin(extra.min ?? 172, () => {
      const dependsOn = (extra.dependsOn || []).map((k) => ids[k]);
      ids[key] = hub.createTask({ projectId: ids[project], title, description, status, dependsOn }, clock).task.id;
    });
  mk('jwt', 'P1', 'Add JWT refresh rotation',
    'Rotate refresh tokens on every use and revoke the whole family if a rotated token is replayed. Keep access tokens at 15 min.', 'next', { min: 171 });
  mk('limiter', 'P1', 'Implement sliding-window rate limiter',
    'Replace the fixed-window counter with a Redis sorted-set sliding window. Per-IP and per-token limits, 429 with Retry-After.', 'next', { min: 171 });
  mk('audit', 'P1', 'Audit auth middleware for token leaks',
    'Grep logs and error handlers for places where bearer tokens or refresh tokens could be written out.', 'backlog', { min: 170 });
  mk('uuid', 'P1', 'Migrate sessions table to UUIDv7',
    'Switch sessions.id from serial to UUIDv7 so ids are sortable and safe to expose. Needs a reversible migration.', 'next', { min: 170 });
  mk('openapi', 'P1', 'Add OpenAPI schema for /v1/tokens',
    'Document issue, refresh and revoke endpoints including error bodies. Blocked on the refresh rotation shape.', 'backlog', { min: 169, dependsOn: ['jwt'] });
  mk('jwks', 'P1', 'Rotate signing keys with a JWKS endpoint',
    'Publish /.well-known/jwks.json, support two active keys during rotation, and cache with a 10 minute max-age.', 'next', { min: 169, dependsOn: ['jwt', 'limiter'] });
  mk('reqid', 'P1', 'Add request-id logging middleware',
    'Generate or propagate X-Request-Id, attach it to every log line and error response.', 'next', { min: 168 });
  mk('rls', 'P1', 'Evaluate switching to Postgres RLS',
    'Spike: could row-level security replace our tenant_id checks in the repository layer? Write up trade-offs only.', 'later', { min: 168 });
  mk('v0', 'P1', 'Remove deprecated /v0 login route',
    'Traffic dropped to zero in March. Delete the route, the tests and the docs page.', 'archived', { min: 167 });
  mk('authdocs', 'P1', 'Document auth flows in docs/auth.md',
    'Sequence diagrams for login, refresh and revoke. Link from the README.', 'backlog', { min: 167 });
  mk('sparkline', 'P2', 'Rewrite sparkline component with canvas',
    'SVG sparklines choke past 2k points. Render to canvas with devicePixelRatio awareness and keep the same props.', 'next', { min: 166 });
  mk('inventory', 'P2', 'Inventory chart components and props',
    'List every chart component, its props and where it is used so we can plan the consolidation.', 'backlog', { min: 166 });
  mk('tooltip', 'P2', 'Add keyboard tooltips for chart points (a11y)',
    'Chart points are mouse-only today. Arrow keys should move between points and announce the value.', 'next', { min: 165 });
  mk('heatmap', 'P2', 'Dark-mode palette for heatmap',
    'Current ramp loses contrast on dark backgrounds. Pick a perceptually uniform ramp and test with colour-blind simulation.', 'next', { min: 165 });
  mk('virt', 'P2', 'Virtualize the events table',
    'Table renders every row. Window it to the visible range and keep keyboard navigation working.', 'backlog', { min: 164 });
  mk('csv', 'P2', 'Add CSV export to usage chart',
    'Export the series currently on screen, respecting the selected date range.', 'later', { min: 164 });
  // v0.6: a planning task whose agent proposed six screens; the card shows them as a tick-to-run checklist.
  mk('plan', 'P2', 'Plan the new dashboard screens',
    'Propose the extra screens Orbit needs. Tick the ones you want and Helm creates and starts a task for each.', 'next', { min: 163 });
  atMin(162, () => emit(SESS_B, 'task.choices', { taskId: ids.plan, choices: [
    { id: 'overview', title: 'Overview screen with the five headline KPIs', detail: 'One glanceable page: active users, error rate, p95 latency, spend and uptime, each with a sparkline and a delta against last week.', effort: 'M', value: 'high' },
    { id: 'alerts', title: 'Alerts inbox', detail: 'List fired alerts with severity, snooze and acknowledge. Links through to the chart that triggered it.', effort: 'M', value: 'high' },
    { id: 'compare', title: 'Compare two date ranges side by side', detail: 'Pick range A and B and overlay the series with a shared axis.', effort: 'L', value: 'medium' },
    { id: 'share', title: 'Shareable read-only dashboard links', detail: 'Signed URLs with an expiry that render a frozen snapshot of the current view.', effort: 'S', value: 'medium' },
    { id: 'empty', title: 'Empty and first-run states', detail: 'Friendly zero-data screens that explain how to connect a source.', effort: 'S', value: 'low' },
    { id: 'settings', title: 'Workspace settings page', detail: 'Members, API keys and billing in one tabbed screen.', effort: 'L', value: 'low' },
  ] }));

  // -------------------------------------------------------------------- main-session activity
  const mainTool = (sid, minAgo, tool, called, finished, ok = true) => {
    atMin(minAgo, () => emit(sid, 'tool.called', { toolUseId: `toolu_m${Math.floor(rnd() * 1e6)}`, tool, summary: called }));
    atMin(minAgo - 0.1, () => emit(sid, 'tool.finished', { toolUseId: 'x', tool, ok, summary: finished }));
  };
  atMin(172, () => emit(SESS_A, 'turn.started', {}));
  mainTool(SESS_A, 171.5, 'Read', 'Read CLAUDE.md', 'Read 64 lines');
  mainTool(SESS_A, 171.0, 'Bash', 'Bash: git status --short', 'exit 0');
  mainTool(SESS_A, 170.5, 'Grep', 'Grep: TODO(auth) in src/', '9 matches in 5 files');
  atMin(168, () => emit(SESS_A, 'turn.completed', { ok: true }));
  atMin(162, () => emit(SESS_A, 'turn.started', {}));
  atMin(150, () => emit(SESS_A, 'turn.completed', { ok: true }));
  atMin(141, () => emit(SESS_A, 'turn.started', {}));
  mainTool(SESS_A, 112, 'Read', 'Read db/migrations/0042_sessions.sql', 'Read 37 lines');
  atMin(110, () => emit(SESS_A, 'turn.completed', { ok: true }));
  atMin(61, () => emit(SESS_A, 'turn.started', {}));
  mainTool(SESS_A, 60, 'Bash', 'Bash: git diff --stat', '4 files changed, 173 insertions(+), 18 deletions(-)');
  mainTool(SESS_A, 38, 'Edit', 'Edit docs/auth.md', 'Edited docs/auth.md (+22 -0)');
  atMin(36, () => emit(SESS_A, 'turn.completed', { ok: true }));
  atMin(2.4, () => emit(SESS_A, 'turn.started', {}));
  mainTool(SESS_A, 1.0, 'Bash', 'Bash: git diff --stat', '6 files changed, 301 insertions(+), 24 deletions(-)');
  mainTool(SESS_B, 160, 'Read', 'Read package.json', 'Read 58 lines');
  mainTool(SESS_B, 158, 'Glob', 'Glob: src/components/charts/**', '23 files');
  mainTool(SESS_C, 118, 'Bash', 'Bash: gh run list --limit 5', '5 runs, 2 failed');

  // heartbeats: tokens and cost climb over the session
  const beats = [
    [SESS_A, 170, 21000, 0.42], [SESS_A, 140, 88000, 1.35], [SESS_A, 110, 151000, 2.60], [SESS_A, 80, 214000, 3.71],
    [SESS_A, 50, 280000, 4.62], [SESS_A, 25, 341000, 5.48], [SESS_A, 10, 389000, 6.21], [SESS_A, 0.3, 412000, 6.80],
    [SESS_B, 165, 18000, 0.55], [SESS_B, 130, 64000, 1.42], [SESS_B, 90, 122000, 2.37], [SESS_B, 45, 171000, 2.96],
    [SESS_B, 20, 196000, 3.15], [SESS_B, 6, 203000, 3.15],
    [SESS_C, 115, 9000, 0.18], [SESS_C, 85, 31000, 0.31], [SESS_C, 52, 47000, 0.42],
  ];
  for (const [sid, m, tokens, costUsd] of beats) atMin(m, () => emit(sid, 'session.heartbeat', { tokens, costUsd }));

  // ------------------------------------------------------------------------- agents
  /**
   * steps: [tool, calledSummary, finishedSummary, files?, ok?]. `endMin` = minutes ago of the last event.
   * end: 'ok' | 'fail' | null (still running / abandoned). agentId null = never bound (pending).
   */
  function agentRun(o) {
    const pace = o.paceSec || 38;
    const rel = [];
    let t = 0;
    rel.push([0, 'spawn']);
    if (o.agentId) rel.push([4, 'bind']);
    t = 10;
    o.steps.forEach((s, i) => {
      rel.push([t, 'call', i]);
      if (!(o.openLast && i === o.steps.length - 1)) rel.push([t + 11 + Math.floor(rnd() * 8), 'fin', i]);
      t += pace + Math.floor(rnd() * 25);
    });
    const lastRel = rel[rel.length - 1][0];
    let done = null;
    if (o.end) { done = lastRel + 14; rel.push([done, 'done']); if (o.recap) rel.push([done + 22, 'recap']); }
    const lastEvent = rel[rel.length - 1][0];
    const base = NOW - o.endMin * MIN - lastEvent * 1000; // absolute time of rel 0
    const id = () => o.agentId || `pending:${o.toolUseId}`;
    for (const [r, kind, i] of rel) {
      const when = base + r * 1000;
      atMs(when, () => {
        if (kind === 'spawn') {
          const data = {
            toolUseId: o.toolUseId, subagentType: o.type, model: o.model, description: val(o.desc),
            prompt: o.prompt,
          };
          if (o.taskKey) data.taskId = ids[o.taskKey];
          emit(o.sid, 'agent.spawned', data);
        } else if (kind === 'bind') {
          emit(o.sid, 'agent.bound', { toolUseId: o.toolUseId, agentId: o.agentId });
        } else if (kind === 'call') {
          const s = o.steps[i];
          const d = { agentId: id(), toolUseId: `${o.toolUseId}_${i}`, tool: s[0], summary: s[1] };
          if (s[3] && EDIT_TOOLS.includes(s[0])) d.files = s[3]; // the mod announces edits before they happen
          emit(o.sid, 'tool.called', d);
        } else if (kind === 'fin') {
          const s = o.steps[i];
          const d = { agentId: id(), toolUseId: `${o.toolUseId}_${i}`, tool: s[0], ok: s[4] !== false, summary: s[2] };
          if (s[3]) d.files = s[3];
          emit(o.sid, 'tool.finished', d);
        } else if (kind === 'done') {
          emit(o.sid, 'agent.completed', {
            agentId: id(), ok: o.end === 'ok', summary: o.summary, tokens: o.tokens,
          });
        } else if (kind === 'recap') {
          const tid = hub.db.get('SELECT task_id FROM agents WHERE tool_use_id = ?', o.toolUseId).task_id;
          emit(o.sid, 'recap.generated', { taskId: tid, ...o.recap });
        }
      });
    }
  }

  agentRun({
    sid: SESS_A, toolUseId: 'toolu_01Hk3aJwt', agentId: 'ag_a1f3c9d2e4', type: 'helm:builder', model: 'sonnet',
    desc: () => `Implement JWT refresh rotation [helm:${ids.jwt}]`, endMin: 150, end: 'ok', tokens: 84210,
    prompt: 'Implement refresh token rotation in src/auth. Rotate on every use, revoke the family on replay, add tests.',
    steps: [
      ['Read', 'Read src/auth/tokens.ts', 'Read 212 lines'],
      ['Grep', 'Grep: refreshToken in src/', '14 matches in 6 files'],
      ['Read', 'Read src/auth/session.ts', 'Read 148 lines'],
      ['Write', 'Write src/auth/refresh.ts', 'Created src/auth/refresh.ts (96 lines)', ['src/auth/refresh.ts']],
      ['Edit', 'Edit src/auth/tokens.ts', 'Edited src/auth/tokens.ts (+31 -9)', ['src/auth/tokens.ts']],
      ['Write', 'Write test/auth/refresh.test.ts', 'Created test/auth/refresh.test.ts (142 lines)', ['test/auth/refresh.test.ts']],
      ['Bash', 'Bash: npm test -- auth/refresh', 'exit 1: 2 failed, 9 passed', null, false],
      ['Edit', 'Edit src/auth/refresh.ts', 'Edited src/auth/refresh.ts (+7 -3)', ['src/auth/refresh.ts']],
      ['Bash', 'Bash: npm test -- auth', 'exit 0: 31 passed'],
    ],
    summary: 'Refresh tokens now rotate on every use. Replaying a rotated token revokes the whole token family. 31 auth tests pass.',
    recap: {
      what: 'Refresh tokens now rotate on every use, and replaying an already-rotated token revokes the entire token family.',
      how: 'Added src/auth/refresh.ts with a family_id column check, rotated inside one DB transaction, and wired it into tokens.ts. Tests cover happy path, replay and concurrent refresh.',
      learned: 'Two concurrent refreshes from the same client look exactly like a replay attack unless you allow a short grace window; we allow 10 seconds for the immediately previous token.',
      concepts: ['auth', 'jwt', 'token-rotation', 'transactions'],
    },
  });

  agentRun({
    sid: SESS_A, toolUseId: 'toolu_01Ab9Audit', agentId: 'ag_b7d1e0a355', type: 'helm:scout', model: 'haiku',
    desc: () => `Audit auth middleware for token leaks [helm:${ids.audit}]`, endMin: 138, end: 'ok', tokens: 18940,
    prompt: 'Find every place a bearer token or refresh token could be logged or returned in an error body.',
    steps: [
      ['Read', 'Read src/middleware/auth.ts', 'Read 131 lines'],
      ['Grep', 'Grep: console.log in src/middleware', '6 matches in 3 files'],
      ['Grep', 'Grep: Authorization in src/', '11 matches in 5 files'],
      ['Read', 'Read src/ws/handshake.ts', 'Read 87 lines'],
    ],
    summary: 'Found 2 places where bearer tokens are logged at debug level (auth.ts:58, ws/handshake.ts:41). No other leaks.',
    recap: {
      what: 'Audited the auth middleware and websocket handshake for token exposure and found two debug logs that print bearer tokens.',
      how: 'Grepped for logging calls and Authorization header reads, then read each hit in context to separate real leaks from redacted logging.',
      learned: 'Our logger redacts keys named "token" but not values in a header map, so logging req.headers leaks the Authorization value.',
      concepts: ['auth', 'middleware', 'security', 'logging'],
    },
  });
  atMin(131, () => hub.updateTask(ids.audit, { status: 'done' }, clock));

  agentRun({
    sid: SESS_A, toolUseId: 'toolu_01Cd4Uuid', agentId: 'ag_c2e8f41a07', type: 'helm:builder', model: 'sonnet',
    desc: () => `Migrate sessions table to UUIDv7 [helm:${ids.uuid}]`, endMin: 108, end: 'fail', tokens: 51320,
    prompt: 'Write a reversible migration that changes sessions.id to UUIDv7 and updates every referencing table.',
    steps: [
      ['Read', 'Read db/migrations/0042_sessions.sql', 'Read 37 lines'],
      ['Read', 'Read src/db/schema.ts', 'Read 205 lines'],
      ['Write', 'Write db/migrations/0043_sessions_uuidv7.sql', 'Created db/migrations/0043_sessions_uuidv7.sql (58 lines)', ['db/migrations/0043_sessions_uuidv7.sql']],
      ['Bash', 'Bash: npm run db:migrate:dry', 'exit 1: foreign key violation', null, false],
      ['Bash', 'Bash: npm run db:migrate:dry -- --verbose', 'exit 1: audit_log.session_id integer vs uuid', null, false],
    ],
    summary: 'Dry-run failed: audit_log.session_id is an integer FK to sessions(id) and cannot be cast to uuid. Needs a backfill plan first.',
  });

  agentRun({
    sid: SESS_C, toolUseId: 'toolu_01Ef7Flaky', agentId: 'ag_d4a6b9c831', type: 'helm:builder', model: 'sonnet',
    desc: 'Fix flaky webhook retry integration test', endMin: 74, end: 'ok', tokens: 39770,
    prompt: 'test/integration/webhooks.test.ts fails about one run in five on CI. Find the race and fix it.',
    steps: [
      ['Read', 'Read test/integration/webhooks.test.ts', 'Read 176 lines'],
      ['Bash', 'Bash: npm test -- webhooks --repeat 20', 'exit 1: 4 of 20 failed', null, false],
      ['Read', 'Read src/webhooks/retry.ts', 'Read 94 lines'],
      ['Edit', 'Edit test/integration/webhooks.test.ts', 'Edited test/integration/webhooks.test.ts (+14 -9)', ['test/integration/webhooks.test.ts']],
      ['Bash', 'Bash: npm test -- webhooks --repeat 50', 'exit 0: 50 of 50 passed'],
    ],
    summary: 'Flake was a race between the retry backoff timer and fake timers. The test now advances timers deterministically. 50/50 passes.',
    recap: {
      what: 'Fixed the flaky webhook retry integration test by removing a race between backoff timers and the fake clock.',
      how: 'Reproduced with --repeat 20, traced the failures to an un-awaited setTimeout in retry.ts, and made the test advance fake timers inside an awaited helper.',
      learned: 'Jest fake timers do not flush promises; after advancing timers you also need to await a microtask turn before asserting.',
      concepts: ['testing', 'flaky-tests', 'webhooks', 'async'],
    },
  });
  atMin(66, () => {
    const tid = hub.db.get("SELECT task_id FROM agents WHERE tool_use_id = 'toolu_01Ef7Flaky'").task_id;
    ids.flaky = tid;
    hub.updateTask(tid, { status: 'done' }, clock);
  });

  agentRun({
    sid: SESS_C, toolUseId: 'toolu_01Gh2Node', agentId: 'ag_e5b7c0d942', type: 'helm:builder', model: 'sonnet',
    desc: 'Bump Node to 24 in the CI image', endMin: 51.5, end: null, openLast: true, paceSec: 20,
    prompt: 'Update Dockerfile.ci and the workflow matrix to Node 24.',
    steps: [
      ['Read', 'Read .github/workflows/ci.yml', 'Read 88 lines'],
      ['Edit', 'Edit Dockerfile.ci', 'Edited Dockerfile.ci (+1 -1)', ['Dockerfile.ci']],
      ['Bash', 'Bash: docker build -f Dockerfile.ci .', ''],
    ],
  });
  atMin(50, () => emit(SESS_C, 'session.ended', { reason: 'user closed the terminal' }));

  agentRun({
    sid: SESS_B, toolUseId: 'toolu_01Ij5Inv', agentId: 'ag_e91f20bb64', type: 'helm:scout', model: 'haiku',
    desc: () => `Inventory chart components and props [helm:${ids.inventory}]`, endMin: 150, end: 'ok', tokens: 14210,
    prompt: 'List all chart components under src/components/charts with props and call sites.',
    steps: [
      ['Glob', 'Glob: src/components/charts/**', '23 files'],
      ['Read', 'Read src/components/charts/index.ts', 'Read 31 lines'],
      ['Grep', 'Grep: <Sparkline in src/', '17 matches in 9 files'],
    ],
    summary: 'Found 9 chart components; Sparkline, Heatmap and LineChart account for 80% of usage. Prop overlap is high (width, height, series, theme).',
    recap: {
      what: 'Catalogued the 9 chart components, their props and call sites to prepare a consolidation plan.',
      how: 'Globbed the charts directory, read the barrel file, then grepped call sites to count real usage per component.',
      learned: 'Three components share an identical series/theme/size prop shape, so a single ChartBase with a render prop can replace most of the duplication.',
      concepts: ['react', 'charts', 'components', 'refactoring'],
    },
  });
  atMin(141, () => hub.updateTask(ids.inventory, { status: 'done' }, clock));

  agentRun({
    sid: SESS_B, toolUseId: 'toolu_01Kl8Tip', agentId: 'ag_f03b7712d9', type: 'helm:builder', model: 'sonnet',
    desc: () => `Add keyboard tooltips for chart points [helm:${ids.tooltip}]`, endMin: 92, end: 'ok', tokens: 62880,
    prompt: 'Make chart points focusable. Arrow keys move between points, Escape closes, value is announced via aria-live.',
    steps: [
      ['Read', 'Read src/components/charts/Tooltip.tsx', 'Read 118 lines'],
      ['Edit', 'Edit src/components/charts/Tooltip.tsx', 'Edited Tooltip.tsx (+44 -12)', ['src/components/charts/Tooltip.tsx']],
      ['Edit', 'Edit src/components/charts/ChartPoint.tsx', 'Edited ChartPoint.tsx (+19 -3)', ['src/components/charts/ChartPoint.tsx']],
      ['Write', 'Write src/components/charts/tooltip.a11y.test.tsx', 'Created tooltip.a11y.test.tsx (96 lines)', ['src/components/charts/tooltip.a11y.test.tsx']],
      ['Bash', 'Bash: npm test -- tooltip', 'exit 0: 12 passed'],
    ],
    summary: 'Chart points are keyboard reachable with roving tabindex; arrow keys move, Escape closes, values are announced politely. 12 tests pass.',
    recap: {
      what: 'Chart points are now keyboard-accessible: arrow keys move between points, Escape dismisses the tooltip, and the value is announced to screen readers.',
      how: 'Used a roving tabindex across ChartPoint elements, moved tooltip state into a small reducer, and added an aria-live="polite" region updated on focus.',
      learned: 'aria-live regions must exist in the DOM before their text changes, otherwise the first announcement is dropped.',
      concepts: ['a11y', 'aria', 'keyboard', 'react'],
    },
  });

  agentRun({
    sid: SESS_B, toolUseId: 'toolu_01Mn3Spark', agentId: 'ag_0a58c3e1f7', type: 'helm:builder', model: 'sonnet',
    desc: () => `Rewrite sparkline component with canvas [helm:${ids.sparkline}]`, endMin: 13, end: null, openLast: true,
    prompt: 'Rewrite Sparkline to render with canvas. Same props, handle devicePixelRatio, keep the SVG fallback for SSR.',
    steps: [
      ['Read', 'Read src/components/charts/Sparkline.tsx', 'Read 96 lines'],
      ['Grep', 'Grep: devicePixelRatio in src/', '3 matches in 2 files'],
      ['Write', 'Write src/components/charts/SparklineCanvas.tsx', 'Created SparklineCanvas.tsx (121 lines)', ['src/components/charts/SparklineCanvas.tsx']],
      ['Bash', 'Bash: npm run storybook:build', ''],
    ],
  });

  agentRun({
    sid: SESS_A, toolUseId: 'toolu_01Op6Survey', agentId: 'ag_5c9d2e7b10', type: 'helm:scout', model: 'haiku',
    desc: 'Survey rate-limit usage across routes', endMin: 1.4, end: null, paceSec: 55,
    prompt: 'List every route that already has some rate limiting and which library or helper it uses.',
    steps: [
      ['Glob', 'Glob: src/routes/**/*.ts', '31 files'],
      ['Grep', 'Grep: rateLimit in src/routes', '7 matches in 4 files'],
      ['Read', 'Read src/routes/upload.ts', 'Read 142 lines'],
      ['Read', 'Read src/routes/export.ts', 'Read 77 lines'],
      ['Grep', 'Grep: express-rate-limit in package.json', '1 match'],
    ],
  });

  // the newest agent was spawned a moment ago and is still unbound ("pending:...")
  agentRun({
    sid: SESS_A, toolUseId: 'toolu_01Qm7rLimit', agentId: null, type: 'helm:builder', model: 'sonnet',
    taskKey: 'limiter', desc: () => `Implement sliding-window rate limiter [helm:${ids.limiter}]`,
    endMin: 0.5, end: null, paceSec: 40,
    prompt: 'Replace the fixed-window limiter with a Redis sorted-set sliding window. Per-IP and per-token limits.',
    steps: [
      ['Read', 'Read src/middleware/rateLimit.ts', 'Read 64 lines'],
      ['Read', 'Read src/lib/redis.ts', 'Read 41 lines'],
      ['Write', 'Write src/middleware/slidingWindow.ts', 'Created slidingWindow.ts (88 lines)', ['src/middleware/slidingWindow.ts']],
      ['Edit', 'Edit src/middleware/index.ts', 'Edited index.ts (+3 -1)', ['src/middleware/index.ts']],
    ],
  });

  // ------------------------------------------------- v0.2 extras: conflicts, questions, jobs, digests
  // Conflict 1: the request-id agent and the (still unbound) limiter agent both edit src/middleware/index.ts.
  // The request-id agent then goes quiet, waiting on the user: it never stalls, however long it waits.
  agentRun({
    sid: SESS_A, toolUseId: 'toolu_01Rs4ReqId', agentId: 'ag_7e3a915bc2', type: 'helm:builder', model: 'sonnet',
    desc: () => `Add request-id logging middleware [helm:${ids.reqid}]`, endMin: 5, end: null, paceSec: 30,
    prompt: 'Generate or propagate X-Request-Id, attach it to every log line and error response.',
    steps: [
      ['Read', 'Read src/middleware/index.ts', 'Read 52 lines'],
      ['Read', 'Read src/lib/logger.ts', 'Read 73 lines'],
      ['Write', 'Write src/middleware/requestId.ts', 'Created requestId.ts (41 lines)', ['src/middleware/requestId.ts']],
      ['Edit', 'Edit src/middleware/index.ts', 'Edited index.ts (+2 -0)', ['src/middleware/index.ts']],
    ],
  });
  // Conflict 2: the heatmap palette agent (finished 4 min ago, still inside the 10 min window) touched
  // SparklineCanvas.tsx, which the stalled sparkline agent is also working on.
  agentRun({
    sid: SESS_B, toolUseId: 'toolu_01Uv9Heat', agentId: 'ag_2b6f94d0ac', type: 'helm:builder', model: 'sonnet',
    desc: () => `Dark-mode palette for heatmap [helm:${ids.heatmap}]`, endMin: 4, end: 'ok', tokens: 41230,
    prompt: 'Replace the heatmap colour ramp with a perceptually uniform one that keeps contrast on dark backgrounds.',
    steps: [
      ['Read', 'Read src/components/charts/Heatmap.tsx', 'Read 133 lines'],
      ['Write', 'Write src/components/charts/palette.ts', 'Created palette.ts (58 lines)', ['src/components/charts/palette.ts']],
      ['Edit', 'Edit src/components/charts/Heatmap.tsx', 'Edited Heatmap.tsx (+17 -8)', ['src/components/charts/Heatmap.tsx']],
      ['Edit', 'Edit src/components/charts/SparklineCanvas.tsx', 'Edited SparklineCanvas.tsx (+6 -2)', ['src/components/charts/SparklineCanvas.tsx']],
      ['Bash', 'Bash: npm test -- heatmap', 'exit 0: 9 passed'],
    ],
    summary: 'Heatmap now uses a viridis-derived ramp with a dark-mode variant. Contrast passes AA for every step; 9 tests pass.',
    recap: {
      what: 'The heatmap has a dark-mode palette: a viridis-derived ramp whose steps keep AA contrast on dark backgrounds.',
      how: 'Generated the ramp in OKLCH so lightness is evenly spaced, exported it from a new palette.ts, and switched Heatmap and the canvas sparkline over to it.',
      learned: 'Interpolating in sRGB makes the middle of a ramp look muddy; interpolating in OKLCH keeps perceived brightness even from end to end.',
      concepts: ['color', 'a11y', 'charts', 'oklch'],
    },
  });

  // Questions: an answered one from the Chart rework session, an open one from the survey scout, and the
  // request-id agent reported as `waiting` by the session's reconcile (it lists every live agent, as the mod does).
  atMin(100, () => emit(SESS_B, 'tool.called', {
    toolUseId: 'toolu_ask_scales', tool: 'AskUserQuestion',
    summary: 'Use d3-scale for the sparkline canvas, or hand-roll linear scales to keep the bundle small?',
  }));
  atMin(99, () => emit(SESS_B, 'tool.finished', {
    toolUseId: 'toolu_ask_scales', tool: 'AskUserQuestion', ok: true, summary: 'User chose: hand-roll linear scales',
  }));
  atMin(4.4, () => emit(SESS_A, 'reconcile', { agents: [
    { agentId: 'ag_5c9d2e7b10', status: 'running' }, { agentId: 'ag_7e3a915bc2', status: 'waiting' },
  ] }));
  atMin(2, () => emit(SESS_A, 'tool.called', {
    agentId: 'ag_5c9d2e7b10', toolUseId: 'toolu_ask_export', tool: 'AskUserQuestion',
    summary: 'Should the survey also cover the hand-rolled counter in src/routes/export.ts, or only express-rate-limit usages?',
  }));

  // Jobs: an explainer for the JWT task, and two digests. Each runs through the real hub paths:
  // the hub picks the session and builds the input, the "mod" claims the job and posts job.result.
  const EXPLAINER = [
    '## What this task did', '',
    'Refresh tokens now **rotate on every use**. When a client refreshes, the old token is retired and a new one is issued in the same database transaction. If a token that was already rotated shows up again, the server treats it as stolen and revokes the whole *token family*.', '',
    '### How rotation works', '',
    '1. Each login creates a `family_id`. Every refresh token carries it.',
    '2. `POST /v1/tokens/refresh` looks the token up, marks it `used_at = now()`, and inserts its successor, all in one transaction.',
    '3. If the presented token is already `used_at`, nobody legitimate can hold it: every token in the family is revoked.', '',
    '### Why there is a grace window', '',
    'Two tabs can refresh at the same moment, and the second request looks exactly like a replay. The code allows **10 seconds** for the immediately previous token before it declares a theft.', '',
    '### Where to look', '',
    '- `src/auth/refresh.ts` holds the rotation and the replay check.',
    '- `src/auth/tokens.ts` wires it into the existing issue and revoke paths.',
    '- `test/auth/refresh.test.ts` covers the happy path, replay and the concurrent refresh.', '',
    '### Worth remembering', '',
    'Rotation moves the trust from "this token is valid" to "this token is valid *and has not been seen before*". That is why the database write has to be atomic.',
  ].join('\n');
  atMin(95, () => {
    const j = hub.explainTask(ids.jwt, clock).job;
    ids.explainJob = j.id; ids.explainSess = j.sessionId;
    hub.claimJobs(j.sessionId, clock);
  });
  atMin(94.4, () => emit(ids.explainSess, 'job.result', { jobId: ids.explainJob, ok: true, text: EXPLAINER }));

  const digestJob = (key, minAgo, body, text) => {
    atMin(minAgo, () => {
      const j = hub.requestDigest(body(), clock).job;
      ids[key] = j.id; ids[key + 'Sess'] = j.sessionId;
      hub.claimJobs(j.sessionId, clock);
    });
    atMin(minAgo - 0.6, () => emit(ids[key + 'Sess'], 'job.result', { jobId: ids[key], ok: true, text: text() }));
  };
  digestJob('digestYesterday', 140, () => ({ date: localDate(NOW - 24 * 60 * MIN), projectId: ids.P1 }), () => [
    '# Yesterday: groundwork for auth hardening', '',
    'A quiet day that set up everything today builds on.', '',
    '## Done', '',
    '- Wrote up the auth threat model and agreed the order of work: token rotation first, then rate limiting, then key rotation.',
    '- Moved the sessions table off serial ids on paper (migration plan drafted, not yet run).', '',
    '## Still open', '',
    '- The `audit_log.session_id` foreign key blocks the UUIDv7 migration until there is a backfill plan.', '',
    '## What I learned', '',
    'Changing a primary key type is mostly a story about **every table that references it**, not about the table itself.',
  ].join('\n'));
  digestJob('digestToday', 45, () => ({ date: localDate(clock), projectId: ids.P1 }), () => [
    '# Today on Meridian API', '',
    '## Done', '',
    '- **Audit auth middleware for token leaks.** Two debug logs printed bearer tokens (`auth.ts:58`, `ws/handshake.ts:41`). No other leaks.',
    '- **Fix flaky webhook retry test.** The race was between the backoff timer and the fake clock; 50 of 50 runs now pass.', '',
    '## In review', '',
    '- **JWT refresh rotation.** Replaying a rotated token revokes the whole family. Needs a human read before merge.', '',
    '## Blocked', '',
    '- **UUIDv7 sessions migration.** Dry run failed on `audit_log.session_id`; needs a backfill plan first.', '',
    '## Concepts touched', '',
    'auth, token-rotation, testing, flaky-tests, logging',
  ].join('\n'));

  // --------------------------------------------------------------------------- notes
  const note = (key, minAgo, target, text, attach) => atMin(minAgo, () => {
    const t = target();
    ids[key] = hub.createNote({ target: t, text, attachments: attach ? [ids[attach]] : undefined }, clock).note.id;
  });
  const execute = (minAgo, target) => atMin(minAgo, () => hub.executeNotes({ target: target() }, clock));
  const claim = (minAgo, sid) => atMin(minAgo, () => hub.claimInbox(sid, clock));
  const result = (key, minAgo, sid, ok, via, error) => atMin(minAgo, () => {
    const d = { noteId: ids[key], ok, via };
    if (error) d.error = error;
    emit(sid, 'note.result', d);
  });
  const sessA = () => ({ kind: 'session', id: SESS_A });
  const sessB = () => ({ kind: 'session', id: SESS_B });
  const taskT = (k) => () => ({ kind: 'task', id: ids[k] });

  note('nRanA', 34, sessA, "Use the existing redis client in src/lib/redis.ts, don't add a new dependency.");
  execute(33.5, sessA); claim(32.5, SESS_A); result('nRanA', 31.8, SESS_A, true, 'prompt');
  note('nRanB', 26, taskT('jwt'), 'Also add a counter metric for refresh-token reuse detections so we can alert on it.');
  execute(25.5, taskT('jwt')); claim(24.5, SESS_A); result('nRanB', 23.5, SESS_A, true, 'followup_spawn');
  note('nFail', 12, taskT('sparkline'), "Fall back to the SVG path if canvas isn't available in Safari 15.");
  execute(11.5, taskT('sparkline')); claim(10.8, SESS_B);
  result('nFail', 10, SESS_B, false, 'send_message', 'session was idle; delivery timed out after 60s');
  atMin(4.8, () => {
    ids.shot = hub.addAttachment({ data: tinyPng(), name: 'staging-banner.png', mime: 'image/png' }, clock).attachment.id;
  });
  note('nSend', 4.6, sessA, 'Heads-up: staging DB is read-only until 14:00, so skip migration dry-runs for now. Banner screenshot attached.', 'shot');
  execute(4.5, sessA); claim(4.2, SESS_A);
  note('nQueued', 3.2, sessB, "When you're back: run the visual regression suite before pushing the sparkline work.");
  execute(3.1, sessB);
  note('nDraft1', 3.6, taskT('limiter'), 'Cover the /v1/export route in the limiter tests too; it has the heaviest payloads.');
  note('nDraft2', 1.2, sessA, 'After the limiter lands, draft the OpenAPI schema for /v1/tokens.');

  // v0.3: replies, and a task started from the dashboard (Start -> session note -> ran -> reply)
  const reply = (key, minAgo, sid, text) => atMin(minAgo, () => emit(sid, 'note.reply', { noteId: ids[key], text }));
  reply('nRanA', 31.5, SESS_A, 'Understood. I will reuse the existing redis client in `src/lib/redis.ts` and add no new dependency.');
  reply('nRanB', 22, SESS_A, 'Added a `refresh_token_reuse_total` counter, incremented on every replayed-token revocation.\n\n- metric lives in `src/auth/metrics.ts`\n- covered by the revoke tests');
  atMin(9, () => { ids.startAudit = hub.startTask(ids.authdocs, clock).note.id; });
  claim(8.5, SESS_A);
  atMin(8, () => emit(SESS_A, 'note.result', { noteId: ids.startAudit, ok: true, via: 'prompt' }));
  atMin(7.8, () => emit(SESS_A, 'note.reply', { noteId: ids.startAudit, text: 'Started the auth docs task in the background with helm:builder.' }));

  // v0.4: cost meter. Helm's own overhead (recap/answer/explain/digest) vs work the user asked for (note_turn),
  // today (never before local midnight, so a run just after midnight still lands on today) and yesterday.
  const startToday = new Date(new Date(NOW).setHours(0, 0, 0, 0)).getTime();
  const d0 = new Date(startToday);
  const startYesterday = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - 1).getTime();
  const usage = (when, kind, model, inT, outT, costUsd, extra = {}) => atMs(when, () => emit(SESS_A, 'helm.usage', {
    kind, model, inputTokens: inT, outputTokens: outT, cacheReadTokens: extra.cache ?? 0, costUsd, ...extra.ids,
  }, when));
  const today = (minAgo) => Math.max(startToday + 2 * MIN, NOW - minAgo * MIN);
  usage(startYesterday + 10 * 60 * MIN, 'recap', 'haiku-5-5', 2400, 310, 0.000395, { ids: { taskId: 'T-1' } });
  usage(startYesterday + 11 * 60 * MIN, 'explain', 'sonnet-5-5', 5200, 900, 0.0194);
  usage(startYesterday + 15 * 60 * MIN, 'digest', 'sonnet-5-5', 8800, 1400, 0.0316);
  usage(startYesterday + 16 * 60 * MIN, 'note_turn', 'opus-5-5', 21000, 2600, 0.136, { cache: 40000 });
  usage(today(150), 'recap', 'haiku-5-5', 2900, 340, 0.00046);
  usage(today(100), 'answer', 'haiku-5-5', 3100, 220, 0.00042);
  usage(today(60), 'recap', 'haiku-5-5', 2500, 300, 0.0004);
  usage(today(40), 'explain', 'sonnet-5-5', 6100, 1100, 0.0232);
  usage(today(30), 'note_turn', 'opus-5-5', 18000, 1900, 0.112, { cache: 52000 });
  usage(today(20), 'answer', 'haiku-5-5', 2800, 260, 0.00041);
  usage(today(6), 'digest', 'sonnet-5-5', 9400, 1500, 0.0338);

  // ------------------------------------------------------------------------- run
  actions.sort((a, b) => a.t - b.t);
  for (const a of actions) {
    clock = Math.max(clock, Math.min(a.t, NOW));
    a.fn();
  }

  // v0.9: one workflow from the built-in template, so the Workflows screen has something to open (no run: that needs a live mod)
  if (ids.P1) hub.wf.createWorkflow({ projectId: ids.P1, template: 'build-test-review' }, clock);

  // A real git repo for the JWT task so the demo shows real diffs (skipped quietly when git is unavailable).
  let gitTaskId = null;
  try {
    const root = seedGitRepo(hub.cfg.home);
    if (root && ids.jwt) {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      emit(SESS_A, 'agent.git', { toolUseId: 'toolu_01Hk3aJwt', cwd: root, root, base: head, head, at: clock });
      gitTaskId = ids.jwt;
    }
  } catch (e) { log?.warn?.('seed: git repo skipped', e); }

  // back to real time: apply the stall/idle rules to the seeded state (Session B idle, sparkline agent stalled+blocked)
  hub.setClock(Date.now);
  hub.autoSnapshot = prevSnap;
  hub.sweep(Date.now());
  hub.tx(() => hub.db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('seeded', '1')"));

  const count = (t) => hub.db.get(`SELECT COUNT(*) AS n FROM ${t}`).n;
  const counts = {
    projects: count('projects'), sessions: count('sessions'), agents: count('agents'), tasks: count('tasks'),
    notes: count('notes'), activity: count('activity'), events: count('events'),
    questions: count('questions'), conflicts: count('conflicts'), jobs: count('jobs'), digests: count('digests'),
    attachments: count('attachments'), usage: count('usage'),
  };
  log?.info(`seed done ${JSON.stringify(counts)}`);
  return { skipped: false, counts, gitTaskId };
}

/** Make $HELM_HOME/seed-repo: one commit, then a modified file and two new (untracked) ones. Returns the real root, or null. */
export function seedGitRepo(home) {
  const dir = path.join(home, 'seed-repo');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.email=demo@helm.local', '-c', 'user.name=Helm Demo', '-c', 'commit.gpgsign=false', ...a],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  try { git('init', '-q'); } catch { return null; }
  put('README.md', '# meridian-api (demo)\n');
  put('src/auth/tokens.ts', [
    "import { sign, verify } from './jwt';", '',
    'export function issueTokens(userId: string) {',
    "  const access = sign({ sub: userId }, { expiresIn: '15m' });",
    "  const refresh = sign({ sub: userId, kind: 'refresh' }, { expiresIn: '30d' });",
    '  return { access, refresh };', '}', '',
    'export function readToken(raw: string) {', '  return verify(raw);', '}', ''].join('\n'));
  git('add', '-A'); git('commit', '-q', '-m', 'baseline');
  put('src/auth/tokens.ts', [
    "import { sign, verify } from './jwt';",
    "import { rotate } from './refresh';", '',
    'export function issueTokens(userId: string, familyId = crypto.randomUUID()) {',
    "  const access = sign({ sub: userId }, { expiresIn: '15m' });",
    "  const refresh = sign({ sub: userId, kind: 'refresh', fam: familyId }, { expiresIn: '30d' });",
    '  return { access, refresh, familyId };', '}', '',
    'export function refreshTokens(raw: string) {', '  return rotate(readToken(raw));', '}', '',
    'export function readToken(raw: string) {', '  return verify(raw);', '}', ''].join('\n'));
  put('src/auth/refresh.ts', [
    "import { issueTokens } from './tokens';", '',
    'const used = new Set<string>();', '',
    'export function rotate(claims: { sub: string; jti: string; fam: string }) {',
    '  if (used.has(claims.jti)) throw new Error(`token family ${claims.fam} revoked: replay detected`);',
    '  used.add(claims.jti);', '  return issueTokens(claims.sub, claims.fam);', '}', ''].join('\n'));
  put('test/auth/refresh.test.ts', [
    "import { rotate } from '../../src/auth/refresh';", '',
    "test('a replayed token revokes its family', () => {",
    "  const c = { sub: 'u1', jti: 'a', fam: 'f1' };", '  rotate(c);', '  expect(() => rotate(c)).toThrow(/replay/);', '});', ''].join('\n'));
  return fs.realpathSync(dir);
}

// ===================================================================== live demo
const FILES = ['src/auth/refresh.ts', 'src/auth/tokens.ts', 'src/middleware/rateLimit.ts', 'src/routes/projects.ts',
  'src/routes/export.ts', 'src/db/repo.ts', 'src/lib/redis.ts', 'src/webhooks/sender.ts', 'test/auth/revoke.test.ts',
  'src/middleware/requestId.ts', 'src/jwks/keys.ts', 'docs/auth.md'];
const TOOL_STEPS = [
  (f) => ['Read', `Read ${f}`, `Read ${40 + Math.floor(Math.random() * 200)} lines`],
  (f) => ['Grep', `Grep: ${['TODO', 'refreshToken', 'rateLimit', 'tenantId', 'retry'][Math.floor(Math.random() * 5)]} in src/`, `${1 + Math.floor(Math.random() * 14)} matches`],
  (f) => ['Edit', `Edit ${f}`, `Edited ${f} (+${3 + Math.floor(Math.random() * 40)} -${Math.floor(Math.random() * 12)})`, [f]],
  (f) => ['Bash', `Bash: npm test -- ${f.split('/').pop().replace(/\..*/, '')}`, `exit 0: ${5 + Math.floor(Math.random() * 30)} passed`],
  (f) => ['Write', `Write ${f}`, `Created ${f}`, [f]],
];
const POOL = [
  'Add structured request-id logging', 'Harden password reset token expiry', 'Cache JWKS responses for 10 minutes',
  'Fix N+1 query in /v1/projects', 'Add retry with jitter to the webhook sender', 'Write integration tests for token revocation',
  'Rate-limit the /v1/login endpoint per account', 'Return RFC 7807 problem details from the API',
];
const QUESTIONS = [
  'Should refresh tokens expire after 30 days, or slide with use?',
  'Keep the legacy /v0 error shape for old clients, or return RFC 7807 everywhere?',
  'The migration needs a backfill. Run it in the same deploy, or as a separate job first?',
  'Two libraries solve this. Prefer the one already in package.json, or the smaller one?',
];
const CONCEPTS = [['http', 'caching'], ['sql', 'performance'], ['auth', 'security'], ['testing', 'integration'], ['observability', 'logging']];

export function startDemoLive(hub, log, { tickMs } = {}) {
  const sid = SESS_A;
  let seq = hub.db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?', sid).m;
  const emit = (type, data) => hub.ingest([{ sessionId: sid, seq: ++seq, type, at: Date.now(), data }]);
  const state = new Map(); // toolUseId -> { target, pendingBind }
  let spawned = 0, tokens = 412000, cost = 6.8, lastBeat = 0, stopped = false, timer = null;
  const timeouts = new Set();

  const later = (ms, fn) => {
    const to = setTimeout(() => {
      timeouts.delete(to);
      if (stopped) return;
      try { fn(); } catch (e) { log?.error('demo-live deferred step failed', e); }
    }, ms);
    timeouts.add(to);
  };
  // An agent asks the user something; a few seconds later "the user" answers (tool.finished).
  const askQuestion = (a) => {
    const toolUseId = `tu_ask_${Math.random().toString(36).slice(2, 9)}`;
    const q = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
    emit('tool.called', { agentId: a.id, toolUseId, tool: 'AskUserQuestion', summary: q });
    later(5000 + Math.floor(Math.random() * 9000), () => {
      emit('tool.finished', { agentId: a.id, toolUseId, tool: 'AskUserQuestion', ok: true, summary: 'User answered' });
    });
  };
  // Two running agents announce an edit to the same file within seconds: the conflict radar lights up.
  const conflictingEdit = (running) => {
    const i = Math.floor(Math.random() * running.length);
    const a = running[i], b = running[(i + 1 + Math.floor(Math.random() * (running.length - 1))) % running.length];
    const f = FILES[Math.floor(Math.random() * FILES.length)];
    for (const [who, delay] of [[a, 0], [b, 1200 + Math.floor(Math.random() * 1500)]]) {
      const go = () => {
        const toolUseId = `tu_${Math.random().toString(36).slice(2, 9)}`;
        emit('tool.called', { agentId: who.id, toolUseId, tool: 'Edit', summary: `Edit ${f}`, files: [f] });
        later(600 + Math.floor(Math.random() * 800), () => {
          emit('tool.finished', { agentId: who.id, toolUseId, tool: 'Edit', ok: true, summary: `Edited ${f} (+${4 + Math.floor(Math.random() * 20)} -2)`, files: [f] });
        });
      };
      if (delay) later(delay, go); else go();
    }
  };

  const step = () => {
    const now = Date.now();
    if (now - lastBeat > 14_000) {
      tokens += 2000 + Math.floor(Math.random() * 6000);
      cost = Math.round((cost + 0.02 + Math.random() * 0.06) * 100) / 100;
      emit('session.heartbeat', { tokens, costUsd: cost });
      lastBeat = now;
    }
    const s = hub.p.getSession(sid);
    if (s && !s.busy) emit('turn.started', {});
    const running = hub.db.all(`SELECT * FROM agents WHERE session_id = ? AND status IN ('running','stalled') ORDER BY rowid`, sid);
    const r = Math.random();
    if (running.length < 3 && r < 0.22) {
      spawned++;
      const title = POOL[(spawned - 1) % POOL.length];
      const toolUseId = `toolu_demo_${Date.now().toString(36)}${spawned}`;
      const scout = spawned % 3 === 0;
      emit('agent.spawned', {
        toolUseId, subagentType: scout ? 'helm:scout' : 'helm:builder', model: scout ? 'haiku' : 'sonnet',
        description: title, prompt: `${title}. Keep changes small and add tests.`,
      });
      state.set(toolUseId, { target: 5 + Math.floor(Math.random() * 5), bind: true, title });
      return;
    }
    if (!running.length) return;
    const roll = Math.random();
    if (roll < 0.05) { askQuestion(running[Math.floor(Math.random() * running.length)]); return; }
    if (roll > 0.93 && running.length >= 2) { conflictingEdit(running); return; }
    const a = running[Math.floor(Math.random() * running.length)];
    let st = state.get(a.tool_use_id);
    if (!st) { st = { target: a.tool_count + 3 + Math.floor(Math.random() * 4), bind: false, title: a.description }; state.set(a.tool_use_id, st); }
    if (st.bind && a.id.startsWith('pending:') && Math.random() < 0.6) {
      emit('agent.bound', { toolUseId: a.tool_use_id, agentId: `ag_demo${Math.random().toString(16).slice(2, 12)}` });
      st.bind = false;
      return;
    }
    if (a.tool_count >= st.target && r < 0.6) {
      const ok = Math.random() < 0.85;
      emit('agent.completed', {
        agentId: a.id, ok, tokens: 20000 + Math.floor(Math.random() * 60000),
        summary: ok ? `${st.title}: done, tests pass.` : `${st.title}: gave up after repeated test failures in CI.`,
      });
      if (ok) {
        const c = CONCEPTS[Math.floor(Math.random() * CONCEPTS.length)];
        emit('recap.generated', {
          taskId: a.task_id, what: `${st.title}.`, how: 'Read the existing code paths, made a minimal change, and added focused tests.',
          learned: 'Small, well-tested steps made review fast.', concepts: c,
        });
      }
      return;
    }
    const f = FILES[Math.floor(Math.random() * FILES.length)];
    const [tool, called, finished, files] = TOOL_STEPS[Math.floor(Math.random() * TOOL_STEPS.length)](f);
    const toolUseId = `tu_${Math.random().toString(36).slice(2, 9)}`;
    emit('tool.called', { agentId: a.id, toolUseId, tool, summary: called });
    const to = setTimeout(() => {
      timeouts.delete(to);
      if (stopped) return;
      try {
        const d = { agentId: a.id, toolUseId, tool, ok: true, summary: finished };
        if (files) d.files = files;
        emit('tool.finished', d);
      } catch (e) { log?.error('demo-live finish failed', e); }
    }, 500 + Math.floor(Math.random() * 1000));
    timeouts.add(to);
  };

  const tick = () => {
    if (stopped) return;
    try { step(); } catch (e) { log?.error('demo-live step failed', e); }
    timer = setTimeout(tick, tickMs ?? 1000 + Math.floor(Math.random() * 2000));
  };
  timer = setTimeout(tick, tickMs ?? 1500);
  log?.info('demo-live started');
  return () => {
    stopped = true;
    clearTimeout(timer);
    for (const t of timeouts) clearTimeout(t);
  };
}
