# Changelog

All notable changes to Helm are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Shapes and endpoints are defined in `CONTRACT.md`.

## [0.13.0] - 2026-10-10

### Added

- Create workflows by describing them (a Sonnet draft opens on the canvas), Change with words, five templates.

### Fixed

- Auto mode double starts; in-flight jobs and steps resumed after a mod reload; Workflows screen crash on load.

## [0.12.0] - 2026-10-10

### Added

- Mod step runner: live sessions claim workflow steps and run them. Agent steps go to a Sonnet or Haiku agent bound
  to the step's card, shell steps run the command, and review steps make an Opus call. The agent's cost is booked
  to the run. Verified end to end: builder → `node --test` → gate approved in the canvas → Opus review PASS.
- Opening a workflow that has a live or waiting run shows that run's overlay automatically.
- Workflows (hub + web, contract v0.9): a canvas for graphs of agent, shell-check, gate, Opus-review and note steps with ok / fail / approved /
  rejected edges and retry; versions with a summary and restore; a deterministic run engine in the hub (steps queued per live session, claimed
  through `GET /v1/sessions/:id/steps`, results reported as `wf.step.result`); gates that open an approval question and are decided from the
  canvas, the Inbox or the Board card; pause, resume, abort, retry and skip; per-run budget; cost rolled up from `helm.usage` rows that carry
  `runId` and `nodeId`; a run timeline in the Dock; a run chip and a "Group by run" toggle on the Board. One built-in template
  (Build, Test, Gate, Review, Merge). The mod's step runner is a separate task.

## [0.11.0] - 2026-10-10

### Added

- Notes before Start: on a task that hasn't started, an "Add details before starting" box collects draft
  notes, listed as "Will be sent with Start (N notes)". Starting the task (from the panel, the board card,
  Create & start, Choices or Auto mode) folds them into the start brief and marks them sent. Start reads
  "Start with N notes", and the card's Start button shows the count.

## [0.10.0] - 2026-10-10

### Added

- Cost and usage analytics: `GET /v1/usage/breakdown` totals spend per day, project, model and task from `helm.usage`
  (plus each project's session cost), and the cost meter popover gains Day / Project / Model / Task tabs.
- Auto mode for Up next (per project, kept in the hub): when nothing is in progress, the top Up next task starts
  by itself, one at a time, with a 5-minute backoff after a failed start. Adds a Manual | Auto switch, a
  "Next up" marker, "Auto-started" in the activity log and an "Auto-start failed" needs-you reason.
- Code mode now also covers the task description (view and editor) and every notes panel and note box.

- Phone quick capture at `/m` (`web/m/`): add a task (with or without starting it), send a note to a live session and read the
  reply, attach a photo or file, and see what needs you. Works on the Mac at `http://localhost:7777/m`.
- Phone access (Settings > Phone access), off by default: `POST /v1/remote { enabled }` (loopback only) opens a token-protected
  LAN listener on port 7778 with a route allow-list, rate limiting, a ban after repeated bad tokens and request logging. The link
  comes with a QR code from a small built-in encoder. Switching it off closes the port and rotates the token.

## [0.9.0] - 2026-10-10

### Added

- Minimise panels: each side panel and the floating Talk has a minimise button that tucks it into a slim
  shelf on the right edge without losing its state (drafts, scroll position, diff tab). `M` or ⌘/Ctrl+.
  minimises everything at once, and pressing it again restores the same layout. Chips restore on click,
  close on ×, and ⌥1–9 restores chip N. The shelf persists across reloads.

## [0.8.0] - 2026-10-10

### Added

- Diff panel: clicking a file in Files changed opens its diff in its own resizable Dock panel, with a tab
  per file (`+a −d`), unified and split views with aligned changes, syntax highlighting, wrap, Copy path,
  Copy diff and an "Open in editor" link. The open file is kept in the URL (`&diff=`), and very long
  diffs load in chunks.
- Detachable Talk: pop Talk out of the Dock into a floating window you can drag anywhere and resize from
  any edge or corner (⇧T, or the header button). It keeps drafts, scroll position and code mode, and
  remembers its position.
- Threads timeline: the axis fits the visible rows automatically, with − / + / Fit zoom, ⌘-scroll zoom
  around the cursor, panning, tick marks that adapt to the zoom level, and bars of at least 3px.

## [0.7.1] - 2026-10-10

### Fixed

- The dashboard no longer reloads under you. A newer web build waits until its files have been stable
  for 15 seconds. It then reloads only if you're idle; otherwise a "Helm updated · Reload" pill appears.
- What you type in Talk, Task chat and notes is saved as a draft per target and restored after any
  reload or re-render, until you send it.

## [0.7.0] - 2026-10-10

### Added

- Settings page (`#/settings`): theme, accent colour, text size, density, and Code mode with a live preview.
- Code mode: Talk and Task chat render as syntax-highlighted code (JavaScript, TypeScript or Python). Your
  messages appear as variables and replies as doc comments, task links as identifiers and attachments as
  imports. The composer is highlighted live, and code mode can be switched off at any time.
- Board: cards that need you (choices, questions, waiting agents, failed notes, review) glow amber with a
  "Needs you · reason" pill and sort to the top of their column. Adds column counts, a "Needs me" filter
  and a `y` key that jumps to the next one.
- Choices: an optional note per choice and a message sent with the selection. Both go into each created
  task's brief and stay visible on the card.

## [0.6.0] - 2026-10-10

### Added

- Choices: when an agent's output proposes options, they appear as a checklist at the top of the task
  panel. Tick what you want and choose "Create & start selected": each pick becomes a linked task and is
  delegated. Agents emit a ` ```helm-choices ` block, and the `task` tool gains a `choices` action.
  Waiting choices show as a Board chip, an Inbox group and a Spotlight command.
- Threads redesign: a git-graph style tree (newest first, live agents pinned, finished agents grouped by
  hour, subagents nested under their parent) and a Timeline view with duration bars. Rows are virtualised
  for hundreds of agents. Adds filters, search, density, an all-sessions view and keyboard navigation.
- Resizable dock panels: drag or use the keyboard on each panel's left edge, double-click to reset.
  Widths are saved per panel.
- `Agent.parentId` (from the engine's `parentAgentId`) and `Task.parentTaskId`.

### Changed

- The hub no longer logs a "seq gap" warning for the mod's clock-based sequence numbers.

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
