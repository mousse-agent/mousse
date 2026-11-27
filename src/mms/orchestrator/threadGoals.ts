import { randomUUID } from 'node:crypto'
import {
  applyGoalReport,
  continuedGoal,
  decideAfterGoalTurn,
  goalDetails,
  newGoal,
  stoppedGoal,
  type GoalReportStatus,
  type GoalTurnOutcome,
  type ThreadGoal
} from '../../shared/threadGoal'
import type { Thread } from '../../shared/types'

/** The source of every turn Mousse starts for a goal: the first one (`/goal`) and each next one. */
export const GOAL_SOURCE = 'goal'

/** What the goals reach in the thread's owner. */
export interface ThreadGoalHost {
  thread(threadId: string): Thread | undefined
  saveGoal(threadId: string, goal: ThreadGoal | undefined): void
  /** The turn limit a new or continued goal gets (Settings → General → Threads). */
  turnLimit(): number
  /**
   * Queues a goal turn: the first is the person's goal, shown as their message; each next one is a hidden continue
   * message, so the transcript gets no bubble for it.
   */
  queueGoalTurn(threadId: string, turn: { visible: true; text: string } | { visible: false }): void
  /** Removes the goal turns still waiting in the thread's queue. */
  removeQueuedGoalTurns(threadId: string): void
  /** A goal turn waits in the thread's queue. */
  goalTurnQueued(threadId: string): boolean
  /** Anything waits in the thread's queue, or a turn is running or being started. */
  busy(threadId: string): boolean
  /** An approval or a question waits for the person. */
  waitingForPerson(threadId: string): boolean
  now(): string
}

export class GoalError extends Error {
  constructor(readonly code: 'not_found' | 'no_goal' | 'conflict' | 'invalid', message: string) {
    super(message)
    this.name = 'GoalError'
  }
}

/**
 * The goals of a profile's threads (issue #1207). `/goal` sets one and queues its first turn; after each turn of the
 * thread `afterTurn` decides, with `decideAfterGoalTurn`, whether the next goal turn is queued. The agent's
 * `goal_update` reports go through `report`. Everything is saved on the thread, so a restart keeps the goal, stopped.
 */
export class ThreadGoals {
  /** Threads whose agent reported in the turn running now; read and cleared when the turn ends. */
  private readonly reported = new Set<string>()

  constructor(private readonly host: ThreadGoalHost) {}

  get(threadId: string): ThreadGoal | undefined {
    return this.host.thread(threadId)?.goal
  }

  /** Whether a queued goal turn may still run: only while its goal is working. */
  goalTurnWanted(threadId: string): boolean {
    return this.get(threadId)?.state === 'working'
  }

  /** The working goal a turn starting now runs under (its `epoch`); undefined without one. */
  epochFor(threadId: string): string | undefined {
    const goal = this.get(threadId)
    return goal?.state === 'working' ? goal.epoch : undefined
  }

  /** `/goal <text>`: the thread's goal, replacing any other, and its first turn queued. */
  set(threadId: string, text: string): ThreadGoal {
    const trimmed = text.trim()
    if (!trimmed) throw new GoalError('invalid', 'Say what done looks like: /goal <text>.')
    this.requireThread(threadId)
    this.host.removeQueuedGoalTurns(threadId)
    this.reported.delete(threadId)
    const goal = newGoal(trimmed, this.host.turnLimit(), this.host.now(), randomUUID())
    this.host.saveGoal(threadId, goal)
    this.host.queueGoalTurn(threadId, { visible: true, text: trimmed })
    return goal
  }

  /**
   * `/goal <text>` on a new chat: the goal is set just before the window sends its text as the thread's first message,
   * so that turn runs under the goal and its end decides like any other. Nothing is queued here; a send the window could
   * not make clears the goal again.
   */
  adopt(threadId: string, text: string): ThreadGoal {
    const trimmed = text.trim()
    if (!trimmed) throw new GoalError('invalid', 'Say what done looks like: /goal <text>.')
    this.requireThread(threadId)
    this.host.removeQueuedGoalTurns(threadId)
    this.reported.delete(threadId)
    const goal = newGoal(trimmed, this.host.turnLimit(), this.host.now(), randomUUID())
    this.host.saveGoal(threadId, goal)
    return goal
  }

  /** `/goal clear`: no goal, and no goal turn left in the queue. A turn already running finishes. */
  clear(threadId: string): void {
    this.requireThread(threadId)
    this.host.removeQueuedGoalTurns(threadId)
    this.reported.delete(threadId)
    if (this.get(threadId)) this.host.saveGoal(threadId, undefined)
  }

  /** Continue: a goal that is not working works again, with a fresh allowance of turns. */
  continue(threadId: string): ThreadGoal {
    this.requireThread(threadId)
    const goal = this.get(threadId)
    if (!goal) throw new GoalError('no_goal', 'This thread has no goal.')
    if (goal.state === 'working') return goal
    const next = continuedGoal(goal, this.host.turnLimit(), this.host.now(), randomUUID())
    this.host.saveGoal(threadId, next)
    // A turn running now (a person's) is followed by the goal's when it ends; the queue keeps its order.
    if (!this.host.goalTurnQueued(threadId)) this.host.queueGoalTurn(threadId, { visible: false })
    return next
  }

  /** A Stop of the thread, from anywhere: the goal stops and its queued turn goes. */
  stopped(threadId: string): void {
    const goal = this.get(threadId)
    this.host.removeQueuedGoalTurns(threadId)
    if (goal?.state !== 'working') return
    this.host.saveGoal(threadId, stoppedGoal(goal, 'user', this.host.now()))
  }

  /**
   * `goal_update` from the thread's agent, in a turn that ran under the goal `turnEpoch`. A report from a turn of a goal
   * that was replaced or continued since changes nothing. Returns what the agent is told.
   */
  report(threadId: string, status: unknown, reason: unknown, turnEpoch: string | undefined): string {
    if (status !== 'met' && status !== 'continue' && status !== 'blocked') throw new GoalError('invalid', 'status must be "met", "continue" or "blocked".')
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (!text) throw new GoalError('invalid', 'Give a short reason.')
    const goal = this.get(threadId)
    if (!goal) throw new GoalError('no_goal', 'This thread has no goal; goal_update is only for a thread whose person set one with /goal.')
    if (goal.state !== 'working') return `The goal is already ${goal.state}; nothing more runs for it unless the person continues it.`
    if (turnEpoch !== goal.epoch) return 'This turn started before the person set or continued the goal it has now, so this report changes nothing. The next turn says what the goal is.'
    const next = applyGoalReport(goal, status as GoalReportStatus, text, this.host.now())
    this.reported.add(threadId)
    this.host.saveGoal(threadId, next)
    if (next.state !== 'working') this.host.removeQueuedGoalTurns(threadId)
    if (status === 'met') return 'Recorded: the goal is met. Mousse starts no more turns for it. Finish this turn with a short summary for the person.'
    if (status === 'blocked') return 'Recorded: the goal is blocked. Mousse stops and shows your reason to the person. End this turn by saying what you need.'
    return 'Recorded. Mousse starts the next turn when this one ends.'
  }

  /**
   * A turn of the thread ended. Only a working goal is touched: it stops on a pause, a failure, an interruption or a
   * waiting question; otherwise its next turn is queued unless something else runs first or a limit is reached.
   */
  afterTurn(threadId: string, outcome: GoalTurnOutcome, source: string | undefined, turnEpoch: string | undefined): void {
    const reported = this.reported.delete(threadId)
    const goal = this.get(threadId)
    if (goal?.state !== 'working') return
    // A turn that did not run under this goal (it started before the goal was set or continued) decides nothing: the
    // goal's own first turn is queued already, or follows the send that is starting it.
    if (!turnEpoch || turnEpoch !== goal.epoch) return
    const decision = decideAfterGoalTurn(goal, {
      outcome,
      goalTurn: source === GOAL_SOURCE,
      reported,
      waitingForPerson: this.host.waitingForPerson(threadId),
      queued: this.host.busy(threadId)
    }, this.host.now())
    if (decision.goal !== goal) this.host.saveGoal(threadId, decision.goal)
    if (decision.next) this.host.queueGoalTurn(threadId, { visible: false })
  }

  /** Startup: a goal still working was cut off by the restart. It shows as stopped and its queued turn goes. */
  recoverAtStartup(threads: readonly Thread[]): number {
    let stopped = 0
    for (const thread of threads) {
      const goal = thread.goal
      if (goal?.state !== 'working') continue
      try {
        this.host.removeQueuedGoalTurns(thread.id)
        this.host.saveGoal(thread.id, stoppedGoal(goal, 'restart', this.host.now()))
        stopped += 1
      } catch (error) {
        console.warn('a goal cut off by a restart could not be marked stopped', { threadId: thread.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return stopped
  }

  /** `/goal` alone: the goal in words. */
  describe(threadId: string): string {
    const goal = this.get(threadId)
    return goal ? goalDetails(goal) : 'This thread has no goal. Set one with /goal <what done looks like>.'
  }

  private requireThread(threadId: string): Thread {
    const thread = this.host.thread(threadId)
    if (!thread) throw new GoalError('not_found', `Thread not found: ${threadId}`)
    if (thread.botOwned || thread.lineage || thread.automationManager) throw new GoalError('invalid', 'Goals are for ordinary threads, not a bot\'s, a subagent\'s or the Automation manager\'s.')
    return thread
  }
}
