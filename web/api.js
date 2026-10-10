// api.js — thin REST client over the hub contract (same origin, relative URLs).
async function request(method, path, body, opts = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (opts.signal) init.signal = opts.signal;
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new Error('Hub unreachable');
  }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.data = data; // e.g. { error, issues } from a rejected workflow save
    throw err;
  }
  return data;
}

const q = (o) => {
  const p = new URLSearchParams();
  for (const k in o) if (o[k] != null && o[k] !== '') p.set(k, o[k]);
  const s = p.toString();
  return s ? `?${s}` : '';
};
const enc = encodeURIComponent;

export const api = {
  state: (projectId) => request('GET', `/v1/state${q({ projectId })}`),
  health: () => request('GET', '/v1/health'),
  task: (id) => request('GET', `/v1/tasks/${enc(id)}`),
  sessionActivity: (id, limit = 200) => request('GET', `/v1/sessions/${enc(id)}/activity${q({ limit })}`),
  createProject: (name) => request('POST', '/v1/projects', { name }),
  patchProject: (id, patch) => request('PATCH', `/v1/projects/${enc(id)}`, patch),
  join: (sessionId, projectId) => request('POST', `/v1/sessions/${enc(sessionId)}/join`, { projectId }),
  createTask: (body) => request('POST', '/v1/tasks', body),
  startTask: (id) => request('POST', `/v1/tasks/${enc(id)}/start`),
  applyChoices: (id, picked, start, extra = {}) => request('POST', `/v1/tasks/${enc(id)}/choices/apply`, { picked, start: !!start, ...extra }),
  resetChoices: (id) => request('POST', `/v1/tasks/${enc(id)}/choices/reset`),
  patchTask: (id, patch) => request('PATCH', `/v1/tasks/${enc(id)}`, patch),
  createNote: (target, text, execute = false, attachments) => {
    const body = { target, text };
    if (execute) body.execute = true;
    if (attachments && attachments.length) body.attachments = attachments;
    return request('POST', '/v1/notes', body);
  },
  patchNote: (id, text, attachments) => request('PATCH', `/v1/notes/${enc(id)}`, attachments ? { text, attachments } : { text }),
  deleteNote: (id) => request('DELETE', `/v1/notes/${enc(id)}`),
  executeNotes: (target) => request('POST', '/v1/notes/execute', { target }),
  retryNote: (id) => request('POST', `/v1/notes/${enc(id)}/retry`),
  search: (query, limit = 30, opts) => request('GET', `/v1/search${q({ q: query, limit })}`, undefined, opts),
  learn: (projectId) => request('GET', `/v1/learn${q({ projectId })}`),
  // v0.2 extras
  conflicts: () => request('GET', '/v1/conflicts'),
  sessionHealth: (id, hours = 24) => request('GET', `/v1/sessions/${enc(id)}/health${q({ hours })}`), // v0.14
  healthSessions: () => request('GET', '/v1/health/sessions'),
  questions: (state) => request('GET', `/v1/questions${q({ state })}`),
  dismissQuestion: (id) => request('POST', `/v1/questions/${enc(id)}/dismiss`),
  explain: (taskId) => request('POST', `/v1/tasks/${enc(taskId)}/explain`),
  generateDigest: (body) => request('POST', '/v1/digest', body || {}),
  digests: (projectId, limit = 14) => request('GET', `/v1/digests${q({ projectId, limit })}`),
  // v0.5: git diff of a task's changed files (404 on hubs that predate it)
  taskDiff: (id, refresh = false) => request('GET', `/v1/tasks/${enc(id)}/diff${refresh ? '?refresh=1' : ''}`),
  // v0.12 branch per task (404 on hubs that predate it)
  gitInfo: (id) => request('GET', `/v1/tasks/${enc(id)}/git`),
  createBranch: (id) => request('POST', `/v1/tasks/${enc(id)}/branch`),
  updateBranch: (id) => request('POST', `/v1/tasks/${enc(id)}/branch/update`),
  pushBranch: (id, remote) => request('POST', `/v1/tasks/${enc(id)}/push`, { confirm: true, ...(remote ? { remote } : {}) }),
  linkPr: (id, url) => request('POST', `/v1/tasks/${enc(id)}/pr`, { url }),
  deleteBranch: (id, opts = {}) => request('DELETE', `/v1/tasks/${enc(id)}/branch${q({ deleteBranch: opts.deleteBranch ? 1 : '', force: opts.force ? 1 : '' })}`),
  refreshCi: (id) => request('POST', `/v1/tasks/${enc(id)}/ci/refresh`),
  // v0.4
  usage: (days = 7) => request('GET', `/v1/usage${q({ days })}`),
  // cost analytics: spend per day / project / model / task (404 on hubs that predate it)
  usageBreakdown: (days = 7) => request('GET', `/v1/usage/breakdown${q({ days })}`),
  // v0.9 workflows
  workflow: (id) => request('GET', `/v1/workflows/${enc(id)}`),
  createWorkflow: (body) => request('POST', '/v1/workflows', body),
  saveWorkflow: (id, graph, summary) => request('PUT', `/v1/workflows/${enc(id)}`, { graph, summary }),
  patchWorkflow: (id, patch) => request('PATCH', `/v1/workflows/${enc(id)}`, patch),
  restoreWorkflow: (id, version) => request('POST', `/v1/workflows/${enc(id)}/restore`, { version }),
  validateGraph: (graph, opts) => request('POST', '/v1/workflows/validate', { graph }, opts),
  workflowTemplates: () => request('GET', '/v1/workflows/templates'),
  draftWorkflow: (body) => request('POST', '/v1/workflows/draft', body),
  runWorkflow: (id, body) => request('POST', `/v1/workflows/${enc(id)}/run`, body || {}),
  run: (id) => request('GET', `/v1/runs/${enc(id)}`),
  runControl: (id, action) => request('POST', `/v1/runs/${enc(id)}/${action}`),
  nodeControl: (id, nodeId, action) => request('POST', `/v1/runs/${enc(id)}/nodes/${enc(nodeId)}/${action}`),
  decideGate: (id, nodeId, decision, comment) => request('POST', `/v1/runs/${enc(id)}/gates/${enc(nodeId)}`, { decision, ...(comment ? { comment } : {}) }),
  // v0.11 task templates
  templates: (projectId) => request('GET', `/v1/templates${q({ projectId, includeArchived: 1 })}`),
  createTemplate: (body) => request('POST', '/v1/templates', body),
  patchTemplate: (id, patch) => request('PATCH', `/v1/templates/${enc(id)}`, patch),
  archiveTemplate: (id) => request('DELETE', `/v1/templates/${enc(id)}`),
  useTemplate: (id, body) => request('POST', `/v1/templates/${enc(id)}/use`, body),
  // v0.13 concepts
  concepts: (query, sort, opts) => request('GET', `/v1/concepts${q({ q: query, sort })}`, undefined, opts),
  concept: (slug) => request('GET', `/v1/concepts/${enc(slug)}`),
  patchConcept: (slug, patch) => request('PATCH', `/v1/concepts/${enc(slug)}`, patch),
  mergeConcepts: (from, into) => request('POST', '/v1/concepts/merge', { from, into }),
  summarizeConcept: (slug) => request('POST', `/v1/concepts/${enc(slug)}/summarize`),
  attachmentUrl: (id) => `/v1/attachments/${enc(id)}`,
  /** Raw-body upload with progress. Resolves { attachment }; rejects with err.status (404/405 = hub too old). */
  uploadAttachment(file, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/v1/attachments');
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('x-filename', encodeURIComponent(file.name || 'file'));
      if (onProgress && xhr.upload) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { data = null; }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.attachment) { resolve(data); return; }
        const err = new Error((data && data.error) || `Upload failed (${xhr.status})`);
        err.status = xhr.status;
        reject(err);
      };
      xhr.onerror = () => reject(new Error('Hub unreachable'));
      xhr.onabort = () => { const e = new Error('Upload cancelled'); e.name = 'AbortError'; reject(e); };
      if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(file);
    });
  },
};
