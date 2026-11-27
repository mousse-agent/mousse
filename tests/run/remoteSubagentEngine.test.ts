/**
 * Issue #469: a remote subagent's task in the Run Engine. Its child run here is a stand-in with no
 * `turn.start`: a `remote_subagents` row binds it to the run on another computer, a restart leaves it
 * alone, and its terminal write publishes to the parent exactly as a local child run's does.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RUN_MIGRATIONS } from '../../src/mms/run/db/migrations'
import type { RemoteDelegationTarget } from '../../src/mms/run/RunEngine'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const REMOTE: RemoteDelegationTarget = {
  node: 'node-mac',
  prompt: 'Run the macOS tests',
  permissionMode: 'accept_edits',
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

// Issue #1160: version 18 lets a task's mode be Full access. Rows a computer wrote before it keep their mode and
// their order (a subagent's tasks are read by created_at, then rowid).
describe('the remote subagent table before and after Full access', () => {
  it('keeps the rows written before, in order, and takes Full access after', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-remote-mode-'))
    const db = new ProfileDatabase({ profileHome: home })
    try {
      db.migrate(RUN_MIGRATIONS.filter((migration) => migration.version <= 17))
      const insert = (id: string, mode: string) => db.database.prepare(
        `INSERT INTO remote_subagents(delegation_id, child_thread_id, child_run_id, node, prompt, permission_mode, chat_mode, worktree, state, created_at, updated_at)
         VALUES(?, 'child', ?, 'node-mac', 'p', ?, 'agent', 0, 'done', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
      ).run(id, `run-${id}`, mode)
      // Same created_at: only the rowid orders them, and 'b' was written before 'a'.
      insert('b', 'accept_edits')
      insert('a', 'ask')
      insert('c', 'auto')
      expect(() => insert('d', 'full')).toThrow(/CHECK/)
      db.migrate(RUN_MIGRATIONS)
      const rows = () => db.database.prepare('SELECT delegation_id, permission_mode FROM remote_subagents ORDER BY created_at, rowid').all()
      expect(rows()).toEqual([
        { delegation_id: 'b', permission_mode: 'accept_edits' },
        { delegation_id: 'a', permission_mode: 'ask' },
        { delegation_id: 'c', permission_mode: 'auto' }
      ])
      insert('d', 'full')
      expect(() => insert('e', 'root')).toThrow(/CHECK/)
      expect(rows().at(-1)).toEqual({ delegation_id: 'd', permission_mode: 'full' })
    } finally {
      db.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
