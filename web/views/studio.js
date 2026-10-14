// views/studio.js — Studio, the drawing board (#/studio/<docId>): pick a project, describe what to create, edit it as blocks,
// pin comments to text, and check the print-styled page. Persistence goes through studio/store.js: the hub (drafting and
// Apply all are model jobs) when it is reachable and the document has a project, localStorage otherwise.
import { h, setText, setClass, bus } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel } from '../store.js';
import { toast, toastError } from '../ui.js';
import { navigate } from '../router.js';
import { fmtAgo } from '../format.js';
import { studioStore as store, newCommentId } from '../studio/store.js';
import { createEditor } from '../studio/editor.js';
import { buildPaper } from '../studio/paper.js';
import { exportDoc, EXPORT_FORMATS } from '../studio/export.js';
import { reanchorAll, moveComments, BLOCK_TYPES, TYPE_LABEL } from '../studio/blocks.js';
import { docJobs, jobActive, jobProgress, undoableBatch } from '../studio/sync.js';

const TYPE_BTN = { p: 'P', h1: 'H1', h2: 'H2', h3: 'H3', li: 'List', quote: 'Quote', code: 'Code', diagram: 'Diagram' };
const SAVE_DELAY = 500;

export function mount(container, route) {
  let docs = [];
  let doc = null;           // {id, title, projectId, ...}
  let comments = [];
  let tab = 'edit';
  let draftAnchor = null;   // anchor captured when the user pressed Comment
  let activeComment = null;
  let loadToken = 0;
  let saveTimer = null;
  let dirty = false;
  let wantedId = (route && route.args[0]) || null;
  let docVersion = 0;       // the hub version this screen last saw (Undo only offers itself while it is current)
  let flushing = Promise.resolve();
  let refreshing = false;
  let ticker = null;
  let listTimer = null;
  let wasDrafting = false;
  const extraJobs = new Map(); // a job the hub just returned from create, until the SSE stream delivers its row

  /* ================= left rail: documents ================= */
  const docList = h('ul', { class: 'st-doclist', role: 'list' });
  const newBtn = h('button', { class: 'btn btn-accent btn-sm', type: 'button', onclick: () => { flush(); navigate('studio'); } }, icon('plus', 14), 'New');
  const rail = h('aside', { class: 'st-docs', 'aria-label': 'Documents' },
    h('div', { class: 'st-rail-head' }, h('span', { class: 'st-eyebrow mono' }, 'DOCS'), h('span', { class: 'spacer' }), newBtn), docList);

  /* ================= new-document panel ================= */
  const projectSel = h('select', { class: 'composer-input st-select', 'aria-label': 'Project', onchange: () => updateCreateNote() });
  const promptBox = h('textarea', {
    class: 'st-prompt', rows: 5, 'aria-label': 'Describe what to create', spellcheck: 'true',
    placeholder: 'a one-page proposal for the Q4 migration, plain tone, three sections',
    onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); create(); } },
  });
  const createBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => create() }, icon('sparkle', 15), 'Create');
  const createNote = h('p', { class: 'st-note' });
  const composer = h('section', { class: 'st-new', 'aria-label': 'New document' },
    h('p', { class: 'st-eyebrow mono' }, '$ studio new'),
    h('h2', { class: 'st-new-title' }, 'What are we making?'),
    h('label', { class: 'st-field' }, h('span', { class: 'st-label' }, 'Project'), projectSel),
    h('div', { class: 'st-field' }, h('label', { class: 'st-label', for: 'st-prompt' }, 'Describe what to create'),
      h('div', { class: 'st-promptwrap' }, h('span', { class: 'st-caret mono', 'aria-hidden': 'true' }, '>'), promptBox)),
    h('div', { class: 'st-new-foot' },
      h('span', { class: 'st-hint' }, h('kbd', { class: 'kbd' }, '⌘↵'), ' to create'),
      h('span', { class: 'spacer' }), createBtn),
    createNote);
  promptBox.id = 'st-prompt';

  /* ================= editor column ================= */
  const titleInput = h('input', {
    class: 'st-title', type: 'text', 'aria-label': 'Document title', maxlength: 300, spellcheck: 'false',
    oninput: () => { if (doc) { doc.title = titleInput.value; markDirty(); } },
  });
  const status = h('span', { class: 'st-status mono', role: 'status', 'aria-live': 'polite' }, '');

  const typeBtns = {};
  const typeBar = h('div', { class: 'seg st-types', role: 'toolbar', 'aria-label': 'Block type' },
    BLOCK_TYPES.map((t) => {
      const b = h('button', {
        class: 'seg-btn st-type', type: 'button', title: TYPE_LABEL[t], 'aria-label': TYPE_LABEL[t], 'aria-pressed': 'false',
        onmousedown: (e) => e.preventDefault(), // keep the caret in the block
        onclick: () => editor.setFocusedType(t),
      }, TYPE_BTN[t]);
      typeBtns[t] = b;
      return b;
    }));
  const commentBtn = h('button', {
    class: 'btn btn-sm btn-accent', type: 'button', disabled: true, title: 'Comment on the selected text (⌥⌘M)',
    onmousedown: (e) => e.preventDefault(), onclick: () => startComment(),
  }, icon('chat', 14), 'Comment');

  const tabBtns = {};
  const tabs = h('div', { class: 'seg st-tabs', role: 'tablist', 'aria-label': 'Document view',
    onkeydown: (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setTab(tab === 'edit' ? 'preview' : 'edit', true);
    } },
    ['edit', 'preview'].map((t) => {
      const b = h('button', { class: 'seg-btn', type: 'button', role: 'tab', id: `st-tab-${t}`, 'aria-controls': `st-panel-${t}`, onclick: () => setTab(t) },
        t === 'edit' ? 'Edit' : 'PDF preview');
      tabBtns[t] = b;
      return b;
    }));
  const printBtn = h('button', { class: 'btn btn-sm', type: 'button', title: 'Opens the print dialog; choose Save as PDF', onclick: () => printNow() }, icon('file', 14), 'Print / Save PDF');

  const popBtn = h('button', { class: 'btn btn-sm', type: 'button', title: 'Open this document in a floating window that follows you around Helm', onclick: () => popOut() }, icon('popout', 14), 'Pop out');
  function popOut() { if (doc) { broadcast(); bus.emit('studio-popout', { id: doc.id, title: doc.title }); } }
  let lastBroadcastId = null;
  /** Tell the floating Studio pill (studio/pill.js) what this screen shows right now, unsaved typing included. */
  function broadcast() {
    if (!doc) return;
    bus.emit('studio-live', {
      id: doc.id, replaces: lastBroadcastId && lastBroadcastId !== doc.id ? lastBroadcastId : undefined, title: doc.title, version: docVersion, dirty,
      blocks: editor.getBlocks().map((b) => ({ ...b })), comments: comments.map((c) => ({ id: c.id, state: c.state, jobId: c.jobId || null })),
    });
    lastBroadcastId = doc.id;
  }

  const exportBtns = EXPORT_FORMATS.map((f) => h('button', {
    class: 'seg-btn', type: 'button', title: `Download as ${f.label}`, onclick: () => runExport(f),
  }, f.label));
  const exportBar = h('div', { class: 'st-export', role: 'group', 'aria-label': 'Export' },
    h('span', { class: 'st-eyebrow mono' }, 'EXPORT'), h('div', { class: 'seg' }, exportBtns));
  async function runExport(f) {
    if (!doc) return;
    exportBtns.forEach((b) => { b.disabled = true; });
    setStatus(`Exporting ${f.label}…`);
    try {
      await flush(); // a hub document is exported from the hub's copy, so it must be saved first
      const name = await exportDoc({ format: f.format, title: doc.title, blocks: editor.getBlocks(), docId: store.isLocal(doc.id) ? null : doc.id });
      toast(`Saved ${name}`);
      setStatus('');
    } catch (e) {
      setStatus('');
      toastError(e.hint ? `${e.message}. ${e.hint}` : e.status === 404 ? 'Export needs a newer hub (restart it)' : e, 'Export');
    } finally { exportBtns.forEach((b) => { b.disabled = false; }); }
  }

  const editor = createEditor({
    onChange: (blocks, info) => { if (!doc) return; comments = reanchorAll(comments, blocks); markDirty(); renderRail(); editor.refreshHighlights(); if (info && info.structural) setStatus('Editing…'); },
    onSelection: (a) => { selectionAnchor = a; updateSelectionUI(); },
    onFocusBlock: (b) => { for (const t of BLOCK_TYPES) { const on = !!b && b.type === t; typeBtns[t].setAttribute('aria-pressed', String(on)); setClass(typeBtns[t], 'on', on); } },
    getComments: () => comments,
  });
  editor.onMoveComments((from, to, shift) => { comments = moveComments(comments, from, to, shift); });
  let selectionAnchor = null;

  const jobBar = h('div', { class: 'st-job', role: 'status', 'aria-live': 'polite', hidden: true });
  const editorPanel = h('div', { class: 'st-panel', id: 'st-panel-edit', role: 'tabpanel', 'aria-labelledby': 'st-tab-edit' },
    jobBar, h('div', { class: 'st-sheet' }, editor.el));
  const previewHost = h('div', { class: 'st-preview-host' });
  const previewPanel = h('div', { class: 'st-panel st-panel-preview', id: 'st-panel-preview', role: 'tabpanel', 'aria-labelledby': 'st-tab-preview', hidden: true },
    h('p', { class: 'st-note st-preview-note' }, 'A4 page, as it prints. The print dialog decides the page breaks; use Save as PDF as the destination.'), previewHost);

  const bar = h('div', { class: 'st-bar' }, tabs, typeBar, h('span', { class: 'spacer' }), status, exportBar, commentBtn, popBtn, printBtn);
  const editorCol = h('section', { class: 'st-main', 'aria-label': 'Document' },
    h('div', { class: 'st-head' }, titleInput), bar, editorPanel, previewPanel);

  /* ================= right rail: comments ================= */
  const applyBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => applyAll() }, 'Apply all');
  const batchHost = h('div', { class: 'st-draftslot' });
  const commentList = h('ul', { class: 'st-comments', role: 'list' });
  const commentHost = h('div', { class: 'st-draftslot' });
  const commentRail = h('aside', { class: 'st-rail', 'aria-label': 'Comments' },
    h('div', { class: 'st-rail-head' }, h('span', { class: 'st-eyebrow mono' }, 'COMMENTS'), h('span', { class: 'spacer' }), applyBtn),
    commentHost, batchHost, commentList);

  /* floating "Comment" bubble that follows the selection */
  const bubble = h('button', {
    class: 'st-bubble', type: 'button', hidden: true, onmousedown: (e) => e.preventDefault(), onclick: () => startComment(),
  }, icon('chat', 13), 'Comment');
  document.body.appendChild(bubble);

  const workbench = h('div', { class: 'st-work' }, editorCol, commentRail);
  const noDoc = h('div', { class: 'st-center' }, composer);
  const wrap = h('div', { class: 'st', 'data-mode': 'new' }, rail, h('div', { class: 'st-stage' }, noDoc, workbench));
  container.appendChild(wrap);

  /* ================= behaviour ================= */
  function setStatus(t) { setText(status, t); }
  function markDirty() { dirty = true; broadcast(); setStatus('Editing…'); clearTimeout(saveTimer); saveTimer = setTimeout(flush, SAVE_DELAY); if (tab === 'preview') renderPreview(); }
  // Saves are serialised: a second flush waits for the first, so two block diffs never race each other.
  function flush() { flushing = flushing.then(doFlush, doFlush); return flushing; }
  function applyIdMap(map) {
    if (!map || !Object.keys(map).length) return;
    comments = comments.map((c) => (map[c.id] ? { ...c, id: map[c.id] } : c));
    if (activeComment && map[activeComment]) activeComment = map[activeComment];
    renderRail();
  }
  async function doFlush() {
    clearTimeout(saveTimer);
    if (!dirty || !doc) return;
    dirty = false;
    const id = doc.id;
    const blocks = editor.getBlocks().map((b) => ({ ...b }));
    const mine = comments;
    try {
      let r, idMap = null;
      if (store.isLocal(id)) { await store.saveComments(id, mine); r = await store.saveBlocks(id, blocks, doc.title); }
      else { r = await store.saveBlocks(id, blocks, doc.title); idMap = (await store.saveComments(id, mine)).idMap; }
      if (!doc || doc.id !== id) return;
      if (r.id && r.id !== id) { // a browser-only document just moved to the hub
        idMap = r.idMap; doc.id = r.id; wantedId = r.id; docVersion = r.version;
        applyIdMap(idMap);
        navigate('studio', [r.id], {}, { replace: true });
        toast('Saved to the hub with its project');
        loadDocs();
        return;
      }
      if (r.version != null) docVersion = r.version;
      applyIdMap(idMap);
      const d = docs.find((x) => x.id === id);
      if (d) { d.title = doc.title; d.blockCount = blocks.length; renderDocs(); }
      if (!dirty) setStatus(`Saved${store.isLocal(id) ? ' on this device' : ''} · ${new Date().toTimeString().slice(0, 5)}`);
      renderRail();
    } catch (e) { dirty = true; toastError(e, 'Could not save'); setStatus('Not saved'); }
  }

  function projectName(id) { const p = id && sel.projects().find((x) => x.id === id); return p ? p.name : ''; }
  function fillProjects() {
    const keep = projectSel.value || (state.ui.projectId && state.ui.projectId !== 'all' ? state.ui.projectId : '');
    projectSel.textContent = '';
    projectSel.appendChild(h('option', { value: '' }, 'No project'));
    for (const p of sel.projects()) projectSel.appendChild(h('option', { value: p.id }, p.name));
    projectSel.value = Array.from(projectSel.options).some((o) => o.value === keep) ? keep : '';
  }

  function renderDocs() {
    docList.textContent = '';
    if (!docs.length) docList.appendChild(h('li', { class: 'st-empty' }, 'No documents yet.'));
    for (const d of docs) {
      const on = doc && doc.id === d.id;
      docList.appendChild(h('li', { class: ['st-doc', on && 'on'] },
        h('a', { class: 'st-doclink', href: `#/studio/${encodeURIComponent(d.id)}`, 'aria-current': on ? 'page' : null },
          h('span', { class: 'st-doctitle' }, d.title || 'Untitled'),
          h('span', { class: 'st-docmeta mono' }, [projectName(d.projectId), fmtAgo ? fmtAgo(new Date(d.updatedAt).getTime()) : ''].filter(Boolean).join(' · '))),
        h('button', { class: 'icon-btn sm st-docdel', type: 'button', title: 'Archive', 'aria-label': `Archive ${d.title}`, onclick: () => archive(d) }, icon('archive', 14))));
    }
  }

  async function archive(d) {
    if (!window.confirm(`Archive "${d.title}"?`)) return;
    try {
      await store.deleteDoc(d.id);
      docs = docs.filter((x) => x.id !== d.id);
      if (doc && doc.id === d.id) { doc = null; dirty = false; navigate('studio'); }
      renderDocs();
    } catch (e) { toastError(e, 'Could not archive'); }
  }

  async function loadDocs() {
    try { docs = await store.listDocs(); } catch (e) { docs = []; toastError(e, 'Could not list documents'); }
    renderDocs();
  }

  async function open(id) {
    const token = ++loadToken;
    flush();
    if (!id) { doc = null; show(); return; }
    try {
      const r = await store.getDoc(id);
      if (token !== loadToken) return;
      doc = r.doc;
      comments = r.comments;
      docVersion = doc.version || 0;
      wasDrafting = false;
      draftAnchor = null; activeComment = null;
      titleInput.value = doc.title;
      editor.setBlocks(editable(doc.blocks));
      comments = reanchorAll(comments, editor.getBlocks());
      setStatus('');
      show();
      renderRail();
      renderDocs();
      syncJobs();
      if (tab === 'preview') renderPreview();
    } catch (e) {
      if (token !== loadToken) return;
      doc = null; show();
      toast(e.status === 404 ? 'That document no longer exists.' : e.message, { kind: 'error' });
      navigate('studio', [], {}, { replace: true });
    }
  }

  function show() {
    const has = !!doc;
    wrap.dataset.mode = has ? 'doc' : 'new';
    setHidden(noDoc, has); setHidden(workbench, !has);
    setTab(tab, false, true);
    if (!has) { renderDocs(); setTimeout(() => { if (wrap.dataset.mode === 'new') promptBox.focus({ preventScroll: true }); }, 0); }
  }
  function setHidden(el, v) { el.hidden = !!v; }

  async function create() {
    const prompt = promptBox.value.trim();
    if (!prompt) { toast('Describe what you want to create first.'); promptBox.focus(); return; }
    createBtn.disabled = true;
    try {
      const r = await store.createDoc({ projectId: projectSel.value || null, prompt });
      if (r.job) extraJobs.set(r.job.id, r.job);
      if (r.draftError) toast(`${r.draftError}. The document starts empty; open Claude Code with the Helm mod and describe it again.`, { kind: 'info' });
      promptBox.value = '';
      await loadDocs();
      navigate('studio', [r.doc.id]);
    } catch (e) { toastError(e, 'Could not create'); }
    finally { createBtn.disabled = false; }
  }
  function updateCreateNote() {
    setText(createNote, projectSel.value
      ? 'Sonnet drafts the document through your Claude Code session (a few cents). You can leave this screen while it works.'
      : 'No project chosen: the document starts with your description as a quote, saved in this browser. Pick a project to have the model draft it.');
  }
  const editable = (blocks) => (blocks && blocks.length ? blocks : [{ id: 'b1', type: 'p', text: '' }]);

  /* ----- tabs + print ----- */
  function setTab(t, focus, quiet) {
    tab = t;
    for (const k of ['edit', 'preview']) {
      const on = k === t;
      tabBtns[k].setAttribute('aria-selected', String(on));
      tabBtns[k].tabIndex = on ? 0 : -1;
      setClass(tabBtns[k], 'on', on);
    }
    editorPanel.hidden = t !== 'edit';
    previewPanel.hidden = t !== 'preview';
    typeBar.hidden = t !== 'edit';
    commentBtn.hidden = t !== 'edit';
    commentRail.hidden = t !== 'edit';
    wrap.dataset.tab = t;
    if (t === 'preview' && doc) renderPreview();
    if (focus) tabBtns[t].focus();
    if (!quiet) updateSelectionUI();
  }
  function renderPreview() {
    previewHost.textContent = '';
    previewHost.appendChild(buildPaper(editor.getBlocks()));
  }
  let printRoot = null;
  function preparePrint() {
    cleanupPrint();
    if (!doc) return false;
    printRoot = h('div', { class: 'st-print-root' }, buildPaper(editor.getBlocks(), 'st-paper st-paper-print'));
    document.body.appendChild(printRoot);
    document.documentElement.classList.add('st-printing');
    return true;
  }
  function cleanupPrint() {
    document.documentElement.classList.remove('st-printing');
    if (printRoot) { printRoot.remove(); printRoot = null; }
  }
  function printNow() {
    if (!doc) return;
    flush();
    if (preparePrint()) window.print(); // afterprint removes the print root again
  }
  const onBefore = () => { if (route && wrap.isConnected) preparePrint(); };
  window.addEventListener('beforeprint', onBefore);
  window.addEventListener('afterprint', cleanupPrint);

  /* ----- comments ----- */
  function updateSelectionUI() {
    const a = tab === 'edit' && doc ? selectionAnchor : null;
    commentBtn.disabled = !a;
    if (!a) { bubble.hidden = true; return; }
    const r = a.rect;
    bubble.hidden = false;
    const w = bubble.offsetWidth || 90;
    bubble.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w / 2))}px`;
    bubble.style.top = `${Math.min(window.innerHeight - 40, r.bottom + 8)}px`;
  }

  function startComment() {
    const a = selectionAnchor || editor.currentAnchor();
    if (!a || !doc) { toast('Select some text in one block first.'); return; }
    draftAnchor = { blockId: a.blockId, start: a.start, end: a.end, quote: a.quote };
    renderDraft();
    bubble.hidden = true;
  }
  function renderDraft() {
    commentHost.textContent = '';
    if (!draftAnchor) return;
    const ta = h('textarea', {
      class: 'st-comment-input', rows: 3, 'aria-label': 'Comment', placeholder: 'What should change here?',
      onkeydown: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cancelDraft(); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
      },
    });
    const submit = () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      const a = draftAnchor;
      draftAnchor = null;
      comments = comments.concat([{ id: newCommentId(comments), blockId: a.blockId, start: a.start, end: a.end, quote: a.quote, text: text.slice(0, 2000), state: 'open', createdAt: new Date().toISOString() }]);
      renderDraft(); renderRail(); markDirty(); editor.refreshHighlights();
      editor.focusAt(a.blockId, a.end);
    };
    commentHost.appendChild(h('div', { class: 'st-card st-draft' },
      h('blockquote', { class: 'st-quote' }, a_q(draftAnchor.quote)),
      ta,
      h('div', { class: 'st-card-foot' }, h('span', { class: 'st-hint' }, h('kbd', { class: 'kbd' }, '⌘↵'), ' add · ', h('kbd', { class: 'kbd' }, 'Esc'), ' cancel'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: cancelDraft }, 'Cancel'),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: submit }, 'Add'))));
    ta.focus();
  }
  const a_q = (q) => (q.length > 140 ? q.slice(0, 137) + '…' : q);
  function cancelDraft() { draftAnchor = null; renderDraft(); const id = editor.focusedId(); if (doc && id) editor.focusAt(id, 0); }

  const applicable = () => comments.filter((c) => c.state === 'open' || c.state === 'conflict').length;
  const queuedCount = () => comments.filter((c) => c.state === 'queued').length;
  const allJobs = () => { const m = new Map(state.jobs); for (const [k, v] of extraJobs) if (!m.has(k)) m.set(k, v); return m; };
  const CHIP = { orphaned: 'text changed', queued: 'waiting' };
  function renderRail() {
    broadcast();
    const n = applicable(), q = queuedCount();
    applyBtn.textContent = q ? 'Applying…' : n ? `Apply all (${n})` : 'Apply all';
    applyBtn.disabled = !n || q > 0;
    renderBatch();
    commentList.textContent = '';
    if (!comments.length) commentList.appendChild(h('li', { class: 'st-empty' }, 'Select text and press Comment. Each note is pinned to its block and the quoted words.'));
    for (const c of comments) {
      const chip = `${CHIP[c.state] || c.state}${c.state === 'applied' && c.appliedVersion ? ` · v${c.appliedVersion}` : ''}`;
      const li = h('li', { class: ['st-card', 'st-comment', activeComment === c.id && 'on'], 'data-state': c.state },
        h('button', { class: 'st-comment-main', type: 'button', onclick: () => jump(c), 'aria-label': `Comment on "${a_q(c.quote)}"` },
          h('blockquote', { class: 'st-quote' }, a_q(c.quote)),
          h('p', { class: 'st-comment-text' }, c.text)),
        c.state === 'conflict' && c.reason ? h('p', { class: 'st-comment-reason' }, `Not applied: ${c.reason}`) : null,
        h('div', { class: 'st-card-foot' },
          h('span', { class: `st-chip st-chip-${c.state}` }, chip),
          h('span', { class: 'spacer' }),
          h('button', { class: 'icon-btn sm', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment', disabled: c.state === 'queued', onclick: () => removeComment(c.id) }, icon('trash', 14))));
      commentList.appendChild(li);
    }
    ensureTicker();
  }
  /** Progress while Apply all runs, and the result card (with Undo) once a batch has landed and nothing has changed since. */
  function renderBatch() {
    batchHost.textContent = '';
    if (!doc || store.isLocal(doc.id)) return;
    const queued = comments.filter((c) => c.state === 'queued');
    if (queued.length) {
      const job = allJobs().get(queued[0].jobId);
      batchHost.appendChild(h('div', { class: 'st-batch', role: 'status' },
        h('div', { class: 'st-batch-head' }, h('span', { class: 'st-pulse', 'aria-hidden': 'true' }), h('strong', null, `Applying ${queued.length} comment${queued.length === 1 ? '' : 's'}`)),
        h('p', { class: 'st-batch-sub' }, jobProgress(job, Date.now()) || 'Starting…')));
      return;
    }
    const batch = undoableBatch(comments, docVersion);
    if (!batch) return;
    const left = comments.filter((c) => c.state === 'conflict').length;
    batchHost.appendChild(h('div', { class: 'st-batch' },
      h('div', { class: 'st-batch-head' }, icon('check', 14), h('strong', null, `${batch.length} comment${batch.length === 1 ? '' : 's'} applied as one version`)),
      left ? h('p', { class: 'st-batch-sub' }, `${left} could not be applied. The reason is on each comment; fix the text or apply again.`) : null,
      h('div', { class: 'st-card-foot' }, h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => undoBatch() }, 'Undo all'))));
  }
  function jump(c) {
    activeComment = c.id;
    editor.setActiveComment(c.id);
    if (c.state === 'orphaned') { toast('That text was edited away. The note is kept; delete it when done.'); }
    else if (!editor.reveal(c)) toast('That block is gone.');
    renderRail();
  }
  function removeComment(id) {
    comments = comments.filter((c) => c.id !== id);
    if (activeComment === id) { activeComment = null; editor.setActiveComment(null); }
    renderRail(); editor.refreshHighlights(); markDirty();
  }
  async function applyAll() {
    if (!doc || !applicable()) return;
    applyBtn.disabled = true;
    try {
      await flush();
      const r = await store.applyAll(doc.id);
      if (!r.ok) toast(r.reason, { kind: 'info' });
      else { if (r.job) extraJobs.set(r.job.id, r.job); await refreshDoc(true); }
    } catch (e) { toastError(e, 'Apply all failed'); }
    finally { renderRail(); }
  }
  async function undoBatch() {
    if (!doc) return;
    await flush();
    if (!undoableBatch(comments, docVersion)) { toast('The document changed since Apply all, so there is nothing safe to undo.', { kind: 'info' }); renderRail(); return; }
    try {
      await store.undoApply(doc.id, docVersion - 1);
      await refreshDoc(true);
      toast('Apply all undone. Those comments are open again.');
    } catch (e) { toastError(e, 'Could not undo'); }
  }

  /* ----- hub jobs: draft progress, Apply all results ----- */
  const sameBlocks = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id && x.type === b[i].type && x.text === b[i].text);
  /** Pull the hub's copy (after a job finished, or an undo) and show it, keeping unsaved typing and unsent comments. */
  async function refreshDoc(force) {
    if (!doc || store.isLocal(doc.id) || refreshing) return;
    refreshing = true;
    const id = doc.id;
    try {
      await flush();
      const r = await store.getDoc(id);
      if (!doc || doc.id !== id) return;
      docVersion = r.doc.version;
      if (!dirty && !sameBlocks(editor.getBlocks(), editable(r.doc.blocks))) editor.setBlocks(editable(r.doc.blocks));
      if (!titleInput.matches(':focus') && r.doc.title !== doc.title) { doc.title = r.doc.title; titleInput.value = r.doc.title; }
      const pending = comments.filter((c) => /^c\d+$/.test(c.id));
      comments = reanchorAll(r.comments.concat(pending), editor.getBlocks());
      renderRail(); editor.refreshHighlights();
      if (tab === 'preview') renderPreview();
    } catch (e) { if (force) toastError(e, 'Could not refresh'); }
    finally { refreshing = false; syncJobs(); }
  }
  function syncJobs() {
    if (!doc || store.isLocal(doc.id)) { jobBar.hidden = true; editor.setReadOnly(false); return; }
    const { draft } = docJobs(allJobs(), doc.id);
    const drafting = jobActive(draft);
    editor.setReadOnly(drafting);
    jobBar.textContent = '';
    if (drafting) {
      jobBar.hidden = false; jobBar.dataset.kind = 'running';
      jobBar.append(h('span', { class: 'st-pulse', 'aria-hidden': 'true' }), h('span', null, `Drafting: ${jobProgress(draft, Date.now(), 'Sonnet is writing')} You can leave this screen; the page fills in when it is done.`));
    } else if (draft && draft.state === 'failed' && docVersion === 0) {
      jobBar.hidden = false; jobBar.dataset.kind = 'failed';
      jobBar.append(h('span', { class: 'st-pulse', 'aria-hidden': 'true' }), h('span', null, `The draft did not work: ${draft.error || 'unknown error'}. You can write the document by hand.`));
    } else jobBar.hidden = true;
    if (wasDrafting && !drafting) refreshDoc();
    wasDrafting = drafting;
    ensureTicker();
  }
  function ensureTicker() {
    const busy = !!doc && !store.isLocal(doc.id) && (jobActive(docJobs(allJobs(), doc.id).draft) || queuedCount() > 0);
    if (busy && !ticker) ticker = setInterval(() => { renderBatch(); syncJobs(); }, 1000);
    else if (!busy && ticker) { clearInterval(ticker); ticker = null; }
  }
  /** A job or a document changed over the event stream: refresh when the hub's copy moved or a job we wait for has finished. */
  function onHubChange() {
    if (!doc || store.isLocal(doc.id)) return;
    syncJobs();
    const row = state.docs.get(doc.id);
    const jobs = allJobs();
    const finished = comments.some((c) => c.state === 'queued' && c.jobId && jobs.has(c.jobId) && !jobActive(jobs.get(c.jobId)));
    if ((row && row.version !== docVersion && !dirty) || finished) refreshDoc();
  }

  /* ----- global keys for this view ----- */
  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyM' && doc && tab === 'edit') { e.preventDefault(); startComment(); }
  };
  document.addEventListener('keydown', onKey);
  const onHide = () => flush();
  window.addEventListener('beforeunload', onHide);
  document.addEventListener('visibilitychange', onHide);
  const onScroll = () => updateSelectionUI();
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);

  /* ----- boot ----- */
  fillProjects();
  updateCreateNote();
  setTab('edit', false, true);
  setHidden(workbench, true);
  loadDocs().then(() => open(wantedId));

  return {
    watch: ['project', 'job', 'doc'],
    update(changed) {
      if (changed.has('project')) { fillProjects(); renderDocs(); }
      if (changed.has('doc')) { clearTimeout(listTimer); listTimer = setTimeout(loadDocs, 800); } // edits fire doc events: keep the list fresh without a request per keystroke
      onHubChange();
    },
    setRoute(r) {
      const id = r.args[0] || null;
      if (id !== wantedId) { wantedId = id; open(id); }
    },
    destroy() {
      flush();
      editor.destroy();
      cleanupPrint();
      bubble.remove();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onHide);
      window.removeEventListener('beforeprint', onBefore);
      window.removeEventListener('afterprint', cleanupPrint);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      clearTimeout(saveTimer);
      if (ticker) clearInterval(ticker);
      clearTimeout(listTimer);
    },
  };
}
