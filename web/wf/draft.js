// wf/draft.js — "From template…" gallery and "Describe it…" composer (CONTRACT v0.10).
// Both are centred sheets (not anchored popovers) because they hold cards and a large textarea.
// The composer never talks to a model: it queues a wf_draft job through the hub and watches the job in the store.
import { h, setText } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { api } from '../api.js';

const EXAMPLES = [
  'Build a feature, run tests, ask me before merging',
  'Investigate a bug then fix it with tests',
  'Research the codebase, let me approve a plan, then build it',
];
const NODE_TONE = { agent: 'agent', shell: 'shell', gate: 'gate', review: 'review', note: 'note' };
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); return el; };

/** A small picture of a graph: boxes per node (coloured by type) and lines per edge. */
export function miniGraph(graph, { w = 260, hgt = 110 } = {}) {
  const nodes = (graph && graph.nodes) || [];
  const svg = sv('svg', { class: 'wf-mini', viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': `${nodes.length} steps` });
  if (!nodes.length) return svg;
  const xs = nodes.map((n) => n.position.x), ys = nodes.map((n) => n.position.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), bw = 200, bh = 70;
  const sx = (w - 16) / Math.max(1, Math.max(...xs) - x0 + bw), sy = (hgt - 16) / Math.max(1, Math.max(...ys) - y0 + bh);
  const k = Math.min(sx, sy);
  const ox = (w - (Math.max(...xs) - x0 + bw) * k) / 2, oy = (hgt - (Math.max(...ys) - y0 + bh) * k) / 2;
  const at = (n) => ({ x: ox + (n.position.x - x0) * k, y: oy + (n.position.y - y0) * k });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of (graph.edges || [])) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const pa = at(a), pb = at(b);
    svg.append(sv('path', { class: `mini-e ${e.when === 'fail' || e.when === 'rejected' ? 'bad' : ''}`, d: `M${pa.x + bw * k} ${pa.y + bh * k / 2} C${pa.x + bw * k + 12} ${pa.y + bh * k / 2} ${pb.x - 12} ${pb.y + bh * k / 2} ${pb.x} ${pb.y + bh * k / 2}` }));
  }
  for (const n of nodes) {
    const p = at(n);
    svg.append(sv('rect', { class: `mini-n t-${NODE_TONE[n.type] || 'agent'}`, x: p.x, y: p.y, width: bw * k, height: bh * k, rx: 3 }));
  }
  return svg;
}

let current = null;
export function closeSheet() {
  if (!current) return;
  const { el, onKey, prevFocus, cleanup } = current;
  current = null;
  document.removeEventListener('keydown', onKey, true);
  if (cleanup) cleanup();
  el.classList.remove('in');
  setTimeout(() => el.remove(), 140);
  if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
}
function openSheet(title, body, { wide = false, cleanup } = {}) {
  closeSheet();
  const prevFocus = document.activeElement;
  const close = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close', onclick: () => closeSheet() }, icon('close', 16));
  const card = h('div', { class: `wf-sheet${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', { class: 'wf-sheet-head' }, h('h2', {}, title), close), body);
  const el = h('div', { class: 'wf-sheet-wrap' }, card);
  el.addEventListener('pointerdown', (e) => { if (e.target === el) closeSheet(); });
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.append(el);
  current = { el, onKey, prevFocus, cleanup };
  requestAnimationFrame(() => {
    el.classList.add('in');
    const f = el.querySelector('[data-autofocus]') || el.querySelector('button.wf-card,textarea,input,select');
    if (f) f.focus({ preventScroll: true });
  });
  return card;
}

function projectSelect(projects, projectId) {
  if (projects.length < 2) return null;
  const s = h('select', { class: 'select select-sm wf-select', 'aria-label': 'Project' }, projects.map((p) => h('option', { value: p.id }, p.name)));
  s.value = projectId || projects[0].id;
  return s;
}

/**
 * Template gallery. onCreate(templateId, projectId) -> Promise; the sheet closes when it resolves.
 */
export async function openGallery({ projects, projectId, onCreate }) {
  const grid = h('div', { class: 'wf-cards', role: 'list' }, h('p', { class: 'wf-pop-p' }, 'Loading templates…'));
  const proj = projectSelect(projects, projectId);
  const body = h('div', { class: 'wf-sheet-body' },
    h('p', { class: 'wf-pop-p' }, 'Pick a starting point. It becomes your own workflow that you can edit freely.'),
    proj ? h('label', { class: 'wf-field' }, h('span', {}, 'Project'), proj) : null, grid);
  openSheet('Start from a template', body, { wide: true });
  let list;
  try { list = (await api.workflowTemplates()).templates; } catch (e) { setText(grid.firstChild, `Could not load templates: ${e.message || e}`); return; }
  grid.textContent = '';
  let busy = false;
  for (const t of list) {
    const card = h('button', { class: 'wf-card', type: 'button', role: 'listitem', 'data-template': t.id,
      onclick: async () => {
        if (busy) return;
        busy = true; card.classList.add('busy');
        try { await onCreate(t.id, proj ? proj.value : projectId); closeSheet(); } catch { busy = false; card.classList.remove('busy'); }
      } },
    miniGraph(t.graph),
    h('div', { class: 'wf-card-t' }, h('span', { class: 'wf-card-ic', 'aria-hidden': 'true' }, t.icon || '◆'), h('strong', {}, t.title)),
    h('p', {}, t.description));
    grid.append(card);
  }
}

/**
 * Composer. Create mode: { projects, projectId }. Modify mode: { projects, projectId, workflow } (sends workflowId).
 * onDone({ workflowId, version, unchanged, prompt }) runs after the hub made the workflow / version.
 */
export function openComposer({ projects, projectId, workflow = null, onDone }) {
  const modify = !!workflow;
  const ta = h('textarea', {
    class: 'wf-area wf-compose', rows: '5', maxlength: '4000', 'data-autofocus': '', 'aria-label': 'Describe the workflow',
    placeholder: modify ? 'e.g. Run lint before the tests, and add a review step at the end' : 'Describe the workflow you want, in your own words',
  });
  const proj = modify ? null : projectSelect(projects, projectId);
  const chips = modify ? null : h('div', { class: 'wf-chips', role: 'group', 'aria-label': 'Examples' },
    EXAMPLES.map((t) => h('button', { class: 'wf-chip-ex', type: 'button', onclick: () => { ta.value = t; ta.focus(); go.disabled = false; } }, t)));
  const err = h('div', { class: 'wf-draft-err', hidden: true, role: 'alert' });
  const go = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, icon('sparkle', 14), h('span', {}, modify ? 'Change it' : 'Draft'));
  const form = h('div', { class: 'wf-compose-form' },
    modify ? h('p', { class: 'wf-pop-p' }, `Describe the change to "${workflow.name}". Sonnet drafts a new version; the current one stays in the history.`)
      : h('p', { class: 'wf-pop-p' }, 'Sonnet drafts the steps and connections. It opens on the canvas for you to edit, and nothing runs until you press Run.'),
    proj ? h('label', { class: 'wf-field' }, h('span', {}, 'Project'), proj) : null, ta, chips, err,
    h('div', { class: 'wf-pop-foot' }, h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => closeSheet() }, 'Cancel'), go));
  const shimmer = h('div', { class: 'wf-shimmer', hidden: true, 'aria-live': 'polite' },
    h('div', { class: 'wf-shimmer-bars' }, h('i'), h('i'), h('i')),
    h('p', { class: 'wf-shimmer-t' }, 'Sonnet is drafting your workflow…'),
    h('p', { class: 'wf-pop-p wf-shimmer-s' }, 'This usually takes under a minute.'));
  const body = h('div', { class: 'wf-sheet-body' }, form, shimmer);
  let timer = null, dead = false;
  const stop = () => { dead = true; if (timer) clearInterval(timer); timer = null; };
  openSheet(modify ? 'Change with words' : 'Describe your workflow', body, { cleanup: stop });
  ta.addEventListener('input', () => { go.disabled = !ta.value.trim(); });
  go.disabled = true;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !go.disabled) { e.preventDefault(); submit(); } });
  go.addEventListener('click', submit);

  function fail(message, issues) {
    stop();
    setText(shimmer.querySelector('.wf-shimmer-t'), 'Sonnet is drafting your workflow…');
    shimmer.hidden = true; form.hidden = false;
    err.hidden = false; err.textContent = '';
    err.append(h('strong', {}, message));
    if (issues && issues.length) err.append(h('ul', {}, issues.slice(0, 6).map((i) => h('li', {}, icon('warning', 13), h('span', {}, i.message)))));
    setText(go.lastChild, 'Try again');
    go.disabled = !ta.value.trim();
  }
  async function submit() {
    const prompt = ta.value.trim();
    if (!prompt) return;
    go.disabled = true; err.hidden = true;
    let job;
    try {
      const body = { projectId: modify ? workflow.projectId : (proj ? proj.value : projectId), prompt };
      if (modify) body.workflowId = workflow.id;
      job = (await api.draftWorkflow(body)).job;
    } catch (e) {
      fail(e.status === 409 ? 'No live Claude Code session in this project to draft with. Start one, then try again.' : (e.message || 'Could not start the draft'), null);
      return;
    }
    form.hidden = true; shimmer.hidden = false; dead = false;
    let id = job.id, polls = 0;
    const settle = (j) => {
      if (j.state === 'failed') {
        let issues = null;
        try { issues = JSON.parse(j.result || 'null').issues; } catch { /* plain error */ }
        fail(j.error || 'The draft failed', issues);
        return;
      }
      let r = null;
      try { r = JSON.parse(j.result || 'null'); } catch { /* ignore */ }
      if (r && r.retryJobId) { id = r.retryJobId; setText(shimmer.querySelector('.wf-shimmer-t'), 'Fixing a few problems in the draft…'); return; }
      if (r && r.workflowId) { stop(); closeSheet(); onDone({ ...r, prompt }); return; }
      fail('The draft finished without a workflow', null);
    };
    timer = setInterval(() => {
      if (dead) return;
      polls++;
      const j = state.jobs.get(id);
      if (j && (j.state === 'done' || j.state === 'failed')) settle(j);
      else if (polls > 600) fail('Timed out waiting for the draft', null);
    }, 400);
  }
}
