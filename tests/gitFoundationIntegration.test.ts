import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChildAgentIntegrationService } from '../src/mms/agents/ChildAgentIntegrationService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

describe('Git foundation pinned child results', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  beforeEach(() => { f = gitFoundationFixture() })
  afterEach(() => f.dispose())

  /** A worker's result is a pinned revision (a snapshot of its files, or any commit with them); the thread is `f.repo`. */
  function request(child: string, result: string, operationId = 'integrate-child') {
    return {
      operationId, agentId: 'child', workerWorktree: child,
      spawnBaseSha: f.baseSha, pinnedWorkerSha: result, threadWorkspace: f.repo
    }
  }

  it('records one immutable receipt between two snapshots with pinned base/result and retries without a second merge', async () => {
    const child = f.child()
    f.commit(child, 'first\n')
    const result = f.commit(child, 'second\n')
    const service = new ChildAgentIntegrationService(f.thread)
    const input = request(child, result)
    const integrated = await service.integrate(input)
    const receipts = new ChangeReceiptService(f.thread).list()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      id: integrated.receiptId, operationId: input.operationId, kind: 'integration',
      afterSha: integrated.integrationSha, introducedCommits: [],
      contributions: [{ actorId: 'child', baseSha: f.baseSha, resultSha: result }]
    })
    // The files came in; no commit was made and HEAD did not move.
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    expect(git(f.repo, 'rev-parse', `${receipts[0].beforeSha}^{tree}`)).toBe(git(f.repo, 'rev-parse', `${f.baseSha}^{tree}`))
    expect(git(f.repo, 'rev-parse', `${receipts[0].afterSha}^{tree}`)).toBe(git(f.repo, 'rev-parse', `${result}^{tree}`))
    expect(f.read(f.repo)).toBe('second\n')
    for (const ref of receipts[0].retainedRefs) expect(git(f.repo, 'rev-parse', ref)).toMatch(/^[0-9a-f]{40}$/)
    expect(git(f.repo, 'rev-parse', 'refs/mousse/agents/child')).toBe(result)
    expect(await service.integrate(input)).toEqual(integrated)
    expect(new ChangeReceiptService(f.thread).list()).toEqual(receipts)
    expect(f.read(child)).toBe('second\n')
  }, 30_000)

  it('does not mind that the worker or the thread moved on: it merges the pinned result into the files as they are', async () => {
    const child = f.child()
    const reviewed = f.commit(child, 'reviewed\n')
    f.commit(child, 'newer\n')
    const movedParent = f.commit(f.repo, 'parent\n', 'parent.txt')
    await new ChildAgentIntegrationService(f.thread).integrate(request(child, reviewed))
    expect(f.read(f.repo)).toBe('reviewed\n')
    expect(f.read(f.repo, 'parent.txt')).toBe('parent\n')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(movedParent)
  })

  it('refuses a conflicting result with the file names and changes nothing; the first result and both workers stay', async () => {
    const a = f.child()
    const b = f.child('other-child')
    const resultA = f.commit(a, 'result A\n')
    const resultB = f.commit(b, 'result B\n')
    const service = new ChildAgentIntegrationService(f.thread)
    const first = await service.integrate(request(a, resultA))
    await expect(service.integrate({ ...request(b, resultB, 'integrate-other'), agentId: 'other-child' })).rejects.toMatchObject({ code: 'integration_conflict', details: { files: ['value.txt'] } })
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(true)
    expect(git(a, 'rev-parse', 'HEAD')).toBe(resultA)
    expect(git(b, 'rev-parse', 'HEAD')).toBe(resultB)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    expect(f.read(f.repo)).toBe('result A\n')
    expect(git(f.repo, 'status', '--porcelain')).toBe('M value.txt')
    expect(git(f.repo, 'diff', '--name-only', '--diff-filter=U')).toBe('')
    expect(git(f.repo, 'for-each-ref', 'refs/mousse/pending-changes')).toBe('')
    expect(new ThreadJournal(f.thread).latestByOperation().get('integrate-other')).toBeUndefined()
    expect(new ChangeReceiptService(f.thread).list()).toHaveLength(1)
    expect(first.integrationSha).toBe(new ChangeReceiptService(f.thread).list()[0].afterSha)
  }, 30_000)

  describe('a delegated task pinned to its own checkpoint (issue #142)', () => {
    /** Task A finished at `pinned`; the subagent then continued: a later commit, and uncommitted work. */
    const continuedAfterTask = () => {
      const child = f.child()
      const pinned = f.commit(child, 'task A\n')
      const later = f.commit(child, 'task B, committed\n')
      writeFileSync(join(child, 'value.txt'), 'task B, still being written\n')
      return { child, pinned, later }
    }

    it('merges exactly the checkpoint, however far the live worktree has moved, and leaves that worktree alone', async () => {
      const { child, pinned, later } = continuedAfterTask()
      const integrated = await new ChildAgentIntegrationService(f.thread).integrate(request(child, pinned, 'integrate-task-a'))
      expect(integrated.workerHeadSha).toBe(pinned)
      expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
      expect(f.read(f.repo)).toBe('task A\n')
      expect(new ChangeReceiptService(f.thread).list()[0].contributions).toMatchObject([{ actorId: 'child', baseSha: f.baseSha, resultSha: pinned }])
      expect(git(f.repo, 'rev-parse', 'refs/mousse/agents/child')).toBe(pinned)
      // The subagent keeps running where it was: its commit and its unsaved work are untouched.
      expect(git(child, 'rev-parse', 'HEAD')).toBe(later)
      expect(f.read(child)).toBe('task B, still being written\n')
    })

    it('a retry returns the same record; the same pin under another operation does not merge twice', async () => {
      const { child, pinned } = continuedAfterTask()
      const service = new ChildAgentIntegrationService(f.thread)
      const integrated = await service.integrate(request(child, pinned, 'integrate-task-a'))
      expect(await service.integrate(request(child, pinned, 'integrate-task-a'))).toEqual(integrated)
      expect(new ChangeReceiptService(f.thread).list()).toHaveLength(1)
    })

    it('still refuses a pin outside the repository and a result with no change, and a thread that moved on is no reason to refuse', async () => {
      const { child, pinned } = continuedAfterTask()
      const service = new ChildAgentIntegrationService(f.thread)
      await expect(service.integrate(request(child, f.baseSha, 'no-change'))).rejects.toThrow(/produced no change/)
      await expect(service.integrate(request(child, '0123456789abcdef0123456789abcdef01234567', 'missing'))).rejects.toThrow(/no longer in the repository/)
      expect(new ChangeReceiptService(f.thread).list()).toEqual([])
      f.commit(f.repo, 'parent\n', 'parent.txt')
      await service.integrate(request(child, pinned, 'moved'))
      expect(f.read(f.repo)).toBe('task A\n')
      expect(f.read(f.repo, 'parent.txt')).toBe('parent\n')
    })

    it('a crash after the intent was written recovers the pinned merge, even though the subagent has moved on', async () => {
      const { child, pinned, later } = continuedAfterTask()
      const append = ThreadJournal.prototype.append
      const crashed = vi.spyOn(ThreadJournal.prototype, 'append').mockImplementation(function (this: ThreadJournal, entry) {
        const written = append.call(this, entry)
        if (entry.state === 'prepared') throw new Error('crash after the intent')
        return written
      })
      await expect(new ChildAgentIntegrationService(f.thread).integrate(request(child, pinned, 'crashed'))).rejects.toThrow('crash after the intent')
      crashed.mockRestore()
      expect(f.read(f.repo)).toBe('base\n')
      // The durable request carries the pin, so recovery needs nothing from the live worktree of a worker that kept going.
      await new ChildAgentIntegrationService(f.thread).recoverPending(f.repo)
      expect(f.read(f.repo)).toBe('task A\n')
      expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
      expect(new ChangeReceiptService(f.thread).list()[0].contributions).toMatchObject([{ resultSha: pinned }])
      expect(git(child, 'rev-parse', 'HEAD')).toBe(later)
      expect(f.read(child)).toBe('task B, still being written\n')
    })
  })

  it('takes the pinned result only: a worker’s uncommitted files are not part of it and are not touched', async () => {
    const child = f.child()
    const result = f.commit(child, 'committed\n')
    writeFileSync(join(child, 'value.txt'), 'pending\n')
    await new ChildAgentIntegrationService(f.thread).integrate(request(child, result))
    expect(f.read(f.repo)).toBe('committed\n')
    expect(f.read(child)).toBe('pending\n')
    expect(git(child, 'rev-parse', 'HEAD')).toBe(result)
  })
})
