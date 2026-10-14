# Changelog

All notable changes to Helm are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Shapes and endpoints are defined in `CONTRACT.md`.

## [Unreleased]

## [0.25.8] - 2026-10-13

### Fixed

- The Auto toggle and the x1-x5 picker are back on every Up next header (T-96). T-67's group-by lanes built their own Up next columns without the controls, and the controls only lived on the Status board's single column, so Project and Agent grouping lost them. One shared builder now serves the Status column and each lane: a project lane gets Manual | Auto and x1-x5 for its own project, a single-project Status board keeps them, and "All projects" (and a lane mixing projects) shows the compact Auto n/m popover with each project's mode and concurrency. The rule is a pure `autoHeader()` in `web/boardview.js` with node tests. Web only, no hub restart.

## [0.25.7] - 2026-10-13

### Changed

- Pending notes can be edited and deleted from the sheet (T-73). Notes under "Will be sent with Start" show Edit and Delete on hover and keyboard focus, edit inline (Enter or Cmd+Enter saves, Esc cancels, Code mode included), ask a small inline "Delete?" confirm, and have the same two actions in the right-click / Shift+F10 menu. The hub already refused edits and deletes once a note is no longer a draft (409); tests now cover pending edit (attachments kept) and delete, replay, and refusal after Start folds or a note is queued or sending. No hub restart needed for the UI change.

## [0.25.6] - 2026-10-13

### Fixed

- Agent end no longer forces parked cards (T-53). A task in `later`, or `blocked` by the user, keeps its status (and the user's reason) when its agent finishes or fails.
  The end, tokens, `interrupted` (Resume), report, files, diff and recap are still recorded, and the recap safety net covers these cards. Who set a block is stored in `tasks.blocked_by` (`user` for a PATCH, null otherwise); failure, stall and workflow blocks behave as before.

## [0.25.5] - 2026-10-13

### Fixed

- Overlapping ticks (T-52). When a tick hung for 20 s the watchdog started a new one, and the old tick's `finally` later cleared `ticking` while the new tick still ran,
  so two ticks overlapped. Each tick now takes a generation token and only the newest may clear the flag; the watchdog reads the engine clock. `runCompacts`,
  `runRecaps`, `flushChoices` and `captureGitBases` got in-flight guards, so a resumed old tick cannot compact a note twice, emit a recap twice or shift a queue twice.

## [0.25.4] - 2026-10-13

### Fixed

- A card the main loop was working on kept collecting its tool calls and files after you moved it to done, later or review in the web
  UI (T-51). The hub now attributes a main-loop tool event, its files, mentions and git base to the tagged card only while that card is
  `in_progress` when the event is projected (event order, so `--rebuild` gives the same result); otherwise the row stays session-level.
  The mod drops its `mainTask` tag when the hub reports the card left `in_progress` (one card check every 12 s, only while a tag is
  set). A hub restart is needed for the hub half to take effect.

## [0.25.3] - 2026-10-12

### Fixed

- Talk replies still missing after T-68 (T-95). Cause: Claude Code loaded the installed plugin copy `helm@helm-local` (stale 0.2.0 in
  `~/.claude/plugins/cache/helm-local/helm/0.2.0`, no reply code and a three-action `task` tool) next to the dev link, and that copy delivered the
  notes and registered the tool. The fix is outside the repo: refresh or disable the installed copy (see README, "One copy only").
- `session.started` now carries `mod: { version, root, installed }`, so the events show which copy of the mod a session runs.


## [0.25.2] - 2026-10-12

### Fixed

- Recaps (T-76). Recaps came out cut off or with an empty/one-word "How", and a finished card could stay without one. The parser read one line per label, so a
  `HOW:` followed by bullets gave `- **Hub:**`; `hub/recap.mjs` (typed copy `hooks/recap.ts`) now reads plain, bold, heading and multi-line
  sections and TAGS, and cuts at a sentence. The full final report now travels in `agent.completed` (`data.report`, stored on `agents.report`), the mod
  saves its recap queue in `$.store` (`recaps:<session>`) and restores it on `session.start`, and the sweep gives a review/done task whose agent
  finished more than `recapGraceMs` (3 min) ago a recap: parsed from the stored report, else a Haiku `recap` job built from its activity trail.
- `POST /v1/recaps/backfill` (and `helmd --backfill-recaps [--dry-run] [--improve] [--reports FILE]`) repairs existing cards. It records
  `recap.generated` / `hub.agent.report` events, so `--rebuild` replays it.

## [0.25.1] - 2026-10-11

### Fixed

- Markdown renderer (T-55): a paragraph with more than 500 emphasis/code spans no longer loses its tail; when the inline loop guard trips, the
  remaining text is appended as plain text.

## [0.25.0] - 2026-10-11

### Added

- Studio `diagram` block (T-74). The model used to fake diagrams as ASCII art in code blocks. A diagram is now a block whose text is a
  small flowchart language: nodes with shapes (`id[Box]`, `id(Round)`, `id[(DB)]`, `id{Diamond}`), edges with optional labels
  (`->`, dashed `-->`, chains), titled groups and a direction (`dir TB|LR`). `web/studio/diagram.js` is pure and shared by the browser
  and the hub: a parser returning `{ nodes, edges, groups, errors }` (errors carry line numbers), a deterministic layered layout with
  no dependencies (cycle breaking, layers, barycenter ordering, no overlapping nodes) and an SVG string builder that escapes every label.
  `web/studio/diagramdom.js` draws the same picture with `createElementNS`.
- Editing: the source sits beside a live drawing (below it on a narrow page) with parse errors listed under it; the paper preview, print
  and the floating pill draw the SVG. A new empty diagram starts from a small example.
- Export: HTML and PDF carry inline SVG; markdown writes a ```` ```diagram ```` fence. Word: `textutil` drops SVG and every image, so
  each diagram is drawn to a PNG by headless Chrome, a placeholder goes through `textutil`, and `hub/zipedit.mjs` (node:zlib) puts the PNGs
  into the docx. Without Chrome, or for a diagram that does not parse, the docx shows a "diagram not drawn" note and the source text.
- Judging: `diagram` is in the block schema; a `replace_text`, `replace` or `insert_after` that leaves a diagram unparseable is a
  conflict whose reason is the parse error. `doc_draft` and `doc_edit` prompts teach the language and forbid ASCII art.
- Project context for drafts: `doc_draft` input now has `brief`, built by the hub (`hub/docbrief.mjs`): project name and folder, the
  first ~1500 characters of README.md, the plan.md headline, the project's top Learn concepts and the newest recaps' "what" lines, capped at
  9000 characters (about 2.3k tokens). Only README.md and plan.md are read (first 6 KB, regular files, no symlinks). The prompt says to use
  only the request and the brief and to write `[placeholder]` for anything else.
- Tests: `t74diagram.test.mjs` (parser, layout, escaping, judging, zip, export) and `t74brief.test.mjs`; two mod tests for the new prompts.

### Changed

- `doc_draft` allows 6000 output tokens (was 4000) because diagrams add text. `CONTRACT.md` gains "Diagram DSL" and "Project brief".
- Plugin and `hub/package.json` version 0.25.0.

### Needs a hub restart

The hub must be restarted to serve the diagram export, the judging rule and the brief; the web UI reloads itself. The mod prompts
hot-reload with the session.

## [0.24.2] - 2026-10-11

### Added

- Up next auto concurrency (T-71): a per-project `autoConcurrency` (1-5, default 1) set with `PATCH /v1/projects/:id`, recorded in
  `hub.project.update` so `--rebuild` keeps it. Auto mode now keeps up to N tasks busy (in progress plus starts still in flight),
  starts several in one pass, and skips tasks whose `dependsOn` are not all done. A small x1-x5 picker sits beside the Auto toggle.
  New column `projects.auto_concurrency` (additive migration). The running hub needs a restart to pick this up.

## [0.24.1] - 2026-10-11

### Added

- `hub/test/v15studio.test.mjs` (T-63): one end-to-end Studio test on a temp `HELM_HOME` hub that acts as the mod. Create, `doc_draft`
  claim and result (version 1), comments, Apply all with applied, refused and failed patches (exactly one new version), revert
  reopening the applied comment, html export (pdf and docx when Chrome and `textutil` exist), and `--rebuild` giving identical state.
  It also checks `/v1/health` against the plugin manifest.

### Changed

- `CONTRACT.md` v0.15 now lists every `/v1/docs` route (including `POST /v1/docs/export`), the input and output JSON of the
  `doc_draft` and `doc_edit` jobs, the patch ops and the judging rules. `README.md` has a Studio section and
  `docs/PLAN-studio.md` a status note (shipped vs open).
- Changelog tidied: `[Unreleased]` is back at the top, and the T-58 hub-side Studio entry that sat in it now lives under 0.20.0.

### Fixed

- Version drift: `/v1/health` reported 0.19.3 because `hub/config.mjs` and `hub/package.json` were never bumped. `VERSION` is now
  read from `.claude-plugin/plugin.json`, and `hub/package.json` is kept equal to it (a test checks both).

### Needs a hub restart

- Only to make `/v1/health` report the right version.

## [0.24.0] - 2026-10-11

### Added

- Floating Studio pill (T-62). **Pop out** in Studio opens the current document in a draggable, resizable floating window (the same
  window code as the detached Talk window) that stays with you on every Helm screen. It shows the title, a status (saved, drafting,
  applying n/m, editing or conflicts), a live A4 preview that re-renders as you type in Studio or when the hub reports a new
  version or a finished job, an **Apply all (n)** button (enabled only while there are open comments) and an Open in Studio link.
  Minimising it puts a chip on the right-edge shelf with a status dot, the short title and the open comment count; clicking the
  chip restores the window. Open or minimised state and position are remembered per browser. The preview is built with DOM calls
  only. Pure logic is in `web/studio/pillmodel.js` with tests in `hub/test/t62studiopill.test.mjs`.

## [0.23.1] - 2026-10-11

### Fixed

- Talk no longer waits forever on a session note (N-74, N-81, N-84). Cause: the mod reloads about half a second after a note's
  turn starts, and the turn-to-note map was only saved by a 2 s timer, so the reload dropped it and the reply was never sent.
  The map (and a list of notes still awaiting a reply) is now saved at submit, at `turn.start` and at `turn.complete`, and the
  reply event is saved to the outbox at once. A reconcile step reads the session transcript for any note its turn could not
  answer (reload, note folded into a running turn, empty answer) and takes the text after the last tool call of the turn that
  carried the "Helm note (N-x)" marker; if the transcript cannot give a reply it posts a short "replied in the session" notice.
  Added hub tests that `note.reply` pushes a live note upsert.

## [0.23.0] - 2026-10-11

### Added

- Studio drafts and edits with the model (T-59). **Create** now creates a hub document and queues a `doc_draft` job: the mod runs
  Sonnet (4000 max tokens, strict JSON-only system prompt) and returns `{"blocks":[...]}` in the block schema (headings 1-3,
  paragraph, list item, quote, code, bold/italic marks). The hub validates it and stores it as version 1. The page is locked and
  shows "Sonnet is writing... 12 s" while the job runs, and you can leave the screen. A draft that fails (cut-off or invalid JSON,
  or the doc was edited meanwhile) leaves an empty, editable document with the reason.
- **Apply all** is one `doc_edit` job (Sonnet, 2500 max tokens). It sends only the commented blocks, one neighbour block each side
  and the outline, each block with a content hash. The model returns one patch per comment: `replace_text`, `insert_after`,
  `delete`, `retype` (or `reply` to refuse). Both jobs are metered in `helm.usage` like the other jobs.
- Hub judging is deterministic code, not the model (`judgePatches`): the block must exist, its hash must still match what was sent
  (a block you edited while the job ran is a conflict and your text is kept), the patch must target the block its own comment is on
  (only `insert_after` may sit beside a commented block), the result must pass the block schema, and two comments cannot rewrite
  the same block. All valid patches land as ONE new version.
- The comments rail shows a result chip per comment (waiting, applied with its version, or conflict with the reason), a progress
  card while the job runs, and a card after it lands with **Undo all**. Undo reverts to the version before the batch and re-opens
  exactly the comments it had applied. Undo is offered only while the document is still at the applied version.
- `web/studio/store.js` now has a hub backend (`/v1/docs`) next to the local one and picks per document id (D-n on the hub, L-n in
  the browser). A browser-only document that has a project is moved to the hub, with its comments, the first time it is saved
  while the hub is reachable. Without the hub, or without a project, everything still works locally. Saves are block-level diffs
  (`web/studio/sync.js`), so tables and images the editor shows as flat text are never overwritten. Export of a hub document now
  uses the hub's copy, which keeps bold and links.
- `POST /v1/docs/:id/edit` inserts may carry a block id (`b<n>`) which is kept when free, so a comment made on a freshly typed block
  keeps pointing at it. `state.docs` is now part of the web store (the SSE `doc` entity).
- Tests: `hub/test/v19studiojobs.test.mjs` (patch judging, hash conflicts, scope rule, one version per batch, revert, rebuild),
  `hub/test/v19studioweb.test.mjs` (hub store against a real hub, diffs, migration, offline), and four mod tests in
  `hooks/register.test.ts` (both kinds claimed, run on Sonnet, metered, bad JSON becomes a failed job, reload re-runs an
  in-flight doc job).

### Changed

- `doc_draft` replies are JSON blocks (markdown is still accepted by the hub as a fallback). The mod checks that a doc job's reply
  is valid JSON with a non-empty `blocks` / `patches` list before reporting it, so a reply cut off by the token limit fails the job
  early instead of reaching the hub as text. `doc_edit` now sends the neighbour block on both sides (it used to send the heading
  above and one block below).
- Going back past an Apply all (`POST /revert`) re-opens the comments that batch had applied.
- The Studio view watched the entity `projects` (never fires); it now watches `project`, `job` and `doc`.

### Needs a hub restart

- The running hub keeps the old judging code, so restart it (`node hub/helmd.mjs --stop`, then start it again) and reload the Helm
  mod (`/reload-plugins`) to get the new prompts. Nothing needs migrating: no new tables, and old queued jobs without hashes are
  judged the old way.

## [0.22.1] - 2026-10-11

### Changed

- Talk header: the session name is now a plain label that drags the floating window, and the session picker moved to the Talk
  icon. Hover (short delay) or click it for a compact popover of sessions grouped by project, newest first, with the current
  one checked and a dot on busy ones. Enter, Space or ArrowDown open it; arrows move, Enter picks, Esc closes.

## [0.22.0] - 2026-10-11

### Added

- Right-click menu (`web/contextmenu.js`, reusable): opens at the pointer and stays inside the viewport (flips above or left
  when there is no room), with separators, headings, submenus, shortcut hints, checked rows and destructive styling. Keyboard:
  arrows, Home/End, Enter/Space, Right/Left for submenus, Esc, type-ahead; Shift+F10 or the menu key opens it on a focused
  card. It closes on an outside click, scroll, resize or window blur, gives focus back to the card, and works in both themes.
- Task menu (`web/taskmenu.js`) on Board cards, Review queue rows and Today agent chips: Open, Start (Resume when the task is
  interrupted), Chat, Add note, Move to (submenu), Add dependency (submenu of open tasks in the same project), Copy ID, Copy
  link and Archive (with Undo). Each item calls the action the hover bar or detail panel already uses. "Move to project" is
  shown disabled: the hub ignores `projectId` on `PATCH /v1/tasks/:id`, so a task cannot change project yet.
- Board View control: Group by Status (the kanban, unchanged), Project (a collapsible swimlane per project, each with its own
  status columns), Agent (a lane per model, "No agent" last) or None (one flat list with a status chip on each card). Filter
  chips for status, project (only when there is more than one), has agent and needs you. Sort: Manual, Newest, Updated (cards
  that need you stay on top). The old "Needs me" button is the same filter.
- Saved views: name the current view and switch between them from pills next to the View button or from the popover. They are
  kept in `localStorage` (try/catch, `helm.board.view` and `helm.board.views`); the hub has no settings store for this yet.
- With "All projects" selected and tasks from more than one project, a quiet "N projects here, group by project" hint appears
  in the bar (dismissible).
- Drag and drop works inside a lane. Dropping on another lane is refused (no-drop cursor) because the hub cannot move a task
  between projects; in a sorted view a drop changes only the status. `hub/test/v18boardview.test.mjs` covers grouping,
  filtering, sorting, saved views, lane drop rules and the menu's placement and keyboard helpers.

## [0.21.3] - 2026-10-11

### Fixed

- Review showed "No files changed" for work the mod spawned itself (follow-ups, workflow agents) and for tasks the main
  loop did (`work`). A plugin's own `$.agent.spawn` skips the mod's `agent.spawn` hook, so no git base was queued; the
  reconciler now takes one for any running `[helm:T-n]` agent it discovers (`agent.git` with `discovered: true`, which
  never replaces a real base). `tool.call` does not appear to fire for those agents' tool calls (their rows show no tool
  activity), so files can no longer depend on it.
- A task's files are now derived from git: `git diff --name-only <base>` plus untracked files, kept only when the task's
  own tool calls named them (Edit/Write paths, paths inside Bash commands, tool summaries). With no path information the
  whole delta is shown, labelled "unattributed". The result is stored as a `hub.task.files` event, so `--rebuild` is
  deterministic and git is never asked on replay.
- The same file recorded as relative and absolute is listed once in a task diff.

### Added

- `POST /v1/tasks/:id/files { files, root?, note?, replace? }` attaches files to an existing task (backfill). With
  `root` and no recorded base, the repo's HEAD becomes the base. Tests: `hub/test/t66files.test.mjs`, mod tests in
  `hooks/register.test.ts`.

## [0.21.2] - 2026-10-11

### Fixed

- Code mode: the highlighted layer and the textarea now wrap identically, in the Talk composer and every gutter editor
  (task description, template, review). The closing quote and `;` hang in the right padding with zero layout width, the
  `const msg = "` prefix is unbreakable (matching the textarea's text-indent), both layers use the same right padding,
  border-box sizing and `white-space: break-spaces`. The caret now reaches the end of every line and the field grows on
  exactly the keystroke that wraps. Web only, no hub restart.

## [0.21.1] - 2026-10-11

### Added

- Resume: a card whose agent was stopped mid-flight (killed, stopped, failed, or its session ended) and that is not Done
  shows Resume (replay icon) instead of Start, on the hover bar and in the detail panel. The hub derives
  `task.interrupted` and `task.lastAgentId`; `POST /v1/tasks/:id/resume` (and `/start` on such a card) queues a task note
  and the mod spawns a `helm:builder` with the brief, the previous agent's recent activity, the files touched so far and
  an instruction to inspect `git status`/`git diff`, run the tests and continue without redoing or reverting work.
  Needs a hub restart (adds the `tasks.interrupted` column and back-fills it).

## [0.21.0] - 2026-10-11

### Added

- Studio export: an Export group (HTML, PDF, Word) in the Studio toolbar. The browser posts the document's block tree to
  the new `POST /v1/docs/export` (`{ format, title, blocks }`), so documents that only exist in localStorage export too.
  The hub validates the blocks, renders in a throwaway directory under `$HELM_HOME/tmp` and deletes it once the file has
  been sent. Nothing is recorded for these (there is no hub document); `POST /v1/docs/:id/export` still records
  `hub.doc.export`, and both routes now also accept `?format=html|pdf|docx|md`.
- A missing Chrome or `/usr/bin/textutil` is a clear `501` whose body carries a `hint` pointing at `window.print()`;
  a failed conversion is a `502` with the same hint.
- The PDF preview page now shows bold, italic and link marks (DOM calls only).
- Tests: `hub/test/studioexport.test.mjs` (serializer escaping, every block type, comments excluded, endpoints; the pdf
  and docx tests skip when Chrome or textutil is absent).

## [0.20.0] - 2026-10-11

### Added

- Studio documents, hub side (T-58): `docs`, `doc_versions` and `doc_comments` tables, `hub.doc.*` events, `/v1/docs` routes
  (create, edit, comment, apply, revert, export), `doc_draft` and `doc_edit` model jobs judged by the hub, HTML/Markdown/PDF/docx
  export, and search. See CONTRACT.md v0.15.
- Studio screen (`#/studio/<doc>`, sidebar entry "Studio"): a project picker and a "describe what to create" box, plus a
  block editor where every block (heading 1-3, paragraph, list item, quote, code) is its own `contenteditable`. Enter
  splits a block, Backspace at the start merges into the previous one, paste is plain text only, and typing `# `, `- `,
  `> ` or three backticks at the start of a line changes the block type. Block text is written with DOM calls only
  (never `innerHTML`); a test enforces that for the Studio sources.
- Comments: select text and press Comment (bubble, toolbar button or Option+Cmd+M). Each note is pinned to a block id
  plus the quoted text, highlighted in the page, listed in a right rail with an "Apply all (n)" button, and re-anchors
  as the text is edited (or shows "text changed" when the quote is gone).
- PDF preview tab: an A4 print-styled page built from the same blocks, and a "Print / Save PDF" button that calls
  `window.print()` (print CSS hides the app chrome and prints only the page).
- `web/studio/store.js`: documents and comments persist behind one small async interface. Today it uses localStorage
  (try/catch, memory fallback); the header documents the mapping to the hub's `/v1/docs` routes for the swap.

### Fixed

- Agents Helm spawns itself (note follow-ups, workflow agent steps) now show on their card. `$.agent.spawn` from the mod
  skips the `agent.spawn` hook, so the mod announces them (`agent.spawned` + `agent.bound`), and reconcile binds any
  discovered agent whose description carries `[helm:T-n]` to that card.
- The connection pill no longer shows live for a replaced event stream: `openStream()` now ignores the resync result of an
  `open` or `reset` event when a newer EventSource has taken over, so it cannot set `live` or schedule a reconnect.

### Known gaps

_Both gaps were closed in 0.23.0 (jobs, Apply all and the hub store)._

- "Create" does not call the `doc_draft` job yet (the new document starts with the description as a quote) and
  "Apply all" does not call `doc_edit` yet; both are marked with `TODO(doc_draft)` / `TODO(doc_edit)` and the screen says so.
- Documents are stored in the browser until the hub backend is switched on in `studio/store.js`.

## [0.19.6] - 2026-10-11

### Changed

- Talk's header is now a single compact row (title, session switcher, model badge, detach, minimise, close) in both the
  docked panel and the floating window, so the thread gets more height. The switcher truncates with an ellipsis and
  never wraps; the project and folder line moved into its tooltip.

## [0.19.5] - 2026-10-11

### Fixed

- The board card's hover buttons now sit on an opaque bar at the bottom-right instead of a see-through one over the
  title, and Start no longer overlaps the Done icon.

## [0.19.4] - 2026-10-11

### Fixed

- A queued `/compact` note now survives a mod reload (kept in the plugin store and restored on start); before, the
  reload dropped it and the note sat in "sending" until the hub timed it out.
- The `task` tool's `work` action only tags the main loop's tool calls with a card once the hub accepted the id.
  A mistyped id used to leave later calls tagged with a card that does not exist.
- A key-less `keydown` (browser autofill dispatches them) no longer throws in the global shortcut handler or the
  review view's key handler.

### Tests

- Mod tests for `/compact` notes (run, reload restore, failure) and the `work` action (+4, 101 in all).

## [0.19.3] - 2026-10-11

### Fixed

- Work the main session does itself is now recorded on its card. The `task` tool's new `work` action sets the
  card in progress, and the main loop's tool calls and files then show in its activity until it moves on.
- The `task` tool retries for a few seconds while the hub reconnects after a mod reload, instead of failing (a
  failed status update had left T-47 showing In progress).
- `/compact` notes surface errors instead of hanging in "sending"; they wait while a turn runs and compact
  between turns.

## [0.19.2] - 2026-10-10

### Added

- `/compact [instructions]` as a Helm note to a session runs the engine's compaction once the session is idle,
  then replies "Compacted" under the note (slash commands in notes would otherwise arrive as plain text).

## [0.19.1] - 2026-10-10

### Fixed

- Workflow review steps now see each gate's decision, time, comment and message (the first real review
  reported the gate section empty).
- Saving in-flight jobs and steps is serialised, so steps finishing together no longer drop each other
  (which could re-run a shell step or re-bill a review after a reload).

### Added

- 16 mod tests for the workflow step runner (agent, shell and review steps, cost, resume after reload).

## [0.19.0] - 2026-10-10

### Added

- Session health (`CONTRACT.md` v0.14): `Session` gains `contextWindow`, `contextPercent`, `rateLimits`, `busySince`, `lastTurnAt`, `stalledAgents`, `costToday` and a derived `health` (`ok | warn | critical` plus reasons: context above 70/85%, a rate limit above 80/95%, stalled agents, 30 minutes idle with agents running, cost today over `HELM_COST_WARN_USD`). A `session_samples` history (one a minute, kept 7 days), `GET /v1/sessions/:id/health` and `GET /v1/health/sessions`. Web: a Health screen at `#/health`, a context ring on Office desks, a header health dot, a Sessions group in the Inbox and a "Session health" Spotlight command.

## [0.18.0] - 2026-10-10

### Added

- Concepts (`CONTRACT.md` v0.13, Learn++): recap tags become first-class concepts (`Concept` rows with aliases, task links, related concepts, pin, an optional Haiku-written page). Hub: `hub/concepts.mjs`, `GET /v1/concepts`, `GET/PATCH /v1/concepts/:slug`, `POST /v1/concepts/merge`, `POST /v1/concepts/:slug/summarize` (job kind `concept_summary`), `concepts` in `/v1/state`, SSE entity `concept`, FTS kind `concept`, back-fill from existing recaps. Web: Learn is now Feed | Concepts, a concept page at `#/learn/c/:slug` (header, page, "Where you learned it" timeline, related), concept chips link to it everywhere, Spotlight finds concepts, Code mode renders the page as a doc comment.

## [0.17.0] - 2026-10-10

### Added

- A git branch and PR per task (`CONTRACT.md` v0.12): "Create branch" makes `helm/T-n-slug` in a separate worktree under `$HELM_HOME/worktrees` with only the task's files (your working tree and branch are never touched), "Update branch" adds commits, "Push & open PR…" pushes behind a confirm dialog naming the remote and branch and links a GitHub compare page, a pasted PR link (or the hub, for public repos) becomes a PR chip, and unauthenticated GitHub polling shows CI badges on the task and a branch glyph with a CI dot on the card. `needsYou` gains "CI failed". No tokens: pushes use your own credentials. Hub: `Task.branch`, `hub.task.branch` / `hub.task.ci` events, `hub/gitflow.mjs`, `hub/gitsync.mjs`.

## [0.16.0] - 2026-10-10

### Added

- Today (`#/today`): one Gantt-style timeline for every session's agents and workflow runs, with task markers, a summary strip (agent time, peak concurrency, tasks done, cost), range selection and a day picker.

## [0.15.0] - 2026-10-10

### Added

- Review queue (`#/review[/T-n]`, sidebar item with a count badge under Inbox, Spotlight "Review queue"): every task in Review in one two-pane workspace. Queue (oldest first or newest) with `+a −d`, recap line, time in review and run chip; per task the final report, recap, the diff (shared renderer, file tabs, unified/split, source badge), workflow shell checks plus the description's `Checks:` list as a local checklist, and Approve (A) / Request changes (R, a `!` task note) / Later (L) / J K skip / Enter opens the Diff panel / ? help. "Reviewed today: N". Web only, no hub change.

- Today (`#/today[/YYYY-MM-DD]`, sidebar item after Threads, Spotlight "Today's timeline"): a day Gantt across sessions. One lane group per session (agent bars coloured by status, model badge, task chip, main-session busy band), a Workflows group with node-step ticks, task-event diamonds (done / review / blocked / auto-start), a summary strip (agents by model, agent time, peak concurrency, tasks done, Helm overhead, longest task), zoom/pan/Fit/Day/Now, drag-to-select range summary, day picker, 1 fps live growth, virtualised rows. Web only, no hub change; the time-axis code now lives in `axis.js`, shared with the Threads timeline.

### Changed

- The diff row renderer moved from `views/diffpanel.js` to `diffview.js` so the Diff panel and the Review queue share it.

## [0.14.0] - 2026-10-10

### Added

- Task templates: save a task (brief, agent, checks) and start it in one click from the Board composer, Spotlight or the new Templates page. `{{var}}` blanks, usage counts, `/v1/templates` (CONTRACT v0.11).

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
