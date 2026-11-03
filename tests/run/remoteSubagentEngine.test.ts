/**
 * Issue #469: a remote subagent's task in the Run Engine. Its child run here is a stand-in with no
 * `turn.start`: a `remote_subagents` row binds it to the run on another computer, a restart leaves it
 * alone, and its terminal write publishes to the parent exactly as a local child run's does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteDelegationTarget } from '../../src/mms/run/RunEngine'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const REMOTE: RemoteDelegationTarget = {
  node: 'node-mac',
  prompt: 'Run the macOS tests',
  permissionMode: 'accept_edits',
  chatMode: 'agent',
  worktree: true,
  projectId: 'far-project',
  instanceId: null,
  model: null,
  deadlineAt: null
}

describe('remote subagent tasks in the engine (issue #469)', () => {
  let f: DelegationFixture
  afterEach(() => f?.dispose())

  it('a remote task commits a stand-in run with its binding and no turn.start', async () => {
    f = delegationFixture()
    f.engine.reconcileOnBoot()
    const parent = await f.runningRun('parent')
    const accepted = await f.delegate(parent.runId, 'call-1', { remote: REMOTE, title: 'Mac tester' })
    expect(f.engine.getRun(accepted.childRunId)).toMatchObject({ status: 'queued', source: 'delegation' })
    expect(f.outbox.listForRun(accepted.childRunId)).toEqual([])
    expect(f.engine.remoteSubagents.get(accepted.delegationId)).toMatchObject({
      childRunId: accepted.childRunId,
      node: 'node-mac',
      state: 'starting',
      permissionMode: 'accept_edits',
      chatMode: 'agent',
      worktree: true,
      projectId: 'far-project',
      remoteThreadId: null
    })
    // A retry replays the first task and binds nothing new.
    expect(await f.delegate(parent.runId, 'call-1', { remote: REMOTE, title: 'Mac tester' })).toMatchObject({ delegationId: accepted.delegationId, replayed: true })
    expect(f.engine.remoteSubagents.listForChildThread(accepted.childThreadId)).toHaveLength(1)
  })

  it('a restart leaves the stand-in waiting: its run goes on on the other computer', async () => {
    f = delegationFixture()
    const home = f.profileHome
    f.engine.reconcileOnBoot()
    const parent = await f.runningRun('parent')
    const remote = await f.delegate(parent.runId, 'call-remote', { remote: REMOTE })
    const local = await f.delegate(parent.runId, 'call-local')
    f.dispose(true)

    f = delegationFixture({ profileHome: home, pid: 2 })
    const boot = f.engine.reconcileOnBoot()
    // The local child whose turn.start died publishes its failure; the remote one is still running.
    expect(boot.orphanedChildren).toEqual([local.childRunId])
    expect(f.engine.getRun(remote.childRunId)!.status).toBe('queued')
    expect(f.engine.delegations.get(remote.delegationId)!.status).toBe('running')
    // The reconciler does not restart or cancel a queued run that never had a turn.start.
    f.reconciler.runOnce()
    expect(f.engine.getRun(remote.childRunId)!.status).toBe('queued')
  })

  it('settling the stand-in publishes the far result to the parent once', async () => {
    f = delegationFixture()
    f.engine.reconcileOnBoot()
    const parent = await f.runningRun('parent')
    const accepted = await f.delegate(parent.runId, 'call-1', { remote: REMOTE })
    expect(await f.engine.settleRemoteRun(accepted.childRunId, 'completed', undefined, 'All 40 tests pass on macOS.')).toBe(true)
    expect(f.engine.delegations.get(accepted.delegationId)).toMatchObject({
      status: 'result_available',
      result: { runStatus: 'completed', text: 'All 40 tests pass on macOS.' }
    })
    expect(f.engine.inbox.listPending('parent')).toHaveLength(1)
    // A second write (a pass that read the same end) changes nothing.
    expect(await f.engine.settleRemoteRun(accepted.childRunId, 'failed', { error: 'late' })).toBe(false)
    expect(f.engine.delegations.get(accepted.delegationId)!.result).toMatchObject({ runStatus: 'completed' })
  })

  it('a cancel ends the stand-in like a queued child, so the parent hears nothing', async () => {
    f = delegationFixture()
    f.engine.reconcileOnBoot()
    const parent = await f.runningRun('parent')
    const accepted = await f.delegate(parent.runId, 'call-1', { remote: REMOTE })
    expect(await f.engine.cancelDelegation(accepted.delegationId)).toEqual([accepted.delegationId])
    expect(f.engine.getRun(accepted.childRunId)!.status).toBe('cancelled')
    expect(f.engine.inbox.listPending('parent')).toEqual([])
    // The binding stays open: the service tells the other computer to stop.
    expect(f.engine.remoteSubagents.get(accepted.delegationId)!.state).toBe('starting')
  })

  it('a follow-up is a task of its own on the same far thread, replayed by its request id', async () => {
    f = delegationFixture()
    f.engine.reconcileOnBoot()
    const parent = await f.runningRun('parent')
    const first = await f.delegate(parent.runId, 'call-1', { remote: REMOTE, title: 'Mac tester' })
    f.engine.remoteSubagents.update(first.delegationId, { remoteThreadId: 'far-thread', remoteRunId: 'far-run-1', state: 'running' })
    await f.engine.settleRemoteRun(first.childRunId, 'completed', undefined, 'First answer')
    f.engine.remoteSubagents.update(first.delegationId, { state: 'done' })
    const request = {
      childThreadId: first.childThreadId,
      clientRequestId: `followup:${parent.runId}:call-2`,
      delegation: { parentThreadId: 'parent', parentRunId: parent.runId, prompt: 'Now the iOS tests', wake: 'always' as const, workspace: 'isolated' as const },
      remote: { ...REMOTE, prompt: 'Now the iOS tests', remoteThreadId: 'far-thread' }
    }
    const next = await f.engine.requestRemoteFollowUp(request)
    expect(next.replayed).toBe(false)
    expect(next.delegationId).not.toBe(first.delegationId)
    expect(f.engine.getRun(next.childRunId)).toMatchObject({ status: 'queued', threadId: first.childThreadId })
    expect(f.engine.remoteSubagents.get(next.delegationId)).toMatchObject({ remoteThreadId: 'far-thread', remoteRunId: null, state: 'starting' })
    expect(await f.engine.requestRemoteFollowUp(request)).toMatchObject({ delegationId: next.delegationId, replayed: true })
    expect(f.engine.remoteSubagents.listForChildThread(first.childThreadId)).toHaveLength(2)
  })
})
