import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallOwner } from '../../../shared/harness/status'
import type { HarnessCaps } from '../../../shared/harness/types'
import type { ResolvedSettings } from '@anthropic-ai/claude-agent-sdk'
import type { CliProviderConfigPatch } from '../../../shared/providerAuth'
import type { StoredCliConfig } from '../cliConfig'
import {
  ClaudeSubscriptionProviderService,
  type AuthProbe
} from '../vendors/claude/ClaudeSubscriptionProviderService'
import type { ClaudeIntegrationSource } from '../vendors/claude/integrations'
import {
  CLAUDE_SUBSCRIPTION_CAPABILITIES,
  ClaudeSubscriptionAdapter
} from './claudeCode/adapter'
import type { ProviderLoginResult } from '../../../shared/providerAuth'
import type { LoginSession } from '../../providers/LoginSession'
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  CLAUDE_API_KEY_LOGIN,
  checkClaudeApiKey,
  claudeKeyTurnSettings,
  claudeApiKeyEnv,
  claudeApiKeyProblem,
  claudeApiKeySubject,
  entryBaseUrl,
  type ClaudeApiKeyChecker
} from '../claude/apiKey'
import { cliNames, findOnPath, lockedEnv, ownedLaunchEnv, ownedUserEnv } from '../env'
import { CLAUDE_LOCKED_PROFILE, CLAUDE_MANAGED_POLICY_REFUSAL, CLAUDE_NATIVE_TOOLS, claudeLockedCaps, claudeLockedHoldsBots, claudeSandboxFact } from '../claude/locked'
import { readClaudeManagedPolicy, remoteSettingsHoldPolicy, type ManagedPolicyReadInput } from '../claude/managedPolicy'
import { compatibilityFields, CONTAINMENT_EVIDENCE, hasContainmentEvidence, type ContainmentEvidence } from '../compatibility'
import { CLAUDE_INSTANCE_ID } from '../../../shared/providerInstances'
import { compareVersions, decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver, type InstanceConfig } from '../driver'
import { ownedHomeProblem } from '../ownedHome'
import { ptyAvailable, redactSignIn, runInPty, terminalText, transcriptLinks, type PtyRun, type PtySpawn } from '../pty'
import { runHarness } from '../spawn'
import { InstanceVault } from '../vault'
import { ALL_MIRROR_FIELDS, SIGN_OUT_MIRROR_FIELDS } from '../vendorMirror'

export const CLAUDE_CODE_CAPS: HarnessCaps = Object.freeze({
  ...CLAUDE_SUBSCRIPTION_CAPABILITIES,
  planMode: true,
  contextUsage: 'reported',
  // Claude Code asks Mousse through its permission callback under the mode Mousse sets.
  toolControl: 'approval_only',
  // Only once the installed version is known to have it (`claudeCodeCaps`).
  autoPermissionMode: false,
  budgets: 'unsupported',
  spendLimits: 'unsupported'
})

/**
 * The first Claude Code version whose auto mode a session can start in with `--permission-mode auto`
 * (the SDK's `permissionMode: 'auto'`) alone. Claude Code's changelog for 2.1.111: "Auto mode no longer
 * requires `--enable-auto-mode`"; before it, `auto` needed that extra flag, which Mousse does not pass.
 */
export const CLAUDE_AUTO_MODE_MIN_VERSION = '2.1.111'

/**
 * The caps of an ordinary (not locked) Claude Code entry at its installed version. Auto is offered only
 * when that version is known and has auto mode: an unknown version runs Auto as Auto-accept edits.
 */
export function claudeCodeCaps(installedVersion: string | undefined): HarnessCaps {
  if (installedVersion === undefined || compareVersions(installedVersion, CLAUDE_AUTO_MODE_MIN_VERSION) < 0) return CLAUDE_CODE_CAPS
  return CLAUDE_CODE_AUTO_CAPS
}
const CLAUDE_CODE_AUTO_CAPS: HarnessCaps = Object.freeze({ ...CLAUDE_CODE_CAPS, autoPermissionMode: true })

export { CLAUDE_NATIVE_TOOLS } from '../claude/locked'

/** A locked entry (PR 6 §3): it runs bots only, in a home of its own, under the locked profile. */
/** How long a "no policy" reading of a locked entry is trusted before it counts as unknown again. */
export const CLAUDE_POLICY_TRUST_MS = 30_000

/**
 * A reading this recent is the one a check point uses instead of reading again: one bot turn reads
 * the policy once (at dispatch), and its admission and start, moments later, use that reading.
 */
export const CLAUDE_POLICY_REREAD_MS = 2_000

export function claudeLocked(config: Pick<InstanceConfig, 'profile' | 'home'>): boolean {
  return config.profile === CLAUDE_LOCKED_PROFILE && config.home === 'private'
}

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

/** How long a sign-in in the terminal may take before Mousse ends it. */
export const CLAUDE_SIGN_IN_TIMEOUT_MS = 10 * 60_000

/** How long a terminal that printed its success may take to exit before it is ended (it is writing its files). */
export const CLAUDE_SUCCESS_GRACE_MS = 5_000

/**
 * The terminal is made wide so Claude prints its long sign-in link on one line: a link cut at the
 * terminal's edge would not be found.
 */
const SIGN_IN_COLUMNS = 1000

/** What Claude's browser sign-in link looks like: an OAuth authorize address, never an install or update notice. */
const SIGN_IN_LINK = /\/oauth\/authorize|[?&](?:client_id|code_challenge)=/i

/** The sign-in link in a terminal transcript, by what it looks like and not by where it comes. */
export function claudeSignInLink(transcript: string): string | undefined {
  return transcriptLinks(transcript).find((link) => SIGN_IN_LINK.test(link))
}

export interface ClaudeCodeDriverOptions {
  /** The profile's service for the built-in `claude` instance (shared with usage and Settings). */
  builtIn?: () => ClaudeSubscriptionProviderService
  /** The user's Mousse MCP servers and skills for an instance, resolved with its environment. */
  integrations?: (env: () => NodeJS.ProcessEnv) => ClaudeIntegrationSource | null
  /** Test seam: builds the service of an added instance. */
  createService?: (context: DriverContext, options: ConstructorParameters<typeof ClaudeSubscriptionProviderService>[2]) => ClaudeSubscriptionProviderService
  /** Test seam: whether a sign-in terminal runs here, and the terminal it runs in (default: `node-pty`). */
  pty?: { available: () => boolean; spawn?: PtySpawn }
  /** Test seam: how long a sign-in may take (default `CLAUDE_SIGN_IN_TIMEOUT_MS`). */
  signInTimeoutMs?: number
  /** Test seam: Recheck's `models.list` for an API-key entry. */
  checkApiKey?: ClaudeApiKeyChecker
  /** Test seam: the SDK's offline settings resolver, read before each turn of an API-key entry. */
  resolveSettings?: SettingsResolver
  /** Test seam: the platform a locked entry's caps and evidence are read for (default `process.platform`). */
  platform?: NodeJS.Platform
  /** Test seam: whether an organisation's Claude Code policy applies, fixed (default: read per entry). */
  managedPolicy?: () => boolean
  /** Test seam: the fresh policy reading of one entry (default `readClaudeManagedPolicy`). */
  readPolicy?: (input: ManagedPolicyReadInput) => Promise<boolean>
  /** Test seam: the containment evidence (default `CONTAINMENT_EVIDENCE`). */
  evidence?: readonly ContainmentEvidence[]
  /** Each Claude Code process a locked entry's bot turn starts (its active-time supervision). */
  onLockedProcess?: (pid: number, threadId: string) => void
}

/** The SDK's `resolveSettings`: the settings a turn's folder gives Claude Code, without starting it. */
export type SettingsResolver = (options: { cwd: string; settingSources: Array<'project' | 'local'> }) => Promise<Pick<ResolvedSettings, 'sources'>>

const sdkResolveSettings: SettingsResolver = async (options) => (await import('@anthropic-ai/claude-agent-sdk')).resolveSettings(options)

/**
 * An entry that runs on an Anthropic API key Mousse keeps. It is never the user's own Claude Code:
 * without a home of its own it runs nothing (it never falls back to the user's sign-in).
 */
export function claudeRunsOnApiKey(config: Pick<InstanceConfig, 'loginMethod'>): boolean {
  return config.loginMethod === CLAUDE_API_KEY_LOGIN
}

/**
 * Claude Code's family alias for a full Claude model id (`claude-opus-4-1` → `opus`), for a model
 * API's model that moved here; undefined for a model of no known family.
 */
export function claudeFamilyAlias(model: string): string | undefined {
  return /(?:^|[^a-z])(opus|sonnet|haiku)(?:[^a-z]|$)/i.exec(model)?.[1]?.toLowerCase()
}

/** Vault entries of an API-key entry. */
const SECRET = { apiKey: 'anthropic_api_key' } as const

function readAuth(service: ClaudeSubscriptionProviderService, status: Awaited<ReturnType<ClaudeSubscriptionProviderService['status']>>, signInCommand: string, inApp: boolean): AuthReading {
  const methodLabel = 'Claude Code sign-in'
  // Signed in from Mousse: the Sign in button, with the command to copy kept beside it as the fallback.
  const signedOut = (message: string | undefined): AuthReading =>
    inApp
      ? { state: 'signed_out', methodLabel, message: 'Not signed in. Choose Sign in to sign this account in.', signInCommand, canSignIn: true }
      : { state: 'signed_out', methodLabel, message, signInCommand }
  switch (status.state) {
    case 'connected': {
      const account = service.account()
      // What it runs on, as `claude auth status` said in this same check: never another one.
      return { state: 'signed_in', methodLabel, credential: account?.credential ?? 'unknown', ...(account?.label ? { account: { label: account.label } } : {}), ...(account?.subject ? { subject: account.subject } : {}) }
    }
    case 'signed_out':
      return signedOut(status.message)
    case 'disconnected':
      return signedOut(status.message)
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
  const platform = options.platform ?? process.platform
  const evidence = options.evidence ?? CONTAINMENT_EVIDENCE
  /** The locked entries whose runtime is bound: where their policy is read. */
  const lockedEntries = new Map<string, { home?: string; cwd: () => string }>()
  /**
   * The last policy reading of each locked entry, for the synchronous caps and `botAuthority`. A
   * reading is the entry's own (another entry's home may hold a server-managed policy), and a "no
   * policy" reading is trusted only for `CLAUDE_POLICY_TRUST_MS`: every bot check point (approval,
   * dispatch, turn admission) reads it again first, and the turn reads it once more before it starts.
   * Unread, stale or unreadable counts as present.
   */
  const readings = new Map<string, { managed: boolean; at: number }>()
  const managedFor = (instanceId?: string): boolean => {
    if (options.managedPolicy) return options.managedPolicy()
    const reading = instanceId === undefined ? undefined : readings.get(instanceId)
    return !reading || reading.managed || Date.now() - reading.at > CLAUDE_POLICY_TRUST_MS
  }
  /** Readings in progress, by entry: a check point that comes while one runs waits for it. */
  const pending = new Map<string, Promise<boolean>>()
  /**
   * The entry's policy, read now in a fresh process (`readClaudeManagedPolicy`), unless a reading
   * finished within `CLAUDE_POLICY_REREAD_MS` or is running: then that one.
   */
  const readManaged = async (instanceId: string): Promise<boolean> => {
    if (options.managedPolicy) return options.managedPolicy()
    const entry = lockedEntries.get(instanceId)
    if (!entry) return true
    const recent = readings.get(instanceId)
    if (recent && Date.now() - recent.at <= CLAUDE_POLICY_REREAD_MS) return recent.managed
    const running = pending.get(instanceId)
    if (running) return running
    const reading = (async () => {
      let managed: boolean
      try {
        managed = await (options.readPolicy ?? readClaudeManagedPolicy)({ cwd: entry.cwd(), platform, ...(entry.home ? { home: entry.home } : {}) })
      } catch {
        managed = true
      }
      readings.set(instanceId, { managed, at: Date.now() })
      return managed
    })()
    pending.set(instanceId, reading)
    try {
      return await reading
    } finally {
      pending.delete(instanceId)
    }
  }
  return {
    kind: 'claude',
    label: 'Claude Code',
    binaryNames: cliNames('claude'),
    ...compatibilityFields('claude'),
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
    // Claude Code's documented switches (names checked in the 2.1.291 binary's text): usage
    // telemetry, and error reports.
    telemetryOff: () => ({ env: { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' } }),
    telemetryDocs: 'https://code.claude.com/docs/en/data-usage',
    decodeConfig: (raw, instanceId) => {
      const config = decodeInstanceConfig(raw, { privateHome: true })
      // The user's own built-in entry is never locked: it runs Claude Code as they set it up.
      if (instanceId === CLAUDE_INSTANCE_ID) delete config.profile
      return config
    },
    // An API-key entry has a home of its own: the user's own Claude Code runs exactly as they set it up.
    // So does a locked entry: a bot never runs in the user's own Claude Code setup.
    privateHomeFor: (config) => (claudeRunsOnApiKey(config) || config.profile === CLAUDE_LOCKED_PROFILE ? 'required' : 'allowed'),
    caps: (config, installedVersion, _facts, instanceId) =>
      claudeLocked(config) ? claudeLockedCaps(CLAUDE_CODE_CAPS, { platform, ...(installedVersion ? { cliVersion: installedVersion } : {}), managedPolicy: managedFor(instanceId), evidence }) : claudeCodeCaps(installedVersion),
    // Only a locked entry holds a bot to its grant, and only once its gate and ledger have evidence on
    // this platform (`CONTAINMENT_EVIDENCE`) and no organisation policy applies; no record exists yet.
    botAuthority: (config, instanceId) => claudeLocked(config) && claudeLockedHoldsBots(platform, managedFor(instanceId), evidence),
    readPolicyFacts: async (config, instanceId) => {
      if (claudeLocked(config)) await readManaged(instanceId)
    },
    nativeToolNames: (neutral) => CLAUDE_NATIVE_TOOLS[neutral] ?? [],
    updateCommand: (owner: InstallOwner) => {
      if (owner === 'npm') return 'npm install -g @anthropic-ai/claude-code@latest'
      if (owner === 'brew') return 'brew upgrade claude-code'
      if (owner === 'standalone') return 'claude update'
      return undefined
    },
    create(context: DriverContext): DriverRuntime {
      const signInCommand = claudeSignInCommand(context.env.home)
      let service: ClaudeSubscriptionProviderService
      let entry: OwnedService | undefined
      // An API-key entry never shares the user's own service, even under the built-in id.
      const onKey = claudeRunsOnApiKey(context.config)
      const shared = Boolean(context.builtIn && options.builtIn) && !onKey
      // An added instance with a home of its own: it signs in and out in that home, from Mousse.
      const privateHome = shared ? undefined : context.env.home
      // One environment for every process of such an instance: what it configures never moves its home or brings a credential back.
      const environmentOf = (from: DriverContext): NodeJS.ProcessEnv => (from.env.home ? ownedLaunchEnv('claude', from.env, from.config.env) : from.env.env)
      const env = () => environmentOf(context)
      const ptyRuns = () => (options.pty ? options.pty.available() : ptyAvailable())
      if (shared) service = options.builtIn!()
      else {
        if (context.env.home) mkdirSync(context.env.home, { recursive: true, mode: 0o700 })
        entry = owned.get(context.instanceId)
        if (entry && (entry.home !== context.env.home || Boolean(entry.credential) !== onKey || entry.locked !== claudeLocked(context.config))) {
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
          // One key store per instance, read live: a rename or variable change keeps it.
          const credential = onKey ? apiKeyCredential(live, options.checkApiKey ?? checkClaudeApiKey, options.resolveSettings ?? sdkResolveSettings) : undefined
          const launch = (): StoredCliConfig => {
            const config = live().config
            // An entry with its own home never applies variables that choose its sign-in (`environmentOf`).
            const configured = live().env.home ? ownedUserEnv('claude', config.env) : config.env
            return {
              ...(config.binaryPath ? { binaryPath: config.binaryPath } : {}),
              ...(config.args ? { args: config.args } : {}),
              ...(configured ? { env: configured } : {})
            }
          }
          // A locked entry's turns start from nothing but the allowlist, with the entry's own home.
          const locked = claudeLocked(context.config)
          const serviceOptions = {
            ...(locked
              ? {
                  lockedEnv: (scratch: string) =>
                    lockedEnv({ platform, base: live().env.env, driver: 'claude', credential: onKey ? 'api_key' : 'subscription', ...(live().env.home ? { home: live().env.home } : {}), scratch })
                }
              : {}),
            stateDir: context.stateDir,
            findBinary: () => live().findBinary(),
            baseEnv: () => environmentOf(live()),
            launchConfig: launch,
            signedOut: () => live().signedOut(),
            saveLaunch: (patch: CliProviderConfigPatch) => live().saveLaunch(patch),
            // The entry's telemetry switch, from its newest revision.
            telemetryEnv: () => live().env.enforced,
            signInCommand,
            ...(credential ? credential.serviceOptions : {})
          }
          const created = options.createService?.(context, serviceOptions)
            ?? new ClaudeSubscriptionProviderService(context.profileHome, context.questions, serviceOptions)
          entry = {
            service: created,
            home: context.env.home,
            locked,
            ...(credential ? { credential } : {}),
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

      /** The sign-in terminal that is running, so removing the instance can end it. */
      let activeRun: PtyRun | undefined
      /**
       * `claude auth login` in the instance's home. The link goes to the page (with a paste field
       * for the code Claude may ask for), and the sign-in counts only once `claude auth status` in
       * that home says signed in. The terminal's output is never logged or stored.
       */
      const signInInTerminal = async (session: LoginSession, cwd: string): Promise<ProviderLoginResult> => {
        const pasted: string[] = []
        const fail = (message: string): ProviderLoginResult => ({ success: false, sessionId: session.sessionId, error: redactSignIn(message, pasted) })
        // Only a folder Mousse owns: a link to another account's folder would sign that account in.
        const problem = ownedHomeProblem(privateHome!, context.profileHome)
        if (problem) return fail(problem)
        const launch = service.authLaunch()
        // No terminal here (or no executable yet): the command to copy, as for the user's own Claude.
        if (!launch || !ptyRuns()) return service.login(session, cwd)
        const cancelled = () => session.abort.signal.aborted
        const withdrawn = new AbortController()
        let linkShown = false
        let promptSeen = false
        let sawSuccess = false
        let invalidCodes = 0
        let waiting: string | undefined
        let run: PtyRun | undefined
        const type = () => {
          if (!run || !promptSeen || waiting === undefined) return
          run.write(`${waiting}\r`)
          waiting = undefined
        }
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let grace: ReturnType<typeof setTimeout> | undefined
        /** Ends the terminal; one that already printed its success is left to finish writing its files first. */
        const stopRun = () => {
          if (!sawSuccess) run?.cancel()
          else grace ??= setTimeout(() => run?.cancel(), CLAUDE_SUCCESS_GRACE_MS)
        }
        try {
          const interaction = session.createAuthCallbacks({ usesCallbackServer: true })
          /** The paste field for the code Claude asks for; offered again when Claude refuses a code. */
          const offerPaste = (message: string) =>
            interaction.prompt({ type: 'manual_code', message, signal: withdrawn.signal }).then((code) => {
              pasted.push(code)
              waiting = code
              type()
            }, () => undefined)
          run = runInPty(launch.command, [...launch.args, 'auth', 'login'], {
            env: launch.env,
            // The home is the folder Claude Code starts in: no project settings of Mousse's own folder are read.
            cwd: privateHome!,
            cols: SIGN_IN_COLUMNS,
            ...(options.pty?.spawn ? { spawn: options.pty.spawn } : {}),
            onOutput: (transcript) => {
              const text = terminalText(transcript)
              const link = claudeSignInLink(transcript)
              if (link && !linkShown) {
                linkShown = true
                // The paste field goes first, so the link's prompt carries `acceptsRedirectPaste`.
                void offerPaste('Paste the code Claude shows after you sign in')
                interaction.notify({
                  type: 'auth_url',
                  url: link,
                  instructions: 'Sign in with your Claude account in the browser. If Claude asks for a code, paste it here.'
                })
              }
              if (/paste code here/i.test(text)) {
                promptSeen = true
                type()
              }
              if (/login successful/i.test(text)) sawSuccess = true
              // Claude keeps asking after a code it refuses: the field comes back.
              const invalid = text.match(/invalid code/gi)?.length ?? 0
              if (invalid > invalidCodes) {
                invalidCodes = invalid
                void offerPaste('Claude did not accept that code. Paste the whole code again.')
              }
            }
          })
          activeRun = run
          session.abort.signal.addEventListener('abort', stopRun, { once: true })
          timer = setTimeout(() => {
            timedOut = true
            stopRun()
          }, options.signInTimeoutMs ?? CLAUDE_SIGN_IN_TIMEOUT_MS)
          timer.unref?.()
          let exitCode: number
          try {
            ;({ exitCode } = await run.done)
          } finally {
            clearTimeout(timer)
            clearTimeout(grace)
            withdrawn.abort()
            session.abort.signal.removeEventListener('abort', stopRun)
            activeRun = undefined
          }
          // Claude accepted the sign-in and finished before the stop reached it.
          const finished = sawSuccess && exitCode === 0
          if (cancelled()) {
            // The account is signed in in its home all the same: Mousse takes it up, so nothing is half done.
            if (finished) await service.reconnect().catch(() => undefined)
            return fail('Login cancelled')
          }
          if (timedOut && !finished) return fail('Sign-in timed out. Start it again.')
          if (exitCode !== 0) return fail(`claude auth login exited with code ${exitCode}.`)
          // Only Claude's own check in this home counts.
          const signedIn = await service.reconnect()
          if (cancelled()) return fail('Login cancelled')
          if (!signedIn) return fail('Claude did not report a sign-in.')
          await service.refreshModels(cwd).catch(() => undefined)
          return { success: true, sessionId: session.sessionId }
        } catch (error) {
          return fail(cancelled() ? 'Login cancelled' : error instanceof Error ? error.message : String(error))
        }
      }

      /**
       * `claude auth logout` in the instance's home, then Mousse's own sign-out. It counts only when
       * `claude auth status` in that home then says signed out: a command that did not run or did not
       * work, with the account still signed in, is an error the user sees, and nothing is recorded.
       */
      const signOutOfHome = async (): Promise<void> => {
        const problem = ownedHomeProblem(privateHome!, context.profileHome)
        if (problem) throw new Error(problem)
        const launch = service.authLaunch()
        if (!launch) throw new Error('Claude Code was not found, so this account cannot be signed out. Install it or set its path, then try again.')
        const result = await runHarness({ ...context.env, env: launch.env }, 'auth', launch.command, [...launch.args, 'auth', 'logout'], { timeoutMs: 15_000 })
        // Whatever the exit code said (a non-zero one is also how an account that was already signed out answers), the home decides.
        const state = result.timedOut || result.spawnError ? 'unknown' : await service.authState()
        if (state === 'signed_out') return service.logout()
        const why = result.timedOut
          ? 'it did not finish in time'
          : result.spawnError
            ? `it could not start (${result.spawnError})`
            : result.code === 0
              ? 'it ran, but the account still reads signed in'
              : `it exited with code ${result.code}`
        throw new Error(`Claude Code was not signed out: \`claude auth logout\` ${why}. ${state === 'signed_in' ? 'The account is still signed in.' : 'Mousse could not confirm the account is signed out.'} Mousse has stopped using it here; sign in again to use it, or run the command in a terminal to finish the sign-out.`)
      }

      const integrations = options.integrations?.(env) ?? null
      const lockedEntry = !shared && claudeLocked(context.config)
      if (lockedEntry) {
        // Its policy is read as soon as the runtime is bound, so the entry's caps can say what it holds.
        lockedEntries.set(context.instanceId, { ...(context.env.home ? { home: context.env.home } : {}), cwd: () => service.standaloneWorkspace('locked-policy') })
        void readManaged(context.instanceId).then(() => context.changed(), () => undefined)
      }
      const adapter = new ClaudeSubscriptionAdapter(() => service, () => integrations, lockedEntry
        ? {
            // Read again as each turn starts: the policy, the CLI version's gate-and-ledger evidence, and
            // for shell the sandbox and its evidence for this version here.
            admit: async () => {
              if (await readManaged(context.instanceId)) return { ok: false, reason: CLAUDE_MANAGED_POLICY_REFUSAL }
              const version = (await service.cliConfig()).version
              if (version === undefined || !hasContainmentEvidence({ driver: 'claude', kind: 'tools', platform, cliVersion: version }, evidence))
                return { ok: false, reason: `Mousse has no evidence that Claude Code ${version ?? '(unknown version)'} holds a bot to its permissions here.` }
              const sandbox = claudeSandboxFact(platform, (name) => Boolean(findOnPath([name], context.env))) === 'available'
              return { ok: true, shellContained: sandbox && hasContainmentEvidence({ driver: 'claude', kind: 'sandbox', platform, cliVersion: version }, evidence) }
            },
            // A server-managed policy Claude Code fetched at its own start (the first turn of a new
            // home) lands in the home's cache: from then on every call of the turn is denied.
            // Claude Code's own empty sentinel (no server-managed settings) is no policy.
            policyAppeared: () => Boolean(context.env.home) && remoteSettingsHoldPolicy(context.env.home!),
            ...(options.onLockedProcess ? { onProcess: options.onLockedProcess } : {})
          }
        : undefined)
      const runtime: DriverRuntime = {
        adapter,
        configured: () => service.configured(),
        configuredProvider: () => service.configuredProvider(),
        llmProvider: () => service.llmProvider(),
        models: () => service.models(),
        movedModel: claudeFamilyAlias,
        modelsRefreshedAt: () => service.modelsRefreshedAt(),
        // The built-in instance mirrors its launch settings and sign-out to its settings.json for an
        // older Mousse; an added one only its sign-out (its launch settings were always in config).
        vendorMirror: service.vendorMirror(shared ? ALL_MIRROR_FIELDS : SIGN_OUT_MIRROR_FIELDS),
        ...(shared ? { validateLaunch: (patch: CliProviderConfigPatch) => service.validateLaunch(patch) } : {}),
        auth: async ({ force }) => readAuth(service, await service.status({ force }), signInCommand, Boolean(privateHome) && ptyRuns()),
        // Read from the home and the variables Claude Code reads; `claude auth status` is the turn's own check.
        identity: async () => service.accountSubject(),
        // Claude Code refuses `bypassPermissions` when the user's settings say so.
        permissionLimits: (cwd) => service.permissionLimits(cwd),
        refreshModels: async (cwd) => {
          await service.status()
          await service.refreshModels(cwd)
        },
        signIn: privateHome ? signInInTerminal : (session, cwd) => service.login(session, cwd),
        signOut: privateHome ? signOutOfHome : () => service.logout(),
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
            // A sign-in terminal this runtime started ends with the instance, not with a config change.
            activeRun?.cancel()
            user.service.stop()
          })
        }
      }
      // An API-key entry signs in and out with its key: never `claude auth` (the terminal sign-in above).
      return entry?.credential ? { ...runtime, ...entry.credential.runtime(service) } : runtime
    }
  }
}

type ApiKeyCredential = ReturnType<typeof apiKeyCredential>

/**
 * The sign-in of an API-key entry (PR 2 §6), kept per instance with its service and reading the
 * newest runtime's context. The key is a vault secret applied last as `ANTHROPIC_API_KEY` on every
 * process (`finalEnv`), after every sign-in and route variable is dropped, with the entry's own
 * home and its own address (`config.env.ANTHROPIC_BASE_URL`) set again. Claude Code loads no
 * settings from that home. Signed in means a saved key that is not a subscription token; Recheck
 * asks the Anthropic API (`models.list`). Signing in opens a secret prompt; signing out forgets
 * the key and ends every process holding it. Claude Code's own `claude auth` never runs for it.
 */
function apiKeyCredential(live: () => DriverContext, check: ClaudeApiKeyChecker, resolveSettings: SettingsResolver) {
  const vault = new InstanceVault(join(live().stateDir, 'secrets.json'))
  const label = () => live().config.displayName ?? 'Claude Code (API key)'
  /** The entry's own home; none means it was stored without one, and it runs nothing. */
  const home = () => live().env.home
  const baseUrl = () => entryBaseUrl(live().config.env)
  const saved = (): string | undefined => {
    try {
      return vault.get(SECRET.apiKey)
    } catch (error) {
      console.warn('[harness] claude secrets unreadable', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }
  /** The key processes run with: none without a home of its own, or when the saved value is no key. */
  const usable = (): string | undefined => {
    const key = saved()
    return home() && key && !claudeApiKeyProblem(key) ? key.trim() : undefined
  }
  const signedOutMessage = () => `${label()} has no Anthropic API key. Add one in Settings → Providers.`
  const noHomeMessage = () => `${label()} runs on an API key only in a home of its own. Remove it and add Claude Code (API key) again.`
  const subject = (key: string) => claudeApiKeySubject(key, baseUrl())
  const serviceOptions = {
    // Never the user's own home, even for an entry stored without one: there it runs nothing anyway.
    finalEnv: (env: NodeJS.ProcessEnv) => claudeApiKeyEnv(env, { apiKey: usable(), home: home() ?? join(live().stateDir, 'home'), baseUrl: baseUrl() }),
    probe: (): AuthProbe => {
      if (!home()) return { kind: 'signed_out', message: noHomeMessage() }
      const key = usable()
      return key
        ? { kind: 'signed_in', account: { label: 'API key', subject: subject(key), credential: 'api_key' } }
        : { kind: 'signed_out', message: signedOutMessage() }
    },
    signedOutMessage: () => (home() ? signedOutMessage() : noHomeMessage()),
    // The home is Mousse's own: settings there could replace the key or its address, so they are not
    // loaded, and launch arguments cannot load other settings files.
    settingSources: ['project', 'local'] as Array<'project' | 'local'>,
    droppedArgs: ['settings', 'setting-sources'],
    // The turn's folder may set another sign-in or address: the flag tier pins the entry's own over
    // it, or the turn is refused before Claude Code starts (`claudeKeyTurnSettings`).
    turnSettings: async (cwd: string) =>
      claudeKeyTurnSettings(await resolveSettings({ cwd, settingSources: ['project', 'local'] }), { ...(baseUrl() ? { baseUrl: baseUrl()! } : {}), label: label() })
  }
  /** Key sign-ins waiting for their prompt or still saving; a sign-out cancels them. */
  const pending = new Set<LoginSession>()
  /** Moved on by every sign-out: a key sign-in started before one saves nothing and does not succeed. */
  let generation = 0

  const runtime = (service: ClaudeSubscriptionProviderService): Partial<DriverRuntime> => {
    const save = async (apiKey: string): Promise<void> => {
      if (!home()) throw new Error(noHomeMessage())
      const problem = claudeApiKeyProblem(apiKey)
      if (problem) throw new Error(problem)
      vault.set(SECRET.apiKey, apiKey.trim())
      // The next check reads the new key; a warm process started with another key is not reused.
      await service.status({ force: true })
      live().changed()
    }
    const auth = async ({ force, signal }: { force: boolean; signal?: AbortSignal }): Promise<AuthReading> => {
      const methodLabel = 'API key'
      if (!home()) return { state: 'signed_out', methodLabel, message: noHomeMessage() }
      const status = await service.status({ force })
      if (status.state === 'missing_binary' || status.state === 'error') return { state: 'unknown', methodLabel, ...(status.message ? { message: status.message } : {}) }
      const key = saved()
      if (!key) return { state: 'signed_out', methodLabel, message: signedOutMessage(), canSignIn: true }
      const problem = claudeApiKeyProblem(key)
      if (problem) return { state: 'signed_out', methodLabel, message: problem, canSignIn: true }
      const signedIn: AuthReading = { state: 'signed_in', methodLabel, credential: 'api_key', subject: subject(key), ownedByMousse: true, canSignIn: true }
      if (!force) return signedIn
      let result: Awaited<ReturnType<ClaudeApiKeyChecker>>
      try {
        result = await check({ apiKey: key.trim(), baseUrl: baseUrl() ?? ANTHROPIC_DEFAULT_BASE_URL, ...(signal ? { signal } : {}) })
      } catch {
        signal?.throwIfAborted()
        // Not reaching Anthropic says nothing about the key: it stays in use.
        return { ...signedIn, message: 'Mousse could not reach Anthropic to check the key. Check again later.' }
      }
      return result === 'refused' ? { state: 'signed_out', methodLabel, message: 'Anthropic did not accept this API key. Paste a new one.', canSignIn: true } : signedIn
    }
    return {
      auth,
      identity: async () => {
        const key = usable()
        return key ? subject(key) : undefined
      },
      signIn: async (session: LoginSession): Promise<ProviderLoginResult> => {
        const started = generation
        /** A sign-out since this sign-in started: it must not save a key, nor sign the entry in again. */
        const superseded = () => session.abort.signal.aborted || started !== generation
        pending.add(session)
        try {
          if (!home()) throw new Error(noHomeMessage())
          const key = await session.createAuthCallbacks().prompt({ type: 'secret', message: 'Paste an Anthropic API key (console.anthropic.com → API keys).', placeholder: 'sk-ant-api…' })
          if (superseded()) throw new Error('Login cancelled')
          await save(key)
          // A sign-out while saving already removed the key; this sign-in does not count.
          if (superseded()) throw new Error('Login cancelled')
          return { success: true, sessionId: session.sessionId }
        } catch (error) {
          return { success: false, sessionId: session.sessionId, error: superseded() ? 'Login cancelled' : error instanceof Error ? error.message : String(error) }
        } finally {
          pending.delete(session)
        }
      },
      // Everything that holds the key or could save one stops first, whatever happens next: key
      // sign-ins in progress, then every turn, warm process and helper (the service's Mousse-side
      // sign-out; `claude auth` never runs). Then the key and the saved sessions are deleted, and a
      // failure to delete either is reported after.
      signOut: async () => {
        generation += 1
        for (const session of [...pending]) session.abort.abort()
        const failures: unknown[] = []
        try {
          await service.logout()
        } catch (error) {
          failures.push(error)
        }
        try {
          vault.set(SECRET.apiKey, undefined)
        } catch (error) {
          failures.push(error)
        }
        await service.status({ force: true }).catch(() => {})
        live().changed()
        if (failures.length) throw failures[0]
      },
      adoptApiKey: save,
      // Replace key: the entry's own key in its vault, never in the terminal's sign-in.
      setSecret: save
    }
  }
  return { serviceOptions, runtime }
}


/** The service of an added instance and the runtimes using it (`claudeCodeDriver`). */
interface OwnedService {
  service: ClaudeSubscriptionProviderService
  home: string | undefined
  /** Built for a locked entry (`claudeLocked`): its turns take the locked environment. */
  locked: boolean
  /** The newest runtime's context, which the service reads. */
  context: DriverContext
  users: number
  /** The key store of an API-key entry (`apiKeyCredential`), kept with the service. */
  credential?: ApiKeyCredential
}

/** Where an added Claude instance keeps its own Claude home. */
export function claudePrivateHome(stateDir: string): string {
  return join(stateDir, 'home')
}
