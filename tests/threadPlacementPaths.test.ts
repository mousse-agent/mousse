/**
 * A thread with its worktree off works in the project folder, and no path makes a worktree for it: a send, a file
 * write, a terminal, a Git action, a workflow or a restore. Its turns are still snapshotted and undone there, without
 * touching HEAD, the index or the branches. A thread with the worktree on still gets one, and the turn that makes it
 * notes the project folder's uncommitted changes it does not have.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '../src/shared/transcript'
import type { Thread } from '../src/shared/types'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import type { ProviderAdapter, TurnInput, TurnResult, TurnSink } from '../src/mms/harness/adapter'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { testHarness } from '../src/mms/run/testkit/harness'
import { resolveOwnedThreadWorkspace } from '../src/mms/workspace/WorkflowWorkspace'
import { isProjectFolderWorkspace, ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { threadPlacement } from '../src/mms/workspace/threadPlacement'
import { providerResponse } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { PI_TEST_CAPABILITIES } from './support/piStub'

describe('where a thread works', () => {
  let home: string
  let repo: string
  let main: MousseMainService
  let projectId: string
  const turnFolders: Array<string | null> = []
  /** What the scripted agent does in its folder during a turn. */
  let onTurn: ((cwd: string) => void) | undefined
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-placement-'))
    repo = join(home, 'repo')
    mkdirSync(repo)
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'value.txt'), 'base\n')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    main = await MousseMainService.create({ homeDir: join(home, 'home'), headless: true, ownerKind: 'test' })
    await main.start()
    main.settings.set({ provider: { llmProvider: 'openai', model: 'fixture-model' },
      integrations: { ...main.settings.get().integrations, skills: { ...main.settings.get().integrations.skills, enabled: false } } })
    turnFolders.length = 0
    onTurn = undefined
    const adapter: ProviderAdapter = {
      driver: 'pi',
      capabilities: PI_TEST_CAPABILITIES,
      configured: () => true,
      async startTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
        turnFolders.push(input.cwd)
        if (input.cwd) onTurn?.(input.cwd)
        const providerRef = { provider: input.llmProvider, model: input.model }
        sink.providerRef(providerRef)
        const text = 'done'
        sink.text({ phase: 'complete', content: text, contentIndex: 0 })
        const reply = providerResponse([{ type: 'text', text }], 'stop') as AssistantMessage
        return { text, aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [...input.messages, reply], providerRef }
      },
      interrupt: async () => 'not_active'
    }
    main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
    projectId = main.projects.openProject(repo).id
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await main.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  const ctx = () => ({ mms: main, globalSequence: () => 0 })
  const thread = (worktreeEnabled?: boolean): Thread => main.threads.createThread('Placement', projectId, repo, worktreeEnabled === undefined ? {} : { worktreeEnabled })
  /** The worktrees the repository has, the project folder first. */
  const worktrees = () => git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length
  const workspaceOf = (threadId: string) => new ThreadWorkspaceManager(main.threads.getThreadDir(threadId)).load()
  /** No worktree: at most the project folder's own record, and the repository lists only the project folder. */
  const noWorktree = (threadId: string) => {
    const workspace = workspaceOf(threadId)
    expect(workspace === undefined || isProjectFolderWorkspace(workspace)).toBe(true)
    expect(worktrees()).toBe(1)
  }
  /** Undo of the thread's latest turn, confirming the diff when the provider's containment asks for a review. */
  const undo = async (threadId: string) => {
    const first = await dispatchMethod(ctx(), 'actions.undoLatest', { threadId }) as { requiresReview?: true; diffSha?: string }
    if (first?.requiresReview) return dispatchMethod(ctx(), 'actions.undoLatest', { threadId, reviewedDiffSha: first.diffSha })
    return first
  }
  /** HEAD, the branches and the real index, as Git reads them without refreshing anything. */
  const gitState = () => ({
    head: git('rev-parse', 'HEAD').trim(),
    branch: git('symbolic-ref', '-q', 'HEAD').trim(),
    branches: git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'),
    index: git('ls-files', '--stage'),
    staged: git('--no-optional-locks', 'diff', '--cached', '--name-status')
  })

  it('one helper decides: off is the project folder, on or unset is a worktree', () => {
    expect(threadPlacement({ worktreeEnabled: false })).toBe('project-folder')
    expect(threadPlacement({ worktreeEnabled: true })).toBe('worktree')
    expect(threadPlacement({})).toBe('worktree')
    expect(threadPlacement(undefined)).toBe('worktree')
  })

  it('makes no worktree for a thread with its worktree off, by any path', async () => {
    const off = thread(false)

    // Send: the turn runs in the project folder.
    const sent = await main.orchestrator.send({ content: 'edit something', mode: 'agent' }, false, { threadId: off.id })
    expect(sent.error).toBeUndefined()
    expect(turnFolders.at(-1)).toBe(repo)
    noWorktree(off.id)

    // File write: the file lands in the project folder.
    await dispatchMethod(ctx(), 'files.write', { threadId: off.id, path: 'written.txt', content: 'from files.write\n' })
    expect(readFileSync(join(repo, 'written.txt'), 'utf8')).toBe('from files.write\n')
    noWorktree(off.id)

    // Terminal: it starts in the project folder (the shell itself is not started here).
    const create = vi.spyOn(main.ptyManager, 'create').mockReturnValue('pty-1')
    await dispatchMethod(ctx(), 'pty.create', { threadId: off.id, agentId: 'main' })
    expect(create.mock.calls[0]?.[1]).toBe(repo)
    noWorktree(off.id)

    // Git action: the commit is made in the project folder, on its own branch.
    await dispatchMethod(ctx(), 'git.commit', { threadId: off.id, message: 'From the thread' })
    expect(git('log', '-1', '--format=%s').trim()).toBe('From the thread')
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
    noWorktree(off.id)

    // Workflow: refused before anything is made, with the reason.
    await expect(resolveOwnedThreadWorkspace({ profileId: main.profileId, threads: main.threads, projects: main.projects }, { profileId: main.profileId, threadId: off.id, projectId }))
      .rejects.toMatchObject({ code: 'thread_in_project_folder', message: 'This chat works in the project folder. Turn on the worktree for this chat to run workflows.' })
    // Restore: there is no worktree to bring back, and none is made.
    const restored = await dispatchMethod(ctx(), 'workspace.restore', { threadId: off.id }) as { metadata: { kind?: string; worktreePath: string } }
    expect(restored.metadata).toMatchObject({ kind: 'project-folder', worktreePath: realpathSync(repo) })

    noWorktree(off.id)
    // Its record is kept apart from worktree records, so nothing that retires or deletes worktrees reads it.
    expect(existsSync(join(main.threads.getThreadDir(off.id), 'workspace.json'))).toBe(false)
    expect(existsSync(join(main.threads.getThreadDir(off.id), 'project-folder.json'))).toBe(true)
  }, 60_000)

  it('snapshots a worktree-off turn in the project folder, and Undo restores it without touching HEAD, the index or the branches', async () => {
    // A staged edit and an untracked file of the person's, before the turn.
    writeFileSync(join(repo, 'value.txt'), 'staged by the person\n')
    git('add', 'value.txt')
    writeFileSync(join(repo, 'mine.txt'), 'the person\'s\n')
    const before = gitState()
    const off = thread(false)
    onTurn = (cwd) => {
      writeFileSync(join(cwd, 'value.txt'), 'the agent\'s edit\n')
      writeFileSync(join(cwd, 'agent-new.txt'), 'made by the agent\n')
    }
    const sent = await main.orchestrator.send({ content: 'edit value.txt', mode: 'agent' }, false, { threadId: off.id })
    expect(sent.error).toBeUndefined()
    noWorktree(off.id)
    expect(workspaceOf(off.id)).toMatchObject({ kind: 'project-folder', branch: '' })
    const turn = new ThreadActionService(main.threads.getThreadDir(off.id)).list().filter((action) => !action.turnId.startsWith('user-changes:')).at(-1)!
    expect(turn.changedPaths.map((change) => change.path).sort()).toEqual(['agent-new.txt', 'value.txt'])
    expect(gitState()).toEqual(before)

    onTurn = undefined
    await undo(off.id)
    expect(readFileSync(join(repo, 'value.txt'), 'utf8')).toBe('staged by the person\n')
    expect(existsSync(join(repo, 'agent-new.txt'))).toBe(false)
    expect(readFileSync(join(repo, 'mine.txt'), 'utf8')).toBe('the person\'s\n')
    expect(gitState()).toEqual(before)
    noWorktree(off.id)
  }, 60_000)

  it('lets two threads share one project folder: Undo of one keeps what the other wrote', async () => {
    const first = thread(false)
    const second = thread(false)
    onTurn = (cwd) => writeFileSync(join(cwd, 'first.txt'), 'first\n')
    await main.orchestrator.send({ content: 'write first', mode: 'agent' }, false, { threadId: first.id })
    onTurn = (cwd) => writeFileSync(join(cwd, 'second.txt'), 'second\n')
    await main.orchestrator.send({ content: 'write second', mode: 'agent' }, false, { threadId: second.id })
    onTurn = undefined
    await undo(first.id)
    expect(existsSync(join(repo, 'first.txt'))).toBe(false)
    expect(readFileSync(join(repo, 'second.txt'), 'utf8')).toBe('second\n')
    noWorktree(first.id)
  }, 60_000)

  it('offers no Publish for a worktree-off thread: its changes are already in the project folder', async () => {
    const off = thread(false)
    await main.orchestrator.send({ content: 'edit something', mode: 'agent' }, false, { threadId: off.id })
    expect(await dispatchMethod(ctx(), 'publish.status', { threadId: off.id })).toMatchObject({ available: false })
    await expect(dispatchMethod(ctx(), 'publish.start', { threadId: off.id, targetBranch: 'main' })).rejects.toMatchObject({ code: 'thread_in_project_folder' })
    const status = await dispatchMethod(ctx(), 'workspace.getStatus', { threadId: off.id }) as { execution: { placement?: string; capability: { publishable: boolean; undoable: boolean } } }
    expect(status.execution).toMatchObject({ placement: 'project-folder', capability: { publishable: false, undoable: true } })
  }, 60_000)

  it('records a worktree-off turn in a folder without Git in its hidden store, and Undo restores it, the folder gaining no .git', async () => {
    const plainFolder = join(home, 'plain'); mkdirSync(plainFolder)
    writeFileSync(join(plainFolder, 'notes.txt'), 'the person\'s notes\n')
    const plainProject = main.projects.openProject(plainFolder).id
    const off = main.threads.createThread('Plain', plainProject, plainFolder, { worktreeEnabled: false })
    onTurn = (cwd) => {
      writeFileSync(join(cwd, 'notes.txt'), 'rewritten by the agent\n')
      writeFileSync(join(cwd, 'agent-new.txt'), 'made by the agent\n')
    }
    const sent = await main.orchestrator.send({ content: 'edit the notes', mode: 'agent' }, false, { threadId: off.id })
    expect(sent.error).toBeUndefined()
    expect(turnFolders.at(-1)).toBe(plainFolder)
    // No worktree and no project-folder record: the folder's hidden store records the turn.
    expect(workspaceOf(off.id)).toBeUndefined()
    const turn = new ThreadActionService(main.threads.getThreadDir(off.id)).list().filter((action) => !action.turnId.startsWith('user-changes:')).at(-1)!
    expect(turn.scope).toBeUndefined()
    expect(turn.changedPaths.map((change) => change.path).sort()).toEqual(['agent-new.txt', 'notes.txt'])

    onTurn = undefined
    await undo(off.id)
    expect(readFileSync(join(plainFolder, 'notes.txt'), 'utf8')).toBe('the person\'s notes\n')
    expect(existsSync(join(plainFolder, 'agent-new.txt'))).toBe(false)
    expect(existsSync(join(plainFolder, '.git'))).toBe(false)
  }, 60_000)

  it('still makes a worktree for a thread with its worktree on, from a file write as from a send', async () => {
    const on = thread(true)
    await dispatchMethod(ctx(), 'files.write', { threadId: on.id, path: 'written.txt', content: 'x\n' })
    expect(workspaceOf(on.id)?.lifecycle).toBe('ready')
    expect(existsSync(join(repo, 'written.txt'))).toBe(false)
    expect(worktrees()).toBe(2)
  }, 60_000)

  it('notes on the turn that the project folder had uncommitted changes the new worktree does not have, and copies nothing', async () => {
    writeFileSync(join(repo, 'value.txt'), 'edited, not committed\n')
    writeFileSync(join(repo, 'draft.md'), 'new, not committed\n')
    const on = thread()
    const sent = await main.orchestrator.send({ content: 'edit something', mode: 'agent' }, false, { threadId: on.id })
    expect(sent.error).toBeUndefined()
    const workspace = workspaceOf(on.id)!
    expect(turnFolders.at(-1)).toBe(workspace.worktreePath)
    // The worktree started from the last commit; the project folder keeps its changes.
    expect(readFileSync(join(workspace.worktreePath, 'value.txt'), 'utf8')).toBe('base\n')
    expect(existsSync(join(workspace.worktreePath, 'draft.md'))).toBe(false)
    expect(readFileSync(join(repo, 'value.txt'), 'utf8')).toBe('edited, not committed\n')
    const turns = new ThreadActionService(main.threads.getThreadDir(on.id)).list().filter((action) => !action.turnId.startsWith('user-changes:'))
    expect(turns.at(-1)?.startNote).toBe("The project folder had uncommitted changes the worktree doesn't have (2 files: value.txt, draft.md). The worktree started from the last commit; the changes stay in the project folder.")

    // Only the turn that made the worktree carries it.
    await main.orchestrator.send({ content: 'again', mode: 'agent' }, false, { threadId: on.id })
    const later = new ThreadActionService(main.threads.getThreadDir(on.id)).list().filter((action) => !action.turnId.startsWith('user-changes:'))
    expect(later.at(-1)?.startNote).toBeUndefined()
  }, 60_000)

  it('notes nothing when the project folder is clean', async () => {
    const on = thread(true)
    await main.orchestrator.send({ content: 'edit something', mode: 'agent' }, false, { threadId: on.id })
    const turns = new ThreadActionService(main.threads.getThreadDir(on.id)).list()
    expect(turns.length).toBeGreaterThan(0)
    expect(turns.every((action) => action.startNote === undefined)).toBe(true)
  }, 60_000)
})
