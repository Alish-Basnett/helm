// notes.js — reusable Notes panel (task or session target). Colour on text = state, nothing else.
import { h, reconcile, setText, setClass, setHidden, startTicker } from './dom.js';
import { icon } from './icons.js';
import { state, sel, subscribe } from './store.js';
import { createReply, createWaitLine } from './replies.js';
import { addNote, editNote, deleteNote, executeNotes, retryNote } from './actions.js';

const STATE_LABEL = { draft: 'Draft', queued: 'Queued', sending: 'Sending…', failed: 'Failed' };

/**
 * opts: { target:{kind,id}, mode:'notes'|'prompt', title, placeholder, disabled }
 * 'prompt' mode: Enter adds + executes immediately (scoped prompt box).
 */
export function createNotesPanel(opts) {
  const target = opts.target;
  const prompt = opts.mode === 'prompt';
  const title = opts.title || (prompt ? 'Prompt' : 'Notes');

  const countEl = h('span', { class: 'panel-count mono' });
  const execLabel = h('span', {}, 'Execute');
  const execBtn = h('button', {
    class: 'btn btn-accent btn-sm', type: 'button', disabled: true,
    title: 'Run all draft notes (⌘↵ in the box adds and runs one)',
    onclick: () => executeNotes(target),
  }, icon('play', 14), execLabel);
  const list = h('ul', { class: 'note-list', 'aria-label': title });
  const empty = h('div', { class: 'note-empty' }, prompt
    ? 'Prompts you send to this task appear here with their delivery state.'
    : 'No notes yet. Drafts stay grey until you run them.');
  const ta = h('textarea', {
    class: 'note-input', rows: '1', 'aria-label': opts.placeholder || (prompt ? 'Prompt this task' : 'Add a note'),
    placeholder: opts.placeholder || (prompt ? 'Prompt this task…' : 'Add a note…'),
    disabled: opts.disabled,
  });
  const hint = h('div', { class: 'note-hint mono' }, prompt ? '↵ send · ⇧↵ new line' : '↵ add draft · ⌘↵ add & run');
  const sendBtn = h('button', { class: 'icon-btn note-send', type: 'button', 'aria-label': prompt ? 'Send prompt' : 'Add note', title: prompt ? 'Send' : 'Add draft', onclick: () => submit(prompt), disabled: opts.disabled }, icon('send', 18));
  const composer = h('div', { class: 'note-composer' }, ta, sendBtn, hint);
  const el = h('section', { class: ['panel notes-panel', prompt && 'prompt-mode'], 'aria-label': title },
    h('header', { class: 'panel-head' },
      h('h3', { class: 'panel-title' }, icon(prompt ? 'send' : 'note', 15), title, countEl),
      prompt ? null : execBtn),
    list, empty, composer);

  function autosize() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  }
  async function submit(run) {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    autosize();
    const p = addNote(target, text, { execute: run });
    list.scrollTop = list.scrollHeight;
    await p;
  }
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    e.preventDefault();
    submit(prompt || e.metaKey || e.ctrlKey);
  });

  /* ----- note rows ----- */
  function makeRow(n) {
    const text = h('div', { class: 'note-text' });
    const meta = h('div', { class: 'note-meta mono' });
    const reply = createReply();
    const wait = createWaitLine();
    const body = h('div', { class: 'note-body' }, text, meta, reply.el, wait.el);
    const edit = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Edit note', title: 'Edit', onclick: () => beginEdit(row) }, icon('pencil', 14));
    const del = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Delete note', title: 'Delete', onclick: () => deleteNote(row.__id) }, icon('trash', 14));
    const actions = h('div', { class: 'note-actions' }, edit, del);
    const row = h('li', { class: 'note' }, body, actions);
    row.__text = text; row.__meta = meta; row.__reply = reply; row.__wait = wait; row.__actions = actions; row.__id = n.id; row.__editing = false;
    text.addEventListener('click', () => { if (row.__note.state === 'draft' && !getSelection().toString()) beginEdit(row); });
    return row;
  }

  function beginEdit(row) {
    const n = row.__note;
    if (!n || n.state !== 'draft' || row.__editing) return;
    row.__editing = true;
    const input = h('textarea', { class: 'note-edit', rows: '2', 'aria-label': 'Edit draft note' });
    input.value = n.text;
    row.__text.hidden = true;
    row.__text.after(input);
    const done = (save) => {
      if (!row.__editing) return;
      row.__editing = false;
      const v = input.value;
      input.remove();
      row.__text.hidden = false;
      if (save && v.trim() && v.trim() !== n.text) editNote(n.id, v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); done(true); }
    });
    input.addEventListener('blur', () => done(true));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function updateRow(row, n) {
    row.__note = n;
    row.__id = n.id;
    const cls = `note state-${n.state}`;
    if (row.className !== cls) row.className = cls;
    setClass(row, 'pending', !!n.__pending);
    if (!row.__editing) setText(row.__text, n.text);
    const meta = row.__meta;
    // rebuild meta only when its content signature changes
    const sig = `${n.state}|${n.ranAt}|${n.error || ''}|${n.via || ''}`;
    if (meta.__sig !== sig) {
      meta.__sig = sig;
      meta.textContent = '';
      if (n.state === 'ran') {
        meta.appendChild(h('span', { 'data-ago': n.ranAt || n.createdAt, 'data-ago-prefix': 'ran ' }, ''));
        if (n.via) meta.appendChild(h('span', { class: 'note-via' }, `via ${n.via.replace('_', ' ')}`));
      } else if (n.state === 'failed') {
        meta.appendChild(h('span', {}, 'Failed'));
        if (n.error) meta.appendChild(h('span', { class: 'note-err', title: n.error }, n.error));
        meta.appendChild(h('button', { class: 'link-btn', type: 'button', onclick: () => retryNote(n.id) }, 'Retry'));
      } else {
        meta.appendChild(h('span', {}, STATE_LABEL[n.state] || n.state));
      }
    }
    setHidden(row.__actions, n.state !== 'draft' || !!n.__pending);
    row.__reply.update(n);
    row.__wait.update(n);
  }

  function render() {
    const notes = sel.notesFor(target.kind, target.id);
    const drafts = notes.filter((n) => n.state === 'draft' && !n.__pending).length;
    setText(countEl, notes.length ? String(notes.length) : '');
    setText(execLabel, drafts ? `Execute ${drafts}` : 'Execute');
    execBtn.disabled = drafts === 0;
    setClass(execBtn, 'has-drafts', drafts > 0);
    empty.hidden = notes.length > 0;
    list.hidden = notes.length === 0;
    const before = list.scrollHeight - list.scrollTop - list.clientHeight;
    reconcile(list, notes, (n) => n.id, (n) => makeRow(n), updateRow);
    if (before < 40) list.scrollTop = list.scrollHeight;
  }

  startTicker();
  render();
  const off = subscribe((changed) => { if (changed.has('note') || changed.has('task')) render(); });
  return { el, render, destroy: off, focus: () => ta.focus() };
}
