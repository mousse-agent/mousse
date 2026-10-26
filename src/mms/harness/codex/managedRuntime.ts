import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { LlmModelOption } from '../../../shared/settings'
import { chatgptTokenCommand, type CliCommand } from '../../run/mcp/attachment'
import { codexEnvironment, CodexProviderService, type CodexAccountReading } from '../../providers/codex/CodexProviderService'
import { CodexAdapter } from '../../run/adapters/codex/CodexAdapter'
import { ChatGptAuth, type ChatGptAuthOptions, type ChatGptStatus } from '../chatgpt/chatgptAuth'
import type { ChatGptModel } from '../chatgpt/models'
import type { AuthReading, DriverContext, DriverRuntime } from '../driver'
import { chatgptTokenBroker, type ChatGptTokenBroker } from './broker'
import { CodexInstallation } from './installation'
import { CODEX_MANAGED_VERSION } from './release'

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
 * The `-c` overrides one managed app-server starts with. `requires_openai_auth` and `env_key` are
 * left out: the provider authenticates through `auth` alone. Codex's own multi-agent tools stay
 * off, as ChatGPT plan use asks.
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
    '-c', 'features.multi_agent_v2=false'
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

export interface ManagedCodexDependencies {
  installation?: CodexInstallation
  broker?: ChatGptTokenBroker
  /** Builds the instance's ChatGPT sign-in (tests: fake endpoints). */
  auth?: (options: ChatGptAuthOptions) => ChatGptAuth
  service?: ConstructorParameters<typeof CodexProviderService>[2]
  helper?: (endpoint: string, leaseId: string) => CliCommand
  baseUrl?: string
}

export function createManagedCodexRuntime(context: DriverContext, deps: ManagedCodexDependencies = {}): DriverRuntime {
  const installation = deps.installation ?? sharedCodexInstallation(context.installationHome)
  const broker = deps.broker ?? chatgptTokenBroker()
  const helper = deps.helper ?? ((endpoint, leaseId) => chatgptTokenCommand(endpoint, leaseId))
  // The profile key the newest process was launched with; a different one in the store means the
  // account changed under it.
  let launchedKey: string | undefined
  let service: CodexProviderService | undefined
  const stopProcesses = async (): Promise<void> => {
    broker.revokeInstance(context.instanceId)
    launchedKey = undefined
    await service?.stopAll('account_changed')
  }
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
  service = new CodexProviderService(context.profileHome, context.questions, { ...deps.service, findBinary: () => installation.installed()?.path }, {
    dir: join(context.stateDir, 'codex'),
    env: () => codexEnvironment(context.env.env),
    clientInfo: { name: 'Mousse', title: 'Mousse' },
    modelProvider: MANAGED_MODEL_PROVIDER,
    account: { read: account },
    models: { list: async (signal) => (await auth.listModels(signal)).map(modelOption) },
    prepareLaunch: async (signal) => {
      if (!installation.installed()) throw new Error('Codex is not installed. Install it in Settings → Providers.')
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
  let installAbort: AbortController | undefined
  return {
    adapter: new CodexAdapter(() => codex, { managed: true }),
    configured: () => codex.configured(),
    llmProvider: () => codex.llmProvider(),
    models: () => codex.models(),
    // `default` runs the plan's first listed model, fixed when the turn is bound.
    concreteModel: (model) => (model && model !== 'default' ? model : codex.models()[0]?.id),
    auth: async () => managedAuthReading(auth.status(), auth.identity()),
    identity: async () => auth.identity(),
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
    verifyInstall: async (signal) => void (await installation.verify(signal)),
    removeInstall: (options) => installation.removeInstall(options),
    forgetConversation: (threadId) => codex.forgetConversation(threadId),
    stop: () => {
      broker.revokeInstance(context.instanceId)
      codex.stop()
    }
  }
}
