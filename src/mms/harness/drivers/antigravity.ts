import type { HarnessCaps } from '../../../shared/harness/types'
import type { AntigravityProviderService } from '../../providers/antigravity/AntigravityProviderService'
import { ANTIGRAVITY_RELEASE, validateManualAntigravityBinary } from '../../providers/antigravity/installation'
import { AcpAdapter, type AcpTurnClient } from '../../run/adapters/acp/AcpAdapter'
import { ANTIGRAVITY_CAPABILITIES, ANTIGRAVITY_LABEL } from '../acp/presets/antigravity'
import { decodeInstanceConfig, type DriverContext, type DriverRuntime, type HarnessDriver } from '../driver'
import { LAUNCH_MIRROR_FIELDS } from '../vendorMirror'

/** The pinned agent release Mousse installs and verifies. */
export const ANTIGRAVITY_VERSION = ANTIGRAVITY_RELEASE.replace(/^agy_acp_server_/, '')

/** Antigravity publishes no context window, and Mousse offers no Plan mode for it. */
export const ANTIGRAVITY_CAPS: HarnessCaps = Object.freeze({
  ...ANTIGRAVITY_CAPABILITIES,
  planMode: false,
  contextUsage: 'none',
  // The agent asks Mousse for every tool permission and file write.
  toolControl: 'approval_only',
  budgets: 'unsupported',
  spendLimits: 'unsupported'
})

/** The turn runtime of Antigravity: the ACP adapter with the preset's name and capabilities. */
export function antigravityAdapter(client: () => AcpTurnClient | null): AcpAdapter {
  return new AcpAdapter(client, { driver: 'antigravity', label: ANTIGRAVITY_LABEL, capabilities: ANTIGRAVITY_CAPABILITIES })
}

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
    latestVersion: { kind: 'pinned', version: ANTIGRAVITY_VERSION },
    multiInstance: false,
    privateHome: false,
    canInstall: true,
    // The agent offers the models of the signed-in account only.
    customModels: false,
    methodLabel: 'Google sign-in',
    // ACP updates do not name the MCP server: the bearer is kept only after a turn whose tool calls all completed.
    mcpTurnBinding: 'drained_turn',
    userMcp: 'native',
    mirrorsVendorFile: true,
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    caps: () => ANTIGRAVITY_CAPS,
    updateCommand: () => undefined,
    create(_context: DriverContext): DriverRuntime {
      const service = options.builtIn()
      return {
        adapter: antigravityAdapter(() => service),
        configured: () => service.configured(),
        configuredProvider: () => service.configuredProvider(),
        llmProvider: () => service.llmProvider(),
        models: () => service.models(),
        modelsRefreshedAt: () => service.modelsRefreshedAt(),
        // Launch settings only: Antigravity's `signedIn` is its real sign-in, not a Mousse sign-out.
        vendorMirror: service.vendorMirror(LAUNCH_MIRROR_FIELDS),
        validateLaunch: (patch) => service.validateLaunch(patch),
        launchChanged: () => service.launchChanged(),
        // The sign-in is the profile's saved Google session; checking it would start the agent. It
        // changes only through Mousse's own sign-in and sign-out, which move the account generation
        // on, so the session itself is the account's identity.
        auth: async () => {
          // An unreadable settings file is never overwritten; the card says so until it is fixed.
          const problem = service.settingsProblem()
          if (problem) return { state: 'unknown', methodLabel: 'Google sign-in', message: problem }
          return service.signedIn()
            ? { state: 'signed_in', methodLabel: 'Google sign-in', subject: 'mousse-google-sign-in' }
            : { state: 'signed_out', methodLabel: 'Google sign-in' }
        },
        refreshModels: async (cwd) => void (await service.refreshModels(cwd)),
        signIn: (session, cwd) => service.login(session, cwd),
        signOut: () => service.logout(),
        install: async (onProgress) => void (await service.install((message, fraction, bytes) =>
          onProgress({ message, ...(fraction !== undefined ? { fraction } : {}), ...(bytes ?? {}) }))),
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
