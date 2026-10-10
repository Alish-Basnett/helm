// wf/results.js — shared renderers for a run node's outcome (inspector, run panel). Everything from the engine or a
// model ends up in text nodes; nothing here parses markup.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { fmtElapsed, fmtUsdSmall, fmtAgo, truncate } from '../format.js';
import { STATE_LABEL } from './canvas.js';
import { renderMarkdown } from '../markdown.js';
import { sel } from '../store.js';

const block = (title, ...kids) => h('section', { class: 'wf-res' }, h('h4', { class: 'wf-res-h' }, title), ...kids);
const pre = (text, cls = '') => h('pre', { class: `wf-pre mono ${cls}` }, String(text));

/** Recent tool activity of the agent that ran this node (the live "log"), newest last. */
export function activityLines(taskId, limit = 24) {
  if (!taskId) return [];
  const t = sel.activityRows((a) => a.taskId === taskId && (a.kind === 'tool' || a.kind === 'status')).slice(-limit);
  return t;
}

export function stepRows(steps) {
  return (steps || []).map((s) => {
    const dur = s.claimedAt && s.doneAt ? fmtElapsed(s.doneAt - s.claimedAt) : s.claimedAt ? 'running' : 'queued';
    return h('li', { class: `wf-attempt st-${s.state}` },
      h('span', { class: 'mono wf-attempt-n' }, `#${s.attempt}`),
      h('span', { class: 'wf-attempt-state' }, s.state === 'done' ? 'finished' : s.state),
      h('span', { class: 'mono dim' }, dur),
      h('span', { class: 'mono dim wf-attempt-sess', title: s.sessionId }, truncate(s.sessionId, 12)),
      s.error ? h('span', { class: 'wf-attempt-err' }, truncate(s.error, 80)) : null);
  });
}

/** The outcome of one run node as a stack of small sections. `steps` are this node's Step rows (any state). */
export function nodeResult(rn, node, steps) {
  const o = rn.output || {};
  const out = [];
  if (rn.error) out.push(block('Error', h('div', { class: 'wf-res-err' }, icon('warning', 14), h('span', {}, rn.error))));
  if (o.gate) {
    out.push(block('Gate',
      h('p', { class: 'wf-res-p' }, o.gate.message),
      o.gate.files && o.gate.files.length ? h('ul', { class: 'wf-files mono' }, o.gate.files.slice(0, 40).map((f) => h('li', {}, f))) : null));
  }
  if (typeof o.approved === 'boolean') out.push(block('Decision', h('p', { class: 'wf-res-p' }, o.approved ? 'Approved' : 'Rejected', o.comment ? ` — ${o.comment}` : '')));
  if (o.verdict) out.push(block('Verdict', h('span', { class: `wf-verdict ${o.verdict}` }, o.verdict === 'pass' ? 'Pass' : 'Changes requested')));
  if (o.findings) out.push(block('Findings', h('div', { class: 'wf-md' }, renderMarkdown(o.findings))));
  else if (o.text && node && node.type !== 'shell') out.push(block('Output', h('div', { class: 'wf-md' }, renderMarkdown(truncate(o.text, 4000)))));
  if (o.check) {
    out.push(block(`Check · exit ${o.check.exitCode ?? '?'}${o.check.passed ? ' · passed' : ' · failed'}`,
      o.check.stdout ? pre(o.check.stdout) : null, o.check.stderr ? pre(o.check.stderr, 'err') : null));
  } else if (o.text && node && node.type === 'shell') out.push(block('Output', pre(o.text)));
  if (o.filesChanged && o.filesChanged.length) out.push(block(`Files changed (${o.filesChanged.length})`, h('ul', { class: 'wf-files mono' }, o.filesChanged.slice(0, 40).map((f) => h('li', {}, f)))));
  const act = activityLines(rn.taskId);
  if (act.length) {
    out.push(block('Agent log', h('ol', { class: 'wf-log mono' }, act.map((a) => h('li', { class: a.ok === false ? 'bad' : '' }, h('span', { class: 'dim' }, fmtAgo(a.at)), ' ', truncate(a.summary, 140))))));
  }
  if (steps && steps.length) out.push(block('Attempts', h('ul', { class: 'wf-attempts' }, stepRows(steps))));
  if (rn.costUsd > 0) out.push(block('Cost', h('span', { class: 'mono' }, fmtUsdSmall(rn.costUsd))));
  if (!out.length) out.push(h('p', { class: 'wf-res-empty dim' }, rn.state === 'pending' ? 'Waiting for earlier steps.' : `${STATE_LABEL[rn.state] || rn.state}. Nothing recorded yet.`));
  return h('div', { class: 'wf-results' }, out);
}
