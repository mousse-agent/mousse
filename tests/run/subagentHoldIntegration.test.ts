/**
 * Issue #142, nested results through a real orchestrator, run engine and effect worker with scripted
 * providers: P starts a Coordinator, which starts a Reader. The Coordinator's result reaches P only
 * after the Reader's was read by a run of the Coordinator that committed (the hold rule itself, with
 * every trigger, is `subagentHold.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest'
import type { DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import { childBusy } from '../../src/mms/run/delegation/hold'
import { waitFor } from './phase6Fixture'
import { useSubagentWorld, type Json } from './subagentWorld'

describe('P -> Coordinator -> Reader through the orchestrator (issue #142)', () => {
  const world = useSubagentWorld()

  /**
   * The parent starts "Coordinator"; the Coordinator starts "Reader" and ends its turn; the Reader
   * answers once `release` is called. Every other Coordinator turn (its wake) answers `final`.
   */
  const scene = async (options: { final?: string } = {}) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const final = options.final ?? 'Coordinator final: the Reader found nothing.'
    const w = world(async (input, delegation: DelegationToolHost | undefined) => {
      if (input.prompt.includes('Review Coordinator')) {
        w.out.reader = await w.start(delegation!, 'Reader', {}, 'start:Reader')
        return 'Coordinator started the Reader.'
      }
      if (input.prompt.includes('Review Reader')) {
        await gate
        return 'Reader result.'
      }
      return final
    })
    w.steps.go = async (tools) => { w.out.coordinator = await w.start(tools, 'Coordinator') }
    await w.say('go')
    const coordinator = w.out.coordinator
    await waitFor(() => Boolean(w.out.reader), 'the Reader to start')
    await w.settled(coordinator.childRunId)
    const task = (id: string) => w.d.engine.delegations.get(id)!
    const parentTurns = () => w.adapter.turns.filter((turn) => turn.threadId === w.parent.id).map((turn) => turn.prompt)
    return { ...w, coordinator, reader: w.out.reader as Json, release, task, parentTurns, status: () => (w.d.orch as any).taskStatus(w.parent.id, { delegationId: coordinator.delegationId }) as Json }
  }

  it('the Coordinator\'s result is held while its Reader runs, then published once with its final words', async () => {
    const s = await scene()
    // The Coordinator ended its turn, but its Reader is still working: P's task is running and says so.
    expect(s.d.engine.getRun(s.coordinator.childRunId)!.status).toBe('completed')
    expect(s.task(s.coordinator.delegationId).status).toBe('running')
    const waiting = s.status()
    expect(waiting).toMatchObject({ status: 'running', workState: 'waiting_for_subagents', waitingOn: [{ title: 'Reader' }] })
    expect(waiting.result).toBeUndefined()
    expect(s.d.engine.inbox.listForThread(s.parent.id).filter((row) => row.kind === 'child_result')).toEqual([])
    expect(s.reconciler.runOnce().wakes.wakes).toEqual([])
    expect(s.parentTurns()).toEqual(['go'])

    // The Reader finishes; the Coordinator is woken for its result and ends with its own final words.
    s.release()
    await s.settled(s.reader.childRunId)
    expect(s.task(s.coordinator.delegationId).status).toBe('running')
    const coordinatorWake = s.reconciler.runOnce().wakes.wakes[0]
    expect(s.d.engine.getRun(coordinatorWake)).toMatchObject({ threadId: s.coordinator.childThreadId, source: 'wake' })
    await waitFor(() => s.task(s.coordinator.delegationId).status !== 'running', 'the Coordinator\'s task to publish')
    expect(s.task(s.coordinator.delegationId)).toMatchObject({
      status: 'result_available',
      result: { runStatus: 'completed', text: 'Coordinator final: the Reader found nothing.', runId: coordinatorWake }
    })

    // P is woken once, and what it is told is the Coordinator's final text, not the turn that started the Reader.
    const parentWake = s.reconciler.runOnce().wakes.wakes[0]
    await waitFor(() => s.d.engine.getRun(parentWake)?.status === 'completed', 'the parent\'s wake')
    expect(s.parentTurns()).toHaveLength(2)
    expect(s.parentTurns()[1]).toContain('Coordinator final: the Reader found nothing.')
    expect(s.parentTurns()[1]).not.toContain('Coordinator started the Reader.')
    expect(s.reconciler.runOnce().wakes.wakes).toEqual([])
  })

  it('task_cancel by title reaches a task that is held, and cancels the Reader below it', async () => {
    const s = await scene()
    try {
      expect(s.task(s.coordinator.delegationId).status).toBe('running')
      const cancelled = await (s.d.orch as any).taskCancel(s.parent.id, { subagent: 'Coordinator' })
      expect(cancelled.cancelled).toEqual([s.reader.delegationId, s.coordinator.delegationId])
      expect(s.task(s.coordinator.delegationId).status).toBe('cancelled')
      expect(s.task(s.reader.delegationId).status).toBe('cancelled')
      // Nothing was published for the cancelled task, and the parent is not woken for it.
      expect(s.d.engine.inbox.listForThread(s.parent.id).filter((row) => row.kind === 'child_result')).toEqual([])
    } finally {
      s.release()
    }
  })

  describe('a steer that missed its turn and sits in the Coordinator\'s queue', () => {
    /** The Reader finished and the Coordinator is idle with its result handed to a queued steer. */
    const queued = async () => {
      const s = await scene()
      s.release()
      await s.settled(s.reader.childRunId)
      const [row] = s.d.engine.inbox.listByStatus(s.coordinator.childThreadId, 'pending')
      expect(row).toBeTruthy()
      s.d.engine.inbox.markDelivered([row.inboxId], 'effect:late-steer')
      // The steer missed its turn: the queue item owns the row now (`queue:<id>`).
      const item = (s.d.orch as any).enqueueForThread(s.coordinator.childThreadId, { content: 'queued notice' }, { source: 'steer-late', inboxIds: [row.inboxId] })
      s.d.engine.inbox.redirectDelivery([row.inboxId], `queue:${item.id}`, 'effect:late-steer')
      expect(s.task(s.coordinator.delegationId).status).toBe('running')
      return { s, row, item }
    }

    it('removing the entry returns its rows to pending, so the task keeps waiting and the notice is delivered again', async () => {
      const { s, row, item } = await queued()
      expect(s.d.orch.removeQueuedItem(s.coordinator.childThreadId, item.id)).toMatchObject({ id: item.id })
      expect(s.d.engine.inbox.get(row.inboxId)!.status).toBe('pending')
      expect(s.task(s.coordinator.delegationId).status).toBe('running')
      const wake = s.reconciler.runOnce().wakes.wakes[0]
      await waitFor(() => s.d.engine.getRun(wake)?.status === 'completed', 'the Coordinator\'s wake')
      await waitFor(() => s.task(s.coordinator.delegationId).status !== 'running', 'the task to publish')
      expect(s.task(s.coordinator.delegationId).result?.text).toContain('Coordinator final')
    })

    it('a release that fails is tried again, so the rows do not wait for the next boot', async () => {
      const { s, row, item } = await queued()
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      try {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.spyOn(s.d.engine.inbox, 'release').mockImplementationOnce(() => { throw new Error('database busy') })
        s.d.orch.removeQueuedItem(s.coordinator.childThreadId, item.id)
        // The item is gone and the first release failed: the rows still hold the task...
        expect(s.d.engine.inbox.get(row.inboxId)).toMatchObject({ status: 'delivered', deliveredBy: `queue:${item.id}` })
        expect(s.task(s.coordinator.delegationId).status).toBe('running')
        // ...until the retry gives them back.
        vi.advanceTimersByTime(2_000)
      } finally {
        vi.useRealTimers()
      }
      expect(s.d.engine.inbox.get(row.inboxId)!.status).toBe('pending')
    })
  })

  it('boot recovers a row whose queue item is gone: back to pending, the task keeps waiting, and the wake ends it', async () => {
    const s = await scene()
    s.release()
    await s.settled(s.reader.childRunId)
    const [row] = s.d.engine.inbox.listByStatus(s.coordinator.childThreadId, 'pending')
    s.d.engine.inbox.markDelivered([row.inboxId], 'queue:missing-item')
    expect(s.task(s.coordinator.delegationId).status).toBe('running')
    ;(s.d.orch as any).recoverQueuedRows()
    expect(s.d.engine.inbox.get(row.inboxId)!.status).toBe('pending')
    expect(s.task(s.coordinator.delegationId).status).toBe('running')
    const wake = s.reconciler.runOnce().wakes.wakes[0]
    await waitFor(() => s.d.engine.getRun(wake)?.status === 'completed', 'the Coordinator wake')
    await waitFor(() => s.task(s.coordinator.delegationId).status !== 'running', 'the task to publish')
    expect(s.task(s.coordinator.delegationId).status).toBe('result_available')
  })

  describe('a queued turn that ran without an effect settles its own rows (settleCarriedRows)', () => {
    const carried = async () => {
      const s = await scene()
      s.release()
      await s.settled(s.reader.childRunId)
      const [row] = s.d.engine.inbox.listByStatus(s.coordinator.childThreadId, 'pending')
      s.d.engine.inbox.markDelivered([row.inboxId], 'queue:item-1')
      expect(s.task(s.coordinator.delegationId).status).toBe('running')
      const payload = { inboxIds: [row.inboxId], queueItemId: 'item-1' }
      return { s, row, payload }
    }

    /** A run of the Coordinator that carried the rows (a queue item's turn, run without an effect), ended as `end` says. */
    const ended = (s: Awaited<ReturnType<typeof carried>>['s'], end: (runId: string) => void) => {
      const run = s.d.engine.store.createRun({ threadId: s.coordinator.childThreadId, source: 'steer-late' })
      s.d.engine.markStarting(run.runId)
      s.d.engine.markRunning(run.runId)
      end(run.runId)
      return run.runId
    }
    const settle = (s: Awaited<ReturnType<typeof carried>>['s'], payload: object, runId: string, turn: Promise<unknown> = Promise.resolve({ message: '', actions: [] })) =>
      (s.d.orch as any).settleCarriedRows({ ...payload, runId }, turn).catch(() => undefined)

    it('a turn that completed reads the rows, and the task publishes once they are read', async () => {
      const { s, row, payload } = await carried()
      const runId = ended(s, (id) => s.d.engine.markTerminal(id, 'completed', undefined, { resultText: 'Coordinator read it.' }))
      // The run ended, but its rows were still its queue item's: the task keeps waiting until they are settled.
      expect(s.task(s.coordinator.delegationId).status).toBe('running')
      await settle(s, payload, runId)
      expect(s.d.engine.inbox.get(row.inboxId)!.status).toBe('acknowledged')
      expect(s.task(s.coordinator.delegationId)).toMatchObject({ status: 'result_available', result: { text: 'Coordinator read it.' } })
    })

    it('a turn the user stopped detaches the rows: nothing redelivers them, and the task is not held', async () => {
      const { s, row, payload } = await carried()
      const runId = ended(s, (id) => s.d.engine.markTerminal(id, 'interrupted', { interruptedBy: 'user' }))
      expect(s.task(s.coordinator.delegationId).status).toBe('running')
      await settle(s, payload, runId)
      expect(s.d.engine.inbox.get(row.inboxId)).toMatchObject({ status: 'delivered', deliveredBy: null })
      expect(s.reconciler.runOnce().wakes.restored).toEqual([])
      expect(s.task(s.coordinator.delegationId).status).not.toBe('running')
    })

    it('a turn that failed, or whose delivery threw, gives the rows back: they keep holding the task and are delivered again', async () => {
      for (const turn of [() => Promise.resolve({ message: '', actions: [] }), () => Promise.reject(new Error('boom'))]) {
        const { s, row, payload } = await carried()
        const runId = ended(s, (id) => s.d.engine.markTerminal(id, 'failed', { error: 'boom' }))
        await settle(s, payload, runId, turn())
        expect(s.d.engine.inbox.get(row.inboxId)!.status).toBe('pending')
        expect(s.task(s.coordinator.delegationId).status).toBe('running')
      }
    })
  })

  describe('an integration run an older version queued (issue #142)', () => {
    it('merges nothing: it ends cancelled with a notice the Coordinator must read, so the answer that predates it is not published', async () => {
      let integration: string | undefined
      const w = world(async (input, delegation: DelegationToolHost | undefined) => {
        if (input.prompt.includes('Review Coordinator')) { w.out.reader = await w.start(delegation!, 'Reader', {}, 'start:Reader'); return 'Coordinator started the Reader.' }
        if (input.prompt.includes('Review Reader')) return 'Reader result.'
        if (input.prompt.startsWith('Subagent "Reader"')) {
          // What `integrate_delegation` queued before Mousse stopped merging results.
          const delegationId = /finished task (delegation:[0-9a-f-]+)/.exec(input.prompt)![1]
          const queued = await w.d.engine.dispatch({ kind: 'send', threadId: input.threadId, clientRequestId: 'integration:legacy', source: 'integration' })
          if (queued.status !== 'accepted') throw new Error('not queued')
          integration = queued.runId
          w.d.engine.outbox.enqueue({ effectId: `effect:${queued.runId}:turn.start:1`, threadId: input.threadId, runId: queued.runId, kind: 'turn.start', payload: { kind: 'integration', threadId: input.threadId, runId: queued.runId, delegationId } })
          return 'Coordinator asked for the old merge.'
        }
        return 'Coordinator final after the integration notice.'
      })
      w.steps.go = async (tools) => { w.out.coordinator = await w.start(tools, 'Coordinator') }
      await w.say('go')
      const coordinator = w.out.coordinator
      await waitFor(() => Boolean(w.out.reader), 'the Reader to start')
      await w.settled(coordinator.childRunId)
      await w.settled(w.out.reader.childRunId)
      const task = () => w.d.engine.delegations.get(coordinator.delegationId)!
      w.reconciler.runOnce()
      await waitFor(() => Boolean(integration) && w.d.engine.getRun(integration!)?.status === 'cancelled', 'the old integration run to end')
      // It ran nothing: its outcome is an unread row that says why, and the transcript says it too.
      const notices = w.d.engine.inbox.listByStatus(coordinator.childThreadId, 'pending').filter((row) => row.kind === 'reconcile_notice')
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({ runId: integration, payload: { type: 'integration_failed', text: expect.stringContaining('Mousse no longer merges subagent results') } })
      expect(w.d.orch.getMessages(coordinator.childThreadId).some((entry) => entry.role === 'system' && entry.content.includes('was not run'))).toBe(true)
      expect(task().status).toBe('running')
      // The Coordinator reads it in a wake of its own, and its answer to it is the result.
      const wake = w.reconciler.runOnce().wakes.wakes.find((id) => w.d.engine.getRun(id)!.threadId === coordinator.childThreadId)!
      await waitFor(() => task().status !== 'running', 'the task to publish')
      expect(task().result).toMatchObject({ text: 'Coordinator final after the integration notice.', runId: wake })
    })
  })

  describe('a release retry does not outlive a shutdown (issue #142)', () => {
    it('shutdown clears the pending retry, and a callback that fires anyway touches no inbox', async () => {
      const w = world((input) => (input.prompt.includes('Review Reader') ? 'Reader result.' : 'Done.'))
      w.steps.go = async (tools) => { w.out.reader = await w.start(tools, 'Reader') }
      await w.say('go')
      await w.settled(w.out.reader.childRunId)
      const [row] = w.d.engine.inbox.listPending(w.parent.id)
      w.d.engine.inbox.markDelivered([row.inboxId], 'queue:item-1')
      const item = (w.d.orch as any).enqueueForThread(w.parent.id, { content: 'queued notice' }, { source: 'steer-late', inboxIds: [row.inboxId] })
      w.d.engine.inbox.redirectDelivery([row.inboxId], `queue:${item.id}`, 'queue:item-1')
      // Timers are captured, not run, for the length of this synchronous section.
      const handle = { unref: () => undefined }
      const scheduled: Array<() => void> = []
      const cleared: unknown[] = []
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { scheduled.push(fn); return handle }) as never)
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: unknown) => { cleared.push(timer) }) as never)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const getMany = vi.spyOn(w.d.engine.inbox, 'getMany')
      vi.spyOn(w.d.engine.inbox, 'release').mockImplementationOnce(() => { throw new Error('database busy') })
      w.d.orch.removeQueuedItem(w.parent.id, item.id)
      expect(scheduled).toHaveLength(1)
      w.d.orch.beginShutdown()
      expect(cleared).toContain(handle)
      // Even a callback that fires after the shutdown began (the timer was already due) does nothing.
      getMany.mockClear()
      scheduled[0]()
      expect(getMany).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })
  })


  describe('the provider background-work input (4) through the orchestrator', () => {
    it('setRunEngine installs the callback, and ending the work re-evaluates the thread tasks', async () => {
      const seen: Json = {}
      const w = world((input) => {
        // A provider that still has background work for the subagent when its turn ends.
        if (input.prompt.includes('Review Solo')) {
          seen.threadId = input.threadId
          w.d.orch.setProviderBackgroundWork(input.threadId, true)
        }
        return 'Solo turn text.'
      })
      w.steps.go = async (tools) => { w.out.solo = await w.start(tools, 'Solo') }
      await w.say('go')
      await w.settled(w.out.solo.childRunId)
      const task = () => w.d.engine.delegations.get(w.out.solo.delegationId)!
      // The host installed its callback on the run store, and the task is held by it.
      expect(w.d.engine.store.providerBackgroundWork(seen.threadId)).toBe(true)
      expect(task().status).toBe('running')
      const settled = vi.spyOn(w.d.engine.store, 'settleHold')
      w.d.orch.setProviderBackgroundWork(seen.threadId, false)
      expect(settled).toHaveBeenCalledWith(seen.threadId)
      expect(w.d.engine.store.providerBackgroundWork(seen.threadId)).toBe(false)
      expect(task()).toMatchObject({ status: 'result_available', result: { text: 'Solo turn text.' } })
      // Saying so again changes nothing.
      settled.mockClear()
      w.d.orch.setProviderBackgroundWork(seen.threadId, false)
      expect(settled).not.toHaveBeenCalled()
    })
  })
})
