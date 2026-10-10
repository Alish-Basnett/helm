// views/templates.js — the Templates page (#/templates): saved tasks you start in one click. Search, use, edit,
// duplicate, archive; usage counts. Lives in the sidebar under Learn because templates are reusable content you build up
// and browse (like Workflows and Learn), while Settings holds preferences.
import { h, reconcile, setText, setClass, setHidden, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel } from '../store.js';
import { emptyState } from '../ui.js';
import { plural, fmtAgo } from '../format.js';
import {
  templatesFor, matchTemplate, markVars, varsOfTemplate, agentLabel, scopeLabel,
  openTemplateEditor, openUseDialog, archiveTemplate, duplicateTemplate,
} from '../templates.js';

export function mount(container) {
  let query = '';
  let showArchived = false;
  startTicker();

  const search = h('input', { class: 'composer-input tpl-page-search', type: 'text', role: 'searchbox', placeholder: 'Search templates…', 'aria-label': 'Search templates', autocomplete: 'off', spellcheck: 'false',
    oninput: () => { query = search.value; render(); } });
  const archToggle = h('label', { class: 'switch-row' },
    h('input', { type: 'checkbox', onchange: (e) => { showArchived = e.target.checked; render(); } }), h('span', {}, 'Show archived'));
  const newBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openTemplateEditor() }, icon('plus', 16), 'New template');
  const bar = h('div', { class: 'view-toolbar' },
    h('p', { class: 'view-sub' }, 'Save a brief, an agent and its checks once, then start it in one click from the Board, Spotlight or here. Use ', h('code', {}, '{{name}}'), ' for blanks you fill in each time.'),
    h('span', { class: 'spacer' }), search, archToggle, newBtn);
  const grid = h('div', { class: 'tpl-grid' });
  const none = h('p', { class: 'tpl-page-none', hidden: true });
  const empty = h('div', { class: 'view-empty' }, emptyState({
    iconName: 'templates', title: 'No templates yet',
    body: 'Open any task and choose Save as template, or create one here.',
    action: { label: 'New template', onClick: () => openTemplateEditor() },
  }));
  const wrap = h('div', { class: 'projects tpl-page' }, bar, grid, none, empty);
  container.appendChild(wrap);

  function makeCard() {
    const r = {};
    r.name = h('h3', { class: 'proj-name' });
    r.use = h('button', { class: 'btn btn-accent btn-sm', type: 'button', onclick: () => openUseDialog(r.t) }, icon('play', 13), 'Use');
    r.edit = h('button', { class: 'icon-btn sm', type: 'button', title: 'Edit', onclick: () => openTemplateEditor({ template: r.t }) }, icon('pencil', 14));
    r.dup = h('button', { class: 'icon-btn sm', type: 'button', title: 'Duplicate', onclick: () => duplicateTemplate(r.t) }, icon('copy', 14));
    r.arch = h('button', { class: 'icon-btn sm', type: 'button', onclick: () => archiveTemplate(r.t, !r.t.archived) }, icon('archive', 14));
    r.title = h('p', { class: 'tpl-card-title' });
    r.desc = h('p', { class: 'tpl-card-desc' });
    r.chips = h('div', { class: 'tpl-chips' });
    r.checks = h('ul', { class: 'tpl-card-checks' });
    r.meta = h('div', { class: 'tpl-card-meta mono' });
    const el = h('article', { class: 'proj-card tpl-card' },
      h('header', { class: 'proj-head' }, r.name, h('span', { class: 'spacer' }), r.edit, r.dup, r.arch),
      r.title, r.desc, r.chips, r.checks, h('div', { class: 'tpl-card-foot' }, r.meta, h('span', { class: 'spacer' }), r.use));
    el.__r = r;
    return el;
  }
  function updateCard(el, t) {
    const r = el.__r;
    r.t = t;
    setClass(el, 'archived', !!t.archived);
    setText(r.name, t.name);
    r.title.textContent = '';
    r.title.append(...markVars(t.title));
    setText(r.desc, t.description || '');
    setHidden(r.desc, !t.description);
    const vars = varsOfTemplate(t);
    r.chips.textContent = '';
    r.chips.append(
      h('span', { class: 'badge' }, agentLabel(t.agent)),
      h('span', { class: ['badge', t.projectId ? 'badge-accent' : ''] }, scopeLabel(t)),
      vars.length ? h('span', { class: 'badge', title: vars.map((v) => `{{${v}}}`).join(' ') }, plural(vars.length, 'blank')) : null,
      ...(t.tags || []).map((g) => h('span', { class: 'badge' }, `#${g}`)));
    r.checks.textContent = '';
    for (const c of (t.checks || []).slice(0, 4)) r.checks.append(h('li', {}, icon('check', 12), h('span', {}, c)));
    if ((t.checks || []).length > 4) r.checks.append(h('li', { class: 'dim' }, `+${t.checks.length - 4} more`));
    setHidden(r.checks, !(t.checks || []).length);
    r.meta.textContent = '';
    r.meta.append(h('span', { class: 'tpl-used', title: 'Times this template was used' }, t.usage ? `Used ${t.usage}×` : 'Never used'),
      t.lastUsedAt ? h('span', { 'data-ago': t.lastUsedAt, 'data-ago-prefix': 'last ' }, `last ${fmtAgo(t.lastUsedAt)}`) : null);
    r.arch.title = t.archived ? 'Restore' : 'Archive';
    r.arch.setAttribute('aria-label', `${t.archived ? 'Restore' : 'Archive'} ${t.name}`);
    r.edit.setAttribute('aria-label', `Edit ${t.name}`);
    r.dup.setAttribute('aria-label', `Duplicate ${t.name}`);
    r.use.setAttribute('aria-label', `Use ${t.name}`);
    r.use.disabled = !!t.archived;
    r.arch.replaceChildren(icon(t.archived ? 'retry' : 'archive', 14));
  }

  function render() {
    const scoped = sel.templates({ scoped: true, includeArchived: showArchived });
    const list = scoped.filter((t) => matchTemplate(t, query));
    reconcile(grid, list, (t) => t.id, makeCard, updateCard);
    const total = state.templates.size;
    setHidden(grid, list.length === 0);
    setHidden(empty, !(state.ready && total === 0));
    setHidden(none, !(list.length === 0 && total > 0));
    if (!none.hidden) setText(none, query ? `No templates match “${query}”.` : 'No templates in this project. Switch to All projects, or create one.');
  }
  render();

  return { watch: ['template', 'project', 'ui', 'ready'], update: render, setRoute() {}, destroy() { wrap.remove(); } };
}
