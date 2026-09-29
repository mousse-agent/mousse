/**
 * A thread admits exactly one main turn at a time. Admission is taken synchronously and held
 * until the whole turn (including the post-turn phase) settles, and queued messages still
 * drain afterwards.
 */
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { HeadlessAgentRunner } from '../src/mms/terminals/HeadlessAgentRunner'
import type { MacroEngine } from '../src/mms/macros/MacroEngine'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { getDefaultSettings } from '../src/shared/settings'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('per-thread turn admission', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService
  let inFlight: number
  let maxInFlight: number
  let chatCalls: string[]
  let chatGate: Promise<void>

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-admit-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = new OrchestratorService(
      new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(), new HeadlessAgentRunner(),
      { listProviders: () => [] } as unknown as MacroEngine, { get: () => getDefaultSettings() } as never, {} as never
    )
    orch.setThreadStore(store)
    inFlight = 0; maxInFlight = 0; chatCalls = []
    chatGate = Promise.resolve()
    ;(orch as any).llm = {
      getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'probe' }),
      getContextInputs: async () => ({ systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 'probe-sig' }),
      generateTitle: async () => 'Probe Title',
      chat: async (messages: Array<{ content?: unknown }>) => {
        inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight)
        chatCalls.push(JSON.stringify(messages.at(-1)?.content ?? ''))
        await chatGate
        await new Promise((r) => setTimeout(r, 30))
        inFlight -= 1
        return {
          text: 'reply', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, modelName: 'probe',
          totalResponseTimeMs: 1, totalTokensUsed: 2, tokensPerSecond: undefined,
          contextInputs: { signature: 'probe-sig' }, toolEvents: [], aborted: false, nativeMessages: []
        }
      }
    }
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  const settled = (threadId: string): boolean => !orch.isConversationHistoryBusy(threadId)

  it('queues a second send that arrives before the first turn reaches activeTurn, then drains it', async () => {
    const thread = store.createThread('A')
    // Simulate the awaits (recovery, workspace resolution) that precede activeTurn assignment.
    const realExecute = (orch as any).executeTurn.bind(orch)
    const gate = deferred()
    ;(orch as any).executeTurn = async (...args: unknown[]) => { await gate.promise; return realExecute(...args) }

    const first = orch.send('msg-a', false, { threadId: thread.id })
    const second = await orch.send('msg-b', false, { threadId: thread.id })
    expect(second.queued).toBe(true)
    expect(inFlight).toBe(0)

    gate.resolve()
    const firstResult = await first
    expect(firstResult.queued).not.toBe(true)
    await waitFor(() => chatCalls.length === 2 && settled(thread.id))

    expect(maxInFlight).toBe(1)
    const contents = orch.getMessages(thread.id).map((m) => m.content)
    expect(contents).toContain('msg-a')
    expect(contents).toContain('msg-b')
    expect(existsSync(join(store.getThreadDir(thread.id), 'execution.lease'))).toBe(false)
  }, 30_000)

  it('honors a stop that arrives after admission but before the turn starts running', async () => {
    const thread = store.createThread('E')
    const realExecute = (orch as any).executeTurn.bind(orch)
    const gate = deferred()
    ;(orch as any).executeTurn = async (...args: unknown[]) => { await gate.promise; return realExecute(...args) }

    const signalsAtCall: boolean[] = []
    ;(orch as any).llm.chat = ((real) => async (messages: never, onEvent: never, opts?: { signal?: AbortSignal }) => {
      signalsAtCall.push(Boolean(opts?.signal?.aborted))
      return real(messages, onEvent, opts as never)
    })((orch as any).llm.chat)

    const first = orch.send('msg-a', false, { threadId: thread.id })
    await waitFor(() => orch.isActiveTurnRunning(thread.id))
    expect(orch.abortActiveTurn(thread.id)).toBe(true)

    gate.resolve()
    await first
    await waitFor(() => settled(thread.id))
    // The model client receives an already-aborted signal, so a real provider call ends immediately.
    expect(signalsAtCall.every(Boolean)).toBe(true)
    const session = (orch as any).sessions.get(thread.id) ?? (orch as any).boundSession
    expect(session.abortRequested).toBe(false)
    expect(existsSync(join(store.getThreadDir(thread.id), 'execution.lease'))).toBe(false)
  }, 30_000)

  it('executes exactly one of two simultaneous sends and queues the other', async () => {
    const thread = store.createThread('B')
    const [r1, r2] = await Promise.all([
      orch.send('msg-1', false, { threadId: thread.id }),
      orch.send('msg-2', false, { threadId: thread.id })
    ])
    expect([r1.queued === true, r2.queued === true].filter(Boolean)).toHaveLength(1)
    await waitFor(() => chatCalls.length === 2 && settled(thread.id))
    expect(maxInFlight).toBe(1)
  }, 30_000)

  it('queues a send that arrives while a channel turn is admitted, and clears admission afterwards', async () => {
    const thread = store.createThread('D')
    const realExecute = (orch as any).executeTurn.bind(orch)
    const gate = deferred()
    ;(orch as any).executeTurn = async (...args: unknown[]) => { await gate.promise; return realExecute(...args) }

    const channel = orch.runChannelTurn(thread.id, 'from-channel', store)
    await waitFor(() => orch.isActiveTurnRunning(thread.id))
    const during = await orch.send('msg-b', false, { threadId: thread.id })
    expect(during.queued).toBe(true)
    expect(inFlight).toBe(0)

    gate.resolve()
    const result = await channel
    expect(result.error).toBeUndefined()
    // Channel turns never chain queue drains; the queued message stays durable for the next drain.
    expect(maxInFlight).toBe(1)
    expect(chatCalls).toHaveLength(1)
    expect(orch.isActiveTurnRunning(thread.id)).toBe(false)
  }, 30_000)

  it('queues a send that arrives during the post-turn phase and drains it afterwards', async () => {
    const thread = store.createThread('C')
    const postTurn = deferred()
    let actionRuns = 0
    ;(orch as any).llm.chat = ((real) => async (...args: unknown[]) => {
      const result = await real(...(args as [never]))
      return chatCalls.length === 1
        ? { ...result, text: 'working\n```mousse-actions\n{"type":"message","content":"hold"}\n```' }
        : result
    })((orch as any).llm.chat)
    ;(orch as any).executeAction = async () => { actionRuns += 1; await postTurn.promise; return ['held'] }

    const first = orch.send('msg-a', false, { threadId: thread.id })
    await waitFor(() => actionRuns === 1) // model loop done: activeTurn is already cleared
    expect(inFlight).toBe(0)
    const second = await orch.send('msg-b', false, { threadId: thread.id })
    expect(second.queued).toBe(true)
    expect(chatCalls).toHaveLength(1)

    postTurn.resolve()
    await first
    await waitFor(() => chatCalls.length === 2 && settled(thread.id))
    expect(maxInFlight).toBe(1)
    expect(orch.getMessages(thread.id).map((m) => m.content)).toContain('msg-b')
  }, 30_000)
})
