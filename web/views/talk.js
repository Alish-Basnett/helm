// views/talk.js — Talk: chat with a live session. Your notes are right-aligned bubbles coloured by note state,
// Claude's replies are left bubbles. `createTalk` is the reusable thread + composer (used by the Talk sheet
// and by Threads when the main node is selected); `createTalkSheet` is the right-hand sheet with a session picker.
import { h, reconcile, setText, setHidden, setAttr, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { state, sel, subscribe, lsGet, lsSet } from '../store.js';
import { addNote, deleteNote, executeNotes, retryNote } from '../actions.js';
import { createReply, createWaitLine } from '../replies.js';
import { cwdTail } from '../format.js';
import { emptyState, modelBadge, updateModelBadge } from '../ui.js';

const STATE_LABEL = { draft: 'Draft', queued: 'Queued', sending: 'Sending…', ran: 'Delivered', failed: 'Failed' };

/** opts: { sessionId, inline? }  →  { el, destroy, focus, scrollToEnd } */
export function createTalk(opts) {
  const sid = opts.sessionId;
  const target = { kind: 'session', id: sid };
  let firstRender = true;

  const list = h('ul', { class: 'talk-thread', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation with session' });
  const empty = h('div', { class: 'talk-empty' }, icon('chat', 22), h('p', {}, 'Say something to this session. ↵ sends it right away, and Claude’s reply lands here.'));
  const ta = h('textarea', { class: 'note-input talk-input', rows: '1', placeholder: 'Message this session…', 'aria-label': 'Message this session' });
  const send = h('button', { class: 'icon-btn note-send', type: 'button', 'aria-label': 'Send now', title: 'Send now (↵)', onclick: () => submit(true) }, icon('send', 18));
  const draftBtn = h('button', { class: 'link-btn talk-draft', type: 'button', onclick: () => submit(false), title: 'Keep it as a draft; run it later with Execute' }, 'Save as draft');
  const hint = h('div', { class: 'note-hint mono talk-hint' }, h('span', {}, '↵ send now · ⇧↵ new line'), draftBtn);
  const composer = h('div', { class: 'note-composer talk-composer' }, ta, send, hint);
  const el = h('section', { class: ['talk', opts.inline && 'inline'], 'aria-label': 'Talk' }, list, empty, composer);

  const nearEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const scrollToEnd = () => { list.scrollTop = list.scrollHeight; };
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };

  async function submit(run) {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    autosize();
    const p = run ? addNote(target, text, { execute: true }) : addNote(target, text);
    scrollToEnd();
    await p;
    scrollToEnd();
  }
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    e.preventDefault();
    submit(true);
  });

  /* ----- one turn: my bubble + Claude's reply (or typing) ----- */
  function makeTurn() {
    const text = h('div', { class: 'tk-text' });
    const meta = h('div', { class: 'tk-meta mono' });
    const bubble = h('div', { class: 'tk-bubble' }, text, meta);
    const me = h('div', { class: 'tk-me' }, bubble);
    const reply = createReply();
    const wait = createWaitLine({ typing: true });
    const claude = h('div', { class: 'tk-claude' }, reply.el, wait.el);
    const li = h('li', { class: 'tk-turn' }, me, claude);
    li.__r = { text, meta, reply, wait, claude };
    return li;
  }

  function updateTurn(li, n) {
    const r = li.__r;
    const cls = `tk-turn state-${n.state}${n.__pending ? ' pending' : ''}`;
    if (li.className !== cls) li.className = cls;
    setText(r.text, n.text);
    const sig = `${n.state}|${n.ranAt}|${n.error || ''}|${n.__pending ? 1 : 0}`;
    if (r.meta.__sig !== sig) {
      r.meta.__sig = sig;
      r.meta.textContent = '';
      r.meta.append(h('span', {}, STATE_LABEL[n.state] || n.state));
      if (n.state === 'ran') r.meta.append(h('span', { 'data-ago': n.ranAt || n.createdAt }, ''));
      if (n.state === 'draft' && !n.__pending) {
        r.meta.append(
          h('button', { class: 'link-btn', type: 'button', onclick: () => executeNotes(target) }, 'Send'),
          h('button', { class: 'link-btn', type: 'button', onclick: () => deleteNote(n.id) }, 'Delete'));
      }
      if (n.state === 'failed') {
        if (n.error) r.meta.append(h('span', { class: 'note-err', title: n.error }, n.error));
        r.meta.append(h('button', { class: 'link-btn', type: 'button', onclick: () => retryNote(n.id) }, 'Retry'));
      }
    }
    r.reply.update(n);
    r.wait.update(n);
    setHidden(r.claude, !n.reply && r.wait.el.hidden);
  }

  function render() {
    const s = state.sessions.get(sid);
    const ended = !s || s.status === 'ended';
    ta.disabled = ended; send.disabled = ended; draftBtn.disabled = ended;
    setAttr(ta, 'placeholder', ended ? 'This session has ended' : 'Message this session…');
    const notes = sel.notesFor('session', sid);
    empty.hidden = notes.length > 0;
    list.hidden = notes.length === 0;
    const stick = firstRender || nearEnd();
    reconcile(list, notes, (n) => n.id, makeTurn, updateTurn);
    if (stick) scrollToEnd();
    firstRender = false;
  }

  startTicker();
  render();
  const off = subscribe((changed) => { if (changed.has('note') || changed.has('session')) render(); });
  requestAnimationFrame(scrollToEnd); // re-pin once the thread is attached and laid out
  return { el, destroy: off, focus: () => ta.focus(), scrollToEnd, render };
}

/* ---------- the sheet ---------- */
export function createTalkSheet(root) {
  const scrim = h('div', { class: 'scrim talk-scrim', onclick: () => close() });
  const picker = h('select', { class: 'select talk-picker', 'aria-label': 'Session to talk to', onchange: () => choose(picker.value, true) });
  const model = modelBadge('');
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => close() }, icon('close', 18));
  const sub = h('div', { class: 'talk-sub mono' });
  const head = h('header', { class: 'sheet-head talk-head' },
    h('div', { class: 'sheet-head-top' }, h('h2', { class: 'talk-title' }, icon('chat', 16), 'Talk'), model, h('span', { class: 'spacer' }), closeBtn),
    picker, sub);
  const bodyEl = h('div', { class: 'talk-body' });
  const sheet = h('aside', { class: 'sheet talk-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Talk to a session', 'aria-hidden': 'true', inert: true }, head, bodyEl);
  root.append(scrim, sheet);

  let isOpen = false;
  let sid = null;
  let talk = null;
  let prevFocus = null;

  function pick(preferred) {
    const list = sel.talkSessions();
    if (preferred && list.some((x) => x.id === preferred)) return preferred;
    if (sid && list.some((x) => x.id === sid)) return sid;
    const remembered = lsGet('helm.talk.session');
    if (remembered && list.some((x) => x.id === remembered)) return remembered;
    return list[0] ? list[0].id : null; // most recently active
  }

  function mountTalk() {
    if (talk) { talk.destroy(); talk = null; }
    bodyEl.textContent = '';
    if (!sid) {
      bodyEl.append(emptyState({ iconName: 'chat', title: 'No live session', body: 'No live session for this project — open a Claude Code session in it.' }));
      return;
    }
    talk = createTalk({ sessionId: sid });
    bodyEl.append(talk.el);
    if (isOpen) requestAnimationFrame(() => { if (talk) { talk.scrollToEnd(); talk.focus(); } });
  }

  function choose(id, remember) {
    sid = id || null;
    if (sid && remember) lsSet('helm.talk.session', sid);
    syncPicker();
    mountTalk();
  }

  function syncPicker() {
    const list = sel.talkSessions();
    const multi = state.ui.projectId === 'all' && state.projects.size > 1;
    const sig = list.map((x) => `${x.id}|${x.title}|${x.status}|${x.projectId}`).join(';') + `|${multi}`;
    if (picker.__sig !== sig) {
      picker.__sig = sig;
      picker.textContent = '';
      for (const x of list) {
        picker.appendChild(h('option', { value: x.id }, `${multi ? sel.projectName(x.projectId) + ' · ' : ''}${x.title || cwdTail(x.cwd) || x.id}  ·  ${x.status}`));
      }
      if (!list.length) picker.appendChild(h('option', { value: '' }, 'No live sessions'));
    }
    picker.disabled = list.length === 0;
    if (sid && picker.value !== sid) picker.value = sid;
    const s = sid && state.sessions.get(sid);
    setHidden(model, !s);
    if (s) updateModelBadge(model, s.model);
    setText(sub, s ? `${sel.projectName(s.projectId)} · ${cwdTail(s.cwd, 3)}${s.busy ? ' · working' : ''}` : '');
  }

  function onKey(e) {
    if (!isOpen) return;
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.menu, .spotlight-scrim.open')) { e.preventDefault(); close(); }
    else if (e.key === 'Tab') {
      const f = Array.from(sheet.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!sheet.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey);

  function open(sessionId) {
    if (isOpen) { if (sessionId) choose(pick(sessionId), true); else if (talk) talk.focus(); return; }
    isOpen = true;
    prevFocus = document.activeElement;
    sid = pick(sessionId);
    syncPicker();
    mountTalk();
    sheet.inert = false;
    sheet.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      sheet.classList.add('open'); scrim.classList.add('open');
      if (talk) { talk.scrollToEnd(); talk.focus(); } else closeBtn.focus({ preventScroll: true });
    });
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    sheet.classList.remove('open'); scrim.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true'); sheet.inert = true;
    if (talk) { talk.destroy(); talk = null; bodyEl.textContent = ''; }
    if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
    prevFocus = null;
  }

  const off = subscribe((changed) => {
    if (!isOpen) return;
    if (!(changed.has('session') || changed.has('project') || changed.has('ui') || changed.has('ready'))) return;
    const live = sel.talkSessions();
    if (!sid || !live.some((x) => x.id === sid)) {
      const next = pick();
      if (next !== sid) { sid = next; syncPicker(); mountTalk(); return; }
    }
    syncPicker();
  });

  return {
    open, close, toggle: () => (isOpen ? close() : open()),
    get isOpen() { return isOpen; },
    destroy() { off(); document.removeEventListener('keydown', onKey); },
  };
}
