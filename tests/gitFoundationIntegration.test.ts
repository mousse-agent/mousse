import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cancelPendingIntegrations } from '../src/mms/agents/ChildAgentIntegrationService'
import { buildSubagentResultReport } from '../src/mms/agents/subagentResultReport'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

describe('Git foundation pinned child results', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  beforeEach(() => { f = gitFoundationFixture() })
  afterEach(() => f.dispose())

  const pins = { base: 'refs/mousse/agents/child/base', result: 'refs/mousse/agents/child/result' }
  const report = (child: string, result: string) => buildSubagentResultReport({ cwd: child, workedIn: child, shared: false, baseSha: f.baseSha, resultSha: result, pins })

  it('reports the pinned base and result and never merges: the thread keeps its files, HEAD and index', () => {
    const child = f.child()
    f.commit(child, 'first\n')
    const result = f.commit(child, 'second\n')
    const status = git(f.repo, 'status', '--porcelain')
    const frozen = report(child, result)
    expect(frozen).toMatchObject({ baseSha: f.baseSha, resultSha: result, baseRef: pins.base, resultRef: pins.result, changedFiles: ['value.txt'], git: { head: result, commitCount: 2 } })
    expect(git(f.repo, 'rev-parse', pins.base)).toBe(f.baseSha)
    expect(git(f.repo, 'rev-parse', pins.result)).toBe(result)
    // Nothing came into the thread.
    expect(f.read(f.repo)).toBe('base\n')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    expect(git(f.repo, 'status', '--porcelain')).toBe(status)
    expect(new ChangeReceiptService(f.thread).list()).toEqual([])
    // A second report of the same result is the same report.
    expect(report(child, result)).toEqual(frozen)
  }, 30_000)

  it('the pins outlive the worktree and its branch', () => {
    const child = f.child()
    const result = f.commit(child, 'kept\n')
    report(child, result)
    git(f.repo, 'worktree', 'remove', '--force', child)
    git(f.repo, 'branch', '-D', 'child')
    expect(git(f.repo, 'show', `${pins.result}:value.txt`)).toBe('kept')
  })

  it('reports exactly the checkpoint, however far the live worktree has moved, and leaves that worktree alone', () => {
    const child = f.child()
    const pinned = f.commit(child, 'task A\n')
    const later = f.commit(child, 'task B, committed\n')
    writeFileSync(join(child, 'value.txt'), 'task B, still being written\n')
    expect(report(child, pinned)).toMatchObject({ resultSha: pinned, git: { head: pinned, commitCount: 1 } })
    expect(git(f.repo, 'rev-parse', pins.result)).toBe(pinned)
    expect(git(child, 'rev-parse', 'HEAD')).toBe(later)
    expect(f.read(child)).toBe('task B, still being written\n')
    expect(f.read(f.repo)).toBe('base\n')
  })

  it('an integration an older version left half done is cancelled, never replayed, and the files stay as they are', () => {
    const child = f.child()
    const pinned = f.commit(child, 'task A\n')
    new ThreadJournal(f.thread).append({
      operationId: 'crashed', operationType: 'child-integration', state: 'prepared',
      expectedPreState: { preSnapshot: f.baseSha, workerSha: pinned, spawnBaseSha: f.baseSha, expectedTree: '' },
      details: { request: { agentId: 'child', operationId: 'crashed', workerWorktree: child, spawnBaseSha: f.baseSha, pinnedWorkerSha: pinned, threadWorkspace: f.repo } }
    })
    expect(cancelPendingIntegrations(f.thread)).toEqual([{ operationId: 'crashed', agentId: 'child', resultSha: pinned, spawnBaseSha: f.baseSha }])
    expect(new ThreadJournal(f.thread).latestByOperation().get('crashed')).toMatchObject({ state: 'cancelled' })
    expect(f.read(f.repo)).toBe('base\n')
    expect(new ChangeReceiptService(f.thread).list()).toEqual([])
    expect(cancelPendingIntegrations(f.thread)).toEqual([])
  })
})
