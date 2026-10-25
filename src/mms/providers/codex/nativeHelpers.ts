import type { CodexNotification } from './protocol'

/** What the service saw of a thread no turn owned yet; a helper's first events can beat the item that names it. */
export interface StrayThread {
  turnId?: string
  completed: boolean
  /** Spawn items the thread emitted before any run named it; replayed when it is registered as a helper. */
  spawns?: Array<{ type: string } & Record<string, unknown>>
}

type HelperState = { turnId?: string; running: boolean; seenActive: boolean; interruptedTurn?: string }

/**
 * The native helpers (Codex's own subagents, separate Codex threads) one Codex turn started.
 * Checked live against codex-cli 0.162: the app-server completes the parent's turn while its helpers
 * keep running, and `turn/interrupt` on the parent leaves them running; only `turn/interrupt` on the
 * helper's own thread (with the turn id from its `turn/started`) ends it. So Mousse tracks them to
 * keep the child's run open until they settle and to stop them with the child.
 *
 * A helper is named by a `subAgentActivity` item (`kind: 'started'`) or a `collabAgentToolCall`
 * `spawnAgent` item (`receiverThreadIds`) on the parent's thread, or on a helper's own thread
 * (helpers can start helpers).
 */
export class NativeHelpers {
  private readonly helpers = new Map<string, HelperState>()
  private waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
  private stopWith: ((threadId: string, turnId: string) => void) | undefined
  private closed: { reason: unknown } | undefined
  /** When a helper last reported anything: a spawn, or any event of its thread (the idle cap reads this). */
  lastActivityAt = Date.now()

  constructor(
    private readonly stray: (threadId: string) => StrayThread | undefined = () => undefined,
    /** The Codex thread whose turn started the helpers. */
    readonly parentThreadId?: string
  ) {}

  has(threadId: string): boolean {
    return this.helpers.has(threadId)
  }

  /** Whether `threadId` is the parent's thread or one of the helpers' threads. */
  owns(threadId: string): boolean {
    return threadId === this.parentThreadId || this.helpers.has(threadId)
  }

  /** Helper threads still running. */
  running(): string[] {
    return [...this.helpers].filter(([, helper]) => helper.running).map(([threadId]) => threadId)
  }

  /** An item of the parent's thread; registers a helper it names and follows its state. */
  noteItem(item: { type: string } & Record<string, unknown>): void {
    if (item.type === 'subAgentActivity') {
      const threadId = typeof item.agentThreadId === 'string' ? item.agentThreadId : undefined
      if (!threadId) return
      const helper = this.helpers.get(threadId)
      if (item.kind === 'completed' || item.kind === 'interrupted') {
        if (helper) this.set(threadId, helper, false)
      } else if (!helper) this.register(threadId)
      // The parent sent a known helper more work; a repeat of `started` never reopens a settled one.
      else if (item.kind === 'interacted') this.set(threadId, helper, true)
      return
    }
    if (item.type !== 'collabAgentToolCall') return
    if (item.tool === 'spawnAgent')
      for (const threadId of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) if (typeof threadId === 'string') this.register(threadId)
    const states = item.agentsStates && typeof item.agentsStates === 'object' ? (item.agentsStates as Record<string, { status?: string }>) : {}
    for (const [threadId, state] of Object.entries(states)) {
      const helper = this.helpers.get(threadId)
      if (helper && state?.status && state.status !== 'running' && state.status !== 'pendingInit') this.set(threadId, helper, false)
    }
  }

  /**
   * A notification of a helper's own thread. Its spawn items name helpers of its own; they are
   * tracked in the same set, so the run waits for, and Stop interrupts, the whole tree.
   */
  handle(notification: CodexNotification): void {
    const params = notification.params as { threadId?: string; turn?: { id?: string }; status?: { type?: string }; item?: { type?: string } } | undefined
    const threadId = params?.threadId
    // The stopped parent thread: only its spawn items matter (a helper named after Stop is still stopped).
    if (threadId && threadId === this.parentThreadId) {
      if ((notification.method === 'item/started' || notification.method === 'item/completed') && typeof params?.item?.type === 'string')
        this.noteItem(params.item as { type: string } & Record<string, unknown>)
      return
    }
    const helper = threadId ? this.helpers.get(threadId) : undefined
    if (!threadId || !helper) return
    this.lastActivityAt = Date.now()
    if ((notification.method === 'item/started' || notification.method === 'item/completed') && typeof params?.item?.type === 'string') {
      this.noteItem(params.item as { type: string } & Record<string, unknown>)
      return
    }
    if (notification.method === 'turn/started' && params?.turn?.id) {
      helper.turnId = params.turn.id
      helper.seenActive = true
      this.set(threadId, helper, true)
      this.interrupt(threadId, helper)
    } else if (notification.method === 'turn/completed') this.set(threadId, helper, false)
    else if (notification.method === 'thread/status/changed') {
      if (params?.status?.type === 'active') helper.seenActive = true
      else if (params?.status?.type === 'idle' && helper.seenActive) this.set(threadId, helper, false)
    }
  }

  /** A running helper has not reported its turn id yet, so a stop cannot reach it. */
  awaitingTurn(): boolean {
    return [...this.helpers.values()].some((helper) => helper.running && !helper.turnId)
  }

  /** Interrupts every running helper now, and any that starts its turn later. `send` issues `turn/interrupt`. */
  stopAll(send: (threadId: string, turnId: string) => void): void {
    this.stopWith = send
    for (const [threadId, helper] of this.helpers) this.interrupt(threadId, helper)
  }

  /** Interrupts a running helper whose turn id is known, once per turn, if a stop was requested. */
  private interrupt(threadId: string, helper: HelperState): void {
    if (!this.stopWith || !helper.running || !helper.turnId || helper.interruptedTurn === helper.turnId) return
    helper.interruptedTurn = helper.turnId
    this.stopWith(threadId, helper.turnId)
  }

  /** Resolves when no helper is running; rejects when the process is lost (`close`). */
  whenSettled(): Promise<void> {
    if (this.closed) return Promise.reject(this.closed.reason)
    if (!this.running().length) return Promise.resolve()
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  /** The process is gone: nothing more will be reported, so waiters fail instead of waiting forever. */
  close(reason: unknown): void {
    this.closed = { reason }
    for (const waiter of this.waiters.splice(0)) waiter.reject(reason)
  }

  private register(threadId: string): void {
    if (this.helpers.has(threadId)) return
    this.lastActivityAt = Date.now()
    const seen = this.stray(threadId)
    const helper: HelperState = { running: !seen?.completed, seenActive: Boolean(seen), ...(seen?.turnId ? { turnId: seen.turnId } : {}) }
    this.helpers.set(threadId, helper)
    this.interrupt(threadId, helper)
    // What the helper already spawned, in order: its helpers are tracked from here on.
    for (const item of seen?.spawns ?? []) this.noteItem(item)
  }

  private set(_threadId: string, helper: HelperState, running: boolean): void {
    helper.running = running
    if (running || this.running().length) return
    for (const waiter of this.waiters.splice(0)) waiter.resolve()
  }
}
