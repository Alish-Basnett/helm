// SQLite access (node:sqlite) + schema. WAL, busy_timeout, prepared-statement cache.
import fs from 'node:fs';
import path from 'node:path';

// node:sqlite prints an ExperimentalWarning on import; keep the daemon log/TTY clean.
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : (w && w.message) || '';
  if (/sqlite/i.test(msg)) return;
  return origEmit.call(process, w, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = origEmit;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL);

-- Append-only source of truth. Hub commands and sweeps are recorded here too
-- (session_id '_hub') so that replaying this table rebuilds every projection.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, auto INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', busy INTEGER NOT NULL DEFAULT 0,
  now_doing TEXT NOT NULL DEFAULT '', tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT,
  tool_use_id TEXT NOT NULL, subagent_type TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL, ended_at INTEGER, last_activity_at INTEGER NOT NULL,
  now_doing TEXT NOT NULL DEFAULT '', tool_count INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agents_session ON agents(session_id, status);
CREATE INDEX IF NOT EXISTS agents_tooluse ON agents(tool_use_id);
CREATE INDEX IF NOT EXISTS agents_task ON agents(task_id);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
  agent_id TEXT, ord REAL NOT NULL DEFAULT 0, blocked_reason TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]', files_changed TEXT NOT NULL DEFAULT '[]',
  tokens INTEGER NOT NULL DEFAULT 0, recap TEXT, recap_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER,
  conflicts TEXT NOT NULL DEFAULT '[]',   -- v0.2: derived from agent_files (see Projector.recomputeConflicts)
  explainer TEXT,                         -- v0.2: markdown from an explain job
  explain_job TEXT                        -- v0.2: JSON { id, state } of the latest explain job
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS tasks_session ON tasks(session_id);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, queued_at INTEGER, ran_at INTEGER, via TEXT, error TEXT,
  sending_at INTEGER -- when the mod claimed it (queued -> sending); drives the sending timeout
);
CREATE INDEX IF NOT EXISTS notes_session ON notes(session_id, state);
CREATE INDEX IF NOT EXISTS notes_target ON notes(target_kind, target_id);
-- NOT AUTOINCREMENT: ids restart at 1 after a rebuild so replays are byte-identical.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT, task_id TEXT,
  kind TEXT NOT NULL, tool TEXT, summary TEXT NOT NULL DEFAULT '', ok INTEGER, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_session ON activity(session_id, id);
CREATE INDEX IF NOT EXISTS activity_task ON activity(task_id, id);
CREATE INDEX IF NOT EXISTS activity_agent ON activity(agent_id);
-- agent.completed seen before agent.bound (sync subagents): applied when the bind arrives.
CREATE TABLE IF NOT EXISTS late_completions (
  session_id TEXT NOT NULL, agent_id TEXT NOT NULL, ok INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '', tokens INTEGER, at INTEGER NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);

-- v0.2 extras ---------------------------------------------------------------
-- Files an agent announced it is about to edit (tool.called.files). Drives the conflict radar.
CREATE TABLE IF NOT EXISTS agent_files (
  agent_id TEXT NOT NULL, path TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, path)
);
CREATE INDEX IF NOT EXISTS agent_files_path ON agent_files(path);
-- Current conflicts (a projection of agent_files + agents), one row per contested path.
CREATE TABLE IF NOT EXISTS conflicts (path TEXT PRIMARY KEY, agents TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT, task_id TEXT,
  kind TEXT NOT NULL, text TEXT NOT NULL, tool_use_id TEXT,
  state TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS questions_state ON questions(state);
CREATE INDEX IF NOT EXISTS questions_tool ON questions(session_id, tool_use_id);
CREATE INDEX IF NOT EXISTS questions_agent ON questions(agent_id, kind, state);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, task_id TEXT, project_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued', input TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT,
  created_at INTEGER NOT NULL, claimed_at INTEGER, done_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_session ON jobs(session_id, state);
CREATE INDEX IF NOT EXISTS jobs_task ON jobs(task_id, kind, state);
CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, project_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS digests_date ON digests(date);

CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, op TEXT NOT NULL, row TEXT NOT NULL
);

-- Full-text search: external-content FTS5 kept in sync by triggers (same transaction).
CREATE TABLE IF NOT EXISTS search_docs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  session_id TEXT, task_id TEXT, at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, ref)
);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  title, body, content='search_docs', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS search_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS search_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search(search, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS search_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search(search, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO search(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
`;

const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export class Db {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.cache = new Map();
    this.depth = 0;
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = OFF');
    this.raw.exec(SCHEMA);
    this.migrate();
  }
  /** Additive migrations for databases created by an older schema. Each step is guarded by a column check. */
  migrate() {
    const has = (table, col) => this.raw.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!has('notes', 'sending_at')) this.raw.exec('ALTER TABLE notes ADD COLUMN sending_at INTEGER');
    // v0.2: the new tables come from SCHEMA (CREATE TABLE IF NOT EXISTS); only tasks needs new columns.
    // Existing rows are not back-filled: run `helmd --rebuild` to replay old events through the new projections.
    if (!has('tasks', 'conflicts')) this.raw.exec("ALTER TABLE tasks ADD COLUMN conflicts TEXT NOT NULL DEFAULT '[]'");
    if (!has('tasks', 'explainer')) this.raw.exec('ALTER TABLE tasks ADD COLUMN explainer TEXT');
    if (!has('tasks', 'explain_job')) this.raw.exec('ALTER TABLE tasks ADD COLUMN explain_job TEXT');
  }
  prep(sql) {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }
  exec(sql) { this.raw.exec(sql); }
  run(sql, ...p) { return this.prep(sql).run(...norm(p)); }
  get(sql, ...p) { return this.prep(sql).get(...norm(p)); }
  all(sql, ...p) { return this.prep(sql).all(...norm(p)); }
  /** Run fn inside one transaction (re-entrant). Returns [result, outermost] via callbacks. */
  transaction(fn, { onCommit, onRollback } = {}) {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    let result;
    try {
      result = fn();
      this.raw.exec('COMMIT');
    } catch (e) {
      this.depth = 0;
      try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
      if (onRollback) onRollback();
      throw e;
    }
    this.depth = 0;
    if (onCommit) onCommit();
    return result;
  }
  checkpoint() { try { this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy */ } }
  close() {
    this.checkpoint();
    this.cache.clear();
    this.raw.close();
  }
}
