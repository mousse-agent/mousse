import type { PermissionLimits } from '../permissionMode'
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
export type RunsFailure = 'override_not_found' | 'not_on_path' | 'spawn_failed' | 'exited' | 'bad_version' | 'timeout' | 'files_changed' | 'known_broken'

export interface InstanceBinary {
  /** Resolved executable; absent when nothing was found. */
  path?: string
  version?: string
  source: BinarySource
  owner?: InstallOwner
}

export type UpdateAffordance =
  | { kind: 'one_click'; owner: InstallOwner; latestVersion?: string }
  /** Installed by its owner (npm, brew, the CLI's own installer): Update runs `command`, which can also be copied. */
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
  /** A Mousse update retired the entry's route: move to the agent that replaces it. */
  | 'move'

export interface NextStep {
  action: NextStepAction
  label: string
  /** A command the user can copy (advisory update, terminal sign-in). */
  command?: string
  /** The headline and the explanation of a persistent prompt (`move`). */
  title?: string
  detail?: string
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
  /** Where a private home is kept; it stays on disk when the provider is removed. */
  homePath?: string
  /** The explicit executable; absent = found on PATH (or Mousse's own install). */
  binaryPath?: string
  args: string[]
  env: Record<string, string>
  loginMethod?: string
  /** The entry this one moved to; it is off, and its threads continue there. */
  movedTo?: string
  /** An ACP agent Mousse installs from the registry. */
  source?: { kind: 'registry'; agentId: string; version: string; distribution: 'binary' | 'npx' }
  /** Codex: Mousse's own download and sign-in, or the user's Codex CLI. */
  setup?: 'managed' | 'existing'
}

/**
 * A version known not to work with Mousse (`compatibility.state: 'known_broken'`): what goes wrong,
 * the version that fixes it when there is one, and whether the user allowed this version for this
 * program anyway (`providers.instances.allowKnownProblem`).
 */
export interface KnownProblem {
  reason: string
  fixedIn?: string
  allowed?: boolean
}

/**
 * What an instance's turns run on: a key the user gave (`api_key`), a subscription sign-in
 * (`subscription`), the environment's cloud credentials (`ambient`: AWS, or Google's application
 * default credentials), or `unknown` (the user's own home, which Mousse does not inspect further).
 */
export type CredentialKind = 'api_key' | 'subscription' | 'ambient' | 'unknown'

/**
 * The entry's agent telemetry (Settings → Providers). Mousse applies it only through what it adds to
 * the processes it starts; it never edits the agent's files.
 * - `off`: every process starts with the agent's documented switch (`variables`, `args`) set last;
 * - `agent_setting`: Mousse sets nothing, and the agent does what its own settings say;
 * - `none`: the agent documents no switch, so there is nothing to set.
 */
export interface InstanceTelemetry {
  setting: 'off' | 'agent_setting' | 'none'
  /** The setting until the user picks one: `off` for an agent Mousse set up, `agent_setting` on the user's own setup. */
  defaultSetting?: 'off' | 'agent_setting'
  /** The variables Off sets: a launch variable of the same name is ignored while it is off. */
  variables?: string[]
  /** The launch arguments Off adds after the entry's own. */
  args?: string[]
  /** The vendor's page on what the agent collects. */
  docsUrl?: string
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
    progress?: { message: string; fraction?: number; receivedBytes?: number; totalBytes?: number }
    /** Mousse can install this driver itself. */
    canInstall: boolean
    /** Files Mousse downloaded for this entry ("Delete downloaded files"). */
    downloaded?: { bytes: number }
    /** Whether the registry gave a checksum for the download (registry agents). */
    checksum?: 'registry' | 'none'
    /** Something about the install the user should know (the registry changed this version's launch). */
    advisory?: string
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
    /** A move may copy a model API's saved API key to this entry (`instances.move` with `copyKey`). */
    canTakeKey?: boolean
    /** What the instance runs on once signed in; absent when the driver cannot tell without another check. */
    credential?: CredentialKind
  }
  compatibility: { state: CompatibilityState; testedRange?: string; knownProblem?: KnownProblem }
  update?: UpdateAffordance
  binary?: InstanceBinary
  caps: HarnessCaps
  /**
   * What limits the permission modes the instance can enforce right now (Claude: the user's
   * settings forbid bypassing permissions). Read on every snapshot; absent when nothing does.
   */
  permissionLimits?: PermissionLimits
  /** The stored settings the editor shows; present on daemons with the harness gateway. */
  config?: InstanceConfigView
  models: {
    entries: InstanceModel[]
    /**
     * Names listings gave models the instance does not list now (an empty Codex list, a removed
     * model), by model id, so a selection that names one still reads by name.
     */
    names?: Record<string, string>
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
  /**
   * An older Mousse version changed this provider's settings in its own settings file, found when
   * Mousse started: `older_applied` took them over (shown until the next start or a change);
   * `older_conflict` kept this version's and offers "Use the older settings"
   * (`configure({ useOlderSettings: true })`) until the user picks or saves.
   */
  settingsNotice?: { kind: 'older_applied' | 'older_conflict'; message: string }
  /** The entry's agent telemetry; absent on older daemons. */
  telemetry?: InstanceTelemetry
}

/**
 * What "Refresh models" did for one instance (`providers.instances.refreshAllModels`). `skipped`
 * leaves the list alone on purpose (not signed in, a chat is running); `failed` carries the reason.
 */
export interface ModelRefreshResult {
  instanceId: string
  outcome: 'refreshed' | 'skipped' | 'failed'
  message?: string
  snapshot: InstanceSnapshot
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
  update: 'Update',
  move: 'Move'
}

function step(snapshot: InstanceSnapshot, action: NextStepAction, label = DEFAULT_STEPS[action]): NextStep {
  const hint = snapshot.nextStep
  return hint?.action === action ? hint : { action, label }
}

/** A retired entry has no sign-in to offer: signed out, its step stays Move. */
function signInStep(snapshot: InstanceSnapshot, label?: string): NextStep {
  return snapshot.nextStep?.action === 'move' ? snapshot.nextStep : step(snapshot, 'sign_in', label)
}

function updateStep(snapshot: InstanceSnapshot): NextStep | null {
  const update = snapshot.update
  if (!update) return null
  if (update.kind === 'one_click') return step(snapshot, 'update')
  if (update.kind === 'notice') return null
  return { action: 'update', label: 'Update', command: update.command }
}

function withLabel(headline: string, label: string | undefined): string {
  return label ? `${headline} · ${label}` : headline
}

/** A reason as a sentence: ends with a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

const STALE_DETAIL = 'The last check did not finish. Showing the last good status.'

/**
 * Status copy for one instance. Order matters: off, installing, the binary, then
 * sign-in, then version advice. Signed out is neutral (a step, not a fault); a stale check keeps
 * the last good status and only adds a note.
 */
export function describeStatus(snapshot: InstanceSnapshot): StatusDescription {
  const { enabled, install, runs, auth, compatibility } = snapshot

  // Retired by a Mousse update: nothing runs on it, on or off, and Move is the one step.
  if (runs.state === 'no' && snapshot.nextStep?.action === 'move') {
    return {
      headline: snapshot.nextStep.title ?? 'Retired',
      detail: snapshot.nextStep.detail ?? runs.message ?? null,
      tone: 'warning',
      nextStep: snapshot.nextStep
    }
  }

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
    return { headline: 'Checking status', detail: null, tone: 'neutral', nextStep: null }
  }

  if (snapshot.stale && !snapshot.lastGoodAt) {
    return {
      headline: 'Check incomplete',
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
      detail: runs.message ?? "Mousse could not find this provider's command on PATH.",
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

  // A known problem with this version, not allowed: nothing runs until it is updated or allowed.
  const problem = compatibility.state === 'known_broken' ? compatibility.knownProblem : undefined
  if (compatibility.state === 'known_broken' && !problem?.allowed) {
    const version = snapshot.binary?.version
    const fix = problem?.fixedIn ? `Version ${problem.fixedIn} fixes it.` : null
    return {
      headline: version ? `Known problem with ${version}` : 'Known problem with this version',
      detail: [problem?.reason ? sentence(problem.reason) : null, fix, 'Update it, or run this version anyway.'].filter(Boolean).join(' '),
      tone: 'error',
      nextStep: updateStep(snapshot)
    }
  }

  if (runs.state === 'no') {
    return {
      headline: 'Unavailable',
      detail: runs.message ?? 'Mousse could not start this provider.',
      tone: 'error',
      nextStep: step(snapshot, 'recheck')
    }
  }

  if (auth.state === 'signed_out') {
    return {
      headline: 'Not signed in',
      detail: auth.message ?? staleDetail,
      tone: 'neutral',
      nextStep: signInStep(snapshot)
    }
  }

  if (auth.state === 'expired') {
    return {
      headline: 'Sign-in expired',
      detail: auth.message ?? staleDetail,
      tone: 'warning',
      nextStep: signInStep(snapshot, 'Sign in again')
    }
  }

  if (compatibility.state === 'too_old') {
    return {
      headline: 'Version too old',
      detail: compatibility.testedRange ? `Use ${compatibility.testedRange} for full support.` : 'Update to a tested version.',
      tone: 'warning',
      nextStep: updateStep(snapshot)
    }
  }

  if (auth.state === 'refreshing') {
    return { headline: 'Refreshing sign-in', detail: staleDetail, tone: 'neutral', nextStep: null }
  }

  if (runs.state === 'unknown' || install.state === 'unknown') {
    return {
      headline: 'Not verified',
      detail: runs.message ?? staleDetail ?? 'Mousse could not fully verify this provider.',
      tone: 'warning',
      nextStep: step(snapshot, 'recheck')
    }
  }

  if (auth.state === 'unknown') {
    return {
      headline: 'Installed · Sign-in unverified',
      detail: auth.message ?? staleDetail,
      tone: 'neutral',
      // An agent that offers its sign-in methods can be signed in from here.
      nextStep: auth.canSignIn ? step(snapshot, 'sign_in') : step(snapshot, 'recheck')
    }
  }

  const headline = auth.state === 'signed_in'
    ? withLabel('Signed in', auth.account?.label ?? auth.methodLabel)
    : 'Available'
  // Allowed anyway: it runs, and the card keeps saying why it may not work.
  const allowed = problem?.allowed
    ? `Known problem with ${snapshot.binary?.version ?? 'this version'}: ${sentence(problem.reason)} Running it anyway, as you allowed.`
    : null
  const detail = allowed ?? (compatibility.state === 'newer_than_tested'
    ? `Newer than the versions Mousse was tested with${compatibility.testedRange ? ` (${compatibility.testedRange})` : ''}.`
    : snapshot.update?.latestVersion
      ? `Update available: ${snapshot.update.latestVersion}.`
      : null)
  return {
    headline,
    detail: staleDetail ?? detail,
    tone: allowed ? 'warning' : 'ready',
    nextStep: updateStep(snapshot) ?? (snapshot.stale ? step(snapshot, 'recheck') : null)
  }
}
