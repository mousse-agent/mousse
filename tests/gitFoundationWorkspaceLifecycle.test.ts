import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

let f: ReturnType<typeof gitFoundationFixture>
beforeEach(() => { f = gitFoundationFixture() })
afterEach(() => f.dispose())

it('restores the durable provisioning crash image after worktree add but before retained ref and completion', async () => {
  const manager = new ThreadWorkspaceManager(f.thread)
  const metadata = await manager.provision('task', 'main', f.repo)
  // Reconstruct precisely the on-disk image at the worktree-add boundary.
  // All paths belong to this test fixture; the branch/worktree and intent remain real.
  git(f.repo, 'update-ref', '-d', metadata.retainedRef)
  writeFileSync(manager.workspacePath, JSON.stringify({ ...metadata, lifecycle: 'provisioning' }))
  const journal = new ThreadJournal(f.thread)
  const completion = journal.list().find((entry) => entry.operationType === 'workspace-provision' && entry.state === 'completed')!
  const completionFile = `${String(completion.sequence).padStart(16, '0')}.json`
  expect(readdirSync(journal.directory)).toContain(completionFile)
  rmSync(join(journal.directory, completionFile))
  const restored = await new ThreadWorkspaceManager(f.thread).restore(f.repo)
  expect(restored.lifecycle).toBe('ready')
  expect(restored.worktreePath).toBe(metadata.worktreePath)
  expect(git(f.repo, 'rev-parse', restored.retainedRef)).toBe(f.baseSha)
  expect(journal.latestByOperation().get(completion.operationId)?.state).toBe('completed')
  expect(() => new ChangeReceiptService(f.thread).assertNoPendingOperation()).not.toThrow()
  expect(git(f.repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(2)
  const { action } = await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(restored.worktreePath), () => writeFileSync(join(restored.worktreePath, 'value.txt'), 'after restored provisioning\n'))
  expect(action.state).toBe('completed')
  expect(f.read(f.repo)).toBe('base\n')
})

it('completed checkpoint replay returns the same receipt while repeated execution is rejected before model mutation', async () => {
  const actions = new ThreadActionService(f.thread)
  let calls = 0
  const mutate = () => { calls++; writeFileSync(join(f.repo, 'value.txt'), `call ${calls}\n`) }
  const first = await actions.runCheckpointedAction(actionOptions(f.repo, 'stable-turn'), mutate)
  const second = await actions.checkpointExistingTurn(actionOptions(f.repo, 'stable-turn'), f.baseSha, 'completed')
  expect(second).toEqual(first.action)
  await expect(actions.runCheckpointedAction(actionOptions(f.repo, 'stable-turn'), mutate)).rejects.toThrow(/must not be replayed/)
  expect(calls).toBe(1)
  expect(actions.list()).toHaveLength(1)
  expect(new ChangeReceiptService(f.thread).list()).toHaveLength(1)
  expect(f.read(f.repo)).toBe('call 1\n')
})
