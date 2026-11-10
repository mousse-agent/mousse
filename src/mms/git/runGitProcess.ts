import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createReadStream, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { killProcessTree } from '../execution/processTree'

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

const cancellation = new AsyncLocalStorage<AbortSignal>()

/**
 * Runs `work` with every Git command it starts (through {@link runGitProcess}) ended by `signal`: a command not yet
 * started then fails at once, and one running is stopped, and its run ends only once Git has exited. A command that
 * writes a ref is left to finish (it is quick, and a stopped one would leave the ref's lock file behind).
 */
export function withGitCancellation<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  return signal ? cancellation.run(signal, work) : work()
}

/** Whether the Git work running here was stopped (see {@link withGitCancellation}). */
export function gitWorkCancelled(): boolean {
  return cancellation.getStore()?.aborted === true
}

/** Git commands a cancellation leaves to finish: they write refs, whose lock files Git does not clear after a stop. */
const REF_WRITERS = new Set(['update-ref', 'symbolic-ref', 'pack-refs', 'branch', 'tag', 'commit', 'gc'])

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
  const signal = cancellation.getStore()
  return new Promise((settle) => {
    options.beforeStart?.()
    if (signal?.aborted) {
      settle({ status: null, stdout: '', stdoutBytes: Buffer.alloc(0), stderr: '', error: Object.assign(new Error('git was not started: the work was stopped'), { code: 'ABORT_ERR' }) })
      return
    }
    const child = spawn('git', argv, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: [options.input !== undefined || options.inputFile !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
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
    const onAbort = (): void => {
      if (argv.some((arg) => REF_WRITERS.has(arg))) return
      // The whole tree: on Windows a program Git started would otherwise keep running, and keep its output open.
      if (!error && child.pid) { error = Object.assign(new Error('spawnSync git ABORT_ERR'), { code: 'ABORT_ERR', syscall: 'spawnSync git' }); killProcessTree(child.pid) } else stop('ABORT_ERR')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout!.on('data', (chunk: Buffer) => { outSize += chunk.length; if (outSize > limit) stop('ENOBUFS'); else out.push(chunk) })
    child.stderr!.on('data', (chunk: Buffer) => { errSize += chunk.length; if (errSize > limit) stop('ENOBUFS'); else err.push(chunk) })
    child.on('error', (spawnError) => { error ??= spawnError })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // A command stopped part way may leave the lock of the private index it wrote; only it could hold that lock.
      const index = options.env.GIT_INDEX_FILE
      if (error?.code === 'ABORT_ERR' && index) try { rmSync(`${resolve(options.cwd, index)}.lock`, { force: true }) } catch { /* the next run of that index reports it */ }
      // As `spawnSync`: the exit code even when the output was cut off; none for a process that was killed or never started.
      const started = !error || error.code === 'ENOBUFS' || error.code === 'ETIMEDOUT' || error.code === 'ABORT_ERR'
      const bytes = Buffer.concat(out)
      settle({ status: started ? code : null, stdout: bytes.toString('utf8'), stdoutBytes: bytes, stderr: Buffer.concat(err).toString('utf8'), ...(error ? { error } : {}) })
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
