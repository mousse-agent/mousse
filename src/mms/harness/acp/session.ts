import { createHash, randomUUID } from 'node:crypto'
import { methods, type NewSessionResponse } from '@agentclientprotocol/sdk'
import type { ProviderToolEvent } from '../../../shared/agentActivity'
import type { LlmModelOption } from '../../../shared/settings'
import type { ChatImageAttachment } from '../../../shared/types'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import { harnessAppError } from '../../../shared/harness/types'
import { interruptWithDeadline, loadWithDeadline, SessionLoadTimeoutError } from '../supervise'
import { isAuthRequired } from './auth'
import { initializeAgent, sessionCapability, type AcpAgentInfo } from './capabilities'
import { closeAcpConnection, type AcpClientHandlers, type AcpConnection, type AcpConnectionFactory, type AcpPurpose } from './connection'
import { LoadGate } from './loadGate'
import { sessionMcpServers } from './mcp'
import { AGENT_DEFAULT_MODEL, agentModels, agentModes, modelOptions, planModeId, type ModelControl } from './models'
import {
  answerPermission,
  classifyGenericOption,
  questionsPrompter,
  readWorkspaceFile,
  writeWorkspaceFile,
  type AcpRequestScope,
  type ClassifyOption,
  type PermissionPrompter
} from './permissions'
import type { AcpQuirks } from './quirks'
import { agentCancelledError, promptStopOutcome } from './stopReason'
import { xaiHandlers, xaiStopFailure } from './xai'

/**
 * The ACP session lifecycle shared by every ACP agent: one agent process per thread, kept between
 * turns while its saved session still matches the committed history; `session/new`, or the saved
 * session reopened (resume, or load behind the load gate); the prompt loop with steer as
 * cancel-and-restart; stop through the turn's signal or a native cancel.
 */

/** A connection the core opened, with the turn state it carries. */
export interface AcpProcess extends AcpConnection {
  sessionId?: string
  cwd?: string
  threadId?: string
  turnSignal?: AbortSignal
  /** Who answers the running turn's permission requests (its bridge's); the sessions' own otherwise. */
  turnPrompter?: PermissionPrompter
  /** `initialize` advertised `mcpCapabilities.http`; otherwise the Mousse server goes through the stdio bridge. */
  mcpHttp?: boolean
  /** What `initialize` answered. */
  info?: AcpAgentInfo
  /** How the session's model is chosen. */
  modelControl?: ModelControl
  /** The session's modes, the one it started in and the one it is in. */
  modes?: Array<{ id: string; name: string }>
  defaultModeId?: string
  currentModeId?: string
  /** The prompt request in flight, settled (either way) when it ends. */
  prompting?: Promise<void>
  /** Bearer token of the Mousse MCP server the session was opened with (null: none). */
  mcpToken?: string | null
  /** Provider instance whose turn opened the session. */
  instanceId?: string
  /** Hash of the session instructions the session was given (`orchestrationInstructions`). */
  instructionsHash?: string
  /** Launch-settings generation the process was started with; an older one is not reused. */
  generation: number
  /** Sign-in generation at launch; a process from before the latest sign-in cannot sign the profile out. */
  signInGeneration: number
  /**
   * Who waits for each tagged prompt's `prompt_complete` (`xaiExtensions`): one entry per prompt,
   * removed when that prompt settles, so a late completion of an earlier prompt touches nothing.
   */
  promptWaiters?: Map<string, (params: Record<string, unknown>) => void>
  /** Requests of the agent that Mousse is answering now (permission, questions, files): its silence is not counted meanwhile. */
  openRequests?: number
  /** Called when the agent shows a sign of life or such a request starts or ends (the running turn's silence timer). */
  activity?: () => void
  /** `interrupt` sent the running prompt a native cancel (cleared when the next prompt starts). */
  cancelRequested?: boolean
}

/** How long a steer waits for a cancelled prompt's own completion before sending the next one. */
export const PROMPT_COMPLETE_WAIT_MS = 5_000

/**
 * How long a prompt may get no reply and no update from the agent (and no request of the agent
 * waiting on the user) before the turn fails and the agent's process is ended. Long, because an
 * agent may run a quiet tool for minutes; it only has to be finite, so that a hung agent never
 * leaves a chat, a schedule or a delegating parent running for the turn's six-hour limit.
 */
export const PROMPT_SILENCE_MS = 15 * 60_000

/** A prompt that is a slash command: the agent expands it only when it opens the first block. */
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(\s|$)/

/** The trimmed prompt when it is a slash command (`/review src`; not a path such as `/tmp/x`). */
export function slashCommand(prompt: string): string | undefined {
  const text = prompt.trim()
  return SLASH_COMMAND.test(text) ? text : undefined
}

function describeDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.max(1, Math.round(ms / 1000))} seconds`
}

/** The agent's requests count as open while a handler answers them (see `AcpProcess.openRequests`). */
function attended(handlers: AcpClientHandlers, track: { begin(): void; end(): void }): AcpClientHandlers {
  const wrap = <A extends unknown[], R>(handle: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    track.begin()
    try {
      return await handle(...args)
    } finally {
      track.end()
    }
  }
  return {
    ...handlers,
    requestPermission: wrap(handlers.requestPermission),
    ...(handlers.readTextFile ? { readTextFile: wrap(handlers.readTextFile) } : {}),
    ...(handlers.writeTextFile ? { writeTextFile: wrap(handlers.writeTextFile) } : {}),
    ...(handlers.createElicitation ? { createElicitation: wrap(handlers.createElicitation) } : {}),
    ...(handlers.extRequests ? { extRequests: Object.fromEntries(Object.entries(handlers.extRequests).map(([method, handle]) => [method, wrap(handle)])) } : {})
  }
}

/** `instanceId` is absent on sessions saved before provider instances existed (the default instance). */
export interface SavedAcpSession {
  sessionId: string
  cwd: string
  historyKey?: string
  instanceId?: string
  /** Hash of the session instructions the session was given; changed ones are sent again on resume. */
  instructionsHash?: string
  /**
   * How the session chooses its model and which modes it has, as it said when it opened. A load
   * whose reply is missing or partial (the replay opened the gate) keeps them.
   */
  setup?: SessionSetup
}

export interface SessionSetup {
  modelControl?: ModelControl
  modes?: Array<{ id: string; name: string }>
  defaultModeId?: string
}

/** Where saved sessions and the last listed models persist. */
export interface AcpSessionStore {
  saved(threadId: string): SavedAcpSession | undefined
  /** `undefined` drops the thread's session. */
  setSaved(threadId: string, saved: SavedAcpSession | undefined): void
  models(): LlmModelOption[]
  setModels(models: LlmModelOption[]): void
}

export interface AcpChatInput {
  threadId: string
  instanceId?: string
  cwd: string
  model: string
  /** `plan`: the session runs in the agent's plan mode (only where the agent offers one). */
  mode?: 'default' | 'plan'
  prompt: string
  /** Prefixed to every prompt: the turn's skills, mode, applet catalogue and usable Mousse tools. */
  turnPreamble?: string
  history?: string
  images?: ChatImageAttachment[]
  signal?: AbortSignal
  mcp?: { url: string; token: string } | null
  /** Session instructions: in the session's first prompt, and again on a resumed session they changed for. */
  orchestrationInstructions?: string
  onText: (text: string) => void
  drainSteer?: () => string | undefined
  onSteer?: (text: string) => void
  /** A tool call started, changed or ended; `status` says how it ended (`unfinished`: the turn ended first). */
  onTool?: (event: ProviderToolEvent & { status?: 'completed' | 'failed' | 'unfinished' }) => void
  /** Who answers this turn's permission requests (the turn bridge's `permission`). */
  prompter?: PermissionPrompter
  /** The agent's session id, once known (provider refs name it for interrupt and terminate). */
  onSession?: (sessionId: string) => void
}

/** What the core learned about the agent and its sessions, for runtime facts. */
export interface AcpObservations {
  info?: AcpAgentInfo
  session?: { configOptions?: unknown[]; modes?: Array<{ id: string; name: string }>; models?: LlmModelOption[] }
}

export interface AcpSessionsOptions {
  /** The agent's name in prompts and errors ("Allow Antigravity to run this tool?"). */
  label: string
  /** The instance of sessions saved before provider instances existed. */
  defaultInstanceId: string
  questions: UserQuestionService
  connect: AcpConnectionFactory
  store: AcpSessionStore
  quirks: AcpQuirks
  /** How permission options are labelled and which are shown (default: the generic classes). */
  classifyOption?: ClassifyOption
  /** Who answers permission requests (default: the thread's questions). */
  prompter?: PermissionPrompter
  /** `_meta` sent with `initialize`. */
  initializeMeta?: Record<string, unknown>
  /** Test seam: how long a cancel may take before the process is ended (`INTERRUPT_DEADLINE_MS`). */
  cancelDeadlineMs?: number
  /** Test seam: how long a load replay may pause before the gate opens (`LOAD_REPLAY_IDLE_MS`). */
  loadIdleMs?: number
  /** Test seam: how long a prompt may get no sign of life before the turn fails (`PROMPT_SILENCE_MS`); 0 turns it off. */
  promptSilenceMs?: number
  /** Client capabilities added to `initialize` (ACP `auth`, `elicitation`). */
  clientCapabilities?: () => Record<string, unknown>
  /** Sign-in links may arrive as URL elicitations (else only through the preset's own channel). */
  urlElicitation?: boolean
  /** End a session with `session/close` (when advertised) before its process is killed. */
  closeSessions?: boolean
  /** Bumped when the launch settings change; a process from an older one is not reused. */
  launchGeneration(): number
  /** Bumped when a sign-in succeeds. */
  signInGeneration(): number
  /** The saved sign-in no longer works (the agent asked for sign-in). */
  markSignedOut(): void
  /** What a turn says when the agent wants a sign-in. */
  signInRequiredMessage: string
  /** A line for the thread (a saved session could not be reopened, so its history was handed over). */
  notice?(threadId: string, text: string): void
  /** `initialize` or a session told something new (runtime facts). */
  observed?(observations: AcpObservations): void
  /**
   * Runs before every new agent process (a managed install checks its files); a throw stops the
   * launch with that error.
   */
  beforeLaunch?(purpose: AcpPurpose): Promise<void>
}

export class AcpSessions {
  private readonly sessions = new Map<string, AcpProcess>()
  private readonly processes = new Set<AcpProcess>()
  /** Processes running a turn right now. */
  private readonly turning = new Set<AcpProcess>()
  private stopped = false
  private readonly prompter: PermissionPrompter

  constructor(private readonly options: AcpSessionsOptions) {
    this.prompter = options.prompter ?? questionsPrompter(options.questions)
  }

  /** Opens a connection to the agent. `onAuthUrl` receives sign-in links; without it a link means the sign-in is gone. */
  launch(purpose: AcpPurpose, onAuthUrl?: (url: string) => void): AcpProcess {
    const { label, questions, quirks } = this.options
    if (this.stopped) throw new Error(`${label} provider is stopped`)
    let active: AcpProcess | undefined
    const scope: AcpRequestScope = {
      get threadId() { return active?.threadId },
      get cwd() { return active?.cwd },
      get approvals() { return active?.turnPrompter?.approvals },
      aborted: () => Boolean(active?.turnSignal?.aborted || active?.connection.signal.aborted),
      throwIfAborted: () => {
        active?.turnSignal?.throwIfAborted()
        active?.connection.signal.throwIfAborted()
      }
    }
    const classify = this.options.classifyOption ?? classifyGenericOption
    const handlers: AcpClientHandlers = {
      requestPermission: (request) => answerPermission(active?.turnPrompter ?? this.prompter, scope, request, { label, classify }),
      ...(quirks.clientFs ? {
        readTextFile: (request) => readWorkspaceFile(scope, request),
        writeTextFile: (request) => writeWorkspaceFile(questions, scope, request, label)
      } : {}),
      // A sign-in link the agent sends as a URL elicitation goes to the sign-in; nothing else is answered.
      ...(this.options.urlElicitation ? { createElicitation: async (request: Parameters<NonNullable<AcpClientHandlers['createElicitation']>>[0]) => {
        const url = (request as { mode?: unknown; url?: unknown }).mode === 'url' ? (request as { url?: unknown }).url : undefined
        if (!onAuthUrl || typeof url !== 'string' || !/^https:\/\//i.test(url)) return { action: 'decline' }
        onAuthUrl(url)
        return { action: 'accept' }
      } } : {}),
      ...(quirks.xaiExtensions ? xaiHandlers({
        questions,
        scope,
        promptComplete: (promptId, params) => active?.promptWaiters?.get(promptId)?.(params)
      }) : {})
    }
    const connection = this.options.connect({
      purpose,
      handlers: attended(handlers, {
        begin: () => {
          if (!active) return
          active.openRequests = (active.openRequests ?? 0) + 1
          active.activity?.()
        },
        end: () => {
          if (!active) return
          active.openRequests = Math.max(0, (active.openRequests ?? 0) - 1)
          active.activity?.()
        }
      }),
      onAuthUrl: onAuthUrl ?? (() => {
        // The agent wants a sign-in outside a sign-in: the saved sign-in is gone or was never valid.
        if (!active) return
        if (active.signInGeneration === this.options.signInGeneration()) this.options.markSignedOut()
        active.connection.close(new Error(this.options.signInRequiredMessage))
      }),
      onExit: () => {
        if (active) this.processes.delete(active)
      }
    })
    active = Object.assign(connection, { generation: this.options.launchGeneration(), signInGeneration: this.options.signInGeneration() })
    this.processes.add(active)
    return active
  }

  /** `initialize`; client fs only for turns of a preset that offers it. */
  async initialize(process: AcpProcess, clientFs = false): Promise<AcpAgentInfo> {
    const info = await initializeAgent(process.connection, {
      clientFs,
      label: this.options.label,
      ...(this.options.quirks.strictProtocol ? { strictProtocol: true } : {}),
      ...(this.options.initializeMeta ? { meta: this.options.initializeMeta } : {}),
      ...(this.options.clientCapabilities ? { capabilities: this.options.clientCapabilities() } : {})
    })
    process.mcpHttp = info.mcpHttp
    process.info = info
    this.options.observed?.({ info })
    return info
  }

  /**
   * Ends the process (and the whole tree its factory started). A session the agent can close is
   * closed first, briefly, when the runtime asks for it.
   */
  close(process: AcpProcess): void {
    if (this.options.closeSessions && process.sessionId && !process.connection.signal.aborted && sessionCapability(process.info, 'close')) {
      const sessionId = process.sessionId
      const timer = setTimeout(() => closeAcpConnection(process), 2_000)
      timer.unref?.()
      void process.connection.agent.request(methods.agent.session.close, { sessionId })
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer)
          closeAcpConnection(process)
        })
      return
    }
    closeAcpConnection(process)
  }

  /**
   * An agent request answered "authentication required": the saved sign-in is gone. Marks the
   * profile signed out unless a sign-in finished after the process started, and returns the error to show.
   */
  authRequiredError(process: AcpProcess, error: unknown): Error | undefined {
    if (!isAuthRequired(error)) return undefined
    if (process.signInGeneration === this.options.signInGeneration()) this.options.markSignedOut()
    return new Error(this.options.signInRequiredMessage)
  }

  /**
   * A short start-up check: `initialize` only, then the process ends. Records what the agent
   * answered; throws when it does not start or answer.
   */
  async handshake(signal?: AbortSignal): Promise<AcpAgentInfo> {
    await this.options.beforeLaunch?.('handshake')
    const active = this.launch('handshake')
    const abort = () => this.close(active)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      signal?.throwIfAborted()
      return await this.initialize(active, this.options.quirks.clientFs === true)
    } finally {
      signal?.removeEventListener('abort', abort)
      closeAcpConnection(active)
    }
  }

  /** Opens one session in `cwd` and closes it: the models and modes it offers (sign-in verification, "Refresh models"). */
  async probeSession(cwd: string, signal?: AbortSignal): Promise<{ models: LlmModelOption[]; modes: Array<{ id: string; name: string }> }> {
    await this.options.beforeLaunch?.('models')
    const active = this.launch('models')
    const abort = () => this.close(active)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await this.initialize(active)
      signal?.throwIfAborted()
      const session = await active.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
      active.sessionId = session.sessionId
      return this.observeSession(active, session)
    } catch (error) {
      throw this.authRequiredError(active, error) ?? error
    } finally {
      signal?.removeEventListener('abort', abort)
      this.close(active)
    }
  }

  /**
   * Records a session's models and modes; returns them. `known` is what a reopened session said
   * when it opened: it stands in for what a load's missing reply would have said, and `currentModeId`
   * is the mode the replay left it in.
   */
  private observeSession(active: AcpProcess, session: unknown, known?: SessionSetup & { currentModeId?: string }): { models: LlmModelOption[]; modes: Array<{ id: string; name: string }> } {
    const { models, control } = agentModels(session, active.info?.meta)
    const modes = agentModes(session)
    active.modelControl = control.kind === 'none' && known?.modelControl ? known.modelControl : control
    active.modes = modes.modes.length ? modes.modes : known?.modes ?? []
    active.defaultModeId = known?.defaultModeId ?? modes.current
    active.currentModeId = modes.current ?? known?.currentModeId ?? active.defaultModeId
    if (models.length) this.options.store.setModels(models)
    const configOptions = (session as { configOptions?: unknown[] } | null)?.configOptions
    this.options.observed?.({ session: { ...(Array.isArray(configOptions) ? { configOptions } : {}), modes: modes.modes, models } })
    return { models, modes: modes.modes }
  }

  private historyKey(history: string): string {
    return createHash('sha256').update(history).digest('hex')
  }

  /** Record only the canonical history that the owning turn durably committed. */
  commitConversation(threadId: string, history: string): void {
    const saved = this.options.store.saved(threadId)
    if (!saved || !this.sessions.has(threadId)) return
    this.options.store.setSaved(threadId, { ...saved, historyKey: this.historyKey(history) })
  }

  /** Drops the saved session of `threadId`; its next turn starts a new one with the history in the prompt. */
  forgetConversation(threadId: string): void {
    if (!this.options.store.saved(threadId)) return
    this.options.store.setSaved(threadId, undefined)
  }

  /** The thread's process serving `sessionId`. */
  private bySession(sessionId: string | undefined): AcpProcess | undefined {
    if (!sessionId) return undefined
    for (const active of this.sessions.values()) if (active.sessionId === sessionId) return active
    return undefined
  }

  /**
   * The native cancel: `session/cancel` for the running prompt, pending permission prompts
   * rejected, and the prompt awaited. The gateway bounds the wait (`interruptWithDeadline`).
   */
  async interrupt(sessionId: string | undefined): Promise<'interrupted' | 'not_active'> {
    const active = this.bySession(sessionId)
    if (!active || !this.turning.has(active) || !active.prompting) return 'not_active'
    if (active.threadId) this.options.questions.autoRejectPendingForThread(active.threadId)
    // The prompt that ends `cancelled` now ends because Mousse asked, not because the agent chose to.
    active.cancelRequested = true
    await active.connection.agent.notify(methods.agent.session.cancel, { sessionId: active.sessionId! })
    await active.prompting
    // The agent may still count its task as running after the cancel's reply: its process ends,
    // and the thread's next turn reopens the saved session on a new one.
    if (this.options.quirks.xaiExtensions) closeAcpConnection(active)
    return 'interrupted'
  }

  /**
   * Waits for the agent to report `promptId` complete (`xaiExtensions`): `done` settles with the
   * completion's params and never rejects; `dispose` removes the waiter once the prompt settled.
   */
  private completionOf(active: AcpProcess, promptId: string): { done: Promise<Record<string, unknown>>; dispose(): void } {
    const waiters = (active.promptWaiters ??= new Map<string, (params: Record<string, unknown>) => void>())
    const done = new Promise<Record<string, unknown>>((resolve) => {
      waiters.set(promptId, (params) => {
        waiters.delete(promptId)
        resolve(params)
      })
    })
    return { done, dispose: () => waiters.delete(promptId) }
  }

  /** Kills the process of `sessionId`; the thread's next turn starts a new one with the history handed over. */
  terminate(sessionId: string | undefined): void {
    const active = this.bySession(sessionId)
    if (!active) return
    closeAcpConnection(active)
    if (active.threadId) {
      this.sessions.delete(active.threadId)
      this.forgetConversation(active.threadId)
    }
  }

  /**
   * Reopens a saved session on a fresh process: `session/load` behind the load gate when the
   * agent can load, else `session/resume` when advertised. Null when it cannot be reopened; a load
   * that misses the gateway's deadline kills the process and forgets the session.
   */
  private async reopen(active: AcpProcess, saved: SavedAcpSession, input: AcpChatInput, mcpServers: ReturnType<typeof sessionMcpServers>): Promise<{ response: unknown; currentModeId?: string } | null> {
    if (active.info?.agentCapabilities.loadSession === true) {
      const gate = new LoadGate(saved.sessionId, this.options.loadIdleMs)
      const deliver = active.onUpdate
      // Setup the replay states (its model selector, the mode it is in) when the reply says nothing.
      let replayOptions: unknown[] | undefined
      let currentModeId: string | undefined
      active.onUpdate = (update, sessionId) => {
        const verdict = gate.update(sessionId, update)
        if (verdict === 'discard') return
        if (verdict === 'keep') {
          const event = update as { sessionUpdate?: string; configOptions?: unknown; currentModeId?: unknown }
          if (event.sessionUpdate === 'config_option_update' && Array.isArray(event.configOptions)) replayOptions = event.configOptions
          if (event.sessionUpdate === 'current_mode_update' && typeof event.currentModeId === 'string') currentModeId = event.currentModeId
        }
        deliver?.(update, sessionId)
      }
      let response: Record<string, unknown> = {}
      const load = active.connection.agent.request(methods.agent.session.load, { sessionId: saved.sessionId, cwd: input.cwd, mcpServers })
        .then((value) => {
          if (gate.state !== 'ready' && value && typeof value === 'object') response = value as Record<string, unknown>
          gate.reply()
        })
      // A failed load ends the wait at once; a late answer after the gate opened changes nothing.
      const failed = load.then(() => new Promise<never>(() => {}))
      try {
        await loadWithDeadline(saved.sessionId, Promise.race([gate.ready, failed]), () => {
          closeAcpConnection(active)
          this.forgetConversation(input.threadId)
        })
        return { response: response.configOptions === undefined && replayOptions ? { ...response, configOptions: replayOptions } : response, ...(currentModeId ? { currentModeId } : {}) }
      } finally {
        gate.dispose()
        active.onUpdate = deliver
        load.catch(() => undefined)
      }
    }
    if (sessionCapability(active.info, 'resume')) return { response: await active.connection.agent.request(methods.agent.session.resume, { sessionId: saved.sessionId, cwd: input.cwd, mcpServers }) }
    return null
  }

  /** Sets the session's model: a fixed option (preset), else the control the session offers. */
  private async selectModel(active: AcpProcess, model: string): Promise<void> {
    const { label, store, quirks } = this.options
    if (quirks.modelConfigId) {
      if (!store.models().some((entry) => entry.id === model)) throw new Error(`This ${label} model is unavailable for the signed-in account`)
      await active.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: active.sessionId!, configId: quirks.modelConfigId, value: model })
      return
    }
    if (model === AGENT_DEFAULT_MODEL) return
    const listed = store.models()
    if (listed.length && !listed.some((entry) => entry.id === model)) throw new Error(`This ${label} model is unavailable for the signed-in account`)
    const control = active.modelControl ?? { kind: 'none' }
    if (control.kind === 'config') await active.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: active.sessionId!, configId: control.configId, value: model })
    else if (control.kind === 'set_model') await active.connection.agent.request('session/set_model', { sessionId: active.sessionId!, modelId: model })
    else throw new Error(`${label} offers no model choice; use its default model`)
  }

  /** Puts the session in the agent's plan mode for a plan turn, and back for a normal one. */
  private async selectMode(active: AcpProcess, mode: AcpChatInput['mode']): Promise<void> {
    const plan = planModeId(active.modes ?? [])
    if (mode === 'plan') {
      if (!plan) throw new Error(`${this.options.label} has no plan mode`)
      if (active.currentModeId === plan) return
      await active.connection.agent.request(methods.agent.session.setMode, { sessionId: active.sessionId!, modeId: plan })
      active.currentModeId = plan
      return
    }
    if (plan && active.currentModeId === plan && active.defaultModeId && active.defaultModeId !== plan) {
      await active.connection.agent.request(methods.agent.session.setMode, { sessionId: active.sessionId!, modeId: active.defaultModeId })
      active.currentModeId = active.defaultModeId
    }
  }

  /**
   * `mcp` attaches the Mousse MCP server to the ACP session (SPEC §15.2) and `orchestrationInstructions`
   * goes into the session's first prompt. The token is stable per thread, so a live session is reused
   * across turns; only a changed token (after a revocation) closes it and resumes with the new one.
   */
  async chat(input: AcpChatInput): Promise<string> {
    const { label, store, questions, quirks } = this.options
    input.signal?.throwIfAborted()
    const historyKey = this.historyKey(input.history ?? '')
    const instanceId = input.instanceId ?? this.options.defaultInstanceId
    // A native session belongs to the instance that opened it; another instance starts fresh.
    const stored = store.saved(input.threadId)
    let saved = stored && (stored.instanceId ?? this.options.defaultInstanceId) === instanceId ? stored : undefined
    let active = this.sessions.get(input.threadId)
    const mcpToken = input.mcp?.token ?? null
    if (active && (active.connection.signal.aborted || active.generation !== this.options.launchGeneration() || active.cwd !== input.cwd || saved?.historyKey !== historyKey || (active.mcpToken ?? null) !== mcpToken || (active.instanceId ?? this.options.defaultInstanceId) !== instanceId)) {
      this.close(active)
      this.sessions.delete(input.threadId)
      active = undefined
    }
    let freshProcess = !active
    if (!active) await this.options.beforeLaunch?.('turn')
    active ??= this.launch('turn')
    let current = active
    const adopt = (next: AcpProcess) => {
      next.threadId = input.threadId
      next.instanceId = instanceId
      next.cwd = input.cwd
      next.turnSignal = input.signal
      next.turnPrompter = input.prompter
      this.turning.add(next)
      current = next
    }
    adopt(active)
    const abort = () => {
      questions.autoRejectPendingForThread(input.threadId)
      // Closing also aborts setup RPCs; a lost startup abort must never dispatch a prompt.
      this.close(current)
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    let text = ''
    const toolTitles = new Map<string, string>()
    let resumed = !freshProcess
    let steerTimer: ReturnType<typeof setInterval> | undefined
    let steerFailure: unknown
    // A prompt is in flight, and the agent's silence is counted (`PROMPT_SILENCE_MS`).
    let prompting = false
    const silenceMs = this.options.promptSilenceMs ?? PROMPT_SILENCE_MS
    let silenceTimer: ReturnType<typeof setTimeout> | undefined
    let silenceFailure: Error | undefined
    /** Restarts the silence timer on a sign of life; it does not run while the agent waits on a request of its own. */
    const watchSilence = () => {
      clearTimeout(silenceTimer)
      silenceTimer = undefined
      if (!prompting || !(silenceMs > 0) || (current.openRequests ?? 0) > 0) return
      silenceTimer = setTimeout(() => {
        silenceFailure = harnessAppError({
          code: 'timeout',
          message: `${label} did not answer: it sent no reply and no update for ${describeDuration(silenceMs)}, so it was stopped. Send the message again.`,
          instanceId
        })
        closeAcpConnection(current)
      }, silenceMs)
      silenceTimer.unref?.()
    }
    const onUpdate = (update: unknown) => {
      watchSilence()
      if (!update || typeof update !== 'object') return
      const event = update as { sessionUpdate?: string; content?: { type?: string; text?: string }; toolCallId?: string; title?: string; name?: string; status?: string; configOptions?: NewSessionResponse['configOptions']; currentModeId?: string }
      if (event.sessionUpdate === 'agent_message_chunk' && event.content?.type === 'text') {
        text += event.content.text ?? ''
        input.onText(text)
      }
      if (event.sessionUpdate === 'tool_call' && event.toolCallId) {
        const title = event.name === 'start_subagent' ? `${label} subagent: ${event.title ?? 'Task'}` : event.title ?? event.name ?? `${label} tool`
        toolTitles.set(event.toolCallId, title)
        input.onTool?.({ phase: 'start', callId: event.toolCallId, title, toolName: event.name })
      }
      if (event.sessionUpdate === 'tool_call_update' && event.toolCallId && (event.status === 'completed' || event.status === 'failed')) {
        input.onTool?.({ phase: 'complete', callId: event.toolCallId, title: event.title ?? toolTitles.get(event.toolCallId) ?? `${label} tool`, status: event.status as 'completed' | 'failed' })
        toolTitles.delete(event.toolCallId)
      }
      if (event.sessionUpdate === 'config_option_update' && event.configOptions) {
        const updated = quirks.modelConfigId ? modelOptions({ configOptions: event.configOptions }) : agentModels({ configOptions: event.configOptions }).models
        if (updated.length) store.setModels(updated)
      }
      if (event.sessionUpdate === 'current_mode_update' && typeof event.currentModeId === 'string') current.currentModeId = event.currentModeId
    }
    try {
      input.signal?.throwIfAborted()
      if (freshProcess) {
        let session: unknown
        let known: (SessionSetup & { currentModeId?: string }) | undefined
        for (;;) {
          await this.initialize(current, quirks.clientFs === true)
          input.signal?.throwIfAborted()
          const mcpServers = sessionMcpServers(input.mcp, { http: current.mcpHttp === true && quirks.mcp !== 'stdio' })
          current.mcpToken = mcpToken
          session = undefined
          if (saved?.cwd === input.cwd && saved.historyKey === historyKey) {
            const reopenedId = saved.sessionId
            try {
              let reopened = true
              if (quirks.preferResume) session = await current.connection.agent.request(methods.agent.session.resume, { sessionId: reopenedId, cwd: input.cwd, mcpServers })
              else {
                // Setup metadata of a load replay applies; replayed conversation is dropped.
                current.onUpdate = onUpdate
                const loaded = await this.reopen(current, saved, input, mcpServers)
                reopened = loaded !== null
                if (loaded) {
                  session = loaded.response
                  known = { ...saved.setup, ...(loaded.currentModeId ? { currentModeId: loaded.currentModeId } : {}) }
                }
              }
              if (reopened) {
                current.sessionId = reopenedId
                resumed = true
              }
            } catch (error) {
              if (error instanceof SessionLoadTimeoutError) {
                // The process is gone and the session forgotten: a fresh one gets the history.
                this.processes.delete(current)
                this.turning.delete(current)
                saved = undefined
                this.options.notice?.(input.threadId, `${label} did not reopen this chat's session in time, so the chat history was handed to a new session.`)
                await this.options.beforeLaunch?.('turn')
                adopt(this.launch('turn'))
                freshProcess = true
                continue
              }
              input.signal?.throwIfAborted()
              current.connection.signal.throwIfAborted()
            }
          }
          if (!current.sessionId) {
            const created = await current.connection.agent.request(methods.agent.session.new, { cwd: input.cwd, mcpServers })
            current.sessionId = created.sessionId
            session = created
          }
          break
        }
        input.signal?.throwIfAborted()
        // Until the owning turn commits its updated history, this ACP session is
        // deliberately non-resumable after a crash or a failed/aborted prompt.
        // A resumed session keeps the instructions it was given; a new one has none yet.
        current.instructionsHash = resumed ? saved?.instructionsHash : undefined
        const instructions = current.instructionsHash ? { instructionsHash: current.instructionsHash } : {}
        store.setSaved(input.threadId, { sessionId: current.sessionId!, cwd: input.cwd, instanceId, ...instructions })
        if (quirks.modelConfigId) {
          const models = modelOptions((session ?? {}) as Pick<NewSessionResponse, 'configOptions'>)
          if (models.length) store.setModels(models)
        } else {
          this.observeSession(current, session ?? {}, known)
          store.setSaved(input.threadId, {
            sessionId: current.sessionId!, cwd: input.cwd, instanceId, ...instructions,
            setup: { ...(current.modelControl ? { modelControl: current.modelControl } : {}), modes: current.modes ?? [], ...(current.defaultModeId ? { defaultModeId: current.defaultModeId } : {}) }
          })
        }
        this.sessions.set(input.threadId, current)
      }
      active = current
      active.onUpdate = onUpdate
      if (!active.sessionId) throw new Error(`${label} session was not created`)
      input.onSession?.(active.sessionId)
      await this.selectModel(active, input.model)
      if (!quirks.modelConfigId) await this.selectMode(active, input.mode)
      input.signal?.throwIfAborted()
      const imageBlocks = (input.images ?? []).map((image) => {
        const mimeType = image.mimeType.toLowerCase()
        if (!['image/bmp', 'image/jpeg', 'image/png', 'image/webp'].includes(mimeType) || Buffer.byteLength(image.data, 'base64') > 10 * 1024 * 1024) {
          throw new Error(`${label} cannot send image ${image.name}; use BMP, JPEG, PNG, or WebP under 10 MiB`)
        }
        return { type: 'image' as const, data: image.data, mimeType }
      })
      const pendingSteers: string[] = []
      let cancelSent = false
      const turnProcess = active
      const collectSteer = () => {
        if (input.signal?.aborted || steerFailure) return
        try {
          const steer = input.drainSteer?.()?.trim()
          if (!steer) return
          input.onSteer?.(steer)
          pendingSteers.push(steer)
          if (prompting && !cancelSent) {
            cancelSent = true
            questions.autoRejectPendingForThread(input.threadId)
            // The same cancel and deadline as a stop: an agent that does not stop for the steer is
            // ended, and the turn fails rather than replaying a request whose outcome is unknown.
            void interruptWithDeadline({
              interrupt: async () => {
                await turnProcess.connection.agent.notify(methods.agent.session.cancel, { sessionId: turnProcess.sessionId! })
                await turnProcess.prompting
                return 'interrupted'
              },
              terminate: () => {
                steerFailure ??= new Error(`${label} did not stop for the new guidance, so it was ended. Send the guidance again.`)
                closeAcpConnection(turnProcess)
                this.sessions.delete(input.threadId)
              },
              forgetConversation: (threadId) => this.forgetConversation(threadId)
            }, { provider: '', ...(turnProcess.sessionId ? { sessionId: turnProcess.sessionId } : {}) }, { threadId: input.threadId, ...(this.options.cancelDeadlineMs !== undefined ? { deadlineMs: this.options.cancelDeadlineMs } : {}) })
              .catch((error) => { steerFailure ??= error; this.close(turnProcess) })
          }
        } catch (error) { steerFailure = error; this.close(turnProcess) }
      }
      steerTimer = setInterval(collectSteer, 100)
      steerTimer.unref?.()
      const history = !resumed && input.history
        ? `Previous conversation (context only; do not repeat earlier actions):\n${input.history}\n\nCurrent request:\n`
        : ''
      // The session's instructions go into its first prompt, and again into a resumed session's prompt
      // when they changed since (their hash is kept with the session). A slash command goes out
      // without them: the next prompt that is not a command carries them.
      const command = slashCommand(input.prompt)
      const instructionsHash = input.orchestrationInstructions ? createHash('sha256').update(input.orchestrationInstructions).digest('hex').slice(0, 32) : undefined
      const orchestration = !command && input.orchestrationInstructions && (!resumed || active.instructionsHash !== instructionsHash)
        ? `<mousse_orchestration_instructions>\n${input.orchestrationInstructions}\n</mousse_orchestration_instructions>\n\n`
        : ''
      if (!command && instructionsHash && active.instructionsHash !== instructionsHash) {
        active.instructionsHash = instructionsHash
        const savedNow = store.saved(input.threadId)
        if (savedNow) store.setSaved(input.threadId, { ...savedNow, instructionsHash })
      }
      const preamble = input.turnPreamble ? input.turnPreamble + '\n\nCurrent request:\n' : ''
      // The text blocks of the prompt. A command is the first block alone, as typed, because agents
      // parse a command at the start of the first block; the history the agent needs follows it.
      // (An agent that joins every block before it parses may still read the command literally.)
      let blocks = command
        ? [command, history + preamble].filter((block) => block)
        : [orchestration + history + preamble + (input.prompt || '(image attachment)')]
      let commandTurn = command !== undefined
      let attachments = imageBlocks
      for (;;) {
        input.signal?.throwIfAborted()
        if (steerFailure) throw steerFailure
        collectSteer()
        if (pendingSteers.length) {
          const guidance = 'Additional guidance:\n' + pendingSteers.splice(0).join('\n')
          if (commandTurn) blocks = [blocks[0], blocks[1] ? `${blocks[1]}\n\n${guidance}` : guidance]
          else blocks = [`${blocks[0]}\n\n${guidance}`]
        }
        prompting = true
        cancelSent = false
        active.cancelRequested = false
        active.activity = watchSilence
        watchSilence()
        // Any accepted prompt makes the old history fingerprint stale until commit.
        const accepted = store.saved(input.threadId)
        if (accepted) {
          const { historyKey: _stale, ...rest } = accepted
          store.setSaved(input.threadId, rest)
        }
        // xAI: the prompt is tagged, and ends at its reply or its `prompt_complete`, whichever is first.
        const promptId = quirks.xaiExtensions ? randomUUID() : undefined
        const reply = active.connection.agent.request(methods.agent.session.prompt, { sessionId: active.sessionId,
          prompt: [...blocks.map((block) => ({ type: 'text' as const, text: block })), ...attachments], ...(promptId ? { _meta: { promptId } } : {}) })
        const completion = promptId ? this.completionOf(active, promptId) : undefined
        const request: Promise<unknown> = completion ? Promise.race([reply, completion.done]) : reply
        if (completion) reply.catch(() => undefined)
        active.prompting = request.then(() => undefined, () => undefined)
        let outcome: unknown
        try {
          outcome = await request
        } catch (error) {
          completion?.dispose()
          throw error
        } finally {
          active.prompting = undefined
        }
        prompting = false
        watchSilence()
        if (completion) {
          // A steer's cancel: the next prompt waits (briefly) for the cancelled task to report its end.
          if (cancelSent) {
            let timer: ReturnType<typeof setTimeout> | undefined
            await Promise.race([completion.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, PROMPT_COMPLETE_WAIT_MS) })])
            clearTimeout(timer)
          }
          completion.dispose()
          // However the prompt ended, a refusal or an error is never a finished turn.
          const failure = cancelSent || input.signal?.aborted ? undefined : xaiStopFailure(label, outcome)
          if (failure) throw failure
        } else if (!cancelSent && !active.cancelRequested && !input.signal?.aborted) {
          // The agent's own word on how the prompt ended: a refusal or a limit is never a clean
          // success, and a cancel Mousse did not ask for is an interruption.
          const ended = promptStopOutcome(label, outcome)
          if (ended === 'cancelled') throw agentCancelledError(label)
          if (ended) throw ended
        }
        input.signal?.throwIfAborted()
        collectSteer()
        if (steerFailure) throw steerFailure
        if (!pendingSteers.length) break
        blocks = [pendingSteers.splice(0).join('\n')]
        commandTurn = false
        attachments = []
        if (text) text += '\n\n'
      }
      for (const [callId, title] of toolTitles) input.onTool?.({ phase: 'complete', callId, title, status: 'unfinished' })
      return text
    } catch (error) {
      this.close(current)
      this.sessions.delete(input.threadId)
      if (steerFailure) throw steerFailure
      if (silenceFailure && !input.signal?.aborted) throw silenceFailure
      throw this.authRequiredError(current, error) ?? error
    } finally {
      clearTimeout(silenceTimer)
      current.activity = undefined
      if (steerTimer) clearInterval(steerTimer)
      input.signal?.removeEventListener('abort', abort)
      current.onUpdate = undefined
      current.turnSignal = undefined
      current.turnPrompter = undefined
      this.turning.delete(current)
    }
  }

  /** Idle agent processes close now; a busy one is replaced on that thread's next turn. */
  closeIdle(): void {
    for (const [threadId, active] of this.sessions) {
      if (this.turning.has(active)) continue
      this.close(active)
      this.sessions.delete(threadId)
    }
  }

  closeAll(): void {
    for (const active of this.processes) closeAcpConnection(active)
    this.sessions.clear()
  }

  stop(): void {
    this.stopped = true
    this.closeAll()
  }
}
