// views/settings.js — Settings: Appearance (theme, accent, text size, density), Talk & chat (code mode + style), About.
// Every control writes through prefs.js, which applies it to <html> instantly and persists it.
import { h, setText, startTicker } from '../dom.js';
import { icon } from '../icons.js';
import { OPTIONS, getPref, setPref, onPrefs, resetAppearance, codeOn } from '../prefs.js';
import { createCodeTurn } from '../code.js';
import { createReply } from '../replies.js';
import { setLinked } from '../tasklinks.js';

const REPO = 'https://github.com/Alish-Basnett/helm';
const LABELS = {
  theme: { system: 'System', light: 'Light', dark: 'Dark' },
  fs: { s: 'Small', m: 'Medium', l: 'Large' },
  density: { comfortable: 'Comfortable', compact: 'Compact' },
  codestyle: { js: 'JavaScript', ts: 'TypeScript', py: 'Python' },
  accent: { cyan: 'Cyan', blue: 'Blue', indigo: 'Indigo', green: 'Green', orange: 'Orange', pink: 'Pink' },
};

function sampleNote() {
  const now = Date.now();
  return {
    id: 'N-7', state: 'ran', createdAt: now - 150000, ranAt: now - 120000, repliedAt: now - 60000,
    text: 'make the board yellow when waiting',
    reply: 'DONE: Waiting cards now glow yellow.\n\nThe rule lives in `views.css`:\n```js\nconst waiting = cards.filter((c) => c.status === "waiting");\n```\nFollow-up in `T-18`.',
  };
}

export function mount(container) {
  startTicker();
  const syncs = [];

  /* ----- control builders ----- */
  function seg(key, label) {
    const btns = OPTIONS[key].map((v) => h('button', {
      class: 'seg-btn', type: 'button', role: 'radio', 'data-v': v, onclick: () => setPref(key, v),
    }, LABELS[key][v]));
    const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label }, btns);
    const sync = () => { for (const b of btns) { const on = b.getAttribute('data-v') === getPref(key); b.setAttribute('aria-checked', String(on)); b.classList.toggle('on', on); b.tabIndex = on ? 0 : -1; } };
    el.addEventListener('keydown', (e) => {
      if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
      e.preventDefault();
      const o = OPTIONS[key];
      const d = /Left|Up/.test(e.key) ? -1 : 1;
      setPref(key, o[(o.indexOf(getPref(key)) + d + o.length) % o.length]);
      const on = btns.find((b) => b.getAttribute('data-v') === getPref(key));
      if (on) on.focus();
    });
    syncs.push(sync);
    return el;
  }
  function swatches() {
    const btns = OPTIONS.accent.map((v) => h('button', {
      class: 'sw', type: 'button', role: 'radio', 'data-v': v, 'data-accent-swatch': v, title: LABELS.accent[v], 'aria-label': LABELS.accent[v],
      onclick: () => setPref('accent', v),
    }, icon('check', 14)));
    const el = h('div', { class: 'sw-row', role: 'radiogroup', 'aria-label': 'Accent colour' }, btns);
    syncs.push(() => { for (const b of btns) { const on = b.getAttribute('data-v') === getPref('accent'); b.setAttribute('aria-checked', String(on)); b.classList.toggle('on', on); } });
    return el;
  }
  const tgl = h('button', {
    class: 'tgl', type: 'button', role: 'switch', id: 'set-code', 'aria-label': 'Code mode',
    onclick: () => setPref('code', codeOn() ? 'off' : 'on'),
  }, h('span', { class: 'tgl-knob' }));
  syncs.push(() => tgl.setAttribute('aria-checked', String(codeOn())));

  const row = (title, hint, control, id) => h('div', { class: 'set-row', id }, h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, title), hint ? h('div', { class: 'set-hint' }, hint) : null), h('div', { class: 'set-ctl' }, control));

  /* ----- live preview ----- */
  const preview = h('div', { class: 'set-preview', 'aria-label': 'Code mode preview' });
  const note = sampleNote();
  let cm = null;
  function paintPreview() {
    preview.textContent = '';
    preview.classList.toggle('cm-surface', codeOn());
    if (codeOn()) {
      cm = createCodeTurn();
      preview.append(cm.el);
      cm.update(note, getPref('codestyle'));
    } else {
      const text = h('div', { class: 'tk-text' });
      setLinked(text, note.text);
      const reply = createReply();
      reply.update(note);
      preview.append(h('div', { class: 'tk-turn state-ran' },
        h('div', { class: 'tk-me' }, h('div', { class: 'tk-bubble' }, text, h('div', { class: 'tk-meta mono' }, h('span', {}, 'Delivered')))),
        h('div', { class: 'tk-claude' }, reply.el)));
    }
  }
  syncs.push(paintPreview);

  /* ----- About ----- */
  const ver = h('span', { class: 'mono' }, '…');
  fetch('/v1/health', { cache: 'no-store' }).then((r) => r.json()).then((j) => setText(ver, j && j.version ? `v${j.version}` : 'unknown')).catch(() => setText(ver, 'hub unreachable'));

  const resetBtn = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: resetAppearance }, icon('retry', 14), 'Reset appearance');

  const page = h('div', { class: 'settings' },
    h('section', { class: 'set-card', 'aria-labelledby': 'set-h-appearance' },
      h('h2', { class: 'set-h', id: 'set-h-appearance' }, 'Appearance'),
      row('Theme', 'Follows your Mac by default.', seg('theme', 'Theme'), 'set-theme'),
      row('Accent colour', 'Buttons, links, focus rings and highlights.', swatches(), 'set-accent'),
      row('Text size', 'Scales text across the app and chat.', seg('fs', 'Text size'), 'set-fs'),
      row('Density', 'Compact tightens spacing and rows.', seg('density', 'Density'), 'set-density'),
      h('div', { class: 'set-foot' }, resetBtn)),
    h('section', { class: 'set-card', 'aria-labelledby': 'set-h-talk' },
      h('h2', { class: 'set-h', id: 'set-h-talk' }, 'Talk & chat'),
      row('Code mode', 'Makes Talk and Task chat look like source code from a distance: your messages become variables, replies become doc comments. Still easy to read and type in.', tgl, 'set-codemode'),
      row('Code mode style', 'Changes keywords and comment syntax.', seg('codestyle', 'Code mode style'), 'set-codestyle'),
      h('div', { class: 'set-previewbox' }, h('div', { class: 'set-hint set-prevlabel' }, icon('code', 14), 'Live preview'), preview)),
    h('section', { class: 'set-card', 'aria-labelledby': 'set-h-about' },
      h('h2', { class: 'set-h', id: 'set-h-about' }, 'About'),
      row('Helm', 'Local hub version', ver, 'set-version'),
      row('Source', 'Report issues or read the code.', h('a', { class: 'link-btn', href: REPO, target: '_blank', rel: 'noopener noreferrer' }, 'github.com/Alish-Basnett/helm'), 'set-repo')));
  container.append(page);

  const syncAll = (skipPreview) => { for (const s of syncs) if (!(skipPreview && s === paintPreview)) s(); };
  syncAll();
  const off = onPrefs((k) => { if (k === 'code' || k === 'codestyle') syncAll(); else syncAll(true); });
  return { destroy() { off(); } };
}
