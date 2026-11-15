import { describe, expect, it } from 'vitest'
import { applyGoalReport, decideAfterGoalTurn, newGoal, type GoalTurnEnd, type ThreadGoal } from '../src/shared/threadGoal'

/**
 * What happens after a turn of a thread whose goal is working (issue #1207). Inputs: how the turn ended, whether Mousse
 * started it for the goal, whether the agent reported, whether the person is being asked something, whether anything
 * else is queued, and how many turns and silent turns the goal has used.
 */
const NOW = '2026-11-15T10:00:00.000Z'
const working = (patch: Partial<ThreadGoal> = {}): ThreadGoal => ({ ...newGoal('Ship it', 5, NOW, 'goal-1'), ...patch })
const end = (patch: Partial<GoalTurnEnd> = {}): GoalTurnEnd => ({ outcome: 'completed', goalTurn: true, reported: true, waitingForPerson: false, queued: false, ...patch })

describe('after a goal turn', () => {
  it.each([
    { row: 'reported, nothing queued: next turn', goal: working(), end: end(), next: true, state: 'working', turns: 2 },
    { row: 'usage-limit pause: stopped', goal: working(), end: end({ outcome: 'paused' }), next: false, state: 'stopped', stoppedBy: 'usage_limit' },
    { row: 'failed: stopped', goal: working(), end: end({ outcome: 'failed' }), next: false, state: 'stopped', stoppedBy: 'error' },
    { row: 'interrupted: stopped', goal: working(), end: end({ outcome: 'interrupted' }), next: false, state: 'stopped', stoppedBy: 'interrupted' },
    { row: 'question waiting: stopped', goal: working(), end: end({ waitingForPerson: true }), next: false, state: 'stopped', stoppedBy: 'waiting' },
    { row: 'something queued: it runs first, nothing counted', goal: working(), end: end({ queued: true }), next: false, state: 'working', turns: 1 },
    { row: 'at the limit: stopped', goal: working({ turns: 5 }), end: end(), next: false, state: 'stopped', stoppedBy: 'turn_limit' },
    { row: 'first silent goal turn: next turn', goal: working(), end: end({ reported: false }), next: true, state: 'working', silentTurns: 1 },
    { row: 'second silent goal turn: stuck', goal: working({ silentTurns: 1 }), end: end({ reported: false }), next: false, state: 'stuck' },
    { row: 'a person\'s turn without a report counts no silence', goal: working({ silentTurns: 1 }), end: end({ goalTurn: false, reported: false }), next: true, state: 'working', silentTurns: 1 },
    { row: 'a goal that is not working is left alone', goal: working({ state: 'met' }), end: end(), next: false, state: 'met' }
  ])('$row', ({ row: _row, goal, end: turnEnd, next, ...expected }) => {
    const decision = decideAfterGoalTurn(goal, turnEnd, NOW)
    expect(decision.next).toBe(next)
    expect(decision.goal).toMatchObject(expected)
  })

  it.each([
    { status: 'met' as const, state: 'met' },
    { status: 'blocked' as const, state: 'stuck' },
    { status: 'continue' as const, state: 'working' }
  ])('a $status report makes the goal $state, and a goal that is not working takes no report', ({ status, state }) => {
    expect(applyGoalReport(working({ silentTurns: 1 }), status, 'why', NOW)).toMatchObject({ state, silentTurns: 0, lastReport: { status, reason: 'why' } })
    const met = working({ state: 'met' })
    expect(applyGoalReport(met, status, 'late', NOW)).toBe(met)
  })
})
