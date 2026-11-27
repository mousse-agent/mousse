import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { harnessAppError } from '../../../shared/harness/types'
import { AGENT_DEFAULT_MODEL } from '../acp/models'
import { parseThinkingSuffixFromModelId } from '../../../shared/modelVariants'
import type { InstallOwner } from '../../../shared/harness/status'
import type { ProviderLoginResult } from '../../../shared/providerAuth'
import type { LoginSession } from '../../providers/LoginSession'
import { cliLaunch, withUserEnv, type CliLaunch } from '../cliConfig'
import type { AcpConnection, AcpLaunchRequest } from '../acp/connection'
import { GROK_LABEL, GROK_PRESET, GROK_TESTED_VERSION, grokCaps } from '../acp/presets/grok'
import { compatibilityFields } from '../compatibility'
import type { AgentInstalls, PackageBinarySpec } from '../agents/install'
import { DIST_DIR } from '../agents/receipt'
import { compareVersions, decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver, type ManagedInstall } from '../driver'
import { cliNames, resolveCommand } from '../env'
import { grokCredential, grokHome, type GrokCredential } from '../grok/credential'
import { GROK_API_KEY_VARIABLE } from '../grok/variables'
import { ensureGrokHeldHome, grokHeldEnv, grokHeldHome, grokHeldPolicyProblem } from '../grok/held'
import { fingerprintOf, sameBinary } from '../status'
import type { BinaryFingerprint } from '../../../shared/harness/types'
import { runGrokHeldCheck } from '../grok/heldCheck'
import { GROK_HELD_SHIPPED, GrokHeldStore, grokHeldRecord, type GrokHeldRecord } from '../grok/heldEvidence'
import { collectRun, grokOneShotArgs, grokOneShotEnv, grokOneShotResult, writeGrokOneShotFiles } from '../grok/oneShot'
import { killTree, spawnHarness } from '../spawn'
import { ptyAvailable, runInPty, signInPrompts, type PtySpawn } from '../pty'
import { InstanceVault } from '../vault'
import { createAcpRuntime } from './acp'

/**
 * xAI's Grok CLI over ACP (the Grok preset of the ACP core). It runs the `grok` on PATH (the
 * official installer's `~/.grok/bin` included), an executable the user sets, or a copy Mousse
 * installs from xAI's npm package. Its sign-in is the home's `auth.json` (`grok login`, run by
 * Mousse in a terminal) or an xAI API key Mousse keeps; status reads the credential without
 * starting Grok (`grokCredential`).
 */

/** The install folder of managed copies under `agents/`. */
export const GROK_AGENT_ID = 'xai-grok'

/** The npm package of this computer's Grok build (`@xai-official/grok-win32-x64`). */
export function grokPackage(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const os = ({ win32: 'win32', darwin: 'darwin', linux: 'linux' } as Record<string, string>)[platform]
  const cpu = ({ x64: 'x64', arm64: 'arm64' } as Record<string, string>)[arch]
  return os && cpu ? `@xai-official/grok-${os}-${cpu}` : undefined
}

/**
 * The files of Grok's platform package by version range, checked at install (a missing one fails
 * it). The package holds only the brotli-compressed `grok`; its helpers (`grove`, `grove-credential`,
 * `grove-fsmonitor`) are not in it, so Grok fetches them into its home: a managed copy runs only
 * with a home of its own.
 */
export const GROK_FILESET: ReadonlyArray<{ min: string; max: string; files: (exe: string) => string[] }> = [
  { min: '1.0.0', max: '1.99999.0', files: (exe) => [`bin/grok${exe}`] }
]

/** What a managed install takes from the package, for `version` on `platform`. */
export function grokPackageSpec(version: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): PackageBinarySpec {
  const name = grokPackage(platform, arch)
  if (!name) throw new Error('xAI publishes no Grok for this computer.')
  const exe = platform === 'win32' ? '.exe' : ''
  const set = GROK_FILESET.find((entry) => compareVersions(version, entry.min) >= 0 && compareVersions(version, entry.max) <= 0)
  if (!set) throw new Error(`Mousse does not know the files of Grok ${version}.`)
  return {
    agentId: GROK_AGENT_ID,
    name,
    version,
    expand: { [`bin/grok${exe}.br`]: `bin/grok${exe}` },
    required: set.files(exe),
    cmd: `bin/grok${exe}`
  }
}

/** Vault entries. */
const SECRET = { apiKey: 'xai_api_key' } as const

export interface GrokDriverOptions {
  agents?: AgentInstalls
  /** Test seam: opens agent connections instead of starting Grok. */
  connect?: (context: DriverContext, request: AcpLaunchRequest) => AcpConnection
  /** Test seam: the pseudo-terminal for `grok login`. */
  pty?: { available: () => boolean; spawn?: PtySpawn }
  /** Test seam: the system config folder. */
  systemDir?: string
  now?: () => number
  /** Test seam: the platform the held check's records are matched on. */
  platform?: NodeJS.Platform
  /** Test seam: the records shipped with Mousse (`GROK_HELD_SHIPPED`). */
  shipped?: readonly GrokHeldRecord[]
  /** Test seam: the held check (`runGrokHeldCheck`). */
  heldCheck?: typeof runGrokHeldCheck
}

/** What the driver knows of one entry's held launch: its local records, and what keeps it from one. */
interface HeldEntry {
  store: GrokHeldStore
  /** Why this entry cannot run on a held home at all (a sign-in Mousse cannot carry there); undefined when it can. */
  problem(): string | undefined
}

/** After a check that could not conclude, the same version is checked again no sooner than this. */
export const GROK_HELD_RETRY_MS = 10 * 60_000

/** How long a read of whether the entry's sign-in can run on a held home is reused. */
const HELD_PROBLEM_TTL_MS = 2_000

/** A check found on its own (not one a person asked for) starts its held check this long after, never at app start. */
export const GROK_HELD_CHECK_DELAY_MS = 60_000

/** The sign-in methods Mousse offers for Grok, in order. */
export const GROK_SIGN_IN_METHODS = [
  { id: 'account', label: 'Sign in with your Grok account', description: 'Opens a device code to confirm in your browser.' },
  { id: 'api_key', label: 'API key', description: 'An xAI API key from console.x.ai.' }
] as const

export function grokDriver(options: GrokDriverOptions = {}): HarnessDriver {
  const platform = options.platform ?? process.platform
  const entries = new Map<string, HeldEntry>()
  const recordOf = (version: string | undefined, instanceId: string | undefined) =>
    grokHeldRecord(version, platform, (instanceId ? entries.get(instanceId)?.store.list() : undefined) ?? [], options.shipped ?? GROK_HELD_SHIPPED)
  /** Why turns (`turns`) or one-shots (`titles`) are not held for this entry's version; undefined when they are. */
  const gap = (what: 'turns' | 'titles', label: string, version: string | undefined, instanceId: string | undefined): string | undefined => {
    const problem = instanceId ? entries.get(instanceId)?.problem() : undefined
    if (problem) return problem
    if (!version) return `Mousse has not read which ${label} version runs here yet, so it has not checked that it asks before every tool.`
    const record = recordOf(version, instanceId)
    if (!record) return `Mousse has not yet checked that ${label} ${version} asks before every tool on this computer. The check runs in the background after the next check of this entry.`
    if (!record[what]) return `${record.reason ?? `${label} ${version} did not hold Mousse's check.`}`
    return undefined
  }
  return {
    kind: 'grok',
    label: GROK_LABEL,
    binaryNames: cliNames('grok'),
    ...compatibilityFields('grok'),
    latestVersion: { kind: 'npm', package: '@xai-official/grok' },
    multiInstance: true,
    privateHome: true,
    canInstall: true,
    customModels: false,
    methodLabel: 'Grok account or API key',
    // ACP updates do not name the MCP server: the bearer is kept only after a turn whose tool calls all completed.
    mcpTurnBinding: 'drained_turn',
    userMcp: 'native',
    // The agent's own `session/request_permission` flow decides (when it asks at all).
    relay: { approvals: 'runtime' },
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: true }),
    versionArgs: () => ['--version'],
    // Proven per executable: every admission stats it again (`HarnessDriver.binaryBoundCaps`).
    binaryBoundCaps: true,
    // Asks before every tool only where its held launch is proven for this version and platform.
    caps: (config, version, _facts, instanceId) => grokCaps(!gap('turns', config.displayName ?? GROK_LABEL, version, instanceId)),
    toolControlReason: (config, version, instanceId) => {
      const why = gap('turns', config.displayName ?? GROK_LABEL, version, instanceId)
      return why ? `${why} Until then, ${config.displayName ?? GROK_LABEL} runs only chats you drive, in Full access.` : undefined
    },
    // Chat titles, branch names, pull request drafts, commit messages, a bot's name and digest: one headless request
    // with no tools (`grok/oneShot.ts`), where the check proved it for this version.
    oneShot: true,
    oneShotRefusal: (config, version, instanceId) => gap('titles', config.displayName ?? GROK_LABEL, version, instanceId),
    updateCommand: (owner: InstallOwner) => (owner === 'standalone' ? 'grok update' : owner === 'npm' ? 'npm install -g @xai-official/grok@latest' : undefined),
    create: (context) => createGrokRuntime(context, options, (entry) => entries.set(context.instanceId, entry), (version) => recordOf(version, context.instanceId))
  }
}

function createGrokRuntime(context: DriverContext, options: GrokDriverOptions, register: (entry: HeldEntry) => void, recordOf: (version: string | undefined) => GrokHeldRecord | undefined): DriverRuntime {
  const label = context.config.displayName ?? GROK_LABEL
  const heldHome = grokHeldHome(context.stateDir)
  const heldStore = new GrokHeldStore(context.stateDir)
  const heldRun = options.heldCheck ?? runGrokHeldCheck
  /** The held check running now, and when each version's last inconclusive one ended. */
  let checking: AbortController | undefined
  const inconclusive = new Map<string, number>()
  /** What the last check of the entry read: the version, at the executable fingerprint it read it from. */
  let probedBinary: { version: string; fingerprint?: BinaryFingerprint } | undefined
  /** A held check waiting for its delay (`GROK_HELD_CHECK_DELAY_MS`). */
  let checkTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const vault = new InstanceVault(join(context.stateDir, 'secrets.json'))
  const agents = options.agents
  const ptyRuns = () => (options.pty ? options.pty.available() : ptyAvailable())
  /** Bumped by every sign-in start and cancel: a sign-in that finishes under an older one changes nothing. */
  let loginGeneration = 0

  const savedKey = (): string | undefined => {
    try {
      return vault.get(SECRET.apiKey)
    } catch (error) {
      console.warn('[harness] grok secrets unreadable', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /** The managed copy of the tested version, when it is installed. */
  const spec = (): PackageBinarySpec | undefined => {
    try {
      return grokPackageSpec(GROK_TESTED_VERSION)
    } catch {
      return undefined
    }
  }
  /**
   * The managed copy this entry installed: only an entry with its own home uses one, and only the
   * version it holds a reference to. Another entry's copy is never picked up, so an entry on the
   * user's own home always runs the user's own `grok`.
   */
  const installedNow = () => {
    if (!context.env.home || !agents) return undefined
    const ref = agents.reference(GROK_AGENT_ID, context.instanceId)
    return ref ? agents.installed(agents.packageSource({ agentId: GROK_AGENT_ID, version: ref.version })) : undefined
  }
  let verified: { hash: string; atMs: number } | undefined
  let filesChanged: string | undefined

  /** The executable: the entry's own, else a managed copy, else the one on PATH. */
  const program = (): { resolved: CliLaunch; managed: boolean; root?: string } | undefined => {
    if (context.config.binaryPath) {
      const resolved = resolveCommand(context.config.binaryPath, context.env)
      return resolved ? { resolved, managed: false } : undefined
    }
    const installed = installedNow()
    if (installed && agents) {
      const launch = agents.launch(installed, context.env)
      return { resolved: { path: launch.path, command: launch.command, args: launch.args }, managed: true, root: installed.root }
    }
    const found = context.findBinary()
    const resolved = found ? cliLaunch(found) : undefined
    return resolved ? { resolved, managed: false } : undefined
  }

  /**
   * The variables every Grok process starts with: the instance's own, then its saved key. The
   * updater and referrer variables come from the instance environment (private homes only).
   */
  const keyed = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const key = savedKey()
    return key ? withUserEnv(env, { [GROK_API_KEY_VARIABLE]: key }) : env
  }
  /**
   * Every process but a sign-in, a sign-out and the credential read runs on the held home (`grok/held.ts`), in every
   * mode: its sessions stay in one home whatever mode a thread is in, and in Full access Mousse answers each ask itself.
   * An entry whose sign-in Mousse cannot read runs on its own home (`heldProblem`).
   */
  const processEnv = (purpose: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const native = keyed(env)
    if (purpose === 'status' || purpose === 'sign_in' || purpose === 'sign_out' || heldProblem()) return native
    ensureGrokHeldHome(heldHome)
    return grokHeldEnv(native, heldHome)
  }

  /** The credential a Grok process of this instance would use now. */
  const credential = (): GrokCredential =>
    grokCredential({
      env: processEnv('status', withUserEnv(context.env.env, { ...(context.config.env ?? {}) })),
      ...(options.systemDir ? { systemDir: options.systemDir } : {}),
      ...(options.now ? { now: options.now() } : {})
    })

  /**
   * A sign-in Mousse cannot tell (another sign-in command, config or endpoint) may live in the home's own config: no
   * held home carries it. Read again at most every `HELD_PROBLEM_TTL_MS`: caps read it on every listing.
   */
  let problemRead: { atMs: number; value: string | undefined } | undefined
  const heldProblem = (): string | undefined => {
    const now = Date.now()
    if (problemRead && now - problemRead.atMs < HELD_PROBLEM_TTL_MS) return problemRead.value
    const found = credential()
    const value = found.kind === 'unknown'
      ? `Mousse cannot tell which account ${label} signs in with (${found.reason}), so it cannot run it on a home that asks before every tool.`
      : grokHeldPolicyProblem(heldHome, { ...(options.systemDir ? { systemDir: options.systemDir } : {}), env: context.env.env })
    problemRead = { atMs: now, value }
    return value
  }
  register({ store: heldStore, problem: heldProblem })

  /**
   * The executable a held launch starts must be the one the last check read: another one (a self-update, a replaced
   * file) has no proof yet, so nothing held starts on it until it is checked again. Throws with the reason.
   */
  const refuseChangedBinary = (path: string): void => {
    if (!probedBinary?.fingerprint) return
    if (!sameBinary(fingerprintOf(path), probedBinary.fingerprint))
      throw harnessAppError({ code: 'binding_stale', message: `The ${label} program changed since Mousse last checked it, so it does not start until it is checked again. Check again in Settings → Providers.` })
  }

  /**
   * After a check of the entry: a version with no record is checked in the background (`runGrokHeldCheck`), at once
   * when a person asked for the check, else after `GROK_HELD_CHECK_DELAY_MS`. One that could not conclude keeps the
   * last record and is tried again after `GROK_HELD_RETRY_MS`.
   */
  const probed = (version: string | undefined, info: { fingerprint?: BinaryFingerprint; soon: boolean } = { soon: false }): void => {
    probedBinary = version ? { version, ...(info.fingerprint ? { fingerprint: info.fingerprint } : {}) } : undefined
    if (stopped || !version || checking || recordOf(version) || heldProblem()) return
    const last = inconclusive.get(version)
    if (last !== undefined && Date.now() - last < GROK_HELD_RETRY_MS) return
    if (info.soon) {
      // A person asked: a check waiting for its delay starts now.
      if (checkTimer) clearTimeout(checkTimer)
      checkTimer = undefined
      startCheck(version)
    } else if (!checkTimer) {
      checkTimer = setTimeout(() => {
        checkTimer = undefined
        if (!stopped && probedBinary?.version === version && !recordOf(version)) startCheck(version)
      }, GROK_HELD_CHECK_DELAY_MS)
      checkTimer.unref?.()
    }
  }

  const startCheck = (version: string): void => {
    if (checking || stopped) return
    const found = program()
    if (!found) return
    const controller = new AbortController()
    checking = controller
    void (async () => {
      try {
        if (found.managed) await checkManaged(controller.signal, true)
        const record = await heldRun({
          command: found.resolved.command,
          args: found.resolved.args,
          env: withUserEnv(context.env.env, { ...(context.config.env ?? {}) }),
          cliVersion: version,
          log: (line) => console.warn('[harness]', line)
        }, controller.signal)
        if (controller.signal.aborted) return
        if (!record) {
          inconclusive.set(version, Date.now())
          return
        }
        heldStore.put(record)
        context.changed()
      } catch (error) {
        inconclusive.set(version, Date.now())
        console.warn('[harness] Grok held check failed', error instanceof Error ? error.message : String(error))
      } finally {
        if (checking === controller) checking = undefined
      }
    })()
  }

  const checkManaged = async (signal?: AbortSignal, reuse = false): Promise<void> => {
    const installed = program()?.managed ? installedNow() : undefined
    if (!installed || !agents) return
    if (reuse && verified?.hash === installed.hash && Date.now() - verified.atMs < 5_000 && !filesChanged) return
    const changed = await agents.changed(installed, undefined, signal)
    if (changed) {
      if (filesChanged !== changed) {
        filesChanged = changed
        context.changed()
      }
      throw new Error(`Installed files changed since install (${changed}). Reinstall ${label} in Settings → Providers.`)
    }
    filesChanged = undefined
    verified = { hash: installed.hash, atMs: Date.now() }
  }

  const base = createAcpRuntime(context, GROK_PRESET, {
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.pty ? { pty: options.pty } : {})
  }, ptyRuns, {
    driver: 'grok',
    program: () => {
      const found = program()
      if (!found) return undefined
      return { resolved: found.resolved, ...(found.root && agents ? { track: () => agents.track(found.root!) } : {}) }
    },
    env: (env, purpose) => processEnv(purpose, env),
    // A turn starts only on the executable its caps were proven for.
    launching: (purpose, executable) => {
      if (purpose === 'turn') refuseChangedBinary(executable)
    },
    checkInstall: ({ signal, reuse }) => checkManaged(signal, reuse),
    // A sign-out never signs the user's own home out of Grok; a private home is Mousse's own.
    agentLogout: () => Boolean(context.env.home),
    // Turns run on the held home: sessions saved on the entry's own home before cannot be reopened there.
    sessionsHome: heldHome
  })

  const reading = (): AuthReading => {
    const signInCommand = 'grok login --device-auth'
    const canSignIn = { canSignIn: true }
    const found = credential()
    switch (found.kind) {
      case 'api_key':
        return { state: 'signed_in', methodLabel: 'API key', subject: found.subject, ...canSignIn, ...(savedKey() ? { ownedByMousse: true } : {}) }
      case 'unknown':
        // Grok signs in some other way: Mousse cannot tell the account, so it resumes nothing.
        return { state: 'unknown', methodLabel: 'Set outside Mousse', message: `Mousse cannot tell which account Grok uses: ${found.reason}. Check again after changing it.` }
      case 'none':
        return { state: 'signed_out', methodLabel: 'Grok account or API key', signInCommand, ...canSignIn }
      case 'account':
        if (found.state === 'expired')
          return { state: 'expired', methodLabel: found.methodLabel, message: 'Your Grok sign-in expired.', signInCommand, ...canSignIn }
        return {
          state: 'signed_in',
          methodLabel: found.methodLabel,
          ...(found.subject ? { subject: found.subject } : {}),
          ...(found.state === 'refreshing' ? { message: 'Grok renews its sign-in on the next chat.' } : {}),
          ...canSignIn
        }
    }
  }

  const saveApiKey = (apiKey: string): void => {
    const key = apiKey.trim()
    if (!key) throw new Error('Paste an xAI API key.')
    vault.set(SECRET.apiKey, key)
    // Threads move to the new account through the gateway: their next admission reads a new identity.
    context.changed()
  }

  /**
   * `grok login --device-auth` in a terminal. A private home signs in into a staging home first;
   * its `auth.json` replaces the instance's only when the command succeeds and nobody cancelled, so
   * a late success after a cancel changes nothing.
   */
  const signInAccount = async (session: LoginSession): Promise<void> => {
    const generation = ++loginGeneration
    const found = program()
    if (!found) throw new Error(`${label} is not installed.`)
    if (!ptyRuns()) {
      throw new Error(`Mousse cannot open a sign-in terminal here. Run \`grok login --device-auth\`${context.env.home ? ` with GROK_HOME=${context.env.home}` : ''} in a terminal, then check again.`)
    }
    // A managed copy runs only while its files match its install record.
    await checkManaged(session.abort.signal)
    const home = context.env.home
    const staging = home ? mkdtempSync(join(context.stateDir, 'login-')) : undefined
    try {
      const env = processEnv('sign_in', withUserEnv(context.env.env, { ...(context.config.env ?? {}), ...(staging ? { GROK_HOME: staging } : {}) }))
      // The device sign-in never uses a key: the account's own token is what it writes.
      for (const name of Object.keys(env)) if (name.toUpperCase() === GROK_API_KEY_VARIABLE) delete env[name]
      const shown = new Set<string>()
      const run = runInPty(found.resolved.command, [...found.resolved.args, 'login', '--device-auth'], {
        env,
        ...(options.pty?.spawn ? { spawn: options.pty.spawn } : {}),
        onOutput: (transcript) => {
          const prompt = signInPrompts(transcript)
          if (prompt.url && prompt.userCode && !shown.has(prompt.userCode)) {
            shown.add(prompt.userCode)
            session.emitEvent({ sessionId: session.sessionId, type: 'device_code', userCode: prompt.userCode, verificationUri: prompt.url })
          } else if (prompt.url && !prompt.userCode && !shown.has(prompt.url)) {
            shown.add(prompt.url)
            session.emitEvent({ sessionId: session.sessionId, type: 'auth_url', url: prompt.url, usesCallbackServer: false })
          }
        }
      })
      const cancel = () => {
        loginGeneration += 1
        run.cancel()
      }
      session.abort.signal.addEventListener('abort', cancel, { once: true })
      let exitCode: number
      try {
        ;({ exitCode } = await run.done)
      } finally {
        session.abort.signal.removeEventListener('abort', cancel)
      }
      if (session.abort.signal.aborted || generation !== loginGeneration) throw new Error('Login cancelled')
      if (exitCode !== 0) throw new Error(`grok login exited with code ${exitCode}.`)
      if (home && staging) {
        const signedIn = join(staging, 'auth.json')
        if (!existsSync(signedIn)) throw new Error('grok login finished without signing in.')
        mkdirSync(home, { recursive: true, mode: 0o700 })
        // Replaced in one step: a Grok running in the home never reads a half-written file.
        const temporary = join(home, `.auth.json.${process.pid}.${Date.now()}`)
        try {
          copyFileSync(signedIn, temporary)
          renameSync(temporary, join(home, 'auth.json'))
        } finally {
          rmSync(temporary, { force: true })
        }
      }
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true })
    }
  }

  const signIn = async (session: LoginSession, cwd: string, method?: string): Promise<ProviderLoginResult> => {
    try {
      let chosen = GROK_SIGN_IN_METHODS.find((entry) => entry.id === method)?.id
      if (!chosen) {
        const picked = await session.createAuthCallbacks().prompt({
          type: 'select',
          message: `How do you sign in to ${label}?`,
          options: GROK_SIGN_IN_METHODS.map((entry) => ({ id: entry.id, label: entry.label, description: entry.description }))
        })
        chosen = GROK_SIGN_IN_METHODS.find((entry) => entry.id === picked)?.id
        if (!chosen) throw new Error('Choose a sign-in method.')
      }
      if (chosen === 'api_key') {
        const key = await session.createAuthCallbacks().prompt({ type: 'secret', message: 'Paste an xAI API key (console.x.ai → API keys).', placeholder: 'xai-…' })
        session.abort.signal.throwIfAborted()
        saveApiKey(key)
        return { success: true, sessionId: session.sessionId }
      }
      if (!ptyRuns()) {
        // No terminal here: Grok's own browser sign-in over ACP, then the same check as any agent.
        return await base.signIn!(session, cwd, 'grok.com')
      }
      await signInAccount(session)
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      return { success: false, sessionId: session.sessionId, error: session.abort.signal.aborted ? 'Login cancelled' : error instanceof Error ? error.message : String(error) }
    }
  }

  const managed = (): ManagedInstall | undefined => {
    const installed = installedNow()
    if (!installed) return undefined
    return {
      path: join(installed.root, DIST_DIR, ...installed.receipt.launch.cmd.split('/')),
      version: installed.receipt.version,
      bytes: installed.receipt.bytes,
      checksum: installed.receipt.checksum,
      receiptHash: installed.hash,
      ...(filesChanged ? { broken: filesChanged } : {})
    }
  }

  const runtime: DriverRuntime = {
    ...base,
    configured: () => {
      if (!program()) return false
      if (managed()?.broken) return false
      const found = credential()
      return found.kind === 'api_key' || found.kind === 'unknown' || (found.kind === 'account' && found.state !== 'expired')
    },
    llmProvider: () => (runtime.configured() ? { id: context.instanceId, label, models: runtime.models() } : undefined),
    // No process is started: the credential decides.
    auth: async () => reading(),
    // Read at every admission: a credential replaced outside Mousse moves the account generation on.
    identity: async () => {
      const found = credential()
      return found.kind === 'api_key' || found.kind === 'account' ? found.subject : undefined
    },
    probed,
    oneShot: async (spec, signal) => {
      signal.throwIfAborted()
      const found = credential()
      if (found.kind === 'none' || (found.kind === 'account' && found.state === 'expired'))
        throw harnessAppError({ code: 'signed_out', message: `Sign in to ${label} in Settings → Providers.` })
      // The gateway admits a one-shot only on a version the check proved, and only on the executable it read.
      const record = recordOf(probedBinary?.version)
      if (!record?.titles) throw harnessAppError({ code: 'unsupported', message: `Mousse has not proven that this ${label} runs a request with no tools.` })
      const running = program()
      if (!running) throw harnessAppError({ code: 'not_installed', message: `${label} is not installed.` })
      refuseChangedBinary(running.resolved.path)
      if (running.managed) await checkManaged(signal, true)
      const { baseId, effort } = parseThinkingSuffixFromModelId(spec.model)
      const root = join(context.stateDir, 'one-shot', randomUUID())
      try {
        const files = writeGrokOneShotFiles({ root, system: spec.system, prompt: spec.prompt })
        const env = grokOneShotEnv(keyed(withUserEnv(context.env.env, { ...(context.config.env ?? {}) })), files)
        const args = grokOneShotArgs({ ...files, ...(baseId && baseId !== AGENT_DEFAULT_MODEL ? { model: baseId } : {}), ...(effort ? { effort } : {}), tools: record.tools })
        const child = spawnHarness({ ...context.env, env }, 'grok-one-shot', running.resolved.command, [...running.resolved.args, ...args], { cwd: files.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        spec.onActivity()
        const run = await collectRun(child, signal, () => killTree(child))
        signal.throwIfAborted()
        return { text: grokOneShotResult(label, run) }
      } finally {
        try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* a leftover folder is harmless */ }
      }
    },
    signIn,
    stop: () => {
      stopped = true
      if (checkTimer) clearTimeout(checkTimer)
      checkTimer = undefined
      checking?.abort()
      return base.stop()
    },
    signOut: async () => {
      checking?.abort()
      if (checkTimer) clearTimeout(checkTimer)
      checkTimer = undefined
      problemRead = undefined
      loginGeneration += 1
      vault.set(SECRET.apiKey, undefined)
      // A private home's sign-in is Mousse's own: it goes too. The user's own home is left alone.
      if (context.env.home) rmSync(join(grokHome(context.env.env), 'auth.json'), { force: true })
      await base.signOut?.()
    },
    adoptApiKey: async (apiKey) => saveApiKey(apiKey),
    ...(agents ? {
      install: async (onProgress) => {
        const wanted = spec()
        if (!wanted) throw new Error('xAI publishes no Grok for this computer.')
        // Grok fetches its helpers into its home: a copy Mousse installs runs only with a home of its own.
        if (!context.env.home) throw new Error(`Mousse installs its own Grok only for an entry with its own home. Turn on "Own home" for ${label}, or install Grok yourself.`)
        await agents.installPackageBinary({ instanceId: context.instanceId, spec: wanted, env: context.env, label, onProgress })
        filesChanged = undefined
      },
      cancelInstall: () => agents.cancel(context.instanceId),
      installState: () => ({ installing: agents.installing(context.instanceId) }),
      managed,
      verifyInstall: async (signal) => {
        try {
          await checkManaged(signal)
        } catch {
          // Shown through `managed().broken`.
        }
      },
      // The version this entry holds (it may predate the one Mousse installs now).
      removeInstall: async ({ force }) => {
        const ref = agents.reference(GROK_AGENT_ID, context.instanceId)
        if (!ref) return { removed: true, bytes: 0 }
        return agents.removeInstall({ instanceId: context.instanceId, source: agents.packageSource({ agentId: GROK_AGENT_ID, version: ref.version }), force })
      },
      release: async () => {
        const ref = agents.reference(GROK_AGENT_ID, context.instanceId)
        if (ref) await agents.release(context.instanceId, agents.packageSource({ agentId: GROK_AGENT_ID, version: ref.version }))
      }
    } : {})
  }
  return runtime
}
