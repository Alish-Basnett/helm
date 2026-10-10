// Helm in-session UI: a quiet band above the prompt and a /helm-pane pane.
//
// register.ts owns the hub connection; it hands this module a tiny `api` so the two stay decoupled.
// Everything drawn comes from `$.state` (see types/index.d.ts), refreshed from the hub every 5 s
// and straight after a button press. Render hooks only read state; they never write it.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { HelmAgentCounts, HelmTask } from '../types'

export type HelmUiApi = {
  /**
   * Accepted for compatibility, not used: the host's static scan refuses `$` handed to a function
   * that is not declared at the top of the same file, so this module talks to the hub through its
   * own `hubFetch` below (same socket, same routes). Safe to leave out.
   */
  hub?: ($: any, method: string, path: string, body?: unknown) => Promise<any>
  sessionId: () => string
  hubUp: () => boolean
  dashboardUrl: string
}

const PANE = 'helm'
const COMMAND = 'helm-pane'
const REFRESH_MS = 5000

const tasksAtom = atom({ plugin: 'helm', key: 'tasks' } as const, [] as HelmTask[])
const agentsAtom = atom({ plugin: 'helm', key: 'agents' } as const, {} as HelmAgentCounts)
const questionsAtom = atom({ plugin: 'helm', key: 'questions' } as const, 0)
const hubUpAtom = atom({ plugin: 'helm', key: 'hubUp' } as const, false)

const GROUPS: { status: HelmTask['status']; label: string }[] = [
  { status: 'in_progress', label: 'In progress' },
  { status: 'review', label: 'Review' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'next', label: 'Up next' },
]

const OPEN_PANE = { id: PANE, title: 'Helm', focus: true, closeOnEscape: true } as const

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

let timer: { cancel: () => void } | undefined
let refreshing = false
let sock = ''

// One request to the hub over its unix socket, with a timeout (HttpInit has none, so race the clock).
async function hubFetch($: any, method: string, path: string, body?: unknown, timeoutMs = 4000): Promise<any> {
  if (!sock) sock = `${(await $.env.get('HELM_HOME')) || `${await $.env.get('HOME')}/.helm`}/helmd.sock`
  const timeout = $.clock.sleep(timeoutMs).then(() => {
    throw new Error(`hub ${method} ${path} timed out after ${timeoutMs} ms`)
  })
  const r: any = await Promise.race([
    $.http.fetch(`http://helm${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      socketPath: sock,
    }),
    timeout,
  ])
  if (!r.ok) throw new Error(`hub ${method} ${path} → ${r.status}`)
  return r.text ? JSON.parse(r.text) : {}
}

// State writes, one function per snapshot so each atom is a literal the host's scan can list.
// A value is written only when it changed, so an unchanged poll redraws nothing.
async function markDown($: any) {
  if (await read($, hubUpAtom)) await update($, hubUpAtom, () => false)
}

async function store($: any, tasks: HelmTask[], agents: HelmAgentCounts, questions: number) {
  if (!same(await read($, tasksAtom), tasks)) await update($, tasksAtom, () => tasks)
  if (!same(await read($, agentsAtom), agents)) await update($, agentsAtom, () => agents)
  if ((await read($, questionsAtom)) !== questions) await update($, questionsAtom, () => questions)
  if (!(await read($, hubUpAtom))) await update($, hubUpAtom, () => true)
}

// Pull this session's snapshot from the hub into $.state.
async function refresh($: any, api: HelmUiApi) {
  if (refreshing) return
  refreshing = true
  try {
    const sid = api.sessionId() || (await $.session.id().catch(() => ''))
    if (!sid || !api.hubUp()) {
      await markDown($)
      return
    }
    const [t, a, q] = await Promise.allSettled([
      hubFetch($, 'GET', `/v1/tasks?sessionId=${encodeURIComponent(sid)}`),
      hubFetch($, 'GET', `/v1/sessions/${encodeURIComponent(sid)}/agents`),
      hubFetch($, 'GET', '/v1/questions?state=open'),
    ])
    if (t.status !== 'fulfilled') {
      await markDown($)
      return
    }
    const tasks: HelmTask[] = (t.value?.tasks ?? []).map((x: any) => ({
      id: String(x.id),
      title: String(x.title ?? ''),
      status: x.status,
    }))
    const agents: HelmAgentCounts = {}
    if (a.status === 'fulfilled') {
      for (const ag of a.value?.agents ?? []) agents[ag.status] = (agents[ag.status] ?? 0) + 1
    }
    // /v1/questions lands with the hub's v0.2: any error, or an unexpected body, counts as 0.
    let questions = 0
    if (q.status === 'fulfilled' && Array.isArray(q.value?.questions)) {
      questions = q.value.questions.filter((x: any) => !x.sessionId || x.sessionId === sid).length
    }
    await store($, tasks, agents, questions)
  } catch {
    await markDown($).catch(() => {})
  } finally {
    refreshing = false
  }
}

async function setStatus($: any, api: HelmUiApi, id: string, status: 'done' | 'later') {
  try {
    await hubFetch($, 'PATCH', `/v1/tasks/${encodeURIComponent(id)}`, { status })
  } catch (err) {
    $.ui.toast(`Helm: could not move ${id} to ${status} (${String(err).slice(0, 120)})`)
  }
  await refresh($, api)
}

export function registerUi(on: Parameters<Register>[0], api: HelmUiApi): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({ name: COMMAND, description: 'Open the Helm pane' })
    } catch {
      // Already registered by an earlier load of this module.
    }
    timer?.cancel()
    void refresh($, api)
    timer = $.clock.every(REFRESH_MS, () => void refresh($, api))
    return started
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open(OPEN_PANE)
    return { text: 'Helm pane opened.' }
  }).catch(() => ({ text: 'Could not open the Helm pane.' }))

  // ---------- band ----------
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [tasks, agents, questions, isUp] = await Promise.all([
      read($, tasksAtom),
      read($, agentsAtom),
      read($, questionsAtom),
      read($, hubUpAtom),
    ])
    if (e.props.hasSurvey || !isUp) return next(e)

    const running = agents.running ?? 0
    const review = tasks.filter(t => t.status === 'review').length
    const blocked = tasks.filter(t => t.status === 'blocked').length
    const needsYou = Math.max(questions, agents.waiting ?? 0)
    if (running + review + blocked + needsYou === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const parts: { text: string; color?: 'warning' | 'error' }[] = []
    if (running) parts.push({ text: `${running} running` })
    if (review) parts.push({ text: `${review} review` })
    if (blocked) parts.push({ text: `${blocked} blocked`, color: 'error' })
    if (needsYou) parts.push({ text: `${needsYou} needs you`, color: 'warning' })

    return (
      <Box>
        <Text color="claude">◉ </Text>
        <Text dimColor>Helm  </Text>
        {parts.map((p, i) => (
          <Text key={p.text} dimColor={!p.color} color={p.color}>
            {i > 0 ? ' · ' : ''}
            {p.text}
          </Text>
        ))}
        <Text>   </Text>
        <Button key="open" label="Open" onPress={() => void $.ui.open(OPEN_PANE)} />
      </Box>
    )
  })

  // ---------- pane ----------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [tasks, agents, questions, isUp] = await Promise.all([
      read($, tasksAtom),
      read($, agentsAtom),
      read($, questionsAtom),
      read($, hubUpAtom),
    ])
    const { Box, Button, Link, Text } = $.ui.resolve(e)

    // Rows: one for the summary, one for the dashboard link, the rest for groups and cards.
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 6)
    const body: unknown[] = []
    let used = 0
    let hidden = 0

    if (!isUp) {
      body.push(<Text key="down" dimColor>Helm hub is not reachable. It starts with the session; give it a few seconds.</Text>)
    } else {
      for (const g of GROUPS) {
        const cards = tasks.filter(t => t.status === g.status)
        if (cards.length === 0) continue
        if (used + 2 > room) {
          hidden += cards.length
          continue
        }
        body.push(
          <Text key={`h:${g.status}`} bold>
            {g.label} <Text dimColor>({cards.length})</Text>
          </Text>,
        )
        used += 1
        for (const t of cards) {
          if (used >= room) {
            hidden += 1
            continue
          }
          used += 1
          body.push(
            <Box key={`c:${t.id}`} gap={1}>
              <Text dimColor>{t.id}</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">{t.title}</Text>
              </Box>
              <Button key={`done:${t.id}`} label="Done" onPress={() => void setStatus($, api, t.id, 'done')} />
              <Button key={`later:${t.id}`} label="Later" onPress={() => void setStatus($, api, t.id, 'later')} />
            </Box>,
          )
        }
      }
      if (hidden > 0) body.push(<Text key="more" dimColor>… {hidden} more</Text>)
      if (body.length === 0) body.push(<Text key="none" dimColor>No open tasks in this session.</Text>)
    }

    const running = agents.running ?? 0
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {running} running agent{running === 1 ? '' : 's'}
          {questions > 0 ? ` · ${questions} waiting on you` : ''}
        </Text>
        {body as any}
        <Text>
          <Link href={api.dashboardUrl} label="Dashboard" />
        </Text>
      </Box>
    )
  })
}
