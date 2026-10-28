import type {
  CompatibilityState,
  InstallState,
  InstanceBinary,
  InstanceSnapshot,
  RunsFailure,
  RunsState,
  UpdateAffordance
} from '../../shared/harness/status'
import { statSync } from 'node:fs'
import type { BinaryFingerprint } from '../../shared/harness/types'
import { parseCliVersion } from '../providers/cliConfig'
import { knownProblemOf } from './compatibility'
import { compareVersions, installOwner, type AuthReading, type DriverRuntime, type HarnessDriver, type InstanceConfig, type ManagedInstall } from './driver'
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
  compatibility: InstanceSnapshot['compatibility']
  binary?: InstanceBinary
  /** The executable's size and modification time when checked: runtime facts recorded for another one are dropped. */
  fingerprint?: BinaryFingerprint
  /** The managed install's receipt hash, when the executable is Mousse's own install. */
  receiptHash?: string
  /** A phase hit its deadline; the gateway keeps the last good values and marks the snapshot stale. */
  timedOut: boolean
  /** The runtime's start-up check ran in this probe (`runs` says how it went). */
  handshakeRan?: boolean
}

export function testedRange(driver: Pick<HarnessDriver, 'testedVersions'>): string | undefined {
  const tested = driver.testedVersions
  if (!tested) return undefined
  return tested.min === tested.max ? tested.min : `${tested.min} – ${tested.max}`
}

/**
 * The version against the driver's row of `COMPATIBILITY`: a known-broken version first, then the
 * tested range. A version newer than tested is reported, never blocked.
 */
export function compatibilityOf(driver: Pick<HarnessDriver, 'testedVersions' | 'knownBroken'>, version: string | undefined): ProbeResult['compatibility'] {
  const tested = driver.testedVersions
  const range = testedRange(driver)
  const testedRangeField = range ? { testedRange: range } : {}
  const broken = knownProblemOf(driver.knownBroken, version)
  if (broken) return { state: 'known_broken', ...testedRangeField, knownProblem: { reason: broken.reason, ...(broken.fixedIn ? { fixedIn: broken.fixedIn } : {}) } }
  if (!tested) return { state: 'tested' }
  if (!version) return { state: 'unknown', ...testedRangeField }
  const state: CompatibilityState =
    compareVersions(version, tested.min) < 0 ? 'too_old' : compareVersions(version, tested.max) > 0 ? 'newer_than_tested' : 'tested'
  return { state, ...testedRangeField }
}

/**
 * One-click update only when Mousse owns the install; otherwise the owner's command to copy.
 * Offered when the version is older than tested, has a known problem that a later version fixes,
 * or when `latest` (the newest published version known, from `LatestVersionCache`) is newer than
 * the installed one. An owner Mousse cannot prove has no command: a newer version is then reported
 * as a notice only, with nothing to run or click.
 */
export function updateAffordance(
  driver: HarnessDriver,
  binary: InstanceBinary | undefined,
  compatibility: ProbeResult['compatibility'],
  latest?: string
): UpdateAffordance | undefined {
  if (!binary) return undefined
  const outdated = compatibility.state === 'too_old' || (compatibility.state === 'known_broken' && Boolean(compatibility.knownProblem?.fixedIn))
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

/** What `probeVersion` found: the executable, whether it starts, its version and how that compares. */
export interface VersionProbe {
  install: InstallState
  runs: ProbeResult['runs']
  compatibility: ProbeResult['compatibility']
  binary?: InstanceBinary
  fingerprint?: BinaryFingerprint
  /** The install's receipt hash (a managed install's `ManagedInstall.receiptHash`). */
  receiptHash?: string
  timedOut: boolean
  /** Why no version was read without a fault (`No version flag`). */
  note?: string
}

/**
 * Finds the executable an instance would run and reads its version: binary resolution, the version
 * flag (`versionArgs`, else `--version`), the fingerprint and the version against `COMPATIBILITY`.
 * It takes no runtime, so it cannot check a sign-in, start the agent or list models: the upkeep
 * script (`scripts/check-agent-versions.mjs`) runs it on its own, and `probeInstance` runs it first.
 */
export async function probeVersion(input: {
  driver: Pick<HarnessDriver, 'kind' | 'label' | 'binaryNames' | 'canInstall' | 'testedVersions' | 'knownBroken' | 'versionArgs'>
  env: InstanceEnv
  /** The explicit executable, when one is set. */
  override?: string
  /** Rejects an override that is not the agent (a manual Antigravity path). */
  validateOverride?: (path: string) => void
  /** Mousse's own install of the agent, when it has one (read from its receipt, never through a runtime). */
  managed?: ManagedInstall
  /** Only Mousse's own install runs: nothing on PATH is used. */
  pinned?: boolean
  /** The instance's settings, for the driver's version flag. */
  config?: InstanceConfig
  timeoutMs?: number
}): Promise<VersionProbe> {
  const { driver, env, managed } = input
  if (managed?.broken) {
    return {
      install: 'broken',
      runs: { state: 'no', failure: 'files_changed', message: `Installed files changed since install (${managed.broken}). Reinstall to run it.` },
      compatibility: compatibilityOf(driver, managed.version),
      binary: { path: managed.path, source: 'managed', owner: 'managed', ...(managed.version ? { version: managed.version } : {}) },
      timedOut: false
    }
  }
  const resolved = resolveBinary({
    override: input.override,
    validateOverride: input.validateOverride,
    managed: managed?.path,
    // A runtime pinned to Mousse's own install never runs a binary found on PATH.
    names: input.pinned ? [] : driver.binaryNames,
    env
  })
  if (resolved.overrideMissing) {
    return {
      install: 'unknown',
      runs: { state: 'no', failure: 'override_not_found', message: `Mousse cannot run ${resolved.path}.` },
      compatibility: compatibilityOf(driver, undefined),
      binary: { path: resolved.path, source: 'override' },
      timedOut: false
    }
  }
  if (!resolved.launch) {
    return {
      install: 'not_installed',
      runs: {
        state: 'no',
        failure: 'not_on_path',
        message: driver.canInstall ? `${driver.label} is not installed.` : "Mousse could not find this provider's command on PATH."
      },
      compatibility: compatibilityOf(driver, undefined),
      timedOut: false
    }
  }

  const binary: InstanceBinary = { path: resolved.launch.path, source: resolved.source, owner: installOwner(resolved.launch.path, resolved.source) }
  const fingerprint = fingerprintOf(resolved.launch.path)
  const fromReceipt = resolved.source === 'managed' && managed?.receiptHash ? { receiptHash: managed.receiptHash } : {}
  let runs: ProbeResult['runs'] = { state: 'yes' }
  let install: InstallState = 'installed'
  let timedOut = false
  let note: string | undefined
  const versionArgs = driver.versionArgs ? driver.versionArgs(input.config ?? { home: 'default' }) : ['--version']
  if (managed?.version && resolved.source === 'managed') binary.version = managed.version
  else if (!versionArgs) note = 'No version flag'
  else {
    const result = await runHarness(env, 'version', resolved.launch.command, [...resolved.launch.args, ...versionArgs], { timeoutMs: input.timeoutMs ?? PROBE_TIMEOUTS.versionMs, maxBytes: 64 * 1024 })
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
  // Without a version flag the version is unknown here, whatever the range says.
  const compatibility = note ? { state: 'unknown' as const, ...(testedRange(driver) ? { testedRange: testedRange(driver) } : {}) } : compatibilityOf(driver, binary.version)
  return { install, runs, compatibility, binary, ...(fingerprint ? { fingerprint } : {}), ...fromReceipt, timedOut, ...(note ? { note } : {}) }
}

/** The headline of a version with a known problem, for the card and the refusal alike. */
export function knownProblemMessage(label: string, version: string | undefined, reason: string | undefined): string {
  const text = reason?.trim() ?? ''
  return `Known problem with ${label} ${version ?? 'this version'}${text ? `: ${/[.!?]$/.test(text) ? text.slice(0, -1) : text}` : ''}.`
}

/**
 * Checks one instance: which binary would run, whether it starts (its version flag, never a model
 * turn or the heavy runtime), its version against the tested range, and its sign-in. With
 * `handshake` (Add, Recheck, after install) a runtime that has one also runs its start-up check.
 * Each phase has a hard deadline; a version check that hangs is killed with its process tree. A
 * version with a known problem reports `runs: no` after its sign-in was read: the page can still
 * say who is signed in, and Update or allowing the version are the steps.
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
  /** Reads the sign-in instead of the runtime (an instance signed out in Mousse is not asked). */
  auth?: () => Promise<AuthReading>
  timeouts?: Partial<typeof PROBE_TIMEOUTS>
  now?: () => Date
}): Promise<ProbeResult> {
  const { driver, runtime, env } = input
  const readAuth = (force: boolean): Promise<AuthReading> => (input.auth ? input.auth() : runtime.auth({ force }))
  const timeouts = { ...PROBE_TIMEOUTS, ...input.timeouts }
  const checkedAt = (input.now?.() ?? new Date()).toISOString()
  const notChecked: AuthReading = { state: 'unknown', ...(driver.methodLabel ? { methodLabel: driver.methodLabel } : {}) }

  // A runtime Mousse hosts itself (the pi loop) has no binary to find.
  if (!driver.binaryNames.length && !runtime.managed && !driver.canInstall && !input.override) {
    const reading = await withDeadline(readAuth(input.force), timeouts.authMs)
    const timedOut = 'timedOut' in reading
    const auth = timedOut ? { ...notChecked, message: 'The sign-in check did not finish.' } : reading.value
    return { checkedAt, install: 'installed', runs: { state: 'yes' }, auth, compatibility: { state: 'tested' }, binary: { source: 'bundled' }, timedOut }
  }

  // Recheck, Add and after install: every installed file against its install record. Hashing a
  // large install is local work with no deadline; the start-up check that follows reuses it.
  if (input.force && runtime.verifyInstall) {
    try {
      await runtime.verifyInstall(new AbortController().signal)
    } catch (error) {
      console.warn('[harness] install check failed', { driver: driver.kind, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const managed = runtime.managed?.()
  const installing = runtime.installState?.().installing === true
  const found = await probeVersion({
    driver,
    env,
    ...(input.override ? { override: input.override } : {}),
    ...(runtime.validateOverride ? { validateOverride: runtime.validateOverride } : {}),
    ...(managed ? { managed } : {}),
    ...(runtime.pinned ? { pinned: true } : {}),
    ...(input.config ? { config: input.config } : {}),
    timeoutMs: timeouts.versionMs
  })
  const { binary, fingerprint } = found
  let { runs, timedOut } = found
  const install: InstallState = installing && found.install !== 'broken' ? 'installing' : found.install
  if (runs.state === 'no' && (runs.failure === 'files_changed' || runs.failure === 'override_not_found' || runs.failure === 'not_on_path'))
    return { checkedAt, install, runs, auth: notChecked, compatibility: found.compatibility, ...(binary ? { binary } : {}), timedOut: false }

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
    if (binary && !binary.version) {
      const announced = runtime.runtimeFacts?.()?.agentInfo?.version
      if (announced) binary.version = announced
    }
  }

  let auth = notChecked
  if (runs.state !== 'no') {
    try {
      const reading = await withDeadline(readAuth(input.force), timeouts.authMs)
      if ('timedOut' in reading) {
        timedOut = true
        auth = { ...notChecked, message: 'The sign-in check did not finish.' }
      } else auth = reading.value
    } catch (error) {
      auth = { ...notChecked, message: error instanceof Error ? error.message : String(error) }
    }
  }
  const compatibility = compatibilityOf(driver, binary?.version)
  if (compatibility.state === 'known_broken' && runs.state !== 'no')
    runs = { state: 'no', failure: 'known_broken', message: knownProblemMessage(driver.label, binary?.version, compatibility.knownProblem?.reason) }
  return {
    checkedAt,
    install,
    runs,
    auth,
    compatibility,
    ...(binary ? { binary } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(found.receiptHash ? { receiptHash: found.receiptHash } : {}),
    timedOut,
    ...(handshakeRan ? { handshakeRan } : {})
  }
}
