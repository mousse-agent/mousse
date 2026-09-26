import { useCallback, useEffect, useState } from 'react'
import type { ChangeReceipt, ThreadAction } from '../../shared/threadActions'
import type { WorkspaceExecutionContext } from '../../shared/workspace'

interface ChangeStatus {
  activeBranchId?: string
  actions: ThreadAction[]
  receipts: ChangeReceipt[]
  journalGeneration: number
  execution?: WorkspaceExecutionContext
}

/** Workspace history remains reachable after Undo hides the affected message. */
export function ThreadChangeControls({ threadId, busy, revision }: { threadId: string; busy: boolean; revision: unknown }) {
  const [status, setStatus] = useState<ChangeStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    const [history, workspace] = await Promise.all([
      window.mousse.actions.list(threadId) as Promise<ChangeStatus>,
      window.mousse.workspace.getStatus(threadId) as Promise<{ execution?: WorkspaceExecutionContext; journalGeneration: number }>
    ])
    return { ...history, execution: workspace.execution }
  }, [threadId])

  useEffect(() => {
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
      title={published ? 'Published changes require a new code revert' : `Revision ${latest.endSha.slice(0, 12)}`}>
      {working ? 'Updating workspace…' : redo ? 'Redo last undo' : latest.nativeContextStartBoundary ? 'Undo latest turn' : 'Undo latest code change'}
    </button>
    <span> {latest.changedPaths.length} changed {latest.changedPaths.length === 1 ? 'file' : 'files'}</span>
    {latest.externalEffects.length > 0 && <span> · External effects are retained</span>}
    {error && <div role="alert">{error}</div>}
  </div>
}
