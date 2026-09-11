import { useEffect, useState, type ReactNode } from 'react'
import type { AgentDefinitionsClient } from '../agentDefinitions/client'
import {
  EMPTY_WORKFLOW_CATALOGS,
  type WorkflowDefinitionsClient,
  type WorkflowEditorCatalogs,
  type WorkflowExecutionClient,
  type WorkflowLeaveGuard
} from './client'
import { EMPTY_WORKFLOW_LIBRARY_QUERY, type WorkflowLibraryQuery } from './libraryFilter'
import { WorkflowEditor } from './WorkflowEditor'
import { WorkflowLibrary } from './WorkflowLibrary'
import { WorkflowRunPanel } from './WorkflowRunPanel'
import { Modal } from '../ui/Modal'
import './workflows.css'

export interface WorkflowsWorkspaceProps {
  profileId: string
  client: WorkflowDefinitionsClient
  catalogs?: WorkflowEditorCatalogs
  execution?: WorkflowExecutionClient
  agentDefinitions?: AgentDefinitionsClient
  activeRunsSlot?: ReactNode
  active?: boolean
  onRegisterLeaveGuard?: (guard: WorkflowLeaveGuard | null) => void
}

export function WorkflowsWorkspace({
  profileId,
  client,
  catalogs = EMPTY_WORKFLOW_CATALOGS,
  execution,
  agentDefinitions,
  activeRunsSlot,
  active = true,
  onRegisterLeaveGuard
}: WorkflowsWorkspaceProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [query, setQuery] = useState<WorkflowLibraryQuery>(EMPTY_WORKFLOW_LIBRARY_QUERY)
  const [runId, setRunId] = useState<string | null>(null)

  useEffect(() => {
    setOpenId(null)
    setQuery(EMPTY_WORKFLOW_LIBRARY_QUERY)
    setRunId(null)
  }, [client, profileId])

  if (openId) {
    return (
      <WorkflowEditor
        key={`${profileId}:${openId}`}
        profileId={profileId}
        definitionId={openId}
        client={client}
        catalogs={catalogs}
        execution={execution}
        agentDefinitions={agentDefinitions}
        active={active}
        onBack={() => setOpenId(null)}
        onOpenDefinition={setOpenId}
        onRegisterLeaveGuard={onRegisterLeaveGuard}
      />
    )
  }

  return (
    <>
      <WorkflowLibrary
        key={profileId}
        profileId={profileId}
        client={client}
        query={query}
        onQueryChange={setQuery}
        onOpen={setOpenId}
        onCreated={setOpenId}
        onRun={execution ? setRunId : undefined}
        runDisabledReason={execution ? undefined : 'Execution is not connected.'}
        activeRunsSlot={activeRunsSlot}
      />
      {runId && execution ? (
        <LibraryRunDialog
          profileId={profileId}
          definitionId={runId}
          client={client}
          execution={execution}
          onClose={() => setRunId(null)}
        />
      ) : null}
    </>
  )
}

function LibraryRunDialog({
  profileId,
  definitionId,
  client,
  execution,
  onClose
}: {
  profileId: string
  definitionId: string
  client: WorkflowDefinitionsClient
  execution: WorkflowExecutionClient
  onClose: () => void
}) {
  const [manifest, setManifest] = useState<import('../../../shared/workflows').WorkflowManifest | null>(null)
  const [hash, setHash] = useState<string>()
  const [revisionId, setRevisionId] = useState<string>()
  const [run, setRun] = useState<import('./client').WorkflowRunView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setManifest(null)
    setHash(undefined)
    setRevisionId(undefined)
    setRun(null)
    setError(null)
    void client
      .get({ profileId, id: definitionId })
      .then(async (document) => {
        if (cancelled) return
        if (!document.head) {
          setError('Publish a revision before running from the library, or open the editor and use Run draft.')
          return
        }
        if (!client.getRevision) throw new Error('Published workflow revisions are not available from this connection.')
        const revision = await client.getRevision({ profileId, id: definitionId, revisionId: document.head.revisionId })
        if (cancelled) return
        if (revision.profileId !== profileId || revision.id !== definitionId || revision.semanticHash !== document.head.semanticHash) throw new Error('Published workflow revision does not match this selection.')
        setManifest(revision.bundle.manifest)
        setHash(revision.semanticHash)
        setRevisionId(document.head.revisionId)
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [client, definitionId, profileId])

  return (
    <Modal open title="Run workflow" onClose={onClose}>
      {error ? <p className="wf-field-error">{error}</p> : null}
      {manifest ? (
        <WorkflowRunPanel
          profileId={profileId}
          definitionId={definitionId}
          manifest={manifest}
          semanticHash={hash}
          revisionId={revisionId}
          execution={execution}
          run={run}
          onRunChange={setRun}
        />
      ) : !error ? (
        <p>Loading input schema…</p>
      ) : null}
    </Modal>
  )
}
