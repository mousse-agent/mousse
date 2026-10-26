import { createHash, randomUUID } from 'node:crypto'
import type { ChatImageAttachment } from '../../../shared/types'
import { cursorMcpServers } from '../../run/mcp/attachment'
import type { CursorAgentSetup, CursorHostMethods, CursorUsage } from '../hosts/cursorProtocol'
import { interruptWithDeadline, LOAD_DEADLINE_MS, loadWithDeadline, recoverActiveRun, SessionLoadTimeoutError } from '../supervise'
import { CursorHostCallError, CursorHostExitedError, type CursorHostClient, type CursorRunListener } from './hostClient'

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
  /** Threads with a saved agent. */
  threads(): string[]
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
  /**
   * The id provider refs name for interrupt and terminate: a turn key at once, then the agent's id
   * once it is known.
   */
  onSession?(id: string): void
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
  /** Test seam: how long reopening a saved agent may take (`LOAD_DEADLINE_MS`). */
  loadDeadlineMs?: number
}

/** The model id that lets Cursor choose. */
export const CURSOR_DEFAULT_MODEL = 'default'
const RECORDED_RUNS = 20
const STEER_POLL_MS = 100

interface LiveAgent {
  agentId: string
  cwd: string
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

/** Raised inside a turn when its Stop arrives before the work it waits for. */
class TurnStopped extends Error {
  constructor() {
    super('The turn was stopped.')
    this.name = 'TurnStopped'
  }
}

/** One live turn: everything it waits for settles when it is stopped. */
interface Turn {
  threadId: string
  /** Aborted by Stop: the turn's own signal, or the gateway's interrupt. */
  stop: AbortController
  /** Resolves once the turn has ended, either way. */
  settled: Promise<void>
}

/** What a turn produced so far; kept when it ends early. */
interface Progress {
  text: string
  usage?: CursorUsage
}

/** `work`, or `TurnStopped` as soon as `stop` aborts. */
function stoppable<T>(work: Promise<T>, stop: AbortSignal): Promise<T> {
  if (stop.aborted) return Promise.reject(new TurnStopped())
  return new Promise<T>((resolve, reject) => {
    const onStop = () => reject(new TurnStopped())
    stop.addEventListener('abort', onStop, { once: true })
    work.then(resolve, reject).finally(() => stop.removeEventListener('abort', onStop))
  })
}

export class CursorSessions {
  private readonly live = new Map<string, LiveAgent>()
  /** Live turns, by the id their provider ref names: a turn key until the agent is known, then both. */
  private readonly turns = new Map<string, Turn>()
  /** Agents no thread uses any more, removed from the store when the host runs next. */
  private readonly toPrune = new Set<string>()
  /** Reopens in flight, by agent: a late answer to an abandoned one must not close the agent another turn is reopening. */
  private readonly reopening = new Map<string, number>()
  private generation = 0
  /** The thread whose stuck stop or steer is ending the host. */
  private endingFor: string | undefined
  /** Why the host last exited: for the notice of the other threads it cut short. */
  private lastExit: { endedFor?: string } = {}
  private stopped = false

  constructor(private readonly options: CursorSessionsOptions) {
    options.host.onExit(() => {
      this.lastExit = this.endingFor ? { endedFor: this.endingFor } : {}
      this.endingFor = undefined
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
    const saved = this.options.store.saved(threadId)
    if (!saved) return
    this.options.store.setSaved(threadId, undefined)
    this.prune([saved.agentId])
  }

  /** Drops every thread's agent (the credential changed, or the user signed out). */
  forgetAll(): void {
    for (const threadId of this.options.store.threads()) this.forgetConversation(threadId)
    this.closeAll()
  }

  /** Removes superseded agents from the store: now when the host runs, else before the next turn. */
  private prune(agentIds: string[]): void {
    for (const agentId of agentIds) this.toPrune.add(agentId)
    if (this.options.host.running) void this.flushPrune()
  }

  private async flushPrune(): Promise<void> {
    if (!this.toPrune.size) return
    const agentIds = [...this.toPrune].sort()
    this.toPrune.clear()
    try {
      await this.options.host.request('prune', { storeDir: this.options.storeDir, agentIds })
    } catch {
      // Pruning saves space only; an agent left behind is never resumed.
    }
  }

  private closeLive(threadId: string): void {
    const live = this.live.get(threadId)
    if (!live) return
    this.live.delete(threadId)
    if (live.generation === this.generation && this.options.host.running) {
      void this.options.host.request('close', { agentId: live.agentId }).catch(() => undefined)
    }
  }

  /** Whether a live agent, a turn or a reopen still uses `agentId`. */
  private inUse(agentId: string): boolean {
    if (this.turns.has(agentId) || (this.reopening.get(agentId) ?? 0) > 0) return true
    for (const live of this.live.values()) if (live.agentId === agentId) return true
    return false
  }

  /**
   * An open the turn stopped waiting for: when it still answers, its agent is closed (and removed
   * when new), unless another turn has reopened the same agent meanwhile.
   */
  private abandon(opening: Promise<{ agentId: string }>, options: { prune: boolean }): void {
    void opening.then(({ agentId }) => {
      if (this.inUse(agentId)) return
      void this.options.host.request('close', { agentId }).catch(() => undefined)
      if (options.prune) this.prune([agentId])
    }, () => undefined)
  }

  /** Stops the turn `id` names (its turn key or its agent) and resolves once it has ended. */
  async interrupt(id: string | undefined): Promise<'interrupted' | 'not_active'> {
    const turn = id ? this.turns.get(id) : undefined
    if (!turn) return 'not_active'
    turn.stop.abort()
    await turn.settled
    return 'interrupted'
  }

  /**
   * Ends the host and every turn in it; each ends once, as interrupted. The other threads it cut
   * short are told why.
   */
  terminate(id?: string): void {
    const turn = id ? this.turns.get(id) : undefined
    // Only a running host exits; otherwise nothing would clear the mark.
    if (this.options.host.running) this.endingFor = turn?.threadId
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

  /**
   * The thread's agent: the live one, the saved one reopened (within the shared load deadline), or
   * a new one. Every wait ends at Stop; an open that answers after it is closed again. The MCP
   * token is not part of the match: each send carries the current one.
   */
  private async open(input: CursorChatInput, apiKey: string, historyKey: string, stop: AbortSignal): Promise<{ agentId: string; resumed: boolean }> {
    const { host, store, label } = this.options
    // A Stop that came first opens nothing (and starts no host).
    if (stop.aborted) throw new TurnStopped()
    const saved = store.saved(input.threadId)
    const matches = saved?.cwd === input.cwd && saved.historyKey === historyKey
    const live = this.live.get(input.threadId)
    if (live && live.generation === this.generation && matches && live.agentId === saved?.agentId) return { agentId: live.agentId, resumed: true }
    if (live) this.closeLive(input.threadId)
    const setup = this.setup(input, apiKey)
    if (saved && matches) {
      const resuming = host.request('resume', { ...setup, agentId: saved.agentId })
      this.reopening.set(saved.agentId, (this.reopening.get(saved.agentId) ?? 0) + 1)
      try {
        const { agentId } = await loadWithDeadline(saved.agentId, stoppable(resuming, stop), () => {}, this.options.loadDeadlineMs ?? LOAD_DEADLINE_MS)
        this.live.set(input.threadId, { agentId, cwd: input.cwd, generation: this.generation })
        return { agentId, resumed: true }
      } catch (error) {
        if (error instanceof TurnStopped) {
          this.abandon(resuming, { prune: false })
          throw error
        }
        if (error instanceof CursorHostCallError && error.auth) throw this.failure(error)
        if (error instanceof CursorHostExitedError) throw error
        // A resume that failed or missed the deadline: the history goes to a new agent instead.
        if (error instanceof SessionLoadTimeoutError) this.abandon(resuming, { prune: false })
        this.options.notice?.(input.threadId, `${label} could not reopen this chat's agent, so the chat history was handed to a new one.`)
      } finally {
        const left = (this.reopening.get(saved.agentId) ?? 1) - 1
        if (left > 0) this.reopening.set(saved.agentId, left)
        else this.reopening.delete(saved.agentId)
      }
    }
    const creating = host.request('create', setup)
    let agentId: string
    try {
      ;({ agentId } = await stoppable(creating, stop))
    } catch (error) {
      if (error instanceof TurnStopped) this.abandon(creating, { prune: true })
      throw error
    }
    store.setSaved(input.threadId, { agentId, cwd: input.cwd, runIds: [] })
    if (saved && saved.agentId !== agentId) this.prune([saved.agentId])
    this.live.set(input.threadId, { agentId, cwd: input.cwd, generation: this.generation })
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
    const { label } = this.options
    if (this.stopped) throw new Error(`${label} is stopped`)
    input.signal?.throwIfAborted()
    const apiKey = this.options.apiKey()
    if (!apiKey) throw new Error(this.options.signInRequiredMessage)
    let settle!: () => void
    const turn: Turn = { threadId: input.threadId, stop: new AbortController(), settled: new Promise<void>((resolve) => { settle = resolve }) }
    // The ref names the turn from the start, so a Stop before its agent exists still finds it.
    const key = `cursor-turn:${randomUUID()}`
    this.turns.set(key, turn)
    input.onSession?.(key)
    let agentId: string | undefined
    const onAbort = () => turn.stop.abort()
    input.signal?.addEventListener('abort', onAbort, { once: true })
    const progress: Progress = { text: '' }
    const interrupted = (): CursorChatResult => ({ text: progress.text, interrupted: true, ...(progress.usage ? { usage: progress.usage } : {}) })
    try {
      return await this.runTurn(input, apiKey, turn, progress, (id) => {
        agentId = id
        this.turns.set(id, turn)
        input.onSession?.(id)
      })
    } catch (error) {
      if (error instanceof TurnStopped) return interrupted()
      if (error instanceof CursorHostExitedError) {
        // The prompt may already have reached Cursor: the outcome is unknown, so the turn ends as
        // interrupted, its agent is not resumed, and nothing is sent again.
        this.forgetConversation(input.threadId)
        const { endedFor } = this.lastExit
        if (endedFor && endedFor !== input.threadId) this.options.notice?.(input.threadId, `${label} was restarted to stop another chat, so this reply was cut short.`)
        return interrupted()
      }
      throw error
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      this.turns.delete(key)
      if (agentId && this.turns.get(agentId) === turn) this.turns.delete(agentId)
      settle()
    }
  }

  private async runTurn(input: CursorChatInput, apiKey: string, turn: Turn, progress: Progress, opened: (agentId: string) => void): Promise<CursorChatResult> {
    const { host, store, label } = this.options
    const stop = turn.stop.signal
    // A prune that hangs ends with the turn's Stop like everything else it waits for.
    await stoppable(this.flushPrune(), stop)
    let open: { agentId: string; resumed: boolean }
    try {
      open = await this.open(input, apiKey, this.historyKey(input.history ?? ''), stop)
    } catch (error) {
      if (error instanceof TurnStopped || error instanceof CursorHostExitedError) throw error
      throw this.failure(error)
    }
    const { agentId } = open
    opened(agentId)
    if (stop.aborted) throw new TurnStopped()
    const history = !open.resumed && input.history
      ? `Previous conversation (context only; do not repeat earlier actions):\n${input.history}\n\nCurrent request:\n`
      : ''
    const orchestration = !open.resumed && input.orchestrationInstructions
      ? `<mousse_orchestration_instructions>\n${input.orchestrationInstructions}\n</mousse_orchestration_instructions>\n\n`
      : ''
    let prompt = orchestration + history + (input.appletInstructions ? input.appletInstructions + '\n\nCurrent request:\n' : '') + (input.prompt || '(image attachment)')
    let images = (input.images ?? []).map((image) => ({ data: image.data, mimeType: image.mimeType }))
    const model = { id: input.model || CURSOR_DEFAULT_MODEL }
    const mcpServers = input.mcp ? cursorMcpServers(input.mcp) : undefined
    let thinking = ''
    const pendingSteers: string[] = []
    let steerFailure: Error | undefined
    for (;;) {
      if (stop.aborted) throw new TurnStopped()
      if (steerFailure) throw steerFailure
      const params = { agentId, text: prompt, ...(images.length ? { images } : {}), model, mode: input.mode === 'plan' ? 'plan' as const : 'agent' as const, ...(mcpServers ? { mcpServers } : {}) }
      // The run is registered before it is sent: a Stop while the send is in flight cancels it as
      // soon as its id is known (and the gateway's deadline ends the host when that never comes).
      let endRun!: (end: RunEnd) => void
      const ended = new Promise<RunEnd>((resolve) => { endRun = resolve })
      let started!: (runId: string | undefined) => void
      const runIdKnown = new Promise<string | undefined>((resolve) => { started = resolve })
      let cancelled: Promise<void> | undefined
      const active: ActiveRun = {
        ended: ended.then(() => undefined),
        cancel: () => (cancelled ??= runIdKnown.then(async (id) => void (id ? await host.request('cancel', { runId: id }) : undefined)))
      }
      const onStop = () => void active.cancel().catch(() => undefined)
      stop.addEventListener('abort', onStop, { once: true })
      let runId: string
      try {
        runId = await this.startRun(input.threadId, agentId, input.cwd, params)
      } catch (error) {
        started(undefined)
        stop.removeEventListener('abort', onStop)
        if (error instanceof CursorHostExitedError) throw error
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
      const base = progress.text ? `${progress.text}\n\n` : ''
      let runText = ''
      host.watchRun(runId, {
        update: (update) => {
          switch (update.type) {
            case 'text-delta':
              if (typeof update.text !== 'string') return
              runText += update.text
              progress.text = base + runText
              input.onText(progress.text)
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
              const toolName = str((update.toolCall as { type?: unknown } | undefined)?.type)
              input.onTool?.({ phase: 'start', callId, title, ...(toolName ? { toolName } : {}) })
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
        if (stop.aborted || steerFailure) return
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
            this.endingFor = input.threadId
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
        stop.removeEventListener('abort', onStop)
      }
      for (const [callId, title] of tools) input.onTool?.({ phase: 'complete', callId, title })
      if ('hostExited' in end) {
        if (steerFailure) throw steerFailure
        throw new CursorHostExitedError('while the run streamed')
      }
      if (end.usage) progress.usage = addUsage(progress.usage, end.usage)
      if (end.status === 'error') {
        this.closeLive(input.threadId)
        throw this.failure(end.error ? new CursorHostCallError(end.error) : new Error(`${label} failed.`))
      }
      if (end.transportFailure) {
        // The reply was only a transport error: the turn failed once and is not sent again.
        this.closeLive(input.threadId)
        throw new Error(`${label} lost its connection to Cursor (${end.transportFailure}). Send the message again.`)
      }
      if (stop.aborted) throw new TurnStopped()
      collectSteer()
      if (steerFailure) throw steerFailure
      if (end.status === 'cancelled' && !pendingSteers.length) throw new TurnStopped()
      if (!pendingSteers.length) return { text: progress.text, interrupted: false, ...(progress.usage ? { usage: progress.usage } : {}) }
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
