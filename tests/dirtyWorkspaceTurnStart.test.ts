import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { discardPendingChanges, inspectPendingChanges, requireClean } from '../src/mms/actions/git'
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

describe('a turn that starts in a dirty workspace', () => {
  it('saves the pending changes as their own user checkpoint and the turn starts after it', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const before = git(repo, 'rev-parse', 'HEAD')
    userEdits(repo)

    const { startSha, action: saved } = await actions.saveUserChanges({ threadId: 'thread', conversationBranchId: 'main', workspacePath: repo, presentationMessageStart: 0, nativeContextBoundary: boundary })
    expect(saved).toMatchObject({ actor: { kind: 'user' }, state: 'completed', startSha: before, endSha: startSha, presentationMessageStart: 0, presentationMessageEnd: 0, externalEffects: [] })
    // No conversation start boundary: the app never offers the save as a turn to undo.
    expect(saved!.nativeContextStartBoundary).toBeUndefined()
    expect(saved!.changedPaths.map((item) => item.path).sort()).toEqual(['notes/screen shot.png', 'staged.txt', 'value.txt'])
    expect(git(repo, 'log', '-1', '--format=%s')).toMatch(/^mousse: save pending changes/)
    // Ignored files are never part of a checkpoint.
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(tryGit(repo, 'cat-file', '-e', 'HEAD:ignored.log')).toBe(false)

    const turn = actions.beginTurn(turnOptions(repo, 'turn', 0), startSha)
    expect(turn.startSha).toBe(startSha)
    expect(turn.parentActionId).toBe(saved!.id)
  })

  it('Undo of that turn brings the user’s edits back exactly, untracked files included, and keeps the agent’s out', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    userEdits(repo)
    const { startSha, action: saved } = await actions.saveUserChanges({ threadId: 'thread', conversationBranchId: 'main', workspacePath: repo, presentationMessageStart: 0, nativeContextBoundary: boundary })
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
    expect(git(repo, 'rev-parse', 'HEAD^{tree}')).toBe(git(repo, 'rev-parse', `${saved!.endSha}^{tree}`))
    expect(actions.get(saved!.id)?.state).toBe('completed')
    expect(actions.get(turn.id)?.state).toBe('undone')
  })

  it('a clean workspace records nothing', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    writeFileSync(join(repo, 'ignored.log'), 'ignored only\n')
    const result = await actions.saveUserChanges({ threadId: 'thread', conversationBranchId: 'main', workspacePath: repo })
    expect(result).toEqual({ startSha: git(repo, 'rev-parse', 'HEAD') })
    expect(actions.list()).toEqual([])
  })

  it('an unresolved merge conflict is never saved; the refusal names the folder and files and offers only Discard', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    git(repo, 'switch', '-q', '-c', 'side'); writeFileSync(join(repo, 'value.txt'), 'side\n'); git(repo, 'commit', '-qam', 'side')
    git(repo, 'switch', '-q', '-'); writeFileSync(join(repo, 'value.txt'), 'main\n'); git(repo, 'commit', '-qam', 'main')
    expect(tryGit(repo, 'merge', 'side')).toBe(false)
    writeFileSync(join(repo, 'untracked.txt'), 'mine\n')
    const head = git(repo, 'rev-parse', 'HEAD')

    const refusal = await actions.saveUserChanges({ threadId: 'thread', conversationBranchId: 'main', workspacePath: repo }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'workspace_conflict', details: { label: 'Thread workspace', folder: 'thread', conflict: true, actions: ['discard'], files: ['value.txt', 'untracked.txt'], count: 2 } })
    expect((refusal as Error).message).toContain(git(repo, 'rev-parse', '--show-toplevel'))
    expect((refusal as Error).message).toMatch(/merge in progress with conflicts in value\.txt/)
    expect(pendingChangesDetails(refusal)?.actions).toEqual(['discard'])
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(actions.list()).toEqual([])

    // Discard (after the person confirmed) ends the merge and keeps a copy of everything it dropped.
    const { backupRef } = discardPendingChanges(repo)
    expect(backupRef).toMatch(/^refs\/mousse\/discarded\//)
    expect(inspectPendingChanges(repo)).toEqual({ top: git(repo, 'rev-parse', '--show-toplevel'), files: [], unmerged: [] })
    expect(tryGit(repo, 'rev-parse', '--verify', '-q', 'MERGE_HEAD')).toBe(false)
    expect(git(repo, 'show', `${backupRef}:untracked.txt`)).toBe('mine')
    expect(git(repo, 'show', `${backupRef}:value.txt`)).toContain('<<<<<<<')
    expect(git(repo, 'rev-parse', `${backupRef}^`)).toBe(head)
    // The turn can start now.
    expect((await actions.saveUserChanges({ threadId: 'thread', conversationBranchId: 'main', workspacePath: repo })).startSha).toBe(head)
  })
})

describe('refusals about pending changes', () => {
  it('name the folder and the first few files and carry the caller’s actions', () => {
    const { repo } = fixture()
    for (let index = 1; index <= 7; index++) writeFileSync(join(repo, `file-${index}.txt`), `${index}\n`)
    const refusal = (() => { try { requireClean(repo, 'Thread workspace', { folder: 'thread', actions: ['save', 'discard'] }) } catch (error) { return error } })()
    expect(refusal).toMatchObject({ code: 'workspace_not_clean', details: { path: git(repo, 'rev-parse', '--show-toplevel'), count: 7, conflict: false, actions: ['save', 'discard'] } })
    const details = pendingChangesDetails(refusal)!
    expect(details.files).toHaveLength(5)
    expect((refusal as Error).message).toBe(`Thread workspace ${details.path} has uncommitted changes: ${details.files.join(', ')} and 2 more. Save or discard them, then try again.`)
  })

  it('offer no action for a folder the user cannot act on from the app', () => {
    const { repo } = fixture()
    writeFileSync(join(repo, 'value.txt'), 'changed\n')
    const refusal = (() => { try { requireClean(repo, 'Worker worktree') } catch (error) { return error } })()
    expect(refusal).toMatchObject({ code: 'workspace_not_clean', details: { files: ['value.txt'], actions: [] } })
    expect((refusal as Error).message).toMatch(/Commit or discard them/)
    expect(pendingChangesDetails(refusal)).toBeUndefined()
  })

  it('Undo in a dirty workspace offers Discard, never Save, so the turn stays the latest action', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const options = turnOptions(repo, 'turn', 0)
    const start = git(repo, 'rev-parse', 'HEAD')
    actions.beginTurn(options, start)
    writeFileSync(join(repo, 'agent.txt'), 'agent\n')
    await actions.checkpointExistingTurn(options, start, 'completed')
    writeFileSync(join(repo, 'value.txt'), 'later user edit\n')
    await expect(new UndoService(thread).undoLatest('main', repo)).rejects.toMatchObject({ code: 'workspace_not_clean', details: { folder: 'thread', actions: ['discard'], files: ['value.txt'] } })
    expect(readFileSync(join(repo, 'value.txt'), 'utf8')).toBe('later user edit\n')
  })
})
