import { createHash } from 'node:crypto'
import { methods, type NewSessionResponse } from '@agentclientprotocol/sdk'
import type { LlmModelOption } from '../../../shared/settings'
import type { ChatImageAttachment } from '../../../shared/types'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import { isAuthRequired } from './auth'
import { initializeAgent } from './capabilities'
import { closeAcpConnection, type AcpConnection, type AcpConnectionFactory, type AcpPurpose } from './connection'
import { sessionMcpServers } from './mcp'
import { modelOptions } from './models'
import { askToolPermission, readWorkspaceFile, writeWorkspaceFile, type AcpRequestScope } from './permissions'
import type { AcpQuirks } from './quirks'

/**
 * The ACP session lifecycle shared by every ACP agent: one agent process per thread, kept between
 * turns while its saved session still matches the committed history; `session/new` or a resumed
 * session; the prompt loop with steer as cancel-and-restart; and stop through the turn's signal.
 */

/** A connection the core opened, with the turn state it carries. */
export interface AcpProcess extends AcpConnection {
  sessionId?: string
  cwd?: string
  threadId?: string
  turnSignal?: AbortSignal
  /** `initialize` advertised `mcpCapabilities.http`; otherwise the Mousse server goes through the stdio bridge. */
  mcpHttp?: boolean
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
  /** Bumped when the launch settings change; a process from an older one is not reused. */
  launchGeneration(): number
  /** Bumped when a sign-in succeeds. */
  signInGeneration(): number
  /** The saved sign-in no longer works (the agent asked for sign-in). */
  markSignedOut(): void
  /** What a turn says when the agent wants a sign-in. */
  signInRequiredMessage: string
}

export class AcpSessions {
  private readonly sessions = new Map<string, AcpProcess>()
  private readonly processes = new Set<AcpProcess>()
  /** Processes running a turn right now. */
  private readonly turning = new Set<AcpProcess>()
  private stopped = false

  constructor(private readonly options: AcpSessionsOptions) {}

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
    const connection = this.options.connect({
      purpose,
      handlers: {
        requestPermission: (request) => askToolPermission(questions, scope, request, label),
        ...(quirks.clientFs ? {
          readTextFile: (request) => readWorkspaceFile(scope, request),
          writeTextFile: (request) => writeWorkspaceFile(questions, scope, request, label)
        } : {})
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
  async initialize(process: AcpProcess, clientFs = false): Promise<void> {
    const info = await initializeAgent(process.connection, { clientFs, label: this.options.label })
    process.mcpHttp = info.mcpHttp
  }

  close(process: AcpProcess): void {
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

  /**
   * `mcp` attaches the Mousse MCP server to the ACP session (SPEC §15.2) and `orchestrationInstructions`
   * goes into the session's first prompt. The token is stable per thread, so a live session is reused
   * across turns; only a changed token (after a revocation) closes it and resumes with the new one.
   */
  async chat(input: AcpChatInput): Promise<string> {
    const { label, store, questions } = this.options
    input.signal?.throwIfAborted()
    const historyKey = this.historyKey(input.history ?? '')
    const instanceId = input.instanceId ?? this.options.defaultInstanceId
    // A native session belongs to the instance that opened it; another instance starts fresh.
    const stored = store.saved(input.threadId)
    const saved = stored && (stored.instanceId ?? this.options.defaultInstanceId) === instanceId ? stored : undefined
    let active = this.sessions.get(input.threadId)
    const mcpToken = input.mcp?.token ?? null
    if (active && (active.connection.signal.aborted || active.generation !== this.options.launchGeneration() || active.cwd !== input.cwd || saved?.historyKey !== historyKey || (active.mcpToken ?? null) !== mcpToken || (active.instanceId ?? this.options.defaultInstanceId) !== instanceId)) {
      this.close(active)
      this.sessions.delete(input.threadId)
      active = undefined
    }
    const freshProcess = !active
    active ??= this.launch('turn')
    active.threadId = input.threadId
    active.instanceId = instanceId
    active.cwd = input.cwd
    active.turnSignal = input.signal
    const current = active
    this.turning.add(current)
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
    try {
      input.signal?.throwIfAborted()
      if (freshProcess) {
        await this.initialize(active, this.options.quirks.clientFs === true)
        input.signal?.throwIfAborted()
        const mcpServers = sessionMcpServers(input.mcp, { http: active.mcpHttp === true })
        active.mcpToken = mcpToken
        let session: Pick<NewSessionResponse, 'configOptions'>
        if (saved?.cwd === input.cwd && saved.historyKey === historyKey) {
          try {
            session = await active.connection.agent.request(methods.agent.session.resume, { sessionId: saved.sessionId, cwd: input.cwd, mcpServers })
            active.sessionId = saved.sessionId
            resumed = true
          } catch {
            input.signal?.throwIfAborted()
            active.connection.signal.throwIfAborted()
            session = await active.connection.agent.request(methods.agent.session.new, { cwd: input.cwd, mcpServers })
            active.sessionId = (session as NewSessionResponse).sessionId
          }
        } else {
          session = await active.connection.agent.request(methods.agent.session.new, { cwd: input.cwd, mcpServers })
          active.sessionId = (session as NewSessionResponse).sessionId
        }
        input.signal?.throwIfAborted()
        // Until the owning turn commits its updated history, this ACP session is
        // deliberately non-resumable after a crash or a failed/aborted prompt.
        store.setSaved(input.threadId, { sessionId: active.sessionId, cwd: input.cwd, instanceId })
        const models = modelOptions(session)
        if (models.length) store.setModels(models)
        this.sessions.set(input.threadId, active)
      }
      active.onUpdate = (update) => {
        if (!update || typeof update !== 'object') return
        const event = update as { sessionUpdate?: string; content?: { type?: string; text?: string }; toolCallId?: string; title?: string; name?: string; status?: string; configOptions?: NewSessionResponse['configOptions'] }
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
          const updated = modelOptions({ configOptions: event.configOptions })
          if (updated.length) store.setModels(updated)
        }
      }
      if (!active.sessionId) throw new Error(`${label} session was not created`)
      if (!store.models().some((model) => model.id === input.model)) throw new Error(`This ${label} model is unavailable for the signed-in account`)
      await active.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: active.sessionId, configId: 'model', value: input.model })
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
            void current.connection.agent.notify(methods.agent.session.cancel, { sessionId: current.sessionId! })
              .catch((error) => { steerFailure = error; this.close(current) })
          }
        } catch (error) { steerFailure = error; this.close(current) }
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
        await active.connection.agent.request(methods.agent.session.prompt, { sessionId: active.sessionId,
          prompt: [{ type: 'text', text: prompt }, ...attachments] })
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
    for (const active of this.processes) this.close(active)
    this.sessions.clear()
  }

  stop(): void {
    this.stopped = true
    this.closeAll()
  }
}
