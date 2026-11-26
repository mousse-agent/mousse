import { join } from 'node:path'
import type { HarnessCaps } from '../../../shared/harness/types'
import { AntigravityProviderService, type AntigravityEntry } from '../acp/presets/antigravity/AntigravityProviderService'
import { manualAntigravityRuntime } from '../acp/presets/antigravity/installation'
import { AcpAdapter, type AcpTurnClient } from './acp/adapter'
import { ANTIGRAVITY_CAPABILITIES, ANTIGRAVITY_LABEL } from '../acp/presets/antigravity'
import { decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver } from '../driver'
import { cliNames } from '../env'
import { LAUNCH_MIRROR_FIELDS } from '../vendorMirror'
import { compatibilityFields } from '../compatibility'
import { ACP_NATIVE_TOOLS } from '../acp/botApprovals'

/**
 * The account a recorded sign-in stands for. Mousse never reads the Google account itself, so a
 * sign-in or sign-out (which move the account generation on) is what changes it. An entry with a
 * home of its own stands for its own account (`<subject>:<instanceId>`), never "the same account".
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
 * The service of an entry added after the first: its settings in its state folder and the agent's folders, Google
 * sign-in included, in its own home (`AntigravityEntry`). Its launch settings are its own config's.
 */
function entryService(context: DriverContext, entry: AntigravityEntry): AntigravityProviderService {
  const service = new AntigravityProviderService(context.profileHome, context.installationHome, context.questions, undefined, {
    entry,
    launch: () => ({
      ...(context.config.binaryPath ? { binaryPath: context.config.binaryPath } : {}),
      ...(context.config.args?.length ? { args: [...context.config.args] } : {}),
      ...(context.config.env && Object.keys(context.config.env).length ? { env: { ...context.config.env } } : {})
    }),
    saveLaunch: (patch) => context.saveLaunch(patch)
  })
  service.hooks.changed = () => context.changed()
  return service
}

/**
 * Google's Antigravity, run as `agy acp`: a manual path in Settings, else the user's own `agy`
 * (found on PATH or in Google's install folder), else Mousse's own install of the release Google's
 * update feed names. The first entry's Google sign-in is the one this computer's `agy` keeps; each
 * entry added after it signs in to its own account, kept in its own home.
 */
export function antigravityDriver(options: {
  builtIn: () => AntigravityProviderService
  /** Test seam: the service of an added entry (`entryService` otherwise). */
  entry?: (context: DriverContext, entry: AntigravityEntry) => AntigravityProviderService
}): HarnessDriver {
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
    // A further entry is another Google account, in a home of its own (`AGY_FILE_TOKEN_ENV`).
    multiInstance: true,
    privateHome: true,
    // The first entry runs on this computer's `agy` sign-in; an added one never moves onto it.
    privateHomeFor: (config) => (config.home === 'private' ? 'required' : 'allowed'),
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
    // Chat titles, pull request drafts and commit messages: one prompt in a session of its own (`service.oneShot`).
    oneShot: true,
    // Only the native agy launch can switch off the user's customizations on a bot turn.
    botAuthority: () => options.builtIn().supportsBotTurns(),
    botApprovals: () => true,
    nativeToolNames: (neutral) => ACP_NATIVE_TOOLS[neutral] ?? [],
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: true }),
    caps: () => ANTIGRAVITY_CAPS,
    updateCommand: () => undefined,
    create(context: DriverContext): DriverRuntime {
      // Only the gateway's built-in entry runs on the profile's service; every added one has its own.
      const own = context.builtIn === false
      const service = own
        ? (options.entry ?? entryService)(context, { instanceId: context.instanceId, stateDir: context.stateDir, home: context.env.home ?? join(context.stateDir, 'home') })
        : options.builtIn()
      const subject = own ? `${SIGN_IN_SUBJECT}:${context.instanceId}` : SIGN_IN_SUBJECT
      service.useAgyFinder(() => context.findBinary())
      return {
        adapter: antigravityAdapter(() => service),
        configured: () => service.configured(),
        configuredProvider: () => service.configuredProvider(),
        llmProvider: () => service.llmProvider(),
        models: () => service.models(),
        modelsRefreshedAt: () => service.modelsRefreshedAt(),
        // Launch settings only: Antigravity's `signedIn` is its real sign-in, not a Mousse sign-out. An older Mousse
        // knows only the first entry, so an added one keeps no copy.
        ...(own ? {} : { vendorMirror: service.vendorMirror(LAUNCH_MIRROR_FIELDS) }),
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
          const shared = service.isolationProblem()
          return signedIn
            ? { state: 'signed_in', methodLabel: 'Google sign-in', subject }
            : { state: 'signed_out', methodLabel: 'Google sign-in', ...(shared ? { message: shared } : {}) }
        },
        // Turn admission reads the recorded sign-in only: it never starts the agent.
        identity: async () => (service.signedIn() ? subject : undefined),
        // The plan limits, read by `agy` itself when the usage page asks; never in the background.
        usage: (signal) => service.usage(signal),
        usageOnRequest: true,
        refreshModels: async (cwd) => void (await service.refreshModels(cwd)),
        signIn: (session, cwd) => service.login(session, cwd),
        signOut: () => service.logout(),
        // Removing an added entry deletes its own home and the sign-in in it; the first entry's removal deletes nothing.
        ...(own ? { deleteCredentials: () => service.deleteHome() } : {}),
        install: async (onProgress) => void (await service.install((message, fraction, bytes) =>
          onProgress({ message, ...(fraction !== undefined ? { fraction } : {}), ...(bytes ?? {}) }))),
        cancelInstall: () => service.cancelInstall(),
        installState: () => service.installState(),
        // Mousse's own install, while it is what runs; the user's own `agy` is found as on PATH.
        managed: () => service.managedRuntime(),
        validateOverride: (path) => void manualAntigravityRuntime(path),
        forgetConversation: (threadId) => service.forgetConversation(threadId),
        oneShot: (spec, signal) => service.oneShot(spec, signal),
        setLiveHost: (host) => service.setLiveHost(host),
        inFlightContinuation: (threadId) => service.inFlightContinuation(threadId),
        hasContinuation: (threadId, id) => service.hasContinuation(threadId, id),
        discardContinuations: (threadId, id) => service.discardContinuations(threadId, id),
        // The profile's service outlives its runtime; an added entry's ends with it.
        stop: () => { if (own) service.stop() }
      }
    }
  }
}
