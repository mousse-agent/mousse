import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { RedoService } from '../src/mms/actions/RedoService'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

describe('Git foundation merge-aware compensation', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  beforeEach(() => { f = gitFoundationFixture() })
  afterEach(() => f.dispose())

  it('preserves the originating prompt identity through repeated managed Undo and Redo', async () => {
    const service = new ThreadActionService(f.thread)
    const { action } = await service.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'value.txt'), 'managed\n'))
    const validate = (target: import('../src/shared/threadActions').ThreadAction) => {
      expect(target.turnId).toBe(action.turnId)
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      await new UndoService(f.thread).undoLatest('main', f.repo, undefined, service.currentRevision(), undefined, 'undo', action.turnId, validate)
      expect(f.read(f.repo)).toBe('base\n')
      const redo = await new RedoService(f.thread).redoLatest('main', f.repo, service.currentRevision())
      expect(redo.turnId).toBe(action.turnId)
      expect(f.read(f.repo)).toBe('managed\n')
    }
  }, 30_000)

  it('undoes and redoes a no-ff integration containing two successive same-file child commits exactly once', async () => {
    const child = f.child()
    const first = f.commit(child, 'child first\n')
    const second = f.commit(child, 'child second\n')
    const service = new ThreadActionService(f.thread)
    const { action } = await service.runCheckpointedAction(actionOptions(f.repo), () => {
      git(f.repo, 'merge', '--no-ff', '--no-edit', second)
    })
    const merged = git(f.repo, 'rev-parse', 'HEAD')
    expect(f.read(f.repo)).toBe('child second\n')
    // The action lists the merge, not the commits the merge brought in: only first-parent commits count.
    expect(action.commits).toEqual([merged])
    expect(action.commits).not.toContain(first)
    expect(action.commits).not.toContain(second)
    // Undo restores the files by three-way merge of the snapshots. The merge commit stays on the branch.
    const undo = await new UndoService(f.thread).undoLatest('main', f.repo)
    expect(f.read(f.repo)).toBe('base\n')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(merged)
    expect(git(f.repo, 'rev-parse', `${undo.endSha}^{tree}`)).toBe(git(f.repo, 'rev-parse', `${f.baseSha}^{tree}`))
    expect(git(f.repo, 'status', '--porcelain')).toBe('M value.txt')
    const redo = await new RedoService(f.thread).redoLatest('main', f.repo)
    expect(f.read(f.repo)).toBe('child second\n')
    expect(git(f.repo, 'rev-parse', `${redo.endSha}^{tree}`)).toBe(git(f.repo, 'rev-parse', `${merged}^{tree}`))
    expect(git(f.repo, 'status', '--porcelain')).toBe('')
    expect(new Set([action.endSha, undo.endSha, redo.endSha]).size).toBe(3)
    expect(git(f.repo, 'merge-base', '--is-ancestor', second, 'HEAD')).toBe('')
  }, 30_000)

  it('reverses parent edits surrounding a child merge without double-reverting child ancestry', async () => {
    const child = f.child()
    f.commit(child, 'one\n')
    const result = f.commit(child, 'two\n')
    const { action } = await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(f.repo), () => {
      f.commit(f.repo, 'parent before\n', 'parent.txt')
      git(f.repo, 'merge', '--no-ff', '--no-edit', result)
      writeFileSync(join(f.repo, 'parent.txt'), 'parent after\n')
    })
    // The parent's own commit and the merge, first parents only; the edit after the merge is not committed.
    expect(action.commits).toHaveLength(2)
    await new UndoService(f.thread).undoLatest('main', f.repo)
    // The files go back to before the turn; the parent's own commit and the merge stay on the branch.
    expect(f.read(f.repo)).toBe('base\n')
    expect(() => f.read(f.repo, 'parent.txt')).toThrow()
    expect(git(f.repo, 'status', '--porcelain')).toContain('D parent.txt')
    await new RedoService(f.thread).redoLatest('main', f.repo)
    expect(f.read(f.repo)).toBe('two\n')
    expect(f.read(f.repo, 'parent.txt')).toBe('parent after\n')
  }, 30_000)

  it('refuses a later shell commit that overlaps with the turn, without changing code or action state', async () => {
    const service = new ThreadActionService(f.thread)
    const { action } = await service.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'value.txt'), 'managed\n'))
    const moved = f.commit(f.repo, 'unmanaged\n')
    await expect(new UndoService(f.thread).undoLatest('main', f.repo)).rejects.toMatchObject({ code: 'restore_conflict' })
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(moved)
    expect(f.read(f.repo)).toBe('unmanaged\n')
    expect(service.get(action.id)?.state).toBe('completed')
  })

  it('undoes a turn after an unrelated shell commit, leaving that commit alone', async () => {
    const service = new ThreadActionService(f.thread)
    const { action } = await service.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'value.txt'), 'managed\n'))
    const moved = f.commit(f.repo, 'unrelated\n', 'other.txt')
    await new UndoService(f.thread).undoLatest('main', f.repo)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(moved)
    expect(f.read(f.repo)).toBe('base\n')
    expect(f.read(f.repo, 'other.txt')).toBe('unrelated\n')
    expect(service.get(action.id)?.state).toBe('undone')
  })

  it('accepts authored commits during an admitted leased turn and between turns, without a recovery step', async () => {
    const resolver = new WorkspaceResolver(f.thread, 'task', f.repo)
    const workspace = (await resolver.resolve('agent')).workspacePath!
    const actions = new ThreadActionService(f.thread)
    const lease = await waitAcquireExecutionLease(f.thread, { source: 'test-admitted-turn' })
    try {
      const options = { ...actionOptions(workspace), heldThreadLease: lease }
      actions.beginTurn(options, f.baseSha)
      const authored = f.commit(workspace, 'agent commit\n')
      const action = await actions.checkpointExistingTurn(options, f.baseSha, 'completed')
      // The end is a snapshot whose parent is the agent's commit; the commit itself is listed and HEAD is left on it.
      expect(git(workspace, 'rev-parse', `${action.endSha}^`)).toBe(authored)
      expect(git(workspace, 'rev-parse', 'HEAD')).toBe(authored)
      expect(action.commits).toEqual([authored])
    } finally { releaseExecutionLeaseHandle(lease) }
    expect((await resolver.resolve('plan')).workspacePath).toBe(workspace)
    const unmanaged = f.commit(workspace, 'unmanaged later commit\n')
    expect((await resolver.resolve('agent')).workspacePath).toBe(workspace)
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(unmanaged)
    expect(f.read(workspace)).toBe('unmanaged later commit\n')
  }, 30_000)
})
