// Tests for hooks/ui.tsx. They run against the plugin as loaded, so register.ts must call
// registerUi (that wiring is what puts ui.tsx's hub/state/UI calls into the module the host
// scans). Everything beneath the plugin is faked: the hub answers over a fake http.fetch.
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const SESSION = 'sess-1'

type FakeTask = { id: string; title: string; status: string }

function world(on: any, opts: { questions?: boolean } = {}) {
  const tasks: FakeTask[] = [
    { id: 'T-1', title: 'Wire the band', status: 'in_progress' },
    { id: 'T-2', title: 'Review the pane', status: 'review' },
    { id: 'T-3', title: 'Stuck on the schema', status: 'blocked' },
    { id: 'T-4', title: 'Write the docs', status: 'next' },
  ]
  const agents = [{ status: 'running' }, { status: 'running' }, { status: 'done' }]
  const hubCalls: { method: string; path: string; body?: any }[] = []
  const opened: any[] = []
  const reply = (status: number, body: unknown) => ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } })

  mock.store(on)
  mock.env(on, { HELM_HOME: '/tmp/helm-ui-test', HOME: '/tmp' })
  const clock = mock.clock(on)

  // The hub, over the socket the plugin talks to.
  on('http.fetch', (_$: any, e: any) => {
    const path = String(e.url).replace('http://helm', '')
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    hubCalls.push({ method, path, body })
    if (path === '/v1/health') return reply(200, { ok: true })
    if (path.startsWith('/v1/tasks?')) return reply(200, { tasks })
    if (path === `/v1/sessions/${SESSION}/agents`) return reply(200, { agents })
    if (path.startsWith('/v1/questions')) {
      // A v0.1 hub has no such route.
      return opts.questions ? reply(200, { questions: [{ sessionId: SESSION }, { sessionId: 'other' }] }) : reply(404, { error: 'not found' })
    }
    if (method === 'PATCH') {
      const task = tasks.find(t => path === `/v1/tasks/${t.id}`)
      if (!task) return reply(404, { error: 'no task' })
      task.status = body.status
      return reply(200, { task })
    }
    if (path.includes('/inbox')) return reply(200, { notes: [] })
    return reply(200, {})
  })

  // The rest of what the plugin's session.start and ticks touch.
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/tmp' }))
  on('session.model', () => ({ value: 'sonnet' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_$: any, e: any) => ({ value: { tool: `mcp__helm__${e.name}` } }))
  on('agent.register', (_$: any, e: any) => ({ value: { agent: `helm:${e.name}` } }))
  on('agent.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_$: any, e: any) => (opened.push(e), { value: { isPlaced: true } }))
  // What core draws for the band when the plugin steps aside.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['ENGINE-BAND'] }) as any)

  return { tasks, agents, hubCalls, opened, clock }
}

const PANE_PROPS = (surface: string) => ({
  title: 'Helm',
  isFocused: true,
  bodyColumns: surface === 'desktop' ? 100 : 80,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
})
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} }
const VIEWPORT = { columns: 100, rows: 30 }

async function start($: any, surface: string, w: ReturnType<typeof world>) {
  await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
  await w.clock.advance(5000) // one refresh tick, so the snapshot is in state
}

const drawn = async (m: { drawn: () => Promise<unknown> }) => JSON.stringify(await m.drawn())

for (const surface of SURFACES) {
  test(`${surface}: pane groups this session's cards; Done and Later PATCH the hub`, async ($, on) => {
    const w = world(on)
    await start($, surface, w)
    const pane = await $.ui.mount({ plugin: 'helm', surface, component: 'Pane', requestId: 'helm', props: PANE_PROPS(surface), viewport: VIEWPORT })

    const text = await drawn(pane)
    for (const label of ['In progress', 'Review', 'Blocked', 'Up next', 'Wire the band', 'Write the docs', 'Dashboard']) expect(text).toContain(label)
    expect(await pane.findAll({ type: 'Button' })).toHaveLength(8)
    expect((await pane.find({ type: 'Link' }))?.props.href).toBe('http://localhost:7777')

    await pane.press({ key: 'done:T-1' })
    expect(w.hubCalls).toContainEqual({ method: 'PATCH', path: '/v1/tasks/T-1', body: { status: 'done' } })
    expect(await drawn(pane)).not.toContain('Wire the band')

    await pane.press({ key: 'later:T-4' })
    expect(w.hubCalls).toContainEqual({ method: 'PATCH', path: '/v1/tasks/T-4', body: { status: 'later' } })
    expect(await drawn(pane)).not.toContain('Write the docs')
  })

  test(`${surface}: pane is cut to the viewport rows`, async ($, on) => {
    const w = world(on)
    await start($, surface, w)
    const pane = await $.ui.mount({ plugin: 'helm', surface, component: 'Pane', requestId: 'helm', props: PANE_PROPS(surface), viewport: { columns: 100, rows: 9 } })
    expect((await pane.findAll({ type: 'Button' })).length).toBeLessThan(8)
    expect(await drawn(pane)).toContain('more')
  })

  test(`${surface}: band shows the counts and Open opens the pane`, async ($, on) => {
    const w = world(on, { questions: true })
    await start($, surface, w)
    const band = await $.ui.mount({ plugin: 'helm', surface, component: 'AbovePrompt', props: BAND_PROPS, viewport: VIEWPORT })

    const text = await drawn(band)
    for (const part of ['2 running', '1 review', '1 blocked', '1 needs you']) expect(text).toContain(part)

    await band.press({ key: 'open' })
    expect(w.opened.at(-1)).toMatchObject({ id: 'helm', title: 'Helm' })
  })

  test(`${surface}: band steps aside when there is nothing to report or a survey is up`, async ($, on) => {
    const w = world(on)
    w.tasks.length = 0
    w.agents.length = 0
    await start($, surface, w)
    const quiet = await $.ui.mount({ plugin: 'helm', surface, component: 'AbovePrompt', props: BAND_PROPS, viewport: VIEWPORT })
    expect(await drawn(quiet)).toContain('ENGINE-BAND')

    w.agents.push({ status: 'running' })
    await w.clock.advance(5000)
    expect(await drawn(quiet)).toContain('1 running')

    const survey = await $.ui.mount({ plugin: 'helm', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey: true }, viewport: VIEWPORT })
    expect(await drawn(survey)).toContain('ENGINE-BAND')
  })

  test(`${surface}: polls every 5 s and counts a 404 on /v1/questions as zero`, async ($, on) => {
    const w = world(on, { questions: false })
    await start($, surface, w)
    const polls = () => w.hubCalls.filter(c => c.path.startsWith('/v1/questions')).length
    const before = polls()
    await w.clock.advance(5000)
    expect(polls()).toBe(before + 1)
    await w.clock.advance(5000)
    expect(polls()).toBe(before + 2)

    const band = await $.ui.mount({ plugin: 'helm', surface, component: 'AbovePrompt', props: BAND_PROPS, viewport: VIEWPORT })
    const text = await drawn(band)
    expect(text).toContain('2 running')
    expect(text).not.toContain('needs you')
  })
}

test('/helm-pane opens the pane', async ($, on) => {
  const w = world(on)
  await start($, 'terminal', w)
  const r = await $.command.run({ command: 'helm-pane', args: '' } as any)
  expect(r.text).toContain('opened')
  expect(w.opened.at(-1)).toMatchObject({ id: 'helm', title: 'Helm' })
})
