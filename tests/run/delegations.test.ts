import { afterEach, describe, expect, it } from 'vitest'
import { Delegations, promptDigest } from '../../src/mms/run/Delegations'
import type { ChildResultPayload, DelegationRecord } from '../../src/mms/run/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

describe('Delegations (SPEC §14.1)', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  const seeded = () => {
    f = delegationFixture()
    const delegations = new Delegations(f.store, f.engine.inbox)
    const child = f.store.createRun({ threadId: 'child', source: 'delegation' })
    delegations.createLineage({ threadId: 'child', parentThreadId: 'parent', parentRunId: 'run-p', relationship: 'subagent' })
    const delegation = delegations.create({
      parentRunId: 'run-p',
      parentThreadId: 'parent',
      childThreadId: 'child',
      childRunId: child.runId,
      prompt: 'Review the diff',
      wake: 'always'
    })
    return { f, delegations, child, delegation }
  }

  it('stores lineage and delegation rows and logs their events', () => {
    const { f, delegations, child, delegation } = seeded()
    expect(delegations.getLineage('child')).toMatchObject({ parentThreadId: 'parent', parentRunId: 'run-p', relationship: 'subagent' })
    expect(() => delegations.createLineage({ threadId: 'child', parentThreadId: 'x', parentRunId: 'y', relationship: 'fork' })).toThrow('already has lineage')
    expect(delegation).toMatchObject({ status: 'running', childRunId: child.runId, wake: 'always', promptDigest: promptDigest('Review the diff'), result: null })
    expect(delegations.get(delegation.delegationId)).toEqual(delegation)
    expect(delegations.listForParentRun('run-p')).toEqual([delegation])
    expect(delegations.listForChildThread('child')).toEqual([delegation])
    expect(delegations.listForParentThread('parent')).toEqual([delegation])
    expect(f.store.listEvents('child').map((event) => event.type)).toContain('thread.lineage')
    const logged = f.store.listEvents('parent').filter((event) => event.type === 'delegation.status')
    expect(logged.map((event) => (event.payload as DelegationRecord).status)).toEqual(['running'])
  })

  it('changes status by compare-and-set on the previous status', () => {
    const { delegations, delegation } = seeded()
    const id = delegation.delegationId
    expect(() => delegations.setStatus({ delegationId: id, from: 'result_available', to: 'acknowledged' })).toThrow(/is running/)
    expect(() => delegations.setStatus({ delegationId: id, from: 'running', to: 'acknowledged' })).toThrow(/cannot move/)
    delegations.setStatus({ delegationId: id, from: 'running', to: 'cancelled' })
    expect(() => delegations.setStatus({ delegationId: id, from: 'running', to: 'result_available' })).toThrow(/is cancelled/)
    expect(delegations.get(id)!.status).toBe('cancelled')
  })

  it('publication gate: the child terminal write publishes the result and one parent inbox row atomically', () => {
    const { f, delegations, child, delegation } = seeded()
    f.engine.markStarting(child.runId)
    f.engine.markRunning(child.runId)
    f.engine.markTerminal(child.runId, 'completed', undefined, { resultText: 'Found two bugs' })
    const published = delegations.get(delegation.delegationId)!
    expect(published).toMatchObject({ status: 'result_available', result: { runStatus: 'completed', text: 'Found two bugs', runId: child.runId } })
    expect(published.completedAt).toBeTruthy()
    const rows = f.engine.inbox.listPending('parent')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'child_result', runId: 'run-p', status: 'pending' })
    expect(rows[0].payload as ChildResultPayload).toEqual({
      delegationId: delegation.delegationId,
      childThreadId: 'child',
      childRunId: child.runId,
      result: { runStatus: 'completed', text: 'Found two bugs', runId: child.runId }
    })
    // The run, the delegation and the inbox row were one transaction: the run's terminal event
    // and the publication events are contiguous. The row is written first, so the parent is never
    // judged idle between the status change and its notice.
    const childStatus = f.store.listEvents('child').filter((event) => event.type === 'run.status').at(-1)!
    const parentEvents = f.store.listEvents('parent').filter((event) => event.seq > childStatus.seq)
    expect(parentEvents.map((event) => event.type)).toEqual(['inbox.status', 'delegation.status'])
  })

  it('publication gate: a failed child publishes its failure', () => {
    const { f, delegations, child, delegation } = seeded()
    f.engine.markStarting(child.runId)
    f.engine.markTerminal(child.runId, 'failed', { error: 'provider exploded' })
    expect(delegations.get(delegation.delegationId)!.result).toEqual({ runStatus: 'failed', error: 'provider exploded', runId: child.runId })
    expect(f.engine.inbox.listPending('parent')).toHaveLength(1)
  })

  it('publication gate: a late child after cancel finishes but cannot publish', () => {
    const { f, delegations, child, delegation } = seeded()
    f.engine.markStarting(child.runId)
    f.engine.markRunning(child.runId)
    delegations.setStatus({ delegationId: delegation.delegationId, from: 'running', to: 'cancelled' })
    const ended = f.engine.markTerminal(child.runId, 'completed', undefined, { resultText: 'too late' })
    expect(ended.status).toBe('completed')
    expect(delegations.get(delegation.delegationId)).toMatchObject({ status: 'cancelled', result: null })
    expect(f.engine.inbox.listForThread('parent')).toEqual([])
  })

  it('publication gate: runs that are not delegated children publish nothing', () => {
    f = delegationFixture()
    const plain = f.store.createRun({ threadId: 'plain', source: 'gui' })
    f.engine.markStarting(plain.runId)
    expect(f.engine.markTerminal(plain.runId, 'completed', undefined, { resultText: 'x' }).status).toBe('completed')
    expect(f.store.db.statement('SELECT COUNT(*) AS n FROM inbox').get()!.n).toBe(0)
  })

  it('publishes once: a second run on the child thread does not republish the first delegation', () => {
    const { f, delegations, child, delegation } = seeded()
    f.finish(child.runId, 'first')
    const second = f.store.createRun({ threadId: 'child', source: 'delegation' })
    f.finish(second.runId, 'second')
    expect(delegations.get(delegation.delegationId)!.result!.text).toBe('first')
    expect(f.engine.inbox.listForThread('parent')).toHaveLength(1)
  })
})
