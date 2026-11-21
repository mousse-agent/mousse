/**
 * `git.heads`, the call behind the sidebar's thread cards: every card's branch without a Git process, and a push
 * (`git.headsChanged`) when Mousse makes a thread's worktree or renames its branch.
 *
 * Threads: one in its own worktree, one in its project's folder, one with no worktree yet, one whose worktree is not on
 * disk (retired), one unknown; projects: a repository, and one unknown.
 */
import * as childProcess from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '../src/shared/transcript'
import type { GitHeadsResult } from '../src/shared/types'
import { MousseMainService } from '../src/mms/MousseMainService'
import type { ProviderAdapter, TurnInput, TurnResult, TurnSink } from '../src/mms/harness/adapter'
import { dispatchMethod } from '../src/mms/protocol/handlers'
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
  main.events.on('protocol:event', (event: { type?: string; data?: unknown }) => { if (event.type === 'git.headsChanged') pushed.push(event.data) })
  const own = main.threads.createThread('Own', projectId, repo, {})
  const folder = main.threads.createThread('Folder', projectId, repo, { worktreeEnabled: false })
  const fresh = main.threads.createThread('Fresh', projectId, repo, {})
  await main.orchestrator.send({ content: 'go', mode: 'agent' }, false, { threadId: own.id })
  await main.orchestrator.send({ content: 'go', mode: 'agent' }, false, { threadId: folder.id })
  const workspace = new ThreadWorkspaceManager(main.threads.getThreadDir(own.id)).load()!
  expect(pushed).toContainEqual({ threadIds: [own.id] })

  // Mousse renames the thread's branch (the title model's name): the card hears it and reads the new name.
  pushed.length = 0
  expect(await new ThreadWorkspaceManager(main.threads.getThreadDir(own.id)).renameOwnBranch(workspace.branch, 'mousse/named-by-title')).toBe('renamed')
  expect(pushed).toEqual([{ threadIds: [own.id] }])
  expect((await heads({ threadIds: [own.id] })).threads[own.id]).toMatchObject({ own: true, branch: 'mousse/named-by-title' })

  // The agent switched branches in its worktree, and the project folder is on another branch.
  git(workspace.worktreePath, 'checkout', '-q', '-b', 'agent-branch')
  git(repo, 'checkout', '-q', '-b', 'person-branch')
  started = 0
  const answer = await heads({ threadIds: [own.id, folder.id, fresh.id, 'no-such-thread'], projectIds: [projectId, 'no-such-project'] })
  expect(started).toBe(0)
  expect(answer.projects[projectId]).toEqual({ repo: true, branch: 'person-branch' })
  expect(answer.projects['no-such-project']).toEqual({ error: 'Project not found' })
  expect(answer.threads[own.id]).toEqual({ own: true, branch: 'agent-branch', folder: workspace.worktreePath, generation: workspace.generation ?? 0, lifecycle: 'ready' })
  expect(answer.threads[folder.id]).toEqual({ project: true })
  expect(answer.threads[fresh.id]).toEqual({ project: true })
  expect(answer.threads['no-such-thread']).toEqual({ error: 'Thread not found' })

  // Not on disk (a storage rule retired it): the branch Mousse recorded, and no folder to work in.
  renameSync(workspace.worktreePath, `${workspace.worktreePath}-away`)
  expect((await heads({ threadIds: [own.id] })).threads[own.id]).toEqual({ own: true, branch: 'mousse/named-by-title', generation: workspace.generation ?? 0, lifecycle: 'ready' })
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
})
