/**
 * Issue #142, nested results through a real orchestrator, run engine and effect worker with scripted
 * providers: P starts a Coordinator, which starts a Reader. The Coordinator's result reaches P only
 * after the Reader's was read by a run of the Coordinator that committed (the hold rule itself, with
 * every trigger, is `subagentHold.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import type { DelegationToolHost } from '../../src/mms/orchestrator/LlmClient'
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

    it('a turn that ends cleanly reads the rows, and the task publishes', async () => {
      const { s, row, payload } = await carried()
      await (s.d.orch as any).settleCarriedRows(payload, Promise.resolve({ message: 'ok', actions: [] }))
      expect(s.d.engine.inbox.get(row.inboxId)!.status).toBe('acknowledged')
      expect(s.task(s.coordinator.delegationId).status).not.toBe('running')
    })

    it('a turn that fails or throws gives the rows back: they keep holding the task and are delivered again', async () => {
      for (const outcome of [() => Promise.resolve({ message: '', actions: [], error: 'boom' }), () => Promise.reject(new Error('boom'))]) {
        const { s, row, payload } = await carried()
        await (s.d.orch as any).settleCarriedRows(payload, outcome()).catch(() => undefined)
        expect(s.d.engine.inbox.get(row.inboxId)!.status).toBe('pending')
        expect(s.task(s.coordinator.delegationId).status).toBe('running')
      }
    })
  })
})
