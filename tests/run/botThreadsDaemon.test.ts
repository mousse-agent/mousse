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
import { BOT_THREAD_STARTS_PER_DAY } from '../../src/mms/run/mcp/appTools/thread'
import { BOT_THREAD_ACT_TOOLS, BOT_THREAD_READ_TOOLS } from '../../src/shared/bots/personal/manifest'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { AgentActor } from '../../src/mms/run/types'
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
   * tools (a chat turn its owner's message started holds them all).
   */
  const world = (options: { held?: readonly string[]; role?: 'activation' | 'context' } = {}) => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-bot-threads-'))
    previousHome ??= process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    homes.push(home)
    const pi = piAdapter((input) => `done: ${input.prompt.length}`)
    const d = phase6Daemon(home, [pi])
    daemons.push(d)
    d.settings.permissions = { ...d.settings.permissions, defaultMode: 'ask' }
    mkdirSync(join(home, 'project'))
    const project = d.projects.openProject(join(home, 'project'))
    const chat = d.store.createThread('alpha', project.id)
    // The bot's own model, which a thread it starts must never take.
    d.orch.setThreadModelOverride(chat.id, PI)
    const runId = 'run:bot-chat:1'
    const held = new Set(options.held ?? [...BOT_THREAD_READ_TOOLS, ...BOT_THREAD_ACT_TOOLS])
    d.orch.appToolTurns.register(appTurn({ threadId: chat.id, runId, bot: { activationId: 'act-1', appTools: held } as unknown as BotAuthority }))
    d.orch.setBotThreads({
      roleOf: (threadId) => (threadId === chat.id ? options.role ?? 'activation' : undefined),
      botOf: (threadId) => (threadId === chat.id ? { botId: 'b1', name: 'alpha' } : undefined)
    })
    const actor: AgentActor = { kind: 'agent', threadId: chat.id, runId, toolCallId: 'call-1' }
    const orch = d.orch as unknown as {
      createThreadAsAgent(input: Record<string, unknown>, options: Record<string, unknown>): Promise<AgentCreatedThread>
      sendToThreadAsAgent(threadId: string, input: { content: string; mode: 'agent' | 'plan' }, options: Record<string, unknown>): Promise<{ runId: string }>
      stopRunAsAgent(threadId: string, runId: string, options: Record<string, unknown>): Promise<unknown>
      showAgentAction(threadId: string, actor: AgentActor, summary: string): void
      questions: { requestAnswers(questions: unknown, threadId: string, options: unknown): Promise<unknown>; listPendingForThread(threadId: string): unknown[] }
    }
    const create = (key: string, extra: Record<string, unknown> = {}) =>
      orch.createThreadAsAgent({ projectId: project.id, title: 'Fix login', workspace: 'project', firstMessage: 'Look at the login page.', mode: 'agent', ...extra }, { clientRequestId: key, actor, accessLevel: 'lineage' })
    const send = (threadId: string, key: string) => orch.sendToThreadAsAgent(threadId, { content: 'Please also check the signup page.', mode: 'agent' }, { clientRequestId: key, actor })
    const runMode = (runId: string) => d.engine.bindingForRun(runId)?.policy.permissionMode
    const settled = (runId: string) => waitFor(() => ['completed', 'failed', 'cancelled', 'interrupted'].includes(d.engine.getRun(runId)?.status ?? ''), `run ${runId}`)
    return { d, pi, project, chat, actor, orch, create, send, runMode, settled }
  }

  it('a thread it starts is an ordinary thread in Full access, launched by its chat thread, on the default model unless it names one, and its first message is the bot\'s', async () => {
    const w = world()
    const made = await w.create('c1')
    expect(made).toMatchObject({ title: 'Fix login', permissionMode: 'full', model: null, replayed: false, firstMessage: { sent: true } })
    // The profile's default is Ask: an ordinary agent's thread would run in Ask; the bot's runs in Full access.
    const stored = w.d.store.getThread(made.threadId)!
    expect(stored).toMatchObject({ projectId: w.project.id, permissionMode: 'full', createdByThreadId: w.chat.id })
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
    // So is a plan shown for review: the owner's next message there answers it, never the bot's. Once they reply, it goes.
    const planned = w.d.store.createThread('Planned', w.project.id)
    const internals = w.d.orch as unknown as { sessionAls: { run(session: unknown, fn: () => void): void }; getOrCreateSession(id: string): unknown; presentPlanCard(payload: { title: string; markdown: string }, threadId: string): void }
    internals.sessionAls.run(internals.getOrCreateSession(planned.id), () => internals.presentPlanCard({ title: 'Plan', markdown: '1. Do it.' }, planned.id))
    await expect(w.send(planned.id, 's4')).rejects.toMatchObject({ code: 'plan_review_pending' })
    const replied = await w.d.orch.send('Not yet, change step 1.', false, { threadId: planned.id, clientRequestId: 'owner-1' })
    await w.settled(replied.runId!)
    await expect(w.send(planned.id, 's5')).resolves.toMatchObject({ runId: expect.any(String) })
  })

  // A bot's thread that may not start, message or stop threads, whatever let the call get this far.
  const refusals: Array<[string, Parameters<typeof world>[0], (() => void) | undefined, RegExp]> = [
    ['a turn that may only read threads (work, a schedule, a reminder)', { held: BOT_THREAD_READ_TOOLS }, undefined, /only in its chat/],
    ['a turn that holds none of them', { held: [] }, undefined, /only in its chat/],
    ['a consult\'s thread', { role: 'context' }, undefined, /only in its chat/]
  ]
  it.each(refusals)('%s starts, messages and stops nothing', async (_name, options) => {
    const w = world(options)
    const target = w.d.store.createThread('Target', w.project.id)
    const before = w.d.store.listAllThreads().length
    for (const attempt of [() => w.create('r1'), () => w.send(target.id, 'r2'), () => w.orch.stopRunAsAgent(target.id, 'run-x', { clientRequestId: 'r3', actor: w.actor })]) {
      const error = await attempt().then(() => undefined, (failure: unknown) => failure)
      expect(error).toBeInstanceOf(McpToolError)
      expect((error as McpToolError).code).toBe('mousse_scope_denied')
    }
    expect(w.d.store.listAllThreads()).toHaveLength(before)
    expect(w.pi.turns).toHaveLength(0)
  })

  it('this computer\'s switch off refuses even a turn that holds every thread tool, and a turn that is not the bot\'s registered one', async () => {
    const w = world()
    w.d.settings.bots = { here: { ...w.d.settings.bots.here, threads: false } }
    await expect(w.create('off-1')).rejects.toMatchObject({ code: 'mousse_scope_denied', message: expect.stringMatching(/Not on this computer: "use your threads" is switched off here/) })
    w.d.settings.bots = { here: { ...w.d.settings.bots.here, threads: true } }
    const stranger = { ...w.actor, runId: 'run:not-registered' }
    await expect(w.orch.createThreadAsAgent({ projectId: w.project.id, title: 'X', workspace: 'project' }, { clientRequestId: 'x1', actor: stranger, accessLevel: 'manage' })).rejects.toBeInstanceOf(McpToolError)
    expect(w.d.store.listAllThreads().filter((thread) => thread.createdByThreadId === w.chat.id)).toEqual([])
  })

  it(`starts at most ${BOT_THREAD_STARTS_PER_DAY} threads a day`, async () => {
    const w = world()
    for (let index = 0; index < BOT_THREAD_STARTS_PER_DAY; index += 1)
      await w.create(`d${index}`, { title: `Day ${index}`, firstMessage: undefined, mode: undefined })
    await expect(w.create('d-over', { title: 'One more', firstMessage: undefined, mode: undefined })).rejects.toMatchObject({ code: 'mousse_conflict', message: expect.stringMatching(/the most a bot may start in a day/) })
    expect(w.d.store.listAllThreads().filter((thread) => thread.createdByThreadId === w.chat.id)).toHaveLength(BOT_THREAD_STARTS_PER_DAY)
  })
})
