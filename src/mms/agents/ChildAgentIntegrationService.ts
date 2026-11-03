import { ThreadJournal } from '../data/ThreadJournal'
import { mergeIdentityAsync } from '../actions/leftMerge'
import { tryGitAsync } from '../actions/git'

/** An integration an older version started and did not finish; it is recorded as cancelled, never run again. */
export interface CancelledIntegration {
  operationId: string
  agentId?: string
  /** The subagent's result it would have merged; still pinned, so the parent agent can bring it in with Git. */
  resultSha?: string
  spawnBaseSha?: string
  /** The folder where a merge it started is still in progress (older versions merged there); it can still be aborted. */
  mergeInProgress?: string
}

const UNFINISHED = new Set(['running', 'prepared', 'git_applied', 'recovery_required'])

/**
 * Mousse no longer merges a subagent's result into its parent; the parent agent brings it in with Git. A merge an
 * older version left unfinished (`child-integration` or `change-integration` still running, prepared, applied or
 * waiting for recovery) is therefore not replayed after an upgrade: each is recorded as cancelled, and returned so
 * the caller can tell the thread. The files are left as they are. Git runs without blocking the daemon. A turn's or a
 * workflow's start calls it holding the thread's lease. `operations.recover` holds none: it passes `beforeRecord`, which
 * runs synchronously right before each record is written (after the Git reads) and refuses by throwing when a turn has
 * started meanwhile.
 */
export async function cancelPendingIntegrations(threadDirectory: string, workspacePath?: string, beforeRecord?: () => void): Promise<CancelledIntegration[]> {
  const journal = new ThreadJournal(threadDirectory)
  const cancelled: CancelledIntegration[] = []
  for (const entry of journal.latestByOperation().values()) {
    if (!['child-integration', 'change-integration'].includes(entry.operationType) || !UNFINISHED.has(entry.state)) continue
    const intent = journal.list().find((item) => item.operationId === entry.operationId && item.state === 'prepared')
    const request = (intent?.details as { request?: { agentId?: string; pinnedWorkerSha?: string; expectedWorkerHead?: string; spawnBaseSha?: string } } | undefined)?.request
    const resultSha = request?.pinnedWorkerSha ?? request?.expectedWorkerHead
    // An older version merged with `git merge`; one it left stopped is still in the folder and stays abortable.
    const left = [...journal.list()].reverse().find((item) => item.operationId === entry.operationId && (item.details as { preMergeSha?: unknown } | undefined)?.preMergeSha)?.details as { preMergeSha?: string; workerHeadSha?: string } | undefined
    const mergeInProgress = workspacePath && (await tryGitAsync(workspacePath, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'])).ok ? workspacePath : undefined
    const identity = mergeInProgress ? await mergeIdentityAsync(mergeInProgress) : undefined
    beforeRecord?.()
    journal.append({
      operationId: entry.operationId,
      operationType: entry.operationType,
      state: 'cancelled',
      details: {
        reason: mergeInProgress ? `A merge from an earlier version is still in progress in ${mergeInProgress}; abort it or finish it with Git.` : 'Mousse no longer merges subagent results; the parent agent brings them in with Git.',
        previousState: entry.state, ...(resultSha ? { resultSha } : {}),
        // Which merge it is, so Abort never takes one the person or the agent started later for this one (`isRecordedMerge`).
        ...(mergeInProgress ? { mergeInProgress, mergeIdentity: identity, ...(left?.preMergeSha ? { preMergeSha: left.preMergeSha } : {}), workerHeadSha: left?.workerHeadSha ?? resultSha } : {})
      }
    })
    cancelled.push({ operationId: entry.operationId, ...(request?.agentId ? { agentId: request.agentId } : {}), ...(resultSha ? { resultSha } : {}), ...(request?.spawnBaseSha ? { spawnBaseSha: request.spawnBaseSha } : {}), ...(mergeInProgress ? { mergeInProgress } : {}) })
  }
  return cancelled
}

/** The line a thread shows for integrations an older version left unfinished. */
export function cancelledIntegrationsNotice(cancelled: CancelledIntegration[]): string | undefined {
  if (!cancelled.length) return undefined
  const items = cancelled.map((item) => `${item.agentId ? `subagent ${item.agentId}` : item.operationId}${item.resultSha ? ` (result ${item.resultSha}${item.spawnBaseSha ? `, base ${item.spawnBaseSha}` : ''})` : ''}`)
  const merging = [...new Set(cancelled.flatMap((item) => item.mergeInProgress ? [item.mergeInProgress] : []))]
  const files = merging.length
    ? `A merge from an earlier version is still in progress in ${merging.join(', ')}; abort it (operations abort) or finish it with Git.`
    : 'Your files were left as they are; bring a result in with Git if you still want it.'
  return `An unfinished merge of ${items.join('; ')} from an earlier version was cancelled and not run again: Mousse no longer merges subagent results. ${files}`
}
