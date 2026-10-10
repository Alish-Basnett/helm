// views/learn.js — concept pills, "today" strip, recap cards (What · How · Learned).
import { h, reconcile, setText, setClass, setHidden, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, upsert } from '../store.js';
import { api } from '../api.js';
import { generateDigest } from '../actions.js';
import { fmtAgo, fmtDay, startOfToday, truncate } from '../format.js';
import { emptyState } from '../ui.js';
import { setMarkdown } from '../markdown.js';
import { createExplain } from '../explain.js';
import { openTask, setArgs, navigate, route } from '../router.js';

const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** 'YYYY-MM-DD' (local) → Date at local midnight. */
function parseDay(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function mount(container) {
  let data = null; // concepts[]
  let error = null;
  let loading = true;
  let concept = route().query.get('concept') || null;
  let reqId = 0;
  let timer = null;
  let lastScope = state.ui.projectId;
  const recapSig = () => Array.from(state.tasks.values()).filter((x) => x.recap).map((x) => x.id + ':' + (x.recap.what || '').length + ':' + (x.recap.concepts || []).length).sort().join(',');
  let lastSig = recapSig();
  startTicker();

  const pills = h('div', { class: 'pills', role: 'toolbar', 'aria-label': 'Concept filter' });
  const todayStrip = h('div', { class: 'today-strip' });
  const todayWrap = h('section', { class: 'today', 'aria-label': 'Learned today' },
    h('h2', { class: 'section-title' }, icon('sparkle', 14), 'Today'), todayStrip);
  const cards = h('div', { class: 'recap-grid' });
  const empty = h('div', { class: 'view-empty' }, emptyState({
    iconName: 'learn', title: 'Nothing learned yet',
    body: 'When a task finishes, Helm writes a short recap — what happened, how, and what you can take from it. They collect here, grouped by concept.',
  }));
  const err = h('div', { class: 'banner banner-red', hidden: true }, icon('warning', 15), h('span', {}), h('button', { class: 'link-btn', type: 'button', onclick: () => load() }, 'Retry'));

  /* ---------- daily digest (v0.2) ---------- */
  let digestSel = route().query.get('digest') || null; // selected digest id; null = latest in scope
  let starting = false;   // POST /v1/digest in flight
  let ownJobId = null;    // job started from this card
  let fetchedMissing = false;
  const dgDate = h('span', { class: 'dg-date mono' });
  const dgScope = h('span', { class: 'dg-scope' });
  const dgBtnLabel = h('span', {}, 'Generate today’s digest');
  const dgBtn = h('button', { class: 'btn btn-accent btn-sm', type: 'button', onclick: () => startDigest() }, icon('sparkle', 14), dgBtnLabel);
  const dgBusy = h('div', { class: 'job-line', role: 'status', hidden: true }, h('span', { class: 'job-text' }, 'Haiku is writing…'));
  const dgFailMsg = h('span', { class: 'job-fail-msg' });
  const dgFail = h('div', { class: 'job-failed', role: 'alert', hidden: true }, icon('warning', 14), dgFailMsg, h('button', { class: 'link-btn', type: 'button', onclick: () => startDigest() }, 'Retry'));
  const dgBody = h('div', { class: 'dg-body' });
  const dgNone = h('p', { class: 'dg-none' }, 'No digest yet for this scope. Generate one and it will summarise what shipped, what is blocked, and what you can learn from it.');
  const dgDates = h('div', { class: 'dg-dates', role: 'toolbar', 'aria-label': 'Digest dates' });
  const dgPrev = h('div', { class: 'dg-prev' }, h('span', { class: 'dg-prev-label' }, 'Previous'), dgDates);
  const digestCard = h('section', { class: 'digest-card', 'aria-label': 'Daily digest' },
    h('header', { class: 'dg-head' }, icon('calendar', 16), h('h2', { class: 'dg-title' }, 'Daily digest'), dgDate, dgScope, h('span', { class: 'spacer' }), dgBtn),
    dgBusy, dgFail, dgBody, dgNone, dgPrev);

  const scopeProjectId = () => (state.ui.projectId === 'all' ? null : state.ui.projectId);
  function currentDigest() {
    if (digestSel && state.digests.has(digestSel)) return state.digests.get(digestSel);
    return sel.digestsFor(state.ui.projectId)[0] || null;
  }
  async function loadDigests() {
    try {
      const res = await api.digests(scopeProjectId() || undefined, 14);
      for (const d of (res && res.digests) || []) upsert('digest', d);
    } catch { /* older hub: the store copy is all we have */ }
  }
  async function startDigest() {
    if (starting) return;
    starting = true;
    ownJobId = null;
    renderDigest();
    const job = await generateDigest({ projectId: scopeProjectId() });
    starting = false;
    if (job) ownJobId = job.id;
    renderDigest();
  }
  function renderDigest() {
    const list = sel.digestsFor(state.ui.projectId);
    const cur = currentDigest();
    setText(dgScope, scopeProjectId() ? sel.projectName(scopeProjectId()) : 'All projects');
    // job state
    const pid = scopeProjectId();
    const job = (ownJobId && state.jobs.get(ownJobId)) || sel.digestJob(pid);
    const busy = starting || (!!job && (job.state === 'queued' || job.state === 'running'));
    const recent = job && Date.now() - (job.doneAt || job.createdAt || 0) < 30 * 60 * 1000;
    const failed = !busy && !!job && job.state === 'failed' && recent && (!cur || (job.createdAt || 0) > (cur.createdAt || 0));
    setHidden(dgBusy, !busy);
    setHidden(dgFail, !failed);
    if (failed) setText(dgFailMsg, job.error ? `Couldn’t write the digest: ${job.error}` : 'Couldn’t write the digest.');
    const today = localDate();
    const haveToday = list.some((d) => d.date === today);
    dgBtn.disabled = busy;
    setText(dgBtnLabel, busy ? 'Writing…' : haveToday ? 'Regenerate today’s digest' : 'Generate today’s digest');
    // body
    setHidden(dgBody, !cur);
    setHidden(dgNone, !!cur);
    if (cur) {
      const day = parseDay(cur.date);
      setText(dgDate, day ? day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : cur.date);
      setMarkdown(dgBody, cur.text);
    } else setText(dgDate, '');
    // dates
    setHidden(dgPrev, list.length < 2);
    reconcile(dgDates, list, (d) => d.id, (d) => h('button', { class: 'dg-date-chip mono', type: 'button' }), (b, d) => {
      const day = parseDay(d.date);
      setText(b, day ? fmtDay(day.getTime()) : d.date);
      b.title = day ? day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : d.date;
      const on = cur && cur.id === d.id;
      setClass(b, 'on', !!on);
      b.setAttribute('aria-pressed', String(!!on));
      b.onclick = () => { digestSel = d.id; renderDigest(); };
    });
    // a linked digest (from search) that is older than the store window: look for it once
    if (digestSel && !state.digests.has(digestSel) && !fetchedMissing) {
      fetchedMissing = true;
      api.digests(undefined, 60).then((res) => { for (const d of (res && res.digests) || []) upsert('digest', d); }).catch(() => {});
    }
  }

  const root = h('div', { class: 'learn' }, err, digestCard, pills, todayWrap, cards, empty);
  container.appendChild(root);

  async function load() {
    const my = ++reqId;
    loading = true;
    try {
      const pid = state.ui.projectId === 'all' ? undefined : state.ui.projectId;
      const res = await api.learn(pid);
      if (my !== reqId) return;
      data = res.concepts || [];
      error = null;
    } catch (e) {
      if (my !== reqId) return;
      error = e.message;
    }
    loading = false;
    render();
  }

  // Collapse concept groups into one entry per task.
  function recaps() {
    const m = new Map();
    for (const c of data || []) {
      for (const r of c.recaps || []) {
        let e = m.get(r.taskId);
        if (!e) { e = { ...r, concepts: new Set() }; m.set(r.taskId, e); }
        e.concepts.add(c.name);
      }
    }
    return Array.from(m.values()).sort((a, b) => b.at - a.at);
  }

  function makeCard(r) {
    const title = h('h3', { class: 'recap-card-title' });
    const id = h('button', { class: 'task-chip mono', type: 'button' });
    const when = h('span', { class: 'recap-when mono' });
    const body = h('div', { class: 'recap' });
    const tags = h('div', { class: 'tags' });
    const explain = createExplain({ getTask: () => state.tasks.get(el.__taskId) || null });
    const el = h('article', { class: 'recap-card' }, h('header', { class: 'recap-card-head' }, title, h('div', { class: 'recap-card-sub' }, id, when)), body, explain.el, tags);
    el.__r = { title, id, when, body, tags, explain };
    return el;
  }
  function updateCard(el, r) {
    const x = el.__r;
    el.__taskId = r.taskId;
    x.explain.update();
    setText(x.title, r.title);
    setText(x.id, r.taskId);
    x.id.onclick = () => openTask(r.taskId);
    x.when.setAttribute('data-ago', r.at);
    setText(x.when, fmtAgo(r.at));
    const sig = [r.what, r.how, r.learned].join('\u0001');
    if (x.body.__sig !== sig) {
      x.body.__sig = sig;
      x.body.textContent = '';
      for (const [k, v] of [['What', r.what], ['How', r.how], ['Learned', r.learned]]) {
        x.body.append(h('div', { class: 'recap-row' + (k === 'Learned' ? ' learned' : '') }, h('div', { class: 'recap-label' }, k), h('p', { class: 'recap-text' }, v || '—')));
      }
    }
    const names = Array.from(r.concepts);
    const tsig = names.join('|') + '|' + concept;
    if (x.tags.__sig !== tsig) {
      x.tags.__sig = tsig;
      x.tags.textContent = '';
      names.forEach((n) => x.tags.append(h('button', { class: 'tag' + (n === concept ? ' on' : ''), type: 'button', onclick: () => setConcept(n === concept ? null : n) }, icon('tag', 12), n)));
    }
  }

  function setConcept(c) {
    concept = c;
    const q = {};
    if (c) q.concept = c;
    navigate('learn', [], q, { replace: true });
    render();
  }

  function render() {
    const all = recaps();
    const counts = (data || []).map((c) => ({ name: c.name, count: c.count ?? (c.recaps || []).length })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    setHidden(err, !error);
    setText(err.children[1], error ? `Couldn't load recaps: ${error}` : '');
    // pills
    const pillItems = [{ name: null, label: 'All', count: all.length }, ...counts.map((c) => ({ name: c.name, label: c.name, count: c.count }))];
    reconcile(pills, pillItems, (p) => p.name || '__all', (p) => {
      const b = h('button', { class: 'pill', type: 'button' }, h('span', { class: 'pill-label' }), h('span', { class: 'pill-count mono' }));
      return b;
    }, (b, p) => {
      b.onclick = () => setConcept(p.name);
      setText(b.firstChild, p.label);
      setText(b.lastChild, String(p.count));
      setClass(b, 'on', (concept || null) === p.name);
      b.setAttribute('aria-pressed', String((concept || null) === p.name));
    });
    setHidden(pills, !data || all.length === 0);
    // today strip
    const t0 = startOfToday();
    const today = all.filter((r) => r.at >= t0);
    setHidden(todayWrap, !data || all.length === 0);
    reconcile(todayStrip, today, (r) => r.taskId, (r) => {
      const b = h('button', { class: 'today-chip', type: 'button' }, h('div', { class: 'today-title' }), h('div', { class: 'today-what' }), h('div', { class: 'today-meta mono' }));
      return b;
    }, (b, r) => {
      b.onclick = () => openTask(r.taskId);
      setText(b.children[0], r.title);
      setText(b.children[1], truncate(r.learned || r.what || '', 110));
      setText(b.children[2], `${r.taskId} · ${fmtAgo(r.at)}`);
    });
    todayStrip.dataset.empty = 'Nothing learned yet today';
    // cards
    const filtered = concept ? all.filter((r) => r.concepts.has(concept)) : all;
    reconcile(cards, filtered, (r) => r.taskId, makeCard, updateCard);
    setHidden(cards, filtered.length === 0);
    setHidden(empty, loading || !!error || all.length > 0 || !state.ready);
  }

  load();
  loadDigests();
  render();
  renderDigest();

  return {
    watch: ['task', 'ui', 'digest', 'job'],
    update(changed) {
      if (state.ui.projectId !== lastScope) { lastScope = state.ui.projectId; digestSel = null; load(); loadDigests(); renderDigest(); return; }
      if (changed.has('digest') || changed.has('job')) renderDigest();
      if ((changed.has('task') || changed.has('job')) && cards.__keyed) for (const el of cards.__keyed.values()) el.__r.explain.update();
      if (changed.has('task')) {
        const sig = recapSig();
        if (sig !== lastSig) { lastSig = sig; clearTimeout(timer); timer = setTimeout(load, 700); }
      }
    },
    setRoute(r) {
      const c = r.query.get('concept') || null;
      if (c !== concept) { concept = c; render(); }
      const d = r.query.get('digest') || null;
      if (d !== digestSel) { digestSel = d; fetchedMissing = false; renderDigest(); }
    },
    destroy() { clearTimeout(timer); reqId++; root.remove(); },
  };
}
