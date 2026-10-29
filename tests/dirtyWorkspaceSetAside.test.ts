import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { RedoService } from '../src/mms/actions/RedoService'
import { CodeRevertService } from '../src/mms/actions/CodeRevertService'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { PublishService } from '../src/mms/actions/PublishService'
import { keptPendingChangesNotice, type KeptPendingChanges } from '../src/mms/actions/git'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { pendingChangesDetails } from '../src/shared/workspace'
import { mousseToUIMessages } from '../src/renderer/chat/adapters/mousseToUI'
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

  it('Undo and Redo run and give the pending changes back exactly, staged and untracked, and the turn stays undoable', async () => {
    const actions = new ThreadActionService(f.thread)
    const { action: turn } = await actions.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'agent.txt'), 'agent\n'))
    userEdits(f.repo)
    const before = pending(f.repo)

    await new UndoService(f.thread).undoLatest('main', f.repo)
    expect(actions.get(turn.id)?.state).toBe('undone')
    expect(existsSync(join(f.repo, 'agent.txt'))).toBe(false)
    expect(pending(f.repo)).toEqual(before)
    // Nothing was committed for the user, and nothing is left aside.
    expect(actions.list().some((action) => action.turnId.startsWith('user-changes:'))).toBe(false)
    expect(git(f.repo, 'rev-parse', 'HEAD^{tree}')).toBe(git(f.repo, 'rev-parse', `${turn.startSha}^{tree}`))
    expect(keptRefs(f.repo)).toEqual([])

    await new RedoService(f.thread).redoLatest('main', f.repo)
    expect(readFileSync(join(f.repo, 'agent.txt'), 'utf8')).toBe('agent\n')
    expect(pending(f.repo)).toEqual(before)
    expect(keptRefs(f.repo)).toEqual([])
    // The shared stash is never used.
    expect(() => git(f.repo, 'rev-parse', '--verify', '-q', 'refs/stash')).toThrow()
  })

  it('keeps the Undo when the changes no longer fit, leaves them under a ref and says where', async () => {
    const actions = new ThreadActionService(f.thread)
    const { action: turn } = await actions.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'agent.txt'), 'agent\n'))
    // The user edits the file the turn created, which Undo deletes.
    writeFileSync(join(f.repo, 'agent.txt'), 'the user built on it\n')
    writeFileSync(join(f.repo, 'notes.md'), 'mine\n')
    const kept: KeptPendingChanges[] = []

    await new UndoService(f.thread, { onPendingChangesKept: (item) => kept.push(item) }).undoLatest('main', f.repo)
    expect(actions.get(turn.id)?.state).toBe('undone')
    expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(kept).toEqual([{ path: git(f.repo, 'rev-parse', '--show-toplevel'), ref: expect.stringMatching(/^refs\/mousse\/pending-changes\//), files: ['agent.txt'], operation: 'Undo' }])
    expect(keptRefs(f.repo)).toEqual([kept[0].ref])
    expect(git(f.repo, 'show', `${kept[0].ref}:agent.txt`)).toBe('the user built on it')
    expect(git(f.repo, 'show', `${kept[0].ref}^3:notes.md`)).toBe('mine')
    expect(keptPendingChangesNotice(kept[0])).toBe(`Your uncommitted changes in ${kept[0].path} were not put back after Undo: agent.txt changed in both. They are saved in Git; to restore them, run \`git stash apply ${kept[0].ref}\` in that folder.`)
  })

  it('a code revert runs and the pending changes come back on top of it', async () => {
    const actions = new ThreadActionService(f.thread)
    const { action: first } = await actions.runCheckpointedAction(actionOptions(f.repo, 'first'), () => writeFileSync(join(f.repo, 'first.txt'), 'first\n'))
    await actions.runCheckpointedAction({ ...actionOptions(f.repo, 'second'), presentationMessageStart: 2, presentationMessageEnd: 4 }, () => writeFileSync(join(f.repo, 'second.txt'), 'second\n'))
    userEdits(f.repo)
    const before = pending(f.repo)

    await new CodeRevertService(f.thread).revertCode(first.id, f.repo)
    expect(existsSync(join(f.repo, 'first.txt'))).toBe(false)
    expect(existsSync(join(f.repo, 'second.txt'))).toBe(true)
    expect(pending(f.repo)).toEqual(before)
    expect(keptRefs(f.repo)).toEqual([])
  })

  it('a conflict still stops Undo, names the folder and files and offers Discard', async () => {
    const actions = new ThreadActionService(f.thread)
    await actions.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'agent.txt'), 'agent\n'))
    const head = git(f.repo, 'rev-parse', 'HEAD')
    const side = f.child('side')
    f.commit(side, 'side\n')
    writeFileSync(join(f.repo, 'value.txt'), 'main\n'); git(f.repo, 'commit', '-qam', 'main')
    expect(() => git(f.repo, 'merge', 'side')).toThrow()
    const mergeHead = git(f.repo, 'rev-parse', 'HEAD')

    const refusal = await new UndoService(f.thread).undoLatest('main', f.repo).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'workspace_conflict', details: { conflict: true, discard: true, operation: 'merge', files: ['value.txt'] } })
    expect((refusal as Error).message).toBe(`Thread workspace ${git(f.repo, 'rev-parse', '--show-toplevel')} has a merge in progress with conflicts in value.txt. Resolve it or discard the changes, then try again.`)
    expect(pendingChangesDetails(refusal)?.discard).toBe(true)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(mergeHead)
    expect(git(f.repo, 'rev-parse', 'MERGE_HEAD')).toBeTruthy()
    expect(head).not.toBe(mergeHead)
  })

  it('conversation branches switch with pending changes, which stay with the branch they were made on', async () => {
    const workspace = (await new WorkspaceResolver(f.thread, 'task', f.repo).resolve('agent')).workspacePath!
    const actions = new ThreadActionService(f.thread)
    const { action } = await actions.runCheckpointedAction(actionOptions(workspace), () => writeFileSync(join(workspace, 'agent.txt'), 'agent\n'))
    const branches = new ConversationBranchService(f.thread)
    userEdits(workspace)
    const before = pending(workspace)

    // A fork only adds a branch; the checkout is untouched.
    const first = await branches.fork(workspace, 'main', action.id, 'First')
    const second = await branches.fork(workspace, 'main', action.id, 'Second')
    expect(pending(workspace)).toEqual(before)
    // The thread's first branch can't be activated again, so its changes move with the person.
    await branches.activate(workspace, first.id)
    expect(pending(workspace)).toEqual(before)
    // Leaving a branch that can come back parks them; returning puts them back exactly.
    await branches.activate(workspace, second.id)
    expect(git(workspace, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(keptRefs(workspace)).toHaveLength(1)
    await branches.activate(workspace, first.id)
    expect(pending(workspace)).toEqual(before)
    expect(keptRefs(workspace)).toEqual([])
    expect(actions.list().some((item) => item.turnId.startsWith('user-changes:'))).toBe(false)
  })

  it('Publish runs with pending changes in both folders: the thread’s stay unpublished, the primary checkout’s come back', async () => {
    const workspace = f.child('task')
    const reviewed = f.commit(workspace, 'reviewed\n')
    writeFileSync(join(workspace, 'thread-notes.md'), 'not reviewed\n')
    writeFileSync(join(f.repo, 'draft.md'), 'staged draft\n'); git(f.repo, 'add', 'draft.md')
    userEdits(f.repo)
    git(f.repo, 'checkout', '--', 'value.txt')
    const before = pending(f.repo)
    const target = git(f.repo, 'branch', '--show-current')

    const result = await new PublishService(f.thread).publish(workspace, f.repo, target, undefined, { expectedSourceSha: reviewed, expectedTargetSha: f.baseSha })
    expect(result.state).toBe('completed')
    expect(f.read(f.repo)).toBe('reviewed\n')
    expect(pending(f.repo)).toEqual(before)
    expect(git(workspace, 'status', '--porcelain', '--untracked-files=all')).toBe('?? thread-notes.md')
    expect(() => git(f.repo, 'cat-file', '-e', `${result.publishSha}:thread-notes.md`)).toThrow()
    expect(keptRefs(f.repo)).toEqual([])
  })
})

it('the thread shows the line as Mousse’s own notice, apart from the agent’s answer', () => {
  const text = keptPendingChangesNotice({ path: '/w', ref: 'refs/mousse/pending-changes/x', files: ['a.ts'], operation: 'Undo' })
  const [notice] = mousseToUIMessages([{ id: 'pending-changes:x', role: 'system', kind: 'warning', content: text, timestamp: new Date(0).toISOString() }])
  expect(notice).toMatchObject({ role: 'assistant', metadata: expect.objectContaining({ notice: true }), parts: [{ type: 'text', text }] })
})
