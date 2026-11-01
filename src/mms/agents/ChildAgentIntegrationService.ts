import { ThreadJournal } from '../data/ThreadJournal'

/** An integration an older version started and did not finish; it is recorded as cancelled, never run again. */
export interface CancelledIntegration {
  operationId: string
  agentId?: string
  /** The subagent's result it would have merged; still pinned, so the parent agent can bring it in with Git. */
  resultSha?: string
  spawnBaseSha?: string
}

const UNFINISHED = new Set(['running', 'prepared', 'git_applied', 'recovery_required'])

/**
 * Mousse no longer merges a subagent's result into its parent; the parent agent brings it in with Git. A merge an
 * older version left unfinished (`child-integration` or `change-integration` still running, prepared, applied or
 * waiting for recovery) is therefore not replayed after an upgrade: each is recorded as cancelled, and returned so
 * the caller can tell the thread. The files are left as they are.
 */
export function cancelPendingIntegrations(threadDirectory: string): CancelledIntegration[] {
  const journal = new ThreadJournal(threadDirectory)
  const cancelled: CancelledIntegration[] = []
  for (const entry of journal.latestByOperation().values()) {
    if (!['child-integration', 'change-integration'].includes(entry.operationType) || !UNFINISHED.has(entry.state)) continue
    const intent = journal.list().find((item) => item.operationId === entry.operationId && item.state === 'prepared')
    const request = (intent?.details as { request?: { agentId?: string; pinnedWorkerSha?: string; expectedWorkerHead?: string; spawnBaseSha?: string } } | undefined)?.request
    const resultSha = request?.pinnedWorkerSha ?? request?.expectedWorkerHead
    journal.append({
      operationId: entry.operationId,
      operationType: entry.operationType,
      state: 'cancelled',
      details: { reason: 'Mousse no longer merges subagent results; the parent agent brings them in with Git.', previousState: entry.state, ...(resultSha ? { resultSha } : {}) }
    })
    cancelled.push({ operationId: entry.operationId, ...(request?.agentId ? { agentId: request.agentId } : {}), ...(resultSha ? { resultSha } : {}), ...(request?.spawnBaseSha ? { spawnBaseSha: request.spawnBaseSha } : {}) })
  }
  return cancelled
}

/** The line a thread shows for integrations an older version left unfinished. */
export function cancelledIntegrationsNotice(cancelled: CancelledIntegration[]): string | undefined {
  if (!cancelled.length) return undefined
  const items = cancelled.map((item) => `${item.agentId ? `subagent ${item.agentId}` : item.operationId}${item.resultSha ? ` (result ${item.resultSha}${item.spawnBaseSha ? `, base ${item.spawnBaseSha}` : ''})` : ''}`)
  return `An unfinished merge of ${items.join('; ')} from an earlier version was cancelled and not run again: Mousse no longer merges subagent results. Your files were left as they are; bring a result in with Git if you still want it.`
}
