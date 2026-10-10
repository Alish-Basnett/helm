# Helm contract (mod ⇄ hub ⇄ web)

Single source of truth for shapes. If code disagrees with this file, fix the code
or update this file in the same change.

## Layout

```
helm/
  .claude-plugin/plugin.json      mod manifest
  hooks/hooks.json                { "modules": ["./register.ts"] }
  hooks/register.ts               the mod (runs inside every Claude Code session)
  hub/helmd.mjs                   hub entry: node hub/helmd.mjs [--seed] [--port 7777]
  hub/*.mjs                       hub internals (db, projections, http, sse, search)
  hub/seed.mjs                    demo data for UI work without live sessions
  hub/test/*.test.mjs             node --test
  web/index.html, web/*.js, web/*.css   served by the hub at /
```

Runtime: Node ≥ 24, **zero npm dependencies** (`node:sqlite`, `node:http`, `node:fs`).
Web: vanilla ES modules, no build step, no CDN (works offline).

## Hub process

- Home dir: `$HELM_HOME` or `~/.helm/` → `helm.db` (SQLite WAL), `helmd.sock`,
  `helmd.pid`, `helmd.log`.
- Listens on **both** the unix socket `helmd.sock` (mods, via `$.http.fetch(url, { socketPath })`)
  and TCP `127.0.0.1:${HELM_PORT:-7777}` (web UI). Same router for both.
- Single instance: on start, if the pid file names a live process answering
  `/v1/health`, exit 0. Stale socket files are removed.
- All JSON bodies UTF-8; errors `{ error: string }` with 4xx/5xx.

## IDs and time

- `P-<n>` project, `T-<n>` task, `N-<n>` note (global integer counters).
- `sessionId` = Claude Code session id. `agentId` = engine agent id.
- Times are epoch milliseconds (`number`).

## Rows (what `/v1/state` and SSE carry)

```ts
type Project = { id: string; name: string; createdAt: number; archived: boolean }

type Session = {
  id: string; projectId: string; cwd: string; title: string; model: string;
  startedAt: number; lastSeenAt: number;
  status: 'active' | 'idle' | 'ended';        // idle = no heartbeat for 2 min
  busy: boolean;                              // a main turn is running
  nowDoing: string;                           // latest main-agent tool summary
  tokens: number;                            // context tokens (latest heartbeat)
  costUsd: number;                            // session spend so far (latest heartbeat)
}

type Agent = {
  id: string;                                 // agentId, or `pending:<toolUseId>` until bound
  sessionId: string; taskId: string | null; toolUseId: string;
  subagentType: string; model: string; description: string;
  status: 'running' | 'done' | 'failed' | 'stalled';
  startedAt: number; endedAt: number | null; lastActivityAt: number;
  nowDoing: string; toolCount: number; tokens: number;
}

type TaskStatus = 'backlog' | 'next' | 'in_progress' | 'review' | 'done' | 'later' | 'blocked' | 'archived'

type Task = {
  id: string; projectId: string; sessionId: string | null;
  title: string; description: string; status: TaskStatus;
  agentId: string | null;                     // current/last agent
  order: number;                              // sort within column (float, lower first)
  blockedReason: string | null;
  dependsOn: string[];                        // task ids
  filesChanged: string[];
  tokens: number;
  recap: { what: string; how: string; learned: string; concepts: string[] } | null;
  createdAt: number; updatedAt: number; doneAt: number | null;
}

type NoteState = 'draft' | 'queued' | 'sending' | 'ran' | 'failed'
// UI colour (text only): draft = dim grey, queued/sending = accent, ran = soft green, failed = red

type Note = {
  id: string;
  target: { kind: 'session' | 'task'; id: string };
  sessionId: string;                          // session that will deliver it
  text: string; state: NoteState;
  createdAt: number; queuedAt: number | null; ranAt: number | null;
  via: 'prompt' | 'send_message' | 'followup_spawn' | null;
  error: string | null;
}

type Activity = {
  id: number; sessionId: string; agentId: string | null; taskId: string | null;
  kind: 'tool' | 'tool_done' | 'status' | 'note' | 'recap';
  tool: string | null; summary: string; ok: boolean | null; at: number;
}
```

## Ingest (mod → hub)

`POST /v1/events` body `{ events: Event[] }` → `{ accepted: number, duplicates: number, lastSeq: number }`

Every event: `{ sessionId: string, seq: number, type: string, at: number, data: object }`.
`(sessionId, seq)` is unique; a repeat is counted as a duplicate and ignored (idempotent
replay from the mod's outbox). Events are applied in `seq` order per session; a gap is
accepted (outbox may have trimmed) but logged.

| type | data | projection |
|---|---|---|
| `session.started` | `{ cwd, title, model }` | upsert Session; if new and not joined, create Project named after `basename(cwd)` (reuse an existing non-archived project with that exact name **only if** the session id was previously bound to it) |
| `session.heartbeat` | `{ tokens?, costUsd? }` | `lastSeenAt`, status active, tokens/costUsd when present |
| `session.ended` | `{ reason }` | status ended; running agents of that session → failed ("session ended") |
| `turn.started` | `{ agentId? }` | no agentId → session.busy = true |
| `turn.completed` | `{ agentId?, ok, error? }` | no agentId → session.busy = false |
| `agent.spawned` | `{ toolUseId, taskId?, subagentType, model, description, prompt }` | Agent `pending:<toolUseId>` running. Task: `taskId` given → that task; else parse `[helm:T-n]` from description; else create Task (title = description, status in_progress, project = session's). Task → in_progress, agentId set |
| `agent.bound` | `{ toolUseId, agentId }` | rename pending agent id → agentId everywhere |
| `tool.called` | `{ agentId?, toolUseId, tool, summary }` | Activity; agent (or session if no agentId) nowDoing, lastActivityAt, toolCount++; stalled → running, blocked-by-stall task → in_progress |
| `tool.finished` | `{ agentId?, toolUseId, tool, ok, summary, files? }` | Activity; `files` appended (deduped) to task.filesChanged |
| `agent.completed` | `{ agentId, ok, summary, tokens?, files? }` (`files` from the agent's `FILES:` report line, appended like tool.finished files) | agent done/failed; task → `review` if ok, `blocked` (reason = summary) if not |
| `recap.generated` | `{ taskId, what, how, learned, concepts }` | task.recap; Activity kind recap |
| `note.result` | `{ noteId, ok, via, error? }` | note ran/failed |
| `reconcile` | `{ agents: { agentId, status: 'running' \| 'done' \| 'failed' }[] }` | for this session: any hub agent running but reported done/failed or missing → apply that terminal state; running in report but unknown to hub → create Agent |

Stall sweep (hub timer, every 30 s): running agent with `lastActivityAt` older than 5 min →
`stalled`; older than 10 min → its task `blocked` with reason `no activity for 10 min`
(returns to in_progress on next `tool.called`). Session without heartbeat 2 min → idle.
A note still `sending` 10 min (`HELM_SENDING_MS`) after the mod claimed it (`sending_at`) becomes `failed` with error
`delivery unconfirmed — retry` (the Retry endpoint works on it; a late `note.result` still overrides it to `ran`/`failed`).

## Mod pulls

- `GET /v1/sessions/:id/inbox` → `{ notes: Note[] }` — atomically moves this session's
  `queued` notes to `sending` and returns them (oldest first).
- `GET /v1/sessions/:id/agents` → `{ agents: Agent[] }` (reconciler compares against `$.agent.list()`).
- `GET /v1/sessions/:id/project` → `{ project: Project }`.
- `GET /v1/tasks?sessionId=&status=` → `{ tasks: Task[] }` (for the mod's `helm_task` tool).

## Web / commands

- `GET /v1/health` → `{ ok: true, version, pid, startedAt }`
- `GET /v1/state?projectId=` → `{ projects, sessions, agents, tasks, notes, seq }`
  (no projectId = everything). `seq` = latest change seq, for SSE resume.
- `GET /v1/stream` (SSE). Each message: `id: <changeSeq>`, `event: change`,
  `data: { entity: 'project'|'session'|'agent'|'task'|'note'|'activity', op: 'upsert'|'delete', row }`.
  Honours `Last-Event-ID` (replays changes after it from the changes table; if too old,
  sends `event: reset` and the client refetches `/v1/state`). Heartbeat comment every 15 s.
- `GET /v1/tasks/:id` → `{ task, agent, activity: Activity[], notes: Note[] }`
- `GET /v1/sessions/:id/activity?limit=200` → `{ activity: Activity[] }`
- `POST /v1/projects` `{ name }` → `{ project }`; `PATCH /v1/projects/:id` `{ name?, archived? }`
- `POST /v1/sessions/:id/join` `{ projectId }` → `{ session }` (move session + its tasks)
- `POST /v1/tasks` `{ projectId, title, description?, status?, dependsOn?, sessionId? }` → `{ task }`
- `PATCH /v1/tasks/:id` `{ title?, description?, status?, order?, dependsOn? }` → `{ task }`
- `POST /v1/notes` `{ target, text }` → `{ note }` (state draft; sessionId resolved from target)
- `PATCH /v1/notes/:id` `{ text }` (draft only) · `DELETE /v1/notes/:id` (draft only)
- `POST /v1/notes/execute` `{ target }` → `{ notes }` — all draft notes for that target → queued
- `POST /v1/notes/:id/retry` → failed → queued
- `GET /v1/search?q=&limit=30` → `{ results: { kind: 'task'|'note'|'recap'|'activity'|'session'|'project', id, title, snippet, projectId, sessionId, taskId, at }[] }` (FTS5, prefix matching, snippet with `<mark>`)
- `GET /v1/learn?projectId=` → `{ concepts: { name, count, recaps: { taskId, title, what, how, learned, at }[] }[] }`
- `GET /*` → static files from `web/` (index.html fallback for unknown non-/v1 paths).

## Mod ⇄ engine (for reference; implemented in hooks/register.ts)

- `agent.spawn` hook: emit `agent.spawned`, enforce model by subagentType
  (`helm:builder` → sonnet, `helm:scout` → haiku; others: keep given, default sonnet).
- `tool.call` (Agent tool) result carries `agentId` → emit `agent.bound`.
- `tool.call` (any) → `tool.called` before `next`, `tool.finished` after, with `e.agentId`.
- subagent `turn.complete` (has agentId) → `agent.completed`, then Haiku recap → `recap.generated`.
- timer 2 s: drain outbox, poll inbox, deliver notes; timer 10 s: heartbeat + reconcile.
- Task tag convention for delegation: put `[helm:T-12]` in the Agent call's description.

## v0.2 additions — extras (conflict radar, questions, jobs, digests)

### Conflict radar
- `tool.called` data gains `files?: string[]` — absolute paths the call is about to edit
  (Edit / Write / MultiEdit / NotebookEdit). The mod sends it on `tool.called`, not only `tool.finished`.
- Hub keeps `agent_files(agent_id, path, at)`. A **conflict** is a path touched (via `files`) by two or
  more distinct agents where each is `running` / `stalled` / `waiting`, or touched it within the last
  10 min. Recomputed on `tool.called` with files, on agent completion, and in the sweep.
  (Clarified: `files` on a call without an agent are ignored; two agents of the *same* task never conflict for `Task.conflicts`; the sweep emits a `hub.sweep` event with `conflicts: true` only when the set changed.)
- `Task` gains `conflicts: { path: string; otherTaskId: string | null; otherAgentId: string; otherSessionId: string }[]`
  (empty array when none). A change to it is pushed as a task upsert.
- `GET /v1/conflicts` → `{ conflicts: { path, agents: { agentId, taskId, sessionId, at }[] }[] }` (current only).

### Questions inbox
```ts
type Question = {
  id: string;                                  // Q-<n>
  sessionId: string; agentId: string | null; taskId: string | null;
  kind: 'ask' | 'waiting';                     // ask = AskUserQuestion call; waiting = agent status waiting
  text: string;                                // the question(s), or "Waiting for input"
  toolUseId: string | null;
  state: 'open' | 'answered';
  createdAt: number; answeredAt: number | null;
}
```
- `tool.called` with `tool === 'AskUserQuestion'` → open Question (kind ask, `text` = the mod's
  `summary`, which carries the question text). The matching `tool.finished` (same `toolUseId`) → answered.
- `reconcile` agent status gains `'waiting'`; `Agent.status` gains `'waiting'`. Entering waiting → open
  Question kind waiting for that agent (one open at a time); leaving waiting (running/done/failed) → answered.
  A waiting agent never stalls.
  (Clarified: a new `tool.called` other than AskUserQuestion also takes a waiting agent back to `running`; when an agent completes or a session ends, that agent's / session's open questions become `answered`; the stall-blocked task of an agent that starts waiting returns to `in_progress`.)
- In `/v1/state` as `questions` (open + last 50 answered); SSE entity `question`. `POST …/dismiss` on an already answered question is a 200 no-op.
- `GET /v1/questions?state=open|answered` → `{ questions }`. `POST /v1/questions/:id/dismiss` → answered.

### Jobs (model work the hub asks a live mod to do)
```ts
type Job = {
  id: string;                                  // J-<n>
  kind: 'explain' | 'digest';
  sessionId: string;                           // live session chosen to run it
  taskId: string | null; projectId: string | null;
  state: 'queued' | 'running' | 'done' | 'failed';
  input: Record<string, unknown>;              // everything the mod needs to prompt (built by the hub)
  result: string | null; error: string | null;
  createdAt: number; claimedAt: number | null; doneAt: number | null;
}
```
- Session choice: the task's session if active/idle (not ended), else the project's most recent
  active/idle session, else any active session (latest `lastSeenAt`); none → 409 `{ error: 'no live session' }`.
- `POST /v1/tasks/:id/explain` → `{ job }`. `input` = `{ title, description, recap, filesChanged,
  activity: last 40 tool summaries oldest→newest }`. Re-explaining while a job is queued/running returns that job.
  (Clarified: `activity` is `string[]` of `kind='tool'` summaries; `POST /v1/tasks/:id/explain` and `POST /v1/digest` answer 200.)
- `POST /v1/digest` `{ date?: 'YYYY-MM-DD' (local, default today), projectId?: string }` → `{ job }`.
  `input` = `{ date, projectName|null, done: {id,title,recap}[], blocked: {id,title,reason}[],
  inProgress: {id,title}[], concepts: string[] }` for tasks whose `doneAt` / `updatedAt` fall on that date.
  (Clarified: `done[].recap` is the Task `recap` object or null; `concepts` = deduped concepts of the done tasks' recaps; with no `projectId` only an *active* session qualifies, per the session rule; a digest request is never de-duplicated.)
- `GET /v1/sessions/:id/jobs` → `{ jobs }` — atomically claims this session's queued jobs → running.
- Event `job.result` `{ jobId, ok, text?, error? }` → done/failed. explain → `Task.explainer = text`;
  digest → a Digest row. Running jobs older than `HELM_JOB_MS` (default 5 min) → failed `timed out` (sweep).
  (Clarified: the sweep also fails *queued* jobs older than `HELM_JOB_MS` with `not picked up by a live session`, so a dead session cannot wedge re-explain; a `timed out` job can still be completed by a late `job.result`; `ok: true` without text counts as failed `empty result`.)
- `Task` gains `explainer: string | null` (markdown) and `explainJob: { id, state } | null` (clarified: the task's *latest* explain job in any state; a failed re-run keeps the old `explainer`).
- In `/v1/state` as `jobs` (queued/running + last 20 finished); SSE entity `job`.

### Digests
```ts
type Digest = { id: string; date: string; projectId: string | null; text: string; createdAt: number }  // D-<n>, text = markdown
```
- `GET /v1/digests?projectId=&limit=14` → `{ digests }`; in `/v1/state` as `digests` (latest 14); SSE entity `digest`.
  (Clarified: ordered by `date` desc, then newest first; `projectId` filters by exact match; `/v1/state?projectId=` scopes questions, jobs and digests to that project.)

### Search
FTS also indexes questions (text), explainer text (as part of the task doc) and digests.
(Clarified: result `kind` gains `'question'` and `'digest'`; digest hits carry the digest's `projectId`.)

### Migration
Opening a v0.1 database adds the new tables/columns in place. Old events are not replayed automatically; run
`node hub/helmd.mjs --rebuild` (daemon stopped) to back-fill questions/conflicts from history.
