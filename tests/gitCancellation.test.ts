/**
 * `gitCancellationScope`: the Git commands a piece of work runs end with its signal (a stopped turn's checkpoint). A
 * stopped command's run ends once Git and what it started are gone; when something of it outlives the kill, the run
 * ends anyway and the repository's lease is kept until it is gone, or for good.
 */
import { execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GIT_STOP_TIMING, gitCancellationScope, gitStopProbe, gitWorkCancelled, runGitProcess, StoppedGitTree } from '../src/mms/git/runGitProcess'
import type { ProcessEntry } from '../src/mms/git/stoppedGitTree'
import { withGitMutationLocks } from '../src/mms/actions/GitOperationCoordinator'
import { acquireRepositoryLease, RepositoryLeaseBusyError } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'

const dirs: string[] = []
const timing = { ...GIT_STOP_TIMING }
afterEach(() => {
  Object.assign(GIT_STOP_TIMING, timing)
  delete gitStopProbe.alive
  delete gitStopProbe.table
  delete gitStopProbe.kill
  vi.restoreAllMocks()
  // A repository kept locked keeps its lock file open, and a stopped command may still be ending in its folder (on
  // Windows the folder cannot be removed then); it stays.
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
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
    await expect(survivors).resolves.toBeUndefined()
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

  it("keeps watching a stopped command's process past the limit, says so, and lets the repository go once it ends", async () => {
    const cwd = repo()
    const threadDirectory = mkdtempSync(join(tmpdir(), 'mousse-git-cancel-thread-')); dirs.push(threadDirectory)
    const identity = resolveRepositoryIdentity(cwd)
    Object.assign(GIT_STOP_TIMING, { exitWaitMs: 100, slowPollMs: 50, survivorLimitMs: 300 })
    let lingering = true
    gitStopProbe.alive = () => lingering
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)
    const ran = await withGitMutationLocks(threadDirectory, cwd, 'test', () => runGitProcess(SLOW, { cwd, env: process.env }), undefined, undefined, controller.signal)
    expect(ran.error?.code).toBe('ABORT_ERR')
    // The watch starts once the stop's look at the process list is done, which can take a while on a busy machine.
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.stringContaining('until it ends or Mousse restarts'), expect.anything()), { timeout: 10_000 })
    // Past the limit it is still held, and still watched.
    await expect(acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 300 })).rejects.toBeInstanceOf(RepositoryLeaseBusyError)
    lingering = false
    const lease = await acquireRepositoryLease(identity, { retryDelayMs: 5, maxWaitMs: 5_000 })
    expect(lease.release()).toBe(true)
  }, 30_000)

  it('ends a stopped run on time while something that escaped the kill holds its output open', async () => {
    const cwd = repo()
    GIT_STOP_TIMING.exitWaitMs = 1_000
    const controller = new AbortController()
    const scope = gitCancellationScope(controller.signal)
    // A subshell that ends at once leaves a `sleep` behind with the command's output; then the command waits.
    const running = scope.run(() => runGitProcess(['-c', 'alias.orphan=!f() { (sleep 8 &) ; sleep 30; }; f', 'orphan'], { cwd, env: process.env }))
    await new Promise((resolve) => setTimeout(resolve, 800))
    const begun = Date.now()
    controller.abort()
    expect((await running).error?.code).toBe('ABORT_ERR')
    expect(Date.now() - begun).toBeLessThan(6_000)
  }, 40_000)
})

describe('StoppedGitTree', () => {
  /** Answers each look with the next list in turn, and records what was killed. */
  const script = (...tables: Array<ProcessEntry[] | undefined>): number[] => {
    const killed: number[] = []
    gitStopProbe.table = async () => tables.length > 1 ? tables.shift() : tables[0]
    gitStopProbe.kill = (pid) => { killed.push(pid) }
    return killed
  }
  /** The command as Mousse holds it: still running. */
  const command = (pid: number): ChildProcess => ({ pid, exitCode: null, signalCode: null, kill: () => true }) as unknown as ChildProcess
  /** When Mousse started the command, and a process created `offsetMs` from then. */
  const spawnedAt = Date.parse('2026-11-10T12:00:00.000Z')
  const at = (pid: number, ppid: number, offsetMs: number, extra: Partial<ProcessEntry> = {}): ProcessEntry => ({ pid, ppid, pgid: 100, started: `t${spawnedAt + offsetMs}`, startedMs: spawnedAt + offsetMs, ...extra })

  it('kills once, at the stop, and only watches after: what is started later is neither watched nor killed', async () => {
    const killed = script(
      [at(100, 1, 5), at(101, 100, 40)],
      [at(101, 100, 40), at(102, 101, 900)],
      [at(102, 101, 900)]
    )
    const tree = await StoppedGitTree.stop(command(100), spawnedAt)
    expect(killed).toEqual([100])
    expect(await tree.alive()).toBe(true)
    expect(tree.pids().sort()).toEqual([100, 101])
    expect(await tree.alive()).toBe(false)
    expect(killed).toEqual([100])
  })

  it('kills nothing when the command already ended', async () => {
    const killed = script([])
    await StoppedGitTree.stop({ pid: 100, exitCode: 0, signalCode: null, kill: () => true } as unknown as ChildProcess, spawnedAt)
    expect(killed).toEqual([])
  })

  it("never takes a pid another program got for the command's", async () => {
    script(
      [at(100, 1, 5), at(101, 100, 40)],
      [at(100, 7, 3_600_000), at(101, 7, 3_600_001), at(103, 101, 3_600_002)]
    )
    const tree = await StoppedGitTree.stop(command(100), spawnedAt)
    expect(await tree.alive()).toBe(false)
  })

  it('never takes a later process for the command when the list at the stop could not be read', async () => {
    // The list at the stop fails; by the next one the command ended and another program got its pid, and started a child.
    script(undefined, undefined, [at(100, 7, 3_600_000, { pgid: 100 }), at(104, 100, 3_600_001, { pgid: 100 })])
    const tree = await StoppedGitTree.stop(command(100), spawnedAt)
    expect(await tree.alive()).toBe(true)
    expect(await tree.alive()).toBe(false)
    expect(tree.pids()).toEqual([])
  })

  it('never takes in a process created before the command whose old parent had the command\'s pid', async () => {
    // Windows keeps a child's parent pid after the parent ends: this program's parent, long gone, had the pid git has now.
    script(
      [at(100, 1, 5), at(200, 100, -3_600_000, { pgid: 200 })],
      [at(200, 100, -3_600_000, { pgid: 200 })]
    )
    const tree = await StoppedGitTree.stop(command(100), spawnedAt)
    expect(tree.pids()).toEqual([100])
    expect(await tree.alive()).toBe(false)
  })

  it('neither tracks nor (on Windows) kills a pid whose creation time is present and not the command\'s', async () => {
    const killed = script([at(100, 7, 3_600_000), at(101, 100, 3_600_001)])
    const tree = await StoppedGitTree.stop(command(100), spawnedAt)
    // Off Windows the command's own group is killed before the list is read (its id goes to no other group while it lives).
    expect(killed).toEqual(process.platform === 'win32' ? [] : [100])
    expect(tree.pids()).toEqual([])
    expect(await tree.alive()).toBe(false)
  })

  it('kills the command and keeps watching it by pid when its creation time cannot be read', async () => {
    // No creation time for the command (Windows without CreationDate; a `ps` whose lstart does not parse), and a member
    // of its group: neither can be disproved, so both keep the lock until they are gone.
    const unread = { started: 'Mo 10 Nov 12:00:00 2026' }
    const killed = script(
      [{ pid: 100, ppid: 1, pgid: 100, ...unread }, { pid: 101, ppid: 100, pgid: 100, started: 'later' }],
      [{ pid: 101, ppid: 100, pgid: 100, started: 'later' }],
      []
    )
    const tree = await StoppedGitTree.stop(command(100), spawnedAt)
    expect(killed).toEqual([100])
    expect(tree.pids().sort()).toEqual([100, 101])
    expect(await tree.alive()).toBe(true)
    expect(await tree.alive()).toBe(false)
  })

  it('kills the command when the list at the stop cannot be read, as its handle shows it running', async () => {
    const killed = script(undefined, [])
    await StoppedGitTree.stop(command(100), spawnedAt)
    expect(killed).toEqual([100])
  })

  it('counts a zombie as exited', async () => {
    script([at(100, 1, 5)], [at(100, 1, 5, { zombie: true })])
    const tree = await StoppedGitTree.stop(command(100), spawnedAt)
    expect(await tree.alive()).toBe(false)
  })

  it('counts the command as still there while its processes cannot be listed', async () => {
    script(undefined, undefined, [])
    const tree = await StoppedGitTree.stop(command(100), spawnedAt)
    expect(await tree.alive()).toBe(true)
    // The first list read stands for the one at the stop: nothing of the command is in it.
    expect(await tree.alive()).toBe(false)
  })

  it('ends the stopped run at its deadline while the process list and the kill hang', async () => {
    const cwd = repo()
    GIT_STOP_TIMING.exitWaitMs = 1_000
    gitStopProbe.table = () => new Promise(() => undefined)
    // A kill that does nothing, as a hung taskkill would: the command keeps running.
    gitStopProbe.kill = () => undefined
    const controller = new AbortController()
    const scope = gitCancellationScope(controller.signal)
    const running = scope.run(() => runGitProcess(['-c', 'alias.slow=!sleep 8', 'slow'], { cwd, env: process.env }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const begun = Date.now()
    controller.abort()
    expect((await running).error?.code).toBe('ABORT_ERR')
    expect(Date.now() - begun).toBeLessThan(2_500)
    // Not known to be gone: the repository stays locked for it.
    expect(scope.survivorsGone()).toBeDefined()
  }, 30_000)
})
