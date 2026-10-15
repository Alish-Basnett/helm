// startqueue.js — v0.27.1: a Start / Resume that is waiting for a live session in its project (pure; no DOM).

/** The hub holds a Start for the project (note target kind `project`, still queued) until a session of that project is live. */
export const isHeldStart = (n) => !!n && n.state === 'queued' && !!n.target && n.target.kind === 'project';

export const waitingText = (projectName) => `Queued — waiting for ${projectName ? `a ${projectName}` : 'a'} session`;

/** v0.28: what a Start would do right now, from GET /v1/tasks/:id/start-target. */
export const startTargetText = (verb, tg) => {
  if (!tg || !tg.projectName) return verb;
  return tg.held || !tg.sessionLabel ? `${verb} in ${tg.projectName} \u00b7 will wait for a session` : `${verb} in ${tg.projectName} \u00b7 ${tg.sessionLabel}`;
};

/** Ask before a Start that will be held, or that goes to a project other than the one the board is showing ('all' / none: no scope). */
export const needsStartConfirm = (tg, scopeProjectId) =>
  !!tg && (tg.held || (!!scopeProjectId && scopeProjectId !== 'all' && tg.projectId !== scopeProjectId));

/** The key a cached start target depends on: the card's project and session, and the live sessions of that project. */
export const startTargetKey = (task, sessions) =>
  [task.projectId, task.sessionId || '', ...sessions.filter((s) => s.projectId === task.projectId && s.status !== 'ended').map((s) => `${s.id}:${s.status}:${s.appTitle || s.title || ''}`).sort()].join('|');

/** Projects a card can move to: not archived, not its own, the coordinator first, then by name. */
export const moveTargets = (projects, currentId) =>
  projects.filter((p) => !p.archived && p.id !== currentId)
    .sort((a, b) => (b.coordinator ? 1 : 0) - (a.coordinator ? 1 : 0) || a.name.localeCompare(b.name));
