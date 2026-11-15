/**
 * "Use your threads" in the service: a real `OrchestratorService`, Run Engine and effect worker over a temporary
 * profile, with a scripted provider. What a thread a bot starts is (Full access, launched by the bot's chat thread, never
 * on the bot's own model), how its messages read and which mode they run in, and every way the service itself refuses a
 * bot's thread that may not start, message or stop threads, whatever let the call get this far. The tools' side (lanes,
 * the listing, who the bot may reach, what it reads) is in botThreadTools.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOT_MESSAGE_PREFIX, McpToolError, type AgentCreatedThread } from '../../src/mms/run/mcp/appTools'
import { THREAD_CREATE_MAX_PER_RUN, THREAD_SEND_MAX_PER_RUN } from '../../src/mms/run/mcp/appTools/thread'
import type { PermissionMode } from '../../src/shared/permissionMode'
import { BOT_THREAD_ACT_TOOLS, BOT_THREAD_READ_TOOLS } from '../../src/shared/bots/personal/manifest'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { AgentActor } from '../../src/mms/run/types'
import type { EventEmitter } from 'node:events'
import { launchedThreadsOf, watchLaunchedThreads } from '../../src/mms/bots/launchedThreads'
import { launchedActive } from '../../src/shared/bots/personal/chat'
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
  const world = (options: { held?: readonly string[]; role?: 'activation' | 'context'; owner?: { limit?: PermissionMode } | null; script?: (input: { threadId: string; prompt: string }) => string | Promise<string> } = {}) => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-bot-threads-'))
    previousHome ??= process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    homes.push(home)
    const pi = piAdapter((input) => options.script ? options.script(input) : `done: ${input.prompt.length}`)
    const d = phase6Daemon(home, [pi])
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
    const turnRun = (activation: string) => {
      const runId = `run:bot-chat:${++runs}`
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
      sendToThreadAsAgent(threadId: string, input: { content: string; mode: 'agent' | 'plan' }, options: Record<string, unknown>): Promise<{ runId: string }>
      stopRunAsAgent(threadId: string, runId: string, options: Record<string, unknown>): Promise<unknown>
      setThreadArchivedAsAgent(threadId: string, archived: boolean, options: Record<string, unknown>): Promise<unknown>
      showAgentAction(threadId: string, actor: AgentActor, summary: string, options?: { notice?: boolean }): void
      questions: { requestAnswers(questions: unknown, threadId: string, options: unknown): Promise<unknown>; listPendingForThread(threadId: string): unknown[] }
    }
    // A bot's requests name its chat turn, as the thread tools make them (`botRequestPrefix`).
    const create = (key: string, extra: Record<string, unknown> = {}) =>
      orch.createThreadAsAgent({ projectId: project.id, title: 'Fix login', workspace: 'project', firstMessage: 'Look at the login page.', mode: 'agent', ...extra }, { clientRequestId: `thread_create:${chat.id}:${activationId}:${key}`, actor, accessLevel: 'lineage' })
    const send = (threadId: string, key: string) => orch.sendToThreadAsAgent(threadId, { content: 'Please also check the signup page.', mode: 'agent' }, { clientRequestId: `thread_send:${chat.id}:${activationId}:${key}`, actor })
    const stop = (threadId: string, runId: string, key: string) => orch.stopRunAsAgent(threadId, runId, { clientRequestId: `thread_interrupt:${chat.id}:${key}`, actor })
    const archive = (threadId: string, archived = true) => orch.setThreadArchivedAsAgent(threadId, archived, { actor })
    const runMode = (runId: string) => d.engine.bindingForRun(runId)?.policy.permissionMode
    const settled = (runId: string) => waitFor(() => ['completed', 'failed', 'cancelled', 'interrupted'].includes(d.engine.getRun(runId)?.status ?? ''), `run ${runId}`)
    return { d, pi, project, chat, get actor() { return actor }, orch, create, send, stop, archive, runMode, settled, turnRun }
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
    ['a turn that may only read threads (work, a schedule, a reminder)', { held: BOT_THREAD_READ_TOOLS }, undefined, /only in its chat/],
    ['a turn that holds none of them', { held: [] }, undefined, /only in its chat/],
    ['a consult\'s thread', { role: 'context' }, undefined, /only in its chat/],
    ['a turn its records say no message of the owner\'s started', { owner: null }, undefined, /only in its chat/]
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
    expect(w.d.store.getThread(target.id)!.settledAt).toBeUndefined()
    expect(w.pi.turns).toHaveLength(0)
  })

  it('this computer\'s switch off refuses even a turn that holds every thread tool, and a turn that is not the bot\'s registered one', async () => {
    const w = world()
    w.d.settings.bots = { here: { ...w.d.settings.bots.here, threads: false } }
    await expect(w.create('off-1')).rejects.toMatchObject({ code: 'mousse_scope_denied', message: expect.stringMatching(/Not on this computer: "use your threads" is switched off here/) })
    const kept = w.d.store.createThread('Kept', w.project.id)
    await expect(w.archive(kept.id)).rejects.toMatchObject({ code: 'mousse_scope_denied', message: expect.stringMatching(/Not on this computer/) })
    expect(w.d.store.getThread(kept.id)!.settledAt).toBeUndefined()
    w.d.settings.bots = { here: { ...w.d.settings.bots.here, threads: true } }
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

  it(`counts ${THREAD_CREATE_MAX_PER_RUN} starts and ${THREAD_SEND_MAX_PER_RUN} messages a chat turn, across every run of that turn`, async () => {
    const w = world()
    const bare = { firstMessage: undefined, mode: undefined }
    for (let index = 0; index < 3; index += 1) await w.create(`a${index}`, { title: `A${index}`, ...bare })
    // The same turn goes on in a new run (after a wall, or a restart): its count goes on with it.
    w.turnRun('act-1')
    for (let index = 3; index < THREAD_CREATE_MAX_PER_RUN; index += 1) await w.create(`a${index}`, { title: `A${index}`, ...bare })
    await expect(w.create('a-over', { title: 'Over', ...bare })).rejects.toMatchObject({ code: 'mousse_conflict', message: expect.stringMatching(/the most one turn may start/) })
    // A retry of one it made takes no new place.
    await expect(w.create('a1', { title: 'A1', ...bare })).resolves.toMatchObject({ replayed: true })
    // The owner's next message is a turn of its own.
    w.turnRun('act-2')
    await expect(w.create('b0', { title: 'B0', ...bare })).resolves.toMatchObject({ replayed: false })

    w.turnRun('act-3')
    // Messages that were refused are not counted, nor reported: a thread waiting on a question refuses three.
    const waiting = w.d.store.createThread('Waiting', w.project.id)
    void w.orch.questions.requestAnswers([{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], waiting.id, {})
    for (let index = 0; index < 3; index += 1) await expect(w.send(waiting.id, `refused-${index}`)).rejects.toMatchObject({ code: 'questions_pending' })
    const targets = Array.from({ length: THREAD_SEND_MAX_PER_RUN + 1 }, (_, index) => w.d.store.createThread(`Target ${index}`, w.project.id))
    const sent: string[] = []
    for (let index = 0; index < THREAD_SEND_MAX_PER_RUN; index += 1) {
      if (index === THREAD_SEND_MAX_PER_RUN / 2) w.turnRun('act-3')
      sent.push((await w.send(targets[index]!.id, `m${index}`)).runId)
    }
    await expect(w.send(targets[THREAD_SEND_MAX_PER_RUN]!.id, 'm-over')).rejects.toMatchObject({ code: 'mousse_conflict', message: expect.stringMatching(new RegExp(`You sent ${THREAD_SEND_MAX_PER_RUN} messages to threads in this chat turn, the most one turn may send`)) })
    // Twenty turns run before the daemon stops; on a busy machine they take a while.
    await waitFor(() => sent.every((runId) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(w.d.engine.getRun(runId)?.status ?? '')), 'the twenty runs', 120_000)
  }, 180_000)

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
    const settledEvents: string[] = []
    w.d.orch.on('thread-settled', (payload: { threadId: string }) => settledEvents.push(payload.threadId))
    const actions = (threadId: string) => w.d.engine.store.listEvents(threadId).filter((event) => event.type === 'agent.action').map((event) => (event.payload as { action: string; actorThreadId: string }))
    // Archived as the app's Archive does: in Archived, its pull request watch told, and the change recorded as the bot's.
    const done = w.d.store.createThread('Merged work', w.project.id)
    expect(await w.archive(done.id)).toEqual({ status: 'accepted', archived: true, changed: true })
    expect(w.d.store.getThread(done.id)!.settledAt).toEqual(expect.any(String))
    expect(settledEvents).toEqual([done.id])
    expect(actions(done.id)).toEqual([expect.objectContaining({ action: 'archived_thread', actorThreadId: w.chat.id })])
    // Again: already archived, nothing changes.
    expect(await w.archive(done.id)).toEqual({ status: 'accepted', archived: true, changed: false })
    // Unarchived: back in the list, nothing deleted.
    expect(await w.archive(done.id, false)).toEqual({ status: 'accepted', archived: false, changed: true })
    expect(w.d.store.getThread(done.id)!.settledAt).toBeUndefined()
    expect(actions(done.id).map((action) => action.action)).toEqual(['archived_thread', 'unarchived_thread'])
    // Never its own chat thread.
    await expect(w.archive(w.chat.id)).rejects.toMatchObject({ code: 'mousse_scope_denied' })
    expect(w.d.store.getThread(w.chat.id)!.settledAt).toBeUndefined()
    // A thread still working is refused, and keeps working; once its turn ends it can be archived.
    const target = w.d.store.createThread('Busy', w.project.id)
    busy = target.id
    const owner = await w.d.orch.send('Work on this.', false, { threadId: target.id, clientRequestId: 'owner-busy', awaitMode: 'ack' })
    await waitFor(() => w.d.engine.getRun(owner.runId!)?.status === 'running', 'the owner\'s turn running')
    expect(await w.archive(target.id)).toEqual({ status: 'rejected', reason: 'thread_running' })
    expect(w.d.store.getThread(target.id)!.settledAt).toBeUndefined()
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

  it('has no daily cap: across chat turns it starts more than 20 threads in a day', async () => {
    const w = world()
    const total = 25
    for (let index = 0; index < total; index += 1) {
      // Five a chat turn: a new turn every five.
      if (index % THREAD_CREATE_MAX_PER_RUN === 0) w.turnRun(`act-day-${index}`)
      await w.create(`d${index}`, { title: `Day ${index}`, firstMessage: undefined, mode: undefined })
    }
    expect(w.d.store.listAllThreads().filter((thread) => thread.createdByThreadId === w.chat.id)).toHaveLength(total)
  })

  it('a thread it starts is what it manages while its run works, waits on the owner while it asks, and is listed as done once it ends; each change tells its chat thread', async () => {
    let release: (() => void) | undefined
    const w = world({ script: (input) => (input.prompt.includes('Look at the login page.') ? new Promise<string>((resolve) => { release = () => resolve('done') }) : 'done') })
    const questions = w.orch.questions as unknown as EventEmitter & { listPendingForThread(threadId: string): Array<{ requestId: string }>; dismiss(requestId: string): boolean }
    const changed: string[] = []
    const unwatch = watchLaunchedThreads({ runs: w.d.engine, questions, thread: (id) => w.d.store.getThread(id), changed: (creator) => changed.push(creator) })
    const managed = (creators: string[]) => launchedThreadsOf({
      creators: new Set(creators),
      threads: w.d.store.listAllThreads(),
      activeRuns: w.d.engine.store.listNonTerminalRuns(),
      lastRun: (id) => w.d.engine.store.listRuns(id, { limit: 1 })[0],
      asks: (id) => questions.listPendingForThread(id).length > 0,
      projectName: (id) => (id === w.project.id ? 'Shop' : undefined)
    })
    const made = await w.create('c1')
    await waitFor(() => release !== undefined, 'the launched thread\'s turn')
    expect(managed([w.chat.id])).toEqual([{ threadId: made.threadId, title: 'Fix login', project: 'Shop', status: 'running', startedAt: expect.any(String), updatedAt: expect.any(String) }])
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
    unwatch()
  })
})
