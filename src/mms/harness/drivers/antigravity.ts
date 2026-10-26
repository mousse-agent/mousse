import type { HarnessCaps } from '../../../shared/harness/types'
import type { AntigravityProviderService } from '../../providers/antigravity/AntigravityProviderService'
import { ANTIGRAVITY_RELEASE, validateManualAntigravityBinary } from '../../providers/antigravity/installation'
import { ANTIGRAVITY_CAPABILITIES, AntigravityAdapter } from '../../run/adapters/antigravity/AntigravityAdapter'
import { decodeInstanceConfig, type DriverContext, type DriverRuntime, type HarnessDriver } from '../driver'

/** The pinned agent release Mousse installs and verifies. */
export const ANTIGRAVITY_VERSION = ANTIGRAVITY_RELEASE.replace(/^agy_acp_server_/, '')

/** Antigravity publishes no context window, and Mousse offers no Plan mode for it. */
export const ANTIGRAVITY_CAPS: HarnessCaps = Object.freeze({
  ...ANTIGRAVITY_CAPABILITIES,
  planMode: false,
  contextUsage: 'none'
})

/**
 * Google's Antigravity ACP agent. Mousse installs the pinned, hash-verified release into the
 * installation (one click; the install owner is Mousse), or runs a manual agent path.
 */
export function antigravityDriver(options: { builtIn: () => AntigravityProviderService }): HarnessDriver {
  return {
    kind: 'antigravity',
    label: 'Google Antigravity',
    // Never searched on PATH: only the verified install or a manual path runs.
    binaryNames: [],
    testedVersions: { min: ANTIGRAVITY_VERSION, max: ANTIGRAVITY_VERSION },
    multiInstance: false,
    privateHome: false,
    canInstall: true,
    // The agent offers the models of the signed-in account only.
    customModels: false,
    methodLabel: 'Google sign-in',
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    caps: () => ANTIGRAVITY_CAPS,
    updateCommand: () => undefined,
    create(_context: DriverContext): DriverRuntime {
      const service = options.builtIn()
      return {
        adapter: new AntigravityAdapter(() => service),
        configured: () => service.configured(),
        configuredProvider: () => service.configuredProvider(),
        llmProvider: () => service.llmProvider(),
        models: () => service.models(),
        launch: () => service.storedLaunch(),
        setLaunch: async (patch) => void (await service.setCliConfig(patch)),
        // The sign-in is the profile's saved Google session; checking it would start the agent. It
        // changes only through Mousse's own sign-in and sign-out, which move the account generation
        // on, so the session itself is the account's identity.
        auth: async () =>
          service.signedIn()
            ? { state: 'signed_in', methodLabel: 'Google sign-in', subject: 'mousse-google-sign-in' }
            : { state: 'signed_out', methodLabel: 'Google sign-in' },
        refreshModels: async (cwd) => void (await service.refreshModels(cwd)),
        signIn: (session, cwd) => service.login(session, cwd),
        signOut: () => service.logout(),
        install: async (onProgress) => void (await service.install(onProgress)),
        cancelInstall: () => service.cancelInstall(),
        installState: () => service.installState(),
        managed: () => {
          const path = service.managedBinary()
          return path ? { path, version: ANTIGRAVITY_VERSION } : undefined
        },
        validateOverride: (path) => void validateManualAntigravityBinary(path),
        forgetConversation: (threadId) => service.forgetConversation(threadId),
        stop: () => {}
      }
    }
  }
}
