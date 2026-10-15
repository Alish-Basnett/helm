// The folder a session belongs to (v0.27): one project per folder.
import fs from 'node:fs';
import path from 'node:path';

const WORKTREE = /\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/;

/** Pure string rules, the same on every replay: no trailing slash, no repeated slashes, a Claude worktree maps to its repo root. */
export function normaliseFolder(cwd) {
  let p = String(cwd ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!p) return '';
  p = p.replace(WORKTREE, '');
  p = p.length > 1 ? p.replace(/\/+$/, '') : p;
  return p || '/';
}

/**
 * What the hub records at ingest (needs the disk, so it is carried in the event and never re-run on replay): resolve symlinks,
 * then the string rules (a `.claude/worktrees/<name>` path maps to its repo; an external git worktree stays its own folder).
 * A missing folder keeps its path. A relative or empty cwd has no folder (null).
 */
export function resolveFolder(cwd) {
  let p = String(cwd ?? '').trim();
  if (!p || !path.isAbsolute(p)) return null;
  try { p = fs.realpathSync(p); } catch { /* gone or unreadable: keep the path as sent */ }
  // Removed: mapping a git worktree's .git file to its main repo. Folders such as ~/KBank-check are external worktrees of another repo
  // but separate projects; only app-made worktrees (.claude/worktrees/<name>, handled in normaliseFolder) belong to their repo.
  // try {
  //   const dotgit = path.join(p, '.git');
  //   if (fs.statSync(dotgit).isFile()) {
  //     const fd = fs.openSync(dotgit, 'r'); // a worktree's .git is one short line: read at most 4 KB
  //     let text;
  //     try { const buf = Buffer.alloc(4096); text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, 4096, 0)); } finally { fs.closeSync(fd); }
  //     const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  //     const main = m && /^(.*?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(path.resolve(p, m[1]));
  //     if (main) { try { p = fs.realpathSync(main[1]); } catch { p = main[1]; } }
  //   }
  // } catch { /* no .git here */ }
  return normaliseFolder(p);
}
