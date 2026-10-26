import { createHash } from 'node:crypto'
import type { ChatImageAttachment } from '../../../shared/types'
import { cursorMcpServers } from '../../run/mcp/attachment'
import type { CursorAgentSetup, CursorHostMethods, CursorUsage } from '../hosts/cursorProtocol'
import { interruptWithDeadline, recoverActiveRun } from '../supervise'
import { CursorHostCallError, type CursorHostClient, type CursorRunListener } from './hostClient'

/**
 * The turn lifecycle of a Cursor instance: one SDK agent per thread, kept between turns while
 * its saved agent still matches the committed history, reopened from the instance's local store
 * after a restart (`Agent.resume`), or created with the history in the first prompt. Steering
 * cancels the run and sends the guidance as the next one; stop is the run's native cancel. The
 * gateway's deadlines apply to both (`supervise.ts`): a run that does not stop in time ends with
 * the host, and each turn the host served ends once, interrupted, never replayed.
 */

/** What `<stateDir>/cursor.json` keeps per thread. */
export interface SavedCursorAgent {
  agentId: string
  cwd: string
  /** Fingerprint of the committed history the agent holds; absent until a turn commits. */
  historyKey?: string
  /** Runs Mousse started on the agent for this thread (most recent last), for active-run recovery. */
  runIds: string[]
}

export interface CursorSessionStore {
  saved(threadId: string): SavedCursorAgent | undefined
  setSaved(threadId: string, saved: SavedCursorAgent | undefined): void
}

export interface CursorToolEvent {
  phase: 'start' | 'complete'
  callId: string
  title: string
  toolName?: string
}

export interface CursorChatInput {
  threadId: string
  cwd: string
  /** `default` lets Cursor choose (its Auto model). */
  model: string
  mode?: 'default' | 'plan'
  prompt: string
  appletInstructions?: string
  history?: string
  images?: ChatImageAttachment[]
  signal?: AbortSignal
  mcp?: { url: string; token: string } | null
  orchestrationInstructions?: string
  onText(text: string): void
  onThinking?(text: string): void
  onTool?(event: CursorToolEvent): void
  drainSteer?(): string | undefined
  onSteer?(text: string): void
  /** The agent's id once known: provider refs name it for interrupt and terminate. */
  onSession?(agentId: string): void
}

export interface CursorChatResult {
  text: string
  /** The turn was stopped, or its host ended: it ends as interrupted and is not replayed. */
  interrupted: boolean
  usage?: CursorUsage
}

export interface CursorSessionsOptions {
  label: string
  host: CursorHostClient
  /** `JsonlLocalAgentStore` directory of the instance. */
  storeDir: string
  /** The credential turns run with; undefined when the instance is signed out. */
  apiKey(): string | undefined
  /** Ambient Cursor settings the agent loads (the user's rules, skills and MCP servers). */
  settingSources: readonly string[]
  store: CursorSessionStore
  /** Cursor refused the credential. */
  markSignedOut(): void
  signInRequiredMessage: string
  notice?(threadId: string, text: string): void
  /** Test seam: how long a cancel may take before the host is ended (`INTERRUPT_DEADLINE_MS`). */
  cancelDeadlineMs?: number
}

/** The model id that lets Cursor choose. */
export const CURSOR_DEFAULT_MODEL = 'default'
const RECORDED_RUNS = 20
const STEER_POLL_MS = 100

interface LiveAgent {
  agentId: string
  cwd: string
  mcpToken: string | null
  /** Host generation the agent was opened in; a restarted host no longer holds it. */
  generation: number
}

interface ActiveRun {
  ended: Promise<void>
  /** Asks the host to cancel the run, once (a stop and the gateway's interrupt may both ask). */
  cancel(): Promise<void>
}

type RunEnd = Parameters<CursorRunListener['end']>[0]

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** A short title for a Cursor tool call (`Shell: npm test`, `Read src/a.ts`). */
export function cursorToolTitle(toolCall: unknown, label = 'Cursor'): string {
  const call = toolCall && typeof toolCall === 'object' ? (toolCall as { type?: unknown; args?: unknown }) : {}
  const type = str(call.type) ?? 'tool'
  const args = call.args && typeof call.args === 'object' ? (call.args as Record<string, unknown>) : {}
  const subject = str(args.command) ?? str(args.path) ?? str(args.pattern) ?? str(args.globPattern) ?? str(args.description) ?? str(args.toolName) ?? str(args.name)
  const name = type.charAt(0).toUpperCase() + type.slice(1)
  if (!subject) return `${label} ${type}`
  const short = subject.length > 80 ? `${subject.slice(0, 77)}…` : subject
  return type === 'shell' ? `Shell: ${short}` : `${name} ${short}`
}

export class CursorSessions {
  private readonly live = new Map<string, LiveAgent>()
  private readonly active = new Map<string, ActiveRun>()
  private generation = 0
  private stopped = false

  constructor(private readonly options: CursorSessionsOptions) {
    options.host.onExit(() => {
      this.generation += 1
      this.live.clear()
    })
  }

  private historyKey(history: string): string {
    return createHash('sha256').update(history).digest('hex')
  }

  private local(cwd: string) {
    return { cwd, storeDir: this.options.storeDir }
  }

  /** Record only the history the owning turn durably committed. */
  commitConversation(threadId: string, history: string): void {
    const saved = this.options.store.saved(threadId)
    if (!saved || !this.live.has(threadId)) return
    this.options.store.setSaved(threadId, { ...saved, historyKey: this.historyKey(history) })
  }

  /** Drops the thread's agent; its next turn starts a new one with the history in the prompt. */
  forgetConversation(threadId: string): void {
    this.closeLive(threadId)
    if (this.options.store.saved(threadId)) this.options.store.setSaved(threadId, undefined)
  }

  private closeLive(threadId: string): void {
    const live = this.live.get(threadId)
    if (!live) return
    this.live.delete(threadId)
    if (live.generation === this.generation && this.options.host.running) {
      void this.options.host.request('close', { agentId: live.agentId }).catch(() => undefined)
    }
  }

  /** The native cancel of the agent's running run; resolves once the run has ended. */
  async interrupt(agentId: string | undefined): Promise<'interrupted' | 'not_active'> {
    const active = agentId ? this.active.get(agentId) : undefined
    if (!active) return 'not_active'
    await active.cancel()
    await active.ended
    return 'interrupted'
  }

  /** Ends the host and every run in it; each of those turns ends once, as interrupted. */
  terminate(): void {
    this.options.host.kill()
  }

  private setup(input: CursorChatInput, apiKey: string): CursorAgentSetup {
    return {
      apiKey,
      ...this.local(input.cwd),
      model: { id: input.model || CURSOR_DEFAULT_MODEL },
      mode: input.mode === 'plan' ? 'plan' : 'agent',
      ...(input.mcp ? { mcpServers: cursorMcpServers(input.mcp) } : {}),
      settingSources: [...this.options.settingSources],
      // Cursor approves tools itself; Auto-review is the gate it offers.
      autoReview: true
    }
  }

  private failure(error: unknown): Error {
    if (error instanceof CursorHostCallError && error.auth) {
      this.options.markSignedOut()
      return new Error(this.options.signInRequiredMessage)
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  /** The thread's agent: the live one, the saved one reopened, or a new one. */
  private async open(input: CursorChatInput, apiKey: string, historyKey: string): Promise<{ agentId: string; resumed: boolean }> {
    const { host, store, label } = this.options
    const mcpToken = input.mcp?.token ?? null
    const saved = store.saved(input.threadId)
    const matches = saved?.cwd === input.cwd && saved.historyKey === historyKey
    const live = this.live.get(input.threadId)
    if (live && live.generation === this.generation && matches && live.agentId === saved?.agentId && live.mcpToken === mcpToken) return { agentId: live.agentId, resumed: true }
    if (live) this.closeLive(input.threadId)
    const setup = this.setup(input, apiKey)
    if (saved && matches) {
      try {
        const { agentId } = await host.request('resume', { ...setup, agentId: saved.agentId })
        this.live.set(input.threadId, { agentId, cwd: input.cwd, mcpToken, generation: this.generation })
        return { agentId, resumed: true }
      } catch (error) {
        if (error instanceof CursorHostCallError && error.auth) throw this.failure(error)
        input.signal?.throwIfAborted()
        this.options.notice?.(input.threadId, `${label} could not reopen this chat's agent, so the chat history was handed to a new one.`)
      }
    }
    const { agentId } = await host.request('create', setup)
    store.setSaved(input.threadId, { agentId, cwd: input.cwd, runIds: [] })
    this.live.set(input.threadId, { agentId, cwd: input.cwd, mcpToken, generation: this.generation })
    return { agentId, resumed: false }
  }

  /**
   * Starts a run. An agent that still runs another run is recovered once, and only when that run
   * is provably this thread's (`recoverActiveRun`); otherwise the turn fails with the conflict.
   */
  private async startRun(threadId: string, agentId: string, cwd: string, params: CursorHostMethods['send']['params']): Promise<string> {
    const { host, store, label } = this.options
    const send = async () => (await host.request('send', params)).runId
    try {
      return await send()
    } catch (error) {
      if (!(error instanceof CursorHostCallError && error.activeRun)) throw error
      const listed = await host.request('listRuns', { agentId, ...this.local(cwd), limit: 5 })
      const running = listed.runs.find((run) => run.status === 'running')
      const saved = store.saved(threadId)
      const outcome = await recoverActiveRun(
        { agentId, ...(running ? { runId: running.id } : {}) },
        { ...(saved?.agentId ? { nativeAgentId: saved.agentId } : {}), recordedRunIds: new Set(saved?.runIds ?? []) },
        { cancelRun: async (runId) => void (await host.request('cancelRun', { runId, ...this.local(cwd) })), resend: send }
      )
      if (!outcome.recovered) throw new Error(`${label} is still running an earlier request in this chat that Mousse cannot stop safely. Wait for it to finish, then send the message again.`)
      return outcome.value
    }
  }

  async chat(input: CursorChatInput): Promise<CursorChatResult> {
    const { host, store, label } = this.options
    if (this.stopped) throw new Error(`${label} is stopped`)
    input.signal?.throwIfAborted()
    const apiKey = this.options.apiKey()
    if (!apiKey) throw new Error(this.options.signInRequiredMessage)
    const historyKey = this.historyKey(input.history ?? '')
    let opened: { agentId: string; resumed: boolean }
    try {
      opened = await this.open(input, apiKey, historyKey)
    } catch (error) {
      throw this.failure(error)
    }
    const { agentId } = opened
    input.onSession?.(agentId)
    const history = !opened.resumed && input.history
      ? `Previous conversation (context only; do not repeat earlier actions):\n${input.history}\n\nCurrent request:\n`
      : ''
    const orchestration = !opened.resumed && input.orchestrationInstructions
      ? `<mousse_orchestration_instructions>\n${input.orchestrationInstructions}\n</mousse_orchestration_instructions>\n\n`
      : ''
    let prompt = orchestration + history + (input.appletInstructions ? input.appletInstructions + '\n\nCurrent request:\n' : '') + (input.prompt || '(image attachment)')
    let images = (input.images ?? []).map((image) => ({ data: image.data, mimeType: image.mimeType }))
    const model = { id: input.model || CURSOR_DEFAULT_MODEL }
    const mcpServers = input.mcp ? cursorMcpServers(input.mcp) : undefined
    let text = ''
    let thinking = ''
    let usage: CursorUsage | undefined
    const pendingSteers: string[] = []
    let steerFailure: Error | undefined
    for (;;) {
      input.signal?.throwIfAborted()
      if (steerFailure) throw steerFailure
      const params = { agentId, text: prompt, ...(images.length ? { images } : {}), model, mode: input.mode === 'plan' ? 'plan' as const : 'agent' as const, ...(mcpServers ? { mcpServers } : {}) }
      // The run is registered before it is sent: a stop that arrives while the send is in flight
      // cancels it as soon as its id is known.
      let endRun!: (end: RunEnd) => void
      const ended = new Promise<RunEnd>((resolve) => { endRun = resolve })
      let started!: (runId: string | undefined) => void
      const runIdKnown = new Promise<string | undefined>((resolve) => { started = resolve })
      let cancelled: Promise<void> | undefined
      const active: ActiveRun = {
        ended: ended.then(() => undefined),
        cancel: () => (cancelled ??= runIdKnown.then(async (id) => void (id ? await host.request('cancel', { runId: id }) : undefined)))
      }
      this.active.set(agentId, active)
      // Stop: the native cancel; the gateway's deadline ends the host when it misses.
      const onAbort = () => void active.cancel().catch(() => undefined)
      input.signal?.addEventListener('abort', onAbort, { once: true })
      let runId: string
      try {
        runId = await this.startRun(input.threadId, agentId, input.cwd, params)
      } catch (error) {
        started(undefined)
        endRun({ status: 'error' })
        input.signal?.removeEventListener('abort', onAbort)
        if (this.active.get(agentId) === active) this.active.delete(agentId)
        this.closeLive(input.threadId)
        throw this.failure(error)
      }
      started(runId)
      // An accepted prompt makes the history fingerprint stale until the turn commits.
      const saved = store.saved(input.threadId)
      if (saved) {
        const { historyKey: _stale, ...rest } = saved
        store.setSaved(input.threadId, { ...rest, runIds: [...rest.runIds, runId].slice(-RECORDED_RUNS) })
      }
      const tools = new Map<string, string>()
      const base = text ? `${text}\n\n` : ''
      let runText = ''
      host.watchRun(runId, {
        update: (update) => {
          switch (update.type) {
            case 'text-delta':
              if (typeof update.text !== 'string') return
              runText += update.text
              text = base + runText
              input.onText(text)
              return
            case 'thinking-delta':
              if (typeof update.text !== 'string') return
              thinking += update.text
              input.onThinking?.(thinking)
              return
            case 'tool-call-started': {
              const callId = str(update.callId)
              if (!callId) return
              const title = cursorToolTitle(update.toolCall, label)
              tools.set(callId, title)
              input.onTool?.({ phase: 'start', callId, title, ...(str((update.toolCall as { type?: unknown })?.type) ? { toolName: str((update.toolCall as { type?: unknown }).type) } : {}) })
              return
            }
            case 'tool-call-completed': {
              const callId = str(update.callId)
              if (!callId) return
              input.onTool?.({ phase: 'complete', callId, title: tools.get(callId) ?? cursorToolTitle(update.toolCall, label) })
              tools.delete(callId)
              return
            }
            default:
          }
        },
        end: (end) => endRun(end)
      })
      // Steer: cancel the run (with the gateway's deadline) and send the guidance as the next one.
      let cancelling = false
      const collectSteer = () => {
        if (input.signal?.aborted || steerFailure) return
        let steer: string | undefined
        try {
          steer = input.drainSteer?.()?.trim()
        } catch (error) {
          steerFailure = error instanceof Error ? error : new Error(String(error))
          return
        }
        if (!steer) return
        input.onSteer?.(steer)
        pendingSteers.push(steer)
        if (cancelling) return
        cancelling = true
        void interruptWithDeadline({
          interrupt: async () => {
            await active.cancel()
            await active.ended
            return 'interrupted'
          },
          terminate: () => {
            steerFailure ??= new Error(`${label} did not stop for the new guidance, so it was ended. Send the guidance again.`)
            host.kill()
          },
          forgetConversation: (threadId) => this.forgetConversation(threadId)
        }, { provider: '', sessionId: agentId }, { threadId: input.threadId, ...(this.options.cancelDeadlineMs !== undefined ? { deadlineMs: this.options.cancelDeadlineMs } : {}) })
          .catch((error: unknown) => { steerFailure ??= error instanceof Error ? error : new Error(String(error)) })
      }
      const steerTimer = setInterval(collectSteer, STEER_POLL_MS)
      steerTimer.unref?.()
      let end: RunEnd
      try {
        end = await ended
      } finally {
        clearInterval(steerTimer)
        input.signal?.removeEventListener('abort', onAbort)
        if (this.active.get(agentId) === active) this.active.delete(agentId)
      }
      for (const [callId, title] of tools) input.onTool?.({ phase: 'complete', callId, title })
      if ('hostExited' in end) {
        this.live.delete(input.threadId)
        if (steerFailure) throw steerFailure
        return { text, interrupted: true, ...(usage ? { usage } : {}) }
      }
      if (end.usage) usage = addUsage(usage, end.usage)
      if (end.status === 'error') {
        this.closeLive(input.threadId)
        throw this.failure(end.error ? new CursorHostCallError(end.error) : new Error(`${label} failed.`))
      }
      if (end.transportFailure) {
        // The reply was only a transport error: the turn failed once and is not sent again.
        this.closeLive(input.threadId)
        throw new Error(`${label} lost its connection to Cursor (${end.transportFailure}). Send the message again.`)
      }
      if (input.signal?.aborted) return { text, interrupted: true, ...(usage ? { usage } : {}) }
      collectSteer()
      if (steerFailure) throw steerFailure
      if (end.status === 'cancelled' && !pendingSteers.length) return { text, interrupted: true, ...(usage ? { usage } : {}) }
      if (!pendingSteers.length) return { text, interrupted: false, ...(usage ? { usage } : {}) }
      prompt = pendingSteers.splice(0).join('\n')
      images = []
    }
  }

  closeAll(): void {
    for (const threadId of [...this.live.keys()]) this.closeLive(threadId)
  }

  stop(): void {
    this.stopped = true
    this.live.clear()
    this.options.host.stop()
  }
}

function addUsage(total: CursorUsage | undefined, next: CursorUsage): CursorUsage {
  if (!total) return { ...next }
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens
  }
}
