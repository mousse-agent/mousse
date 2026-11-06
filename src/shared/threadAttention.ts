import type { ThreadActivityState } from './types'

/**
 * How much a thread needs the person, worst first: it waits for an answer or an approval, it is
 * working (or waiting on background work), it is paused at a usage limit, it finished and nobody
 * looked yet, or there is nothing to see. Rows, project rows, the "Needs me" group, the window badge
 * and notifications all read this one ladder.
 */
export const ATTENTION_LADDER = ['needs-me', 'working', 'paused', 'done', 'quiet'] as const
export type ThreadAttention = (typeof ATTENTION_LADDER)[number]

/** What a thread row says about itself: the attention level, told apart where the row shows a different icon. */
export type ThreadStatus = 'approval' | 'question' | 'working' | 'waiting' | 'paused' | 'done' | 'quiet'

const ATTENTION_OF: Record<ThreadStatus, ThreadAttention> = {
  approval: 'needs-me',
  question: 'needs-me',
  working: 'working',
  waiting: 'working',
  paused: 'paused',
  done: 'done',
  quiet: 'quiet'
}

/**
 * The status of a thread from its activity (rolled up over its subagents, when it has any).
 * `awaitsApproval` is whether the input it waits for is a permission request rather than a question.
 */
export function threadStatus(activity: ThreadActivityState | undefined, awaitsApproval = false): ThreadStatus {
  switch (activity) {
    case 'awaiting_input':
      return awaitsApproval ? 'approval' : 'question'
    case 'processing':
      return 'working'
    case 'waiting':
      return 'waiting'
    case 'paused':
      return 'paused'
    case 'completed':
      return 'done'
    default:
      return 'quiet'
  }
}

/** The attention level of a thread with this activity. */
export function threadAttention(activity: ThreadActivityState | undefined): ThreadAttention {
  return ATTENTION_OF[threadStatus(activity)]
}

/** The attention level a status belongs to. */
export function attentionOfStatus(status: ThreadStatus): ThreadAttention {
  return ATTENTION_OF[status]
}

/** The level that needs the person most among `levels`; quiet when there are none. */
export function worstOf(levels: Iterable<ThreadAttention>): ThreadAttention {
  let worst = ATTENTION_LADDER.length - 1
  for (const level of levels) {
    const rank = ATTENTION_LADDER.indexOf(level)
    if (rank >= 0 && rank < worst) worst = rank
    if (worst === 0) break
  }
  return ATTENTION_LADDER[worst]
}

/** "1 thread needs you", "3 threads need you": the one phrase every surface uses for the count. */
export function needsMeLabel(count: number): string {
  return count === 1 ? '1 thread needs you' : `${count} threads need you`
}
