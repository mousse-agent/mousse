import { useEffect, useState } from 'react'
import type { WorkflowDefinitionsClient, WorkflowRevisionSummary } from './client'
import { isWorkflowClientError } from './client'

export function WorkflowHistoryPanel({
  profileId,
  definitionId,
  client,
  currentSemanticHash,
  onViewRevision,
  onRestore
}: {
  profileId: string
  definitionId: string
  client: WorkflowDefinitionsClient
  currentSemanticHash?: string
  onViewRevision?: (revisionId: string) => void | Promise<void>
  onRestore: (revisionId: string) => void
}) {
  const [revisions, setRevisions] = useState<WorkflowRevisionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!client.listRevisions) {
      setRevisions([])
      return
    }
    let cancelled = false
    void client
      .listRevisions({ profileId, id: definitionId })
      .then((result) => {
        if (!cancelled) setRevisions(result)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(isWorkflowClientError(caught) ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [client, definitionId, profileId])

  if (!client.listRevisions) {
    return <p data-history-unavailable="">Version history is not provided by the host definitions port.</p>
  }
  if (error) return <p className="wf-field-error">{error}</p>
  if (!revisions) return <p>Loading history…</p>
  if (revisions.length === 0) return <p>No published revisions yet.</p>

  return (
    <ul data-history="">
      {revisions.map((revision) => (
        <li key={revision.revisionId}>
          <code>{revision.semanticHash.slice(0, 12)}</code> {revision.name} · {revision.publishedAt}
          {revision.semanticHash === currentSemanticHash ? ' · current draft identity' : ''}
          {client.getRevision && onViewRevision ? (
            <button type="button" className="btn btn-sm" onClick={() => void onViewRevision(revision.revisionId)}>
              View published
            </button>
          ) : null}
          {client.restoreRevision ? (
            <button type="button" className="btn btn-sm" onClick={() => onRestore(revision.revisionId)}>
              Restore to draft
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
