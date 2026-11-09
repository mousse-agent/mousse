/**
 * The composer's `/clear` and `/compact` under the real orchestrator and Run Engine, with an ACP agent
 * that keeps its own sessions: what the agent is sent after each.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { acpDriver } from '../src/mms/harness/drivers/acp'
import { piDriver } from '../src/mms/harness/drivers/pi'
import { createHarnessGateway } from '../src/mms/harness/gateway'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { ProviderInstanceService } from '../src/mms/harness/instanceMap'
import { ProfileDatabase } from '../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../src/mms/run/EffectWorker'
import { RunEngine } from '../src/mms/run/RunEngine'
import { RunStore } from '../src/mms/run/RunStore'
import { inProcessAgent } from '../src/mms/run/testkit/acpAgent'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../src/shared/settings'
import { createNativeContext, userMessage } from '../src/mms/orchestrator/nativeContext'
import { nativeAgentAssistantMessage } from '../src/mms/providers/nativeAgentHistory'
import type { ChatMessage } from '../src/shared/types'
import { mutateDurableQueue } from '../src/mms/queue/durableQueue'
import { enqueueMessage } from '../src/mms/queue/ThreadMessageQueue'
import { getQueueHoldPath, readQueueHold } from '../src/mms/queue/queueHold'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mousse-context-commands-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const previousHome = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
  cleanups.push(() => {
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
  })

  // Each session/new opens a new native session; every prompt is recorded with the session it went to.
  const sessions: string[] = []
  const prompts: Array<{ sessionId: string; text: string }> = []
  const agent = inProcessAgent((app) => {
    app
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'echo-agent', version: '0.0.1' }, agentCapabilities: {}, authMethods: [] }))
      .onRequest(methods.agent.session.new, () => {
        const sessionId = `native-${sessions.length + 1}`
        sessions.push(sessionId)
        return { sessionId }
      })
      .onRequest(methods.agent.session.prompt, async (c) => {
        const text = c.params.prompt.map((block) => (block as { text?: string }).text ?? '').join('\n')
        prompts.push({ sessionId: c.params.sessionId, text })
        await c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `reply ${prompts.length}` } } })
        return { stopReason: 'end_turn' as const }
      })
  })

  const projects = new ProjectManager()
  const store = new ThreadDataStore(projects)
  const selection = { instanceId: 'acp:echo', llmProvider: '', model: 'default' }
  const settings = { ...getDefaultSettings(), provider: { ...getDefaultSettings().provider, ...selection }, permissions: { defaultMode: 'full' as const } }
  const orch = new OrchestratorService(
    new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(),
    { get: () => settings } as never, {} as never, undefined, undefined, undefined, undefined, undefined, projects
  )
  orch.setThreadStore(store)
  const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })), heartbeatMs: 50 })
  orch.setRunEngine(engine)
  orch.recoverRunEngineOnBoot()
  const worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
  worker.start()
  orch.attachEffectWorker(worker)
  const harness = createHarnessGateway({
    profileHome: home,
    installationHome: home,
    instanceMap: new ProviderInstanceService(),
    questions: new UserQuestionService(),
    shellPath: async () => ({ entries: [], source: 'failed' }),
    drivers: [piDriver(), acpDriver({ connect: (_context, request) => agent.connect(request), pty: { available: () => false } })]
  })
  harness.instanceMap.setEntry('acp:echo', { driver: 'acp', enabled: true, config: { displayName: 'Echo agent', binaryPath: process.execPath } })
  orch.setHarness(harness)
  cleanups.push(async () => {
    await worker.stop()
    orch.attachEffectWorker(null)
    orch.setRunEngine(null)
    engine.store.db.close()
    harness.stop()
  })

  const workspace = join(home, 'workspace')
  mkdirSync(workspace)
  const project = projects.openProject(workspace)
  const thread = store.createThread('commands', project.id, workspace)
  let sends = 0
  const send = async (text: string) => {
    const response = await orch.send(text, false, { threadId: thread.id, clientRequestId: `send-${++sends}` })
    expect(response.error).toBeUndefined()
  }
  return { orch, thread, sessions, prompts, send, harness, store, engine }
}

/** A thread long enough that Mousse's own cut would compact it. */
function longThread(orch: OrchestratorService, threadId: string) {
  const native = []
  const shown: ChatMessage[] = []
  for (let index = 0; index < 12; index += 1) {
    const question = `question ${index} ${'q'.repeat(12_000)}`
    const answer = `answer ${index} ${'a'.repeat(12_000)}`
    native.push(userMessage(question), nativeAgentAssistantMessage(answer, 'default', 'acp'))
    shown.push(
      { id: `u${index}`, role: 'user', content: question, timestamp: new Date().toISOString() },
      { id: `a${index}`, role: 'assistant', content: answer, timestamp: new Date().toISOString() }
    )
  }
  orch.replaceConversationState(threadId, shown, createNativeContext(native))
  return orch.getNativeContext(threadId)
}
/** The runtime's compaction never finishes on its own; it rejects once stopped. */
const hangs = (harness: { compactConversation: (request: { signal: AbortSignal }) => Promise<boolean> }) => {
  harness.compactConversation = (request) => new Promise<boolean>((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}
const lastRow = (orch: OrchestratorService, threadId: string) => orch.getMessagesForPersistence(threadId).at(-1)
const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('/clear', () => {
  it('starts a fresh native session with no earlier context, and keeps the transcript with a divider', async () => {
    const { orch, thread, sessions, prompts, send } = await setup()
    await send('the code word is heron')
    await send('what is the code word?')
    // This agent opens a session per turn, so the second turn carries the conversation in its prompt.
    expect(prompts[1]?.text).toContain('heron')

    orch.clearConversationContext(thread.id)
    const messages = orch.getMessagesForPersistence(thread.id)
    expect(messages.at(-1)).toMatchObject({ kind: 'context_cleared', content: 'Context cleared' })
    expect(messages.some((message) => message.content.includes('the code word is heron'))).toBe(true)

    await send('start over')
    expect(prompts.at(-1)?.sessionId).toBe(sessions.at(-1))
    expect(prompts.at(-1)?.text).toContain('start over')
    expect(prompts.at(-1)?.text).not.toContain('heron')
    expect(prompts.at(-1)?.text).not.toContain('reply 1')
  }, 30_000)
})

describe('/compact', () => {
  it('compacts Mousse\'s copy when the agent has no compaction of its own, and says so in the transcript', async () => {
    const { orch, thread, prompts, send } = await setup()
    await send('a short thread')
    // Nothing older than the recent messages to compact on a short thread.
    expect(await orch.compactConversationContext(thread.id, 'keep the plan')).toBe('unchanged')
    expect(orch.getMessagesForPersistence(thread.id).at(-1)).toMatchObject({
      kind: 'context_compaction',
      content: 'Context checked — no older messages to compact',
      streaming: false
    })
    // An unchanged context is still the whole conversation.
    await send('next')
    expect(prompts.at(-1)?.text).toContain('a short thread')
  }, 30_000)
})

describe('/compact that is stopped or runs out of time', () => {
  it('keeps the full history when a person stops it: no local cut, and the row says so', async () => {
    const { orch, thread, harness } = await setup()
    const before = longThread(orch, thread.id)
    hangs(harness as never)
    const running = orch.compactConversationContext(thread.id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(lastRow(orch, thread.id)).toMatchObject({ kind: 'context_compaction', streaming: true, compaction: { manual: true } })
    expect(orch.stopCompaction(thread.id)).toBe(true)
    expect(await running).toBe('stopped')
    const after = orch.getNativeContext(thread.id)
    expect(after.revision).toBe(before.revision)
    expect(after.activeStartIndex).toBe(before.activeStartIndex)
    expect(after.compaction).toBeUndefined()
    expect(lastRow(orch, thread.id)).toMatchObject({ content: 'Compaction stopped · full history kept', streaming: false, compaction: { manual: true, kept: 'stopped' } })
    // Nothing runs any more: a second Stop has nothing to stop.
    expect(orch.stopCompaction(thread.id)).toBe(false)
  }, 30_000)

  it('stops the same way at the time limit, and with a thread Stop', async () => {
    const { orch, thread, harness } = await setup()
    const before = longThread(orch, thread.id)
    hangs(harness as never)
    ;(orch as unknown as { nativeCompactTimeoutMs: number }).nativeCompactTimeoutMs = 30
    expect(await orch.compactConversationContext(thread.id)).toBe('stopped')
    expect(orch.getNativeContext(thread.id).revision).toBe(before.revision)
    expect(lastRow(orch, thread.id)).toMatchObject({ content: 'Compaction stopped · full history kept', compaction: { kept: 'stopped' } })

    ;(orch as unknown as { nativeCompactTimeoutMs: number }).nativeCompactTimeoutMs = 60_000
    const running = orch.compactConversationContext(thread.id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await orch.stopThread(thread.id, 'user')).ok).toBe(true)
    expect(await running).toBe('stopped')
    expect(orch.getNativeContext(thread.id).compaction).toBeUndefined()
  }, 30_000)

  it('cuts Mousse\'s copy when the runtime has no compaction, and says the sizes', async () => {
    const { orch, thread, harness } = await setup()
    longThread(orch, thread.id)
    ;(harness as unknown as { compactConversation: () => Promise<boolean> }).compactConversation = async () => false
    expect(await orch.compactConversationContext(thread.id)).toBe('compacted')
    expect(lastRow(orch, thread.id)?.content).toMatch(/^Context compacted · \d+K → \d+K$/)
    expect(orch.getNativeContext(thread.id).compaction).toBeDefined()
  }, 30_000)
})

describe('a compaction row a restart cut short', () => {
  it('is settled when the thread loads: interrupted, full history kept', async () => {
    const { orch, store } = await setup()
    const thread = store.createThread('interrupted')
    const row: ChatMessage = { id: 'compacting', role: 'assistant', kind: 'context_compaction', content: 'Compacting context…', streaming: true, compaction: { manual: true }, timestamp: new Date().toISOString() }
    store.mutateThreadData(thread.id, () => ({ messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: new Date().toISOString() }, row] }))
    const settled = { content: 'Compaction interrupted · full history kept', streaming: false, compaction: { manual: true, kept: 'interrupted' } }
    expect(orch.getMessagesForPersistence(thread.id).at(-1)).toMatchObject(settled)
    expect(store.loadThreadData(thread.id).messages.at(-1)).toMatchObject(settled)
  }, 30_000)
})

describe('a message sent while the context compacts', () => {
  /** The runtime's compaction, finished by the test: `true` (the runtime compacted), `false` (Mousse cuts its copy), or an error. */
  const controlled = (harness: { compactConversation: (request: { signal: AbortSignal }) => Promise<boolean> }) => {
    let finish!: (result: boolean | Error) => void
    harness.compactConversation = (request) => new Promise<boolean>((resolve, reject) => {
      finish = (result) => (result instanceof Error ? reject(result) : resolve(result))
      request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    return (result: boolean | Error) => finish(result)
  }
  /** `threads.compact`: the compaction is its own run, and the queue goes on once that run has ended. */
  const compactNow = (orch: OrchestratorService, engine: RunEngine, threadId: string) =>
    engine.runLocalAction({ threadId, source: 'compact' }, () => orch.compactConversationContext(threadId))
      .finally(() => orch.drainQueueAfterCompaction(threadId))
      .then((ran) => ran.result)
  const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))
  const sentWith = (prompts: Array<{ text: string }>, text: string) => prompts.find((prompt) => prompt.text.includes(text))
  /** Whether the thread's context is still the full history: no compaction recorded, nothing cut. */
  const fullHistory = (orch: OrchestratorService, threadId: string, before: { activeStartIndex?: number }) => {
    const context = orch.getNativeContext(threadId)
    return context.compaction === undefined && context.activeStartIndex === before.activeStartIndex
  }
  /** Every way the queue may be drained, each of which must leave a held queue alone. */
  const drainEverywhere = (orch: OrchestratorService, threadId: string) => {
    const internal = orch as unknown as { scheduleQueueDrain: (session: unknown) => void }
    internal.scheduleQueueDrain(orch.getOrCreateSession(threadId))
    orch.drainQueueAfterCompaction(threadId)
    orch.recoverAndDrainPendingQueues()
  }

  it('waits in the queue, from every drain, and goes with the compacted context once the compaction is done', async () => {
    const { orch, thread, harness, engine, prompts, store } = await setup()
    longThread(orch, thread.id)
    const finish = controlled(harness as never)
    const compaction = compactNow(orch, engine, thread.id)
    await until(() => lastRow(orch, thread.id)?.kind === 'context_compaction')
    // The hold is saved with the queue, for every process that drains it.
    expect(readQueueHold(store.getThreadDir(thread.id))).toMatchObject({ kind: 'compaction', ownerPid: process.pid })

    const response = await orch.send('sent while compacting', false, { threadId: thread.id, clientRequestId: 'held-1' })
    expect(response).toMatchObject({ queued: true, queueItem: { content: 'sent while compacting' } })
    drainEverywhere(orch, thread.id)
    await settle()
    expect(prompts).toHaveLength(0)
    expect(orch.listQueue(thread.id).map((item) => item.content)).toEqual(['sent while compacting'])
    expect(lastRow(orch, thread.id)).toMatchObject({ kind: 'context_compaction', streaming: true })

    finish(false)
    expect(await compaction).toBe('compacted')
    expect(existsSync(getQueueHoldPath(store.getThreadDir(thread.id)))).toBe(false)
    await until(() => Boolean(sentWith(prompts, 'sent while compacting')))
    expect(orch.getNativeContext(thread.id).compaction).toBeDefined()
    expect(orch.listQueue(thread.id)).toEqual([])
  }, 30_000)

  it('goes with the full history when the compaction stops, runs out of time or fails; the row says what happened', async () => {
    for (const ending of ['stopped', 'timed out', 'failed'] as const) {
      const { orch, thread, harness, engine, prompts } = await setup()
      const before = longThread(orch, thread.id)
      const finish = controlled(harness as never)
      if (ending === 'timed out') (orch as unknown as { nativeCompactTimeoutMs: number }).nativeCompactTimeoutMs = 400
      // The runtime compacted, then saving its result failed.
      if (ending === 'failed') vi.spyOn(orch as unknown as { clearLastTurnUsage: () => void }, 'clearLastTurnUsage').mockImplementationOnce(() => { throw new Error('disk full') })
      const compaction = compactNow(orch, engine, thread.id)
      await until(() => lastRow(orch, thread.id)?.kind === 'context_compaction')
      expect(await orch.send(`waiting (${ending})`, false, { threadId: thread.id, clientRequestId: `held-${ending}` })).toMatchObject({ queued: true })
      await settle(100)
      expect(prompts).toHaveLength(0)

      if (ending === 'stopped') expect((await orch.stopThread(thread.id, 'user')).ok).toBe(true)
      if (ending === 'failed') {
        finish(true)
        await expect(compaction).rejects.toThrow('disk full')
      } else {
        expect(await compaction).toBe('stopped')
      }
      const row = orch.getMessagesForPersistence(thread.id).find((message) => message.kind === 'context_compaction')
      expect(row).toMatchObject(ending === 'failed'
        ? { content: 'Context not compacted · disk full', compaction: { kept: 'failed' } }
        : { content: 'Compaction stopped · full history kept', compaction: { kept: 'stopped' } })

      await until(() => Boolean(sentWith(prompts, `waiting (${ending})`)))
      expect(fullHistory(orch, thread.id, before)).toBe(true)
      vi.restoreAllMocks()
    }
  }, 60_000)

  it('lifts the hold when the compaction row cannot be saved at the start, so a following send runs', async () => {
    const { orch, thread, harness, engine, prompts, store } = await setup()
    longThread(orch, thread.id)
    controlled(harness as never)
    vi.spyOn(orch as unknown as { persist: (immediate?: boolean) => void }, 'persist').mockImplementationOnce(() => { throw new Error('disk full') })
    await expect(compactNow(orch, engine, thread.id)).rejects.toThrow('disk full')
    expect(existsSync(getQueueHoldPath(store.getThreadDir(thread.id)))).toBe(false)
    // No compaction is left to stop, and a new one may start.
    expect(orch.stopCompaction(thread.id)).toBe(false)
    vi.restoreAllMocks()
    await orch.send('after the failed start', false, { threadId: thread.id, clientRequestId: 'after-failed-start' })
    await until(() => Boolean(sentWith(prompts, 'after the failed start')))
  }, 30_000)

  it('Send now on the first held message stops the compaction, cuts nothing, and sends that message first with the full history', async () => {
    const { orch, thread, harness, engine, prompts } = await setup()
    const before = longThread(orch, thread.id)
    controlled(harness as never)
    const compaction = compactNow(orch, engine, thread.id)
    await until(() => lastRow(orch, thread.id)?.kind === 'context_compaction')
    await orch.send('first held', false, { threadId: thread.id, clientRequestId: 'first' })
    await orch.send('second held', false, { threadId: thread.id, clientRequestId: 'second' })
    const [first] = orch.listQueue(thread.id)

    expect(orch.promoteQueueItemToSteer(thread.id, first!.id)).toBe(true)
    expect(await compaction).toBe('stopped')
    expect(orch.getMessagesForPersistence(thread.id).find((message) => message.kind === 'context_compaction'))
      .toMatchObject({ content: 'Compaction stopped · full history kept', compaction: { kept: 'stopped' } })

    await until(() => Boolean(sentWith(prompts, 'second held')))
    expect(prompts[0]!.text).toContain('first held')
    expect(fullHistory(orch, thread.id, before)).toBe(true)
    expect(prompts[0]!.text).not.toContain('second held')
  }, 30_000)

  it('Send now on a later held message moves it to the front before the compaction stops', async () => {
    const { orch, thread, harness, engine, prompts } = await setup()
    longThread(orch, thread.id)
    controlled(harness as never)
    const compaction = compactNow(orch, engine, thread.id)
    await until(() => lastRow(orch, thread.id)?.kind === 'context_compaction')
    await orch.send('older', false, { threadId: thread.id, clientRequestId: 'older' })
    await orch.send('picked', false, { threadId: thread.id, clientRequestId: 'picked' })
    const picked = orch.listQueue(thread.id).find((item) => item.content === 'picked')!

    expect(orch.promoteQueueItemToSteer(thread.id, picked.id)).toBe(true)
    expect(await compaction).toBe('stopped')
    await until(() => Boolean(sentWith(prompts, 'older')))
    expect(prompts[0]!.text).toContain('picked')
    expect(prompts[0]!.text).not.toContain('older')
  }, 30_000)

  it('queues a steer and leaves the compaction running', async () => {
    const { orch, thread, harness, engine, prompts } = await setup()
    longThread(orch, thread.id)
    const finish = controlled(harness as never)
    const compaction = compactNow(orch, engine, thread.id)
    await until(() => lastRow(orch, thread.id)?.kind === 'context_compaction')
    expect(orch.steerThreadOrEnqueueExternal(thread.id, 'steer while compacting', { source: 'gui-steer' })).toMatchObject({ steered: false, queued: true })
    await settle(100)
    expect(lastRow(orch, thread.id)).toMatchObject({ kind: 'context_compaction', streaming: true })
    expect(prompts).toHaveLength(0)
    finish(false)
    expect(await compaction).toBe('compacted')
    await until(() => Boolean(sentWith(prompts, 'steer while compacting')))
  }, 30_000)
})

describe('a compaction hold found at startup', () => {
  /** The thread as a daemon left it: a queued message, a compaction row still running, and the hold saved for it. */
  const leftBehind = (store: ThreadDataStore, threadId: string, owner: { pid: number; instance: string }) => {
    mutateDurableQueue(store, threadId, (items) => enqueueMessage(items, { threadId, content: 'queued before the restart', intent: 'normal', source: 'gui' }).items)
    store.mutateThreadData(threadId, () => ({ messages: [
      { id: 'u1', role: 'user', content: 'hello', timestamp: new Date().toISOString() },
      { id: 'compacting', role: 'assistant', kind: 'context_compaction', content: 'Compacting context…', streaming: true, compaction: { manual: true }, timestamp: new Date().toISOString() }
    ] }))
    writeFileSync(getQueueHoldPath(store.getThreadDir(threadId)), JSON.stringify({ kind: 'compaction', id: 'compacting', since: new Date().toISOString(), ownerPid: owner.pid, ownerInstance: owner.instance }))
  }

  it('of a daemon that is gone: the row is settled as interrupted, the hold lifts and the queue drains', async () => {
    const { orch, thread, store, prompts } = await setup()
    // A process that has exited.
    const gone = spawnSync(process.execPath, ['-e', '']).pid
    leftBehind(store, thread.id, { pid: gone, instance: 'earlier-daemon' })
    orch.recoverAndDrainPendingQueues()
    await until(() => prompts.some((prompt) => prompt.text.includes('queued before the restart')))
    expect(store.loadThreadData(thread.id).messages.find((message) => message.id === 'compacting'))
      .toMatchObject({ content: 'Compaction interrupted · full history kept', streaming: false })
    expect(existsSync(getQueueHoldPath(store.getThreadDir(thread.id)))).toBe(false)
  }, 30_000)

  it('of another process that still runs it: nothing drains and a send queues, until that compaction ends', async () => {
    const { orch, thread, store, prompts } = await setup()
    leftBehind(store, thread.id, { pid: process.ppid, instance: 'another-process' })
    orch.recoverAndDrainPendingQueues()
    expect(await orch.send('sent here meanwhile', false, { threadId: thread.id, clientRequestId: 'peer-held' })).toMatchObject({ queued: true })
    ;(orch as unknown as { scheduleQueueDrain: (session: unknown) => void }).scheduleQueueDrain(orch.getOrCreateSession(thread.id))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(prompts).toHaveLength(0)
    // Its row stays as that process left it.
    expect(store.loadThreadData(thread.id).messages.find((message) => message.id === 'compacting')).toMatchObject({ streaming: true })

    // The other process ends its compaction: it settles the row and lifts the hold; the queue goes on.
    store.mutateThreadData(thread.id, (current) => ({ messages: current.messages.map((message) => (message.id === 'compacting' ? { ...message, streaming: false, content: 'Context compacted' } : message)) }))
    rmSync(getQueueHoldPath(store.getThreadDir(thread.id)))
    orch.drainQueueAfterCompaction(thread.id)
    await until(() => prompts.some((prompt) => prompt.text.includes('sent here meanwhile')))
    expect(prompts[0]!.text).toContain('queued before the restart')
  }, 30_000)
})
