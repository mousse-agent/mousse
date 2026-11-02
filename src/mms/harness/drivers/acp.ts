import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { methods } from '@agentclientprotocol/sdk'
import { RESERVED_AGENT_IDS, type HarnessCaps, type HarnessDriverKind, type RuntimeFacts } from '../../../shared/harness/types'
import type { ProviderLoginResult } from '../../../shared/providerAuth'
import type { LlmModelOption } from '../../../shared/settings'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { LoginSession } from '../../providers/LoginSession'
import { AcpAdapter } from './acp/adapter'
import { decodeAuthMethods, type AcpAuthMethod } from '../acp/auth'
import { connectAcpProcess, type AcpConnection, type AcpConnectionFactory, type AcpLaunchRequest, type AcpPurpose } from '../acp/connection'
import { AGENT_DEFAULT_MODEL } from '../acp/models'
import type { AcpLaunch, AcpPreset, AcpSource } from '../acp/preset'
import { GENERIC_ACP_PRESET } from '../acp/presets/generic'
import { AcpSessions, type AcpObservations, type SavedAcpSession } from '../acp/session'
import { decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver, type InstanceConfig, type LiveProcessHost, type ManagedInstall, type RuntimeFactsReport } from '../driver'
import { withUserEnv, type CliLaunch } from '../cliConfig'
import type { AgentInstalls, InstalledAgent, RegistrySource } from '../agents/install'
import { DIST_DIR } from '../agents/receipt'
import { resolveCommand } from '../env'
import { ptyAvailable, runInPty, signInPrompts, type PtySpawn } from '../pty'
import { killTree, spawnHarness } from '../spawn'
import { fingerprintOf } from '../status'

/**
 * Any agent that speaks the Agent Client Protocol, run from a command the user chose
 * (`config.source = { kind: 'local', command, args, env }`): no shell, `.cmd` shims resolved to
 * the program they run, and a command that cannot run reports `runs: no`. Or an agent from the ACP
 * registry that Mousse installs (`{ kind: 'registry', agentId, version, distribution }`): it runs
 * from its install record only, and only while every installed file matches it. Sign-in follows
 * the methods the agent advertises (ACP `agent` and `terminal`), and counts only once a later
 * `session/new` succeeds.
 */

const LABEL = 'ACP agent'

/** What `<stateDir>/acp.json` keeps. */
interface AcpState {
  sessions?: Record<string, SavedAcpSession>
  models?: LlmModelOption[]
  /** ISO time `models` was last updated from the agent (a model refresh, or a turn's session state). */
  modelsRefreshedAt?: string
  /** What the agent last reported; the gateway keeps its own copy per revision. */
  facts?: RuntimeFactsReport
  /** `initialize.authMethods` as the agent sent them (facts keep only a summary). */
  authMethods?: unknown[]
  /** A sign-in verified in Mousse, for this launch (`bindingHash`) only. */
  auth?: { bindingHash: string; methodId: string; authenticated: boolean }
  /** The agent asked for a sign-in during a turn. */
  signedOut?: boolean
  /** The installed files (of the install record `hash`) no longer match it. */
  filesChanged?: { hash: string; message: string }
}

export interface AcpDriverOptions {
  preset?: AcpPreset
  /** Test seam: opens agent connections instead of starting the command. */
  connect?: (context: DriverContext, request: AcpLaunchRequest) => AcpConnection
  /** Test seam: the pseudo-terminal for `terminal` sign-in methods. */
  pty?: { available: () => boolean; spawn?: PtySpawn }
  /** Managed installs of registry agents; without it a registry entry cannot be installed. */
  agents?: AgentInstalls
  /** Test seam: how long a prompt may get no sign of life before the turn fails. */
  promptSilenceMs?: number
}

/**
 * What a driver built on this runtime (a preset with an executable of its own, like Grok) adds to
 * it: where its program is, the last word on its variables, and its own check before a launch.
 */
export interface AcpRuntimeHooks {
  /** The driver kind its turns report (default `acp`). */
  driver?: HarnessDriverKind
  /**
   * The program the preset runs when the entry has no command of its own (an override, a managed
   * copy or the one on PATH); `track` marks a process running from a managed copy.
   */
  program?(purpose: AcpPurpose): { resolved: CliLaunch; track?: () => () => void } | undefined
  /** The variables of a process, last (the instance's secrets win). */
  env?(env: NodeJS.ProcessEnv, purpose: AcpPurpose): NodeJS.ProcessEnv
  /**
   * The preset's own file check, run wherever a registry agent's install is checked: before every
   * new process (turns, checks, sign-in and sign-out included) and on Recheck. A throw stops the launch.
   */
  checkInstall?(options: { signal?: AbortSignal; reuse: boolean }): Promise<void>
  /** Whether sign-out may ask the agent to sign out (`logout`); false leaves the agent's own sign-in alone. */
  agentLogout?(): boolean
}

/**
 * A launch right after a full file check of the same install record does not hash again (a
 * Recheck checks the files, then starts the agent for its handshake).
 */
export const INSTALL_CHECK_REUSE_MS = 5_000

const REGISTRY_AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const REGISTRY_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Where an instance's agent comes from: `config.source`, else its executable, arguments and variables. */
export function acpSourceOf(config: InstanceConfig): AcpSource | undefined {
  if (config.source) return config.source
  return config.binaryPath ? { kind: 'local', command: config.binaryPath, args: [...(config.args ?? [])], env: { ...(config.env ?? {}) } } : undefined
}

/** A stored registry source, or undefined when any of its values could not be a path segment. */
export function decodeRegistrySource(source: Record<string, unknown>): RegistrySource | undefined {
  const { agentId, version, distribution, receiptHash, consent } = source
  // A reserved id (Mousse's own managed runtimes) is never a registry source.
  if (typeof agentId !== 'string' || !REGISTRY_AGENT_ID.test(agentId) || RESERVED_AGENT_IDS.has(agentId)) return undefined
  if (typeof version !== 'string' || !REGISTRY_VERSION.test(version)) return undefined
  if (distribution !== 'binary' && distribution !== 'npx') return undefined
  const accepted = isRecord(consent) && typeof consent.version === 'string' && typeof consent.artifactUrl === 'string'
    ? { version: consent.version, artifactUrl: consent.artifactUrl }
    : undefined
  return {
    kind: 'registry',
    agentId,
    version,
    distribution,
    ...(typeof receiptHash === 'string' && /^[a-f0-9]{64}$/.test(receiptHash) ? { receiptHash } : {}),
    ...(accepted ? { consent: accepted } : {})
  }
}

function decodeAcpConfig(raw: Record<string, unknown> | undefined): InstanceConfig {
  const config = decodeInstanceConfig(raw, { privateHome: false })
  const source = raw?.source
  const registry = isRecord(source) && source.kind === 'registry' ? decodeRegistrySource(source) : undefined
  if (registry) {
    config.source = registry
    // A registry agent runs from its install only, never from an executable path.
    delete config.binaryPath
  } else if (isRecord(source) && source.kind === 'local' && typeof source.command === 'string' && source.command.trim()) {
    config.source = {
      kind: 'local',
      command: source.command.trim(),
      args: Array.isArray(source.args) ? source.args.filter((arg): arg is string => typeof arg === 'string') : [],
      env: isRecord(source.env) ? Object.fromEntries(Object.entries(source.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string')) : {}
    }
  } else {
    const derived = acpSourceOf(config)
    if (derived) config.source = derived
  }
  return config
}

/** The methods Mousse can offer here: terminal methods only where a sign-in terminal runs. */
export function offeredAuthMethods(methods: AcpAuthMethod[], ptyRuns: boolean): AcpAuthMethod[] {
  return methods.filter((method) => method.type !== 'terminal' || ptyRuns)
}

export function acpDriver(options: AcpDriverOptions = {}): HarnessDriver {
  const preset = options.preset ?? GENERIC_ACP_PRESET
  const ptyRuns = () => (options.pty ? options.pty.available() : ptyAvailable())
  return {
    kind: 'acp',
    label: preset.label,
    // Never searched on PATH by name: the instance's command is its executable.
    binaryNames: [],
    ...(preset.testedVersions ? { testedVersions: preset.testedVersions } : {}),
    ...(preset.knownBroken?.length ? { knownBroken: preset.knownBroken } : {}),
    multiInstance: true,
    privateHome: false,
    // Registry agents only; a local command's runtime offers no install.
    canInstall: true,
    customModels: false,
    methodLabel: 'The agent’s own sign-in',
    // ACP updates do not name the MCP server: the bearer is kept only after a turn whose tool calls all completed.
    mcpTurnBinding: 'drained_turn',
    userMcp: 'native',
    // The agent's own `session/request_permission` flow decides (when it asks at all).
    relay: { approvals: 'runtime' },
    decodeConfig: decodeAcpConfig,
    versionArgs: (config) => preset.versionArgs?.(config) ?? null,
    caps: (_config, _version, facts?: RuntimeFacts): HarnessCaps => {
      const caps = { ...preset.staticCaps }
      return facts && preset.capsFromFacts ? preset.capsFromFacts(caps, facts) : caps
    },
    updateCommand: () => undefined,
    create: (context) => createAcpRuntime(context, preset, options, ptyRuns)
  }
}

export function createAcpRuntime(context: DriverContext, preset: AcpPreset, options: AcpDriverOptions, ptyRuns: () => boolean, hooks: AcpRuntimeHooks = {}): DriverRuntime {
  const statePath = join(context.stateDir, 'acp.json')
  let state: AcpState = {}
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
    if (isRecord(parsed)) state = parsed as AcpState
  } catch {
    // No state yet.
  }
  const save = () => {
    mkdirSync(context.stateDir, { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(statePath, state, { mode: 0o600 })
  }
  const source = acpSourceOf(context.config)
  const registrySource = source?.kind === 'registry' ? source : undefined
  const agents = options.agents
  const label = context.config.displayName ?? preset.label
  /** The install a registry entry's launch was last checked against, and when. */
  let verified: { hash: string; atMs: number } | undefined
  let liveHost: LiveProcessHost | null = null
  let signInGeneration = 0
  let observedInfo: AcpObservations['info']
  let observedSession: AcpObservations['session']

  /**
   * The binding a verified sign-in belongs to: the command, its arguments, its variables and the
   * method (a registry agent: its id, version, distribution and install). Changing any of them
   * makes the sign-in unknown again.
   */
  const sortedEnv = (env: Record<string, string> | undefined) => Object.entries(env ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const bindingHash = (methodId: string) => createHash('sha256')
    .update(JSON.stringify(source?.kind === 'registry'
      ? [source.agentId, source.version, source.distribution, source.receiptHash, context.config.args, sortedEnv(context.config.env), methodId]
      : [source?.command, source?.args, sortedEnv(source?.env), methodId]))
    .digest('hex')

  /** The instance's variables over its environment (on Windows a user `PATH` replaces `Path`). */
  const launchEnv = (purpose: AcpPurpose, variables: Record<string, string>, extra: Record<string, string> = {}) => {
    const env = withUserEnv(withUserEnv(context.env.env, variables), extra)
    return hooks.env ? hooks.env(env, purpose) : env
  }

  /** The registry entry's published install, when there is one. */
  const installedNow = (): InstalledAgent | undefined => (registrySource && agents ? agents.installed(registrySource) : undefined)

  const launchOf = (purpose: AcpLaunchRequest['purpose']): { resolved: CliLaunch; launch: AcpLaunch; root?: string; track?: () => () => void } => {
    if (!source && hooks.program) {
      const program = hooks.program(purpose)
      if (!program) throw new Error(`${label} is not installed. Install it, or set its executable in Settings → Providers.`)
      const launch = preset.launch({ config: context.config, source: { kind: 'local', command: program.resolved.path, args: [], env: {} }, purpose })
      return { resolved: program.resolved, launch, ...(program.track ? { track: program.track } : {}) }
    }
    if (!source) throw new Error(`${label} has no command. Set one in its settings.`)
    if (source.kind === 'registry') {
      const installed = installedNow()
      if (!agents || !installed) throw new Error(`${label} is not installed. Install it in Settings → Providers.`)
      // The receipt says how it starts; the entry's own arguments and variables go on top.
      const agent = agents.launch(installed, context.env)
      return {
        resolved: { path: agent.path, command: agent.command, args: agent.args },
        launch: { command: agent.command, args: [...(context.config.args ?? [])], env: { ...agent.env, ...(context.config.env ?? {}) } },
        root: installed.root
      }
    }
    const launch = preset.launch({ config: context.config, source, purpose })
    const resolved = resolveCommand(launch.command, context.env)
    if (!resolved) throw new Error(`Mousse cannot run ${launch.command}.`)
    return { resolved, launch }
  }

  /**
   * Before a registry agent starts: its install record is the one the entry was installed with,
   * and every file still matches it. A mismatch is kept (the card offers Reinstall) and stops the launch.
   */
  const checkInstall = async (signal?: AbortSignal, options: { reuse?: boolean } = {}): Promise<void> => {
    if (!registrySource) return hooks.checkInstall?.({ ...(signal ? { signal } : {}), reuse: options.reuse === true })
    const installed = installedNow()
    if (!agents || !installed) throw new Error(`${label} is not installed. Install it in Settings → Providers.`)
    // Only a launch reuses a check made moments ago; Recheck always hashes every file.
    if (options.reuse && verified?.hash === installed.hash && Date.now() - verified.atMs < INSTALL_CHECK_REUSE_MS && !state.filesChanged) return
    const changed = await agents.changed(installed, registrySource.receiptHash, signal)
    if (changed) {
      if (state.filesChanged?.hash !== installed.hash || state.filesChanged.message !== changed) {
        state.filesChanged = { hash: installed.hash, message: changed }
        save()
        context.changed()
      }
      throw new Error(`Installed files changed since install (${changed}). Reinstall ${label} in Settings → Providers.`)
    }
    if (state.filesChanged) {
      delete state.filesChanged
      save()
    }
    verified = { hash: installed.hash, atMs: Date.now() }
  }

  const spawnAgent = (request: AcpLaunchRequest): AcpConnection => {
    const { resolved, launch, root, track } = launchOf(request.purpose)
    // Every registry launch follows a file check (`beforeLaunch`); none starts without one.
    if (root && (!verified || verified.hash !== installedNow()?.hash || Date.now() - verified.atMs > 60_000))
      throw new Error(`Mousse did not check the files of ${label} before starting it.`)
    const untrack = root && agents ? agents.track(root) : track?.()
    // Checks and sign-in verification run in a folder of their own, removed when the process ends.
    const scratch = request.purpose === 'turn' ? undefined : mkdtempSync(join(tmpdir(), 'mousse-acp-'))
    const child = spawnHarness({ ...context.env, env: launchEnv(request.purpose, launch.env) }, `acp-${request.purpose}`, resolved.command, [...resolved.args, ...launch.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(scratch ? { cwd: scratch } : {})
    }) as ChildProcessWithoutNullStreams
    const connection = connectAcpProcess(child, request.handlers, {
      // During a sign-in, a link the agent prints is the sign-in link.
      ...(request.purpose === 'sign_in' && request.onAuthUrl ? {
        stderrLine: (line: string) => {
          const url = signInPrompts(line).url
          if (url) request.onAuthUrl!(url)
        }
      } : {}),
      onExit: () => {
        untrack?.()
        request.onExit?.()
        if (scratch) rmSync(scratch, { recursive: true, force: true })
      }
    })
    // The whole tree goes when the connection is closed: agents start helpers of their own.
    connection.child = {
      get pid() { return child.pid },
      get exitCode() { return child.exitCode },
      get signalCode() { return child.signalCode },
      kill: () => {
        killTree(child)
        return true
      }
    }
    return connection
  }

  const connect: AcpConnectionFactory = options.connect ? (request) => options.connect!(context, request) : spawnAgent

  const sessions = new AcpSessions({
    label,
    defaultInstanceId: context.instanceId,
    questions: context.questions,
    connect,
    quirks: preset.quirks,
    ...(options.promptSilenceMs !== undefined ? { promptSilenceMs: options.promptSilenceMs } : {}),
    ...(preset.classifyOption ? { classifyOption: preset.classifyOption } : {}),
    ...(preset.initializeMeta ? { initializeMeta: preset.initializeMeta } : {}),
    urlElicitation: true,
    // ACP 1.5: agents offer terminal sign-in only to clients that can run one, and send sign-in
    // links as URL elicitations only to clients that accept them.
    clientCapabilities: () => ({ auth: { terminal: ptyRuns() }, elicitation: { url: {} } }),
    closeSessions: true,
    beforeLaunch: () => checkInstall(undefined, { reuse: true }),
    store: {
      saved: (threadId) => state.sessions?.[threadId],
      setSaved: (threadId, saved) => {
        if (saved) state.sessions = { ...state.sessions, [threadId]: saved }
        else if (state.sessions) {
          const { [threadId]: _dropped, ...rest } = state.sessions
          state.sessions = rest
        }
        save()
      },
      models: () => state.models ?? [],
      setModels: (models) => {
        state.models = models
        state.modelsRefreshedAt = new Date().toISOString()
        save()
      }
    },
    launchGeneration: () => 0,
    signInGeneration: () => signInGeneration,
    markSignedOut: () => {
      if (state.signedOut && !state.auth?.authenticated) return
      state.signedOut = true
      if (state.auth) state.auth = { ...state.auth, authenticated: false }
      save()
      context.changed()
    },
    signInRequiredMessage: `Sign in to ${label} in Settings → Providers before chatting`,
    notice: (threadId, text) => liveHost?.notice?.(threadId, text),
    observed: (observations) => {
      if (observations.info) observedInfo = observations.info
      if (observations.session) observedSession = observations.session
      recordFacts(observations.session ? 'session' : 'handshake')
    }
  })

  /** Facts from what the agent last said, for the executable that runs now. */
  const recordFacts = (sourceOfFacts: RuntimeFactsReport['source']) => {
    let binary
    try {
      binary = fingerprintOf(launchOf('handshake').resolved.path)
    } catch {
      return
    }
    if (!binary || !observedInfo) return
    const previous = state.facts
    state.authMethods = observedInfo.authMethods
    state.facts = {
      binary,
      ...(observedInfo.protocolVersion !== undefined ? { protocolVersion: observedInfo.protocolVersion } : {}),
      ...(observedInfo.agentInfo ? { agentInfo: observedInfo.agentInfo } : {}),
      agentCapabilities: observedInfo.agentCapabilities,
      authMethods: decodeAuthMethods(observedInfo.authMethods).map((method) => ({
        id: method.id,
        name: method.name,
        type: method.type,
        ...(method.description ? { description: method.description } : {})
      })),
      ...(observedSession?.configOptions ? { configOptions: observedSession.configOptions } : previous?.configOptions ? { configOptions: previous.configOptions } : {}),
      ...(observedSession?.modes ? { modes: observedSession.modes } : previous?.modes ? { modes: previous.modes } : {}),
      ...(observedSession?.models ? { models: observedSession.models } : previous?.models ? { models: previous.models } : {}),
      capturedAt: new Date().toISOString(),
      source: sourceOfFacts
    }
    save()
  }

  const authMethods = (): AcpAuthMethod[] => decodeAuthMethods(observedInfo?.authMethods ?? state.authMethods)

  const reading = (): AuthReading => {
    const known = observedInfo || state.facts
    const methods = authMethods()
    const verified = state.auth?.authenticated === true && state.auth.bindingHash === bindingHash(state.auth.methodId)
    const method = methods.find((entry) => entry.id === state.auth?.methodId)
    // Sign-in starts from Settings whenever the agent offers a method Mousse can run here.
    const canSignIn = offeredAuthMethods(methods, ptyRuns()).length > 0
    // No subject: Mousse cannot read which account an arbitrary agent runs as, so a thread's native
    // session is never resumed across turns (each turn hands the history over).
    if (verified) return { state: 'signed_in', methodLabel: method?.name ?? 'Signed in through Mousse', ownedByMousse: true, ...(canSignIn ? { canSignIn } : {}) }
    if (state.signedOut) return { state: 'signed_out', methodLabel: 'Sign in', message: `${label} asked for a sign-in.`, ...(canSignIn ? { canSignIn } : {}) }
    if (!known) return { state: 'unknown', message: 'Check again to see how this agent signs in.' }
    if (!methods.length) return { state: 'not_required', methodLabel: 'No sign-in needed' }
    return { state: 'unknown', methodLabel: methods.map((entry) => entry.name).join(' · '), message: `Sign in if ${label} asks you to, or sign in now.`, ...(canSignIn ? { canSignIn } : {}) }
  }


  /** One session in a scratch folder: the sign-in works and the account's models are listed. */
  const verify = async (signal?: AbortSignal): Promise<void> => {
    const scratch = mkdtempSync(join(tmpdir(), 'mousse-acp-verify-'))
    try {
      await sessions.probeSession(scratch, signal)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  const succeed = (methodId: string, session: LoginSession): ProviderLoginResult => {
    signInGeneration += 1
    state.auth = { bindingHash: bindingHash(methodId), methodId, authenticated: true }
    delete state.signedOut
    save()
    return { success: true, sessionId: session.sessionId }
  }

  const signIn = async (session: LoginSession, _cwd: string, methodId?: string): Promise<ProviderLoginResult> => {
    const fail = (error: unknown): ProviderLoginResult => ({
      success: false,
      sessionId: session.sessionId,
      error: session.abort.signal.aborted ? 'Login cancelled' : error instanceof Error ? error.message : String(error)
    })
    try {
      // A runtime made since the last check (a restart, a new revision) asks the agent again: the
      // methods it offers now, with their full arguments, decide the sign-in.
      if (!observedInfo) await sessions.handshake(session.abort.signal)
      const offered = offeredAuthMethods(authMethods(), ptyRuns())
      if (!offered.length) {
        await verify(session.abort.signal)
        return succeed('', session)
      }
      let method = offered.find((entry) => entry.id === methodId)
      if (!method && offered.length === 1) method = offered[0]
      if (!method) {
        const picked = await session.createAuthCallbacks().prompt({
          type: 'select',
          message: `How do you sign in to ${label}?`,
          options: offered.map((entry) => ({ id: entry.id, label: entry.name, ...(entry.description ? { description: entry.description } : {}) }))
        })
        method = offered.find((entry) => entry.id === picked)
        if (!method) throw new Error('Choose a sign-in method.')
      }
      if (method.type === 'terminal') {
        await checkInstall(session.abort.signal)
        const { resolved, launch } = launchOf('sign_in')
        const shown = new Set<string>()
        const run = runInPty(resolved.command, [...resolved.args, ...launch.args, ...method.args], {
          env: launchEnv('sign_in', launch.env, method.env),
          ...(options.pty?.spawn ? { spawn: options.pty.spawn } : {}),
          onOutput: (transcript) => {
            const found = signInPrompts(transcript)
            if (found.url && found.userCode && !shown.has(`code:${found.userCode}`)) {
              shown.add(`code:${found.userCode}`)
              session.emitEvent({ sessionId: session.sessionId, type: 'device_code', userCode: found.userCode, verificationUri: found.url })
            } else if (found.url && !found.userCode && !shown.has(found.url)) {
              shown.add(found.url)
              session.emitEvent({ sessionId: session.sessionId, type: 'auth_url', url: found.url, usesCallbackServer: false })
            }
          }
        })
        session.abort.signal.addEventListener('abort', () => run.cancel(), { once: true })
        const { exitCode } = await run.done
        session.abort.signal.throwIfAborted()
        if (exitCode !== 0) throw new Error(`The sign-in command exited with code ${exitCode}.`)
        await verify(session.abort.signal)
        return succeed(method.id, session)
      }
      // `agent`: the agent signs in after `authenticate`, sending its link as an elicitation or printing it.
      await checkInstall(session.abort.signal)
      const active = sessions.launch('sign_in', (url) => {
        session.emitEvent({ sessionId: session.sessionId, type: 'auth_url', url, usesCallbackServer: false })
      })
      const close = () => sessions.close(active)
      session.abort.signal.addEventListener('abort', close, { once: true })
      try {
        await sessions.initialize(active)
        session.abort.signal.throwIfAborted()
        await active.connection.agent.request(methods.agent.authenticate, { methodId: method.id })
      } finally {
        session.abort.signal.removeEventListener('abort', close)
        sessions.close(active)
      }
      session.abort.signal.throwIfAborted()
      await verify(session.abort.signal)
      return succeed(method.id, session)
    } catch (error) {
      return fail(error)
    }
  }

  const adapter = new AcpAdapter(() => client, {
    driver: hooks.driver ?? 'acp',
    label,
    capabilities: preset.staticCaps,
    planMode: () => Boolean(state.facts?.modes?.some((mode) => /^(plan|architect)$/i.test(mode.id) || /^(plan|architect)$/i.test(mode.name)))
  })
  const client = {
    chat: (input: Parameters<AcpSessions['chat']>[0]) => sessions.chat(input),
    commitConversation: (threadId: string, history: string) => sessions.commitConversation(threadId, history),
    configured: () => runtime.configured(),
    interrupt: (sessionId: string | undefined) => sessions.interrupt(sessionId)
  }

  /** What the card shows about a registry entry's install. */
  const managed = (): ManagedInstall | undefined => {
    const installed = installedNow()
    if (!installed || !agents) return undefined
    const replaced = registrySource?.receiptHash && installed.hash !== registrySource.receiptHash ? 'the install was replaced' : undefined
    const broken = replaced ?? (state.filesChanged?.hash === installed.hash ? state.filesChanged.message : undefined)
    const advisory = agents.advisory(installed)
    return {
      path: join(installed.root, DIST_DIR, ...installed.receipt.launch.cmd.split('/')),
      version: installed.receipt.version,
      bytes: installed.receipt.bytes,
      checksum: installed.receipt.checksum,
      receiptHash: installed.hash,
      ...(broken ? { broken } : {}),
      ...(advisory ? { advisory } : {})
    }
  }

  const registryRuntime: Partial<DriverRuntime> = registrySource && agents ? {
    install: async (onProgress) => {
      const installed = await agents.install({ instanceId: context.instanceId, source: registrySource, env: context.env, label, onProgress })
      if (state.filesChanged) {
        delete state.filesChanged
        save()
      }
      // The entry is bound to this install record: a different one later reads as changed files.
      return { config: { source: { ...registrySource, receiptHash: installed.hash } } }
    },
    cancelInstall: () => agents.cancel(context.instanceId),
    installState: () => ({ installing: agents.installing(context.instanceId) }),
    managed,
    verifyInstall: async (signal) => {
      try {
        await checkInstall(signal)
      } catch {
        // Recorded in the state; the probe reads it through `managed().broken`.
      }
    },
    removeInstall: async ({ force }) => {
      const result = await agents.removeInstall({ instanceId: context.instanceId, source: registrySource, force })
      if (result.removed) sessions.closeAll()
      return result
    },
    release: () => agents.release(context.instanceId, registrySource)
  } : {}

  const runtime: DriverRuntime = {
    adapter,
    ...registryRuntime,
    configured: () => {
      if (!source || state.signedOut) return false
      if (registrySource && (!installedNow() || managed()?.broken)) return false
      try {
        launchOf('turn')
        return true
      } catch {
        return false
      }
    },
    llmProvider: () => (runtime.configured() ? { id: context.instanceId, label, models: runtime.models() } : undefined),
    models: () => [{ id: AGENT_DEFAULT_MODEL, label: 'Agent default' }, ...(state.models ?? []).filter((model) => model.id !== AGENT_DEFAULT_MODEL)],
    modelsRefreshedAt: () => (state.models?.length ? state.modelsRefreshedAt : undefined),
    auth: async () => reading(),
    // Read at every admission; an arbitrary agent's account cannot be read, so it is unknown.
    identity: async () => undefined,
    handshake: async (signal) => {
      try {
        await sessions.handshake(signal)
      } catch (error) {
        // A failed check leaves no facts behind: the old ones describe a program that no longer starts.
        observedInfo = undefined
        delete state.facts
        delete state.authMethods
        save()
        throw error
      }
    },
    runtimeFacts: () => state.facts,
    refreshModels: async () => {
      await verify()
    },
    signIn,
    signOut: async () => {
      sessions.closeAll()
      if (hooks.agentLogout?.() !== false && state.auth?.methodId && authMethods().some((method) => method.id === state.auth?.methodId && method.type === 'agent')) {
        try {
          await checkInstall()
          const active = sessions.launch('sign_out')
          try {
            await sessions.initialize(active)
            await active.connection.agent.request(methods.agent.logout, {})
          } finally {
            sessions.close(active)
          }
        } catch {
          // An agent without `logout` keeps its own sign-in; Mousse forgets its own record below.
        }
      }
      delete state.auth
      state.sessions = {}
      save()
    },
    forgetConversation: (threadId) => sessions.forgetConversation(threadId),
    terminate: (ref) => sessions.terminate(ref.sessionId),
    setLiveHost: (host) => {
      liveHost = host
    },
    stop: () => sessions.stop()
  }
  return runtime
}
