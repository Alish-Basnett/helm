// views/workflows.js — Workflows: a list of flows on the left, the canvas in the middle, the inspector on the right.
// Edit mode works on a local Doc (undo/redo, dirty tracking) and saves a new version through the hub, which validates.
// Run mode (`#/workflows/W-1?run=R-3`) shows the exact version that run started on, read-only, with live node states;
// the timeline lives in the Dock (wf/runpanel.js).
import { h, setText, setClass, setHidden, reconcile, bus, startTicker, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, upsert, lsGet, lsSet } from '../store.js';
import { api } from '../api.js';
import { navigate, setQuery } from '../router.js';
import { toast, toastError, openMenu, emptyState } from '../ui.js';
import { fmtAgo, fmtUsdSmall, fmtElapsed, truncate, plural } from '../format.js';
import { decideGate, controlRun, controlNode } from '../actions.js';
import { onBusy } from '../drafts.js';
import { Doc, summarizeChange, canon, clone, emptyGraph, isExec } from '../wf/graph.js';
import { createCanvas } from '../wf/canvas.js';
import { createPalette } from '../wf/palette.js';
import { createInspector } from '../wf/inspector.js';
import { openPop, closePop } from '../wf/pop.js';
import { ensureDetail, detailOf, onDetail } from '../wf/rundata.js';
import { noteGraph } from '../wf/labels.js';
import { RUN_LABEL } from '../wf/runpanel.js';

const TEMPLATE = { key: 'build-test-review', label: 'Build → Test → Gate → Review → Merge', hint: 'Build, run the tests (a failure goes to a fix step), wait for you, get an Opus review, then merge.' };
const LIVE = new Set(['running', 'waiting', 'paused']);
/** Unsaved edits per workflow, kept across navigation within the page: id -> { base, graph }. */
const drafts = new Map();

export function mount(container, route) {
  startTicker();
  let wfId = null;
  let detail = null; // { workflow, versions[] } from GET /v1/workflows/:id
  let doc = null; // the working copy (edit mode)
  let runDoc = null; // read-only copy of the version a run started on
  let viewRunId = null;
  let loading = 0; // request sequence, so a slow response for a previous workflow is dropped
  let issues = new Map();
  let issueList = [];
  let showArchived = lsGet('helm.wf.archived') === '1';
  let renamingId = null;
  let emptyShown = false;
  const offBusy = onBusy(() => !!(doc && doc.dirty) || drafts.size > 0);

  /* ------------------------------------------------------------------ left list */
  const listEl = h('div', { class: 'wf-list-items', role: 'list', 'aria-label': 'Workflows' });
  const newBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openNew(newBtn) }, icon('plus', 14), 'New');
  const archToggle = h('button', { class: 'wf-list-toggle', type: 'button', onclick: () => { showArchived = !showArchived; lsSet('helm.wf.archived', showArchived ? '1' : '0'); renderList(); } });
  const runsHead = h('h3', { class: 'wf-list-h' }, icon('history', 13), 'Runs');
  const runsEl = h('div', { class: 'wf-list-runs', role: 'list', 'aria-label': 'Runs of this workflow' });
  const listPane = h('aside', { class: 'wf-list', 'aria-label': 'Workflows' },
    h('div', { class: 'wf-list-top' }, h('h2', { class: 'wf-list-title' }, 'Workflows'), h('span', { class: 'spacer' }), newBtn),
    listEl, archToggle, runsHead, runsEl);

  /* ------------------------------------------------------------------- toolbar */
  const nameBtn = h('button', { class: 'wf-name', type: 'button', title: 'Rename', onclick: () => detail && startRename(detail.workflow.id, nameBtn) }, '');
  const verBtn = h('button', { class: 'wf-ver mono', type: 'button', 'aria-haspopup': 'dialog', title: 'Version history', onclick: () => openVersions() }, 'v1', icon('chevronDown', 12));
  const dirtyDot = h('span', { class: 'wf-dirty', hidden: true, title: 'Unsaved changes' });
  const tbtn = (ic, label, fn) => h('button', { class: 'icon-btn sm wf-tb', type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(ic, 17));
  const undoBtn = tbtn('undo', 'Undo (⌘Z)', () => undo());
  const redoBtn = tbtn('redo', 'Redo (⇧⌘Z)', () => redo());
  const tidyBtn = tbtn('tidy', 'Tidy the layout', () => canvas.tidy());
  const issuesBtn = h('button', { class: 'wf-issues-btn', type: 'button', hidden: true, onclick: () => openIssues() }, icon('warning', 14), h('span', {}));
  const runsBtn = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', 'aria-haspopup': 'dialog', title: 'Runs of this workflow', onclick: () => openRunsPop(runsBtn) }, icon('history', 14), h('span', { class: 'wf-lbl' }, 'Runs'));
  const saveBtn = h('button', { class: 'btn btn-sm wf-save', type: 'button', title: 'Save a new version (⌘S)', onclick: () => openSave() }, icon('check', 14), h('span', {}, 'Saved'));
  const runBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'aria-haspopup': 'dialog', title: 'Run this workflow', onclick: () => openRun() }, icon('play', 14), 'Run');
  const bar = h('header', { class: 'wf-bar' },
    h('div', { class: 'wf-bar-l' }, nameBtn, verBtn, dirtyDot),
    h('span', { class: 'wf-bar-sep' }), undoBtn, redoBtn, tidyBtn,
    h('span', { class: 'spacer' }), issuesBtn, runsBtn, saveBtn, runBtn);

  /* --------------------------------------------------------------------- canvas */
  const canvas = createCanvas({
    onSelection: (s2) => { syncInspector(); void s2; },
    onGate: (runId, nodeId, decision, comment) => decideGate(runId, nodeId, decision, comment),
    onNodeAction: (action, nodeId) => { if (viewRunId) controlNode(viewRunId, nodeId, action); },
    onOpenNode: (id) => { canvas.select([id]); const f = inspector.el.querySelector('input,textarea'); if (f) f.focus(); },
  });
  const palette = createPalette(canvas);
  const inspector = createInspector({
    onDeleteSelection: () => canvas.deleteSelection(),
    onFocusNode: (id) => { canvas.select([id]); canvas.centerOn(id); },
    onNodeAction: (action, nodeId) => { if (viewRunId) controlNode(viewRunId, nodeId, action); },
    onGate: (runId, nodeId, d, c) => decideGate(runId, nodeId, d, c),
  });

  const runBar = h('div', { class: 'wf-runbar', hidden: true });
  const stage = h('div', { class: 'wf-stage' }, canvas.el, palette.el, runBar);
  const main = h('section', { class: 'wf-main' }, bar, stage);
  const emptyPane = h('div', { class: 'wf-none', hidden: true });
  const root = h('div', { class: 'wf-view' }, listPane, main, inspector.el, emptyPane);
  container.appendChild(root);

  /* ----------------------------------------------------------------- list render */
  function runChip(w) {
    const rs = sel.runsOf(w.id);
    const live = rs.find((r) => LIVE.has(r.status));
    const last = live || rs[0];
    if (!last) return null;
    return h('span', { class: `wf-chip st-${last.status}`, title: `${last.id} · ${RUN_LABEL[last.status] || last.status}` }, h('span', { class: 'wf-chip-dot' }), live ? RUN_LABEL[live.status] : last.id);
  }
  function makeItem(w) {
    const r = {};
    r.name = h('span', { class: 'wf-item-name' });
    r.meta = h('span', { class: 'wf-item-meta mono' });
    r.chip = h('span', { class: 'wf-item-chip' });
    r.more = h('button', { class: 'icon-btn sm wf-item-more', type: 'button', 'aria-label': 'More', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); itemMenu(el.__w, r.more); } }, icon('more', 16));
    const el = h('div', { class: 'wf-item', role: 'listitem', tabindex: '0', 'data-id': w.id },
      h('span', { class: 'wf-item-ic' }, icon('workflow', 16)), h('div', { class: 'wf-item-t' }, r.name, r.meta), r.chip, r.more);
    el.__r = r;
    el.addEventListener('click', () => { if (renamingId !== el.__w.id) navigate('workflows', [el.__w.id]); });
    el.addEventListener('keydown', (e) => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); navigate('workflows', [el.__w.id]); } });
    el.addEventListener('dblclick', () => startRename(el.__w.id, r.name));
    return el;
  }
  function updateItem(el, w) {
    const r = el.__r;
    el.__w = w;
    setClass(el, 'active', w.id === wfId);
    setClass(el, 'archived', w.archived);
    el.setAttribute('aria-current', w.id === wfId ? 'true' : 'false');
    if (renamingId !== w.id) setText(r.name, w.name);
    const nruns = sel.runsOf(w.id).length;
    setText(r.meta, `${w.id} · v${w.currentVersion}${nruns ? ` · ${plural(nruns, 'run')}` : ''}${state.ui.projectId === 'all' && state.projects.size > 1 ? ` · ${sel.projectName(w.projectId)}` : ''}`);
    r.chip.textContent = '';
    const chip = runChip(w);
    if (chip) r.chip.append(chip);
  }
  function renderList() {
    const all = sel.scopedWorkflows(true);
    const list = all.filter((w) => showArchived || !w.archived);
    reconcile(listEl, list, (w) => w.id, makeItem, updateItem);
    const archived = all.filter((w) => w.archived).length;
    setHidden(archToggle, archived === 0);
    setText(archToggle, showArchived ? `Hide ${archived} archived` : `Show ${archived} archived`);
    // runs of the selected workflow
    const rs = wfId ? sel.runsOf(wfId).slice(0, 8) : [];
    setHidden(runsHead, !rs.length);
    reconcile(runsEl, rs, (r) => r.id, (r) => {
      const el = h('button', { class: 'wf-run', type: 'button', role: 'listitem', 'data-id': r.id },
        h('span', { class: 'wf-run-dot' }), h('span', { class: 'wf-run-id mono' }), h('span', { class: 'wf-run-st' }), h('span', { class: 'spacer' }), h('span', { class: 'wf-run-cost mono' }), h('span', { class: 'wf-run-ago mono dim' }));
      el.addEventListener('click', () => setQuery({ run: el.__r.id, tl: null }, { replace: false }));
      return el;
    }, (el, r) => {
      el.__r = r;
      el.className = `wf-run st-${r.status}${r.id === viewRunId ? ' active' : ''}`;
      setText(el.children[1], r.id);
      setText(el.children[2], RUN_LABEL[r.status] || r.status);
      setText(el.children[4], r.costUsd > 0 ? fmtUsdSmall(r.costUsd) : '');
      el.children[5].setAttribute('data-ago', r.startedAt); setText(el.children[5], fmtAgo(r.startedAt));
    });
    setHidden(emptyPane, true);
  }

  function itemMenu(w, anchor) {
    openMenu(anchor, [
      { label: 'Rename', icon: 'pencil', onSelect: () => startRename(w.id, listEl.querySelector(`[data-id="${CSS.escape(w.id)}"] .wf-item-name`)) },
      { label: 'Duplicate', icon: 'copy', onSelect: () => duplicate(w) },
      { divider: true },
      { label: w.archived ? 'Restore from archive' : 'Archive', icon: 'archive', danger: !w.archived, onSelect: () => archive(w) },
    ], { minWidth: 200, align: 'right' });
  }
  async function archive(w) {
    try {
      const { workflow } = await api.patchWorkflow(w.id, { archived: !w.archived });
      upsert('workflow', workflow);
      if (workflow.archived) {
        toast(`Archived “${w.name}”`, { action: { label: 'Undo', onClick: () => api.patchWorkflow(w.id, { archived: false }).then((r) => upsert('workflow', r.workflow)).catch((e) => toastError(e)) } });
        if (wfId === w.id && !showArchived) { const next = sel.scopedWorkflows().find((x) => x.id !== w.id); navigate('workflows', next ? [next.id] : []); }
      }
    } catch (e) { toastError(e, 'Could not archive'); }
  }
  async function duplicate(w) {
    try {
      const d = await api.workflow(w.id);
      const latest = d.versions.find((v) => v.version === d.workflow.currentVersion) || d.versions[0];
      const res = await api.createWorkflow({ projectId: w.projectId, name: `${w.name} copy`, graph: latest.graph });
      upsert('workflow', res.workflow);
      navigate('workflows', [res.workflow.id]);
    } catch (e) { toastError(e, 'Could not duplicate'); }
  }
  function startRename(id, nameEl) {
    const w = state.workflows.get(id);
    if (!w || !nameEl) return;
    renamingId = id;
    const input = h('input', { class: 'wf-rename', type: 'text', value: w.name, maxlength: '200', 'aria-label': 'Workflow name' });
    const host = nameEl;
    const prev = host.textContent;
    host.textContent = '';
    host.append(input);
    input.focus(); input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      renamingId = null;
      const v = input.value.trim();
      host.textContent = prev;
      if (commit && v && v !== w.name) {
        try { const r = await api.patchWorkflow(id, { name: v }); upsert('workflow', r.workflow); } catch (e) { toastError(e, 'Could not rename'); }
      }
      renderList(); renderBar();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  /* ------------------------------------------------------------- new workflow */
  function defaultProjectId() {
    const sc = sel.scopeProject();
    if (sc) return sc.id;
    const remembered = lsGet('helm.composer.project');
    const ps = sel.projects();
    if (remembered && ps.some((p) => p.id === remembered)) return remembered;
    return ps[0] ? ps[0].id : null;
  }
  function openNew(anchor) {
    const ps = sel.projects();
    if (!ps.length) { toast('Create a project first', { kind: 'error' }); navigate('projects'); return; }
    const projSel = h('select', { class: 'select select-sm wf-select', 'aria-label': 'Project' }, ps.map((p) => h('option', { value: p.id }, p.name)));
    projSel.value = defaultProjectId() || ps[0].id;
    const multi = state.ui.projectId === 'all' && ps.length > 1;
    const nameIn = h('input', { class: 'wf-input', type: 'text', placeholder: 'Name (optional)', maxlength: '200', 'data-autofocus': '' });
    let busy = false;
    const make = async (template) => {
      if (busy) return;
      busy = true;
      try {
        const body = { projectId: projSel.value };
        if (nameIn.value.trim()) body.name = nameIn.value.trim();
        if (template) body.template = template;
        const res = await api.createWorkflow(body);
        upsert('workflow', res.workflow);
        closePop();
        navigate('workflows', [res.workflow.id]);
      } catch (e) { toastError(e, 'Could not create workflow'); busy = false; }
    };
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); make(null); } });
    const body = h('div', { class: 'wf-pop-body' },
      h('h3', { class: 'wf-pop-h' }, 'New workflow'),
      nameIn, multi ? projSel : null,
      h('button', { class: 'wf-pop-opt', type: 'button', onclick: () => make(null) }, icon('plus', 16), h('span', {}, h('strong', {}, 'Blank workflow'), h('em', {}, 'Start with an empty canvas'))),
      h('button', { class: 'wf-pop-opt', type: 'button', onclick: () => make(TEMPLATE.key) }, icon('sparkle', 16), h('span', {}, h('strong', {}, TEMPLATE.label), h('em', {}, TEMPLATE.hint))));
    openPop(anchor, body, { width: 340, align: anchor === newBtn ? 'left' : 'left' });
  }

  function stashDraft() {
    if (doc && doc.dirty && detail) drafts.set(doc.__wf, { base: clone(doc.savedGraph), graph: clone(doc.graph), version: detail.workflow.currentVersion });
    else if (doc) drafts.delete(doc.__wf);
  }

  /* ----------------------------------------------------------------- load + modes */
  async function loadWorkflow(id, { keepDoc = false } = {}) {
    const seq = ++loading;
    let d;
    try { d = await api.workflow(id); } catch (e) {
      if (seq !== loading) return;
      if (e.status === 404) { detail = null; wfId = null; showEmpty('That workflow does not exist', 'It may have been removed. Pick another one on the left.'); return; }
      toastError(e, 'Could not load workflow'); return;
    }
    if (seq !== loading || wfId !== id) return;
    detail = d;
    const latest = d.versions.find((v) => v.version === d.workflow.currentVersion) || d.versions[0];
    if (!keepDoc || !doc) {
      const draft = drafts.get(id);
      drafts.delete(id);
      doc = new Doc(draft && draft.version === latest.version ? draft.base : latest.graph);
      doc.__wf = id;
      if (draft && draft.version === latest.version) { doc.graph = clone(draft.graph); toast('Restored your unsaved edits', { duration: 2200 }); }
      doc.on((kind) => { renderBar(); syncInspector(true); if (kind !== 'saved') validateSoon(); });
    } else if (canon(doc.graph) === canon(latest.graph)) {
      doc.markSaved(latest.graph); // our own save (or someone else's identical one): clean, history kept
    } else if (!doc.dirty) {
      doc.load(latest.graph); // changed elsewhere and we have no edits of our own
      doc.emit('saved');
    }
    applyMode();
    validateSoon();
    renderList();
    renderBar();
  }

  function showEmpty(title, body) {
    emptyShown = true;
    setHidden(main, true); setHidden(inspector.el, true); setHidden(emptyPane, false);
    emptyPane.textContent = '';
    const create = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openNew(create) }, icon('plus', 15), 'New workflow');
    emptyPane.append(emptyState({ iconName: 'workflow', title, body }), h('div', { class: 'wf-none-actions' }, create));
  }
  function showWorkspace() { setHidden(main, false); setHidden(inspector.el, false); setHidden(emptyPane, true); }

  /** Edit mode shows the working copy; run mode shows the version the run started on. */
  function applyMode() {
    if (!detail) return;
    emptyShown = false;
    showWorkspace();
    const run = viewRunId ? state.runs.get(viewRunId) : null;
    if (viewRunId && run && run.workflowId === wfId) {
      const v = detail.versions.find((x) => x.version === run.version);
      if (v) {
        noteGraph(run.id, v.graph);
        if (!runDoc || runDoc.__run !== run.id) {
          const sameWf = canvas.currentDoc && canvas.currentDoc.__wf === wfId;
          runDoc = new Doc(v.graph); runDoc.__run = run.id; runDoc.__wf = wfId;
          canvas.setDoc(runDoc, { keepView: !!sameWf });
        }
        canvas.setReadOnly(true);
        canvas.setRun(run);
        palette.setDisabled(true);
        ensureDetail(run);
        syncRunBar(run);
        syncInspector(true);
        renderBar();
        return;
      }
    }
    runDoc = null;
    canvas.setRun(null);
    setHidden(runBar, true);
    root.classList.remove('is-run');
    if (canvas.currentDoc !== doc) canvas.setDoc(doc, { keepView: !!(canvas.currentDoc && canvas.currentDoc.__wf === wfId) });
    canvas.setReadOnly(false);
    palette.setDisabled(false);
    syncInspector(true);
    renderBar();
  }

  function syncRunBar(run) {
    root.classList.add('is-run');
    setHidden(runBar, false);
    const wasRun = runBar.__run === run.id;
    runBar.__run = run.id;
    const live = LIVE.has(run.status);
    const costNew = fmtUsdSmall(run.costUsd || 0) + (run.budgetUsd ? ` / ${fmtUsdSmall(run.budgetUsd)}` : '');
    const prevCost = runBar.__cost;
    runBar.textContent = '';
    const cost = h('span', { class: 'wf-rb-cost mono' }, costNew);
    if (wasRun && prevCost != null && prevCost !== costNew) cost.classList.add('bump');
    runBar.__cost = costNew;
    const nodes = run.nodes;
    const doneN = nodes.filter((n) => ['ok', 'skipped'].includes(n.state)).length;
    runBar.append(
      h('span', { class: `wf-rb-pill st-${run.status}` }, h('span', { class: 'wf-n-dot' }), RUN_LABEL[run.status] || run.status),
      h('strong', { class: 'mono' }, run.id),
      h('span', { class: 'dim mono' }, `v${run.version} · ${doneN}/${nodes.length}`),
      cost,
      live ? h('span', { class: 'wf-rb-time mono', 'data-since': run.startedAt }, fmtElapsed(Date.now() - run.startedAt)) : h('span', { class: 'wf-rb-time mono dim' }, fmtElapsed((run.endedAt || run.startedAt) - run.startedAt)),
      h('span', { class: 'wf-rb-sep' }),
      run.status === 'paused'
        ? h('button', { class: 'btn btn-accent btn-sm', type: 'button', onclick: () => controlRun(run.id, 'resume') }, icon('play', 13), 'Resume')
        : (live ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => controlRun(run.id, 'pause') }, icon('pause', 13), 'Pause') : null),
      live ? h('button', { class: 'btn btn-quiet btn-sm danger-text', type: 'button', onclick: () => controlRun(run.id, 'abort') }, icon('stop', 13), 'Abort') : null,
      h('button', { class: 'btn btn-quiet btn-sm', type: 'button', title: 'Show or hide the run timeline', onclick: () => setQuery({ tl: route.query.get('tl') === '0' ? null : '0' }) }, icon('checklist', 14), 'Timeline'),
      h('button', { class: 'btn btn-quiet btn-sm', type: 'button', title: 'Back to editing', onclick: () => setQuery({ run: null, tl: null }) }, icon('pencil', 13), 'Edit'));
    if (run.error && run.status !== 'done') runBar.append(h('div', { class: 'wf-rb-err' }, icon('warning', 13), h('span', {}, truncate(run.error, 140))));
  }

  /* ---------------------------------------------------------------- toolbar state */
  function renderBar() {
    const w = detail && detail.workflow;
    const run = viewRunId ? state.runs.get(viewRunId) : null;
    const runMode = !!run && !!runDoc;
    if (w) {
      const live = state.workflows.get(w.id) || w;
      if (renamingId !== w.id) setText(nameBtn, live.name);
      setText(verBtn.firstChild, `v${runMode ? run.version : live.currentVersion}`);
      verBtn.title = runMode ? `Showing the version this run started on (v${run.version})` : 'Version history';
    }
    const dirty = !!doc && doc.dirty && !runMode;
    setHidden(dirtyDot, !dirty);
    setClass(saveBtn, 'dirty', dirty);
    saveBtn.disabled = runMode || !dirty;
    setText(saveBtn.lastChild, dirty ? 'Save' : 'Saved');
    undoBtn.disabled = runMode || !doc || !doc.canUndo;
    redoBtn.disabled = runMode || !doc || !doc.canRedo;
    tidyBtn.disabled = runMode;
    const errs = issueList.filter((i) => i.level === 'error').length;
    setHidden(issuesBtn, runMode || issueList.length === 0);
    setClass(issuesBtn, 'bad', errs > 0);
    setText(issuesBtn.lastChild, errs ? plural(errs, 'problem') : plural(issueList.length, 'hint'));
    const nruns = w ? sel.runsOf(w.id).length : 0;
    runsBtn.disabled = !nruns;
    runBtn.disabled = !w || !!errs || !doc || !doc.graph.nodes.some(isExec);
    runBtn.title = errs ? 'Fix the problems first' : 'Run this workflow';
  }
  function syncInspector(force = false) {
    const run = viewRunId && runDoc ? state.runs.get(viewRunId) : null;
    const d = run ? runDoc : doc;
    inspector.show({
      doc: d || new Doc(emptyGraph()), selection: canvas.selection, readOnly: !!run, issues, run, title: detail && detail.workflow.name,
      detail: run ? detailOf(run.id) : null, duplicate: () => canvas.duplicate(),
    });
    void force;
  }

  /* ---------------------------------------------------------------- validation */
  const validateSoon = debounce(async () => {
    if (!doc) return;
    const mine = doc;
    try {
      const r = await api.validateGraph(mine.graph);
      if (mine !== doc) return;
      issueList = r.issues || [];
      const map = new Map();
      for (const i of issueList) {
        if (i.level !== 'error' && i.level !== 'warn') continue;
        const k = i.nodeId || '*';
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(i.edgeId ? `${i.message}` : i.message);
      }
      issues = map;
      canvas.setIssues(new Map([...map].filter(([k]) => k !== '*')));
      renderBar();
      if (!viewRunId) syncInspector();
    } catch { /* hub briefly down: the next edit validates again */ }
  }, 380);

  function openIssues() {
    const list = h('ul', { class: 'wf-problems wf-problems-pop' }, issueList.map((i) => h('li', { class: i.level }, icon('warning', 13),
      i.nodeId ? h('button', { class: 'link-btn', type: 'button', onclick: () => { closePop(); canvas.select([i.nodeId]); canvas.centerOn(i.nodeId); } }, i.nodeId) : null, h('span', {}, i.message))));
    openPop(issuesBtn, h('div', { class: 'wf-pop-body' }, h('h3', { class: 'wf-pop-h' }, 'Problems'), list), { width: 380, align: 'right' });
  }

  /* ------------------------------------------------------------- undo / redo */
  function undo() { if (doc && !viewRunId && doc.undo()) { toastUndo('Undid'); } }
  function redo() { if (doc && !viewRunId) doc.redo(); }
  function toastUndo() { /* the canvas change is the feedback */ }

  /* --------------------------------------------------------------------- save */
  function savedGraph() {
    const v = detail && detail.versions.find((x) => x.version === detail.workflow.currentVersion);
    return v ? v.graph : null;
  }
  function openSave() {
    if (!doc || !detail || !doc.dirty || viewRunId) return;
    const base = savedGraph() || emptyGraph();
    const summary = h('textarea', { class: 'wf-area', rows: '3', placeholder: 'What changed?', maxlength: '300', 'data-autofocus': '', 'aria-label': 'Version summary' });
    summary.value = summarizeChange(base, doc.graph);
    const errBox = h('ul', { class: 'wf-problems', hidden: true });
    const go = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, icon('check', 14), `Save v${detail.workflow.currentVersion + 1}`);
    let busy = false;
    const save = async () => {
      if (busy) return;
      busy = true; go.disabled = true;
      try {
        const res = await api.saveWorkflow(detail.workflow.id, doc.graph, summary.value.trim() || 'Edited');
        closePop();
        upsert('workflow', res.workflow);
        const keepSel = canvas.selection;
        await refreshDetail();
        doc.markSaved(res.version.graph);
        canvas.select(keepSel.nodes, keepSel.edge);
        if (res.unchanged) toast('Nothing changed', { duration: 1800 });
        else toast(`Saved v${res.version.version}`, { kind: 'success', duration: 2200 });
        renderBar(); renderList();
      } catch (e) {
        busy = false; go.disabled = false;
        const iss = e.data && e.data.issues;
        if (iss) {
          errBox.hidden = false; errBox.textContent = '';
          for (const i of iss.filter((x) => x.level === 'error').slice(0, 6)) errBox.append(h('li', {}, icon('warning', 13), h('span', {}, i.message)));
          issueList = iss; validateSoon();
        } else toastError(e, 'Could not save');
      }
    };
    go.addEventListener('click', save);
    summary.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } });
    openPop(saveBtn, h('div', { class: 'wf-pop-body' },
      h('h3', { class: 'wf-pop-h' }, 'Save a version'),
      h('p', { class: 'wf-pop-p' }, `Edits are kept as v${detail.workflow.currentVersion + 1}. Earlier versions stay in the history, and runs keep the version they started on.`),
      summary, errBox,
      h('div', { class: 'wf-pop-foot' }, h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => closePop() }, 'Cancel'), go)), { width: 360, align: 'right' });
  }
  async function refreshDetail() {
    if (!wfId) return;
    try { detail = await api.workflow(wfId); } catch (e) { toastError(e, 'Could not refresh'); }
  }

  /* ------------------------------------------------------------------ versions */
  function openVersions() {
    if (!detail) return;
    const cur = detail.workflow.currentVersion;
    const dirty = doc && doc.dirty;
    const rows = detail.versions.map((v) => {
      const isCur = v.version === cur;
      const btn = isCur ? null : h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: (e) => confirmRestore(e.currentTarget, v) }, icon('retry', 13), 'Restore');
      return h('li', { class: `wf-v${isCur ? ' cur' : ''}` },
        h('span', { class: 'wf-v-n mono' }, `v${v.version}`),
        h('div', { class: 'wf-v-t' }, h('strong', {}, v.summary || 'Edited'), h('span', { class: 'mono dim' }, `${v.author} · ${fmtAgo(v.createdAt)}${v.parentVersion ? ` · from v${v.parentVersion}` : ''}`)),
        isCur ? h('span', { class: 'wf-v-cur' }, 'Current') : btn);
    });
    openPop(verBtn, h('div', { class: 'wf-pop-body' }, h('h3', { class: 'wf-pop-h' }, 'Versions'),
      dirty ? h('p', { class: 'wf-pop-p warn' }, 'You have unsaved changes. Restoring replaces them.') : null,
      h('ul', { class: 'wf-versions' }, rows)), { width: 380 });
  }
  function confirmRestore(btn, v) {
    if (btn.__armed) { restore(v); return; }
    btn.__armed = true;
    btn.classList.add('armed');
    setText(btn.lastChild, `Restore v${v.version}?`);
    setTimeout(() => { btn.__armed = false; btn.classList.remove('armed'); if (btn.isConnected) setText(btn.lastChild, 'Restore'); }, 3500);
  }
  async function restore(v) {
    try {
      const res = await api.restoreWorkflow(detail.workflow.id, v.version);
      closePop();
      upsert('workflow', res.workflow);
      await refreshDetail();
      doc.load(res.version.graph);
      doc.emit('saved');
      if (viewRunId) setQuery({ run: null, tl: null });
      applyMode();
      toast(`Restored v${v.version} as v${res.version.version}`, { kind: 'success' });
    } catch (e) { toastError(e, 'Could not restore'); }
  }

  /* ---------------------------------------------------------------------- runs */
  function openRunsPop(anchor) {
    const rs = detail ? sel.runsOf(detail.workflow.id) : [];
    if (!rs.length) return;
    const body = h('div', { class: 'wf-pop-body' }, h('h3', { class: 'wf-pop-h' }, `Runs · ${rs.length}`),
      h('ul', { class: 'wf-versions' }, rs.slice(0, 30).map((r) => h('li', { class: `wf-v wf-runrow st-${r.status}`, tabindex: '0', onclick: () => { closePop(); setQuery({ run: r.id, tl: null }, { replace: false }); } },
        h('span', { class: 'wf-v-n mono' }, r.id),
        h('div', { class: 'wf-v-t' }, h('strong', {}, RUN_LABEL[r.status] || r.status), h('span', { class: 'mono dim' }, `v${r.version} · ${fmtAgo(r.startedAt)}${r.costUsd ? ' · ' + fmtUsdSmall(r.costUsd) : ''}`)),
        h('span', { class: `wf-chip st-${r.status}` }, h('span', { class: 'wf-chip-dot' }))))));
    openPop(anchor, body, { width: 360, align: 'right' });
  }

  function liveSessions() {
    const pid = detail && detail.workflow.projectId;
    return Array.from(state.sessions.values()).filter((s) => s.status !== 'ended')
      .sort((a, b) => (b.projectId === pid) - (a.projectId === pid) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  }
  function openRun() {
    if (!detail || !doc) return;
    if (viewRunId) { setQuery({ run: null, tl: null }); }
    const g = savedGraph() || doc.graph;
    const params = g.params || [];
    const inputs = params.map((p) => {
      const t = p.type === 'line' ? h('input', { class: 'wf-input', type: 'text', maxlength: '2000' }) : h('textarea', { class: 'wf-area', rows: '3', maxlength: '20000' });
      t.value = p.default || '';
      t.setAttribute('aria-label', p.label || p.key);
      return { p, el: t };
    });
    const sessions = liveSessions();
    const sessSel = h('select', { class: 'select select-sm wf-select', 'aria-label': 'Session to run in' }, h('option', { value: '' }, sessions.length ? 'Automatic (newest live session)' : 'No live session'), sessions.map((s) => h('option', { value: s.id }, `${truncate(s.title || s.cwd || s.id, 34)} · ${s.status}`)));
    const budget = h('input', { class: 'wf-input', type: 'number', min: '0', step: '0.1', placeholder: 'No limit', 'aria-label': 'Budget in dollars' });
    const exec = g.nodes.filter(isExec);
    const counts = [];
    const n = (type, label) => { const c = exec.filter((x) => x.type === type).length; if (c) counts.push(`${c} ${label}`); };
    n('agent', 'agent'); n('shell', 'check'); n('review', 'review'); n('gate', 'gate');
    const warnUnsaved = doc.dirty;
    const errBox = h('div', { class: 'wf-run-err', hidden: true });
    const go = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, icon('play', 14), 'Run');
    let busy = false;
    const start = async () => {
      if (busy) return;
      for (const i of inputs) if (i.p.required && !i.el.value.trim()) { i.el.setAttribute('aria-invalid', 'true'); i.el.focus(); return; }
      busy = true; go.disabled = true;
      const body = { params: {} };
      for (const i of inputs) if (i.el.value !== '') body.params[i.p.key] = i.el.value;
      if (sessSel.value) body.sessionId = sessSel.value;
      const b = parseFloat(budget.value);
      if (b > 0) body.budgetUsd = b;
      try {
        const res = await api.runWorkflow(detail.workflow.id, body);
        upsert('run', res.run);
        closePop();
        setQuery({ run: res.run.id, tl: null }, { replace: false });
        toast(`Started ${res.run.id}`, { kind: 'success', duration: 2200 });
      } catch (e) {
        busy = false; go.disabled = false;
        errBox.hidden = false; setText(errBox, e.status === 409 ? 'No live Claude Code session for this project. Open one, then try again.' : e.message);
      }
    };
    go.addEventListener('click', start);
    for (const i of inputs) i.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || i.p.type === 'line')) { e.preventDefault(); start(); } });
    const body = h('div', { class: 'wf-pop-body' },
      h('h3', { class: 'wf-pop-h' }, `Run ${detail.workflow.name}`),
      h('p', { class: 'wf-pop-p mono' }, `v${detail.workflow.currentVersion}${counts.length ? ' · ' + counts.join(', ') : ''}`),
      warnUnsaved ? h('p', { class: 'wf-pop-p warn' }, 'You have unsaved changes. The run uses the saved version.') : null,
      inputs.map((i) => h('label', { class: 'wf-f' }, h('span', { class: 'wf-f-l' }, i.p.label || i.p.key, i.p.required ? h('span', { class: 'wf-req' }, ' *') : null), i.el)),
      h('label', { class: 'wf-f' }, h('span', { class: 'wf-f-l' }, 'Run in'), sessSel),
      h('label', { class: 'wf-f' }, h('span', { class: 'wf-f-l' }, 'Budget (USD)'), budget,
        h('span', { class: 'wf-f-hint' }, 'The run pauses when the cost reaches this. Agent steps use Sonnet or Haiku; the review uses Opus, which costs more. Costs appear live as it runs.')),
      errBox,
      h('div', { class: 'wf-pop-foot' }, h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => closePop() }, 'Cancel'), go));
    openPop(runBtn, body, { width: 380, align: 'right' });
  }

  /* ------------------------------------------------------------------- keyboard */
  function onKey(e) {
    if (!container.isConnected) return;
    const meta = e.metaKey || e.ctrlKey;
    const tag = (e.target && e.target.tagName) || '';
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
    if (meta && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); openSave(); return; }
    if (typing || !meta || e.altKey) return;
    if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); redo(); }
  }
  document.addEventListener('keydown', onKey);

  const offFocus = bus.on('wf-focus-node', ({ runId, nodeId }) => {
    if (runId !== viewRunId) return;
    canvas.select([nodeId]);
    canvas.centerOn(nodeId);
  });
  const offDetail = onDetail((id) => { if (id === viewRunId) syncInspector(); });

  /* -------------------------------------------------------------- store updates */
  function update(changed) {
    // keep the selected workflow valid
    renderList();
    if (!detail && wfId && state.workflows.has(wfId) && !loading) loadWorkflow(wfId);
    const w = wfId && state.workflows.get(wfId);
    if (detail && w && w.currentVersion !== detail.workflow.currentVersion) {
      // saved from somewhere else (or by us a moment ago): refetch; an unsaved local copy is kept
      loadWorkflow(wfId, { keepDoc: true });
    } else if (detail && w && w.name !== detail.workflow.name) {
      detail = { ...detail, workflow: { ...detail.workflow, name: w.name } };
    }
    if (viewRunId) {
      const run = state.runs.get(viewRunId);
      if (run && changed.has('run')) { if (!runDoc || runDoc.__run !== run.id) applyMode(); else { canvas.setRun(run); syncRunBar(run); ensureDetail(run); syncInspector(); } }
    }
    if (changed.has('session') || changed.has('workflow')) renderBar();
    renderBar();
    if (state.ready && !wfId) {
      if (sel.scopedWorkflows().length) { setRoute(route); return; }
      if (!emptyShown) showEmpty('No workflows yet', 'A workflow is a graph of steps: agents that build, checks that test, gates that wait for you, and an Opus review. Start from the template or draw your own.');
    }
  }

  /* ---------------------------------------------------------------------- route */
  async function setRoute(r) {
    route = r;
    const id = r.args[0] || null;
    const runId = r.query.get('run') || null;
    if (!id) {
      const remembered = lsGet('helm.wf.last');
      const list = sel.scopedWorkflows();
      const pick = (remembered && list.find((w) => w.id === remembered)) || list[0];
      if (pick && state.ready) { navigate('workflows', [pick.id], runId ? { run: runId } : {}, { replace: true }); return; }
      wfId = null; detail = null;
      renderList();
      return;
    }
    // a run link names its workflow's run: make sure we are on that workflow
    if (id !== wfId) {
      stashDraft();
      wfId = id; detail = null; doc = null; runDoc = null; issues = new Map(); issueList = [];
      lsSet('helm.wf.last', id);
      viewRunId = runId;
      renderList();
      await loadWorkflow(id);
      // Opening a workflow with a run that needs you (or is still going) shows that run, not a bare canvas.
      if (!runId) {
        const live = [...state.runs.values()]
          .filter((x) => x.workflowId === id && ['waiting', 'running', 'paused'].includes(x.status))
          .sort((x, y) => (x.status === 'waiting' ? -1 : 0) - (y.status === 'waiting' ? -1 : 0) || y.startedAt - x.startedAt)[0];
        if (live) { navigate('workflows', [id], { run: live.id }, { replace: true }); return; }
      }
    }
    if (runId !== viewRunId || (runId && !runDoc)) {
      viewRunId = runId;
      if (runId && !state.runs.has(runId)) {
        try { const d = await api.run(runId); upsert('run', d.run); } catch { toast(`Run ${runId} not found`, { kind: 'error' }); setQuery({ run: null, tl: null }); viewRunId = null; }
      }
      applyMode();
      renderList();
    }
    ensureRunPanel();
  }
  function ensureRunPanel() { bus.emit('wf-run-panel', { runId: viewRunId, want: route.query.get('tl') !== '0' }); }

  setRoute(route);
  renderList();

  return {
    watch: ['workflow', 'run', 'project', 'session', 'ui', 'ready', 'task'],
    update(changed) { update(changed); ensureRunPanel(); },
    setRoute,
    destroy() {
      document.removeEventListener('keydown', onKey);
      stashDraft();
      offFocus(); offDetail(); offBusy();
      closePop(false);
      bus.emit('wf-run-panel', { runId: null, want: false });
      canvas.destroy(); inspector.destroy();
      root.remove();
    },
  };
}
