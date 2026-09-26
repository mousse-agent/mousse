import { useCallback, useEffect, useState } from 'react'
import type { ChangeReceipt, ThreadAction } from '../../shared/threadActions'
import type { WorkspaceExecutionContext } from '../../shared/workspace'
import { readThreadActionHistory } from '../utils/threadActionHistory'
import type { UndoRetentionPolicy } from '../../shared/undoRetention'
import { useAppStore } from '../stores/appStore'

interface ChangeStatus {
  activeBranchId?: string
  actions: ThreadAction[]
  receipts: ChangeReceipt[]
  journalGeneration: number
  execution?: WorkspaceExecutionContext
  retentionPolicy?: UndoRetentionPolicy
}

/** Workspace history remains reachable after Undo hides the affected message. */
export function ThreadChangeControls({ threadId, busy, revision }: { threadId: string; busy: boolean; revision: unknown }) {
  const profileId = useAppStore((state) => state.profileId)
  const [status, setStatus] = useState<ChangeStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    const [history, workspace] = await Promise.all([
      readThreadActionHistory(threadId, true),
      window.mousse.workspace.getStatus(threadId) as Promise<{ execution?: WorkspaceExecutionContext; journalGeneration: number }>
    ])
    return { ...history, execution: workspace.execution }
  }, [profileId, threadId])

  useEffect(() => {
    setStatus(null)
    if (busy) return
    let current = true
    const read = () => { void refresh().then((next) => { if (current) setStatus(next) }).catch(() => { if (current) setStatus(null) }) }
    read()
    const timer = window.setInterval(read, 3_000)
    return () => { current = false; window.clearInterval(timer) }
  }, [refresh, busy, revision])

  const latest = status?.actions.filter((action) => action.conversationBranchId === (status.activeBranchId ?? 'main')).at(-1)
  const receipt = status?.receipts.find((item) => item.id === latest?.receiptId)
  const published = receipt && status?.receipts.some((item) => item.kind === 'publish' && item.publishedReceiptIds?.includes(receipt.id))
  const eligible = Boolean(latest && latest.reversible && ['completed', 'failed', 'stopped'].includes(latest.state)
    && (!latest.retention || ['available', 'pinned'].includes(latest.retention.state))
    && status?.execution?.lifecycle === 'ready' && status.execution.headSha === latest.endSha && !published)
  const redo = receipt?.kind === 'undo'

  const apply = async () => {
    if (!latest || !eligible || busy || working) return
    setWorking(true); setError(null)
    try {
      const current = await refresh()
      if (current.actions.filter((action) => action.conversationBranchId === (current.activeBranchId ?? 'main')).at(-1)?.id !== latest.id) throw new Error('Workspace history changed. Review the latest change and try again.')
      if (redo) await window.mousse.actions.redo(threadId, current.journalGeneration)
      else await window.mousse.actions.undoLatest(threadId, current.journalGeneration)
      setStatus(await refresh())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setWorking(false) }
  }

  if (!latest) return null
  return <div className="thread-change-controls" aria-label="Workspace changes">
    <button type="button" disabled={!eligible || busy || working} onClick={() => void apply()}
      title={latest.retention?.reason ?? (published ? 'Published changes require a new code revert' : `Revision ${latest.endSha.slice(0, 12)}`)}>
      {working ? 'Updating workspace…' : redo ? 'Redo last undo' : latest.nativeContextStartBoundary ? 'Undo latest turn' : 'Undo latest code change'}
    </button>
    <span> {latest.changedPaths.length} changed {latest.changedPaths.length === 1 ? 'file' : 'files'}</span>
    {latest.retention && <span title={latest.retention.reason}> · Undo {latest.retention.state}{latest.retention.deadline && latest.retention.state === 'available' ? ` until ${new Date(latest.retention.deadline).toLocaleDateString()}` : ''}</span>}
    <label> Undo retention <select aria-label="Undo retention duration" value={String((status?.retentionPolicy?.windowMs ?? 30 * 86400000) / 86400000)} disabled={busy || working} onChange={(event) => {
      const days = Number(event.target.value)
      if (!days) return
      setWorking(true)
      void window.mousse.actions.configureRetention({ threadId, policy: { windowMs: days * 86400000 } })
        .then(refresh).then(setStatus).catch((cause) => setError(String(cause))).finally(() => setWorking(false))
    }}>{status?.retentionPolicy && ![7, 30, 90].includes(status.retentionPolicy.windowMs / 86400000) && <option value={String(status.retentionPolicy.windowMs / 86400000)}>{status.retentionPolicy.windowMs / 86400000} days</option>}<option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label>
    {latest.retention?.state !== 'expired' && <button type="button" disabled={busy || working} onClick={() => {
      setWorking(true)
      void window.mousse.actions.pin({ threadId, actionId: latest.id, pinned: latest.retention?.state !== 'pinned' })
        .then(refresh).then(setStatus).catch((cause) => setError(String(cause))).finally(() => setWorking(false))
    }}>{latest.retention?.state === 'pinned' ? 'Unpin checkpoint' : 'Keep checkpoint'}</button>}
    {latest.retention?.state === 'blocked' && latest.retention.reason.startsWith('Clock') && <button type="button" disabled={busy || working} onClick={() => {
      setWorking(true)
      void window.mousse.actions.configureRetention({ threadId, acknowledgeClock: true }).then(() => window.mousse.actions.sweepRetention(threadId))
        .then(refresh).then(setStatus).catch((cause) => setError(String(cause))).finally(() => setWorking(false))
    }}>Accept current clock for retention</button>}
    {latest.externalEffects.length > 0 && <span> · External effects are retained</span>}
    {error && <div role="alert">{error}</div>}
  </div>
}
