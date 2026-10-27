import type { InstallOwner } from '../../../shared/harness/status'
import type { HarnessCaps } from '../../../shared/harness/types'
import type { CodexProviderService } from '../../providers/codex/CodexProviderService'
import { CODEX_CAPABILITIES, CodexAdapter } from '../../run/adapters/codex/CodexAdapter'
import { cliNames } from '../env'
import { decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver, type InstanceConfig } from '../driver'
import { createManagedCodexRuntime } from '../codex/managedRuntime'

/** Codex CLI versions Mousse was tested with. */
export const CODEX_TESTED_VERSIONS = { min: '0.100.0', max: '0.162.999' }

export const CODEX_CAPS: HarnessCaps = Object.freeze({
  ...CODEX_CAPABILITIES,
  planMode: true,
  contextUsage: 'reported',
  // Codex asks Mousse before each tool under the approval policy Mousse sets.
  toolControl: 'approval_only',
  budgets: 'unsupported',
  spendLimits: 'unsupported'
})

const SIGN_IN_COMMAND = 'codex login'

function readAuth(service: CodexProviderService, status: Awaited<ReturnType<CodexProviderService['status']>>): AuthReading {
  const methodLabel = 'ChatGPT sign-in'
  switch (status.state) {
    case 'connected': {
      const account = service.account()
      return { state: 'signed_in', methodLabel, ...(account?.label ? { account: { label: account.label } } : {}), ...(account?.subject ? { subject: account.subject } : {}) }
    }
    case 'signed_out':
    case 'disconnected':
      return { state: 'signed_out', methodLabel, message: status.message, signInCommand: SIGN_IN_COMMAND }
    default:
      return { state: 'unknown', methodLabel, ...(status.message ? { message: status.message } : {}) }
  }
}

/**
 * Codex's own config: `setup` (absent = `existing`, so the built-in entry is unchanged). A managed
 * entry always runs in its private home; the user's own Codex never does, whatever was stored.
 */
export function decodeCodexConfig(raw: Record<string, unknown> | undefined): InstanceConfig {
  const managed = raw?.setup === 'managed'
  const config = decodeInstanceConfig(raw, { privateHome: managed })
  if (managed) return { ...config, setup: 'managed', home: 'private' }
  if (raw?.home === 'private') console.warn('[codex] a private home on an entry using your own Codex is ignored')
  return { ...config, ...(raw?.setup === 'existing' ? { setup: 'existing' as const } : {}) }
}

/**
 * Codex through `codex app-server`. The built-in entry (`setup: existing`) reuses the terminal
 * `codex login`; a managed entry (`setup: managed`) runs Mousse's pinned Codex in its own home and
 * signs in with ChatGPT in Mousse (`codex/managedRuntime.ts`).
 */
export function codexDriver(options: { builtIn: () => CodexProviderService; managed?: (context: DriverContext) => DriverRuntime }): HarnessDriver {
  return {
    kind: 'codex',
    label: 'Codex',
    binaryNames: cliNames('codex'),
    testedVersions: CODEX_TESTED_VERSIONS,
    latestVersion: { kind: 'npm', package: '@openai/codex' },
    multiInstance: true,
    privateHome: true,
    privateHomeFor: (config) => (config.setup === 'managed' ? 'required' : 'forbidden'),
    canInstall: true,
    customModels: true,
    methodLabel: 'ChatGPT sign-in',
    // Codex forks a loaded thread when its bearer changes, so the bearer is kept after turns proven drained.
    mcpTurnBinding: 'drained_turn',
    userMcp: 'native',
    // Codex passes MCP image content to the model; the ChatGPT models it runs read images.
    mcpImageResults: true,
    decodeConfig: decodeCodexConfig,
    caps: () => CODEX_CAPS,
    updateCommand: (owner: InstallOwner) => {
      if (owner === 'npm') return 'npm install -g @openai/codex@latest'
      if (owner === 'brew') return 'brew upgrade codex'
      return undefined
    },
    create(context: DriverContext): DriverRuntime {
      if (context.config.setup === 'managed') return (options.managed ?? createManagedCodexRuntime)(context)
      const service = options.builtIn()
      return {
        adapter: new CodexAdapter(() => service),
        configured: () => service.configured(),
        configuredProvider: () => service.configuredProvider(),
        llmProvider: () => service.llmProvider(),
        models: () => service.models(),
        modelsRefreshedAt: () => service.modelsRefreshedAt(),
        launch: () => service.storedLaunch(),
        setLaunch: async (patch) => void (await service.setCliConfig(patch)),
        auth: async ({ force }) => readAuth(service, await service.status({ force })),
        refreshModels: async () => {
          await service.status()
          await service.refreshModels()
        },
        signIn: (session, cwd) => service.login(session, cwd),
        signOut: () => service.logout(),
        forgetConversation: (threadId) => service.forgetConversation(threadId),
        // The profile owns the built-in service and stops it.
        stop: () => {}
      }
    }
  }
}
