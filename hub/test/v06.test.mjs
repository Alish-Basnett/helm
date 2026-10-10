// v0.6: Agent.parentId (subagent nesting): stored, follows pending -> bound renames, migrates, rebuilds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, tmpDir } from './helpers.mjs';
import { loadConfig } from '../config.mjs';
import { createLogger } from '../log.mjs';
import { Hub } from '../hub.mjs';

const agentOf = (h, id) => h.state().agents.find((a) => a.id === id);

test('parentAgentId is stored as Agent.parentId and follows renames of parent and child', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('s1', 'session.started', { cwd: '/w', title: 'Main', model: 'opus' }));
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tp', subagentType: 'general-purpose', description: 'parent' }));
  assert.equal(agentOf(h, 'pending:tp').parentId, null);
  // child spawned by a parent whose id is already bound upstream (engine ids) while our row is still pending
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tc', subagentType: 'general-purpose', description: 'child', parentAgentId: 'ap' }));
  assert.equal(agentOf(h, 'pending:tc').parentId, 'ap');
  // a child that points at the pending id follows when the parent binds
  h.send(h.ev('s1', 'agent.spawned', { toolUseId: 'tk', subagentType: 'general-purpose', description: 'kid', parentAgentId: 'pending:tp' }));
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tp', agentId: 'ap' }));
  assert.equal(agentOf(h, 'pending:tk').parentId, 'ap');
  // child renames keep their parent
  h.send(h.ev('s1', 'agent.bound', { toolUseId: 'tc', agentId: 'ac' }));
  assert.equal(agentOf(h, 'ac').parentId, 'ap');
  assert.equal(agentOf(h, 'ap').parentId, null);
});

test('rebuild reproduces parentId deterministically', async (t) => {
  const h = await startTest(); t.after(h.stop);
  h.send(h.ev('s1', 'session.started', { cwd: '/w', title: 'Main', model: 'opus' }),
    h.ev('s1', 'agent.spawned', { toolUseId: 'tp', subagentType: 'g', description: 'parent' }),
    h.ev('s1', 'agent.spawned', { toolUseId: 'tc', subagentType: 'g', description: 'child', parentAgentId: 'pending:tp' }),
    h.ev('s1', 'agent.bound', { toolUseId: 'tp', agentId: 'ap' }),
    h.ev('s1', 'agent.bound', { toolUseId: 'tc', agentId: 'ac' }));
  const before = h.hub.dump(), st = h.state();
  h.hub.rebuild();
  assert.deepEqual(h.hub.dump(), before);
  assert.deepEqual({ ...h.state(), seq: 0 }, { ...st, seq: 0 });
  assert.equal(agentOf(h, 'ac').parentId, 'ap');
});

test('a database from before v0.6 gains agents.parent_id; old rows read parentId null; rebuild back-fills', async (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig({ home: dir, port: 0, singleton: false, sweep: false });
  const log = createLogger(path.join(dir, 'x.log'), { tty: false });
  let hub = new Hub(cfg, log);
  const T = Date.now();
  const ev = (seq, type, data) => ({ sessionId: 's1', seq, type, at: T + seq, data });
  hub.ingest([ev(1, 'session.started', { cwd: '/w/p', title: 'S', model: 'm' }),
    ev(2, 'agent.spawned', { toolUseId: 'tp', subagentType: 'b', description: 'P' }),
    ev(3, 'agent.spawned', { toolUseId: 'tc', subagentType: 'b', description: 'C', parentAgentId: 'ap' }),
    ev(4, 'agent.bound', { toolUseId: 'tp', agentId: 'ap' }), ev(5, 'agent.bound', { toolUseId: 'tc', agentId: 'ac' })]);
  hub.close();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(cfg.dbFile);
  raw.exec('ALTER TABLE agents DROP COLUMN parent_id');
  raw.close();
  for (let i = 0; i < 2; i++) { // second open proves idempotence
    hub = new Hub(cfg, log);
    assert.deepEqual(hub.state().agents.map((a) => a.parentId), [null, null]);
    if (i === 0) hub.close();
  }
  hub.rebuild();
  assert.equal(hub.state().agents.find((a) => a.id === 'ac').parentId, 'ap');
  hub.close();
});
