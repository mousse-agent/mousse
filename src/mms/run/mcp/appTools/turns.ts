import { randomBytes } from 'node:crypto'
import type { AppToolTurn } from './types'

/** A fresh per-turn token: unguessable, never derived from ids a runtime can see. */
export function mintTurnToken(): string {
  return randomBytes(18).toString('base64url')
}

/**
 * `runId` → the app-tool context of the run's turn (PR 2 §2 "Turn context"). The `turn.start`
 * executor registers a turn before the gateway starts it and drops it when the turn settles, so a
 * call from a runtime reaches a turn's browser, skills and applets only while that turn runs.
 */
export class AppToolTurns {
  private readonly turns = new Map<string, AppToolTurn>()
  /** The latest turn token per thread, for a turn the runtime started itself (`continuation`). */
  private readonly lastToken = new Map<string, string>()

  /**
   * Registers the run's turn with a fresh token, or, for a turn the runtime started on its own, with
   * the token of the turn it continues: the runtime's calls in flight across that hand-over were
   * stamped with the earlier turn's token (PR 2 §2, `per_call` turn token). Returns the drop.
   */
  register(turn: Omit<AppToolTurn, 'turnToken'> & { turnToken?: string }, options: { continuation?: boolean } = {}): { turn: AppToolTurn; drop(): void } {
    const turnToken = turn.turnToken ?? (options.continuation ? this.lastToken.get(turn.threadId) : undefined) ?? mintTurnToken()
    const registered: AppToolTurn = { ...turn, turnToken }
    this.turns.set(turn.runId, registered)
    this.lastToken.set(turn.threadId, turnToken)
    return {
      turn: registered,
      drop: () => {
        if (this.turns.get(turn.runId)?.turnToken === turnToken) this.turns.delete(turn.runId)
      }
    }
  }

  get(runId: string): AppToolTurn | undefined {
    return this.turns.get(runId)
  }

  /**
   * Completes a registered turn once the executor knows the rest of it (its browser binding, skills
   * and applet staging); the token and identity never change.
   */
  update(runId: string, patch: Partial<Omit<AppToolTurn, 'threadId' | 'runId' | 'turnToken'>>): AppToolTurn | undefined {
    const turn = this.turns.get(runId)
    if (!turn) return undefined
    const updated: AppToolTurn = { ...turn, ...patch }
    this.turns.set(runId, updated)
    return updated
  }

  /** The run's turn ended, however it ended (the executor's last word on it). */
  dropRun(runId: string): void {
    this.turns.delete(runId)
  }

  /** The thread was deleted: nothing of it stays. */
  forgetThread(threadId: string): void {
    this.lastToken.delete(threadId)
    for (const [runId, turn] of this.turns) if (turn.threadId === threadId) this.turns.delete(runId)
  }
}
