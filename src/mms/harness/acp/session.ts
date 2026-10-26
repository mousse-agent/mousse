import { createHash } from 'node:crypto'
import { methods, type NewSessionResponse } from '@agentclientprotocol/sdk'
import type { LlmModelOption } from '../../../shared/settings'
import type { ChatImageAttachment } from '../../../shared/types'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import { loadWithDeadline, SessionLoadTimeoutError } from '../supervise'
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
  /** Launch-settings generation the process was started with; an older one is not reused. */
  generation: number
  /** Sign-in generation at launch; a process from before the latest sign-in cannot sign the profile out. */
  signInGeneration: number
}

/** `instanceId` is absent on sessions saved before provider instances existed (the default instance). */
export interface SavedAcpSession {
  sessionId: string
  cwd: string
  historyKey?: string
  instanceId?: string
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
  appletInstructions?: string
  history?: string
  images?: ChatImageAttachment[]
  signal?: AbortSignal
  mcp?: { url: string; token: string } | null
  orchestrationInstructions?: string
  onText: (text: string) => void
  drainSteer?: () => string | undefined
  onSteer?: (text: string) => void
  onTool?: (event: { phase: 'start' | 'complete'; callId: string; title: string; toolName?: string }) => void
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
      aborted: () => Boolean(active?.turnSignal?.aborted || active?.connection.signal.aborted),
      throwIfAborted: () => {
        active?.turnSignal?.throwIfAborted()
        active?.connection.signal.throwIfAborted()
      }
    }
    const classify = this.options.classifyOption ?? classifyGenericOption
    const connection = this.options.connect({
      purpose,
      handlers: {
        requestPermission: (request) => answerPermission(this.prompter, scope, request, { label, classify }),
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
        } } : {})
      },
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

  /** Records a session's models and modes; returns them. */
  private observeSession(active: AcpProcess, session: unknown): { models: LlmModelOption[]; modes: Array<{ id: string; name: string }> } {
    const { models, control } = agentModels(session, active.info?.meta)
    const modes = agentModes(session)
    active.modelControl = control
    active.modes = modes.modes
    active.defaultModeId = modes.current
    active.currentModeId = modes.current
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
    await active.connection.agent.notify(methods.agent.session.cancel, { sessionId: active.sessionId! })
    await active.prompting
    return 'interrupted'
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
  private async reopen(active: AcpProcess, saved: SavedAcpSession, input: AcpChatInput, mcpServers: ReturnType<typeof sessionMcpServers>): Promise<unknown | null> {
    if (active.info?.agentCapabilities.loadSession === true) {
      const gate = new LoadGate(saved.sessionId)
      const deliver = active.onUpdate
      active.onUpdate = (update, sessionId) => {
        const verdict = gate.update(sessionId, update)
        if (verdict !== 'discard') deliver?.(update, sessionId)
      }
      let response: unknown = {}
      const load = active.connection.agent.request(methods.agent.session.load, { sessionId: saved.sessionId, cwd: input.cwd, mcpServers })
        .then((value) => {
          if (gate.state !== 'ready') response = value ?? {}
          gate.reply()
        })
      // A failed load ends the wait at once; a late answer after the gate opened changes nothing.
      const failed = load.then(() => new Promise<never>(() => {}))
      try {
        await loadWithDeadline(saved.sessionId, Promise.race([gate.ready, failed]), () => {
          closeAcpConnection(active)
          this.forgetConversation(input.threadId)
        })
        return response
      } finally {
        gate.dispose()
        active.onUpdate = deliver
        load.catch(() => undefined)
      }
    }
    if (sessionCapability(active.info, 'resume')) return active.connection.agent.request(methods.agent.session.resume, { sessionId: saved.sessionId, cwd: input.cwd, mcpServers })
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
    active ??= this.launch('turn')
    let current = active
    const adopt = (next: AcpProcess) => {
      next.threadId = input.threadId
      next.instanceId = instanceId
      next.cwd = input.cwd
      next.turnSignal = input.signal
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
    const onUpdate = (update: unknown) => {
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
        input.onTool?.({ phase: 'complete', callId: event.toolCallId, title: event.title ?? toolTitles.get(event.toolCallId) ?? `${label} tool` })
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
                session = await this.reopen(current, saved, input, mcpServers)
                reopened = session !== null
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
        store.setSaved(input.threadId, { sessionId: current.sessionId!, cwd: input.cwd, instanceId })
        if (quirks.modelConfigId) {
          const models = modelOptions((session ?? {}) as Pick<NewSessionResponse, 'configOptions'>)
          if (models.length) store.setModels(models)
        } else this.observeSession(current, session ?? {})
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
      let prompting = false
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
            void turnProcess.connection.agent.notify(methods.agent.session.cancel, { sessionId: turnProcess.sessionId! })
              .catch((error) => { steerFailure = error; this.close(turnProcess) })
          }
        } catch (error) { steerFailure = error; this.close(turnProcess) }
      }
      steerTimer = setInterval(collectSteer, 100)
      steerTimer.unref?.()
      const history = !resumed && input.history
        ? `Previous conversation (context only; do not repeat earlier actions):\n${input.history}\n\nCurrent request:\n`
        : ''
      const orchestration = !resumed && input.orchestrationInstructions
        ? `<mousse_orchestration_instructions>\n${input.orchestrationInstructions}\n</mousse_orchestration_instructions>\n\n`
        : ''
      let prompt = orchestration + history + (input.appletInstructions ? input.appletInstructions + '\n\nCurrent request:\n' : '') + (input.prompt || '(image attachment)')
      let attachments = imageBlocks
      for (;;) {
        input.signal?.throwIfAborted()
        if (steerFailure) throw steerFailure
        collectSteer()
        if (pendingSteers.length) prompt += '\n\nAdditional guidance:\n' + pendingSteers.splice(0).join('\n')
        prompting = true
        cancelSent = false
        // Any accepted prompt makes the old history fingerprint stale until commit.
        const accepted = store.saved(input.threadId)
        if (accepted) {
          const { historyKey: _stale, ...rest } = accepted
          store.setSaved(input.threadId, rest)
        }
        const request = active.connection.agent.request(methods.agent.session.prompt, { sessionId: active.sessionId,
          prompt: [{ type: 'text', text: prompt }, ...attachments] })
        active.prompting = request.then(() => undefined, () => undefined)
        try {
          await request
        } finally {
          active.prompting = undefined
        }
        prompting = false
        input.signal?.throwIfAborted()
        collectSteer()
        if (steerFailure) throw steerFailure
        if (!pendingSteers.length) break
        prompt = pendingSteers.splice(0).join('\n')
        attachments = []
        if (text) text += '\n\n'
      }
      for (const [callId, title] of toolTitles) input.onTool?.({ phase: 'complete', callId, title })
      return text
    } catch (error) {
      this.close(current)
      this.sessions.delete(input.threadId)
      if (steerFailure) throw steerFailure
      throw this.authRequiredError(current, error) ?? error
    } finally {
      if (steerTimer) clearInterval(steerTimer)
      input.signal?.removeEventListener('abort', abort)
      current.onUpdate = undefined
      current.turnSignal = undefined
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
