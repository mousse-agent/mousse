import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks'
import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createReadStream, statSync } from 'node:fs'
import { createRequire as createGitWorkerRequire } from 'node:module'
import { resolve, win32 } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { readProcessEntries } from './stoppedGitTree'
import { windowsGitRuntime } from './windowsGitProcess'

/**
 * Where Git processes are started: off the daemon's event loop.
 *
 * On Windows, `spawn()` creates the process synchronously on the calling thread, and on a loaded machine that takes
 * 100 ms to a second per Git process. A turn start runs dozens of Git commands and a cleanup pass hundreds, so every
 * stream, agent and request froze while they started. {@link spawnGit} hands the start to a long-lived helper process
 * (Mousse's own runtime as Node), which owns the process, its pipes and its kill; the caller gets an object that behaves
 * as the `ChildProcess` would
 * (the same events in the same order, its output as `Buffer` chunks, `kill`, `pid` once started, `ref`/`unref`).
 * Everything the command depends on (program, arguments, working folder, environment) is worked out by the caller, as
 * before, and passed across unchanged; so are the Git policy's checks, the cancellation scope and the turn-boundary
 * accounting, which stay with the caller. Events and callbacks run in the async scope of the command that requested
 * them, so concurrent operations keep their own context.
 *
 * A helper process, not a worker thread: on Windows a process started from one thread inherits the pipes another thread
 * is creating for its own child at that moment, and holds them open, so that child's end never arrives while it runs.
 * With Git started from a second thread, the daemon's other processes (providers, tools) and Git would hold each
 * other's pipes. A helper has its own handles, and starts its processes from its one thread, as the daemon does.
 *
 * Two lanes, each its own helper: `interactive` (the default) and `background`, for maintenance that runs on a timer
 * ({@link inBackgroundGitLane}). A cleanup pass that starts hundreds of processes then never queues ahead of a turn's
 * Git. Each helper starts on its lane's first Git command and stops after {@link GIT_SPAWN_WORKER_IDLE_MS} without any.
 *
 * Background Git is also held to one process per physical disk while interactive Git runs on that disk
 * ({@link DiskGate}): on a hard disk, maintenance reads would otherwise take the disk's time from the person's commands.
 * With no interactive Git on a disk, background Git there is not limited.
 *
 * `MOUSSE_GIT_SPAWN_WORKER=0` starts Git on the calling thread, as before.
 */

export type GitLane = 'interactive' | 'background'

const lanes = new AsyncLocalStorage<GitLane>()
const admittedDisk = new AsyncLocalStorage<string>()

/** Runs `work` with its Git processes started on the background lane: maintenance that no person is waiting for. */
export function inBackgroundGitLane<T>(work: () => T): T {
  return lanes.run('background', work)
}

/** How long a lane's helper stays up without any Git process before it stops. */
export const GIT_SPAWN_WORKER_IDLE_MS = 60_000

type Pipe = 'pipe' | 'ignore'

/** The `spawn` options Mousse's Git commands use; anything else is not passed across. */
export interface GitSpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdio?: [Pipe, Pipe, Pipe]
  windowsHide?: boolean
  detached?: boolean
  /** A final admission check that must run on the same thread, immediately before spawning Git. */
  beforeStart?: () => void
  /** As `spawn`'s: aborting it kills the process with `killSignal` and emits an `AbortError`. */
  signal?: AbortSignal
  killSignal?: NodeJS.Signals | number
  /** A file streamed to Git's input (which must be `pipe`) by whatever started Git; never read on the caller's thread. */
  inputFile?: string
  /** The file could not be read: Git's input is closed and the process killed. */
  onInputFileError?: (error: Error) => void
}

function workerEnabled(): boolean {
  return process.env.MOUSSE_GIT_SPAWN_WORKER !== '0'
}

/**
 * Starts `file` (the Git program, from `gitFile()`) with `args`, on the current lane's helper. Returns at once; the
 * process starts on the helper. Commands with a final `beforeStart` check run directly to keep that check adjacent
 * to process creation. On Windows Git never opens a console window unless `windowsHide: false` asks for one.
 */
export function spawnGit<I extends Pipe = 'pipe', O extends Pipe = 'pipe', E extends Pipe = 'pipe'>(file: string, args: readonly string[], given: GitSpawnOptions & { stdio?: [I, O, E] } = {}): GitChild<I, O, E> {
  const options = { ...given, windowsHide: given.windowsHide ?? true }
  if (draining) throw workerError('The daemon is shutting down')
  if (options.beforeStart || !workerEnabled()) return spawnHere(file, args, options) as GitChild<I, O, E>
  return lane(lanes.getStore() ?? 'interactive').start(file, args, options) as unknown as GitChild<I, O, E>
}

/** The process {@link spawnGit} started, typed as `spawn` types it for the same `stdio`. */
export type GitChild<I extends Pipe, O extends Pipe, E extends Pipe> = ChildProcessByStdio<I extends 'pipe' ? Writable : null, O extends 'pipe' ? Readable : null, E extends 'pipe' ? Readable : null>

/** On the calling thread, as before the worker: also the shape the worker itself uses. */
function spawnHere(file: string, args: readonly string[], options: GitSpawnOptions): ChildProcess {
  const { inputFile, onInputFileError, beforeStart, signal, killSignal, ...spawnOptions } = options
  let child: ChildProcess
  if (process.platform === 'win32') child = spawnWindowsHere(file, args, { ...spawnOptions, beforeStart }, signal, killSignal)
  else {
    beforeStart?.()
    child = spawn(file, [...args], { ...spawnOptions, detached: true, signal, killSignal })
    let ending: Promise<void> | undefined
    const stop = () => ending ??= reapPosixGroup(child.pid)
    trackDirect(child, stop)
    const emit = child.emit.bind(child)
    child.emit = (event: string | symbol, ...values: unknown[]) => {
      if (event !== 'close') return emit(event, ...values)
      void stop().then(() => emit(event, ...values))
      return true
    }
  }
  if (inputFile !== undefined && child.stdin) {
    const stdin = child.stdin
    stdin.on('error', () => undefined)
    const source = createReadStream(inputFile)
    source.on('error', (error) => { stdin.destroy(); child.kill(); onInputFileError?.(error) })
    child.once('close', () => source.destroy())
    source.pipe(stdin)
  }
  return child
}

/** Settles once the process `spawnGit` returned has started (or failed to); at once for one started on this thread. */
export function gitChildSpawned(child: ChildProcess): Promise<void> {
  return child instanceof WorkerGitChild ? child.spawned : Promise.resolve()
}

// `import.meta.url` is empty when this module is bundled as CommonJS (a test's child process); `__filename` is set there.
const requireHere = createGitWorkerRequire(typeof __filename === 'string' ? __filename : import.meta.url)
let windows: ReturnType<typeof windowsGitRuntime> | undefined
const windowsRuntime = () => windows ??= windowsGitRuntime(requireHere, requireHere.resolve('koffi'))
const windowsJobs = new Set<WindowsGitJob>()
const directChildren = new Map<Promise<void>, () => Promise<void>>()
const childJobs = new WeakMap<ChildProcess | WorkerGitChild, WindowsGitJob>()
let draining: Promise<void> | undefined

interface SyncGitOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  encoding: 'utf8'
  stdio?: [Pipe, Pipe, Pipe]
  input?: string
  timeout?: number
  maxBuffer?: number
  windowsHide?: boolean
}

/** The few synchronous Git checks use the same Windows job assignment and finish before returning. */
export function spawnGitSync(file: string, args: readonly string[], options: SyncGitOptions) {
  if (draining) return { status: null, stdout: '', stderr: '', error: workerError('The daemon is shutting down') }
  if (process.platform !== 'win32') return spawnSync(file, args, options)
  return windowsRuntime().spawnSync(file, args, { ...options, windowsHide: options.windowsHide ?? true })
}

export function execFileGitSync(file: string, args: readonly string[], options: SyncGitOptions): string {
  const result = spawnGitSync(file, args, options)
  if (!result.error && result.status === 0) return result.stdout
  throw Object.assign(result.error ?? new Error('Command failed: git ' + args.join(' ') + (result.stderr ? '\n' + result.stderr : '')), result)
}

function workerError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'EGITWORKER' })
}

function trackDirect(child: ChildProcess, stop: () => Promise<void>): void {
  const ended = new Promise<void>((done) => child.once('close', done))
  directChildren.set(ended, stop)
  void ended.then(() => directChildren.delete(ended))
}

/** Reap a detached POSIX group, including a hook that outlived the Git root. Zombies cannot touch the repository. */
async function reapPosixGroup(pgid: number | undefined): Promise<void> {
  if (pgid === undefined) return
  for (;;) {
    try { process.kill(-pgid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    }
    const entries = await readProcessEntries()
    if (entries && !entries.some((entry) => entry.pgid === pgid && !entry.zombie)) return
    await delay(10)
  }
}

/** The daemon keeps the handle across helper loss. Reap only after this job cannot admit another root. */
class WindowsGitJob {
  private readonly runtime = windowsRuntime()
  private readonly job = this.runtime.job()
  private ending?: Promise<void>
  private closed = false

  constructor() { windowsJobs.add(this) }
  get name(): string { return this.job.name }

  empty(): boolean {
    if (this.closed) return true
    try { return this.runtime.active(this.job.owned) === 0 } catch { return false }
  }

  finish(): Promise<void> {
    return this.ending ??= this.reap()
  }

  private async reap(): Promise<void> {
    let terminated = false
    for (;;) {
      try {
        if (this.runtime.active(this.job.owned) === 0) break
        if (!terminated) { this.runtime.terminate(this.job.owned); terminated = true }
      } catch { /* A failed query cannot let a mutation release the repository. Retry until the job is empty. */ }
      await delay(10)
    }
    this.closed = true
    this.runtime.close(this.job.owned)
    windowsJobs.delete(this)
  }
}

/** True when Git started and the job emptied, even if its exit notification is still in flight. */
export function windowsGitAlreadyExited(child: ChildProcess | WorkerGitChild): boolean {
  return child.pid !== undefined && childJobs.get(child)?.empty() === true
}

export function stopWindowsGit(child: ChildProcess): Promise<void> {
  return gitChildSpawned(child).then(() => childJobs.get(child)?.finish())
}

function spawnWindowsHere(file: string, args: readonly string[], options: GitSpawnOptions, signal?: AbortSignal, killSignal?: NodeJS.Signals | number): ChildProcess {
  const job = new WindowsGitJob()
  let child: ChildProcess
  let refused = false
  try {
    child = windowsRuntime().spawn(file, args, options, job.name, () => {
      try { options.beforeStart?.() } catch (error) { refused = true; throw error }
    })
  } catch (error) {
    if (refused) { void job.finish(); throw error }
    const failed = new EventEmitter()
    const streams = (options.stdio ?? ['pipe', 'pipe', 'pipe']).map((pipe) => pipe === 'pipe' ? new Readable({ read() {} }) : null)
    child = Object.assign(failed, {
      stdin: options.stdio?.[0] === 'ignore' ? null : new Writable({ write(_chunk, _encoding, done) { done() } }),
      stdout: streams[1], stderr: streams[2], kill: () => false, unref: () => undefined
    }) as unknown as ChildProcess
    void job.finish().then(() => { failed.emit('error', error); failed.emit('close', null, null) })
  }
  childJobs.set(child, job)
  let abortError: Error | undefined
  let closed = false
  trackDirect(child, () => job.finish())
  const emit = child.emit.bind(child)
  child.emit = (event: string | symbol, ...values: unknown[]) => {
    if (event !== 'close') return emit(event, ...values)
    void job.finish().then(() => {
      closed = true
      if (abortError) emit('error', abortError)
      emit(event, ...values)
    })
    return true
  }
  const killRoot = child.kill.bind(child)
  child.kill = (requested) => {
    if (closed || windowsGitAlreadyExited(child)) return false
    killRoot(requested)
    void job.finish()
    Object.assign(child, { killed: true })
    return true
  }
  const abort = (): void => {
    if (!child.kill(killSignal)) return
    abortError = Object.assign(new Error('The operation was aborted', { cause: signal?.reason }), { name: 'AbortError', code: 'ABORT_ERR' })
  }
  if (signal?.aborted) process.nextTick(abort)
  else if (signal) {
    signal.addEventListener('abort', abort, { once: true })
    child.once('close', () => signal.removeEventListener('abort', abort))
  }
  return child
}

/** Cancel before the request has been sent to the helper, without starting a Git process. */
export function cancelQueuedGit(child: ChildProcess): boolean {
  return child instanceof WorkerGitChild && !child.isLaunched && child.kill()
}

/** When the process was really started (epoch ms): on the worker, which may be later than the call; else `fallback`. */
export function gitChildStartedAt(child: ChildProcess, fallback: number): number {
  return child instanceof WorkerGitChild ? child.startedAt ?? fallback : fallback
}

// ---------------------------------------------------------------------------------------------------------------------
// The helper is plain CommonJS run with `-e`. The daemon owns the Windows jobs through helper shutdown or loss.

const HELPER_SOURCE = `
const { spawn } = require('node:child_process')
const { accessSync, constants, createReadStream, statSync } = require('node:fs')
const { constants: { errno } } = require('node:os')
const { resolve } = require('node:path')
const windows = process.platform === 'win32' ? (${windowsGitRuntime.toString()})(require, process.argv[1]) : undefined
const children = new Map()
const gates = new Map()
const executable = ({ file, args, options }) => {
  const paths = file.includes('/') ? [''] : (options.env.PATH ?? '/usr/bin:/bin').split(':')
  let code = 'ENOENT'
  for (const dir of paths) {
    const candidate = resolve(options.cwd, dir, file)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return
      code = 'EACCES'
    } catch (error) {
      if (error.code === 'EACCES') code = 'EACCES'
    }
  }
  const syscall = 'spawn ' + file
  throw Object.assign(new Error(syscall + ' ' + code), { code, errno: -errno[code], syscall, path: file, spawnargs: args })
}
const stopGroup = (pid) => { try { process.kill(-pid, 'SIGKILL') } catch {} }
const plain = (e) => ({ message: String(e && e.message || e), name: e && e.name, code: e && e.code, errno: e && e.errno, syscall: e && e.syscall, path: e && e.path, spawnargs: e && e.spawnargs })
const send = (message, done) => process.connected && process.send(message, done)
const pipe = (stream, fd, post) => {
  if (!stream) return
  stream.on('data', (data) => {
    const sent = post({ t: 'data', fd, data }, () => { if (!sent) stream.resume() })
    if (!sent) stream.pause()
  })
}
process.on('disconnect', () => {
  if (!windows) for (const child of children.values()) if (child.pid) stopGroup(child.pid)
  process.exit(0)
})
process.on('message', (m) => {
  if (m.t === 'disks') {
    require('node:child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Partition | Where-Object DriveLetter | ForEach-Object { "{0}={1}" -f $_.DriveLetter, $_.DiskNumber }'], { windowsHide: true, timeout: 30000 }, (error, stdout) => send({ id: 0, t: 'disks', text: error ? '' : String(stdout) }))
    return
  }
  if (m.t === 'spawn') {
    const post = (message, done) => send(Object.assign({ id: m.id }, message), done)
    const at = Date.now()
    let child
    try {
      if (windows) child = windows.spawn(m.file, m.args, m.options, m.job)
      else {
        // Git cannot run until the daemon knows its group. If the helper dies before that, fd 3 closes and the shell
        // exits without executing Git. exec keeps Git in the group it already leads.
        executable(m)
        child = spawn('/bin/sh', ['-c', 'IFS= read -r start <&3 && exec 3<&- && exec "$@"', 'git-start', m.file, ...m.args], {
          ...m.options, detached: true, stdio: [...m.options.stdio, 'pipe']
        })
      }
    } catch (error) { post({ t: 'throw', error: plain(error) }); return }
    children.set(m.id, child)
    child.once('spawn', () => {
      if (windows) post({ t: 'spawn', pid: child.pid, at })
      else {
        const gate = child.stdio[3]
        gate.on('error', () => {})
        gates.set(m.id, () => {
          post({ t: 'spawn', pid: child.pid, at: Date.now() })
          gate.end('start\\n')
        })
        post({ t: 'group', pid: child.pid })
      }
    })
    child.on('error', (error) => post({ t: 'error', error: plain(error) }))
    child.on('exit', (code, signal) => post({ t: 'exit', code, signal }))
    let source
    child.on('close', (code, signal) => {
      children.delete(m.id)
      gates.delete(m.id)
      const closed = () => post({ t: 'close', code, signal })
      if (!source || source.closed) closed()
      else { source.once('close', closed); source.destroy() }
    })
    pipe(child.stdout, 1, post)
    pipe(child.stderr, 2, post)
    if (child.stdin) {
      child.stdin.on('error', (error) => post({ t: 'stdinError', error: plain(error) }))
      if (m.inputFile !== undefined) {
        source = createReadStream(m.inputFile)
        source.on('error', (error) => { child.stdin.destroy(); child.kill(); post({ t: 'inputFileError', error: plain(error) }) })
        source.pipe(child.stdin)
      }
    }
    return
  }
  const child = children.get(m.id)
  if (!child) return
  if (m.t === 'admit') { gates.get(m.id)?.(); gates.delete(m.id) }
  else if (m.t === 'write') child.stdin && child.stdin.write(Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength))
  else if (m.t === 'end') child.stdin && child.stdin.end()
  else if (m.t === 'destroyStdin') child.stdin && child.stdin.destroy()
  else if (m.t === 'kill') { try { child.kill(m.signal) } catch {} }
})
`

interface PlainError { message: string; name?: string; code?: string | number; errno?: number; syscall?: string; path?: string; spawnargs?: string[] }

type FromWorker =
  | { id: number; t: 'group'; pid: number }
  | { id: number; t: 'spawn'; pid: number; at: number }
  | { id: number; t: 'data'; fd: 1 | 2; data: Uint8Array }
  | { id: number; t: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { id: number; t: 'close'; code: number | null; signal: NodeJS.Signals | null }
  | { id: number; t: 'error' | 'throw' | 'stdinError' | 'inputFileError'; error: PlainError }

function revive(plain: PlainError): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException & { spawnargs?: string[] } = new Error(plain.message)
  if (plain.name && plain.name !== 'Error') error.name = plain.name
  if (plain.code !== undefined) error.code = String(plain.code)
  if (plain.errno !== undefined) error.errno = plain.errno
  if (plain.syscall !== undefined) error.syscall = plain.syscall
  if (plain.path !== undefined) error.path = plain.path
  if (plain.spawnargs !== undefined) error.spawnargs = plain.spawnargs
  return error
}

/** Ids are unique across lanes and workers, so one never names another lane's process. */
let nextChildId = 1

class Lane {
  private worker: ChildProcess | undefined
  private readonly workers = new Map<ChildProcess, Promise<void>>()
  private readonly children = new Map<number, WorkerGitChild>()
  private closing = false

  private idle: NodeJS.Timeout | undefined
  private refs = 0

  constructor(private readonly name: GitLane) {}

  start(file: string, args: readonly string[], options: GitSpawnOptions): WorkerGitChild {
    const id = nextChildId++
    const pipes = options.stdio ?? ['pipe', 'pipe', 'pipe']
    const child = new WorkerGitChild(this, id, file, args, pipes as [Pipe, Pipe, Pipe], options)
    this.children.set(id, child)
    this.hold(1)
    clearTimeout(this.idle)
    const message = {
      t: 'spawn', id, file, args: [...args],
      ...(options.inputFile !== undefined ? { inputFile: options.inputFile } : {}),
      options: {
        // A worker's own environment is a copy taken when it started: the caller's is always passed.
        env: { ...(options.env ?? process.env) },
        stdio: pipes,
        cwd: options.cwd ?? process.cwd(),
        ...(options.windowsHide !== undefined ? { windowsHide: options.windowsHide } : {}),
        ...(options.detached !== undefined ? { detached: options.detached } : {})
      }
    }
    const launch = (): void => {
      if (this.closing) return
      try {
        const job = process.platform === 'win32' ? new WindowsGitJob() : undefined
        if (job) childJobs.set(child, job)
        const worker = this.ensure()
        this.post(worker, { ...message, job: job?.name })
        child.launched(worker)
      } catch (error) {
        // The disk slot was consumed even though the command could not be sent.
        child.isLaunched = true
        process.nextTick(() => { void child.lost(workerError(String(error))) })
      }
    }
    const disk = diskOf(options.cwd)
    if (this.name === 'interactive') {
      diskGate.interactiveStarted(disk)
      child.onDone(() => diskGate.interactiveEnded(disk))
      launch()
    } else if (admittedDisk.getStore() === disk) {
      launch()
    } else {
      const cancel = diskGate.background(disk, launch)
      child.queued(cancel)
      child.onDone(() => { if (child.isLaunched) diskGate.backgroundEnded(disk); else cancel() })
    }
    return child
  }

  post(worker: ChildProcess, message: Record<string, unknown>): void {
    if (worker.connected) worker.send(message, (error) => { if (error) worker.kill() })
  }

  /** A child that keeps the daemon alive started (+1) or no longer does (-1): the worker is referenced while any does. */
  hold(delta: number): void {
    this.refs += delta
    const helper = this.worker
    if (!helper) return
    // The channel keeps the daemon alive, not the helper's process handle alone.
    const channel = (helper as ChildProcess & { channel?: { ref(): void; unref(): void } }).channel
    if (this.refs > 0) { helper.ref(); channel?.ref() }
    else { helper.unref(); channel?.unref() }
  }

  settled(child: WorkerGitChild): void {
    this.children.delete(child.id)
    if (this.closing || this.children.size) return
    clearTimeout(this.idle)
    const worker = this.worker
    this.idle = setTimeout(() => {
      if (this.worker !== worker || this.children.size) return
      this.worker = undefined
      if (worker?.connected) worker.disconnect()
    }, GIT_SPAWN_WORKER_IDLE_MS)
    this.idle.unref()
  }

  /** Stops admission, all helpers (including idle ones still exiting), and their Git process trees. */
  async terminate(): Promise<void> {
    this.closing = true
    const closed = [...this.children.values()].map((child) => new Promise<void>((done) => child.once('close', done)))
    for (const child of this.children.values()) if (!child.isLaunched) child.kill()
    clearTimeout(this.idle)
    const workers = [...this.workers]
    for (const [worker] of workers) { worker.ref(); worker.kill() }
    await Promise.all([...workers.map(([, exited]) => exited), ...closed])
  }

  private ensure(): ChildProcess {
    if (this.worker) return this.worker
    const args = ['-e', HELPER_SOURCE, ...(process.platform === 'win32' ? [requireHere.resolve('koffi')] : [])]
    const worker = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      windowsHide: true
    })
    worker.unref()
    ;(worker as ChildProcess & { channel?: { unref(): void } }).channel?.unref()
    worker.on('message', (message: FromWorker | { id: 0; t: 'disks'; text: string }) => {
      if (message.t === 'disks') learnDisks(message.text)
      else this.children.get(message.id)?.receive(message)
    })
    // Which disk each drive is on matters only once background Git has to share a disk: asked by that lane's helper.
    if (this.name === 'background' && process.platform === 'win32' && !diskMapAsked) {
      diskMapAsked = true
      this.post(worker, { t: 'disks' })
    }
    const lost = async (reason: string): Promise<void> => {
      if (this.worker === worker) {
        this.worker = undefined
        if (!physicalDisks.size) diskMapAsked = false
      }
      const error = workerError(`The Git helper stopped (${reason})`)
      await Promise.all([...this.children.values()].filter((child) => child.worker === worker).map((child) => child.lost(error)))
      this.workers.delete(worker)
    }
    this.workers.set(worker, new Promise<void>((done) => {
      let reason = 'closed'
      let ended = false
      const end = () => {
        if (ended) return
        ended = true
        void lost(reason).then(done)
      }
      worker.on('error', (error) => { reason = error.message })
      worker.once('exit', (code, signal) => { reason = `exit ${code ?? signal}`; end() })
      worker.once('close', end) // Also fires if the helper itself failed to spawn.
    }))
    this.worker = worker
    this.hold(0)
    return worker
  }
}

const laneWorkers: Record<GitLane, Lane> = { interactive: new Lane('interactive'), background: new Lane('background') }
function lane(name: GitLane): Lane {
  return laneWorkers[name]
}

/** Permanently stop admission and wait for both lanes and direct Git commands during daemon teardown. */
export function drainGitSpawnWorkers(): Promise<void> {
  return draining ??= Promise.resolve().then(async () => {
    const direct = [...directChildren]
    await Promise.all([
      laneWorkers.background.terminate(), laneWorkers.interactive.terminate(),
      ...direct.map(async ([closed, stop]) => { await stop(); await closed })
    ])
    await Promise.all([...windowsJobs].map((job) => job.finish()))
  })
}

/** A new foreground daemon can start after the previous daemon has fully drained. */
export async function resumeGitSpawnWorkers(): Promise<void> {
  if (!draining) return
  const previous = draining
  await previous
  if (previous !== draining) return
  laneWorkers.background = new Lane('background')
  laneWorkers.interactive = new Lane('interactive')
  draining = undefined
}

/** Reset the lanes for tests. */
export async function stopGitSpawnWorkers(): Promise<void> {
  const { background, interactive } = laneWorkers
  laneWorkers.background = new Lane('background')
  laneWorkers.interactive = new Lane('interactive')
  await Promise.all([background.terminate(), interactive.terminate()])
}

// ---------------------------------------------------------------------------------------------------------------------
// Background Git per physical disk.

/** Drive letter → physical disk number, read once by the background lane's helper (`Get-Partition`); until then each volume counts alone. */
const physicalDisks = new Map<string, string>()
let diskMapAsked = false
function learnDisks(text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const [letter, disk] = line.trim().split('=')
    if (letter && /^[a-z]$/i.test(letter) && disk && /^\d+$/.test(disk)) physicalDisks.set(letter.toUpperCase(), disk)
  }
}

function physicalDisk(key: string): string {
  const disk = key.startsWith('volume:') ? physicalDisks.get(key.slice('volume:'.length)) : undefined
  return disk === undefined ? key : `disk:${disk}`
}

/** Off Windows: a folder's device, by `stat`, once per folder. */
const devices = new Map<string, string>()

/** Stable key for the volume a command reads, even while its physical disk is being discovered. */
export function diskOf(cwd: string | undefined): string {
  const where = resolve(cwd ?? process.cwd())
  if (process.platform === 'win32') {
    const root = win32.parse(where).root
    const letter = /^([a-z]):/i.exec(root)?.[1]?.toUpperCase()
    if (!letter) return `share:${root.toLowerCase()}`
    return `volume:${letter}`
  }
  let device = devices.get(where)
  if (device === undefined) {
    try { device = String(statSync(where).dev) } catch { device = 'unknown' }
    if (devices.size >= 4096) devices.clear()
    devices.set(where, device)
  }
  return `device:${device}`
}

/**
 * While interactive Git runs on a disk, background Git there is held to one process at a time; the others wait, in
 * order, and start as soon as the disk allows. With no interactive Git on the disk, background Git is not limited.
 */
export class DiskGate {
  private readonly interactive = new Map<string, number>()
  private readonly running = new Map<string, number>()
  private readonly waiting: { disk: string; go: () => void }[] = []

  constructor(private readonly diskFor = (key: string): string => key) {}

  interactiveStarted(disk: string): void { this.add(this.interactive, disk, 1) }
  interactiveEnded(disk: string): void { this.add(this.interactive, disk, -1); this.pump() }
  backgroundEnded(disk: string): void { this.add(this.running, disk, -1); this.pump() }

  /** Runs `go` now or once the disk allows; the function returned takes a waiting one out (true when it was waiting). */
  background(disk: string, go: () => void): () => boolean {
    const entry = { disk, go }
    this.waiting.push(entry)
    this.pump()
    return () => {
      const at = this.waiting.indexOf(entry)
      if (at < 0) return false
      this.waiting.splice(at, 1)
      return true
    }
  }

  /** Background processes running on `disk`, how many wait, and the interactive ones running there. */
  load(disk: string): { running: number; waiting: number; interactive: number } {
    const key = this.diskFor(disk)
    return { running: this.count(this.running, key), waiting: this.waiting.filter((entry) => this.diskFor(entry.disk) === key).length, interactive: this.count(this.interactive, key) }
  }

  private allows(disk: string): boolean {
    const key = this.diskFor(disk)
    return !this.count(this.interactive, key) || !this.count(this.running, key)
  }

  private pump(): void {
    for (let at = 0; at < this.waiting.length;) {
      const entry = this.waiting[at]!
      if (!this.allows(entry.disk)) { at += 1; continue }
      this.waiting.splice(at, 1)
      this.add(this.running, entry.disk, 1)
      entry.go()
    }
  }

  private count(counts: Map<string, number>, disk: string): number {
    let total = 0
    for (const [key, count] of counts) if (this.diskFor(key) === disk) total += count
    return total
  }

  private add(counts: Map<string, number>, disk: string, delta: number): void {
    const next = (counts.get(disk) ?? 0) + delta
    if (next > 0) counts.set(disk, next)
    else counts.delete(disk)
  }
}

export const diskGate = new DiskGate(physicalDisk)

/** Admit the check and its command together. Git probes in the check use the same slot. */
export async function withGitDiskAdmission<T>(cwd: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (lanes.getStore() !== 'background' || !workerEnabled()) return work()
  const disk = diskOf(cwd)
  if (admittedDisk.getStore() === disk) return work()
  await new Promise<void>((done, reject) => {
    let admitted = false
    function abort(): void { if (cancel()) reject(signal?.reason) }
    const cancel = diskGate.background(disk, () => {
      admitted = true
      signal?.removeEventListener('abort', abort)
      done()
    })
    if (!admitted) {
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    }
  })
  try {
    signal?.throwIfAborted()
    if (draining) throw workerError('The daemon is shutting down')
    return await admittedDisk.run(disk, work)
  } finally {
    diskGate.backgroundEnded(disk)
  }
}

/** What `spawnGit` returns when the worker starts the process: a `ChildProcess` as its callers use one. */
class WorkerGitChild extends EventEmitter {
  pid: number | undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  /** When the worker started the process (epoch ms). */
  startedAt: number | undefined
  readonly spawnfile: string
  readonly spawnargs: string[]
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly stdio: [Writable | null, Readable | null, Readable | null]
  readonly spawned: Promise<void>
  private readonly asyncScope = new AsyncResource('GitSpawn')
  private markSpawned!: () => void
  private referenced = true
  private done = false
  private exited = false
  /** The worker was asked to start it; until then what is sent to it waits here. */
  isLaunched = false
  worker: ChildProcess | undefined
  private finishing = false
  private posixGroup?: number
  private readonly unsent: Record<string, unknown>[] = []
  private cancelWaiting: (() => boolean) | undefined
  private readonly doneHooks: (() => void)[] = []
  private abortError?: Error

  constructor(private readonly owner: Lane, readonly id: number, file: string, args: readonly string[], pipes: [Pipe, Pipe, Pipe], options: GitSpawnOptions) {
    super()
    this.spawnfile = file
    this.spawnargs = [file, ...args]
    this.spawned = new Promise((settle) => { this.markSpawned = settle })
    this.stdin = pipes[0] === 'pipe' ? this.input() : null
    this.stdout = pipes[1] === 'pipe' ? new Readable({ read() { /* pushed as it arrives */ } }) : null
    this.stderr = pipes[2] === 'pipe' ? new Readable({ read() { /* pushed as it arrives */ } }) : null
    this.stdio = [this.stdin, this.stdout, this.stderr]
    this.inputFileError = options.onInputFileError
    const signal = options.signal
    if (signal) {
      // As `spawn` does with its `signal`.
      const onAbort = (): void => {
        if (!this.kill(options.killSignal)) return
        const error = Object.assign(new Error('The operation was aborted', { cause: signal.reason }), { name: 'AbortError', code: 'ABORT_ERR' })
        if (childJobs.has(this)) this.abortError = error
        else this.emit('error', error)
      }
      if (signal.aborted) process.nextTick(onAbort)
      else {
        signal.addEventListener('abort', onAbort, { once: true })
        this.once('close', () => signal.removeEventListener('abort', onAbort))
      }
    }
  }

  private readonly inputFileError: ((error: Error) => void) | undefined

  private input(): Writable {
    const send = (t: string, extra: Record<string, unknown> = {}): void => this.toWorker({ t, id: this.id, ...extra })
    let ended = false
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        send('write', { data: chunk })
        callback()
      },
      final(callback) {
        ended = true
        send('end')
        callback()
      },
      // Called after a normal end too (auto-destroy): only an input cut short closes Git's input at once, since a
      // destroy right after the end would drop what the worker has not written to Git yet.
      destroy(error, callback) {
        if (!ended) send('destroyStdin')
        callback(error)
      }
    })
  }

  /** The worker was asked to start it: what waited for that goes now. */
  launched(worker: ChildProcess): void {
    this.worker = worker
    this.isLaunched = true
    this.cancelWaiting = undefined
    for (const message of this.unsent.splice(0)) this.owner.post(worker, message)
  }

  /** It waits for its disk (background Git); `cancel` takes it out of the wait. */
  queued(cancel: () => boolean): void {
    if (!this.isLaunched) this.cancelWaiting = cancel
  }

  onDone(hook: () => void): void {
    this.doneHooks.push(hook)
  }

  private toWorker(message: Record<string, unknown>): void {
    if (this.done) return
    if (this.worker) this.owner.post(this.worker, message)
    else this.unsent.push(message)
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.done || this.finishing || windowsGitAlreadyExited(this) || (!childJobs.has(this) && (this.exitCode !== null || this.signalCode !== null))) return false
    this.killed = true
    if (!this.isLaunched && this.cancelWaiting?.()) {
      // Killed while waiting for its disk: it never starts, and ends as a process killed at once would.
      const name = (typeof signal === 'string' ? signal : 'SIGTERM') as NodeJS.Signals
      this.signalCode = name
      process.nextTick(() => {
        this.markSpawned()
        this.exited = true
        this.emit('exit', null, name)
        this.close(null, name)
      })
      return true
    }
    this.toWorker({ t: 'kill', id: this.id, signal: signal ?? 'SIGTERM' })
    if (childJobs.has(this)) void this.spawned.then(() => childJobs.get(this)!.finish())
    return true
  }

  ref(): void {
    if (this.referenced || this.done) return
    this.referenced = true
    this.owner.hold(1)
  }

  unref(): void {
    if (!this.referenced || this.done) return
    this.referenced = false
    this.owner.hold(-1)
  }

  receive(message: FromWorker): void {
    this.asyncScope.runInAsyncScope(() => this.handleMessage(message))
  }

  private handleMessage(message: FromWorker): void {
    switch (message.t) {
      case 'group':
        this.posixGroup = message.pid
        this.toWorker({ t: 'admit', id: this.id })
        return
      case 'spawn':
        this.pid = message.pid
        this.startedAt = message.at
        this.markSpawned()
        this.emit('spawn')
        return
      case 'data':
        (message.fd === 1 ? this.stdout : this.stderr)?.push(Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength))
        return
      case 'exit':
        this.exited = true
        if (message.signal) this.signalCode = message.signal
        else this.exitCode = message.code
        this.emit('exit', this.exitCode, this.signalCode)
        return
      case 'stdinError':
        this.stdin?.destroy(revive(message.error))
        return
      case 'inputFileError':
        if (childJobs.has(this)) this.kill()
        this.inputFileError?.(revive(message.error))
        return
      case 'error':
        this.markSpawned()
        this.emit('error', revive(message.error))
        return
      case 'throw':
        void this.lost(revive(message.error))
        return
      case 'close':
        if (!this.exited && this.exitCode === null && this.signalCode === null) {
          if (message.signal) this.signalCode = message.signal
          else this.exitCode = message.code
        }
        void this.finish(message.code, message.signal)
    }
  }

  /** The worker stopped with this process running: an error, then the end, so whoever waits for it is answered. */
  lost(error: Error): Promise<void> {
    return this.finish(null, null, error)
  }

  private async finish(code: number | null, signal: NodeJS.Signals | null, error?: Error): Promise<void> {
    if (this.done || this.finishing) return
    this.finishing = true
    const job = childJobs.get(this)
    if (job) await job.finish()
    else await reapPosixGroup(this.posixGroup)
    this.asyncScope.runInAsyncScope(() => {
      const failure = error ?? this.abortError
      if (failure) this.emit('error', failure)
      this.close(code, signal)
    })
  }

  private close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.done) return
    this.done = true
    this.markSpawned()
    if (this.referenced) this.owner.hold(-1)
    this.owner.settled(this)
    for (const hook of this.doneHooks.splice(0)) hook()
    if (this.stdin && !this.stdin.destroyed) this.stdin.destroy()
    // As `ChildProcess`: its 'close' comes after its output streams ended, for a stream someone reads.
    const reading = [this.stdout, this.stderr].filter((stream): stream is Readable => stream !== null && !stream.destroyed && stream.readableFlowing === true && !stream.readableEnded)
    this.stdout?.push(null)
    this.stderr?.push(null)
    let left = reading.length
    const emitClose = (): void => {
      this.asyncScope.runInAsyncScope(() => this.emit('close', code, signal))
      this.asyncScope.emitDestroy()
    }
    if (!left) { process.nextTick(emitClose); return }
    const ended = (): void => { if (--left === 0) emitClose() }
    for (const stream of reading) {
      let counted = false
      const once = (): void => { if (!counted) { counted = true; ended() } }
      stream.once('end', once)
      stream.once('close', once)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// `execFile` on top of `spawnGit`, with its callback, error and limits.

export interface ExecGitOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  encoding?: BufferEncoding | 'buffer' | null
  timeout?: number
  maxBuffer?: number
  killSignal?: NodeJS.Signals | number
  windowsHide?: boolean
  signal?: AbortSignal
}

export type ExecGitError = NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; cmd?: string; code?: string | number }
type ExecGitCallback<T> = (error: ExecGitError | null, stdout: T, stderr: T) => void

/**
 * `execFile(file, args, options, callback)` for Git, started by {@link spawnGit}: the same callback, the same error
 * (`Command failed: …` with the exit `code`, `killed` and `signal`; the spawn error itself when Git could not start;
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` past `maxBuffer`), the same output limit (1 MiB unless given), time limit and
 * `signal`. The time limit counts from when Git started.
 */
export function execFileGit(file: string, args: readonly string[], options: ExecGitOptions & { encoding: 'buffer' | null }, callback: ExecGitCallback<Buffer>): ChildProcess
export function execFileGit(file: string, args: readonly string[], options: ExecGitOptions, callback: ExecGitCallback<string>): ChildProcess
export function execFileGit(file: string, args: readonly string[], options: ExecGitOptions, callback: ExecGitCallback<string> | ExecGitCallback<Buffer>): ChildProcess {
  const maxBuffer = options.maxBuffer ?? 1024 * 1024
  const killSignal = options.killSignal ?? 'SIGTERM'
  const encoding = options.encoding === 'buffer' || options.encoding === null ? undefined : options.encoding ?? 'utf8'
  const child = spawnGit(file, args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.windowsHide !== undefined ? { windowsHide: options.windowsHide } : {}),
    ...(options.signal ? { signal: options.signal, killSignal } : {}),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  // As `execFile`: Git's input is a pipe that is never written to.
  child.stdin?.on('error', () => undefined)
  const out: (Buffer | string)[] = []
  const err: (Buffer | string)[] = []
  let outSize = 0
  let errSize = 0
  let killed = false
  let failure: ExecGitError | undefined
  let finished = false
  let timer: NodeJS.Timeout | undefined
  const text = (chunks: (Buffer | string)[]): string | Buffer => encoding ? chunks.join('') : Buffer.concat(chunks as Buffer[])
  const kill = (): void => {
    child.stdout?.destroy()
    child.stderr?.destroy()
    killed = true
    try { child.kill(killSignal) } catch (error) { failure ??= error as ExecGitError; exit(null, null) }
  }
  const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    const stdout = text(out)
    const stderr = text(err)
    const done = callback as (error: ExecGitError | null, stdout: string | Buffer, stderr: string | Buffer) => void
    if (!failure && code === 0 && signal === null && !(process.platform === 'win32' && killed)) { done(null, stdout, stderr); return }
    const cmd = [file, ...args].join(' ')
    const error: ExecGitError = failure ?? Object.assign(new Error(`Command failed: ${cmd}\n${String(stderr)}`), {
      code: (code !== null && code < 0 ? undefined : code) as unknown as string, killed: child.killed || killed, signal
    })
    error.cmd = cmd
    done(error, stdout, stderr)
  }
  if (options.timeout && options.timeout > 0) {
    void gitChildSpawned(child).then(() => { if (!finished) timer = setTimeout(() => { kill(); timer = undefined }, options.timeout) })
  }
  const collect = (chunks: (Buffer | string)[], name: 'stdout' | 'stderr') => (chunk: Buffer | string): void => {
    const length = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.length
    const size = name === 'stdout' ? (outSize += length) : (errSize += length)
    if (size > maxBuffer) {
      const room = maxBuffer - (size - length)
      // Node counts encoded bytes and then slices decoded chunks by character index.
      chunks.push(typeof chunk === 'string' ? chunk.slice(0, room) : chunk.subarray(0, room))
      failure ??= Object.assign(new RangeError(`${name} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) as ExecGitError
      kill()
    } else chunks.push(chunk)
  }
  if (encoding) {
    child.stdout?.setEncoding(encoding)
    child.stderr?.setEncoding(encoding)
  }
  child.stdout?.on('data', collect(out, 'stdout'))
  child.stderr?.on('data', collect(err, 'stderr'))
  child.on('error', (error: ExecGitError) => {
    failure = error
    child.stdout?.destroy()
    child.stderr?.destroy()
  })
  child.on('close', exit)
  return child
}

/** {@link execFileGit} as a promise, as `promisify(execFile)` gives: `{ stdout, stderr }`, or the error carrying both. */
export function execFileGitAsync(file: string, args: readonly string[], options: ExecGitOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((settle, reject) => {
    execFileGit(file, args, { ...options, encoding: options.encoding === 'buffer' || options.encoding === null ? 'utf8' : options.encoding ?? 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else settle({ stdout, stderr })
    })
  })
}
