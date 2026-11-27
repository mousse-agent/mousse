/**
 * Thread goals (issue #1207): `/goal <what done looks like>` sets a goal on a thread, and Mousse keeps starting turns
 * until the agent reports it met (`goal_update`), the agent is blocked, a limit is reached or the person stops it.
 * The goal is saved on the thread (`Thread.goal`), so it survives a restart.
 */

/** `working`: Mousse starts the next turn after each one. The others start nothing until Continue. */
export type ThreadGoalState = 'working' | 'met' | 'stuck' | 'stopped'

/** What the agent says with `goal_update`. */
export type GoalReportStatus = 'met' | 'continue' | 'blocked'

/** Why a goal stopped. */
export type GoalStopCause = 'user' | 'turn_limit' | 'usage_limit' | 'error' | 'waiting' | 'interrupted' | 'restart'

export interface GoalReport {
  status: GoalReportStatus
  /** The agent's own short words: what is done, what is next, or what blocks it. */
  reason: string
  at: string
}

export interface ThreadGoal {
  /** What done looks like, as the person typed it. */
  text: string
  /**
   * Which goal this is: new when a goal is set and when it is continued. A turn records the one it ran under, and its
   * report and its end count only while that is still the thread's goal (a goal set or continued meanwhile is another).
   */
  epoch: string
  state: ThreadGoalState
  /** Set when stopped: why. */
  stoppedBy?: GoalStopCause
  /** Goal turns Mousse started since the goal was set or last continued, the first included. */
  turns: number
  /** Goal turns allowed before the goal stops; Continue allows this many again. */
  turnLimit: number
  /** Goal turns in a row that ended without a `goal_update` report. */
  silentTurns: number
  /** The agent's latest report. */
  lastReport?: GoalReport
  setAt: string
  updatedAt: string
}

export const DEFAULT_GOAL_TURN_LIMIT = 20
export const MAX_GOAL_TURN_LIMIT = 200
/** The longest goal text kept. */
export const MAX_GOAL_TEXT = 2_000
/** The longest reason kept from a report. */
export const MAX_GOAL_REASON = 500
/** Goal turns in a row without a report before the goal counts as stuck. */
export const GOAL_SILENT_TURN_LIMIT = 2

/** The name of the app tool the agent reports with. */
export const GOAL_UPDATE_TOOL = 'goal_update'

/** The choices Settings offers for the turn limit. A value saved by hand outside these stays listed. */
export const GOAL_TURN_LIMIT_CHOICES = [5, 10, 20, 50, 100] as const

export function normalizeGoalTurnLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_GOAL_TURN_LIMIT ? value : DEFAULT_GOAL_TURN_LIMIT
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** A new goal, counting the turn that starts it. */
export function newGoal(text: string, turnLimit: number, now: string, epoch: string): ThreadGoal {
  return { text: text.trim().slice(0, MAX_GOAL_TEXT), epoch, state: 'working', turns: 1, turnLimit: normalizeGoalTurnLimit(turnLimit), silentTurns: 0, setAt: now, updatedAt: now }
}

/** Continue: the goal works again with a fresh allowance of turns, counting the turn Continue starts. */
export function continuedGoal(goal: ThreadGoal, turnLimit: number, now: string, epoch: string): ThreadGoal {
  const { stoppedBy: _stoppedBy, ...rest } = goal
  return { ...rest, epoch, state: 'working', turns: 1, turnLimit: normalizeGoalTurnLimit(turnLimit), silentTurns: 0, updatedAt: now }
}

export function stoppedGoal(goal: ThreadGoal, cause: GoalStopCause, now: string): ThreadGoal {
  return { ...goal, state: 'stopped', stoppedBy: cause, updatedAt: now }
}

/**
 * A `goal_update` report: `met` ends the goal, `blocked` makes it stuck, `continue` keeps it working. Only a working
 * goal takes a report; any other is returned as it is.
 */
export function applyGoalReport(goal: ThreadGoal, status: GoalReportStatus, reason: string, now: string): ThreadGoal {
  if (goal.state !== 'working') return goal
  const report: GoalReport = { status, reason: clip(reason, MAX_GOAL_REASON), at: now }
  const state: ThreadGoalState = status === 'met' ? 'met' : status === 'blocked' ? 'stuck' : 'working'
  return { ...goal, state, lastReport: report, silentTurns: 0, updatedAt: now }
}

/** How a turn of a thread with a goal ended. */
export type GoalTurnOutcome = 'completed' | 'failed' | 'interrupted' | 'paused'

export interface GoalTurnEnd {
  outcome: GoalTurnOutcome
  /** The turn was one Mousse started for the goal (not a message the person sent). */
  goalTurn: boolean
  /** The agent called `goal_update` in this turn. */
  reported: boolean
  /** An approval or a question is still waiting for the person. */
  waitingForPerson: boolean
  /** Something is queued on the thread (a person's message, or the next goal turn): it runs first, and its end decides. */
  queued: boolean
}

/**
 * What happens after a turn of a thread whose goal is working: the goal as it is now, and whether Mousse queues the
 * next goal turn. Every stop is decided here; nothing else starts a goal turn but `/goal` and Continue.
 */
export function decideAfterGoalTurn(goal: ThreadGoal, end: GoalTurnEnd, now: string): { goal: ThreadGoal; next: boolean } {
  if (goal.state !== 'working') return { goal, next: false }
  if (end.outcome === 'paused') return { goal: stoppedGoal(goal, 'usage_limit', now), next: false }
  if (end.outcome === 'failed') return { goal: stoppedGoal(goal, 'error', now), next: false }
  if (end.outcome === 'interrupted') return { goal: stoppedGoal(goal, 'interrupted', now), next: false }
  if (end.waitingForPerson) return { goal: stoppedGoal(goal, 'waiting', now), next: false }
  // Only a goal turn's silence counts: a person may ask something in passing that needs no report.
  const silentTurns = end.goalTurn && !end.reported ? goal.silentTurns + 1 : end.reported ? 0 : goal.silentTurns
  const counted: ThreadGoal = silentTurns === goal.silentTurns ? goal : { ...goal, silentTurns, updatedAt: now }
  if (silentTurns >= GOAL_SILENT_TURN_LIMIT) {
    return { goal: { ...counted, state: 'stuck', lastReport: { status: 'blocked', reason: 'The agent stopped reporting progress.', at: now } }, next: false }
  }
  if (end.queued) return { goal: counted, next: false }
  if (counted.turns >= counted.turnLimit) return { goal: stoppedGoal(counted, 'turn_limit', now), next: false }
  return { goal: { ...counted, turns: counted.turns + 1, updatedAt: now }, next: true }
}

/** The note every turn of a thread with a working goal starts with. The model reads it; the person never sees it. */
export function goalNote(goal: Pick<ThreadGoal, 'text' | 'turns' | 'turnLimit'>): string {
  return [
    '<mousse_goal>',
    `This thread has a goal. Done looks like: ${goal.text}`,
    `Keep working toward it. Mousse starts the next turn for you after this one (turn ${goal.turns} of at most ${goal.turnLimit}), so do as much as you can in each turn and don't ask whether to continue.`,
    `Before you end each turn, call the ${GOAL_UPDATE_TOOL} tool once: "met" only when the goal is fully done and you checked it, "blocked" when you can't go on without the person (say what you need), or "continue" with a short note of what you did and what is next.`,
    '</mousse_goal>'
  ].join('\n')
}

// ── Display ───────────────────────────────────────────────────────────────────────────────────────

const STOP_REASONS: Record<GoalStopCause, string> = {
  user: 'Stopped.',
  turn_limit: 'Reached its turn limit.',
  usage_limit: 'Stopped at a usage limit.',
  error: 'Stopped: a turn failed.',
  waiting: 'Stopped: an approval or question is waiting for you.',
  interrupted: 'Stopped: the turn was interrupted.',
  restart: 'Stopped: Mousse restarted.'
}

/** The state word the marker shows. */
export function goalStateLabel(goal: Pick<ThreadGoal, 'state' | 'turns' | 'turnLimit'>): string {
  switch (goal.state) {
    case 'working': return `Working · turn ${goal.turns}/${goal.turnLimit}`
    case 'met': return 'Met'
    case 'stuck': return 'Stuck'
    case 'stopped': return 'Stopped'
  }
}

/** Why the goal is where it is, in a sentence: the agent's own words when it gave some. */
export function goalReason(goal: ThreadGoal): string | undefined {
  if (goal.state === 'stopped') {
    const cause = STOP_REASONS[goal.stoppedBy ?? 'user']
    return goal.stoppedBy === 'turn_limit' ? `Stopped: reached the ${goal.turnLimit}-turn limit.` : cause
  }
  return goal.lastReport?.reason || undefined
}

/** The full wording: the goal, its state and the latest word on it. */
export function goalDetails(goal: ThreadGoal): string {
  const reason = goalReason(goal)
  // A stopped goal's reason says it stopped ("Stopped: Mousse restarted."), so it stands in for the state.
  const state = goal.state === 'stopped' ? '' : `${goalStateLabel(goal)}.`
  return [`Goal: ${goal.text}`, state, reason ? `${goal.state === 'working' ? 'Latest: ' : ''}${reason}` : ''].filter(Boolean).join('\n')
}
