import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { RedoService } from '../src/mms/actions/RedoService'
import { CodeRevertService } from '../src/mms/actions/CodeRevertService'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { PublishService } from '../src/mms/actions/PublishService'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { pendingChangesDetails } from '../src/shared/workspace'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10])

/**
 * The user's own uncommitted work: a changed tracked file, a staged new file, a file staged and then changed
 * again, an untracked binary with a space in its name in a new folder, and an ignored file.
 */
function userEdits(repo: string): void {
  writeFileSync(join(repo, 'value.txt'), 'user edit\n')
  writeFileSync(join(repo, 'staged.txt'), 'staged by the user\n'); git(repo, 'add', 'staged.txt')
  writeFileSync(join(repo, 'both.txt'), 'staged version\n'); git(repo, 'add', 'both.txt'); writeFileSync(join(repo, 'both.txt'), 'changed after staging\n')
  mkdirSync(join(repo, 'notes'), { recursive: true }); writeFileSync(join(repo, 'notes', 'screen shot.png'), PNG)
  const exclude = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude')
  mkdirSync(dirname(exclude), { recursive: true }); appendFileSync(exclude, 'ignored.log\n')
  writeFileSync(join(repo, 'ignored.log'), 'keep me\n')
}

/** Everything that tells pending changes apart: what is staged, what is not, and what is untracked. */
function pending(repo: string) {
  return {
    status: git(repo, 'status', '--porcelain', '--untracked-files=all'),
    staged: git(repo, 'diff', '--cached', '--binary'),
    unstaged: git(repo, 'diff', '--binary'),
    screenshot: readFileSync(join(repo, 'notes', 'screen shot.png')).equals(PNG),
    ignored: readFileSync(join(repo, 'ignored.log'), 'utf8')
  }
}

const keptRefs = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/pending-changes').split('\n').filter(Boolean)

describe('operations in a thread worktree with uncommitted changes', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  beforeEach(() => { f = gitFoundationFixture() })
  afterEach(() => f.dispose())

  it('Undo and Redo leave the user’s pending edits and staging exactly as they were, and the turn stays undoable', async () => {
    const actions = new ThreadActionService(f.thread)
    const { action: turn } = await actions.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'agent.txt'), 'agent\n'))
    userEdits(f.repo)
    const before = pending(f.repo)
    const head = git(f.repo, 'rev-parse', 'HEAD')

    await new UndoService(f.thread).undoLatest('main', f.repo)
    expect(actions.get(turn.id)?.state).toBe('undone')
    expect(existsSync(join(f.repo, 'agent.txt'))).toBe(false)
    // The turn's file is gone and nothing else moved: the staged and unstaged diffs, the untracked screenshot and the ignored file are the user's.
    expect(pending(f.repo)).toEqual({ ...before, status: before.status.replace('?? agent.txt\n', '') })
    // Nothing was committed or saved for the user, and nothing is left aside.
    expect(actions.list().some((action) => action.turnId.startsWith('user-changes:'))).toBe(false)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(keptRefs(f.repo)).toEqual([])

    await new RedoService(f.thread).redoLatest('main', f.repo)
    expect(readFileSync(join(f.repo, 'agent.txt'), 'utf8')).toBe('agent\n')
    expect(pending(f.repo)).toEqual(before)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(keptRefs(f.repo)).toEqual([])
    // The shared stash is never used.
    expect(() => git(f.repo, 'rev-parse', '--verify', '-q', 'refs/stash')).toThrow()
  })

  it('refuses the Undo when the user’s edits overlap with it, names the files and changes nothing', async () => {
    const actions = new ThreadActionService(f.thread)
    const { action: turn } = await actions.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'agent.txt'), 'agent\n'))
    // The user edits the file the turn created, which Undo deletes.
    writeFileSync(join(f.repo, 'agent.txt'), 'the user built on it\n')
    writeFileSync(join(f.repo, 'notes.md'), 'mine\n')
    const before = git(f.repo, 'status', '--porcelain', '--untracked-files=all')

    const refusal = await new UndoService(f.thread).undoLatest('main', f.repo).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ name: 'UndoConflictError', files: ['agent.txt'] })
    expect(actions.get(turn.id)?.state).toBe('completed')
    expect(readFileSync(join(f.repo, 'agent.txt'), 'utf8')).toBe('the user built on it\n')
    expect(readFileSync(join(f.repo, 'notes.md'), 'utf8')).toBe('mine\n')
    expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toBe(before)
    // No operation is left pending, so the thread is not locked by the refusal.
    expect(new ThreadJournal(f.thread).list().some((entry) => entry.operationType === 'undo')).toBe(false)
    new ChangeReceiptService(f.thread).assertNoPendingOperation()
  })

  it('a code revert runs and the pending changes stay on top of it', async () => {
    const actions = new ThreadActionService(f.thread)
    const { action: first } = await actions.runCheckpointedAction(actionOptions(f.repo, 'first'), () => writeFileSync(join(f.repo, 'first.txt'), 'first\n'))
    await actions.runCheckpointedAction({ ...actionOptions(f.repo, 'second'), presentationMessageStart: 2, presentationMessageEnd: 4 }, () => writeFileSync(join(f.repo, 'second.txt'), 'second\n'))
    userEdits(f.repo)
    const before = pending(f.repo)
    const head = git(f.repo, 'rev-parse', 'HEAD')

    await new CodeRevertService(f.thread).revertCode(first.id, f.repo)
    expect(existsSync(join(f.repo, 'first.txt'))).toBe(false)
    expect(existsSync(join(f.repo, 'second.txt'))).toBe(true)
    expect(pending(f.repo)).toEqual({ ...before, status: before.status.replace('?? first.txt\n', '') })
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(keptRefs(f.repo)).toEqual([])
  })

  it('a conflict in the checkout still stops Undo, names the folder and files and offers Discard', async () => {
    const actions = new ThreadActionService(f.thread)
    await actions.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'agent.txt'), 'agent\n'))
    const head = git(f.repo, 'rev-parse', 'HEAD')
    const side = f.child('side')
    f.commit(side, 'side\n')
    writeFileSync(join(f.repo, 'value.txt'), 'main\n'); git(f.repo, 'commit', '-qam', 'main')
    expect(() => git(f.repo, 'merge', 'side')).toThrow()
    const mergeHead = git(f.repo, 'rev-parse', 'HEAD')

    const refusal = await new UndoService(f.thread).undoLatest('main', f.repo).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'workspace_conflict', details: { conflict: true, discard: true, operation: 'merge', files: ['value.txt', 'agent.txt'] } })
    expect((refusal as Error).message).toBe(`Thread workspace ${git(f.repo, 'rev-parse', '--show-toplevel')} has a merge in progress with conflicts in value.txt. Resolve it or discard the changes, then try again.`)
    expect(pendingChangesDetails(refusal)?.discard).toBe(true)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(mergeHead)
    expect(git(f.repo, 'rev-parse', 'MERGE_HEAD')).toBeTruthy()
    expect(head).not.toBe(mergeHead)
  })

  it('conversation branches switch the files to the code each branch last had, and keep what the person was working on', async () => {
    const workspace = (await new WorkspaceResolver(f.thread, 'task', f.repo).resolve('agent')).workspacePath!
    const actions = new ThreadActionService(f.thread)
    const { action } = await actions.runCheckpointedAction(actionOptions(workspace), () => writeFileSync(join(workspace, 'agent.txt'), 'agent\n'))
    const branches = new ConversationBranchService(f.thread)
    userEdits(workspace)
    const head = git(workspace, 'rev-parse', 'HEAD')
    const gitBranch = git(workspace, 'branch', '--show-current')
    const status = git(workspace, 'status', '--porcelain', '--untracked-files=all')
    const gitBranches = git(workspace, 'branch', '--list', '--format=%(refname:short)')

    // A fork only adds a ref; the checkout is untouched and no Git branch is made.
    const first = await branches.fork(workspace, 'main', action.id, 'First')
    const second = await branches.fork(workspace, 'main', action.id, 'Second')
    expect(git(workspace, 'status', '--porcelain', '--untracked-files=all')).toBe(status)
    expect(git(workspace, 'branch', '--list', '--format=%(refname:short)')).toBe(gitBranches)
    expect(git(workspace, 'rev-parse', first.retainedRef)).toBe(action.endSha)

    // Leaving the thread's first branch records what changed outside Mousse as the user's, then the files become the fork's code.
    await branches.activate(workspace, first.id)
    const saved = actions.list().find((item) => item.turnId.startsWith('user-changes:'))!
    expect(git(workspace, 'show', `${saved.endSha}:value.txt`)).toBe('user edit')
    expect(git(workspace, 'show', `${saved.endSha}:notes/screen shot.png`)).toBeTruthy()
    expect(readFileSync(join(workspace, 'value.txt'), 'utf8')).toBe('base\n')
    expect(existsSync(join(workspace, 'notes'))).toBe(false)
    expect(readFileSync(join(workspace, 'agent.txt'), 'utf8')).toBe('agent\n')
    // HEAD, the Git branch and the ignored file are untouched by switching.
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(workspace, 'branch', '--show-current')).toBe(gitBranch)
    expect(readFileSync(join(workspace, 'ignored.log'), 'utf8')).toBe('keep me\n')

    // Work on the first branch stays with it while the second is active, and comes back exactly.
    writeFileSync(join(workspace, 'first-branch.txt'), 'on first\n')
    await branches.activate(workspace, second.id)
    expect(existsSync(join(workspace, 'first-branch.txt'))).toBe(false)
    await branches.activate(workspace, first.id)
    expect(readFileSync(join(workspace, 'first-branch.txt'), 'utf8')).toBe('on first\n')
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head)
    expect(keptRefs(workspace)).toEqual([])
  })

  it('Publish takes the thread’s uncommitted files, but refuses a primary checkout with pending changes and changes nothing there', async () => {
    const workspace = f.child('task')
    f.commit(workspace, 'reviewed\n')
    writeFileSync(join(workspace, 'thread-notes.md'), 'not committed\n')
    writeFileSync(join(f.repo, 'draft.md'), 'staged draft\n'); git(f.repo, 'add', 'draft.md')
    userEdits(f.repo)
    git(f.repo, 'checkout', '--', 'value.txt')
    const before = pending(f.repo)
    const target = git(f.repo, 'branch', '--show-current')

    await expect(new PublishService(f.thread).publish(workspace, f.repo, target)).rejects.toMatchObject({ code: 'workspace_not_clean' })
    expect(pending(f.repo)).toEqual(before)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    expect(keptRefs(f.repo)).toEqual([])
    expect(git(workspace, 'status', '--porcelain', '--untracked-files=all')).toBe('?? thread-notes.md')
  })
})
