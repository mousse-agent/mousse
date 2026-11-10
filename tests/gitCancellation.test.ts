/**
 * `gitCancellationScope`: the Git commands a piece of work runs end with its signal (a stopped turn's checkpoint). A
 * stopped command's run ends once Git and what it started are gone; when something of it outlives the kill, the run
 * ends anyway and the repository's lease is kept until it is gone, or for good.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GIT_STOP_TIMING, gitCancellationScope, gitStopProbe, gitWorkCancelled, runGitProcess } from '../src/mms/git/runGitProcess'
import { withGitMutationLocks } from '../src/mms/actions/GitOperationCoordinator'
import { acquireRepositoryLease, RepositoryLeaseBusyError } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'

const dirs: string[] = []
const timing = { ...GIT_STOP_TIMING }
afterEach(() => {
  Object.assign(GIT_STOP_TIMING, timing)
  delete gitStopProbe.alive
  vi.restoreAllMocks()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-git-cancel-')); dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README'), 'x'); git('add', '.'); git('commit', '-qm', 'init')
  return dir
}

/** A Git command that runs for 30 seconds through a program Git starts (an alias), as a stuck command would. */
const SLOW = ['-c', 'alias.slow=!sleep 30', 'slow']

describe('gitCancellationScope', () => {
  it('starts no Git once the work was stopped', async () => {
    const cwd = repo()
    const controller = new AbortController(); controller.abort()
    const ran = await gitCancellationScope(controller.signal).run(async () => {
      expect(gitWorkCancelled()).toBe(true)
      return await runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env })
    })
    expect(ran.error?.code).toBe('ABORT_ERR')
    expect(ran.status).toBeNull()
    // Outside the work nothing is cancelled.
    expect(gitWorkCancelled()).toBe(false)
    expect((await runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env })).status).toBe(0)
  })

  it('stops a running command and what it started, and ends its run only once they exited', async () => {
    const cwd = repo()
    const index = join(cwd, 'private-index')
    const controller = new AbortController()
    const begun = Date.now()
    const running = gitCancellationScope(controller.signal).run(() => runGitProcess(SLOW, { cwd, env: { ...process.env, GIT_INDEX_FILE: index } }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    // As a command writing that private index would have left it when stopped.
    writeFileSync(`${index}.lock`, '')
    controller.abort()
    const ran = await running
    expect(ran.error?.code).toBe('ABORT_ERR')
    expect(Date.now() - begun).toBeLessThan(15_000)
    expect(existsSync(`${index}.lock`)).toBe(false)
  }, 30_000)

  it('leaves a lock of the private index that was there before the stopped command started', async () => {
    const cwd = repo()
    const index = join(cwd, 'private-index')
    writeFileSync(`${index}.lock`, '')
    const controller = new AbortController()
    const running = gitCancellationScope(controller.signal).run(() => runGitProcess(SLOW, { cwd, env: { ...process.env, GIT_INDEX_FILE: index } }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    controller.abort()
    expect((await running).error?.code).toBe('ABORT_ERR')
    expect(existsSync(`${index}.lock`)).toBe(true)
  }, 30_000)

  it('lets a command that writes a ref finish', async () => {
    const cwd = repo()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    const controller = new AbortController()
    const running = gitCancellationScope(controller.signal).run(() => runGitProcess(['update-ref', 'refs/mousse/test/kept', head], { cwd, env: process.env }))
    controller.abort()
    const ran = await running
    expect(ran.error).toBeUndefined()
    expect(ran.status).toBe(0)
    expect(execFileSync('git', ['rev-parse', 'refs/mousse/test/kept'], { cwd, encoding: 'utf8' }).trim()).toBe(head)
  })

  it("ends a stopped command's run when something of it outlives the kill, and cleans its lock only once that is gone", async () => {
    const cwd = repo()
    const index = join(cwd, 'private-index')
    GIT_STOP_TIMING.exitWaitMs = 200
    // Stands in for a process stuck in the file system: still there for a while after the kill.
    let lingering = true
    gitStopProbe.alive = () => lingering
    const controller = new AbortController()
    const scope = gitCancellationScope(controller.signal)
    const running = scope.run(() => runGitProcess(SLOW, { cwd, env: { ...process.env, GIT_INDEX_FILE: index } }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    writeFileSync(`${index}.lock`, '')
    controller.abort()
    expect((await running).error?.code).toBe('ABORT_ERR')
    // The run ended; the lock stays while the process is still there.
    const survivors = scope.survivorsGone()
    expect(survivors).toBeDefined()
    expect(existsSync(`${index}.lock`)).toBe(true)
    lingering = false
    await expect(survivors).resolves.toBe(true)
    expect(existsSync(`${index}.lock`)).toBe(false)
  }, 30_000)

  it("keeps the repository locked while a stopped command's process is still there, and lets go once it is gone", async () => {
    const cwd = repo()
    const threadDirectory = mkdtempSync(join(tmpdir(), 'mousse-git-cancel-thread-')); dirs.push(threadDirectory)
    const identity = resolveRepositoryIdentity(cwd)
    GIT_STOP_TIMING.exitWaitMs = 200
    let lingering = true
    gitStopProbe.alive = () => lingering
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)
    const ran = await withGitMutationLocks(threadDirectory, cwd, 'test', () => runGitProcess(SLOW, { cwd, env: process.env }), undefined, undefined, controller.signal)
    // The operation ended, so a stopped turn ends; the repository stays locked.
    expect(ran.error?.code).toBe('ABORT_ERR')
    await expect(acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 300 })).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
    lingering = false
    const lease = await acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 5_000 })
    expect(lease.release()).toBe(true)
  }, 30_000)

  it("keeps the repository locked for good, and says so, when a stopped command's process never goes", async () => {
    const cwd = repo()
    const threadDirectory = mkdtempSync(join(tmpdir(), 'mousse-git-cancel-thread-')); dirs.push(threadDirectory)
    const identity = resolveRepositoryIdentity(cwd)
    Object.assign(GIT_STOP_TIMING, { exitWaitMs: 100, survivorLimitMs: 300 })
    gitStopProbe.alive = () => true
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)
    const ran = await withGitMutationLocks(threadDirectory, cwd, 'test', () => runGitProcess(SLOW, { cwd, env: process.env }), undefined, undefined, controller.signal)
    expect(ran.error?.code).toBe('ABORT_ERR')
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('stays locked until Mousse restarts'), expect.anything())
    // Past the limit it is not released early: the next caller still waits.
    await expect(acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 300 })).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
  }, 30_000)
})
