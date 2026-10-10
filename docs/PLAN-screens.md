# Helm: audit of screens and plan for new ones

Status: plan, T-18, 2026-10-10. No code changed. Based on `README.md`, `CONTRACT.md` (v0.1 to v0.5), `CHANGELOG.md`, `plan.md`, `web/views/*.js` and `hooks/register.ts`.

Mod API facts are cited as `d.ts:<line>`, meaning the file
`/private/tmp/claude-501/bundled-skills/2.1.293/e5ff1e8ceaedd560d01ace78c59ce0aa/plugin-authoring/types/claude-code.d.ts`.
Anything I could not back with a line there is marked **unverified** and is a spike item in phase 0.

## 1. Audit of current screens

Routes live in `web/router.js` (`VIEWS = board, projects, office, threads, inbox, learn`). Talk and Task chat are Dock panels, not routes (`web/views/talk.js`, `taskchat.js`, `sheet.js`). Each screen: **Works** lines first, then **Gap** lines.

### 1.1 Board (`web/views/board.js`)
- Works: seven lanes driven by engine events; drag to move, card keys, Start (`S`) and Create and start (`⌘↵`).
- Works: conflict markers from `Task.conflicts`; empty-state banners.
- Gap: `Task.dependsOn` exists but is not drawn, so a chain of tasks looks unrelated.
- Gap: no grouping by run or epic, and no bulk actions. No per-card cost (`Task.tokens` only).
- Gap: Review is a dead end. No approve or request-changes, only Done.

### 1.2 Projects (`web/views/projects.js`)
- Works: project cards with status bar and legend, create, rename, archive, move a session in.
- Gap: counts only. No spend, last activity or health per project.
- Gap: no project settings (default check commands, cwd, model routing). A workflow needs exactly these.
- Gap: no per-project templates.

### 1.3 Office (`web/views/office.js`)
- Works: a desk per session with subagents, live "now doing", model badge, waiting and stalled states.
- Works: conflict radar (polled `/v1/conflicts`, fallback from `Task.conflicts`).
- Gap: read only. Cannot message a session or hand it work from here.
- Gap: no context gauge (`Session.tokens`) or spend (`Session.costUsd`) on the desk.
- Gap: no sign of which sessions collaborate; ended sessions just disappear.

### 1.4 Threads (`web/views/threads.js`)
- Works: live main to subagent graph with pulses; step into an agent for brief, timeline, files, recap and prompt box.
- Gap: graph is one session's parent/child tree only. No cross-session links.
- Gap: positions computed; no drag, pan or zoom, so big sessions overflow.
- Gap: timeline capped at 200 rows (`sessionActivity(id, 200)`); no filter by tool, file or failure.

### 1.5 Inbox (`web/views/inbox.js`)
- Works: open and answered questions from `AskUserQuestion` and waiting agents; dismiss; empty state.
- Gap: you cannot answer from Helm. The contract has dismiss only, so you still go to the terminal.
- Gap: no approvals concept. Workflow gates need one and this is their home.
- Gap: no grouping by task or session; no badge outside the tab; answered history capped at 50.

### 1.6 Learn (`web/views/learn.js`)
- Works: recaps by concept, daily digest card with Generate, Explain deeper, scope follows the project.
- Gap: concepts are free-text tags; "css grid" and "grid layout" stay separate.
- Gap: a log, not a study tool. No quiz or spaced review; digest is daily only.
- Gap: Obsidian export is one way and off by default.

### 1.7 Talk (`web/views/talk.js`, Dock)
- Works: a session's notes as a chat with replies, session picker, attachments, `T-n` chips; `execute: true` in one call.
- Gap: one session at a time. No broadcast, no "ask B about A's task".
- Gap: replies are asked to be 1-2 sentences, so it cannot hold a long working conversation.
- Gap: no slash commands (`/start T-12`, `/run workflow`); weak on a phone.

### 1.8 Task chat (`web/views/taskchat.js`, Dock)
- Works: task notes as a chat coloured by state; cheap Haiku answers; `!` forces the agent. Shares the Talk component.
- Gap: chat and diff are apart. No per-hunk comment that becomes a structured follow-up.
- Gap: "request changes" is a free-text note. No record of files changed since the last message.

---

## 2. Workflows screen (the headline)

### 2.1 Goal in one paragraph

Draw a graph where each node is a unit of work (a session, an agent, a shell check, a human gate) and each edge says what flows to the next. Press Run and watch nodes light up. Describe a workflow in plain words and get a graph you can edit. Everything stays inspectable and stoppable from Helm.

### 2.2 Node types

All nodes share: `id`, `type`, `label`, `position {x,y}`, `config`, `retry {max, backoffMs}`, `timeoutMs`.

| Node | Config (essentials) | Executed by | Model | Produces |
|---|---|---|---|---|
| **Prompt** | `text` (template with `{{inputs.*}}`), `target: session \| new-agent` | `prompt.submit` on the chosen session (`d.ts:2911`) | the session's | text (the turn's answer) |
| **Session** | `sessionId` or `match {project, cwd}`, `text` | `session.send` with `{ sessionId }` (`d.ts:2857`) | the receiving session's | text (reply, see 2.5) |
| **Agent step (builder)** | `prompt`, `cwd?`, `isolation?: worktree`, `taskId?` | `agent.spawn` with `subagentType: helm:builder` (`d.ts:3135-3150`) | Sonnet | text, filesChanged, diff, ok |
| **Agent step (scout)** | `prompt`, `cwd?` | `agent.spawn` with `helm:scout`; its `disallowedTools` already blocks edits (`register.ts:715`) | Haiku | text |
| **Safety gate / approval** | `message`, `show: diff \| files \| text`, `timeoutMs?`, `onTimeout: fail \| skip` | the hub alone; shown in Inbox and on the node | none | `approved: bool`, optional comment |
| **Note** | `text` (markdown) | nobody; documentation on the canvas | none | nothing (never executed) |
| **Condition / branch** | `expr` over upstream values, e.g. `inputs.check.ok`, `filesChanged.length > 5` | the hub (pure function, no model) | none | picks one outgoing edge |
| **Wait / timer** | `ms` or `until` (clock time), or `untilSessionIdle` | the hub timer | none | nothing |
| **Parallel / join** | fan-out is any node with several outgoing edges; **Join** has `mode: all \| any \| n-of-m` | the hub | none | merged inputs |
| **Opus review** | `rubric`, `inputs: diff + task brief`, `verdict: pass \| changes` | `model.complete` with `model: 'opus'` (`d.ts:2579`, request shape `d.ts:6140`) | Opus 5.5 | verdict, findings (text) |
| **Run shell check** | `argv` (or `script` run as `["sh","-c",script]`), `cwd`, `timeoutMs` (default 30 s, max 10 min), `passIf: exit0 \| regex` | `$.process.run` by argv, no implicit shell (`d.ts:3465-3478`) | none | pass/fail, exit code, truncated stdout and stderr |

Notes on the table
- **Shell check is CLI only.** The docs say `process` is "CLI only" (`d.ts:3465`). In the desktop app the mod cannot run it. Fallback: the node degrades to an agent step with `helm:scout` told to run the command and report `DONE: pass` or `DONE: fail`. This costs Haiku tokens, so the UI warns.
- **Opus review uses `model.complete`, not a spawn.** Helm's own `agent.spawn` hook downgrades Opus subagents to Sonnet (README, "Model routing"). A direct `model.complete` call avoids fighting that rule, returns exact `usage`, and cannot edit anything.
- **Note nodes** also carry the user's "stop for a quick safety check" idea in prose; the actual stop is the Gate node.

### 2.3 Edges and data passing

An edge is `{ id, from, to, when: 'ok' | 'fail' | 'always' | 'approved' | 'rejected' | 'branch:<name>' }`. Default `when` is `ok`.

What flows (each node output is a typed bag; the next node picks what it needs by template):

| Key | Type | Source nodes | Used for |
|---|---|---|---|
| `text` | string (cap 8 KB, full text stored as an artifact) | agent, session, prompt, review | `{{inputs.build.text}}` in a prompt |
| `ok` | bool | all executing nodes | `when: ok` / `fail` routing |
| `filesChanged` | string[] | agent step | condition, gate display |
| `diff` | `{ totals, files[] }` or a ref to `GET /v1/tasks/:id/diff` | agent step (via its task, v0.5) | review node, gate display |
| `check` | `{ exitCode, stdout, stderr, passed }` | shell check | gate display, condition |
| `verdict` | `pass \| changes` + `findings` | Opus review | condition, follow-up prompt |
| `approved` | bool + `comment` | gate | routing, extra text for next node |

Rules
- Inputs are addressed by upstream node id, never by position: `{{inputs.<nodeId>.<key>}}`.
- Large values are passed by reference (`{ ref: 'wfout:R-4:n3' }`) and resolved by the hub when it builds a step, so events stay small.
- A node with several incoming edges waits for all of them unless it is a Join with another mode.
- Types are checked on save: a prompt that references `inputs.build.diff` from a node that cannot produce `diff` is flagged on the canvas before you run.

### 2.4 Execution model

#### Where the engine lives

In the hub, as a **state machine over events**, the same way tasks work today. The hub never calls a model. It decides, and queues steps for a live mod to carry out.

```
canvas ──POST /v1/workflows/:id/run──▶ hub
   hub: wf.run.started  ──▶ evaluate graph ──▶ ready nodes ──▶ queue Steps
mod (any live session) ──GET /v1/sessions/:id/steps──▶ claims Steps
mod executes ──▶ event wf.step.result ──▶ hub: wf.node.state ──▶ evaluate again
gate node ──▶ hub: wf.gate.opened ──▶ Inbox ──▶ POST /v1/runs/:id/gates/:nodeId {decision}
```

Why this is deterministic and resumable
- Run state is a pure function of the append-only log: `reduce(events) => RunState`. No hidden timers in memory; waits are stored as `wakeAt` and re-armed by the sweep (existing 30 s timer).
- `node state` machine: `pending -> ready -> queued -> running -> (ok | failed | skipped | waiting_gate | waiting_timer)`. Only the reducer moves state, only on events.
- `--rebuild` already replays the log (CONTRACT, Migration), so runs rebuild for free.
- Idempotency: every step has `stepId = <runId>:<nodeId>:<attempt>`. A repeated `wf.step.result` for the same id is ignored, like `(sessionId, seq)` duplicates.

#### How each node is carried out by a mod

| Node | Mod action | Completion signal |
|---|---|---|
| Agent step | `$.agent.spawn({ prompt, description: "[helm:T-n] ...", subagentType, model, cwd })` resolves `{ model, agentId }` (`d.ts:3144-3146`); spawn is always background (`d.ts:106`) | the agent's `turn.complete` carries `agentId` and `answer` (`d.ts:395-399`, `13162-13173`); Helm already turns it into `agent.completed` |
| Session | `$.session.send({ to: { sessionId }, text })` (`d.ts:2857`) | **not** the send: "Delivered means queued ... never read" (`d.ts:11545`). Done when the receiving session's mod sees the `Helm step (<stepId>)` tag in its turn and reports the answer (same trick as `Helm note (N-x)` in `register.ts`, reply capture) |
| Prompt | `$.prompt.submit({ text, asUser: true })`, "a turn of its own, once the session is idle" (`d.ts:2911`) | the mod matches the tag in `turn.start` and reports on `turn.complete` |
| Shell check | `$.process.run(argv, { cwd, timeoutMs })` resolves `{ exitCode, stdout, stderr }` once exited (`d.ts:3465-3478`) | immediate return value |
| Opus review | `$.model.complete({ model: 'opus', system: rubric, prompt, maxTokens, timeoutMs })` (`d.ts:6140-6200`) | immediate; `isAnswered` false means failed with `reason` |
| Gate, condition, wait, join, note | hub only | hub events |

Choosing the executing session ("driver"): reuse the Jobs rule (task's session, else project's most recent active session, else any active session). A node may pin a `sessionId`. No live session: the run goes to `waiting_session` and Inbox shows "workflow R-3 needs a live session".

#### Gate = a Helm question plus approval

- Hub opens a `Question`-like row `kind: 'approval'` with `runId`, `nodeId`, the message, and links to the diff. It appears in Inbox (new filter "Approvals"), as a pulsing node on the canvas, and in the Board card.
- `POST /v1/runs/:id/gates/:nodeId` `{ decision: 'approve' | 'reject', comment? }` emits `wf.gate.decided`. The reducer routes the `approved` or `rejected` edge.
- Optional hard stop, **inside** a running agent: a node can set `guard: { denyTools: ['Bash'], untilGate: 'g1' }`. The mod's existing `tool.call` hook returns `{ deny: reason }` for matching calls while the gate is open (`d.ts:3915-3925`). Use for "do not run migrations until I approve". Only works for agents the mod owns the hook for; stop the whole turn is not available.
- Not used: `$.ui.ask` (`d.ts:2406-2412`). It opens a dialog in one terminal and rejects in `-p` runs, so the approval would be invisible from Helm and stuck on the wrong machine.

#### Failure, retry and resume

| Case | Behaviour |
|---|---|
| Step fails (`ok:false`, shell non-zero, review `changes`) | follow `when: fail` edge if present, else retry per `retry.max` with backoff, else run -> `failed` at that node and the Board card -> `blocked` with the reason |
| Mod does not claim a queued step in `HELM_JOB_MS` | step -> `failed: not picked up` (same sweep as Jobs); retry picks another session |
| Session ends mid-step | existing rule fails its running agents; the step becomes `failed: session ended`, retry reassigns |
| Stalled agent | existing stall sweep (5 min stalled, 10 min blocked); the node shows amber; user can Retry, Skip or Abort from the inspector |
| Hub restart | reducer replays; `queued`/`running` steps older than the timeout are re-queued; step ids keep it idempotent |
| User edits a graph mid-run | a run pins `workflowVersion`. Edits create a new version; the live run is unaffected. "Re-run from node" starts a new run seeded with the old outputs |
| Pause / abort | `POST /v1/runs/:id/pause|abort`. Abort stops queuing, sends no kill (the API has no kill of a running subagent; **unverified**, spike) and marks running nodes `abandoned` |
| Resume | `POST /v1/runs/:id/resume` re-evaluates; failed node can be retried or skipped individually |

#### How runs appear on the Board

- A **run = a group of cards**. Each executing node that spawns an agent creates its own task (`[helm:T-n]` tag in `description`, reusing `agent.spawned` task binding in CONTRACT v0.1). Non-agent nodes (shell, review, gate) create a lightweight task only when they fail or wait.
- New optional `Task.runId` and `Task.nodeId`. Cards carry a small chip `R-3 · build`.
- The Board gets a "Group by run" toggle: a lane shows one collapsed header `R-3 Build, test, review (3/5)` that expands to its cards; `dependsOn` is filled from the graph edges, so the existing dependency data is finally visible.
- A gate in `waiting_gate` puts its card in **Review** with a green **Approve** button.

### 2.5 Creating workflows by prompt

Flow
1. A prompt box on the Workflows screen: "Describe the workflow you want".
2. Hub queues a `workflow_draft` Job (existing Job mechanism, kind added). Input: user text, project settings (check commands, default cwd), the node-type catalogue, the JSON schema (section 2.5.1), and 2 example graphs.
3. Model: **Sonnet** by default for drafting (structure plus judgment), **Haiku** for "small edit" requests ("add a gate before merge"). Opus only on an explicit "think harder" toggle. The mod calls `$.model.complete` with `maxTokens` high enough and `effort: 'low'` for Haiku (`d.ts:6140-6200`, `2579`).
4. The mod returns JSON text. The hub validates it against the schema. Invalid -> one automatic repair call that includes the validator errors; still invalid -> show the errors and the raw text.
5. Valid graph is saved as a **draft** version and opens on the canvas with layout auto-computed. Nothing runs until you press Run.
6. Edit by prompt too: select nodes (or none), type "make the test step run lint first", and the model returns a **patch** (add, remove, change ops), which the canvas previews as ghost nodes before you accept.

#### 2.5.1 Graph JSON (v1 schema, enforced by a hand-written validator in the hub; no dependency)

```json
{
  "schema": "helm.workflow/1",
  "name": "Build, test, review, merge",
  "nodes": [
    { "id": "build", "type": "agent", "label": "Build feature", "position": { "x": 80, "y": 120 },
      "config": { "agent": "builder", "prompt": "{{params.brief}}", "isolation": "worktree" },
      "retry": { "max": 1, "backoffMs": 5000 } },
    { "id": "test", "type": "shell", "label": "Run tests",
      "config": { "argv": ["npm", "test"], "timeoutMs": 300000 } },
    { "id": "gate", "type": "gate", "label": "Safety check",
      "config": { "message": "Tests passed. Review the diff.", "show": "diff" } },
    { "id": "review", "type": "review", "label": "Opus review",
      "config": { "rubric": "Correctness, security, scope creep." } },
    { "id": "merge", "type": "agent", "label": "Merge",
      "config": { "agent": "builder", "prompt": "Merge the branch for {{inputs.build.taskId}}." } }
  ],
  "edges": [
    { "id": "e1", "from": "build", "to": "test" },
    { "id": "e2", "from": "test",  "to": "gate",   "when": "ok" },
    { "id": "e3", "from": "test",  "to": "build",  "when": "fail", "loop": { "max": 2 } },
    { "id": "e4", "from": "gate",  "to": "review", "when": "approved" },
    { "id": "e5", "from": "review","to": "merge",  "when": "ok" }
  ],
  "params": [{ "key": "brief", "label": "What to build", "type": "text" }]
}
```

Validator rules: ids unique; every edge endpoint exists; exactly one or more entry nodes (no incoming edges); cycles allowed only on edges with `loop.max`; each template reference resolves to an upstream node that can produce that key; `note` nodes have no edges; unknown node types are rejected, not dropped.

#### 2.5.2 Versioning
- `Workflow` = identity (`W-n`, name, projectId). `WorkflowVersion` = immutable graph (`v1`, `v2`...).
- Saving always creates a new version with `author: user | model`, a one-line `summary`, and `parentVersion`.
- The canvas has a version dropdown, a diff view ("2 nodes added, 1 edge changed") and Restore, which creates a new version from an old one.
- A Run stores the exact version it ran.

#### 2.5.3 Templates and running

Built-in templates (stored as ordinary graphs, copy to edit):

| Template | Graph |
|---|---|
| Build, test gate, review, merge | build -> shell test -> gate -> Opus review -> merge |
| Fix a bug | scout reproduces -> builder fixes -> shell test -> (fail loops back, max 2) |
| Research then build | scout reports -> gate "approve plan" -> builder |
| Parallel refactor | fan-out three builders in worktrees -> Join(all) -> shell test -> review |
| Safe migration | builder writes migration -> gate -> shell dry-run -> gate -> apply |

"Run a selected workflow": list on the left; **Run** opens a small form for `params`, a driver-session picker (default: auto) and a cost estimate (2.7). `Run` is also reachable from Spotlight (`> run workflow`) and from the Talk composer later.

### 2.6 UI design

Style: Apple HIG base (system font, 8-pt grid, vibrancy, 12 px radii), SF Mono for anything live, one phosphor-cyan accent, faint grid behind the canvas (matches Office and Threads in `plan.md`, Design).

Layout
```
┌ toolbar: [workflow ▾] [v7 ▾] [Prompt ▸] [Run ▶] [Pause] [zoom 100%] [fit] ──────────┐
│ palette │                    canvas (pan / zoom)                      │ inspector     │
│ ─────── │   ┌────────┐      ┌────────┐      ┌────────┐               │ ───────────── │
│ Session │   │ Build  │────▶ │ Tests  │────▶ │ ▣ Gate │               │ Node: Tests   │
│ Agent   │   │ ● run  │      │ ✓ 12s  │      │ waits  │               │ Type, config  │
│ Prompt  │   └────────┘      └────────┘      └────────┘               │ Inputs/outputs│
│ Gate    │                                              ┌ minimap ┐   │ Last run log  │
│ ...     │                                              └─────────┘   │ Retry / Skip  │
└─────────┴─────────────────────────────────────────────────────────────┴───────────────┘
```

Behaviour
- **Pan and zoom**: pointer drag on empty space pans; wheel or pinch zooms around the cursor (0.25 to 2); space+drag also pans; `0` fits all. Implementation: one `div.world` with `transform: translate(x,y) scale(k)` for nodes and a single `<svg>` layer in the same transform for edges.
- **Palette**: grouped list (Run, Control, Human, Doc); drag a type onto the canvas or press `/` on canvas to open a search-to-add popover.
- **Edges**: drag from an output port to an input port; cubic Bézier paths; the edge label shows `when`; drop on empty canvas opens "add node here". Loop edges draw as arcs with `×2`.
- **Inspector** (right): form generated from a per-type field list (label, config fields, retry, timeout, model badge). Edits update the draft instantly; Save makes a version. During a run it also shows that node's status, inputs, outputs, log tail (from Activity) and Retry / Skip / Open task.
- **Live run state**: node border and badge by state: grey pending, cyan pulsing running, green ok, red failed, amber stalled or waiting gate, dashed skipped. Edges: a pulse travels along an edge when its source finishes (reuse the Threads pulse). Elapsed time ticks in SF Mono.
- **Minimap**: 160x100 px canvas element bottom right, shows node boxes coloured by state and the current viewport; click or drag to move.
- **Hacker edge (accents only):** mono ids, type-on log lines, glow on the running node. **Keyboard and a11y:** Tab walks nodes in graph order; Enter opens the inspector; arrows nudge a selected node by 8 px; `⌘Z` undo (draft only); every node is a `role="group"` with an `aria-label` that includes its state. Reduced motion turns pulses into a static dot.
- **No libraries.** Vanilla ES modules like the rest of `web/`: `web/views/workflows.js` (view), `web/wf/canvas.js` (pan, zoom, ports, edges, minimap), `web/wf/inspector.js`, `web/wf/layout.js` (simple layered auto-layout: topological rank by x, order within rank by y), `web/wf/graph.js` (pure model and validator, shared logic mirrored in the hub). Add `'workflows'` to `VIEWS` and a nav icon in `web/icons.js`.

### 2.7 Costs

| Node | Model | Cost source |
|---|---|---|
| Agent builder | Sonnet 5.5 (2/10 USD per MTok) | agent `turn.complete.usage` priced by the mod's price table (new, see below) |
| Agent scout | Haiku 5.5 (0.10/0.50) | same |
| Opus review | Opus 5.5 (4/20) | `model.complete` result `usage`, exact |
| Prompt / Session | the target session's model | the target session's `turn.complete.usage` for the tagged turn |
| Shell, gate, condition, wait, note | none | 0 |
| Prompt-to-workflow drafting | Sonnet or Haiku | `model.complete` usage, an overhead kind |

Attribution
- Today `helm.usage` has kinds `recap | answer | explain | digest | note_turn` (CONTRACT v0.4) and agent spend is not recorded per agent. Phase 1 adds `runId` and `nodeId` to `helm.usage` and new kinds `wf_review`, `wf_draft` (overhead) and `wf_step` (requested work).
- The mod computes `costUsd` for an agent or tagged turn from `TurnCompleteFields.usage` (`d.ts:13196-13200`) with the existing price table and emits a `helm.usage { kind: 'wf_step', runId, nodeId, model, tokens..., costUsd }`.
- `Run.costUsd` is the sum of its usage rows; the canvas shows cost per node and a total in the toolbar; the cost meter popover gains a third bucket "workflow runs".
- Estimate before run: hub keeps the median cost per `(nodeType, model)` from past runs and shows `~$0.40 (3 agent steps, 1 review)`; no history shows a range from the price table with a "no data" label.
- Guardrail: a per-run `budgetUsd`. The hub stops queuing new steps when exceeded and opens a gate "budget reached, continue?".

### 2.8 Risks and limits (what the API cannot do today)

| Limit | Evidence | Mitigation |
|---|---|---|
| `session.send` to another session is fire and forget: delivered means queued, never read, and the receiver may hold it for its person | `d.ts:11545-11548`; `d.ts:2849-2851` | steps carry a tag; completion needs the receiver's own mod to report; add a step timeout and a "waiting for reply" state |
| Sending to a session that is not running is not delivered | `d.ts:11446-11451` (SessionSendAddress, `sessionId`) | node fails fast with "session not running"; offer "use any active session" |
| No `session.create` / new-session API found | grep of `d.ts` for create/start/launch finds only `ui.open`, `session.start` (an event, `d.ts:4711`), `model.fork` | session nodes can only target existing sessions in phase 1. Starting a fresh `claude` process from the hub is **unverified** and not planned |
| `$.process.run` is CLI only | `d.ts:3465` | shell nodes degrade to a Haiku scout in the desktop app, flagged in the UI |
| Spawned agents always run in the background and answer by `turn.complete` | `d.ts:106`, `d.ts:3144-3146` | fits the design; the mod keeps `agentId -> stepId` in a map and persists it (store limit 4 MiB, already handled by the outbox) |
| Agent steps cannot be rewritten if they came from the native workflow tool (`e.workflow`): "a hook can only refuse it" | `d.ts:345-351`, `4052-4054` | Helm's engine does not use the native `Workflow` tool; its spawns come from `$.agent.spawn` and stay rewritable |
| A tool-call deny cannot undo what already ran, and a hook that fails is skipped | `d.ts:3920-3925` | guards use `.catch(... { deny })` as the docs prescribe; gate guards are best effort, not a security boundary |
| Killing a running subagent from the mod | no kill API found in the grep | **unverified**; Abort stops further steps and marks running nodes `abandoned`. Spike before promising "cancel" |
| `maxTurns` / `isolation: 'worktree'` are agent-type fields (`AgentSpec`), not per-spawn arguments | `d.ts:500`, `528` vs `AgentSpawnArgs` (`d.ts:250`) | register extra agent types (`helm:builder-wt`) via `$.agent.register` (`d.ts:3162-3185`) for worktree isolation |

Biggest risk: step completion for Session and Prompt nodes depends on tag matching in the receiving session. Mitigation: spike S1 (section 4) proves it before any UI work.

---

## 3. Other high-value screens and features (ranked by value over effort)

Effort: S = under 1 day, M = 2 to 4 days, L = a week or more. Value is for a solo user running several sessions.

| # | Idea | Value | Effort | Value/effort |
|---|---|---|---|---|
| 1 | Review queue | high | M | high |
| 2 | Cost and usage analytics | high | S | high |
| 3 | Notifications | high | S | high |
| 4 | Session health / context window | medium-high | S | high |
| 5 | Templates for repeated tasks | high | S | high |
| 6 | Quick-capture screen (mobile) | medium | S | medium-high |
| 7 | Timeline / Gantt | medium | M | medium |
| 8 | Git/PR integration | high | M | medium |
| 9 | Learn++ knowledge base | medium | M | medium |

### 3.1 Review queue (M)
- **Pitch:** the Review lane becomes a real inbox for diffs: one task at a time, file list on the left, unified diff in the middle, **Approve** and **Request changes** on the right. Request changes sends your comment as a note to the task's agent (follow-up spawn if finished) and moves the card back to In progress. Keyboard: `j/k` files, `a` approve, `r` request.
- **Uses:** `GET /v1/tasks/:id/diff` and `diffStat` (v0.5), `diffs.js` viewer, notes Execute with `followup_spawn`, `Task.status`.
- **New:** per-hunk comments, collected into one structured note ("File X line Y: ..."). Contract: `POST /v1/tasks/:id/review { decision, comments[] }`.
- **Why first:** every workflow gate wants this screen, so the gate UI is this view embedded.

### 3.2 Cost and usage analytics (S)
- **Pitch:** where did today's money go: per project, per model, per task, overhead vs requested, 7/30-day bars, top 5 expensive tasks.
- **Uses:** `GET /v1/usage?days=` and `usageToday` (v0.4), `Session.costUsd`, `Task.tokens`.

### 3.3 Notifications (S)
- **Pitch:** a tab badge and optional browser notification for: gate waiting, question waiting, task blocked, run finished. A quiet-hours setting.
- **Uses:** SSE `question`, `task`, new `run` entities; Web Notification API (permission asked on click); `document.title` count.

### 3.4 Session health / context window (S)
- **Pitch:** per session, a gauge of context tokens vs the model window, a "compact soon" warning, spend rate (USD per hour), idle time, and a one-click "send /compact note".
- **Uses:** `Session.tokens`, `Session.costUsd` from heartbeat. The mod can call `$.session.compact` (`d.ts:2847`) on request.

### 3.5 Templates for repeated tasks (S)
- **Pitch:** save a task (title, brief template, builder or scout, check command) as a template; one click creates and starts it with params. Same store as workflow templates.
- **Uses:** `POST /v1/tasks` with `start: true`, new `templates` table. Overlaps Workflows templates, so build the table once (`kind: 'task' | 'workflow'`).

### 3.6 Quick capture for mobile (S)
- **Pitch:** a minimal `/#/capture` route: a big text box, a project picker, a Send-to-Backlog and a Send-and-start button. Meant to be opened from a phone on the same network.
- **Uses:** `POST /v1/tasks`, attachments upload (v0.4).
- **Limit:** the hub binds to 127.0.0.1. Phone use needs a user-chosen tunnel or LAN bind with a token; plan a `HELM_BIND` setting with a required bearer token before shipping. Until then it is a compact screen, not remote.

### 3.7 Timeline / Gantt (M)
- **Pitch:** the day across sessions as swim lanes (one per session), bars for agent runs coloured by model, markers for gates, questions, failures. Zoom from 1 h to a day, click a bar to open the task.
- **Uses:** `Agent.startedAt/endedAt`, Activity, `Question.createdAt`. All present.

### 3.8 Git/PR integration (M)
- **Pitch:** a "Open PR" button on a Review card: creates a branch, commits the task's files, pushes, opens a PR with the recap as the body. Also a workflow node.
- **Uses:** `Task.git` (root, base, head), `filesChanged`, recap; `gh` through `$.process.run` (CLI only, `d.ts:3465`) or a builder agent that runs it.
- **Risk:** it publishes content. Always behind a gate with the PR title and body shown; never automatic. Needs an explicit user click each time.

### 3.9 Learn++ knowledge base (M)
- **Pitch:** turn recaps into a searchable base: concept pages that merge synonyms, show every task where the concept appeared, and a "quiz me" mode that asks 3 questions from Learned lines.
- **Uses:** `GET /v1/learn`, recaps, existing Obsidian export, Haiku jobs.

---

## 4. Phased delivery plan

### Phase 0: spikes (0.5 day, before any UI)

| Spike | Question | Pass |
|---|---|---|
| S1 | Does `session.send({ to: { sessionId } })` from mod A arrive in session B's `session.receive` / `turn.start` with the text intact, so B's mod can tag-match and report? | B's mod emits `note.reply`-style event for a tagged send; documented in `register.ts` notes |
| S2 | Can `$.agent.spawn` set `cwd` and a custom `subagentType` registered at runtime? | agent runs in the given dir with the chosen model |
| S3 | `$.process.run` available in the user's terminal and desktop sessions? | exit code and stdout returned; failure mode documented |
| S4 | Is there any way to cancel a running subagent from the mod? | yes with call name, or "no" recorded as a limit |

### Phase 1: Workflows MVP (target 1 week; the part builders execute)

Scope
- Node types: **agent (builder, scout), shell check, gate, Opus review, note**, plus `ok`/`fail`/`approved`/`rejected` edges and retry.
- Not in phase 1: session, prompt, wait, parallel/join, condition expressions, loops, prompt-to-workflow, templates UI (one hard-coded template), mobile.
- Canvas: pan, zoom, palette, inspector, live state, minimap, save/versions.
- Run: start, pause, abort, retry node, approve gate; Board shows the cards with a run chip.

Builder task split (each is one Helm task)
1. **Hub: workflow store and reducer.** Tables `workflows`, `workflow_versions`, `runs`, `run_nodes`, `steps`; reducer `hub/workflows.mjs`; validator `hub/wfgraph.mjs`; tests `hub/test/v06.test.mjs` (state machine, idempotent results, resume after restart, gate routing, retry, timeout of unclaimed steps).
2. **Hub: HTTP and SSE.** Endpoints below; new SSE entities `workflow`, `run`; `/v1/state` carries `runs` (active + last 20) and `workflows`.
3. **Mod: step runner.** Poll `GET /v1/sessions/:id/steps` inside the existing 2 s tick; execute agent/shell/review; keep `agentId -> stepId` map; emit `wf.step.result`; extend `agent.spawn` hook to skip the Opus-to-Sonnet downgrade for tagged review steps (reviews use `model.complete`, so only tagged agents need the check); price table to `costUsd`. Tests in `hooks/register.test.ts`.
4. **Web: canvas.** `web/views/workflows.js`, `web/wf/*.js`, nav entry, CSS in `web/views.css`. No library.
5. **Web: run UI.** Live node state, gate Approve in Inbox and on the node, Board "Group by run" and run chip.
6. **Docs and QA.** CONTRACT v0.6, CHANGELOG 0.6.0, one real end-to-end run recorded in `plan.md`'s build log.

#### Contract additions for v0.6 (exact)

Rows
```ts
type Workflow = { id: string /* W-n */; projectId: string; name: string; currentVersion: number;
  createdAt: number; updatedAt: number; archived: boolean }
type WorkflowVersion = { workflowId: string; version: number; graph: Graph /* schema helm.workflow/1 */;
  author: 'user' | 'model'; summary: string; parentVersion: number | null; createdAt: number }
type RunStatus = 'running' | 'paused' | 'waiting' | 'done' | 'failed' | 'aborted'
type NodeState = 'pending' | 'ready' | 'queued' | 'running' | 'ok' | 'failed' | 'skipped'
  | 'waiting_gate' | 'abandoned'
type Run = { id: string /* R-n */; workflowId: string; version: number; projectId: string;
  status: RunStatus; params: Record<string, string>; driverSessionId: string | null;
  budgetUsd: number | null; costUsd: number; startedAt: number; endedAt: number | null; error: string | null }
type RunNode = { runId: string; nodeId: string; state: NodeState; attempt: number;
  taskId: string | null; agentId: string | null; startedAt: number | null; endedAt: number | null;
  output: { text?: string; ok?: boolean; filesChanged?: string[]; check?: object; verdict?: string; approved?: boolean } | null;
  error: string | null; costUsd: number }
type Step = { id: string /* <runId>:<nodeId>:<attempt> */; runId: string; nodeId: string; kind: 'agent' | 'shell' | 'review';
  sessionId: string; state: 'queued' | 'running' | 'done' | 'failed'; input: Record<string, unknown>;
  createdAt: number; claimedAt: number | null; doneAt: number | null }
```
`Task` gains `runId: string | null` and `nodeId: string | null`. `Question` gains `kind: 'approval'` with `runId`, `nodeId`.

Events, mod to hub
| type | data | projection |
|---|---|---|
| `wf.step.result` | `{ stepId, ok, text?, filesChanged?, check?, verdict?, findings?, agentId?, taskId?, error?, usage? }` | step done/failed; run node output; reducer advances |
| `helm.usage` (extended) | adds `runId?`, `nodeId?`; kinds `wf_step`, `wf_review`, `wf_draft` | usage rows; `Run.costUsd` |
| `agent.completed` (extended) | adds `costUsd?` | per-agent cost |

Events, hub-internal (recorded in the log so rebuild reproduces them, like `hub.task.diff`)
| type | data |
|---|---|
| `wf.created` / `wf.saved` | `{ workflowId, version, graph, author, summary }` |
| `wf.run.started` | `{ runId, workflowId, version, params, driverSessionId, budgetUsd }` |
| `wf.node.state` | `{ runId, nodeId, state, attempt, output?, error? }` |
| `wf.gate.opened` / `wf.gate.decided` | `{ runId, nodeId, message }` / `{ runId, nodeId, decision, comment? }` |
| `wf.run.finished` | `{ runId, status, error? }` |

Mod pull
- `GET /v1/sessions/:id/steps` -> `{ steps: Step[] }`, atomically claims this session's `queued` steps to `running` (same as `/jobs`). A hub without it must not break the mod: re-check every 60 s (the lesson in CHANGELOG 0.2.0, Fixed).

Web / commands
- `GET /v1/workflows?projectId=` -> `{ workflows }`; `POST /v1/workflows` `{ projectId, name, graph? }` -> `{ workflow }`
- `GET /v1/workflows/:id` -> `{ workflow, versions: WorkflowVersion[] }`; `PUT /v1/workflows/:id` `{ graph, summary? }` -> new version (validated; 400 `{ error, issues[] }`)
- `POST /v1/workflows/:id/run` `{ version?, params?, sessionId?, budgetUsd? }` -> `{ run }`; 409 `no live session`
- `GET /v1/runs?workflowId=&status=` -> `{ runs }`; `GET /v1/runs/:id` -> `{ run, nodes: RunNode[], steps: Step[] }`
- `POST /v1/runs/:id/pause` · `/resume` · `/abort`
- `POST /v1/runs/:id/nodes/:nodeId/retry` · `/skip`
- `POST /v1/runs/:id/gates/:nodeId` `{ decision: 'approve' | 'reject', comment? }`
- SSE entities: `workflow`, `run` (row = Run with `nodes` inlined). `/v1/state` gains `workflows`, `runs`.
- Sweep additions: queued steps older than `HELM_JOB_MS` -> failed `not picked up by a live session`; `waiting` runs re-evaluated.

Exit criteria for phase 1
- [ ] `node --test hub/test/` green including new `v06` tests; `claude plugin test` green; `tsc` clean.
- [ ] Kill -9 the hub mid-run: run resumes, no step runs twice (assert by `stepId`).
- [ ] The template "build -> test -> gate -> review -> merge" runs end to end on a scratch repo: cards appear in the right lanes, the gate pauses until Approve in Helm, a failing test routes the `fail` edge.
- [ ] Canvas: pan, zoom, drag node, connect, edit in inspector, save a version, restore an old one; works in light and dark; keyboard path to run and approve.
- [ ] Cost: run total equals sum of node costs; review node cost matches `usage` from `model.complete`.
- [ ] No new npm dependencies; no console errors in the browser pane.
- [ ] Shell node on desktop shows the degrade warning (or is proven to work).

### Phase 2: describe it, reuse it (about 1 week)

- Prompt-to-workflow (`wf_draft` Job, validator repair loop, patch edits by prompt), template gallery stored in the `templates` table (shared with 3.5), session and prompt nodes (needs S1), condition, wait.
- **Exit:** "build a login page then test it and ask me before merging" produces a valid graph that opens on the canvas and runs; invalid model output is repaired or reported without a crash; session node proven across two real sessions.

### Phase 3: control and insight (about 1 week)

- Parallel and join, loops with `max`, per-run budget gate, run history and replay, estimates before run.
- Review queue (3.1) as the gate screen; Cost analytics (3.2); Notifications (3.3).
- **Exit:** a parallel three-branch refactor in worktrees joins and passes review; one Approve from the Review queue resumes the run; the cost screen's totals match the sum of run costs.

### Phase 4: breadth (as appetite allows)

- Session health (3.4), Templates for tasks (3.5), Quick capture (3.6, behind the token-protected bind), Timeline (3.7), Git/PR node and button (3.8), Learn++ (3.9).
- **Exit:** each ships behind its own checklist; none changes an existing contract shape without a CONTRACT entry in the same change.

### Open questions

1. Gate answerable from the terminal too (`/helm approve R-3`)? 2. Default `budgetUsd`? 3. Workflows per project only (assumed) or global? 4. Session and prompt nodes in phase 2 (they depend on S1)?
