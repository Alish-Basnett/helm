// wf/inspector.js — the right-hand pane: per-type forms for the selected step (validated as you type), the connection
// editor, the workflow's inputs and problems, and — while looking at a run — that step's live state and outcome.
import { h, setText } from '../dom.js';
import { icon } from '../icons.js';
import { modelBadge } from '../ui.js';
import { state } from '../store.js';
import { fmtUsdSmall, fmtElapsed, truncate } from '../format.js';
import { TYPE_META, PALETTE, kindsFor, entryOf, modelOf, EDGE_LABEL, isExec, joinArgs } from './graph.js';
export { joinArgs };
import { STATE_LABEL } from './canvas.js';
import { nodeResult } from './results.js';

/* ---------- shell-words: "npm run test -- --grep 'a b'" <-> ['npm','run','test','--','--grep','a b'] ---------- */
export function splitArgs(str) {
  const out = [];
  let cur = '', q = null, has = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < str.length) cur += str[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}
const PARAM_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export function createInspector({ onDeleteSelection, onFocusNode, onNodeAction, onGate, onOpenRun } = {}) {
  const root = h('aside', { class: 'wf-inspector', 'aria-label': 'Inspector' });
  let ctx = null; // { doc, selection, readOnly, issues, run, detail }
  let selfChange = false;
  const gateDrafts = new Map();

  /* ---------------------------------------------------------------- small widgets */
  const field = (label, control, hint, err) => h('label', { class: `wf-f${err ? ' invalid' : ''}` },
    h('span', { class: 'wf-f-l' }, label), control, hint ? h('span', { class: 'wf-f-hint' }, hint) : null, err ? h('span', { class: 'wf-f-err' }, err) : null);
  const row = (...kids) => h('div', { class: 'wf-f-row' }, ...kids);
  const section = (title, ...kids) => h('section', { class: 'wf-i-sec' }, title ? h('h3', { class: 'wf-i-h' }, title) : null, ...kids);

  function edit(fn, key) {
    if (!ctx || ctx.readOnly) return;
    selfChange = true;
    try { ctx.doc.mutate(fn, key); } finally { selfChange = false; }
  }
  const nodeEdit = (id, field2, fn) => edit((g) => fn(g.nodes.find((n) => n.id === id)), `n:${id}:${field2}`);

  function textInput(value, onInput, { placeholder = '', mono = false, invalid = false, maxlength = 200, type = 'text' } = {}) {
    const i = h('input', {
      type, value: value ?? '', placeholder, maxlength: String(maxlength), spellcheck: 'false', autocomplete: 'off',
      class: `wf-input${mono ? ' mono' : ''}`, 'aria-invalid': invalid ? 'true' : null,
    });
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }
  function area(value, onInput, { placeholder = '', rows = 5, mono = false, invalid = false } = {}) {
    const t = h('textarea', { class: `wf-area${mono ? ' mono' : ''}`, rows: String(rows), placeholder, spellcheck: 'false', 'aria-invalid': invalid ? 'true' : null });
    t.value = value ?? '';
    t.addEventListener('input', () => onInput(t.value));
    return t;
  }
  function segmented(options, value, onPick) {
    const wrap = h('div', { class: 'wf-seg', role: 'radiogroup' });
    for (const [v, label] of options) {
      wrap.append(h('button', { class: `wf-seg-b${v === value ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(v === value), onclick: () => onPick(v) }, label));
    }
    return wrap;
  }
  function selectEl(options, value, onPick) {
    const sl = h('select', { class: 'select select-sm wf-select' });
    for (const [v, label] of options) sl.append(h('option', { value: v }, label));
    sl.value = value;
    sl.addEventListener('change', () => onPick(sl.value));
    return sl;
  }
  const check = (label, on, onChange, title) => {
    const c = h('input', { type: 'checkbox' });
    c.checked = !!on;
    c.addEventListener('change', () => onChange(c.checked));
    return h('label', { class: 'wf-check', title: title || '' }, c, h('span', {}, label));
  };

  /* ------------------------------------------------------------------ node form */
  function nodeForm(n) {
    const ro = ctx.readOnly;
    const meta = TYPE_META[n.type];
    const iss = (ctx.issues.get(n.id) || []);
    const entry = entryOf(n);
    const model = modelOf(n);
    const c = n.config || {};
    const head = h('div', { class: 'wf-i-head' },
      h('span', { class: `wf-i-ic t-${meta.tone}` }, icon(meta.icon, 17)),
      h('div', { class: 'wf-i-headt' }, h('strong', {}, entry ? entry.label : n.type), h('span', { class: 'mono dim' }, n.id)),
      model ? modelBadge(model) : null);
    const kids = [head];
    kids.push(field('Name', textInput(n.label, (v) => nodeEdit(n.id, 'label', (x) => { x.label = v; }), { invalid: !n.label.trim() }), 'Shown on the card.'));

    if (n.type === 'agent') {
      kids.push(field('Agent', segmented([['builder', 'Builder · Sonnet'], ['scout', 'Scout · Haiku']], c.agent || 'builder', (v) => nodeEdit(n.id, 'agent', (x) => { x.config.agent = v; }))));
      kids.push(field('Prompt', area(c.prompt, (v) => nodeEdit(n.id, 'prompt', (x) => { x.config.prompt = v; }), { rows: 7, invalid: !String(c.prompt || '').trim(), placeholder: 'What should this agent do?' }),
        'Use {{params.name}} for run inputs and {{inputs.step.text}} for an earlier step’s output.', !String(c.prompt || '').trim() ? 'A prompt is required.' : ''));
      kids.push(field('Working directory', textInput(c.cwd || '', (v) => nodeEdit(n.id, 'cwd', (x) => { if (v) x.config.cwd = v; else delete x.config.cwd; }), { mono: true, placeholder: 'Default: the session’s folder', maxlength: 1000 })));
      kids.push(check('Work in a separate git worktree', c.isolation === 'worktree', (on) => nodeEdit(n.id, 'isolation', (x) => { if (on) x.config.isolation = 'worktree'; else delete x.config.isolation; }), 'Keeps this step’s edits out of your working tree until you merge'));
    } else if (n.type === 'shell') {
      const useScript = c.script !== undefined && c.argv === undefined;
      kids.push(field('Run as', segmented([['argv', 'Command'], ['script', 'Script']], useScript ? 'script' : 'argv', (v) => nodeEdit(n.id, 'mode', (x) => {
        if (v === 'script') { const a = x.config.argv; delete x.config.argv; x.config.script = a ? joinArgs(a) : 'echo hello'; } else { const sc = x.config.script; delete x.config.script; x.config.argv = sc ? splitArgs(sc) : ['npm', 'test']; }
      }))));
      if (useScript) {
        kids.push(field('Script', area(c.script, (v) => nodeEdit(n.id, 'script', (x) => { x.config.script = v; }), { mono: true, rows: 5, invalid: !String(c.script || '').trim() }), 'Runs as sh -c.', !String(c.script || '').trim() ? 'A script is required.' : ''));
      } else {
        kids.push(field('Command', textInput(joinArgs(c.argv), (v) => nodeEdit(n.id, 'argv', (x) => { x.config.argv = splitArgs(v); }), { mono: true, invalid: !(c.argv && c.argv.length), maxlength: 2000 }),
          'Runs directly, with no shell. Quote arguments that contain spaces.', !(c.argv && c.argv.length) ? 'A command is required.' : ''));
      }
      kids.push(field('Working directory', textInput(c.cwd || '', (v) => nodeEdit(n.id, 'cwd', (x) => { if (v) x.config.cwd = v; else delete x.config.cwd; }), { mono: true, placeholder: 'Default: the session’s folder', maxlength: 1000 })));
      kids.push(row(
        field('Time limit (seconds)', textInput(String(Math.round((c.timeoutMs || 30000) / 1000)), (v) => nodeEdit(n.id, 'timeout', (x) => { const s = Math.max(1, Math.min(600, parseInt(v, 10) || 30)); x.config.timeoutMs = s * 1000; }), { type: 'number', maxlength: 4 })),
        field('Passes when', selectEl([['exit0', 'Exit code is 0'], ['regex', 'Output matches']], c.passIf || 'exit0', (v) => nodeEdit(n.id, 'passIf', (x) => { x.config.passIf = v; if (v === 'regex' && !x.config.pattern) x.config.pattern = 'ok'; if (v === 'exit0') delete x.config.pattern; })))));
      if (c.passIf === 'regex') {
        let bad = '';
        try { new RegExp(c.pattern || ''); } catch (e) { bad = 'Not a valid regular expression.'; }
        kids.push(field('Pattern', textInput(c.pattern || '', (v) => nodeEdit(n.id, 'pattern', (x) => { x.config.pattern = v; }), { mono: true, invalid: !!bad || !c.pattern }), 'Tested against stdout and stderr.', bad || (!c.pattern ? 'A pattern is required.' : '')));
      }
      kids.push(h('p', { class: 'wf-note' }, icon('warning', 13), h('span', {}, 'Shell checks run through the session’s process tool, which only exists in the terminal app. In the desktop app the step falls back to a Haiku scout that runs the command for you, which costs a few tokens.')));
    } else if (n.type === 'gate') {
      kids.push(field('Message', area(c.message, (v) => nodeEdit(n.id, 'message', (x) => { x.config.message = v; }), { rows: 4, invalid: !String(c.message || '').trim(), placeholder: 'What should the person check?' }), 'Shown on the gate, in the Inbox and on the Board card.', !String(c.message || '').trim() ? 'A message is required.' : ''));
      kids.push(field('Show', selectEl([['files', 'Files changed'], ['diff', 'Diff of the changes'], ['text', 'Text from earlier steps'], ['none', 'Nothing']], c.show || 'files', (v) => nodeEdit(n.id, 'show', (x) => { x.config.show = v; }))));
      kids.push(h('p', { class: 'wf-note' }, icon('gate', 13), h('span', {}, 'Approving follows the green “approved” connection. Rejecting follows “rejected”; with none, the run stops there.')));
    } else if (n.type === 'review') {
      kids.push(field('Rubric', area(c.rubric, (v) => nodeEdit(n.id, 'rubric', (x) => { x.config.rubric = v; }), { rows: 6, invalid: !String(c.rubric || '').trim(), placeholder: 'What should Opus judge the work against?' }), 'Opus replies with findings and a pass or changes verdict. “Changes” counts as a failure.', !String(c.rubric || '').trim() ? 'A rubric is required.' : ''));
      const inputs = c.inputs || ['text', 'files'];
      const toggle = (k, on) => nodeEdit(n.id, 'inputs', (x) => { const s2 = new Set(x.config.inputs || ['text', 'files']); if (on) s2.add(k); else s2.delete(k); x.config.inputs = [...s2]; });
      kids.push(field('Opus sees', h('div', { class: 'wf-checks' },
        check('Earlier steps’ output', inputs.includes('text'), (on) => toggle('text', on)),
        check('Files changed', inputs.includes('files'), (on) => toggle('files', on)),
        check('Test results', inputs.includes('check'), (on) => toggle('check', on)))));
    } else if (n.type === 'note') {
      kids.push(field('Note', area(c.text, (v) => nodeEdit(n.id, 'text', (x) => { x.config.text = v; }), { rows: 8, placeholder: 'Markdown: **bold**, `code`, lists' }), 'Notes document the flow. They are never run.'));
    }

    if (isExec(n) && n.type !== 'gate') {
      const r = n.retry || { max: 0, backoffMs: 0 };
      kids.push(section('If it fails',
        row(
          field('Retry up to', selectEl([0, 1, 2, 3, 4, 5].map((i) => [String(i), i === 0 ? 'Never' : `${i} time${i === 1 ? '' : 's'}`]), String(r.max), (v) => nodeEdit(n.id, 'retry', (x) => { x.retry = { ...(x.retry || { backoffMs: 0 }), max: Number(v) }; }))),
          field('Wait between (s)', textInput(String(Math.round((r.backoffMs || 0) / 1000)), (v) => nodeEdit(n.id, 'backoff', (x) => { x.retry = { ...(x.retry || { max: 0 }), backoffMs: Math.max(0, Math.min(600, parseInt(v, 10) || 0)) * 1000 }; }), { type: 'number', maxlength: 4 }))),
        h('p', { class: 'wf-f-hint' }, 'After the last retry the step follows its “fail” connection. With none, the run stops.')));
    }
    if (isExec(n) && n.type !== 'gate') {
      const live = Array.from(state.sessions.values()).filter((x) => x.status !== 'ended');
      const opts = [['', 'The run’s session (default)'], ...live.map((x) => [x.id, `${truncate(x.title || x.cwd || x.id, 36)} · ${x.status}`])];
      if (n.sessionId && !live.some((x) => x.id === n.sessionId)) opts.push([n.sessionId, `${truncate(n.sessionId, 18)} (not running)`]);
      kids.push(section('Where it runs',
        field('Session', selectEl(opts, n.sessionId || '', (v) => nodeEdit(n.id, 'session', (x) => { if (v) x.sessionId = v; else delete x.sessionId; }))),
        field('Time limit (minutes)', textInput(n.timeoutMs ? String(Math.round(n.timeoutMs / 60000)) : '', (v) => nodeEdit(n.id, 'nodetimeout', (x) => { const m = parseInt(v, 10); if (m > 0) x.timeoutMs = Math.min(360, m) * 60000; else delete x.timeoutMs; }), { type: 'number', placeholder: 'Default: 60', maxlength: 4 }))));
    }
    if (iss.length) kids.push(section('Problems', h('ul', { class: 'wf-problems' }, iss.map((m) => h('li', {}, icon('warning', 13), h('span', {}, m))))));
    if (!ro) kids.push(h('div', { class: 'wf-i-foot' }, h('button', { class: 'btn btn-quiet btn-sm danger-text', type: 'button', onclick: () => onDeleteSelection && onDeleteSelection() }, icon('trash', 14), 'Delete step')));
    const form = h('div', { class: 'wf-form' }, kids);
    if (ro) for (const el of form.querySelectorAll('input,textarea,select,button.wf-seg-b')) el.disabled = true;
    return form;
  }

  /* ---------------------------------------------------------- run view of a node */
  function runNode(n) {
    const run = ctx.run;
    const rn = run.nodes.find((x) => x.nodeId === n.id);
    const meta = TYPE_META[n.type];
    const entry = entryOf(n);
    const kids = [h('div', { class: 'wf-i-head' },
      h('span', { class: `wf-i-ic t-${meta.tone}` }, icon(meta.icon, 17)),
      h('div', { class: 'wf-i-headt' }, h('strong', {}, n.label), h('span', { class: 'mono dim' }, `${n.id} · ${entry ? entry.label : n.type}`)),
      modelOf(n) ? modelBadge(modelOf(n)) : null)];
    if (!rn) {
      kids.push(h('p', { class: 'wf-res-empty dim' }, 'Notes are never run.'));
      return h('div', { class: 'wf-form' }, kids);
    }
    kids.push(h('div', { class: `wf-i-state st-${rn.state}` }, h('span', { class: 'wf-n-dot' }), h('strong', {}, STATE_LABEL[rn.state] || rn.state),
      rn.attempt > 1 ? h('span', { class: 'mono dim' }, `attempt ${rn.attempt}`) : null, h('span', { class: 'spacer' }),
      rn.costUsd > 0 ? h('span', { class: 'mono' }, fmtUsdSmall(rn.costUsd)) : null,
      rn.startedAt && rn.endedAt ? h('span', { class: 'mono dim' }, fmtElapsed(rn.endedAt - rn.startedAt)) : null));
    const live = !['done', 'failed', 'aborted'].includes(run.status);
    if (rn.state === 'waiting_gate' && live) {
      const key = `${run.id}:${n.id}`;
      const comment = h('input', { class: 'wf-input', type: 'text', placeholder: 'Comment (optional)', value: gateDrafts.get(key) || '', maxlength: '1000', 'aria-label': 'Comment for the decision' });
      comment.addEventListener('input', () => gateDrafts.set(key, comment.value));
      const go = (d) => { onGate && onGate(run.id, n.id, d, comment.value.trim()); gateDrafts.delete(key); };
      comment.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go('approve'); } });
      kids.push(section('Your decision', comment, h('div', { class: 'wf-f-row' },
        h('button', { class: 'btn btn-sm wf-approve', type: 'button', onclick: () => go('approve') }, icon('check', 14), 'Approve'),
        h('button', { class: 'btn btn-sm wf-reject', type: 'button', onclick: () => go('reject') }, icon('close', 13), 'Reject'))));
    }
    if ((rn.state === 'failed' || rn.state === 'abandoned') && run.status !== 'aborted' && run.status !== 'done') {
      kids.push(h('div', { class: 'wf-f-row' },
        h('button', { class: 'btn btn-accent btn-sm', type: 'button', onclick: () => onNodeAction && onNodeAction('retry', n.id) }, icon('retry', 14), 'Retry'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => onNodeAction && onNodeAction('skip', n.id) }, icon('skip', 14), 'Skip')));
    }
    const steps = ctx.detail && ctx.detail.run && ctx.detail.run.id === run.id ? ctx.detail.steps.filter((s) => s.nodeId === n.id) : [];
    kids.push(nodeResult(rn, n, steps));
    if (rn.taskId) kids.push(h('div', { class: 'wf-i-foot' }, h('a', { class: 'btn btn-quiet btn-sm', href: `#/board?task=${encodeURIComponent(rn.taskId)}` }, icon('board', 14), `Open card ${rn.taskId}`)));
    return h('div', { class: 'wf-form' }, kids);
  }

  /* ---------------------------------------------------------------- edge form */
  function edgeForm(e) {
    const from = ctx.doc.node(e.from), to = ctx.doc.node(e.to);
    const kids = [h('div', { class: 'wf-i-head' }, h('span', { class: `wf-i-ic k-${e.when}` }, icon('arrowRight', 17)),
      h('div', { class: 'wf-i-headt' }, h('strong', {}, 'Connection'), h('span', { class: 'mono dim' }, `${e.from} → ${e.to}`)))];
    kids.push(h('p', { class: 'wf-res-p' }, `From “${from ? from.label : e.from}” to “${to ? to.label : e.to}”.`));
    kids.push(field('Follow when', segmented(kindsFor(from.type).map((k) => [k, EDGE_LABEL[k]]), e.when, (v) => edit((g) => { g.edges.find((x) => x.id === e.id).when = v; }))));
    kids.push(h('p', { class: 'wf-f-hint' }, from.type === 'gate'
      ? 'approved follows when someone approves the gate; rejected when they reject it.'
      : 'ok follows when the step succeeds; fail follows when it fails (after any retries).'));
    if (!ctx.readOnly) kids.push(h('div', { class: 'wf-i-foot' }, h('button', { class: 'btn btn-quiet btn-sm danger-text', type: 'button', onclick: () => onDeleteSelection && onDeleteSelection() }, icon('trash', 14), 'Delete connection')));
    const form = h('div', { class: 'wf-form' }, kids);
    if (ctx.readOnly) for (const el of form.querySelectorAll('button.wf-seg-b')) el.disabled = true;
    return form;
  }

  /* ----------------------------------------------------------- workflow-level form */
  function workflowForm() {
    const g = ctx.doc.graph;
    const kids = [h('div', { class: 'wf-i-head' }, h('span', { class: 'wf-i-ic' }, icon('workflow', 17)),
      h('div', { class: 'wf-i-headt' }, h('strong', {}, ctx.title || 'Workflow'), h('span', { class: 'mono dim' }, `${g.nodes.filter(isExec).length} steps · ${g.edges.length} connections`)))];
    // inputs (params)
    const params = g.params || [];
    const plist = h('div', { class: 'wf-params' });
    params.forEach((p, i) => {
      const badKey = !PARAM_RE.test(p.key) || params.some((q, j) => j < i && q.key === p.key);
      plist.append(h('div', { class: 'wf-param' },
        textInput(p.key, (v) => edit((gr) => { gr.params[i].key = v; }, `p:${i}:key`), { mono: true, invalid: badKey, placeholder: 'key', maxlength: 40 }),
        textInput(p.label || '', (v) => edit((gr) => { gr.params[i].label = v; }, `p:${i}:label`), { placeholder: 'Label', maxlength: 120 }),
        textInput(p.default || '', (v) => edit((gr) => { if (v) gr.params[i].default = v; else delete gr.params[i].default; }, `p:${i}:def`), { placeholder: 'Default', maxlength: 2000 }),
        check('Required', p.required, (on) => edit((gr) => { gr.params[i].required = on; })),
        ctx.readOnly ? null : h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': `Remove input ${p.key}`, title: 'Remove', onclick: () => edit((gr) => { gr.params.splice(i, 1); if (!gr.params.length) delete gr.params; }) }, icon('close', 14))));
    });
    kids.push(section('Run inputs',
      params.length ? plist : h('p', { class: 'wf-f-hint' }, 'Inputs are asked for when you press Run. Use them in prompts as {{params.key}}.'),
      ctx.readOnly ? null : h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => edit((gr) => {
        gr.params = gr.params || [];
        let n = gr.params.length + 1;
        while (gr.params.some((p) => p.key === `input${n}`)) n++;
        gr.params.push({ key: `input${n}`, label: `Input ${n}`, type: 'text', required: true });
      }) }, icon('plus', 14), 'Add input')));
    const iss = ctx.issues.get('*') || [];
    if (iss.length) kids.push(section('Problems', h('ul', { class: 'wf-problems' }, iss.map((m) => h('li', {}, icon('warning', 13), h('span', {}, m))))));
    const nodeIss = [...ctx.issues.entries()].filter(([k]) => k !== '*');
    if (nodeIss.length) {
      kids.push(section('Steps with problems', h('ul', { class: 'wf-problems' }, nodeIss.map(([id, ms]) => h('li', {},
        icon('warning', 13), h('button', { class: 'link-btn', type: 'button', onclick: () => onFocusNode && onFocusNode(id) }, id), h('span', {}, ` ${ms[0]}`))))));
    }
    kids.push(h('p', { class: 'wf-hint-keys' }, h('kbd', {}, 'double-click'), ' the canvas to add a step · drag from a dot to connect · ', h('kbd', {}, '⌘Z'), ' undo · ', h('kbd', {}, '0'), ' fit'));
    return h('div', { class: 'wf-form' }, kids);
  }

  /* ------------------------------------------------------------------- render */
  function render() {
    root.textContent = '';
    if (!ctx || !ctx.doc) { root.append(h('p', { class: 'wf-res-empty dim', style: { padding: '16px' } }, 'Select a workflow.')); return; }
    const { nodes, edge } = ctx.selection;
    let body;
    if (edge && ctx.doc.edge(edge)) body = edgeForm(ctx.doc.edge(edge));
    else if (nodes.length === 1 && ctx.doc.node(nodes[0])) body = ctx.run ? runNode(ctx.doc.node(nodes[0])) : nodeForm(ctx.doc.node(nodes[0]));
    else if (nodes.length > 1) {
      body = h('div', { class: 'wf-form' }, h('div', { class: 'wf-i-head' }, h('span', { class: 'wf-i-ic' }, icon('copy', 17)), h('div', { class: 'wf-i-headt' }, h('strong', {}, `${nodes.length} steps selected`), h('span', { class: 'mono dim' }, 'drag to move together'))),
        ctx.readOnly ? null : h('div', { class: 'wf-f-row' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.duplicate && ctx.duplicate() }, icon('copy', 14), 'Duplicate'),
          h('button', { class: 'btn btn-quiet btn-sm danger-text', type: 'button', onclick: () => onDeleteSelection && onDeleteSelection() }, icon('trash', 14), 'Delete')));
    } else body = workflowForm();
    root.append(body);
  }

  return {
    el: root,
    /** ctx: { doc, selection, readOnly, issues: Map, run, detail, title, duplicate } */
    show(next) { ctx = next; if (!selfChange) render(); },
    refresh() { if (!selfChange) render(); },
    destroy() { root.remove(); },
  };
}
