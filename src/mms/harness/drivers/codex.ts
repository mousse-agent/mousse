import { mkdirSync } from 'node:fs'
import type { InstallOwner } from '../../../shared/harness/status'
import type { HarnessCaps } from '../../../shared/harness/types'
import type { PermissionLimits } from '../../../shared/permissionMode'
import type { ProviderLoginResult } from '../../../shared/providerAuth'
import { CODEX_INSTANCE_ID } from '../../../shared/providerInstances'
import type { StoredCliConfig } from '../../providers/cliConfig'
import { spawnCodexAppServer, type CodexLaunch, type CodexProcess } from '../../providers/codex/CodexAppServerClient'
import { codexEnvironment, CodexProviderService } from '../../providers/codex/CodexProviderService'
import type { LoginSession } from '../../providers/LoginSession'
import { CODEX_CAPABILITIES, CodexAdapter } from '../../run/adapters/codex/CodexAdapter'
import { cliNames, ownedLaunchEnv, ownedUserEnv } from '../env'
import { usageWindows } from '../../providers/codex/rateLimits'
import { decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver, type InstanceConfig, type RuntimeUsage } from '../driver'
import { createManagedCodexRuntime } from '../codex/managedRuntime'
import { ownedHomeProblem } from '../ownedHome'
import { ptyAvailable, redactSignIn, runInPty, terminalText, transcriptLinks, type PtyRun, type PtySpawn } from '../pty'
import { recordHarnessSpawn, runHarness } from '../spawn'
import { ALL_MIRROR_FIELDS, SIGN_OUT_MIRROR_FIELDS } from '../vendorMirror'

/** Codex CLI versions Mousse was tested with. */
export const CODEX_TESTED_VERSIONS = { min: '0.100.0', max: '0.162.999' }

export const CODEX_CAPS: HarnessCaps = Object.freeze({
  ...CODEX_CAPABILITIES,
  planMode: true,
  contextUsage: 'reported',
  // Codex asks Mousse before each tool under the approval policy Mousse sets.
  toolControl: 'approval_only',
  budgets: 'unsupported',
  spendLimits: 'unsupported',
  definitionLimits: 'none'
})

const SIGN_IN_COMMAND = 'codex login'

/**
 * The terminal command that signs an instance with its own home in, the home passed as `CODEX_HOME`.
 * On Windows it runs through `cmd /c`, which works the same pasted into Command Prompt or
 * PowerShell and leaves the terminal's own environment unchanged.
 */
export function codexSignInCommand(home: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (!home) return SIGN_IN_COMMAND
  return platform === 'win32'
    ? `cmd /c "set CODEX_HOME=${home}&& codex login --device-auth"`
    : `CODEX_HOME='${home.replace(/'/g, `'\\''`)}' codex login --device-auth`
}

/** How long a sign-in may take before Mousse ends it: a little after the one-time code expires (15 minutes). */
export const CODEX_SIGN_IN_TIMEOUT_MS = 16 * 60_000

/** How long a terminal that printed its success may take to exit before it is ended (it is writing its files). */
export const CODEX_SUCCESS_GRACE_MS = 5_000

/** The terminal is made wide so a long link is printed on one line. */
const SIGN_IN_COLUMNS = 1000

/** What Mousse tells the user when Codex says it signed in but the home does not hold the sign-in. */
export const CODEX_NOT_STORED_MESSAGE =
  'Codex did not store the sign-in in this account\'s home. If Codex keeps its sign-in in the operating system\'s credential store, set `cli_auth_credentials_store = "file"` in the config.toml of that home, then sign in again.'

/**
 * The link and one-time code of Codex's device sign-in, read from the terminal's output: the link
 * under "Open this link" and the code under "Enter this one-time code", each only once its line is
 * complete (a half-printed code is never shown). A link printed before that step (an update
 * notice) is not taken for the sign-in link.
 */
export function codexDeviceCode(transcript: string): { url: string; userCode: string } | undefined {
  const text = terminalText(transcript)
  const step = text.search(/open this link/i)
  if (step < 0) return undefined
  const after = text.slice(step)
  const url = transcriptLinks(after)[0]
  if (!url || !new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\r?\\n`).test(after)) return undefined
  const afterLink = after.slice(after.indexOf(url) + url.length)
  const code = /one-time code[\s\S]{0,120}?\b([A-Z0-9]{3,10}(?:-[A-Z0-9]{3,10})+)[ \t]*\r?\n/.exec(afterLink)?.[1]
  return code ? { url, userCode: code } : undefined
}

/**
 * What Codex cannot enforce. Auto-accept edits needs `untrusted` + read-only to apply a patch after
 * Mousse accepts it while a mutating command still waits for Mousse's answer. That is proven only by
 * a recorded app-server exchange of both halves, and none is recorded yet (capturing one needs a
 * signed-in Codex account), so Codex does not offer the mode: a thread set to it asks about edits
 * as well, and the composer says so. Add the two fixtures, then remove this limit.
 */
export const CODEX_PERMISSION_LIMITS: PermissionLimits = Object.freeze({
  // Full access is Codex's own full-access profile: `never` ask and no sandbox (`codexTurnPolicy`).
  sandboxOffInFull: true,
  unavailable: Object.freeze({ accept_edits: 'Codex cannot auto-accept edits while asking for commands' })
})

/** An added instance with its own home: the command that signs it in, and whether Mousse can do it. */
interface OwnedSignIn {
  command: string
  inApp: boolean
}

function readAuth(service: CodexProviderService, status: Awaited<ReturnType<CodexProviderService['status']>>, owned?: OwnedSignIn): AuthReading {
  const methodLabel = 'ChatGPT sign-in'
  switch (status.state) {
    case 'connected': {
      const account = service.account()
      return { state: 'signed_in', methodLabel, ...(account?.label ? { account: { label: account.label } } : {}), ...(account?.subject ? { subject: account.subject } : {}) }
    }
    case 'signed_out':
    case 'disconnected':
      // Signed in from Mousse: the Sign in button, with the command to copy kept beside it as the fallback.
      if (owned)
        return {
          state: 'signed_out',
          methodLabel,
          message: owned.inApp ? 'Not signed in. Choose Sign in to sign this account in.' : 'Not signed in. Run the command below in a terminal, then check again.',
          signInCommand: owned.command,
          ...(owned.inApp ? { canSignIn: true } : {})
        }
      return { state: 'signed_out', methodLabel, message: status.message, signInCommand: SIGN_IN_COMMAND }
    default:
      return { state: 'unknown', methodLabel, ...(status.message ? { message: status.message } : {}) }
  }
}

/**
 * The plan's limits as Codex reports them to the user's own sign-in (the same numbers the CLI
 * shows). When Codex cannot be asked now, the last snapshot it sent stands in and says so.
 */
async function readUsage(service: CodexProviderService, signal: AbortSignal): Promise<RuntimeUsage> {
  const limits = await service.rateLimits(signal)
  const windows = usageWindows(limits.snapshot)
  if (!windows.length) return { status: 'unavailable', windows: [], message: 'Codex reported no usage limits for this plan.' }
  return {
    status: 'available',
    windows,
    ...(limits.live ? {} : { message: `Codex could not be reached; these are the limits it last reported (${new Date(limits.at).toISOString()}).` })
  }
}

/**
 * Codex's own config: `setup` (absent = `existing`, so the built-in entry is unchanged). A managed
 * entry always runs in its private home. An entry on the user's own Codex CLI may have one (another
 * account, signed in from Mousse); the built-in `codex` entry never does, whatever was stored.
 */
export function decodeCodexConfig(raw: Record<string, unknown> | undefined, instanceId?: string): InstanceConfig {
  const managed = raw?.setup === 'managed'
  const config = decodeInstanceConfig(raw, { privateHome: true })
  if (managed) return { ...config, setup: 'managed', home: 'private' }
  if (instanceId === CODEX_INSTANCE_ID) config.home = 'default'
  return { ...config, ...(raw?.setup === 'existing' ? { setup: 'existing' as const } : {}) }
}

export interface CodexDriverOptions {
  /** The profile's service for the built-in `codex` instance (shared with usage and Settings). */
  builtIn: () => CodexProviderService
  /** A managed entry's runtime (default: Mousse's own download and ChatGPT sign-in). */
  managed?: (context: DriverContext) => DriverRuntime
  /** Test seam: whether a sign-in terminal runs here, and the terminal it runs in (default: `node-pty`). */
  pty?: { available: () => boolean; spawn?: PtySpawn }
  /** Test seam: how long a sign-in may take (default `CODEX_SIGN_IN_TIMEOUT_MS`). */
  signInTimeoutMs?: number
  /** Test seam: starts the app-server of an added instance (default: the real process). */
  launch?: (launch: CodexLaunch) => CodexProcess
  /** Test seam: the platform the sign-in command is written for (default `process.platform`). */
  platform?: NodeJS.Platform
}

/** The service of each added instance and the runtimes using it (`codexDriver`). */
interface OwnedService {
  service: CodexProviderService
  home: string | undefined
  /** The newest runtime's context, which the service reads. */
  context: DriverContext
  users: number
}

/**
 * Codex through `codex app-server`. The built-in entry reuses the terminal `codex login`; a managed
 * entry (`setup: managed`) runs Mousse's pinned Codex in its own home and signs in with ChatGPT in
 * Mousse (`codex/managedRuntime.ts`). Any other added entry runs the user's own Codex CLI: with a
 * home of its own (another account) it signs in and out there from Mousse with Codex's own device
 * sign-in; on the user's home it runs as the built-in does.
 */
export function codexDriver(options: CodexDriverOptions): HarnessDriver {
  /**
   * The service of each added instance, kept across the runtimes a config change rebuilds: one
   * service, and so one writer, per instance's settings file, and a sign-in running when its own
   * executable prompt saves a path goes on. It reads the newest runtime's context, and stops when
   * the last runtime using it stops. A new home gets a new service; the old one stops writing.
   */
  const owned = new Map<string, OwnedService>()
  const platform = options.platform ?? process.platform
  return {
    kind: 'codex',
    label: 'Codex',
    binaryNames: cliNames('codex'),
    testedVersions: CODEX_TESTED_VERSIONS,
    latestVersion: { kind: 'npm', package: '@openai/codex' },
    multiInstance: true,
    privateHome: true,
    // A managed entry always has a home of its own; an entry on the user's own Codex CLI may (another account).
    privateHomeFor: (config) => (config.setup === 'managed' ? 'required' : 'allowed'),
    canInstall: true,
    customModels: true,
    methodLabel: 'ChatGPT sign-in',
    // Codex forks a loaded thread when its bearer changes, so the bearer is kept after turns proven drained.
    mcpTurnBinding: 'drained_turn',
    userMcp: 'native',
    // Codex passes MCP image content to the model; the ChatGPT models it runs read images.
    mcpImageResults: true,
    mirrorsVendorFile: true,
    decodeConfig: decodeCodexConfig,
    caps: () => CODEX_CAPS,
    updateCommand: (owner: InstallOwner) => {
      if (owner === 'npm') return 'npm install -g @openai/codex@latest'
      if (owner === 'brew') return 'brew upgrade codex'
      return undefined
    },
    create(context: DriverContext): DriverRuntime {
      // A managed entry keeps its own runtime and ChatGPT sign-in.
      if (context.config.setup === 'managed') return (options.managed ?? createManagedCodexRuntime)(context)
      if (context.builtIn) {
        const service = options.builtIn()
        return {
          ...serviceRuntime(service),
          // The user's own Codex mirrors its launch settings and sign-out to its settings.json for an older Mousse.
          vendorMirror: service.vendorMirror(ALL_MIRROR_FIELDS),
          validateLaunch: (patch) => service.validateLaunch(patch),
          launchChanged: () => service.launchChanged(),
          auth: async ({ force }) => readAuth(service, await service.status({ force })),
          signIn: (session, cwd) => service.login(session, cwd),
          signOut: () => service.logout(),
          // The profile owns the built-in service and stops it.
          stop: () => {}
        }
      }
      return ownedRuntime(context)
    }
  }

  /** What every Codex runtime does with its service: turns, listings, usage, refresh. */
  function serviceRuntime(service: CodexProviderService): Pick<DriverRuntime, 'adapter' | 'configured' | 'configuredProvider' | 'llmProvider' | 'models' | 'modelsRefreshedAt' | 'usage' | 'permissionLimits' | 'refreshModels' | 'forgetConversation'> {
    return {
      adapter: new CodexAdapter(() => service),
      configured: () => service.configured(),
      configuredProvider: () => service.configuredProvider(),
      llmProvider: () => service.llmProvider(),
      models: () => service.models(),
      modelsRefreshedAt: () => service.modelsRefreshedAt(),
      usage: (signal) => readUsage(service, signal),
      permissionLimits: () => CODEX_PERMISSION_LIMITS,
      refreshModels: async () => {
        await service.status()
        await service.refreshModels()
      },
      forgetConversation: (threadId) => service.forgetConversation(threadId)
    }
  }

  /**
   * An added entry on the user's own Codex CLI. With a home of its own it is another account: every
   * process of it (status checks, turns, the sign-in and the sign-out) runs with its own
   * `CODEX_HOME` and without any credential from Mousse's environment or its own settings
   * (`ownedLaunchEnv`), and Mousse signs it in with `codex login --device-auth` and out with
   * `codex logout` there. On the user's home it runs as the built-in does, with the terminal sign-in.
   */
  function ownedRuntime(context: DriverContext): DriverRuntime {
    const privateHome = context.env.home
    const signInCommand = codexSignInCommand(privateHome, platform)
    const ptyRuns = () => (options.pty ? options.pty.available() : ptyAvailable())
    if (privateHome && !ownedHomeProblem(privateHome, context.profileHome)) mkdirSync(privateHome, { recursive: true, mode: 0o700 })
    let entry = owned.get(context.instanceId)
    if (entry && entry.home !== privateHome) {
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
      entry = {
        service: new CodexProviderService(context.profileHome, context.questions, {
          findBinary: () => live().findBinary(),
          launch: (spec) => {
            recordHarnessSpawn({ instanceId: context.instanceId, purpose: 'app-server', command: spec.binary, args: spec.args, env: spec.env })
            return (options.launch ?? spawnCodexAppServer)(spec)
          }
        }, {
          dir: context.stateDir,
          // One environment for every process of such an instance: what it configures never moves its home or brings a credential back.
          env: () => environmentOf(live()),
          launch: (): StoredCliConfig => launchOf(live()),
          signedOut: () => live().signedOut(),
          saveLaunch: (patch) => live().saveLaunch(patch),
          // A home that is a link would run another account's sign-in: nothing starts in it.
          ...(privateHome
            ? {
                prepareLaunch: async () => {
                  const problem = ownedHomeProblem(privateHome, live().profileHome)
                  if (problem) throw new Error(problem)
                  return { args: [], onExit: () => {} }
                }
              }
            : {})
        }),
        home: privateHome,
        context,
        users: 0
      }
      owned.set(context.instanceId, entry)
    }
    entry.users += 1
    const user = entry
    const service = user.service
    let stopped = false
    /** The sign-in terminal that is running, so removing the instance can end it. */
    let activeRun: PtyRun | undefined

    const homeProblem = (): string | undefined => (privateHome ? ownedHomeProblem(privateHome, context.profileHome) : undefined)
    /** The home is the folder the sign-in commands start in: it exists by then (checked just before, so it is no link). */
    const ensureHome = (): void => void (privateHome && mkdirSync(privateHome, { recursive: true, mode: 0o700 }))

    /**
     * `codex login --device-auth` in the instance's home. The link and one-time code go to the page,
     * and the sign-in counts only once Codex in that home says it is signed in. The terminal's output
     * is never logged or stored.
     */
    const signInInTerminal = async (session: LoginSession): Promise<ProviderLoginResult> => {
      const secrets: string[] = []
      const fail = (message: string): ProviderLoginResult => ({ success: false, sessionId: session.sessionId, error: redactSignIn(message, secrets) })
      const cancelled = () => session.abort.signal.aborted
      // Only a folder Mousse owns: a link to another account's folder would sign that account in.
      const problem = homeProblem()
      if (problem) return fail(problem)
      const launch = service.authLaunch()
      if (!launch) return fail('Codex was not found. Install it or set its path in this provider\'s settings, then try again.')
      if (!ptyRuns()) return signInByCommand(session)
      ensureHome()
      let sawSuccess = false
      let timedOut = false
      let shown: string | undefined
      let run: PtyRun | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let grace: ReturnType<typeof setTimeout> | undefined
      /** Ends the terminal; one that already printed its success is left to finish writing its files first. */
      const stopRun = () => {
        if (!sawSuccess) run?.cancel()
        else grace ??= setTimeout(() => run?.cancel(), CODEX_SUCCESS_GRACE_MS)
      }
      try {
        // A running app-server keeps the account it started with, and would write its old tokens back over the new sign-in.
        await service.stopAll('Signing in')
        if (cancelled()) return fail('Login cancelled')
        run = runInPty(launch.command, [...launch.args, 'login', '--device-auth'], {
          env: launch.env,
          // The home is the folder Codex starts in: no project settings of Mousse's own folder are read.
          cwd: privateHome!,
          cols: SIGN_IN_COLUMNS,
          ...(options.pty?.spawn ? { spawn: options.pty.spawn } : {}),
          onOutput: (transcript) => {
            const found = codexDeviceCode(transcript)
            if (found && shown !== found.userCode) {
              shown = found.userCode
              secrets.push(found.userCode)
              session.emitEvent({ sessionId: session.sessionId, type: 'device_code', userCode: found.userCode, verificationUri: found.url, expiresInSeconds: 15 * 60 })
            }
            if (/successfully logged in/i.test(terminalText(transcript))) sawSuccess = true
          }
        })
        activeRun = run
        session.abort.signal.addEventListener('abort', stopRun, { once: true })
        timer = setTimeout(() => {
          timedOut = true
          stopRun()
        }, options.signInTimeoutMs ?? CODEX_SIGN_IN_TIMEOUT_MS)
        timer.unref?.()
        let exitCode: number
        try {
          ;({ exitCode } = await run.done)
        } finally {
          clearTimeout(timer)
          clearTimeout(grace)
          session.abort.signal.removeEventListener('abort', stopRun)
          activeRun = undefined
        }
        // Codex accepted the sign-in and finished before the stop reached it.
        const finished = sawSuccess && exitCode === 0
        if (cancelled()) {
          // The account is signed in in its home all the same: Mousse takes it up, so nothing is half done.
          if (finished) await service.reconnect().catch(() => undefined)
          return fail('Login cancelled')
        }
        if (timedOut && !finished) return fail('Sign-in timed out. Start it again.')
        if (exitCode !== 0) return fail(`codex login exited with code ${exitCode}.`)
        // Only Codex's own check in this home counts.
        const signedIn = await service.reconnect()
        if (cancelled()) return fail('Login cancelled')
        if (!signedIn) return fail(CODEX_NOT_STORED_MESSAGE)
        await service.refreshModels().catch(() => undefined)
        return { success: true, sessionId: session.sessionId }
      } catch (error) {
        return fail(cancelled() ? 'Login cancelled' : error instanceof Error ? error.message : String(error))
      }
    }

    /** No terminal here: the command to copy, with the home in it, and a check after the user ran it. */
    const signInByCommand = async (session: LoginSession): Promise<ProviderLoginResult> => {
      const interaction = session.createAuthCallbacks()
      try {
        for (;;) {
          session.abort.signal.throwIfAborted()
          // Each check starts a new Codex process: one that ran before the sign-in knows nothing of it.
          if (await service.reconnect()) break
          session.abort.signal.throwIfAborted()
          const answer = await interaction.prompt({
            type: 'select',
            message: `Mousse cannot open a sign-in terminal here. Run this in a terminal, then choose Check sign-in: ${signInCommand}`,
            options: [
              { id: 'check', label: 'Check sign-in' },
              { id: 'cancel', label: 'Cancel' }
            ]
          })
          if (answer !== 'check') throw new Error('Codex sign-in cancelled')
        }
        await service.refreshModels().catch(() => undefined)
        return { success: true, sessionId: session.sessionId }
      } catch (error) {
        return { success: false, sessionId: session.sessionId, error: session.abort.signal.aborted ? 'Login cancelled' : redactSignIn(error instanceof Error ? error.message : String(error)) }
      }
    }

    /**
     * `codex logout` in the instance's home, then Mousse's own sign-out. It counts only when Codex in
     * that home then says signed out: a command that did not run or did not work, with the account
     * still signed in, is an error the user sees, and nothing is recorded.
     */
    const signOutOfHome = async (): Promise<void> => {
      const problem = homeProblem()
      if (problem) throw new Error(problem)
      const launch = service.authLaunch()
      if (!launch) throw new Error('Codex was not found, so this account cannot be signed out. Install it or set its path, then try again.')
      // Nothing may hold the sign-in while it is removed: a running app-server would write its cached tokens back.
      await service.stopAll('Signing out')
      ensureHome()
      const result = await runHarness({ ...context.env, env: launch.env }, 'auth', launch.command, [...launch.args, 'logout'], { timeoutMs: 15_000, cwd: privateHome! })
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
      throw new Error(`Codex was not signed out: \`codex logout\` ${why}. ${state === 'signed_in' ? 'The account is still signed in.' : 'Mousse could not confirm the account is signed out.'} Mousse has stopped using it here; sign in again to use it, or run the command in a terminal to finish the sign-out.`)
    }

    return {
      ...serviceRuntime(service),
      // A home that is a link is never used, so the account behind the link is never asked or run as.
      configured: () => !homeProblem() && service.configured(),
      // An added entry mirrors only its sign-out to its settings.json for an older Mousse.
      vendorMirror: service.vendorMirror(SIGN_OUT_MIRROR_FIELDS),
      validateLaunch: (patch) => service.validateLaunch(patch),
      launchChanged: () => service.launchChanged(),
      auth: async ({ force }) => {
        const problem = homeProblem()
        if (problem) return { state: 'unknown', methodLabel: 'ChatGPT sign-in', message: problem }
        return readAuth(service, await service.status({ force }), privateHome ? { command: signInCommand, inApp: ptyRuns() } : undefined)
      },
      signIn: privateHome ? signInInTerminal : (session, cwd) => service.login(session, cwd),
      signOut: privateHome ? signOutOfHome : () => service.logout(),
      stop: () => {
        if (stopped) return
        stopped = true
        user.users -= 1
        // A config change retires this runtime just before it builds the next one, which takes the
        // service over: it stops only when no runtime took it by then.
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

/** One environment for every process of an added instance: with a home of its own, the owned one. */
function environmentOf(from: DriverContext): NodeJS.ProcessEnv {
  return codexEnvironment(from.env.home ? ownedLaunchEnv('codex', from.env, from.config.env) : from.env.env)
}

/** The launch settings of an added instance: an entry with its own home never applies variables that choose its sign-in. */
function launchOf(from: DriverContext): StoredCliConfig {
  const config = from.config
  const configured = from.env.home ? ownedUserEnv('codex', config.env) : config.env
  return {
    ...(config.binaryPath ? { binaryPath: config.binaryPath } : {}),
    ...(config.args ? { args: config.args } : {}),
    ...(configured && Object.keys(configured).length ? { env: configured } : {})
  }
}
