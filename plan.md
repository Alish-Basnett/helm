# Helm — mission control for Claude Code

A Claude Code mod + local hub + web app that turns every session into a live,
self-updating kanban, with an Office view of all sessions and their subagents,
Threads you can step inside, per-task learning recaps, notes you can execute,
and a global spotlight search.

Started 2026-10-10.

## Decisions (defaults taken when "go" was given — change any time)

| Decision | Default |
|---|---|
| Name | **Helm** |
| Where it lives | `~/WebDev/builtbyAlish/helm` (git repo), installed at user scope from the local marketplace `helm-local` (read from the folder itself) |
| Learning log to Obsidian | Off by default, a `userConfig` toggle (`obsidianExport`) writing to `ClearFlow/Learning/` |
| Extras | All six kept (conflict radar, questions inbox, cost meter, replay, dependencies, daily digest), built after the core |
| Runtime | Node 24, zero dependencies: `node:sqlite` (WAL + FTS5), `node:http`. Web UI is vanilla ES modules, no build step |

## What the mod API gives us (checked against this build's types, 2.1.2xx)

- In-session visibility: `agent.spawn` (prompt, description, subagentType, model),
  `tool.call` carrying `agentId` (which loop made it), `turn.start/complete`,
  `session.start/end`, `$.session.usage()`, `$.agent.list()`.
- Actuation: `agent.spawn` can force `{ model }`; `$.agent.register` adds agent types;
  `$.agent.spawn` starts background subagents; `$.prompt.submit` queues a prompt to
  the main agent; `prompt.compose` adds a system-prompt section; slash commands,
  panes, bands, status line, toasts.
- Limits: `$.store` is per plugin, ≤ 4 MiB → no cross-session state in the mod.
  Desktop pane elements are Box/Text/Button/Input/Select/Svg/Link/Code/Markdown/Client
  → the rich UI is a web app, the in-session UI stays a compact band + pane.

## Architecture

```
 Session A (Opus 5.5)        Session B (Opus 5.5)
 ┌──────────────────┐        ┌──────────────────┐
 │ Helm mod         │        │ Helm mod         │   sensor + actuator, user scope
 │ hooks → events   │        │ hooks → events   │
 │ inbox ← notes    │        │ inbox ← notes    │
 └────────┬─────────┘        └────────┬─────────┘
          └──── HTTP over unix socket ┘
                     ▼
        ┌──────────────────────────────┐
        │ helmd — local hub daemon     │   auto-started by the first mod
        │ SQLite (WAL) append-only log  │   single source of truth
        │ projections + FTS5 index      │
        │ SSE live stream               │
        └──────────────┬───────────────┘
                       ▼
        Web app — http://localhost:7777   (in-app browser pane or Safari)
        + one-line band and /helm pane inside each session
```

Contract between the three parts: `helm/CONTRACT.md`.

## Reliability: the board is driven by engine events, not model memory

| Engine event | Board effect |
|---|---|
| `agent.spawn` | Card → **In progress** (auto-created if no `[helm:<taskId>]` tag in the description) |
| `tool.call` with that `agentId` | Live line in the task's Thread + Office desk |
| subagent `turn.complete` | Card → **Review** (or **Done** for trivial), recap generated |
| error / deny / no activity for N min | Card → **Blocked** with reason |

- **Outbox**: hub down → events queue in `$.store`, replay in order. Every event has
  `(sessionId, seq)`; the hub ignores duplicates, so replay is idempotent.
- **Reconciler**: every 10 s the mod diffs `$.agent.list()` against the hub's view of
  that session and repairs drift.
- **Guards**: gating hooks carry `.catch` so a failing hook never drops an event.
- **Tests**: `claude plugin test` units, hub unit tests (`node --test`), and a scripted
  end-to-end run that spawns real agents and asserts every card transition.

## Model routing

| Agent | Model | Job |
|---|---|---|
| main session | Opus 5.5 | plan, split, delegate, talk to you |
| `helm:builder` | Sonnet 5.5 | write code, refactor, run tests, fix |
| `helm:scout` | Haiku 5.5 | search, read, inventory, quick checks |
| scribe | Haiku 5.5 (direct `$.model` call) | recaps, card titles, search tags |

Enforced in `agent.spawn`; a `prompt.compose` section teaches the main agent to
delegate in the background and stay conversational.

## Features

1. **Kanban** — Backlog · Up next · In progress · Review · Done, plus Saved for later
   and Blocked. Buttons on every card: Done, Later, Retry, Archive; drag to move.
   Card shows agent, model, elapsed time, tokens, files changed.
2. **Projects** — a new session gets its own project (named after its folder).
   `/helm join <project>` onboards another session into an existing one.
3. **Office** — every session is a desk; its subagents sit beside it with a live
   "now doing" line, model badge, heartbeat. Stalled agents dim amber.
4. **Threads** — live graph main → subagents with data pulses on each tool call.
   Step into a subagent: brief, tool timeline, files, current step, recap, and a
   prompt box scoped to that task.
5. **Recaps** — after every task: **What · How · Learned**. Feeds the **Learn** view
   (concept-grouped "today I learned" + "explain deeper").
6. **Spotlight ⌘K** — FTS5 over tasks, recaps, notes, threads, tool activity across
   all sessions; doubles as a command palette.
7. **Notes + Execute** — on any task or the main session. Colour on the text only:
   dim grey = not run · accent = sending · soft green = ran (timestamp) · red = failed.
   Execute delivers pending notes: main → `$.prompt.submit`; task → `SendMessage` to the
   live subagent, else a follow-up `helm:builder` spawn seeded with the task context.

Extras: file-conflict radar, questions inbox, cost meter, task replay, dependencies,
daily digest.

## Design

Apple HIG base — system font stack (SF Pro), 8-pt grid, vibrancy (backdrop blur),
12 px radii, spring motion, symbol-style icons, dark first with a true light mode.
Futuristic edge kept to accents — SF Mono for anything live (ids, tool calls,
timings), one phosphor-cyan accent, a faint grid behind Office/Threads, data pulses
on graph edges, a short type-on for new tool lines.

## Phases (each: investigate → plan → verify plan → build → verify result)

| # | Phase | Exit criteria | Status |
|---|---|---|---|
| 0 | Spikes: `agentId` on subagent tool calls, messaging a running subagent, queued `prompt.submit`, hub auto-start from a mod | each proven in this build, or fallback chosen | ✅ done |
| 1 | Hub: event log, schema, projections, reconciler endpoint, outbox semantics | kill/restart loses no events; `node --test` green | ✅ done (58 tests) |
| 2 | Mod sensors + model routing | real spawns land with the right models | ✅ done |
| 3 | Board, projects, status buttons | delegate 3 tasks → every transition correct | ✅ core done (T-1, T-2 real runs) |
| 4 | Office + Threads live | two sessions + subagents live | ✅ 4 real sessions reporting |
| 5 | Notes + Execute, scoped prompts | a note reaches main and a subagent; colour follows | ✅ subagent (N-1) + main (N-2) proven |
| 6 | Recaps, Learn, Spotlight | cross-session search; every finished task has a recap | ✅ recaps + backfill; Learn, Spotlight built |
| 7 | Polish, user-scope install, multi-session soak | a fresh session picks it up with zero setup | ✅ T-3…T-8 done |

**Biggest risk:** prompting a subagent mid-run. Fallback keeps every task promptable
via a follow-up spawn that continues from the task's context.

## Build log

- 2026-10-10 — Plan written. Node 24.18 confirmed with `node:sqlite` + FTS5 (zero deps).
  Phase 0 + 1 started; delegated: Haiku scout (API cheat sheet), Sonnet builders
  (hub, web UI) against `CONTRACT.md`. Opus writes the spike mod.
- 2026-10-10 — Mod v0 written (`hooks/register.ts`): sensors for every contract event, model
  routing (builder→Sonnet, scout/Explore→Haiku, Opus→Sonnet), `helm:builder` / `helm:scout`
  agent types, `mcp__helm__task` tool, `/helm open|join|status`, outbox with time-based seq
  (monotonic across reloads), hub auto-start (`nohup node hub/helmd.mjs`), notes delivery
  (main → `$.prompt.submit`, live subagent → `$.session.send({ to: { agentId } })`, finished →
  follow-up `helm:builder` spawn), Haiku recaps via `$.model.complete`, probe log of raw event
  shapes at `~/.helm/probe-<session>.json`. Validates clean on 2.1.293 (the `claude` on PATH is
  2.1.276 and wrongly rejects `prompt.compose`; use the app's bundled binary for validate/test).
  Phase 0 finding: messaging a running subagent is a first-class API (`$.session.send`), so the
  biggest risk is retired on paper — runtime proof pending once the mod loads.
- 2026-10-10 — Mod loaded (hot reload enabled). **Phase 0 runtime proofs** from `~/.helm/probe-*.json`:
  ✓ `tool.call` inside subagents carries the right `agentId` · ✓ subagent `turn.complete` fires
  with `agentId`, `reason`, `usage.model` · ✓ `agent.list` statuses as documented ·
  ✓ `agent.spawn` routing: `helm:scout` with no model → `claude-haiku-5-5`; the spawn result
  and the Agent tool result both carry `agentId` (binding is immediate) ·
  ✓ `session.usage` gives `context.tokens` + `cost.usd` → contract gained `Session.costUsd`.
  Pending (needs hub): `$.session.send` to a live subagent, `$.prompt.submit` note delivery, hub auto-start.
- 2026-10-10 — Haiku scout (routed by the mod itself) reviewed `register.ts` against the types:
  12 findings, all fixed. Key: `/clear` ends the session with no new `session.start` → the mod
  now keeps its timers, rebinds to the new session id and carries the project over; all network
  work moved into one 1.5 s tick (off hook budgets, hub calls race a 4 s clock timeout);
  `prompt.submit` uses `asUser` and honours `drop`; `session.send` honours `isDelivered:false`;
  plugin tool answers `{ result, context }` / `{ deny }`; `agent.completed` deduped across the
  Agent result and `turn.complete`; outbox persisted lean (store is 4 MiB). `tsc` and
  `claude plugin validate` both clean.
- 2026-10-10 — Hub (52→53 tests) and web UI landed. Visual QA in the browser pane on a seeded
  demo hub: Board, task sheet, Office, Threads (graph + pulses + note colours), Learn, Spotlight
  (grouped `<mark>` results), light + dark — no console errors. Polish item: Done column clipped
  at 1440px → became real task **T-1**.
  **Phase 0 complete:** ✓ hub auto-start (now via `helmd --detach`) · ✓ live `$.session.send` to a
  running subagent (note N-1 → `ran` via `send_message`) · main-session note via `$.prompt.submit`
  queued (arrives as a prompt when the turn ends).
  **First real end-to-end run:** `mcp__helm__task create` → T-1 · Agent `[helm:T-1]` as
  `helm:builder` → card jumped to In progress, bound to the agent, model claude-sonnet-5-5, live
  "now doing". Fixes found by the run: plugin tool `result` must be a string/array (not an
  object); a hub restart mid-session leaves a stub "Unassigned" session → hub now migrates the
  stub into its real project on `session.started` (+ test).
- 2026-10-10 — Hardening from the live run: a main-session note made `$.prompt.submit` block the
  mod's tick for the whole turn (board feed froze) → deliveries are fire-and-forget, tick has a
  20 s watchdog, outbox persists on its own timer, in-flight notes survive reloads. Reconciler now
  emits missed completions; recap **backfill** rebuilds a missing recap from the hub activity log
  (T-1's recap restored). Files changed now also come from the builder's `FILES:` line (edits via
  Bash never hit Edit/Write). Hub: notes stuck in `sending` time out after 10 min (T-2, built by a
  Helm builder through Helm). T-1, T-2 verified → Done. Remaining roadmap is on the board: T-3…T-8.
- 2026-10-10 — **v0.2 complete.** Moved to `~/WebDev/builtbyAlish/helm`, installed at user scope
  (`helm@helm-local`); the user's other open sessions picked it up and report live (4 sessions).
  Built through Helm by Sonnet builders: T-3 mod tests (39) · T-4 band + `/helm-pane` (11 UI tests,
  terminal + desktop) · T-7 hub extras (conflict radar, questions inbox, explain/digest jobs,
  digests; hub tests 78) · T-8 web extras (radar strip, Inbox, Explain deeper, digest card, Replay,
  "waiting for you"). Lead: mod v0.2 (files on tool.called, waiting status, AskUserQuestion text,
  Haiku job runner, Obsidian export `userConfig`), wiring, contract v0.2, README.
  Verified live: explain + digest jobs written by Haiku through this session's mod; `kill -9` of the
  hub mid-session → the mod restarted it in ~3 s with zero lost events; second session (headless)
  appeared, joined project `helm`, ended cleanly (its run stopped at an expired CLI OAuth login).
  Fix found live: a hub without `/jobs` made the mod stop asking until reload → now re-checks every 60 s.
  Known gaps: T-1's file list was lost in the early freeze (pre-fix); `/helm join` typed in a session
  is unit-path only (the same hub join is proven via the dashboard API).
- 2026-10-10 — **v0.3: drive everything from Helm.** Note replies (session note → the main turn's
  answer; task note → the agent's final report; maps persisted across reloads), Start on cards and in
  the sheet, Create & start, and a Talk sheet (header `t`, also in Threads) that is a chat with the
  session. Hub T-9 (85 tests), web T-10, reply tests T-11 (mod 59 tests). Proven live: Create & start
  T-12 → note N-3 delivered as a prompt → delegated to a builder → card to Review with files → my reply
  captured under N-3 and shown in Talk. Fix from T-11: follow-up spawns bind their reply through our
  own `agent.spawn` hook (a plugin's `$.agent.spawn` may not return the agentId).
- 2026-10-10 — **v0.4: near-zero Helm cost + files.** Measured Helm's own footprint: ~530 cached tokens per
  Opus request (~$0.0001), Haiku recap ~$0.0003; the expensive path was task questions spawning a Sonnet
  builder (~$0.05–0.30). Now: questions answered by one Haiku call over the task record (live: $0.000189,
  correct one-liner), recaps parsed free from DONE/HOW/LEARNED/TAGS, 1–2 sentence replies, overhead meter
  (`helm.usage`, `/v1/usage`, header + popover), attachments (drag/drop/paste → `~/.helm/attachments`, paths
  handed to the agent), dashboard self-reload on new web build. Hub T-13 (95 tests), web T-14, mod tests
  T-15 (81). Fixes from tests: cache writes priced at 1.25×, unknown models price as Opus.
- 2026-10-10 — **v0.5: diffs, task chat, task links** (from dashboard note N-7). Mod records a git base per
  spawn (`git stash create` || HEAD → `agent.git`); hub T-16 serves per-task diffs (snapshot frozen at
  completion via `hub.task.diff`, live refresh, history fallback for old tasks; 106 tests); web T-17 adds
  the Dock (Talk + details + task chat side by side), collapsible Files changed with totals and a unified
  diff viewer, and `T-n` chips that open a task while Talk stays open. Verified live in the browser pane.
  Found in QA: the browser mixed cached old `app.js` with new modules → web files now `no-store`.
- 2026-10-10 — **v0.6.** T-19 (dashboard card) Threads redesign: virtualised git-graph tree + timeline,
  newest first, nested subagents (`Agent.parentId`). T-21 (notes N-9/N-10) Choices: plan outputs become
  tick-to-run checklists; T-18's 11 suggested screens attached as choices. T-22 (card) resizable, saved dock
  widths. Incident: a builder stopped the live hub with `--stop` minus `HELM_HOME`; the mod restarted it
  within seconds, no data lost (backup `helm-pre-v06.db`). Builders are now told to always pass `HELM_HOME`.
  Follow-up: Timeline axis should zoom to the visible range (bars are thin over a full day).
- 2026-10-10 — **v0.12: Workflows (T-28).** Hub engine (decide-then-record `wf.*` events, rebuild identical),
  canvas + run UI (builder), mod step runner (lead). First real run R-1 on a scratch repo: Sonnet builder added
  `add()` → shell `node --test` passed → gate approved from the canvas → Opus review VERDICT: PASS, $0.017.
  Fixes from the run: agent step cost now booked to the run; opening a workflow auto-selects its live run.
  Follow-ups: mod tests for the step runner; review prompt should include the gate decision.
