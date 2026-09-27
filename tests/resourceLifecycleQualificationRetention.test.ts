import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { ReceiptRefReleaseService } from '../src/mms/actions/ReceiptRefReleaseService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

it.each(['not a valid Git object identity\n', '0'.repeat(40) + '\n'])('keeps ref release pending when post-deletion verification encounters corrupt Git authority: %j', async (corruptRef) => {
  const f = gitFoundationFixture()
  try {
    writeFileSync(join(f.thread, 'meta.json'), '{"id":"task"}')
    const store = new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home, allowedTaskRoots: [f.root] })
    store.registerTask({ taskId: 'task', location: f.thread })
    const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(workspace.worktreePath), () => writeFileSync(join(workspace.worktreePath, 'value.txt'), 'expired result\n'))
    const receipt = new ChangeReceiptService(f.thread).list()[0]!
    let now = Date.now()
    const retention = new UndoRetentionService(f.thread, () => now)
    await retention.configure(workspace.worktreePath, { windowMs: 1000, migrationGraceMs: 1000, maxForwardStepMs: 100000 }, true)
    now += 10000; await retention.sweep(workspace.worktreePath)
    const release = new ReceiptRefReleaseService(store, 'task', () => now)
    const result = await release.release(workspace.worktreePath, { afterGit: () => {
      const commonDir = resolve(workspace.worktreePath, git(workspace.worktreePath, 'rev-parse', '--git-common-dir'))
      const path = join(commonDir, receipt.retainedRefs[0]!)
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, corruptRef)
    } })
    expect(result.releasedRefs).toEqual([])
    expect(result.retained).toHaveLength(1)
    const operations = [...new ThreadJournal(f.thread).latestByOperation().values()].filter((entry) => entry.operationType === 'undo-ref-release')
    expect(operations).toHaveLength(1)
    expect(operations[0].state).toBe('prepared')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
  } finally { f.dispose() }
}, 30_000)
