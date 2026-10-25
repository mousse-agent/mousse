import type { CodexNotification } from './protocol'

/** What the service saw of a thread no turn owned yet; a helper's first events can beat the item that names it. */
export interface StrayThread {
  turnId?: string
  completed: boolean
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
 * `spawnAgent` item (`receiverThreadIds`) on the parent's thread, while the run is live.
 *
 * Known gaps (a follow-up handles them):
 * - Only direct helpers are tracked. A helper that starts a helper of its own is not noticed, so the
 *   run does not wait for it and Stop does not interrupt it.
 * - A helper whose spawn is reported after Stop, or after the run was released, is never registered,
 *   so it is not interrupted.
 */
export class NativeHelpers {
  private readonly helpers = new Map<string, HelperState>()
  private waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
  private stopWith: ((threadId: string, turnId: string) => void) | undefined
  private closed: { reason: unknown } | undefined
  /** When a helper last reported anything: a spawn, or any event of its thread (the idle cap reads this). */
  lastActivityAt = Date.now()

  constructor(private readonly stray: (threadId: string) => StrayThread | undefined = () => undefined) {}

  has(threadId: string): boolean {
    return this.helpers.has(threadId)
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

  /** A notification of a helper's own thread. */
  handle(notification: CodexNotification): void {
    const params = notification.params as { threadId?: string; turn?: { id?: string }; status?: { type?: string } } | undefined
    const threadId = params?.threadId
    const helper = threadId ? this.helpers.get(threadId) : undefined
    if (!threadId || !helper) return
    // A stopped tracker claims at most one turn per helper: the first, for a helper that had none when
    // Stop landed. Later turns (work a later run sends the helper) are not its own.
    if (this.stopWith && notification.method === 'turn/started' && helper.turnId && helper.turnId !== params?.turn?.id) return
    this.lastActivityAt = Date.now()
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
  }

  private set(_threadId: string, helper: HelperState, running: boolean): void {
    helper.running = running
    if (running || this.running().length) return
    for (const waiter of this.waiters.splice(0)) waiter.resolve()
  }
}
