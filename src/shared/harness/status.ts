import type { HarnessCaps, HarnessDriverKind, InstanceModel, ProviderScope } from './types'

/**
 * Status of one provider instance as the daemon last checked it. Install, runs and auth are
 * separate axes: a timeout makes the snapshot `stale` and keeps the last good values; it never
 * turns into "unavailable". `describeStatus` is the one place that turns a snapshot into copy, for
 * the providers page, the composer picker and errors alike.
 */

export type InstallState = 'not_installed' | 'installing' | 'installed' | 'broken' | 'unknown'
export type RunsState = 'yes' | 'no' | 'unknown'
export type AuthState = 'signed_in' | 'signed_out' | 'expired' | 'refreshing' | 'unknown' | 'not_required'
export type CompatibilityState = 'tested' | 'newer_than_tested' | 'too_old' | 'known_broken' | 'unknown'
export type BinarySource = 'path' | 'managed' | 'override' | 'bundled'
/** Who installed the binary; one-click update needs a proven owner. */
export type InstallOwner = 'npm' | 'pnpm' | 'bun' | 'brew' | 'winget' | 'standalone' | 'managed' | 'unknown'

/** Why the binary does not run. `override_not_found` never falls back to PATH. */
export type RunsFailure = 'override_not_found' | 'not_on_path' | 'spawn_failed' | 'exited' | 'bad_version' | 'timeout'

export interface InstanceBinary {
  /** Resolved executable; absent when nothing was found. */
  path?: string
  version?: string
  source: BinarySource
  owner?: InstallOwner
}

export type UpdateAffordance =
  | { kind: 'one_click'; owner: InstallOwner; latestVersion?: string }
  | { kind: 'advisory'; command: string; latestVersion?: string }
  /** A newer version is known, but Mousse cannot say how this copy was installed: no command, no action. */
  | { kind: 'notice'; latestVersion: string }

export type NextStepAction =
  | 'enable'
  | 'install'
  | 'cancel_install'
  | 'fix_override'
  | 'recheck'
  | 'sign_in'
  | 'update'

export interface NextStep {
  action: NextStepAction
  label: string
  /** A command the user can copy (advisory update, terminal sign-in). */
  command?: string
}

export interface InstanceEnabled {
  device: boolean
  /** The project override; absent when the project does not set one or the scope is the device. */
  project?: boolean
  /** What applies in the snapshot's scope. Device off is a ceiling a project cannot lift. */
  effective: boolean
  /** The layer that decided `effective`. */
  setBy: 'device' | 'project'
}

/** An instance's settings as stored: the editor's name, account home, executable, args and variables. */
export interface InstanceConfigView {
  displayName?: string
  home: 'default' | 'private'
  /** The explicit executable; absent = found on PATH (or Mousse's own install). */
  binaryPath?: string
  args: string[]
  env: Record<string, string>
  loginMethod?: string
  /** The entry this one moved to; it is off, and its threads continue there. */
  movedTo?: string
}

export interface InstanceSnapshot {
  instanceId: string
  driver: HarnessDriverKind
  displayName: string
  /** The instance on the user's own setup (`claude`, `codex`, `antigravity`, `pi:<id>`); removable like any other. */
  builtIn: boolean
  scope: ProviderScope
  enabled: InstanceEnabled
  install: {
    state: InstallState
    /** Set while an install or update runs (it outlives the page that started it). */
    operationId?: string
    progress?: { message: string; fraction?: number }
    /** Mousse can install this driver itself. */
    canInstall: boolean
  }
  runs: { state: RunsState; failure?: RunsFailure; message?: string }
  auth: {
    state: AuthState
    /** Keyed by id, never email; `label` is for display. */
    account?: { id: string; label?: string }
    /** How the instance signs in (e.g. "Claude subscription", "API key"). */
    methodLabel?: string
    message?: string
    /**
     * Mousse owns this sign-in (a private home, a Mousse-managed agent, a Mousse-held key), so it
     * may sign out. False for the user's own CLI login, which Mousse never signs out.
     */
    canSignOut?: boolean
    /** A sign-in can start in Mousse now, even when the account is not checked (`unknown`). */
    canSignIn?: boolean
  }
  compatibility: { state: CompatibilityState; testedRange?: string }
  update?: UpdateAffordance
  binary?: InstanceBinary
  caps: HarnessCaps
  /** The stored settings the editor shows; present on daemons with the harness gateway. */
  config?: InstanceConfigView
  models: {
    entries: InstanceModel[]
    source: 'live' | 'cached' | 'manifest' | 'none'
    /** The runtime runs a model by id, so the editor offers adding custom models. */
    canAddCustom?: boolean
    refreshedAt?: string
    error?: string
  }
  /** ISO time of the last completed check; absent until the first check finishes. */
  checkedAt?: string
  /** The last check timed out or failed; the values are from `lastGoodAt`. */
  stale: boolean
  lastGoodAt?: string
  /**
   * The driver's wording for the next step (e.g. the terminal sign-in command). `describeStatus`
   * uses it when it names the same action the status calls for.
   */
  nextStep?: NextStep
}

/** `{ scope, snapshots }`: pushed on every change, and returned by `providers.snapshots`. */
export interface ProviderSnapshotsEvent {
  scope: ProviderScope
  snapshots: InstanceSnapshot[]
}

export type StatusTone = 'ready' | 'neutral' | 'warning' | 'error' | 'disabled'

export interface StatusDescription {
  headline: string
  detail: string | null
  tone: StatusTone
  nextStep: NextStep | null
}

const DEFAULT_STEPS: Record<NextStepAction, string> = {
  enable: 'Turn on',
  install: 'Install',
  cancel_install: 'Cancel',
  fix_override: 'Change path',
  recheck: 'Check again',
  sign_in: 'Sign in',
  update: 'Update'
}

function step(snapshot: InstanceSnapshot, action: NextStepAction, label = DEFAULT_STEPS[action]): NextStep {
  const hint = snapshot.nextStep
  return hint?.action === action ? hint : { action, label }
}

function updateStep(snapshot: InstanceSnapshot): NextStep | null {
  const update = snapshot.update
  if (!update) return null
  if (update.kind === 'one_click') return step(snapshot, 'update')
  if (update.kind === 'notice') return null
  return { action: 'update', label: 'Copy update command', command: update.command }
}

function withLabel(headline: string, label: string | undefined): string {
  return label ? `${headline} · ${label}` : headline
}

const STALE_DETAIL = 'The last check did not finish. Showing the last good status.'

/**
 * Status copy for one instance (T3 Code wording). Order matters: off, installing, the binary, then
 * sign-in, then version advice. Signed out is neutral (a step, not a fault); a stale check keeps
 * the last good status and only adds a note.
 */
export function describeStatus(snapshot: InstanceSnapshot): StatusDescription {
  const { enabled, install, runs, auth, compatibility } = snapshot

  if (!enabled.effective) {
    return {
      headline: 'Disabled',
      detail: enabled.setBy === 'project' ? 'Turned off for this project.' : 'Turned off on this device.',
      tone: 'disabled',
      nextStep: step(snapshot, 'enable')
    }
  }

  if (install.state === 'installing') {
    return {
      headline: 'Installing',
      detail: install.progress?.message ?? null,
      tone: 'neutral',
      nextStep: install.operationId ? step(snapshot, 'cancel_install') : null
    }
  }

  if (!snapshot.checkedAt && !snapshot.stale) {
    return { headline: 'Checking provider status', detail: null, tone: 'neutral', nextStep: null }
  }

  if (snapshot.stale && !snapshot.lastGoodAt) {
    return {
      headline: 'Status unknown',
      detail: 'The check did not finish.',
      tone: 'warning',
      nextStep: step(snapshot, 'recheck')
    }
  }

  const staleDetail = snapshot.stale ? STALE_DETAIL : null

  if (runs.state === 'no' && runs.failure === 'override_not_found') {
    const path = snapshot.binary?.path
    return {
      headline: 'Override not found',
      detail: path ? `Mousse cannot run ${path}. Change the path or clear it.` : 'Change the executable path or clear it.',
      tone: 'error',
      nextStep: step(snapshot, 'fix_override')
    }
  }

  if (install.state === 'not_installed') {
    return {
      headline: 'Not found',
      detail: runs.message ?? 'CLI not detected on PATH.',
      tone: 'warning',
      nextStep: install.canInstall ? step(snapshot, 'install') : step(snapshot, 'recheck')
    }
  }

  if (install.state === 'broken') {
    return {
      headline: 'Install is broken',
      detail: runs.message ?? null,
      tone: 'error',
      nextStep: install.canInstall ? step(snapshot, 'install', 'Reinstall') : step(snapshot, 'recheck')
    }
  }

  if (runs.state === 'no') {
    return {
      headline: 'Unavailable',
      detail: runs.message ?? 'The provider failed its startup checks.',
      tone: 'error',
      nextStep: step(snapshot, 'recheck')
    }
  }

  if (compatibility.state === 'known_broken') {
    return {
      headline: 'Known broken version',
      detail: snapshot.binary?.version ? `Version ${snapshot.binary.version} does not work with Mousse.` : null,
      tone: 'error',
      nextStep: updateStep(snapshot)
    }
  }

  if (auth.state === 'signed_out') {
    return {
      headline: 'Not signed in',
      detail: auth.message ?? staleDetail,
      tone: 'neutral',
      nextStep: step(snapshot, 'sign_in')
    }
  }

  if (auth.state === 'expired') {
    return {
      headline: 'Sign-in expired',
      detail: auth.message ?? staleDetail,
      tone: 'warning',
      nextStep: step(snapshot, 'sign_in', 'Sign in again')
    }
  }

  if (compatibility.state === 'too_old') {
    return {
      headline: 'Unsupported version',
      detail: compatibility.testedRange ? `Use ${compatibility.testedRange} for full support.` : 'Update for full support.',
      tone: 'warning',
      nextStep: updateStep(snapshot)
    }
  }

  if (auth.state === 'refreshing') {
    return { headline: 'Refreshing sign-in', detail: staleDetail, tone: 'neutral', nextStep: null }
  }

  if (runs.state === 'unknown' || install.state === 'unknown') {
    return {
      headline: 'Needs attention',
      detail: runs.message ?? staleDetail ?? 'Mousse could not fully verify this provider.',
      tone: 'warning',
      nextStep: step(snapshot, 'recheck')
    }
  }

  if (auth.state === 'unknown') {
    return {
      headline: 'Installed · Sign-in not checked',
      detail: auth.message ?? staleDetail,
      tone: 'neutral',
      // An agent that offers its sign-in methods can be signed in from here.
      nextStep: auth.canSignIn ? step(snapshot, 'sign_in') : step(snapshot, 'recheck')
    }
  }

  const headline = auth.state === 'signed_in'
    ? withLabel('Signed in', auth.account?.label ?? auth.methodLabel)
    : 'Available'
  const detail = compatibility.state === 'newer_than_tested'
    ? `Newer than the versions Mousse was tested with${compatibility.testedRange ? ` (${compatibility.testedRange})` : ''}.`
    : snapshot.update?.latestVersion
      ? `Update available: ${snapshot.update.latestVersion}.`
      : null
  return {
    headline,
    detail: staleDetail ?? detail,
    tone: 'ready',
    nextStep: updateStep(snapshot) ?? (snapshot.stale ? step(snapshot, 'recheck') : null)
  }
}
