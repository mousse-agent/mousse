import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beginFixturePhase, fixturePhase } from './phaseTiming'

/**
 * Launch the bundled CLI as a real daemon process and run CLI commands against it.
 * Readiness means the daemon's own runtime and owner records name the child's pid,
 * the same evidence the production CLI uses before it talks to a daemon.
 */

export interface OwnerRecord {
  pid: number
  token: string
  endpoint: string
  [key: string]: unknown
}

export interface DaemonOptions {
  /** Bundled CLI entry, normally `productBuild().entry`. */
  entry: string
  /** The Mousse home the daemon owns; also exported as `MOUSSE_HOME`. */
  home: string
  /** Exported as `MOUSSE_REPO_ROOT` when given. */
  repoRoot?: string
  /** Extra environment on top of the inherited one. */
  env?: NodeJS.ProcessEnv
  /** Node flags placed before the entry, such as `--import` for a crash preload. */
  nodeArgs?: string[]
  /** CLI arguments after `--home <home>`; defaults to `service run`. */
  args?: string[]
  /** Readiness evidence: the owner record implies the runtime record and is the default. */
  readiness?: 'owner' | 'runtime'
  /** Milliseconds to wait for readiness. */
  timeout?: number
  /** Bytes of combined stdout and stderr to keep for failure messages. */
  logBytes?: number
  /** Appears in failure messages. */
  label?: string
  cwd?: string
  /** Registers ownership immediately after spawn, before the first readiness wait. */
  onStart?: (daemon: Daemon) => void
}

export interface Daemon {
  readonly child: ChildProcess
  readonly pid: number
  readonly home: string
  /** Tail of the daemon's combined stdout and stderr. */
  readonly output: string
  /** The owner record observed at readiness, when readiness waited for it. */
  readonly owner: OwnerRecord | null
  /** Resolves once the process has exited for any reason. */
  readonly exited: Promise<void>
  /** Whether the process has already exited. */
  readonly done: boolean
  /** Send a signal (SIGKILL by default) and wait for the exit. */
  kill(signal?: NodeJS.Signals): Promise<void>
  /** Ask for a graceful exit, escalate to SIGKILL after the grace period, and wait. */
  stop(graceMs?: number): Promise<void>
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

export async function until<T>(
  probe: () => Promise<T> | T,
  ready: (value: T) => boolean,
  timeout = 20_000,
  message = 'Timed out waiting for the daemon fixture'
): Promise<T> {
  const deadline = Date.now() + timeout
  do {
    const value = await probe()
    if (ready(value)) return value
    await sleep(40)
  } while (Date.now() < deadline)
  throw new Error(message)
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const finished = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { entry, home, label = 'Daemon', logBytes = 8000, timeout = 40_000, readiness = 'owner' } = options
  const finishReadiness = beginFixturePhase('daemon', 'spawn-to-readiness')
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), entry, '--home', home, ...(options.args ?? ['service', 'run'])], {
    cwd: options.cwd ?? process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MOUSSE_HOME: home,
      ...(options.repoRoot ? { MOUSSE_REPO_ROOT: options.repoRoot } : {}),
      NO_COLOR: '1',
      ...options.env
    }
  })
  let output = ''
  const collect = (bytes: Buffer) => {
    output = (output + String(bytes)).slice(-logBytes)
  }
  child.stdout!.on('data', collect)
  child.stderr!.on('data', collect)
  const exited = new Promise<void>((done) => {
    child.once('exit', () => done())
    child.once('error', () => done())
  })
  let owner: OwnerRecord | null = null
  const kill = async (signal: NodeJS.Signals = 'SIGKILL') => {
    if (finished(child)) return
    child.kill(signal)
    await fixturePhase('daemon', 'kill', () => exited)
  }
  const daemon: Daemon = {
    child,
    pid: child.pid!,
    home,
    get output() {
      return output
    },
    get owner() {
      return owner
    },
    exited,
    get done() {
      return finished(child)
    },
    kill,
    async stop(graceMs = 5_000) {
      if (finished(child)) return
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
      try {
        await fixturePhase('daemon', 'stop', () => exited)
      } finally {
        clearTimeout(timer)
      }
    }
  }
  try {
    options.onStart?.(daemon)
    await until(
      () => {
        if (finished(child)) throw new Error(`${label} exited before readiness: ${output}`)
        const runtime = readJson(join(home, 'mms.runtime.json'))
        if (runtime?.pid !== child.pid) return false
        if (readiness === 'runtime') return true
        const record = readJson(join(home, 'mms.owner.json'))
        if (record?.pid !== child.pid) return false
        owner = record
        return true
      },
      Boolean,
      timeout,
      `${label} readiness timed out: ${output}`
    )
    return daemon
  } catch (error) {
    await daemon.kill()
    throw error
  } finally {
    finishReadiness()
  }
}

export interface CliOptions {
  entry: string
  /** Prepends `--home <home>` and exports `MOUSSE_HOME`. */
  home?: string
  args: string[]
  /** Written to stdin, which is then closed. Without it stdin is closed immediately. */
  input?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Milliseconds before the process is killed and the call rejects. */
  timeout?: number
  /** Bytes of stdout plus stderr after which the process is killed and the call rejects. */
  maxOutput?: number
  label?: string
  /** Node flags placed before the entry. */
  nodeArgs?: string[]
}

export interface CliResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** Run one CLI command to completion; resolves for any exit code, rejects on timeout or spawn failure. */
export function runCli(options: CliOptions): Promise<CliResult> {
  const { entry, home, label = 'CLI', timeout = 20_000, maxOutput = 4 * 1024 * 1024 } = options
  const finish = beginFixturePhase('daemon', 'cli')
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [...(options.nodeArgs ?? []), entry, ...(home ? ['--home', home] : []), ...options.args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(home ? { MOUSSE_HOME: home } : {}), NO_COLOR: '1', ...options.env }
    })
    let stdout = ''
    let stderr = ''
    let failure: Error | undefined
    const fail = (error: Error) => {
      failure = error
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => fail(new Error(`${label} timed out: ${options.args.join(' ')}\n${stderr.slice(-4000)}`)), timeout)
    const receive = (chunk: Buffer, error: boolean) => {
      if (error) stderr += chunk.toString()
      else stdout += chunk.toString()
      if (stdout.length + stderr.length > maxOutput) fail(new Error(`${label} exceeded the output bound`))
    }
    child.stdout!.on('data', (chunk: Buffer) => receive(chunk, false))
    child.stderr!.on('data', (chunk: Buffer) => receive(chunk, true))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else resolve({ code, signal, stdout, stderr })
    })
    child.stdin!.end(options.input)
  }).finally(finish)
}

/** Run a CLI command that must succeed and print one JSON document. */
export async function cliJson<T = any>(options: CliOptions): Promise<T> {
  const label = options.label ?? 'CLI'
  const result = await runCli(options)
  if (result.code !== 0) throw new Error(`${label} failed (${result.code ?? result.signal}): ${options.args.join(' ')}\n${result.stderr.slice(-4000)}`)
  try {
    return JSON.parse(result.stdout) as T
  } catch {
    throw new Error(`${label} returned invalid JSON: ${result.stdout.slice(0, 500)}`)
  }
}
