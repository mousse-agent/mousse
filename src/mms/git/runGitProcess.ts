import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { listProcesses, type ListedProcess } from '../harness/stopProcesses'

/** What a Git process left: as `spawnSync` reports it. */
export interface GitProcess {
  status: number | null
  stdout: string
  stderr: string
  error?: NodeJS.ErrnoException
  /** `stdout` as the bytes Git wrote, for output that is not text (`cat-file --batch`). */
  stdoutBytes: Buffer
}

/** The output limit `spawnSync` and `execFileSync` use when none is given. */
const DEFAULT_MAX_BUFFER = 1024 * 1024

interface GitCancellation {
  signal: AbortSignal
  /** One watch per stopped command whose processes were not all gone in time: true once they are, false at the limit. */
  survivors: Array<Promise<boolean>>
}
const cancellation = new AsyncLocalStorage<GitCancellation>()

/**
 * Work whose Git commands (run through {@link runGitProcess}) end with `signal`: a command not yet started then fails
 * at once, and one running is stopped with everything it started. A command that writes a ref is left to finish (it is
 * quick, and a stopped one would leave the ref's lock file behind).
 *
 * A stopped command's run ends once its processes are confirmed gone, or after {@link GIT_STOP_TIMING}`.exitWaitMs`
 * when some are still there (one stuck in the file system can outlive a kill for a while). Then the run ends anyway,
 * so the work can end, and {@link GitCancellationScope.survivorsGone} says when they are gone: the caller keeps the
 * repository's lock until then.
 */
export interface GitCancellationScope {
  run<T>(work: () => Promise<T>): Promise<T>
  /** Settles once every process a stopped command left is gone (true), or at the limit (false); undefined when none was left. */
  survivorsGone(): Promise<boolean> | undefined
}

export function gitCancellationScope(signal: AbortSignal): GitCancellationScope {
  const scope: GitCancellation = { signal, survivors: [] }
  return {
    run: (work) => cancellation.run(scope, work),
    survivorsGone: () => scope.survivors.length ? Promise.all(scope.survivors).then((gone) => gone.every(Boolean)) : undefined
  }
}

/** Whether the Git work running here was stopped (see {@link gitCancellationScope}). */
export function gitWorkCancelled(): boolean {
  return cancellation.getStore()?.signal.aborted === true
}

/** Git commands a cancellation leaves to finish: they write refs, whose lock files Git does not clear after a stop. */
const REF_WRITERS = new Set(['update-ref', 'symbolic-ref', 'pack-refs', 'branch', 'tag', 'commit'])

/**
 * How long a stopped command's processes are waited for before its run ends anyway (`exitWaitMs`), how long they are
 * then watched before the repository is given up as locked until Mousse restarts (`survivorLimitMs`), and how often
 * they are looked at. Tests shorten them.
 */
export const GIT_STOP_TIMING = { exitWaitMs: 5_000, survivorLimitMs: 10 * 60_000, pollMs: 50 }

/** A stopped command's processes: off Windows its process group (it leads it); on Windows it and what it started. */
export interface StoppedGitTree {
  pid: number
  /** Windows: the processes below it when it was stopped. */
  members: number[]
}

/** Stands in for the look at a stopped command's processes (tests: one that does not exit yet). */
export const gitStopProbe: { alive?: (tree: StoppedGitTree) => boolean } = {}

function below(listed: ListedProcess[], root: number): number[] {
  const found: number[] = []
  const queue = [root]
  while (queue.length) {
    const parent = queue.shift()!
    for (const entry of listed) {
      if (entry.ppid === parent && entry.pid !== parent && !found.includes(entry.pid)) { found.push(entry.pid); queue.push(entry.pid) }
    }
  }
  return found
}

/**
 * Kills a stopped command and everything it started: off Windows its process group; on Windows the processes below it
 * are listed first (what is left of them is looked at by pid later, since Windows keeps no group), then `taskkill /T`
 * runs and is waited for.
 */
async function killCommandTree(pid: number): Promise<StoppedGitTree> {
  if (process.platform === 'win32') {
    const listed = await listProcesses('win32')
    const members = listed ? below(listed, pid) : []
    await new Promise<void>((done) => {
      const kill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      kill.on('error', () => done())
      kill.on('exit', () => done())
    })
    return { pid, members }
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  return { pid, members: [] }
}

function treeAlive(tree: StoppedGitTree): boolean {
  if (gitStopProbe.alive) return gitStopProbe.alive(tree)
  const there = (target: number): boolean => { try { process.kill(target, 0); return true } catch { return false } }
  return process.platform === 'win32' ? [tree.pid, ...tree.members].some(there) : there(-tree.pid)
}

/** True once nothing of `tree` is left, false when something still is after `ms`. */
function waitGone(tree: StoppedGitTree, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  return new Promise((done) => {
    const look = (): void => {
      if (!treeAlive(tree)) done(true)
      else if (Date.now() >= until) done(false)
      else setTimeout(look, GIT_STOP_TIMING.pollMs)
    }
    look()
  })
}

/**
 * The output limit for a read whose output grows with the repository: its index, a tree, its refs, changed or untracked
 * paths. A big repository lists far more than 1 MiB of them, and output past a limit fails the read; it is never cut off.
 */
export const LISTING_MAX_BUFFER = 256 * 1024 * 1024

/**
 * Runs `git argv` without blocking and reports it as `spawnSync` would: output past `maxBuffer` (on either stream)
 * or a run past `timeout` stops Git and is an `ENOBUFS` or `ETIMEDOUT` error, with the output read so far.
 * `inputFile` streams a file to Git's input instead of `input` (a pack for `index-pack --stdin`), however large.
 * `beforeStart` runs synchronously right before Git starts, with nothing awaited in between; what it throws rejects the
 * run, and Git never starts.
 */
export function runGitProcess(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; inputFile?: string; maxBuffer?: number; timeout?: number; beforeStart?: () => void }): Promise<GitProcess> {
  const limit = options.maxBuffer ?? DEFAULT_MAX_BUFFER
  const scope = cancellation.getStore()
  const signal = scope?.signal
  return new Promise((settle) => {
    options.beforeStart?.()
    if (signal?.aborted) {
      settle({ status: null, stdout: '', stdoutBytes: Buffer.alloc(0), stderr: '', error: Object.assign(new Error('git was not started: the work was stopped'), { code: 'ABORT_ERR' }) })
      return
    }
    // A command that may be stopped leads a process group of its own off Windows, so stopping it reaches what it started.
    const ownGroup = signal !== undefined && process.platform !== 'win32'
    // The lock of the private index the command works on, and whether it was already there before the command started:
    // only a lock that was not, and was made since, can be the stopped command's.
    const startedAt = Date.now()
    const indexLock = signal && options.env.GIT_INDEX_FILE ? `${resolve(options.cwd, options.env.GIT_INDEX_FILE)}.lock` : undefined
    const lockedBefore = indexLock !== undefined && existsSync(indexLock)
    const child = spawn('git', argv, { cwd: options.cwd, env: options.env, windowsHide: true, detached: ownGroup, stdio: [options.input !== undefined || options.inputFile !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outSize = 0
    let errSize = 0
    let error: NodeJS.ErrnoException | undefined
    const stop = (code: 'ENOBUFS' | 'ETIMEDOUT' | 'ABORT_ERR'): void => {
      if (error) return
      error = Object.assign(new Error(`spawnSync git ${code}`), { code, syscall: 'spawnSync git' })
      child.kill()
    }
    const timer = options.timeout ? setTimeout(() => stop('ETIMEDOUT'), options.timeout) : undefined
    let stopped: Promise<StoppedGitTree> | undefined
    const onAbort = (): void => {
      if (error || argv.some((arg) => REF_WRITERS.has(arg))) return
      error = Object.assign(new Error('spawnSync git ABORT_ERR'), { code: 'ABORT_ERR', syscall: 'spawnSync git' })
      // The whole tree: a program Git started would otherwise keep running, and keep its output open.
      if (child.pid) stopped = killCommandTree(child.pid)
      else child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout!.on('data', (chunk: Buffer) => { outSize += chunk.length; if (outSize > limit) stop('ENOBUFS'); else out.push(chunk) })
    child.stderr!.on('data', (chunk: Buffer) => { errSize += chunk.length; if (errSize > limit) stop('ENOBUFS'); else err.push(chunk) })
    child.on('error', (spawnError) => { error ??= spawnError })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // A command stopped part way may leave the lock of the private index it was writing. Only a lock that was not there
      // when it started, and was made since, is removed, and only once nothing of the command is left: under the
      // repository's lease nothing else writes that index meanwhile.
      const cleanLock = (): void => {
        if (!indexLock || lockedBefore) return
        try { if (statSync(indexLock).mtimeMs >= startedAt - 2_000) rmSync(indexLock, { force: true }) } catch { /* not there */ }
      }
      void (async () => {
        const tree = stopped ? await stopped : undefined
        if (tree) {
          if (await waitGone(tree, GIT_STOP_TIMING.exitWaitMs)) cleanLock()
          else {
            // Something of it is still there. The run ends now, so the work can end; the caller keeps the repository
            // locked until this watch sees it gone (and then its lock is cleaned up), or for good at the limit.
            scope?.survivors.push(waitGone(tree, GIT_STOP_TIMING.survivorLimitMs).then((gone) => {
              if (gone) cleanLock()
              else console.error('[git] a stopped Git command left processes that did not exit; its repository stays locked until Mousse restarts', { pid: tree.pid, members: tree.members, command: argv.slice(0, 4).join(' '), cwd: options.cwd })
              return gone
            }))
          }
        }
        // As `spawnSync`: the exit code even when the output was cut off; none for a process that was killed or never started.
        const started = !error || error.code === 'ENOBUFS' || error.code === 'ETIMEDOUT' || error.code === 'ABORT_ERR'
        const bytes = Buffer.concat(out)
        settle({ status: started ? code : null, stdout: bytes.toString('utf8'), stdoutBytes: bytes, stderr: Buffer.concat(err).toString('utf8'), ...(error ? { error } : {}) })
      })()
    })
    if (options.input !== undefined) {
      // Git may stop reading early (a refusal); what it did not read is dropped, as with `spawnSync`.
      child.stdin!.on('error', () => undefined)
      child.stdin!.end(options.input)
    } else if (options.inputFile !== undefined) {
      child.stdin!.on('error', () => undefined)
      const file = createReadStream(options.inputFile)
      file.on('error', (readError) => { error ??= readError; child.stdin!.destroy(); child.kill() })
      file.pipe(child.stdin!)
    }
  })
}

/**
 * The error `execFileSync` throws for a Git run that failed: the message names the command and Git's own output, and it
 * carries `status`, `stdout` and `stderr` (and the cause when Git was stopped or never started).
 */
export function gitRunError(argv: readonly string[], ran: GitProcess): Error & { status: number | null; stdout: string; stderr: string } {
  return Object.assign(new Error(`Command failed: git ${argv.join(' ')}${ran.stderr ? `\n${ran.stderr}` : ''}`, ran.error ? { cause: ran.error } : undefined), { status: ran.status, stdout: ran.stdout, stderr: ran.stderr, ...(ran.error?.code ? { code: ran.error.code } : {}) })
}
