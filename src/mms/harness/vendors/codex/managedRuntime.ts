import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CHATGPT_USAGE_URL } from '../../../../shared/providerAuth'
import type { LlmModelOption } from '../../../../shared/settings'
import { chatgptTokenCommand, type CliCommand } from '../../../run/mcp/attachment'
import { CODEX_PROVIDER_ID, codexEnvironment, CodexProviderService, type CodexAccountReading } from './CodexProviderService'
import { CodexAdapter } from '../../drivers/codex/adapter'
import { ChatGptAuth, type ChatGptAuthOptions, type ChatGptStatus } from '../../chatgpt/chatgptAuth'
import type { ChatGptModel } from '../../chatgpt/models'
import type { AuthReading, DriverContext, DriverRuntime, RuntimeUsage } from '../../driver'
import type { UseLimitResetResponse } from '../../../../shared/providerAuth'
import type { RateLimitSnapshot } from './protocol'
import { reportedUsageWindows, snapshotPlan, snapshotResets } from './rateLimits'
import { chatgptTokenBroker, type ChatGptTokenBroker } from './broker'
import { CodexInstallation } from './installation'
import { CODEX_MANAGED_VERSION } from './release'
import { telemetryOf } from '../../telemetry'

/**
 * A Codex entry Mousse manages: its own pinned download, a private `CODEX_HOME` and Sign in with
 * ChatGPT. Codex never sees a refresh token or a token file: each app-server launch gets a broker
 * lease, and Codex asks the token helper (`mousse-cli engine chatgpt-token`) for an access token
 * whenever it needs one (`auth.command`, `refresh_interval_ms=0`).
 */

/** OpenAI's provider id for ChatGPT plan use. Codex records it in its rollouts, so it never changes. */
export const MANAGED_MODEL_PROVIDER = 'openai_chatgpt_plan'
export const CHATGPT_API_BASE_URL = 'https://api.openai.com/v1'
/** Codex kills the helper after this; the helper gives up at 78 s, the broker at 75 s. */
export const TOKEN_COMMAND_TIMEOUT_MS = 80_000
export const MANAGED_METHOD_LABEL = 'ChatGPT plan'
/** A TOML value from JSON: JSON strings, numbers and booleans are valid TOML. */
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, entry]) => `${key}=${toml(entry)}`).join(',')}}`
  return JSON.stringify(value)
}

/**
 * Codex features that reach chatgpt.com or GitHub on their own (ChatGPT apps and connectors,
 * plugins and their marketplace, update checks, tool and skill suggestions). A managed entry uses
 * none of them, and ChatGPT plan use must not call ChatGPT's backend: the wire test
 * (`codexManagedWire.test.ts`) saw chatgpt.com, github.com and api.github.com contacted without
 * these and the analytics switch, and nothing with them. Analytics is the entry's telemetry
 * setting (Settings → Providers, Off by default: `-c analytics.enabled=false`).
 */
export const MANAGED_OFFLINE_OVERRIDES = [
  'features.apps=false',
  'features.plugins=false',
  'features.remote_plugin=false',
  'features.plugin_sharing=false',
  'features.in_app_updates=false',
  'features.tool_suggest=false',
  'features.skill_search=false',
  'check_for_update_on_startup=false'
] as const

/**
 * The `-c` overrides one managed app-server starts with. `requires_openai_auth` and `env_key` are
 * left out: the provider authenticates through `auth` alone. Codex's own multi-agent tools stay
 * off, as ChatGPT plan use asks. No `model_catalog_url`: Codex 0.162.1 lists `<base_url>/models`
 * through the same `auth` command on its own (wire test), and Mousse always sends the model.
 */
export function managedCodexConfigArgs(helper: Pick<CliCommand, 'command' | 'args'>, options: { baseUrl?: string } = {}): string[] {
  const provider = {
    name: 'ChatGPT plan',
    base_url: options.baseUrl ?? CHATGPT_API_BASE_URL,
    wire_api: 'responses',
    supports_websockets: false,
    auth: { command: helper.command, args: helper.args, timeout_ms: TOKEN_COMMAND_TIMEOUT_MS, refresh_interval_ms: 0 }
  }
  return [
    '-c', `model_provider=${toml(MANAGED_MODEL_PROVIDER)}`,
    '-c', `model_providers.${MANAGED_MODEL_PROVIDER}=${toml(provider)}`,
    '-c', 'features.multi_agent=false',
    '-c', 'features.multi_agent_v2=false',
    ...MANAGED_OFFLINE_OVERRIDES.flatMap((override) => ['-c', override])
  ]
}

/** What a sign-in check reads from the ChatGPT store. */
export function managedAuthReading(status: ChatGptStatus, subject: string | undefined): AuthReading {
  const base = { methodLabel: MANAGED_METHOD_LABEL, ownedByMousse: true, canSignIn: true } as const
  switch (status.state) {
    case 'signed_in':
      return { ...base, state: 'signed_in', ...(status.label ? { account: { label: status.label } } : {}), ...(subject ? { subject } : {}) }
    case 'expired':
      return { ...base, state: 'expired', ...(status.message ? { message: status.message } : {}) }
    case 'signed_out':
    case 'sharing_disabled':
      return { ...base, state: 'signed_out', ...(status.message ? { message: status.message } : {}) }
    default:
      return { ...base, state: 'unknown', ...(status.message ? { message: status.message } : {}) }
  }
}

/**
 * A managed entry's usage: the windows of a snapshot of the plan's limits, with ChatGPT's own page
 * beside it. A snapshot read just now (`live`) is undated; one Codex sent on an earlier turn
 * (`account/rateLimits/updated`) says when.
 */
export function managedCodexUsage(signedIn: boolean, reported: { snapshot: RateLimitSnapshot; at: number } | undefined, nowMs: number, options: { live?: boolean } = {}): RuntimeUsage {
  const link = { manageUrl: CHATGPT_USAGE_URL }
  if (!signedIn) return { status: 'unavailable', windows: [], message: 'Sign in with ChatGPT to see limits.', ...link }
  if (!reported) return { status: 'unavailable', windows: [], message: 'Limits show after the next turn.', ...link }
  const windows = reportedUsageWindows(reported.snapshot, nowMs)
  if (!windows.length) return { status: 'unavailable', windows: [], message: 'No limits reported for this plan.', ...link }
  const plan = snapshotPlan(reported.snapshot)
  const resets = snapshotResets(reported.snapshot)
  return { status: 'available', windows, ...(plan ? { plan } : {}), ...(resets ? { resets } : {}), ...(options.live ? {} : { readAt: new Date(reported.at).toISOString() }), ...link }
}

/** A turn's snapshot younger than this is shown as it is; an older one is read again. */
export const REPORTED_LIMITS_FRESH_MS = 5 * 60_000

/** The user's own Codex CLI (the profile's built-in Codex service), as far as reading limits goes. */
export type UserCodexLimits = Pick<CodexProviderService, 'status' | 'account' | 'rateLimits' | 'consumeResetCredit'>

/**
 * Uses a limit reset through the user's own Codex CLI, only when it is signed in to the same ChatGPT
 * account as the managed entry: never another account's credit. Throws when it is not.
 */
export async function useUserCodexReset(userCodex: UserCodexLimits | undefined, email: string | null | undefined, creditId: string | undefined, signal?: AbortSignal): Promise<UseLimitResetResponse> {
  const wanted = email?.trim().toLowerCase()
  if (!userCodex || !wanted) throw new Error('Codex CLI is not available to use a reset.')
  // Read the CLI's sign-in now, not a cached one: a credit must never be spent for an account that just changed.
  await userCodex.status({ force: true })
  if (userCodex.account()?.subject !== `chatgpt:${wanted}`) throw new Error('Codex CLI is signed in to another account.')
  return userCodex.consumeResetCredit(creditId, signal)
}

/**
 * The plan's limits read now through the user's own Codex CLI and its stored sign-in
 * (`account/rateLimits/read`: Codex asks its own backend; Mousse calls nothing itself), only when
 * that sign-in is the same ChatGPT account as the managed one (by email). Undefined otherwise or
 * when the read fails, so another account's limits are never shown here.
 */
export async function userCodexLimits(userCodex: UserCodexLimits | undefined, email: string | null | undefined, signal?: AbortSignal): Promise<{ snapshot: RateLimitSnapshot; at: number } | undefined> {
  const wanted = email?.trim().toLowerCase()
  if (!userCodex || !wanted) return undefined
  try {
    await userCodex.status()
    if (signal?.aborted || userCodex.account()?.subject !== `chatgpt:${wanted}`) return undefined
    const read = await userCodex.rateLimits(signal)
    return read.live ? { snapshot: read.snapshot, at: read.at } : undefined
  } catch {
    return undefined
  }
}

function modelOption(model: ChatGptModel): LlmModelOption {
  const efforts = model.capabilities.efforts
  return { id: model.id, label: model.label, ...(efforts?.length ? { efforts: [...efforts] } : {}) }
}

/** The installs of one installation home, shared by its profiles in this process (leases count here). */
const installations = new Map<string, CodexInstallation>()

export function sharedCodexInstallation(installationHome: string): CodexInstallation {
  let installation = installations.get(installationHome)
  if (!installation) {
    installation = new CodexInstallation({ installationHome })
    installations.set(installationHome, installation)
  }
  return installation
}

/** How long `configured()` trusts its last read of the ChatGPT store. */
const SIGNED_IN_CACHE_MS = 2_000
/** A failed model listing is tried again after this, at the next sign-in check. */
const MODEL_RETRY_MS = 60_000

/**
 * The Codex services of every live revision of an entry (by profile home and instance id): a
 * credential change stops them all, a revision a reconfiguration replaced included.
 */
const revisions = new Map<string, Set<CodexProviderService>>()

function trackRevision(key: string, service: CodexProviderService): void {
  let set = revisions.get(key)
  if (!set) revisions.set(key, (set = new Set()))
  set.add(service)
}

function untrackRevision(key: string, service: CodexProviderService): void {
  const set = revisions.get(key)
  set?.delete(service)
  if (set && !set.size) revisions.delete(key)
}

/** Stops every revision's app-servers and awaits their exit; rejects when any of them could not be stopped. */
async function stopEveryRevision(key: string): Promise<void> {
  const results = await Promise.allSettled([...(revisions.get(key) ?? [])].map((service) => service.stopAll('account_changed')))
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) throw failed.reason
}

export interface ManagedCodexDependencies {
  installation?: CodexInstallation
  broker?: ChatGptTokenBroker
  /** Builds the instance's ChatGPT sign-in (tests: fake endpoints). */
  auth?: (options: ChatGptAuthOptions) => ChatGptAuth
  service?: ConstructorParameters<typeof CodexProviderService>[2]
  helper?: (endpoint: string, leaseId: string) => CliCommand
  baseUrl?: string
  /** The user's own Codex CLI, to read the plan's limits when it is signed in to the same account. */
  userCodex?: () => UserCodexLimits
}

export function createManagedCodexRuntime(context: DriverContext, deps: ManagedCodexDependencies = {}): DriverRuntime {
  const installation = deps.installation ?? sharedCodexInstallation(context.installationHome)
  /** The install a launch may use: none while it is broken. */
  const runnableInstall = () => {
    const installed = installation.installed()
    return installed && !installed.broken ? installed : undefined
  }
  const broker = deps.broker ?? chatgptTokenBroker()
  const helper = deps.helper ?? ((endpoint, leaseId) => chatgptTokenCommand(endpoint, leaseId))
  // The profile key the newest process was launched with; a different one in the store means the
  // account changed under it.
  let launchedKey: string | undefined
  let service: CodexProviderService | undefined
  const servicesKey = `${context.profileHome}\u0000${context.instanceId}`
  // Every revision of the entry: one a reconfiguration replaced may still finish a turn.
  const stopProcesses = async (): Promise<void> => {
    broker.revokeInstance(context.instanceId)
    launchedKey = undefined
    clearModelsOnChange?.()
    await stopEveryRevision(servicesKey)
  }
  let clearModelsOnChange: (() => void) | undefined
  const auth = (deps.auth ?? ((options) => new ChatGptAuth(options)))({
    instanceId: context.instanceId,
    profileHome: context.profileHome,
    installationHome: context.installationHome,
    // Saved first, then everything on the old key stops, then the old token is revoked.
    onCredentialChange: stopProcesses
  })
  const home = context.env.home
  const account = async (): Promise<CodexAccountReading> => {
    const status = auth.status()
    if (status.state !== 'signed_in') return { kind: 'signed_out', message: status.message ?? 'Sign in with ChatGPT.' }
    if (launchedKey !== undefined && auth.profileKey() !== launchedKey) {
      // The process runs on a connection that is no longer the active one: it stops, and the next
      // turn starts a new one with a new lease.
      void stopProcesses().catch(() => {})
      return { kind: 'error', message: 'The ChatGPT account changed. Send the message again.' }
    }
    return { kind: 'signed_in', planType: 'chatgpt', email: null, ...(status.label ? { label: status.label } : {}), ...(auth.identity() ? { subject: auth.identity() } : {}) }
  }
  service = new CodexProviderService(context.profileHome, context.questions, { ...deps.service, findBinary: () => runnableInstall()?.path }, {
    dir: join(context.stateDir, 'codex'),
    env: () => codexEnvironment(context.env.env),
    // Off by default for a managed entry; the user may give it back to Codex's own setting.
    telemetry: () => telemetryOf(context),
    clientInfo: { name: 'Mousse', title: 'Mousse' },
    modelProvider: MANAGED_MODEL_PROVIDER,
    account: { read: account },
    models: { list: async (signal) => (await auth.listModels(signal)).map(modelOption) },
    prepareLaunch: async (signal) => {
      const installed = installation.installed()
      if (!installed) throw new Error('Codex is not installed. Install it in Settings → Providers.')
      // A broken install (not the pin, incomplete, or changed since install) never runs.
      if (installed.broken) throw new Error(`Codex cannot start: ${installed.broken.replace(/ Reinstall it\.$/, '')} Reinstall Codex in Settings → Providers.`)
      if (home) mkdirSync(home, { recursive: true, mode: 0o700 })
      // A fresh token first, so a refresh never races the process's first request.
      const access = await auth.access(undefined, signal)
      const endpoint = await broker.start()
      const lease = broker.register({
        profileId: basename(context.profileHome),
        instanceId: context.instanceId,
        profileKey: access.profileKey,
        access: async (leaseSignal) => (await auth.access(access.profileKey, leaseSignal)).accessToken
      })
      const releaseInstall = installation.acquire()
      launchedKey = access.profileKey
      const command = helper(endpoint, lease.leaseId)
      return {
        args: managedCodexConfigArgs(command, { baseUrl: deps.baseUrl }),
        env: command.env,
        onExit: () => {
          lease.release()
          releaseInstall()
        }
      }
    }
  })
  const codex = service
  trackRevision(servicesKey, codex)
  clearModelsOnChange = () => {
    signedIn = undefined
    discovery = {}
    codex.clearModels()
  }
  let installAbort: AbortController | undefined
  // The plan's models are listed once a signed-in check finds none (after sign-in, after an
  // account switch cleared them); a failed listing is tried again a minute later.
  let discovery: { running?: Promise<void>; failedAt?: number } = {}
  const discoverModels = (): void => {
    if (codex.models().length || discovery.running) return
    if (discovery.failedAt !== undefined && Date.now() - discovery.failedAt < MODEL_RETRY_MS) return
    // Each listing writes back only into its own state: one an account change replaced (cleared
    // with `discovery = {}`) neither blocks nor overwrites the listing for the new account.
    const own: { running?: Promise<void>; failedAt?: number } = {}
    discovery = own
    own.running = codex.refreshModels().then(
      () => {
        if (discovery !== own) return
        discovery = {}
        context.changed()
      },
      () => {
        if (discovery === own) discovery = { failedAt: Date.now() }
      }
    )
  }

  // Ready from Mousse's own state: an installed, unbroken Codex and a signed-in ChatGPT
  // connection. The store read is local; it is cached briefly because listings call it often.
  let signedIn: { at: number; value: boolean } | undefined
  const configured = (): boolean => {
    const installed = installation.installed()
    if (!installed || installed.broken) return false
    if (!signedIn || Date.now() - signedIn.at > SIGNED_IN_CACHE_MS) signedIn = { at: Date.now(), value: auth.status().state === 'signed_in' }
    return signedIn.value
  }
  return {
    adapter: new CodexAdapter(() => codex, { managed: true }),
    configured,
    llmProvider: () => (configured() ? { id: CODEX_PROVIDER_ID, label: 'Codex', models: codex.models() } : undefined),
    models: () => codex.models(),
    modelsRefreshedAt: () => codex.modelsRefreshedAt(),
    // `default` runs the plan's first listed model, fixed when the turn is bound.
    concreteModel: (model) => (model && model !== 'default' ? model : codex.models()[0]?.id),
    auth: async () => {
      const reading = managedAuthReading(auth.status(), auth.identity())
      if (reading.state === 'signed_in') discoverModels()
      return reading
    },
    identity: async () => auth.identity(),
    // Mousse calls no ChatGPT backend itself: the limits are the ones Codex reported on the plan's
    // last turn while fresh, else read now by the user's own Codex CLI for the same account, else
    // the last snapshot, dated.
    usage: async (signal) => {
      const status = auth.status()
      if (status.state !== 'signed_in') return managedCodexUsage(false, undefined, Date.now())
      const identity = auth.identity()
      const reported = codex.reportedRateLimits(identity)
      if (reported && Date.now() - reported.at < REPORTED_LIMITS_FRESH_MS) return managedCodexUsage(true, reported, Date.now())
      const live = await userCodexLimits(deps.userCodex?.(), status.email, signal)
      if (!live) return managedCodexUsage(true, reported, Date.now())
      codex.keepRateLimits(live.snapshot, identity)
      return managedCodexUsage(true, live, Date.now(), { live: true })
    },
    // A reset is used through the user's own Codex CLI for the same account, then the limits are kept.
    useLimitReset: async (creditId, signal) => {
      const status = auth.status()
      if (status.state !== 'signed_in') throw new Error('Sign in with ChatGPT first.')
      const userCodex = deps.userCodex?.()
      const result = await useUserCodexReset(userCodex, status.email, creditId, signal)
      const live = await userCodexLimits(userCodex, status.email, signal)
      if (live) codex.keepRateLimits(live.snapshot, auth.identity())
      return result
    },
    refreshModels: async () => void (await codex.refreshModels()),
    signIn: (session, _cwd, method) => auth.signIn(session, method),
    signOut: async () => {
      const result = await auth.signOut()
      if (!result.confirmed) console.warn('[codex] ChatGPT sign-out saved; revocation not confirmed', { instanceId: context.instanceId, message: result.message })
    },
    deleteCredentials: async () => {
      const result = await auth.deleteInstance()
      if (!result.confirmed) console.warn('[codex] ChatGPT connections deleted; revocation not confirmed', { instanceId: context.instanceId, message: result.message })
    },
    install: async (onProgress) => {
      const unsupported = installation.unsupportedMessage()
      if (unsupported) throw new Error(unsupported)
      installAbort = new AbortController()
      try {
        await installation.install(onProgress, installAbort.signal)
      } finally {
        installAbort = undefined
      }
    },
    cancelInstall: () => installation.cancel(),
    installState: () => ({ installing: installation.installing() }),
    managed: () => {
      const installed = installation.installed()
      if (!installed) return undefined
      return { path: installed.path, version: installed.version, ...(installed.bytes !== undefined ? { bytes: installed.bytes } : {}), ...(installed.broken ? { broken: installed.broken } : {}) }
    },
    pinned: () => ({ version: CODEX_MANAGED_VERSION }),
    // A failed check is kept by the installation: `managed().broken` reports it and no launch
    // runs until a later check passes or a reinstall replaces the files.
    verifyInstall: async (signal) => {
      const problem = await installation.verify(signal)
      if (problem) console.warn('[codex] the managed Codex install failed its check', { instanceId: context.instanceId, problem })
    },
    removeInstall: (options) => installation.removeInstall(options),
    forgetConversation: (threadId) => codex.forgetConversation(threadId),
    compactConversation: (request) => codex.compactConversation(request.threadId, request.history, request.instanceId, request.signal),
    stop: () => {
      // The gateway stops a runtime once its turns end, the newest one included (removal, shutdown).
      // It stays tracked until its last process has exited: a credential change meanwhile still
      // stops and awaits it before anything is revoked.
      codex.stop()
      void codex.processesExited().finally(() => untrackRevision(servicesKey, codex))
    }
  }
}
