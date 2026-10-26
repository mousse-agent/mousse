import type {
  CompatibilityState,
  InstallState,
  InstanceBinary,
  RunsFailure,
  RunsState,
  UpdateAffordance
} from '../../shared/harness/status'
import { statSync } from 'node:fs'
import type { BinaryFingerprint } from '../../shared/harness/types'
import { parseCliVersion } from '../providers/cliConfig'
import { compareVersions, installOwner, type AuthReading, type DriverRuntime, type HarnessDriver, type InstanceConfig } from './driver'
import { resolveBinary, type InstanceEnv } from './env'
import { runHarness } from './spawn'

/** Deadlines of one probe. A version check is a few hundred ms; a sign-in check may start the CLI. */
export const PROBE_TIMEOUTS = { versionMs: 8_000, authMs: 20_000, handshakeMs: 20_000 }

/** What one probe found, before the gateway applies staleness and the instance's scope. */
export interface ProbeResult {
  checkedAt: string
  install: InstallState
  runs: { state: RunsState; failure?: RunsFailure; message?: string }
  auth: AuthReading
  compatibility: { state: CompatibilityState; testedRange?: string }
  binary?: InstanceBinary
  /** The executable's size and modification time when checked: runtime facts recorded for another one are dropped. */
  fingerprint?: BinaryFingerprint
  /** A phase hit its deadline; the gateway keeps the last good values and marks the snapshot stale. */
  timedOut: boolean
  /** The runtime's start-up check ran in this probe (`runs` says how it went). */
  handshakeRan?: boolean
}

export function testedRange(driver: HarnessDriver): string | undefined {
  const tested = driver.testedVersions
  if (!tested) return undefined
  return tested.min === tested.max ? tested.min : `${tested.min} – ${tested.max}`
}

export function compatibilityOf(driver: HarnessDriver, version: string | undefined): ProbeResult['compatibility'] {
  const tested = driver.testedVersions
  const range = testedRange(driver)
  if (!tested) return { state: 'tested' }
  if (!version) return { state: 'unknown', ...(range ? { testedRange: range } : {}) }
  const state: CompatibilityState =
    compareVersions(version, tested.min) < 0 ? 'too_old' : compareVersions(version, tested.max) > 0 ? 'newer_than_tested' : 'tested'
  return { state, ...(range ? { testedRange: range } : {}) }
}

/**
 * One-click update only when Mousse owns the install; otherwise the owner's command to copy.
 * Offered when the version is older than tested, or when `latest` (the newest published version
 * known, from `LatestVersionCache`) is newer than the installed one. An owner Mousse cannot prove
 * has no command: a newer version is then reported as a notice only, with nothing to run or click.
 */
export function updateAffordance(
  driver: HarnessDriver,
  binary: InstanceBinary | undefined,
  compatibility: ProbeResult['compatibility'],
  latest?: string
): UpdateAffordance | undefined {
  if (!binary) return undefined
  const outdated = compatibility.state === 'too_old' || compatibility.state === 'known_broken'
  const newer = Boolean(latest && binary.version && compareVersions(latest, binary.version) > 0)
  if (!outdated && !newer) return undefined
  const latestVersion = newer && latest ? { latestVersion: latest } : {}
  const owner = binary.owner ?? 'unknown'
  if (owner === 'managed' && driver.canInstall) return { kind: 'one_click', owner, ...latestVersion }
  const command = driver.updateCommand?.(owner)
  if (command) return { kind: 'advisory', command, ...latestVersion }
  // The version is worth showing; without a proven owner there is nothing to run or click.
  return newer && latest ? { kind: 'notice', latestVersion: latest } : undefined
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<{ value: T } | { timedOut: true }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve({ value })
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Size and modification time of an executable; undefined when it cannot be read. */
export function fingerprintOf(path: string | undefined): BinaryFingerprint | undefined {
  if (!path) return undefined
  try {
    const stat = statSync(path)
    return { path, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return undefined
  }
}

export function sameBinary(a: BinaryFingerprint | undefined, b: BinaryFingerprint | undefined): boolean {
  return Boolean(a && b && a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs)
}

/**
 * Checks one instance: which binary would run, whether it starts (its version flag, never a model
 * turn or the heavy runtime), its version against the tested range, and its sign-in. With
 * `handshake` (Add, Recheck, after install) a runtime that has one also runs its start-up check.
 * Each phase has a hard deadline; a version check that hangs is killed with its process tree.
 */
export async function probeInstance(input: {
  driver: HarnessDriver
  runtime: DriverRuntime
  env: InstanceEnv
  /** The explicit executable, when one is set. */
  override?: string
  /** The instance's settings, for the driver's version flag. */
  config?: InstanceConfig
  force: boolean
  /** Run the runtime's start-up check too (`DriverRuntime.handshake`). */
  handshake?: boolean
  timeouts?: Partial<typeof PROBE_TIMEOUTS>
  now?: () => Date
}): Promise<ProbeResult> {
  const { driver, runtime, env } = input
  const timeouts = { ...PROBE_TIMEOUTS, ...input.timeouts }
  const checkedAt = (input.now?.() ?? new Date()).toISOString()
  const notChecked: AuthReading = { state: 'unknown', ...(driver.methodLabel ? { methodLabel: driver.methodLabel } : {}) }

  // A runtime Mousse hosts itself (the pi loop) has no binary to find.
  if (!driver.binaryNames.length && !runtime.managed && !driver.canInstall && !input.override) {
    const reading = await withDeadline(runtime.auth({ force: input.force }), timeouts.authMs)
    const timedOut = 'timedOut' in reading
    const auth = timedOut ? { ...notChecked, message: 'The sign-in check did not finish.' } : reading.value
    return { checkedAt, install: 'installed', runs: { state: 'yes' }, auth, compatibility: { state: 'tested' }, binary: { source: 'bundled' }, timedOut }
  }

  const managed = runtime.managed?.()
  const resolved = resolveBinary({
    override: input.override,
    validateOverride: runtime.validateOverride,
    managed: managed?.path,
    names: driver.binaryNames,
    env
  })
  const installing = runtime.installState?.().installing === true
  if (resolved.overrideMissing) {
    return {
      checkedAt,
      install: installing ? 'installing' : 'unknown',
      runs: { state: 'no', failure: 'override_not_found', message: `Mousse cannot run ${resolved.path}.` },
      auth: notChecked,
      compatibility: compatibilityOf(driver, undefined),
      binary: { path: resolved.path, source: 'override' },
      timedOut: false
    }
  }
  if (!resolved.launch) {
    return {
      checkedAt,
      install: installing ? 'installing' : 'not_installed',
      runs: {
        state: 'no',
        failure: 'not_on_path',
        message: driver.canInstall ? `${driver.label} is not installed.` : 'CLI not detected on PATH.'
      },
      auth: notChecked,
      compatibility: compatibilityOf(driver, undefined),
      timedOut: false
    }
  }

  const binary: InstanceBinary = { path: resolved.launch.path, source: resolved.source, owner: installOwner(resolved.launch.path, resolved.source) }
  const fingerprint = fingerprintOf(resolved.launch.path)
  let runs: ProbeResult['runs'] = { state: 'yes' }
  let install: InstallState = installing ? 'installing' : 'installed'
  let timedOut = false
  const versionArgs = driver.versionArgs ? driver.versionArgs(input.config ?? { home: 'default' }) : ['--version']
  if (managed?.version && resolved.source === 'managed') binary.version = managed.version
  else if (versionArgs) {
    const result = await runHarness(env, 'version', resolved.launch.command, [...resolved.launch.args, ...versionArgs], { timeoutMs: timeouts.versionMs, maxBytes: 64 * 1024 })
    if (result.timedOut) {
      timedOut = true
      runs = { state: 'unknown', failure: 'timeout', message: `${driver.label} did not answer --version in time.` }
    } else if (result.spawnError) {
      install = 'broken'
      runs = { state: 'no', failure: 'spawn_failed', message: `${driver.label} could not start (${result.spawnError}).` }
    } else if (result.code !== 0) {
      install = 'broken'
      runs = { state: 'no', failure: 'exited', message: `${driver.label} exited with code ${result.code} when asked for its version.` }
    } else {
      const version = parseCliVersion(`${result.stdout}\n${result.stderr}`)
      if (version) binary.version = version
      else runs = { state: 'yes', failure: 'bad_version', message: `Mousse could not read the ${driver.label} version.` }
    }
  }

  const handshakeRan = runs.state !== 'no' && Boolean(input.handshake && runtime.handshake)
  if (handshakeRan && runtime.handshake) {
    const controller = new AbortController()
    try {
      const shook = await withDeadline(runtime.handshake(controller.signal), timeouts.handshakeMs)
      if ('timedOut' in shook) {
        controller.abort()
        timedOut = true
        runs = { state: 'unknown', failure: 'timeout', message: `${driver.label} did not finish starting in time.` }
      } else runs = { state: 'yes' }
    } catch (error) {
      runs = { state: 'no', failure: 'exited', message: `${driver.label} could not start: ${error instanceof Error ? error.message : String(error)}` }
    }
    // A version the agent announced itself, when the executable has no version flag.
    if (!binary.version) {
      const announced = runtime.runtimeFacts?.()?.agentInfo?.version
      if (announced) binary.version = announced
    }
  }

  let auth = notChecked
  if (runs.state !== 'no') {
    try {
      const reading = await withDeadline(runtime.auth({ force: input.force }), timeouts.authMs)
      if ('timedOut' in reading) {
        timedOut = true
        auth = { ...notChecked, message: 'The sign-in check did not finish.' }
      } else auth = reading.value
    } catch (error) {
      auth = { ...notChecked, message: error instanceof Error ? error.message : String(error) }
    }
  }
  const compatibility = compatibilityOf(driver, binary.version)
  return { checkedAt, install, runs, auth, compatibility, binary, ...(fingerprint ? { fingerprint } : {}), timedOut, ...(handshakeRan ? { handshakeRan } : {}) }
}
