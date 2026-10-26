import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { InstanceEnv } from './env'

/**
 * The one way the gateway starts a harness process (probes, version checks, sign-in checks, model
 * listing, installs). Every spawn carries its instance's environment, so an instance with its own
 * home never sees another one's. The wrapped vendor services keep their own process plumbing for
 * turns in PR 1 and take the instance environment through their dependencies instead.
 */

export interface HarnessSpawn {
  instanceId: string
  /** Why the process starts (`probe`, `version`, `auth`, `models`, `install`, `turn`). */
  purpose: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

type SpawnObserver = (spawned: HarnessSpawn) => void
const observers = new Set<SpawnObserver>()

/** Test seam: sees every harness spawn (and every vendor-service spawn the gateway routes). */
export function observeHarnessSpawns(observer: SpawnObserver): () => void {
  observers.add(observer)
  return () => observers.delete(observer)
}

/** Reports a spawn made outside `spawnHarness` (a vendor service's own launcher) to the observers. */
export function recordHarnessSpawn(spawned: HarnessSpawn): void {
  for (const observer of observers) {
    try {
      observer(spawned)
    } catch {
      /* observers never break a spawn */
    }
  }
}

/** `command args…` with the instance's environment, `extraEnv` on top. */
export function spawnHarness(
  env: InstanceEnv,
  purpose: string,
  command: string,
  args: string[],
  options: Omit<SpawnOptions, 'env'> & { extraEnv?: NodeJS.ProcessEnv } = {}
): ChildProcess {
  const { extraEnv, ...spawnOptions } = options
  const processEnv = extraEnv ? { ...env.env, ...extraEnv } : env.env
  recordHarnessSpawn({ instanceId: env.instanceId, purpose, command, args, env: processEnv })
  return spawn(command, args, {
    windowsHide: true,
    // A process group on POSIX, so a timeout kills the whole tree.
    detached: process.platform !== 'win32',
    ...spawnOptions,
    env: processEnv
  })
}

/** Kills `child` and everything it started. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

export interface HarnessRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** The process could not start (ENOENT, EACCES); `code` is null. */
  spawnError?: string
}

/**
 * Runs a short command to completion with a hard deadline. On timeout or abort the whole process
 * tree is killed and the result says so; it never throws.
 */
export function runHarness(
  env: InstanceEnv,
  purpose: string,
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; extraEnv?: NodeJS.ProcessEnv; cwd?: string; maxBytes?: number }
): Promise<HarnessRunResult> {
  return new Promise((resolve) => {
    const maxBytes = options.maxBytes ?? 256 * 1024
    let stdout = ''
    let stderr = ''
    let settled = false
    let child: ChildProcess
    const finish = (result: Omit<HarnessRunResult, 'stdout' | 'stderr'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ ...result, stdout, stderr })
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish({ code: null, timedOut: true })
    }, options.timeoutMs)
    timer.unref?.()
    const onAbort = () => {
      killTree(child)
      finish({ code: null, timedOut: false, spawnError: 'aborted' })
    }
    try {
      child = spawnHarness(env, purpose, command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.extraEnv ? { extraEnv: options.extraEnv } : {})
      })
    } catch (error) {
      finish({ code: null, timedOut: false, spawnError: error instanceof Error ? error.message : String(error) })
      return
    }
    if (options.signal?.aborted) return onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => finish({ code: null, timedOut: false, spawnError: error.message }))
    // `close` waits for the pipes; a grandchild holding them open is cut off by the deadline.
    child.once('close', (code) => finish({ code, timedOut: false }))
  })
}

/**
 * `claude auth …` for the Claude service, through `runHarness`: the same contract as the
 * service's own runner (stdout on success; on failure an error carrying stdout, because
 * `claude auth status` exits non-zero when signed out but still prints its JSON), with the
 * process tree killed on timeout.
 */
export function harnessAuthRunner(instanceId: string, driver: InstanceEnv['driver'] = 'claude') {
  return async (binary: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> => {
    const result = await runHarness(
      { instanceId, driver, configRevision: 0, homeId: 'default', env, searchPath: [] },
      'auth',
      binary,
      args,
      { timeoutMs: 15_000, ...(signal ? { signal } : {}), maxBytes: 64 * 1024 }
    )
    if (result.code === 0) return result.stdout
    throw Object.assign(
      new Error(
        signal?.aborted
          ? 'Claude sign-in cancelled'
          : 'Claude Code authentication command failed. Install or update the official Claude Code CLI.'
      ),
      { stdout: result.stdout || undefined }
    )
  }
}
