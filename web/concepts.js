// concepts.js — v0.13 shared bits: concept slugs, links to the concept page, the recap-chip builder, the usage sparkline.
import { h, s } from './dom.js';
import { icon } from './icons.js';
import { state } from './store.js';
import { navigate } from './router.js';

/** Client mirror of the hub's slugify (hub/concepts.mjs): lower-case, de-accented, hyphenated. */
export function slugify(tag) {
  return String(tag == null ? '' : tag).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\+/g, ' plus ').replace(/#/g, ' sharp ').replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
}

/** The slug a recap tag points at: a known concept (by slug, name or alias) wins, else the tag's own slug (the hub resolves aliases). */
export function conceptSlugFor(tag) {
  const raw = String(tag == null ? '' : tag).trim().toLowerCase();
  const own = slugify(raw);
  if (state.concepts.has(own)) return own;
  for (const c of state.concepts.values()) {
    if (String(c.name).toLowerCase() === raw || (c.aliases || []).includes(raw)) return c.slug;
  }
  return own;
}

export const conceptHash = (slug) => `#/learn/c/${encodeURIComponent(slug)}`;
/** Open the concept page for a slug or a raw recap tag. */
export function openConcept(slugOrTag) {
  const slug = conceptSlugFor(slugOrTag);
  if (slug) navigate('learn', ['c', slug]);
}

/** The small tag button used for a recap's concepts anywhere: opens the concept page. */
export function conceptTag(tag, opts = {}) {
  const slug = conceptSlugFor(tag);
  const label = (state.concepts.get(slug) || {}).name || tag;
  return h('button', {
    class: ['tag', 'concept-tag', opts.on && 'on'], type: 'button', 'data-concept': slug,
    title: `Open the concept page for “${label}”`, onclick: (e) => { e.stopPropagation(); openConcept(slug); },
  }, icon('tag', 12), label);
}

/** Bars for the last `days` days (oldest left) from a concept's task timestamps. Returns an <svg>. */
export function sparkline(ats, { days = 14, w = 84, hgt = 22, now = Date.now() } = {}) {
  const DAY = 86_400_000;
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const t0 = d.getTime() - (days - 1) * DAY;
  const buckets = new Array(days).fill(0);
  for (const at of ats || []) {
    const i = Math.floor((at - t0) / DAY);
    if (i >= 0 && i < days) buckets[i]++;
  }
  const max = Math.max(1, ...buckets);
  const gap = 2, bw = (w - gap * (days - 1)) / days;
  const svg = s('svg', { class: 'spark', viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, role: 'img', 'aria-label': `Usage over the last ${days} days: ${buckets.reduce((a, b) => a + b, 0)} task${buckets.reduce((a, b) => a + b, 0) === 1 ? '' : 's'}` });
  buckets.forEach((n, i) => {
    const bh = n ? Math.max(3, Math.round((n / max) * (hgt - 2))) : 1.5;
    svg.append(s('rect', { class: n ? 'spark-bar on' : 'spark-bar', x: (i * (bw + gap)).toFixed(2), y: (hgt - bh).toFixed(2), width: bw.toFixed(2), height: bh, rx: 1 }));
  });
  return svg;
}
