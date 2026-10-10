// views/concepts.js — v0.13 Learn++: the Concepts tab (searchable cards) and the concept page (#/learn/c/:slug).
import { h, reconcile, setText, setClass, setHidden, debounce, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, lsGet, lsSet } from '../store.js';
import { api } from '../api.js';
import { summarizeConcept, patchConcept, mergeConcepts } from '../actions.js';
import { fmtAgo, fmtDay, plural } from '../format.js';
import { emptyState } from '../ui.js';
import { setMarkdown } from '../markdown.js';
import { taskLinker, taskChip } from '../tasklinks.js';
import { navigate, openTask, setArgs } from '../router.js';
import { codeOn, getPref, onPrefs } from '../prefs.js';
import { docBlock } from '../code.js';
import { openConcept, sparkline } from '../concepts.js';

const SORTS = [['recent', 'Recent'], ['count', 'Most used'], ['name', 'A–Z']];
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** Name for a slug: the store's copy first, else the slug itself. */
const nameOf = (slug, extra) => (extra && extra.get(slug)) || (state.concepts.get(slug) || {}).name || slug;

/* ===================================================================== Concepts tab */
export function createConceptsTab(host) {
  let query = '';
  let sort = SORTS.some(([k]) => k === lsGet('helm.concepts.sort')) ? lsGet('helm.concepts.sort') : 'recent';
  let pinnedFirst = lsGet('helm.concepts.pinned', '1') !== '0';
  let list = null; // Concept[] from the hub (all, sorted)
  let error = null;
  let reqId = 0;
  startTicker();

  const search = h('input', {
    class: 'composer-input cc-search', type: 'text', role: 'searchbox', placeholder: 'Search concepts, aliases…', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Search concepts', oninput: () => { query = search.value; reload(); },
  });
  const segBtns = SORTS.map(([k, label]) => h('button', { class: 'cc-seg-btn', type: 'button', 'data-sort': k, onclick: () => { sort = k; lsSet('helm.concepts.sort', k); paintBar(); reload(true); } }, label));
  const seg = h('div', { class: 'cc-seg', role: 'group', 'aria-label': 'Sort concepts' }, segBtns);
  const pinToggle = h('label', { class: 'switch-row' },
    h('input', { type: 'checkbox', checked: pinnedFirst, onchange: (e) => { pinnedFirst = e.target.checked; lsSet('helm.concepts.pinned', pinnedFirst ? '1' : '0'); render(); } }),
    h('span', {}, 'Pinned first'));
  const count = h('span', { class: 'cc-total mono' });
  const bar = h('div', { class: 'cc-bar' }, search, seg, pinToggle, h('span', { class: 'spacer' }), count);
  const err = h('div', { class: 'banner banner-red', hidden: true }, icon('warning', 15), h('span', {}), h('button', { class: 'link-btn', type: 'button', onclick: () => reload(true) }, 'Retry'));
  const grid = h('div', { class: 'cc-grid' });
  const none = h('p', { class: 'cc-none', hidden: true });
  const empty = h('div', { class: 'view-empty', hidden: true }, emptyState({
    iconName: 'tag', title: 'No concepts yet',
    body: 'Every recap tags the ideas it touched. Helm gathers those tags into concepts, so you can see what you keep learning and where.',
  }));
  const el = h('div', { class: 'cc', hidden: true }, bar, err, grid, none, empty);
  host.appendChild(el);

  function paintBar() {
    for (const b of segBtns) {
      const on = b.getAttribute('data-sort') === sort;
      setClass(b, 'on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  async function load() {
    const my = ++reqId;
    try {
      const res = await api.concepts(query.trim() || undefined, sort);
      if (my !== reqId) return;
      list = res.concepts || [];
      error = null;
    } catch (e) {
      if (my !== reqId) return;
      error = e.message;
      if (!list) list = sel.concepts({ by: sort }).filter(matchLocal); // an older hub: the store copy is all we have
    }
    render();
  }
  function matchLocal(c) {
    const n = query.trim().toLowerCase();
    return !n || [c.name, c.slug, ...(c.aliases || [])].some((v) => String(v).toLowerCase().includes(n));
  }
  const reloadSoon = debounce(load, 220);
  function reload(now) { if (now) { reloadSoon.cancel(); load(); } else reloadSoon(); }

  function makeCard() {
    const name = h('button', { class: 'cc-name', type: 'button' });
    const pin = h('button', { class: 'cc-pin icon-btn', type: 'button' }, icon('bookmark', 16));
    const total = h('span', { class: 'cc-count mono' });
    const when = h('span', { class: 'cc-when mono' });
    const sp = h('span', { class: 'cc-spark' });
    const flag = h('span', { class: 'cc-flag' });
    const rel = h('div', { class: 'cc-rel' });
    const card = h('article', { class: 'cc-card' },
      h('header', { class: 'cc-head' }, name, h('span', { class: 'spacer' }), total, pin),
      h('div', { class: 'cc-meta' }, when, flag, h('span', { class: 'spacer' }), sp), rel);
    card.__c = { name, pin, total, when, sp, flag, rel };
    return card;
  }
  function updateCard(card, c) {
    const x = card.__c;
    setText(x.name, c.name);
    x.name.onclick = () => openConcept(c.slug);
    x.name.setAttribute('aria-label', `Open ${c.name}`);
    setText(x.total, plural(c.count, 'task'));
    x.when.setAttribute('data-ago', c.lastSeenAt);
    x.when.setAttribute('data-ago-prefix', 'last seen ');
    setText(x.when, `last seen ${fmtAgo(c.lastSeenAt)}`);
    setClass(card, 'pinned', c.pinned);
    x.pin.setAttribute('aria-pressed', String(c.pinned));
    x.pin.title = c.pinned ? 'Unpin' : 'Pin to the top';
    x.pin.setAttribute('aria-label', c.pinned ? `Unpin ${c.name}` : `Pin ${c.name}`);
    x.pin.onclick = async (e) => {
      e.stopPropagation();
      const was = c.pinned;
      c.pinned = !was; render();
      const done = await patchConcept(c.slug, { pinned: !was });
      if (!done) { c.pinned = was; render(); }
    };
    const sig = c.taskAts.join(',') + '|' + fmtDate(Date.now());
    if (x.sp.__sig !== sig) { x.sp.__sig = sig; x.sp.textContent = ''; x.sp.append(sparkline(c.taskAts)); }
    const flagText = c.hasSummary ? 'page' : c.needsSummary ? 'needs a page' : '';
    setText(x.flag, flagText);
    setClass(x.flag, 'has', c.hasSummary);
    setClass(x.flag, 'needs', !c.hasSummary && c.needsSummary);
    setHidden(x.flag, !flagText);
    const relNames = (c.related || []).slice(0, 4);
    const rsig = relNames.join('|') + '|' + relNames.map((s) => nameOf(s)).join('|');
    if (x.rel.__sig !== rsig) {
      x.rel.__sig = rsig;
      x.rel.textContent = '';
      for (const s of relNames) x.rel.append(h('button', { class: 'tag', type: 'button', onclick: () => openConcept(s) }, nameOf(s)));
    }
  }

  function render() {
    paintBar();
    setHidden(err, !error);
    setText(err.children[1], error ? `Couldn’t load concepts: ${error}` : '');
    const all = list || [];
    const rows = pinnedFirst ? [...all.filter((c) => c.pinned), ...all.filter((c) => !c.pinned)] : all;
    reconcile(grid, rows, (c) => c.slug, makeCard, updateCard);
    setHidden(grid, rows.length === 0);
    setText(count, list ? plural(all.length, 'concept') : '');
    const filtering = !!query.trim();
    setHidden(none, !(list && rows.length === 0 && filtering));
    setText(none, `No concept matches “${query.trim()}”.`);
    setHidden(empty, !(list && rows.length === 0 && !filtering && !error && state.ready));
  }

  return {
    el,
    activate() { setHidden(el, false); paintBar(); load(); },
    deactivate() { setHidden(el, true); },
    update(changed) { if (changed.has('concept') && !el.hidden) reload(); },
    destroy() { reqId++; reloadSoon.cancel(); el.remove(); },
  };
}

/* ===================================================================== Concept page */
export function createConceptPage(host) {
  let slug = null;
  let data = null; // { concept, tasks }
  let status = 'idle'; // idle | loading | ready | missing | error
  let errMsg = '';
  let reqId = 0;
  let loadedSig = '';
  let starting = false;
  let renaming = false;
  let mergeOpen = false;
  let mergeTarget = null;
  let mergeList = null;
  let aliasAdding = false;
  startTicker();

  const back = h('button', { class: 'link-btn cp-back', type: 'button', onclick: () => navigate('learn', ['concepts']) }, icon('chevronLeft', 14), 'All concepts');
  const nameH = h('h2', { class: 'cp-name' });
  const nameInput = h('input', { class: 'composer-input cp-name-input', type: 'text', maxlength: '60', 'aria-label': 'Concept name', hidden: true,
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); } else if (e.key === 'Escape') { e.preventDefault(); renaming = false; paintHead(); } } });
  const pinBtn = h('button', { class: 'btn btn-sm cp-pin', type: 'button', onclick: () => togglePin() }, icon('bookmark', 14), h('span', {}, 'Pin'));
  const renameBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => startRename() }, icon('pencil', 14), 'Rename');
  const mergeBtn = h('button', { class: 'btn btn-sm', type: 'button', 'aria-expanded': 'false', onclick: () => toggleMerge() }, icon('branch', 14), 'Merge into…');
  const metaEl = h('div', { class: 'cp-meta mono' });
  const aliasRow = h('div', { class: 'cp-aliases tags' });
  const head = h('header', { class: 'cp-head' },
    h('div', { class: 'cp-title-row' }, nameH, nameInput, h('span', { class: 'spacer' }), pinBtn, renameBtn, mergeBtn),
    metaEl, aliasRow);

  // merge picker
  const mergeFilter = h('input', { class: 'composer-input', type: 'text', placeholder: 'Find the concept to merge into…', 'aria-label': 'Merge target', autocomplete: 'off', spellcheck: 'false', oninput: () => paintMerge() });
  const mergeResults = h('div', { class: 'cp-merge-list', role: 'listbox', 'aria-label': 'Concepts' });
  const mergeConfirmText = h('span', { class: 'cp-merge-text' });
  const mergeGo = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => doMerge() }, 'Merge');
  const mergeNo = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { mergeTarget = null; paintMerge(); } }, 'Back');
  const mergeConfirm = h('div', { class: 'cp-merge-confirm', hidden: true }, mergeConfirmText, mergeGo, mergeNo);
  const mergePanel = h('section', { class: 'cp-merge', hidden: true, 'aria-label': 'Merge concept' },
    h('p', { class: 'cp-merge-hint' }, 'Merging moves every task, alias and the pin into the concept you pick. Future recaps with this name land there too.'),
    mergeFilter, mergeResults, mergeConfirm);

  // summary
  const sumBtnLabel = h('span', {}, 'Write the page');
  const sumBtn = h('button', { class: 'btn btn-accent btn-sm', type: 'button', onclick: () => writePage() }, icon('sparkle', 14), sumBtnLabel);
  const sumHint = h('span', { class: 'cp-sum-hint' });
  const sumBusy = h('div', { class: 'job-line', role: 'status', hidden: true }, h('span', { class: 'job-text' }, 'Haiku is writing…'));
  const sumFailMsg = h('span', { class: 'job-fail-msg' });
  const sumFail = h('div', { class: 'job-failed', role: 'alert', hidden: true }, icon('warning', 14), sumFailMsg, h('button', { class: 'link-btn', type: 'button', onclick: () => writePage() }, 'Retry'));
  const sumBody = h('div', { class: 'cp-sum-body' });
  const sumEmpty = h('p', { class: 'cp-sum-empty' }, 'No page for this concept yet. Haiku can write one from what your recaps say you learned: what it is, how you used it, pitfalls, and where to go deeper.');
  const summary = h('section', { class: 'cp-sum', 'aria-label': 'Concept page' },
    h('header', { class: 'cp-sec-head' }, h('h3', { class: 'section-title' }, icon('sparkle', 14), 'The page'), sumHint, h('span', { class: 'spacer' }), sumBtn),
    sumBusy, sumFail, sumEmpty, sumBody);

  // timeline
  const tlTitle = h('h3', { class: 'section-title' }, icon('clock', 14), 'Where you learned it');
  const tl = h('ol', { class: 'cp-tl' });
  const timeline = h('section', { class: 'cp-tlwrap', 'aria-label': 'Where you learned it' }, tlTitle, tl);

  // related
  const relRow = h('div', { class: 'tags cp-rel-row' });
  const related = h('section', { class: 'cp-related', 'aria-label': 'Related concepts' }, h('h3', { class: 'section-title' }, icon('threads', 14), 'Related concepts'), relRow);

  const msg = h('div', { class: 'cp-msg', hidden: true });
  const el = h('div', { class: 'cp', hidden: true }, back, msg, head, mergePanel, summary, timeline, related);
  host.appendChild(el);

  const offPrefs = onPrefs((k) => { if (k === 'code' || k === 'codestyle') { sumBody.__sig = null; paintSummary(); } });

  /* ---------- data ---------- */
  async function load(force) {
    if (!slug) return;
    const my = ++reqId;
    if (!data || data.concept.slug !== slug && !(data.concept.aliases || []).includes(slug)) { status = 'loading'; paint(); }
    try {
      const res = await api.concept(slug);
      if (my !== reqId) return;
      data = res;
      status = 'ready';
      loadedSig = sigOf(res.concept);
      if (res.concept.slug !== slug) { slug = res.concept.slug; setArgs(['c', slug], { replace: true }); } // reached through an alias
    } catch (e) {
      if (my !== reqId) return;
      if (e.status === 404) { status = 'missing'; data = null; } else { status = 'error'; errMsg = e.message; }
    }
    paint();
  }
  const sigOf = (c) => [c.count, c.lastSeenAt, c.summaryAt, c.name, c.pinned, (c.aliases || []).join(','), (c.related || []).join(',')].join('|');
  const loadSoon = debounce(() => load(), 250);

  function job() { return data ? sel.conceptJob(data.concept.slug) : null; }

  /* ---------- actions ---------- */
  async function writePage() {
    if (!data || starting) return;
    starting = true; paintSummary();
    await summarizeConcept(data.concept.slug);
    starting = false; paintSummary();
  }
  async function togglePin() {
    if (!data) return;
    const c = data.concept;
    const was = c.pinned;
    c.pinned = !was; paintHead();
    const done = await patchConcept(c.slug, { pinned: !was });
    if (!done) { c.pinned = was; paintHead(); }
  }
  function startRename() {
    if (!data) return;
    renaming = true; paintHead();
    nameInput.value = data.concept.name;
    nameInput.focus(); nameInput.select();
  }
  async function commitRename() {
    const v = nameInput.value.trim();
    renaming = false;
    if (!data || !v || v === data.concept.name) { paintHead(); return; }
    const done = await patchConcept(data.concept.slug, { name: v }, 'Could not rename');
    if (done) { data.concept.name = done.name; loadedSig = sigOf(data.concept); }
    paintHead();
  }
  async function setAliases(next) {
    if (!data) return;
    const done = await patchConcept(data.concept.slug, { aliases: next }, 'Could not change aliases');
    if (done) { data.concept.aliases = done.aliases; loadedSig = sigOf(data.concept); }
    aliasAdding = false;
    paintHead();
  }
  function toggleMerge() {
    mergeOpen = !mergeOpen;
    mergeTarget = null;
    mergeFilter.value = '';
    paintMerge();
    if (mergeOpen) {
      mergeFilter.focus();
      api.concepts(undefined, 'name').then((r) => { mergeList = r.concepts || []; paintMerge(); }).catch(() => { mergeList = sel.concepts({ by: 'name' }); paintMerge(); });
    }
  }
  async function doMerge() {
    if (!data || !mergeTarget) return;
    const from = data.concept.slug, into = mergeTarget.slug;
    mergeGo.disabled = true;
    const done = await mergeConcepts(from, into);
    mergeGo.disabled = false;
    if (done) { mergeOpen = false; mergeTarget = null; slug = done.slug; setArgs(['c', done.slug], { replace: true }); load(true); }
  }

  /* ---------- painting ---------- */
  function paintHead() {
    const c = data && data.concept;
    if (!c) return;
    setText(nameH, c.name);
    setHidden(nameH, renaming);
    setHidden(nameInput, !renaming);
    setHidden(renameBtn, renaming);
    setText(pinBtn.lastChild, c.pinned ? 'Pinned' : 'Pin');
    setClass(pinBtn, 'on', c.pinned);
    pinBtn.setAttribute('aria-pressed', String(c.pinned));
    mergeBtn.setAttribute('aria-expanded', String(mergeOpen));
    const bits = [plural(c.count, 'task'), `first seen ${fmtDate(c.firstSeenAt)}`];
    metaEl.textContent = '';
    metaEl.append(bits.join(' · '), ' · last seen ', h('span', { 'data-ago': c.lastSeenAt }, fmtAgo(c.lastSeenAt)));
    aliasRow.textContent = '';
    aliasRow.append(h('span', { class: 'cp-alias-label' }, 'Also called'));
    for (const a of c.aliases || []) {
      aliasRow.append(h('span', { class: 'tag cp-alias' }, a,
        h('button', { class: 'cp-alias-x', type: 'button', 'aria-label': `Remove alias ${a}`, title: 'Remove alias', onclick: () => setAliases(c.aliases.filter((x) => x !== a)) }, icon('close', 10))));
    }
    if (aliasAdding) {
      const inp = h('input', { class: 'composer-input cp-alias-input', type: 'text', maxlength: '60', placeholder: 'another name', 'aria-label': 'New alias',
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); const v = inp.value.trim(); if (v) setAliases([...c.aliases, v]); else { aliasAdding = false; paintHead(); } }
          else if (e.key === 'Escape') { e.preventDefault(); aliasAdding = false; paintHead(); }
        } });
      aliasRow.append(inp);
      setTimeout(() => inp.focus(), 0);
    } else {
      aliasRow.append(h('button', { class: 'tag cp-alias-add', type: 'button', onclick: () => { aliasAdding = true; paintHead(); } }, icon('plus', 12), (c.aliases || []).length ? 'alias' : 'Add an alias'));
    }
  }

  function paintMerge() {
    setHidden(mergePanel, !mergeOpen);
    if (!mergeOpen || !data) return;
    const own = data.concept.slug;
    setHidden(mergeResults, !!mergeTarget);
    setHidden(mergeFilter, !!mergeTarget);
    setHidden(mergeConfirm, !mergeTarget);
    if (mergeTarget) {
      setText(mergeConfirmText, `Merge “${data.concept.name}” (${plural(data.concept.count, 'task')}) into “${mergeTarget.name}”? This cannot be undone.`);
      return;
    }
    const n = mergeFilter.value.trim().toLowerCase();
    const pool = (mergeList || sel.concepts({ by: 'name' })).filter((c) => c.slug !== own)
      .filter((c) => !n || [c.name, c.slug, ...(c.aliases || [])].some((v) => String(v).toLowerCase().includes(n)));
    mergeResults.textContent = '';
    for (const c of pool.slice(0, 8)) {
      mergeResults.append(h('button', { class: 'menu-item cp-merge-item', type: 'button', role: 'option', onclick: () => { mergeTarget = c; paintMerge(); } },
        h('span', { class: 'menu-label' }, c.name, h('span', { class: 'menu-sub' }, plural(c.count, 'task')))));
    }
    if (!pool.length) mergeResults.append(h('p', { class: 'cp-merge-none' }, mergeList ? 'No other concept matches.' : 'Loading…'));
  }

  function paintSummary() {
    const c = data && data.concept;
    if (!c) return;
    const j = job();
    const busy = starting || (!!j && (j.state === 'queued' || j.state === 'running'));
    const recentFail = !!j && j.state === 'failed' && Date.now() - (j.doneAt || j.createdAt || 0) < 30 * 60 * 1000 && (j.createdAt || 0) > (c.summaryAt || 0);
    const failed = !busy && recentFail;
    const has = !!(c.summary && c.summary.trim());
    setHidden(sumBusy, !busy);
    setHidden(sumFail, !failed);
    if (failed) setText(sumFailMsg, j.error ? `Couldn’t write the page: ${j.error}` : 'Couldn’t write the page.');
    sumBtn.disabled = busy;
    setText(sumBtnLabel, busy ? 'Writing…' : has ? 'Rewrite' : 'Write the page');
    setClass(sumBtn, 'btn-accent', !has || busy);
    setHidden(sumEmpty, has || busy);
    setHidden(sumBody, !has);
    setClass(sumBody, 'stale', busy);
    setText(sumHint, !has && c.needsSummary && !busy ? `Seen in ${c.count} tasks: worth a page` : has && c.summaryAt ? `written ${fmtAgo(c.summaryAt)}` : '');
    if (!has) { sumBody.__sig = null; sumBody.textContent = ''; return; }
    const code = codeOn();
    const sig = [code, code ? getPref('codestyle') : '', c.summary, taskLinker.sig(c.summary)].join('\u0001');
    if (sumBody.__sig === sig) return;
    sumBody.__sig = sig;
    sumBody.textContent = '';
    setClass(sumBody, 'cp-code', code);
    if (code) sumBody.append(docBlock(c.summary, getPref('codestyle'), c.name, c.slug));
    else { sumBody.__md = null; setMarkdown(sumBody, c.summary, taskLinker); }
  }

  function paintTimeline() {
    const tasks = (data && data.tasks) || [];
    setText(tlTitle.lastChild, `Where you learned it · ${tasks.length}`);
    const sig = tasks.map((t) => [t.id, t.title, t.what, t.how, t.learned, t.doneAt, t.at].join('\u0001')).join('\u0002') + '|' + [...tasks.map((t) => (state.tasks.has(t.id) ? 1 : 0))].join('');
    if (tl.__sig === sig) return;
    tl.__sig = sig;
    tl.textContent = '';
    if (!tasks.length) { tl.append(h('li', { class: 'cp-tl-none' }, 'No task teaches this concept right now.')); return; }
    for (const t of tasks) {
      const chip = taskChip(t.id) || h('button', { class: 'task-chip mono', type: 'button', onclick: () => openTask(t.id) }, t.id);
      const when = t.doneAt || t.at;
      const rows = [['What', t.what], ['How', t.how], ['Learned', t.learned]].filter(([, v]) => v);
      tl.append(h('li', { class: 'cp-tl-item' },
        h('span', { class: 'cp-tl-dot', 'aria-hidden': 'true' }),
        h('div', { class: 'cp-tl-card' },
          h('div', { class: 'cp-tl-head' }, chip, h('span', { class: 'cp-tl-title' }, t.title), h('span', { class: 'spacer' }),
            h('span', { class: 'cp-tl-when mono', title: new Date(when).toLocaleString() }, fmtDay(when))),
          rows.map(([k, v]) => h('div', { class: 'recap-row' + (k === 'Learned' ? ' learned' : '') }, h('div', { class: 'recap-label' }, k), h('p', { class: 'recap-text' }, v))))));
    }
  }

  function paintRelated() {
    const c = data && data.concept;
    const rel = (c && c.related) || [];
    setHidden(related, rel.length === 0);
    relRow.textContent = '';
    for (const s of rel) relRow.append(h('button', { class: 'tag', type: 'button', onclick: () => openConcept(s) }, icon('tag', 12), nameOf(s)));
  }

  function paint() {
    const ok = status === 'ready' && !!data;
    setHidden(msg, ok || status === 'idle');
    for (const x of [head, summary, timeline]) setHidden(x, !ok);
    if (!ok) {
      setHidden(mergePanel, true);
      setHidden(related, true);
      msg.textContent = '';
      if (status === 'loading') msg.append(h('p', { class: 'dim' }, 'Loading…'));
      else if (status === 'missing') msg.append(emptyState({ iconName: 'tag', title: 'No such concept', body: 'It may have been merged into another one, or none of its recaps use it any more.', action: { label: 'See all concepts', onClick: () => navigate('learn', ['concepts']) } }));
      else if (status === 'error') msg.append(h('div', { class: 'banner banner-red' }, icon('warning', 15), h('span', {}, `Couldn’t load the concept: ${errMsg}`), h('button', { class: 'link-btn', type: 'button', onclick: () => load(true) }, 'Retry')));
      return;
    }
    paintHead();
    paintMerge();
    paintSummary();
    paintTimeline();
    paintRelated();
  }

  return {
    el,
    show(newSlug) {
      setHidden(el, false);
      if (newSlug !== slug) {
        slug = newSlug; data = null; status = 'loading'; renaming = false; mergeOpen = false; mergeTarget = null; aliasAdding = false; loadedSig = '';
        sumBody.__sig = null; tl.__sig = null;
        paint();
        load(true);
      } else if (status !== 'ready') load(true);
    },
    hide() { setHidden(el, true); },
    update(changed) {
      if (el.hidden || !slug) return;
      if (changed.has('job') || changed.has('task')) { paintSummary(); if (changed.has('task')) paintTimeline(); }
      if (changed.has('concept') && data) {
        const live = state.concepts.get(data.concept.slug);
        if (live && sigOf(live) !== loadedSig) loadSoon();
        else if (!live && status === 'ready') loadSoon(); // merged away or dropped elsewhere
      }
      if (changed.has('job')) { const j = job(); if (j && j.state === 'done' && (!data.concept.summaryAt || (j.doneAt || 0) > data.concept.summaryAt)) loadSoon(); }
    },
    destroy() { reqId++; loadSoon.cancel(); offPrefs(); el.remove(); },
  };
}

