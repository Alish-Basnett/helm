// Task templates (CONTRACT v0.11): row mapper, `{{var}}` rendering and the deterministic reducer for `hub.template.*` events.
// Commands live in hub.mjs; they validate, render and record events (session `_hub`), so `helmd --rebuild` replays them exactly.
// No wall clock and no randomness here: time is `ev.at`, ids come from the counters table.

const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));
const cut = (s, n) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export const TEMPLATE_AGENTS = ['builder', 'scout', 'auto'];
export const MAX_CHECKS = 20;
export const MAX_TAGS = 10;
const VAR_RE = /\{\{\s*([A-Za-z_][\w .-]{0,39}?)\s*\}\}/g;

export const toTemplate = (r) => ({
  id: r.id, projectId: r.project_id ?? null, name: r.name, title: r.title, description: r.description,
  agent: r.agent, checks: parse(r.checks, []), tags: parse(r.tags, []), usage: r.usage,
  lastUsedAt: r.last_used_at ?? null, createdAt: r.created_at, updatedAt: r.updated_at, archived: !!r.archived,
});
export const getTemplate = (db, id) => db.get('SELECT * FROM templates WHERE id = ?', id);

/** The distinct `{{var}}` names used in the given texts, in first-seen order. */
export function templateVars(...texts) {
  const out = [];
  for (const t of texts) for (const m of str(t).matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
/** Fill `{{var}}` placeholders; a missing or blank value falls back to the variable's own name. */
export function fillVars(text, vars = {}) {
  return str(text).replace(VAR_RE, (_, name) => {
    const v = vars && Object.hasOwn(vars, name) ? vars[name] : undefined;
    return typeof v === 'string' && v.trim() ? v.trim() : name;
  });
}
/** Map an agent's subagent type (`helm:builder`, `scout`, `Explore`, …) onto a template agent. */
export function agentOfSubagent(type) {
  const t = str(type).toLowerCase();
  if (t.includes('builder')) return 'builder';
  if (t.includes('scout')) return 'scout';
  return 'auto';
}
/** The task title/description a template produces for `vars`. */
export function renderTemplate(tpl, vars = {}) {
  const title = fillVars(tpl.title, vars).trim().slice(0, 300) || tpl.name;
  let description = fillVars(tpl.description, vars);
  const checks = (tpl.checks || []).map((c) => fillVars(c, vars));
  if (checks.length) description += `${description ? '\n\n' : ''}Checks:\n${checks.map((c) => `- ${c}`).join('\n')}`;
  if (tpl.agent === 'builder' || tpl.agent === 'scout') description += `${description ? '\n\n' : ''}Preferred agent: helm:${tpl.agent}`;
  return { title, description: description.slice(0, 20000) };
}

function index(p, id, at) {
  const t = getTemplate(p.db, id);
  if (!t) return;
  if (t.archived) { p.delDoc('template', id); return; }
  const checks = parse(t.checks, []);
  p.setDoc('template', id, t.name, [t.title, t.description, ...checks, ...parse(t.tags, [])].filter(Boolean).join('\n'), { at });
}
function push(p, id) { const r = getTemplate(p.db, id); if (r) p.emit('template', 'upsert', toTemplate(r)); }

export function applyTemplate(p, ev) {
  const d = ev.data;
  switch (ev.type) {
    case 'hub.template.create': {
      const id = p.nextId('TT');
      p.db.run(
        `INSERT INTO templates(id, project_id, name, title, description, agent, checks, tags, usage, last_used_at, created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, 0)`,
        id, d.projectId ?? null, cut(str(d.name), 200), cut(str(d.title), 300), str(d.description).slice(0, 20000),
        TEMPLATE_AGENTS.includes(d.agent) ? d.agent : 'auto', JSON.stringify(d.checks || []), JSON.stringify(d.tags || []), ev.at, ev.at);
      index(p, id, ev.at); push(p, id);
      return toTemplate(getTemplate(p.db, id));
    }
    case 'hub.template.update': {
      const t = getTemplate(p.db, d.id);
      if (!t) throw new Error('template not found');
      const f = { updated_at: ev.at }, x = d.patch || {};
      if (x.projectId !== undefined) f.project_id = x.projectId;
      if (x.name !== undefined) f.name = cut(str(x.name), 200);
      if (x.title !== undefined) f.title = cut(str(x.title), 300);
      if (x.description !== undefined) f.description = str(x.description).slice(0, 20000);
      if (x.agent !== undefined) f.agent = x.agent;
      if (x.checks !== undefined) f.checks = JSON.stringify(x.checks);
      if (x.tags !== undefined) f.tags = JSON.stringify(x.tags);
      if (x.archived !== undefined) f.archived = x.archived ? 1 : 0;
      p.upd('templates', t.id, f);
      index(p, t.id, ev.at); push(p, t.id);
      return toTemplate(getTemplate(p.db, t.id));
    }
    case 'hub.template.used': {
      const t = getTemplate(p.db, d.id);
      if (!t) throw new Error('template not found');
      p.upd('templates', t.id, { usage: t.usage + 1, last_used_at: ev.at });
      push(p, t.id);
      return toTemplate(getTemplate(p.db, t.id));
    }
    default:
      p.log?.warn(`unknown template event ignored: ${ev.type}`);
      return null;
  }
}
