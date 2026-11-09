import { isLocalOnlyThread } from '../../shared/threadLineage'
import type { ScheduledJob, Thread } from '../../shared/types'

/**
 * Which automations another of the user's computers may see and change here (over Bridge). A bot's schedule is its
 * bot's, and bots are a Net feature of their own; a private thread (`Thread.localOnly`) or a bot's thread answers as
 * if it did not exist, so an automation bound to one, or added by one, does too.
 */

/** Whether a thread exists here and is one other computers never see. */
export function privateThreadOf(threads: { getThread(id: string): Thread | undefined; listAllThreads(): Thread[] }): (threadId: string) => boolean {
  let all: Thread[] | undefined
  return (threadId) => {
    const thread = threads.getThread(threadId)
    if (!thread) return false
    if (thread.botOwned) return true
    all ??= threads.listAllThreads()
    return isLocalOnlyThread(thread, all)
  }
}

/** Whether another computer may see and change this automation. */
export function jobSharedWithComputers(job: ScheduledJob, isPrivate: (threadId: string) => boolean): boolean {
  if (job.bot) return false
  // A draft is this computer's manager's work in progress; it moves once it is an automation.
  if (job.draft) return false
  if (job.threadId && isPrivate(job.threadId)) return false
  // An automation that wakes on a private thread's pull request names that thread and its pull request.
  if (job.trigger?.threadEvent && isPrivate(job.trigger.threadEvent.threadId)) return false
  if (job.createdBy && isPrivate(job.createdBy.threadId)) return false
  return true
}
