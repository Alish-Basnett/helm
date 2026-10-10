import type { Register } from 'claude-code'
import { registerUi } from './ui'

// Helm mod: the sensor + actuator that runs inside every Claude Code session.
// It turns engine events into hub events (see CONTRACT.md), routes subagent
// models, delivers executed notes, and keeps a probe log of raw event shapes.

type HubEvent = { sessionId: string; seq: number; type: string; at: number; data: Record<string, unknown> }

const PORT = 7777
const OUTBOX_CAP = 3000
const TERMINAL = new Set(['completed', 'failed', 'killed'])

const MODEL_BY_TYPE: Record<string, string> = {
  'helm:builder': 'sonnet',
  'helm:scout': 'haiku',
  Explore: 'haiku',
  'claude-code-guide': 'haiku',
  'statusline-setup': 'haiku',
}

const HELM_SECTION = `# Helm (installed mod)
You orchestrate on Opus: plan, delegate, stay free to talk.
- Before delegating, create a card with \`mcp__helm__task\` (action "create"); it returns an id like T-12.
- Delegate with the Agent tool, \`[helm:T-12]\` at the start of the description: \`helm:builder\` (Sonnet) for code, \`helm:scout\` (Haiku) for reading/search. Run in the background, in parallel when independent.
- Cards move themselves. Use action "update" only for later/done/blocked when asked.
- "Helm note (N-x)" messages are the user's own words from the dashboard; your answer is shown under the note, so reply in 1–2 plain sentences unless asked for more. "Start Helm task T-n" means delegate that existing card now.`

const BUILDER_PROMPT = `You are a Helm builder (Sonnet). You own exactly one task from the user's Helm board.
Do the task completely and verify it (run the relevant tests, type-check or build, or show the command output that proves it works). Stay inside the task's scope; if you discover out-of-scope work, mention it at the end instead of doing it.
End with a short final report in exactly this shape:
DONE: <one line, what is now true>
HOW: <one or two lines, the approach and key decisions>
FILES: <comma-separated paths you changed, or none>
LEARNED: <one line, the transferable dev/IT concept behind this task, explained for a learner>
TAGS: <1-3 lowercase topic tags, e.g. css, sql, testing>
If the user only asked a question, answer it in 1–2 sentences and skip the report.
If your work proposes options for the user to pick from (plans, audits, suggestions), end with a fenced block:
\`\`\`helm-choices
[{"id":"short-slug","title":"one line","detail":"one or two lines","effort":"S|M|L","value":"low|medium|high"}]
\`\`\``

const SCOUT_PROMPT = `You are a Helm scout (Haiku). You answer one narrow question fast: search, read, list, check. Never edit files.
Be precise: cite file paths with line numbers. End with:
DONE: <one line answer>
HOW: <where you looked>
FILES: none
LEARNED: <one line, a concept worth knowing from what you found>
TAGS: <1-3 lowercase topic tags>`

// USD per million tokens: input, output, cache read (current list prices).
const PRICES: Record<string, [number, number, number]> = {
  fable: [10, 50, 0.25],
  opus: [4, 20, 0.2],
  sonnet: [2, 10, 0.2],
  haiku: [0.1, 0.5, 0.01],
}

function costOf(model: string, u: any): number {
  // Unknown names price as Opus, so the meter can over- but never under-count.
  const key = /haiku/i.test(model) ? 'haiku' : /sonnet/i.test(model) ? 'sonnet' : /fable|mythos/i.test(model) ? 'fable' : 'opus'
  const [i, o, c] = PRICES[key]!
  // cache writes bill at 1.25× the input rate
  const usd = (Number(u?.input_tokens ?? 0) * i + Number(u?.cache_creation_input_tokens ?? 0) * i * 1.25
    + Number(u?.output_tokens ?? 0) * o + Number(u?.cache_read_input_tokens ?? 0) * c) / 1e6
  return Math.round(usd * 1e6) / 1e6
}

function meter(kind: string, model: string, u: any, extra: Record<string, unknown> = {}) {
  if (!u) return
  emit('helm.usage', {
    kind, model,
    inputTokens: Number(u.input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
    costUsd: costOf(model, u),
    ...extra,
  })
}

// Builders end with DONE/HOW/LEARNED/TAGS lines: a recap for free, no model call.
function recapFromReport(answer: string) {
  const line = (k: string) => String(answer ?? '').match(new RegExp(`^\\s*\\**${k}:?\\**\\s*(.+)$`, 'im'))?.[1]?.trim()
  const what = line('DONE'), how = line('HOW'), learned = line('LEARNED')
  if (!what || !learned) return null
  const tags = (line('TAGS') ?? '').split(/,\s*/).map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 3)
  return { what: clip(what, 160), how: clip(how ?? '', 200), learned: clip(learned, 240), concepts: tags.map(t => clip(t, 24)) }
}

// Actionable outputs: a ```helm-choices JSON block in a final answer becomes a checklist on the card.
function choicesFrom(answer: string): any[] | null {
  const m = String(answer ?? '').match(/```helm-choices\s*([\s\S]*?)```/)
  if (!m) return null
  try {
    const list = JSON.parse(m[1]!)
    if (!Array.isArray(list)) return null
    return list.slice(0, 30).map((c: any, i: number) => ({
      id: clip(c.id || `c${i + 1}`, 40), title: clip(c.title, 140), detail: clip(c.detail ?? '', 400),
      effort: ['S', 'M', 'L'].includes(c.effort) ? c.effort : undefined,
      value: ['low', 'medium', 'high'].includes(c.value) ? c.value : undefined,
    })).filter(c => c.title)
  } catch { return null }
}

const QUESTION = /^(what|why|how|when|where|who|which|does|do|did|is|are|was|were|can|could|should|would|will|has|have)\b/i
function isQuestion(text: string) {
  const t = String(text ?? '').trim()
  return t.endsWith('?') || QUESTION.test(t)
}

function withAttachments(text: string, note: any) {
  const files = (note.attachments ?? []) as any[]
  if (!files.length) return text
  return `${text}\n\nAttached files (open them with the Read tool):\n${files.map(f => `- ${f.path}`).join('\n')}`
}

const ANSWER_SYSTEM = `Answer the user's question about this task from its record only. 1–2 plain sentences, no preamble. If the record doesn't contain the answer, say that in one sentence and suggest prefixing the note with ! to ask the agent.`

const RECAP_SYSTEM = `You write ultra-short task recaps for a developer who wants to keep learning. Reply with JSON only:
{"what":"<= 14 words, what was done","how":"<= 18 words, how it was done","learned":"<= 22 words, the transferable concept, plain words","concepts":["1-3 lowercase topic tags like git, sql, auth, css, testing, networking"]}`

// ---------- module state (resets on hot reload; durable bits live in $.store / the hub) ----------
let home = ''
let sock = ''
let root = ''
let sessionId = ''
let seq = 0
let outbox: HubEvent[] = []
let hubUp = false
let lastEnsure = 0
let flushing = false
let polling = false
let nodeBin = ''
let lastReconcile = ''
let lastReconcileAt = 0
const spawnByToolUse = new Map<string, { description: string; prompt: string; subagentType: string; model: string; at: number }>()
const toolUseByAgent = new Map<string, string>()
const recentTools = new Map<string, string[]>()
const recapQueue: { agentId: string; answer: string; tries: number }[] = []
const probes: Record<string, unknown[]> = {}
let probesDirty = false
const timers: { cancel: () => void }[] = []
const completedAgents = new Set<string>()
let completedDirty = false
let rebindAfterClear: { projectId?: string } | null = null
let ticking = false
let tickStartedAt = 0

// ---------- helpers ----------
function emit(type: string, data: Record<string, unknown>) {
  if (!sessionId) return
  seq = Math.max(seq + 1, Date.now() * 1000)
  outbox.push({ sessionId, seq, type, at: Date.now(), data })
  if (outbox.length > OUTBOX_CAP) {
    const i = outbox.findIndex(ev => ev.type.startsWith('tool.'))
    outbox.splice(i >= 0 ? i : 0, 1)
  }
}

// ---------- note replies: what Claude answered to a note, shown back under it in the dashboard ----------
// session notes: turnId → note ids (matched in turn.start); task notes: agentId → note ids (answered on completion)
const replyTurns = new Map<string, string[]>()
const replyAgents = new Map<string, string[]>()
// follow-up spawns made for task notes: taskId → note ids, bound to the agent in our own agent.spawn hook
// (a plugin's $.agent.spawn may not hand the agentId back to its caller)
const pendingFollowups = new Map<string, string[]>()
const choiceQueue: { agentId: string; choices: any[]; tries: number }[] = []

async function flushChoices($: any) {
  while (choiceQueue.length) {
    const job = choiceQueue[0]!
    try {
      const { agents } = await hub($, 'GET', `/v1/sessions/${sessionId}/agents`)
      const agent = (agents as any[]).find(a => a.id === job.agentId)
      if (!agent?.taskId) {
        if (++job.tries > 5) choiceQueue.shift()
        return
      }
      choiceQueue.shift()
      emit('task.choices', { taskId: agent.taskId, choices: job.choices })
    } catch {
      return
    }
  }
}
let repliesDirty = false

function awaitAgentReply(agentId: string, noteId: string) {
  replyAgents.set(agentId, [...new Set([...(replyAgents.get(agentId) ?? []), noteId])])
  repliesDirty = true
}

function sendReplies(ids: string[] | undefined, text: string) {
  const body = String(text ?? '').trim().slice(0, 8000)
  for (const noteId of ids ?? []) emit('note.reply', { noteId, text: body || '(no answer text)' })
  if (ids?.length) repliesDirty = true
}

function completeAgent(agentId: string, ok: boolean, summary: string, tokens: number | undefined, answer: string) {
  if (completedAgents.has(agentId)) return
  completedAgents.add(agentId)
  completedDirty = true
  emit('agent.completed', { agentId, ok, summary: clip(summary, 400), tokens, files: reportedFiles(answer) })
  if (ok) recapQueue.push({ agentId, answer, tries: 0 })
  const choices = ok ? choicesFrom(answer) : null
  if (choices?.length) choiceQueue.push({ agentId, choices, tries: 0 })
  sendReplies(replyAgents.get(agentId), answer || summary)
  replyAgents.delete(agentId)
  settleStepAgent(agentId, ok, answer, summary, tokens)
}

// Builders end with "FILES: a, b"; edits made through Bash never pass Edit/Write, so this is the reliable list.
function reportedFiles(answer: string): string[] {
  const m = String(answer ?? '').match(/^\s*\**FILES:?\**\s*(.+)$/im)
  if (!m) return []
  return m[1]!.split(/,\s*/).map(f => f.trim().replace(/^`|`$/g, '')).filter(f => f && !/^none\.?$/i.test(f)).slice(0, 100)
}

function probe(kind: string, sample: unknown) {
  const list = (probes[kind] ??= [])
  if (list.length >= 4) return
  try {
    list.push(JSON.parse(JSON.stringify(sample, (_k, v) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v))))
    probesDirty = true
  } catch {}
}

function clip(s: unknown, n: number) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function base(p: unknown) {
  return String(p ?? '').split('/').filter(Boolean).pop() ?? ''
}

function summarize(e: any): string {
  switch (String(e.tool)) {
    case 'Bash': return clip(e.description || String(e.command ?? '').replace(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/, ''), 90)
    case 'Read': return `Reading ${base(e.file_path)}`
    case 'Edit': case 'MultiEdit': return `Editing ${base(e.file_path)}`
    case 'Write': return `Writing ${base(e.file_path)}`
    case 'NotebookEdit': return `Editing ${base(e.notebook_path)}`
    case 'Grep': return `Searching “${clip(e.pattern, 40)}”`
    case 'Glob': return `Finding ${clip(e.pattern, 40)}`
    case 'WebFetch': return `Fetching ${clip(e.url, 60)}`
    case 'WebSearch': return `Searching web “${clip(e.query, 50)}”`
    case 'Agent': return `Delegating: ${clip(e.description, 70)}`
    case 'SendMessage': return `Messaging ${clip(e.to, 30)}`
    case 'AskUserQuestion': return clip((e.questions ?? []).map((q: any) => q.question).join('  ·  ') || 'Asking you a question', 280)
    default: return String(e.tool).replace(/^mcp__/, '').replace(/__/g, ' · ')
  }
}

function filesOf(e: any): string[] {
  const p = e.file_path ?? e.notebook_path
  return ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(String(e.tool)) && p ? [String(p)] : []
}

async function hub($: any, method: string, path: string, body?: unknown, timeoutMs = 4000): Promise<any> {
  // HttpInit has no timeout, so race the call against the clock.
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
  if (!r.ok) throw new Error(`hub ${method} ${path} → ${r.status} ${clip(r.text, 200)}`)
  return r.text ? JSON.parse(r.text) : {}
}

async function findNode($: any): Promise<string> {
  if (nodeBin) return nodeBin
  const stored = (await $.store.get('nodeBin')) as string | undefined
  const tries = [
    stored ? `"${stored}" -e "process.exit(+process.versions.node.split('.')[0] < 22)" && echo "${stored}"` : '',
    `ls -d "$HOME"/.nvm/versions/node/v2[2-9]*/bin/node 2>/dev/null | sort -V | tail -1`,
    `for n in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$n" ] && echo "$n" && break; done`,
    `/bin/zsh -lc 'command -v node' 2>/dev/null`,
  ].filter(Boolean)
  for (const cmd of tries) {
    try {
      const { stdout } = await $.process.run(['/bin/sh', '-c', cmd], { timeoutMs: 8000 })
      const p = stdout.trim().split('\n').pop()?.trim()
      if (p && p.startsWith('/')) {
        nodeBin = p
        await $.store.set('nodeBin', p)
        return p
      }
    } catch {}
  }
  return ''
}

async function ensureHub($: any): Promise<boolean> {
  try {
    await hub($, 'GET', '/v1/health')
    hubUp = true
    return true
  } catch {}
  hubUp = false
  if (Date.now() - lastEnsure < 15000) return false
  lastEnsure = Date.now()
  const entry = `${root}/hub/helmd.mjs`
  if (!(await $.fs.exists(entry).catch(() => false))) return false
  const node = await findNode($)
  if (!node) {
    $.ui.status('Helm: Node ≥ 22 not found')
    return false
  }
  try {
    // --detach forks a detached daemon and returns once it answers /v1/health.
    const r = await $.process.run([node, entry, '--detach'], { env: { HELM_HOME: home, HELM_PORT: String(PORT) }, timeoutMs: 15000 })
    if (r.exitCode !== 0) probe('ensureHub.exit', { code: r.exitCode, stderr: clip(r.stderr, 300) })
  } catch (err) {
    probe('ensureHub.error', String(err))
  }
  try {
    await hub($, 'GET', '/v1/health')
    hubUp = true
    return true
  } catch {}
  return false
}

async function flush($: any) {
  if (flushing) return
  flushing = true
  try {
    if (outbox.length && (hubUp || (await ensureHub($)))) {
      while (outbox.length) {
        const batch = outbox.slice(0, 200)
        try {
          await hub($, 'POST', '/v1/events', { events: batch })
        } catch (err) {
          hubUp = false
          probe('flush.error', String(err))
          break
        }
        const top = batch[batch.length - 1]!.seq
        outbox = outbox.filter(ev => ev.seq > top)
      }
    }
    await saveOutbox($)
    if (probesDirty) {
      probesDirty = false
      await $.fs.write(`${home}/probe-${sessionId.slice(0, 8)}.json`, JSON.stringify(probes, null, 2)).catch(() => {})
    }
  } finally {
    flushing = false
  }
}

async function saveOutbox($: any) {
  // The store caps at 4 MiB of JSON across the plugin: keep the persisted copy lean.
  const lean = outbox.slice(-1500).map(ev =>
    ev.type === 'agent.spawned' ? { ...ev, data: { ...ev.data, prompt: clip(ev.data.prompt, 800) } } : ev,
  )
  await $.store.set(`outbox:${sessionId}`, lean).catch((err: unknown) => probe('store.error', String(err)))
}

// One loop drives all network work, off every hook's budget.
async function tick($: any) {
  // Watchdog: a tick that has hung for 20 s (a stuck host call) no longer blocks new ones.
  if (ticking && Date.now() - tickStartedAt < 20000) return
  ticking = true
  tickStartedAt = Date.now()
  try {
    if (rebindAfterClear) await rebind($)
    if (!hubUp) await ensureHub($)
    await flush($)
    await pollInbox($)
    await pollJobs($)
    await pollSteps($)
    await captureGitBases($)
    if (hubUp && !outbox.length) await flushChoices($)
    if (hubUp && !outbox.length) {
      await backfillRecaps($).catch(err => probe('backfill.error', String(err)))
      await runRecaps($)
    }
  } catch (err) {
    probe('tick.error', String(err))
  } finally {
    ticking = false
  }
}

// After /clear the process continues under a new session id with no session.start.
async function rebind($: any) {
  const next = await $.session.id().catch(() => '')
  if (!next || next === sessionId) return
  const carry = rebindAfterClear
  rebindAfterClear = null
  sessionId = next
  seq = Math.max(seq, Date.now() * 1000)
  const cwd = await $.session.cwd().catch(() => '')
  emit('session.started', { cwd, title: base(cwd) || 'session', model: await $.session.model().catch(() => '') })
  await flush($)
  if (carry?.projectId && hubUp) await hub($, 'POST', `/v1/sessions/${sessionId}/join`, { projectId: carry.projectId }).catch(() => {})
}

// ---------- jobs: model work the hub asks this session to do (explain deeper, daily digest) ----------
const JOB_SYSTEM: Record<string, string> = {
  explain: `You are a patient senior engineer teaching a developer who wants to grow. Explain the task below in depth, in markdown, under 350 words:
## What happened
## Why this approach
## The concept, properly (the transferable idea, with a tiny example)
## Try it yourself (one small exercise)
Plain words, no hype. Never invent facts that are not in the input.`,
  digest: `You write a developer's end-of-day digest in markdown, under 220 words:
## Shipped (bullets: task id + one line)
## Blocked (bullets, with the reason) — omit if none
## In flight — omit if none
## 3 concepts you picked up today (each: name — one plain-words line)
Only use what is in the input.`,
  wf_draft: `You design Helm workflows. The input has the user's request ("prompt"), the graph schema ("schema"), the allowed node types, example graphs, and optionally the current graph to modify ("current") and validation issues to fix ("fixIssues").
Reply with exactly ONE JSON object: a complete graph that follows the schema, in a single \`\`\`json fenced block, and nothing else.
Keep it as small as the request allows, give every node a short clear label, use gates before anything risky, and only use node types and fields from the schema.`,
}
// Which model writes each job: drafting a workflow needs judgement, the rest are cheap Haiku calls.
const JOB_MODEL: Record<string, { model: string; maxTokens: number }> = {
  wf_draft: { model: 'sonnet', maxTokens: 8000 },
}
// Claimed jobs and model/shell steps are persisted while they run, so a hot reload (which drops the old
// module's in-flight calls) re-runs them instead of leaving them stuck as "running" in the hub.
async function trackInflight($: any, key: 'jobs' | 'steps', item: any, on: boolean) {
  const k = `inflight-${key}:${sessionId}`
  const list = ((await $.store.get(k).catch(() => [])) as any[] | undefined) ?? []
  const next = on ? [...list.filter(x => x.id !== item.id), item] : list.filter(x => x.id !== item.id)
  await $.store.set(k, next.slice(-20)).catch(() => {})
}
let jobsPolling = false
let jobsMissingAt = 0
async function pollJobs($: any) {
  // An older hub without the endpoint is re-checked every minute (hubs get upgraded mid-session).
  if (jobsPolling || !hubUp || Date.now() - jobsMissingAt < 60000) return
  jobsPolling = true
  try {
    let jobs: any[] = []
    try {
      jobs = (await hub($, 'GET', `/v1/sessions/${sessionId}/jobs`)).jobs ?? []
    } catch (err) {
      if (/→ 404/.test(String(err))) jobsMissingAt = Date.now()
      return
    }
    for (const job of jobs) void runJob($, job)
  } finally {
    jobsPolling = false
  }
}

async function runJob($: any, job: any) {
  await trackInflight($, 'jobs', job, true)
  try {
    const system = JOB_SYSTEM[job.kind]
    if (!system) throw new Error(`unknown job kind ${job.kind}`)
    const pick = JOB_MODEL[job.kind] ?? { model: 'haiku', maxTokens: 900 }
    const r = await $.model.complete({ model: pick.model, system, maxTokens: pick.maxTokens, timeoutMs: 120000, prompt: JSON.stringify(job.input, null, 1).slice(0, 40000) })
    meter(job.kind === 'wf_draft' ? 'wf_draft' : job.kind, pick.model, r.usage, { taskId: job.taskId ?? undefined })
    if (!r.isAnswered) throw new Error(`model: ${r.reason ?? 'no answer'}`)
    emit('job.result', { jobId: job.id, ok: true, text: r.text.trim() })
  } catch (err) {
    emit('job.result', { jobId: job.id, ok: false, error: clip(String(err), 300) })
  }
  await trackInflight($, 'jobs', job, false)
  void flush($)
}

// ---------- workflow steps: the hub's Workflows engine asks this session to run agent / shell / review steps ----------
const stepByAgent = new Map<string, string>()   // agentId → stepId
const agentUsage = new Map<string, any>()       // agentId → its final turn usage (for workflow step cost)
const stepByTask = new Map<string, string>()    // taskId → stepId (bound to the agent in our agent.spawn hook)
let stepsDirty = false
let stepsPolling = false
let stepsMissingAt = 0

function stepUsage(model: string, u: any) {
  if (!u) return undefined
  return {
    model,
    inputTokens: Number(u.input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
    costUsd: costOf(model, u),
  }
}

async function pollSteps($: any) {
  // An older hub without the endpoint is re-checked every minute.
  if (stepsPolling || !hubUp || Date.now() - stepsMissingAt < 60000) return
  stepsPolling = true
  try {
    let steps: any[] = []
    try {
      steps = (await hub($, 'GET', `/v1/sessions/${sessionId}/steps`)).steps ?? []
    } catch (err) {
      if (/→ 404/.test(String(err))) stepsMissingAt = Date.now()
      return
    }
    for (const step of steps) void runStep($, step)
  } finally {
    stepsPolling = false
  }
}

async function runStep($: any, step: any) {
  const input = step.input ?? {}
  if (step.kind !== 'agent') await trackInflight($, 'steps', step, true)
  try {
    if (step.kind === 'agent') {
      // The hub already created the card; the [helm:T-n] tag binds this agent to it.
      if (input.taskId) { stepByTask.set(input.taskId, step.id); stepsDirty = true }
      const r = await $.agent.spawn({
        prompt: String(input.prompt ?? ''), description: String(input.description ?? input.label ?? 'workflow step'),
        subagentType: input.subagentType ?? 'helm:builder', model: input.model, cwd: input.cwd,
      })
      if (r?.deny) throw new Error(r.deny)
      if (r?.agentId) { stepByAgent.set(r.agentId, step.id); stepsDirty = true }
      return // the result is reported when the agent completes
    }
    if (step.kind === 'shell') {
      const argv = Array.isArray(input.argv) && input.argv.length ? input.argv.map(String) : ['sh', '-c', String(input.script ?? 'true')]
      let check: any
      try {
        const r = await $.process.run(argv, { cwd: input.cwd, timeoutMs: Math.min(Number(input.timeoutMs) || 30000, 600000) })
        check = { exitCode: r.exitCode, stdout: String(r.stdout ?? '').slice(-8000), stderr: String(r.stderr ?? '').slice(-4000) }
      } catch (err) {
        const timedOut = /time|kill/i.test(String(err))
        check = { exitCode: timedOut ? 124 : 1, stdout: '', stderr: clip(String(err), 2000), timedOut }
      }
      emit('wf.step.result', { stepId: step.id, ok: true, check, text: clip(check.stdout || check.stderr, 2000) })
    } else if (step.kind === 'review') {
      const r = await $.model.complete({
        model: input.model ?? 'opus', system: input.system, prompt: String(input.prompt ?? ''),
        maxTokens: Number(input.maxTokens) || 4096, timeoutMs: Number(input.timeoutMs) || 180000,
      })
      if (!r.isAnswered) throw new Error(`model: ${r.reason ?? 'no answer'}`)
      const verdict = /VERDICT:\s*PASS/i.test(r.text.split('\n').reverse().find((l: string) => /VERDICT:/i.test(l)) ?? '') ? 'pass' : 'changes'
      emit('wf.step.result', { stepId: step.id, ok: true, text: r.text.slice(0, 16000), verdict, usage: stepUsage(input.model ?? 'opus', r.usage) })
    } else {
      throw new Error(`unknown step kind ${step.kind}`)
    }
  } catch (err) {
    emit('wf.step.result', { stepId: step.id, ok: false, error: clip(String(err), 400) })
  }
  if (step.kind !== 'agent') await trackInflight($, 'steps', step, false)
  void flush($)
}

/** An agent that was a workflow step finished: report it to the engine. */
function settleStepAgent(agentId: string, ok: boolean, answer: string, summary: string, tokens: number | undefined) {
  const stepId = stepByAgent.get(agentId)
  if (!stepId) return
  stepByAgent.delete(agentId)
  for (const [t, s] of stepByTask) if (s === stepId) stepByTask.delete(t)
  stepsDirty = true
  const u = agentUsage.get(agentId)
  agentUsage.delete(agentId)
  emit('wf.step.result', { stepId, ok, agentId, text: String(answer || summary).slice(0, 16000), filesChanged: reportedFiles(answer), error: ok ? undefined : clip(summary, 400), usage: u ? stepUsage(String(u.model ?? 'sonnet'), u) : undefined })
}

// ---------- optional Obsidian export of recaps ----------
let exportOpts: { on: boolean; dir: string } = { on: false, dir: '' }
async function exportRecap($: any, recap: any, title: string) {
  if (!exportOpts.on || !exportOpts.dir) return
  const d = new Date()
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const dir = `${exportOpts.dir.replace(/\/$/, '')}/Helm`
  const file = `${dir}/${day}.md`
  await $.process.run(['mkdir', '-p', dir]).catch(() => {})
  const prev = (await $.fs.exists(file)) ? String(await $.fs.read(file)) : `# Helm learning log — ${day}\n`
  const tags = (recap.concepts as string[]).map(c => `#${c.replace(/\s+/g, '-')}`).join(' ')
  const entry = `\n## ${recap.taskId} · ${title}\n- **What:** ${recap.what}\n- **How:** ${recap.how}\n- **Learned:** ${recap.learned}\n${tags}\n`
  await $.fs.write(file, prev + entry)
}

// ---------- git base per spawn: lets the hub show each task's diff later ----------
const gitQueue: { toolUseId: string; agentId?: string; cwd?: string; tries: number }[] = []

async function git($: any, cwd: string, args: string[]): Promise<string> {
  const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 5000 })
  if (r.exitCode !== 0) throw new Error(clip(r.stderr, 200))
  return r.stdout.trim()
}

async function captureGitBases($: any) {
  while (gitQueue.length) {
    const job = gitQueue.shift()!
    try {
      const cwd = job.cwd || (await $.session.cwd())
      const root = await git($, cwd, ['rev-parse', '--show-toplevel'])
      const head = await git($, root, ['rev-parse', 'HEAD'])
      // `git stash create` snapshots index + working tree as a commit object without touching anything.
      const stash = await git($, root, ['stash', 'create']).catch(() => '')
      emit('agent.git', { toolUseId: job.toolUseId, agentId: job.agentId, cwd, root, head, base: stash || head, at: Date.now() })
    } catch (err) {
      probe('git.base', String(err)) // not a repo, or git missing: no event
    }
  }
}

// Any finished task of this session still without a recap (a completion missed during a reload) gets one.
const backfilled = new Set<string>()
let lastBackfill = 0
async function backfillRecaps($: any) {
  if (Date.now() - lastBackfill < 60000) return
  lastBackfill = Date.now()
  const { tasks } = await hub($, 'GET', `/v1/tasks?sessionId=${encodeURIComponent(sessionId)}`)
  for (const t of tasks as any[]) {
    if ((t.status === 'review' || t.status === 'done') && !t.recap && t.agentId && !backfilled.has(t.id)) {
      backfilled.add(t.id)
      if (!recapQueue.some(j => j.agentId === t.agentId)) recapQueue.push({ agentId: t.agentId, answer: '', tries: 0 })
    }
  }
}

async function runRecaps($: any) {
  while (recapQueue.length) {
    const job = recapQueue[0]!
    try {
      const { agents } = await hub($, 'GET', `/v1/sessions/${sessionId}/agents`)
      const agent = (agents as any[]).find(a => a.id === job.agentId)
      if (!agent?.taskId) {
        if (++job.tries > 5) recapQueue.shift()
        return
      }
      const free = recapFromReport(job.answer)
      if (free) {
        recapQueue.shift()
        const recap = { taskId: agent.taskId, ...free }
        emit('recap.generated', recap)
        await exportRecap($, recap, agent.description).catch(err => probe('export.error', String(err)))
        continue
      }
      const spawn = spawnByToolUse.get(toolUseByAgent.get(job.agentId) ?? '')
      let tools = (recentTools.get(job.agentId) ?? []).slice(-25).join('\n')
      if (!tools) {
        // Recovered or reloaded: rebuild the tool trail from the hub's activity log.
        const { activity } = await hub($, 'GET', `/v1/tasks/${agent.taskId}`)
        tools = (activity as any[]).filter(r => r.kind === 'tool').slice(0, 25).reverse().map(r => `${r.tool}: ${r.summary}`).join('\n')
      }
      const r = await $.model.complete({
        model: 'haiku',
        system: RECAP_SYSTEM,
        maxTokens: 300,
        timeoutMs: 20000,
        prompt: `Task: ${spawn?.description ?? agent.description}\n\nBrief:\n${clip(spawn?.prompt, 1500)}\n\nTools used:\n${tools}\n\nFinal report:\n${clip(job.answer, 3000)}`,
      })
      recapQueue.shift()
      meter('recap', 'haiku', r.usage, { taskId: agent.taskId })
      if (!r.isAnswered) continue
      const m = r.text.match(/\{[\s\S]*\}/)
      if (!m) continue
      const j = JSON.parse(m[0])
      const recap = {
        taskId: agent.taskId,
        what: clip(j.what, 160),
        how: clip(j.how, 200),
        learned: clip(j.learned, 240),
        concepts: Array.isArray(j.concepts) ? j.concepts.slice(0, 3).map((c: unknown) => clip(c, 24).toLowerCase()) : [],
      }
      emit('recap.generated', recap)
      await exportRecap($, recap, agent.description).catch(err => probe('export.error', String(err)))
    } catch (err) {
      probe('recap.error', String(err))
      if (++job.tries > 5) recapQueue.shift()
      return
    }
  }
}

async function reconcile($: any) {
  try {
    const list = (await $.agent.list()) as any[]
    probe('agent.list', list.slice(0, 3))
    const agents = list.map(a => ({
      agentId: a.id,
      status: a.status === 'failed' || a.status === 'killed' ? 'failed' : a.status === 'completed' ? 'done' : a.status === 'waiting' ? 'waiting' : 'running',
      description: a.description,
      type: a.type,
    }))
    // A completion missed while the mod was down or reloading: emit it now so the card moves and gets a recap.
    for (const a of list) {
      if (TERMINAL.has(a.status) && !completedAgents.has(a.id)) {
        completeAgent(a.id, a.status === 'completed', a.status === 'completed' ? 'completed (recovered by reconciler)' : `ended: ${a.status}`, undefined, '')
      }
    }
    if (completedDirty) {
      completedDirty = false
      await $.store.set(`done:${sessionId}`, [...completedAgents].slice(-500)).catch(() => {})
    }
    const key = JSON.stringify(agents.map(a => [a.agentId, a.status]))
    if (key !== lastReconcile || Date.now() - lastReconcileAt > 60000) {
      lastReconcile = key
      lastReconcileAt = Date.now()
      emit('reconcile', { agents })
    }
  } catch (err) {
    probe('reconcile.error', String(err))
  }
}

async function heartbeat($: any) {
  const data: Record<string, unknown> = {}
  try {
    const u: any = await $.session.usage()
    if (Number.isFinite(u?.context?.tokens)) data.tokens = u.context.tokens
    if (Number.isFinite(u?.cost?.usd)) data.costUsd = Math.round(u.cost.usd * 10000) / 10000
  } catch {}
  emit('session.heartbeat', data)
  await reconcile($)
  await refreshStatus($)
}

async function refreshStatus($: any) {
  if (!hubUp) {
    $.ui.status('◌ Helm offline')
    return
  }
  try {
    const [{ agents }, { tasks }] = await Promise.all([
      hub($, 'GET', `/v1/sessions/${sessionId}/agents`),
      hub($, 'GET', `/v1/tasks?sessionId=${encodeURIComponent(sessionId)}`),
    ])
    const running = (agents as any[]).filter(a => a.status === 'running').length
    const review = (tasks as any[]).filter(t => t.status === 'review').length
    const blocked = (tasks as any[]).filter(t => t.status === 'blocked').length
    const bits = [`${running} running`, `${review} review`]
    if (blocked) bits.push(`${blocked} blocked`)
    $.ui.status(`◉ Helm  ${bits.join(' · ')}`)
  } catch {}
}

async function pollInbox($: any) {
  if (polling || !hubUp) return
  polling = true
  try {
    const { notes } = await hub($, 'GET', `/v1/sessions/${sessionId}/inbox`)
    // Never await delivery here: $.prompt.submit resolves only once the main turn is idle,
    // and awaiting it would freeze the tick (and the whole board feed) for the turn's length.
    for (const note of notes as any[]) void deliver($, note).then(() => flush($))
  } catch (err) {
    probe('inbox.error', String(err))
  } finally {
    polling = false
  }
}

async function setInflight($: any, noteId: string, on: boolean) {
  const key = `inflight:${sessionId}`
  const list = ((await $.store.get(key).catch(() => [])) as string[] | undefined) ?? []
  const next = on ? [...new Set([...list, noteId])] : list.filter(id => id !== noteId)
  await $.store.set(key, next).catch(() => {})
}

async function deliver($: any, note: any) {
  await setInflight($, note.id, true)
  try {
    if (note.target.kind === 'session') {
      const r = await $.prompt.submit({ text: withAttachments(`Helm note (${note.id}):\n${note.text}`, note), asUser: true })
      if (r?.drop) throw new Error(`dropped: ${r.drop}`)
      emit('note.result', { noteId: note.id, ok: true, via: 'prompt' })
    } else {
      const { task, agent, activity } = await hub($, 'GET', `/v1/tasks/${note.target.id}`)
      const forced = String(note.text).trimStart().startsWith('!')
      const ask = forced ? String(note.text).trimStart().slice(1).trim() : String(note.text)
      if (!forced && !(note.attachments ?? []).length && isQuestion(ask)) {
        // Cheap path: one Haiku call over the task's record instead of waking or spawning an agent.
        const record = {
          id: task.id, title: task.title, status: task.status, description: clip(task.description, 2000),
          recap: task.recap, explainer: clip(task.explainer, 1500), files: task.filesChanged,
          activity: ((activity ?? []) as any[]).slice(0, 30).reverse().map(r => `${r.kind} ${r.tool ?? ''}: ${r.summary}`),
        }
        const r = await $.model.complete({ model: 'haiku', system: ANSWER_SYSTEM, maxTokens: 200, timeoutMs: 30000, prompt: `Task record:\n${JSON.stringify(record, null, 1)}\n\nQuestion: ${ask}` })
        meter('answer', 'haiku', r.usage, { taskId: task.id, noteId: note.id })
        if (!r.isAnswered) throw new Error(`model: ${r.reason ?? 'no answer'}`)
        emit('note.result', { noteId: note.id, ok: true, via: 'answer' })
        emit('note.reply', { noteId: note.id, text: r.text.trim().slice(0, 8000) })
        await setInflight($, note.id, false)
        return
      }
      const live = agent && !String(agent.id).startsWith('pending:')
        ? ((await $.agent.list()) as any[]).find(a => a.id === agent.id && !TERMINAL.has(a.status))
        : undefined
      const text = withAttachments(`Helm note (${note.id}) from the user for task ${task.id} “${task.title}”:\n${ask}`, note)
      if (live) {
        const sent = await $.session.send({ to: { agentId: agent.id }, text })
        if (sent && sent.isDelivered === false) throw new Error(sent.reason ?? 'not delivered')
        awaitAgentReply(agent.id, note.id)
        emit('note.result', { noteId: note.id, ok: true, via: 'send_message' })
      } else {
        const recap = task.recap ? `\nPrevious result: ${task.recap.what} — ${task.recap.how}` : ''
        pendingFollowups.set(task.id, [...(pendingFollowups.get(task.id) ?? []), note.id])
        const r = await $.agent.spawn({
          subagentType: 'helm:builder',
          description: `[helm:${task.id}] follow-up`,
          prompt: `Follow-up on Helm task ${task.id}: ${task.title}\n\nOriginal brief:\n${clip(task.description, 2000)}${recap}\nFiles touched so far: ${(task.filesChanged ?? []).join(', ') || 'none'}\n\nThe user's new instruction:\n${withAttachments(ask, note)}`,
        })
        if (r?.deny) throw new Error(r.deny)
        if (r?.agentId && pendingFollowups.has(task.id)) {
          for (const id of pendingFollowups.get(task.id)!) awaitAgentReply(r.agentId, id)
          pendingFollowups.delete(task.id)
        }
        emit('note.result', { noteId: note.id, ok: true, via: 'followup_spawn', agentId: r?.agentId })
      }
    }
  } catch (err) {
    emit('note.result', { noteId: note.id, ok: false, via: null, error: clip(String(err), 300) })
  }
  await setInflight($, note.id, false)
}

// ---------- hooks ----------
export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Record<string, unknown>
  exportOpts = { on: opts.obsidianExport === true, dir: String(opts.obsidianPath ?? '') }
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      for (const t of timers.splice(0)) t.cancel()
      home = (await $.env.get('HELM_HOME')) || `${await $.env.get('HOME')}/.helm`
      sock = `${home}/helmd.sock`
      root = $.plugin.root
      sessionId = await $.session.id()
      await $.process.run(['mkdir', '-p', home]).catch(() => {})
      const saved = (await $.store.get(`outbox:${sessionId}`)) as HubEvent[] | undefined
      if (Array.isArray(saved) && saved.length) outbox = [...saved, ...outbox.filter(ev => !saved.some(s => s.seq === ev.seq))]
      seq = Math.max(seq, ...outbox.map(ev => ev.seq), Date.now() * 1000)
      // A hot reload drops in-flight deliveries. Session notes were already queued in the engine
      // by $.prompt.submit, so they will arrive; record them as delivered. Anything else: failed (retryable).
      for (const id of ((await $.store.get(`done:${sessionId}`)) as string[] | undefined) ?? []) completedAgents.add(id)
      const savedSteps = (await $.store.get(`steps:${sessionId}`)) as { agents?: [string, string][]; tasks?: [string, string][] } | undefined
      for (const [k, v] of savedSteps?.agents ?? []) stepByAgent.set(k, v)
      for (const [k, v] of savedSteps?.tasks ?? []) stepByTask.set(k, v)
      const savedReplies = (await $.store.get(`replies:${sessionId}`)) as { turns?: [string, string[]][]; agents?: [string, string[]][] } | undefined
      for (const [k, v] of savedReplies?.turns ?? []) replyTurns.set(k, v)
      for (const [k, v] of savedReplies?.agents ?? []) replyAgents.set(k, v)
      const inflight = ((await $.store.get(`inflight:${sessionId}`)) as string[] | undefined) ?? []
      for (const id of inflight) emit('note.result', { noteId: id, ok: true, via: 'prompt', error: 'confirmed after reload' })
      await $.store.set(`inflight:${sessionId}`, []).catch(() => {})
      probe('session.start', { e, sessionId, root, surface: e.surface })

      const cwd = e.cwd || (await $.session.cwd())
      const model = await $.session.model().catch(() => '')
      emit('session.started', { cwd, title: base(cwd) || 'session', model })

      await $.command.register({ name: 'helm', description: 'Helm mission control: open | join <project> | status', argumentHint: 'open | join <project> | status' }).catch(err => probe('command.error', String(err)))
      await $.tool.register({
        name: 'task',
        description: 'Helm board: create, update or list tasks for this session\'s project. Create a task before delegating it, then tag the Agent description with [helm:<id>].',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'update', 'list', 'choices'] },
            choices: { type: 'array', description: 'for action "choices": options the user can tick', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' }, effort: { type: 'string', enum: ['S', 'M', 'L'] }, value: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['title'] } },
            id: { type: 'string', description: 'task id for update, e.g. T-12' },
            title: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string', enum: ['backlog', 'next', 'in_progress', 'review', 'done', 'later', 'blocked'] },
            dependsOn: { type: 'array', items: { type: 'string' } },
          },
          required: ['action'],
        },
      }).catch(err => probe('tool.register.error', String(err)))
      await $.agent.register({ name: 'builder', description: 'Sonnet builder for one Helm task: writes code, refactors, runs tests, fixes bugs, and reports DONE/HOW/FILES/LEARNED.', prompt: BUILDER_PROMPT, model: 'sonnet' }).catch(err => probe('agent.register.error', String(err)))
      await $.agent.register({ name: 'scout', description: 'Haiku scout for one narrow Helm question: search, read, list, check. Never edits.', prompt: SCOUT_PROMPT, model: 'haiku', disallowedTools: ['Edit', 'Write', 'NotebookEdit'] }).catch(err => probe('agent.register.error', String(err)))

      // resume claimed work a previous module instance left in flight (see trackInflight)
      for (const job of ((await $.store.get(`inflight-jobs:${sessionId}`)) as any[] | undefined) ?? []) void runJob($, job)
      for (const step of ((await $.store.get(`inflight-steps:${sessionId}`)) as any[] | undefined) ?? []) void runStep($, step)
      timers.push($.clock.every(1500, () => void tick($)))
      // Persist the outbox on its own timer, so events survive a reload even if a tick is stuck.
      let savedLen = -1
      timers.push($.clock.every(2000, () => {
        if (outbox.length !== savedLen) {
          savedLen = outbox.length
          void saveOutbox($)
        }
        if (stepsDirty) {
          stepsDirty = false
          void $.store.set(`steps:${sessionId}`, { agents: [...stepByAgent], tasks: [...stepByTask] }).catch(() => {})
        }
        if (repliesDirty) {
          repliesDirty = false
          void $.store.set(`replies:${sessionId}`, { turns: [...replyTurns], agents: [...replyAgents] }).catch(() => {})
        }
      }))
      timers.push($.clock.every(10000, () => void heartbeat($)))
      void tick($).then(() => heartbeat($))
    } catch (err) {
      probe('session.start.error', String(err))
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    const reason = String(e.reason ?? 'end')
    emit('session.ended', { reason })
    if (reason === 'clear') {
      // Keep the timers: the tick rebinds to the new session id and carries the project over.
      let projectId: string | undefined
      try { projectId = hubUp ? (await hub($, 'GET', `/v1/sessions/${sessionId}/project`, undefined, 1000)).project?.id : undefined } catch {}
      rebindAfterClear = { projectId }
    } else {
      for (const t of timers.splice(0)) t.cancel()
    }
    await saveOutbox($)
    void flush($)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { ...r, sections: [...r.sections, { id: 'helm:orchestration', scope: 'session' as const, text: HELM_SECTION }] }
  })

  on('agent.spawn', async ($, e, next) => {
    const a: any = e
    let model: string | undefined = a.model
    if (!a.fork) {
      if (!model) model = MODEL_BY_TYPE[a.subagentType] ?? 'sonnet'
      if (/opus/i.test(model ?? '')) model = 'sonnet'
    }
    const r: any = await next(a.fork ? e : { ...e, model })
    try {
      probe('agent.spawn', { in: e, out: r })
      if (!r?.deny) {
        const info = { description: a.description, prompt: a.prompt, subagentType: a.subagentType, model: r?.model ?? model ?? '', at: Date.now() }
        spawnByToolUse.set(a.tool_use_id, info)
        const tag = String(a.description ?? '').match(/\[helm:(T-\d+)\]/)
        gitQueue.push({ toolUseId: a.tool_use_id, agentId: r?.agentId, cwd: a.cwd, tries: 0 })
        emit('agent.spawned', { toolUseId: a.tool_use_id, parentAgentId: a.parentAgentId, taskId: tag?.[1], subagentType: info.subagentType, model: info.model, description: clip(String(a.description ?? '').replace(/\[helm:T-\d+\]\s*/, ''), 160), prompt: clip(a.prompt, 4000) })
        if (r?.agentId && tag?.[1] && stepByTask.has(tag[1])) {
          stepByAgent.set(r.agentId, stepByTask.get(tag[1])!)
          stepsDirty = true
        }
        const followTask = String(a.description ?? '').match(/^\[helm:(T-\d+)\] follow-up/)?.[1]
        if (r?.agentId && followTask && pendingFollowups.has(followTask)) {
          for (const id of pendingFollowups.get(followTask)!) awaitAgentReply(r.agentId, id)
          pendingFollowups.delete(followTask)
        }
        if (r?.agentId) {
          toolUseByAgent.set(r.agentId, a.tool_use_id)
          emit('agent.bound', { toolUseId: a.tool_use_id, agentId: r.agentId })
        }
      }
    } catch (err) {
      probe('agent.spawn.error', String(err))
    }
    return r
  }).catch(($, e, next) => next(e))

  // TS2589: inferring this matcher over the MCP tool union is too deep for tsc; params are typed loosely.
  // @ts-ignore (needed on some tsc versions, not others)
  on('tool.call', { tool: 'mcp__helm__task' }, (async ($: any, e: any) => {
    const a: any = e
    try {
      if (!hubUp) {
        void tick($)
        return { deny: 'Helm hub is starting; try again in a few seconds.' }
      }
      await flush($)
      if (a.action === 'create') {
        const { project } = await hub($, 'GET', `/v1/sessions/${sessionId}/project`)
        const { task } = await hub($, 'POST', '/v1/tasks', { projectId: project.id, sessionId, title: a.title ?? 'Untitled', description: a.description ?? '', status: a.status ?? 'next', dependsOn: a.dependsOn ?? [] })
        // A plugin tool's result must be a string or an array (MCP content), not an object.
        return { result: `Created ${task.id} (${task.status}): ${task.title}`, context: [`Put [helm:${task.id}] at the start of the Agent description when delegating it.`] }
      }
      if (a.action === 'choices') {
        const choices = choicesFrom('```helm-choices\n' + JSON.stringify(a.choices ?? []) + '\n```') ?? []
        emit('task.choices', { taskId: a.id, choices })
        await flush($)
        return { result: `${a.id}: ${choices.length} choices shown on the card` }
      }
      if (a.action === 'update') {
        const patch: Record<string, unknown> = {}
        for (const k of ['title', 'description', 'status', 'dependsOn']) if (a[k] !== undefined) patch[k] = a[k]
        const { task } = await hub($, 'PATCH', `/v1/tasks/${a.id}`, patch)
        return { result: `${task.id} → ${task.status}` }
      }
      const { tasks } = await hub($, 'GET', `/v1/tasks?sessionId=${encodeURIComponent(sessionId)}`)
      const rows = (tasks as any[]).map(t => ({ id: t.id, title: t.title, status: t.status }))
      return { result: rows.map(t => `${t.id} [${t.status}] ${t.title}`).join('\n') || 'No tasks yet.' }
    } catch (err) {
      return { deny: `Helm hub unavailable: ${clip(String(err), 200)}` }
    }
  }) as any)

  on('tool.call', async ($, e, next) => {
    const a: any = e
    const tool = String(a.tool)
    if (tool === 'mcp__helm__task') return next(e)
    const t0 = Date.now()
    let summary = ''
    try {
      summary = summarize(a)
      if (a.agentId) {
        const list = recentTools.get(a.agentId) ?? []
        list.push(`${tool}: ${summary}`)
        recentTools.set(a.agentId, list.slice(-40))
      }
      emit('tool.called', { agentId: a.agentId, toolUseId: a.tool_use_id, tool, summary, files: filesOf(a) })
    } catch {}
    const r: any = await next(e)
    try {
      const ok = !r?.deny && !r?.isError
      if (tool === 'Agent') probe('tool.call.Agent', { in: e, out: r })
      else if (a.agentId) probe('tool.call.subagent', { agentId: a.agentId, tool, ok })
      emit('tool.finished', { agentId: a.agentId, toolUseId: a.tool_use_id, tool, ok, summary: r?.deny ? `Denied: ${clip(r.deny, 80)}` : summary, files: ok ? filesOf(a) : [], durationMs: Date.now() - t0 })
      const res = r?.result
      if (tool === 'Agent' && res?.agentId) {
        toolUseByAgent.set(res.agentId, a.tool_use_id)
        emit('agent.bound', { toolUseId: a.tool_use_id, agentId: res.agentId })
        if (res.status === 'completed') {
          const answer = (res.content ?? []).map((c: any) => c.text ?? '').join('\n')
          completeAgent(res.agentId, true, answer, res.totalTokens, answer)
        }
      }
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    emit('turn.started', {})
    try {
      // Only the main loop raises turn.start; a prompt carrying "Helm note (N-x)" will answer those notes.
      const ids = [...String(e.text ?? '').matchAll(/Helm note \((N-\d+)\)/g)].map(m => m[1]!)
      if (ids.length) {
        replyTurns.set(e.turnId, [...new Set(ids)])
        repliesDirty = true
      }
    } catch {}
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const a: any = e
    try {
      probe(a.agentId ? 'turn.complete.subagent' : 'turn.complete.main', { ...a, answer: clip(a.answer, 300) })
      if (a.agentId) {
        if (a.usage && stepByAgent.has(a.agentId)) agentUsage.set(a.agentId, a.usage)
        const ok = a.reason === 'answer'
        const tokens = a.usage ? Number(a.usage.input_tokens ?? 0) + Number(a.usage.output_tokens ?? 0) : undefined
        completeAgent(a.agentId, ok, ok ? String(a.answer ?? '') : a.reason === 'refusal' ? a.refusal?.explanation ?? 'refused' : `ended: ${a.reason}`, tokens, String(a.answer ?? ''))
      } else {
        emit('turn.completed', { ok: a.reason === 'answer', error: a.reason === 'answer' ? undefined : a.reason })
        const ids = replyTurns.get(a.turnId)
        if (ids) {
          sendReplies(ids, a.reason === 'answer' ? String(a.answer ?? '') : `(the turn ended: ${a.reason})`)
          if (a.usage) meter('note_turn', String(a.usage.model ?? 'opus'), a.usage, { noteId: ids[0] })
          replyTurns.delete(a.turnId)
        }
      }
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'helm' }, async ($, e) => {
    const [sub, ...rest] = String(e.args ?? '').trim().split(/\s+/)
    const arg = rest.join(' ')
    if (!hubUp) {
      void tick($)
      return { text: 'Helm hub is starting (or could not start: see ~/.helm/helmd.out). Try again in a few seconds.' }
    }
    void flush($)
    if (sub === 'join') {
      if (!arg) return { text: 'Usage: /helm join <project name or P-id>' }
      const { projects } = await hub($, 'GET', '/v1/state')
      const p = (projects as any[]).find(x => !x.archived && (x.id === arg || x.name.toLowerCase() === arg.toLowerCase()))
      if (!p) return { text: `No project “${arg}”. Projects: ${(projects as any[]).filter(x => !x.archived).map(x => `${x.name} (${x.id})`).join(', ')}` }
      await hub($, 'POST', `/v1/sessions/${sessionId}/join`, { projectId: p.id })
      return { text: `This session joined ${p.name} (${p.id}).` }
    }
    if (sub === 'status') {
      const { project } = await hub($, 'GET', `/v1/sessions/${sessionId}/project`)
      const { tasks } = await hub($, 'GET', `/v1/tasks?sessionId=${encodeURIComponent(sessionId)}`)
      const lines = (tasks as any[]).map(t => `${t.id}  ${t.status.padEnd(11)} ${t.title}`)
      return { text: `Helm · ${project.name} (${project.id})\n${lines.join('\n') || 'No tasks yet.'}` }
    }
    return { text: `Helm dashboard: http://localhost:${PORT}  (session ${sessionId.slice(0, 8)})` }
  })

  registerUi(on, { hub, sessionId: () => sessionId, hubUp: () => hubUp, dashboardUrl: `http://localhost:${PORT}` })
}
