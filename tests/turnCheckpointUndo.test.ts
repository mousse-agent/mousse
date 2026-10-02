import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { CodeRevertService } from '../src/mms/actions/CodeRevertService'

const roots: string[] = []
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'mousse-action-')); roots.push(base)
  const repo = join(base, 'repo'); const thread = join(base, 'thread'); mkdirSync(repo); mkdirSync(thread)
  execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo }); execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repo })
  writeFileSync(join(repo, 'value.txt'), 'base\n'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })
  return { repo, thread }
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

const boundary = { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' }

describe('turn checkpoints and compensating undo', () => {
  it('commits every non-ignored turn change and undoes it without rewriting history', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    const { action } = await actions.runCheckpointedAction({
      threadId: 'thread', turnId: 'turn', conversationBranchId: 'main', workspacePath: repo,
      presentationMessageStart: 0, presentationMessageEnd: 1, nativeContextBoundary: boundary
    }, () => { writeFileSync(join(repo, 'value.txt'), 'changed\n'); writeFileSync(join(repo, 'new.txt'), 'new\n') })
    expect(action.startSha).toBe(before)
    expect(action.endSha).not.toBe(before)
    expect(action.changedPaths.map((item) => item.path).sort()).toEqual(['new.txt', 'value.txt'])

    const compensation = await new UndoService(thread).undoLatest('main', repo)
    expect(readFileSync(join(repo, 'value.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n')
    expect(compensation.endSha).not.toBe(action.startSha)
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('3')
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
    const reverted = await new CodeRevertService(thread).revertCode(first.action.id, repo)
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

describe('checkpoint safety during in-progress git operations', () => {
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

  it('refuses to checkpoint conflict markers and leaves HEAD and the index untouched', async () => {
    const { worktree, thread } = conflictedWorktree()
    const before = head(worktree); const indexBefore = gitIn(worktree, ['ls-files', '-s'])
    await expect(new ThreadActionService(thread).checkpointExistingTurn({
      threadId: 'thread', turnId: 'retry', conversationBranchId: 'main', workspacePath: worktree,
      presentationMessageStart: 0, presentationMessageEnd: 1, nativeContextBoundary: boundary
    }, before, 'completed')).rejects.toThrow(/in-progress Git operation|unmerged/)
    expect(head(worktree)).toBe(before)
    expect(gitIn(worktree, ['ls-files', '-s'])).toBe(indexBefore)
    expect(readFileSync(join(worktree, 'value.txt'), 'utf8')).toContain('<<<<<<<')
  }, 30_000)

  it('refuses when only unmerged index entries remain after MERGE_HEAD is gone', async () => {
    const { worktree, thread } = conflictedWorktree()
    const mergeHead = gitIn(worktree, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim()
    rmSync(resolve(worktree, mergeHead), { force: true })
    const before = head(worktree)
    await expect(new ThreadActionService(thread).checkpointExistingTurn({
      threadId: 'thread', turnId: 'retry2', conversationBranchId: 'main', workspacePath: worktree,
      presentationMessageStart: 0, presentationMessageEnd: 1, nativeContextBoundary: boundary
    }, before, 'completed')).rejects.toThrow(/unmerged/)
    expect(head(worktree)).toBe(before)
  }, 30_000)
})
