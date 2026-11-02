/**
 * A thread with its worktree off works in the project folder, and no path makes a worktree for it: a send, a file
 * write, a terminal, a Git action, a workflow or a restore. A thread with the worktree on still gets one, and the
 * turn that makes it notes the project folder's uncommitted changes it does not have.
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
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { threadPlacement } from '../src/mms/workspace/threadPlacement'
import { providerResponse } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { PI_TEST_CAPABILITIES } from './support/piStub'

describe('where a thread works', () => {
  let home: string
  let repo: string
  let main: MousseMainService
  let projectId: string
  const turnFolders: Array<string | null> = []
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
    const adapter: ProviderAdapter = {
      driver: 'pi',
      capabilities: PI_TEST_CAPABILITIES,
      configured: () => true,
      async startTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
        turnFolders.push(input.cwd)
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
    expect(workspaceOf(off.id)).toBeUndefined()

    // File write: the file lands in the project folder.
    await dispatchMethod(ctx(), 'files.write', { threadId: off.id, path: 'written.txt', content: 'from files.write\n' })
    expect(readFileSync(join(repo, 'written.txt'), 'utf8')).toBe('from files.write\n')
    expect(workspaceOf(off.id)).toBeUndefined()

    // Terminal: it starts in the project folder (the shell itself is not started here).
    const create = vi.spyOn(main.ptyManager, 'create').mockReturnValue('pty-1')
    await dispatchMethod(ctx(), 'pty.create', { threadId: off.id, agentId: 'main' })
    expect(create.mock.calls[0]?.[1]).toBe(repo)
    expect(workspaceOf(off.id)).toBeUndefined()

    // Git action: the commit is made in the project folder, on its own branch.
    await dispatchMethod(ctx(), 'git.commit', { threadId: off.id, message: 'From the thread' })
    expect(git('log', '-1', '--format=%s').trim()).toBe('From the thread')
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
    expect(workspaceOf(off.id)).toBeUndefined()

    // Workflow: refused before anything is made, with the reason.
    await expect(resolveOwnedThreadWorkspace({ profileId: main.profileId, threads: main.threads, projects: main.projects }, { profileId: main.profileId, threadId: off.id, projectId }))
      .rejects.toMatchObject({ code: 'thread_in_project_folder' })
    // Restore: there is nothing to restore, and nothing is made.
    await expect(dispatchMethod(ctx(), 'workspace.restore', { threadId: off.id })).rejects.toMatchObject({ code: 'thread_in_project_folder' })

    expect(workspaceOf(off.id)).toBeUndefined()
    expect(worktrees()).toBe(1)
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
