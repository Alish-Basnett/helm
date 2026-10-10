# Changelog

All notable changes to Helm are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Shapes and endpoints are defined in `CONTRACT.md`.

## [0.5.0] - 2026-10-10

### Added

- Git diffs per task: the mod records each agent's git base at spawn (`git stash create`, or HEAD when
  the tree is clean). The hub serves `GET /v1/tasks/:id/diff` in snapshot, live, history (approximate,
  for tasks with no recorded base) or none mode, freezes a snapshot when the agent completes, and keeps
  `Task.diffStat`.
- Files changed in task details: the label shows `N files +A −D`, each file is a collapsed row with a
  status badge and `+a −d`, and expanding a row shows a unified diff with line numbers. A refresh button
  recomputes the diff live.
- The Dock: Talk, Task details and a new Task chat panel sit side by side, and extra panels fold into
  tabs on narrow screens. Notes move into the Task chat panel, the task's own chatbox.
- Task links: every `T-n` in Talk, replies, notes and activity renders as a chip that opens that task's
  details and chat while Talk stays open.

### Fixed

- Web files are served with `no-store`, so a browser can't mix stale and new modules after an update.

## [0.4.0] - 2026-10-10

### Added

- Attachments: drag and drop or paste files and images into any note composer or Talk. They are stored in
  `~/.helm/attachments/` and handed to the agent as file paths it can read.
- Cheap answers: a question on a task (ends with `?` or starts with what/why/how/...) is answered by one Haiku
  call over the task's record instead of waking or spawning an agent (about $0.0002 instead of $0.05-0.30).
  Start a note with `!` to send it to the agent anyway.
- Helm overhead meter: Helm's own model calls are recorded as `helm.usage`. The header shows today's
  overhead, and the popover splits overhead from work requested through Helm.
- Short-first replies with a "Show full" toggle, and activity rows that expand to their full text.
- The dashboard reloads itself when the hub serves newer web files (`/v1/health` gains `webBuild`).

### Changed

- Recaps are parsed from the builder's own DONE/HOW/LEARNED/TAGS report lines at no cost, and Haiku runs
  only as a fallback.
- Replies to Helm notes are asked to be 1-2 sentences, and the orchestration prompt is shorter.
- The cost meter prices cache writes at 1.25x input, and an unknown model is priced as Opus so the meter
  never under-counts.

### Fixed

- Replies not appearing in a stale dashboard tab (the tab now reloads after an update).

## [0.3.0] - 2026-10-10

### Added

- Note replies: `Note` gains `reply` and `repliedAt`. The `note.reply` event stores the answer, adds a
  `note` activity entry and indexes the reply in search. The mod sends it from the main agent's answer
  for a session note, or from the agent's final answer for a task note.
- Start: `POST /v1/tasks/:id/start` queues a session note that tells the live session to delegate the
  existing task with `[helm:T-n]`. Allowed from `backlog`, `next`, `later` and `blocked`; sets the task
  to `next` and records `startNoteId`. Returns 409 `no live session` when none is available.
- Create & start: `POST /v1/tasks` accepts `start: true`. If the start is refused, the task is still
  created and the response carries `error`.
- Start button on board cards (key `S`) and in the task sheet.
- Create & start button in the board composer (`⌘↵`).
- Talk: the session's notes shown as a thread with Claude's replies, as a right-hand Talk sheet with a
  session picker and inline on the Threads main node.
- `POST /v1/notes` accepts `execute: true` to create and queue a note in one call.

### Changed

- Notes show the reply under the note, with a "waiting for reply" line for 15 minutes after delivery.
- Pre-v0.3 databases are migrated in place. Run `node hub/helmd.mjs --rebuild` to back-fill replies
  from history.

## [0.2.0] - 2026-10-10

### Added

- Conflict radar: `tool.called` carries `files`; the hub tracks which agents touch the same path and
  exposes `Task.conflicts` and `GET /v1/conflicts`. The web app shows a radar strip.
- Questions inbox: `AskUserQuestion` calls and agents in the `waiting` status open a `Question`;
  answered when the call finishes or the agent resumes. `GET /v1/questions`, dismiss endpoint, and an
  Inbox view with "waiting for you" markers.
- Jobs: the hub queues model work that a live mod claims through `GET /v1/sessions/:id/jobs` and
  reports with `job.result`. Stale queued and running jobs fail after `HELM_JOB_MS` (default 5 min).
- Explain job: `POST /v1/tasks/:id/explain` fills `Task.explainer`; "Explain deeper" in the web app.
- Digest job and digests: `POST /v1/digest`, `GET /v1/digests`, and a digest card in Learn.
- In-session band and `/helm-pane` pane, for the terminal and the desktop app.
- Replay: step through a finished task's activity in the web app.
- Obsidian export of the learning log, off by default, behind the `obsidianExport` `userConfig` toggle
  (writes to `ClearFlow/Learning/`).
- `Session.costUsd` from the heartbeat, shown as a cost meter.
- Search indexes questions, explainer text and digests.
- Mod tests (39), UI tests (11) and hub tests (78).
- Installed at user scope from the `helm-local` marketplace.

### Changed

- The mod reports `files` on `tool.called`, not only on `tool.finished`.
- Files changed also come from the builder's `FILES:` report line, since edits made through Bash never
  reach Edit or Write.
- A hub restart no longer leaves a stub "Unassigned" session: the hub moves it into its real project on
  `session.started`.
- Notes stuck in `sending` for 10 minutes (`HELM_SENDING_MS`) become `failed` with
  `delivery unconfirmed — retry`.
- Agent and mod tick hardening: note delivery is fire-and-forget, the tick has a 20 s watchdog, and the
  outbox persists on its own timer.
- Opening a v0.1 database adds the new tables and columns in place.

### Fixed

- A main-session note blocked the mod's tick for the whole turn and froze the board feed.
- A hub without `/jobs` made the mod stop asking until reload; it now re-checks every 60 s.
- Plugin tool `result` must be a string or array, not an object.
- `/clear` ended the session with no new `session.start`; the mod now rebinds to the new session id.
- A missing recap is rebuilt from the hub activity log (backfill), and the reconciler emits missed
  completions.
- Known gap: the file list of T-1 was lost in the early freeze, before the fix.

## [0.1.0] - 2026-10-10

### Added

- Mod (`hooks/register.ts`): sensors for session, turn, agent and tool events; model routing
  (`helm:builder` to Sonnet, `helm:scout` and Explore to Haiku); the `helm:builder` and `helm:scout`
  agent types; the `mcp__helm__task` tool; `/helm open|join|status`.
- Outbox with idempotent `(sessionId, seq)` replay, a reconciler against `$.agent.list()`, and hub
  auto-start.
- Hub (`hub/helmd.mjs`): zero-dependency Node 24 daemon on `node:sqlite` (WAL, FTS5) and `node:http`,
  listening on a unix socket and TCP port 7777. Append-only event log, projections, SSE stream, stall
  sweep, and the REST API in `CONTRACT.md`.
- Web app (vanilla ES modules, no build step): Board with Backlog, Up next, In progress, Review, Done,
  Saved for later and Blocked; Projects; Office; Threads; Learn; Spotlight search (`⌘K`).
- Notes with Execute: main-session notes go through `$.prompt.submit`, live subagents through
  `$.session.send`, and finished tasks through a follow-up `helm:builder` spawn.
- Per-task recaps (What, How, Learned) written by Haiku.
- Hub tests (58 at the end of phase 1).

### Fixed

- Twelve findings from a scout review of the mod against the API types, including non-blocking hub
  calls (4 s timeout), `prompt.submit` using `asUser`, and `agent.completed` deduplication.
- The Done column was clipped at 1440 px.
