// wf/runpanel.js — the run timeline in the Dock: status, cost and elapsed ticking, pause / resume / abort, and one row per
// step (state, time, cost, attempts) that opens into its output, check log and agent log. Gates show Approve / Reject here too.
import { h, setText, setHidden, bus, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, subscribe } from '../store.js';
import { panelClose } from '../dock.js';
import { setQuery } from '../router.js';
import { fmtElapsed, fmtUsdSmall, truncate } from '../format.js';
import { decideGate, controlRun, controlNode } from '../actions.js';
import { STATE_LABEL } from './canvas.js';
import { nodeResult } from './results.js';
import { ensureDetail, detailOf, onDetail } from './rundata.js';
import { labelsOf as runLabels, typesOf as runTypes, onLabels, hasGraph } from './labels.js';

export const RUN_LABEL = { running: 'Running', waiting: 'Needs you', paused: 'Paused', done: 'Done', failed: 'Failed', aborted: 'Aborted' };
const LIVE = new Set(['running', 'waiting', 'paused']);

export function createRunPanel(dock) {
  const panel = dock.register('run', {
    order: 0.7, width: 430, label: 'Run', icon: 'play', ariaLabel: 'Workflow run',
    onClose: () => setQuery({ tl: '0' }),
  });
  let runId = null;
  let visible = false;
  let sig = '';
  const open = new Set();
  const gateDrafts = new Map();

  const title = h('h2', { class: 'talk-title wfp-title' }, icon('play', 16), h('span', { class: 'wfp-title-t' }, 'Run'));
  const pill = h('span', { class: 'wfp-pill' });
  const sub = h('div', { class: 'wfp-sub' });
  const costEl = h('span', { class: 'wfp-cost mono' });
  const timeEl = h('span', { class: 'wfp-time mono' });
  const stats = h('div', { class: 'wfp-stats' }, pill, h('span', { class: 'spacer' }), costEl, timeEl);
  const ctl = h('div', { class: 'wfp-ctl' });
  const head = h('header', { class: 'sheet-head wfp-head' },
    h('div', { class: 'sheet-head-top' }, title, h('span', { class: 'spacer' }), panelClose(panel, 'Close timeline')), sub, stats, ctl);
  const err = h('div', { class: 'wfp-err', hidden: true });
  const list = h('ol', { class: 'wfp-list', 'aria-label': 'Steps' });
  const body = h('div', { class: 'wfp-body' }, err, list);
  panel.el.append(head, body);
  startTicker();

  const run = () => (runId ? state.runs.get(runId) || null : null);
  const workflowOf = (r) => state.workflows.get(r.workflowId);

  function renderHead(r) {
    const wf = workflowOf(r);
    setText(title.querySelector('.wfp-title-t'), `Run ${r.id}`);
    setText(sub, `${wf ? wf.name : r.workflowId} · v${r.version}`);
    pill.className = `wfp-pill st-${r.status}`;
    setText(pill, RUN_LABEL[r.status] || r.status);
    const prev = costEl.__cost;
    setText(costEl, fmtUsdSmall(r.costUsd || 0) + (r.budgetUsd ? ` / ${fmtUsdSmall(r.budgetUsd)}` : ''));
    if (prev != null && prev !== r.costUsd) { costEl.classList.remove('bump'); void costEl.offsetWidth; costEl.classList.add('bump'); }
    costEl.__cost = r.costUsd;
    if (LIVE.has(r.status)) { timeEl.setAttribute('data-since', r.startedAt); setText(timeEl, fmtElapsed(Date.now() - r.startedAt)); }
    else { timeEl.removeAttribute('data-since'); setText(timeEl, fmtElapsed((r.endedAt || r.startedAt) - r.startedAt)); }
    ctl.textContent = '';
    if (r.status === 'running' || r.status === 'waiting') ctl.append(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => controlRun(r.id, 'pause') }, icon('pause', 14), 'Pause'));
    if (r.status === 'paused') ctl.append(h('button', { class: 'btn btn-accent btn-sm', type: 'button', onclick: () => controlRun(r.id, 'resume') }, icon('play', 14), 'Resume'));
    if (LIVE.has(r.status)) ctl.append(h('button', { class: 'btn btn-quiet btn-sm danger-text', type: 'button', onclick: () => controlRun(r.id, 'abort') }, icon('stop', 14), 'Abort'));
    ctl.append(h('a', { class: 'btn btn-quiet btn-sm', href: `#/workflows/${encodeURIComponent(r.workflowId)}?run=${encodeURIComponent(r.id)}` }, icon('workflow', 14), 'On canvas'));
    setHidden(err, !r.error);
    if (r.error) setText(err, r.error);
  }

  function rowFor(r, rn, labels, types) {
    const label = labels.get(rn.nodeId) || rn.nodeId;
    const isOpen = open.has(rn.nodeId);
    const det = detailOf(r.id);
    const steps = det ? det.steps.filter((s) => s.nodeId === rn.nodeId) : [];
    const dur = rn.startedAt ? (rn.endedAt ? fmtElapsed(rn.endedAt - rn.startedAt) : null) : null;
    const head2 = h('button', { class: 'wfp-row-h', type: 'button', 'aria-expanded': String(isOpen), onclick: () => {
      if (open.has(rn.nodeId)) open.delete(rn.nodeId); else open.add(rn.nodeId);
      bus.emit('wf-focus-node', { runId: r.id, nodeId: rn.nodeId });
      sig = ''; render();
    } },
    h('span', { class: `wf-n-dot st-${rn.state}`, 'aria-hidden': 'true' }),
    h('span', { class: 'wfp-row-l' }, label),
    rn.attempt > 1 ? h('span', { class: 'wfp-att mono', title: `Attempt ${rn.attempt}` }, `×${rn.attempt}`) : null,
    h('span', { class: 'spacer' }),
    rn.state === 'running' || rn.state === 'queued' || rn.state === 'waiting_gate'
      ? h('span', { class: 'mono dim', 'data-since': rn.startedAt || '' }, rn.startedAt ? fmtElapsed(Date.now() - rn.startedAt) : '')
      : dur ? h('span', { class: 'mono dim' }, dur) : null,
    rn.costUsd > 0 ? h('span', { class: 'mono wfp-row-cost' }, fmtUsdSmall(rn.costUsd)) : null,
    h('span', { class: `wfp-row-st st-${rn.state}` }, STATE_LABEL[rn.state] || rn.state),
    icon('chevronDown', 13, 'wfp-chev'));
    const li = h('li', { class: `wfp-row st-${rn.state}${isOpen ? ' open' : ''}`, 'data-node': rn.nodeId }, head2);
    // gates are always actionable from the list
    if (rn.state === 'waiting_gate' && LIVE.has(r.status)) {
      const key = `${r.id}:${rn.nodeId}`;
      const comment = h('input', { class: 'wf-input', type: 'text', placeholder: 'Comment (optional)', maxlength: '1000', value: gateDrafts.get(key) || '', 'aria-label': 'Comment for the decision' });
      comment.addEventListener('input', () => gateDrafts.set(key, comment.value));
      const go = (d) => { gateDrafts.delete(key); decideGate(r.id, rn.nodeId, d, comment.value); };
      comment.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go('approve'); } });
      li.append(h('div', { class: 'wfp-gate' },
        h('p', { class: 'wf-res-p' }, (rn.output && rn.output.gate && rn.output.gate.message) || 'Waiting for your decision.'),
        comment,
        h('div', { class: 'wf-f-row' },
          h('button', { class: 'btn btn-sm wf-approve', type: 'button', onclick: () => go('approve') }, icon('check', 14), 'Approve'),
          h('button', { class: 'btn btn-sm wf-reject', type: 'button', onclick: () => go('reject') }, icon('close', 13), 'Reject'))));
    }
    if ((rn.state === 'failed' || rn.state === 'abandoned') && r.status !== 'aborted' && r.status !== 'done') {
      li.append(h('div', { class: 'wf-f-row wfp-fix' },
        h('button', { class: 'btn btn-accent btn-sm', type: 'button', onclick: () => controlNode(r.id, rn.nodeId, 'retry') }, icon('retry', 14), 'Retry'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => controlNode(r.id, rn.nodeId, 'skip') }, icon('skip', 14), 'Skip')));
    }
    if (isOpen) li.append(h('div', { class: 'wfp-detail' }, nodeResult(rn, { type: types.get(rn.nodeId) }, steps)));
    return li;
  }

  function render() {
    const r = run();
    if (!r) { list.textContent = ''; setText(sub, runId ? 'Loading…' : ''); return; }
    ensureDetail(r);
    const det = detailOf(r.id);
    const s = `${r.id}|${r.status}|${r.costUsd}|${r.error || ''}|${r.nodes.map((n) => `${n.nodeId}:${n.state}:${n.attempt}:${n.costUsd}`).join(',')}|${[...open].join(',')}|${det ? det.steps.length : -1}|${hasGraph(r.id) ? 1 : 0}`;
    if (s === sig) return;
    sig = s;
    renderHead(r);
    const labels = runLabels(r.id);
    const types = runTypes(r.id);
    list.textContent = '';
    for (const rn of r.nodes) list.append(rowFor(r, rn, labels, types));
  }

  const off1 = subscribe((changed) => { if (runId && (changed.has('run') || changed.has('activity') || changed.has('workflow') || changed.has('ready'))) render(); });
  const off2 = onDetail((id) => { if (id === runId) { sig = ''; render(); } });
  const off3 = onLabels((id) => { if (id === runId) { sig = ''; render(); } });

  return {
    /** runId = the run on the canvas (or null); show = whether its timeline panel should be open. */
    show(id, want) {
      const changed = id !== runId;
      runId = id;
      if (changed) { open.clear(); sig = ''; }
      const on = !!id && want !== false;
      if (on) { if (!panel.isOpen) dock.open('run', { focus: false }); render(); }
      else if (panel.isOpen) dock.close('run');
      visible = on;
    },
    get runId() { return runId; },
    get visible() { return visible; },
    destroy() { off1(); off2(); off3(); },
  };
}
