// explain.js — "Explain deeper" control: button, job state (shimmer / failed + Retry), markdown explainer.
// Used in the task sheet's recap block and on Learn recap cards. State comes from task.explainJob + jobs map.
import { h, setText, setHidden, setClass } from './dom.js';
import { icon } from './icons.js';
import { sel } from './store.js';
import { explainTask } from './actions.js';
import { setMarkdown } from './markdown.js';

/** opts.getTask(): Task | null.  Returns { el, update() }. */
export function createExplain(opts) {
  const run = () => { const t = opts.getTask(); if (t) explainTask(t.id); };
  const label = h('span', {}, 'Explain deeper');
  const btn = h('button', { class: 'btn btn-accent btn-sm explain-btn', type: 'button', onclick: run }, icon('sparkle', 14), label);
  const shimmer = h('div', { class: 'job-line', role: 'status', hidden: true }, h('span', { class: 'job-text' }, 'Haiku is writing…'));
  const failMsg = h('span', { class: 'job-fail-msg' });
  const failed = h('div', { class: 'job-failed', role: 'alert', hidden: true },
    icon('warning', 14), failMsg, h('button', { class: 'link-btn', type: 'button', onclick: run }, 'Retry'));
  const body = h('div', { class: 'explainer-body' });
  const wrap = h('div', { class: 'explainer', hidden: true }, h('div', { class: 'explainer-label' }, icon('sparkle', 12), 'Deeper explanation'), body);
  const el = h('div', { class: 'explain', hidden: true }, h('div', { class: 'explain-row' }, btn), shimmer, failed, wrap);

  function update() {
    const t = opts.getTask();
    if (!t) { setHidden(el, true); return; }
    const j = sel.explainJob(t);
    const busy = !!j && (j.state === 'queued' || j.state === 'running');
    const bad = !!j && j.state === 'failed';
    const hasText = !!(t.explainer && t.explainer.trim());
    // show for tasks that have something to explain from
    setHidden(el, !(t.recap || hasText || j));
    btn.disabled = busy;
    setText(label, busy ? 'Explaining…' : hasText ? 'Explain again' : 'Explain deeper');
    setHidden(shimmer, !busy);
    setHidden(failed, !bad || busy);
    if (bad) setText(failMsg, j.error ? `Couldn’t explain: ${j.error}` : 'Couldn’t explain this task.');
    setHidden(wrap, !hasText);
    setClass(wrap, 'stale', busy);
    if (hasText) setMarkdown(body, t.explainer);
  }
  return { el, update }; // hidden until the owner's first update()
}
