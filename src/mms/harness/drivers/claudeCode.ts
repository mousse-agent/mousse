import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallOwner } from '../../../shared/harness/status'
import type { HarnessCaps } from '../../../shared/harness/types'
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

/** Claude Code versions Mousse was tested with. */
export const CLAUDE_TESTED_VERSIONS = { min: '2.0.0', max: '2.1.999' }

export const CLAUDE_CODE_CAPS: HarnessCaps = Object.freeze({
  ...CLAUDE_SUBSCRIPTION_CAPABILITIES,
  planMode: true,
  contextUsage: 'reported'
})

/** The terminal sign-in command for an instance: its own home is passed as `CLAUDE_CONFIG_DIR`. */
export function claudeSignInCommand(home: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (!home) return 'claude auth login'
  return platform === 'win32'
    ? `$env:CLAUDE_CONFIG_DIR="${home}"; claude auth login`
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
      return { state: 'signed_in', methodLabel, ...(account?.label ? { account: { label: account.label } } : {}), ...(account?.subject ? { subject: account.subject } : {}) }
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
  return {
    kind: 'claude',
    label: 'Claude Code',
    binaryNames: cliNames('claude'),
    testedVersions: CLAUDE_TESTED_VERSIONS,
    multiInstance: true,
    privateHome: true,
    canInstall: false,
    methodLabel: 'Claude Code sign-in',
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: true }),
    caps: () => CLAUDE_CODE_CAPS,
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
      let owned = false
      if (context.builtIn && options.builtIn) service = options.builtIn()
      else {
        owned = true
        if (context.env.home) mkdirSync(context.env.home, { recursive: true, mode: 0o700 })
        const launch = (): StoredCliConfig => ({
          ...(context.config.binaryPath ? { binaryPath: context.config.binaryPath } : {}),
          ...(context.config.args ? { args: context.config.args } : {}),
          ...(context.config.env ? { env: context.config.env } : {})
        })
        const serviceOptions = {
          stateDir: context.stateDir,
          findBinary: context.findBinary,
          baseEnv: env,
          launchConfig: launch,
          signInCommand
        }
        service = options.createService?.(context, serviceOptions)
          ?? new ClaudeSubscriptionProviderService(context.profileHome, context.questions, serviceOptions)
      }
      const integrations = options.integrations?.(env) ?? null
      const adapter = new ClaudeSubscriptionAdapter(() => service, () => integrations)
      return {
        adapter,
        configured: () => service.configured(),
        configuredProvider: () => service.configuredProvider(),
        llmProvider: () => service.llmProvider(),
        models: () => service.models(),
        ...(context.builtIn
          ? {
              launch: () => service.storedLaunch(),
              setLaunch: async (patch) => void (await service.setCliConfig(patch))
            }
          : {}),
        auth: async ({ force }) => readAuth(service, await service.status({ force }), signInCommand),
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
          if (owned) service.stop()
        }
      }
    }
  }
}

/** Where an added Claude instance keeps its own Claude home. */
export function claudePrivateHome(stateDir: string): string {
  return join(stateDir, 'home')
}
