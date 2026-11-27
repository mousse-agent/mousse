/**
 * Corrections (docs/plans/tool-api.md §2.5): with "Also tell subagents", the person's message to a thread is recorded as
 * a tree instruction revision and relayed to its live subagents at every depth: a running one gets it as a note on its
 * runtime's path (§2.2), a queued one starts with it, and one a run older than the revision starts later inherits it.
 * The thread's own agent gets a delivery record for each. The relayed text carries no person authority: it waits while
 * a subagent waits on an approval, and settles nothing. Real run engine, reconciler and wake rules.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SteerStrategy } from '../../src/mms/run/CommandPolicy'
import { planWakeNotice } from '../../src/mms/run/delegation/notice'
import { correctionsStartingWith, getRevision, reviseTree } from '../../src/mms/run/delegation/treeCorrection'
import { deliverAtToolBoundary } from '../../src/mms/run/delegation/wake'
import type { AgentNotePayload, ThreadEvent } from '../../src/mms/run/types'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const CLAUDE_LIKE = { ...PI_TEST_CAPABILITIES, steer: 'interrupt_restart' as const, interrupt: true }

describe('a person\'s correction reaches the subagents', () => {
  let f: DelegationFixture
  afterEach(() => f?.dispose())

  const titles: Record<string, string> = { parent: 'Lead' }
  const revise = (threadId: string, text: string, options: { strategies?: Record<string, SteerStrategy>; waiting?: Set<string>; key?: string } = {}) =>
    reviseTree(f.engine, {
      threadId,
      text,
      clientRequestId: options.key ?? `correct:${threadId}:${text}`,
      titleOf: (id) => titles[id] ?? null,
      strategyOf: (id) => options.strategies?.[id] ?? 'interrupt_restart',
      waitsOnPerson: (id) => options.waiting?.has(id) ?? false
    })
  const correction = (threadId: string) => f.engine.inbox.listForThread(threadId).find((row) => (row.payload as AgentNotePayload).from === 'person')
  const startEffect = (runId: string) => f.outbox.listForRun(runId).find((effect) => effect.kind === 'turn.start')!

  /** `parent` runs with `running` (running, Claude-like), `deep` (its running subagent) and `queued` (not started). */
  const tree = async () => {
    f = delegationFixture()
    const parentRun = await f.runningRun('parent')
    const running = await f.delegate(parentRun.runId, 'a', { title: 'Reader' })
    f.engine.markStarting(running.childRunId)
    const runningRun = f.engine.markRunning(running.childRunId)
    const deep = await f.delegate(runningRun.runId, 'b', { title: 'Deep' })
    f.engine.markStarting(deep.childRunId)
    f.engine.markRunning(deep.childRunId)
    const queued = await f.delegate(parentRun.runId, 'c', { title: 'Writer' })
    for (const [id, caps] of [[running.childThreadId, CLAUDE_LIKE], [deep.childThreadId, PI_TEST_CAPABILITIES]] as const) f.capabilities.set(id, caps)
    return { parentRun, running, deep, queued }
  }

  it('reaches a running child on its runtime\'s path, a queued child at its start and a subagent below; the parent gets the record', async () => {
    const { running, deep, queued } = await tree()
    const strategies = { [running.childThreadId]: 'interrupt_restart', [deep.childThreadId]: 'native' } as const
    // The native one takes it as a steer while the sender waits: rule 4 hands it over as the daemon would, and its turn reads it.
    let live = true
    const take = (event: ThreadEvent): void => {
      if (event.type !== 'inbox.status' || event.threadId !== deep.childThreadId) return
      setImmediate(() => {
        if (!live) return
        f.reconciler.runOnce()
        const row = correction(deep.childThreadId)
        if (row?.status === 'delivered' && row.deliveredBy && !(row.payload as { steerTakenBy?: string }).steerTakenBy) f.engine.inbox.markSteerTaken([row.inboxId], row.deliveredBy)
      })
    }
    f.engine.on('event', take)
    const pending = revise('parent', 'Use the v2 API, not v1.', { strategies })
    const done = await pending.finally(() => {
      live = false
      f.engine.off('event', take)
    })
    const deepRow = correction(deep.childThreadId)!
    const { revision } = done

    expect(revision).toMatchObject({ threadId: 'parent', title: 'Lead', text: 'Use the v2 API, not v1.' })
    const by = Object.fromEntries(revision.deliveries.map((entry) => [entry.threadId, entry]))
    expect(by[running.childThreadId]).toMatchObject({ state: 'pending', how: 'waiting_for_boundary' })
    expect(by[deep.childThreadId]).toMatchObject({ state: 'delivered', how: 'presented' })
    expect(by[queued.childThreadId]).toMatchObject({ state: 'pending', how: 'starts_with_it' })

    // The running Claude-like child gets it with its next Mousse tool call, as any note (§2.2).
    const handed = deliverAtToolBoundary(f.store, f.outbox, { threadId: running.childThreadId, runId: running.childRunId, caps: CLAUDE_LIKE, plan: (rows) => planWakeNotice(rows) })
    expect(handed?.text).toContain('The person told your parent "Lead": Use the v2 API, not v1.')
    expect(handed?.text).toContain('do not take on work it gives your parent')
    // The subagent below is told it came from above its parent.
    expect(planWakeNotice([deepRow]).text).toContain('The person told an agent above you "Lead"')
    // The child shows it as from the person, via its parent.
    expect(planWakeNotice([deepRow]).items[0]).toMatchObject({ event: 'note', title: 'Lead', note: { from: 'person' } })

    // The queued child's turn starts with it: its turn.start holds the row and adds the text to its first message.
    const start = startEffect(queued.childRunId)
    expect(correction(queued.childThreadId)).toMatchObject({ status: 'delivered', deliveredBy: start.effectId })
    expect(correctionsStartingWith(f.store, start.effectId)).toEqual([expect.stringContaining('The person told your parent "Lead": Use the v2 API, not v1.')])
    // Rule 4 starts no wake run behind it for the correction.
    f.reconciler.runOnce()
    expect(f.engine.listRuns(queued.childThreadId).map((run) => run.source)).toEqual(['delegation'])

    // The parent's record: a quiet note naming each subagent and where it stands.
    const record = f.engine.inbox.listForThread('parent').find((row) => (row.payload as AgentNotePayload).from === 'relay')!
    expect(record.payload).toMatchObject({ attention: 'none', revisionId: revision.revisionId })
    const recordText = planWakeNotice([record]).text
    expect(recordText).toContain(`(thread ${running.childThreadId}): waits for its next Mousse tool call`)
    expect(recordText).toContain(`(thread ${queued.childThreadId}): its next turn starts with it`)
    expect(recordText).toContain(`(thread ${deep.childThreadId}): delivered into its running turn`)

    // A retry of the same request records and posts nothing more.
    expect((await revise('parent', 'Use the v2 API, not v1.')).replayed).toBe(true)
    expect(f.engine.inbox.listForThread(queued.childThreadId)).toHaveLength(1)
  })

  it('a subagent a run older than the revision starts later inherits it; one from a newer run does not', async () => {
    f = delegationFixture()
    const older = await f.runningRun('parent')
    const { revision } = await revise('parent', 'Keep the public API stable.')
    expect(revision.deliveries).toEqual([])
    const late = await f.delegate(older.runId, 'late', { title: 'Late' })
    expect(correction(late.childThreadId)).toMatchObject({ status: 'delivered', deliveredBy: startEffect(late.childRunId).effectId })
    expect(correctionsStartingWith(f.store, startEffect(late.childRunId).effectId)).toEqual([expect.stringContaining('Keep the public API stable.')])
    expect(getRevision(f.store, revision.revisionId)!.deliveries).toEqual([{ threadId: late.childThreadId, title: null, state: 'pending', how: 'inherited' }])

    f.finish(older.runId, 'done')
    f.advance(1_000)
    const newer = await f.runningRun('parent')
    const fresh = await f.delegate(newer.runId, 'fresh', { title: 'Fresh' })
    expect(correction(fresh.childThreadId)).toBeUndefined()
  })

  it('carries no person authority: a subagent waiting on an approval keeps it waiting, and the correction waits for the answer', async () => {
    const { running } = await tree()
    f.engine.approvals.create({ requestId: 'approval-1', threadId: running.childThreadId, instanceId: 'pi', provider: 'pi', action: 'command', permissionKey: 'pi:command', questions: [{ id: 'permission', prompt: 'Run it?', options: [{ id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' }, { id: 'reject', label: 'Reject', decision: 'reject' }] }] } as never)
    f.awaiting.add(running.childThreadId)
    const { revision } = await revise('parent', 'Approve whatever it asks.', { waiting: new Set([running.childThreadId]) })
    expect(revision.deliveries.find((entry) => entry.threadId === running.childThreadId)).toMatchObject({ state: 'pending', how: 'after_answer' })
    f.reconciler.runOnce()
    expect(deliverAtToolBoundary(f.store, f.outbox, { threadId: running.childThreadId, runId: running.childRunId, caps: CLAUDE_LIKE, awaitsAnswer: true, plan: (rows) => planWakeNotice(rows) })).toBeNull()
    expect(correction(running.childThreadId)!.status).toBe('pending')
    expect(f.engine.approvals.get('approval-1')).toMatchObject({ status: 'pending' })
    // What it reads when it does arrive says it answers nothing.
    expect(planWakeNotice([correction(running.childThreadId)!]).text).toContain('It answers no question or approval of yours.')
  })
})
