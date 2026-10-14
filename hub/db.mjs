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
  now_doing TEXT NOT NULL DEFAULT '', tool_count INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
  git TEXT,                               -- v0.5: JSON { cwd, root, base, head, at } from agent.git
  parent_id TEXT                          -- v0.6: id of the agent that spawned this one (follows renames)
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
  explain_job TEXT,                       -- v0.2: JSON { id, state } of the latest explain job
  start_note_id TEXT,                     -- v0.3: the latest Start note
  git TEXT,                               -- v0.5: JSON { root, base, head, at } recorded at spawn (first base wins)
  diff_stat TEXT,                         -- v0.5: JSON { files, additions, deletions } from the latest snapshot / live diff
  branch TEXT                             -- v0.12: JSON Task.branch (git branch / PR / CI), from hub.task.branch + hub.task.ci
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS tasks_session ON tasks(session_id);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, queued_at INTEGER, ran_at INTEGER, via TEXT, error TEXT,
  sending_at INTEGER, -- when the mod claimed it (queued -> sending); drives the sending timeout
  reply TEXT,         -- v0.3: the agent's answer (markdown)
  replied_at INTEGER, -- v0.3
  attachments TEXT NOT NULL DEFAULT '[]' -- v0.4: JSON [{ id, name, mime, size, path }]
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

-- v0.4: attachment metadata (the bytes live on disk under $HELM_HOME/attachments/<id>/) and the cost meter.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
);
-- NOT AUTOINCREMENT, like activity: ids restart at 1 after a rebuild.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '', input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, task_id TEXT, note_id TEXT
);
CREATE INDEX IF NOT EXISTS usage_at ON usage(at);

-- v0.5: the latest frozen diff per task (written by hub.task.diff events; bytes capped by diff.mjs).
CREATE TABLE IF NOT EXISTS task_diffs (
  task_id TEXT PRIMARY KEY, diff TEXT NOT NULL, at INTEGER NOT NULL
);

-- v0.9: Workflows. workflows/versions are the graph store; runs/run_nodes/steps are the execution state
-- (all projections of wf.* events; see hub/workflows.mjs).
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, current_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS workflows_project ON workflows(project_id);
CREATE TABLE IF NOT EXISTS workflow_versions (
  workflow_id TEXT NOT NULL, version INTEGER NOT NULL, graph TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
  summary TEXT NOT NULL DEFAULT '', parent_version INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, version)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, version INTEGER NOT NULL, project_id TEXT NOT NULL,
  status TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', driver_session_id TEXT, budget_usd REAL,
  cost_usd REAL NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, ended_at INTEGER, error TEXT
);
CREATE INDEX IF NOT EXISTS runs_workflow ON runs(workflow_id);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE TABLE IF NOT EXISTS run_nodes (
  run_id TEXT NOT NULL, node_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 0,
  task_id TEXT, agent_id TEXT, started_at INTEGER, ended_at INTEGER, output TEXT, error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, question_id TEXT,
  PRIMARY KEY (run_id, node_id)
);
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL,
  session_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', input TEXT NOT NULL DEFAULT '{}', result TEXT,
  error TEXT, task_id TEXT, created_at INTEGER NOT NULL, claimed_at INTEGER, done_at INTEGER, not_before INTEGER
);
CREATE INDEX IF NOT EXISTS steps_session ON steps(session_id, state);
CREATE INDEX IF NOT EXISTS steps_run ON steps(run_id, node_id, attempt);

-- v0.11: task templates (projections of hub.template.* events; see hub/templates.mjs). project_id NULL = all projects.
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  agent TEXT NOT NULL DEFAULT 'auto', checks TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
  usage INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS templates_project ON templates(project_id);

-- v0.13: concepts, a knowledge base projected from recap tags (see hub/concepts.mjs). concept_tasks = which recap taught which
-- concept; concept_keys = normalised spelling -> slug (variants and merged names land on the same concept).
CREATE TABLE IF NOT EXISTS concepts (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', summary TEXT, summary_at INTEGER,
  task_ids TEXT NOT NULL DEFAULT '[]', task_ats TEXT NOT NULL DEFAULT '[]', first_seen_at INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0, related TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS concepts_seen ON concepts(last_seen_at);
CREATE TABLE IF NOT EXISTS concept_tasks (
  slug TEXT NOT NULL, task_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (slug, task_id)
);
CREATE INDEX IF NOT EXISTS concept_tasks_task ON concept_tasks(task_id);
CREATE TABLE IF NOT EXISTS concept_keys (key TEXT PRIMARY KEY, slug TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS concept_keys_slug ON concept_keys(slug);

-- v0.14: session health history. At most one row a minute per session (appended from heartbeats), pruned to 7 days.
-- NOT AUTOINCREMENT, like activity: ids restart at 1 after a rebuild so replays are byte-identical.
CREATE TABLE IF NOT EXISTS session_samples (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0, percent REAL, cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS session_samples_session ON session_samples(session_id, at);

-- v0.15: Studio documents (projections of hub.doc.* events; see hub/docs.mjs). blocks = JSON block tree; doc_versions are snapshots
-- (edits coalesce into one snapshot per 5 minutes); doc_comments anchor to a block + quote.
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'document',
  blocks TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 0, next_block INTEGER NOT NULL DEFAULT 1,
  session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS docs_project ON docs(project_id);
CREATE TABLE IF NOT EXISTS doc_versions (
  doc_id TEXT NOT NULL, n INTEGER NOT NULL, blocks TEXT NOT NULL, cause TEXT NOT NULL, job_id TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, n)
);
CREATE TABLE IF NOT EXISTS doc_comments (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, block_id TEXT, anchor TEXT, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL, applied_version INTEGER, job_id TEXT, reason TEXT
);
CREATE INDEX IF NOT EXISTS doc_comments_doc ON doc_comments(doc_id, state);

-- v0.26: cross-project links (notes and cards a session sent to another project). Projection of hub.link.* events; see hub/projections.mjs.
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, from_session_id TEXT NOT NULL, from_project_id TEXT NOT NULL,
  to_project_id TEXT NOT NULL, to_session_id TEXT, ref_id TEXT, text TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL, reply TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, answered_at INTEGER, acknowledged_at INTEGER
);
CREATE INDEX IF NOT EXISTS links_state ON links(state);
-- covers deliverLinks' held-note query without touching the table
CREATE INDEX IF NOT EXISTS links_deliver ON links(kind, state, to_project_id, ref_id);

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
    // v0.3: note replies and the task's Start note (run `helmd --rebuild` to back-fill from old events).
    if (!has('notes', 'reply')) this.raw.exec('ALTER TABLE notes ADD COLUMN reply TEXT');
    if (!has('notes', 'replied_at')) this.raw.exec('ALTER TABLE notes ADD COLUMN replied_at INTEGER');
    if (!has('tasks', 'start_note_id')) this.raw.exec('ALTER TABLE tasks ADD COLUMN start_note_id TEXT');
    // v0.4: note attachments (the attachments / usage tables come from SCHEMA; run `helmd --rebuild` to back-fill usage).
    if (!has('notes', 'attachments')) this.raw.exec("ALTER TABLE notes ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    // v0.5: git base + diff stat (task_diffs comes from SCHEMA). Additive and nullable, so safe on a live database;
    // run `helmd --rebuild` to back-fill from old events.
    if (!has('tasks', 'git')) this.raw.exec('ALTER TABLE tasks ADD COLUMN git TEXT');
    if (!has('tasks', 'diff_stat')) this.raw.exec('ALTER TABLE tasks ADD COLUMN diff_stat TEXT');
    if (!has('agents', 'git')) this.raw.exec('ALTER TABLE agents ADD COLUMN git TEXT');
    // v0.6: subagent nesting. Additive + nullable, so safe on a live database; `helmd --rebuild` back-fills it.
    if (!has('agents', 'parent_id')) this.raw.exec('ALTER TABLE agents ADD COLUMN parent_id TEXT');
    // v0.6 (T-21): Choices + task parent link. Additive, defaulted, safe on a live database; `helmd --rebuild` back-fills.
    if (!has('tasks', 'choices')) this.raw.exec("ALTER TABLE tasks ADD COLUMN choices TEXT NOT NULL DEFAULT '[]'");
    if (!has('tasks', 'parent_task_id')) this.raw.exec('ALTER TABLE tasks ADD COLUMN parent_task_id TEXT');
    // v0.7 (T-41): Up next auto mode. Additive + defaulted, safe on a live database; `helmd --rebuild` back-fills.
    if (!has('projects', 'auto_start')) this.raw.exec('ALTER TABLE projects ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0');
    // T-71: per-project auto concurrency (1-5). Additive + defaulted; `helmd --rebuild` back-fills.
    if (!has('projects', 'auto_concurrency')) this.raw.exec('ALTER TABLE projects ADD COLUMN auto_concurrency INTEGER NOT NULL DEFAULT 1');
    if (!has('tasks', 'auto_started_at')) this.raw.exec('ALTER TABLE tasks ADD COLUMN auto_started_at INTEGER');
    // v0.9: Workflows. The workflow tables come from SCHEMA; tasks, questions and usage learn which run/node they belong to.
    // Additive + nullable, safe on a live database; `helmd --rebuild` back-fills nothing (no old events mention runs).
    if (!has('tasks', 'run_id')) this.raw.exec('ALTER TABLE tasks ADD COLUMN run_id TEXT');
    if (!has('tasks', 'node_id')) this.raw.exec('ALTER TABLE tasks ADD COLUMN node_id TEXT');
    if (!has('questions', 'run_id')) this.raw.exec('ALTER TABLE questions ADD COLUMN run_id TEXT');
    if (!has('questions', 'node_id')) this.raw.exec('ALTER TABLE questions ADD COLUMN node_id TEXT');
    if (!has('usage', 'run_id')) this.raw.exec('ALTER TABLE usage ADD COLUMN run_id TEXT');
    if (!has('usage', 'node_id')) this.raw.exec('ALTER TABLE usage ADD COLUMN node_id TEXT');
    this.raw.exec('CREATE INDEX IF NOT EXISTS usage_run ON usage(run_id)');
    // v0.11: the templates table comes from SCHEMA (CREATE TABLE IF NOT EXISTS), so a live database gains it on open, empty.
    // Back-filling is `helmd --rebuild` (no old events mention templates, so nothing is lost either way).
    this.raw.exec('CREATE INDEX IF NOT EXISTS templates_project ON templates(project_id)');
    // v0.12: Task.branch. Additive + nullable, safe on a live database (no old events mention branches, so nothing to back-fill).
    if (!has('tasks', 'branch')) this.raw.exec('ALTER TABLE tasks ADD COLUMN branch TEXT');
    // v0.14: session health. Additive + defaulted/nullable, safe on a live database. session_samples comes from SCHEMA.
    // Existing sessions start at health 'ok' with no context data until their next heartbeat (or `helmd --rebuild`).
    if (!has('sessions', 'context_window')) this.raw.exec('ALTER TABLE sessions ADD COLUMN context_window INTEGER');
    if (!has('sessions', 'context_percent')) this.raw.exec('ALTER TABLE sessions ADD COLUMN context_percent REAL');
    if (!has('sessions', 'rate_limits')) this.raw.exec("ALTER TABLE sessions ADD COLUMN rate_limits TEXT NOT NULL DEFAULT '[]'");
    if (!has('sessions', 'busy_since')) this.raw.exec('ALTER TABLE sessions ADD COLUMN busy_since INTEGER');
    if (!has('sessions', 'last_turn_at')) this.raw.exec('ALTER TABLE sessions ADD COLUMN last_turn_at INTEGER');
    if (!has('sessions', 'health_level')) this.raw.exec("ALTER TABLE sessions ADD COLUMN health_level TEXT NOT NULL DEFAULT 'ok'");
    if (!has('sessions', 'health_reasons')) this.raw.exec("ALTER TABLE sessions ADD COLUMN health_reasons TEXT NOT NULL DEFAULT '[]'");
    if (!has('sessions', 'cost_day')) this.raw.exec('ALTER TABLE sessions ADD COLUMN cost_day TEXT');
    if (!has('sessions', 'cost_base')) this.raw.exec('ALTER TABLE sessions ADD COLUMN cost_base REAL NOT NULL DEFAULT 0');
    // T-66: paths a task's own tool calls mentioned (attribution for git-derived files) and the label of how filesChanged was derived.
    if (!has('tasks', 'mentions')) this.raw.exec("ALTER TABLE tasks ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'");
    if (!has('tasks', 'files_note')) this.raw.exec('ALTER TABLE tasks ADD COLUMN files_note TEXT');
    // T-76: the agent's full final report (agent.completed data.report), so a recap can be rebuilt from it. Additive + nullable.
    if (!has('agents', 'report')) this.raw.exec('ALTER TABLE agents ADD COLUMN report TEXT');
    if (!has('late_completions', 'report')) this.raw.exec('ALTER TABLE late_completions ADD COLUMN report TEXT');
    // T-53: who set a task's block: 'user' (PATCH) or null (agent failure, stall, workflow). Additive + nullable.
    if (!has('tasks', 'blocked_by')) this.raw.exec('ALTER TABLE tasks ADD COLUMN blocked_by TEXT');
    // T-70: the task's latest agent ended without success (killed, stopped, failed) and nothing has run since.
    if (!has('tasks', 'interrupted')) {
      this.raw.exec('ALTER TABLE tasks ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0');
      this.raw.exec(`UPDATE tasks SET interrupted = 1 WHERE agent_id IN (SELECT id FROM agents WHERE status = 'failed')
        AND status NOT IN ('done','archived')`);
    }
    // v0.26: coordinator project, cross-project cards, note links, acknowledge-to-archive. Additive + defaulted/nullable; `helmd --rebuild` back-fills.
    if (!has('projects', 'coordinator')) this.raw.exec('ALTER TABLE projects ADD COLUMN coordinator INTEGER NOT NULL DEFAULT 0');
    if (!has('sessions', 'acknowledged_at')) this.raw.exec('ALTER TABLE sessions ADD COLUMN acknowledged_at INTEGER');
    if (!has('agents', 'acknowledged_at')) this.raw.exec('ALTER TABLE agents ADD COLUMN acknowledged_at INTEGER');
    if (!has('tasks', 'created_by_session_id')) this.raw.exec('ALTER TABLE tasks ADD COLUMN created_by_session_id TEXT');
    if (!has('tasks', 'from_project_id')) this.raw.exec('ALTER TABLE tasks ADD COLUMN from_project_id TEXT');
    if (!has('notes', 'link_id')) this.raw.exec('ALTER TABLE notes ADD COLUMN link_id TEXT');
    this.raw.exec('CREATE INDEX IF NOT EXISTS notes_link ON notes(link_id)');
    this.raw.exec('CREATE INDEX IF NOT EXISTS notes_link_queued ON notes(state, link_id, session_id)'); // deliverLinks' stranded-note query
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
