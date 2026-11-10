import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { StoppedGitTree } from './stoppedGitTree'
export { gitStopProbe, StoppedGitTree } from './stoppedGitTree'

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

/** Processes a stopped command left, and the watch that settles once they are gone. */
export interface GitSurvivors {
  pids(): number[]
  gone: Promise<void>
}
interface GitCancellation {
  signal: AbortSignal
  /** One per stopped command whose processes were not all gone in time. */
  survivors: GitSurvivors[]
}
const cancellation = new AsyncLocalStorage<GitCancellation>()

/**
 * Work whose Git commands (run through {@link runGitProcess}) end with `signal`: a command not yet started then fails
 * at once, and one running is stopped with everything it started. A command that writes a ref is left to finish (it is
 * quick, and a stopped one would leave the ref's lock file behind).
 *
 * A stopped command's run ends once its processes are confirmed gone, or {@link GIT_STOP_TIMING}`.exitWaitMs` after the
 * stop when some are still there (one stuck in the file system can outlive a kill, and one that escaped the kill can
 * hold its output open), whether or not its output was closed. The work then ends, and
 * {@link GitCancellationScope.survivorsGone} settles once they are gone: the caller keeps the repository's lock until then.
 */
export interface GitCancellationScope {
  run<T>(work: () => Promise<T>): Promise<T>
  /** Settles once every process a stopped command left is gone; undefined when none was left. */
  survivorsGone(): Promise<void> | undefined
  /** The pids of what stopped commands left, while it is there. */
  survivorPids(): number[]
}

export function gitCancellationScope(signal: AbortSignal): GitCancellationScope {
  const scope: GitCancellation = { signal, survivors: [] }
  return {
    run: (work) => cancellation.run(scope, work),
    survivorsGone: () => scope.survivors.length ? Promise.all(scope.survivors.map((left) => left.gone)).then(() => undefined) : undefined,
    survivorPids: () => scope.survivors.flatMap((left) => left.pids())
  }
}

/** Whether the Git work running here was stopped (see {@link gitCancellationScope}). */
export function gitWorkCancelled(): boolean {
  return cancellation.getStore()?.signal.aborted === true
}

/** Git commands a cancellation leaves to finish: they write refs, whose lock files Git does not clear after a stop. */
const REF_WRITERS = new Set(['update-ref', 'symbolic-ref', 'pack-refs', 'branch', 'tag', 'commit'])

/**
 * After a stop: how long its processes are waited for before the run ends anyway (`exitWaitMs`, from the stop), how
 * often they are looked at meanwhile (`pollMs`) and after (`slowPollMs`, until they are gone, however long), and after
 * how long what is left is logged as an error (`survivorLimitMs`). Tests shorten them.
 */
export const GIT_STOP_TIMING = { exitWaitMs: 5_000, pollMs: 50, slowPollMs: 5_000, survivorLimitMs: 10 * 60_000 }

function sleep(ms: number): Promise<void> {
  return new Promise((done) => { setTimeout(done, ms).unref() })
}

/**
 * True once nothing of `tree` is left, false when something still is at `deadline`. On Windows a cheap look by pid comes
 * first and the list confirms; elsewhere the list is read each time (`ps` is quick, and tells zombies apart).
 */
async function goneBy(tree: StoppedGitTree, deadline: number): Promise<boolean> {
  for (;;) {
    const there = process.platform === 'win32' && tree.quickAlive() ? true : await tree.alive()
    if (!there) return true
    if (Date.now() >= deadline) return false
    await sleep(Math.min(GIT_STOP_TIMING.pollMs, Math.max(0, deadline - Date.now())))
  }
}

/**
 * Looks at what a stopped command left until none of it is there, however long that takes; past
 * {@link GIT_STOP_TIMING}`.survivorLimitMs` it says so in the log once, and keeps looking.
 */
async function watchSurvivors(tree: StoppedGitTree, describe: () => Record<string, unknown>): Promise<void> {
  const since = Date.now()
  let logged = false
  for (;;) {
    await sleep(GIT_STOP_TIMING.slowPollMs)
    if (!(await tree.alive())) return
    if (!logged && Date.now() - since >= GIT_STOP_TIMING.survivorLimitMs) {
      logged = true
      console.error('[git] a stopped Git command is still running; its repository stays locked until it ends or Mousse restarts', { pids: tree.pids(), ...describe() })
    }
  }
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
    // When the command was started: its creation time must match this, so a pid reused later is never taken for it.
    const spawnedAt = Date.now()
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
    // A command stopped part way may leave the lock of the private index it was writing. Only a lock that was not there
    // when it started, and was made since, is removed, and only once nothing of the command is left: under the
    // repository's lease nothing else writes that index meanwhile.
    const cleanLock = (): void => {
      if (!indexLock || lockedBefore) return
      try { if (statSync(indexLock).mtimeMs >= startedAt - 2_000) rmSync(indexLock, { force: true }) } catch { /* not there */ }
    }
    let settled = false
    let exitCode: number | null = null
    child.on('exit', (code) => { exitCode = code })
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // As `spawnSync`: the exit code even when the output was cut off; none for a process that was killed or never started.
      const started = !error || error.code === 'ENOBUFS' || error.code === 'ETIMEDOUT' || error.code === 'ABORT_ERR'
      const bytes = Buffer.concat(out)
      settle({ status: started ? code : null, stdout: bytes.toString('utf8'), stdoutBytes: bytes, stderr: Buffer.concat(err).toString('utf8'), ...(error ? { error } : {}) })
    }
    let stoppedByCancellation = false
    const onAbort = (): void => {
      if (settled || error || argv.some((arg) => REF_WRITERS.has(arg))) return
      error = Object.assign(new Error('spawnSync git ABORT_ERR'), { code: 'ABORT_ERR', syscall: 'spawnSync git' })
      stoppedByCancellation = true
      // From the stop, not from when the output closes: something that escaped the kill may hold it open for good. The
      // run ends at this deadline whatever the kill or a look at the process list is still doing.
      const deadline = Date.now() + GIT_STOP_TIMING.exitWaitMs
      // Kills once and notes what the command had; then only watches. Never rejects.
      const stopping = child.pid ? StoppedGitTree.stop(child, spawnedAt).then(async (tree) => ({ tree, gone: await goneBy(tree, deadline) })) : Promise.resolve(undefined)
      const atDeadline = sleep(GIT_STOP_TIMING.exitWaitMs).then(() => 'deadline' as const)
      void (async () => {
        const first = await Promise.race([stopping, atDeadline])
        if (first !== 'deadline' && (!first || first.gone)) cleanLock()
        else {
          // Something of it may still be there. The run ends now, so the work can end; the caller keeps the repository
          // locked until the watch sees it gone, and then the lock is cleaned up.
          let watched: StoppedGitTree | undefined
          scope?.survivors.push({
            pids: () => watched?.pids() ?? (child.pid ? [child.pid] : []),
            gone: (async () => {
              const settled = await stopping
              if (settled && !settled.gone) {
                watched = settled.tree
                await watchSurvivors(settled.tree, () => ({ command: argv.slice(0, 4).join(' '), cwd: options.cwd }))
              }
              cleanLock()
            })()
          })
        }
        // The output is not waited for: a process that escaped the kill may hold it open.
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy()
        child.unref()
        finish(exitCode)
      })()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout!.on('data', (chunk: Buffer) => { outSize += chunk.length; if (outSize > limit) stop('ENOBUFS'); else out.push(chunk) })
    child.stderr!.on('data', (chunk: Buffer) => { errSize += chunk.length; if (errSize > limit) stop('ENOBUFS'); else err.push(chunk) })
    child.on('error', (spawnError) => { error ??= spawnError })
    // A stopped command's run is ended by its stop (above), not by its output closing.
    child.on('close', (code) => { if (!stoppedByCancellation) finish(code) })
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
