// templates.js — v0.11 task templates: shared helpers, actions, the editor dialog ("Save as template"), the use dialog
// (fill {{vars}} then Create / Create & start) and the Board composer's Templates popover.
// The Templates page (views/templates.js) and Spotlight reuse these pieces.
import { h } from './dom.js';
import { icon } from './icons.js';
import { state, sel, upsert, lsGet, lsSet } from './store.js';
import { api } from './api.js';
import { toast, toastError } from './ui.js';
import { openTask, navigate } from './router.js';
import { codeEditor, blockView } from './code.js';
import { codeOn, onPrefs } from './prefs.js';
import { NO_SESSION_MSG } from './actions.js';
import { fmtAgo, truncate } from './format.js';

/* ---------- pure helpers ---------- */
const VAR_RE = /\{\{\s*([A-Za-z_][\w .-]{0,39}?)\s*\}\}/g;
export const MAX_CHECKS = 20;

/** Distinct `{{var}}` names in the given texts, first-seen order. */
export function templateVars(...texts) {
  const out = [];
  for (const t of texts) for (const m of String(t || '').matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
export const varsOfTemplate = (t) => templateVars(t.title, t.description, ...(t.checks || []));
/** Fill placeholders; a blank or missing value falls back to the variable's name (same rule as the hub). */
export function fillVars(text, vars = {}) {
  return String(text || '').replace(VAR_RE, (_, n) => (typeof vars[n] === 'string' && vars[n].trim() ? vars[n].trim() : n));
}
/** Text split into plain strings and highlighted `{{var}}` marks (DOM nodes). */
export function markVars(text) {
  const out = [];
  let last = 0;
  const s = String(text || '');
  for (const m of s.matchAll(VAR_RE)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(h('mark', { class: 'tpl-var' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
export const AGENTS = [
  { id: 'auto', label: 'Auto', hint: 'Let the session choose' },
  { id: 'builder', label: 'Builder', hint: 'Writes and changes code' },
  { id: 'scout', label: 'Scout', hint: 'Read-only: search, read, check' },
];
export const agentLabel = (id) => (AGENTS.find((a) => a.id === id) || AGENTS[0]).label;
export function agentOfSubagent(type) {
  const t = String(type || '').toLowerCase();
  return t.includes('builder') ? 'builder' : t.includes('scout') ? 'scout' : 'auto';
}
const lastUsed = (t) => t.lastUsedAt || t.updatedAt || t.createdAt || 0;
export const cmpTemplates = (a, b) => (b.usage || 0) - (a.usage || 0) || lastUsed(b) - lastUsed(a)
  || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
/** Live templates a project can use (its own plus the global ones), most used first, then most recent. */
export function templatesFor(projectId, { includeArchived = false } = {}) {
  return Array.from(state.templates.values())
    .filter((t) => (includeArchived || !t.archived) && (!projectId || t.projectId == null || t.projectId === projectId))
    .sort(cmpTemplates);
}
export function matchTemplate(t, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${t.name} ${t.title} ${(t.tags || []).join(' ')} ${t.description || ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
export const scopeLabel = (t) => (t.projectId ? sel.projectName(t.projectId) : 'All projects');
/** The project a template would be used in without asking: its own, the selected one, the only one, or the remembered one. */
export function defaultProjectFor(tpl) {
  if (tpl && tpl.projectId) return tpl.projectId;
  const s = sel.scopeProject();
  if (s) return s.id;
  const ps = sel.projects();
  if (ps.length === 1) return ps[0].id;
  const r = lsGet('helm.composer.project');
  return r && ps.some((p) => p.id === r) ? r : (ps[0] ? ps[0].id : null);
}

/* ---------- actions ---------- */
/** Make a task from a template. Resolves the response, or null after toasting why not. */
export async function useTemplate(tpl, { projectId, vars = {}, start = false } = {}) {
  if (!projectId) { toast('Create a project first', { kind: 'error' }); navigate('projects'); return null; }
  try {
    const res = await api.useTemplate(tpl.id, { projectId, vars, start: !!start });
    if (res.note) upsert('note', res.note);
    if (res.task) upsert('task', res.task);
    if (res.template) upsert('template', res.template);
    const id = res.task && res.task.id;
    toast(`${start ? 'Started' : 'Created'} ${id} from “${truncate(tpl.name, 40)}”`, { kind: 'success', action: { label: 'Open', onClick: () => id && openTask(id) } });
    return res;
  } catch (e) {
    if (start && e.status === 409) {
      toast(`${/no live session/i.test(e.message) ? NO_SESSION_MSG : e.message}. Nothing was created.`, {
        kind: 'error', duration: 8000, action: { label: 'Create only', onClick: () => useTemplate(tpl, { projectId, vars, start: false }) },
      });
    } else toastError(e, 'Could not use template');
    return null;
  }
}
export async function saveTemplate(body, { id, fromTaskId } = {}) {
  try {
    const res = id ? await api.patchTemplate(id, body) : await api.createTemplate(fromTaskId ? { fromTaskId, ...body } : body);
    if (res.template) upsert('template', res.template);
    return res.template;
  } catch (e) { toastError(e, 'Could not save template'); return null; }
}
export async function archiveTemplate(t, archived = true) {
  try {
    const res = archived ? await api.archiveTemplate(t.id) : await api.patchTemplate(t.id, { archived: false });
    if (res.template) upsert('template', res.template);
    if (archived) toast(`Archived “${truncate(t.name, 40)}”`, { action: { label: 'Undo', onClick: () => archiveTemplate(t, false) } });
    return res.template;
  } catch (e) { toastError(e, archived ? 'Could not archive template' : 'Could not restore template'); return null; }
}
export function duplicateTemplate(t) {
  return saveTemplate({ name: `${t.name} copy`.slice(0, 200), title: t.title, description: t.description, agent: t.agent, checks: t.checks, tags: t.tags, projectId: t.projectId });
}

/* ---------- dialog shell ---------- */
let openDialogState = null;
export function closeDialog() { if (openDialogState) openDialogState.close(); }
function openDialog({ label, content, wide = false, onClose }) {
  closeDialog();
  const prevFocus = document.activeElement;
  const panel = h('div', { class: ['tpl-dialog', wide && 'wide'], role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, content);
  const scrim = h('div', { class: 'tpl-scrim' }, panel);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  const focusables = () => Array.from(panel.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(scrim);
  requestAnimationFrame(() => scrim.classList.add('in'));
  function close() {
    if (!openDialogState || openDialogState.scrim !== scrim) return;
    openDialogState = null;
    document.removeEventListener('keydown', onKey, true);
    scrim.classList.remove('in');
    setTimeout(() => scrim.remove(), 160);
    try { onClose && onClose(); } catch (e) { console.error(e); }
    if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
  }
  openDialogState = { scrim, close };
  return { close, panel, focusFirst: () => { const f = focusables()[0]; if (f) f.focus(); } };
}

const segGroup = (label, options, get, set) => {
  const btns = options.map((o) => h('button', { class: 'tpl-seg-btn', type: 'button', role: 'radio', 'data-v': o.id, title: o.hint || '', onclick: () => { set(o.id); sync(); btns.find((b) => b.dataset.v === o.id).focus(); } }, o.label));
  const el = h('div', { class: 'tpl-seg', role: 'radiogroup', 'aria-label': label }, btns);
  function sync() { for (const b of btns) { const on = b.dataset.v === get(); b.setAttribute('aria-checked', String(on)); b.classList.toggle('on', on); b.tabIndex = on ? 0 : -1; } }
  el.addEventListener('keydown', (e) => {
    if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.id === get());
    const d = /Left|Up/.test(e.key) ? -1 : 1;
    const n = options[(i + d + options.length) % options.length];
    set(n.id); sync(); btns.find((b) => b.dataset.v === n.id).focus();
  });
  sync();
  return { el, sync };
};

/* ---------- vars form (shared by the use dialog and the composer popover) ---------- */
/** Inputs for each {{var}} of `tpl` plus Create / Create & start. `getProject()` -> project id; `onDone(res)` after success. */
export function varsForm(tpl, { getProject, onDone, onCancel } = {}) {
  const names = varsOfTemplate(tpl);
  const values = {};
  const inputs = names.map((n) => {
    const input = h('input', { class: 'composer-input', type: 'text', id: `tplv-${tpl.id}-${n}`, autocomplete: 'off', spellcheck: 'false', placeholder: n, 'aria-label': n });
    input.addEventListener('input', () => { values[n] = input.value; paint(); });
    return input;
  });
  const preview = h('p', { class: 'tpl-preview', 'aria-live': 'polite' });
  const create = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => go(false) }, 'Create');
  const go_ = h('button', { class: 'btn btn-accent btn-sm', type: 'button', title: 'Create and start now (⌘↵)', onclick: () => go(true) }, icon('play', 13), 'Create & start', h('kbd', { class: 'kbd' }, '⌘↵'));
  const cancel = onCancel ? h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: onCancel }, 'Back') : null;
  const el = h('form', { class: 'tpl-form', onsubmit: (e) => { e.preventDefault(); go(false); } },
    names.length ? h('div', { class: 'tpl-vars-grid' }, names.map((n, i) => h('label', { class: 'tpl-var-row' }, h('span', { class: 'tpl-var-name mono' }, `{{${n}}}`), inputs[i]))) : null,
    preview,
    h('div', { class: 'composer-row' }, cancel, h('span', { class: 'spacer' }), create, go_));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); go(true); }
  });
  function paint() { preview.textContent = ''; preview.append(h('span', { class: 'tpl-preview-k' }, 'Title'), ' ', fillVars(tpl.title, values)); }
  let busy = false;
  async function go(start) {
    if (busy) return;
    busy = true; create.disabled = true; go_.disabled = true;
    const res = await useTemplate(tpl, { projectId: getProject(), vars: { ...values }, start });
    busy = false; create.disabled = false; go_.disabled = false;
    if (res && onDone) onDone(res);
  }
  paint();
  return { el, focus: () => (inputs[0] || create).focus() };
}

/** Use a template from anywhere (Spotlight, the Templates page): a small dialog with a project picker when it is ambiguous. */
export function openUseDialog(tpl) {
  if (!tpl) return;
  const ps = sel.projects();
  let projectId = defaultProjectFor(tpl);
  const needsPick = !tpl.projectId && ps.length > 1 && !sel.scopeProject();
  const proj = needsPick ? h('select', { class: 'select select-sm', 'aria-label': 'Project', onchange: () => { projectId = proj.value; lsSet('helm.composer.project', projectId); } },
    ps.map((p) => h('option', { value: p.id }, p.name))) : null;
  if (proj) proj.value = projectId;
  const form = varsForm(tpl, { getProject: () => projectId, onDone: () => dlg.close(), onCancel: () => dlg.close() });
  const dlg = openDialog({
    label: `Use template ${tpl.name}`,
    content: [
      h('header', { class: 'tpl-dialog-head' }, h('h2', { class: 'tpl-dialog-title' }, tpl.name), h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('close', 16))),
      h('div', { class: 'tpl-dialog-body' },
        h('p', { class: 'tpl-summary' }, truncate(tpl.description || tpl.title, 220)),
        proj ? h('label', { class: 'tpl-field' }, h('span', { class: 'tpl-label' }, 'Project'), proj) : null,
        form.el),
    ],
  });
  requestAnimationFrame(() => form.focus());
}

/* ---------- editor dialog ---------- */
/**
 * Create or edit a template. opts: { template } edit, { task } capture from a task ("Save as template"), {} new.
 * `duplicate` pre-fills from an existing template but saves a new one.
 */
export function openTemplateEditor({ template = null, task = null, onSaved } = {}) {
  const ps = sel.projects();
  const agent0 = task ? agentOfSubagent((sel.agentOfTask(task) || {}).subagentType) : 'auto';
  const st = {
    name: template ? template.name : task ? task.title : '',
    title: template ? template.title : task ? task.title : '',
    description: template ? template.description : task ? task.description || '' : '',
    agent: template ? template.agent : agent0,
    checks: template ? template.checks.slice() : [],
    scope: template ? (template.projectId ? 'project' : 'all') : (task || sel.scopeProject() ? 'project' : 'all'),
    projectId: template ? template.projectId : task ? task.projectId : (sel.scopeProject() || {}).id || null,
  };
  if (!st.projectId && ps[0]) st.projectId = ps[0].id;
  const heading = template ? 'Edit template' : task ? 'Save as template' : 'New template';

  const name = h('input', { class: 'composer-input', type: 'text', id: 'tpl-name', 'aria-label': 'Template name', autocomplete: 'off', maxlength: '200', placeholder: 'e.g. Fix a bug' });
  name.value = st.name;
  const title = h('input', { class: 'composer-input', type: 'text', id: 'tpl-title', 'aria-label': 'Task title', autocomplete: 'off', spellcheck: 'false', maxlength: '300', placeholder: 'e.g. Fix a bug in {{area}}' });
  title.value = st.title;
  const titleMirror = h('p', { class: 'tpl-mirror', 'aria-hidden': 'true' });
  const varsRow = h('p', { class: 'tpl-hint tpl-varsrow' });

  // description: plain textarea with a {{var}} highlight layer, or the code editor from code.js when Code mode is on
  const ta = h('textarea', { class: 'tpl-ta', id: 'tpl-desc', rows: '5', 'aria-label': 'Description', spellcheck: 'false', placeholder: 'What should the agent do? Use {{name}} for blanks.' });
  ta.value = st.description;
  const editor = codeEditor(ta, { block: true, className: 'tpl-ed', view: (v, s) => blockView(v, s, 'describe the task; {{vars}} are filled in when used') });
  const hl = h('pre', { class: 'tpl-hl', 'aria-hidden': 'true' });
  editor.el.insertBefore(hl, ta);

  const checksList = h('ul', { class: 'tpl-checks' });
  const checkIn = h('input', { class: 'composer-input', type: 'text', 'aria-label': 'Add a check', autocomplete: 'off', maxlength: '300', placeholder: 'Add a check, e.g. npm test passes' });
  const checkAdd = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => addCheck() }, icon('plus', 14), 'Add');
  const err = h('div', { class: 'banner banner-red', role: 'alert', hidden: true }, icon('warning', 15), h('span', {}));

  const agentSeg = segGroup('Preferred agent', AGENTS, () => st.agent, (v) => { st.agent = v; });
  const scopeOpts = [{ id: 'project', label: 'This project' }, { id: 'all', label: 'All projects' }];
  const scopeSeg = segGroup('Scope', scopeOpts, () => st.scope, (v) => { st.scope = v; syncScope(); });
  const projSel = h('select', { class: 'select select-sm', 'aria-label': 'Project', onchange: () => { st.projectId = projSel.value; } }, ps.map((p) => h('option', { value: p.id }, p.name)));
  if (st.projectId) projSel.value = st.projectId;
  function syncScope() { projSel.hidden = st.scope !== 'project'; }

  function paintVars() {
    const names = templateVars(title.value, ta.value, ...st.checks);
    titleMirror.textContent = '';
    titleMirror.append(...markVars(title.value));
    titleMirror.hidden = !names.length;
    varsRow.textContent = '';
    if (!names.length) varsRow.append('Use ', h('code', {}, '{{name}}'), ' for blanks you fill in when you use the template.');
    else varsRow.append('Asked when used: ', ...names.flatMap((n) => [h('mark', { class: 'tpl-var' }, `{{${n}}}`), ' ']));
  }
  function paintDesc() {
    hl.textContent = '';
    hl.append(...markVars(ta.value), ta.value.endsWith('\n') ? ' ' : '');
    if (!codeOn()) { ta.style.height = 'auto'; ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 96), 280)}px`; }
    hl.scrollTop = ta.scrollTop;
  }
  function renderChecks() {
    checksList.textContent = '';
    st.checks.forEach((c, i) => {
      const inp = h('input', { class: 'composer-input', type: 'text', 'aria-label': `Check ${i + 1}`, maxlength: '300', autocomplete: 'off' });
      inp.value = c;
      inp.addEventListener('input', () => { st.checks[i] = inp.value; paintVars(); });
      checksList.appendChild(h('li', { class: 'tpl-check' }, icon('check', 14, 'tpl-check-ic'), inp,
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': `Remove check ${i + 1}`, title: 'Remove', onclick: () => { st.checks.splice(i, 1); renderChecks(); paintVars(); checkIn.focus(); } }, icon('close', 14))));
    });
    checkAdd.disabled = checkIn.disabled = st.checks.length >= MAX_CHECKS;
  }
  function addCheck() {
    const v = checkIn.value.trim();
    if (!v || st.checks.length >= MAX_CHECKS) return;
    st.checks.push(v); checkIn.value = '';
    renderChecks(); paintVars(); checkIn.focus();
  }
  checkIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); addCheck(); } });

  const fail = (m) => { err.hidden = false; err.lastChild.textContent = m; };
  let saving = false;
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save template');
  async function submit() {
    if (saving) return;
    const n = name.value.trim(), t = title.value.trim();
    if (!n) { fail('Give the template a name.'); name.focus(); return; }
    if (!t) { fail('Give the tasks a title.'); title.focus(); return; }
    if (st.scope === 'project' && !st.projectId) { fail('Create a project first, or save it for all projects.'); return; }
    err.hidden = true;
    const checks = st.checks.map((c) => c.trim()).filter(Boolean);
    if (checkIn.value.trim() && checks.length < MAX_CHECKS) checks.push(checkIn.value.trim());
    const body = { name: n, title: t, description: ta.value, agent: st.agent, checks, projectId: st.scope === 'project' ? st.projectId : null };
    saving = true; save.disabled = true;
    const saved = await saveTemplate(body, { id: template && template.id, fromTaskId: !template && task ? task.id : undefined });
    saving = false; save.disabled = false;
    if (!saved) return;
    dlg.close();
    if (onSaved) onSaved(saved);
    else if (!template) toast(`Saved template “${truncate(saved.name, 40)}”`, { kind: 'success', action: { label: 'Open Templates', onClick: () => navigate('templates') } });
  }

  const form = h('form', { class: 'tpl-dialog-body tpl-editor', onsubmit: (e) => { e.preventDefault(); submit(); } },
    err,
    h('div', { class: 'tpl-field' }, h('label', { class: 'tpl-label', for: 'tpl-name' }, 'Name'), name),
    h('div', { class: 'tpl-field' }, h('label', { class: 'tpl-label', for: 'tpl-title' }, 'Task title'), title, titleMirror),
    h('div', { class: 'tpl-field' }, h('label', { class: 'tpl-label', for: 'tpl-desc' }, 'Brief'), editor.el, varsRow),
    h('div', { class: 'tpl-field' }, h('span', { class: 'tpl-label' }, 'Checks'), h('p', { class: 'tpl-hint' }, 'Short acceptance items the agent must meet. They are appended to the brief.'), checksList,
      h('div', { class: 'tpl-check-add' }, checkIn, checkAdd)),
    h('div', { class: 'tpl-row2' },
      h('div', { class: 'tpl-field' }, h('span', { class: 'tpl-label' }, 'Preferred agent'), agentSeg.el),
      h('div', { class: 'tpl-field' }, h('span', { class: 'tpl-label' }, 'Available in'), h('div', { class: 'tpl-scope' }, scopeSeg.el, projSel))),
    h('div', { class: 'tpl-dialog-foot' }, h('span', { class: 'desc-hint mono tpl-keyhint' }, '⌘↵ save · esc cancel'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dlg.close() }, 'Cancel'), save));
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); submit(); }
  });

  const offPrefs = onPrefs((k) => { if (k === 'code' || k === 'codestyle') { editor.sync(); paintDesc(); } });
  const dlg = openDialog({
    label: heading, wide: true,
    onClose: () => { offPrefs(); editor.destroy(); },
    content: [
      h('header', { class: 'tpl-dialog-head' }, icon('bookmark', 16), h('h2', { class: 'tpl-dialog-title' }, heading), h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('close', 16))),
      form,
    ],
  });
  title.addEventListener('input', paintVars);
  ta.addEventListener('input', () => { paintDesc(); paintVars(); });
  ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; });
  syncScope(); renderChecks(); paintVars(); editor.sync(); paintDesc();
  requestAnimationFrame(() => { name.focus(); name.select(); paintDesc(); });
  return dlg;
}

/* ---------- Board composer popover ---------- */
let popState = null;
export function closeTemplatePopover(restore = false) {
  if (!popState) return;
  const { el, anchor, off } = popState;
  popState = null;
  off();
  el.classList.remove('in');
  setTimeout(() => el.remove(), 120);
  anchor.setAttribute('aria-expanded', 'false');
  if (restore && anchor.isConnected) anchor.focus({ preventScroll: true });
}

/** Templates popover anchored to a composer button. getProject() -> the project the new task would go to. */
export function openTemplatePopover(anchor, { getProject, onDone } = {}) {
  if (popState && popState.anchor === anchor) { closeTemplatePopover(true); return; }
  closeTemplatePopover();
  const projectId = getProject();
  if (!projectId) { toast('Create a project first', { kind: 'error' }); navigate('projects'); return; }
  let query = '';
  let picked = null; // template whose vars form is showing
  const search = h('input', { class: 'composer-input tpl-pop-search', type: 'text', role: 'searchbox', autocomplete: 'off', spellcheck: 'false', placeholder: 'Search templates…', 'aria-label': 'Search templates' });
  const list = h('ul', { class: 'tpl-pop-list', 'aria-label': 'Templates' });
  const body = h('div', { class: 'tpl-pop-body' });
  const manage = h('button', { class: 'link-btn tpl-pop-manage', type: 'button', onclick: () => { closeTemplatePopover(); navigate('templates'); } }, 'Manage templates');
  const el = h('div', { class: 'tpl-pop', role: 'dialog', 'aria-label': 'Templates' }, body);
  const finish = (res) => { closeTemplatePopover(true); if (onDone) onDone(res); };

  function rows() {
    return templatesFor(projectId).filter((t) => matchTemplate(t, query));
  }
  function renderList() {
    body.textContent = '';
    picked = null;
    const all = templatesFor(projectId);
    const shown = rows();
    list.textContent = '';
    for (const t of shown) list.appendChild(row(t));
    body.append(h('div', { class: 'tpl-pop-top' }, search), list);
    if (!shown.length) body.insertBefore(h('p', { class: 'tpl-pop-empty' }, all.length ? `No templates match “${truncate(query, 30)}”` : 'No templates yet. Open a task and use Save as template.'), list);
    body.append(h('div', { class: 'tpl-pop-foot' }, manage));
  }
  function row(t) {
    const names = varsOfTemplate(t);
    const main = h('button', { class: 'tpl-row-main', type: 'button', 'data-id': t.id, title: names.length ? 'Fill in the blanks' : 'Create a task from this template',
      onclick: () => (names.length ? showForm(t) : go(t, false)) },
    h('span', { class: 'tpl-row-name' }, t.name),
    h('span', { class: 'tpl-row-sub' }, markVars(truncate(t.title, 80))),
    h('span', { class: 'tpl-row-meta mono' }, [agentLabel(t.agent) !== 'Auto' ? agentLabel(t.agent) : null, t.usage ? `used ${t.usage}×` : null, t.projectId ? scopeLabel(t) : null].filter(Boolean).join(' · ')));
    const acts = names.length
      ? [h('span', { class: 'tpl-row-vars mono', title: 'Blanks to fill in' }, `${names.length} var${names.length === 1 ? '' : 's'}`)]
      : [h('button', { class: 'btn btn-quiet btn-sm tpl-row-btn', type: 'button', onclick: () => go(t, false), 'aria-label': `Create from ${t.name}` }, 'Create'),
        h('button', { class: 'btn btn-accent btn-sm tpl-row-btn', type: 'button', onclick: () => go(t, true), 'aria-label': `Create and start from ${t.name}`, title: 'Create and start now' }, icon('play', 12), 'Start')];
    return h('li', { class: 'tpl-row' }, main, h('div', { class: 'tpl-row-acts' }, acts));
  }
  async function go(t, start) {
    const res = await useTemplate(t, { projectId, start });
    if (res) finish(res);
  }
  function showForm(t) {
    picked = t;
    body.textContent = '';
    const form = varsForm(t, { getProject: () => projectId, onDone: finish, onCancel: () => { renderList(); search.focus(); } });
    body.append(h('div', { class: 'tpl-pop-head' }, h('strong', {}, t.name), h('span', { class: 'tpl-pop-sub' }, markVars(truncate(t.title, 90)))), form.el);
    form.focus();
  }

  search.addEventListener('input', () => { query = search.value; const keep = search.selectionStart; renderList(); search.focus(); search.setSelectionRange(keep, keep); });
  const rowButtons = () => Array.from(list.querySelectorAll('.tpl-row-main'));
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (picked) { renderList(); search.focus(); } else closeTemplatePopover(true); return; }
    if (picked) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = rowButtons();
    if (!btns.length) return;
    const cur = btns.indexOf(document.activeElement);
    e.preventDefault();
    if (e.key === 'ArrowDown') (btns[cur + 1] || btns[0]).focus();
    else if (cur <= 0) search.focus();
    else btns[cur - 1].focus();
  };
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeTemplatePopover(false); };
  const onResize = () => closeTemplatePopover(false);
  el.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', onResize, { once: true });
  const off = () => { document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('resize', onResize); };
  popState = { el, anchor, off };
  anchor.setAttribute('aria-expanded', 'true');
  renderList();
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, hh = el.offsetHeight;
  let left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + hh > innerHeight - 8) top = Math.max(8, r.top - hh - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  requestAnimationFrame(() => { el.classList.add('in'); search.focus({ preventScroll: true }); });
}

export const fmtUsed = (t) => (t.usage ? `Used ${t.usage}× · ${t.lastUsedAt ? fmtAgo(t.lastUsedAt) : ''}`.replace(/ · $/, '') : 'Never used');
