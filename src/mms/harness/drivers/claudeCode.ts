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
import type { ProviderLoginResult } from '../../../shared/providerAuth'
import type { LoginSession } from '../../providers/LoginSession'
import { cliNames, ownedLaunchEnv, ownedUserEnv } from '../env'
import { decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver } from '../driver'
import { ownedHomeProblem } from '../ownedHome'
import { ptyAvailable, redactSignIn, runInPty, terminalText, transcriptLinks, type PtyRun, type PtySpawn } from '../pty'
import { runHarness } from '../spawn'
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
}

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
      const signInCommand = claudeSignInCommand(context.env.home)
      let service: ClaudeSubscriptionProviderService
      let entry: OwnedService | undefined
      const shared = Boolean(context.builtIn && options.builtIn)
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
            // An entry with its own home never applies variables that choose its sign-in (`environmentOf`).
            const configured = live().env.home ? ownedUserEnv('claude', config.env) : config.env
            return {
              ...(config.binaryPath ? { binaryPath: config.binaryPath } : {}),
              ...(config.args ? { args: config.args } : {}),
              ...(configured ? { env: configured } : {})
            }
          }
          const serviceOptions = {
            stateDir: context.stateDir,
            findBinary: () => live().findBinary(),
            baseEnv: () => environmentOf(live()),
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
