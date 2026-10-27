import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallOwner } from '../../../shared/harness/status'
import type { NativeToolTable } from '../../../shared/harness/tools'
import type { HarnessCaps } from '../../../shared/harness/types'
import type { CliProviderConfigPatch } from '../../../shared/providerAuth'
import type { StoredCliConfig } from '../../providers/cliConfig'
import {
  ClaudeSubscriptionProviderService
} from '../../providers/claudeSubscription/ClaudeSubscriptionProviderService'
import type { ClaudeIntegrationSource } from '../../providers/claudeSubscription/integrations'
import {
  CLAUDE_SUBSCRIPTION_CAPABILITIES,
  ClaudeSubscriptionAdapter
} from '../../run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { cliNames } from '../env'
import { decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver } from '../driver'
import { ALL_MIRROR_FIELDS, SIGN_OUT_MIRROR_FIELDS } from '../vendorMirror'

/** Claude Code versions Mousse was tested with. */
export const CLAUDE_TESTED_VERSIONS = { min: '2.0.0', max: '2.1.999' }

export const CLAUDE_CODE_CAPS: HarnessCaps = Object.freeze({
  ...CLAUDE_SUBSCRIPTION_CAPABILITIES,
  planMode: true,
  contextUsage: 'reported',
  // Claude Code asks Mousse through its permission callback under the mode Mousse sets.
  toolControl: 'approval_only',
  budgets: 'unsupported',
  spendLimits: 'unsupported'
})

/**
 * Claude Code's built-ins for each neutral tool (PR 6 §2). Every name exists in the pinned SDK's
 * `ToolInputSchemas` (`toolNames` test); the other built-ins have no neutral name and are never
 * granted.
 */
export const CLAUDE_NATIVE_TOOLS: NativeToolTable = Object.freeze({
  read: ['Read'],
  list: ['Glob'],
  search: ['Glob', 'Grep'],
  edit: ['Edit'],
  write: ['Write'],
  shell: ['Bash'],
  web_fetch: ['WebFetch'],
  web_search: ['WebSearch']
})

/**
 * The terminal sign-in command for an instance: its own home is passed as `CLAUDE_CONFIG_DIR`. On
 * Windows it runs through `cmd /c`, which works the same pasted into Command Prompt or PowerShell
 * and leaves the terminal's own environment unchanged.
 */
export function claudeSignInCommand(home: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (!home) return 'claude auth login'
  return platform === 'win32'
    ? `cmd /c "set CLAUDE_CONFIG_DIR=${home}&& claude auth login"`
    : `CLAUDE_CONFIG_DIR='${home.replace(/'/g, `'\\''`)}' claude auth login`
}

export interface ClaudeCodeDriverOptions {
  /** The profile's service for the built-in `claude` instance (shared with usage and Settings). */
  builtIn?: () => ClaudeSubscriptionProviderService
  /** The user's Mousse MCP servers and skills for an instance, resolved with its environment. */
  integrations?: (env: () => NodeJS.ProcessEnv) => ClaudeIntegrationSource | null
  /** Test seam: builds the service of an added instance. */
  createService?: (context: DriverContext, options: ConstructorParameters<typeof ClaudeSubscriptionProviderService>[2]) => ClaudeSubscriptionProviderService
}

function readAuth(service: ClaudeSubscriptionProviderService, status: Awaited<ReturnType<ClaudeSubscriptionProviderService['status']>>, signInCommand: string): AuthReading {
  const methodLabel = 'Claude Code sign-in'
  switch (status.state) {
    case 'connected': {
      const account = service.account()
      // What it runs on, as `claude auth status` said in this same check: never another one.
      return { state: 'signed_in', methodLabel, credential: account?.credential ?? 'unknown', ...(account?.label ? { account: { label: account.label } } : {}), ...(account?.subject ? { subject: account.subject } : {}) }
    }
    case 'signed_out':
      return { state: 'signed_out', methodLabel, message: status.message, signInCommand }
    case 'disconnected':
      return { state: 'signed_out', methodLabel, message: status.message, signInCommand }
    case 'missing_binary':
      return { state: 'unknown', methodLabel, message: status.message }
    default:
      return { state: 'unknown', methodLabel, ...(status.message ? { message: status.message } : {}) }
  }
}

/**
 * Claude Code through the official Agent SDK. The built-in `claude` instance runs exactly as the
 * user set Claude Code up (their home, settings and sign-in); an added instance gets its own
 * `CLAUDE_CONFIG_DIR`, signed in with Claude's own `claude auth login` in that home. Mousse never
 * handles Claude tokens.
 */
export function claudeCodeDriver(options: ClaudeCodeDriverOptions = {}): HarnessDriver {
  /**
   * The service of each added instance, kept across the runtimes a config change rebuilds: one
   * service, and so one writer, per instance's settings file, and a sign-in running when its own
   * executable prompt saves a path goes on. It reads the newest runtime's context, and stops when
   * the last runtime using it stops. A new home gets a new service; the old one stops writing.
   */
  const owned = new Map<string, OwnedService>()
  return {
    kind: 'claude',
    label: 'Claude Code',
    binaryNames: cliNames('claude'),
    testedVersions: CLAUDE_TESTED_VERSIONS,
    latestVersion: { kind: 'npm', package: '@anthropic-ai/claude-code' },
    multiInstance: true,
    privateHome: true,
    canInstall: false,
    customModels: true,
    methodLabel: 'Claude Code sign-in',
    // Mousse's own PreToolUse hook stamps each Mousse call with the turn's token (`updatedInput`).
    mcpTurnBinding: 'per_call',
    userMcp: 'native',
    // Claude Code passes MCP image content to the model, and every Claude model reads images.
    mcpImageResults: true,
    mirrorsVendorFile: true,
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: true }),
    caps: () => CLAUDE_CODE_CAPS,
    nativeToolNames: (neutral) => CLAUDE_NATIVE_TOOLS[neutral] ?? [],
    updateCommand: (owner: InstallOwner) => {
      if (owner === 'npm') return 'npm install -g @anthropic-ai/claude-code@latest'
      if (owner === 'brew') return 'brew upgrade claude-code'
      if (owner === 'standalone') return 'claude update'
      return undefined
    },
    create(context: DriverContext): DriverRuntime {
      const env = () => context.env.env
      const signInCommand = claudeSignInCommand(context.env.home)
      let service: ClaudeSubscriptionProviderService
      let entry: OwnedService | undefined
      const shared = Boolean(context.builtIn && options.builtIn)
      if (shared) service = options.builtIn!()
      else {
        if (context.env.home) mkdirSync(context.env.home, { recursive: true, mode: 0o700 })
        entry = owned.get(context.instanceId)
        if (entry && entry.home !== context.env.home) {
          // Another home: the old service keeps running its turns but never writes the file again.
          entry.service.freezeSettings()
          owned.delete(context.instanceId)
          entry = undefined
        }
        if (entry) entry.context = context
        else {
          // Every read goes to the newest runtime's context: its config, environment and binary lookup.
          const current = { context }
          const live = () => current.context
          const launch = (): StoredCliConfig => {
            const config = live().config
            return {
              ...(config.binaryPath ? { binaryPath: config.binaryPath } : {}),
              ...(config.args ? { args: config.args } : {}),
              ...(config.env ? { env: config.env } : {})
            }
          }
          const serviceOptions = {
            stateDir: context.stateDir,
            findBinary: () => live().findBinary(),
            baseEnv: () => live().env.env,
            launchConfig: launch,
            signedOut: () => live().signedOut(),
            saveLaunch: (patch: CliProviderConfigPatch) => live().saveLaunch(patch),
            signInCommand
          }
          const created = options.createService?.(context, serviceOptions)
            ?? new ClaudeSubscriptionProviderService(context.profileHome, context.questions, serviceOptions)
          entry = {
            service: created,
            home: context.env.home,
            users: 0,
            get context() { return current.context },
            set context(next) { current.context = next }
          }
          owned.set(context.instanceId, entry)
        }
        entry.users += 1
        service = entry.service
      }
      let stopped = false
      const integrations = options.integrations?.(env) ?? null
      const adapter = new ClaudeSubscriptionAdapter(() => service, () => integrations)
      return {
        adapter,
        configured: () => service.configured(),
        configuredProvider: () => service.configuredProvider(),
        llmProvider: () => service.llmProvider(),
        models: () => service.models(),
        modelsRefreshedAt: () => service.modelsRefreshedAt(),
        // The built-in instance mirrors its launch settings and sign-out to its settings.json for an
        // older Mousse; an added one only its sign-out (its launch settings were always in config).
        vendorMirror: service.vendorMirror(shared ? ALL_MIRROR_FIELDS : SIGN_OUT_MIRROR_FIELDS),
        ...(shared ? { validateLaunch: (patch: CliProviderConfigPatch) => service.validateLaunch(patch) } : {}),
        auth: async ({ force }) => readAuth(service, await service.status({ force }), signInCommand),
        // Read from the home and the variables Claude Code reads; `claude auth status` is the turn's own check.
        identity: async () => service.accountSubject(),
        refreshModels: async (cwd) => {
          await service.status()
          await service.refreshModels(cwd)
        },
        signIn: (session, cwd) => service.login(session, cwd),
        signOut: () => service.logout(),
        forgetConversation: (threadId) => service.forgetConversation(threadId),
        setLiveHost: (host) => service.setLiveHost(host),
        inFlightContinuation: (threadId) => service.inFlightContinuation(threadId),
        hasContinuation: (threadId, id) => service.hasContinuation(threadId, id),
        discardContinuations: (threadId, id) => service.discardContinuations(threadId, id),
        stop: () => {
          if (!entry || stopped) return
          stopped = true
          const user = entry
          user.users -= 1
          // A config change retires this runtime just before it builds the next one, which takes
          // the service over: it stops only when no runtime took it by then.
          queueMicrotask(() => {
            if (user.users > 0) return
            if (owned.get(context.instanceId) === user) owned.delete(context.instanceId)
            user.service.stop()
          })
        }
      }
    }
  }
}

/** The service of an added instance and the runtimes using it (`claudeCodeDriver`). */
interface OwnedService {
  service: ClaudeSubscriptionProviderService
  home: string | undefined
  /** The newest runtime's context, which the service reads. */
  context: DriverContext
  users: number
}

/** Where an added Claude instance keeps its own Claude home. */
export function claudePrivateHome(stateDir: string): string {
  return join(stateDir, 'home')
}
