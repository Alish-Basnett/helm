// choices.js — v0.6: the "Choices" card. An agent's plan-style output becomes a tick-to-run checklist:
// tick what you want, then "Create & start selected" makes one linked task per tick and starts each.
import { h, setText, setClass, setHidden, setAttr, reconcile } from './dom.js';
import { icon } from './icons.js';
import { state, sel } from './store.js';
import { applyChoices, resetChoices } from './actions.js';
import { taskChip } from './tasklinks.js';
import { plural } from './format.js';

const EFFORT = { S: 'Small', M: 'Medium', L: 'Large' };
const VALUE = { low: 'Low value', medium: 'Medium value', high: 'High value' };

// Ticks survive the details panel being rebuilt (switching tasks and back).
const ticks = new Map(); // taskId -> Set(choice id)
const tickSet = (id) => { let s = ticks.get(id); if (!s) ticks.set(id, (s = new Set())); return s; };

// Quick notes (per choice) and the message that goes out with the send: a per-task draft kept in memory and localStorage.
const DRAFT_KEY = 'helm.choiceDrafts';
const NOTE_MAX = 500, MSG_MAX = 1000;
const drafts = (() => { try { const v = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } })();
const draftOf = (id) => (drafts[id] ||= { notes: {}, message: '' });
function saveDrafts() {
  for (const k of Object.keys(drafts)) if (!drafts[k].message && !Object.values(drafts[k].notes).some(Boolean)) delete drafts[k];
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch { /* storage unavailable: memory only */ }
}
const noteOpen = new Map(); // taskId -> Set(choice id) whose note editor is expanded
const openSet = (id) => { let s = noteOpen.get(id); if (!s) noteOpen.set(id, (s = new Set())); return s; };
function grow(ta) { ta.style.height = 'auto'; if (ta.scrollHeight) ta.style.height = `${Math.min(ta.scrollHeight, 66)}px`; }

export function createChoices({ getTask }) {
  const c = {};
  let busy = false;

  c.count = h('span', { class: 'choices-count' });
  c.sub = h('span', { class: 'choices-sub' });
  c.all = h('button', { class: 'link-btn', type: 'button', onclick: () => setAll(true) }, 'Select all');
  c.none = h('button', { class: 'link-btn', type: 'button', onclick: () => setAll(false) }, 'None');
  c.reset = h('button', { class: 'link-btn', type: 'button', onclick: async () => { const t = getTask(); if (!t) return; busy = true; paint(); await resetChoices(t.id); busy = false; paint(); } }, 'Reset');
  c.tools = h('div', { class: 'choices-tools' }, c.all, h('span', { class: 'choices-sep', 'aria-hidden': 'true' }, '·'), c.none);
  c.list = h('ul', { class: 'choices-list', role: 'list' });
  c.go = h('button', { class: 'btn btn-primary btn-sm', type: 'button', title: 'Create a task for each ticked suggestion and start them (⌘↵)', onclick: () => run(true) });
  c.only = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', title: 'Create the tasks without starting them', onclick: () => run(false) }, 'Create only');
  c.hint = h('span', { class: 'choices-hint' }, 'Tick the ones you want');
  c.msg = h('input', { class: 'choices-msg', type: 'text', placeholder: 'Message with these…', maxlength: String(MSG_MAX), 'aria-label': 'Message sent with the selected choices', autocomplete: 'off' });
  c.msg.addEventListener('input', () => { const t = getTask(); if (!t) return; draftOf(t.id).message = c.msg.value; saveDrafts(); });
  c.act = h('div', { class: 'choices-actions' }, c.go, c.only, c.msg);
  c.foot = h('div', { class: 'choices-foot' }, c.act, c.hint);
  c.sent = h('p', { class: 'choices-sent', hidden: true });
  c.done = h('div', { class: 'choices-done' }, h('span', { class: 'choices-done-text' }), c.reset);

  c.el = h('section', { class: 'sheet-section choices-card', 'aria-label': 'Choices', hidden: true,
    onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); run(true); } } },
  h('h3', { class: 'choices-head' }, icon('checklist', 16), h('span', { class: 'choices-title' }, 'Choices'), c.count, c.sub),
  c.tools, c.sent, c.list, c.foot, c.done);

  function ticked(t) {
    const s = tickSet(t.id);
    const open = new Set(t.choices.filter((x) => x.state === 'open').map((x) => x.id));
    for (const id of Array.from(s)) if (!open.has(id)) s.delete(id);
    return s;
  }

  function setAll(on) {
    const t = getTask();
    if (!t) return;
    const s = tickSet(t.id);
    s.clear();
    if (on) for (const x of t.choices) if (x.state === 'open') s.add(x.id);
    paint();
  }

  async function run(start) {
    const t = getTask();
    if (!t || busy) return;
    const picked = t.choices.filter((x) => x.state === 'open' && ticked(t).has(x.id)).map((x) => x.id);
    if (!picked.length) return;
    busy = true; paint();
    const d = draftOf(t.id);
    const notes = {};
    for (const id of picked) { const n = (d.notes[id] || '').trim(); if (n) notes[id] = n.slice(0, NOTE_MAX); }
    const message = (d.message || '').trim().slice(0, MSG_MAX);
    const extra = {};
    if (Object.keys(notes).length) extra.notes = notes;
    if (message) extra.message = message;
    const res = await applyChoices(t.id, picked, start, extra);
    if (res) { tickSet(t.id).clear(); delete drafts[t.id]; noteOpen.delete(t.id); saveDrafts(); }
    busy = false; paint();
  }

  function makeRow(ch) {
    const r = {};
    r.cb = h('input', { type: 'checkbox', class: 'choice-cb', id: `choice-${Math.random().toString(36).slice(2, 9)}` });
    r.cb.addEventListener('change', () => {
      const t = getTask(); if (!t) return;
      const s = tickSet(t.id);
      if (r.cb.checked) s.add(r.cb.__id); else s.delete(r.cb.__id);
      paint();
    });
    r.title = h('label', { class: 'choice-title', for: r.cb.id });
    r.effort = h('span', { class: 'badge choice-badge effort' });
    r.value = h('span', { class: 'badge choice-badge value' });
    r.more = h('button', { class: 'choice-more', type: 'button', 'aria-expanded': 'false' }, icon('chevronDown', 14));
    r.state = h('span', { class: 'choice-state' });
    r.noteBtn = h('button', { class: 'choice-note-btn', type: 'button', 'aria-expanded': 'false' });
    r.noteBtn.addEventListener('click', () => {
      const t = getTask(); if (!t) return;
      const s = openSet(t.id), id = r.cb.__id;
      if (s.has(id)) s.delete(id); else s.add(id);
      paint();
      if (s.has(id)) r.note.focus();
    });
    r.note = h('textarea', { class: 'choice-note', rows: '1', placeholder: 'Quick note for this one…', maxlength: String(NOTE_MAX), 'aria-label': 'Quick note for this choice' });
    r.note.addEventListener('input', () => {
      const t = getTask(); if (!t) return;
      draftOf(t.id).notes[r.cb.__id] = r.note.value;
      grow(r.note); saveDrafts();
      setHidden(r.noteGlyph, !r.note.value.trim()); setClass(r.noteBtn, 'has', !!r.note.value.trim());
    });
    r.note.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) e.preventDefault(); if (e.key === 'Escape' && !r.note.value) { r.noteBtn.click(); r.noteBtn.focus(); e.stopPropagation(); } });
    r.noteGlyph = icon('note', 12);
    r.noteLabel = h('span', { class: 'choice-note-label' }, '＋ note');
    r.noteBtn.append(r.noteGlyph, r.noteLabel);
    r.sentNote = h('p', { class: 'choice-sent-note', hidden: true });
    r.chip = h('span', { class: 'choice-chip' });
    r.detail = h('p', { class: 'choice-detail', hidden: true });
    r.more.addEventListener('click', () => {
      const open = r.detail.hidden;
      setHidden(r.detail, !open);
      r.more.setAttribute('aria-expanded', String(open));
      setClass(r.more, 'open', open);
    });
    const el = h('li', { class: 'choice-row', role: 'listitem' },
      h('div', { class: 'choice-main' }, r.cb, r.title, r.effort, r.value, r.state, r.chip, r.noteBtn, r.more), r.sentNote, r.note, r.detail);
    el.__r = r;
    return el;
  }

  function updateRow(el, ch) {
    const r = el.__r;
    const t = getTask();
    const open = ch.state === 'open';
    r.cb.__id = ch.id;
    r.cb.checked = open ? tickSet(t.id).has(ch.id) : ch.state === 'picked';
    r.cb.disabled = !open || busy;
    setText(r.title, ch.title);
    setHidden(r.effort, !ch.effort);
    if (ch.effort) { setText(r.effort, ch.effort); r.effort.title = `${EFFORT[ch.effort]} effort`; setAttr(r.effort, 'aria-label', `${EFFORT[ch.effort]} effort`); }
    setHidden(r.value, !ch.value);
    if (ch.value) { setText(r.value, ch.value); r.value.className = `badge choice-badge value v-${ch.value}`; r.value.title = VALUE[ch.value]; setAttr(r.value, 'aria-label', VALUE[ch.value]); }
    setHidden(r.more, !ch.detail);
    setText(r.detail, ch.detail || '');
    r.more.setAttribute('aria-label', `Details for ${ch.title}`);
    const dn = open ? (draftOf(t.id).notes[ch.id] || '') : '';
    const hasNote = !!dn.trim();
    const expanded = open && (openSet(t.id).has(ch.id));
    // the note affordance shows for ticked rows, rows with a note, or an expanded editor (hover/focus reveals it in CSS)
    setHidden(r.noteBtn, !open);
    setClass(r.noteBtn, 'has', hasNote);
    setHidden(r.noteGlyph, !hasNote);
    setText(r.noteLabel, hasNote ? 'note' : '＋ note');
    r.noteBtn.setAttribute('aria-expanded', String(expanded));
    r.noteBtn.setAttribute('aria-label', `${hasNote ? 'Edit note' : 'Add a note'} for ${ch.title}`);
    setHidden(r.note, !expanded);
    if (expanded && r.note.value !== dn) { r.note.value = dn; }
    if (expanded) grow(r.note);
    setHidden(r.sentNote, !(ch.state === 'picked' && ch.note));
    setText(r.sentNote, ch.note || '');
    el.className = `choice-row s-${ch.state}${open && r.cb.checked ? ' ticked' : ''}${hasNote ? ' has-note' : ''}`;
    setHidden(r.state, ch.state !== 'skipped');
    setText(r.state, 'Skipped');
    // picked rows carry a chip to the created task
    const want = ch.state === 'picked' ? ch.taskId : null;
    if (r.chip.__for !== want) {
      r.chip.__for = want;
      r.chip.textContent = '';
      const chip = want ? taskChip(want) : null;
      if (chip) r.chip.append(chip);
      else if (want) r.chip.append(h('span', { class: 'mono choice-chip-id' }, want));
    }
  }

  function paint() {
    const t = getTask();
    if (!t || !t.choices.length) { setHidden(c.el, true); return; }
    setHidden(c.el, false);
    const total = t.choices.length;
    const nOpen = sel.openChoiceCount(t);
    const sel_ = ticked(t).size;
    setText(c.count, plural(total, 'suggestion'));
    setText(c.sub, nOpen ? '· tick what you want' : '· applied');
    reconcile(c.list, t.choices, (x) => x.id, makeRow, updateRow);
    const dm = draftOf(t.id).message || '';
    if (c.msg.value !== dm && document.activeElement !== c.msg) c.msg.value = dm;
    const sent = t.choices.find((x) => x.state === 'picked' && x.message);
    setHidden(c.sent, !(nOpen === 0 && sent));
    setText(c.sent, sent ? `Sent with: ${sent.message}` : '');
    setHidden(c.tools, nOpen === 0);
    setHidden(c.foot, nOpen === 0);
    setHidden(c.done, nOpen > 0);
    setClass(c.el, 'applied', nOpen === 0);
    if (nOpen === 0) {
      const picked = t.choices.filter((x) => x.state === 'picked').length;
      setText(c.done.firstChild, `${picked} created, ${total - picked} skipped.`);
    }
    c.go.textContent = '';
    c.go.append(icon('play', 13), `Create & start selected (${sel_})`);
    c.go.disabled = !sel_ || busy;
    c.only.disabled = !sel_ || busy;
    c.all.disabled = busy;
    c.none.disabled = busy || !sel_;
    c.msg.disabled = busy;
    setText(c.hint, sel_ ? `${sel_} of ${nOpen} ticked` : 'Tick the ones you want');
    c.reset.disabled = busy;
  }

  return { el: c.el, update: paint, focus() { const cb = c.list.querySelector('.choice-cb:not(:disabled)'); if (cb) cb.focus(); else c.el.scrollIntoView({ block: 'start' }); } };
}
