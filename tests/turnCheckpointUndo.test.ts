import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { CodeRevertService } from '../src/mms/actions/CodeRevertService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { pressed } from './support/userRequest'

const roots: string[] = []
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'mousse-action-')); roots.push(base)
  const repo = join(base, 'repo'); const thread = join(base, 'thread'); mkdirSync(repo); mkdirSync(thread)
  execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo }); execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repo })
  writeFileSync(join(repo, 'value.txt'), 'base\n'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })
  return { repo, thread }
}
afterEach(() => { vi.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

const boundary = { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' }

describe('turn checkpoints and compensating undo', () => {
  it('snapshots every non-ignored turn change and undoes it without adding or rewriting a commit', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    const { action } = await actions.runCheckpointedAction({
      threadId: 'thread', turnId: 'turn', conversationBranchId: 'main', workspacePath: repo,
      presentationMessageStart: 0, presentationMessageEnd: 1, nativeContextBoundary: boundary
    }, () => { writeFileSync(join(repo, 'value.txt'), 'changed\n'); writeFileSync(join(repo, 'new.txt'), 'new\n') })
    // The turn runs between two snapshots, each on the HEAD it was taken on (snapshot → its exact bytes → HEAD); nothing is committed on the branch.
    expect(execFileSync('git', ['rev-parse', `${action.startSha}^^`], { cwd: repo, encoding: 'utf8' }).trim()).toBe(before)
    expect(action.endSha).not.toBe(action.startSha)
    expect(action.commits).toEqual([])
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(before)
    expect(action.changedPaths.map((item) => item.path).sort()).toEqual(['new.txt', 'value.txt'])

    const compensation = await pressed('Undo', () => new UndoService(thread).undoLatest('main', repo))
    expect(readFileSync(join(repo, 'value.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n')
    expect(compensation.endSha).not.toBe(action.startSha)
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('1')
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(before)
    expect(actions.get(action.id)?.state).toBe('undone')
  }, 15_000)

  it('reverts older code without rewinding the current conversation lineage', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const first = await actions.runCheckpointedAction({
      threadId: 'thread', turnId: 'first', conversationBranchId: 'main', workspacePath: repo,
      presentationMessageStart: 0, presentationMessageEnd: 1, nativeContextBoundary: boundary
    }, () => writeFileSync(join(repo, 'value.txt'), 'first\n'))
    await actions.runCheckpointedAction({
      threadId: 'thread', turnId: 'second', conversationBranchId: 'main', workspacePath: repo,
      presentationMessageStart: 1, presentationMessageEnd: 2, nativeContextBoundary: boundary
    }, () => writeFileSync(join(repo, 'other.txt'), 'second\n'))
    const reverted = await pressed('Revert', () => new CodeRevertService(thread).revertCode(first.action.id, repo))
    expect(readFileSync(join(repo, 'value.txt'), 'utf8').trim()).toBe('base')
    expect(readFileSync(join(repo, 'other.txt'), 'utf8').trim()).toBe('second')
    expect(reverted.parentActionId).toBe(actions.list()[1].id)
  }, 15_000)

  it('records no-op actions so conversation lineage remains complete', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const { action } = await actions.runCheckpointedAction({
      threadId: 'thread', turnId: 'noop', conversationBranchId: 'main', workspacePath: repo,
      presentationMessageStart: 0, presentationMessageEnd: 1, nativeContextBoundary: boundary
    }, () => undefined)
    expect(action.startSha).toBe(action.endSha)
    expect(action.commits).toEqual([])
    expect(action.state).toBe('completed')
  })

  it('rejects stale action revisions under the mutation lock', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    await actions.runCheckpointedAction({
      threadId: 'thread', turnId: 'first', conversationBranchId: 'main', workspacePath: repo,
      presentationMessageStart: 0, presentationMessageEnd: 1, nativeContextBoundary: boundary
    }, () => writeFileSync(join(repo, 'value.txt'), 'first\n'))
    const currentRevision = actions.currentRevision()

    await expect(actions.runCheckpointedAction({
      threadId: 'thread', turnId: 'stale', conversationBranchId: 'main', workspacePath: repo,
      presentationMessageStart: 1, presentationMessageEnd: 2, nativeContextBoundary: boundary,
      expectedJournalRevision: currentRevision - 1
    }, () => writeFileSync(join(repo, 'value.txt'), 'stale\n'))).rejects.toThrow(
      `STALE_JOURNAL_GENERATION:${currentRevision}`
    )
    expect(readFileSync(join(repo, 'value.txt'), 'utf8').trim()).toBe('first')
    expect(actions.list()).toHaveLength(1)
  }, 15_000)
})

describe('a project-folder turn that committed', () => {
  const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  /** HEAD, the real index and every branch: what Undo, Redo and Revert never touch. */
  const gitState = (repo: string) => ({ head: gitIn(repo, 'rev-parse', 'HEAD'), index: gitIn(repo, 'ls-files', '--stage'), branches: gitIn(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads') })
  const turn = (actions: ThreadActionService, repo: string, turnId: string, mutate: () => void, start = 0) => actions.runCheckpointedAction({
    threadId: 'thread', turnId, conversationBranchId: 'main', workspacePath: repo,
    presentationMessageStart: start, presentationMessageEnd: start + 1, nativeContextBoundary: boundary
  }, mutate)
  const commitDiscount = (repo: string) => () => {
    writeFileSync(join(repo, 'discount.js'), 'export const discount = 0.1\n'); gitIn(repo, 'add', 'discount.js'); gitIn(repo, 'commit', '-qm', 'discount')
  }

  it('Undo restores the files, leaves HEAD, the index and the branches alone, and names the commit and its branch', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const branch = gitIn(repo, 'branch', '--show-current')
    const { action } = await turn(actions, repo, 'turn', commitDiscount(repo))
    const commit = gitIn(repo, 'rev-parse', 'HEAD')
    expect(action.commits).toEqual([commit])
    const before = gitState(repo)

    const undone = await pressed('Undo', () => new UndoService(thread).undoLatest('main', repo))
    expect(undone.notice).toBe(`Undo restored files only. Commit ${commit.slice(0, 7)} from this turn stays on ${branch}, so Git now shows its changes as undone.`)
    expect(undone.commits).toEqual([])
    expect(actions.get(undone.id)?.notice).toBe(undone.notice)
    expect(gitState(repo)).toEqual(before)
    // What the notice says Git now shows.
    expect(gitIn(repo, 'status', '--porcelain')).toBe('D discount.js')
  }, 15_000)

  it('a turn that made no commit has no notice', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    await turn(actions, repo, 'turn', () => writeFileSync(join(repo, 'value.txt'), 'changed\n'))
    expect((await pressed('Undo', () => new UndoService(thread).undoLatest('main', repo))).notice).toBeUndefined()
  }, 15_000)

  it('says when the branch has moved since and no longer holds the commit', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const branch = gitIn(repo, 'branch', '--show-current')
    const { action } = await turn(actions, repo, 'turn', commitDiscount(repo))
    // The person moves the branch back by hand after the turn; Mousse records that as their own change.
    gitIn(repo, 'reset', '-q', '--hard', 'HEAD~1')
    await actions.recordOutsideChanges({ threadId: 'thread', conversationBranchId: 'main', workspacePath: repo })
    const reverted = await pressed('Revert', () => new CodeRevertService(thread).revertCode(action.id, repo))
    expect(reverted.notice).toBe(`Revert restored files only. Commit ${action.commits[0]!.slice(0, 7)} from this turn was made on ${branch}, which has moved since and no longer holds it.`)
  }, 15_000)

  it('Revert of an older turn that committed names the commit too', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const branch = gitIn(repo, 'branch', '--show-current')
    const { action } = await turn(actions, repo, 'first', commitDiscount(repo))
    await turn(actions, repo, 'second', () => writeFileSync(join(repo, 'other.txt'), 'second\n'), 1)
    const before = gitState(repo)
    const reverted = await pressed('Revert', () => new CodeRevertService(thread).revertCode(action.id, repo))
    expect(reverted.notice).toBe(`Revert restored files only. Commit ${action.commits[0]!.slice(0, 7)} from this turn stays on ${branch}, so Git now shows its changes as reverted.`)
    expect(gitState(repo)).toEqual(before)
  }, 15_000)

  it('an Undo interrupted after the files changed is recovered with the same notice', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const branch = gitIn(repo, 'branch', '--show-current')
    const { action } = await turn(actions, repo, 'turn', commitDiscount(repo))
    const before = gitState(repo)
    // The daemon stops after the files changed and before the Undo was recorded.
    vi.spyOn(ChangeReceiptService.prototype, 'record').mockRejectedValueOnce(new Error('daemon stopped'))
    await expect(pressed('Undo', () => new UndoService(thread).undoLatest('main', repo))).rejects.toThrow('daemon stopped')
    expect(actions.get(action.id)?.state).toBe('undoing')

    await new UndoService(thread).recoverPending(repo, () => undefined)
    const target = actions.get(action.id)!
    expect(target.state).toBe('undone')
    const recovered = actions.get(target.compensationActionId!)!
    expect(recovered.notice).toBe(`Undo restored files only. Commit ${action.commits[0]!.slice(0, 7)} from this turn stays on ${branch}, so Git now shows its changes as undone.`)
    expect(recovered.commits).toEqual([])
    expect(gitState(repo)).toEqual(before)
  }, 15_000)
})

describe('checkpoints during in-progress git operations', () => {
  const head = (cwd: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  const gitIn = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

  function conflictedWorktree() {
    const { repo, thread } = fixture()
    const worktree = join(repo, '..', 'worktree')
    gitIn(repo, ['branch', '-M', 'main'])
    gitIn(repo, ['worktree', 'add', '-q', '-b', 'task', worktree])
    gitIn(worktree, ['config', 'user.name', 'Test']); gitIn(worktree, ['config', 'user.email', 'test@example.test'])
    writeFileSync(join(worktree, 'value.txt'), 'task\n'); gitIn(worktree, ['commit', '-qam', 'task'])
    writeFileSync(join(repo, 'value.txt'), 'main\n'); gitIn(repo, ['commit', '-qam', 'main'])
    expect(() => gitIn(worktree, ['merge', '--no-edit', 'main'])).toThrow()
    return { worktree, thread }
  }

  it('records conflict markers as files, says a merge is in progress, and leaves HEAD, the index and the merge untouched', async () => {
    const { worktree, thread } = conflictedWorktree()
    const before = head(worktree); const indexBefore = gitIn(worktree, ['ls-files', '-s'])
    const action = await new ThreadActionService(thread).checkpointExistingTurn({
      threadId: 'thread', turnId: 'retry', conversationBranchId: 'main', workspacePath: worktree,
      presentationMessageStart: 0, presentationMessageEnd: 1, nativeContextBoundary: boundary
    }, before, 'completed')
    expect(action.state).toBe('completed')
    expect(action.git?.operationInProgress).toBe('merge')
    expect(gitIn(worktree, ['show', `${action.endSha}:value.txt`])).toContain('<<<<<<<')
    expect(head(worktree)).toBe(before)
    expect(gitIn(worktree, ['ls-files', '-s'])).toBe(indexBefore)
    expect(readFileSync(join(worktree, 'value.txt'), 'utf8')).toContain('<<<<<<<')
    expect(gitIn(worktree, ['rev-parse', '--verify', 'MERGE_HEAD']).trim()).toBeTruthy()
  }, 30_000)

  it('records the files when only unmerged index entries remain after MERGE_HEAD is gone', async () => {
    const { worktree, thread } = conflictedWorktree()
    const mergeHead = gitIn(worktree, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim()
    rmSync(resolve(worktree, mergeHead), { force: true })
    const before = head(worktree); const indexBefore = gitIn(worktree, ['ls-files', '-s'])
    const action = await new ThreadActionService(thread).checkpointExistingTurn({
      threadId: 'thread', turnId: 'retry2', conversationBranchId: 'main', workspacePath: worktree,
      presentationMessageStart: 0, presentationMessageEnd: 1, nativeContextBoundary: boundary
    }, before, 'completed')
    expect(action.state).toBe('completed')
    expect(head(worktree)).toBe(before)
    expect(gitIn(worktree, ['ls-files', '-s'])).toBe(indexBefore)
  }, 30_000)
})
