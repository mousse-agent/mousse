import { Plus, Upload } from '../../lib/icons'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RefreshToolsButton } from '../automations/LibraryParts'
import { Select } from '../ui/Select'
import { SearchInput } from '../ui/SearchInput'
import { isWorkflowClientError, type WorkflowDefinitionsClient, type WorkflowLibraryItem } from './client'
import { TemplatePickerDialog } from './dialogs'
import { parseWorkflowImportFile } from './importBundle'
import {
  EMPTY_WORKFLOW_LIBRARY_QUERY,
  filterWorkflowLibrary,
  isWorkflowLibraryFiltered,
  uniqueWorkflowStatuses,
  uniqueWorkflowTags,
  type WorkflowLibraryQuery,
  type WorkflowLibraryStatus
} from './libraryFilter'

const STATUS_LABELS: Record<Exclude<WorkflowLibraryStatus, 'all'>, string> = {
  draft: 'Draft',
  published: 'Published',
  'unpublished-changes': 'Unpublished changes',
  unsupported: 'Unsupported nodes'
}
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
  /** Connects the configured MCP servers and reads their tools again, for the editor's catalogs. */
  onRefreshTools?: () => void
  refreshingTools?: boolean
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
  activeRunsSlot,
  onRefreshTools,
  refreshingTools = false
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
  // Filters offer only what the library holds, and one stays while it is set so it can be cleared.
  const library = useMemo(() => items.filter((item) => !item.archived), [items])
  const tags = uniqueWorkflowTags(library)
  const statuses = uniqueWorkflowStatuses(library)
  const empty = !loading && !unavailable && !error && library.length === 0
  const filtered = isWorkflowLibraryFiltered(query)

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
        <h2>Workflows</h2>
        <div className="wf-actions">
          {activeRunsSlot}
          {onRefreshTools ? <RefreshToolsButton refreshing={refreshingTools} onRefresh={onRefreshTools} /> : null}
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} aria-label="Import workflow">
            <Upload size={14} /> Import
          </button>
          <button
            type="button"
            className="btn"
            data-action="new-workflow"
            disabled={creating}
            onClick={() => setTemplateOpen(true)}
          >
            <Plus size={14} /> New workflow
          </button>
        </div>
      </header>
      {empty ? null : (
        <div className="wf-toolbar">
          <SearchInput value={query.search} onChange={(search) => setQuery({ ...query, search })} placeholder="Search workflows" />
          {tags.length > 0 || query.tag ? (
            <Select
              className="automation-filter"
              size="small"
              ariaLabel="Filter by tag"
              value={query.tag}
              onChange={(tag) => setQuery({ ...query, tag })}
              options={[
                { value: '', label: 'All tags' },
                ...tags.map((tag) => ({ value: tag, label: tag })),
                ...(query.tag && !tags.includes(query.tag) ? [{ value: query.tag, label: query.tag }] : [])
              ]}
            />
          ) : null}
          {statuses.length > 1 || query.status !== 'all' ? (
            <Select<WorkflowLibraryStatus>
              className="automation-filter"
              size="small"
              ariaLabel="Filter by status"
              value={query.status}
              onChange={(status) => setQuery({ ...query, status })}
              options={[
                { value: 'all', label: 'All statuses' },
                ...statuses.map((status) => ({ value: status, label: STATUS_LABELS[status] })),
                ...(query.status !== 'all' && !statuses.includes(query.status) ? [{ value: query.status, label: STATUS_LABELS[query.status] }] : [])
              ]}
            />
          ) : null}
          {library.length > 1 ? (
            <Select<WorkflowLibraryQuery['sort']>
              className="automation-filter"
              size="small"
              ariaLabel="Sort workflows"
              value={query.sort}
              onChange={(sort) => setQuery({ ...query, sort })}
              options={[
                { value: 'updated', label: 'Recently edited' },
                { value: 'name', label: 'Name' },
                { value: 'lastRun', label: 'Last run' }
              ]}
            />
          ) : null}
        </div>
      )}
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
      ) : empty ? (
        // New workflow and Import sit in the header; the empty library adds no second create button.
        <p className="automation-empty-line" data-library-empty="">No workflows yet.</p>
      ) : visible.length === 0 ? (
        <p className="automation-empty-line" data-library-no-match="">
          No workflows match.
          {filtered ? (
            <button
              type="button"
              className="btn btn-sm"
              data-action="clear-filters"
              onClick={() => setQuery({ ...EMPTY_WORKFLOW_LIBRARY_QUERY, sort: query.sort })}
            >
              Clear filters
            </button>
          ) : null}
        </p>
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
