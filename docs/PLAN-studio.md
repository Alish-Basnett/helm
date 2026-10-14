# Helm Studio: feasibility of an "artifacts" drawing pad

Status: feasibility study, T-56, 2026-10-11. No code changed. Based on `hub/db.mjs`, `hub/projections.mjs`, `hub/hub.mjs`, `hooks/register.ts` (job runner, `JOB_SYSTEM`, `JOB_MODEL`), `web/dom.js`, `docs/PLAN-screens.md`, the engine types (`d.ts` = `.../plugin-authoring/types/claude-code.d.ts`) and three commands run on this Mac.

## Status (T-74, 0.25.0)

**Shipped**

| Piece | Task | Where |
|---|---|---|
| Hub documents: tables, `hub.doc.*` events, `/v1/docs` routes, versions, comments with anchors, search | T-58 | `hub/docs.mjs`, `hub/docsengine.mjs`, CONTRACT v0.15 |
| Export: html, md, pdf (Chrome), docx (`textutil`), also for a block tree the hub does not hold | T-60 | `studioexport.test.mjs` |
| Studio screen: block editor, comment rail, PDF preview tab, local and hub store | T-61 | `web/studio/`, `web/views/` |
| `doc_draft` and `doc_edit` jobs, Apply all with hub-side judging, one version per batch, Undo all | T-59 | `v19studiojobs.test.mjs` |
| Floating pill with live preview, status, Apply all and the shelf chip | T-62 | `web/studio/pillmodel.js`, `t62studiopill.test.mjs` |
| End-to-end test, contract, README and changelog | T-63 | `hub/test/v15studio.test.mjs` |
| Diagram blocks (text DSL, auto layout, SVG in the editor, paper, pill and export, PNG in docx, judged patches) and a project brief for `doc_draft` | T-74 | `web/studio/diagram.js`, `hub/docbrief.mjs`, `hub/zipedit.mjs`, `t74diagram.test.mjs`, `t74brief.test.mjs`, CONTRACT "Diagram DSL" and "Project brief" |

**Still open**

- Project context is a fixed brief (README start, plan headline, concepts, recaps); a read-only agent that explores the repo for a richer brief is not built. Diagram editing is text only (no drag to rearrange), and a diagram has one flowchart type.
- Images and tables are exported and preserved but not editable in the block editor; comments anchor to a single block.
- No choices for clarifying questions or conflict resolution, no history diff view, no re-anchor UI for orphaned comments.
- Templates, import of .docx/.html, a proofread pass, mobile view and comment-from-phone (phase 3).
- A job still needs a live Claude Code session with the Helm mod; the hub alone cannot call a model.

## Recommendation (read this first)

1. **Feasible, build it.** Every piece exists in Helm already except the editor itself. No new dependency is needed.
2. **Source of truth is a block tree (JSON), not a PDF and not raw HTML.** Each block has a stable id. It is rendered with DOM calls only, exported through a hub-side serializer, and sent to the model as markdown with block ids.
3. **Edit in place with per-block `contenteditable`**, plain text plus bold/italic/links, no `innerHTML` anywhere.
4. **Comments anchor to `{blockId, quote, prefix, suffix}`. "Apply all" is one Sonnet job** that gets only the commented blocks (plus their headings) and returns one JSON patch per comment. The hub validates and applies the patches deterministically, saves one version, and marks any patch it could not apply as a conflict.
5. **The drawing board and the floating pill are part of the plan (section 1b).** Studio is a board you can open standalone; a floating pill follows you around Helm and shows the live preview of the PDF; the finished PDF is shown on the board itself, not only downloaded.
6. **Export PDF with headless Chrome (verified: 4.7 s) and .docx with macOS `textutil` (verified).** Pandoc and LibreOffice are not installed, so they are optional upgrades only. MVP is about 2 to 3 weeks of focused work (L); the editor and comment anchoring are the risk.

## Facts checked on this Mac

| Check | Result |
|---|---|
| `which pandoc soffice libreoffice wkhtmltopdf` | none installed |
| Chrome | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (Brave also present) |
| Headless print | `Chrome --headless=new --no-pdf-header-footer --print-to-pdf=t.pdf file://t.html` wrote a valid PDF in 4.7 s (13 KB for a trivial page). A harmless `CVDisplayLink` error is printed; ignore it. |
| HTML to docx | `textutil -convert docx t.html` wrote a valid .docx (headings, bold, lists, a table). `textutil` ships with macOS. |
| Node | v24.18.1, so `node:child_process`, `node:sqlite`, `node:zlib` are all built in |

## 1. Standalone Studio screen

A new route `studio` in `web/router.js` (`VIEWS`), a full screen, not a Dock panel. Layout:

- Left rail: documents grouped by project, plus "New".
- Centre: the page (white sheet, print-like width), toolbar (bold, italic, heading, list, Export, History).
- Right rail: comments, each with status (open, applied, conflict), and an "Apply all (n)" button.

"New" flow: choose project (existing project picker), choose kind (report, letter, one-pager, CV, free), type the description, optional attachments (reuse `web/attachments.js`). Submit creates the doc and a `doc_draft` job.

**Routing: use a hub job, not a note to the project's session.** Reasons:

- Notes go to the session as a prompt (`note_turn`), so they interrupt the agent that is working on a task, use tools, and return unstructured text. Studio needs structured JSON and a cheap, tool-free call.
- Jobs already do exactly this: `hub.job.create`, the mod claims it in `pollJobs`, runs `$.model.complete`, and emits `job.result` (`hooks/register.ts:453-486`).
- A job needs a live session id, but the work itself is model-only, so the project's session is only the *carrier*. Pick the most recent non-ended session of the chosen project; if none, any live session; if none at all, refuse up front with "No live Claude Code session with the Helm mod" instead of letting the job die on the existing `JOB_UNCLAIMED_ERROR` timeout (5 min, `config.mjs jobMs`).
- Project context (so the doc can say true things about the project) is phase 2: a read-only `$.agent.spawn` that summarises the repo into a context block stored on the doc. Not needed for "make me a CV" or "write a proposal".

New job kinds: `doc_draft` and `doc_edit`. Touch points: `JOB_SYSTEM` and `JOB_MODEL` in `hooks/register.ts` (Sonnet for both, `maxTokens` about 6000 for draft, 4000 for edit), `USAGE_KINDS` and `REQUESTED_KINDS` in `hub/projections.mjs` (these are work the user asked for, so they belong in `REQUESTED_KINDS`, not overhead), and `JOB_MODEL`'s existing `wf_draft` pattern for the model choice.

## 1b. Drawing board, floating pill, and PDF preview

This was in the original brief and missing from the first version of this doc. It is added here.

**Drawing board (the standalone page).** The `studio` route above is the board: open it from the sidebar with no task needed, pick a project, describe what you want, and the result appears on the white sheet. The sheet has two tabs:

- **Edit**: the block editor from section 3, with comments in the right rail.
- **PDF preview**: the real exported PDF, shown in an `<iframe>`/`<embed>` pointed at `GET /v1/docs/:id/export.pdf?v=n` (Chrome and Safari both render PDFs natively, so no viewer library). The preview is re-rendered when the version changes (after a draft, an edit, or Apply all), with a "Rendering..." state for the ~5 s Chrome takes. What you see in this tab is byte-for-byte what Export downloads, which is the point: no surprise between preview and file.

**Floating pill.** Reuse `web/floating.js` (`createFloating`: draggable, edge-resizable, persisted geometry, z-index 80..89, double-click to compact) and `web/shelf.js` (minimised chips, same pattern as the floating Talk window). Design:

- Collapsed, it is a small pill showing the current doc title and a status dot: drafting, applying n comments, rendering PDF, ready, conflict. It stays visible on every Helm screen, so you can leave Studio while a draft or an Apply all job runs.
- Click to expand into a floating window with a **live PDF preview** (same `export.pdf` embed) plus the comment count and an "Apply all (n)" button, so you can review output and fire the batch without going back to the board.
- Job events (`job.result`, `hub.doc.applied`) arrive over the existing SSE stream; the pill updates the status and refreshes the preview when a new version lands. A toast on completion, like other jobs.
- "Open in Studio" button on the pill jumps to the board; minimising sends it to the shelf as a chip.

**Output presented on the PDF.** After "Apply all", the preview shows the new version. Two details make the loop visible:

1. The hub renders a second HTML variant for preview only, with changed blocks marked by a soft highlight (and optional margin comment numbers). Export downloads the clean variant. Both come from the same serializer with one flag, so the layouts are identical.
2. Each comment in the rail links to its block; clicking a comment scrolls the Edit tab to it, and in the PDF tab it jumps to the page holding that text (phase 2; needs text-to-page mapping from the render, so MVP only highlights, it does not jump).

Limits worth knowing: you edit blocks on the Edit tab, not by clicking directly on the PDF (PDF has no editable text layer here, section 2). Comments are placed on the Edit tab text, and the PDF tab is the faithful read-only result. Direct "click on the PDF page to comment" is a phase 3 stretch that needs coordinate-to-block mapping.

Cost/effort: the pill is small (S to M), because floating window, shelf chip, SSE and job wiring all exist. The PDF tab is S once export works. Both go into Phase 1, not later.

## 2. Document model and export

**Decision: block tree JSON.** Not binary PDF (cannot be edited like Word), not a raw HTML string (needs sanitising, no stable anchors), not markdown as the stored form (loses ids, tables and images are awkward).

```
doc.blocks = [
  { id:'b1', type:'h1'|'h2'|'h3'|'p'|'li'|'quote'|'code'|'hr'|'img'|'table', text:'plain text', marks:[{s,e,t:'b'|'i'|'a',href?}], ... }
]
```

- Lists are flat `li` blocks with `level` and `ordered`. Tables hold a 2D array of plain strings (phase 2). Images reference an attachment id (phase 2).
- Everything is plain strings plus a small mark list, so the hub can validate with a whitelist and a length cap, like it does for notes.
- **Model I/O is markdown with block ids** (`<!--b3-->` line prefix, or a JSON list). Models write markdown well, and a tiny parser/serializer turns it into blocks. Check whether `web/markdown.js` can be reused for the parse side (unverified); otherwise write ~100 lines.
- **Export** (hub, after validating the doc):
  1. Serializer walks the blocks and writes an HTML string with every text run escaped (`& < > "`) and a fixed print stylesheet. This is server-side string building from a closed block vocabulary, not browser `innerHTML` of untrusted content.
  2. PDF: write to `$HELM_HOME/studio/<doc>/<n>.html`, run Chrome headless `--print-to-pdf`, return the file via a `GET /v1/docs/:id/export.pdf?v=n` route. Use a temp `--user-data-dir` so it never touches the user's profile.
  3. .docx: `textutil -convert docx` on the same HTML. Fidelity is basic (fonts, headings, lists, simple tables are fine; page headers and complex layout are not).
  4. Zero-install fallbacks: a "Print" button calling `window.print()` with `@media print` (works on any machine, including the phone), and `.html` download.
- Pandoc or LibreOffice: **do not depend on them.** If `which pandoc` ever succeeds, prefer it for docx (better styles); detect at runtime and fall back to `textutil`. Not on this Mac, so not MVP.
- Where the export runs: the hub is a local Node daemon (`helmd.mjs`) and can spawn Chrome with `node:child_process` itself. If a remote hub is ever used (`remote.mjs`), the export moves to a `doc_export` job using `$.process.run(argv, { timeoutMs })` (`d.ts:3470`, 30 s default, so set it to 60 s). Decide in the phase 0 spike.
- Editing an *existing* binary PDF is out of scope: no PDF text-extraction tool is installed and round-tripping layout is not feasible. Importing .docx/.html works via `textutil -convert html` (phase 3).

## 3. Word-like in-place editing

Plan: each block is its own `contenteditable="plaintext-only"` element (`<p>`, `<h2>` ...) created with `document.createElement` and `textContent`, in a column. Bold/italic/link marks are applied by a toolbar that edits the block's `marks` array and re-renders the block through `createElement` of `<strong>`, `<em>`, `<a>` spans. Nothing parses HTML, so Helm's rule on `innerHTML` holds (`web/dom.js` only uses `textContent`; the one existing `innerHTML` use is the trusted icon template, `web/icons.js:91`).

- Why per block: stable ids for comments, small patch units for the model, per-block undo-friendly diffs, and no browser-generated markup soup (the classic `contenteditable` problem). Enter splits a block, Backspace at the start merges, both handled in JS; paste is intercepted and inserted as plain text (`beforeinput` / `paste` event, `clipboardData.getData('text/plain')`).
- Autosave: debounce 800 ms, send a block-level diff (`hub.doc.edit`), not the whole doc.
- Browser undo (`Cmd+Z`) works inside a block. Cross-block structural undo uses the version history (section 5).
- Hand-rolled editing has real costs: IME composition, selection across blocks, mobile keyboards. MVP limits selection-based comments to a single block (see section 4). A library (Tiptap/ProseMirror) would solve these but breaks the zero-dependency rule; that is a decision to revisit only if phase 2 hurts.

## 4. Anchored comments and "Apply all"

**Anchor:** `{ blockId, start, end, quote, prefix, suffix }`. On render, trust `start/end` if `text.slice(start,end) === quote`; otherwise search for `prefix+quote+suffix`, then `quote` alone; if still missing, mark the comment *orphaned* (shown in the rail, user re-anchors). Anchors are recomputed after each edit to that block.

**Comment:** `{ id, docId, anchor, text, state: 'open'|'applied'|'conflict'|'orphaned'|'dismissed', createdAt, appliedVersion }`. A comment may also be doc-wide (no anchor), e.g. "make the tone more formal".

**Apply all = one job (`doc_edit`), not one per comment:**

1. The hub collects open comments, then the blocks they point at, plus the heading above each and one neighbouring block for context, plus a 1-line outline of the whole doc (headings only). Whole-doc comments send the full doc.
2. One Sonnet call. System prompt (cache-friendly, fixed) says: return JSON only, one entry per comment id, never touch other blocks.
3. Reply shape:

```json
{ "patches": [
  { "commentId": "C-3", "blockId": "b7", "op": "replace", "find": "exact original substring", "with": "new text" },
  { "commentId": "C-4", "blockId": "b9", "op": "delete" },
  { "commentId": "C-5", "op": "insert_after", "blockId": "b9", "blocks": [ { "type": "p", "text": "..." } ] },
  { "commentId": "C-6", "op": "reply", "text": "Cannot do this: no data on revenue in the doc." } ] }
```

4. **The hub, not the model, applies it** (same pattern as `wf_draft`: the mod stores the raw reply, the hub judges it and emits the real event). For each patch: block exists, `find` occurs exactly once in the current block text (or `op` is block-level), result is within length caps, ops from the whitelist. Failing patches become `conflict` with the reason. Two patches touching overlapping ranges in one block: apply the first, flag the second as `conflict`.
5. **Conflict detection with concurrent edits:** the job stores `baseVersion` and a hash per sent block. If the user edited a sent block while the job ran, a patch whose `find` still matches applies cleanly (string-level, so unrelated typing does not break it); if not, it is a `conflict` and the comment stays open for a re-run. Typing during a run is therefore safe.
6. Result is one new version (one undo step for the whole batch), per-comment status updates, and a changed-text highlight in the page until dismissed.

**Cost control:** Sonnet only; send only commented blocks plus headings (a 10-page doc with 8 comments is roughly 1.5-3k input tokens and about 1k output, i.e. cents); fixed system prompt first so it caches; `maxTokens` capped; usage recorded as `doc_edit` in `usage` so the existing cost meter shows it. If the affected text exceeds roughly 6k tokens, split by section and run chunks sequentially in the same job. Do not fall back to Haiku for edits: wrong silent edits cost more than the saved cents.

## 5. Event sourcing and storage

Fits the existing contract: user/system facts are events appended to `events`, tables are projections rebuilt by replay, projections are pure (time is `ev.at`, no randomness; ids from `counters`, like `A-n`/`T-n`). Follow the `hub.*` naming of hub-originated events.

| Event | Data | Effect |
|---|---|---|
| `hub.doc.create` | `{ projectId, title, kind, prompt, attachments }` | row in `docs` (id `D-n`), empty version 0, queues `doc_draft` job |
| `hub.doc.rename` / `hub.doc.archive` | `{ id, title }` | update |
| `hub.doc.edit` | `{ id, baseVersion, ops:[{blockId, text, marks}...] }` | updates `docs.blocks`; **coalesced** into a `doc_versions` snapshot only on idle (5 min), apply, export or manual "save version", so typing does not create thousands of rows |
| `hub.doc.comment.add` / `.update` / `.delete` | `{ docId, anchor, text }` | `doc_comments` |
| `hub.doc.apply` | `{ docId, commentIds }` | creates the `doc_edit` job (reuses `hub.job.create`) and marks the comments `queued` |
| `job.result` then `hub.doc.applied` | `{ docId, jobId, baseVersion, results:[{commentId, status, reason?}], blocks }` | the hub's judged result: new version + per-comment status |
| `hub.doc.revert` | `{ docId, toVersion }` | writes a **new** version copying the old one (history never rewritten) |
| `hub.doc.export` | `{ docId, version, format }` | records the export (file lives on disk) |

Tables (added to `SCHEMA` in `hub/db.mjs`, plain `CREATE TABLE IF NOT EXISTS`, so a live DB gains them empty, as v0.11 templates did):

```
docs(id PK, project_id, title, kind, blocks TEXT /*JSON*/, version INTEGER, session_id, created_at, updated_at, archived)
doc_versions(doc_id, n, blocks TEXT, cause TEXT /*create|edit|apply|revert|manual*/, job_id, at, PRIMARY KEY(doc_id, n))
doc_comments(id PK, doc_id, block_id, anchor TEXT /*JSON*/, text, state, created_at, applied_version)
```

Also add the three tables to the rebuild list in `hub/hub.mjs:29`, a `search_docs` entry per doc (so global search finds Studio docs, via `setDoc('doc', id, title, text)`), a `toDoc` projection mapper and an SSE push (`emit('doc', 'upsert', ...)`), as other entities do. Undo = revert to a previous version; the History drawer lists versions with cause and a block-level diff (reuse `web/diffview.js` if it takes plain text; unverified).

Size: a snapshot is the whole block JSON (tens of KB at most). Cap 100 versions per doc, prune oldest `edit` snapshots first and never `apply`/`manual` ones.

## 6. Fit with existing pieces

| Existing | Reuse |
|---|---|
| Jobs pipeline | `doc_draft`, `doc_edit` kinds; claim/timeout/sweep/failure UI unchanged. Hub judging step copied from `wf_draft` |
| Notes / Talk | Right-rail "Ask about this doc" is the Talk component with `target_kind: 'doc'` for free-form instructions that are not anchored (they become doc-wide comments). Anchored comments are **not** notes: notes have a send/queue/reply lifecycle that does not fit |
| Attachments | Description attachments for context (text, images to describe); phase 2 image blocks reference an attachment id, the exporter inlines them as `data:` URIs |
| Choices (`web/choices.js`) | Before drafting an ambiguous request the model may return `choices` (tone, length, audience) rendered with the existing Choices component; and conflicts can be offered as choices ("keep mine / take rewrite") |
| Usage meter | `doc_draft`/`doc_edit` in `USAGE_KINDS` so cost shows per kind |
| Search | docs indexed in `search_docs` |
| Templates (v0.11) | phase 3: doc kinds as templates (CV, proposal skeletons) |
| Mobile `web/m/` | read-only view and export in phase 3 |

## 7. Phasing, effort, risks

**Phase 0: spike (S, 1-2 days).** Throwaway script: block JSON to HTML to Chrome PDF and textutil docx (done in principle above); a 200-line `contenteditable` per-block prototype checking Enter/Backspace/paste on Safari and Chrome; one `doc_edit` prompt on a real 3-page doc to confirm Sonnet returns valid patches ≥ 95% of the time. Confirm the session-carrier approach and whether hub-side `child_process` is acceptable. Go/no-go gate.

**Phase 1: MVP (L).** Studio route (the drawing board) with Edit and PDF preview tabs, floating pill with live preview, project picker, "new from description" via `doc_draft`, block model and hub tables/events, per-block editor with bold/italic/headings/lists, single-block comments, Apply all with validated patches and conflict states, versions and undo, PDF export (Chrome) plus Print fallback, usage and search wiring, tests (`hub/test/v15studio.test.mjs` in the existing style: replay, patch application, conflicts, rebuild determinism). Delivers the user's stated loop: create, edit, comment, apply all.

**Phase 2: M.** .docx export (`textutil`, Pandoc if present), images and tables, comments across several blocks, Choices for clarifying questions and conflict resolution, project grounding via read-only `$.agent.spawn`, history diff view, re-anchor UI for orphaned comments.

**Phase 3: M to L.** Doc templates, import .docx/.html (via `textutil`), second reviewer pass ("proofread" job), mobile read-only and comment-from-phone, optional shared page styles (letterhead, fonts), optionally Pandoc/LibreOffice-based higher-fidelity export if installed.

**Risks**

| Risk | Level | Mitigation |
|---|---|---|
| `contenteditable` edge cases (IME, cross-block selection, mobile) | High | per-block plain-text editing, intercept paste, single-block comments in MVP; phase 0 spike; revisit a library only if it fails |
| Model patch quality (wrong `find`, rewrites too much) | Medium | exact-match `find`, hub validation, per-comment conflict state, one-click undo of the whole apply, Sonnet not Haiku |
| docx fidelity from `textutil` | Medium | position as "good draft", PDF is the primary export; optional Pandoc upgrade |
| Chrome path or flags change; a headless Chrome failure | Low-medium | detect Chrome/Brave at startup, `window.print()` fallback, 60 s timeout, temp profile dir |
| Event volume from typing | Medium | block-level diffs, debounce, coalesced snapshots |
| Job needs a live session (hub alone cannot call a model) | Medium | pre-flight check with a clear message; this is an existing architecture limit, not new |
| Security: untrusted text from the model or pasted content into the page | Medium | closed block vocabulary, `createElement`/`textContent` only, escape in the exporter, link `href` limited to `http(s)`/`mailto` |
| Scope creep to "real Word" | High | non-goals: tracked changes, real-time collaboration, editing an existing PDF, page layout |

## Open questions for the user

- Is PDF the main deliverable (recommended) or is .docx equally important? It changes how much we invest in export fidelity.
- Should drafts know the project's code and docs (phase 2 grounding) or is a blank description enough for the first release?
- Single user on one Mac (assumed), or could the hub be remote? It decides where export runs.
