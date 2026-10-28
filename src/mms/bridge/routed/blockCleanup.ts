import type { MmsProfileServices } from '../../MmsProfileServices'

export interface BlockCleanup {
  /** Queued messages the device sent that had not started, now removed. */
  queued: number
  /** Standing "Always for this thread" rules a person on the device made, now revoked. */
  rules: number
  /** Turns the device started that were still running, now stopped. */
  turns: number
}

/**
 * What a device that has just been blocked leaves behind on this computer, taken away: the messages
 * it queued that no turn has started, the "Always for this thread" rules it made (they would answer
 * the owner's own turns without asking), and the turns it started that are still running. Its
 * streams, terminals and held results are closed by the network layer; this is the work only the
 * owner's data can say. Each step goes on when another fails.
 */
export async function cleanUpBlockedDevice(
  services: MmsProfileServices,
  node: string
): Promise<BlockCleanup> {
  const done: BlockCleanup = { queued: 0, rules: 0, turns: 0 }
  const warn = (what: string, error: unknown): void =>
    console.warn(`blocking a device could not ${what}`, {
      node,
      error: error instanceof Error ? error.message : String(error)
    })
  let threadIds: string[] = []
  try {
    threadIds = services.threads.listAllThreads().map((thread) => thread.id)
  } catch (error) {
    warn('list the threads', error)
  }
  for (const threadId of threadIds) {
    try {
      for (const item of services.orchestrator.listQueue(threadId)) {
        // A message a turn has claimed or drained has started; only what still waits goes.
        if (item.sentFrom?.node !== node || (item.state !== 'pending' && item.state !== 'steering')) continue
        if (services.orchestrator.removeQueuedItem(threadId, item.id)) done.queued += 1
      }
    } catch (error) {
      warn('remove its queued messages', error)
    }
    try {
      const run = services.runEngine.store.getActiveRun(threadId)
      if (!run) continue
      const sentBy = services.runEngine.store.db
        .statement(
          "SELECT 1 AS found FROM thread_events WHERE thread_id = ? AND run_id = ? AND type = 'run.sent_from' AND json_extract(payload, '$.node') = ? LIMIT 1"
        )
        .get(threadId, run.runId, node)
      if (!sentBy) continue
      await services.orchestrator.stopThread(threadId, 'remote')
      done.turns += 1
    } catch (error) {
      warn('stop its turns', error)
    }
  }
  try {
    done.rules = services.orchestrator.clearApprovalRulesMadeBy(node)
  } catch (error) {
    warn('revoke its rules', error)
  }
  return done
}
