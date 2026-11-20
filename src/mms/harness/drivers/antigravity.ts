import type { HarnessCaps } from '../../../shared/harness/types'
import type { AntigravityProviderService } from '../acp/presets/antigravity/AntigravityProviderService'
import { manualAntigravityRuntime } from '../acp/presets/antigravity/installation'
import { AcpAdapter, type AcpTurnClient } from './acp/adapter'
import { ANTIGRAVITY_CAPABILITIES, ANTIGRAVITY_LABEL } from '../acp/presets/antigravity'
import { decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver } from '../driver'
import { cliNames } from '../env'
import { LAUNCH_MIRROR_FIELDS } from '../vendorMirror'
import { compatibilityFields } from '../compatibility'

/**
 * The account a recorded sign-in stands for. Mousse never reads the Google account itself, so a
 * sign-in or sign-out (which move the account generation on) is what changes it.
 */
const SIGN_IN_SUBJECT = 'mousse-google-sign-in'

/** Antigravity publishes no context window, and Mousse offers no Plan mode for it. */
export const ANTIGRAVITY_CAPS: HarnessCaps = Object.freeze({
  ...ANTIGRAVITY_CAPABILITIES,
  planMode: false,
  contextUsage: 'none',
  // The agent asks Mousse for every tool permission and file write.
  toolControl: 'approval_only',
  autoPermissionMode: false,
  budgets: 'unsupported',
  spendLimits: 'unsupported'
})

/** The turn runtime of Antigravity: the ACP adapter with the preset's name and capabilities. */
export function antigravityAdapter(client: () => AcpTurnClient | null): AcpAdapter {
  return new AcpAdapter(client, { driver: 'antigravity', label: ANTIGRAVITY_LABEL, capabilities: ANTIGRAVITY_CAPABILITIES })
}

/**
 * Google's Antigravity, run as `agy acp`: a manual path in Settings, else the user's own `agy`
 * (found on PATH or in Google's install folder), else Mousse's own install of the release Google's
 * update feed names. Its Google sign-in is the one this computer's `agy` keeps.
 */
export function antigravityDriver(options: { builtIn: () => AntigravityProviderService }): HarnessDriver {
  return {
    kind: 'antigravity',
    label: 'Google Antigravity',
    // The user's own `agy`; Google's installer folder is searched too (`agyStandalonePaths`).
    binaryNames: cliNames('agy'),
    ...compatibilityFields('antigravity'),
    // Update offers the feed's release only while Mousse's own install runs: the user's own `agy`
    // updates itself. Read on every update check; it starts a feed read when one is due.
    get latestVersion() {
      const version = options.builtIn().latestVersion()
      return version ? { kind: 'pinned' as const, version } : undefined
    },
    multiInstance: false,
    privateHome: false,
    canInstall: true,
    // The agent offers the models of the signed-in account only.
    customModels: false,
    methodLabel: 'Google sign-in',
    // ACP updates do not name the MCP server: the bearer is kept only after a turn whose tool calls all completed.
    mcpTurnBinding: 'drained_turn',
    userMcp: 'native',
    // The agent's own `session/request_permission` flow decides (when it asks at all).
    relay: { approvals: 'runtime' },
    mirrorsVendorFile: true,
    // Sign-in and sign-out run in Mousse, whichever executable runs.
    ownsSignIn: true,
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    caps: () => ANTIGRAVITY_CAPS,
    updateCommand: () => undefined,
    create(context: DriverContext): DriverRuntime {
      const service = options.builtIn()
      service.useAgyFinder(() => context.findBinary())
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
        // The sign-in the profile recorded. An explicit check (Add, Check again, after install) also
        // asks `agy` whether this computer already has one, by opening a session without signing in.
        // It changes only through a sign-in or sign-out, which move the account generation on.
        auth: async ({ force }): Promise<AuthReading> => {
          // An unreadable settings file is never overwritten; the card says so until it is fixed.
          const problem = service.settingsProblem()
          if (problem) return { state: 'unknown', methodLabel: 'Google sign-in', message: problem }
          const signedIn = service.signedIn() || (force && await service.checkSignedIn())
          return signedIn
            ? { state: 'signed_in', methodLabel: 'Google sign-in', subject: SIGN_IN_SUBJECT }
            : { state: 'signed_out', methodLabel: 'Google sign-in' }
        },
        // Turn admission reads the recorded sign-in only: it never starts the agent.
        identity: async () => (service.signedIn() ? SIGN_IN_SUBJECT : undefined),
        // The plan limits, read by `agy` itself when the usage page asks; never in the background.
        usage: (signal) => service.usage(signal),
        refreshModels: async (cwd) => void (await service.refreshModels(cwd)),
        signIn: (session, cwd) => service.login(session, cwd),
        signOut: () => service.logout(),
        install: async (onProgress) => void (await service.install((message, fraction, bytes) =>
          onProgress({ message, ...(fraction !== undefined ? { fraction } : {}), ...(bytes ?? {}) }))),
        cancelInstall: () => service.cancelInstall(),
        installState: () => service.installState(),
        // Mousse's own install, while it is what runs; the user's own `agy` is found as on PATH.
        managed: () => service.managedRuntime(),
        validateOverride: (path) => void manualAntigravityRuntime(path),
        forgetConversation: (threadId) => service.forgetConversation(threadId),
        stop: () => {}
      }
    }
  }
}
