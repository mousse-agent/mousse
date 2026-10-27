/**
 * SPEC §16.2 merge-back: only into the fork's direct parent, only after a completed fork run; a
 * newer request supersedes a pending one; the parent's next turn consumes it as a
 * `fork_delta_summary`; queueing on the parent is refused while it is pending.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandRejection } from '../../src/mms/run/db/RunStoreError'
import { PI, phase6Daemon, piAdapter, type Phase6Daemon } from './phase6Fixture'

describe('merge-back (SPEC §16.2)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const setup = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-merge-back-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const pi = piAdapter((input) => `reply to ${input.prompt}`)
    const d = (daemon = phase6Daemon(home, [pi]))
    return { pi, d }
  }

  /** A parent with one completed run and a fork after it. */
  const forkOf = async (d: Phase6Daemon) => {
    const parent = d.store.createThread('Parent')
    d.orch.setThreadModelOverride(parent.id, PI)
    await d.orch.send('Design the API', false, { threadId: parent.id, clientRequestId: 'p-1' })
    const forked = await d.engine.forkThread({ sourceThreadId: parent.id, clientRequestId: `fork:${parent.id}` })
    return { parent, forkThreadId: forked.threadId }
  }

  const reason = (error: unknown) => (error instanceof CommandRejection ? error.reason : error)

  it('goes only into the direct parent of a fork', async () => {
    const { d } = setup()
    const plain = d.store.createThread('Plain')
    expect(reason(await d.engine.mergeBack({ forkThreadId: plain.id, clientRequestId: 'm-plain' }).catch((e) => e))).toBe('not_a_fork')
    const parent = d.store.createThread('Delegating parent')
    const child = d.store.createThread('Subagent child')
    const sent = await d.engine.dispatch({ kind: 'send', threadId: parent.id, clientRequestId: 'p', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    d.engine.delegations.createLineage({ threadId: child.id, parentThreadId: parent.id, parentRunId: sent.runId, relationship: 'subagent' })
    expect(reason(await d.engine.mergeBack({ forkThreadId: child.id, clientRequestId: 'm-child' }).catch((e) => e))).toBe('not_a_fork')

    const { parent: forkParent, forkThreadId } = await forkOf(d)
    await d.orch.send('Try variant B', false, { threadId: forkThreadId, clientRequestId: 'f-1' })
    const merged = await d.engine.mergeBack({ forkThreadId, clientRequestId: 'm-1' })
    expect(merged).toMatchObject({ parentThreadId: forkParent.id, replayed: false })
    expect(d.engine.transfers.get(merged.transferId)).toMatchObject({
      type: 'merge_back', status: 'pending', sourceThreadId: forkThreadId, targetThreadId: forkParent.id, sourceRunOrdinal: 1,
      payload: { fromOrdinal: 1, toOrdinal: 1, integration: { kind: 'fork', merged: false } }
    })
    expect(await d.engine.mergeBack({ forkThreadId, clientRequestId: 'm-1' })).toEqual({ ...merged, replayed: true })
  })

  it('needs the fork\'s latest run to be completed', async () => {
    const { pi, d } = setup()
    const { forkThreadId } = await forkOf(d)
    expect(reason(await d.engine.mergeBack({ forkThreadId, clientRequestId: 'm-none' }).catch((e) => e))).toBe('fork_not_completed')
    pi.failNext = new Error('provider down')
    await d.orch.send('Try variant B', false, { threadId: forkThreadId, clientRequestId: 'f-fail' }).catch(() => undefined)
    expect(d.engine.listRuns(forkThreadId)[0].status).toBe('failed')
    expect(reason(await d.engine.mergeBack({ forkThreadId, clientRequestId: 'm-failed' }).catch((e) => e))).toBe('fork_not_completed')
  })

  it('supersedes a pending merge-back, is consumed once by the parent\'s next turn and refuses queueing meanwhile', async () => {
    const { pi, d } = setup()
    const { parent, forkThreadId } = await forkOf(d)
    await d.orch.send('Try variant B', false, { threadId: forkThreadId, clientRequestId: 'f-1' })
    const first = await d.engine.mergeBack({ forkThreadId, clientRequestId: 'm-1' })
    await d.orch.send('Polish variant B', false, { threadId: forkThreadId, clientRequestId: 'f-2' })
    const second = await d.engine.mergeBack({ forkThreadId, clientRequestId: 'm-2' })
    expect(d.engine.transfers.get(first.transferId)!.status).toBe('superseded')
    expect(d.engine.transfers.get(second.transferId)).toMatchObject({ status: 'pending', payload: { fromOrdinal: 1, toOrdinal: 2 } })
    expect(d.engine.pendingMergeBack(parent.id)?.transferId).toBe(second.transferId)

    // Queueing on the parent is refused until the merge-back is consumed.
    const queued = await d.orch.send('Queued thought', false, { threadId: parent.id, clientRequestId: 'q-1', forceQueue: true }).catch((e) => e)
    expect(queued).toMatchObject({ code: 'merge_back_pending' })
    expect(() => d.orch.mcpToolHost().enqueue(parent.id, { content: 'from a tool', mode: 'agent' })).toThrow(/merge-back/)
    expect(() => d.orch.assertQueueOpen(forkThreadId)).not.toThrow()

    await d.orch.send('What did the fork find?', false, { threadId: parent.id, clientRequestId: 'p-2' })
    const turn = pi.turns.at(-1)!
    expect(turn.threadId).toBe(parent.id)
    // The parent keeps its own history and receives the fork's runs 1–2 before the new message.
    expect(turn.nativeHistory).toContain('Design the API')
    expect(turn.prompt.startsWith('<handoff strategy="fork_delta_summary" covered="1-2"')).toBe(true)
    expect(turn.prompt).toContain('Try variant B')
    expect(turn.prompt).toContain('reply to Polish variant B')
    expect(turn.prompt.endsWith('What did the fork find?')).toBe(true)

    expect(d.engine.transfers.get(second.transferId)).toMatchObject({ status: 'consumed', payload: { strategy: 'fork_delta_summary' } })
    const handoff = d.engine.handoffs.listForThread(parent.id).at(-1)!
    expect(handoff).toMatchObject({ strategy: 'fork_delta_summary', status: 'delivered', coveredFromOrdinal: 1, coveredToOrdinal: 2 })
    expect(d.engine.pendingMergeBack(parent.id)).toBeNull()
    expect(() => d.orch.assertQueueOpen(parent.id)).not.toThrow()

    // Delivered once: the delta stays in the parent's transcript, no second handoff is planned, and
    // nothing new can be merged.
    await d.orch.send('Next step', false, { threadId: parent.id, clientRequestId: 'p-3' })
    expect(JSON.stringify(pi.turns.at(-1)!.messages)).toContain('fork_delta_summary')
    expect(d.engine.handoffs.listForThread(parent.id)).toHaveLength(1)
    expect(reason(await d.engine.mergeBack({ forkThreadId, clientRequestId: 'm-3' }).catch((e) => e))).toBe('nothing_to_merge')
  })
})
