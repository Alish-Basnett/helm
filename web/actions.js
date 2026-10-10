// actions.js — optimistic user actions with rollback + toast on error.
import { api } from './api.js';
import { state, upsert, remove, sel } from './store.js';
import { toast, toastError } from './ui.js';

let tmpCounter = 0;
const tmpId = (p) => `tmp-${p}-${Date.now().toString(36)}${++tmpCounter}`;

/* ---------- tasks ---------- */
export async function patchTask(id, patch, errLabel = 'Could not update task') {
  const before = state.tasks.get(id);
  if (!before) return null;
  const now = Date.now();
  const optimistic = { ...before, ...patch };
  if (patch.status && patch.status !== before.status) {
    if (patch.status === 'done') optimistic.doneAt = now;
    if (patch.status !== 'blocked') optimistic.blockedReason = patch.status === before.status ? before.blockedReason : null;
  }
  upsert('task', optimistic);
  try {
    const { task } = await api.patchTask(id, patch);
    if (task) upsert('task', task);
    return task;
  } catch (e) {
    if (state.tasks.get(id) === optimistic) upsert('task', before);
    toastError(e, errLabel);
    return null;
  }
}

export function setStatus(id, status, label) {
  const t = state.tasks.get(id);
  if (!t || t.status === status) return Promise.resolve(null);
  return patchTask(id, { status }, label || 'Could not move task');
}

export async function createTask({ projectId, title, description, status = 'backlog', dependsOn, sessionId, start = false }) {
  title = (title || '').trim();
  if (!title) return null;
  const col = sel.scopedTasks().filter((t) => t.status === status && t.projectId === projectId);
  const order = col.reduce((m, t) => Math.max(m, t.order || 0), 0) + 1;
  const tmp = {
    id: tmpId('T'), projectId, sessionId: sessionId || null, title, description: description || '', status: start ? 'next' : status,
    agentId: null, order, blockedReason: null, dependsOn: dependsOn || [], filesChanged: [], tokens: 0, recap: null,
    createdAt: Date.now(), updatedAt: Date.now(), doneAt: null, startNoteId: start ? tmpId('N') : null, __pending: true,
  };
  upsert('task', tmp);
  try {
    const body = { projectId, title, status };
    if (description) body.description = description;
    if (dependsOn && dependsOn.length) body.dependsOn = dependsOn;
    if (sessionId) body.sessionId = sessionId;
    if (start) body.start = true;
    const res = await api.createTask(body);
    remove('task', tmp.id);
    if (res.note) upsert('note', res.note);
    if (res.task) upsert('task', res.task);
    if (start && res.error) toast(startErrorMessage({ status: 409, message: res.error }), { kind: 'error' });
    return res.task;
  } catch (e) {
    remove('task', tmp.id);
    toastError(e, 'Could not create task');
    return null;
  }
}

/* ---------- projects ---------- */
export async function createProject(name) {
  name = (name || '').trim();
  if (!name) return null;
  const tmp = { id: tmpId('P'), name, createdAt: Date.now(), archived: false, __pending: true };
  upsert('project', tmp);
  try {
    const { project } = await api.createProject(name);
    remove('project', tmp.id);
    if (project) upsert('project', project);
    return project;
  } catch (e) {
    remove('project', tmp.id);
    toastError(e, 'Could not create project');
    return null;
  }
}

export async function patchProject(id, patch, errLabel = 'Could not update project') {
  const before = state.projects.get(id);
  if (!before) return null;
  const optimistic = { ...before, ...patch };
  upsert('project', optimistic);
  try {
    const { project } = await api.patchProject(id, patch);
    if (project) upsert('project', project);
    return project;
  } catch (e) {
    if (state.projects.get(id) === optimistic) upsert('project', before);
    toastError(e, errLabel);
    return null;
  }
}

/** v0.7: switch a project's Up next between Manual and Auto. Toasts what the hub did (it may start a task at once). */
export async function setAutoStart(id, on) {
  const before = state.projects.get(id);
  if (!before || before.autoStart === on) return null;
  const optimistic = { ...before, autoStart: on };
  upsert('project', optimistic);
  try {
    const res = await api.patchProject(id, { autoStart: on });
    // An older hub ignores the field and still answers 200: never claim success it did not confirm.
    if (res?.project?.autoStart !== on) throw new Error('The hub did not apply auto mode. Restart it (node hub/helmd.mjs --stop, then --detach).');
    upsert('project', res.project);
    const started = (res.autoStarted || [])[0];
    if (!on) toast('Manual mode: you start tasks yourself');
    else toast(started ? `Auto mode on: starting ${started}` : 'Auto mode on: the next task starts when nothing is in progress');
    return res;
  } catch (e) {
    if (state.projects.get(id) === optimistic) upsert('project', before);
    toastError(e, 'Could not change auto mode');
    return null;
  }
}

/** The project the Up next switch controls: the selected one, or the only one that exists. */
export function autoTarget() {
  const s = sel.scopeProject();
  if (s) return s;
  const ps = sel.projects();
  return ps.length === 1 ? ps[0] : null;
}

export async function archiveProject(id, archived = true) {
  const p = state.projects.get(id);
  const res = await patchProject(id, { archived }, archived ? 'Could not archive project' : 'Could not restore project');
  if (res && archived && p) {
    toast(`Archived “${p.name}”`, { action: { label: 'Undo', onClick: () => archiveProject(id, false) } });
  }
  return res;
}

export async function joinSession(sessionId, projectId) {
  const s = state.sessions.get(sessionId);
  if (!s || s.projectId === projectId) return null;
  const before = { session: s, tasks: [] };
  const optimistic = { ...s, projectId };
  upsert('session', optimistic);
  for (const t of state.tasks.values()) {
    if (t.sessionId === sessionId && t.projectId !== projectId) {
      before.tasks.push(t);
      upsert('task', { ...t, projectId });
    }
  }
  try {
    const { session } = await api.join(sessionId, projectId);
    if (session) upsert('session', session);
    toast(`Moved to ${sel.projectName(projectId)}`, { kind: 'success' });
    return session;
  } catch (e) {
    if (state.sessions.get(sessionId) === optimistic) upsert('session', before.session);
    for (const t of before.tasks) upsert('task', t);
    toastError(e, 'Could not move session');
    return null;
  }
}

/* ---------- notes ---------- */
export async function addNote(target, text, { execute = false, attachments = [] } = {}) {
  text = (text || '').trim();
  if (!text && attachments.length) text = attachments.length === 1 ? 'See the attached file.' : 'See the attached files.';
  if (!text) return null;
  const sessionId = target.kind === 'session' ? target.id : (state.tasks.get(target.id) || {}).sessionId || '';
  const tmp = {
    id: tmpId('N'), target: { kind: target.kind, id: target.id }, sessionId, text,
    state: execute ? 'queued' : 'draft', createdAt: Date.now(), queuedAt: execute ? Date.now() : null,
    ranAt: null, via: null, error: null, reply: null, repliedAt: null, attachments: attachments.slice(), __pending: true,
  };
  upsert('note', tmp);
  let created = null;
  try {
    const { note } = await api.createNote({ kind: target.kind, id: target.id }, text, execute, attachments.map((a) => a.id));
    created = note;
    remove('note', tmp.id);
    if (note) upsert('note', note);
  } catch (e) {
    remove('note', tmp.id);
    toastError(e, 'Could not add note');
    return null;
  }
  // a hub without one-call execute answers with a draft: run it the long way
  if (execute && created && created.state === 'draft') await executeNotes(target);
  return created;
}

export async function editNote(id, text) {
  const before = state.notes.get(id);
  text = (text || '').trim();
  if (!before || !text || before.text === text) return null;
  const optimistic = { ...before, text };
  upsert('note', optimistic);
  try {
    const res = await api.patchNote(id, text);
    if (res && res.note) upsert('note', res.note);
    return res;
  } catch (e) {
    if (state.notes.get(id) === optimistic) upsert('note', before);
    toastError(e, 'Could not edit note');
    return null;
  }
}

export async function deleteNote(id) {
  const before = state.notes.get(id);
  if (!before) return;
  remove('note', id);
  try {
    await api.deleteNote(id);
  } catch (e) {
    if (!state.notes.has(id)) upsert('note', before);
    toastError(e, 'Could not delete note');
  }
}

export async function executeNotes(target) {
  const drafts = sel.notesFor(target.kind, target.id).filter((n) => n.state === 'draft' && !n.__pending);
  if (!drafts.length) return [];
  const now = Date.now();
  const optimistic = drafts.map((n) => ({ ...n, state: 'queued', queuedAt: now }));
  optimistic.forEach((n) => upsert('note', n));
  try {
    const { notes } = await api.executeNotes({ kind: target.kind, id: target.id });
    (notes || []).forEach((n) => upsert('note', n));
    return notes;
  } catch (e) {
    drafts.forEach((n, i) => { if (state.notes.get(n.id) === optimistic[i]) upsert('note', n); });
    toastError(e, 'Could not execute notes');
    return [];
  }
}

export async function retryNote(id) {
  const before = state.notes.get(id);
  if (!before) return;
  const optimistic = { ...before, state: 'queued', error: null, queuedAt: Date.now() };
  upsert('note', optimistic);
  try {
    const res = await api.retryNote(id);
    if (res && res.note) upsert('note', res.note);
  } catch (e) {
    if (state.notes.get(id) === optimistic) upsert('note', before);
    toastError(e, 'Could not retry note');
  }
}

/* ---------- v0.3: Start a task from the dashboard ---------- */
export const STARTABLE = new Set(['backlog', 'next', 'later', 'blocked']);
/** A start request is in flight: optimistic placeholder, or its note is still queued / being delivered. */
export function isStarting(t) {
  if (!t || !t.startNoteId) return false;
  const id = String(t.startNoteId);
  if (id.startsWith('tmp-')) return true;
  const n = state.notes.get(id);
  return !!n && (n.state === 'queued' || n.state === 'sending');
}
/** Draft notes on a task: they ride along with Start (v0.8). */
export const startDrafts = (id) => sel.notesFor('task', id).filter((n) => n.state === 'draft' && !n.__pending);
export const startLabel = (n) => (n > 0 ? `Start with ${n} note${n === 1 ? '' : 's'}` : 'Start');
export const canStart = (t) => !!t && !t.__pending && STARTABLE.has(t.status) && !isStarting(t);
export const NO_SESSION_MSG = 'No live session for this project — open a Claude Code session in it';

export function startErrorMessage(e) {
  const msg = String((e && e.message) || '');
  if (e && e.status === 409) return /no live session/i.test(msg) ? NO_SESSION_MSG : 'Already running';
  return `Could not start task: ${msg || 'unknown error'}`;
}

/** Ask the task's live session to delegate it. Optimistic: card shows "Starting…" until the start note settles. */
export async function startTask(id) {
  const before = state.tasks.get(id);
  if (!before || !canStart(before)) return null;
  const optimistic = { ...before, status: 'next', startNoteId: tmpId('N') };
  upsert('task', optimistic);
  const folded = startDrafts(id); // the hub marks these ran (via start) in the same transaction
  const now = Date.now();
  folded.forEach((n) => upsert('note', { ...n, state: 'ran', ranAt: now, via: 'start' }));
  try {
    const res = await api.startTask(id);
    if (res && res.note) upsert('note', res.note);
    if (res && res.task) upsert('task', res.task);
    return res;
  } catch (e) {
    if (state.tasks.get(id) === optimistic) upsert('task', before);
    folded.forEach((n) => upsert('note', n));
    toast(startErrorMessage(e), { kind: 'error' });
    return null;
  }
}

/* ---------- v0.6: Choices ---------- */
/** Create (and optionally start) a task per picked choice. Returns { tasks, choices, errors } or null. */
export async function applyChoices(taskId, picked, start, extra = {}) {
  if (!picked.length) return null;
  try {
    const res = await api.applyChoices(taskId, picked, start, extra);
    (res.tasks || []).forEach((t) => upsert('task', t));
    const parent = state.tasks.get(taskId);
    if (parent && res.choices) upsert('task', { ...parent, choices: res.choices });
    const n = (res.tasks || []).length;
    const errs = res.errors || [];
    if (errs.length) {
      toast(`Created ${n} task${n === 1 ? '' : 's'}; ${errs.length} not started: ${startErrorMessage({ status: errs[0].status, message: errs[0].error })}`, { kind: 'error' });
    } else {
      toast(start ? `Created and started ${n} task${n === 1 ? '' : 's'}` : `Created ${n} task${n === 1 ? '' : 's'}`, { kind: 'success' });
    }
    return res;
  } catch (e) {
    toastError(e, 'Could not apply choices');
    return null;
  }
}

export async function resetChoices(taskId) {
  try {
    const res = await api.resetChoices(taskId);
    const parent = state.tasks.get(taskId);
    if (res && res.task) upsert('task', res.task);
    else if (parent && res && res.choices) upsert('task', { ...parent, choices: res.choices });
    return res;
  } catch (e) {
    toastError(e, 'Could not reset choices');
    return null;
  }
}

/* ---------- card actions (shared by board, sheet, spotlight) ---------- */
export function quickActions(task) {
  const out = [];
  if (task.status !== 'done') out.push({ key: 'done', label: 'Done', icon: 'check', to: 'done' });
  if (task.status === 'blocked') out.push({ key: 'retry', label: 'Retry', icon: 'retry', to: 'next' });
  if (task.status === 'later') out.push({ key: 'next', label: 'Up next', icon: 'arrowRight', to: 'next' });
  if (task.status !== 'later') out.push({ key: 'later', label: 'Later', icon: 'bookmark', to: 'later' });
  out.push({ key: 'archive', label: 'Archive', icon: 'archive', to: 'archived' });
  return out;
}

export function runQuickAction(task, action) {
  const p = setStatus(task.id, action.to, `Could not ${action.label.toLowerCase()}`);
  if (action.to === 'archived') {
    toast(`Archived ${task.id}`, { action: { label: 'Undo', onClick: () => setStatus(task.id, task.status) } });
  }
  return p;
}

/* ---------- v0.2: questions inbox ---------- */
export async function dismissQuestion(id) {
  const before = state.questions.get(id);
  if (!before || before.state === 'answered') return null;
  const optimistic = { ...before, state: 'answered', answeredAt: Date.now() };
  upsert('question', optimistic);
  try {
    const res = await api.dismissQuestion(id);
    if (res && res.question) upsert('question', res.question);
    return res;
  } catch (e) {
    if (state.questions.get(id) === optimistic) upsert('question', before);
    toastError(e, 'Could not dismiss question');
    return null;
  }
}

/* ---------- v0.2: jobs (explain deeper, daily digest) ---------- */
const jobBusy = (j) => !!j && (j.state === 'queued' || j.state === 'running');

/** Ask a live session (Haiku) to explain a task in more depth. Returns the job, or null. */
export async function explainTask(id) {
  const before = state.tasks.get(id);
  if (!before) return null;
  const current = sel.explainJob(before);
  if (jobBusy(current)) return current;
  upsert('task', { ...before, explainJob: { id: 'tmp-explain', state: 'queued' } });
  try {
    const { job } = await api.explain(id);
    if (job) {
      upsert('job', job);
      const t = state.tasks.get(id);
      if (t) upsert('task', { ...t, explainJob: { id: job.id, state: job.state } });
    }
    return job || null;
  } catch (e) {
    const t = state.tasks.get(id);
    if (t && t.explainJob && t.explainJob.id === 'tmp-explain') upsert('task', { ...t, explainJob: before.explainJob || null });
    toastError(e, 'Could not start explanation');
    return null;
  }
}

/** Ask a live session to write the digest for today (or `date`), for a project or everything. */
export async function generateDigest({ projectId, date } = {}) {
  const body = {};
  if (projectId && projectId !== 'all') body.projectId = projectId;
  if (date) body.date = date;
  try {
    const { job } = await api.generateDigest(body);
    if (job) upsert('job', job);
    return job || null;
  } catch (e) {
    toastError(e, 'Could not start digest');
    return null;
  }
}

/* ---------- v0.13: concepts ---------- */
/** Ask a live session to write the concept's page. Resolves the job, or null (409 'no live session' arrives as a toast). */
export async function summarizeConcept(slug) {
  try {
    const { job } = await api.summarizeConcept(slug);
    if (job) upsert('job', job);
    return job || null;
  } catch (e) {
    toastError(e, 'Could not start the page');
    return null;
  }
}
/** Pin / unpin / rename / aliases. Optimistic for the store copy; resolves the concept or null. */
export async function patchConcept(slug, patch, errLabel = 'Could not update concept') {
  const before = state.concepts.get(slug);
  if (before) upsert('concept', { ...before, ...patch });
  try {
    const { concept } = await api.patchConcept(slug, patch);
    if (concept) upsert('concept', { ...concept, summary: null });
    return concept || null;
  } catch (e) {
    if (before) upsert('concept', before);
    toastError(e, errLabel);
    return null;
  }
}
export async function mergeConcepts(from, into) {
  try {
    const { concept } = await api.mergeConcepts(from, into);
    remove('concept', from);
    if (concept) upsert('concept', { ...concept, summary: null });
    toast(`Merged into ${concept ? concept.name : into}`, { kind: 'success', duration: 2500 });
    return concept || null;
  } catch (e) {
    toastError(e, 'Could not merge');
    return null;
  }
}

/* ---------- v0.9: workflow runs ---------- */
/** Run row from a response goes straight into the store (the SSE change that follows is identical). */
function takeRun(res) {
  if (res && res.run) upsert('run', res.run);
  return res && res.run ? res.run : null;
}
/** Approve or reject a gate. The comment is optional. Resolves the run, or null when the hub refused. */
export async function decideGate(runId, nodeId, decision, comment = '') {
  try {
    const run = takeRun(await api.decideGate(runId, nodeId, decision, comment.trim()));
    toast(decision === 'approve' ? 'Approved' : 'Rejected', { kind: 'success', duration: 2200 });
    return run;
  } catch (e) {
    toastError(e, decision === 'approve' ? 'Could not approve' : 'Could not reject');
    return null;
  }
}
/** pause | resume | abort */
export async function controlRun(runId, action) {
  try { return takeRun(await api.runControl(runId, action)); } catch (e) { toastError(e, `Could not ${action} the run`); return null; }
}
/** retry | skip */
export async function controlNode(runId, nodeId, action) {
  try { return takeRun(await api.nodeControl(runId, nodeId, action)); } catch (e) { toastError(e, `Could not ${action} the step`); return null; }
}

/* ---------- v0.12: a git branch + PR per task ---------- */
// Every call resolves the hub's answer (or null after a toast). The pushed task row replaces the one in the store.
async function gitCall(label, fn) {
  try {
    const r = await fn();
    if (r && r.task) upsert('task', r.task);
    return r;
  } catch (e) { toastError(e, label); return null; }
}
export const createBranch = (id) => gitCall('Could not create the branch', () => api.createBranch(id));
export const updateBranch = (id) => gitCall('Could not update the branch', () => api.updateBranch(id));
/** Only ever called from the confirm dialog (a click on "Push branch"): the hub refuses without confirm: true. */
export const pushBranch = (id, remote) => gitCall('Push failed', () => api.pushBranch(id, remote));
export const linkPr = (id, url) => gitCall('Could not link the PR', () => api.linkPr(id, url));
export const cleanBranch = (id, opts) => gitCall('Could not clean up', () => api.deleteBranch(id, opts));
export const refreshCi = (id) => gitCall('Could not refresh CI', () => api.refreshCi(id));
