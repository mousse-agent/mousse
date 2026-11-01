import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { CodeRevertService } from '../src/mms/actions/CodeRevertService'
import { PublishService } from '../src/mms/actions/PublishService'
import { RedoService } from '../src/mms/actions/RedoService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { publishedRef, restoreChange, takeSnapshot, worktreeTree } from '../src/mms/actions/snapshots'
import { ChildAgentIntegrationService } from '../src/mms/agents/ChildAgentIntegrationService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { WorkspaceGcService } from '../src/mms/workspace/WorkspaceGcService'
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

  it('follows the files HEAD tracks on every snapshot: an ignored file force-added and committed later is in it', () => {
    write('.gitignore', '*.local\n'); git(cwd, 'add', '.gitignore'); git(cwd, 'commit', '-qm', 'ignore')
    write('settings.local', 'one\n')
    // The private index exists before the file is tracked, so seeding it from HEAD alone would never see the file.
    const before = takeSnapshot(cwd, { reason: 'before' })
    expect(git(cwd, 'ls-tree', '--name-only', before.sha)).not.toMatch(/settings\.local/)
    git(cwd, 'add', '-f', 'settings.local')
    const index = git(cwd, 'ls-files', '--stage')
    // Staged but not committed: the real index tracks it.
    expect(git(cwd, 'show', `${takeSnapshot(cwd, { reason: 'staged' }).sha}:settings.local`)).toBe('one')
    git(cwd, 'commit', '-qm', 'track the local settings')
    write('settings.local', 'two\n')
    const after = takeSnapshot(cwd, { reason: 'after' })
    expect(git(cwd, 'show', `${after.sha}:settings.local`)).toBe('two')
    expect(git(cwd, 'ls-files', '--stage')).toBe(index)
    // Untracked again by HEAD and the real index: an ignored file leaves the snapshot.
    git(cwd, 'rm', '-q', '--cached', 'settings.local'); git(cwd, 'commit', '-qm', 'untrack')
    expect(git(cwd, 'ls-tree', '--name-only', takeSnapshot(cwd, { reason: 'untracked' }).sha)).not.toMatch(/settings\.local/)
    expect(f.read(cwd, 'settings.local')).toBe('two\n')
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

  it('can create a repository with no commit inside the worktree: the turn is recorded without it and nothing locks', async () => {
    const tool = join(cwd, 'tool')
    const { action } = await turn('turn', () => {
      write('kept.txt', 'kept\n')
      mkdirSync(tool); git(tool, 'init', '-q'); writeFileSync(join(tool, 'x.txt'), 'x\n')
    })
    expect(action.state).toBe('completed')
    expect(action.changedPaths.map((item) => item.path)).toEqual(['kept.txt'])
    expect(git(cwd, 'ls-tree', '--name-only', action.endSha).split('\n')).not.toContain('tool')
    expect(new ThreadWorkspaceManager(f.thread).verify().lifecycle).toBe('ready')
    noPending()

    // Once it has a commit it is recorded as a link to that commit, like any nested repository.
    const { action: next } = await turn('next', () => {
      git(tool, 'add', 'x.txt'); git(tool, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.test', 'commit', '-qm', 'x')
    }, 2)
    expect(git(cwd, 'ls-tree', next.endSha, 'tool')).toMatch(/^160000 commit /)
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

  it('a retake that fails again keeps the operation waiting with what stopped it this time', async () => {
    const legacy = legacyLock('Error: Workspace branch changed during execution; recovery is required.')
    // Something that stops every snapshot: a file where Mousse keeps its private index.
    const blocker = join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'mousse')
    rmSync(blocker, { recursive: true, force: true }); writeFileSync(blocker, 'in the way\n')
    await expect(actions.recoverPending(cwd)).rejects.toThrow(/EEXIST/)
    const latest = new ThreadJournal(f.thread).latestByOperation().get(legacy.id)!
    expect(latest.state).toBe('recovery_required')
    expect((latest.details as { error?: string }).error).toMatch(/EEXIST/)

    rmSync(blocker)
    await actions.recoverPending(cwd)
    noPending()
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

describe('seeding another worktree from a snapshot', () => {
  it('a cross-thread fork starts at the commit the snapshot was taken on and gets its files, without a snapshot commit on its branch', async () => {
    write('earlier.txt', 'earlier\n'); git(cwd, 'add', 'earlier.txt'); git(cwd, 'commit', '-qm', 'earlier')
    const head = git(cwd, 'rev-parse', 'HEAD')
    const { action } = await turn('turn', () => { write('value.txt', 'turn result\n'); write('new.txt', 'new\n') })
    const forkThread = join(f.root, 'fork-thread'); mkdirSync(forkThread)
    const manager = new ThreadWorkspaceManager(forkThread)
    const seeded = await manager.provision('fork', 'main', f.repo, undefined, undefined, head, { snapshot: action.endSha })
    expect(f.read(seeded.worktreePath)).toBe('turn result\n')
    expect(f.read(seeded.worktreePath, 'new.txt')).toBe('new\n')
    expect(f.read(seeded.worktreePath, 'earlier.txt')).toBe('earlier\n')
    // The branch is at the real commit, the files are uncommitted, and the first turn will not call them outside changes.
    expect(git(seeded.worktreePath, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(seeded.worktreePath, 'status', '--porcelain', '--untracked-files=all')).toBe('M value.txt\n?? new.txt')
    expect(seeded.snapshotSha).toBe(action.endSha)
    expect(git(seeded.worktreePath, 'rev-parse', seeded.retainedRef)).toBe(action.endSha)
    const forkActions = new ThreadActionService(forkThread)
    expect((await forkActions.recordOutsideChanges({ threadId: 'fork', conversationBranchId: 'main', workspacePath: seeded.worktreePath })).action).toBeUndefined()
    // The source thread's files are untouched.
    expect(f.read(cwd)).toBe('turn result\n')
  })
})

/** A worker worktree at the thread's HEAD whose task ended with `files` written: its journal, its end snapshot, and where it started. */
async function worker(name: string, files: Record<string, string>) {
  const path = f.child(`${name}-branch`, git(cwd, 'rev-parse', 'HEAD'))
  git(path, 'config', 'user.name', 'Test'); git(path, 'config', 'user.email', 'test@example.test')
  const { action } = await new ThreadActionService(join(f.root, `${name}-journal`)).runCheckpointedAction({ ...actionOptions(path, `${name}-result`), threadId: name }, () => {
    for (const [file, value] of Object.entries(files)) writeFileSync(join(path, file), value)
  })
  return { path, result: action.endSha, base: git(cwd, 'rev-parse', 'HEAD') }
}
const integrate = (agent: Awaited<ReturnType<typeof worker>>, operationId = `integrate-${agent.result}`) => new ChildAgentIntegrationService(f.thread).integrate({
  agentId: 'worker', operationId, workerWorktree: agent.path, spawnBaseSha: agent.base, pinnedWorkerSha: agent.result, threadWorkspace: cwd
})

describe('subagent results', () => {
  it('arrive as files: the thread’s uncommitted work stays, nothing is committed, and the receipt records both snapshots', async () => {
    const agent = await worker('worker', { 'worker.txt': 'worker\n' })
    // The thread has uncommitted work of its own, in another file and as a staged edit, that the merge must not touch.
    await turn('parent', () => write('parent.txt', 'parent\n'))
    write('notes.txt', 'mine\n'); git(cwd, 'add', 'notes.txt')
    const head = git(cwd, 'rev-parse', 'HEAD')
    const branchesBefore = branches()
    const cached = git(cwd, 'diff', '--cached', '--binary')

    const record = await integrate(agent)
    expect(f.read(cwd, 'worker.txt')).toBe('worker\n')
    expect(f.read(cwd, 'parent.txt')).toBe('parent\n')
    expect(f.read(cwd, 'notes.txt')).toBe('mine\n')
    // No commit, no merge, no set-aside copy; HEAD, branches and the real index are as they were.
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(branches()).toBe(branchesBefore)
    expect(git(cwd, 'diff', '--cached', '--binary')).toBe(cached)
    expect(git(cwd, 'for-each-ref', 'refs/mousse/pending-changes')).toBe('')
    expect(git(cwd, 'log', '--format=%s', '-3')).not.toMatch(/mousse|merge/i)
    expect(() => git(cwd, 'rev-parse', '--verify', '-q', 'MERGE_HEAD')).toThrow()
    // The receipt is between two snapshots of the thread; the worker's result is pinned.
    const receipt = new ChangeReceiptService(f.thread).list().find((item) => item.id === record.receiptId)!
    expect(receipt).toMatchObject({ kind: 'integration', introducedCommits: [], contributions: [{ actorId: 'worker', baseSha: agent.base, resultSha: agent.result }] })
    expect(receipt.git).toMatchObject({ rewroteHistory: false, headBefore: head, headAfter: head })
    expect(git(cwd, 'ls-tree', '--name-only', receipt.beforeSha).split('\n')).not.toContain('worker.txt')
    expect(git(cwd, 'show', `${receipt.afterSha}:worker.txt`)).toBe('worker')
    expect(git(cwd, 'show', `${receipt.afterSha}:notes.txt`)).toBe('mine')
    expect(record).toMatchObject({ workerHeadSha: agent.result, preMergeSha: receipt.beforeSha, integrationSha: receipt.afterSha, changedPaths: ['worker.txt'] })
    expect(git(cwd, 'rev-parse', `refs/mousse/agents/worker`)).toBe(agent.result)
    expect(new ThreadWorkspaceManager(f.thread).load()!.snapshotSha).toBe(receipt.afterSha)
    // The next turn records nothing as outside changes.
    expect((await actions.recordOutsideChanges({ threadId: 'task', conversationBranchId: 'main', workspacePath: cwd })).action).toBeUndefined()
    noPending()
  })

  it('arrive whatever the worker did to its own HEAD and files since', async () => {
    const agent = await worker('worker', { 'worker.txt': 'worker\n' })
    writeFileSync(join(agent.path, 'worker.txt'), 'worker, later\n'); git(agent.path, 'add', 'worker.txt'); git(agent.path, 'commit', '-qm', 'later')
    await integrate(agent)
    expect(f.read(cwd, 'worker.txt')).toBe('worker\n')
  })

  it('a conflict refuses with the file names and changes nothing: no merge, no set-aside, no pending operation', async () => {
    const agent = await worker('worker', { 'value.txt': 'from the worker\n', 'worker.txt': 'worker\n' })
    await turn('parent', () => { write('value.txt', 'from the parent\n'); write('parent.txt', 'parent\n') })
    const status = git(cwd, 'status', '--porcelain', '--untracked-files=all')
    const journal = new ThreadJournal(f.thread).list().length
    const refs = git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse')
    await expect(integrate(agent)).rejects.toMatchObject({ code: 'integration_conflict', details: { files: ['value.txt'] }, message: expect.stringContaining('value.txt') })
    expect(git(cwd, 'status', '--porcelain', '--untracked-files=all')).toBe(status)
    expect(f.read(cwd)).toBe('from the parent\n')
    expect(existsSync(join(cwd, 'worker.txt'))).toBe(false)
    expect(git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse')).toBe(refs)
    expect(new ThreadJournal(f.thread).list().length).toBe(journal)
    expect(new ChangeReceiptService(f.thread).list().filter((item) => item.kind === 'integration')).toEqual([])
    noPending()
    // The thread goes on: a turn starts, and the same result integrates once the overlap is gone.
    write('value.txt', 'base\n')
    await turn('next', () => undefined, 2)
    await integrate(agent)
    expect(f.read(cwd, 'worker.txt')).toBe('worker\n')
  })

  it('refuses a worker that produced no change, by comparing files', async () => {
    const agent = await worker('idle', {})
    await expect(integrate(agent)).rejects.toThrow(/produced no change/)
    // A worker that rewrote a file to what it already was changed nothing either.
    const same = await worker('same', { 'value.txt': 'base\n' })
    await expect(integrate(same)).rejects.toThrow(/produced no change/)
    noPending()
  })

  it('recovers an interrupted integration by merging again, and never twice', async () => {
    const agent = await worker('worker', { 'worker.txt': 'worker\n' })
    const service = new ChildAgentIntegrationService(f.thread)
    // The crash: the intent was written and the files changed, but no receipt exists yet.
    const ours = takeSnapshot(cwd, { reason: 'ours' })
    new ThreadJournal(f.thread).append({
      operationId: 'crashed', operationType: 'child-integration', state: 'prepared',
      expectedPreState: { preSnapshot: ours.sha, workerSha: agent.result, spawnBaseSha: agent.base, expectedTree: '' },
      details: { request: { agentId: 'worker', operationId: 'crashed', workerWorktree: agent.path, spawnBaseSha: agent.base, pinnedWorkerSha: agent.result, threadWorkspace: cwd } }
    })
    write('worker.txt', 'worker\n')
    await service.recoverPending(cwd)
    const receipts = new ChangeReceiptService(f.thread).list().filter((item) => item.kind === 'integration')
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ operationId: 'crashed', beforeSha: ours.sha })
    expect(f.read(cwd, 'worker.txt')).toBe('worker\n')
    noPending()
    await service.recoverPending(cwd)
    expect(new ChangeReceiptService(f.thread).list().filter((item) => item.kind === 'integration')).toHaveLength(1)
  })
})

describe('publish', () => {
  const target = () => git(f.repo, 'branch', '--show-current')
  const publish = (options: Parameters<PublishService['publish']>[4] = {}) => new PublishService(f.thread).publish(cwd, f.repo, target(), undefined, options)

  it('puts the thread’s files, uncommitted ones included, into the primary as one commit with the person’s own identity', async () => {
    const baseSha = git(f.repo, 'rev-parse', 'HEAD')
    // The agent commits one file and leaves the rest of its turn uncommitted; both are in the thread's snapshot.
    const first = await turn('turn', () => {
      write('committed.txt', 'committed\n'); git(cwd, 'add', 'committed.txt'); git(cwd, 'commit', '-qm', 'the agent’s own commit')
      write('value.txt', 'edited\n'); write('uncommitted.txt', 'uncommitted\n')
    })
    const result = await publish({ message: 'Add the feature' })
    expect(result.state).toBe('completed')
    // Exactly one commit on the primary's branch, on top of where it was, and no Mousse snapshot or the agent's own commit in its history.
    expect(git(f.repo, 'rev-list', '--count', `${baseSha}..HEAD`)).toBe('1')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(result.publishSha)
    expect(git(f.repo, 'rev-parse', 'HEAD^')).toBe(baseSha)
    expect(git(f.repo, 'log', '--format=%an <%ae> | %cn <%ce> | %s', '-1')).toBe('Foundation Test <foundation@example.test> | Foundation Test <foundation@example.test> | Add the feature')
    expect(git(f.repo, 'log', '--format=%s')).not.toMatch(/mousse snapshot|the agent’s own commit/)
    expect(git(f.repo, 'branch', '--contains', first.action.endSha)).toBe('')
    expect(f.read(f.repo)).toBe('edited\n')
    expect(f.read(f.repo, 'committed.txt')).toBe('committed\n')
    expect(f.read(f.repo, 'uncommitted.txt')).toBe('uncommitted\n')
    expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    // The thread keeps its own branch, HEAD and files.
    expect(git(cwd, 'branch', '--show-current')).toBe('mousse/thread/task/main')
    expect(f.read(cwd, 'uncommitted.txt')).toBe('uncommitted\n')
    // The turn's receipt is published, so Undo of it is refused; the snapshot is remembered as the next base.
    const receipts = new ChangeReceiptService(f.thread)
    const published = receipts.list().find((item) => item.id === result.receiptId)!
    expect(published).toMatchObject({ kind: 'publish', beforeSha: baseSha, afterSha: result.publishSha })
    expect(published.publishedReceiptIds).toContain(first.action.receiptId)
    expect(published.publishedReceiptIds).not.toContain(result.receiptId)
    await expect(new UndoService(f.thread).undoLatest('main', cwd)).rejects.toMatchObject({ code: 'published_changes' })
    expect(git(f.repo, 'rev-parse', publishedRef('task'))).toBe(result.sourceSha)
  })

  it('publishes again only what came after, even for lines it already published', async () => {
    const baseSha = git(f.repo, 'rev-parse', 'HEAD')
    await turn('one', () => write('value.txt', 'one\n'))
    const first = await publish()
    await turn('two', () => { write('value.txt', 'two\n'); write('extra.txt', 'extra\n') }, 2)
    const second = await publish()
    expect(second.state).toBe('completed')
    expect(git(f.repo, 'rev-list', '--count', `${baseSha}..HEAD`)).toBe('2')
    expect(git(f.repo, 'rev-parse', 'HEAD^')).toBe(first.publishSha)
    expect(f.read(f.repo)).toBe('two\n')
    // Nothing new: no third commit.
    const third = await publish()
    expect(third.publishSha).toBe(second.publishSha)
    expect(git(f.repo, 'rev-list', '--count', `${baseSha}..HEAD`)).toBe('2')
  })

  it('refuses when the files are not the ones that were reviewed, and records the outside edit for the next review', async () => {
    await turn('one', () => write('value.txt', 'one\n'))
    const reviewed = new ThreadWorkspaceManager(f.thread).load()!.snapshotSha!
    write('late.txt', 'late\n')
    await expect(publish({ expectedSourceSha: reviewed })).rejects.toThrow(/source revision changed/)
    expect(git(f.repo, 'log', '--format=%s', '-1')).toBe('base')
    const refreshed = new ThreadWorkspaceManager(f.thread).load()!.snapshotSha!
    expect(refreshed).not.toBe(reviewed)
    expect((await publish({ expectedSourceSha: refreshed })).state).toBe('completed')
    expect(f.read(f.repo, 'late.txt')).toBe('late\n')
  })

  it('refuses a conflict with the file names and changes nothing in the primary or the thread', async () => {
    await turn('one', () => write('value.txt', 'from the thread\n'))
    f.commit(f.repo, 'from the primary\n')
    const head = git(f.repo, 'rev-parse', 'HEAD')
    const result = await publish()
    expect(result).toMatchObject({ state: 'conflict', conflictFiles: ['value.txt'], prePublishSha: head })
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(f.read(f.repo)).toBe('from the primary\n')
    expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(f.read(cwd)).toBe('from the thread\n')
    expect(new ChangeReceiptService(f.thread).list().filter((item) => item.kind === 'publish')).toEqual([])
    noPending()
  })

  it('needs a clean primary on the target branch and changes nothing otherwise', async () => {
    await turn('one', () => write('value.txt', 'one\n'))
    writeFileSync(join(f.repo, 'mine.txt'), 'mine\n')
    await expect(publish()).rejects.toMatchObject({ code: 'workspace_not_clean' })
    expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toBe('?? mine.txt')
    rmSync(join(f.repo, 'mine.txt'))
    await expect(new PublishService(f.thread).publish(cwd, f.repo, 'other-branch')).rejects.toThrow(/must be on other-branch/)
    expect(f.read(f.repo)).toBe('base\n')
    noPending()
  })

  it('says what to set when Git does not know who the person is', async () => {
    await turn('one', () => write('value.txt', 'one\n'))
    git(f.repo, 'config', 'user.useConfigOnly', 'true'); git(f.repo, 'config', '--unset', 'user.name'); git(f.repo, 'config', '--unset', 'user.email')
    const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    try {
      await expect(publish()).rejects.toThrow(/Set user\.name and user\.email/)
    } finally {
      for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
    }
    expect(f.read(f.repo)).toBe('base\n')
    noPending()
  })

  it('a repeated operation is the recorded result, with no second commit', async () => {
    await turn('one', () => write('value.txt', 'one\n'))
    const service = new PublishService(f.thread)
    const first = await service.publish(cwd, f.repo, target(), undefined, { operationId: 'replay' })
    expect(await service.publish(cwd, f.repo, target(), undefined, { operationId: 'replay' })).toEqual(first)
    expect(git(f.repo, 'rev-list', '--count', `${first.prePublishSha}..HEAD`)).toBe('1')
  })

  it('never overwrites an ignored file in the primary: it refuses with the file names and changes nothing', async () => {
    writeFileSync(join(f.repo, '.gitignore'), '*.env\nout\n'); git(f.repo, 'add', '.gitignore'); git(f.repo, 'commit', '-qm', 'ignore')
    git(cwd, 'merge', '-q', '--ff-only', git(f.repo, 'rev-parse', 'HEAD'))
    // The person's own ignored files in the primary, at paths the thread's snapshot has a file.
    writeFileSync(join(f.repo, 'local.env'), 'SECRET=mine\n')
    writeFileSync(join(f.repo, 'out'), 'an ignored file where the thread has a folder\n')
    await turn('one', () => {
      write('value.txt', 'one\n')
      write('local.env', 'SECRET=thread\n'); git(cwd, 'add', '-f', 'local.env')
      mkdirSync(join(cwd, 'out')); write('out/result.txt', 'result\n'); git(cwd, 'add', '-f', 'out/result.txt')
    })
    const head = git(f.repo, 'rev-parse', 'HEAD')
    await expect(publish()).rejects.toThrow(/would overwrite ignored files in .*: local\.env, out\. Move them aside/)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(f.repo, 'local.env'), 'utf8')).toBe('SECRET=mine\n')
    expect(readFileSync(join(f.repo, 'out'), 'utf8')).toBe('an ignored file where the thread has a folder\n')
    expect(f.read(f.repo)).toBe('base\n')
    noPending()
    // Moved aside, the same publish goes through.
    rmSync(join(f.repo, 'local.env')); rmSync(join(f.repo, 'out'))
    expect((await publish()).state).toBe('completed')
    expect(readFileSync(join(f.repo, 'local.env'), 'utf8')).toBe('SECRET=thread\n')
  })

  /** A publish that wrote its intent and its commit, then stopped before the primary moved. */
  async function interruptedBeforeTheMove(state: 'prepared' | 'recovery_required') {
    await turn('one', () => write('value.txt', 'one\n'))
    const journal = new ThreadJournal(f.thread)
    const prePublishSha = git(f.repo, 'rev-parse', 'HEAD')
    const sourceSha = new ThreadWorkspaceManager(f.thread).load()!.snapshotSha!
    const publishSha = git(f.repo, 'commit-tree', git(cwd, 'rev-parse', `${sourceSha}^{tree}`), '-p', prePublishSha, '-m', 'interrupted')
    journal.append({ operationId: 'interrupted', operationType: 'publish', state: 'prepared', expectedPreState: { prePublishSha, targetBranch: target(), sourceSha, publishSha, tree: git(cwd, 'rev-parse', `${sourceSha}^{tree}`) }, details: { threadWorkspace: cwd, primaryCheckout: f.repo } })
    if (state === 'recovery_required') journal.append({ operationId: 'interrupted', operationType: 'publish', state, details: { prePublishSha, targetBranch: target(), error: 'fatal: Not possible to fast-forward' } })
    return { prePublishSha, publishSha, sourceSha }
  }

  it('recovery of a publish stopped before the primary moved only cancels it: no new commit, snapshot or fast-forward', async () => {
    const { prePublishSha } = await interruptedBeforeTheMove('prepared')
    const refs = git(f.repo, 'for-each-ref', '--format=%(refname) %(objectname)')
    expect(await new PublishService(f.thread).recoverPending(cwd, f.repo)).toEqual([{ operationId: 'interrupted', state: 'cancelled' }])
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(prePublishSha)
    expect(f.read(f.repo)).toBe('base\n')
    expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(git(f.repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refs)
    expect(new ChangeReceiptService(f.thread).list().filter((item) => item.kind === 'publish')).toEqual([])
    expect(new ThreadJournal(f.thread).latestByOperation().get('interrupted')).toMatchObject({ state: 'cancelled', details: { recovered: true } })
    noPending()
  })

  it('recovery records a publish whose fast-forward landed, also after the person committed on top', async () => {
    const { publishSha, sourceSha } = await interruptedBeforeTheMove('prepared')
    git(f.repo, 'merge', '-q', '--ff-only', publishSha); f.commit(f.repo, 'the person’s next commit\n')
    const [settled] = await new PublishService(f.thread).recoverPending(cwd, f.repo)
    expect(settled).toMatchObject({ state: 'completed', result: { publishSha, sourceSha } })
    expect(git(f.repo, 'rev-parse', publishedRef('task'))).toBe(sourceSha)
    noPending()
  })

  it('a thread an older version locked after a failed fast-forward recovers on its own and can publish again', async () => {
    const { prePublishSha } = await interruptedBeforeTheMove('recovery_required')
    expect(new ThreadWorkspaceManager(f.thread).verify().lifecycle).toBe('recovery_required')
    await new PublishService(f.thread).recoverPending(cwd, f.repo)
    expect(new ThreadWorkspaceManager(f.thread).verify().lifecycle).toBe('ready')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(prePublishSha)
    expect((await publish()).state).toBe('completed')
  })

  it('a fast-forward Git refuses closes the attempt instead of locking the thread', async () => {
    await turn('one', () => write('value.txt', 'one\n'))
    const head = git(f.repo, 'rev-parse', 'HEAD')
    // Git refuses the update itself: a stale lock on the primary's index.
    const lock = join(git(f.repo, 'rev-parse', '--absolute-git-dir'), 'index.lock')
    writeFileSync(lock, '')
    try { await expect(publish()).rejects.toThrow(/could not update [\s\S]*Nothing was changed/) } finally { rmSync(lock, { force: true }) }
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(new ThreadWorkspaceManager(f.thread).verify().lifecycle).toBe('ready')
    noPending()
    expect((await publish()).state).toBe('completed')
  })
})

describe('rebuilding a worktree from its snapshot', () => {
  /** An agent's turn on a branch of its own, with a commit and files it left uncommitted; then the worktree is gone. */
  async function leftOnAnotherBranch() {
    await turn('turn', () => {
      git(cwd, 'switch', '-q', '-c', 'issue-7-work')
      write('feature.txt', 'committed\n'); git(cwd, 'add', 'feature.txt'); git(cwd, 'commit', '-qm', 'feature')
      write('value.txt', 'uncommitted edit\n'); write('draft.txt', 'draft\n')
    })
    const head = git(cwd, 'rev-parse', 'HEAD')
    const status = git(cwd, 'status', '--porcelain', '--untracked-files=all')
    git(f.repo, 'worktree', 'remove', '--force', cwd)
    expect(existsSync(cwd)).toBe(false)
    return { head, status }
  }

  it('starts at the HEAD the snapshot was taken on, on the branch it was on, with the same uncommitted files', async () => {
    const { head, status } = await leftOnAnotherBranch()
    const restored = await new ThreadWorkspaceManager(f.thread).restore(f.repo)
    expect(restored.lifecycle).toBe('ready')
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(cwd, 'branch', '--show-current')).toBe('issue-7-work')
    expect(git(cwd, 'status', '--porcelain', '--untracked-files=all')).toBe(status)
    expect(f.read(cwd)).toBe('uncommitted edit\n'); expect(f.read(cwd, 'draft.txt')).toBe('draft\n')
    // Nothing of this is outside changes: the next turn starts from the snapshot it was rebuilt from.
    expect((await actions.recordOutsideChanges({ threadId: 'task', conversationBranchId: 'main', workspacePath: cwd })).action).toBeUndefined()
  })

  it('is detached at that HEAD when the branch has moved since', async () => {
    const { head, status } = await leftOnAnotherBranch()
    git(f.repo, 'branch', '-f', 'issue-7-work', f.baseSha)
    await new ThreadWorkspaceManager(f.thread).restore(f.repo)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(cwd, 'branch', '--show-current')).toBe('')
    expect(git(cwd, 'status', '--porcelain', '--untracked-files=all')).toBe(status)
  })
})

describe('workspace GC', () => {
  it('never deletes a snapshot pin, whatever it is called, and keeps the pins of retirement and publish', async () => {
    const { action } = await turn('turn', () => write('agent.txt', 'agent\n'))
    const receipt = new ChangeReceiptService(f.thread).list().find((item) => item.id === action.receiptId)!
    // Pins in places GC does not know: a snapshot is work that exists nowhere else.
    git(f.repo, 'update-ref', 'refs/mousse/somewhere-new/snapshot', action.endSha)
    git(f.repo, 'update-ref', 'refs/mousse/lifecycle/profile/task/key/base', f.baseSha)
    git(f.repo, 'update-ref', 'refs/mousse/lifecycle/profile/task/key/snapshot', action.endSha)
    git(f.repo, 'update-ref', publishedRef('task'), action.endSha)
    // A ref that is nothing but an old commit of the primary's own branch is still a candidate.
    git(f.repo, 'update-ref', 'refs/mousse/scratch/old', f.baseSha)
    const gc = new WorkspaceGcService(f.repo)
    const report = gc.dryRun(new Set(), new Set())
    const pins = ['refs/mousse/threads/task/main', ...receipt.retainedRefs, 'refs/mousse/somewhere-new/snapshot', 'refs/mousse/lifecycle/profile/task/key/base', 'refs/mousse/lifecycle/profile/task/key/snapshot', publishedRef('task')]
    for (const ref of pins) expect(report.retainedRefs).toContain(ref)
    expect(report.unreferencedRefs).toEqual(['refs/mousse/scratch/old'])
    await gc.purge(report, true)
    for (const ref of pins) expect(git(f.repo, 'rev-parse', ref)).toMatch(/^[0-9a-f]{40}$/)
    expect(() => git(f.repo, 'rev-parse', '--verify', '-q', 'refs/mousse/scratch/old')).toThrow()
    expect(f.read(cwd, 'agent.txt')).toBe('agent\n')
  })
})
