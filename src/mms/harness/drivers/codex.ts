import type { InstallOwner } from '../../../shared/harness/status'
import type { HarnessCaps } from '../../../shared/harness/types'
import type { CodexProviderService } from '../../providers/codex/CodexProviderService'
import { CODEX_CAPABILITIES, CodexAdapter } from '../../run/adapters/codex/CodexAdapter'
import { cliNames } from '../env'
import { decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver } from '../driver'

/** Codex CLI versions Mousse was tested with. */
export const CODEX_TESTED_VERSIONS = { min: '0.100.0', max: '0.162.999' }

export const CODEX_CAPS: HarnessCaps = Object.freeze({
  ...CODEX_CAPABILITIES,
  planMode: true,
  contextUsage: 'reported'
})

const SIGN_IN_COMMAND = 'codex login'

function readAuth(service: CodexProviderService, status: Awaited<ReturnType<CodexProviderService['status']>>): AuthReading {
  const methodLabel = 'ChatGPT sign-in'
  switch (status.state) {
    case 'connected':
      return { state: 'signed_in', methodLabel, ...(service.account() ? { account: service.account() } : {}) }
    case 'signed_out':
    case 'disconnected':
      return { state: 'signed_out', methodLabel, message: status.message, signInCommand: SIGN_IN_COMMAND }
    default:
      return { state: 'unknown', methodLabel, ...(status.message ? { message: status.message } : {}) }
  }
}

/**
 * Codex through `codex app-server`, reusing the terminal `codex login` (ChatGPT sign-in). PR 1 has
 * only the built-in `codex` instance; a managed Codex with its own home arrives with Sign in with
 * ChatGPT.
 */
export function codexDriver(options: { builtIn: () => CodexProviderService }): HarnessDriver {
  return {
    kind: 'codex',
    label: 'Codex',
    binaryNames: cliNames('codex'),
    testedVersions: CODEX_TESTED_VERSIONS,
    multiInstance: false,
    privateHome: false,
    canInstall: false,
    methodLabel: 'ChatGPT sign-in',
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    caps: () => CODEX_CAPS,
    updateCommand: (owner: InstallOwner) => {
      if (owner === 'npm') return 'npm install -g @openai/codex@latest'
      if (owner === 'brew') return 'brew upgrade codex'
      return undefined
    },
    create(_context: DriverContext): DriverRuntime {
      const service = options.builtIn()
      return {
        adapter: new CodexAdapter(() => service),
        configured: () => service.configured(),
        configuredProvider: () => service.configuredProvider(),
        llmProvider: () => service.llmProvider(),
        models: () => service.models(),
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
