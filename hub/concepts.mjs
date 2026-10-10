// Concepts (CONTRACT v0.13): a knowledge base built from recap `concepts[]` tags.
// Everything here is a projection of events: `recap.generated` (via conceptsOnRecap) plus the `hub.concept.*` commands
// (update, merge) and the `job.result` of a concept_summary job (storeSummary). No wall clock, no randomness: time is `ev.at`.
// Tables: concepts (the row), concept_tasks (slug x task, the source of count / first / last / related) and
// concept_keys (match key -> slug, so a variant spelling lands on the same concept).

const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));
const cut = (s, n) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export const MAX_RELATED = 5;
export const MAX_ALIASES = 20;
export const SUMMARY_MIN_TASKS = 3; // a concept this well used with no page gets needsSummary
export const STATE_CONCEPTS = 200;
export const MAX_SUMMARY = 8000;

/** Small built-in alias map: match key -> canonical display name. Keys are already normalised (see conceptKey). */
export const BUILTIN_ALIASES = {
  js: 'javascript', ts: 'typescript', py: 'python', golang: 'go', postgres: 'postgresql', psql: 'postgresql',
  k8s: 'kubernetes', regexp: 'regex', a11y: 'accessibility', i18n: 'internationalization',
  l10n: 'localization', nodejs: 'node', reactjs: 'react', vuejs: 'vue', tailwindcss: 'tailwind', gh: 'github',
  sqllite: 'sqlite', e2e: 'end-to-end-testing', tdd: 'test-driven-development', ci: 'continuous-integration',
};

/** Lower-case, de-accented, hyphenated slug of a tag ("Node.js" -> "node-js", "C++" -> "c-plus-plus"). '' when nothing is left. */
export function slugify(tag) {
  return str(tag).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\+/g, ' plus ').replace(/#/g, ' sharp ').replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
}
/** The word "tests" and "test" must match: drop one trailing "s" (not "ss", "us", "is"), "ies" -> "y". */
function singular(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}
/**
 * The match key of a tag: hyphens removed ("sql-lite" = "sqlite"), singular ("tests" = "test"), then the built-in map
 * ("js" = "javascript"). Returns { key, name } where name is the canonical display name when the built-in map hit.
 */
export function conceptKey(tag) {
  const slug = slugify(tag);
  if (!slug) return null;
  const flat = slug.replace(/-/g, '');
  let key = singular(flat);
  let name = null;
  const hit = Object.hasOwn(BUILTIN_ALIASES, flat) ? BUILTIN_ALIASES[flat] : Object.hasOwn(BUILTIN_ALIASES, key) ? BUILTIN_ALIASES[key] : null;
  if (hit) { name = hit; key = singular(hit.replace(/-/g, '')); }
  return { key, name, slug };
}

export const toConcept = (r, { summary = false } = {}) => ({
  slug: r.slug, name: r.name, aliases: parse(r.aliases, []),
  summary: summary ? (r.summary ?? null) : null, hasSummary: r.summary != null && r.summary !== '',
  summaryAt: r.summary_at ?? null,
  taskIds: parse(r.task_ids, []), taskAts: parse(r.task_ats, []),
  firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, count: r.count,
  related: parse(r.related, []), pinned: !!r.pinned,
  needsSummary: r.count >= SUMMARY_MIN_TASKS && !(r.summary != null && r.summary !== ''),
});
export const getConcept = (db, slug) => db.get('SELECT * FROM concepts WHERE slug = ?', slug);
/** A concept by its slug, or by any variant spelling of it (a merged-away name still finds the survivor). */
export function resolveConcept(db, slugOrName) {
  const s = str(slugOrName).trim();
  if (!s) return undefined;
  const direct = getConcept(db, s) || getConcept(db, slugify(s));
  if (direct) return direct;
  const k = conceptKey(s);
  const m = k && db.get('SELECT slug FROM concept_keys WHERE key = ?', k.key);
  return m ? getConcept(db, m.slug) : undefined;
}

function upd(p, slug, f) {
  const keys = Object.keys(f);
  if (keys.length) p.db.run(`UPDATE concepts SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE slug = ?`, ...keys.map((k) => f[k]), slug);
}
const push = (p, slug) => {
  const r = getConcept(p.db, slug);
  if (r) p.emit('concept', 'upsert', toConcept(r));
};
const dropped = (p, r) => p.emit('concept', 'delete', { slug: r.slug });

function index(p, slug, at) {
  const r = getConcept(p.db, slug);
  if (!r) return;
  const aliases = parse(r.aliases, []);
  p.setDoc('concept', slug, r.name, [aliases.join(' '), r.summary || ''].filter(Boolean).join('\n'), { at: r.last_seen_at || at });
}

/** Recompute count, first/last seen, task lists and the top related concepts of one concept from concept_tasks. */
function refresh(p, slug, at) {
  const r = getConcept(p.db, slug);
  if (!r) return;
  const rows = p.db.all('SELECT task_id, at FROM concept_tasks WHERE slug = ? ORDER BY at DESC, rowid DESC', slug);
  if (!rows.length && !r.pinned && !r.summary) {
    p.db.run('DELETE FROM concepts WHERE slug = ?', slug);
    p.db.run('DELETE FROM concept_keys WHERE slug = ?', slug);
    p.delDoc('concept', slug);
    dropped(p, r);
    return;
  }
  const related = p.db.all(
    `SELECT b.slug AS slug, COUNT(*) AS n FROM concept_tasks a JOIN concept_tasks b ON a.task_id = b.task_id AND b.slug != a.slug
     WHERE a.slug = ? GROUP BY b.slug ORDER BY n DESC, b.slug LIMIT ${MAX_RELATED}`, slug).map((x) => x.slug);
  const ats = rows.map((x) => x.at);
  upd(p, slug, {
    count: rows.length, task_ids: JSON.stringify(rows.map((x) => x.task_id)), task_ats: JSON.stringify(ats),
    first_seen_at: ats.length ? Math.min(...ats) : r.first_seen_at, last_seen_at: ats.length ? Math.max(...ats) : r.last_seen_at,
    related: JSON.stringify(related),
  });
  index(p, slug, at);
  push(p, slug);
}

function freshSlug(p, base) {
  let slug = base, n = 2;
  while (getConcept(p.db, slug)) slug = `${base.slice(0, 56)}-${n++}`;
  return slug;
}
const addAlias = (list, name, alias) => {
  const a = cut(str(alias).trim().toLowerCase(), 60);
  if (a && a !== name && !list.includes(a) && list.length < MAX_ALIASES) list.push(a);
};

/**
 * recap.generated: re-attach the task to the concepts its tags resolve to (a regenerated recap replaces the old links),
 * creating concepts as needed. Called by the projector after the recap is stored.
 */
export function conceptsOnRecap(p, taskId, tags, at) {
  const old = p.db.all('SELECT slug FROM concept_tasks WHERE task_id = ?', taskId).map((r) => r.slug);
  p.db.run('DELETE FROM concept_tasks WHERE task_id = ?', taskId);
  const touched = new Set(old);
  const seen = new Set();
  for (const tag of tags) {
    const k = conceptKey(tag);
    if (!k) continue;
    const raw = str(tag).trim().toLowerCase();
    let slug = p.db.get('SELECT slug FROM concept_keys WHERE key = ?', k.key)?.slug;
    if (!slug || !getConcept(p.db, slug)) {
      const name = k.name || raw;
      slug = freshSlug(p, slugify(name) || k.slug);
      p.db.run(
        `INSERT INTO concepts(slug, name, aliases, summary, summary_at, task_ids, task_ats, first_seen_at, last_seen_at, count, related, pinned)
         VALUES (?, ?, '[]', NULL, NULL, '[]', '[]', ?, ?, 0, '[]', 0)`, slug, cut(name, 60), at, at);
      p.db.run('INSERT OR REPLACE INTO concept_keys(key, slug) VALUES (?, ?)', k.key, slug);
    } else {
      // remember the spelling that landed here (js on javascript, tests on test)
      const c = getConcept(p.db, slug);
      const aliases = parse(c.aliases, []);
      const before = aliases.length;
      if (slugify(raw) !== slug) addAlias(aliases, c.name.toLowerCase(), raw);
      if (aliases.length !== before) upd(p, slug, { aliases: JSON.stringify(aliases) });
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    p.db.run('INSERT OR REPLACE INTO concept_tasks(slug, task_id, at) VALUES (?, ?, ?)', slug, taskId, at);
    touched.add(slug);
  }
  // related lists of every concept that shares this task, before or after, can change
  for (const s of [...touched].sort()) refresh(p, s, at);
}

/** Rebuild the concept projection of every recap in the tasks table (migration of a pre-v0.13 database). */
export function backfillConcepts(p) {
  const rows = p.db.all('SELECT id, recap, recap_at, updated_at FROM tasks WHERE recap IS NOT NULL ORDER BY recap_at, rowid');
  let n = 0;
  for (const r of rows) {
    const rc = parse(r.recap, null);
    if (!rc || !Array.isArray(rc.concepts) || !rc.concepts.length) continue;
    conceptsOnRecap(p, r.id, rc.concepts, r.recap_at ?? r.updated_at ?? 0);
    n++;
  }
  return n;
}

/** Store a concept_summary job's markdown. `slug` may be stale (merged away): it is resolved through the key map. */
export function storeSummary(p, slug, text, at) {
  const c = resolveConcept(p.db, slug);
  if (!c) return false;
  upd(p, c.slug, { summary: cut(text.trim(), MAX_SUMMARY), summary_at: at });
  index(p, c.slug, at);
  push(p, c.slug);
  return true;
}

export function applyConcept(p, ev) {
  const d = ev.data;
  switch (ev.type) {
    case 'hub.concept.update': {
      const c = getConcept(p.db, str(d.slug));
      if (!c) throw new Error('concept not found');
      const x = d.patch || {}, f = {};
      if (x.name !== undefined) f.name = cut(str(x.name).trim(), 60);
      if (x.pinned !== undefined) f.pinned = x.pinned ? 1 : 0;
      if (x.summary !== undefined) { f.summary = x.summary === null ? null : cut(str(x.summary).trim(), MAX_SUMMARY); f.summary_at = x.summary === null ? null : ev.at; }
      if (x.aliases !== undefined) {
        const aliases = [];
        for (const a of x.aliases) addAlias(aliases, (f.name ?? c.name).toLowerCase(), a);
        f.aliases = JSON.stringify(aliases);
        // the key map for this slug: its own key plus one per alias (the keys of merged-away names stay as aliases too)
        const own = [conceptKey(c.slug)?.key, conceptKey(f.name ?? c.name)?.key].filter(Boolean);
        for (const r of p.db.all('SELECT key FROM concept_keys WHERE slug = ?', c.slug)) {
          if (!own.includes(r.key)) p.db.run('DELETE FROM concept_keys WHERE key = ?', r.key);
        }
        for (const key of own) p.db.run('INSERT OR REPLACE INTO concept_keys(key, slug) VALUES (?, ?)', key, c.slug);
        for (const a of aliases) {
          const k = conceptKey(a);
          if (k) p.db.run('INSERT OR REPLACE INTO concept_keys(key, slug) VALUES (?, ?)', k.key, c.slug);
        }
      }
      upd(p, c.slug, f);
      index(p, c.slug, ev.at);
      push(p, c.slug);
      return toConcept(getConcept(p.db, c.slug));
    }
    case 'hub.concept.merge': {
      const from = getConcept(p.db, str(d.from)), into = getConcept(p.db, str(d.into));
      if (!from || !into || from.slug === into.slug) throw new Error('concept not found');
      const sharing = new Set(p.db.all(
        'SELECT DISTINCT b.slug AS slug FROM concept_tasks a JOIN concept_tasks b ON a.task_id = b.task_id WHERE a.slug IN (?, ?)',
        from.slug, into.slug).map((r) => r.slug));
      p.db.run('INSERT OR IGNORE INTO concept_tasks(slug, task_id, at) SELECT ?, task_id, at FROM concept_tasks WHERE slug = ?', into.slug, from.slug);
      p.db.run('DELETE FROM concept_tasks WHERE slug = ?', from.slug);
      p.db.run('UPDATE concept_keys SET slug = ? WHERE slug = ?', into.slug, from.slug);
      const aliases = parse(into.aliases, []);
      const nm = into.name.toLowerCase();
      addAlias(aliases, nm, from.name);
      for (const a of parse(from.aliases, [])) addAlias(aliases, nm, a);
      for (const nmv of [from.slug, from.name]) {
        const fk = conceptKey(nmv);
        if (fk) p.db.run('INSERT OR REPLACE INTO concept_keys(key, slug) VALUES (?, ?)', fk.key, into.slug);
      }
      upd(p, into.slug, {
        aliases: JSON.stringify(aliases), pinned: into.pinned || from.pinned ? 1 : 0,
        ...(into.summary ? {} : from.summary ? { summary: from.summary, summary_at: from.summary_at } : {}),
      });
      p.db.run('DELETE FROM concepts WHERE slug = ?', from.slug);
      p.delDoc('concept', from.slug);
      dropped(p, from);
      sharing.delete(from.slug);
      sharing.add(into.slug);
      for (const s of [...sharing].sort()) refresh(p, s, ev.at);
      return toConcept(getConcept(p.db, into.slug));
    }
    default:
      p.log?.warn(`unknown concept event ignored: ${ev.type}`);
      return null;
  }
}
