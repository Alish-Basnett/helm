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
  hub/wfgraph.mjs, workflows.mjs, wfengine.mjs   v0.9 workflows: graph validator, reducer, decision engine
  web/views/workflows.js, web/wf/*.js, web/wf.css   v0.9 workflows canvas and run UI
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

## v0.3 additions — drive everything from Helm (replies, Start, Talk)

### Note replies
- `Note` gains `reply: string | null` (markdown, ≤ 8000 chars) and `repliedAt: number | null`.
- Event `note.reply` `{ noteId, text }` → sets reply/repliedAt (a later reply replaces an earlier one), pushes a
  note upsert, adds Activity kind `note` ("Reply to N-x"), and is indexed in FTS with the note.
- Who sends it (mod): a **session** note → the main agent's answer for the turn that the note started
  (the mod matches `Helm note (N-x)` in `turn.start` text); a **task** note delivered by `send_message`
  or `followup_spawn` → that agent's final answer when it completes.

### Start a task from the dashboard
- `POST /v1/tasks/:id/start` → `{ note, task }`. Creates a **session** note on the task's live session
  (same session rule as jobs: task's session if not ended → project's most recent active/idle → 409
  `{ error: 'no live session' }`), already `queued`, with text:
  `Start Helm task T-n “<title>”.\n\nBrief:\n<description>\n\nCreate nothing new: delegate this existing task now with the Agent tool (description starting with [helm:T-n]), choosing helm:builder for code changes or helm:scout for read-only work, run it in the background, then reply in one line with what you started.`
  Allowed when status is `backlog`, `next`, `later` or `blocked`; otherwise 409. Sets task status `next`
  and `startNoteId`.
- `Task` gains `startNoteId: string | null` (the latest start note; the UI reads its state/reply).
- `POST /v1/tasks` accepts `start: true` → creates the task, then starts it as above; returns `{ task, note? }`
  (task is still created if no live session; the response then carries `error`).

### Talk
- No new endpoints: Talk is the session's notes (target kind `session`) shown as a thread with replies.
  `POST /v1/notes` with `{ target, text, execute: true }` creates and queues in one call → `{ note }`.

- v0.8 (T-38): Start (manual, create with `start`, Choices, auto) folds the task's **draft** notes into the start text after Brief as `Notes from the user:` + `- <text>` lines (attachment paths appended), marks them `ran` with `via: 'start'` (`NoteVia` gains `'start'`) and carries `noteIds` + final `text` in `hub.task.start` / `hub.task.autostart`.

(Clarified, v0.3: `POST /v1/tasks/:id/start` answers 200; `POST /v1/tasks` with `start: true` answers 201 and, when the start is refused (no live session, or a status Start does not allow), still creates the task and returns `{ task, error }` with no `note`; `POST /v1/notes` with `execute: true` answers 201 with the queued note and creates nothing on 409 `no session available…`; restarting a `next` task is allowed and replaces `startNoteId`; the start note's `target` is the chosen session. Pre-v0.3 databases are migrated in place; run `--rebuild` to back-fill replies from history.)

## v0.4 additions — attachments, cost meter, cheap answers

### Attachments
- `POST /v1/attachments` — raw request body is the file (≤ 20 MiB); headers `content-type` (mime) and
  `x-filename` (URI-encoded original name). Saves to `$HELM_HOME/attachments/<A-n>/<safe name>` →
  `201 { attachment: { id: 'A-n', name, mime, size, path, createdAt } }` (`path` is absolute).
- `GET /v1/attachments/:id` → the file with its content-type (`content-disposition: inline` for images,
  `attachment` otherwise). Local-origin guards as for other routes.
- `POST /v1/notes` and `PATCH /v1/notes/:id` accept `attachments: string[]` (attachment ids, ≤ 10).
  `Note` gains `attachments: { id, name, mime, size, path }[]` (empty array when none).
- Delivery (mod): appends `\n\nAttached files (open them with the Read tool):\n- <path>` lines to the
  prompt / message text. Notes with attachments are never answered by the cheap path.

### Cost meter
- Event `helm.usage` `{ kind: 'recap' | 'answer' | 'explain' | 'digest' | 'note_turn', model, inputTokens,
  outputTokens, cacheReadTokens?, costUsd, taskId?, noteId? }`. `note_turn` = a main turn started by a
  Helm note (work the user asked for through Helm); every other kind is Helm's own overhead.
- Hub keeps a `usage` table; `GET /v1/usage?days=7` →
  `{ today: { overheadUsd, requestedUsd, byKind: { [kind]: { calls, costUsd } } }, days: [{ date, overheadUsd, requestedUsd }] }`
  (local dates). In `/v1/state` as `usageToday: { overheadUsd, requestedUsd }`; SSE entity `usage`
  (row = the new usageToday) on each event.
- Cost analytics: `GET /v1/usage/breakdown?days=7` (days clamped 1-90, local days) →
  `{ totalUsd, perDay: [{ date, costUsd }], perProject: [{ projectId|null, name|null, sessionCostUsd, calls, costUsd, inputTokens, outputTokens, cacheReadTokens }], perModel: [{ model, calls, costUsd, ...tokens }], perTask: [{ taskId, title|null, calls, costUsd, ...tokens }] }`.
  Lists are sorted by `costUsd` descending; `perDay` is oldest first with empty days included. Project comes from the usage
  row's session; `sessionCostUsd` is the session projection's own cost for sessions started in the window. The web meter popover shows it as tabs.
- Price table lives in the mod (USD per MTok, input/output/cache read): opus-5-5 4/20/0.20,
  sonnet-5-5 2/10/0.20, haiku-5-5 0.10/0.50/0.01, fable 10/50/0.25; cache writes at 1.25× input; unknown models price as Opus.

### Cheap answers
- A **task** note that reads as a question (ends with `?` or starts with what/why/how/when/where/who/
  which/does/do/did/is/are/was/were/has/have/can/could/should/would/will) and has no attachments is answered by the
  mod with one Haiku call over the task's record (title, description, recap, files, last 30 activity
  lines) instead of messaging or spawning an agent. `note.result.via = 'answer'`; the reply follows.
  A note starting with `!` always goes to the agent (the `!` is stripped).
- `NoteVia` gains `'answer'`.

(Clarified, v0.4: only raster images (png/jpeg/gif/webp/avif/bmp/ico) are served `inline`; svg, html and everything else are `attachment`, with `nosniff` and a sandbox CSP. A note's `attachments[]` entries carry `{ id, name, mime, size, path }` (no `createdAt`); `PATCH /v1/notes/:id` takes `text` and/or `attachments` (at least one; omitted fields are unchanged, `[]` clears), and note text must still be non-empty. Upload errors: empty body 400, over 20 MiB 413; unknown or >10 attachment ids on a note 400. Missing `x-filename` becomes `file`, a missing or invalid `content-type` becomes `application/octet-stream`. `GET /v1/usage?days=` clamps `days` to 1-90 (default 7), returns every local day including empty ones, oldest first, ending today; `byKind` covers today only; `helm.usage` events with an unknown `kind` or a negative/non-numeric `costUsd` are ignored. `Attachment` ids use counter `A`; the hub version is 0.4.0.)

## v0.5 additions — git diffs per task, task chat panel, task links in Talk

### Git base at spawn (mod)
- After an `agent.spawn` succeeds, the mod resolves the agent's working dir (`e.cwd` or the session cwd)
  and emits `agent.git { toolUseId, agentId?, cwd, root, base, head, at }` where `root` =
  `git rev-parse --show-toplevel`, `head` = `git rev-parse HEAD`, `base` = `git stash create` output
  (a commit object of index + working tree that touches nothing) or `head` when the tree is clean.
  Not a git repo → no event. Never blocks the hook (runs from the tick).
- Hub stores it on the agent and, when the agent has a task, on the task: `Task.git: { root, base, head, at } | null`
  (first agent's base wins; a follow-up agent never moves an existing base).

### Diffs (hub)
- `GET /v1/tasks/:id/diff?refresh=1` → `{ source: 'snapshot' | 'live' | 'history' | 'none', root, base,
  totals: { files, additions, deletions }, files: [{ path, rel, status: 'A'|'M'|'D'|'R'|'?', additions,
  deletions, binary, patch, truncated }] , note? }`.
  - `snapshot`: frozen diff recorded when the task's agent completed (see below); `refresh=1` recomputes live.
  - `live`: computed now — for each path in `filesChanged` inside `root`: `git diff --numstat` /
    `git diff --patch` from `base` to the working tree; untracked new files via
    `git diff --no-index -- /dev/null <file>` (status `A`). Paths outside `root` resolve their own repo
    and diff against its `HEAD`.
  - `history` (task has no `git`): for each file, commits between task `createdAt` and `doneAt` (+10 min)
    via `git log -p --since --until -- <file>` squashed into one patch, else `git diff HEAD -- <file>`;
    response carries `note: 'approximate: no base recorded'`.
  - `none`: no files or not a git repo (`note` says why).
  - Caps: 120 KB patch per file (`truncated: true`), 600 KB total; git calls time out at 5 s; `execFile`
    only (no shell); paths must resolve inside a repo root.
- Snapshot: when an agent with a task completes, the hub computes the live diff (outside the ingest
  transaction) and records it as a `hub.task.diff` event `{ taskId, diff }` so rebuild reproduces it.
- `Task.diffStat: { files, additions, deletions } | null` from the latest snapshot (or live result when
  a client asked for one); pushed as a task upsert.

### Web
- **Dock**: right-side panels laid side by side (right to left): Talk, Task details, Task chat. Opening a
  task opens Task details + Task chat (chat toggle remembered). Narrow viewports collapse extra panels
  into tabs. Esc closes the focused panel.
- **Task chat panel**: the task's notes as a chat (your notes = bubbles coloured by state, replies under
  them), composer with attachments, cheap-answer hint. The notes section moves out of Task details
  (a "Chat" button there toggles the panel).
- **Files changed**: section label shows `N files +A −D`; each file is a collapsed row (status badge,
  path, `+a −d`); expanding shows the unified diff (hunks, line numbers, add/remove colouring); a
  refresh button re-fetches live.
  (T-26) Clicking a file row opens the **Diff panel** (Dock id `diff`, between Task chat and Task details, 760px default, URL `&diff=<rel path>`): file tabs, unified/split, line numbers, syntax colours, copy path/patch; the row's chevron keeps the inline peek.
- **Task links**: any `T-<n>` in Talk bubbles, replies, notes and activity renders as a small chip
  `T-12 · <title>`; clicking opens that task's details + chat while Talk stays open.

(Clarified, v0.5 hub: `hub.task.diff { taskId, diff }` freezes the snapshot; a live `?refresh=1` records `hub.task.diffstat { taskId, diffStat }` (stat only, the snapshot stays frozen). A completion snapshot is skipped when the result is `none`. `agent.git` needs absolute `root` and hex `base`/`head`, else it is ignored; relative `filesChanged` resolve against `Task.git.root`. Refused paths (outside any repo, `..`, symlink escapes) are dropped from `files` and named in `note`. With a recorded base that no longer exists the diff falls back to `history`. The hub version is 0.5.0.)

## v0.6 additions — Threads at scale
- `agent.spawned` data gains `parentAgentId?` (the engine's `AgentSpawnInput.parentAgentId`: set when a
  subagent spawned this one). `Agent` gains `parentId: string | null` (bound ids follow renames).
- (v0.6) **Choices: actionable outputs.** An agent that proposes options ends its final answer with a fenced
  block ` ```helm-choices ` containing a JSON array of `{ id, title, detail?, effort?: 'S'|'M'|'L', value?: 'low'|'medium'|'high' }`
  (≤ 30). The mod parses it on completion and emits `task.choices { taskId, choices }` (replaces the set; ids
  kept stable). The `mcp__helm__task` tool gains action `"choices"` (`id`, `choices`) that does the same.
  `Task` gains `choices: { id, title, detail, effort, value, state: 'open'|'picked'|'skipped', taskId: string|null }[]`
  (empty array when none).
  `POST /v1/tasks/:id/choices/apply` `{ picked: string[], start?: boolean }` → creates one task per picked
  choice (title = choice title, description = detail + "From T-n.", same project, `parentTaskId` = T-n),
  starts each when `start` (same rules and 409 handling as `/start`, per task, never failing the batch), marks
  picked → `picked` with its `taskId`, every other open choice → `skipped`; returns `{ tasks, choices, errors }`.
  `apply` also takes `notes?: { [choiceId]: string ≤500 }` and `message?: string ≤1000`; each created task's description is detail, `Note: …`, `Message: …`, `From T-n.` (so the start note carries them), and picked `choices[]` rows store `note` / `message` (hub.task.choices event data, rebuild-exact; reset clears them).
  `POST /v1/tasks/:id/choices/reset` → all back to `open` (created tasks stay). `Task` gains `parentTaskId: string | null`.
  Open choices count as "needs you" (Inbox kind `choices`, one entry per task with open choices).
  Open choices are not a `questions` row: clients derive the Inbox "Choices waiting" entries (kind `choices`, one per task)
  from `Task.choices` in `/v1/state`, so there is no second list to keep in sync. Commands are `hub.task.create` (with `parentTaskId`),
  `hub.task.start` and `hub.task.choices` events, so `--rebuild` is exact; `tasks.choices` / `tasks.parent_task_id` are additive migrations.
- **parentId storage**: the column is `agents.parent_id` (additive, nullable; `ALTER TABLE` on open, `helmd --rebuild` back-fills). A
  child's `parentId` follows the parent's pending -> bound rename; unknown parents are kept as-is.
- **Threads UI** (web): Tree (default) = one trunk per session, agents as orthogonal branches, newest first, in
  Live / Today (by hour, latest open) / Earlier ("Show older (N)") sections, sub-agents nested by `parentId`.
  Timeline = same rows and grouping against a time axis with duration bars. Both are virtualised (rows near the
  viewport only). Header controls: session picker (+ "All sessions"), status chips, model filter, search,
  density, Tree/Timeline; choices persist in `localStorage["helm.threads"]`. Keys: Up/Down move, Enter opens,
  Left/Right fold, `/` focuses search.

## v0.7 additions — Up next auto mode
- `Project` gains `autoStart: boolean` (default false). `PATCH /v1/projects/:id { autoStart }` (boolean, else 400)
  records it in the `hub.project.update` event and returns `{ project, autoStarted: string[] }` (task ids the hub started
  because of this very change). New `GET /v1/projects/:id` → `{ project }`. `/v1/state`, `/v1/projects` and the SSE
  `project` upsert all carry `autoStart`. `Task` gains `autoStartedAt: number | null` (set by an auto-start, cleared by a manual Start).
- **The rule.** The hub re-evaluates after every committed ingest or command and in every sweep. For each non-archived
  project with `autoStart` on: if no task is `in_progress` (review and blocked do not count) and nothing is "starting",
  it starts the top task in `next` (lowest `order`, then oldest `createdAt`) through the normal start logic (a queued
  session note on the project's live session; same session choice as v0.3 Start). "Starting" = a `next` task whose
  `startNoteId` note is `queued` or `sending`, or whose start note was created less than 3 minutes ago and has not failed
  (`HELM_AUTO_STARTING_MS`). At most one auto-start is in flight per project.
- **No live session** → nothing happens and nothing is recorded; the next ingest (e.g. `session.started`) or sweep retries.
- **Failed start** (the start note `failed`, including a `sending` timeout) → the project holds for 5 minutes
  (`HELM_AUTO_BACKOFF_MS`) measured from the failure, then retries the same top task (it never skips ahead). Clients show
  needs-you "Auto-start failed" for a `next` task with `autoStartedAt` whose start note failed.
- **Event** `hub.task.autostart { taskId, sessionId, text, reason }`: the decision is made before the event and carried in
  it (like the sweep), so `--rebuild` replays it without re-deciding and never emits events. Applying it is `hub.task.start`
  plus `autoStartedAt` and an Activity row `Auto-started: <reason>`.
- Migration: `projects.auto_start` and `tasks.auto_started_at` are additive, defaulted columns; `--rebuild` back-fills.
- Web: Up next header has a Manual | Auto switch (a project popover in All projects), a hint line while Auto is on, a
  "Next up" marker on the top card, a Spotlight "Toggle auto mode" command, and a toast `Auto mode on: starting T-n`.

## Phone access — quick-capture page and opt-in LAN listener
The hub only listens on `127.0.0.1` (and the unix socket) and refuses non-local Host/Origin, because it can inject prompts
into Claude sessions. Phone access is a separate, **off by default**, token-protected listener. Nothing about the loopback
behaviour changes.

- **Page**: `web/m/index.html`, `m.js`, `m.css`, served at `/m` (loopback needs no token: `http://localhost:7777/m`). Standalone, no
  imports. Project picker (remembered), New task (`POST /v1/tasks`, `start: true` for "Add & start"; a refused start comes back as
  `{ task, error }` and is shown), Note to session (`POST /v1/notes` with `execute: true`; the reply is read back from `/v1/state`),
  photo/file attach (`POST /v1/attachments`; a task carries the saved paths in its description, a note carries the ids), and a read-only
  "Needs you" list.
- **Control (loopback / unix socket only; 403 on the phone listener)**: `GET /v1/remote` → `{ enabled, port, token|null, url|null, urls[] }`;
  `POST /v1/remote { enabled: boolean }` → the same. Enabling generates (or reuses the saved) 32-byte base64url token and listens on
  `0.0.0.0:${HELM_REMOTE_PORT:-7778}` (`HELM_REMOTE_HOST` narrows it). Disabling closes the listener and **rotates the token**. A taken
  port is a 409. `urls[]` = `{ name, address, url: "http://<lan-ipv4>:<port>/m#k=<token>" }` from `os.networkInterfaces()`.
- **State**: `$HELM_HOME/remote.json` `{ enabled, token }`, mode 0600 (atomic rewrite). On start the listener returns only if `enabled`.
- **Gate on the phone listener** (every request, in this order): ban check (429) → 60 requests/min/IP (429 + `Retry-After`) →
  allow-list (403) → token (401) → router. Allow-list: `GET /m`, `GET /m/*`, `GET /v1/state`, `GET /v1/stream`, `POST /v1/tasks`,
  `POST /v1/notes`, `POST /v1/attachments`, `GET /v1/attachments/:id`; any path that changes under decoding/normalisation is 403.
  Token = `Authorization: Bearer <token>` or cookie `helm_k` (set by the page from the URL hash), compared in constant time. 5 failed
  auths from one IP within 10 min = 10-minute ban. The page shell (`/m`, `/m/`, `/m/index.html`, `/m/m.js`, `/m/m.css`) is served without a
  token because it is code, not data, and must load before it can read the hash. A mutating request with an `Origin` must match `Host`
  (cookie CSRF), and `Sec-Fetch-Site: cross-site` is refused. Every request is logged to `helmd.log` as `remote <METHOD> "<path>" <status> ip=<ip>`
  (never the token).
- **What the phone sees**: `GET /v1/state` on the phone listener is filtered to `{ projects, sessions, tasks, notes, seq }`: sessions without
  `cwd`; only tasks that need the user, each with `needs: string[]` (Review, N choices, Question, Waiting for you, Note failed, Auto-start
  failed); notes of those tasks plus notes created through the phone listener (replies included, attachment paths removed).
  `GET /v1/stream` carries `row: null` (the page refetches `/v1/state`).
- **Web**: Settings > Phone access: toggle, warning ("Anyone with this link on your network can add tasks and message your sessions."),
  the link, Copy, and a QR code from `web/qr.js` (own encoder: byte mode, level M, versions 1-10 = up to 213 bytes; a longer link falls back to text).

## v0.9 additions — Workflows (graphs of agents, checks, gates and reviews)

A **workflow** is a saved graph (`helm.workflow/1`); a **run** executes one pinned version of it. The hub is the engine: it
decides what runs next and queues **steps**; a live mod (any session) claims steps, does the work and reports back with
`wf.step.result`. The hub never calls a model. Everything below is built and tested (`hub/test/v09wf.test.mjs`).

### Rows
```ts
type Workflow = { id: string /* W-n */; projectId: string; name: string; currentVersion: number;
  createdAt: number; updatedAt: number; archived: boolean }
type WorkflowVersion = { workflowId: string; version: number; graph: Graph; author: 'user' | 'model'; summary: string;
  parentVersion: number | null /* the version it was saved on top of, or the one it restores */; createdAt: number }
type RunStatus = 'running' | 'paused' | 'waiting' | 'done' | 'failed' | 'aborted'
//  waiting = nothing is in flight: a gate is open, or a ready step has no live session. paused = by the user, or the budget.
type NodeState = 'pending' | 'ready' | 'queued' | 'running' | 'ok' | 'failed' | 'skipped' | 'waiting_gate' | 'abandoned'
type Run = { id: string /* R-n */; workflowId: string; version: number; projectId: string; status: RunStatus;
  params: Record<string, string>; driverSessionId: string | null; budgetUsd: number | null; costUsd: number;
  startedAt: number; endedAt: number | null; error: string | null;
  nodes: RunNode[] }                                   // inlined in /v1/state, GET /v1/runs and the SSE `run` row
type RunNode = { runId: string; nodeId: string; state: NodeState; attempt: number /* 0 until first queued */;
  taskId: string | null; agentId: string | null; startedAt: number | null; endedAt: number | null;
  output: Output | null; error: string | null; costUsd: number; questionId: string | null /* open gate question */ }
type Output = { ok?: boolean; text?: string; filesChanged?: string[]; taskId?: string;
  check?: { exitCode?: number; stdout?: string; stderr?: string; passed?: boolean; timedOut?: boolean };
  verdict?: 'pass' | 'changes' | null; findings?: string; approved?: boolean; comment?: string;
  gate?: { message: string; show: string; taskIds: string[]; files: string[] }; skipped?: true }
type Step = { id: string /* <runId>:<nodeId>:<attempt> */; runId: string; nodeId: string; attempt: number;
  kind: 'agent' | 'shell' | 'review'; sessionId: string; state: 'queued' | 'running' | 'done' | 'failed';
  input: StepInput; result: object | null; error: string | null; taskId: string | null;
  createdAt: number; claimedAt: number | null; doneAt: number | null; notBefore: number | null }
```
- `Run.costUsd` is exactly the sum of its nodes' `costUsd`; a node's cost is the sum of the usage rows booked against it.
- `Task` gains `runId: string | null` and `nodeId: string | null` (all task rows; `null` for ordinary cards).
- `Question` gains `kind: 'approval'`. Approval questions (only) carry `runId` and `nodeId`; other questions keep their v0.2 shape.
  `sessionId` of an approval question is the run's driver session. `POST /v1/questions/:id/dismiss` on an **open** approval is
  409 (`approve or reject it instead`); session end or agent completion never answers an approval. Search indexes it as
  `Approval: <message>`.

### Graph schema `helm.workflow/1` (validator: `hub/wfgraph.mjs`, dependency-free)
```jsonc
{ "schema": "helm.workflow/1", "name": "…",
  "params": [{ "key": "brief", "label": "What to build", "type": "text" | "line", "default"?: "…", "required"?: true }],
  "nodes": [{ "id": "build", "type": "agent|shell|gate|review|note", "label": "Build feature", "position": {"x":80,"y":160},
              "config": { … per type … }, "retry"?: {"max":0-5,"backoffMs":0-600000}, "timeoutMs"?: 1000-21600000, "sessionId"?: "…" }],
  "edges": [{ "id": "e1", "from": "build", "to": "test", "when": "ok" }] }
```
| type | config | notes |
|---|---|---|
| `agent` | `agent: 'builder' \| 'scout'` (default builder), `prompt` (required, templated), `cwd?`, `isolation?: 'worktree'` | builder = `helm:builder`/Sonnet, scout = `helm:scout`/Haiku |
| `shell` | exactly one of `argv: string[]` or `script: string` (run as `sh -c`), `cwd?`, `timeoutMs` (1000–600000, default 30000), `passIf: 'exit0' \| 'regex'`, `pattern?` (required with regex) | CLI only in the engine (see below) |
| `gate` | `message` (required, templated), `show: 'files' \| 'diff' \| 'text' \| 'none'` (default files) | opens an approval question; no retry/timeout/session |
| `review` | `rubric` (required, templated), `inputs: ('text'\|'files'\|'check')[]` (default text, files) | Opus via `model.complete` |
| `note` | `text` (markdown) | never executed, no edges, no run row |
- Edges: `when ∈ ok, fail, approved, rejected`; from a **gate** only `approved`/`rejected` (default `approved`), from every other node only `ok`/`fail`
  (default `ok`). Notes have no edges. No self edges; no two edges with the same (from, to, when).
- Validator rules (errors block save and run; warnings do not): unique node/edge ids (`^[A-Za-z0-9_-]{1,40}$`), known node types (unknown types are
  rejected, never dropped), valid config per type, `retry`/`timeoutMs` ranges, edge endpoints exist, **no cycles** (loops are phase 3), at least one entry
  node when there are executable nodes, templates resolve: `{{params.key}}` must be a declared param; `{{inputs.node.key}}` must name an **upstream**
  executable node that can produce `key` (agent: `text ok filesChanged taskId`; shell: `text ok check`; review: `text ok verdict findings`; gate: `approved comment`).
  Limits: 60 nodes, 200 edges, 256 KB. An empty graph is a warning (a blank workflow can be created and saved; it cannot be run).
- The stored graph is the validator's **normalised** copy (defaults filled, unknown config keys dropped with a warning, edge `when` defaulted).
- Template strings are rendered by the hub when it builds a step, so mods only ever see final text.

### Engine rules (decided in `hub/wfengine.mjs`, applied by `hub/workflows.mjs`)
- A node is **ready** when all its incoming edges are resolved and at least one is *taken*; an entry node is ready at once. An edge is taken when its source
  finished with the matching outcome: `ok`/`fail` for work nodes, `approved`/`rejected` for a gate, and a user-**skipped** node counts as ok/approved. If
  every incoming edge is resolved and none was taken, the node becomes `skipped` (no output) and its own outgoing edges are all dead. Several incoming edges
  mean "wait for all that can still arrive".
- A finished step becomes a node outcome: agent `ok` = `result.ok !== false`; shell `ok` is **re-derived by the hub** from `check` (`exitCode === 0`, or the
  `pattern` regex against stdout+stderr; a timeout fails) and only falls back to `result.ok`/`check.passed` when no exit code was sent; review `ok` =
  `result.ok !== false` **and** verdict `pass` (verdict = `result.verdict`, else the last `VERDICT: PASS|CHANGES` line of `text`; none = fail closed, `changes` = fail).
- **Failure**: while `attempt <= retry.max` the node goes `ready` again (error kept as `attempt N failed: …`) and a new step `attempt+1` is queued, preferring a
  different live session when one exists, delayed by `retry.backoffMs` (`Step.notBefore`; not claimable earlier). After the last retry the node is `failed`
  and follows its `fail` (gate: `rejected`) edge if there is one; **with none the run ends `failed`** (`error: "<label> failed: <reason>"`), in-flight nodes
  become `abandoned` and their steps fail `run failed`. A failed shell/review node gets a blocked Board card so the failure is visible.
- **Run controls** (`pause` only while running/waiting; `resume` only while paused): pause holds *new* work (queuing, gates, retries); results still land and
  nodes settle. `abort` marks active nodes `abandoned`, fails queued/running steps (`run aborted`), answers open gate questions, run `aborted` (final).
  `retry` (node `failed`/`abandoned`) and `skip` (also `pending`/`ready`) are refused 409 once any later step has started; a retry/skip on a `failed` run reopens it
  (`running`). A late `wf.step.result` never revives an aborted run (the step is already failed).
- **Budget**: `budgetUsd` is checked before each launch; once `Run.costUsd >= budgetUsd` the run pauses with `error: "budget reached ($X)"`. `resume` then lifts the limit.
- **Driver session**: at run start `sessionId` (must exist and not be `ended`, else 404/409) or the Jobs rule (project's newest active/idle session, else any
  active; none → **409 `no live session`**). A node's `sessionId` pins its steps (not running → the node fails at once, no retry); otherwise steps go to the
  driver, re-picked (and `Run.driverSessionId` updated) when it has ended. No live session → run `waiting` with `error: "waiting for a live session"`.
- **Timeouts / liveness** (hub sweep, every 30 s and after every committed ingest/command): a *queued* step older than `HELM_JOB_MS` (default 5 min; from
  `max(createdAt, notBefore)`) fails `not picked up by a live session`; a *running* step older than `node.timeoutMs + 60 s` (shell: `config.timeoutMs + 60 s`;
  default `HELM_STEP_MS` = 60 min) fails `timed out`; any queued/running step whose session is `ended` fails `session ended`. Paused runs do not time out queued
  steps. A failed step is final: a late result for it is ignored (the node may already have retried).
- **Restart**: all state is in SQLite. After a restart the hub re-evaluates live runs on start, in the sweep and after the next commit; nothing is re-queued
  and no step is created twice (a node has at most one non-final step; step ids are `<runId>:<nodeId>:<attempt>`).

### Mod step runner contract (what the mod implements)
**Claim** — `GET /v1/sessions/:id/steps` → `{ steps: Step[] }`. Atomically moves this session's **due** `queued` steps (run `running`/`waiting`, `notBefore` passed)
to `running` (`claimedAt` set) and returns them oldest first. Poll in the existing 2 s tick; a hub without the endpoint answers 404 → re-check every 60 s
(never break the mod). Like `/inbox` and `/jobs` this GET mutates, so it carries the CSRF guard. Never execute a step that was not claimed.

**`Step.input`** (always `runId`, `nodeId`, `attempt`, `label`; everything templated is already rendered):
| kind | fields | how to run it |
|---|---|---|
| `agent` | `agent` `'builder'\|'scout'`, `subagentType` (`helm:builder`/`helm:scout`), `model` (`sonnet`/`haiku`), `prompt`, **`description`** = `"[helm:T-n] <label>"`, `taskId`, `cwd?`, `isolation?: 'worktree'` | `$.agent.spawn({ prompt, description, subagentType, model, cwd })`. The hub already created card `taskId` (status `in_progress`, `Task.runId`/`nodeId` set); the **tag in `description`** makes the existing `agent.spawned` handler bind to it, so no second card appears and the card lifecycle (`agent.completed` → review/blocked) is unchanged. Remember `agentId → stepId`; when the agent's `turn.complete` arrives report the result. |
| `shell` | `argv?: string[]` **or** `script?: string`, `cwd?`, `timeoutMs`, `passIf: 'exit0'\|'regex'`, `pattern?` | `$.process.run(argv or ['sh','-c',script], { cwd, timeoutMs })`. CLI only: in the desktop app degrade to a `helm:scout` agent told to run it and report the exit code (flag it, it costs tokens). Report raw `check`; the hub decides pass/fail. |
| `review` | `model: 'opus'`, `system`, `prompt`, `maxTokens` (4096), `timeoutMs`, `rubric` | `$.model.complete({ model, system, prompt, maxTokens, timeoutMs })`; send the answer as `text` (it ends with `VERDICT: PASS` or `VERDICT: CHANGES`) and the exact `usage`. `isAnswered` false → `ok:false` with the reason as `error`. |

**Result** — mod event `wf.step.result` (the **only** `wf.*` type a mod may send; every other `wf.*` and `hub.*` type is rejected at ingest):
```ts
{ stepId: string; ok: boolean;                      // ok:false = the step failed (error says why)
  text?: string;                                    // agent: final answer; shell: combined output (optional, derived from check); review: the model's reply (≤ 8000 chars kept, tail)
  filesChanged?: string[];                          // agent: from the FILES: line (≤ 200)
  check?: { exitCode: number; stdout: string; stderr: string; passed?: boolean; timedOut?: boolean };  // shell (stdout/stderr tail 4000 each)
  verdict?: 'pass' | 'changes'; findings?: string;  // review (optional: the hub also parses `text`)
  agentId?: string; taskId?: string; error?: string;
  usage?: { model: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd: number } }
```
- **Idempotent by `stepId`**: the first result for a step in `queued`/`running` wins; later ones (and results for unknown steps) are ignored, so the outbox may replay freely.
  The event's `sessionId` is whoever reports it; it is not checked against `Step.sessionId`.
- `usage` is booked as one usage row against the node: kind `wf_review` for a review step, `wf_step` otherwise (`runId`/`nodeId`/`taskId` filled in). If the mod
  prefers to report cost separately it may send `helm.usage` instead — **one or the other for a given cost, never both**.
- **Usage events** — `helm.usage` gains optional `runId`, `nodeId` and kinds `wf_step | wf_review | wf_draft`. Rows with both ids add to that run node and the run
  total (ids that match no run node still book the row, nothing else). Cost meter: `wf_step` counts as *requested* work next to `note_turn`; `wf_review` and
  `wf_draft` are overhead. `agent.completed.costUsd` is accepted and **ignored** (it would double-count).
- Time limit for the mod to answer a claimed step: see Timeouts above. If the session ends, its steps fail `session ended`.

### Events recorded in the log (session `_hub`; replay applies them and never decides)
| type | data | effect |
|---|---|---|
| `wf.created` | `{ projectId, name, graph, author, summary }` | Workflow `W-n` + version 1 |
| `wf.saved` | `{ workflowId, graph, author, summary, parentVersion? }` | version n+1, `currentVersion` moves |
| `wf.updated` | `{ workflowId, name?, archived? }` | rename / archive |
| `wf.run.started` | `{ workflowId, version, projectId, params, driverSessionId, budgetUsd }` | Run `R-n`, one `pending` RunNode per executable node |
| `wf.run.status` | `{ runId, status, error?, budgetUsd?, reopen? }` | non-final status changes (`paused`, `waiting`, `running`) |
| `wf.run.finished` | `{ runId, status: 'done'\|'failed'\|'aborted', error? }` | final |
| `wf.node.state` | `{ runId, nodeId, state, attempt?, output?, error?, taskId? }` | the engine's decision about a node; terminal states stamp `endedAt` and settle its card (`ok`/user-skip → done, `failed` → blocked with the reason, `abandoned` → blocked "run stopped") and answer its gate question |
| `wf.step.created` | `{ stepId, runId, nodeId, attempt, kind, sessionId, input, taskId, notBefore?, driverSessionId? }` | Step `queued`; node → `queued` |
| `wf.step.claimed` | `{ ids, sessionId }` | steps → `running`, nodes → `running` |
| `wf.step.failed` | `{ stepId, error }` | hub-decided failure (timeout, session ended, abort) |
| `wf.step.result` | mod event above | step → `done`/`failed`, usage booked; the engine then settles the node |
| `wf.gate.opened` | `{ runId, nodeId, message, show, taskId, taskIds, files }` | approval Question `Q-n`, node `waiting_gate` (`output.gate` = the context), gate card → Review |
| `wf.gate.decided` | `{ runId, nodeId, decision: 'approve'\|'reject', comment? }` | node `ok` (output.approved true) or `failed` ("rejected: …"), question answered, gate card → done |
| `hub.task.create` | gains `runId?`, `nodeId?` | cards made for a run |
Because every decision is an event, `helmd --rebuild` reproduces runs exactly (`dump()` of the five workflow tables is identical; tested).

### Board and Inbox
- Agent nodes get a card when their first step is queued: title = node label, description = rendered prompt + `(Workflow run R-n, step id)`, status `in_progress`,
  `dependsOn` = cards of its direct upstream nodes. Retries reuse the card. When the node finishes **ok** the card moves to **done** (it was consumed by the
  workflow); a failure blocks it. (Note for Auto mode: a running agent card counts as `in_progress`, so a project's Up next waits for it.)
- A gate gets a card (`Approve: <label>`, status **review**, `Task.runId/nodeId`) and an open approval Question. `needsYou()` for that card reads *Approval needed*.
  Web: Board card chip `R-n · node`, a green Approve button on the card, "Group by run" toggle (one collapsible header per run, `R-n <workflow> (done/total)`), Inbox
  row with Approve / Reject (+comment) and "Open run".

### Endpoints
- `GET /v1/workflows?projectId=` → `{ workflows }` · `POST /v1/workflows` `{ projectId, name?, graph?, template?: 'build-test-review', author? }` → 201 `{ workflow }`
  (no graph/template = an empty canvas; invalid graph → **400 `{ error, issues[] }`**; `issues[i] = { level: 'error'|'warn', code, message, nodeId?, edgeId?, field? }`)
- `POST /v1/workflows/validate` `{ graph }` → `{ ok, issues }` (never fails on a bad graph)
- `GET /v1/workflows/:id` → `{ workflow, versions: WorkflowVersion[] /* newest first, with graphs */ }`
- `PUT /v1/workflows/:id` `{ graph, summary? }` → `{ workflow, version }` (new version, `author: 'user'`, summary default `Edited`; a graph identical to the current one → `{ …, unchanged: true }` and no new version; 400 with issues)
- `PATCH /v1/workflows/:id` `{ name?, archived? }` → `{ workflow }` · `POST /v1/workflows/:id/restore` `{ version }` → `{ workflow, version }` (new version `Restored vN`, `parentVersion: N`)
- `POST /v1/workflows/:id/run` `{ version?, params?, sessionId?, budgetUsd? }` → 201 `{ run }`. 400: invalid version/graph, unknown or missing required param, bad budget;
  404 unknown session/version; 409 archived workflow, session ended, **no live session**.
- `GET /v1/runs?workflowId=&status=a,b` → `{ runs }` (newest first, ≤ 200, nodes inlined) · `GET /v1/runs/:id` → `{ run, nodes, steps }`
- `POST /v1/runs/:id/pause | resume | abort` → `{ run }` (409 in the wrong state) · `POST /v1/runs/:id/nodes/:nodeId/retry | skip` → `{ run }` (404 unknown node, 409 wrong state / later steps started)
- `POST /v1/runs/:id/gates/:nodeId` `{ decision: 'approve' | 'reject', comment? ≤ 1000 }` → `{ run }` (409 when the gate is not waiting)
- `GET /v1/sessions/:id/steps` → `{ steps }` (the mod claim, above)
- `/v1/state` gains `workflows` (all, archived flagged) and `runs` (every active run plus the last 20 finished, nodes inlined); both honour `?projectId=`.
  SSE entities `workflow` (Workflow row) and `run` (Run row with `nodes`); a run row is re-sent on every change to it, its nodes or its cost.
  Search results gain `kind: 'workflow'` (title = name, body = step labels and prompts, `projectId` set).
- Sweep additions: see Timeouts. New config: `HELM_STEP_MS` (`stepMs`, default 60 min). Hub tests: 178 (26 new).

### Migration
Opening an older database creates `workflows`, `workflow_versions`, `runs`, `run_nodes`, `steps` and adds nullable `tasks.run_id/node_id`, `questions.run_id/node_id`,
`usage.run_id/node_id` in place (idempotent; tested by dropping them). Old rows read back with `runId`/`nodeId` null. No old event mentions a run, so `--rebuild`
back-fills nothing.

### Web (as built)
`#/workflows[/:id][?run=R-n&tl=0]`. Left: workflows (New / New from template, rename, duplicate, archive) and the selected workflow's runs. Middle: toolbar (name,
version history with restore, undo/redo, tidy, problems, Runs, Save with a summary prompt, Run with params/session/budget), palette (drag or click), dotted-grid canvas
(pan by drag or Space-drag or wheel, ⌘/ctrl-wheel and pinch zoom to the cursor, Fit / 100%, marquee with ⇧-drag or the Select tool, snap to 16 px, ⌘C/⌘V/⌘D, Delete, arrows nudge 8 px,
⌘Z / ⇧⌘Z, `/` quick add, double-click quick add), SVG edges labelled by kind, drag from a step's right dot to connect (then choose the kind), minimap. Right: inspector
(per-type forms with inline validation, connection editor, run inputs, problems). Run mode shows the exact version a run started on, read-only, with node states, flowing/pulsing
edges, a ticking cost, inline Approve/Reject on gates and Retry/Skip on failures; the **Dock `run` panel** (order 0.7) is the timeline. Files: `web/views/workflows.js`,
`web/wf/{graph,canvas,palette,inspector,results,runpanel,rundata,labels,pop}.js`, `web/wf.css`.

## v0.10 additions — workflows by prompt, templates

The hub still never calls a model. Drafting is a Job (the v0.2 mechanism): the mod claims it from `GET /v1/sessions/:id/jobs` and answers with a `job.result` event.

### Endpoints
- `GET /v1/workflows/templates` → `{ templates: [{ id, title, description, icon, name, graph }] }`. Ids: `build-test-review`, `fix-bug`, `research-build`, `parallel-refactor`, `safe-migration`. `POST /v1/workflows { projectId, template: <id> }` creates any of them. `parallel-refactor` is sequential (no parallel or join node yet); `fix-bug` unrolls its retry loop (fail goes to a second and third fix step, at most 2 loop-backs).
- `POST /v1/workflows/draft { projectId, prompt, workflowId? }` → `{ job }`. `prompt` is 1..4000 chars. 404 unknown project/workflow, 400 workflow of another project, 409 `no live session` (same session rule as explain/digest). With `workflowId` the job asks for a modified version of that workflow.

### `wf_draft` job
`Job.kind = 'wf_draft'`, `Job.projectId` set, `Job.taskId` null. `Job.input`:
```
{ prompt, projectName, attempt: 1 | 2,
  schema,      // text: compact description of helm.workflow/1 (node types, config fields, edge kinds, params, positions, rules)
  nodeTypes,   // [{ type, summary, config, outputs }]
  examples,    // two complete example graphs (JSON objects)
  workflowId?, current?,   // modify mode: the current graph of that workflow
  fixIssues?, previousText? // attempt 2 only: validator errors [{ level, code, message, nodeId?, edgeId? }] and the previous reply }
```
**What the mod must send:** `{ sessionId, seq, type: 'job.result', data: { jobId, ok: true, text } }` where `text` is the model's reply containing exactly one JSON object, the complete graph (`{ "schema": "helm.workflow/1", "name", "nodes", "edges", "params"? }`), optionally inside one ``` fence or with a sentence around it. On attempt 2 the model must return the corrected full graph. For modify requests it returns the complete modified graph, not a patch. `position` and edge `id` may be omitted (the hub lays out left to right and numbers edges); the `schema` tag may be omitted. If the model call fails: `{ jobId, ok: false, error }` (the job fails, no retry). Suggested model: Sonnet (Haiku for small edits), `maxTokens` generous (8k+).

### What the hub does with the reply
The reply is stored on the job (still `running`), then judged right after the commit (`hub/wfengine.mjs finishDraft`), recorded as events:
- extract JSON, fill positions/ids, `wfgraph` validate.
- **valid**: `wf.created` (new workflow, `author: 'model'`) or `wf.saved` (new version of `workflowId`, name kept, `parentVersion` = previous) with `summary` = the prompt shortened to 80 chars; then `hub.job.finish`: `Job.state = 'done'`, `Job.result = JSON '{"workflowId","version"}'`. If the graph equals the current version in modify mode, no version is made and `result` has `"unchanged": true`.
- **invalid, attempt 1**: a follow-up `wf_draft` job (same session if live) with `attempt: 2`, `fixIssues`, `previousText`; the first job ends `done` with `result = '{"retryJobId","issues"}'`.
- **invalid, attempt 2**: `Job.state = 'failed'`, `Job.error` = first issue (+N more), `Job.result = '{"issues":[...]}'`. No third attempt.
New event type `hub.job.finish { jobId, state, result?, error? }` (hub only). `job.result` for a `wf_draft` job no longer completes the job by itself. `helmd --rebuild` replays all of it without deciding again.

## v0.11 additions — task templates

Save a task (brief, preferred agent, checks) once and start it in one click. The hub still never calls a model.

```ts
type TaskTemplate = {
  id: string;                         // 'TT-n' (counter TT)
  projectId: string | null;           // null = available in every project
  name: string; title: string; description: string;   // title/description may contain {{var}} placeholders
  agent: 'builder' | 'scout' | 'auto';
  checks: string[];                   // short acceptance / verification items (max 20, 300 chars each)
  tags: string[];                     // lower-case, max 10
  usage: number; lastUsedAt: number | null;
  createdAt: number; updatedAt: number; archived: boolean;
}
```

### Endpoints
- `GET /v1/templates?projectId=&includeArchived=1` → `{ templates }`. With `projectId`: that project's templates plus the global ones (404 unknown project). Archived ones only with `includeArchived`.
- `POST /v1/templates` → 201 `{ template }`. Either fields `{ name, title, description?, agent?, checks?, tags?, projectId? }` (`projectId` omitted/null = global), or `{ fromTaskId }` which captures a task: `name` and `title` = the task title, `description`, `agent` from the subagent type of the task's last agent (`builder`/`scout` if it contains that word, else `auto`), `projectId` = the task's project (send `projectId: null` for global). Any field in the same body overrides the captured one. 400 invalid, 404 unknown task/project.
- `PATCH /v1/templates/:id` → `{ template }`; any field above plus `archived: boolean` (un-archive restores it).
- `DELETE /v1/templates/:id` → archives (200 `{ template }`); templates are never removed.
- `POST /v1/templates/:id/use { projectId?, vars?, start? }` → 201 `{ task, template, note? }`. `projectId` defaults to the template's own project and is required for a global one (a project template used for another project is 400; archived is 409). `vars` is an object of strings.
  - Title and description: every `{{var}}` (whitespace inside the braces allowed) is replaced by `vars[var]` (trimmed); a missing or blank value falls back to the variable's own name (`{{area}}` becomes `area`). The `checks` are filled the same way.
  - The description then gets `\n\nChecks:\n- <check>…` (when there are checks) and `\n\nPreferred agent: helm:builder|scout` (unless the agent is `auto`).
  - The task is created in `backlog`. With `start: true` it is started by the `/start` rule (same note text, drafts folded, same 409s). If the start is refused (no live session) the whole command is rolled back: **no task, no usage increment**, 409 `{ error: 'no live session' }`.
  - `usage` += 1 and `lastUsedAt` = now on success.

### State, events, search
- `/v1/state` gains `templates` (all of them, archived included; scoped to global + that project with `?projectId=`). SSE entity `template` (`upsert` only; archive is an upsert with `archived: true`).
- FTS: kind `template`, title = name, body = title + description + checks + tags; archived templates leave the index. Search results carry `projectId` (null for global).
- Events (session `_hub`): `hub.template.create { projectId, name, title, description, agent, checks, tags }`, `hub.template.update { id, patch }`, `hub.template.used { id }`. A use is `hub.task.create` [+ `hub.task.start`] + `hub.template.used`, all in one transaction, with the rendered text carried in the events, so `helmd --rebuild` is exact.
- Migration: the `templates` table (and its project index) is created on open by `CREATE TABLE/INDEX IF NOT EXISTS`, empty and safe on a live database. No old event mentions templates, so `--rebuild` back-fills nothing.
- `--seed` adds three global templates: "Fix a bug in {{area}}", "Add tests for {{module}}", "Polish UI of {{screen}}".

### Web
- Task details: a bookmark button opens "Save as template" (name, title, brief with `{{var}}` highlighted, checks, preferred agent, scope This project / All projects). The brief uses the Code mode editor when Code mode is on.
- Board composer: a Templates button opens a searchable popover (most used, then most recent); blanks are asked inline, then Create or Create & start (a template without blanks has both buttons on its row).
- `#/templates` (sidebar, under Learn): list, edit, duplicate, archive/restore, usage counts. Spotlight: `>template` (command "Start from template…") and template names in normal search.

## Review queue (web only; no hub change)
- `#/review[/T-n]`: tasks with `status: 'review'` in the project scope, ordered by when their agent finished (`Agent.endedAt`, else `Task.updatedAt`), oldest first by default.
- Approve = `PATCH /v1/tasks/:id { status: 'done' }` (a workflow gate card uses `POST /v1/runs/:id/gates/:node` instead). Later = `{ status: 'later' }`.
- Request changes = `POST /v1/notes { target: { kind: 'task', id }, text: '!Please change:\n- …', execute: true }`. The leading `!` skips the cheap-answer path (v0.4), so the live agent or a follow-up builder always gets it; the card leaves Review when that agent spawns.
- Ticks on the `Checks:` list and the "Reviewed today" count are UI state in localStorage (`helm.review.checks.<T-n>`, `helm.review.today`), never sent to the hub.
