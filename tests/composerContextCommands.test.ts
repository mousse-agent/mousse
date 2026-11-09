/**
 * The composer's `/clear` and `/compact` under the real orchestrator and Run Engine, with an ACP agent
 * that keeps its own sessions: what the agent is sent after each.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'
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
  return { orch, thread, sessions, prompts, send, harness, store }
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
