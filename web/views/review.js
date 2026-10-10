// views/review.js — the Review queue (#/review[/T-n]): every task waiting in Review in one focused two-pane workspace.
// Left: the queue (oldest in review first, or newest). Right: the selected task — header + the agent's report, recap,
// the diff (the same renderer as the Diff panel, diffview.js), checks, and an action bar: Approve (A), Request changes (R,
// a `!` task note that always reaches the agent), Later (L), and J/K or ↓/↑ to skip. Live through the store (SSE): new
// reviews appear, finished ones leave, and the selection moves on after every action. Everything from git, agents and
// the hub ends up in text nodes.
import { h, reconcile, setText, setClass, setHidden } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, ingestActivity, lsGet, lsSet } from '../store.js';
import { api } from '../api.js';
import { patchTask, setStatus, addNote, decideGate } from '../actions.js';
import { agentLabel, STATUS_META, plural } from '../format.js';
import { toast, emptyState, modelBadge, updateModelBadge, statusDot } from '../ui.js';
import { navigate, openTask, setChat, setDiff, route } from '../router.js';
import { ensureDiff, loadDiff, onDiff, diffEntry, taskHasFiles, statNodes, dirOf, baseOf, STATUS_TITLE, SOURCE_LABEL } from '../diffs.js';
import { renderDiffBody, langOf } from '../diffview.js';
import { bindDraft, clearDraft } from '../drafts.js';
import { codeEditor, blockView } from '../code.js';
import { createAttachTray, bindAttachInput, attsOf } from '../attachments.js';
import * as R from '../review.js';

const SHORTCUTS = [
  ['J  /  ↓', 'Next task in the queue'],
  ['K  /  ↑', 'Previous task'],
  ['A', 'Approve: move the task to Done (Undo in the toast)'],
  ['R', 'Request changes: write a note that goes straight to the agent'],
  ['L', 'Later: save the task for later'],
  ['↵', 'Open the current file in the Diff panel'],
  ['[  /  ]', 'Previous / next file of the diff'],
  ['⌘↵', 'Send the change request (while writing it)'],
  ['Esc', 'Close the composer or this help'],
  ['?', 'Show or hide this help'],
];

/** "12m", "3h 05m", "2d" — how long a task has waited. */
export function fmtWait(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}

const REPORT_RE = /^Agent (?:finished|failed):\s*/;
const fetchedReports = new Set();

/** The agent's final report: the "Agent finished: …" status row the hub records when the agent completes. */
function reportOf(t) {
  const rows = sel.activityRows((a) => a.kind === 'status' && (a.taskId === t.id || (t.agentId && a.agentId === t.agentId)) && REPORT_RE.test(a.summary || ''));
  const last = rows[rows.length - 1];
  return last ? last.summary.replace(REPORT_RE, '') : '';
}

/** Latest "request changes" note (a `!` task note written after the task entered Review). */
function changesNote(t) {
  const since = R.reviewSince(t);
  let best = null;
  for (const n of state.notes.values()) {
    if (!n.target || n.target.kind !== 'task' || n.target.id !== t.id || !String(n.text || '').startsWith('!')) continue;
    if ((n.createdAt || 0) < since - 1000) continue;
    if (!best || (n.createdAt || 0) > (best.createdAt || 0)) best = n;
  }
  return best;
}
const CHANGES_LABEL = { draft: 'Changes drafted', queued: 'Changes sent', sending: 'Changes sending', ran: 'Changes delivered', failed: 'Changes failed' };

export function mount(container, route0) {
  let order = lsGet('helm.review.order', 'oldest') === 'newest' ? 'newest' : 'oldest';
  let selectedId = (route0 && route0.args && route0.args[0]) || null;
  let queue = [];
  let lastIds = [];
  let pane = null;
  let helpOpen = false;
  let alive = true;

  /* ---------- structure ---------- */
  const count = h('span', { class: 'panel-count mono rv-count' });
  const todayEl = h('div', { class: 'rv-today mono' });
  const segOld = h('button', { class: 'dp-seg', type: 'button', role: 'radio', title: 'Longest waiting first', onclick: () => setOrder('oldest') }, 'Oldest');
  const segNew = h('button', { class: 'dp-seg', type: 'button', role: 'radio', title: 'Most recently finished first', onclick: () => setOrder('newest') }, 'Newest');
  const seg = h('div', { class: 'dp-segs rv-seg', role: 'radiogroup', 'aria-label': 'Queue order' }, segOld, segNew);
  const list = h('ul', { class: 'rv-list', role: 'listbox', 'aria-label': 'Tasks in review' });
  const queueEl = h('aside', { class: 'rv-queue', 'aria-label': 'Review queue' },
    h('header', { class: 'rv-qhead' },
      h('h2', { class: 'rv-qtitle' }, icon('review', 16), 'In review', count),
      seg),
    todayEl, list);
  const slot = h('div', { class: 'rv-slot' });
  const emptyEl = h('div', { class: 'rv-empty', hidden: true });
  const mainEl = h('section', { class: 'rv-main', 'aria-label': 'Review' }, slot, emptyEl);
  const help = h('div', { class: 'rv-help-scrim', hidden: true, onmousedown: (e) => { if (e.target === help) toggleHelp(false); } },
    h('div', { class: 'rv-help', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Review shortcuts' },
      h('h3', {}, 'Keyboard shortcuts'),
      h('dl', {}, SHORTCUTS.map(([k, d]) => [h('dt', { class: 'mono' }, ...k.split(/\s{2}\/\s{2}/).flatMap((p, i) => [i ? ' / ' : null, h('kbd', {}, p)])), h('dd', {}, d)])),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => toggleHelp(false) }, 'Close')));
  const root = h('div', { class: 'rv' }, queueEl, mainEl, help);
  container.appendChild(root);

  /* ---------- queue rows ---------- */
  function makeRow(t) {
    const r = {};
    r.id = h('span', { class: 'rv-id mono' });
    r.stat = h('span', { class: 'rv-stat mono' });
    r.wait = h('span', { class: 'rv-wait mono', title: 'Time in review' });
    r.title = h('div', { class: 'rv-rtitle' });
    r.agent = h('span', { class: 'rv-agent mono' });
    r.model = modelBadge('');
    r.run = h('span', { class: 'run-chip', title: 'Made by a workflow run' });
    r.changes = h('span', { class: 'rv-chg mono' });
    r.recap = h('div', { class: 'rv-recap' });
    const btn = h('button', { class: 'rv-row', type: 'button', role: 'option', onclick: () => select(btn.__id) },
      h('div', { class: 'rv-r1' }, r.id, r.stat, h('span', { class: 'spacer' }), icon('clock', 12), r.wait),
      r.title,
      h('div', { class: 'rv-r3' }, r.agent, r.model, r.run, r.changes),
      r.recap);
    btn.__r = r;
    return h('li', { class: 'rv-item' }, btn);
  }
  function updateRow(li, t) {
    const btn = li.firstChild;
    const r = btn.__r;
    btn.__id = t.id;
    li.setAttribute('data-id', t.id);
    const on = t.id === selectedId;
    btn.setAttribute('aria-selected', String(on));
    setClass(btn, 'on', on);
    setText(r.id, t.id);
    r.stat.textContent = '';
    if (t.diffStat) r.stat.append(...statNodes(t.diffStat.additions || 0, t.diffStat.deletions || 0));
    else if ((t.filesChanged || []).length) r.stat.append(plural(t.filesChanged.length, 'file'));
    setText(r.wait, fmtWait(Date.now() - R.reviewSince(t)));
    setText(r.title, t.title);
    const agent = sel.agentOfTask(t);
    setHidden(r.agent, !agent);
    setHidden(r.model, !agent);
    if (agent) { setText(r.agent, agentLabel(agent)); updateModelBadge(r.model, agent.model); }
    setHidden(r.run, !t.runId);
    if (t.runId) setText(r.run, `${t.runId} · ${t.nodeId || 'run'}`);
    const cn = changesNote(t);
    setHidden(r.changes, !cn);
    if (cn) { setText(r.changes, CHANGES_LABEL[cn.state] || 'Changes sent'); r.changes.className = `rv-chg mono s-${cn.state}`; }
    const one = t.recap && t.recap.what ? t.recap.what : '';
    setText(r.recap, one || 'No recap yet');
    setClass(r.recap, 'dim', !one);
  }

  /* ---------- selection ---------- */
  function effectiveId() {
    if (selectedId && queue.some((t) => t.id === selectedId)) return selectedId;
    // the selected task left the queue (approved elsewhere, moved on): take the neighbour at the same position
    const was = lastIds.indexOf(selectedId);
    if (selectedId && was >= 0 && queue.length) return queue[Math.min(was, queue.length - 1)].id;
    return queue.length ? queue[0].id : null;
  }
  function select(id, opts = {}) {
    if (!id) return;
    selectedId = id;
    if (!opts.silent) {
      const r = route();
      if (r.view === 'review' && r.args[0] !== id) navigate('review', [id], {}, { replace: true });
    }
    render();
    const el = list.__keyed && list.__keyed.get(id);
    if (el && typeof el.scrollIntoView === 'function') { try { el.scrollIntoView({ block: 'nearest' }); } catch { /* old engines */ } }
  }
  function neighbour(id, delta) {
    const i = queue.findIndex((t) => t.id === id);
    if (i < 0) return queue.length ? queue[0].id : null;
    const j = Math.min(queue.length - 1, Math.max(0, i + delta));
    return queue[j].id;
  }
  /** After an action: the task after this one, else the one before, else nothing. */
  function nextAfter(id) {
    const i = queue.findIndex((t) => t.id === id);
    if (i < 0) return queue.length ? queue[0].id : null;
    const n = queue[i + 1] || queue[i - 1];
    return n ? n.id : null;
  }
  function setOrder(o) {
    if (o === order) return;
    order = o;
    lsSet('helm.review.order', o);
    render();
  }

  /* ---------- actions ---------- */
  const cur = () => (selectedId ? state.tasks.get(selectedId) : null);
  async function approve() {
    const t = cur();
    if (!t || t.status !== 'review' || t.__pending) return;
    const id = t.id;
    const gate = sel.gateOfTask(t);
    const next = nextAfter(id);
    R.markReviewed(id);
    if (next) select(next); else render();
    if (gate) {
      const run = await decideGate(gate.run.id, gate.node.nodeId, 'approve', '');
      if (!run) { R.unmarkReviewed(id); select(id); }
      return;
    }
    const res = await patchTask(id, { status: 'done' }, 'Could not approve');
    if (!res) { R.unmarkReviewed(id); select(id); renderToday(); return; }
    toast(`Approved ${id}`, {
      kind: 'success', duration: 7000,
      action: { label: 'Undo', onClick: () => { R.unmarkReviewed(id); setStatus(id, 'review', 'Could not undo'); select(id); renderToday(); } },
    });
  }
  async function later() {
    const t = cur();
    if (!t || t.status !== 'review' || t.__pending) return;
    const id = t.id;
    const next = nextAfter(id);
    if (next) select(next);
    const res = await patchTask(id, { status: 'later' }, 'Could not move to later');
    if (!res) { select(id); return; }
    toast(`${id} saved for later`, { action: { label: 'Undo', onClick: () => { setStatus(id, 'review', 'Could not undo'); select(id); } } });
  }
  function skip(delta) {
    const id = neighbour(effectiveId(), delta);
    if (id) select(id);
  }
  function openCurrentDiff() {
    const t = cur();
    if (!t || !pane) return;
    const rel = pane.currentFile();
    if (!rel) { toast('This task has no changed files to open', { kind: 'info' }); return; }
    if (route().task !== t.id) openTask(t.id);
    setDiff(rel);
  }

  /* ---------- the review pane for one task ---------- */
  function createPane(id) {
    const c = {};
    let mode = lsGet('helm.diff.view', 'unified') === 'split' ? 'split' : 'unified';
    let wrap = lsGet('helm.diff.wrap', '1') !== '0';
    let file = null;
    let bodySig = '';
    let tabsSig = '';
    let composer = null;
    let ticks = R.loadTicks(id);
    const task = () => state.tasks.get(id);

    /* header */
    c.id = h('span', { class: 'task-id mono' }, id);
    c.pill = h('span', { class: 'status-pill' }, statusDot('review'), h('span', {}, ''));
    c.run = h('button', { class: 'run-chip', type: 'button', hidden: true, onclick: () => { const t = task(); const run = t && state.runs.get(t.runId); if (run) navigate('workflows', [run.workflowId], { run: run.id }); } });
    c.details = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', title: 'Open the task details in the Dock', onclick: () => openTask(id) }, icon('file', 14), 'Details');
    c.chat = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', title: 'Open the task and its chat in the Dock', onclick: () => { openTask(id); setChat(true); } }, icon('chat', 14), 'Chat');
    c.title = h('h2', { class: 'rv-title' });
    c.meta = h('div', { class: 'rv-meta' });
    c.reportBody = h('div', { class: 'rv-report-body' });
    c.report = h('details', { class: 'rv-report', hidden: true }, h('summary', {}, icon('chevronRight', 13, 'rv-chev'), 'Agent’s final report'), c.reportBody);
    c.head = h('header', { class: 'rv-head' },
      h('div', { class: 'rv-head-top' }, c.id, c.pill, c.run, h('span', { class: 'spacer' }), c.details, c.chat),
      c.title, c.meta, c.report);

    /* recap */
    c.recapBody = h('div', { class: 'rv-recap-body' });
    c.recapSec = h('section', { class: 'rv-sec' }, h('h3', { class: 'rv-sec-title' }, icon('sparkle', 14), 'Recap'), c.recapBody);

    /* diff */
    c.segU = h('button', { class: 'dp-seg', type: 'button', role: 'radio', title: 'Unified view', onclick: () => setMode('unified') }, icon('rows', 14), 'Unified');
    c.segS = h('button', { class: 'dp-seg', type: 'button', role: 'radio', title: 'Split view: old on the left, new on the right', onclick: () => setMode('split') }, icon('columns', 14), 'Split');
    c.wrapBtn = h('button', { class: 'dp-tool', type: 'button', 'aria-pressed': 'true', title: 'Wrap long lines', onclick: () => { wrap = !wrap; lsSet('helm.diff.wrap', wrap ? '1' : '0'); bodySig = ''; paintDiff(); } }, icon('wrap', 14), h('span', { class: 'dp-tool-l' }, 'Wrap'));
    c.src = h('span', { class: 'fc-src mono dp-src', hidden: true });
    c.srcNote = h('span', { class: 'dp-srcnote mono', hidden: true });
    c.refresh = h('button', { class: 'icon-btn sm dp-refresh', type: 'button', 'aria-label': 'Recompute the diff now', title: 'Recompute from the working tree', onclick: () => { const t = task(); if (t) loadDiff(t, true); } }, icon('retry', 14));
    c.openPanel = h('button', { class: 'dp-tool', type: 'button', title: 'Open this file in the Diff panel (Enter)', onclick: () => openCurrentDiff() }, icon('popout', 14), h('span', { class: 'dp-tool-l' }, 'Panel'));
    c.diffBar = h('div', { class: 'dp-toolbar rv-diffbar' },
      h('div', { class: 'dp-segs', role: 'radiogroup', 'aria-label': 'Diff layout' }, c.segU, c.segS),
      c.wrapBtn, c.src, c.srcNote, h('span', { class: 'spacer' }), c.openPanel, c.refresh);
    c.tabs = h('div', { class: 'dp-tabs', role: 'tablist', 'aria-label': 'Changed files' });
    c.diffBody = h('div', { class: 'dp-body rv-diff-body' });
    c.diffTotals = h('span', { class: 'panel-count mono' });
    c.diffBox = h('div', { class: 'rv-diffbox' }, c.diffBar, c.tabs, c.diffBody);
    c.noFiles = h('p', { class: 'rv-nofiles dim', hidden: true }, 'No files changed — this task has only its recap and report.');
    c.diffSec = h('section', { class: 'rv-sec rv-diffsec' }, h('h3', { class: 'rv-sec-title' }, icon('diff', 14), 'Diff', c.diffTotals), c.diffBox, c.noFiles);

    /* checks */
    c.checksCount = h('span', { class: 'panel-count mono' });
    c.runChecks = h('ul', { class: 'rv-checks rv-runchecks', 'aria-label': 'Workflow checks' });
    c.ticks = h('ul', { class: 'rv-checks rv-ticks', 'aria-label': 'Checklist from the task description' });
    c.checksHint = h('p', { class: 'rv-hint mono' }, 'Ticks are for you only: saved in this browser, never sent to the agent.');
    c.checksSec = h('section', { class: 'rv-sec', hidden: true }, h('h3', { class: 'rv-sec-title' }, icon('checklist', 14), 'Checks', c.checksCount), c.runChecks, c.ticks, c.checksHint);

    c.scroll = h('div', { class: 'rv-scroll' }, h('div', { class: 'rv-content' }, c.head, c.recapSec, c.diffSec, c.checksSec));

    /* action bar + composer */
    c.composerSlot = h('div', { class: 'rv-composer-slot', hidden: true });
    c.approve = h('button', { class: 'btn btn-primary rv-approve', type: 'button', title: 'Approve: move to Done (A)', onclick: () => approve() }, icon('check', 16), 'Approve', h('kbd', {}, 'A'));
    c.request = h('button', { class: 'btn rv-request', type: 'button', 'aria-expanded': 'false', title: 'Request changes: write a note for the agent (R)', onclick: () => toggleComposer() }, icon('note', 15), 'Request changes', h('kbd', {}, 'R'));
    c.later = h('button', { class: 'btn btn-quiet rv-later', type: 'button', title: 'Save for later (L)', onclick: () => later() }, icon('bookmark', 15), 'Later', h('kbd', {}, 'L'));
    c.prev = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Previous task (K)', title: 'Previous task (K)', onclick: () => skip(-1) }, icon('chevronUp', 16));
    c.next = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Next task (J)', title: 'Next task (J)', onclick: () => skip(1) }, icon('chevronDown', 16));
    c.pos = h('span', { class: 'rv-pos mono' });
    c.helpBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Keyboard shortcuts (?)', title: 'Keyboard shortcuts (?)', onclick: () => toggleHelp() }, icon('question', 16));
    c.bar = h('div', { class: 'rv-bar', role: 'toolbar', 'aria-label': 'Review actions' }, c.approve, c.request, c.later, h('span', { class: 'spacer' }), c.pos, c.prev, c.next, c.helpBtn);
    c.foot = h('div', { class: 'rv-foot' }, c.composerSlot, c.bar);

    const el = h('div', { class: 'rv-pane', 'data-task': id }, c.scroll, c.foot);

    /* ----- diff painting ----- */
    function setMode(m) {
      if (m === mode) return;
      mode = m;
      lsSet('helm.diff.view', m);
      bodySig = '';
      paintDiff();
    }
    function filesOf() { const e = diffEntry(id); return e && e.data ? e.data.files : []; }
    const relOf = (f) => f.rel || f.path;
    function curFile() {
      const fs = filesOf();
      return fs.find((f) => relOf(f) === file || f.path === file) || fs[0] || null;
    }
    function goFile(delta) {
      const fs = filesOf();
      if (!fs.length) return;
      const cf = curFile();
      const i = Math.min(fs.length - 1, Math.max(0, fs.indexOf(cf) + delta));
      file = relOf(fs[i]);
      paintDiff();
    }
    const note = (text, cls = '') => h('div', { class: `dp-note mono ${cls}` }, text);
    function plainList(names) {
      return h('ul', { class: 'files mono fc-plain rv-plain' }, names.map((f) => h('li', { title: f }, h('span', { class: 'file-dir' }, dirOf(f)), h('span', { class: 'file-name' }, baseOf(f)))));
    }
    function paintDiff() {
      const t = task();
      if (!t) return;
      const has = taskHasFiles(t);
      setHidden(c.noFiles, has);
      setHidden(c.diffBox, !has);
      c.diffTotals.textContent = '';
      const stat = t.diffStat || (diffEntry(id) && diffEntry(id).data && diffEntry(id).data.totals) || null;
      if (has && stat) c.diffTotals.append('· ', plural(stat.files, 'file'), ' ', ...statNodes(stat.additions || 0, stat.deletions || 0));
      if (!has) return;
      const e = diffEntry(id);
      const d = e && e.data;
      const f = curFile();
      // toolbar
      c.segU.setAttribute('aria-checked', String(mode === 'unified')); setClass(c.segU, 'on', mode === 'unified');
      c.segS.setAttribute('aria-checked', String(mode === 'split')); setClass(c.segS, 'on', mode === 'split');
      c.wrapBtn.setAttribute('aria-pressed', String(wrap && mode === 'unified'));
      c.wrapBtn.disabled = mode === 'split';
      if (d) {
        c.src.textContent = SOURCE_LABEL[d.source] || d.source;
        c.src.className = `fc-src mono dp-src src-${d.source}`;
        c.src.title = d.source === 'snapshot' ? 'Frozen when the agent finished' : d.source === 'live' ? 'Computed from the working tree just now' : d.source === 'history' ? 'Approximate: no base commit was recorded' : '';
        c.srcNote.textContent = d.note || '';
      }
      setHidden(c.src, !d);
      setHidden(c.srcNote, !(d && d.note));
      setClass(c.refresh, 'spinning', !!(e && e.status === 'loading'));
      c.refresh.disabled = !!(e && e.status === 'loading');
      setHidden(c.refresh, !!(e && e.status === 'none'));
      setHidden(c.openPanel, !f);

      // tabs
      const fs = d ? d.files : [];
      const tsig = fs.map((x) => `${relOf(x)}|${x.status}|${x.additions}|${x.deletions}|${x.binary ? 1 : 0}`).join(';');
      if (tsig !== tabsSig) {
        tabsSig = tsig;
        c.tabs.textContent = '';
        for (const x of fs) {
          const rel = relOf(x);
          const st = STATUS_TITLE[x.status] ? x.status : '?';
          c.tabs.append(h('button', { class: 'dp-tab', type: 'button', role: 'tab', 'data-rel': rel, title: x.path || rel, onclick: () => { file = rel; paintDiff(); } },
            h('span', { class: `fc-badge mono s-${st === '?' ? 'u' : st}`, title: STATUS_TITLE[st] }, st),
            h('span', { class: 'dp-tab-name mono' }, baseOf(rel)),
            x.binary ? h('span', { class: 'df-bin mono' }, 'bin') : h('span', { class: 'dp-tab-stat mono' }, ...statNodes(x.additions || 0, x.deletions || 0))));
        }
      }
      setHidden(c.tabs, fs.length === 0);
      for (const b of c.tabs.children) {
        const on = !!f && b.getAttribute('data-rel') === relOf(f);
        b.setAttribute('aria-selected', String(on));
        setClass(b, 'active', on);
      }

      // body
      let sig;
      if (f) sig = `${id}|${relOf(f)}|${mode}|${wrap ? 1 : 0}|${f.additions}|${f.deletions}|${f.binary ? 1 : 0}|${f.truncated ? 1 : 0}|${(f.patch || '').length}|${(f.patch || '').slice(0, 80)}`;
      else sig = `none|${e ? e.status : 'x'}|${d ? d.files.length : 0}|${(e && e.error) || ''}`;
      if (sig === bodySig) return;
      bodySig = sig;
      c.diffBody.textContent = '';
      c.diffBody.classList.toggle('wrap', wrap && mode === 'unified');
      c.diffBody.classList.toggle('split', mode === 'split');
      if (f) { c.diffBody.append(renderDiffBody(f, langOf(relOf(f)), mode).el); return; }
      const names = t.filesChanged || [];
      if (!e || (e.status === 'loading' && !d)) c.diffBody.append(note('Loading diff…'));
      else if (e.status === 'error') c.diffBody.append(note(`Could not load the diff: ${e.error}`, 'err'), h('button', { class: 'btn btn-quiet dp-retry', type: 'button', onclick: () => { const x = task(); if (x) loadDiff(x, true); } }, 'Try again'));
      else if (e.status === 'none') c.diffBody.append(note('This hub has no diff endpoint, so only the file names are known.'), names.length ? plainList(names) : null);
      else c.diffBody.append(note(d && d.note ? `No diff: ${d.note}` : 'git found no changes for these files.'), names.length ? plainList(names) : null);
    }

    /* ----- checks painting ----- */
    function paintChecks(t) {
      const run = t.runId ? state.runs.get(t.runId) : null;
      const shell = run ? run.nodes.filter((n) => n.output && n.output.check) : [];
      const items = R.parseChecks(t.description);
      setHidden(c.checksSec, !shell.length && !items.length);
      const done = items.filter((x) => ticks.has(x)).length;
      c.checksCount.textContent = items.length ? `· ${done}/${items.length} ticked` : (shell.length ? `· ${shell.length} from ${run.id}` : '');
      const rsig = JSON.stringify(shell.map((n) => [n.nodeId, n.state, n.output.check]));
      if (c.runChecks.__sig !== rsig) {
        c.runChecks.__sig = rsig;
        c.runChecks.textContent = '';
        for (const n of shell) {
          const ck = n.output.check;
          const passed = ck.passed !== undefined ? !!ck.passed : n.state === 'ok';
          const out = [ck.stdout, ck.stderr].filter(Boolean).join('\n').trim();
          const sum = h('summary', { class: 'rv-check-sum' },
            h('span', { class: `rv-check-mark ${passed ? 'ok' : 'bad'}`, 'aria-label': passed ? 'Passed' : 'Failed' }, icon(passed ? 'checkCircle' : 'warning', 15)),
            h('span', { class: 'rv-check-name mono' }, n.nodeId),
            h('span', { class: 'rv-check-res mono' }, ck.timedOut ? 'timed out' : passed ? 'passed' : `failed${ck.exitCode != null ? ` · exit ${ck.exitCode}` : ''}`));
          c.runChecks.append(h('li', { class: 'rv-check-run' }, out ? h('details', {}, sum, h('pre', { class: 'rv-check-out mono' }, out.length > 4000 ? '…' + out.slice(-4000) : out)) : h('div', {}, sum)));
        }
      }
      const tsig = items.join('\n');
      if (c.ticks.__sig !== tsig) {
        c.ticks.__sig = tsig;
        c.ticks.textContent = '';
        items.forEach((text, i) => {
          const box = h('input', { type: 'checkbox', id: `rv-tick-${id}-${i}` });
          box.checked = ticks.has(text);
          box.addEventListener('change', () => {
            if (box.checked) ticks.add(text); else ticks.delete(text);
            R.saveTicks(id, ticks);
            const tt = task();
            if (tt) paintChecks(tt);
          });
          c.ticks.append(h('li', { class: 'rv-tick' }, h('label', { for: box.id }, box, h('span', {}, text))));
        });
      }
      for (const li of c.ticks.children) {
        const cb = li.querySelector('input');
        const text = items[Array.prototype.indexOf.call(c.ticks.children, li)];
        if (cb && cb.checked !== ticks.has(text)) cb.checked = ticks.has(text);
        setClass(li, 'done', ticks.has(text));
      }
    }

    /* ----- composer (Request changes) ----- */
    function ensureComposer() {
      if (composer) return composer;
      const ta = h('textarea', { class: 'rv-ta', rows: '4', 'aria-label': 'What should the agent change?', placeholder: 'What should change?', spellcheck: 'true' });
      ta.value = R.CHANGE_TEMPLATE;
      bindDraft(ta, `review:${id}`, { base: R.CHANGE_TEMPLATE });
      const ed = codeEditor(ta, { block: true, className: 'rv-code', view: (v, st) => blockView(v, st, 'what should change?', 'changes') });
      const tray = createAttachTray({ onChange: () => paintComposer() });
      const chips = h('div', { class: 'rv-chips', role: 'group', 'aria-label': 'Quick additions' },
        R.CHANGE_CHIPS.map((chip) => h('button', { class: 'rv-chip', type: 'button', onclick: () => { ta.value = R.withChip(ta.value, chip); ta.dispatchEvent(new Event('input', { bubbles: true })); ed.sync(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, icon('plus', 12), chip)));
      const attach = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Attach files', title: 'Attach files (or drop / paste)', onclick: () => binding.pick() }, icon('paperclip', 16));
      const send = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => sendChanges() }, icon('send', 14), h('span', { class: 'rv-send-l' }, 'Send to agent'));
      const cancel = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => toggleComposer(false) }, 'Cancel');
      const title = h('div', { class: 'rv-comp-title' }, icon('note', 14), h('span', { class: 'rv-comp-label' }, 'Request changes'));
      const hint = h('div', { class: 'rv-hint mono' }, '⌘↵ send · Esc close · the note starts with “!” so it always reaches the agent');
      const box = h('div', { class: 'rv-composer' }, title, chips, ed.el, tray.el, h('div', { class: 'rv-comp-row' }, attach, hint, h('span', { class: 'spacer' }), cancel, send));
      const binding = bindAttachInput({ box, ta, tray });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); toggleComposer(false); c.request.focus(); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); sendChanges(); }
      });
      c.composerSlot.append(box);
      composer = { ta, ed, tray, binding, send, box, title };
      return composer;
    }
    function paintComposer() {
      if (!composer) return;
      const t = task();
      const gate = t && sel.gateOfTask(t);
      composer.title.lastChild.textContent = gate ? 'Reject the approval, with a comment' : 'Request changes';
      composer.send.lastChild.textContent = gate ? 'Reject' : 'Send to agent';
      composer.send.disabled = !!composer.tray.busy;
    }
    function toggleComposer(force) {
      const want = force != null ? force : c.composerSlot.hidden;
      if (want && !task()) return;
      if (want) ensureComposer();
      setHidden(c.composerSlot, !want);
      c.request.setAttribute('aria-expanded', String(want));
      setClass(c.request, 'on', want);
      if (want) {
        paintComposer();
        composer.ed.sync();
        composer.ta.focus();
        composer.ta.setSelectionRange(composer.ta.value.length, composer.ta.value.length);
        if (typeof c.foot.scrollIntoView === 'function') { try { c.foot.scrollIntoView({ block: 'nearest' }); } catch { /* old engines */ } }
      }
    }
    async function sendChanges() {
      const t = task();
      if (!t || !composer) return;
      const text = composer.ta.value;
      if (!R.hasChangeText(text) && !composer.tray.count) { toast('Write what should change first', { kind: 'error' }); composer.ta.focus(); return; }
      if (composer.tray.busy) { toast('Still uploading — send again in a moment. Your text is kept.'); return; }
      const gate = sel.gateOfTask(t);
      const next = nextAfter(id);
      if (gate) {
        const clean = text.replace(/^\s*Please change:\s*/i, '').replace(/^\s*-\s*/gm, '').trim();
        const run = await decideGate(gate.run.id, gate.node.nodeId, 'reject', clean);
        if (!run) return;
      } else {
        const taken = composer.tray.take();
        const atts = attsOf(taken);
        const made = await addNote({ kind: 'task', id }, R.changeNoteText(text), { execute: true, attachments: atts });
        if (!made) { composer.tray.restore(taken); return; } // addNote toasted the reason (e.g. no live session); the text stays
        toast(made.state === 'queued' || made.state === 'sending' ? `Changes sent to the agent for ${id}` : `Changes noted for ${id}`, { kind: 'success' });
      }
      composer.ta.value = R.CHANGE_TEMPLATE;
      clearDraft(`review:${id}`);
      composer.ed.sync();
      toggleComposer(false);
      R.markReviewed(id);
      renderToday();
      if (next) select(next);
    }

    /* ----- update ----- */
    function update() {
      const t = task();
      if (!t) return;
      // header
      setText(c.id, t.id);
      const st = STATUS_META[t.status] || { label: t.status };
      c.pill.firstChild.className = `sdot st-${t.status}`;
      setText(c.pill.lastChild, st.label);
      setText(c.title, t.title);
      const run = t.runId ? state.runs.get(t.runId) : null;
      setHidden(c.run, !t.runId);
      if (t.runId) { setText(c.run, `${t.runId} · ${t.nodeId || 'run'}`); c.run.title = run ? `Open ${t.runId} on the canvas` : t.runId; c.run.disabled = !run; }
      const agent = sel.agentOfTask(t);
      const msig = `${agent ? agent.id + agent.model + agent.status : ''}|${t.tokens}|${state.ui.projectId === 'all' ? t.projectId : ''}|${state.projects.size}`;
      if (c.meta.__sig !== msig) {
        c.meta.__sig = msig;
        c.meta.textContent = '';
        if (agent) c.meta.append(h('span', { class: 'rv-agent mono' }, agentLabel(agent)), modelBadge(agent.model));
        if (state.ui.projectId === 'all' && state.projects.size > 1) c.meta.append(h('span', { class: 'rv-proj' }, icon('folder', 13), sel.projectName(t.projectId)));
        const gate = sel.gateOfTask(t);
        if (gate) c.meta.append(h('span', { class: 'badge badge-accent' }, 'Approval gate'));
      }
      const wait = c.meta.querySelector('.rv-waiting') || c.meta.appendChild(h('span', { class: 'rv-waiting mono' }));
      setText(wait, `In review ${fmtWait(Date.now() - R.reviewSince(t))}`);
      const rep = reportOf(t);
      setHidden(c.report, !rep);
      if (c.reportBody.__t !== rep) { c.reportBody.__t = rep; c.reportBody.textContent = rep; }

      // recap
      const r = t.recap;
      const rsig = JSON.stringify(r);
      if (c.recapBody.__sig !== rsig) {
        c.recapBody.__sig = rsig;
        c.recapBody.textContent = '';
        if (!r) c.recapBody.append(h('p', { class: 'dim' }, 'No recap yet. It appears when the agent’s work has been summarised.'));
        else {
          const row = (label, text) => h('div', { class: 'rv-recap-row' }, h('div', { class: 'recap-label' }, label), h('p', { class: 'rv-recap-text' }, text || '—'));
          c.recapBody.append(row('What', r.what), row('How', r.how), row('Learned', r.learned),
            r.concepts && r.concepts.length ? h('div', { class: 'tags rv-tags' }, r.concepts.map((cn) => h('button', { class: 'tag', type: 'button', title: 'See this concept in Learn', onclick: () => navigate('learn', [], { concept: cn }) }, icon('tag', 12), cn))) : null);
        }
      }

      if (taskHasFiles(t)) ensureDiff(t);
      paintDiff();
      paintChecks(t);

      // actions
      const live = t.status === 'review' && !t.__pending;
      c.approve.disabled = !live; c.later.disabled = !live; c.request.disabled = !live;
      const i = queue.findIndex((x) => x.id === id);
      c.pos.textContent = i >= 0 ? `${i + 1} of ${queue.length}` : '';
      c.prev.disabled = i <= 0; c.next.disabled = i < 0 || i >= queue.length - 1;
      paintComposer();
    }

    const offDiff = onDiff((tid) => { if (tid === id && alive) paintDiff(); });
    if (!fetchedReports.has(id)) {
      fetchedReports.add(id);
      api.task(id).then((res) => { if (res && Array.isArray(res.activity)) ingestActivity(res.activity); }).catch(() => fetchedReports.delete(id));
    }
    update();

    return {
      id, el, update,
      currentFile: () => { const f = curFile(); return f ? relOf(f) : null; },
      goFile,
      toggleComposer,
      composerOpen: () => !c.composerSlot.hidden,
      destroy() {
        offDiff();
        if (composer) { composer.ed.destroy(); composer.binding.destroy(); composer.tray.destroy(); }
        el.remove();
      },
    };
  }

  /* ---------- help ---------- */
  function toggleHelp(force) {
    helpOpen = force != null ? force : !helpOpen;
    setHidden(help, !helpOpen);
    if (helpOpen) { const b = help.querySelector('button'); if (b) b.focus(); }
  }

  /* ---------- render ---------- */
  function renderToday() {
    const n = R.reviewedToday();
    setText(todayEl, `Reviewed today: ${n}`);
  }
  function render() {
    if (!alive) return;
    queue = R.reviewQueue(order);
    const id = effectiveId();
    selectedId = id;
    setText(count, queue.length ? String(queue.length) : '');
    segOld.setAttribute('aria-checked', String(order === 'oldest')); setClass(segOld, 'on', order === 'oldest');
    segNew.setAttribute('aria-checked', String(order === 'newest')); setClass(segNew, 'on', order === 'newest');
    renderToday();
    reconcile(list, queue, (t) => t.id, makeRow, updateRow);
    lastIds = queue.map((t) => t.id);

    const empty = state.ready && queue.length === 0;
    setHidden(emptyEl, !empty);
    setHidden(slot, empty || !id);
    if (empty) {
      if (pane) { pane.destroy(); pane = null; }
      emptyEl.textContent = '';
      emptyEl.append(emptyState({
        iconName: 'checkCircle', title: 'Nothing to review: nice.',
        body: `${R.reviewedToday() ? `You reviewed ${R.reviewedToday()} today. ` : ''}Tasks land here when an agent finishes and moves them to Review.`,
        action: { label: 'Go to Board', onClick: () => navigate('board') },
      }));
      return;
    }
    if (!id) return;
    if (!pane || pane.id !== id) {
      if (pane) pane.destroy();
      pane = createPane(id);
      slot.textContent = '';
      slot.append(pane.el);
    } else pane.update();
  }

  /* ---------- keyboard ---------- */
  function onKey(e) {
    if (!alive || e.metaKey || e.ctrlKey || e.altKey) return;
    const tg = e.target;
    if (tg && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable)) return;
    if (document.querySelector('.spotlight-scrim:not([hidden])')) return;
    if (tg && tg.closest && tg.closest('.dock-panel, .menu')) return;
    if (helpOpen) {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopPropagation(); toggleHelp(false); }
      return;
    }
    const inCode = !!(tg && tg.closest && tg.closest('.dp-scroll, .dp-pane, .dp-tabs, .rv-checks, .rv-report'));
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.shiftKey && k !== '?') return;
    let handled = true;
    if (k === 'j' || (k === 'ArrowDown' && !inCode)) skip(1);
    else if (k === 'k' || (k === 'ArrowUp' && !inCode)) skip(-1);
    else if (k === 'a') approve();
    else if (k === 'r') { if (pane) pane.toggleComposer(true); }
    else if (k === 'l') later();
    else if (k === '?') toggleHelp(true);
    else if (k === ']') { if (pane) pane.goFile(1); }
    else if (k === '[') { if (pane) pane.goFile(-1); }
    else if (k === 'Escape') { if (pane && pane.composerOpen()) pane.toggleComposer(false); else handled = false; }
    else if (k === 'Enter') {
      const btn = tg && tg.closest ? tg.closest('button, a, summary, input, label') : null;
      if (btn && !btn.classList.contains('rv-row')) return; // Enter on a control does that control's job
      openCurrentDiff();
    } else handled = false;
    if (handled) e.preventDefault();
  }
  document.addEventListener('keydown', onKey, true); // capture: Esc must close the help before the Dock's Esc handler sees it

  // the wait labels tick over once a minute
  const clock = setInterval(() => { if (alive) render(); }, 60000);

  render();

  return {
    watch: ['task', 'agent', 'note', 'run', 'project', 'ui', 'ready', 'session', 'activity'],
    update: render,
    setRoute(r) {
      const id = r.args && r.args[0];
      if (id && id !== selectedId) { selectedId = id; render(); }
    },
    destroy() {
      alive = false;
      clearInterval(clock);
      document.removeEventListener('keydown', onKey, true);
      if (pane) pane.destroy();
      root.remove();
    },
  };
}
