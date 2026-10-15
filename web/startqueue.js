// startqueue.js — v0.27.1: a Start / Resume that is waiting for a live session in its project (pure; no DOM).

/** The hub holds a Start for the project (note target kind `project`, still queued) until a session of that project is live. */
export const isHeldStart = (n) => !!n && n.state === 'queued' && !!n.target && n.target.kind === 'project';

export const waitingText = (projectName) => `Queued — waiting for ${projectName ? `a ${projectName}` : 'a'} session`;
