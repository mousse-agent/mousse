/**
 * "Use your threads" in the service: a real `OrchestratorService`, Run Engine and effect worker over a temporary
 * profile, with a scripted provider. What a thread a bot starts is (Full access, launched by the bot's chat thread, never
 * on the bot's own model), how its messages read and which mode they run in, and every way the service itself refuses a
 * bot's thread that may not start, message or stop threads, whatever let the call get this far. The tools' side (lanes,
 * the listing, who the bot may reach, what it reads) is in botThreadTools.test.ts.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOT_MESSAGE_PREFIX, McpToolError, type AgentCreatedThread } from '../../src/mms/run/mcp/appTools'
import { agentMessageWords } from '../../src/shared/agentMessageWords'
import { AGENT_MESSAGE_MAX_HOPS } from '../../src/mms/orchestrator/OrchestratorService'
import type { PermissionMode } from '../../src/shared/permissionMode'
import type { RunSettings } from '../../src/shared/settings'
import { usageLimitError } from '../../src/mms/orchestrator/providerErrors'
import { ThreadJournal } from '../../src/mms/data/ThreadJournal'
import { BOT_THREAD_ACT_TOOLS, BOT_THREAD_READ_TOOLS } from '../../src/shared/bots/personal/manifest'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { AgentActor } from '../../src/mms/run/types'
import type { EventEmitter } from 'node:events'
import { launchedThreadsIn, watchLaunchedThreads } from '../../src/mms/bots/launchedThreads'
import { BOT_LAUNCHED_RECENT_MS, launchedActive } from '../../src/shared/bots/personal/chat'
import { appTurn } from './appToolsFixture'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

describe('a bot\'s threads in the service ("use your threads")', () => {
  let previousHome: string | undefined
  const homes: string[] = []
  const daemons: Phase6Daemon[] = []
  afterEach(async () => {
    for (const daemon of daemons.splice(0).reverse()) await daemon.stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  /**
   * A daemon whose profile default is Ask, a project, and a bot "alpha" whose chat thread holds a turn with `held` thread
   * tools (a chat turn its owner's message started holds them all). `owner`: what the bot's records say of the turn (its
   * owner's message started it, from a device held to `limit`); null, a turn no message of the owner's started.
   */
  const world = (options: { held?: readonly string[]; role?: 'activation' | 'context'; owner?: { limit?: PermissionMode } | null; script?: (input: { threadId: string; prompt: string; signal: AbortSignal }) => string | Promise<string>; runs?: Partial<RunSettings> } = {}) => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-bot-threads-'))
    previousHome ??= process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    homes.push(home)
    const pi = piAdapter((input) => options.script ? options.script(input) : `done: ${input.prompt.length}`)
    const d = phase6Daemon(home, [pi], options.runs ? { runs: options.runs } : {})
    daemons.push(d)
    d.settings.permissions = { ...d.settings.permissions, defaultMode: 'ask' }
    mkdirSync(join(home, 'project'))
    const project = d.projects.openProject(join(home, 'project'))
    const chat = d.store.createThread('alpha', project.id)
    // The bot's own model, which a thread it starts must never take.
    d.orch.setThreadModelOverride(chat.id, PI)
    const held = new Set(options.held ?? [...BOT_THREAD_READ_TOOLS, ...BOT_THREAD_ACT_TOOLS])
    // A run of a chat turn (activation): the same turn goes on in a new run after a wall or a restart.
    let actor: AgentActor = { kind: 'agent', threadId: chat.id, runId: '', toolCallId: 'call-1' }
    let activationId = ''
    let runs = 0
    const turnRun = (activation: string, runId = `run:bot-chat:${++runs}`) => {
      d.orch.appToolTurns.register(appTurn({ threadId: chat.id, runId, bot: { activationId: activation, appTools: held } as unknown as BotAuthority }))
      activationId = activation
      actor = { kind: 'agent', threadId: chat.id, runId, toolCallId: `call-${runs}` }
    }
    turnRun('act-1')
    d.orch.setBotThreads({
      roleOf: (threadId) => (threadId === chat.id ? options.role ?? 'activation' : undefined),
      botOf: (threadId) => (threadId === chat.id ? { botId: 'b1', name: 'alpha' } : undefined),
      ownerTurn: () => (options.owner === null ? undefined : options.owner ?? {})
    })
    const orch = d.orch as unknown as {
      createThreadAsAgent(input: Record<string, unknown>, options: Record<string, unknown>): Promise<AgentCreatedThread>
      sendToThreadAsAgent(threadId: string, input: { content: string; mode?: 'agent' }, options: Record<string, unknown>): Promise<{ runId: string }>
      stopRunAsAgent(threadId: string, runId: string, options: Record<string, unknown>): Promise<unknown>
      setThreadArchivedAsAgent(threadId: string, archived: boolean, options: Record<string, unknown>): Promise<unknown>
      setThreadHiddenAsAgent(threadId: string, hidden: boolean, options: Record<string, unknown>): { hidden: boolean; changed: boolean }
      showAgentAction(threadId: string, actor: AgentActor, summary: string, options?: { notice?: boolean }): void
      questions: { requestAnswers(questions: unknown, threadId: string, options: unknown): Promise<unknown>; listPendingForThread(threadId: string): unknown[] }
    }
    // A bot's requests name its chat turn, as the thread tools make them (`botRequestPrefix`).
    const create = (key: string, extra: Record<string, unknown> = {}) =>
      orch.createThreadAsAgent({ projectId: project.id, title: 'Fix login', workspace: 'project', firstMessage: 'Look at the login page.', mode: 'agent', ...extra }, { clientRequestId: `thread_create:${chat.id}:${activationId}:${key}`, actor, accessLevel: 'lineage' })
    const send = (threadId: string, key: string) => orch.sendToThreadAsAgent(threadId, { content: 'Please also check the signup page.', mode: 'agent' }, { clientRequestId: `thread_send:${chat.id}:${activationId}:${key}`, actor })
    const stop = (threadId: string, runId: string, key: string) => orch.stopRunAsAgent(threadId, runId, { clientRequestId: `thread_interrupt:${chat.id}:${key}`, actor })
    const archive = (threadId: string, archived = true) => orch.setThreadArchivedAsAgent(threadId, archived, { actor })
    const hide = (threadId: string, hidden = true) => orch.setThreadHiddenAsAgent(threadId, hidden, { actor })
    const runMode = (runId: string) => d.engine.bindingForRun(runId)?.policy.permissionMode
    const settled = (runId: string) => waitFor(() => ['completed', 'failed', 'cancelled', 'interrupted'].includes(d.engine.getRun(runId)?.status ?? ''), `run ${runId}`)
    return { home, d, pi, project, chat, get actor() { return actor }, orch, create, send, stop, archive, hide, runMode, settled, turnRun }
  }

  it('a thread it starts is an ordinary thread in Full access, launched by its chat thread, on the default model unless it names one, and its first message is the bot\'s', async () => {
    const w = world()
    const made = await w.create('c1')
    expect(made).toMatchObject({ title: 'Fix login', permissionMode: 'full', model: null, replayed: false, firstMessage: { sent: true } })
    // The profile's default is Ask: an ordinary agent's thread would run in Ask; the bot's runs in Full access.
    const stored = w.d.store.getThread(made.threadId)!
    expect(stored).toMatchObject({ projectId: w.project.id, permissionMode: 'full', createdByThreadId: w.chat.id })
    // It keeps the bot's name, so it still says who started it after the bot is renamed or deleted.
    expect(stored.startedByBot).toEqual({ botId: 'b1', name: 'alpha' })
    expect(stored.modelOverride).toBeUndefined()
    expect(w.d.store.listAllThreads().map((thread) => thread.id)).toContain(made.threadId)
    const first = made.firstMessage as { runId: string }
    await w.settled(first.runId)
    expect(w.runMode(first.runId)).toBe('full')
    const message = w.d.orch.getMessages(made.threadId).find((entry) => entry.role === 'user')!
    expect(message.content.startsWith(`${BOT_MESSAGE_PREFIX} "alpha".`)).toBe(true)
    expect(message.content).toContain('Look at the login page.')
    // The transcript row names the bot, never "an agent in" its chat thread.
    w.orch.showAgentAction(made.threadId, w.actor, 'started this thread')
    expect(w.d.orch.getMessages(made.threadId).filter((entry) => entry.role === 'system').map((entry) => entry.content)).toContain('By alpha, your bot: started this thread')
    // A model it names is the thread's (a model alone is on the default entry, never the bot's own).
    const named = await w.create('c2', { title: 'Named', model: PI.model, firstMessage: undefined, mode: undefined })
    expect(named.model).toMatchObject({ model: PI.model })
  })

  it('its message runs in the thread\'s own mode, as the owner\'s would, and is refused while a question waits there', async () => {
    const w = world()
    const full = w.d.store.createThread('Full thread', w.project.id)
    w.d.orch.setThreadPermissionMode(full.id, 'full')
    const ask = w.d.store.createThread('Ask thread', w.project.id)
    w.d.orch.setThreadPermissionMode(ask.id, 'ask')
    const toFull = await w.send(full.id, 's1')
    const toAsk = await w.send(ask.id, 's2')
    await w.settled(toFull.runId)
    await w.settled(toAsk.runId)
    expect(w.runMode(toFull.runId)).toBe('full')
    expect(w.runMode(toAsk.runId)).toBe('ask')
    expect(w.d.orch.getMessages(full.id).find((entry) => entry.role === 'user')!.content.startsWith(`${BOT_MESSAGE_PREFIX} "alpha".`)).toBe(true)
    // A question waiting in a thread is the owner's: the bot's message never answers or skips it.
    const waiting = w.d.store.createThread('Waiting', w.project.id)
    void w.orch.questions.requestAnswers([{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], waiting.id, {})
    await expect(w.send(waiting.id, 's3')).rejects.toMatchObject({ code: 'questions_pending' })
    expect(w.orch.questions.listPendingForThread(waiting.id)).toHaveLength(1)
  })

  // A bot's thread that may not start, message, stop or archive threads, whatever let the call get this far.
  const refusals: Array<[string, Parameters<typeof world>[0], (() => void) | undefined, RegExp]> = [
    ['a turn that may only read threads (the bot\'s first message, another bot\'s message)', { held: BOT_THREAD_READ_TOOLS }, undefined, /only in its own turns/],
    ['a turn that holds none of them', { held: [] }, undefined, /only in its own turns/],
    ['a consult\'s thread', { role: 'context' }, undefined, /only in its own turns/],
    ['a turn its records say may not act on threads', { owner: null }, undefined, /only in its own turns/]
  ]
  it.each(refusals)('%s starts, messages, stops and archives nothing', async (_name, options) => {
    const w = world(options)
    const target = w.d.store.createThread('Target', w.project.id)
    const before = w.d.store.listAllThreads().length
    for (const attempt of [() => w.create('r1'), () => w.send(target.id, 'r2'), () => w.stop(target.id, 'run-x', 'r3'), () => w.archive(target.id)]) {
      const error = await attempt().then(() => undefined, (failure: unknown) => failure)
      expect(error).toBeInstanceOf(McpToolError)
      expect((error as McpToolError).code).toBe('mousse_scope_denied')
    }
    expect(w.d.store.listAllThreads()).toHaveLength(before)
    expect(w.d.store.getThread(target.id)!.archivedAt).toBeUndefined()
    expect(w.pi.turns).toHaveLength(0)
  })

  // Bot/thread parity: what a thread's agent steers, queues and answers with, the bot does as itself, in the thread's own
  // mode (or its owner's device's), and only with "use your threads" held by its turn.
  const service = (w: ReturnType<typeof world>) => w.d.orch as unknown as {
    queueCommandAsAgent(threadId: string, command: Record<string, unknown>, options: Record<string, unknown>): { replayed: boolean; item?: { content: string; permissionMode?: PermissionMode; origin?: { kind: string; threadId?: string } } }
    queueSnapshot(threadId: string): { revision: string; items: Array<{ content: string; permissionMode?: PermissionMode; origin?: { kind: string; threadId?: string } }> }
    steerRunAsAgent(threadId: string, runId: string, text: string, options: Record<string, unknown>): Promise<{ status: string; reason?: string }>
    answerApprovalAsAgent(threadId: string, requestId: string, answers: Record<string, string>, options: Record<string, unknown>): { ok: boolean; reason?: string }
    scheduledCreatorLimits(caller: { threadId: string; runId: string }): { permissionCeiling: PermissionMode }
  }

  it('it queues a message in a thread as the bot, in the thread\'s own mode, and steers as itself; a turn that may only read does neither', async () => {
    const w = world()
    const target = w.d.store.createThread('Target', w.project.id)
    const s = service(w)
    // The item as queued (an idle thread takes it at once).
    const { item } = s.queueCommandAsAgent(target.id, { op: 'enqueue', content: 'Then run the tests.', mode: 'agent', expectedRevision: s.queueSnapshot(target.id).revision }, { clientRequestId: `queue_enqueue:${w.chat.id}:q1`, actor: w.actor })
    // Labelled as the bot's words, from its chat thread, with no mode narrower than the thread's own (Full access stands for it).
    expect(item!.content.startsWith(`${BOT_MESSAGE_PREFIX} "alpha".`)).toBe(true)
    expect(item).toMatchObject({ permissionMode: 'full', origin: { kind: 'agent', threadId: w.chat.id } })
    // A steer goes through to the engine as the bot's (no `bot_thread` refusal): here there is no such run to steer.
    const steered = await s.steerRunAsAgent(target.id, 'run-none', 'Use staging.', { clientRequestId: `thread_steer:${w.chat.id}:s1`, actor: w.actor })
    expect(steered.reason).not.toBe('bot_thread')
    // A steer, or a message that joins the running turn, never settles a question waiting on the owner.
    const waiting = w.d.store.createThread('Waiting', w.project.id)
    void w.orch.questions.requestAnswers([{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], waiting.id, {})
    for (const tool of ['thread_steer', 'thread_send'])
      expect(await s.steerRunAsAgent(waiting.id, 'run-none', 'Use staging.', { clientRequestId: `${tool}:${w.chat.id}:w1`, actor: w.actor, tool })).toEqual({ status: 'rejected', reason: 'questions_pending' })
    expect(w.orch.questions.listPendingForThread(waiting.id)).toHaveLength(1)
    // Its scheduled jobs run in Full access, or no wider than its owner's device; a turn that may not act gets Ask.
    expect(s.scheduledCreatorLimits({ threadId: w.chat.id, runId: w.actor.runId })).toEqual({ permissionCeiling: 'full' })

    const reader = world({ held: BOT_THREAD_READ_TOOLS })
    const other = reader.d.store.createThread('Target', reader.project.id)
    const r = service(reader)
    expect(() => r.queueCommandAsAgent(other.id, { op: 'enqueue', content: 'x', mode: 'agent', expectedRevision: r.queueSnapshot(other.id).revision }, { clientRequestId: `queue_enqueue:${reader.chat.id}:q1`, actor: reader.actor })).toThrow(/only in its own turns/)
    await expect(r.steerRunAsAgent(other.id, 'run-none', 'x', { clientRequestId: `thread_steer:${reader.chat.id}:s1`, actor: reader.actor })).rejects.toThrow(/only in its own turns/)
    // An approval waiting there stays the owner's: this turn may not answer it.
    void reader.orch.questions.requestAnswers([{ id: 'permission', prompt: 'Run it?', options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }] }], other.id, { approval: { action: 'edit', permissionKey: 'mousse:integrate', options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }] } })
    const pending = (reader.orch.questions.listPendingForThread(other.id) as Array<{ requestId: string }>)[0]!.requestId
    expect(() => r.answerApprovalAsAgent(other.id, pending, { permission: 'allow' }, { clientRequestId: `approval_respond:${reader.chat.id}:a1`, actor: reader.actor })).toThrow(/only in its own turns/)
    expect(reader.orch.questions.listPendingForThread(other.id)).toHaveLength(1)
    expect(r.queueSnapshot(other.id).items).toHaveLength(0)
  })

  it('the jobs it makes from a turn its owner\'s other device started run no wider than that device, and from a turn that may not act, in Ask', async () => {
    const limited = world({ owner: { limit: 'accept_edits' } })
    expect(service(limited).scheduledCreatorLimits({ threadId: limited.chat.id, runId: limited.actor.runId })).toEqual({ permissionCeiling: 'accept_edits' })
    const notOwner = world({ owner: null })
    expect(service(notOwner).scheduledCreatorLimits({ threadId: notOwner.chat.id, runId: notOwner.actor.runId })).toEqual({ permissionCeiling: 'ask' })
  })

  it('a turn that is not the bot\'s registered one starts nothing', async () => {
    const w = world()
    const stranger = { ...w.actor, runId: 'run:not-registered' }
    await expect(w.orch.createThreadAsAgent({ projectId: w.project.id, title: 'X', workspace: 'project' }, { clientRequestId: 'x1', actor: stranger, accessLevel: 'manage' })).rejects.toBeInstanceOf(McpToolError)
    expect(w.d.store.listAllThreads().filter((thread) => thread.createdByThreadId === w.chat.id)).toEqual([])
  })

  it('a turn another device\'s message started is held to that device: what it starts runs in that mode, and it messages no thread that runs wider', async () => {
    const w = world({ owner: { limit: 'ask' } })
    const made = await w.create('c1')
    expect(made.permissionMode).toBe('ask')
    expect(w.d.store.getThread(made.threadId)).toMatchObject({ permissionMode: 'ask' })
    const first = made.firstMessage as { runId: string }
    await w.settled(first.runId)
    expect(w.runMode(first.runId)).toBe('ask')
    const full = w.d.store.createThread('Full thread', w.project.id)
    w.d.orch.setThreadPermissionMode(full.id, 'full')
    await expect(w.send(full.id, 's1')).rejects.toMatchObject({ code: 'device_limit' })
    const ask = w.d.store.createThread('Ask thread', w.project.id)
    w.d.orch.setThreadPermissionMode(ask.id, 'ask')
    const sent = await w.send(ask.id, 's2')
    await w.settled(sent.runId)
    expect(w.runMode(sent.runId)).toBe('ask')
    expect(w.d.engine.listRuns(full.id, { limit: 5 })).toEqual([])
  })

  it('has no count per chat turn or per day: one turn starts 25 threads and sends 21 messages', async () => {
    const w = world()
    // More than a day's worth under the old daily cap, all in one chat turn.
    const starts = 25
    for (let index = 0; index < starts; index += 1) await w.create(`a${index}`, { title: `A${index}`, firstMessage: undefined, mode: undefined })
    expect(w.d.store.listAllThreads().filter((thread) => thread.createdByThreadId === w.chat.id)).toHaveLength(starts)
    const targets = Array.from({ length: 21 }, (_, index) => w.d.store.createThread(`Target ${index}`, w.project.id))
    const sent: string[] = []
    for (const [index, target] of targets.entries()) sent.push((await w.send(target.id, `m${index}`)).runId)
    expect(new Set(sent).size).toBe(targets.length)
    // Every message is a turn that runs before the daemon stops; on a busy machine they take a while.
    await waitFor(() => sent.every((runId) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(w.d.engine.getRun(runId)?.status ?? '')), 'the runs', 120_000)
  }, 180_000)

  it('its message names the bot and marks its words, whether it runs at once or waits in the queue', async () => {
    let busy = ''
    let release!: () => void
    const held = new Promise<string>((resolve) => { release = () => resolve('done late') })
    const w = world({ script: (input) => (input.threadId === busy ? held : 'done') })
    const idle = w.d.store.createThread('Idle', w.project.id)
    const target = w.d.store.createThread('Busy', w.project.id)
    busy = target.id
    const owner = await w.d.orch.send('Work on this.', false, { threadId: target.id, clientRequestId: 'owner-busy-words', awaitMode: 'ack' })
    await waitFor(() => w.d.engine.getRun(owner.runId!)?.status === 'running', "the owner's turn running")
    const atOnce = await w.send(idle.id, 'w1')
    const queued = await w.send(target.id, 'w2')
    // Waiting in the queue, as read back from it.
    const item = w.d.orch.listQueue(target.id).find((entry) => entry.origin?.kind === 'agent')!
    expect(item.origin).toMatchObject({ kind: 'agent', threadId: w.chat.id, bot: { id: 'b1', name: 'alpha' } })
    expect(agentMessageWords(item.content, item.origin)).toBe('Please also check the signup page.')
    release()
    await w.settled(atOnce.runId)
    await w.settled(owner.runId!)
    await w.settled(queued.runId)
    for (const threadId of [idle.id, target.id]) {
      const message = w.d.orch.getMessages(threadId).find((entry) => entry.role === 'user' && entry.origin)!
      // The model still reads whose words they are; the chat shows the words alone, under the bot.
      expect(message.content.startsWith(`${BOT_MESSAGE_PREFIX} "alpha".`)).toBe(true)
      expect(message.origin).toMatchObject({ kind: 'agent', threadId: w.chat.id, bot: { id: 'b1', name: 'alpha' } })
      expect(agentMessageWords(message.content, message.origin)).toBe('Please also check the signup page.')
    }
  })

  it('has no cap at once and no limit on agent messages in a row: 11 of its threads work at once, and a turn deep in a chain still starts and messages threads', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const w = world({ script: async () => { await gate; return 'done' } })
    // Its turn runs as the last agent message in a row an agent may send: an agent's next message would be refused.
    const deep = w.d.engine.store.createRun({ threadId: w.chat.id, source: 'mcp', outcome: { sentByAgent: true, agentHops: AGENT_MESSAGE_MAX_HOPS } })
    w.turnRun('act-deep', deep.runId)
    const made: AgentCreatedThread[] = []
    for (let index = 0; index < 11; index += 1) made.push(await w.create(`busy${index}`, { title: `Busy ${index}` }))
    const runs = made.map((thread) => (thread.firstMessage as { sent: true; runId: string }).runId)
    // Every one of them is working now.
    expect(runs.filter((runId) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(w.d.engine.getRun(runId)?.status ?? ''))).toHaveLength(runs.length)
    const target = w.d.store.createThread('Target', w.project.id)
    const sent = await w.send(target.id, 'deep-send')
    // Each message counts as the first agent message after the owner's: the threads it reaches go on from there.
    for (const runId of [...runs, sent.runId]) expect(w.d.engine.getRun(runId)?.outcome).toMatchObject({ sentByAgent: true, agentHops: 1 })
    release()
    await waitFor(() => [...runs, sent.runId].every((runId) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(w.d.engine.getRun(runId)?.status ?? '')), 'the runs', 120_000)
  }, 180_000)

  it('a message that joins a running turn is held to the repeat check, and a retry replays it', async () => {
    let busy = ''
    let release!: () => void
    const held = new Promise<string>((resolve) => { release = () => resolve('done late') })
    const w = world({ script: (input) => (input.threadId === busy ? held : 'done') })
    const s = service(w) as ReturnType<typeof service> & { steerRunAsAgent(threadId: string, runId: string, text: string, options: Record<string, unknown>): Promise<{ status: string; reason?: string; replayed?: boolean }> }
    const target = w.d.store.createThread('Busy', w.project.id)
    busy = target.id
    const owner = await w.d.orch.send('Work on this.', false, { threadId: target.id, clientRequestId: 'owner-busy', awaitMode: 'ack' })
    await waitFor(() => w.d.engine.getRun(owner.runId!)?.status === 'running', 'the owner\'s turn running')
    const join = (key: string) => s.steerRunAsAgent(target.id, owner.runId!, 'Use staging.', { clientRequestId: `thread_send:${w.chat.id}:${key}`, actor: w.actor })
    expect(await join('j1')).toMatchObject({ status: 'accepted', replayed: false })
    await expect(join('j2')).rejects.toMatchObject({ code: 'duplicate_message' })
    expect(await join('j1')).toMatchObject({ status: 'accepted', replayed: true })
    release()
    await w.settled(owner.runId!)
  })

  it('a note from a turn held to a device\'s limit may not direct a thread that runs wider', () => {
    const limited = world({ owner: { limit: 'ask' } })
    const direct = (w: ReturnType<typeof world>, threadId: string) => (w.d.orch as unknown as { assertBotMayDirect(threadId: string, actor: unknown): void }).assertBotMayDirect(threadId, w.actor)
    const wide = limited.d.store.createThread('Full', limited.project.id)
    limited.d.orch.setThreadPermissionMode(wide.id, 'full')
    expect(() => direct(limited, wide.id)).toThrow(expect.objectContaining({ code: 'device_limit' }))
    const narrow = limited.d.store.createThread('Ask', limited.project.id)
    limited.d.orch.setThreadPermissionMode(narrow.id, 'ask')
    expect(() => direct(limited, narrow.id)).not.toThrow()
  })

  it('a Stop is refused while a thread waits on its owner, in the words of a refused message, and stops a turn that is simply running', async () => {
    let busy = ''
    let release!: () => void
    const held = new Promise<string>((resolve) => { release = () => resolve('done late') })
    const w = world({ script: (input) => (input.threadId === busy ? held : 'done') })
    // A question waiting: refused, and the question stays.
    const waiting = w.d.store.createThread('Waiting', w.project.id)
    void w.orch.questions.requestAnswers([{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], waiting.id, {})
    expect(await w.stop(waiting.id, 'run-x', 'x1')).toEqual({ status: 'rejected', reason: 'questions_pending' })
    expect(w.orch.questions.listPendingForThread(waiting.id)).toHaveLength(1)
    // A subagent of the thread waiting on an approval: refused, and the approval still waits (a Stop would cancel it).
    const parent = w.d.store.createThread('Parent', w.project.id)
    const child = w.d.store.createThread('Child', w.project.id, undefined, { lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' } })
    w.d.engine.approvals.create({ requestId: 'child-approval', threadId: child.id, instanceId: 'pi', provider: 'pi', action: 'command', permissionKey: 'pi:command', questions: [{ id: 'permission', prompt: 'Run it?', options: [{ id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' }, { id: 'reject', label: 'Reject', decision: 'reject' }] }] } as never)
    expect(await w.stop(parent.id, 'run-z', 'x2b')).toEqual({ status: 'rejected', reason: 'questions_pending' })
    expect(w.d.engine.approvals.listPending().map((row) => row.requestId)).toContain('child-approval')
    // A turn simply running: stopped.
    const target = w.d.store.createThread('Busy', w.project.id)
    busy = target.id
    const owner = await w.d.orch.send('Work on this.', false, { threadId: target.id, clientRequestId: 'owner-busy', awaitMode: 'ack' })
    await waitFor(() => w.d.engine.getRun(owner.runId!)?.status === 'running', 'the owner\'s turn running')
    expect(await w.stop(target.id, owner.runId!, 'x3')).toMatchObject({ status: 'accepted', runId: owner.runId })
    // The line the tool writes for it is shown in the thread, naming the bot.
    w.orch.showAgentAction(target.id, w.actor, 'stopped the turn that was running', { notice: true })
    expect(w.d.orch.getMessages(target.id).filter((entry) => entry.role === 'system' && entry.kind === 'warning').map((entry) => entry.content))
      .toContain('By alpha, your bot: stopped the turn that was running')
    release()
    await w.settled(owner.runId!)
    expect(w.d.engine.getRun(owner.runId!)!.status).not.toBe('completed')
  })

  it('it archives and unarchives a thread through the app\'s own Archive, never its own chat, and never a thread still working', async () => {
    let busy = ''
    let release!: () => void
    const held = new Promise<string>((resolve) => { release = () => resolve('done late') })
    const w = world({ script: (input) => (input.threadId === busy ? held : 'done') })
    const archivedEvents: string[] = []
    w.d.orch.on('thread-archived', (payload: { threadId: string }) => archivedEvents.push(payload.threadId))
    const actions = (threadId: string) => w.d.engine.store.listEvents(threadId).filter((event) => event.type === 'agent.action').map((event) => (event.payload as { action: string; actorThreadId: string }))
    // Archived as the app's Archive does: in Archived, its pull request watch told, and the change recorded as the bot's.
    const done = w.d.store.createThread('Merged work', w.project.id)
    expect(await w.archive(done.id)).toEqual({ status: 'accepted', archived: true, changed: true })
    expect(w.d.store.getThread(done.id)!.archivedAt).toEqual(expect.any(String))
    expect(archivedEvents).toEqual([done.id])
    expect(actions(done.id)).toEqual([expect.objectContaining({ action: 'archived_thread', actorThreadId: w.chat.id })])
    // Again: already archived, nothing changes.
    expect(await w.archive(done.id)).toEqual({ status: 'accepted', archived: true, changed: false })
    // Unarchived: back in the list, nothing deleted.
    expect(await w.archive(done.id, false)).toEqual({ status: 'accepted', archived: false, changed: true })
    expect(w.d.store.getThread(done.id)!.archivedAt).toBeUndefined()
    expect(actions(done.id).map((action) => action.action)).toEqual(['archived_thread', 'unarchived_thread'])
    // Never its own chat thread.
    await expect(w.archive(w.chat.id)).rejects.toMatchObject({ code: 'mousse_scope_denied' })
    expect(w.d.store.getThread(w.chat.id)!.archivedAt).toBeUndefined()
    // A thread still working is refused, and keeps working; once its turn ends it can be archived.
    const target = w.d.store.createThread('Busy', w.project.id)
    busy = target.id
    const owner = await w.d.orch.send('Work on this.', false, { threadId: target.id, clientRequestId: 'owner-busy', awaitMode: 'ack' })
    await waitFor(() => w.d.engine.getRun(owner.runId!)?.status === 'running', 'the owner\'s turn running')
    expect(await w.archive(target.id)).toEqual({ status: 'rejected', reason: 'thread_running' })
    expect(w.d.store.getThread(target.id)!.archivedAt).toBeUndefined()
    expect(w.d.engine.getRun(owner.runId!)!.status).toBe('running')
    // So is a thread whose subagent is still working.
    const parent = w.d.store.createThread('Parent', w.project.id)
    w.d.store.createThread('Child', w.project.id, undefined, { lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' } })
    const child = w.d.store.listAllThreads().find((thread) => thread.lineage?.parentThreadId === parent.id)!
    busy = child.id
    const childRun = await w.d.orch.send('Sub work.', false, { threadId: child.id, clientRequestId: 'child-busy', awaitMode: 'ack' })
    await waitFor(() => w.d.engine.getRun(childRun.runId!)?.status === 'running', 'the subagent\'s turn running')
    expect(await w.archive(parent.id)).toEqual({ status: 'rejected', reason: 'thread_running' })
    release()
    await w.settled(owner.runId!)
    await w.settled(childRun.runId!)
    expect(w.d.engine.getRun(owner.runId!)!.status).toBe('completed')
    expect(await w.archive(target.id)).toMatchObject({ status: 'accepted', changed: true })
    expect(await w.archive(parent.id)).toMatchObject({ status: 'accepted', changed: true })
  })

  it('a thread it starts tells its chat thread as it is made, before any run does (or with no first message at all)', async () => {
    const w = world()
    const questions = w.orch.questions as unknown as EventEmitter
    const changed: string[] = []
    const unwatch = watchLaunchedThreads({ runs: w.d.engine, questions, threads: w.d.store, thread: (id) => w.d.store.getThread(id), changed: (creator) => changed.push(creator) })
    await w.create('n1', { title: 'Note', firstMessage: undefined, mode: undefined })
    expect(changed).toContain(w.chat.id)
    // A thread no thread started tells no one.
    changed.length = 0
    w.d.store.createThread('Mine', w.project.id)
    expect(changed).toEqual([])
    unwatch()
  })

  it('a thread it starts is kept out of the sidebar and listed as hidden in its chat unless it asks to show it; it hides or shows only threads it started, and each change tells its chat thread', async () => {
    const w = world()
    const questions = w.orch.questions as unknown as EventEmitter & { listPendingForThread(threadId: string): unknown[] }
    const changed: string[] = []
    const unwatch = watchLaunchedThreads({ runs: w.d.engine, questions, threads: w.d.store, thread: (id) => w.d.store.getThread(id), changed: (creator) => changed.push(creator) })
    const listed = () => launchedThreadsIn({ threads: w.d.store, engine: w.d.engine, asks: () => false }, new Set([w.chat.id]))
      .map((thread) => [thread.title, thread.hidden ?? false])
    const actions = (threadId: string) => w.d.engine.store.listEvents(threadId).filter((event) => event.type === 'agent.action').map((event) => (event.payload as { action: string }).action)
    const made = await w.create('h1', { title: 'Quick check' })
    const visible = await w.create('h2', { title: 'Big refactor', hidden: false })
    await w.settled((made.firstMessage as { runId: string }).runId)
    // Hidden from the first write, and it still runs its first message like any thread.
    expect(w.d.store.getThread(made.threadId)).toMatchObject({ hidden: true, startedByBot: { botId: 'b1', name: 'alpha' } })
    expect(w.d.store.getThread(visible.threadId)!.hidden).toBeUndefined()
    expect(w.d.engine.getRun((made.firstMessage as { runId: string }).runId)!.status).toBe('completed')
    expect(listed()).toEqual(expect.arrayContaining([['Quick check', true], ['Big refactor', false]]))
    // The bot writing in it again (thread_send) leaves it hidden: only its owner's message shows it.
    await w.settled((await w.send(made.threadId, 'h3')).runId)
    expect(w.d.store.getThread(made.threadId)!.hidden).toBe(true)
    // A retry of the same request finds the same hidden thread.
    expect(await w.create('h1', { title: 'Quick check' })).toMatchObject({ threadId: made.threadId, replayed: true })

    // Shown again, then hidden again: each a change of the thread, recorded as the bot's, and heard by its chat thread.
    let seen = changed.length
    expect(w.hide(made.threadId, false)).toEqual({ hidden: false, changed: true })
    expect(w.d.store.getThread(made.threadId)!.hidden).toBeUndefined()
    expect(changed.length).toBeGreaterThan(seen)
    expect(listed()).toEqual(expect.arrayContaining([['Quick check', false]]))
    expect(w.hide(made.threadId, false)).toEqual({ hidden: false, changed: false })
    seen = changed.length
    expect(w.hide(visible.threadId)).toEqual({ hidden: true, changed: true })
    expect(w.d.store.getThread(visible.threadId)!.hidden).toBe(true)
    expect(changed.length).toBeGreaterThan(seen)
    expect(actions(made.threadId)).toEqual(expect.arrayContaining(['unhid_thread']))
    expect(actions(visible.threadId)).toEqual(expect.arrayContaining(['hid_thread']))

    // Never a thread it did not start: its owner's own, or its own chat.
    const refusal = (attempt: () => unknown): string | undefined => {
      try {
        attempt()
        return undefined
      } catch (error) {
        return (error as McpToolError).code
      }
    }
    const owners = w.d.store.createThread('Owner work', w.project.id)
    expect(refusal(() => w.hide(owners.id))).toBe('mousse_scope_denied')
    expect(refusal(() => w.hide(w.chat.id))).toBe('mousse_scope_denied')
    expect(w.d.store.getThread(owners.id)!.hidden).toBeUndefined()
    unwatch()

    // A turn that may only read threads (the bot's first message, another bot's message) hides nothing, even a thread
    // the bot started.
    const reading = world({ held: BOT_THREAD_READ_TOOLS })
    const started = reading.d.store.createThread('Started earlier', reading.project.id, undefined, { createdByThreadId: reading.chat.id, startedByBot: { botId: 'b1', name: 'alpha' } })
    expect(refusal(() => reading.hide(started.id))).toBe('mousse_scope_denied')
    expect(reading.d.store.getThread(started.id)!.hidden).toBeUndefined()
  })

  it('when "use your threads" goes, its messages still waiting in a queue are withdrawn with a line in the thread, and never run', async () => {
    let busy = ''
    let release!: () => void
    const held = new Promise<string>((resolve) => { release = () => resolve('done late') })
    const w = world({ script: (input) => (input.threadId === busy && !input.prompt.includes('Please also check') ? held : 'done') })
    const target = w.d.store.createThread('Busy', w.project.id)
    w.d.orch.setThreadPermissionMode(target.id, 'full')
    busy = target.id
    const owner = await w.d.orch.send('Work on this.', false, { threadId: target.id, clientRequestId: 'owner-busy', awaitMode: 'ack' })
    await waitFor(() => w.d.engine.getRun(owner.runId!)?.status === 'running', 'the owner\'s turn running')
    // A thread its message already ran in: nothing waits there, and the withdrawal never reads its queue.
    const done = w.d.store.createThread('Done', w.project.id)
    await w.settled((await w.send(done.id, 'd1')).runId)
    const queued = await w.send(target.id, 'q1')
    expect(queued).toMatchObject({ queued: true })
    const queues = vi.spyOn(w.d.orch as unknown as { mutateQueue: (threadId: string, change: unknown) => unknown }, 'mutateQueue')
    expect(w.d.orch.withdrawBotThreadMessages({ homeThreadId: w.chat.id, name: 'alpha' })).toBe(1)
    expect(queues.mock.calls.map(([threadId]) => threadId)).toEqual([target.id])
    queues.mockRestore()
    // Shown in the thread as Mousse's own line (a `warning` row is drawn; Mousse's other system rows are not).
    expect(w.d.orch.getMessages(target.id).filter((entry) => entry.role === 'system' && entry.kind === 'warning').map((entry) => entry.content))
      .toContain('Withdrawn: a message from alpha, your bot, that had not started. It no longer has "Use your threads".')
    release()
    await w.settled(owner.runId!)
    await w.settled(queued.runId)
    expect(w.d.engine.getRun(queued.runId)!.status).toBe('cancelled')
    // Only the owner's turn ran there; nothing more is withdrawn.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(w.pi.turns.filter((turn) => turn.threadId === target.id)).toHaveLength(1)
    expect(w.d.orch.withdrawBotThreadMessages({ homeThreadId: w.chat.id, name: 'alpha' })).toBe(0)
  })

  it('a thread it starts is what it manages while its run works, waits on the owner while it asks, and is listed as done once it ends; each change tells its chat thread', async () => {
    let release: (() => void) | undefined
    const w = world({ script: (input) => (input.prompt.includes('Look at the login page.') ? new Promise<string>((resolve) => { release = () => resolve('done') }) : 'done') })
    const questions = w.orch.questions as unknown as EventEmitter & { listPendingForThread(threadId: string): Array<{ requestId: string }>; dismiss(requestId: string): boolean }
    const changed: string[] = []
    const unwatch = watchLaunchedThreads({ runs: w.d.engine, questions, threads: w.d.store as unknown as EventEmitter, thread: (id) => w.d.store.getThread(id), changed: (creator) => changed.push(creator) })
    const managed = (creators: string[]) => launchedThreadsIn({
      threads: w.d.store,
      engine: w.d.engine,
      asks: (id) => questions.listPendingForThread(id).length > 0,
      projectName: (id) => (id === w.project.id ? 'Shop' : undefined)
    }, new Set(creators))
    const made = await w.create('c1')
    await waitFor(() => release !== undefined, 'the launched thread\'s turn')
    expect(managed([w.chat.id])).toEqual([{ threadId: made.threadId, title: 'Fix login', project: 'Shop', status: 'running', hidden: true, startedAt: expect.any(String), updatedAt: expect.any(String) }])
    // Another thread's launches are not this bot's.
    expect(managed(['another-thread'])).toEqual([])
    expect(changed.length).toBeGreaterThan(0)
    expect(new Set(changed)).toEqual(new Set([w.chat.id]))

    // A question in it waits on the owner: the line says so, and goes back to working once it is answered.
    let seen = changed.length
    void w.orch.questions.requestAnswers([{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], made.threadId, {}).catch(() => undefined)
    expect(managed([w.chat.id])[0]?.status).toBe('needs_input')
    expect(changed.length).toBeGreaterThan(seen)
    seen = changed.length
    questions.dismiss(questions.listPendingForThread(made.threadId)[0]!.requestId)
    expect(managed([w.chat.id])[0]?.status).toBe('running')
    expect(changed.length).toBeGreaterThan(seen)

    // Its run ends: it is listed as done, no longer keeping the bot busy, and the chat thread hears it.
    seen = changed.length
    release!()
    await w.settled((made.firstMessage as { runId: string }).runId)
    expect(managed([w.chat.id]).map((thread) => [thread.threadId, thread.status, launchedActive(thread)])).toEqual([[made.threadId, 'done', false]])
    expect(changed.length).toBeGreaterThan(seen)

    // A queued run with no turn.start yet waits on the message queue: the bot still manages it. Once its turn.start
    // came and went and nothing started it, the thread sits idle, so the bot does not manage it.
    const stray = await w.d.engine.dispatch({ kind: 'send', threadId: made.threadId, clientRequestId: 'stray-send', source: 'mcp' })
    const strayRunId = (stray as { runId: string }).runId
    expect(w.d.engine.getRun(strayRunId)!.status).toBe('queued')
    expect(managed([w.chat.id]).map((thread) => [thread.status, launchedActive(thread)])).toEqual([['queued', true]])
    const start = w.d.engine.outbox.enqueue({ threadId: made.threadId, runId: strayRunId, kind: 'turn.start', payload: {} })
    expect(managed([w.chat.id]).map((thread) => [thread.status, launchedActive(thread)])).toEqual([['queued', true]])
    w.d.engine.outbox.cancel(start.effectId, new Date().toISOString(), 'test: the start died')
    expect(w.d.engine.getRun(strayRunId)!.status).toBe('queued')
    expect(managed([w.chat.id]).map((thread) => [thread.threadId, launchedActive(thread)])).toEqual([[made.threadId, false]])

    // A question left open would keep it busy, until the thread is archived: an archived thread is never managed,
    // whatever it left behind, and archiving it tells the chat thread.
    void w.orch.questions.requestAnswers([{ id: 'q2', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], made.threadId, {}).catch(() => undefined)
    expect(managed([w.chat.id]).map((thread) => [thread.status, launchedActive(thread)])).toEqual([['needs_input', true]])
    seen = changed.length
    await w.archive(made.threadId)
    expect(w.d.store.getThread(made.threadId)?.archivedAt).toBeTruthy()
    expect(managed([w.chat.id]).map((thread) => [thread.threadId, launchedActive(thread)])).toEqual([[made.threadId, false]])
    expect(changed.length).toBeGreaterThan(seen)
    // Its Recent list leaves the archived thread out at once; unarchived, it is back.
    const recent = () => launchedThreadsIn({ threads: w.d.store, engine: w.d.engine, asks: () => false }, new Set([w.chat.id]), { doneSince: new Date(Date.now() - BOT_LAUNCHED_RECENT_MS).toISOString() })
      .map((thread) => thread.threadId)
    expect(recent()).toEqual([])
    await w.archive(made.threadId, false)
    expect(recent()).toEqual([made.threadId])
    unwatch()
  })
  it('a thread it starts that a usage limit paused keeps it busy while the pause ends by itself, and is on hold for the owner, not managed, once only Resume now ends it; each change tells its chat thread', async () => {
    let limited = true
    const w = world({
      runs: { resumeAfterUsageLimit: true },
      script: (input) => {
        if (!input.prompt.includes('Look at the login page.') || !limited) return 'done'
        throw usageLimitError({ provider: 'openai', resetsAt: new Date(Date.now() + 3_600_000).toISOString(), estimated: false, limitKind: 'five_hour' })
      }
    })
    const questions = w.orch.questions as unknown as EventEmitter & { listPendingForThread(threadId: string): unknown[] }
    const changed: string[] = []
    const unwatch = watchLaunchedThreads({ runs: w.d.engine, questions, threads: w.d.store as unknown as EventEmitter, thread: (id) => w.d.store.getThread(id), changed: (creator) => changed.push(creator) })
    const managed = () => launchedThreadsIn({ threads: w.d.store, engine: w.d.engine, asks: (id) => questions.listPendingForThread(id).length > 0 }, new Set([w.chat.id]))
      .map((thread) => [thread.title, thread.status, launchedActive(thread)])
    const made = await w.create('c1')
    const first = (made.firstMessage as { runId: string }).runId
    await waitFor(() => w.d.engine.getRun(first)?.status === 'paused', 'the usage limit to pause the run')
    // Its timer resumes it at the reset: it still works, and so does the owner's message waiting behind the pause.
    expect(managed()).toEqual([['Fix login', 'paused', true]])
    const behind = await w.d.orch.send('And the signup page.', false, { threadId: made.threadId, clientRequestId: 'owner-behind' })
    expect(behind).toMatchObject({ queued: true, heldByPause: true })
    expect(managed()).toEqual([['Fix login', 'paused', true]])

    // Mousse was off past the reset: the timer is dropped and only Resume now continues it. On hold, not managed.
    let seen = changed.length
    w.d.engine.endPause(first, 'stale')
    expect(managed()).toEqual([['Fix login', 'on_hold', false]])
    expect(changed.length).toBeGreaterThan(seen)

    // Resume now: it works again, and once the continue turn and the waiting message have run it is done.
    limited = false
    seen = changed.length
    w.d.engine.requestResume(first, true)
    w.d.orch.notifyEffects()
    expect(managed()).toEqual([['Fix login', 'paused', true]])
    await waitFor(() => !w.d.engine.store.hasNonTerminalRun(made.threadId), 'the resumed thread to finish')
    expect(managed()).toEqual([['Fix login', 'done', false]])
    expect(changed.length).toBeGreaterThan(seen)

    // With automatic resume off, a usage limit puts a new thread straight on hold.
    w.d.settings.runs = { ...w.d.settings.runs, resumeAfterUsageLimit: false }
    limited = true
    const second = await w.create('c2', { title: 'Fix signup' })
    await waitFor(() => w.d.engine.getRun((second.firstMessage as { runId: string }).runId)?.status === 'paused', 'the second thread to pause')
    expect(managed()).toEqual([['Fix signup', 'on_hold', false], ['Fix login', 'done', false]])
    unwatch()
  })

  it('a thread it starts whose owner pressed Stop with a message waiting is on hold for the owner, not managed, until the message is sent', async () => {
    let release: (() => void) | undefined
    const w = world({
      script: (input) => input.prompt.includes('Look at the login page.')
        ? new Promise<string>((resolve) => { release = () => resolve('done'); input.signal.addEventListener('abort', () => resolve(''), { once: true }) })
        : 'done'
    })
    const questions = w.orch.questions as unknown as EventEmitter & { listPendingForThread(threadId: string): unknown[] }
    const changed: string[] = []
    const unwatch = watchLaunchedThreads({ runs: w.d.engine, questions, threads: w.d.store as unknown as EventEmitter, thread: (id) => w.d.store.getThread(id), changed: (creator) => changed.push(creator) })
    const managed = () => launchedThreadsIn({ threads: w.d.store, engine: w.d.engine, asks: () => false }, new Set([w.chat.id]))
      .map((thread) => [thread.status, launchedActive(thread)])
    const made = await w.create('c1')
    const first = (made.firstMessage as { runId: string }).runId
    await waitFor(() => release !== undefined, 'the launched thread\'s turn')
    const waiting = await w.d.orch.send('And the signup page.', false, { threadId: made.threadId, clientRequestId: 'owner-queued' })
    expect(waiting.queued).toBe(true)
    expect(managed()).toEqual([['running', true]])

    // The owner's Stop holds the waiting message for Send now: nothing in the thread moves by itself.
    const seen = changed.length
    await w.d.orch.stopThread(made.threadId, 'user')
    await w.settled(first)
    expect(w.d.engine.getRun(waiting.runId!)?.status).toBe('queued')
    expect(w.d.store.loadMessageQueue(made.threadId).find((item) => item.runId === waiting.runId)?.heldAfterStop).toBe(true)
    expect(managed()).toEqual([['on_hold', false]])
    expect(changed.length).toBeGreaterThan(seen)

    // Send now: the message runs, and the thread is done.
    expect(w.d.orch.promoteQueueItem(made.threadId, waiting.queueItem!.id)).toEqual({ ok: true })
    await w.settled(waiting.runId!)
    expect(managed()).toEqual([['done', false]])
    unwatch()
  })

  it('a thread it starts whose worktree waits on recovery, with messages queued behind its turn, is on hold for the owner, not managed, and the line says so once the queue stops', async () => {
    let release: (() => void) | undefined
    let dirOf: (threadId: string) => string = () => ''
    // The turn ends with an Undo of Mousse's own left unfinished: the thread waits on workspace recovery.
    const w = world({
      script: async (input) => {
        if (!input.prompt.includes('Look at the login page.')) return 'done'
        await new Promise<void>((resolve) => { release = resolve })
        new ThreadJournal(dirOf(input.threadId)).append({ operationId: 'undo-1', operationType: 'undo', state: 'recovery_required', details: { error: 'Error: the undo stopped' } })
        return 'done'
      }
    })
    dirOf = (id) => w.d.store.getThreadDir(id)
    const repo = join(w.home, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
    writeFileSync(join(repo, 'README'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    const project = w.d.projects.openProject(repo)
    const questions = w.orch.questions as unknown as EventEmitter & { listPendingForThread(threadId: string): unknown[] }
    const managed = () => launchedThreadsIn({ threads: w.d.store, engine: w.d.engine, asks: () => false }, new Set([w.chat.id]))
      .map((thread) => [thread.status, launchedActive(thread)])
    // What the bot's summary reads at each refresh.
    const refreshes: unknown[][] = []
    const unwatch = watchLaunchedThreads({ runs: w.d.engine, questions, threads: w.d.store as unknown as EventEmitter, thread: (id) => w.d.store.getThread(id), changed: () => refreshes.push(managed()) })
    const made = await w.create('c1', { projectId: project.id, workspace: 'new_worktree' })
    await waitFor(() => release !== undefined, 'the launched thread\'s turn')
    const second = await w.d.orch.send('Second', false, { threadId: made.threadId, clientRequestId: 'owner-second' })
    const third = await w.d.orch.send('Third', false, { threadId: made.threadId, clientRequestId: 'owner-third' })
    expect([second.queued, third.queued]).toEqual([true, true])
    release!()
    await w.settled((made.firstMessage as { runId: string }).runId)
    // The next message's turn is refused and goes back to the queue, which stops there; both runs stay queued.
    await waitFor(() => w.d.engine.outbox.listForRun(second.runId!).some((effect) => effect.kind === 'turn.start' && !['pending', 'running'].includes(effect.status)), 'the refused turn')
    await waitFor(() => w.d.store.loadMessageQueue(made.threadId).every((item) => item.state === 'pending'), 'the message back in the queue')
    expect([w.d.engine.getRun(second.runId!)?.status, w.d.engine.getRun(third.runId!)?.status]).toEqual(['queued', 'queued'])
    expect(managed()).toEqual([['on_hold', false]])
    // The refused turn changes no run's status: the summary is read again when the queue stops.
    await waitFor(() => JSON.stringify(refreshes.at(-1)) === JSON.stringify([['on_hold', false]]), 'a refresh once the queue stopped')
    unwatch()
  })
})
