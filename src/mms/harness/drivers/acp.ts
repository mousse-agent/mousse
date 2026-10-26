import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { methods } from '@agentclientprotocol/sdk'
import type { HarnessCaps, RuntimeFacts } from '../../../shared/harness/types'
import type { ProviderLoginResult } from '../../../shared/providerAuth'
import type { LlmModelOption } from '../../../shared/settings'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { LoginSession } from '../../providers/LoginSession'
import { AcpAdapter } from '../../run/adapters/acp/AcpAdapter'
import { decodeAuthMethods, type AcpAuthMethod } from '../acp/auth'
import { connectAcpProcess, type AcpConnection, type AcpConnectionFactory, type AcpLaunchRequest } from '../acp/connection'
import { AGENT_DEFAULT_MODEL } from '../acp/models'
import type { AcpPreset, AcpSource } from '../acp/preset'
import { GENERIC_ACP_PRESET } from '../acp/presets/generic'
import { AcpSessions, type AcpObservations, type SavedAcpSession } from '../acp/session'
import { decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver, type InstanceConfig, type LiveProcessHost, type RuntimeFactsReport } from '../driver'
import { withUserEnv } from '../../providers/cliConfig'
import { resolveCommand } from '../env'
import { ptyAvailable, runInPty, signInPrompts, type PtySpawn } from '../pty'
import { killTree, spawnHarness } from '../spawn'
import { fingerprintOf } from '../status'

/**
 * Any agent that speaks the Agent Client Protocol, run from a command the user chose
 * (`config.source = { kind: 'local', command, args, env }`): no shell, `.cmd` shims resolved to
 * the program they run, and a command that cannot run reports `runs: no`. Sign-in follows the
 * methods the agent advertises (ACP `agent` and `terminal`), and counts only once a later
 * `session/new` succeeds.
 */

const LABEL = 'ACP agent'

/** What `<stateDir>/acp.json` keeps. */
interface AcpState {
  sessions?: Record<string, SavedAcpSession>
  models?: LlmModelOption[]
  /** What the agent last reported; the gateway keeps its own copy per revision. */
  facts?: RuntimeFactsReport
  /** `initialize.authMethods` as the agent sent them (facts keep only a summary). */
  authMethods?: unknown[]
  /** A sign-in verified in Mousse, for this launch (`bindingHash`) only. */
  auth?: { bindingHash: string; methodId: string; authenticated: boolean }
  /** The agent asked for a sign-in during a turn. */
  signedOut?: boolean
}

export interface AcpDriverOptions {
  preset?: AcpPreset
  /** Test seam: opens agent connections instead of starting the command. */
  connect?: (context: DriverContext, request: AcpLaunchRequest) => AcpConnection
  /** Test seam: the pseudo-terminal for `terminal` sign-in methods. */
  pty?: { available: () => boolean; spawn?: PtySpawn }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** The local command of an instance: `config.source`, else its executable, arguments and variables. */
export function acpSourceOf(config: InstanceConfig): AcpSource | undefined {
  if (config.source) return config.source
  return config.binaryPath ? { kind: 'local', command: config.binaryPath, args: [...(config.args ?? [])], env: { ...(config.env ?? {}) } } : undefined
}

function decodeAcpConfig(raw: Record<string, unknown> | undefined): InstanceConfig {
  const config = decodeInstanceConfig(raw, { privateHome: false })
  const source = raw?.source
  if (isRecord(source) && source.kind === 'local' && typeof source.command === 'string' && source.command.trim()) {
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
    multiInstance: true,
    privateHome: false,
    canInstall: false,
    customModels: false,
    methodLabel: 'The agent’s own sign-in',
    // ACP updates do not name the MCP server: the bearer is kept only after a turn whose tool calls all completed.
    mcpTurnBinding: 'drained_turn',
    userMcp: 'native',
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

function createAcpRuntime(context: DriverContext, preset: AcpPreset, options: AcpDriverOptions, ptyRuns: () => boolean): DriverRuntime {
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
  const label = context.config.displayName ?? preset.label
  let liveHost: LiveProcessHost | null = null
  let signInGeneration = 0
  let observedInfo: AcpObservations['info']
  let observedSession: AcpObservations['session']

  /**
   * The binding a verified sign-in belongs to: the command, its arguments, its variables and the
   * method. Changing any of them makes the sign-in unknown again.
   */
  const bindingHash = (methodId: string) => createHash('sha256')
    .update(JSON.stringify([source?.command, source?.args, Object.entries(source?.env ?? {}).sort(([a], [b]) => a.localeCompare(b)), methodId]))
    .digest('hex')

  /** The instance's variables over its environment (on Windows a user `PATH` replaces `Path`). */
  const launchEnv = (variables: Record<string, string>, extra: Record<string, string> = {}) =>
    withUserEnv(withUserEnv(context.env.env, variables), extra)

  const launchOf = (purpose: AcpLaunchRequest['purpose']) => {
    if (!source) throw new Error(`${label} has no command. Set one in its settings.`)
    const launch = preset.launch({ config: context.config, source, purpose })
    const resolved = resolveCommand(launch.command, context.env)
    if (!resolved) throw new Error(`Mousse cannot run ${launch.command}.`)
    return { resolved, launch }
  }

  const spawnAgent = (request: AcpLaunchRequest): AcpConnection => {
    const { resolved, launch } = launchOf(request.purpose)
    // Checks and sign-in verification run in a folder of their own, removed when the process ends.
    const scratch = request.purpose === 'turn' ? undefined : mkdtempSync(join(tmpdir(), 'mousse-acp-'))
    const child = spawnHarness({ ...context.env, env: launchEnv(launch.env) }, `acp-${request.purpose}`, resolved.command, [...resolved.args, ...launch.args], {
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
    ...(preset.classifyOption ? { classifyOption: preset.classifyOption } : {}),
    ...(preset.initializeMeta ? { initializeMeta: preset.initializeMeta } : {}),
    urlElicitation: true,
    // ACP 1.5: agents offer terminal sign-in only to clients that can run one, and send sign-in
    // links as URL elicitations only to clients that accept them.
    clientCapabilities: () => ({ auth: { terminal: ptyRuns() }, elicitation: { url: {} } }),
    closeSessions: true,
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
        const { resolved, launch } = launchOf('sign_in')
        const shown = new Set<string>()
        const run = runInPty(resolved.command, [...resolved.args, ...launch.args, ...method.args], {
          env: launchEnv(launch.env, method.env),
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
    driver: 'acp',
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

  const runtime: DriverRuntime = {
    adapter,
    configured: () => {
      if (!source || state.signedOut) return false
      try {
        launchOf('turn')
        return true
      } catch {
        return false
      }
    },
    llmProvider: () => (runtime.configured() ? { id: context.instanceId, label, models: runtime.models() } : undefined),
    models: () => [{ id: AGENT_DEFAULT_MODEL, label: 'Agent default' }, ...(state.models ?? []).filter((model) => model.id !== AGENT_DEFAULT_MODEL)],
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
      if (state.auth?.methodId && authMethods().some((method) => method.id === state.auth?.methodId && method.type === 'agent')) {
        try {
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
