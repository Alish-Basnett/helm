import { describe, expect, mock, test } from 'claude-code/testing'

// Unit tests for the Helm mod (hooks/register.ts).
//
// Shape of every test: the test's `on` hooks sit BENEATH the plugin and stand for the engine, so
//   - `http.fetch` is a fake Helm hub (it records POST /v1/events bodies),
//   - `agent.spawn`, `tool.call`, `turn.complete`, `prompt.submit`, `session.send`, `model.complete`,
//     `agent.list`, `process.run`, `fs.*` answer what the engine would.
// The 1.5 s tick runs on `mock.clock`, so nothing waits in real time.
//
// register.ts keeps module-level state (session id, outbox, completed-agent set), so each test uses
// its own session id and agent ids and reads only the events it caused.

const TICK = 1500

type Ev = { sessionId: string; seq: number; type: string; at: number; data: Record<string, any> }

type HubOpts = {
  up?: boolean
  tasks?: any[]
  agents?: any[]
  taskDetail?: Record<string, { task: any; agent: any }>
}

// A fake hub speaking just enough of CONTRACT.md for the mod.
function fakeHub(sessionId: string, opts: HubOpts = {}) {
  const events: Ev[] = []
  const calls: { method: string; path: string; body?: any }[] = []
  const inbox: any[] = []
  const jobs: any[] = []
  const steps: any[] = []
  const state = { up: opts.up ?? true, stepsStatus: 200 }
  const tasks = opts.tasks ?? []

  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: {}, text: JSON.stringify(body) })

  function handle(url: string, init: any = {}) {
    const method = String(init.method ?? 'GET')
    const path = url.replace(/^http:\/\/helm/, '')
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    if (!state.up) return { ok: false, status: 503, headers: {}, text: 'hub down' }
    if (method === 'GET' && path === '/v1/health') return json({ ok: true })
    if (method === 'POST' && path === '/v1/events') {
      events.push(...body.events)
      return json({ accepted: body.events.length, duplicates: 0, lastSeq: body.events.at(-1)?.seq ?? 0 })
    }
    if (method === 'GET' && path === `/v1/sessions/${sessionId}/inbox`) return json({ notes: inbox.splice(0) })
    if (method === 'GET' && path === `/v1/sessions/${sessionId}/jobs`) return json({ jobs: jobs.splice(0) })
    if (method === 'GET' && path === `/v1/sessions/${sessionId}/steps`) return state.stepsStatus === 200 ? json({ steps: steps.splice(0) }) : json({ error: 'not found' }, state.stepsStatus)
    if (method === 'GET' && path === `/v1/sessions/${sessionId}/agents`) return json({ agents: opts.agents ?? [] })
    if (method === 'GET' && path === `/v1/sessions/${sessionId}/project`) return json({ project: { id: 'P-1', name: 'proj' } })
    if (method === 'GET' && path.startsWith('/v1/tasks?')) return json({ tasks })
    if (method === 'POST' && path === '/v1/tasks') {
      const task = { id: 'T-42', status: body.status, title: body.title }
      tasks.push(task)
      return json({ task })
    }
    const detail = path.match(/^\/v1\/tasks\/(T-\d+)$/)
    if (method === 'GET' && detail) {
      const d = opts.taskDetail?.[detail[1]!]
      return d ? json({ ...d, activity: [], notes: [] }) : json({ error: 'not found' }, 404)
    }
    return json({ error: `unexpected ${method} ${path}` }, 404)
  }

  return {
    events,
    calls,
    inbox,
    jobs,
    steps,
    state,
    handle,
    ofType: (type: string) => events.filter(e => e.type === type),
    eventPosts: () => calls.filter(c => c.method === 'POST' && c.path === '/v1/events'),
  }
}

type World = {
  clock: ReturnType<typeof mock.clock>
  hub: ReturnType<typeof fakeHub>
  spawned: any[]
  sent: any[]
  submitted: any[]
  modelCalls: any[]
  processCalls: any[]
  toolCalls: any[]
  toolRegistered: any[]
  storeSets: { key: string; value: any }[]
  storeSeed: Record<string, any>
  agentList: { value: any[] }
  sessionId?: string
  engine: { submitResult: any; sendResult: any; modelResult: any; spawnResult: any; processRun: (e: any) => any; toolResult: (e: any) => any }
}

let counter = 0

// Wires the engine floor, starts the session, and lets the first tick (hub up + first flush) settle.
async function boot($: any, on: any, opts: HubOpts & { start?: boolean } = {}): Promise<World & { sessionId: string }> {
  const n = ++counter
  const sessionId = `sess-${String(n).padStart(4, '0')}-abcdef`
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.env(on, { HELM_HOME: '/tmp/helm-test-home', HOME: '/home/test' })
  const hub = fakeHub(sessionId, opts)
  const w: World = {
    clock,
    hub,
    spawned: [],
    sent: [],
    submitted: [],
    modelCalls: [],
    processCalls: [],
    toolCalls: [],
    toolRegistered: [],
    storeSets: [],
    storeSeed: {},
    agentList: { value: [] },
    engine: {
      submitResult: {},
      sendResult: { isDelivered: true },
      modelResult: { isAnswered: true, text: '  ## What happened\nIt works.  ', usage: {} },
      spawnResult: undefined,
      processRun: () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
      toolResult: () => ({ result: 'ok' }),
    },
  }

  // Op events ($.session.id(), $.http.fetch(), ...) are answered as { value }; engine events as their result object.
  const v = (value: unknown) => ({ value })
  // A small in-memory store (replaces mock.store so sets can be recorded): storeSeed holds the data, as after a reload.
  on('store.set', (_$: any, e: any) => (w.storeSets.push({ key: e.key, value: e.value }), w.storeSeed[e.key] = e.value, v(undefined)))
  on('store.get', (_$: any, e: any) => v(w.storeSeed[e.key]))
  on('http.fetch', (_$: any, e: any) => v(hub.handle(e.url, e.init)))
  on('session.id', () => v(sessionId))
  on('session.cwd', () => v('/work/proj'))
  on('session.model', () => v('opus'))
  on('session.usage', () => v({ context: { tokens: 1234 }, cost: { usd: 0.5 } }))
  on('agent.list', () => v(w.agentList.value))
  on('ui.status', () => v(undefined))
  on('fs.exists', () => v(false))
  on('fs.write', () => v(undefined))
  on('process.run', (_$: any, e: any) => { w.processCalls.push(e); const r = w.engine.processRun(e); return r?.deny ? r : v(r) })
  on('command.register', (_$: any, e: any) => v({ command: e.name }))
  on('tool.register', (_$: any, e: any) => (w.toolRegistered.push(e), v({ tool: `mcp__helm__${e.name}` })))
  on('agent.register', (_$: any, e: any) => v({ agent: `helm:${e.name}` }))
  on('model.complete', (_$: any, e: any) => (w.modelCalls.push(e), v(w.engine.modelResult)))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))

  // The engine floor for the events the mod hooks: the bottom answers what core would.
  // (All of them are registered here: a test may not add hooks after its first call on `$`.)
  on('agent.spawn', (_$: any, e: any) => {
    w.spawned.push(e)
    return w.engine.spawnResult ?? { model: e.model ?? 'inherit' }
  })
  on('prompt.submit', (_$: any, e: any) => (w.submitted.push(e), w.engine.submitResult.drop ? w.engine.submitResult : { text: e.text, ...w.engine.submitResult }))
  on('session.send', (_$: any, e: any) => (w.sent.push(e), w.engine.sendResult))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('tool.call', (_$: any, e: any) => (w.toolCalls.push(e), w.engine.toolResult(e)))
  on('prompt.compose', () => ({ sections: [{ id: 'core', scope: 'session', text: 'core prompt' }] }))

  if (opts.start !== false) {
    await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: true })
    await clock.settle()
  }
  return { ...w, sessionId }
}

// Drive one tick of the 1.5 s timer and let the flush it starts finish.
async function tick(w: World) {
  await w.clock.advance(TICK)
  await w.clock.settle()
}

const asEvent = (type: string, w: World) => w.hub.ofType(type)

describe('model routing (agent.spawn)', () => {
  const spawn = (extra: Record<string, unknown>) => ({
    tool_use_id: 'tu-route',
    prompt: 'do it',
    description: 'route',
    provider: { plugin: 'x', tier: 'user' },
    parentModel: 'opus',
    background: true,
    fork: false,
    ...extra,
  })

  test('helm:builder with no model runs on sonnet', async ($, on) => {
    const w = await boot($, on)
    await $.agent.spawn(spawn({ subagentType: 'helm:builder' }) as any)
    expect(w.spawned.at(-1).model).toBe('sonnet')
  })

  test('helm:scout and Explore run on haiku', async ($, on) => {
    const w = await boot($, on)
    await $.agent.spawn(spawn({ subagentType: 'helm:scout' }) as any)
    expect(w.spawned.at(-1).model).toBe('haiku')
    await $.agent.spawn(spawn({ subagentType: 'Explore' }) as any)
    expect(w.spawned.at(-1).model).toBe('haiku')
  })

  test('an unknown type with no model defaults to sonnet', async ($, on) => {
    const w = await boot($, on)
    await $.agent.spawn(spawn({ subagentType: 'general-purpose' }) as any)
    expect(w.spawned.at(-1).model).toBe('sonnet')
  })

  test('an explicit opus is downgraded to sonnet (alias and full id)', async ($, on) => {
    const w = await boot($, on)
    await $.agent.spawn(spawn({ subagentType: 'helm:builder', model: 'opus' }) as any)
    expect(w.spawned.at(-1).model).toBe('sonnet')
    await $.agent.spawn(spawn({ subagentType: 'general-purpose', model: 'claude-opus-4-1' }) as any)
    expect(w.spawned.at(-1).model).toBe('sonnet')
  })

  test('an explicit non-opus model is kept', async ($, on) => {
    const w = await boot($, on)
    await $.agent.spawn(spawn({ subagentType: 'helm:builder', model: 'haiku' }) as any)
    expect(w.spawned.at(-1).model).toBe('haiku')
  })

  test('a fork is left untouched', async ($, on) => {
    const w = await boot($, on)
    await $.agent.spawn(spawn({ subagentType: 'fork', fork: true }) as any)
    expect(w.spawned.at(-1).model).toBeUndefined()
    await $.agent.spawn(spawn({ subagentType: 'fork', fork: true, model: 'opus' }) as any)
    expect(w.spawned.at(-1).model).toBe('opus')
  })
})

describe('agent.spawned event', () => {
  test('parses the [helm:T-n] tag into taskId and strips it from the description', async ($, on) => {
    const w = await boot($, on)
    w.engine.spawnResult = { model: 'sonnet' }
    await $.agent.spawn({
      tool_use_id: 'tu-spawn-1',
      prompt: 'write the tests',
      description: '[helm:T-7] Write the tests',
      subagentType: 'helm:builder',
      provider: { plugin: 'x', tier: 'user' },
      parentModel: 'opus',
      background: true,
      fork: false,
    } as any)
    await tick(w)
    const ev = asEvent('agent.spawned', w).find(e => e.data.toolUseId === 'tu-spawn-1')!
    expect(ev).toBeDefined()
    expect(ev.sessionId).toBe(w.sessionId)
    expect(ev.data).toMatchObject({
      toolUseId: 'tu-spawn-1',
      taskId: 'T-7',
      subagentType: 'helm:builder',
      model: 'sonnet',
      description: 'Write the tests',
      prompt: 'write the tests',
    })
    expect(ev.data.description).not.toContain('helm:')
  })

  test('without a tag taskId is undefined and the description is kept', async ($, on) => {
    const w = await boot($, on)
    await $.agent.spawn({
      tool_use_id: 'tu-spawn-2',
      prompt: 'p',
      description: 'plain work',
      subagentType: 'Explore',
      provider: { plugin: 'x', tier: 'user' },
      parentModel: 'opus',
      background: false,
      fork: false,
    } as any)
    await tick(w)
    const ev = asEvent('agent.spawned', w).find(e => e.data.toolUseId === 'tu-spawn-2')!
    expect(ev.data.taskId).toBeUndefined()
    expect(ev.data.description).toBe('plain work')
    expect(ev.data.model).toBe('haiku')
  })

  test('a started subagent also emits agent.bound with its id', async ($, on) => {
    const w = await boot($, on)
    w.engine.spawnResult = { model: 'sonnet', agentId: 'ag-spawn-3' }
    await $.agent.spawn({
      tool_use_id: 'tu-spawn-3',
      prompt: 'p',
      description: '[helm:T-3] bound at spawn',
      subagentType: 'helm:builder',
      provider: { plugin: 'x', tier: 'user' },
      parentModel: 'opus',
      background: true,
      fork: false,
    } as any)
    await tick(w)
    expect(asEvent('agent.bound', w).find(e => e.data.toolUseId === 'tu-spawn-3')?.data).toEqual({ toolUseId: 'tu-spawn-3', agentId: 'ag-spawn-3' })
  })

  test('a denied spawn emits nothing', async ($, on) => {
    const w = await boot($, on)
    w.engine.spawnResult = { deny: 'nope' }
    const r: any = await $.agent.spawn({
      tool_use_id: 'tu-spawn-deny',
      prompt: 'p',
      description: '[helm:T-9] denied',
      subagentType: 'helm:builder',
      provider: { plugin: 'x', tier: 'user' },
      parentModel: 'opus',
      background: true,
      fork: false,
    } as any)
    expect(r.deny).toBe('nope')
    await tick(w)
    expect(asEvent('agent.spawned', w).filter(e => e.data.toolUseId === 'tu-spawn-deny')).toHaveLength(0)
  })
})

describe('tool events (tool.call)', () => {
  test('Edit emits tool.called with files and agentId, then tool.finished', async ($, on) => {
    const w = await boot($, on)
    w.engine.toolResult = () => ({ result: 'edited' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y', tool_use_id: 'tu-edit', agentId: 'ag-edit' } as any)
    await tick(w)
    const called = asEvent('tool.called', w).find(e => e.data.toolUseId === 'tu-edit')!
    const finished = asEvent('tool.finished', w).find(e => e.data.toolUseId === 'tu-edit')!
    expect(called.data).toMatchObject({ agentId: 'ag-edit', tool: 'Edit', summary: 'Editing a.ts', files: ['/repo/src/a.ts'] })
    expect(finished.data).toMatchObject({ agentId: 'ag-edit', tool: 'Edit', ok: true, summary: 'Editing a.ts', files: ['/repo/src/a.ts'] })
    expect(typeof finished.data.durationMs).toBe('number')
    // called comes before finished
    expect(called.seq).toBeLessThan(finished.seq)
  })

  test('Write reports its file; a Read has none; no agentId means the main loop', async ($, on) => {
    const w = await boot($, on)
    w.engine.toolResult = () => ({ result: 'ok' })
    await $.tool.call({ tool: 'Write', file_path: '/repo/new.md', content: 'hi', tool_use_id: 'tu-write' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/repo/new.md', tool_use_id: 'tu-read' } as any)
    await tick(w)
    const write = asEvent('tool.called', w).find(e => e.data.toolUseId === 'tu-write')!
    const read = asEvent('tool.called', w).find(e => e.data.toolUseId === 'tu-read')!
    expect(write.data.files).toEqual(['/repo/new.md'])
    expect(write.data.agentId).toBeUndefined()
    expect(write.data.summary).toBe('Writing new.md')
    expect(read.data.files).toEqual([])
    expect(read.data.summary).toBe('Reading new.md')
  })

  test('a denied tool call finishes ok:false with no files', async ($, on) => {
    const w = await boot($, on)
    w.engine.toolResult = () => ({ deny: 'protected file' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/.env', old_string: 'a', new_string: 'b', tool_use_id: 'tu-denied', agentId: 'ag-den' } as any)
    await tick(w)
    const finished = asEvent('tool.finished', w).find(e => e.data.toolUseId === 'tu-denied')!
    expect(finished.data.ok).toBe(false)
    expect(finished.data.files).toEqual([])
    expect(finished.data.summary).toBe('Denied: protected file')
  })

  test('an Agent tool result with agentId emits agent.bound', async ($, on) => {
    const w = await boot($, on)
    w.engine.toolResult = () => ({ result: { agentId: 'ag-bound', status: 'async_launched', content: [] } })
    await $.tool.call({ tool: 'Agent', description: '[helm:T-5] go', prompt: 'p', subagent_type: 'helm:builder', tool_use_id: 'tu-agent' } as any)
    await tick(w)
    expect(asEvent('agent.bound', w).filter(e => e.data.toolUseId === 'tu-agent').map(e => e.data)).toEqual([{ toolUseId: 'tu-agent', agentId: 'ag-bound' }])
    expect(asEvent('agent.completed', w).filter(e => e.data.agentId === 'ag-bound')).toHaveLength(0)
    expect(asEvent('tool.called', w).find(e => e.data.toolUseId === 'tu-agent')!.data.summary).toBe('Delegating: [helm:T-5] go')
  })
})

describe('completion', () => {
  const turn = (extra: Record<string, unknown>) => ({ turnId: 't', durationMs: 5, isAborted: false, answer: '', reason: 'answer', ...extra })

  test('a subagent turn.complete emits one agent.completed with files from the FILES: line', async ($, on) => {
    const w = await boot($, on)
    const answer = 'DONE: wrote tests\nHOW: kit\nFILES: /repo/a.ts, `/repo/b.ts`\nLEARNED: mocking'
    await $.turn.complete(turn({ agentId: 'ag-done-1', answer, usage: { input_tokens: 100, output_tokens: 40 } }) as any)
    await tick(w)
    const done = asEvent('agent.completed', w).filter(e => e.data.agentId === 'ag-done-1')
    expect(done).toHaveLength(1)
    expect(done[0]!.data).toMatchObject({ agentId: 'ag-done-1', ok: true, tokens: 140, files: ['/repo/a.ts', '/repo/b.ts'] })
    expect(done[0]!.data.summary).toContain('DONE: wrote tests')
    // a subagent turn is not a main-thread turn.completed
    expect(asEvent('turn.completed', w)).toHaveLength(0)
  })

  test('FILES: none yields an empty list; a missing line too; markdown bold is tolerated', async ($, on) => {
    const w = await boot($, on)
    await $.turn.complete(turn({ agentId: 'ag-f-none', answer: 'DONE: x\nFILES: none' }) as any)
    await $.turn.complete(turn({ agentId: 'ag-f-missing', answer: 'DONE: x' }) as any)
    await $.turn.complete(turn({ agentId: 'ag-f-bold', answer: '**FILES:** a.ts, b.ts' }) as any)
    await tick(w)
    const files = (id: string) => asEvent('agent.completed', w).find(e => e.data.agentId === id)!.data.files
    expect(files('ag-f-none')).toEqual([])
    expect(files('ag-f-missing')).toEqual([])
    expect(files('ag-f-bold')).toEqual(['a.ts', 'b.ts'])
  })

  test('an Agent tool result that reports completion plus the subagent turn.complete emit exactly one agent.completed', async ($, on) => {
    const w = await boot($, on)
    w.engine.toolResult = () => ({
      result: { agentId: 'ag-once', status: 'completed', totalTokens: 321, content: [{ type: 'text', text: 'DONE: ok\nFILES: x.ts' }] },
    })
    await $.tool.call({ tool: 'Agent', description: '[helm:T-1] once', prompt: 'p', subagent_type: 'helm:builder', tool_use_id: 'tu-once' } as any)
    await $.turn.complete(turn({ agentId: 'ag-once', answer: 'DONE: ok\nFILES: x.ts' }) as any)
    await tick(w)
    const done = asEvent('agent.completed', w).filter(e => e.data.agentId === 'ag-once')
    expect(done).toHaveLength(1)
    expect(done[0]!.data).toMatchObject({ ok: true, tokens: 321, files: ['x.ts'] })
  })

  test('the same holds in the other order (turn.complete first, then the tool result)', async ($, on) => {
    const w = await boot($, on)
    w.engine.toolResult = () => ({ result: { agentId: 'ag-once-2', status: 'completed', content: [{ text: 'DONE: ok' }] } })
    await $.turn.complete(turn({ agentId: 'ag-once-2', answer: 'DONE: ok' }) as any)
    await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'helm:builder', tool_use_id: 'tu-once-2' } as any)
    await tick(w)
    expect(asEvent('agent.completed', w).filter(e => e.data.agentId === 'ag-once-2')).toHaveLength(1)
  })

  test('an aborted or errored subagent turn completes with ok:false', async ($, on) => {
    const w = await boot($, on)
    await $.turn.complete(turn({ agentId: 'ag-err', reason: 'error', isAborted: false }) as any)
    await tick(w)
    const ev = asEvent('agent.completed', w).find(e => e.data.agentId === 'ag-err')!
    expect(ev.data.ok).toBe(false)
    expect(ev.data.summary).toBe('ended: error')
    expect(ev.data.files).toEqual([])
  })

  test('a main-loop turn emits turn.started and turn.completed', async ($, on) => {
    const w = await boot($, on)
    await $.turn.start({ text: 'hi', turnId: 'main-1' } as any)
    await $.turn.complete(turn({ answer: 'hello' }) as any)
    await tick(w)
    expect(asEvent('turn.started', w).length).toBeGreaterThan(0)
    const completed = asEvent('turn.completed', w).at(-1)!
    expect(completed.data.ok).toBe(true)
  })
})

describe('mcp__helm__task tool', () => {
  test('create returns a string result and the delegation hint', async ($, on) => {
    const w = await boot($, on)
    const r: any = await $.tool.call({ tool: 'mcp__helm__task', action: 'create', title: 'Write tests', description: 'cover register.ts', tool_use_id: 'tu-task' } as any)
    expect(typeof r.result).toBe('string')
    expect(r.result).toBe('Created T-42 (next): Write tests')
    expect(r.context).toEqual(['Put [helm:T-42] at the start of the Agent description when delegating it.'])
    const post = w.hub.calls.find(c => c.method === 'POST' && c.path === '/v1/tasks')!
    expect(post.body).toMatchObject({ projectId: 'P-1', sessionId: w.sessionId, title: 'Write tests', description: 'cover register.ts', status: 'next', dependsOn: [] })
  })

  test('list returns one line per task, or a placeholder', async ($, on) => {
    const w = await boot($, on, { tasks: [{ id: 'T-1', title: 'First', status: 'review' }] })
    const r: any = await $.tool.call({ tool: 'mcp__helm__task', action: 'list', tool_use_id: 'tu-list' } as any)
    expect(r.result).toBe('T-1 [review] First')
    w.hub.calls.length = 0
  })

  test('the task tool itself is not reported as tool.called', async ($, on) => {
    const w = await boot($, on)
    await $.tool.call({ tool: 'mcp__helm__task', action: 'create', title: 'X', tool_use_id: 'tu-task-quiet' } as any)
    await tick(w)
    expect(asEvent('tool.called', w).filter(e => e.data.toolUseId === 'tu-task-quiet')).toHaveLength(0)
  })

  test('returns { deny } when the hub is down', async ($, on) => {
    const w = await boot($, on, { up: false })
    expect(w.hub.state.up).toBe(false)
    const r: any = await $.tool.call({ tool: 'mcp__helm__task', action: 'create', title: 'Nope', tool_use_id: 'tu-task-down' } as any)
    expect(typeof r.deny).toBe('string')
    expect(r.deny).toContain('Helm hub')
    expect(r.result).toBeUndefined()
  })

  test('returns { deny } when the hub dies after having been up', async ($, on) => {
    const w = await boot($, on)
    w.hub.state.up = false
    const r: any = await $.tool.call({ tool: 'mcp__helm__task', action: 'create', title: 'Nope', tool_use_id: 'tu-task-died' } as any)
    expect(typeof r.deny).toBe('string')
    expect(r.deny).toContain('Helm hub')
  })
})

describe('prompt.compose', () => {
  test('appends the helm:orchestration section after the engine sections', async ($, on) => {
    await boot($, on)
    const r: any = await $.prompt.compose({ model: 'opus', promptModel: 'opus', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)
    expect(r.sections.map((s: any) => s.id)).toEqual(['core', 'helm:orchestration'])
    const section = r.sections.at(-1)
    expect(section.scope).toBe('session')
    expect(section.text).toContain('mcp__helm__task')
    expect(section.text).toContain('[helm:T-12]')
  })
})

describe('executable notes', () => {
  const taskDetail = (agentId: string | null, extra: Record<string, unknown> = {}) => ({
    'T-5': {
      task: { id: 'T-5', title: 'Fix login', description: 'the original brief', recap: null, filesChanged: ['a.ts', 'b.ts'], ...extra },
      agent: agentId ? { id: agentId } : null,
    },
  })

  test('a task note goes to a live agent via session.send', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('ag-live') as any })
    w.agentList.value = [{ id: 'ag-live', status: 'running' }]
    w.hub.inbox.push({ id: 'N-1', target: { kind: 'task', id: 'T-5' }, text: 'also add a test' })
    await tick(w)
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0].text).toContain('Helm note (N-1)')
    expect(w.sent[0].text).toContain('T-5')
    expect(w.sent[0].text).toContain('also add a test')
    expect(JSON.stringify(w.sent[0].to)).toContain('ag-live')
    expect(w.spawned).toHaveLength(0)
    const result = asEvent('note.result', w).find(e => e.data.noteId === 'N-1')!
    expect(result.data).toEqual({ noteId: 'N-1', ok: true, via: 'send_message' })
  })

  test('a task note whose agent has finished spawns a follow-up helm:builder', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('ag-gone', { recap: { what: 'fixed it', how: 'patched', learned: 'x', concepts: [] } }) as any })
    w.agentList.value = [{ id: 'ag-gone', status: 'completed' }]
    w.engine.spawnResult = { model: 'sonnet', agentId: 'ag-followup' }
    w.hub.inbox.push({ id: 'N-2', target: { kind: 'task', id: 'T-5' }, text: 'now handle logout' })
    await tick(w)
    expect(w.sent).toHaveLength(0)
    expect(w.spawned).toHaveLength(1)
    const sp = w.spawned[0]
    // a plugin's own $.agent.spawn reaches the floor in the Agent tool's shape (subagent_type)
    expect(sp.subagentType ?? sp.subagent_type).toBe('helm:builder')
    expect(sp.description).toBe('[helm:T-5] follow-up')
    expect(sp.prompt).toContain('Fix login')
    expect(sp.prompt).toContain('the original brief')
    expect(sp.prompt).toContain('Previous result: fixed it')
    expect(sp.prompt).toContain('a.ts, b.ts')
    expect(sp.prompt).toContain('now handle logout')
    expect(asEvent('note.result', w).find(e => e.data.noteId === 'N-2')!.data).toMatchObject({ noteId: 'N-2', ok: true, via: 'followup_spawn' })
  })

  test('a pending: agent counts as not live and also gets a follow-up spawn', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('pending:tu-1') as any })
    w.hub.inbox.push({ id: 'N-3', target: { kind: 'task', id: 'T-5' }, text: 'go' })
    await tick(w)
    expect(w.sent).toHaveLength(0)
    expect(w.spawned).toHaveLength(1)
  })

  test('a session note goes through prompt.submit as the user', async ($, on) => {
    const w = await boot($, on)
    w.hub.inbox.push({ id: 'N-4', target: { kind: 'session', id: w.sessionId }, text: 'switch to the dev branch' })
    await tick(w)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0].text).toBe('Helm note (N-4):\nswitch to the dev branch')
    // asUser reaches the engine as the origin's flag: the text is read as the person's own words
    expect(w.submitted[0].origin).toMatchObject({ kind: 'plugin', name: 'helm', asUser: true })
    expect(asEvent('note.result', w).find(e => e.data.noteId === 'N-4')!.data).toEqual({ noteId: 'N-4', ok: true, via: 'prompt' })
  })

  test('a dropped prompt.submit gives note.result ok:false', async ($, on) => {
    const w = await boot($, on)
    w.engine.submitResult = { drop: 'blocked by a hook' }
    w.hub.inbox.push({ id: 'N-5', target: { kind: 'session', id: w.sessionId }, text: 'hello' })
    await tick(w)
    const data = asEvent('note.result', w).find(e => e.data.noteId === 'N-5')!.data
    expect(data.ok).toBe(false)
    expect(data.via).toBeNull()
    expect(data.error).toContain('dropped: blocked by a hook')
  })

  test('a task note for a task the hub does not know gives note.result ok:false', async ($, on) => {
    const w = await boot($, on)
    w.hub.inbox.push({ id: 'N-7', target: { kind: 'task', id: 'T-404' }, text: 'hi' })
    await tick(w)
    const data = asEvent('note.result', w).find(e => e.data.noteId === 'N-7')!.data
    expect(data).toMatchObject({ ok: false, via: null })
    expect(data.error).toContain('404')
    expect(w.sent).toHaveLength(0)
    expect(w.spawned).toHaveLength(0)
  })

  test('an undelivered session.send gives note.result ok:false', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('ag-live-2') as any })
    w.agentList.value = [{ id: 'ag-live-2', status: 'running' }]
    w.engine.sendResult = { isDelivered: false, reason: 'agent is gone' }
    w.hub.inbox.push({ id: 'N-6', target: { kind: 'task', id: 'T-5' }, text: 'hi' })
    await tick(w)
    const data = asEvent('note.result', w).find(e => e.data.noteId === 'N-6')!.data
    expect(data).toMatchObject({ ok: false, via: null })
    expect(data.error).toContain('agent is gone')
  })
})

describe('jobs', () => {
  test('an explain job runs $.model.complete on haiku and emits job.result', async ($, on) => {
    const w = await boot($, on)
    w.hub.jobs.push({ id: 'J-1', kind: 'explain', input: { title: 'Fix login', filesChanged: ['a.ts'] } })
    await tick(w)
    expect(w.modelCalls).toHaveLength(1)
    const call = w.modelCalls[0]
    expect(call.model).toBe('haiku')
    expect(call.system).toContain('patient senior engineer')
    expect(call.prompt).toContain('Fix login')
    const result = asEvent('job.result', w).find(e => e.data.jobId === 'J-1')!
    expect(result.data).toEqual({ jobId: 'J-1', ok: true, text: '## What happened\nIt works.' })
    expect(w.hub.calls.some(c => c.path === `/v1/sessions/${w.sessionId}/jobs`)).toBe(true)
  })

  test('a digest job uses the digest system prompt', async ($, on) => {
    const w = await boot($, on)
    w.hub.jobs.push({ id: 'J-2', kind: 'digest', input: { date: '2026-10-10' } })
    await tick(w)
    expect(w.modelCalls[0].system).toContain('end-of-day digest')
    expect(asEvent('job.result', w).find(e => e.data.jobId === 'J-2')!.data.ok).toBe(true)
  })

  test('an unanswered model call becomes job.result ok:false', async ($, on) => {
    const w = await boot($, on)
    w.engine.modelResult = { isAnswered: false, reason: 'api-error' }
    w.hub.jobs.push({ id: 'J-3', kind: 'explain', input: {} })
    await tick(w)
    const data = asEvent('job.result', w).find(e => e.data.jobId === 'J-3')!.data
    expect(data.ok).toBe(false)
    expect(data.error).toContain('api-error')
  })

  test('an unknown job kind fails without calling the model', async ($, on) => {
    const w = await boot($, on)
    w.hub.jobs.push({ id: 'J-4', kind: 'mystery', input: {} })
    await tick(w)
    expect(w.modelCalls).toHaveLength(0)
    const data = asEvent('job.result', w).find(e => e.data.jobId === 'J-4')!.data
    expect(data.ok).toBe(false)
    expect(data.error).toContain('unknown job kind mystery')
  })
})

describe('outbox delivery', () => {
  test('events reach POST /v1/events in order with strictly increasing seq', async ($, on) => {
    const w = await boot($, on)
    w.engine.toolResult = () => ({ result: 'ok' })
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files', tool_use_id: 'tu-order-1' } as any)
    await $.tool.call({ tool: 'Bash', command: 'pwd', description: 'Print dir', tool_use_id: 'tu-order-2' } as any)
    await tick(w)
    expect(w.hub.eventPosts().length).toBeGreaterThan(0)
    const mine = w.hub.events.filter(e => e.sessionId === w.sessionId)
    const seqs = mine.map(e => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(mine[0]!.type).toBe('session.started')
    expect(mine[0]!.data).toMatchObject({ cwd: '/work/proj', title: 'proj', model: 'opus' })
  })

  test('events queued while the hub is down are delivered once it is back', async ($, on) => {
    const w = await boot($, on)
    w.engine.toolResult = () => ({ result: 'ok' })
    w.hub.state.up = false
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'while down', tool_use_id: 'tu-down' } as any)
    await tick(w)
    expect(asEvent('tool.called', w).filter(e => e.data.toolUseId === 'tu-down')).toHaveLength(0)
    w.hub.state.up = true
    await w.clock.advance(20000)
    await w.clock.settle()
    expect(asEvent('tool.called', w).filter(e => e.data.toolUseId === 'tu-down')).toHaveLength(1)
  })
})

describe('note replies', () => {
  const turn = (extra: Record<string, unknown>) => ({ turnId: 't', durationMs: 5, isAborted: false, answer: '', reason: 'answer', ...extra })
  const replies = (w: World) => asEvent('note.reply', w)
  const taskDetail = (agentId: string) => ({
    'T-5': { task: { id: 'T-5', title: 'Fix login', description: 'brief', recap: null, filesChanged: [] }, agent: { id: agentId } },
  })

  test('a delivered session note is answered by the main turn that carries it, newlines kept', async ($, on) => {
    const w = await boot($, on)
    w.hub.inbox.push({ id: 'N-7', target: { kind: 'session', id: w.sessionId }, text: 'status?' })
    await tick(w)
    expect(w.submitted[0].text).toContain('Helm note (N-7)')
    await $.turn.start({ text: w.submitted[0].text, turnId: 'rt-1' } as any)
    await $.turn.complete(turn({ turnId: 'rt-1', answer: 'Line one\n\nLine two\n- item' }) as any)
    await tick(w)
    expect(replies(w)).toHaveLength(1)
    expect(replies(w)[0]!.data).toEqual({ noteId: 'N-7', text: 'Line one\n\nLine two\n- item' })
  })

  test('two notes in one turn each get the reply, once', async ($, on) => {
    const w = await boot($, on)
    await $.turn.start({ text: 'Helm note (N-20):\nfirst\nHelm note (N-21):\nsecond\nagain Helm note (N-20)', turnId: 'rt-2' } as any)
    await $.turn.complete(turn({ turnId: 'rt-2', answer: 'both done' }) as any)
    await tick(w)
    expect(replies(w).map(e => e.data).sort((a, b) => a.noteId.localeCompare(b.noteId))).toEqual([
      { noteId: 'N-20', text: 'both done' },
      { noteId: 'N-21', text: 'both done' },
    ])
  })

  test('an aborted or errored main turn replies with the reason', async ($, on) => {
    const w = await boot($, on)
    await $.turn.start({ text: 'Helm note (N-30):\nx', turnId: 'rt-3' } as any)
    await $.turn.complete(turn({ turnId: 'rt-3', reason: 'aborted', isAborted: true }) as any)
    await $.turn.start({ text: 'Helm note (N-31):\ny', turnId: 'rt-4' } as any)
    await $.turn.complete(turn({ turnId: 'rt-4', reason: 'error' }) as any)
    await tick(w)
    const byId = (id: string) => replies(w).filter(e => e.data.noteId === id).map(e => e.data.text)
    expect(byId('N-30')).toEqual(['(the turn ended: aborted)'])
    expect(byId('N-31')).toEqual(['(the turn ended: error)'])
  })

  test('an empty answer is replied as a placeholder', async ($, on) => {
    const w = await boot($, on)
    await $.turn.start({ text: 'Helm note (N-32):\nx', turnId: 'rt-5' } as any)
    await $.turn.complete(turn({ turnId: 'rt-5', answer: '   ' }) as any)
    await tick(w)
    expect(replies(w).map(e => e.data)).toEqual([{ noteId: 'N-32', text: '(no answer text)' }])
  })

  test('a task note sent to a live agent is answered by that agent completing, exactly once', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('ag-rep-live') as any })
    w.agentList.value = [{ id: 'ag-rep-live', status: 'running' }]
    w.hub.inbox.push({ id: 'N-40', target: { kind: 'task', id: 'T-5' }, text: 'also add a test' })
    await tick(w)
    expect(w.sent).toHaveLength(1)
    expect(replies(w)).toHaveLength(0)
    await $.turn.complete(turn({ agentId: 'ag-rep-live', answer: 'DONE: added\nFILES: a.ts' }) as any)
    await $.turn.complete(turn({ agentId: 'ag-rep-live', answer: 'DONE: added\nFILES: a.ts' }) as any)
    await tick(w)
    expect(replies(w)).toHaveLength(1)
    expect(replies(w)[0]!.data).toEqual({ noteId: 'N-40', text: 'DONE: added\nFILES: a.ts' })
  })

  test('a follow-up spawn cannot be answered: the kit floor returns no agentId from a plugin\'s $.agent.spawn', async ($, on) => {
    // Even when the engine floor answers { agentId }, $.agent.spawn hands the plugin only { model, ... } (the agentId is
    // dropped), so register.ts\'s `if (r?.agentId) awaitAgentReply(...)` never fires and a follow-up spawn gets no reply.
    const w = await boot($, on, { taskDetail: taskDetail('ag-rep-old') as any })
    w.agentList.value = [{ id: 'ag-rep-old', status: 'completed' }]
    w.engine.spawnResult = { model: 'sonnet', agentId: 'ag-rep-new' }
    w.hub.inbox.push({ id: 'N-50', target: { kind: 'task', id: 'T-5' }, text: 'and logout' })
    await tick(w)
    expect(w.spawned).toHaveLength(1)
    const result = asEvent('note.result', w).find(e => e.data.noteId === 'N-50')!.data
    expect(result).toMatchObject({ ok: true, via: 'followup_spawn' })
    expect(result.agentId).toBeUndefined()
    await $.turn.complete(turn({ agentId: 'ag-rep-new', answer: 'DONE: logout' }) as any)
    await tick(w)
    expect(replies(w)).toHaveLength(0)
  })

  test('a turn with no Helm note emits no note.reply', async ($, on) => {
    const w = await boot($, on)
    await $.turn.start({ text: 'just a normal prompt', turnId: 'rt-6' } as any)
    await $.turn.complete(turn({ turnId: 'rt-6', answer: 'hi' }) as any)
    await $.turn.complete(turn({ agentId: 'ag-rep-plain', answer: 'DONE' }) as any)
    await tick(w)
    expect(replies(w)).toHaveLength(0)
  })

  test('reply maps are saved under replies:<sessionId> by the 2 s timer', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('ag-rep-save') as any })
    w.agentList.value = [{ id: 'ag-rep-save', status: 'running' }]
    w.hub.inbox.push({ id: 'N-60', target: { kind: 'task', id: 'T-5' }, text: 'hi' })
    await tick(w)
    await $.turn.start({ text: 'Helm note (N-61):\nx', turnId: 'rt-save' } as any)
    expect(w.storeSets.filter(s => s.key === `replies:${w.sessionId}`)).toHaveLength(0)
    await w.clock.advance(2100)
    await w.clock.settle()
    const saved = w.storeSets.filter(s => s.key === `replies:${w.sessionId}`).at(-1)!.value
    expect(saved.turns).toContainEqual(['rt-save', ['N-61']])
    expect(saved.agents).toContainEqual(['ag-rep-save', ['N-60']])
  })

  test('saved reply maps are restored on session.start, so a reload still answers the note', async ($, on) => {
    const w = await boot($, on, { start: false })
    w.storeSeed[`replies:${w.sessionId}`] = { turns: [['rt-restored', ['N-70']]], agents: [['ag-restored', ['N-71']]] }
    await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: true })
    await w.clock.settle()
    await $.turn.complete(turn({ turnId: 'rt-restored', answer: 'back again' }) as any)
    await $.turn.complete(turn({ agentId: 'ag-restored', answer: 'agent back' }) as any)
    await tick(w)
    expect(replies(w).map(e => e.data).sort((x, y) => x.noteId.localeCompare(y.noteId))).toEqual([
      { noteId: 'N-70', text: 'back again' },
      { noteId: 'N-71', text: 'agent back' },
    ])
  })
})

describe('v0.4: cheap answers', () => {
  const taskDetail = (agentId: string | null) => ({
    'T-5': {
      task: { id: 'T-5', title: 'Fix login', description: 'the original brief', recap: null, filesChanged: ['a.ts', 'b.ts'] },
      agent: agentId ? { id: agentId } : null,
    },
  })
  const noteResult = (w: World, id: string) => asEvent('note.result', w).find(e => e.data.noteId === id)!.data
  const taskNote = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, target: { kind: 'task', id: 'T-5' }, text, ...extra })

  test('a question on a task is answered by one haiku call over the task record, with no agent woken', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('ag-ans-1') as any })
    w.agentList.value = [{ id: 'ag-ans-1', status: 'running' }]
    w.engine.modelResult = { isAnswered: true, text: '  It touched a.ts and b.ts.  ', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 } }
    w.hub.inbox.push(taskNote('N-60', 'what files did this touch?'))
    await tick(w)
    expect(w.modelCalls).toHaveLength(1)
    expect(w.modelCalls[0].model).toBe('haiku')
    expect(w.modelCalls[0].system).toContain("Answer the user's question about this task")
    expect(w.modelCalls[0].prompt).toContain('Task record:')
    expect(w.modelCalls[0].prompt).toContain('Fix login')
    expect(w.modelCalls[0].prompt).toContain('a.ts')
    expect(w.modelCalls[0].prompt).toContain('what files did this touch?')
    expect(noteResult(w, 'N-60')).toEqual({ noteId: 'N-60', ok: true, via: 'answer' })
    expect(asEvent('note.reply', w).filter(e => e.data.noteId === 'N-60').map(e => e.data)).toEqual([{ noteId: 'N-60', text: 'It touched a.ts and b.ts.' }])
    const usage = asEvent('helm.usage', w).filter(e => e.data.kind === 'answer')
    expect(usage).toHaveLength(1)
    // haiku: (1000 * 0.10 + 200 * 0.50 + 5000 * 0.01) / 1e6
    expect(usage[0]!.data).toEqual({ kind: 'answer', model: 'haiku', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, costUsd: 0.00025, taskId: 'T-5', noteId: 'N-60' })
    expect(w.sent).toHaveLength(0)
    expect(w.spawned).toHaveLength(0)
  })

  test('a leading ! sends the note to the live agent with the ! stripped', async ($, on) => {
    const live = await boot($, on, { taskDetail: taskDetail('ag-ans-2') as any })
    live.agentList.value = [{ id: 'ag-ans-2', status: 'running' }]
    live.hub.inbox.push(taskNote('N-61', '!what files did this touch?'))
    await tick(live)
    expect(live.modelCalls).toHaveLength(0)
    expect(live.sent).toHaveLength(1)
    expect(live.sent[0].text).toContain('what files did this touch?')
    expect(live.sent[0].text).not.toContain('!what')
    expect(noteResult(live, 'N-61')).toMatchObject({ ok: true, via: 'send_message' })
  })

  test('a leading ! on a task whose agent has finished spawns a follow-up with the ! stripped', async ($, on) => {
    const gone = await boot($, on, { taskDetail: taskDetail('ag-ans-3') as any })
    gone.agentList.value = [{ id: 'ag-ans-3', status: 'completed' }]
    gone.hub.inbox.push(taskNote('N-62', '  ! what files did this touch?'))
    await tick(gone)
    expect(gone.modelCalls).toHaveLength(0)
    expect(gone.spawned).toHaveLength(1)
    expect(gone.spawned[0].prompt).toContain('The user\'s new instruction:\nwhat files did this touch?')
    expect(gone.spawned[0].prompt).not.toContain('!')
    expect(noteResult(gone, 'N-62')).toMatchObject({ ok: true, via: 'followup_spawn' })
  })

  test('a question with attachments skips the cheap path and the delivered text lists the files', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('ag-ans-4') as any })
    w.agentList.value = [{ id: 'ag-ans-4', status: 'running' }]
    w.hub.inbox.push(taskNote('N-63', 'why does this look wrong?', { attachments: [{ id: 'A-1', name: 'shot.png', path: '/h/attachments/A-1/shot.png' }, { id: 'A-2', name: 'log.txt', path: '/h/attachments/A-2/log.txt' }] }))
    await tick(w)
    expect(w.modelCalls).toHaveLength(0)
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0].text).toContain('why does this look wrong?')
    expect(w.sent[0].text).toContain('\n\nAttached files (open them with the Read tool):\n- /h/attachments/A-1/shot.png\n- /h/attachments/A-2/log.txt')
    expect(w.sent[0].text.endsWith('- /h/attachments/A-2/log.txt')).toBe(true)
    expect(noteResult(w, 'N-63')).toMatchObject({ ok: true, via: 'send_message' })
  })

  test('a follow-up spawn for a note with attachments carries the paths in the prompt', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('ag-ans-5') as any })
    w.agentList.value = [{ id: 'ag-ans-5', status: 'completed' }]
    w.hub.inbox.push(taskNote('N-64', 'is this the bug?', { attachments: [{ id: 'A-3', name: 'a.png', path: '/h/attachments/A-3/a.png' }] }))
    await tick(w)
    expect(w.modelCalls).toHaveLength(0)
    expect(w.spawned[0].prompt).toContain('Attached files (open them with the Read tool):\n- /h/attachments/A-3/a.png')
  })

  test('a session note with attachments gets the same suffix through prompt.submit', async ($, on) => {
    const w = await boot($, on)
    w.hub.inbox.push({ id: 'N-65', target: { kind: 'session', id: w.sessionId }, text: 'look at this', attachments: [{ id: 'A-4', name: 'x.png', path: '/h/attachments/A-4/x.png' }] })
    await tick(w)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0].text).toBe('Helm note (N-65):\nlook at this\n\nAttached files (open them with the Read tool):\n- /h/attachments/A-4/x.png')
  })

  test('a note with an empty attachments array gets no suffix', async ($, on) => {
    const w = await boot($, on)
    w.hub.inbox.push({ id: 'N-66', target: { kind: 'session', id: w.sessionId }, text: 'plain', attachments: [] })
    await tick(w)
    expect(w.submitted[0].text).toBe('Helm note (N-66):\nplain')
  })

  test('a non-question instruction goes to the agent path', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('ag-ans-6') as any })
    w.agentList.value = [{ id: 'ag-ans-6', status: 'running' }]
    w.hub.inbox.push(taskNote('N-67', 'rename the button'))
    await tick(w)
    expect(w.modelCalls).toHaveLength(0)
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0].text).toContain('rename the button')
    expect(noteResult(w, 'N-67')).toMatchObject({ ok: true, via: 'send_message' })
    expect(asEvent('helm.usage', w)).toHaveLength(0)
  })

  test('question detection: a leading interrogative or trailing ? counts, other words do not', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('ag-ans-7') as any })
    w.agentList.value = [{ id: 'ag-ans-7', status: 'running' }]
    w.hub.inbox.push(taskNote('N-68', 'Does it handle null'), taskNote('N-69', 'rename it?'), taskNote('N-70', 'however, rename it'), taskNote('N-71', 'issue: fix it'))
    await tick(w)
    const answered = asEvent('note.result', w).filter(e => e.data.via === 'answer').map(e => e.data.noteId).sort()
    expect(answered).toEqual(['N-68', 'N-69'])
    const sent = w.sent.map(s => s.text).join('\n')
    expect(sent).toContain('however, rename it')
    expect(sent).toContain('issue: fix it')
  })

  test('an unanswered cheap-path model call fails the note and sends no reply', async ($, on) => {
    const w = await boot($, on, { taskDetail: taskDetail('ag-ans-8') as any })
    w.engine.modelResult = { isAnswered: false, reason: 'api-error' }
    w.hub.inbox.push(taskNote('N-72', 'what is the status?'))
    await tick(w)
    expect(noteResult(w, 'N-72')).toMatchObject({ ok: false, via: null })
    expect(noteResult(w, 'N-72').error).toContain('api-error')
    expect(asEvent('note.reply', w)).toHaveLength(0)
    expect(w.sent).toHaveLength(0)
    expect(w.spawned).toHaveLength(0)
  })
})

describe('v0.4: free recaps', () => {
  const turn = (extra: Record<string, unknown>) => ({ turnId: 't', durationMs: 5, isAborted: false, answer: '', reason: 'answer', ...extra })
  const agentsOpt = (id: string, taskId: string) => [{ id, taskId, description: 'Write tests' }]
  // with no tool trail in memory the mod rebuilds one from GET /v1/tasks/:id
  const detail = (taskId: string) => ({ [taskId]: { task: { id: taskId }, agent: null } }) as any

  test('a report with DONE/HOW/LEARNED/TAGS gives recap.generated without any model call', async ($, on) => {
    const w = await boot($, on, { agents: agentsOpt('ag-rc-1', 'T-21') })
    const answer = 'DONE: tests now cover the meter\nHOW: fake hub plus the mock clock\nFILES: hooks/register.test.ts\nLEARNED: a fake at the boundary keeps tests fast\nTAGS: Testing, Mocks, extra, ignored'
    await $.turn.complete(turn({ agentId: 'ag-rc-1', answer }) as any)
    await tick(w)
    await tick(w)
    expect(w.modelCalls).toHaveLength(0)
    const rec = asEvent('recap.generated', w).filter(e => e.data.taskId === 'T-21')
    expect(rec).toHaveLength(1)
    expect(rec[0]!.data).toEqual({
      taskId: 'T-21',
      what: 'tests now cover the meter',
      how: 'fake hub plus the mock clock',
      learned: 'a fake at the boundary keeps tests fast',
      concepts: ['testing', 'mocks', 'extra'],
    })
    expect(asEvent('helm.usage', w).filter(e => e.data.taskId === 'T-21')).toHaveLength(0)
  })

  test('markdown-bold labels are read, and a missing TAGS line gives no concepts', async ($, on) => {
    const w = await boot($, on, { agents: agentsOpt('ag-rc-2', 'T-22') })
    await $.turn.complete(turn({ agentId: 'ag-rc-2', answer: '**DONE:** shipped it\n**LEARNED:** caching helps' }) as any)
    await tick(w)
    await tick(w)
    expect(w.modelCalls).toHaveLength(0)
    expect(asEvent('recap.generated', w).find(e => e.data.taskId === 'T-22')!.data).toEqual({ taskId: 'T-22', what: 'shipped it', how: '', learned: 'caching helps', concepts: [] })
  })

  test('without the report lines the haiku recap runs and is metered as kind recap', async ($, on) => {
    const w = await boot($, on, { agents: agentsOpt('ag-rc-3', 'T-23'), taskDetail: detail('T-23') })
    w.engine.modelResult = {
      isAnswered: true,
      text: 'sure {"what":"Added tests","how":"Fake hub","learned":"Fakes beat mocks","concepts":["Testing","mocks"]}',
      usage: { input_tokens: 2000, output_tokens: 100 },
    }
    await $.turn.complete(turn({ agentId: 'ag-rc-3', answer: 'I finished the work, no report format used.' }) as any)
    await tick(w)
    await tick(w)
    expect(w.modelCalls).toHaveLength(1)
    expect(w.modelCalls[0].model).toBe('haiku')
    expect(asEvent('recap.generated', w).find(e => e.data.taskId === 'T-23')!.data).toEqual({ taskId: 'T-23', what: 'Added tests', how: 'Fake hub', learned: 'Fakes beat mocks', concepts: ['testing', 'mocks'] })
    const usage = asEvent('helm.usage', w).filter(e => e.data.kind === 'recap')
    expect(usage).toHaveLength(1)
    // haiku: (2000 * 0.10 + 100 * 0.50) / 1e6
    expect(usage[0]!.data).toMatchObject({ kind: 'recap', model: 'haiku', inputTokens: 2000, outputTokens: 100, costUsd: 0.00025, taskId: 'T-23' })
  })

  test('DONE without LEARNED is not a free recap', async ($, on) => {
    const w = await boot($, on, { agents: agentsOpt('ag-rc-4', 'T-24'), taskDetail: detail('T-24') })
    w.engine.modelResult = { isAnswered: true, text: '{"what":"w","how":"h","learned":"l","concepts":[]}', usage: { input_tokens: 10, output_tokens: 10 } }
    await $.turn.complete(turn({ agentId: 'ag-rc-4', answer: 'DONE: only this line' }) as any)
    await tick(w)
    await tick(w)
    expect(w.modelCalls).toHaveLength(1)
  })
})

describe('v0.4: usage meter', () => {
  const turn = (extra: Record<string, unknown>) => ({ turnId: 't', durationMs: 5, isAborted: false, answer: '', reason: 'answer', ...extra })
  const MTOK = 1_000_000

  test('an explain job emits helm.usage with kind explain', async ($, on) => {
    const w = await boot($, on)
    w.engine.modelResult = { isAnswered: true, text: 'ok', usage: { input_tokens: 4000, output_tokens: 800 } }
    w.hub.jobs.push({ id: 'J-10', kind: 'explain', taskId: 'T-5', input: { title: 'Fix login' } })
    await tick(w)
    const usage = asEvent('helm.usage', w).filter(e => e.data.kind === 'explain')
    expect(usage).toHaveLength(1)
    // haiku: (4000 * 0.10 + 800 * 0.50) / 1e6 = 0.0008
    expect(usage[0]!.data).toMatchObject({ kind: 'explain', model: 'haiku', inputTokens: 4000, outputTokens: 800, costUsd: 0.0008, taskId: 'T-5' })
  })

  test('a digest job is metered as digest, and an unanswered call is still metered', async ($, on) => {
    const w = await boot($, on)
    w.engine.modelResult = { isAnswered: false, reason: 'api-error', usage: { input_tokens: 100, output_tokens: 0 } }
    w.hub.jobs.push({ id: 'J-11', kind: 'digest', input: {} })
    await tick(w)
    expect(asEvent('helm.usage', w).map(e => e.data.kind)).toContain('digest')
    expect(asEvent('job.result', w).find(e => e.data.jobId === 'J-11')!.data.ok).toBe(false)
  })

  test('a model call that reports no usage emits no helm.usage', async ($, on) => {
    const w = await boot($, on)
    w.engine.modelResult = { isAnswered: true, text: 'ok' }
    w.hub.jobs.push({ id: 'J-12', kind: 'explain', input: {} })
    await tick(w)
    expect(asEvent('job.result', w).find(e => e.data.jobId === 'J-12')!.data.ok).toBe(true)
    expect(asEvent('helm.usage', w)).toHaveLength(0)
  })

  test('a main turn started by a Helm note emits note_turn with the turn model; one without a note emits none', async ($, on) => {
    const w = await boot($, on)
    await $.turn.start({ text: 'Helm note (N-80):\nrename it', turnId: 'rt-u1' } as any)
    await $.turn.complete(turn({ turnId: 'rt-u1', answer: 'done', usage: { model: 'claude-sonnet-5-5', input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 50_000 } }) as any)
    await $.turn.start({ text: 'just a normal prompt', turnId: 'rt-u2' } as any)
    await $.turn.complete(turn({ turnId: 'rt-u2', answer: 'ok', usage: { model: 'claude-opus-5-5', input_tokens: 10_000, output_tokens: 2_000 } }) as any)
    await tick(w)
    const usage = asEvent('helm.usage', w).filter(e => e.data.kind === 'note_turn')
    expect(usage).toHaveLength(1)
    // sonnet: (10000 * 2 + 2000 * 10 + 50000 * 0.20) / 1e6 = 0.05
    expect(usage[0]!.data).toEqual({ kind: 'note_turn', model: 'claude-sonnet-5-5', inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 50_000, costUsd: 0.05, noteId: 'N-80' })
  })

  test('a note turn with no usage still replies but emits no helm.usage; no model defaults to opus pricing', async ($, on) => {
    const w = await boot($, on)
    await $.turn.start({ text: 'Helm note (N-81):\nx', turnId: 'rt-u3' } as any)
    await $.turn.complete(turn({ turnId: 'rt-u3', answer: 'fine' }) as any)
    await $.turn.start({ text: 'Helm note (N-82):\ny', turnId: 'rt-u4' } as any)
    await $.turn.complete(turn({ turnId: 'rt-u4', answer: 'fine', usage: { input_tokens: MTOK, output_tokens: 0 } }) as any)
    await tick(w)
    expect(asEvent('note.reply', w).filter(e => ['N-81', 'N-82'].includes(e.data.noteId))).toHaveLength(2)
    const usage = asEvent('helm.usage', w).filter(e => e.data.kind === 'note_turn')
    expect(usage.map(e => e.data.noteId)).toEqual(['N-82'])
    expect(usage[0]!.data).toMatchObject({ model: 'opus', costUsd: 4 })
  })

  test('costOf: opus is $4 in / $20 out / $0.20 cache read per MTok', async ($, on) => {
    const w = await boot($, on)
    const run = async (id: string, usage: Record<string, number>) => {
      await $.turn.start({ text: `Helm note (${id}):\nx`, turnId: `rt-${id}` } as any)
      await $.turn.complete(turn({ turnId: `rt-${id}`, answer: 'a', usage: { model: 'claude-opus-5-5', ...usage } }) as any)
    }
    await run('N-90', { input_tokens: MTOK })
    await run('N-91', { output_tokens: MTOK })
    await run('N-92', { cache_read_input_tokens: MTOK })
    await run('N-93', { cache_creation_input_tokens: MTOK })
    await tick(w)
    const cost = (id: string) => asEvent('helm.usage', w).find(e => e.data.noteId === id)!.data
    expect(cost('N-90').costUsd).toBe(4)
    expect(cost('N-91').costUsd).toBe(20)
    expect(cost('N-92').costUsd).toBe(0.2)
    // cache writes are counted as input tokens and billed at 1.25× the input rate
    expect(cost('N-93')).toMatchObject({ costUsd: 5, inputTokens: MTOK })
    expect(cost('N-92')).toMatchObject({ inputTokens: 0, cacheReadTokens: MTOK })
  })

  test('costOf: an unknown model name prices as opus (never under-counts)', async ($, on) => {
    const w = await boot($, on)
    await $.turn.start({ text: 'Helm note (N-94):\nx', turnId: 'rt-N-94' } as any)
    await $.turn.complete(turn({ turnId: 'rt-N-94', answer: 'a', usage: { model: 'claude-future-9', input_tokens: MTOK } }) as any)
    await tick(w)
    expect(asEvent('helm.usage', w).find(e => e.data.noteId === 'N-94')!.data.costUsd).toBe(4)
  })

  test('costOf: sonnet 2/10/0.20 and haiku 0.10/0.50/0.01 per MTok', async ($, on) => {
    const w = await boot($, on)
    const run = async (id: string, model: string, usage: Record<string, number>) => {
      await $.turn.start({ text: `Helm note (${id}):\nx`, turnId: `rt-${id}` } as any)
      await $.turn.complete(turn({ turnId: `rt-${id}`, answer: 'a', usage: { model, ...usage } }) as any)
    }
    await run('N-94', 'claude-sonnet-5-5', { input_tokens: MTOK, output_tokens: MTOK, cache_read_input_tokens: MTOK })
    await run('N-95', 'claude-haiku-5-5', { input_tokens: MTOK, output_tokens: MTOK, cache_read_input_tokens: MTOK })
    await run('N-96', 'haiku', { cache_read_input_tokens: MTOK })
    await tick(w)
    const cost = (id: string) => asEvent('helm.usage', w).find(e => e.data.noteId === id)!.data.costUsd
    expect(cost('N-94')).toBe(12.2)
    expect(cost('N-95')).toBe(0.61)
    expect(cost('N-96')).toBe(0.01)
  })
})

describe('v0.9: workflow step runner', () => {
  const MTOK = 1_000_000
  const turn = (extra: Record<string, unknown>) => ({ turnId: 't', durationMs: 5, isAborted: false, answer: '', reason: 'answer', ...extra })
  const results = (w: World, stepId?: string) => asEvent('wf.step.result', w).filter(e => !stepId || e.data.stepId === stepId)
  const stepsCalls = (w: World) => w.hub.calls.filter(c => c.path === `/v1/sessions/${w.sessionId}/steps`)
  const base = { runId: 'R-1', nodeId: 'n', attempt: 1, label: 'step' }
  // A plugin's own $.agent.spawn does not pass through the mod's agent.spawn hook in the kit (and returns no agentId), so
  // the tagged spawn the engine then raises for the same agent is simulated by a call from the test, which does.
  const engineSpawn = ($: any, w: World, agentId: string, description: string) => {
    w.engine.spawnResult = { agentId, model: 'sonnet' }
    return $.agent.spawn({ tool_use_id: `tu-${agentId}`, prompt: 'p', description, subagentType: 'helm:builder', provider: { plugin: 'x', tier: 'user' }, parentModel: 'opus', background: true, fork: false } as any)
  }

  test('an agent step spawns with prompt/description/subagentType/model and reports once when the agent completes', async ($, on) => {
    const w = await boot($, on)
    w.hub.steps.push({ id: 'R-1:build:1', kind: 'agent', input: { ...base, prompt: 'build it', description: '[helm:T-9] Build', subagentType: 'helm:builder', model: 'sonnet', taskId: 'T-9' } })
    await tick(w)
    const sp = w.spawned.at(-1)
    expect(sp).toMatchObject({ prompt: 'build it', description: '[helm:T-9] Build', subagent_type: 'helm:builder', model: 'sonnet' })
    expect(results(w)).toHaveLength(0) // nothing is reported until the agent finishes
    await engineSpawn($, w, 'ag-step-1', '[helm:T-9] Build')
    const answer = 'DONE: built\nHOW: x\nFILES: /r/a.ts, `/r/b.ts`\nLEARNED: y'
    await $.turn.complete(turn({ agentId: 'ag-step-1', answer, usage: { model: 'claude-sonnet-5-5', input_tokens: MTOK, output_tokens: MTOK } }) as any)
    await tick(w)
    const r = results(w, 'R-1:build:1')
    expect(r).toHaveLength(1)
    expect(r[0]!.data).toMatchObject({ stepId: 'R-1:build:1', ok: true, agentId: 'ag-step-1', text: answer, filesChanged: ['/r/a.ts', '/r/b.ts'] })
    // sonnet: 1M input * $2 + 1M output * $10
    expect(r[0]!.data.usage).toMatchObject({ model: 'claude-sonnet-5-5', inputTokens: MTOK, outputTokens: MTOK, costUsd: 12 })
  })

  test('the agent.spawn hook binds the agent to the step through the [helm:T-n] tag (stepByTask → stepByAgent)', async ($, on) => {
    const w = await boot($, on)
    // the step run itself gets no agentId back, as with a plugin spawn in the kit ...
    w.engine.spawnResult = undefined
    w.hub.steps.push({ id: 'R-1:tag:1', kind: 'agent', input: { ...base, prompt: 'p', description: '[helm:T-71] Tagged', taskId: 'T-71' } })
    await tick(w)
    await $.turn.complete(turn({ agentId: 'ag-tag-0', answer: 'DONE: x' }) as any)
    await tick(w)
    expect(results(w, 'R-1:tag:1')).toHaveLength(0)
    // ... later the engine's spawn for the tagged description carries the id, and the hook binds it
    await engineSpawn($, w, 'ag-tag-1', '[helm:T-71] Tagged')
    await $.turn.complete(turn({ agentId: 'ag-tag-1', answer: 'DONE: ok\nFILES: none', usage: { input_tokens: 10, output_tokens: 10 } }) as any)
    await tick(w)
    const r = results(w, 'R-1:tag:1')
    expect(r).toHaveLength(1)
    expect(r[0]!.data).toMatchObject({ ok: true, agentId: 'ag-tag-1', filesChanged: [] })
  })

  test('a failed agent (reason is not answer) reports ok:false with the reason', async ($, on) => {
    const w = await boot($, on)
    w.hub.steps.push({ id: 'R-1:fail:1', kind: 'agent', input: { ...base, prompt: 'p', description: '[helm:T-72] F', taskId: 'T-72' } })
    await tick(w)
    await engineSpawn($, w, 'ag-step-f', '[helm:T-72] F')
    await $.turn.complete(turn({ agentId: 'ag-step-f', reason: 'max_turns', answer: '' }) as any)
    await tick(w)
    const d = results(w, 'R-1:fail:1')[0]!.data
    expect(d.ok).toBe(false)
    expect(d.error).toContain('ended: max_turns')
  })

  test('a second completion for the same agent does not emit a second result', async ($, on) => {
    const w = await boot($, on)
    w.hub.steps.push({ id: 'R-1:idem:1', kind: 'agent', input: { ...base, prompt: 'p', description: '[helm:T-73] I', taskId: 'T-73' } })
    await tick(w)
    await engineSpawn($, w, 'ag-step-2', '[helm:T-73] I')
    await $.turn.complete(turn({ agentId: 'ag-step-2', answer: 'DONE: a' }) as any)
    await $.turn.complete(turn({ agentId: 'ag-step-2', answer: 'DONE: again' }) as any)
    await tick(w)
    await tick(w)
    expect(results(w, 'R-1:idem:1')).toHaveLength(1)
  })

  test('a shell step runs process.run with argv, cwd and timeoutMs and reports the raw check', async ($, on) => {
    const w = await boot($, on)
    w.engine.processRun = () => ({ exitCode: 0, stdout: 'all green', stderr: 'warn', isStdoutTruncated: false, isStderrTruncated: false })
    w.hub.steps.push({ id: 'R-1:sh:1', kind: 'shell', input: { ...base, argv: ['npm', 'test'], cwd: '/work/proj', timeoutMs: 5000 } })
    await tick(w)
    const call = w.processCalls.find(c => JSON.stringify(c).includes('"npm"'))
    expect(JSON.stringify(call)).toContain('"npm","test"')
    expect(JSON.stringify(call)).toContain('"cwd":"/work/proj"')
    expect(JSON.stringify(call)).toContain('"timeoutMs":5000')
    const d = results(w, 'R-1:sh:1')[0]!.data
    expect(d).toMatchObject({ ok: true, check: { exitCode: 0, stdout: 'all green', stderr: 'warn' } })
  })

  test('a shell script runs as sh -c; a non-zero exit is still ok:true (the hub decides pass/fail)', async ($, on) => {
    const w = await boot($, on)
    w.engine.processRun = () => ({ exitCode: 3, stdout: '', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false })
    w.hub.steps.push({ id: 'R-1:sh:2', kind: 'shell', input: { ...base, script: 'exit 3', timeoutMs: 1000 } })
    await tick(w)
    expect(JSON.stringify(w.processCalls.find(c => JSON.stringify(c).includes('exit 3')))).toContain('"sh","-c","exit 3"')
    const d = results(w, 'R-1:sh:2')[0]!.data
    expect(d.ok).toBe(true)
    expect(d.check).toMatchObject({ exitCode: 3, stderr: 'boom' })
    expect(d.text).toBe('boom')
  })

  test('a process.run rejection: timeout-like errors give exitCode 124 + timedOut, others exitCode 1', async ($, on) => {
    const w = await boot($, on)
    let msg = 'command timed out after 1000ms'
    w.engine.processRun = (e: any) => {
      if (JSON.stringify(e).includes('sleep 99') || JSON.stringify(e).includes('crash')) return { deny: msg }
      return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    }
    w.hub.steps.push({ id: 'R-1:sh:3', kind: 'shell', input: { ...base, script: 'sleep 99', timeoutMs: 1000 } })
    await tick(w)
    let d = results(w, 'R-1:sh:3')[0]!.data
    expect(d.ok).toBe(true)
    expect(d.check).toMatchObject({ exitCode: 124, timedOut: true, stdout: '' })
    expect(d.check.stderr).toContain('timed out')
    msg = 'spawn ENOENT'
    w.hub.steps.push({ id: 'R-1:sh:4', kind: 'shell', input: { ...base, script: 'crash', timeoutMs: 1000 } })
    await tick(w)
    d = results(w, 'R-1:sh:4')[0]!.data
    expect(d.check).toMatchObject({ exitCode: 1, timedOut: false })
  })

  test('a review step calls model.complete on opus and reports verdict pass, priced as opus', async ($, on) => {
    const w = await boot($, on)
    w.engine.modelResult = { isAnswered: true, text: '- fine\nVERDICT: PASS', usage: { input_tokens: MTOK, output_tokens: MTOK } }
    w.hub.steps.push({ id: 'R-1:rv:1', kind: 'review', input: { ...base, model: 'opus', system: 'be strict', prompt: 'the work', maxTokens: 4096, timeoutMs: 90000 } })
    await tick(w)
    expect(w.modelCalls.at(-1)).toMatchObject({ model: 'opus', system: 'be strict', prompt: 'the work', maxTokens: 4096, timeoutMs: 90000 })
    const d = results(w, 'R-1:rv:1')[0]!.data
    expect(d).toMatchObject({ ok: true, verdict: 'pass', text: '- fine\nVERDICT: PASS' })
    // opus: 1M * $4 + 1M * $20
    expect(d.usage).toMatchObject({ model: 'opus', costUsd: 24 })
  })

  test('the last VERDICT: line decides; anything but PASS is changes', async ($, on) => {
    const w = await boot($, on)
    const verdictFor = async (id: string, text: string) => {
      w.engine.modelResult = { isAnswered: true, text, usage: {} }
      w.hub.steps.push({ id, kind: 'review', input: { ...base, system: 's', prompt: 'p' } })
      await tick(w)
      return results(w, id)[0]!.data.verdict
    }
    expect(await verdictFor('R-1:rv:2', 'VERDICT: PASS\nactually no\nVERDICT: CHANGES')).toBe('changes')
    expect(await verdictFor('R-1:rv:3', 'VERDICT: CHANGES\nfixed\nVERDICT: PASS')).toBe('pass')
    expect(await verdictFor('R-1:rv:4', 'no verdict line at all')).toBe('changes')
  })

  test('an unanswered review model call gives ok:false with the reason', async ($, on) => {
    const w = await boot($, on)
    w.engine.modelResult = { isAnswered: false, reason: 'api-error' }
    w.hub.steps.push({ id: 'R-1:rv:5', kind: 'review', input: { ...base, system: 's', prompt: 'p' } })
    await tick(w)
    const d = results(w, 'R-1:rv:5')[0]!.data
    expect(d.ok).toBe(false)
    expect(d.error).toContain('api-error')
  })

  test('an unknown step kind gives ok:false', async ($, on) => {
    const w = await boot($, on)
    w.hub.steps.push({ id: 'R-1:x:1', kind: 'mystery', input: base })
    await tick(w)
    const d = results(w, 'R-1:x:1')[0]!.data
    expect(d.ok).toBe(false)
    expect(d.error).toContain('unknown step kind mystery')
  })

  test('a 404 from /steps stops polling for 60 s of ticks, while the other polls carry on', async ($, on) => {
    const w = await boot($, on)
    w.hub.state.stepsStatus = 404
    await tick(w)
    const n = stepsCalls(w).length
    expect(n).toBeGreaterThan(0)
    const jobsBefore = w.hub.calls.filter(c => c.path === `/v1/sessions/${w.sessionId}/jobs`).length
    // 40 ticks = 60 s on the mocked clock: not one more request to /steps ...
    for (let i = 0; i < 40; i++) await tick(w)
    expect(stepsCalls(w)).toHaveLength(n)
    // ... and a step the hub would hand out is not claimed, while jobs are still polled
    expect(w.hub.calls.filter(c => c.path === `/v1/sessions/${w.sessionId}/jobs`).length).toBeGreaterThan(jobsBefore + 30)
    // (the 60 s expiry itself is not tested: the mod reads Date.now(), which mock.clock does not move)
  })

  test('resume: a review step left in inflight-steps is re-run on session.start, and cleared', async ($, on) => {
    const w = await boot($, on, { start: false })
    w.storeSeed[`inflight-steps:${w.sessionId}`] = [{ id: 'R-1:re:1', kind: 'review', input: { ...base, system: 's', prompt: 'redo me' } }]
    await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: true })
    await w.clock.settle()
    await tick(w)
    expect(w.modelCalls.some(c => c.prompt === 'redo me')).toBe(true)
    expect(results(w, 'R-1:re:1')[0]!.data).toMatchObject({ ok: true, verdict: 'changes' })
    expect(w.storeSeed[`inflight-steps:${w.sessionId}`]).toEqual([])
  })

  test('resume: a shell step left in inflight-steps is re-run on session.start, and cleared', async ($, on) => {
    const w = await boot($, on, { start: false })
    w.storeSeed[`inflight-steps:${w.sessionId}`] = [{ id: 'R-1:re:2', kind: 'shell', input: { ...base, argv: ['true'], timeoutMs: 1000 } }]
    await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: true })
    await w.clock.settle()
    await tick(w)
    expect(w.processCalls.some(c => JSON.stringify(c).includes('"true"'))).toBe(true)
    expect(results(w, 'R-1:re:2')[0]!.data).toMatchObject({ ok: true, check: { exitCode: 0 } })
    expect(w.storeSeed[`inflight-steps:${w.sessionId}`]).toEqual([])
  })

  test('resume: an inflight-jobs job is re-run on session.start', async ($, on) => {
    const w = await boot($, on, { start: false })
    w.storeSeed[`inflight-jobs:${w.sessionId}`] = [{ id: 'J-90', kind: 'explain', input: { title: 'Resumed' } }]
    await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: true })
    await w.clock.settle()
    await tick(w)
    expect(w.modelCalls.some(c => String(c.prompt).includes('Resumed'))).toBe(true)
    expect(asEvent('job.result', w).find(e => e.data.jobId === 'J-90')!.data.ok).toBe(true)
    expect(w.storeSeed[`inflight-jobs:${w.sessionId}`]).toEqual([])
  })

  test('review and shell steps are tracked in inflight-steps while running; agent steps are not', async ($, on) => {
    const w = await boot($, on)
    w.engine.spawnResult = { agentId: 'ag-step-3', model: 'sonnet' }
    w.hub.steps.push({ id: 'R-1:tr:1', kind: 'review', input: { ...base, system: 's', prompt: 'p' } })
    w.hub.steps.push({ id: 'R-1:tr:2', kind: 'agent', input: { ...base, prompt: 'p', description: '[helm:T-74] A', taskId: 'T-74' } })
    await tick(w)
    const key = `inflight-steps:${w.sessionId}`
    const sets = w.storeSets.filter(s => s.key === key)
    expect(sets.some(s => s.value.some((x: any) => x.id === 'R-1:tr:1'))).toBe(true)
    expect(sets.some(s => s.value.some((x: any) => x.id === 'R-1:tr:2'))).toBe(false)
  })
})
