// views/talk.js — Talk: chat with a live session. Your notes are right-aligned bubbles coloured by note state,
// Claude's replies are left bubbles. `createTalk` (alias `createChat`) is the reusable thread + composer for ANY note
// target — a session (Talk panel, Threads) or a task (Task chat panel); `createTalkSheet` is the Talk panel in the
// Dock, with a session picker.
import { h, reconcile, setText, setHidden, setAttr, setClass, startTicker } from '../dom.js';
import { bindDraft, clearDraft } from '../drafts.js';
import { icon } from '../icons.js';
import { state, sel, subscribe, lsGet, lsSet } from '../store.js';
import { addNote, deleteNote, executeNotes, retryNote } from '../actions.js';
import { createAttachTray, createAttachmentList, bindAttachInput, attsOf } from '../attachments.js';
import { createReply, createWaitLine } from '../replies.js';
import { setLinked } from '../tasklinks.js';
import { panelClose } from '../dock.js';
import { cwdTail } from '../format.js';
import { emptyState, modelBadge, updateModelBadge, toast } from '../ui.js';
import { getPref, codeOn, onPrefs } from '../prefs.js';
import { createCodeTurn, composerView } from '../code.js';

const STATE_LABEL = { draft: 'Draft', queued: 'Queued', sending: 'Sending…', ran: 'Delivered', failed: 'Failed' };

/**
 * opts: { sessionId } (shorthand for a session target) | { target: { kind: 'session' | 'task', id } }, inline?
 * →  { el, destroy, focus, scrollToEnd, render }
 */
export function createTalk(opts) {
  const target = opts.target || { kind: 'session', id: opts.sessionId };
  const sid = target.id;
  const isTask = target.kind === 'task';
  const who = isTask ? 'this task' : 'this session';
  let firstRender = true;

  const list = h('ul', { class: 'talk-thread', role: 'log', 'aria-live': 'polite', 'aria-label': isTask ? 'Task chat' : 'Conversation with session' });
  const empty = h('div', { class: 'talk-empty' }, icon('chat', 22), h('p', {}, isTask
    ? 'Ask about this task or tell its agent what to do. ↵ sends it right away, and the reply lands here.'
    : 'Say something to this session. ↵ sends it right away, and Claude’s reply lands here.'));
  const ta = h('textarea', { class: 'note-input talk-input', rows: '1', placeholder: `Message ${who}…`, 'aria-label': `Message ${who}`, 'data-autofocus': '' });
  const draftKey = `talk:${target.kind}:${sid}`;
  bindDraft(ta, draftKey); // restores after the listeners below are attached (microtask)
  const send = h('button', { class: 'icon-btn note-send', type: 'button', 'aria-label': 'Send now', title: 'Send now (↵)', onclick: () => submit(true) }, icon('send', 18));
  const draftBtn = h('button', { class: 'link-btn talk-draft', type: 'button', onclick: () => submit(false), title: 'Keep it as a draft; run it later with Execute' }, 'Save as draft');
  const hint = h('div', { class: 'note-hint mono talk-hint' }, h('span', {}, '↵ send now · ⇧↵ new line'), draftBtn);
  const cheapHint = isTask ? h('div', { class: 'note-hint note-hint-cheap mono' }, 'Questions are answered cheaply from the task record · start with ! to send to the agent') : null;
  const tray = createAttachTray({ onChange: () => setClass(composer, 'has-att', tray.count > 0) });
  const attachBtn = h('button', { class: 'icon-btn note-attach', type: 'button', 'aria-label': 'Attach files', title: 'Attach files (or drop / paste)', onclick: () => binding.pick() }, icon('paperclip', 18));
  // code mode: a highlighted layer sits under the (transparent-text) textarea, so typing is coloured live
  const hl = h('pre', { class: 'cm-hl', 'aria-hidden': 'true' });
  const inputWrap = h('div', { class: 'talk-inputwrap' }, hl, ta);
  const composer = h('div', { class: 'note-composer talk-composer' }, tray.el, inputWrap, attachBtn, send, hint, cheapHint);
  const el = h('section', { class: ['talk', isTask && 'task-chat', opts.inline && 'inline'], 'aria-label': isTask ? 'Task chat' : 'Talk' }, list, empty, composer);
  const binding = bindAttachInput({ box: el, ta, tray, disabled: () => ta.disabled });

  const nearEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const scrollToEnd = () => { list.scrollTop = list.scrollHeight; };
  function syncCode() {
    if (!codeOn()) { ta.style.textIndent = ''; return; }
    const v = composerView(ta.value, getPref('codestyle'), ta.getAttribute('placeholder') || '');
    hl.textContent = '';
    hl.append(...v.nodes);
    ta.style.textIndent = `${v.prefixLen}ch`;
    hl.scrollTop = ta.scrollTop;
  }
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; syncCode(); };
  ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; });

  async function submit(run) {
    const text = ta.value.trim();
    if (!text && !tray.count) return;
    if (tray.busy) { toast('Still uploading — send again in a moment. Your text is kept.'); return; }
    const taken = tray.take();
    const atts = attsOf(taken);
    if (!text && !atts.length) { tray.restore(taken); return; }
    ta.value = '';
    clearDraft(draftKey);
    autosize();
    const p = addNote(target, text, { execute: !!run, attachments: atts });
    scrollToEnd();
    const made = await p;
    if (!made) { if (!ta.value) { ta.value = text; autosize(); } tray.restore(taken); }
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
    const atts = createAttachmentList();
    const bubble = h('div', { class: 'tk-bubble' }, text, atts.el, meta);
    const me = h('div', { class: 'tk-me' }, bubble);
    const reply = createReply();
    const wait = createWaitLine({ typing: true });
    const claude = h('div', { class: 'tk-claude' }, reply.el, wait.el);
    const std = h('div', { class: 'tk-std' }, me, claude);
    const li = h('li', { class: 'tk-turn' }, std);
    li.__r = { text, meta, atts, reply, wait, claude, std, cm: null };
    return li;
  }

  function updateTurn(li, n) {
    const r = li.__r;
    const cls = `tk-turn state-${n.state}${n.__pending ? ' pending' : ''}`;
    if (li.className !== cls) li.className = cls;
    if (codeOn()) {
      if (!r.cm) {
        r.cm = createCodeTurn({ onSend: () => executeNotes(target), onDelete: (x) => deleteNote(x.id), onRetry: (x) => retryNote(x.id) });
        li.append(r.cm.el);
      }
      setHidden(r.std, true);
      setHidden(r.cm.el, false);
      try { r.cm.update(n, getPref('codestyle')); } catch (e) { console.error('[helm] code render failed', e); }
      return;
    }
    if (r.cm) setHidden(r.cm.el, true);
    setHidden(r.std, false);
    setLinked(r.text, n.text);
    r.atts.update(n.attachments);
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
    try { r.reply.update(n); } catch (e) { console.error('[helm] reply render failed', e); }
    r.wait.update(n);
    setHidden(r.claude, !n.reply && r.wait.el.hidden);
  }

  function render() {
    // a session you cannot reach is read-only; a task's chat stays open (the hub finds a live session when it sends)
    const s = isTask ? null : state.sessions.get(sid);
    const ended = !isTask && (!s || s.status === 'ended');
    ta.disabled = ended; send.disabled = ended; draftBtn.disabled = ended; attachBtn.disabled = ended;
    setAttr(ta, 'placeholder', ended ? 'This session has ended' : `Message ${who}…`);
    syncCode();
    const notes = sel.notesFor(target.kind, sid);
    empty.hidden = notes.length > 0;
    list.hidden = notes.length === 0;
    const stick = firstRender || nearEnd();
    reconcile(list, notes, (n) => n.id, makeTurn, updateTurn);
    if (stick) scrollToEnd();
    firstRender = false;
  }

  function applyMode() {
    setClass(composer, 'cm-composer', codeOn());
    setClass(el, 'cm-on', codeOn());
    autosize();
    render();
  }
  startTicker();
  applyMode();
  const offPrefs = onPrefs((k) => { if (k === 'code' || k === 'codestyle') applyMode(); });
  const off = subscribe((changed) => { if (changed.has('note') || changed.has('session') || changed.has('task')) render(); });
  requestAnimationFrame(scrollToEnd); // re-pin once the thread is attached and laid out
  return { el, destroy() { off(); offPrefs(); binding.destroy(); tray.destroy(); }, focus: () => ta.focus(), scrollToEnd, render };
}
export const createChat = createTalk;

/* ---------- the Talk panel (in the Dock) ---------- */
export function createTalkSheet(dock) {
  const picker = h('select', { class: 'select talk-picker', 'aria-label': 'Session to talk to', onchange: () => choose(picker.value, true) });
  const model = modelBadge('');
  const sub = h('div', { class: 'talk-sub mono' });
  const bodyEl = h('div', { class: 'talk-body' });
  let isOpen = false;
  let sid = null;
  let talk = null;

  const panel = dock.register('talk', {
    order: 2, width: 400, label: 'Talk', icon: 'chat', ariaLabel: 'Talk to a session',
    onClosed: () => { isOpen = false; if (talk) { talk.destroy(); talk = null; bodyEl.textContent = ''; } },
  });
  const head = h('header', { class: 'sheet-head talk-head' },
    h('div', { class: 'sheet-head-top' }, h('h2', { class: 'talk-title' }, icon('chat', 16), 'Talk'), model, h('span', { class: 'spacer' }), panelClose(panel)),
    picker, sub);
  panel.el.append(head, bodyEl);

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
    if (isOpen) requestAnimationFrame(() => { if (talk) talk.scrollToEnd(); });
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

  function open(sessionId) {
    if (isOpen) {
      if (sessionId) choose(pick(sessionId), true);
      panel.open({ focus: true });
      return;
    }
    isOpen = true;
    sid = pick(sessionId);
    syncPicker();
    mountTalk();
    panel.open({ focus: true });
    requestAnimationFrame(() => { if (talk) talk.scrollToEnd(); });
  }
  function close() { panel.close(); }

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
    open, close, toggle: () => (isOpen && panel.isVisible ? close() : open()),
    get isOpen() { return isOpen; },
    destroy() { off(); },
  };
}
