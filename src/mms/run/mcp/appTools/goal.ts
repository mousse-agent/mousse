import { GOAL_UPDATE_TOOL } from '../../../../shared/threadGoal'
import type { AppToolHost } from './host'
import type { MousseTool } from './types'

/**
 * `goal_update`: the agent of a thread with a goal (`/goal`, issue #1207) says where the goal stands, once per turn.
 * Listed on every ordinary thread so a runtime that keeps its tool list from the thread's first turn has it when a goal
 * is set later; callable only while the thread's goal is working. Subagents and bots never get it.
 */
export function goalTools(host: AppToolHost): MousseTool[] {
  if (!host.goals) return []
  const goals = host.goals
  return [{
    name: GOAL_UPDATE_TOOL,
    description:
      'Only for a thread whose person set a goal with /goal: say where the goal stands, once before you end each turn. ' +
      '"met" when the goal is fully done and you checked it (Mousse then stops), "blocked" when you cannot go on without the person ' +
      '(say what you need; Mousse stops and shows it), "continue" when more work is needed (Mousse starts the next turn). ' +
      'reason: one short sentence of what you did and what is next, or what blocks you.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['met', 'continue', 'blocked'] },
        reason: { type: 'string', description: 'One short sentence.' }
      },
      required: ['status', 'reason']
    },
    access: 'actsAsCaller',
    class: 'read',
    available: (turn) => {
      // A goal is a thread's own (`/goal`): whichever agent runs the thread reports on it, a bot's never.
      if (turn.bot) return 'Only the thread\'s own agent reports on its goal.'
      return goals.working(turn.threadId) ? true : `This thread has no goal that is being worked on; ${GOAL_UPDATE_TOOL} is only for a thread whose person set one with /goal.`
    },
    offered: (turn) => !turn.bot && goals.working(turn.threadId),
    listed: (listing) => listing.botRole === undefined && !listing.readOnly,
    describe: (args) => `Goal status: ${typeof args.status === 'string' ? args.status : 'report'}`,
    handler: (args, ctx) => {
      try {
        return { text: goals.report(ctx.caller.threadId, ctx.caller.runId, args.status, args.reason) }
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true }
      }
    }
  }]
}
