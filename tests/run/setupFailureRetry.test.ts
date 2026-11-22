/**
 * A message whose thread's worktree cannot be made never leaves a blank thread: the thread keeps why (its chat and
 * sidebar show it) and the message, Retry sends that message again on the same thread exactly once, and the agent
 * never runs in the project's own folder instead. Once the worktree is made, the failure goes.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRepositoryIdentity } from '../../src/mms/git/RepositoryIdentity'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { defaultThreadWorktreePath } from '../../src/mms/worktree/worktreeLayout'
import { setupFailureReason } from '../../src/shared/setupFailure'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const folder = (path: string): string => {
  let real = resolve(path)
  try { real = realpathSync.native(path) } catch { /* gone */ }
  return process.platform === 'win32' ? real.toLowerCase() : real
}

describe("a thread whose worktree can't be made", () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    home = undefined
  })

  it('shows why, keeps the message, and Retry sends it once on the same thread, in its worktree', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-setup-failure-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = join(home, 'project'); mkdirSync(projectDir)
    git(projectDir, 'init', '-q'); git(projectDir, 'config', 'user.name', 'Test'); git(projectDir, 'config', 'user.email', 'test@example.test')
    writeFileSync(join(projectDir, 'README'), 'base\n'); git(projectDir, 'add', '.'); git(projectDir, 'commit', '-qm', 'base')
    const pi = piAdapter((input) => `reply to ${input.prompt.split('\n').at(-1)}`)
    const d = (daemon = phase6Daemon(home, [pi]))
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('New Chat', project.id)
    const originalTitle = d.settings.title
    d.settings.title = { ...originalTitle, ...PI }
    const late = Promise.withResolvers<{ text: string }>()
    const oneShot = vi.fn(() => late.promise)
    const titles = d.orch as unknown as { harness: { oneShot: unknown }; titleWork: Map<string, Promise<void>> }
    titles.harness.oneShot = oneShot
    const threadDir = d.store.getThreadDir(thread.id)
    d.orch.setThreadModelOverride(thread.id, PI)

    // Something already at the worktree's place, so `git worktree add` refuses it.
    const place = defaultThreadWorktreePath(home, resolveRepositoryIdentity(projectDir).key, thread.id, 'main')
    mkdirSync(join(place, '..'), { recursive: true })
    writeFileSync(place, 'in the way\n')

    await d.orch.send({ content: 'First', mode: 'agent' }, false, { threadId: thread.id, clientRequestId: 'first' }).catch(() => undefined)
    await waitFor(() => Boolean(d.store.getThread(thread.id)?.setupFailure), 'the failure is recorded', 20_000)
    const failure = d.store.getThread(thread.id)!.setupFailure!
    expect(failure.retryable).toBe(true)
    expect(failure.reason).toMatch(/^Couldn't/)
    expect(failure.detail).toMatch(/already exists/)
    expect(existsSync(join(threadDir, 'setup-retry.json'))).toBe(true)
    // The failed add was for that very place, and no agent ran anywhere, the project's own folder included.
    expect(folder(new ThreadWorkspaceManager(threadDir).load()!.worktreePath)).toBe(folder(place))
    expect(pi.turns).toHaveLength(0)

    const pendingTitle = titles.titleWork.get(thread.id)
    late.resolve({ text: 'Title: Stale failure title\nBranch: stale-failure' })
    await pendingTitle
    expect(d.orch.getMessages(thread.id)).toEqual([])
    expect(oneShot).toHaveBeenCalledOnce()
    expect(d.store.getThread(thread.id)?.name).toBe('New Chat')
    expect(git(projectDir, 'branch', '--list', 'mousse/stale-failure')).toBe('')

    // Retry, once the obstacle is gone: the same message, on the same thread, in a worktree of its own.
    d.settings.title = originalTitle
    rmSync(place, { force: true })
    const retried = await d.orch.retrySetup(thread.id)
    expect(retried.queued).toBeFalsy()
    await waitFor(() => d.engine.getRun(retried.runId!)?.status === 'completed', 'the retried run ends', 45_000)
    expect(pi.turns).toHaveLength(1)
    expect(pi.turns[0]!.prompt).toMatch(/First$/)
    expect(d.orch.getMessages(thread.id).filter((message) => message.role === 'user' && message.content === 'First')).toHaveLength(1)
    const worktree = new ThreadWorkspaceManager(threadDir).load()!
    expect(worktree.lifecycle).toBe('ready')
    expect(folder(pi.turns[0]!.cwd!)).toBe(folder(worktree.worktreePath))
    expect(folder(pi.turns[0]!.cwd!)).not.toBe(folder(projectDir))
    expect(d.store.getThread(thread.id)?.setupFailure).toBeUndefined()
    expect(existsSync(join(threadDir, 'setup-retry.json'))).toBe(false)

    // A second Retry finds nothing to send.
    await expect(d.orch.retrySetup(thread.id)).rejects.toMatchObject({ code: 'nothing_to_retry' })
    expect(pi.turns).toHaveLength(1)
  }, 90_000)
})

describe('setupFailureReason', () => {
  it('says a too-long path in plain words', () => {
    expect(setupFailureReason("fatal: could not create leading directories of 'C:/x': Filename too long")).toMatch(/path is too long/)
    expect(setupFailureReason('ENAMETOOLONG: name too long, mkdir')).toMatch(/path is too long/)
  })
  it('names a branch that blocks the thread’s branch', () => {
    expect(setupFailureReason("fatal: cannot lock ref 'refs/heads/mousse/fix-it': 'refs/heads/mousse' exists; cannot create 'refs/heads/mousse/fix-it'"))
      .toBe(`Couldn't create this thread's branch: the branch "mousse" is in the way.`)
  })
  it('falls back to a plain line for anything else', () => {
    expect(setupFailureReason('something odd')).toBe("Couldn't set up this thread's worktree.")
  })
})
