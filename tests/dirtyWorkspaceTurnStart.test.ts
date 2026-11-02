import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { discardPendingChanges, requireClean } from '../src/mms/actions/git'
import { pendingChangesDetails } from '../src/shared/workspace'

const roots: string[] = []
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (cwd: string, ...args: string[]): boolean => { try { git(cwd, ...args); return true } catch { return false } }

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'mousse-dirty-')); roots.push(base)
  const repo = join(base, 'repo'); const thread = join(base, 'thread'); mkdirSync(repo); mkdirSync(thread)
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test'); git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'value.txt'), 'base\n'); writeFileSync(join(repo, '.gitignore'), 'ignored.log\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  return { repo, thread }
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

const boundary = { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' }
const SCREENSHOT = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10])
const outside = (repo: string) => ({ threadId: 'thread', conversationBranchId: 'main', workspacePath: repo, presentationMessageStart: 0, nativeContextBoundary: boundary })

function turnOptions(repo: string, turnId: string, start: number) {
  return {
    threadId: 'thread', turnId, conversationBranchId: 'main', workspacePath: repo,
    presentationMessageStart: start, presentationMessageEnd: start + 1,
    nativeContextStartBoundary: { ...boundary, messageIndex: start }, nativeContextBoundary: { ...boundary, messageIndex: start }
  }
}

/** The user's own edits: a changed tracked file, a staged new file, an untracked binary in a new folder, and an ignored file. */
function userEdits(repo: string): void {
  writeFileSync(join(repo, 'value.txt'), 'user edit\n')
  writeFileSync(join(repo, 'staged.txt'), 'staged by the user\n'); git(repo, 'add', 'staged.txt')
  mkdirSync(join(repo, 'notes')); writeFileSync(join(repo, 'notes', 'screen shot.png'), SCREENSHOT)
  writeFileSync(join(repo, 'ignored.log'), 'keep me\n')
}

describe('a turn that starts in a workspace changed outside Mousse', () => {
  it('records the changes as a user action of their own, without a commit, and the turn starts from its snapshot', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const before = git(repo, 'rev-parse', 'HEAD')
    userEdits(repo)
    const status = git(repo, 'status', '--porcelain', '--untracked-files=all')

    const { startSha, action: saved } = await actions.recordOutsideChanges(outside(repo))
    expect(saved).toMatchObject({ actor: { kind: 'user' }, state: 'completed', endSha: startSha, presentationMessageStart: 0, presentationMessageEnd: 0, externalEffects: [], commits: [] })
    expect(saved!.startSha).toBe(before)
    // No conversation start boundary: the app never offers the record as a turn to undo.
    expect(saved!.nativeContextStartBoundary).toBeUndefined()
    expect(saved!.changedPaths.map((item) => item.path).sort()).toEqual(['notes/screen shot.png', 'staged.txt', 'value.txt'])
    expect(saved!.git).toMatchObject({ headBefore: before, headAfter: before, rewroteHistory: false })
    // Nothing was committed, switched or staged: the checkout is exactly as the user left it.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('base')
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(status)
    expect(readFileSync(join(repo, 'ignored.log'), 'utf8')).toBe('keep me\n')
    // The snapshot has the files but not the ignored one, and it is pinned under a ref, never a branch.
    expect(git(repo, 'show', `${startSha}:value.txt`)).toBe('user edit')
    expect(tryGit(repo, 'cat-file', '-e', `${startSha}:ignored.log`)).toBe(false)
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)')).not.toMatch(/mousse/)

    const turn = actions.beginTurn(turnOptions(repo, 'turn', 0), startSha)
    expect(turn.startSha).toBe(startSha)
    expect(turn.parentActionId).toBe(saved!.id)
  })

  it('Undo of that turn leaves the user’s edits exactly and takes the agent’s out, without a commit', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    userEdits(repo)
    const { startSha, action: saved } = await actions.recordOutsideChanges(outside(repo))
    const head = git(repo, 'rev-parse', 'HEAD')
    const options = turnOptions(repo, 'turn', 0)
    actions.beginTurn(options, startSha)
    // The agent edits the user's file, adds one and deletes the user's screenshot.
    writeFileSync(join(repo, 'value.txt'), 'agent edit\n'); writeFileSync(join(repo, 'agent.txt'), 'agent\n'); rmSync(join(repo, 'notes', 'screen shot.png'))
    const turn = await actions.checkpointExistingTurn(options, startSha, 'completed')
    // Only the agent's work is the turn's.
    expect(turn.changedPaths.map((item) => item.path).sort()).toEqual(['agent.txt', 'notes/screen shot.png', 'value.txt'])
    expect(turn.changedPaths.find((item) => item.path === 'value.txt')?.beforeHash).toBe(git(repo, 'rev-parse', `${saved!.endSha}:value.txt`))

    await new UndoService(thread).undoLatest('main', repo)
    expect(readFileSync(join(repo, 'value.txt'), 'utf8')).toBe('user edit\n')
    expect(readFileSync(join(repo, 'staged.txt'), 'utf8')).toBe('staged by the user\n')
    expect(readFileSync(join(repo, 'notes', 'screen shot.png')).equals(SCREENSHOT)).toBe(true)
    expect(readFileSync(join(repo, 'ignored.log'), 'utf8')).toBe('keep me\n')
    expect(existsSync(join(repo, 'agent.txt'))).toBe(false)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    // The staging the user did is still there: Undo never touches the real index.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('staged.txt')
    expect(actions.get(saved!.id)?.state).toBe('completed')
    expect(actions.get(turn.id)?.state).toBe('undone')
  })

  it('records nothing when only an ignored file changed', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    writeFileSync(join(repo, 'ignored.log'), 'ignored only\n')
    const result = await actions.recordOutsideChanges(outside(repo))
    expect(result.action).toBeUndefined()
    expect(git(repo, 'show', `${result.startSha}:value.txt`)).toBe('base')
    expect(actions.list()).toEqual([])
  })

  it('records the same edits only once: the next turn starts from the snapshot it already has', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    userEdits(repo)
    const first = await actions.recordOutsideChanges(outside(repo))
    const again = await actions.recordOutsideChanges(outside(repo))
    expect(again).toEqual({ startSha: first.startSha })
    expect(actions.list()).toHaveLength(1)
  })

  it('a merge in progress is recorded with the files, not refused, and HEAD stays where it is', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    git(repo, 'switch', '-q', '-c', 'side'); writeFileSync(join(repo, 'value.txt'), 'side\n'); git(repo, 'commit', '-qam', 'side')
    git(repo, 'switch', '-q', '-'); writeFileSync(join(repo, 'value.txt'), 'main\n'); git(repo, 'commit', '-qam', 'main')
    expect(tryGit(repo, 'merge', 'side')).toBe(false)
    writeFileSync(join(repo, 'untracked.txt'), 'mine\n')
    const head = git(repo, 'rev-parse', 'HEAD')

    const { startSha, action } = await actions.recordOutsideChanges(outside(repo))
    expect(action?.git).toMatchObject({ operationInProgress: 'merge' })
    expect(git(repo, 'show', `${startSha}:untracked.txt`)).toBe('mine')
    expect(git(repo, 'show', `${startSha}:value.txt`)).toContain('<<<<<<<')
    // The merge is untouched: still in progress, conflicted, on the same HEAD.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(tryGit(repo, 'rev-parse', '--verify', '-q', 'MERGE_HEAD')).toBe(true)
    expect(git(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('value.txt')

    // Discard stays what it was for a conflict the user wants gone: it keeps a copy of everything it drops.
    const { backupRef } = discardPendingChanges(repo)
    expect(backupRef).toMatch(/^refs\/mousse\/discarded\//)
    expect(tryGit(repo, 'rev-parse', '--verify', '-q', 'MERGE_HEAD')).toBe(false)
  })
})

describe('refusals about pending changes', () => {
  it('after Mousse’s own steps name the folder and the first few files, and offer nothing', () => {
    const { repo } = fixture()
    for (let index = 1; index <= 7; index++) writeFileSync(join(repo, `file-${index}.txt`), `${index}\n`)
    const refusal = (() => { try { requireClean(repo, 'Worker worktree') } catch (error) { return error } })()
    expect(refusal).toMatchObject({ code: 'workspace_not_clean', details: { path: git(repo, 'rev-parse', '--show-toplevel'), count: 7, conflict: false, discard: false } })
    const files = (refusal as { details: { files: string[] } }).details.files
    expect(files).toHaveLength(5)
    expect((refusal as Error).message).toBe(`Worker worktree ${git(repo, 'rev-parse', '--show-toplevel')} has uncommitted changes: ${files.join(', ')} and 2 more.`)
    expect(pendingChangesDetails(refusal)).toBeUndefined()
  })

  it('a rebase in progress is recorded, and Undo refuses to restore files over it with no Discard', async () => {
    const { repo, thread } = fixture()
    const actions = new ThreadActionService(thread)
    const main = git(repo, 'branch', '--show-current')
    const { startSha } = await actions.recordOutsideChanges(outside(repo))
    const options = turnOptions(repo, 'turn', 0)
    actions.beginTurn(options, startSha)
    writeFileSync(join(repo, 'agent.txt'), 'agent\n')
    await actions.checkpointExistingTurn(options, startSha, 'completed')
    git(repo, 'switch', '-q', '-c', 'side'); writeFileSync(join(repo, 'value.txt'), 'side\n'); git(repo, 'commit', '-qam', 'side')
    git(repo, 'switch', '-q', main); writeFileSync(join(repo, 'value.txt'), 'main\n'); git(repo, 'commit', '-qam', 'main')
    git(repo, 'switch', '-q', 'side')
    expect(tryGit(repo, 'rebase', '-q', main)).toBe(false)
    // A new turn can still start: the rebase is recorded with the snapshot.
    expect((await actions.recordOutsideChanges(outside(repo))).action?.git).toMatchObject({ operationInProgress: 'rebase' })
    const refusal = await new UndoService(thread).undoLatest('main', repo).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'workspace_conflict', details: { operation: 'rebase', discard: false } })
    expect((refusal as Error).message).toMatch(/has a rebase in progress with conflicts in value\.txt\. Finish or abort it in a terminal, then try again\.$/)
    expect(() => discardPendingChanges(repo)).toThrow(/rebase in progress/)
    tryGit(repo, 'rebase', '--abort')
  })
})
