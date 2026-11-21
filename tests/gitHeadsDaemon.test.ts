/**
 * `git.heads`, the call behind the sidebar's thread cards: every card's branch without a Git process, and a push
 * (`git.headsChanged`) when Mousse makes a thread's worktree or renames its branch.
 *
 * Threads: one in its own worktree (heard of when its worktree is planned, made and renamed), one in its project's folder,
 * one whose worktree is not made yet, one whose worktree is not on
 * disk (retired), one unknown; projects: a repository, and one unknown.
 */
import * as childProcess from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '../src/shared/transcript'
import type { GitHeadsResult } from '../src/shared/types'
import * as snapshots from '../src/mms/actions/snapshots'
import { MousseMainService } from '../src/mms/MousseMainService'
import type { ProviderAdapter, TurnInput, TurnResult, TurnSink } from '../src/mms/harness/adapter'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { testHarness } from '../src/mms/run/testkit/harness'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { providerResponse } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { PI_TEST_CAPABILITIES } from './support/piStub'

let home: string
let repo: string
let main: MousseMainService
let projectId: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

// Every Git process this process starts, however it is started.
let started = 0
const prototype = (childProcess as unknown as { ChildProcess: { prototype: { spawn(options: { file?: string }): unknown } } }).ChildProcess.prototype
const spawn = prototype.spawn

beforeEach(async () => {
  prototype.spawn = function (this: unknown, options: { file?: string }) {
    if (/^git(\.exe)?$/i.test(basename(String(options?.file ?? '')))) started++
    return spawn.call(this, options)
  }
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-heads-')))
  repo = join(home, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'value.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base')
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  main = await MousseMainService.create({ homeDir: join(home, 'home'), headless: true, ownerKind: 'test' })
  await main.start()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'fixture-model' },
    integrations: { ...main.settings.get().integrations, skills: { ...main.settings.get().integrations.skills, enabled: false } } })
  const adapter: ProviderAdapter = {
    driver: 'pi',
    capabilities: PI_TEST_CAPABILITIES,
    configured: () => true,
    async startTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
      const providerRef = { provider: input.llmProvider, model: input.model }
      sink.providerRef(providerRef)
      sink.text({ phase: 'complete', content: 'done', contentIndex: 0 })
      const reply = providerResponse([{ type: 'text', text: 'done' }], 'stop') as AssistantMessage
      return { text: 'done', aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [...input.messages, reply], providerRef }
    },
    interrupt: async () => 'not_active'
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  projectId = main.projects.openProject(repo).id
})

afterEach(async () => {
  prototype.spawn = spawn
  vi.restoreAllMocks()
  await main.stop()
  // On Windows a just-stopped service's folders can stay held for a moment (master's fixtures meet the same EPERM).
  try { rmSync(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 }) } catch { /* left for the temp folder's own cleanup */ }
})

const heads = (params: unknown) => dispatchMethod({ mms: main, globalSequence: () => 0 }, 'git.heads', params) as Promise<GitHeadsResult>

it('names every card’s branch without a Git process, and pushes a change when Mousse makes a worktree', { timeout: 180_000 }, async () => {
  const pushed: unknown[] = []
  /** What the card of the thread with its own worktree read each time it heard of a change. */
  const readOnPush: Array<Promise<GitHeadsResult>> = []
  const own = main.threads.createThread('Own', projectId, repo, {})
  main.events.on('protocol:event', (event: { type?: string; data?: { threadIds?: string[] } }) => {
    if (event.type !== 'git.headsChanged') return
    pushed.push(event.data)
    if (event.data?.threadIds?.includes(own.id)) readOnPush.push(heads({ threadIds: [own.id] }))
  })
  const folder = main.threads.createThread('Folder', projectId, repo, { worktreeEnabled: false })
  const fresh = main.threads.createThread('Fresh', projectId, repo, {})
  // Before its first turn, a thread that gets its own worktree has no branch yet, and never its project's.
  expect((await heads({ threadIds: [own.id] })).threads[own.id]).toEqual({ own: true, branch: null, generation: 0, lifecycle: 'unprovisioned' })
  await main.orchestrator.send({ content: 'go', mode: 'agent' }, false, { threadId: own.id })
  await main.orchestrator.send({ content: 'go', mode: 'agent' }, false, { threadId: folder.id })
  const workspace = new ThreadWorkspaceManager(main.threads.getThreadDir(own.id)).load()!
  // Heard once its worktree is planned and again once it is made: each time the card reads the branch Mousse recorded.
  expect(readOnPush.length).toBeGreaterThanOrEqual(2)
  for (const read of await Promise.all(readOnPush)) expect(read.threads[own.id]).toMatchObject({ own: true, branch: workspace.branch })

  // Mousse renames the thread's branch (the title model's name): the card hears it and reads the new name.
  pushed.length = 0
  expect(await new ThreadWorkspaceManager(main.threads.getThreadDir(own.id)).renameOwnBranch(workspace.branch, 'mousse/named-by-title')).toBe('renamed')
  expect(pushed).toEqual([{ threadIds: [own.id] }])
  expect((await heads({ threadIds: [own.id] })).threads[own.id]).toMatchObject({ own: true, branch: 'mousse/named-by-title' })

  // The agent switched branches in its worktree, and the project folder is on another branch.
  git(workspace.worktreePath, 'checkout', '-q', '-b', 'agent-branch')
  git(repo, 'checkout', '-q', '-b', 'person-branch')
  started = 0
  const normalLookup = vi.spyOn(main.threads, 'getThread')
  const answer = await heads({ threadIds: [own.id, folder.id, fresh.id, 'no-such-thread'], projectIds: [projectId, 'no-such-project'] })
  expect(started).toBe(0)
  expect(normalLookup).not.toHaveBeenCalled()
  normalLookup.mockRestore()
  expect(answer.projects[projectId]).toEqual({ repo: true, branch: 'person-branch' })
  expect(answer.projects['no-such-project']).toEqual({ error: 'Project not found' })
  expect(answer.threads[own.id]).toEqual({ own: true, branch: 'agent-branch', folder: workspace.worktreePath, generation: workspace.generation ?? 0, lifecycle: 'ready' })
  expect(answer.threads[folder.id]).toEqual({ project: true })
  expect(answer.threads[fresh.id]).toEqual({ own: true, branch: null, generation: 0, lifecycle: 'unprovisioned' })
  expect(answer.threads['no-such-thread']).toEqual({ error: 'Thread not found' })

  // Not on disk (a storage rule retired it): the branch Mousse recorded, and no folder to work in.
  renameSync(workspace.worktreePath, `${workspace.worktreePath}-away`)
  expect((await heads({ threadIds: [own.id] })).threads[own.id]).toMatchObject({ own: true, branch: 'mousse/named-by-title', generation: workspace.generation ?? 0, lifecycle: 'ready', missing: true })
  // The Git panel's status read of it does not bring it back either.
  const status = await dispatchMethod({ mms: main, globalSequence: () => 0 }, 'git.status', { threadId: own.id }) as { status: { missing?: boolean } }
  expect(status.status.missing).toBe(true)
  expect(existsSync(workspace.worktreePath)).toBe(false)
  expect(started).toBe(0)

  // A detached HEAD names its commit; it is not a failed read.
  renameSync(`${workspace.worktreePath}-away`, workspace.worktreePath)
  git(workspace.worktreePath, 'checkout', '-q', '--detach')
  const commit = git(workspace.worktreePath, 'rev-parse', '--short=7', 'HEAD')
  expect((await heads({ threadIds: [own.id] })).threads[own.id]).toMatchObject({ own: true, branch: null, detachedAt: commit })

  // The directory is still there, but its .git entry is unreadable or gone.
  const dotGit = join(workspace.worktreePath, '.git')
  renameSync(dotGit, `${dotGit}-saved`)
  expect((await heads({ threadIds: [own.id] })).threads[own.id]).toMatchObject({
    own: true,
    unavailable: 'The worktree folder is not a Git checkout.'
  })
})

it('rejects malformed Git scopes before asking for access to a folder', async () => {
  const wait = vi.spyOn(main.orchestrator, 'waitForThreadFolders')
  const path = join(home, 'must-not-probe')
  await expect(heads({ projectIds: [projectId], path })).rejects.toThrow(/path/)
  await expect(dispatchMethod({ mms: main, globalSequence: () => 0 }, 'git.status', { projectId, cwd: path })).rejects.toThrow(/cwd/)
  await expect(dispatchMethod({ mms: main, globalSequence: () => 0 }, 'git.log', { projectId, limit: -1 })).rejects.toThrow(/limit/)
  expect(wait).not.toHaveBeenCalled()
})

it.each([
  'during manifest checkout creation',
  'after manifest reconstruction returns, before generation publication',
  'during retained-snapshot restore'
])('hides the checkout and refuses old-generation Git reads %s', { timeout: 120_000 }, async (pause) => {
  const request = (method: string, params: unknown) => dispatchMethod({
    mms: main,
    globalSequence: () => 0,
    connection: { id: 'git-panel', clientType: 'gui', capabilities: new Set() }
  }, method, params)
  const thread = main.threads.createThread('Rebuilt', projectId, repo, {})
  const manager = new ThreadWorkspaceManager(main.threads.getThreadDir(thread.id))
  const workspace = await manager.provision(thread.id, 'main', repo)
  const scope = { threadId: thread.id, workspaceGeneration: workspace.generation ?? 0 }

  const reading = Promise.withResolvers<void>()
  const finishRead = Promise.withResolvers<void>()
  const getStatus = main.gitService.getStatus.bind(main.gitService)
  const status = vi.spyOn(main.gitService, 'getStatus').mockImplementationOnce(async (...args) => {
    const result = await getStatus(...args)
    reading.resolve()
    await finishRead.promise
    return result
  })
  const pending = request('git.status', scope)
  // Attach the rejection handler before releasing the read.
  const readResult = pending.catch((error: unknown) => error)
  let restoring: Promise<unknown> | undefined
  const finishRebuild = Promise.withResolvers<void>()
  try {
    await Promise.race([reading.promise, pending])
    const retained = pause === 'during retained-snapshot restore'
    if (retained) {
      writeFileSync(join(workspace.worktreePath, 'value.txt'), 'retained edit\n')
      const snapshot = await snapshots.takeSnapshotAsync(workspace.worktreePath, { reason: 'test restore' })
      git(repo, 'update-ref', workspace.retainedRef, snapshot.sha)
      git(repo, 'worktree', 'remove', '--force', workspace.worktreePath)
      expect(manager.hasReconstructionManifest()).toBe(false)
    } else {
      main.storageCleanup.setClockForTests(() => Date.now() + 40 * 86_400_000)
      await request('storage.configure', { policy: {
        schemaVersion: 1,
        worktrees: { removeWithDeletedThreads: true, inactiveDays: 30, removeMerged: false },
        browser: { captureDays: null }
      } })
      await request('storage.cleanup.run', {})
      expect(manager.hasReconstructionManifest()).toBe(true)
    }
    expect(existsSync(workspace.worktreePath)).toBe(false)

    const atPause = Promise.withResolvers<void>()
    const waitHere = async () => {
      atPause.resolve()
      await finishRebuild.promise
    }
    if (retained) {
      const move = snapshots.moveFilesToSnapshotAsync
      vi.spyOn(snapshots, 'moveFilesToSnapshotAsync').mockImplementationOnce(async (...args) => {
        await waitHere()
        return move(...args)
      })
    } else if (pause === 'during manifest checkout creation') {
      const reconstruct = WorktreeRetirementService.prototype.reconstruct
      vi.spyOn(WorktreeRetirementService.prototype, 'reconstruct').mockImplementationOnce(function (this: WorktreeRetirementService, path) {
        return reconstruct.call(this, path, { env: {}, prepare: waitHere })
      })
    } else {
      const verify = ThreadWorkspaceManager.prototype.verify
      vi.spyOn(ThreadWorkspaceManager.prototype, 'verify').mockImplementation(async function (this: ThreadWorkspaceManager, metadata, options) {
        if (metadata?.threadId === thread.id && metadata.generation === scope.workspaceGeneration + 1) await waitHere()
        return verify.call(this, metadata, options)
      })
    }
    restoring = request('workspace.restore', { threadId: thread.id })
    await Promise.race([atPause.promise, restoring.then(() => { throw new Error('Restore did not reach the requested pause') })])
    expect(existsSync(join(workspace.worktreePath, '.git'))).toBe(true)
    const file = join(workspace.worktreePath, 'value.txt')
    if (pause === 'during manifest checkout creation') expect(existsSync(file)).toBe(false)
    else expect(readFileSync(file, 'utf8')).toBe('base\n')
    expect(manager.load()).toMatchObject({ generation: scope.workspaceGeneration, lifecycle: 'ready' })

    expect.soft((await heads({ threadIds: [thread.id] })).threads[thread.id]).toMatchObject({ missing: true })
    expect.soft(status).toHaveBeenCalledTimes(1)
    await expect.soft(request('git.status', { ...scope, attempt: 1 })).rejects.toMatchObject({ code: 'workspace_changed' })
    expect.soft(status).toHaveBeenCalledTimes(1)
    finishRead.resolve()
    expect.soft(await readResult).toMatchObject({ code: 'workspace_changed' })
  } finally {
    finishRead.resolve()
    finishRebuild.resolve()
    await readResult
    await restoring
  }

  if (pause === 'during retained-snapshot restore') {
    expect(readFileSync(join(workspace.worktreePath, 'value.txt'), 'utf8')).toBe('retained edit\n')
  }
  const generation = scope.workspaceGeneration + 1
  expect((await heads({ threadIds: [thread.id] })).threads[thread.id]).toMatchObject({ folder: workspace.worktreePath, generation })
  await expect(request('git.status', { ...scope, workspaceGeneration: generation })).resolves.toMatchObject({ status: { isRepo: true } })
})
