// format.js — pure formatting helpers.
const pad = (n) => String(n).padStart(2, '0');

export function fmtElapsed(ms) {
  ms = Math.max(0, ms | 0);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function fmtAgo(t, now = Date.now()) {
  if (!t) return '';
  const d = Math.max(0, now - t);
  const s = Math.floor(d / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dd = Math.floor(h / 24);
  return dd < 30 ? `${dd}d ago` : new Date(t).toLocaleDateString();
}

export function fmtTokens(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : n < 100000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

export function fmtUsd(n) {
  n = Number(n) || 0;
  return '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
}

export function fmtClock(t = Date.now()) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtTime(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDay(t) {
  const d = new Date(t);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function startOfToday() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
}

export function cwdTail(cwd, n = 2) {
  if (!cwd) return '';
  const parts = String(cwd).split('/').filter(Boolean);
  return (parts.length > n ? '…/' : '/') + parts.slice(-n).join('/');
}

export function truncate(str, n) {
  str = String(str ?? '');
  return str.length > n ? str.slice(0, Math.max(0, n - 1)) + '…' : str;
}

export function modelInfo(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return { key: 'opus', label: 'Opus' };
  if (m.includes('sonnet')) return { key: 'sonnet', label: 'Sonnet' };
  if (m.includes('haiku')) return { key: 'haiku', label: 'Haiku' };
  return { key: 'other', label: model ? truncate(String(model).replace(/^claude-?/i, ''), 12) : 'model' };
}

export function agentLabel(a) {
  if (!a) return 'agent';
  const t = String(a.subagentType || '').split(':').pop();
  return t || 'agent';
}

export function plural(n, one, many) { return `${n} ${n === 1 ? one : many || one + 's'}`; }

export const STATUS_META = {
  backlog: { label: 'Backlog', short: 'Backlog' },
  next: { label: 'Up next', short: 'Next' },
  in_progress: { label: 'In progress', short: 'Active' },
  review: { label: 'Review', short: 'Review' },
  done: { label: 'Done', short: 'Done' },
  later: { label: 'Saved for later', short: 'Later' },
  blocked: { label: 'Blocked', short: 'Blocked' },
  archived: { label: 'Archived', short: 'Archived' },
};
export const MAIN_COLUMNS = ['backlog', 'next', 'in_progress', 'review', 'done'];
export const LANES = ['later', 'blocked'];
export const ALL_STATUSES = ['backlog', 'next', 'in_progress', 'review', 'done', 'later', 'blocked', 'archived'];
