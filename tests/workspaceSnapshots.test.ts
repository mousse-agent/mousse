import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { CodeRevertService } from '../src/mms/actions/CodeRevertService'
import { RedoService } from '../src/mms/actions/RedoService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { restoreChange, takeSnapshot, worktreeTree } from '../src/mms/actions/snapshots'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import type { ThreadAction } from '../src/shared/threadActions'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

let f: ReturnType<typeof gitFoundationFixture>
let cwd: string
let actions: ThreadActionService
beforeEach(async () => {
  f = gitFoundationFixture()
  cwd = (await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)).worktreePath
  actions = new ThreadActionService(f.thread)
})
afterEach(() => f.dispose())

const write = (path: string, value: string) => writeFileSync(join(cwd, path), value)
const turn = (id: string, mutate: () => void, start = 0) =>
  actions.runCheckpointedAction({ ...actionOptions(cwd, id), presentationMessageStart: start, presentationMessageEnd: start + 2 }, mutate)
const branches = () => git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')
const noPending = () => new ChangeReceiptService(f.thread).assertNoPendingOperation()

describe('turns are recorded as private snapshots', () => {
  it('a checkpoint makes no commit on any branch and leaves HEAD, the files and the real index as they were, partial staging included', async () => {
    // A file staged and then edited again (so the index and the files disagree), plus a new staged file.
    write('value.txt', 'staged\n'); git(cwd, 'add', 'value.txt'); write('value.txt', 'staged\nthen edited\n')
    write('new.txt', 'new\n'); git(cwd, 'add', 'new.txt')
    const head = git(cwd, 'rev-parse', 'HEAD')
    const refs = branches()
    const index = git(cwd, 'ls-files', '--stage')
    const cached = git(cwd, 'diff', '--cached', '--binary')

    const { action } = await turn('turn', () => write('agent.txt', 'agent\n'))
    expect(action.commits).toEqual([])
    expect(action.git).toMatchObject({ headBefore: head, headAfter: head, rewroteHistory: false, branchBefore: 'mousse/thread/task/main', branchAfter: 'mousse/thread/task/main' })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(branches()).toBe(refs)
    expect(git(cwd, 'ls-files', '--stage')).toBe(index)
    expect(git(cwd, 'diff', '--cached', '--binary')).toBe(cached)
    expect(git(cwd, 'status', '--porcelain', '--untracked-files=all')).toBe('A  new.txt\nMM value.txt\n?? agent.txt')
    // The snapshot has all of it, and its parent is HEAD, so it is reachable from no branch.
    expect(git(cwd, 'show', `${action.endSha}:value.txt`)).toBe('staged\nthen edited')
    expect(git(cwd, 'show', `${action.endSha}:agent.txt`)).toBe('agent')
    expect(git(cwd, 'rev-parse', `${action.endSha}^`)).toBe(head)
    expect(git(cwd, 'branch', '--contains', action.endSha)).toBe('')
    expect(git(cwd, 'log', '-1', '--format=%B', action.endSha)).toMatch(/^mousse snapshot: .*\n\nMousse-Thread: task\nMousse-Operation: .*\nMousse-Head: .*\nMousse-Branch: mousse\/thread\/task\/main$/)
  })

  it('pins the latest snapshot under the thread ref and keeps exactly the receipt’s before and after refs', async () => {
    const { action } = await turn('turn', () => write('agent.txt', 'agent\n'))
    const metadata = new ThreadWorkspaceManager(f.thread).load()!
    expect(git(cwd, 'rev-parse', metadata.retainedRef)).toBe(action.endSha)
    expect(metadata.snapshotSha).toBe(action.endSha)
    expect(metadata.branch).toBe('mousse/thread/task/main')
    const receipt = new ChangeReceiptService(f.thread).list().find((item) => item.id === action.receiptId)!
    expect(receipt.retainedRefs).toEqual([`refs/mousse/changes/${receipt.id}/before`, `refs/mousse/changes/${receipt.id}/after`])
    expect(git(cwd, 'rev-parse', receipt.retainedRefs[0])).toBe(action.startSha)
    expect(git(cwd, 'rev-parse', receipt.retainedRefs[1])).toBe(action.endSha)
    expect(receipt.git).toMatchObject({ rewroteHistory: false })
  })

  it('reuses the previous snapshot while the files and HEAD are unchanged', () => {
    const first = takeSnapshot(cwd, { reason: 'first' })
    expect(takeSnapshot(cwd, { reason: 'second' }).sha).toBe(first.sha)
    write('more.txt', 'x\n')
    expect(takeSnapshot(cwd, { reason: 'third' }).sha).not.toBe(first.sha)
  })

  it('rebuilds its private index when it is missing or corrupt', () => {
    write('a.txt', 'a\n')
    const first = takeSnapshot(cwd, { reason: 'first' })
    const index = join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'mousse', 'snapshot-index')
    expect(existsSync(index)).toBe(true)
    writeFileSync(index, 'not an index')
    write('b.txt', 'b\n')
    const second = takeSnapshot(cwd, { reason: 'second' })
    expect(git(cwd, 'ls-tree', '--name-only', second.sha).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt']))
    expect(second.sha).not.toBe(first.sha)
  })
})

describe('an agent that does its own Git work', () => {
  it('can switch branches mid-turn: the turn completes, the next turn starts, and Undo restores the files', async () => {
    const head = git(cwd, 'rev-parse', 'HEAD')
    const { action } = await turn('turn', () => {
      git(cwd, 'switch', '-q', '-c', 'issue-1-task')
      write('feature.txt', 'feature\n'); git(cwd, 'add', 'feature.txt'); git(cwd, 'commit', '-qm', 'feature')
      write('draft.txt', 'uncommitted\n')
    })
    const committed = git(cwd, 'rev-parse', 'HEAD')
    expect(action.state).toBe('completed')
    expect(action.git).toMatchObject({ branchBefore: 'mousse/thread/task/main', branchAfter: 'issue-1-task', headBefore: head, headAfter: committed, rewroteHistory: false })
    expect(action.commits).toEqual([committed])
    expect(action.changedPaths.map((item) => item.path).sort()).toEqual(['draft.txt', 'feature.txt'])
    expect(new ThreadWorkspaceManager(f.thread).verify().lifecycle).toBe('ready')
    noPending()

    // The next turn starts on the agent's branch without recovery.
    await turn('next', () => write('next.txt', 'next\n'), 2)
    await new UndoService(f.thread).undoLatest('main', cwd)
    expect(existsSync(join(cwd, 'next.txt'))).toBe(false)
    expect(existsSync(join(cwd, 'feature.txt'))).toBe(true)
  })

  it('Undo of a turn that committed restores the files and leaves HEAD and the branch alone', async () => {
    const { action } = await turn('turn', () => {
      git(cwd, 'switch', '-q', '-c', 'issue-2-task')
      write('feature.txt', 'feature\n'); git(cwd, 'add', 'feature.txt'); git(cwd, 'commit', '-qm', 'feature')
      write('value.txt', 'edited\n')
    })
    const head = git(cwd, 'rev-parse', 'HEAD')
    const undone = await new UndoService(f.thread).undoLatest('main', cwd)
    expect(f.read(cwd)).toBe('base\n')
    expect(existsSync(join(cwd, 'feature.txt'))).toBe(false)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(cwd, 'branch', '--show-current')).toBe('issue-2-task')
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('feature')
    expect(undone).toMatchObject({ commits: [], startSha: expect.any(String), state: 'completed' })
    expect(undone.git).toMatchObject({ headBefore: head, headAfter: head })
    expect(actions.get(action.id)?.state).toBe('undone')
    // No commit of Mousse's anywhere: the branch history is the agent's own.
    expect(git(cwd, 'log', '--format=%s', '-5')).not.toMatch(/mousse/i)

    await new RedoService(f.thread).redoLatest('main', cwd)
    expect(f.read(cwd)).toBe('edited\n')
    expect(existsSync(join(cwd, 'feature.txt'))).toBe(true)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('can reset or rewrite history: the turn is recorded as it is and says history was rewritten', async () => {
    // The agent's earlier commit is the thread's HEAD when the turn starts.
    write('earlier.txt', 'earlier\n'); git(cwd, 'add', 'earlier.txt'); git(cwd, 'commit', '-qm', 'earlier')
    const before = git(cwd, 'rev-parse', 'HEAD')
    const { action } = await turn('turn', () => {
      git(cwd, 'reset', '--hard', '-q', 'HEAD~1')
      write('after-reset.txt', 'x\n')
    })
    expect(action.state).toBe('completed')
    expect(action.git).toMatchObject({ headBefore: before, headAfter: f.baseSha, rewroteHistory: true })
    expect(action.commits).toEqual([])
    expect(action.changedPaths.map((item) => item.path).sort()).toEqual(['after-reset.txt', 'earlier.txt'])
    noPending()
    await new UndoService(f.thread).undoLatest('main', cwd)
    expect(existsSync(join(cwd, 'after-reset.txt'))).toBe(false)
    expect(existsSync(join(cwd, 'earlier.txt'))).toBe(true)
  })

  it('can commit and push: Undo restores the files, leaves HEAD alone and says the commits were already pushed', async () => {
    const remote = join(f.root, 'remote.git')
    git(f.root, 'init', '-q', '--bare', remote)
    git(cwd, 'remote', 'add', 'origin', remote)
    const { action } = await turn('turn', () => {
      write('pushed.txt', 'pushed\n'); git(cwd, 'add', 'pushed.txt'); git(cwd, 'commit', '-qm', 'pushed')
      git(cwd, 'push', '-q', 'origin', 'HEAD:refs/heads/feature')
    })
    const head = git(cwd, 'rev-parse', 'HEAD')
    expect(action.commits).toEqual([head])

    const undone = await new UndoService(f.thread).undoLatest('main', cwd)
    expect(existsSync(join(cwd, 'pushed.txt'))).toBe(false)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(undone.notice).toBe('These commits were already pushed to origin/feature; Undo restores files only.')
    // The notice stays on the recorded action, where the app reads it.
    expect(actions.get(undone.id)?.notice).toBe(undone.notice)
  })

  it('has no notice when its commits were not pushed', async () => {
    await turn('turn', () => { write('local.txt', 'x\n'); git(cwd, 'add', 'local.txt'); git(cwd, 'commit', '-qm', 'local') })
    expect((await new UndoService(f.thread).undoLatest('main', cwd)).notice).toBeUndefined()
  })

  it('takes a snapshot during an in-progress rebase and records it, without touching the rebase', async () => {
    const main = git(cwd, 'branch', '--show-current')
    git(cwd, 'switch', '-q', '-c', 'side'); write('value.txt', 'side\n'); git(cwd, 'commit', '-qam', 'side')
    git(cwd, 'switch', '-q', main); write('value.txt', 'main\n'); git(cwd, 'commit', '-qam', 'main')
    git(cwd, 'switch', '-q', 'side')
    const { action } = await turn('turn', () => {
      expect(() => git(cwd, 'rebase', '-q', main)).toThrow()
      write('other.txt', 'during rebase\n')
    })
    expect(action.state).toBe('completed')
    expect(action.git?.operationInProgress).toBe('rebase')
    expect(git(cwd, 'show', `${action.endSha}:other.txt`)).toBe('during rebase')
    expect(git(cwd, 'diff', '--name-only', '--diff-filter=U')).toBe('value.txt')
    expect(existsSync(join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'rebase-merge'))).toBe(true)
    // Restoring files over an unfinished rebase is refused until the person finishes it.
    await expect(new UndoService(f.thread).undoLatest('main', cwd)).rejects.toMatchObject({ code: 'workspace_conflict' })
  })
})

describe('changes made outside Mousse', () => {
  it('between turns become a user receipt and snapshot, and the next turn starts from it', async () => {
    await turn('first', () => write('agent.txt', 'agent\n'))
    write('notes.md', 'mine\n'); write('value.txt', 'my edit\n')
    const head = git(cwd, 'rev-parse', 'HEAD')

    const { startSha, action } = await actions.recordOutsideChanges({ threadId: 'task', conversationBranchId: 'main', workspacePath: cwd })
    expect(action).toMatchObject({ actor: { kind: 'user' }, state: 'completed', endSha: startSha })
    expect(action!.changedPaths.map((item) => item.path).sort()).toEqual(['notes.md', 'value.txt'])
    const receipt = new ChangeReceiptService(f.thread).list().find((item) => item.id === action!.receiptId)!
    expect(receipt).toMatchObject({ kind: 'checkpoint', actor: { kind: 'user' }, afterSha: startSha })
    expect(new ThreadWorkspaceManager(f.thread).load()!.snapshotSha).toBe(startSha)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)

    const second = await turn('second', () => write('agent2.txt', 'agent\n'), 2)
    expect(second.action.startSha).toBe(startSha)
    expect(second.action.changedPaths.map((item) => item.path)).toEqual(['agent2.txt'])
  })

  it('are not recorded when nothing changed, however often a turn starts', async () => {
    await turn('first', () => write('agent.txt', 'agent\n'))
    const count = actions.list().length
    for (let index = 0; index < 3; index++) expect((await actions.recordOutsideChanges({ threadId: 'task', conversationBranchId: 'main', workspacePath: cwd })).action).toBeUndefined()
    expect(actions.list()).toHaveLength(count)
  })

  it('switching branches or moving HEAD between turns is not a change of files and locks nothing', async () => {
    await turn('first', () => write('agent.txt', 'agent\n'))
    git(cwd, 'switch', '-q', '-c', 'elsewhere')
    expect((await actions.recordOutsideChanges({ threadId: 'task', conversationBranchId: 'main', workspacePath: cwd })).action).toBeUndefined()
    expect(new ThreadWorkspaceManager(f.thread).verify().lifecycle).toBe('ready')
  })
})

describe('Undo, Redo and revert by three-way merge', () => {
  it('Undo keeps later edits to other files and refuses overlapping ones, changing nothing', async () => {
    const { action } = await turn('turn', () => { write('agent.txt', 'agent\n'); write('value.txt', 'agent edit\n') })
    write('later.txt', 'later\n')
    await new UndoService(f.thread).undoLatest('main', cwd)
    expect(existsSync(join(cwd, 'later.txt'))).toBe(true)
    expect(existsSync(join(cwd, 'agent.txt'))).toBe(false)
    expect(actions.get(action.id)?.state).toBe('undone')
    await new RedoService(f.thread).redoLatest('main', cwd)

    // An edit inside the same file as the turn's change overlaps with it.
    write('value.txt', 'agent edit then mine\n')
    const before = git(cwd, 'status', '--porcelain', '--untracked-files=all')
    await expect(new UndoService(f.thread).undoLatest('main', cwd)).rejects.toMatchObject({ code: 'restore_conflict', details: { files: ['value.txt'] } })
    expect(git(cwd, 'status', '--porcelain', '--untracked-files=all')).toBe(before)
    expect(f.read(cwd)).toBe('agent edit then mine\n')
    noPending()
  })

  it('reverting an older turn refuses on a conflict and changes nothing', async () => {
    const first = await turn('first', () => write('value.txt', 'one\n'))
    await turn('second', () => write('value.txt', 'two\n'), 2)
    const journal = new ThreadJournal(f.thread).list().length
    const receipts = new ChangeReceiptService(f.thread).list().length
    await expect(new CodeRevertService(f.thread).revertCode(first.action.id, cwd)).rejects.toMatchObject({ code: 'restore_conflict', details: { files: ['value.txt'] } })
    expect(f.read(cwd)).toBe('two\n')
    expect(actions.list().filter((item) => item.state === 'completed')).toHaveLength(2)
    expect(new ChangeReceiptService(f.thread).list()).toHaveLength(receipts)
    expect(new ThreadJournal(f.thread).list().filter((entry) => entry.operationType === 'code-revert')).toEqual([])
    expect(new ThreadJournal(f.thread).list().length).toBeGreaterThanOrEqual(journal)
    noPending()
  })

  it('reverting an older turn takes back only its files and moves no commit', async () => {
    const first = await turn('first', () => write('first.txt', 'first\n'))
    await turn('second', () => write('second.txt', 'second\n'), 2)
    const head = git(cwd, 'rev-parse', 'HEAD')
    const reverted = await new CodeRevertService(f.thread).revertCode(first.action.id, cwd)
    expect(existsSync(join(cwd, 'first.txt'))).toBe(false)
    expect(existsSync(join(cwd, 'second.txt'))).toBe(true)
    expect(reverted).toMatchObject({ commits: [], changedPaths: [expect.objectContaining({ path: 'first.txt' })] })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('reverting a turn that changed no files is refused', async () => {
    const empty = await turn('empty', () => undefined)
    await expect(new CodeRevertService(f.thread).revertCode(empty.action.id, cwd)).rejects.toThrow(/no reversible repository changes/)
  })

  it('restoreChange never touches the real index, even for a file the user staged', async () => {
    const { action } = await turn('turn', () => write('value.txt', 'agent\n'))
    git(cwd, 'add', 'value.txt')
    const cached = git(cwd, 'diff', '--cached', '--binary')
    const ours = takeSnapshot(cwd, { reason: 'ours' })
    const result = restoreChange(cwd, { reason: 'undo', base: action.endSha, ours: ours.sha, theirs: action.startSha })
    expect('snapshot' in result).toBe(true)
    expect(f.read(cwd)).toBe('base\n')
    // The index still holds the staged agent version: the files and the index now disagree, as they would after any edit.
    expect(git(cwd, 'diff', '--cached', '--binary')).toBe(cached)
  })

  it('works in a thread with no workspace metadata, such as a plain checkout', async () => {
    const other = gitFoundationFixture()
    try {
      const service = new ThreadActionService(other.thread)
      const { action } = await service.runCheckpointedAction(actionOptions(other.repo), () => writeFileSync(join(other.repo, 'x.txt'), 'x\n'))
      expect(action.startSha).not.toBe(action.endSha)
      await new UndoService(other.thread).undoLatest('main', other.repo)
      expect(existsSync(join(other.repo, 'x.txt'))).toBe(false)
      expect(git(other.repo, 'log', '--format=%s')).toBe('base')
    } finally { other.dispose() }
  })
})

describe('recovery', () => {
  /** What the version before snapshots left in the journal when the checkpoint refused a switched branch. */
  function legacyLock(error: string, extra: Record<string, unknown> = {}): ThreadAction {
    const startSha = git(cwd, 'rev-parse', 'HEAD')
    const action: ThreadAction = {
      id: 'legacy-action', turnId: 'legacy-turn', conversationBranchId: 'main', actor: { kind: 'main' },
      presentationMessageStart: 0, presentationMessageEnd: 2, nativeContextBoundary: { messageIndex: 2, compactionGeneration: 0, fidelity: 'exact' },
      startSha, endSha: startSha, commits: [], childIntegrations: [], changedPaths: [], externalEffects: [],
      reversible: true, state: 'running', createdAt: new Date().toISOString()
    }
    actions.replace([action])
    const journal = new ThreadJournal(f.thread)
    journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'running', expectedPreState: { startSha, actionId: action.id }, details: { action } })
    journal.append({ operationId: action.id, operationType: 'action-checkpoint', state: 'recovery_required', details: { actionId: action.id, startSha, error, ...extra } })
    return action
  }

  it.each([
    ['branch changed', 'Error: Workspace branch changed during execution; recovery is required.'],
    ['history diverged', 'Error: Workspace history diverged during execution; recovery is required.']
  ])('a thread locked by the old %s check recovers and unlocks', async (_name, error) => {
    const legacy = legacyLock(error)
    // The agent had switched branches, committed and left more files, which is what locked the thread.
    git(cwd, 'switch', '-q', '-c', 'agent-branch'); write('done.txt', 'done\n'); git(cwd, 'add', 'done.txt'); git(cwd, 'commit', '-qm', 'done'); write('wip.txt', 'wip\n')
    expect(() => actions.beginTurn(actionOptions(cwd, 'blocked'), legacy.startSha)).toThrow(/Workspace recovery required/)

    await actions.recoverPending(cwd)
    noPending()
    const recovered = actions.get(legacy.id)!
    expect(recovered.state).toBe('stopped')
    expect(recovered.startSha).toBe(legacy.startSha)
    expect(git(cwd, 'show', `${recovered.endSha}:wip.txt`)).toBe('wip')
    expect(recovered.changedPaths.map((item) => item.path).sort()).toEqual(['done.txt', 'wip.txt'])
    expect(recovered.commits).toHaveLength(1)
    expect(recovered.git).toMatchObject({ branchAfter: 'agent-branch', rewroteHistory: false })
    expect(git(cwd, 'branch', '--show-current')).toBe('agent-branch')
    // The thread works again.
    await turn('after', () => write('after.txt', 'x\n'), 2)
  })

  it('a locked thread whose old user commit landed with files still changed recovers the same way', async () => {
    const legacy = legacyLock('Interrupted commit needs recovery: it landed and the workspace still has uncommitted changes.', { actionState: 'completed', failurePolicy: 'record' })
    write('value.txt', 'hook rewrote this\n'); git(cwd, 'commit', '-qam', 'user commit'); write('left.txt', 'left\n')
    await actions.recoverPending(cwd)
    noPending()
    expect(actions.get(legacy.id)).toMatchObject({ state: 'completed' })
    expect(actions.get(legacy.id)!.commits).toHaveLength(1)
  })

  it('records an interrupted checkpoint again from the files, whatever branch they are on', async () => {
    const options = { ...actionOptions(cwd, 'crashed'), threadId: 'task' }
    const { startSha } = await actions.recordOutsideChanges(options)
    actions.beginTurn(options, startSha)
    git(cwd, 'switch', '-q', '-c', 'crash-branch'); write('half.txt', 'half\n')
    await actions.recoverPending(cwd)
    const recovered = actions.list().find((item) => item.turnId === 'crashed')!
    expect(recovered.state).toBe('stopped')
    expect(git(cwd, 'show', `${recovered.endSha}:half.txt`)).toBe('half')
    noPending()
  })

  /** An Undo that was interrupted after writing its intent, as `UndoService` writes it. */
  function interruptedUndo(target: ThreadAction, applyFiles: boolean): string {
    const operationId = 'interrupted-undo'
    const ours = takeSnapshot(cwd, { reason: 'before undo', operationId })
    const journal = new ThreadJournal(f.thread)
    let expectedTree = ''
    const restored = restoreChange(cwd, { reason: 'undo', operationId, base: target.endSha, ours: ours.sha, theirs: target.startSha }, (tree) => {
      expectedTree = tree
      journal.append({ operationId, operationType: 'undo', state: 'prepared', expectedPreState: { preUndoSha: ours.sha, actionId: target.id },
        details: { target, contextAction: target, kind: 'undo', compensationId: 'compensation-1', restoreContext: false, ours: ours.sha, expectedTree } })
      actions.replace(actions.list().map((item) => item.id === target.id ? { ...item, state: 'undoing' as const } : item))
    })
    if (!applyFiles) {
      // The crash came before the files changed: put them back as they were.
      expect('snapshot' in restored).toBe(true)
      restoreChange(cwd, { reason: 'undo the undo', base: (restored as { snapshot: { sha: string } }).snapshot.sha, ours: (restored as { snapshot: { sha: string } }).snapshot.sha, theirs: ours.sha })
    }
    return expectedTree
  }

  it('an Undo that crashed after changing the files is recorded from the files, without being replayed', async () => {
    const { action } = await turn('turn', () => write('agent.txt', 'agent\n'))
    interruptedUndo(action, true)
    expect(existsSync(join(cwd, 'agent.txt'))).toBe(false)
    await new UndoService(f.thread).recoverPending(cwd, () => undefined)
    noPending()
    expect(actions.get(action.id)).toMatchObject({ state: 'undone', compensationActionId: 'compensation-1' })
    const compensation = actions.get('compensation-1')!
    expect(compensation).toMatchObject({ actor: { kind: 'user' }, state: 'completed', commits: [] })
    expect(compensation.changedPaths.map((item) => item.path)).toEqual(['agent.txt'])
    expect(worktreeTree(cwd)).toBe(git(cwd, 'rev-parse', `${action.startSha}^{tree}`))
  })

  it('an Undo that crashed before changing the files is cancelled and the turn stays undoable', async () => {
    const { action } = await turn('turn', () => write('agent.txt', 'agent\n'))
    interruptedUndo(action, false)
    expect(existsSync(join(cwd, 'agent.txt'))).toBe(true)
    await new UndoService(f.thread).recoverPending(cwd, () => undefined)
    noPending()
    expect(actions.get(action.id)?.state).toBe('completed')
    await new UndoService(f.thread).undoLatest('main', cwd)
    expect(existsSync(join(cwd, 'agent.txt'))).toBe(false)
  })

  it('an Undo that crashed with files that match neither state stays pending for a person', async () => {
    const { action } = await turn('turn', () => write('agent.txt', 'agent\n'))
    interruptedUndo(action, false)
    mkdirSync(join(cwd, 'surprise'), { recursive: true }); write('surprise/file.txt', 'x\n')
    await expect(new UndoService(f.thread).recoverPending(cwd, () => undefined)).rejects.toThrow(/neither the state before nor the state after/)
    expect(() => noPending()).toThrow()
    expect(readFileSync(join(cwd, 'surprise', 'file.txt'), 'utf8')).toBe('x\n')
  })
})

describe('conversation forks', () => {
  it('pin the snapshot without a Git branch, and activating one switches the files only', async () => {
    const { action } = await turn('turn', () => write('agent.txt', 'agent\n'))
    write('later.txt', 'later\n')
    const head = git(cwd, 'rev-parse', 'HEAD')
    const before = branches()
    const service = new ConversationBranchService(f.thread)
    const fork = await service.fork(cwd, 'main', action.id, 'Alternate')
    expect(git(cwd, 'rev-parse', fork.retainedRef)).toBe(action.endSha)
    expect(branches()).toBe(before)

    await service.activate(cwd, fork.id)
    expect(existsSync(join(cwd, 'later.txt'))).toBe(false)
    expect(readFileSync(join(cwd, 'agent.txt'), 'utf8')).toBe('agent\n')
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(branches()).toBe(before)
    expect(new ThreadWorkspaceManager(f.thread).load()).toMatchObject({ conversationBranchId: fork.id, branch: 'mousse/thread/task/main' })
    // The files the person had when leaving were recorded as theirs first.
    const outside = actions.list().find((item) => item.turnId.startsWith('user-changes:'))!
    expect(git(cwd, 'show', `${outside.endSha}:later.txt`)).toBe('later')
  })
})
