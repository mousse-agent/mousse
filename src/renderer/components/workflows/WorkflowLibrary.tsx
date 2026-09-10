import { Plus, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { SearchInput } from '../ui/SearchInput'
import { isWorkflowClientError, type WorkflowDefinitionsClient, type WorkflowLibraryItem } from './client'
import { TemplatePickerDialog } from './dialogs'
import { parseWorkflowImportFile } from './importBundle'
import {
  EMPTY_WORKFLOW_LIBRARY_QUERY,
  filterWorkflowLibrary,
  uniqueWorkflowTags,
  type WorkflowLibraryQuery
} from './libraryFilter'
import { WORKFLOW_TEMPLATES } from './templates'
import { WorkflowCard } from './WorkflowCard'

export interface WorkflowLibraryProps {
  profileId: string
  client: WorkflowDefinitionsClient
  query?: WorkflowLibraryQuery
  onQueryChange?: (query: WorkflowLibraryQuery) => void
  onOpen: (id: string) => void
  onCreated?: (id: string) => void
  onRun?: (id: string) => void
  runDisabledReason?: string
  activeRunsSlot?: ReactNode
}

export function WorkflowLibrary({
  profileId,
  client,
  query: controlledQuery,
  onQueryChange,
  onOpen,
  onCreated,
  onRun,
  runDisabledReason,
  activeRunsSlot
}: WorkflowLibraryProps) {
  const [uncontrolledQuery, setUncontrolledQuery] = useState<WorkflowLibraryQuery>(EMPTY_WORKFLOW_LIBRARY_QUERY)
  const query = controlledQuery ?? uncontrolledQuery
  const setQuery = (next: WorkflowLibraryQuery) => {
    if (!controlledQuery) setUncontrolledQuery(next)
    onQueryChange?.(next)
  }

  const [items, setItems] = useState<WorkflowLibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const profileRef = useRef(profileId)
  const clientRef = useRef(client)
  profileRef.current = profileId
  clientRef.current = client

  const isCurrentBoundary = (startedProfileId: string, startedClient: WorkflowDefinitionsClient) =>
    profileRef.current === startedProfileId && clientRef.current === startedClient

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setImportError(null)
    setUnavailable(false)
    setCreating(false)
    void client
      .list({ profileId })
      .then((result) => {
        if (!cancelled) setItems(result)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setError(isWorkflowClientError(caught) ? caught.message : String(caught))
        setUnavailable(isWorkflowClientError(caught) && caught.code === 'PROFILE_NOT_READY')
        setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, profileId])

  const visible = useMemo(() => filterWorkflowLibrary(items, query), [items, query])
  const tags = uniqueWorkflowTags(items)

  const createWorkflow = async (templateId?: string) => {
    const startedProfileId = profileId
    const startedClient = client
    setCreating(true)
    setError(null)
    try {
      const created = await client.create({
        profileId,
        templateId: templateId ?? 'blank',
        name: templateId && templateId !== 'blank' ? undefined : 'New workflow'
      })
      if (!isCurrentBoundary(startedProfileId, startedClient)) return
      onCreated?.(created.id)
      onOpen(created.id)
    } catch (caught) {
      if (isCurrentBoundary(startedProfileId, startedClient)) {
        setError(isWorkflowClientError(caught) ? caught.message : String(caught))
      }
    } finally {
      if (isCurrentBoundary(startedProfileId, startedClient)) setCreating(false)
    }
  }

  const onImportFile = async (file: File) => {
    const startedProfileId = profileId
    const startedClient = client
    setImportError(null)
    try {
      const text = await file.text()
      const bundle = parseWorkflowImportFile({ name: file.name, size: file.size, text })
      const imported = await client.importBundle({ profileId, bundle, conflict: 'rename' })
      if (!isCurrentBoundary(startedProfileId, startedClient)) return
      onCreated?.(imported.id)
      onOpen(imported.id)
    } catch (caught) {
      if (isCurrentBoundary(startedProfileId, startedClient)) {
        setImportError(isWorkflowClientError(caught) ? caught.message : String(caught))
      }
    }
  }

  return (
    <div className="wf-root" data-workflow-library="" data-profile-id={profileId}>
      <header className="wf-header">
        <h1>Workflows</h1>
        <div className="wf-actions">
          {activeRunsSlot}
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} aria-label="Import workflow">
            <Upload size={14} /> Import
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-action="new-workflow"
            disabled={creating}
            onClick={() => setTemplateOpen(true)}
          >
            <Plus size={14} /> New workflow
          </button>
        </div>
      </header>
      <div className="wf-toolbar">
        <SearchInput value={query.search} onChange={(search) => setQuery({ ...query, search })} placeholder="Search workflows" />
        <select aria-label="Filter by tag" value={query.tag} onChange={(event) => setQuery({ ...query, tag: event.target.value })}>
          <option value="">All tags</option>
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={query.status}
          onChange={(event) => setQuery({ ...query, status: event.target.value as WorkflowLibraryQuery['status'] })}
        >
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="unpublished-changes">Unpublished changes</option>
          <option value="unsupported">Unsupported nodes</option>
        </select>
        <select
          aria-label="Sort workflows"
          value={query.sort}
          onChange={(event) => setQuery({ ...query, sort: event.target.value as WorkflowLibraryQuery['sort'] })}
        >
          <option value="updated">Recently edited</option>
          <option value="name">Name</option>
          <option value="lastRun">Last run</option>
        </select>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json,.mousse-workflow.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void onImportFile(file)
        }}
      />
      {importError ? (
        <div className="wf-banner wf-banner--error" role="alert">
          {importError}
        </div>
      ) : null}
      {loading ? (
        <div className="wf-loading" role="status">
          Loading workflows…
        </div>
      ) : unavailable ? (
        <div className="wf-error" role="alert">
          Workflow library is unavailable for this profile.
        </div>
      ) : error ? (
        <div className="wf-error" role="alert">
          {error}
        </div>
      ) : visible.length === 0 ? (
        <div className="wf-empty">
          <EmptyState
            title={items.length === 0 ? 'No workflows yet' : 'No workflows match these filters'}
            description={
              items.length === 0
                ? 'Create a workflow from a template, or import a mousse-workflow bundle.'
                : 'Try clearing search or filters.'
            }
            action={
              <button type="button" className="btn btn-primary" data-action="new-workflow-empty" onClick={() => setTemplateOpen(true)}>
                New workflow
              </button>
            }
          />
        </div>
      ) : (
        <div className="wf-library-grid">
          {visible.map((item) => (
            <WorkflowCard
              key={item.id}
              item={item}
              onOpen={onOpen}
              onRun={onRun}
              runDisabledReason={runDisabledReason}
            />
          ))}
        </div>
      )}
      <TemplatePickerDialog
        open={templateOpen}
        templates={WORKFLOW_TEMPLATES}
        onClose={() => setTemplateOpen(false)}
        onSelect={(id) => {
          setTemplateOpen(false)
          void createWorkflow(id)
        }}
      />
    </div>
  )
}
