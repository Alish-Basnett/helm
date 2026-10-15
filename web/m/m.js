// m.js — Helm phone quick capture. Standalone (no imports, no build): add a task, start it, message a live session,
// attach a photo, and see what needs you. Works on the Mac at http://localhost:7777/m and, once paired, on a phone.
//
// Pairing: Settings > Phone access shows http://<lan-ip>:7778/m#k=<token>. The token only ever lives in the URL hash
// (never sent to a server), is moved into localStorage + a SameSite=Strict cookie, and is sent as a Bearer header.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_FILES = 10;
  const MAX_BYTES = 20 * 1024 * 1024;
  const KEY = { project: 'helm.m.project', session: 'helm.m.session', sent: 'helm.m.sent', token: 'helm.m.k' };

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* ---------------------------------------------------------------- pairing */
  let token = '';
  (function pair() {
    const m = /(?:^|[#&])k=([^&]+)/.exec(location.hash);
    if (m) {
      try { token = decodeURIComponent(m[1]); } catch (e) { token = m[1]; }
      ls.set(KEY.token, token);
      // EventSource can't set headers, so the stream authenticates by cookie
      document.cookie = 'helm_k=' + encodeURIComponent(token) + '; path=/; max-age=31536000; SameSite=Strict';
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    } else {
      token = ls.get(KEY.token) || '';
    }
  })();

  /* -------------------------------------------------------------------- api */
  async function request(method, path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (token) headers.authorization = 'Bearer ' + token;
    const init = { method: method, headers: headers, cache: 'no-store' };
    if (opts.json !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
    if (opts.raw !== undefined) init.body = opts.raw;
    let res;
    try { res = await fetch(path, init); } catch (e) { const err = new Error('Hub unreachable'); err.status = 0; throw err; }
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    if (!res.ok) {
      const err = new Error((data && data.error) || (method + ' ' + path + ' failed (' + res.status + ')'));
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw err;
    }
    return data;
  }

  /* ----------------------------------------------------------------- state */
  let S = { projects: [], sessions: [], tasks: [], notes: [], questions: [], agents: [] };
  const projectName = (id) => { const p = S.projects.find((x) => x.id === id); return p ? p.name : ''; };

  function needsFor(t) {
    if (Array.isArray(t.needs)) return t.needs;       // the phone listener computes this on the Mac
    if (t.status === 'done' || t.status === 'archived') return [];
    const out = [];
    const add = (l) => { if (out.indexOf(l) < 0) out.push(l); };
    const nc = Array.isArray(t.choices) ? t.choices.filter((c) => c.state === 'open').length : 0;
    if (nc) add(nc === 1 ? '1 choice' : nc + ' choices');
    const agent = t.agentId ? S.agents.find((a) => a.id === t.agentId) : null;
    S.questions.forEach((q) => {
      if (q.state === 'open' && (q.taskId === t.id || (agent && q.agentId === agent.id))) add(q.kind === 'waiting' ? 'Waiting for you' : 'Question');
    });
    if (agent && agent.status === 'waiting') add('Waiting for you');
    if (S.notes.some((n) => n.state === 'failed' && n.target && n.target.kind === 'task' && n.target.id === t.id)) add('Note failed');
    if (t.status === 'review') add('Review');
    return out;
  }

  /* ------------------------------------------------------------------- UI */
  const bannerEl = $('banner');
  function banner(text) { bannerEl.textContent = text || ''; bannerEl.hidden = !text; }
  function conn(ok, text) {
    $('conn').className = 'conn ' + (ok ? 'ok' : 'bad');
    $('conn-text').textContent = text;
  }
  function say(id, kind, text) {
    const p = $(id);
    p.textContent = text || '';
    p.className = 'msg' + (kind && kind !== 'ok' ? ' ' + kind : '');
    p.hidden = !text;
  }
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  };
  const friendly = (e) => {
    const m = e && e.message ? e.message : String(e);
    if (/no live session|no session available/i.test(m)) return 'No live session. Open Claude Code in this project on your Mac, then try again.';
    return m;
  };

  /* project + session pickers */
  const projectSel = $('project');
  const sessionSel = $('session');
  function liveSessions() {
    return S.sessions.filter((s) => s.projectId === projectSel.value && s.status !== 'ended')
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  }
  function renderPickers() {
    const projects = S.projects.filter((p) => !p.archived);
    const want = projectSel.value || ls.get(KEY.project);
    projectSel.textContent = '';
    projects.forEach((p) => { const o = el('option', '', p.name); o.value = p.id; projectSel.appendChild(o); });
    if (!projects.length) { const o = el('option', '', 'No projects yet'); o.value = ''; projectSel.appendChild(o); }
    if (projects.some((p) => p.id === want)) projectSel.value = want;
    renderSessions();
  }
  function renderSessions() {
    const want = sessionSel.value || ls.get(KEY.session);
    const list = liveSessions();
    sessionSel.textContent = '';
    list.forEach((s) => {
      const o = el('option', '', (s.appTitle || s.title || s.id) + ' · ' + (s.busy ? 'working' : s.status));
      o.value = s.id;
      sessionSel.appendChild(o);
    });
    if (!list.length) { const o = el('option', '', 'No live session'); o.value = ''; sessionSel.appendChild(o); }
    if (list.some((s) => s.id === want)) sessionSel.value = want;
    $('note-send').disabled = !list.length || noteBusy;
  }
  projectSel.addEventListener('change', () => { ls.set(KEY.project, projectSel.value); renderSessions(); renderNeeds(); });
  sessionSel.addEventListener('change', () => ls.set(KEY.session, sessionSel.value));

  /* needs you */
  function renderNeeds() {
    const ul = $('needs');
    const rows = S.tasks.map((t) => ({ t: t, n: needsFor(t) })).filter((x) => x.n.length)
      .sort((a, b) => (b.t.updatedAt || 0) - (a.t.updatedAt || 0));
    ul.textContent = '';
    const badge = $('needs-count');
    badge.textContent = String(rows.length);
    badge.hidden = rows.length === 0;
    if (!rows.length) { ul.appendChild(el('li', 'empty', 'Nothing is waiting on you.')); return; }
    rows.forEach((x) => {
      const li = el('li');
      li.appendChild(el('div', 'item-title', x.t.title));
      const meta = el('div', 'item-meta');
      x.n.forEach((l) => meta.appendChild(el('span', 'tag hot', l)));
      const pn = projectName(x.t.projectId);
      meta.appendChild(el('span', '', (pn ? pn + ' · ' : '') + x.t.id));
      li.appendChild(meta);
      ul.appendChild(li);
    });
  }

  /* sent from here (notes + start notes), with replies */
  let sent = [];
  try { sent = JSON.parse(ls.get(KEY.sent) || '[]'); if (!Array.isArray(sent)) sent = []; } catch (e) { sent = []; }
  function remember(entry) {
    sent.unshift(entry);
    sent = sent.slice(0, 15);
    ls.set(KEY.sent, JSON.stringify(sent));
    renderSent();
  }
  const STATE = { draft: ['Draft', ''], queued: ['Queued', 'hot'], sending: ['Sending', 'hot'], ran: ['Delivered', 'ok'], failed: ['Failed', 'bad'] };
  function noteOf(id) { return S.notes.find((n) => n.id === id) || null; }
  function pending() {
    return sent.some((s) => { const n = noteOf(s.id); return n && (n.state === 'queued' || n.state === 'sending' || (n.state === 'ran' && !n.reply && Date.now() - (n.ranAt || 0) < 10 * 60000)); });
  }
  function renderSent() {
    const ul = $('sent');
    ul.textContent = '';
    if (!sent.length) { ul.appendChild(el('li', 'empty', 'Notes and started tasks show up here with the reply.')); return; }
    sent.forEach((s) => {
      const n = noteOf(s.id);
      const li = el('li');
      li.appendChild(el('div', 'item-title', s.label));
      const meta = el('div', 'item-meta');
      const st = n ? STATE[n.state] || [n.state, ''] : ['Sent', ''];
      meta.appendChild(el('span', 'tag ' + st[1], st[0]));
      meta.appendChild(el('span', '', ago(s.at)));
      li.appendChild(meta);
      if (n && n.state === 'failed' && n.error) li.appendChild(el('div', 'reply', n.error));
      else if (n && n.reply) li.appendChild(el('div', 'reply', n.reply));
      else if (n && (n.state === 'queued' || n.state === 'sending' || n.state === 'ran')) li.appendChild(el('div', 'item-meta', 'Waiting for the reply…'));
      ul.appendChild(li);
    });
  }

  /* --------------------------------------------------------------- refresh */
  let inflight = false;
  let timer = 0;
  let lastAt = 0;
  let halted = false;
  let es = null;
  function schedule(ms) { clearTimeout(timer); if (!halted) timer = setTimeout(refresh, ms); }
  const nextPoll = () => (document.hidden ? 60000 : pending() ? 4000 : 15000);

  async function refresh() {
    if (inflight) return;
    inflight = true;
    let wait = nextPoll();
    try {
      const st = await request('GET', '/v1/state');
      lastAt = Date.now();
      S = Object.assign({ projects: [], sessions: [], tasks: [], notes: [], questions: [], agents: [] }, st);
      banner('');
      conn(true, 'Live');
      renderPickers(); renderNeeds(); renderSent();
      ensureStream();
    } catch (e) {
      conn(false, 'Offline');
      if (e.status === 401) {
        halted = true; // retrying with a bad token only gets this device banned
        banner('This phone is not paired. On your Mac, open Helm > Settings > Phone access and scan the QR code or open the link again.');
      } else if (e.status === 429) {
        wait = Math.max(5, e.retryAfter || 30) * 1000;
        banner('Too many requests from this device. Waiting a moment…');
      } else if (e.status === 403) {
        halted = true;
        banner('The hub refused this request: ' + e.message);
      } else {
        banner(friendly(e));
        wait = 8000;
      }
    } finally {
      inflight = false;
      schedule(wait);
    }
  }
  function ensureStream() {
    if (es && es.readyState !== 2) return;
    if (typeof EventSource === 'undefined') return;
    try {
      es = new EventSource('/v1/stream');
      const poke = () => schedule(Math.max(700, 3000 - (Date.now() - lastAt)));
      es.addEventListener('change', poke);
      es.addEventListener('reset', poke);
    } catch (e) { es = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastAt > 5000) schedule(0); });

  /* ------------------------------------------------------------ attachments */
  function attachWidget(root) {
    const files = [];
    const box = root;
    function render() {
      box.querySelectorAll('.chip').forEach((c) => c.remove());
      files.forEach((f, i) => {
        const c = el('span', 'chip');
        c.appendChild(el('span', '', f.name || 'file'));
        const x = el('button', '', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Remove ' + (f.name || 'file'));
        x.addEventListener('click', () => { files.splice(i, 1); render(); });
        c.appendChild(x);
        box.appendChild(c);
      });
    }
    function picker(label, accept, capture, multiple) {
      const l = el('label', 'pick');
      l.appendChild(document.createTextNode(label));
      const input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      if (capture) input.setAttribute('capture', capture);
      if (multiple) input.multiple = true;
      input.setAttribute('aria-label', label);
      input.addEventListener('change', () => {
        let skipped = '';
        Array.prototype.forEach.call(input.files || [], (f) => {
          if (f.size > MAX_BYTES) skipped = f.name + ' is over 20 MB';
          else if (files.length >= MAX_FILES) skipped = 'At most ' + MAX_FILES + ' files';
          else files.push(f);
        });
        input.value = '';
        render();
        if (skipped) banner(skipped); else if (/over 20 MB|At most/.test(bannerEl.textContent)) banner('');
      });
      l.appendChild(input);
      return l;
    }
    box.appendChild(picker('Photo', 'image/*', 'environment', false));
    box.appendChild(picker('File', '', '', true));
    return {
      get count() { return files.length; },
      clear() { files.length = 0; render(); },
      /** Upload each file in turn; resolves the attachment rows ({ id, name, path, ... }). */
      async upload(onProgress) {
        const out = [];
        for (let i = 0; i < files.length; i++) {
          if (onProgress) onProgress(i + 1, files.length);
          const f = files[i];
          const r = await request('POST', '/v1/attachments', {
            raw: f,
            headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': encodeURIComponent(f.name || 'photo.jpg') },
          });
          out.push(r.attachment);
        }
        return out;
      },
    };
  }
  const taskAttach = attachWidget($('task-attach'));
  const noteAttach = attachWidget($('note-attach'));

  /* ------------------------------------------------------------ new task */
  let taskBusy = false;
  async function addTask(start) {
    if (taskBusy) return;
    const title = $('task-title').value.trim();
    if (!title) { say('task-msg', 'warn', 'Give the task a title first.'); $('task-title').focus(); return; }
    if (!projectSel.value) { say('task-msg', 'warn', 'Pick a project first.'); return; }
    taskBusy = true;
    $('task-add').disabled = $('task-start').disabled = true;
    say('task-msg', 'warn', start ? 'Adding and starting…' : 'Adding…');
    try {
      let description = $('task-desc').value.trim();
      const atts = await taskAttach.upload((i, n) => say('task-msg', 'warn', 'Uploading ' + i + ' of ' + n + '…'));
      if (atts.length) {
        description += (description ? '\n\n' : '') + 'Attached files (open them with the Read tool):\n' + atts.map((a) => '- ' + a.path).join('\n');
      }
      const body = { projectId: projectSel.value, title: title, description: description };
      if (start) body.start = true;
      const r = await request('POST', '/v1/tasks', { json: body });
      const t = r.task;
      $('task-title').value = '';
      $('task-desc').value = '';
      taskAttach.clear();
      if (start && r.error) {
        say('task-msg', 'warn', t.id + ' was added but not started: ' + friendly({ message: r.error }) + ' It is in the backlog.');
      } else if (start && r.note) {
        say('task-msg', 'ok', t.id + ' added and sent to the session.');
        remember({ id: r.note.id, label: 'Start ' + t.id + ' · ' + t.title, at: Date.now() });
      } else {
        say('task-msg', 'ok', t.id + ' added to the backlog.');
      }
      schedule(300);
    } catch (e) {
      say('task-msg', 'err', friendly(e));
    } finally {
      taskBusy = false;
      $('task-add').disabled = $('task-start').disabled = false;
    }
  }
  $('task-form').addEventListener('submit', (e) => { e.preventDefault(); addTask(true); });
  $('task-add').addEventListener('click', () => addTask(false));

  /* ---------------------------------------------------------- note to session */
  let noteBusy = false;
  async function sendNote() {
    if (noteBusy) return;
    const sid = sessionSel.value;
    let text = $('note-text').value.trim();
    if (!sid) { say('note-msg', 'err', friendly({ message: 'no live session' })); return; }
    if (!text && !noteAttach.count) { say('note-msg', 'warn', 'Write a message first.'); $('note-text').focus(); return; }
    noteBusy = true;
    $('note-send').disabled = true;
    say('note-msg', 'warn', 'Sending…');
    try {
      const atts = await noteAttach.upload((i, n) => say('note-msg', 'warn', 'Uploading ' + i + ' of ' + n + '…'));
      if (!text) text = 'See the attached ' + (atts.length === 1 ? 'file' : 'files') + '.';
      const body = { target: { kind: 'session', id: sid }, text: text, execute: true };
      if (atts.length) body.attachments = atts.map((a) => a.id);
      const r = await request('POST', '/v1/notes', { json: body });
      $('note-text').value = '';
      noteAttach.clear();
      say('note-msg', 'ok', 'Sent. The reply will appear below.');
      remember({ id: r.note.id, label: text.length > 90 ? text.slice(0, 90) + '…' : text, at: Date.now() });
      schedule(300);
    } catch (e) {
      say('note-msg', 'err', friendly(e));
    } finally {
      noteBusy = false;
      renderSessions();
    }
  }
  $('note-form').addEventListener('submit', (e) => { e.preventDefault(); sendNote(); });

  /* ------------------------------------------------------------------ boot */
  $('where').textContent = location.host;
  renderNeeds();
  renderSent();
  renderPickers();
  refresh();
})();
