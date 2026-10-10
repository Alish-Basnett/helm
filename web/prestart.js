// prestart.js — "Add details before starting": draft notes that ride along with Start (v0.8).
// A single-line box (grows to 4 lines) adds a draft note on the task; below it the pending drafts are listed with
// edit and remove. The hub folds them into the start note and marks them ran. Same drafts as the task chat.
import { h, setText, setHidden, setClass, reconcile } from './dom.js';
import { icon } from './icons.js';
import { state, subscribe } from './store.js';
import { addNote, editNote, deleteNote, startDrafts, canStart } from './actions.js';
import { bindDraft, clearDraft } from './drafts.js';
import { codeOn, getPref, onPrefs } from './prefs.js';
import { codeEditor, composerView, renderCodeBlock, stringDecl, varName } from './code.js';

const MAX_LINES = 4;

export function createPreStart({ taskId }) {
  const ta = h('textarea', {
    class: 'prestart-input', rows: '1', 'aria-label': 'Add details before starting',
    placeholder: 'Add details before starting…', spellcheck: 'true',
  });
  bindDraft(ta, `prestart:${taskId}`);
  const editor = codeEditor(ta, { view: (v, st, el) => composerView(v, st, el.getAttribute('placeholder') || '') });
  const hint = h('span', { class: 'prestart-keys mono' }, '↵ add · ⇧↵ new line');
  const title = h('div', { class: 'prestart-title' });
  const list = h('ul', { class: 'prestart-list', 'aria-label': 'Notes sent with Start' });
  const listWrap = h('div', { class: 'prestart-pending', hidden: true }, title, list);
  const el = h('section', { class: 'sheet-section prestart', hidden: true }, editor.el, hint, listWrap);

  function autosize() {
    ta.style.height = 'auto';
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.style.height = Math.min(ta.scrollHeight, lh * MAX_LINES + 14) + 'px';
  }
  async function submit() {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    clearDraft(`prestart:${taskId}`);
    autosize();
    editor.sync();
    const made = await addNote({ kind: 'task', id: taskId }, text);
    if (!made && !ta.value) { ta.value = text; autosize(); editor.sync(); }
  }
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    e.preventDefault();
    submit();
  });

  function makeRow(n) {
    const text = h('div', { class: 'prestart-text' });
    const code = h('div', { class: 'prestart-code' });
    const edit = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Edit note', title: 'Edit', onclick: () => beginEdit(row) }, icon('pencil', 14));
    const del = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Remove note', title: 'Remove', onclick: () => deleteNote(row.__id) }, icon('trash', 14));
    const row = h('li', { class: 'prestart-note' }, h('div', { class: 'prestart-body' }, text, code), h('div', { class: 'note-actions' }, edit, del));
    row.__text = text; row.__code = code; row.__id = n.id; row.__editing = false;
    text.addEventListener('click', () => { if (!getSelection().toString()) beginEdit(row); });
    return row;
  }
  function beginEdit(row) {
    const n = row.__note;
    if (!n || row.__editing) return;
    row.__editing = true;
    const input = h('textarea', { class: 'note-edit', rows: '2', 'aria-label': 'Edit note' });
    input.value = n.text;
    const host = codeOn() ? row.__code : row.__text;
    const ed = codeEditor(input, { view: (v, st) => composerView(v, st, '', varName(n.id)) });
    host.hidden = true;
    host.after(ed.el);
    ed.sync();
    const done = (save) => {
      if (!row.__editing) return;
      row.__editing = false;
      const v = input.value;
      ed.destroy();
      ed.el.remove();
      host.hidden = false;
      if (save && v.trim() && v.trim() !== n.text) editNote(n.id, v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); done(true); }
    });
    input.addEventListener('blur', () => done(true));
    input.focus();
  }
  function updateRow(row, n) {
    row.__note = n;
    row.__id = n.id;
    if (row.__editing) return;
    const asCode = codeOn();
    setHidden(row.__text, asCode);
    setHidden(row.__code, !asCode);
    setClass(row, 'pending', !!n.__pending);
    if (asCode) {
      const style = getPref('codestyle');
      const sig = `${style}|${n.text}`;
      if (row.__code.__sig !== sig) { row.__code.__sig = sig; row.__code.textContent = ''; row.__code.append(renderCodeBlock(stringDecl(varName(n.id), n.text, style), style)); }
    } else setText(row.__text, n.text);
  }

  function update() {
    const t = state.tasks.get(taskId);
    const show = !!t && canStart(t);
    setHidden(el, !show);
    const drafts = startDrafts(taskId);
    setHidden(listWrap, drafts.length === 0);
    setText(title, `Will be sent with Start (${drafts.length} note${drafts.length === 1 ? '' : 's'})`);
    reconcile(list, drafts, (n) => n.id, makeRow, updateRow);
  }
  const off = subscribe((changed) => { if (changed.has('note') || changed.has('task')) update(); });
  const offPrefs = onPrefs((k) => { if (k === 'code' || k === 'codestyle') update(); });
  update();
  autosize();
  return { el, update, focus: () => ta.focus(), destroy() { off(); offPrefs(); editor.destroy(); } };
}
