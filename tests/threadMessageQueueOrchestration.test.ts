// Queue behaviour through a bare OrchestratorService with a scripted model.
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { enqueueMessage, listPendingQueue } from '../src/mms/queue/ThreadMessageQueue'
import {
  claimNextNormalDurable,
  mutateDurableQueue,
  reclaimAbandonedClaimsDurable
} from '../src/mms/queue/durableQueue'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { createOrchestrator } from './run/phase6Fixture'
import { getExecutionLeasePath } from '../src/mms/queue/ThreadExecutionLease'

describe('OrchestratorService concurrent threads and queue', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-orch-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, store)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('stacks same-thread sends FIFO when busy instead of throwing', async () => {
    const thread = store.createThread('Busy')
    orch.bindThread(thread.id, [], undefined, [])

    // Simulate an active turn without invoking the LLM.
    const session = orch.getOrCreateSession(thread.id)
    session.activeTurn = { abort: new AbortController(), pendingSteer: [] }

    const result = await orch.send('hello while busy', false, { threadId: thread.id })
    expect(result.queued).toBe(true)
    expect(result.queueItem?.content).toBe('hello while busy')
    expect(orch.listQueue(thread.id)).toHaveLength(1)

    const second = await orch.send('second', false, { threadId: thread.id })
    expect(second.queued).toBe(true)
    expect(orch.listQueue(thread.id).map((i) => i.content)).toEqual([
      'hello while busy',
      'second'
    ])
  })

  it('isolates two threads with no cross-talk on messages or queue', async () => {
    const t1 = store.createThread('T1')
    const t2 = store.createThread('T2')
    orch.bindThread(t1.id, [], undefined, [])
    const s1 = orch.getOrCreateSession(t1.id)
    s1.messages.push({
      id: 'm1',
      role: 'user',
      content: 'thread-one',
      timestamp: new Date().toISOString()
    })
    s1.activeTurn = { abort: new AbortController(), pendingSteer: [] }

    orch.enqueueForThread(t1.id, 'q1')
    orch.enqueueForThread(t2.id, 'q2')

    expect(orch.getMessages(t1.id).map((m) => m.content)).toEqual(['thread-one'])
    expect(orch.getMessages(t2.id)).toEqual([])
    expect(orch.listQueue(t1.id).map((i) => i.content)).toEqual(['q1'])
    expect(orch.listQueue(t2.id).map((i) => i.content)).toEqual(['q2'])

    // Switch bound thread; t1 turn remains isolated.
    orch.bindThread(t2.id, [], undefined, orch.listQueue(t2.id))
    expect(orch.isTurnActive(t1.id)).toBe(true)
    expect(orch.isTurnActive(t2.id)).toBe(false)
    expect(orch.getMessages(t1.id).map((m) => m.content)).toEqual(['thread-one'])
  })

  it('steers an active turn without replaying as a later queue item', () => {
    const thread = store.createThread('Steer')
    orch.bindThread(thread.id, [], undefined, [])
    const session = orch.getOrCreateSession(thread.id)
    session.activeTurn = { abort: new AbortController(), pendingSteer: [] }

    const item = orch.enqueueForThread(thread.id, 'please prefer tests')
    expect(orch.promoteQueueItemToSteer(thread.id, item.id)).toBe(true)
    expect(session.activeTurn.pendingSteer).toContain('please prefer tests')
    // The promoted item stays visible as `steering` until the turn's steer
    // drain consumes its content, so abort-before-drain can't lose it and
    // the queue pill can show sticky "Steering" state.
    const retained = orch.listQueue(thread.id).find((i) => i.id === item.id)
    expect(retained?.state).toBe('steering')
    expect((orch as unknown as { drainSteerForSession: (s: unknown, t: unknown) => string | undefined }).drainSteerForSession(session, session.activeTurn)).toContain('please prefer tests')
    // Drain alone is not an acknowledgement: a crash here must leave the steer
    // recoverable. It is removed only after the native checkpoint is durable.
    expect(orch.listQueue(thread.id).find((i) => i.id === item.id)?.state).toBe('steering')
    session.nativeContext.acceptedSteerItemIds = [item.id]
    store.mutateThreadData(thread.id, () => ({ llmContext: session.nativeContext }))
    const internals = orch as unknown as { acknowledgeDrainedSteers: (s: unknown) => void }
    internals.acknowledgeDrainedSteers(session)
    expect(orch.listQueue(thread.id).find((i) => i.id === item.id)).toBeUndefined()
  })

  it('emits thread-scoped queue events', () => {
    const thread = store.createThread('Events')
    orch.bindThread(thread.id, [], undefined, [])
    const events: Array<{ threadId: string; items: { content: string }[] }> = []
    orch.on('queue-updated', (payload) => events.push(payload))

    orch.enqueueForThread(thread.id, 'e1')
    expect(events).toHaveLength(1)
    expect(events[0].threadId).toBe(thread.id)
    expect(events[0].items.map((i) => i.content)).toEqual(['e1'])
  })

  it('does not execute work for a deleted thread and clears its queue', async () => {
    const thread = store.createThread('Delete')
    orch.bindThread(thread.id, [], undefined, [])
    const session = orch.getOrCreateSession(thread.id)
    session.activeTurn = { abort: new AbortController(), pendingSteer: [] }
    orch.enqueueForThread(thread.id, 'should-not-run')

    orch.markThreadDeleted(thread.id)
    expect(orch.listQueue(thread.id)).toHaveLength(0)
    expect(session.activeTurn.abort.signal.aborted).toBe(true)

    await expect(orch.send('after delete', false, { threadId: thread.id })).rejects.toThrow(
      /deleted|not found/i
    )
  })

  it('stop/abort keeps normal queued messages by default', () => {
    const thread = store.createThread('Stop')
    orch.bindThread(thread.id, [], undefined, [])
    const session = orch.getOrCreateSession(thread.id)
    session.activeTurn = { abort: new AbortController(), pendingSteer: [] }
    orch.enqueueForThread(thread.id, 'keep-me')

    expect(orch.abortActiveTurn(thread.id)).toBe(true)
    expect(orch.listQueue(thread.id).map((i) => i.content)).toEqual(['keep-me'])
  })

  it('does not use process.chdir when resolving project cwd for turns', () => {
    const cwdBefore = process.cwd()
    const spy = vi.spyOn(process, 'chdir')
    const thread = store.createThread('Cwd')
    orch.bindThread(thread.id, [], undefined, [])
    expect(spy).not.toHaveBeenCalled()
    expect(process.cwd()).toBe(cwdBefore)
    spy.mockRestore()
  })

  it('queues a forced send durably with its source label', async () => {
    const thread = store.createThread('ForceQueue')
    orch.bindThread(thread.id, [], undefined, [])
    const result = await orch.send('from-peer', false, {
      threadId: thread.id,
      source: 'cli-peer',
      forceQueue: true
    })
    expect(result.queued).toBe(true)
    expect(result.queueItem?.source).toBe('cli-peer')
    expect(store.loadMessageQueue(thread.id).map((i) => i.content)).toContain('from-peer')
  })

  it('persists external steer intent for the active owner and drops it once', () => {
    const thread = store.createThread('ExternalSteer')
    orch.bindThread(thread.id, [], undefined, [])
    // No local turn — enqueue external steer for peer owner.
    const item = orch.enqueueExternalSteer(thread.id, 'prefer unit tests', { source: 'cli' })
    expect(item).not.toBeNull()
    expect(item!.intent).toBe('steer')
    expect(orch.listQueue(thread.id).find((i) => i.id === item!.id)?.intent).toBe('steer')

    // Active local turn drains external steers via promote/drop path.
    const session = orch.getOrCreateSession(thread.id)
    session.activeTurn = { abort: new AbortController(), pendingSteer: [] }
    expect(orch.steerThread(thread.id, 'local-fast')).toBe(true)
    expect(session.activeTurn.pendingSteer).toContain('local-fast')
  })

  it('promotes a queued GUI item for a live external owner', () => {
    const thread = store.createThread('External queue steer')
    orch.bindThread(thread.id, [], undefined, [])
    const item = orch.enqueueForThread(thread.id, 'change direction')
    vi.spyOn(orch, 'isThreadLeaseHeldExternally').mockReturnValue(true)

    expect(orch.promoteQueueItemToSteer(thread.id, item.id)).toBe(true)
    expect(store.loadMessageQueue(thread.id)).toEqual([
      expect.objectContaining({
        id: item.id,
        content: 'change direction',
        intent: 'steer',
        state: 'steering'
      })
    ])
  })

  it('holds the execution lease through final transcript persistence', async () => {
    const thread = store.createThread('Lease lifetime')
    orch.bindThread(thread.id, [], undefined, [])
    const contextInputs = {
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'test'
    }
    const llm = (orch as unknown as {
      llm: {
        getSelectedModelContextLimit: () => { limit: number }
        getContextInputs: () => Promise<typeof contextInputs>
        chat: (...args: unknown[]) => Promise<unknown>
      }
    }).llm
    vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
    vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
    const chatSpy = vi.spyOn(llm, 'chat').mockResolvedValue({
      text: 'complete',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      modelName: 'test',
      totalResponseTimeMs: 1,
      totalTokensUsed: 2,
      tokensPerSecond: 1,
      contextInputs,
      toolEvents: [],
      nativeMessages: []
    })

    const leasePath = getExecutionLeasePath(store.getThreadDir(thread.id))
    const persistedWithLease: boolean[] = []
    orch.setPersistCallback(() => persistedWithLease.push(existsSync(leasePath)))

    await orch.send('run', false, { threadId: thread.id })

    expect(persistedWithLease.length).toBeGreaterThan(0)
    expect(persistedWithLease.every(Boolean)).toBe(true)
    expect(existsSync(leasePath)).toBe(false)
    expect(chatSpy.mock.calls[0]?.[2]).toMatchObject({
      toolLoopSafety: {
        compactNativeMessages: expect.any(Function)
      }
    })
    expect(chatSpy.mock.calls[0]?.[2]?.toolLoopSafety?.compactionThresholdTokens).toBe(100_000)
  })

  it('queue drain claims FIFO and emits diagnostics instead of system messages on failure', async () => {
    const thread = store.createThread('Drain claim')
    orch.bindThread(thread.id, [], undefined, [])
    orch.enqueueForThread(thread.id, 'queued-1')
    orch.enqueueForThread(thread.id, 'queued-2')

    const failures: Array<{ threadId: string; error: string }> = []
    orch.on('queue-drain-failed', (payload) => failures.push(payload))

    // Fail during durable acceptance so executeTurn rejects and scheduleQueueDrain catches it.
    orch.setPersistCallback(() => {
      throw new Error('simulated pre-accept failure')
    })

    orch.recoverAndDrainPendingQueues()

    await vi.waitFor(() => {
      expect(failures.length).toBeGreaterThan(0)
    })

    expect(failures[0].error).toMatch(/pre-accept failure/i)
    expect(
      orch.getMessages(thread.id).some((m) => m.role === 'system' && /queue drain failed/i.test(m.content))
    ).toBe(false)

    // Pre-accept failure rolls back in-memory user message (no sticky duplicate).
    expect(orch.getMessages(thread.id).filter((m) => m.role === 'user')).toHaveLength(0)

    // Claim was released back to pending at original head (no replacement UUID at tail).
    const pending = listPendingQueue(store.loadMessageQueue(thread.id))
    expect(pending.map((i) => i.content)).toEqual(['queued-1', 'queued-2'])
  })

  it('pre-accept crash side: abandoned claim returns to pending at original order', () => {
    const thread = store.createThread('Pre-accept crash')
    mutateDurableQueue(store, thread.id, (items) => {
      let next = enqueueMessage(items, { threadId: thread.id, content: 'must-retry' }).items
      next = enqueueMessage(next, { threadId: thread.id, content: 'after' }).items
      return next
    })
    const claimedItem = claimNextNormalDurable(store, thread.id, {
      ownerPid: 2_147_000_031,
      ownerToken: 'dead-pre-accept',
      source: 'crashed'
    })
    expect(claimedItem?.content).toBe('must-retry')
    const originalOrder = claimedItem!.order

    // No transcript provenance → reclaim releases to pending at original order.
    orch.reclaimAbandonedClaimsForThread(thread.id)
    const queue = store.loadMessageQueue(thread.id)
    const restored = queue.find((i) => i.id === claimedItem!.id)
    expect(restored?.state).toBe('pending')
    expect(restored?.order).toBe(originalOrder)
    expect(listPendingQueue(queue).map((i) => i.content)).toEqual(['must-retry', 'after'])
  })

  it('queued acceptance: complete failure after durable transcript recovers without duplicate', async () => {
    const thread = store.createThread('Post-accept complete fail')
    orch.bindThread(thread.id, [], undefined, [])

    const contextInputs = {
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'post-accept'
    }
    const llm = (orch as unknown as {
      llm: {
        getSelectedModelContextLimit: () => { limit: number }
        getContextInputs: () => Promise<typeof contextInputs>
        chat: () => Promise<unknown>
      }
    }).llm
    vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
    vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
    vi.spyOn(llm, 'chat').mockResolvedValue({
      text: 'ok',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      modelName: 'test',
      totalResponseTimeMs: 1,
      totalTokensUsed: 2,
      tokensPerSecond: 1,
      contextInputs,
      toolEvents: [],
      nativeMessages: []
    })

    // Real transcript acceptance via persist; then fail the subsequent queue complete write.
    let blockCompleteWrite = false
    const realSaveQueue = store.saveMessageQueue.bind(store)
    vi.spyOn(store, 'saveMessageQueue').mockImplementation((id, queue) => {
      const accepted = store
        .loadThreadData(id)
        .messages.some((m) => m.role === 'user' && m.queueItemId && m.content === 'only-once')
      const stillClaimed = queue.some((i) => i.state === 'claimed' && i.content === 'only-once')
      if (blockCompleteWrite && accepted && !stillClaimed) {
        throw new Error('simulated complete failure after accept')
      }
      return realSaveQueue(id, queue)
    })

    orch.setPersistCallback((threadId) => {
      const id = threadId ?? thread.id
      const existing = store.loadThreadData(id)
      store.saveThreadData(id, {
        messages: orch.getMessages(id),
        agents: existing.agents,
        tasks: existing.tasks,
        llmContext: orch.getNativeContext(id),
        mousseAgentSessions: existing.mousseAgentSessions
      })
      // Next queue mutation that removes the claim is the complete write.
      if (orch.getMessages(id).some((m) => m.queueItemId && m.content === 'only-once')) {
        blockCompleteWrite = true
      }
    })

    mutateDurableQueue(store, thread.id, (items) =>
      enqueueMessage(items, { threadId: thread.id, content: 'only-once' }).items
    )

    const failures: Array<{ error: string }> = []
    orch.on('queue-drain-failed', (payload) => failures.push(payload))

    orch.recoverAndDrainPendingQueues()
    await vi.waitFor(() => {
      expect(
        store.loadThreadData(thread.id).messages.some((m) => m.content === 'only-once' && m.queueItemId)
      ).toBe(true)
    })

    // Claim may still be on disk if complete failed — recovery completes via provenance.
    blockCompleteWrite = false
    orch.reclaimAbandonedClaimsForThread(thread.id)
    expect(store.loadMessageQueue(thread.id).find((i) => i.content === 'only-once')).toBeUndefined()

    const userCount = store
      .loadThreadData(thread.id)
      .messages.filter((m) => m.role === 'user' && m.content === 'only-once').length
    expect(userCount).toBe(1)

    // Further recovery must not re-execute / re-append.
    orch.recoverAndDrainPendingQueues()
    await Promise.resolve()
    expect(
      store.loadThreadData(thread.id).messages.filter((m) => m.role === 'user' && m.content === 'only-once')
    ).toHaveLength(1)
  })

  it('startup recovery reclaims abandoned claims and drains pending work', async () => {
    const thread = store.createThread('Startup drain')
    mutateDurableQueue(store, thread.id, (items) =>
      enqueueMessage(items, { threadId: thread.id, content: 'startup-msg' }).items
    )
    // Abandoned claim without acceptance.
    claimNextNormalDurable(store, thread.id, {
      ownerPid: 2_147_000_050,
      ownerToken: 'abandoned-startup'
    })

    const llm = (orch as unknown as {
      llm: {
        getSelectedModelContextLimit: () => { limit: number }
        getContextInputs: () => Promise<unknown>
        chat: () => Promise<unknown>
      }
    }).llm
    const contextInputs = {
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'startup'
    }
    vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
    vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
    vi.spyOn(llm, 'chat').mockResolvedValue({
      text: 'ok',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      modelName: 'test',
      totalResponseTimeMs: 1,
      totalTokensUsed: 2,
      tokensPerSecond: 1,
      contextInputs,
      toolEvents: [],
      nativeMessages: []
    })
    orch.setPersistCallback((threadId) => {
      const id = threadId ?? thread.id
      const existing = store.loadThreadData(id)
      store.saveThreadData(id, {
        messages: orch.getMessages(id),
        agents: existing.agents,
        tasks: existing.tasks,
        llmContext: orch.getNativeContext(id)
      })
    })

    orch.recoverAndDrainPendingQueues()
    await vi.waitFor(() => {
      expect(
        store.loadThreadData(thread.id).messages.some((m) => m.content === 'startup-msg')
      ).toBe(true)
    })
    expect(store.loadMessageQueue(thread.id)).toHaveLength(0)
  })

  it('send reclaims a stale execution lease instead of queueing behind a ghost', async () => {
    const { writeFileSync } = await import('fs')
    const thread = store.createThread('Ghost lease')
    // Simulate a crashed daemon: execution lease left behind by a dead pid.
    writeFileSync(
      getExecutionLeasePath(store.getThreadDir(thread.id)),
      JSON.stringify({
        pid: 2_147_000_100,
        token: 'dead-ghost-owner',
        processInstanceId: 'dead-instance',
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        source: 'crashed-daemon'
      }),
      'utf-8'
    )

    const llm = (orch as unknown as {
      llm: {
        getSelectedModelContextLimit: () => { limit: number }
        getContextInputs: () => Promise<unknown>
        chat: () => Promise<unknown>
      }
    }).llm
    const contextInputs = {
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'ghost'
    }
    vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
    vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
    vi.spyOn(llm, 'chat').mockResolvedValue({
      text: 'recovered-ok',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      modelName: 'test',
      totalResponseTimeMs: 1,
      totalTokensUsed: 2,
      tokensPerSecond: 1,
      contextInputs,
      toolEvents: [],
      nativeMessages: []
    })
    orch.setPersistCallback((threadId) => {
      const id = threadId ?? thread.id
      const existing = store.loadThreadData(id)
      store.saveThreadData(id, {
        messages: orch.getMessages(id),
        agents: existing.agents,
        tasks: existing.tasks,
        llmContext: orch.getNativeContext(id)
      })
    })

    // Must run directly — never strand the prompt in the queue behind the dead owner.
    const result = await orch.send('after-restart', false, { threadId: thread.id })
    expect(result.queued).not.toBe(true)
    await vi.waitFor(() => {
      expect(
        store.loadThreadData(thread.id).messages.some((m) => m.content === 'after-restart')
      ).toBe(true)
    })
  })

  // Twelve real orchestrator turns run two at a time with thread-file persistence after each,
  // so this test is bound by throughput, not by a race: about 6 s alone and 15 s inside a full
  // run on a loaded machine. The assertion on the concurrency bound stays exact.
  it('startup drain concurrency bound holds across multi-message threads', { timeout: 60_000 }, async () => {
    // Several eligible threads each with multiple pending normals — internal auto-drain
    // must not stack turns on top of the startup pump (bound = 2).
    const messagesPerThread = 3
    const threads = Array.from({ length: 4 }, (_, i) =>
      store.createThread(`Startup bound ${i}`)
    )
    const expectedContents = new Map<string, string[]>()
    for (const thread of threads) {
      const contents = Array.from(
        { length: messagesPerThread },
        (_, j) => `msg-${thread.id}-${j}`
      )
      expectedContents.set(thread.id, contents)
      mutateDurableQueue(store, thread.id, (items) => {
        let next = items
        for (const content of contents) {
          next = enqueueMessage(next, { threadId: thread.id, content }).items
        }
        return next
      })
    }

    const llm = (orch as unknown as {
      llm: {
        getSelectedModelContextLimit: () => { limit: number }
        getContextInputs: () => Promise<unknown>
        chat: () => Promise<unknown>
      }
    }).llm
    const contextInputs = {
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'bound'
    }
    let inFlight = 0
    let maxInFlight = 0
    let totalChatCalls = 0
    vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
    vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
    vi.spyOn(llm, 'chat').mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      totalChatCalls += 1
      // Long enough that chained internal drains would overlap another thread's turn.
      await new Promise((r) => setTimeout(r, 40))
      inFlight -= 1
      return {
        text: 'ok',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        modelName: 'test',
        totalResponseTimeMs: 1,
        totalTokensUsed: 2,
        tokensPerSecond: 1,
        contextInputs,
        toolEvents: [],
        nativeMessages: []
      }
    })
    orch.setPersistCallback((threadId) => {
      if (!threadId) return
      const existing = store.loadThreadData(threadId)
      store.saveThreadData(threadId, {
        messages: orch.getMessages(threadId),
        agents: existing.agents,
        tasks: existing.tasks,
        llmContext: orch.getNativeContext(threadId)
      })
    })

    orch.recoverAndDrainPendingQueues()
    const totalMessages = threads.length * messagesPerThread
    await vi.waitFor(
      () => {
        let accepted = 0
        for (const thread of threads) {
          const users = store
            .loadThreadData(thread.id)
            .messages.filter((m) => m.role === 'user')
            .map((m) => m.content)
          for (const content of expectedContents.get(thread.id)!) {
            if (users.includes(content)) accepted += 1
          }
          expect(store.loadMessageQueue(thread.id)).toHaveLength(0)
        }
        expect(accepted).toBe(totalMessages)
      },
      { timeout: 45_000 }
    )

    // STARTUP_QUEUE_DRAIN_CONCURRENCY is 2 — never exceeded even with multi-item chains.
    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(maxInFlight).toBeGreaterThan(0)
    expect(totalChatCalls).toBe(totalMessages)
  })

  it('opportunistically completes accepted claims before claiming more work', async () => {
    const thread = store.createThread('Accepted cleanup')
    mutateDurableQueue(store, thread.id, (items) => {
      let next = enqueueMessage(items, { threadId: thread.id, content: 'stale-accepted' }).items
      next = enqueueMessage(next, { threadId: thread.id, content: 'next-pending' }).items
      return next
    })
    const stale = claimNextNormalDurable(store, thread.id, {
      ownerPid: process.pid,
      ownerToken: 'still-alive-owner'
    })!
    // Transcript already accepted; queue complete failed earlier — claim remains with live owner.
    store.saveThreadData(thread.id, {
      messages: [
        {
          id: 'u-stale',
          role: 'user',
          content: 'stale-accepted',
          timestamp: new Date().toISOString(),
          queueItemId: stale.id
        }
      ],
      agents: [],
      tasks: [],
      llmContext: {
        version: 2,
        messages: [{ role: 'user', content: 'stale-accepted', timestamp: Date.now() }],
        fidelity: 'native',
        activeStartIndex: 0,
        acceptedQueueItemIds: [stale.id]
      }
    })
    // Bind after planting so session messages retain durable provenance across persist.
    const planted = store.loadThreadData(thread.id)
    orch.bindThread(
      thread.id,
      planted.messages,
      planted.llmContext,
      store.loadMessageQueue(thread.id)
    )
    expect(store.loadMessageQueue(thread.id).find((i) => i.id === stale.id)?.state).toBe('claimed')
    expect(store.loadMessageQueue(thread.id).find((i) => i.content === 'next-pending')?.state).toBe(
      'pending'
    )

    const contextInputs = {
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'cleanup'
    }
    const llm = (orch as unknown as {
      llm: {
        getSelectedModelContextLimit: () => { limit: number }
        getContextInputs: () => Promise<typeof contextInputs>
        chat: () => Promise<unknown>
      }
    }).llm
    vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
    vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
    vi.spyOn(llm, 'chat').mockResolvedValue({
      text: 'ok',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      modelName: 'test',
      totalResponseTimeMs: 1,
      totalTokensUsed: 2,
      tokensPerSecond: 1,
      contextInputs,
      toolEvents: [],
      nativeMessages: []
    })
    orch.setPersistCallback((threadId) => {
      const id = threadId ?? thread.id
      const existing = store.loadThreadData(id)
      store.saveThreadData(id, {
        messages: orch.getMessages(id),
        agents: existing.agents,
        tasks: existing.tasks,
        llmContext: orch.getNativeContext(id)
      })
    })

    // Normal post-turn auto-drain (not startup reclaim) must clean accepted claim then run next.
    await orch.send('kick', false, { threadId: thread.id })
    await vi.waitFor(() => {
      expect(
        store
          .loadThreadData(thread.id)
          .messages.some((m) => m.role === 'user' && m.content === 'next-pending')
      ).toBe(true)
    })

    expect(store.loadMessageQueue(thread.id).find((i) => i.id === stale.id)).toBeUndefined()
    expect(store.loadMessageQueue(thread.id)).toHaveLength(0)
    // Stale content was not re-appended as a second user turn.
    expect(
      store
        .loadThreadData(thread.id)
        .messages.filter((m) => m.role === 'user' && m.content === 'stale-accepted')
    ).toHaveLength(1)
  })

  it('durable claim complete failure does not invent a session-only success', () => {
    const thread = store.createThread('Claim lie guard')
    orch.bindThread(thread.id, [], undefined, [])
    mutateDurableQueue(store, thread.id, (items) =>
      enqueueMessage(items, { threadId: thread.id, content: 'held' }).items
    )
    const claimed = claimNextNormalDurable(store, thread.id, {
      ownerPid: process.pid,
      ownerToken: 'tok'
    })!

    store.saveThreadData(thread.id, {
      messages: [
        {
          id: 'u',
          role: 'user',
          content: 'held',
          timestamp: new Date().toISOString(),
          queueItemId: claimed.id
        }
      ],
      agents: [],
      tasks: [],
      llmContext: {
        version: 2,
        messages: [{ role: 'user', content: 'held', timestamp: Date.now() }],
        fidelity: 'native',
        activeStartIndex: 0,
        acceptedQueueItemIds: [claimed.id]
      }
    })

    const realSave = store.saveMessageQueue.bind(store)
    const saveSpy = vi.spyOn(store, 'saveMessageQueue').mockImplementation(() => {
      throw new Error('disk full on complete')
    })

    // reclaimAbandonedClaimsDurable uses mutateDurableQueue → saveMessageQueue; failure must throw,
    // not report a successful in-memory-only complete.
    expect(() => orch.reclaimAbandonedClaimsForThread(thread.id)).toThrow(/disk full/i)

    saveSpy.mockImplementation(realSave)
    // Disk still has the claim for recovery.
    expect(store.loadMessageQueue(thread.id).find((i) => i.id === claimed.id)?.state).toBe(
      'claimed'
    )
    saveSpy.mockRestore()
  })

  it('unreadable transcript leaves dead-owner claim claimed (fail closed)', () => {
    const thread = store.createThread('Provenance unavailable')
    mutateDurableQueue(store, thread.id, (items) =>
      enqueueMessage(items, { threadId: thread.id, content: 'accepted-or-not' }).items
    )
    const claimed = claimNextNormalDurable(store, thread.id, {
      ownerPid: 2_147_000_070,
      ownerToken: 'dead-owner'
    })!
    // Plant durable acceptance on disk — reclaim must not release if transcript becomes unreadable.
    store.saveThreadData(thread.id, {
      messages: [
        {
          id: 'u',
          role: 'user',
          content: 'accepted-or-not',
          timestamp: new Date().toISOString(),
          queueItemId: claimed.id
        }
      ],
      agents: [],
      tasks: []
    })

    const loadSpy = vi.spyOn(store, 'loadThreadData').mockImplementation(() => {
      throw new Error('EIO: transcript unreadable')
    })

    expect(() => orch.reclaimAbandonedClaimsForThread(thread.id)).toThrow(/unreadable|EIO/i)

    loadSpy.mockRestore()
    // Queue mutation aborted without save — claim remains claimed (never released as not_accepted).
    expect(store.loadMessageQueue(thread.id).find((i) => i.id === claimed.id)?.state).toBe(
      'claimed'
    )
  })

  it('presentation-only queue provenance is ambiguous and never re-executed', () => {
    const thread = store.createThread('Torn queue provenance')
    mutateDurableQueue(store, thread.id, (items) =>
      enqueueMessage(items, { threadId: thread.id, content: 'maybe-accepted' }).items
    )
    const claimed = claimNextNormalDurable(store, thread.id, {
      ownerPid: 2_147_000_071,
      ownerToken: 'dead-owner'
    })!
    store.saveThreadData(thread.id, {
      messages: [{
        id: 'presentation-only',
        role: 'user',
        content: 'maybe-accepted',
        timestamp: new Date().toISOString(),
        queueItemId: claimed.id
      }],
      agents: [],
      tasks: []
    })

    expect(() => orch.reclaimAbandonedClaimsForThread(thread.id)).toThrow(/QUEUE_PROVENANCE_UNAVAILABLE/)
    expect(store.loadMessageQueue(thread.id).find((item) => item.id === claimed.id)?.state).toBe('claimed')
  })

  it('pre-accept failure with unreadable provenance does not release the claim', async () => {
    const thread = store.createThread('Unavailable release guard')
    orch.bindThread(thread.id, [], undefined, [])
    orch.enqueueForThread(thread.id, 'must-stay-claimed-on-unreadable')

    const failures: Array<{ error: string; queueItemId?: string }> = []
    orch.on('queue-drain-failed', (payload) => failures.push(payload))

    orch.setPersistCallback(() => {
      throw new Error('persist boom')
    })

    // After claim, make provenance reads fail closed during settleClaimAfterFailure.
    const realLoad = store.loadThreadData.bind(store)
    const loadSpy = vi.spyOn(store, 'loadThreadData').mockImplementation((id) => {
      // Allow initial reclaim/drain setup loads that happen before claim turn...
      // Once a claim exists, fail closed.
      const queue = store.loadMessageQueue(id)
      if (queue.some((i) => i.state === 'claimed')) {
        throw new Error('EIO: cannot verify provenance')
      }
      return realLoad(id)
    })

    orch.recoverAndDrainPendingQueues()
    await vi.waitFor(() => {
      expect(failures.some((f) => /unreadable|provenance|persist boom/i.test(f.error))).toBe(true)
    })

    loadSpy.mockRestore()
    const still = store.loadMessageQueue(thread.id)
    // Fail-closed: claim not released back to pending (would re-execute).
    // It may still be claimed (preferred) or pending only if never claimed — assert not re-enqueued at tail with new id.
    const byContent = still.filter((i) => i.content === 'must-stay-claimed-on-unreadable')
    expect(byContent).toHaveLength(1)
    // Unavailable provenance must leave the claim claimed, never release or complete it.
    expect(byContent[0].state).toBe('claimed')
  })
})
