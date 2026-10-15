// ackdialog.js — "Acknowledge all…" and "Acknowledge all N in this bundle": one confirm dialog, grouped, with checkboxes.
// Groups are ticked by default; the owner can leave any group or entry out. Requests go out in chunks of 500 (actions.ackBulk).
import { h, setText } from './dom.js';
import { icon } from './icons.js';
import { sel } from './store.js';
import { ackBulk } from './actions.js';
import { openModal } from './modal.js';
import { toast } from './ui.js';
import { plural, truncate, agentLabel, cwdTail, sessionLabel } from './format.js';

const KEY = { agent: 'agentIds', session: 'sessionIds', link: 'linkIds' };
let openNow = null;
const inflight = new Set(); // ids being acknowledged right now: a second dialog must not list them again

/**
 * groups: [{ id, title, iconName, entries: [{ id, label, items: [{ kind: 'agent'|'session'|'link', id, title }] }] }]
 * Returns { close } or null when there is nothing to acknowledge.
 */
export function openAckDialog({ title, note, groups }) {
  groups = groups.map((g) => ({ ...g, entries: g.entries.map((e) => ({ ...e, items: e.items.filter((i) => !inflight.has(i.id)) })).filter((e) => e.items.length) })).filter((g) => g.entries.length);
  if (openNow || !groups.length) return null;
  const picked = new Set(groups.flatMap((g) => g.entries.map((e) => e.id)));
  const entryById = new Map(groups.flatMap((g) => g.entries.map((e) => [e.id, e])));
  const nameOf = new Map(groups.flatMap((g) => g.entries.flatMap((e) => e.items.map((i) => [i.id, i.title]))));
  const count = (e) => e.items.length;
  const total = () => Array.from(picked).reduce((n, id) => n + count(entryById.get(id)), 0);

  let modal = null;
  const head = h('h2', { id: 'ak-h' }, title);
  const noteEl = h('p', { class: 'ak-note' }, note);
  const boxes = new Map(); // entry or group id -> checkbox
  const groupEls = groups.map((g) => {
    const gBox = h('input', { type: 'checkbox', checked: true, 'aria-label': `${g.title}: include all` });
    boxes.set(`g:${g.id}`, gBox);
    const gTotal = g.entries.reduce((n, e) => n + count(e), 0);
    gBox.addEventListener('change', () => { for (const e of g.entries) (gBox.checked ? picked.add(e.id) : picked.delete(e.id)); sync(); });
    const rows = g.entries.map((e) => {
      const box = h('input', { type: 'checkbox', checked: true, 'aria-label': `${e.label}, ${plural(count(e), 'item')}` });
      boxes.set(e.id, box);
      box.addEventListener('change', () => { (box.checked ? picked.add(e.id) : picked.delete(e.id)); sync(); });
      return h('li', {}, h('label', { class: 'ak-row' }, box, h('span', { class: 'ak-label' }, e.label), h('span', { class: 'ak-n mono' }, String(count(e)))));
    });
    return h('section', { class: 'ak-group' },
      h('label', { class: 'ak-ghead' }, gBox, icon(g.iconName || 'checkCircle', 14), h('span', { class: 'ak-gtitle' }, g.title), h('span', { class: 'ak-n mono' }, String(gTotal))),
      h('ul', { class: 'ak-rows', role: 'list' }, rows));
  });
  const list = h('div', { class: 'ak-list' }, groupEls);
  const result = h('div', { class: 'ak-result', hidden: true, role: 'status', 'aria-live': 'polite' });
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel');
  const go = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => run() });
  const card = h('div', { class: 'md-card ak-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ak-h' },
    head, noteEl, list, result, h('div', { class: 'ak-foot' }, cancel, go));

  function sync() {
    for (const g of groups) {
      const n = g.entries.filter((e) => picked.has(e.id)).length;
      const gb = boxes.get(`g:${g.id}`);
      gb.checked = n === g.entries.length;
      gb.indeterminate = n > 0 && n < g.entries.length;
      for (const e of g.entries) boxes.get(e.id).checked = picked.has(e.id);
    }
    const n = total();
    setText(go, n ? `Acknowledge ${n}` : 'Nothing selected');
    go.disabled = !n;
  }

  let running = false;
  async function run() {
    if (running || !picked.size) return;
    running = true;
    modal.setBusy(true);
    go.disabled = true; cancel.disabled = true;
    for (const b of boxes.values()) b.disabled = true;
    const body = {};
    for (const id of picked) for (const it of entryById.get(id).items) (body[KEY[it.kind]] = body[KEY[it.kind]] || []).push(it.id);
    const asked = total();
    const ids = Object.values(body).flat();
    for (const id of ids) inflight.add(id);
    setText(go, 'Acknowledging…');
    const res = await ackBulk(body, (i, n) => { if (n > 1) setText(go, `Acknowledging… ${i}/${n}`); });
    for (const id of ids) inflight.delete(id);
    running = false;
    modal.setBusy(false);
    if (modal.closed) { // closed some other way while it ran: still say what happened
      toast(res.refused.length ? `Acknowledged ${res.acked} of ${asked}; ${res.refused.length} refused: ${res.refused[0].reason}` : `Acknowledged ${plural(res.acked, 'item')}`, { kind: res.refused.length ? 'error' : 'success' });
      return;
    }
    if (!res.refused.length) { toast(`Acknowledged ${plural(res.acked, 'item')}`, { kind: 'success' }); close(); return; }
    // some were refused: show what and why, keep the dialog open on that
    const byReason = new Map();
    for (const r of res.refused) (byReason.get(r.reason) || byReason.set(r.reason, []).get(r.reason)).push(r.id);
    list.hidden = true; noteEl.hidden = true; go.hidden = true;
    setText(head, `${plural(res.refused.length, 'item')} could not be acknowledged`);
    result.hidden = false;
    result.append(
      h('p', {}, `${plural(res.acked, 'item')} of ${asked} acknowledged. The hub refused the rest:`),
      h('ul', { class: 'ak-refused', role: 'list' }, Array.from(byReason, ([reason, ids]) => h('li', {},
        h('strong', {}, reason), h('span', { class: 'ak-n mono' }, ` · ${plural(ids.length, 'item')}`),
        h('div', { class: 'ak-names' }, ids.slice(0, 5).map((id) => truncate(nameOf.get(id) || id, 40)).join(', ') + (ids.length > 5 ? `, +${ids.length - 5} more` : ''))))));
    cancel.disabled = false;
    setText(cancel, 'Close');
    cancel.focus();
  }

  sync();
  modal = openModal(card, { onClose: () => { openNow = null; }, initialFocus: () => cancel });
  function close() { modal.close(); }
  openNow = { close };
  return openNow;
}

const sessionTitle = (s) => sessionLabel(s);
const pname = (id) => sel.projectName(id);
const group = (map, key, make) => map.get(key) || map.set(key, make()).get(key);

/** Everything finished, in every project: subagents and sessions per project, links per project pair. */
export function openAckAll() {
  const p = sel.pendingAck();
  const per = (list, mk) => {
    const m = new Map();
    for (const n of list) group(m, n.projectId, () => ({ id: `${mk.kind}:${n.projectId}`, label: pname(n.projectId), items: [] })).items.push({ kind: mk.kind, id: n.id, title: mk.title(n) });
    return Array.from(m.values()).sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  };
  const bundles = new Map();
  for (const e of p.links) {
    const L = e.link;
    group(bundles, `${L.fromProjectId}>${L.toProjectId}`, () => ({ id: `link:${L.fromProjectId}>${L.toProjectId}`, label: `${pname(L.fromProjectId)} → ${pname(L.toProjectId)}`, items: [] }))
      .items.push({ kind: 'link', id: L.id, title: `${L.kind === 'task' ? 'Task' : 'Note'}: ${L.text || L.id}` });
  }
  const groups = [
    { id: 'agents', title: 'Finished subagents', iconName: 'check', entries: per(p.agents, { kind: 'agent', title: (n) => agentLabel(n.row) + (n.row.taskId ? ` · ${n.row.taskId}` : '') }) },
    { id: 'sessions', title: 'Ended sessions', iconName: 'terminal', entries: per(p.sessions, { kind: 'session', title: (n) => sessionTitle(n.row) }) },
    { id: 'links', title: 'Link bundles', iconName: 'link', entries: Array.from(bundles.values()).sort((a, b) => b.items.length - a.items.length) },
  ];
  const n = p.agents.length + p.sessions.length + p.links.length;
  return openAckDialog({
    title: `Acknowledge ${plural(n, 'finished item')}?`,
    note: 'They are archived and leave the graph; you can bring them back from Archived. Untick anything you want to keep.',
    groups,
  });
}

/** One bundle: every link in it that waits for an OK. */
export function openBundleAck(bundle) {
  const items = bundle.items.filter((i) => i.needsOk).map((i) => ({ kind: 'link', id: i.link.id, title: `${i.link.kind === 'task' ? 'Task' : 'Note'}: ${i.link.text || i.link.id}` }));
  const label = `${pname(bundle.fromProjectId)} → ${pname(bundle.toProjectId)}`;
  return openAckDialog({
    title: `Acknowledge all ${items.length} in this bundle?`,
    note: `${label}. They are archived and leave the graph; you can bring them back from Archived.`,
    groups: [{ id: 'links', title: 'Links', iconName: 'link', entries: [{ id: `bundle:${bundle.key}`, label, items }] }],
  });
}

