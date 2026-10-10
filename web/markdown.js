// markdown.js — tiny, safe markdown renderer. Builds DOM nodes (never HTML strings), so nothing is
// ever parsed as markup: every character from the source ends up in a text node.
// Supports: # headings, paragraphs, - / * bullet lists, 1. numbered lists, ``` code blocks,
// `inline code`, **bold**, *italic* / _italic_, --- rules. No links, no images, no raw HTML.
import { h } from './dom.js';

const INLINE = /`([^`\n]+)`|\*\*(?=\S)([\s\S]+?)\*\*|__(?=\S)([\s\S]+?)__|\*(?=[^\s*])([^*\n]+?)\*|(?<![A-Za-z0-9_])_(?=[^\s_])([^_\n]+?)_(?![A-Za-z0-9_])/;

/** Inline markdown → array of strings / elements. */
function inline(text) {
  const out = [];
  let rest = String(text);
  let guard = 0;
  while (rest && guard++ < 500) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    if (m[1] !== undefined) out.push(h('code', { class: 'md-code' }, m[1]));
    else if (m[2] !== undefined || m[3] !== undefined) out.push(h('strong', {}, inline(m[2] !== undefined ? m[2] : m[3])));
    else out.push(h('em', {}, inline(m[4] !== undefined ? m[4] : m[5])));
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const BULLET = /^(\s*)[-*+•]\s+(.*)$/;
const ORDERED = /^(\s*)\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Render markdown source to a <div class="md"> element. */
export function renderMarkdown(src) {
  const root = h('div', { class: 'md' });
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  let para = [];
  const flush = () => {
    if (para.length) { root.append(h('p', { class: 'md-p' }, inline(para.join(' ')))); para = []; }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++; // closing fence (or EOF)
      root.append(h('pre', { class: 'md-pre' }, h('code', {}, buf.join('\n'))));
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const hd = HEADING.exec(line);
    if (hd) {
      flush();
      const level = Math.min(hd[1].length, 4);
      root.append(h(level <= 2 ? 'h4' : 'h5', { class: `md-h md-h${level}` }, inline(hd[2])));
      i++;
      continue;
    }
    if (RULE.test(line)) { flush(); root.append(h('hr', { class: 'md-hr' })); i++; continue; }
    const isBullet = BULLET.exec(line);
    const isOrdered = !isBullet && ORDERED.exec(line);
    if (isBullet || isOrdered) {
      flush();
      const re = isBullet ? BULLET : ORDERED;
      const list = h(isBullet ? 'ul' : 'ol', { class: 'md-list' });
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (!m) {
          // indented continuation of the previous item
          if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !BULLET.test(lines[i]) && !ORDERED.test(lines[i]) && list.lastChild) {
            const li = list.lastChild;
            li.__text += ' ' + lines[i].trim();
            li.textContent = '';
            li.append(...inline(li.__text));
            i++;
            continue;
          }
          break;
        }
        const li = h('li', { class: m[1].length >= 2 ? 'md-l2' : null }, inline(m[2]));
        li.__text = m[2];
        list.append(li);
        i++;
      }
      root.append(list);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return root;
}

/** Replace `host`'s content with rendered markdown, skipping work when the source is unchanged. */
export function setMarkdown(host, src) {
  const text = src == null ? '' : String(src);
  if (host.__md === text) return;
  host.__md = text;
  host.textContent = '';
  if (text.trim()) host.append(renderMarkdown(text));
}
