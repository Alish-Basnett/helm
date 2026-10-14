// views/talk.js — Talk: chat with a live session. Your notes are right-aligned bubbles coloured by note state,
// Claude's replies are left bubbles. `createTalk` (alias `createChat`) is the reusable thread + composer for ANY note
// target — a session (Talk panel, Threads) or a task (Task chat panel); `createTalkSheet` is the Talk panel in the
// Dock, with a session picker.
import { h, reconcile, setText, setHidden, setAttr, setClass, startTicker, bus } from '../dom.js';
import { bindDraft, clearDraft } from '../drafts.js';
import { icon } from '../icons.js';
import { state, sel, subscribe, lsGet, lsSet } from '../store.js';
import { addNote, deleteNote, executeNotes, retryNote, canStart } from '../actions.js';
import { createAttachTray, createAttachmentList, bindAttachInput, attsOf } from '../attachments.js';
import { createReply, createWaitLine } from '../replies.js';
import { setLinked } from '../tasklinks.js';
import { createFloating, createBubble, loadFloat, saveFloat } from '../floating.js';
import { cwdTail } from '../format.js';
import { emptyState, modelBadge, updateModelBadge, toast } from '../ui.js';
import { getPref, codeOn, onPrefs } from '../prefs.js';
import { openContextMenu, closeContextMenu, isContextMenuOpen } from '../contextmenu.js';
import { createCodeTurn, composerView, codeEditor } from '../code.js';

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
  const editor = codeEditor(ta, { className: 'talk-inputwrap', view: (t, st, el) => composerView(t, st, el.getAttribute('placeholder') || '') });
  const inputWrap = editor.el;
  const composer = h('div', { class: 'note-composer talk-composer' }, tray.el, inputWrap, attachBtn, send, hint, cheapHint);
  const el = h('section', { class: ['talk', isTask && 'task-chat', opts.inline && 'inline'], 'aria-label': isTask ? 'Task chat' : 'Talk' }, list, empty, composer);
  const binding = bindAttachInput({ box: el, ta, tray, disabled: () => ta.disabled });

  const nearEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const scrollToEnd = () => { list.scrollTop = list.scrollHeight; };
  const syncCode = editor.sync;
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; syncCode(); };

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

  /** Drafts on a task that has not started wait for Start; on a running task Execute still sends them. */
  const holdSend = (n) => isTask && n.state === 'draft' && canStart(state.tasks.get(target.id));
  function updateTurn(li, n) {
    const r = li.__r;
    const cls = `tk-turn state-${n.state}${n.__pending ? ' pending' : ''}`;
    if (li.className !== cls) li.className = cls;
    if (codeOn()) {
      if (!r.cm) {
        r.cm = createCodeTurn({ holdSend, onSend: () => executeNotes(target), onDelete: (x) => deleteNote(x.id), onRetry: (x) => retryNote(x.id) });
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
    const hold = holdSend(n);
    const sig = `${n.state}|${n.ranAt}|${n.error || ''}|${n.__pending ? 1 : 0}|${n.via || ''}|${hold ? 1 : 0}`;
    if (r.meta.__sig !== sig) {
      r.meta.__sig = sig;
      r.meta.textContent = '';
      r.meta.append(h('span', {}, n.state === 'ran' && n.via === 'start' ? 'Sent with Start' : STATE_LABEL[n.state] || n.state));
      if (n.state === 'ran') r.meta.append(h('span', { 'data-ago': n.ranAt || n.createdAt }, ''));
      if (n.state === 'draft' && !n.__pending) {
        r.meta.append(
          hold ? h('span', { class: 'prestart-hint' }, 'Will be sent when you press Start')
            : h('button', { class: 'link-btn', type: 'button', onclick: () => executeNotes(target) }, 'Send'),
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
  return { el, destroy() { off(); offPrefs(); editor.destroy(); binding.destroy(); tray.destroy(); }, focus: () => ta.focus(), scrollToEnd, render };
}
export const createChat = createTalk;

/* ---------- the Talk panel (in the Dock, or detached into a floating window) ---------- */
const FLOAT_KEY = 'helm.talk.float';
const BUBBLE_KEY = 'helm.talk.bubble';

export function createTalkSheet(dock) {
  // the session name is a plain label (drags the window); the Talk icon opens the session switcher
  const label = h('span', { class: 'talk-label' });
  const switcher = h('button', { class: 'icon-btn talk-switch', type: 'button', 'aria-label': 'Switch session', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Switch session' }, icon('chat', 18));
  const model = modelBadge('');
  const bodyEl = h('div', { class: 'talk-body' });
  let isOpen = false;
  let detached = false; // true = Talk lives in the floating window (open or not)
  let sid = null;
  let talk = null;
  let win = null; // the floating window, created on first detach
  let minimised = false; // true = hidden on the shelf: still mounted (draft, scroll), just not shown
  let moving = false; // true while we reparent: the Dock's onClosed must not tear Talk down
  let prevFocus = null;

  const panel = dock.register('talk', {
    order: 2, width: 400, label: 'Talk', icon: 'chat', ariaLabel: 'Talk to a session',
    onClosed: () => { if (!moving) teardown(); },
  });
  const closeBtn = h('button', { class: 'icon-btn dock-close', type: 'button', 'aria-label': 'Minimise to a pill', title: 'Minimise to a pill (Esc)', onclick: () => close() }, icon('close', 18));
  const minBtn = h('button', { class: 'icon-btn talk-min', type: 'button', 'aria-label': 'Minimise Talk to the shelf', title: 'Minimise Talk to the shelf (M minimises all)', onclick: () => requestMinimise() }, icon('minimize', 18));
  const popBtn = h('button', { class: 'icon-btn talk-pop', type: 'button', 'data-act': 'detach', onclick: () => toggleDetached() });
  const head = h('header', { class: 'sheet-head talk-head', 'data-float-drag': '' },
    h('div', { class: 'sheet-head-top' }, switcher, label, model, popBtn, minBtn, closeBtn));
  panel.el.append(head, bodyEl);

  function paintMode() {
    popBtn.textContent = '';
    popBtn.append(icon(detached ? 'dockin' : 'popout', 18));
    const label = detached ? 'Dock Talk back into the side panel' : 'Detach Talk into a floating window';
    popBtn.setAttribute('aria-label', label);
    popBtn.title = `${label} (⇧T)`;
    popBtn.setAttribute('data-act', detached ? 'dock' : 'detach');
    closeBtn.title = detached ? 'Minimise to a pill' : 'Minimise to a pill (Esc)';
  }
  paintMode();

  // The minimised form: a circular pill, shown whenever Talk is closed. It is also the only way in besides T / ⇧T,
  // and it reopens Talk in whichever mode (Dock panel or floating window) was used last.
  const pill = createBubble({
    storeKey: BUBBLE_KEY, label: 'Talk to a session', iconEl: icon('chat', 22), className: 'talk-pill',
    title: 'Talk to a session (drag to move · T opens · ⇧T floats it)',
    onActivate: () => open(),
  });
  const syncPill = () => { if (isOpen || minimised) pill.hide(); else pill.show(); };
  const requestMinimise = () => bus.emit('shelf-minimise', 'talk');
  function ensureWin() {
    if (!win) {
      win = createFloating({
        storeKey: FLOAT_KEY, label: 'Talk', ariaLabel: 'Talk to a session (floating window)', className: 'float-talk',
        defaultRect: ({ vw }) => ({ w: 420, h: 560, x: vw - 444, y: 72 }),
      });
    }
    return win;
  }
  /** Put the header + thread in the container that matches the current mode (the same elements, so nothing is re-created). */
  function place() {
    const to = detached ? ensureWin().body : panel.el;
    if (head.parentNode !== to) to.append(head, bodyEl);
  }
  function threadScroll() {
    const t = bodyEl.querySelector('.talk-thread');
    return t ? { t, top: t.scrollTop, end: t.scrollHeight - t.scrollTop - t.clientHeight < 80 } : null;
  }
  function restoreScroll(sc) {
    if (!sc) return;
    const apply = () => { if (sc.end && talk) talk.scrollToEnd(); else sc.t.scrollTop = sc.top; };
    apply();
    requestAnimationFrame(apply);
  }
  function teardown() {
    isOpen = false;
    minimised = false;
    syncPill();
    if (talk) { talk.destroy(); talk = null; bodyEl.textContent = ''; }
  }

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

  /** Compact popover (contextmenu.js): sessions grouped by project, newest first, current one checked, busy as a dot. */
  let hoverT = 0, wasOpen = false;
  function openSwitcher(byKey) {
    clearTimeout(hoverT);
    if (isContextMenuOpen() || switcher.disabled) return;
    const groups = new Map();
    for (const x of sel.talkSessions()) { // already sorted by last used
      if (!groups.has(x.projectId)) groups.set(x.projectId, []);
      groups.get(x.projectId).push(x);
    }
    const items = [];
    for (const [pid, list] of groups) {
      items.push({ heading: sel.projectName(pid) });
      for (const x of list) items.push({
        label: x.title || cwdTail(x.cwd) || x.id, checked: x.id === sid, icon: x.busy ? 'dot' : undefined,
        onSelect: () => { if (x.id !== sid) choose(x.id, true); focusTalk(); },
      });
    }
    const r = switcher.getBoundingClientRect();
    switcher.setAttribute('aria-expanded', 'true');
    openContextMenu({ x: r.left, y: r.bottom + 4, items, restoreFocus: switcher, restoreOnSelect: false, focusFirst: byKey, onClose: () => switcher.setAttribute('aria-expanded', 'false') });
  }
  switcher.addEventListener('pointerenter', () => { clearTimeout(hoverT); hoverT = setTimeout(() => openSwitcher(false), 350); });
  switcher.addEventListener('pointerleave', () => clearTimeout(hoverT));
  switcher.addEventListener('pointerdown', () => { wasOpen = isContextMenuOpen(); }); // the menu's outside-click closes first
  switcher.addEventListener('click', (e) => { if (wasOpen) { wasOpen = false; return; } openSwitcher(e.detail === 0); }); // detail 0 = Enter/Space
  switcher.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); openSwitcher(true); } });

  function syncPicker() {
    const list = sel.talkSessions();
    const cur = sid && state.sessions.get(sid);
    label.textContent = cur ? (cur.title || cwdTail(cur.cwd) || cur.id) : 'No live session';
    switcher.disabled = list.length === 0;
    const s = sid && state.sessions.get(sid);
    setHidden(model, !s);
    if (s) updateModelBadge(model, s.model);
    // the old second line (project · folder · working) now lives in the tooltip so the header stays one row
    const detail = s ? `${sel.projectName(s.projectId)} · ${cwdTail(s.cwd, 3)}${s.busy ? ' · working' : ''}` : '';
    label.title = detail;
    setClass(head, 'is-busy', !!(s && s.busy));
  }

  const focusTalk = () => { if (talk) talk.focus(); else if (win && detached) win.el.focus({ preventScroll: true }); };

  function open(sessionId, opts = {}) {
    const focus = opts.focus !== false;
    if (minimised) { restore({ focus }); if (sessionId && isOpen) choose(pick(sessionId), true); return; }
    if (isOpen) {
      if (sessionId) choose(pick(sessionId), true);
      if (detached) { win.show(); if (focus) focusTalk(); }
      else panel.open({ focus });
      return;
    }
    isOpen = true;
    syncPill();
    sid = pick(sessionId);
    syncPicker();
    mountTalk();
    place();
    if (detached) {
      prevFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      win.show();
      saveFloat(FLOAT_KEY, { detached: true, open: true });
      requestAnimationFrame(() => { if (talk) talk.scrollToEnd(); });
      if (focus) focusTalk();
    } else {
      panel.open({ focus });
      requestAnimationFrame(() => { if (talk) talk.scrollToEnd(); });
    }
  }

  function close() {
    if (!detached) { panel.close(); return; }
    if (!isOpen) return;
    const hadFocus = win.el.contains(document.activeElement);
    win.hide();
    teardown();
    saveFloat(FLOAT_KEY, { detached: true, open: false });
    if (hadFocus && prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
    prevFocus = null;
  }

  /** Dock panel -> floating window. The same elements move; nothing is re-created. */
  function detach() {
    if (detached) return;
    if (minimised) restore();
    if (!isOpen) { detached = true; paintMode(); saveFloat(FLOAT_KEY, { detached: true }); open(); return; }
    const sc = threadScroll();
    prevFocus = null;
    detached = true;
    paintMode();
    place(); // reparent first, so the Dock's close below has no focus to hand back
    moving = true;
    try { panel.close(); } finally { moving = false; }
    win.show();
    saveFloat(FLOAT_KEY, { detached: true, open: true });
    restoreScroll(sc);
    focusTalk(); // the Detach button just left the page: put focus in the composer of the new window
  }

  /** Hide Talk on the shelf without closing it: the thread, composer draft and scroll stay mounted. */
  function minimise() {
    if (!isOpen || minimised) return false;
    minimised = true;
    if (detached) {
      const hadFocus = win.el.contains(document.activeElement);
      win.hide(); // the geometry lives in JS (and storage), so showing it again puts it back exactly
      saveFloat(FLOAT_KEY, { detached: true, open: false }); // a reload must not reopen it
      if (hadFocus && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    } else panel.minimise();
    syncPill();
    return true;
  }
  /** Bring it back. If Talk is not mounted (a "ghost" chip after a reload) it is opened in its last mode. */
  function restore(opts = {}) {
    if (!minimised) return;
    minimised = false;
    syncPill();
    if (!isOpen) { open(undefined, opts); return; }
    if (detached) {
      win.show();
      saveFloat(FLOAT_KEY, { detached: true, open: true });
      if (opts.focus !== false) focusTalk();
    } else panel.restore(opts);
    requestAnimationFrame(() => { if (talk) talk.scrollToEnd(); });
  }
  /** Shelf close (x / middle-click): close it for real. */
  function dismiss() {
    const wasMin = minimised;
    minimised = false;
    if (isOpen) close(); // the Dock clears the minimised flag itself; the floating window is hidden already
    else if (wasMin) syncPill();
  }
  /** Boot: the shelf remembers Talk was minimised before the reload. Nothing is mounted, so it is a ghost until restored. */
  function setGhost(on) { if (isOpen) return; minimised = !!on; syncPill(); }

  /** Floating window -> Dock panel. */
  function dockBack() {
    if (!detached) return;
    if (!isOpen) { detached = false; paintMode(); saveFloat(FLOAT_KEY, { detached: false, open: false }); open(); return; }
    const sc = threadScroll();
    detached = false;
    paintMode();
    place();
    win.hide();
    saveFloat(FLOAT_KEY, { detached: false, open: false });
    panel.open({ focus: true });
    restoreScroll(sc);
  }
  function toggleDetached() { if (minimised) restore(); if (detached) dockBack(); else detach(); }

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

  // restore: Talk lived in the floating window when the page was last open
  const st = loadFloat(FLOAT_KEY);
  if (st.detached) {
    detached = true;
    paintMode();
    if (st.open) open(undefined, { focus: false });
  }
  syncPill();

  return {
    open, close, toggle: () => (isOpen && (detached ? win.isVisible : panel.isVisible) ? close() : open()),
    detach, dock: dockBack, toggleDetached,
    get isOpen() { return isOpen; },
    get isMinimised() { return minimised; },
    get sessionId() { return sid; },
    minimise, restore, dismiss, setGhost,
    get isDetached() { return detached; },
    get floating() { return win; },
    destroy() { off(); pill.destroy(); if (win) win.destroy(); },
  };
}
