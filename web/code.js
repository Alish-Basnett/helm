// code.js — "code disguise" for Talk and Task chat. A tiny tokenizer (JavaScript, TypeScript, Python, shell) plus DOM
// builders that turn notes and replies into editor-looking lines. Everything is built from DOM nodes and text nodes;
// no HTML string is ever parsed, so model output and user text can never inject markup.
import { h, setHidden } from './dom.js';
import { codeChipParts, taskLinkSig } from './tasklinks.js';
import { shortAnswer, replyModel, replyPending, replyDeadline } from './replies.js';
import { modelInfo } from './format.js';
import { api } from './api.js';
import { openLightbox, isImage, fmtSize } from './attachments.js';
import { getPref, codeOn, onPrefs } from './prefs.js';

/* ================= tokenizer ================= */
const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
const JS_KW = 'const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of delete void yield static get set';
const KW = {
  js: words(JS_KW),
  ts: words(`${JS_KW} interface type enum implements readonly public private protected abstract declare namespace as is keyof satisfies`),
  py: words('def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield async await global nonlocal del assert match case'),
  sh: words('if then else elif fi for do done while case esac function in export local return echo cd'),
};
const LIT_JS = words('null true false undefined NaN Infinity this super');
const LIT_PY = words('None True False self cls');
const TYPES = words('string number boolean any void unknown never object bigint symbol int str float bool list dict set tuple bytes');
const NUM = /0[xX][\da-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?/y;
const IDENT = /[A-Za-z_$][\w$]*/y;
const CALL = /[ \t]*\(/y;
const PY_PREFIX = /^[rRbBfFuU]{1,2}$/;

/** Lossless: the token values always concatenate back to `src`. Classes: k s c n f t v p i(plain) w(space). */
export function tokenize(src, lang = 'js') {
  src = String(src == null ? '' : src);
  const hashC = lang === 'py' || lang === 'sh';
  const kw = KW[lang] || KW.js;
  const lits = hashC ? LIT_PY : LIT_JS;
  const out = [];
  const n = src.length;
  let i = 0;
  const push = (c, v) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.c === c && (c === 'p' || c === 'w' || c === 'i')) last.v += v; else out.push({ c, v });
  };
  function readString(start, qIdx) {
    const q = src[qIdx];
    let j = qIdx + 1;
    if (hashC && src.startsWith(q.repeat(3), qIdx)) {
      j = qIdx + 3;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src.startsWith(q.repeat(3), j)) { j += 3; break; }
        j++;
      }
    } else {
      while (j < n) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === q) { j++; break; }
        if (c === '\n') break;
        j++;
      }
    }
    j = Math.min(j, n);
    push('s', src.slice(start, j));
    i = j;
  }
  function template() { // i is just past the opening backtick
    let s = '`';
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') { s += src.slice(i, i + 2); i += 2; continue; }
      if (ch === '`') { s += '`'; i++; push('s', s); return; }
      if (ch === '$' && src[i + 1] === '{') { push('s', s); s = ''; push('p', '${'); i += 2; code(true); push('p', '}'); continue; }
      s += ch; i++;
    }
    push('s', s);
  }
  function code(stopAtBrace) {
    let depth = 0;
    while (i < n) {
      const ch = src[i];
      if (/\s/.test(ch)) { let j = i + 1; while (j < n && /\s/.test(src[j])) j++; push('w', src.slice(i, j)); i = j; continue; }
      if (!hashC && ch === '/' && src[i + 1] === '/') { let j = src.indexOf('\n', i); if (j < 0) j = n; push('c', src.slice(i, j)); i = j; continue; }
      if (!hashC && ch === '/' && src[i + 1] === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; push('c', src.slice(i, j)); i = j; continue; }
      if (hashC && ch === '#') { let j = src.indexOf('\n', i); if (j < 0) j = n; push('c', src.slice(i, j)); i = j; continue; }
      if (ch === '"' || ch === "'") { readString(i, i); continue; }
      if (ch === '`' && !hashC) { i++; template(); continue; }
      if (ch === '}' && stopAtBrace) { if (depth === 0) { i++; return; } depth--; push('p', '}'); i++; continue; }
      if (ch === '{') depth++;
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        NUM.lastIndex = i;
        const m = NUM.exec(src);
        if (m) { push('n', m[0]); i += m[0].length; continue; }
      }
      if (/[A-Za-z_$]/.test(ch)) {
        IDENT.lastIndex = i;
        const w = IDENT.exec(src)[0];
        const end = i + w.length;
        if (hashC && PY_PREFIX.test(w) && (src[end] === '"' || src[end] === "'")) { readString(i, end); continue; }
        CALL.lastIndex = end;
        const call = CALL.test(src);
        let c = 'i';
        if (kw.has(w)) c = 'k';
        else if (lits.has(w)) c = 'v';
        else if (call) c = 'f';
        else if (TYPES.has(w) || /^[A-Z][a-z0-9]/.test(w)) c = 't';
        else if (/^[A-Z][A-Z0-9_]+$/.test(w)) c = 'v';
        push(c, w);
        i = end;
        continue;
      }
      push('p', ch);
      i++;
    }
  }
  code(false);
  return out;
}

/** Tokens → one array of tokens per source line (multi-line strings and comments are split at newlines). */
export function splitLines(tokens) {
  const lines = [[]];
  for (const t of tokens) {
    t.v.split('\n').forEach((part, k) => {
      if (k > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ c: t.c, v: part });
    });
  }
  return lines;
}
export const tokenizeLines = (src, lang) => splitLines(tokenize(src, lang));

/** One line of tokens → DOM nodes (spans per token class, indent guides, clickable task chips inside strings). */
export function tokNodes(tokens, guides = true) {
  const out = [];
  tokens.forEach((t, idx) => {
    if (t.c === 'w' || t.c === 'i') {
      let v = t.v;
      if (idx === 0 && guides && t.c === 'w') {
        const m = /^ +/.exec(v);
        if (m) {
          let sp = m[0];
          while (sp.length >= 2) { out.push(h('span', { class: 'cm-ig' }, '  ')); sp = sp.slice(2); }
          v = sp + v.slice(m[0].length);
        }
      }
      if (v) out.push(v);
    } else if (t.c === 's') {
      out.push(h('span', { class: 'cm-s' }, codeChipParts(t.v) || t.v));
    } else out.push(h('span', { class: `cm-${t.c}` }, t.v));
  });
  return out;
}

/* ================= styles + small helpers ================= */
export const STYLES = {
  js: { id: 'js', label: 'JavaScript', lang: 'js', com: '//' },
  ts: { id: 'ts', label: 'TypeScript', lang: 'ts', com: '//' },
  py: { id: 'py', label: 'Python', lang: 'py', com: '#' },
};
const styleOf = (s) => STYLES[s] || STYLES.js;
const norm = (t) => String(t == null ? '' : t).replace(/\r\n?/g, '\n');
const FENCE_LANG = { js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', node: 'js', json: 'js', ts: 'ts', typescript: 'ts', tsx: 'ts', py: 'py', python: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh' };

const WORDS = ['ask', 'plan', 'fix', 'idea', 'todo', 'hint', 'nudge', 'req', 'tweak', 'step', 'probe', 'wish', 'chore', 'bump', 'spec', 'poke'];
/** n7 for note id "N-7" / "n7" / "7"; otherwise a stable word + digits from a hash of the id. */
export function varName(id) {
  const s = String(id == null ? '' : id);
  const m = /^[A-Za-z]?-?(\d+)$/.exec(s);
  if (m) return `n${Number(m[1])}`;
  let x = 2166136261;
  for (let k = 0; k < s.length; k++) { x ^= s.charCodeAt(k); x = Math.imul(x, 16777619) >>> 0; }
  return `${WORDS[x % WORDS.length]}${(x >>> 8) % 100}`;
}

/** `const name = "…";` (template literal when multi-line, or when `multi` is forced). Escapes so it is valid code. */
export function stringDecl(name, text, style, multi) {
  const st = styleOf(style);
  text = norm(text);
  if (multi == null) multi = text.includes('\n');
  if (st.id === 'py') {
    if (!multi) return `${name} = "${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return `${name} = """${text.replace(/\\/g, '\\\\').replace(/"{3}/g, '\\"\\"\\"').replace(/"$/, '\\"')}"""`;
  }
  const decl = st.id === 'ts' ? `const ${name}: string = ` : `const ${name} = `;
  if (!multi) return `${decl}"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";`;
  return `${decl}\`${text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\`;`;
}
/** The note as a line of source: `const n7 = "…";`. */
export const messageSource = (n, style) => stringDecl(varName(n.id), n.text, style);

const line = (nodes, cls, hang) => h('div', { class: ['cm-line', cls], style: hang ? { '--hang': `${hang}ch` } : null }, h('span', { class: 'cm-code' }, nodes));
/** A comment line: ` * text` (JS/TS) or `# text` (Python). */
function cline(style, nodes, { cls, extra = 0 } = {}) {
  const pre = styleOf(style).com === '#' ? '# ' : ' * ';
  return line([pre, nodes], ['cm-doc', cls].filter(Boolean).join(' '), pre.length + extra);
}
const emptyCline = (style) => line([styleOf(style).com === '#' ? '#' : ' *'], 'cm-doc');

/* ================= my messages ================= */
function stateComment(n, style, ctx) {
  const sym = styleOf(style).com;
  const kids = [`${sym} `];
  const act = (label, fn) => h('button', { class: 'cm-act', type: 'button', onclick: (e) => { e.stopPropagation(); fn(n); } }, label);
  if (n.__pending || n.state === 'sending') kids.push('… sending');
  else if (n.state === 'queued') kids.push('… queued');
  else if (n.state === 'ran') kids.push(n.via === 'start' ? '✓ sent with Start ' : '✓ delivered ', h('span', { 'data-ago': n.ranAt || n.createdAt || Date.now() }, ''));
  else if (n.state === 'failed') {
    kids.push('✗ failed');
    if (n.error) kids.push(' — ', h('span', { class: 'cm-err', title: n.error }, n.error));
    kids.push(' ', act('retry()', ctx.onRetry));
  } else if (n.state === 'draft') {
    kids.push('✎ draft ');
    if (ctx.holdSend && ctx.holdSend(n)) kids.push('will be sent when you press Start ');
    else kids.push(act('send()', ctx.onSend), ' ');
    if (ctx.onEdit) kids.push(act('edit()', ctx.onEdit), ' ');
    kids.push(act('delete()', ctx.onDelete));
  }
  else kids.push(String(n.state));
  const tone = n.__pending ? 'sending' : n.state;
  return h('span', { class: `cm-c cm-state cm-st-${tone}` }, kids);
}

function attachmentLines(atts, style) {
  return (Array.isArray(atts) ? atts : []).map((a) => {
    const url = api.attachmentUrl(a.id);
    const path = `"./${String(a.name || a.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const title = `${a.name || a.id} · ${fmtSize(a.size)}`;
    const link = isImage(a)
      ? h('button', { class: 'cm-s cm-link', type: 'button', title, 'aria-label': `Open image ${a.name || a.id}`, onclick: (e) => { e.stopPropagation(); openLightbox(url, a.name); } }, path)
      : h('a', { class: 'cm-s cm-link', href: url, target: '_blank', rel: 'noopener', title, onclick: (e) => e.stopPropagation() }, path);
    const nodes = styleOf(style).id === 'py'
      ? [h('span', { class: 'cm-i' }, 'file'), h('span', { class: 'cm-p' }, ' = '), h('span', { class: 'cm-f' }, 'open'), h('span', { class: 'cm-p' }, '('), link, h('span', { class: 'cm-p' }, ')')]
      : [h('span', { class: 'cm-k' }, 'import'), ' ', isImage(a) ? 'img' : 'file', ' ', h('span', { class: 'cm-k' }, 'from'), ' ', link, h('span', { class: 'cm-p' }, ';')];
    return line(nodes, 'cm-att');
  });
}

/* ================= Claude's replies ================= */
const INLINE = /`([^`\n]+)`|\*\*(?=\S)([\s\S]+?)\*\*|__(?=\S)([\s\S]+?)__|\*(?=[^\s*])([^*\n]+?)\*|(?<![A-Za-z0-9_])_(?=[^\s_])([^_\n]+?)_(?![A-Za-z0-9_])/;
function inlineNodes(text, lang) {
  const out = [];
  let rest = String(text);
  let guard = 0;
  const plain = (t) => { if (t) { const p = codeChipParts(t); if (p) out.push(...p); else out.push(t); } };
  while (rest && guard++ < 500) {
    const m = INLINE.exec(rest);
    if (!m) { plain(rest); break; }
    if (m.index > 0) plain(rest.slice(0, m.index));
    if (m[1] !== undefined) out.push(h('code', { class: 'cm-ic' }, tokNodes(tokenizeLines(m[1], lang)[0] || [], false)));
    else if (m[2] !== undefined || m[3] !== undefined) out.push(h('strong', { class: 'cm-b' }, inlineNodes(m[2] !== undefined ? m[2] : m[3], lang)));
    else out.push(h('em', { class: 'cm-em' }, inlineNodes(m[4] !== undefined ? m[4] : m[5], lang)));
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const BULLET = /^(\s*)[-*+•]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LABEL = /^(DONE|HOW|FILES|LEARNED|TAGS|NOTE|TODO|FIXME|WARNING)\s*:\s*/;

/** Reply markdown → comment lines (DOM). Fenced code and `code` spans are highlighted as real code. */
export function replyLines(src, style) {
  const st = styleOf(style);
  const lines = norm(src).split('\n');
  const out = [];
  let para = [];
  const blank = () => { if (out.length && !out[out.length - 1].classList.contains('cm-blank')) { const l = emptyCline(style); l.classList.add('cm-blank'); out.push(l); } };
  const flush = () => {
    if (!para.length) return;
    let t = para.join(' ');
    para = [];
    const lab = LABEL.exec(t);
    const nodes = [];
    if (lab) { nodes.push(h('span', { class: 'cm-tag' }, `@${lab[1].toLowerCase()}`), ' '); t = t.slice(lab[0].length); }
    nodes.push(...inlineNodes(t, st.lang));
    out.push(cline(style, nodes));
  };
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const f = FENCE.exec(ln);
    if (f) {
      flush(); blank();
      const lang = FENCE_LANG[(f[2] || '').toLowerCase()] || st.lang;
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(f[1])) buf.push(lines[i++]);
      i++;
      out.push(cline(style, [h('span', { class: 'cm-tag' }, '@example'), ` ${f[2] || lang}`]));
      for (const tl of tokenizeLines(buf.join('\n'), lang)) out.push(cline(style, [h('span', { class: 'cm-ex' }, tokNodes(tl))], { cls: 'cm-exline' }));
      blank();
      continue;
    }
    if (!ln.trim()) { flush(); blank(); i++; continue; }
    const hd = HEADING.exec(ln);
    if (hd) { flush(); blank(); out.push(cline(style, [h('span', { class: 'cm-tag' }, '@section'), ' ', h('strong', { class: 'cm-b' }, inlineNodes(hd[2], st.lang))])); i++; continue; }
    if (RULE.test(ln)) { flush(); blank(); i++; continue; }
    const b = BULLET.exec(ln);
    const o = !b && ORDERED.exec(ln);
    if (b || o) {
      flush();
      const lead = '  '.repeat(Math.min(2, Math.floor(((b || o)[1] || '').length / 2)));
      const mark = b ? '- ' : `${o[2]}. `;
      out.push(cline(style, [lead + mark, ...inlineNodes(b ? b[2] : o[3], st.lang)], { extra: lead.length + mark.length }));
      i++;
      continue;
    }
    para.push(ln.trim());
    i++;
  }
  flush();
  while (out.length && out[out.length - 1].classList.contains('cm-blank')) out.pop();
  return out.length ? out : [cline(style, [''])];
}

/** A concept page as one big doc comment (Code mode): `/** @concept name … *\/` over `export function name() {}`. */
export function docBlock(src, style, name, slug) {
  const st = styleOf(style);
  const py = st.id === 'py';
  const ident = String(slug || name || 'concept').replace(/[^A-Za-z0-9]+/g, '_').replace(/^(\d)/, '_$1').replace(/^_+|_+$/g, '') || 'concept';
  const head = line([h('span', { class: 'cm-c' }, py ? '# ' : '/** '), h('span', { class: 'cm-tag' }, '@concept'), ' ', h('span', { class: 'cm-t' }, name)], 'cm-doc');
  const decl = line(py
    ? [h('span', { class: 'cm-k' }, 'def'), ' ', h('span', { class: 'cm-f' }, ident), h('span', { class: 'cm-p' }, '(): '), h('span', { class: 'cm-k' }, 'pass')]
    : [h('span', { class: 'cm-k' }, 'export function'), ' ', h('span', { class: 'cm-f' }, ident), h('span', { class: 'cm-p' }, '() {}')]);
  return h('div', { class: 'cm-block cm-docblock' }, head, ...replyLines(src, style), py ? null : line([' */'], 'cm-doc'), decl);
}

/** The reply block: header, short-first body with a folded `/* … N more lines *\/` region, closing line. */
function createReplyBlock() {
  let open = false;
  let sig = '';
  const head = h('div', { class: 'cm-line cm-doc cm-rhead' });
  const shortBox = h('div', { class: 'cm-rshort' });
  const fullBox = h('div', { class: 'cm-rfull', hidden: true });
  const foldBtn = h('button', { class: 'cm-fold', type: 'button', 'aria-expanded': 'false' });
  const foldLine = h('div', { class: 'cm-line cm-doc cm-foldline', hidden: true }, h('span', { class: 'cm-code' }, foldBtn));
  const tail = h('div', { class: 'cm-line cm-doc cm-rtail' });
  const el = h('div', { class: 'cm-reply', hidden: true }, head, shortBox, fullBox, foldLine, tail);
  let more = false;
  let hidden = 0;
  let com = '//';
  const apply = () => {
    const full = open || !more;
    setHidden(shortBox, full);
    setHidden(fullBox, !full);
    setHidden(foldLine, !more);
    foldBtn.setAttribute('aria-expanded', String(open));
    const t = open ? '▴ fold' : `… ${hidden} more line${hidden === 1 ? '' : 's'}`;
    foldBtn.textContent = com === '#' ? `# ${t}` : `/* ${t} */`;
    foldBtn.title = open ? 'Fold the reply back to its first line' : 'Show the full reply';
  };
  foldBtn.addEventListener('click', () => { open = !open; apply(); });
  function update(n, style) {
    const has = !!(n && n.reply);
    setHidden(el, !has);
    if (!has) { sig = ''; return; }
    const st = styleOf(style);
    const model = replyModel(n);
    const at = n.repliedAt || n.ranAt || n.createdAt;
    const s = [style, n.id, n.reply, model, at, taskLinkSig(n.reply)].join('\u0001');
    if (s === sig) return;
    sig = s;
    com = st.com;
    const sa = shortAnswer(n.reply);
    more = sa.more && !!sa.short;
    const fullLines = replyLines(n.reply, style);
    const shortLines = more ? replyLines(sa.short, style) : [];
    hidden = Math.max(1, fullLines.length - shortLines.length);
    shortBox.textContent = ''; fullBox.textContent = '';
    shortBox.append(...shortLines);
    fullBox.append(...fullLines);
    const v = varName(n.id);
    const mLabel = model ? modelInfo(model).label : '';
    head.textContent = '';
    const meta = [];
    if (mLabel) meta.push(' · ', mLabel);
    if (at) meta.push(' · ', h('span', { 'data-ago': at }, ''));
    head.append(h('span', { class: 'cm-code' }, st.id === 'py'
      ? [h('span', { class: 'cm-c' }, '# '), h('span', { class: 'cm-f' }, 'reply'), h('span', { class: 'cm-p' }, '('), v, h('span', { class: 'cm-p' }, ')'), ...meta]
      : [h('span', { class: 'cm-c' }, '/** '), h('span', { class: 'cm-tag' }, '@reply'), ' ', h('span', { class: 'cm-t' }, v), ...meta]));
    tail.textContent = '';
    setHidden(tail, st.id === 'py');
    if (st.id !== 'py') tail.append(h('span', { class: 'cm-code' }, ' */'));
    apply();
  }
  return { el, update };
}

/* ================= one turn: my line(s) + Claude's reply ================= */
/** ctx: { onSend(n), onDelete(n), onRetry(n), onEdit?(n) } → { el, update(note, style) }. onEdit adds an `edit()` token
 *  to draft lines and makes a click on a draft's code start editing it. */
export function createCodeTurn(ctx = {}) {
  const noop = () => {};
  const c = { holdSend: ctx.holdSend || null, onSend: ctx.onSend || noop, onDelete: ctx.onDelete || noop, onRetry: ctx.onRetry || noop, onEdit: ctx.onEdit || null };
  let sig = '';
  let cur = null;
  const me = h('div', { class: 'cm-me' });
  if (c.onEdit) {
    me.addEventListener('click', (e) => {
      if (!cur || cur.state !== 'draft' || cur.__pending || e.target.closest('button, a') || String(getSelection()).length) return;
      c.onEdit(cur);
    });
  }
  const reply = createReplyBlock();
  const wait = h('div', { class: 'cm-line cm-wait', role: 'status', hidden: true }, h('span', { class: 'cm-code' }));
  const el = h('div', { class: 'cm-turn' }, me, reply.el, wait);
  function update(n, style) {
    cur = n;
    const st = styleOf(style);
    const s = [style, n.id, n.text, n.state, n.ranAt, n.error || '', n.__pending ? 1 : 0, n.via || '', c.holdSend ? (c.holdSend(n) ? 1 : 0) : 0, taskLinkSig(n.text), (n.attachments || []).map((a) => a.id).join(',')].join('\u0001');
    if (s !== sig) {
      sig = s;
      me.textContent = '';
      const tl = tokenizeLines(messageSource(n, style), st.lang);
      const lines = tl.map((t) => line(tokNodes(t, false), 'cm-msg'));
      lines[lines.length - 1].firstChild.append(' ', stateComment(n, style, c));
      me.append(...lines, ...attachmentLines(n.attachments, style));
    }
    reply.update(n, style);
    const pend = replyPending(n);
    setHidden(wait, !pend);
    if (pend) {
      wait.setAttribute('data-expire', String(replyDeadline(n)));
      const key = `${style}|${n.id}`;
      if (wait.__k !== key) {
        wait.__k = key;
        const v = varName(n.id);
        wait.firstChild.textContent = '';
        wait.firstChild.append(h('span', { class: 'cm-k' }, 'await'), ' ', h('span', { class: 'cm-f' }, 'reply'), h('span', { class: 'cm-p' }, '('), v, h('span', { class: 'cm-p' }, ')'),
          h('span', { class: 'cm-p' }, st.id === 'py' ? '' : ';'), ' ', h('span', { class: 'cm-c cm-wait-text' }, `${st.com} … waiting for reply`));
      }
    } else wait.removeAttribute('data-expire');
  }
  return { el, update };
}

/* ================= composer overlay ================= */
/** The typed text as a string body: `inline code` and T-n references coloured, the text itself never altered. */
function bodyNodes(text, st) {
  const body = [];
  for (const part of text.split(/(`[^`\n]+`|(?<![A-Za-z0-9_])T-\d+(?![A-Za-z0-9_]))/)) {
    if (!part) continue;
    if (part.length > 2 && part[0] === '`' && part[part.length - 1] === '`') body.push('`', h('span', { class: 'cm-ic' }, tokNodes(tokenizeLines(part.slice(1, -1), st.lang)[0] || [], false)), '`');
    else if (/^T-\d+$/.test(part)) body.push(h('span', { class: 'cm-t' }, part));
    else body.push(part);
  }
  return body;
}
/** `const msg = ` (or `msg = ` in Python) as nodes, plus its plain-text length for the textarea's text-indent. */
function declHead(st, name) {
  const py = st.id === 'py';
  const nodes = py
    ? [h('span', { class: 'cm-i' }, name), h('span', { class: 'cm-p' }, ' = ')]
    : [h('span', { class: 'cm-k' }, 'const'), ' ', h('span', { class: 'cm-i' }, name), st.id === 'ts' ? h('span', { class: 'cm-p' }, ': ') : '', st.id === 'ts' ? h('span', { class: 'cm-t' }, 'string') : '', h('span', { class: 'cm-p' }, ' = ')];
  const len = py ? `${name} = `.length : (st.id === 'ts' ? `const ${name}: string = ` : `const ${name} = `).length;
  return { nodes, len };
}

/** The closing quote + `;`: painted after the text but occupying zero width, so it can never change where text wraps. */
/** The hint after an empty field: pushed right by the (zero-width) suffix's real width so the two never overlap. */
const phNode = (st, placeholder, q, py) => h('span', { class: 'cm-c cm-ph', style: { marginLeft: `${q.length + (py ? 0 : 1) + 1}ch` } }, `${st.com} ${placeholder}`);
const sfxNode = (q, py) => h('span', { class: 'cm-sfx' }, h('span', { class: 'cm-sfx-in' }, [h('span', { class: 'cm-s' }, q), h('span', { class: 'cm-p' }, py ? '' : ';')]));

/** What the highlighted layer under the textarea shows: `const msg = "` + the typed text + `";`. Text is never altered. */
export function composerView(text, style, placeholder, name = 'msg') {
  const st = styleOf(style);
  text = norm(text);
  const multi = text.includes('\n');
  const py = st.id === 'py';
  const q = multi ? (py ? '"""' : '`') : '"';
  const head = declHead(st, name);
  // The prefix is unbreakable (the textarea indents its first line by the same width) and the suffix takes no width, so
  // both layers wrap at exactly the same character. A trailing newline still yields a last line because the suffix
  // sits after it.
  const nodes = [h('span', { class: 'cm-pfx' }, [...head.nodes, h('span', { class: 'cm-s' }, q)]), h('span', { class: 'cm-s cm-sb' }, [...bodyNodes(text, st), text.endsWith('\n') ? '\u200b' : '']), sfxNode(q, py)];
  if (!text && placeholder) nodes.push(phNode(st, placeholder, q, py));
  return { nodes, prefixLen: head.len + q.length };
}

/** Like composerView but one entry per typed line (`lines`), for an editor with a line-number gutter. The text is
 *  always shown as a template literal (or triple-quoted string), so the quotes never flip while typing. */
export function blockView(text, style, placeholder, name = 'description') {
  const st = styleOf(style);
  text = norm(text);
  const py = st.id === 'py';
  const q = py ? '"""' : '`';
  const head = declHead(st, name);
  const parts = text.split('\n');
  const lines = parts.map((ln, i) => {
    const nodes = [];
    if (i === 0) nodes.push(h('span', { class: 'cm-pfx' }, [...head.nodes, h('span', { class: 'cm-s' }, q)]));
    nodes.push(h('span', { class: 'cm-s cm-sb' }, bodyNodes(ln, st)));
    if (i === parts.length - 1) {
      nodes.push(sfxNode(q, py));
      if (!text && placeholder) nodes.push(phNode(st, placeholder, q, py));
    }
    return nodes;
  });
  return { lines, prefixLen: head.len + q.length };
}

/**
 * Code mode for any textarea: a highlighted layer sits under the (transparent-text) textarea so typing is coloured live.
 * Returns { el, hl, sync, destroy }; put `el` (it now holds the textarea) where the textarea used to be. Nothing happens
 * while Code mode is off, and the layer follows the setting live. opts:
 *   view(text, style, ta) → { nodes, prefixLen } (inline composer) or { lines, prefixLen } (gutter + one entry per line)
 *   block   – the gutter variant: also grows the textarea to its content so the layers stay aligned
 *   className – extra class(es) for the wrapper
 */
export function codeEditor(ta, opts = {}) {
  const view = opts.view || ((t, st) => composerView(t, st, ta.getAttribute('placeholder') || ''));
  const block = !!opts.block;
  const hl = h('pre', { class: 'cm-hl', 'aria-hidden': 'true' });
  const el = h('div', { class: ['cm-ed', block && 'cm-ed-block', opts.className] }, hl, ta);
  ta.classList.add('cm-ta');
  function sync() {
    if (!codeOn()) { ta.style.textIndent = ''; hl.textContent = ''; if (block) ta.style.height = ''; return; }
    const v = view(ta.value, getPref('codestyle'), ta);
    hl.textContent = '';
    if (v.lines) hl.append(...v.lines.map((nodes) => line(nodes, 'cm-msg')));
    else hl.append(...v.nodes);
    ta.style.textIndent = `${v.prefixLen}ch`;
    if (block) { ta.style.height = 'auto'; ta.style.height = `${Math.max(ta.scrollHeight, 0)}px`; }
    hl.scrollTop = ta.scrollTop;
  }
  const onScroll = () => { hl.scrollTop = ta.scrollTop; };
  ta.addEventListener('input', sync);
  ta.addEventListener('scroll', onScroll);
  const off = onPrefs((k) => { if (k === 'code' || k === 'codestyle') sync(); });
  sync();
  return { el, hl, sync, destroy() { off(); ta.removeEventListener('input', sync); ta.removeEventListener('scroll', onScroll); } };
}

/* ================= blocks: any text as a code block ================= */
/** Source text → a block of numbered, highlighted code lines (DOM only). opts: { cls } extra class for the block. */
export function renderCodeBlock(src, style, opts = {}) {
  const lines = tokenizeLines(src, styleOf(style).lang).map((t) => line(tokNodes(t, false), 'cm-msg'));
  return h('div', { class: ['cm-block', opts.cls] }, lines);
}

/** A task's description as source: a typed header object and the text as a template literal. */
export function descriptionSource(task, style) {
  const st = styleOf(style);
  const id = JSON.stringify(String(task.id || ''));
  const status = JSON.stringify(String(task.status || ''));
  const text = norm(task.description).trim();
  const head = st.id === 'py' ? `task = {"id": ${id}, "status": ${status}}`
    : st.id === 'ts' ? `export const task: Task = { id: ${id}, status: ${status} };`
      : `export const task = { id: ${id}, status: ${status} };`;
  const body = text
    ? stringDecl('description', text, style, true)
    : `${stringDecl('description', '', style, false)} ${st.com} click to add a description`;
  return `${head}\n${body}`;
}
/** The description view: a code block; a click anywhere on it (not on a task chip) calls opts.onEdit. */
export function renderDescription(task, style, opts = {}) {
  return renderCodeBlock(descriptionSource(task, style), style, { cls: 'cm-desc-block' });
}

/** One note in code form (`const n12 = "…"; // ✓ delivered 2m ago`, reply as a `/** @reply *\/` block), cached on `host`. */
export function noteAsCode(host, n, style, ctx) {
  let cm = host.__cm;
  if (!cm) { cm = host.__cm = createCodeTurn(ctx); host.append(cm.el); }
  cm.update(n, style);
  return cm;
}
