import { Plus, Star, Upload } from '../../lib/icons'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RefreshToolsButton } from '../automations/LibraryParts'
import { Select } from '../ui/Select'
import { DelayedLoader } from '../ui/DelayedLoader'
import { SearchInput } from '../ui/SearchInput'
import { AgentCard } from './AgentCard'
import {
  AGENT_RUNTIME_LABELS,
  isAgentDefinitionClientError,
  type AgentDefinitionsClient,
  type AgentLibraryItem
} from './client'
import { parseAgentImportFile } from './importBundle'
import {
  EMPTY_LIBRARY_QUERY,
  filterAgentLibrary,
  isLibraryFiltered,
  uniqueLibraryModels,
  uniqueLibraryRuntimes,
  uniqueLibraryTags,
  type AgentLibraryQuery
} from './libraryFilter'

export interface AgentsLibraryProps {
  profileId: string
  client: AgentDefinitionsClient
  query?: AgentLibraryQuery
  onQueryChange?: (query: AgentLibraryQuery) => void
  onOpen: (id: string) => void
  onCreated?: (id: string) => void
  activeRunsSlot?: ReactNode
  selectedId?: string
  /** Connects the configured MCP servers and reads their tools again, for the editors' tool lists. */
  onRefreshTools?: () => void
  refreshingTools?: boolean
}

export function AgentsLibrary({
  profileId,
  client,
  query: controlledQuery,
  onQueryChange,
  onOpen,
  onCreated,
  activeRunsSlot,
  selectedId,
  onRefreshTools,
  refreshingTools = false
}: AgentsLibraryProps) {
  const [uncontrolledQuery, setUncontrolledQuery] = useState<AgentLibraryQuery>(EMPTY_LIBRARY_QUERY)
  const query = controlledQuery ?? uncontrolledQuery
  const setQuery = (next: AgentLibraryQuery) => {
    if (!controlledQuery) setUncontrolledQuery(next)
    onQueryChange?.(next)
  }

  const [items, setItems] = useState<AgentLibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const profileRef = useRef(profileId)
  const clientRef = useRef(client)
  profileRef.current = profileId
  clientRef.current = client

  const isCurrentBoundary = (startedProfileId: string, startedClient: AgentDefinitionsClient) =>
    profileRef.current === startedProfileId && clientRef.current === startedClient

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setImportError(null)
    setCreating(false)
    void client
      .list({ profileId })
      .then((result) => {
        if (!cancelled) setItems(result)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
        setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, profileId])

  const visible = useMemo(() => filterAgentLibrary(items, query), [items, query])
  // Filters offer only what the library holds, and one stays while it is set so it can be cleared.
  const library = useMemo(() => items.filter((item) => !item.archived), [items])
  const tags = uniqueLibraryTags(library)
  const models = uniqueLibraryModels(library)
  const runtimes = uniqueLibraryRuntimes(library)
  const empty = !loading && !error && library.length === 0
  const filtered = isLibraryFiltered(query)

  const createAgent = async () => {
    const startedProfileId = profileId
    const startedClient = client
    setCreating(true)
    setError(null)
    try {
      const created = await client.create({
        profileId,
        settings: { identity: { name: 'New agent', slug: `agent-${Date.now().toString(36)}`, purpose: '', tags: [] } }
      })
      if (!isCurrentBoundary(startedProfileId, startedClient)) return
      onCreated?.(created.id)
      onOpen(created.id)
    } catch (caught) {
      if (isCurrentBoundary(startedProfileId, startedClient)) {
        setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
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
      const bundle = parseAgentImportFile({ name: file.name, size: file.size, text })
      const imported = await client.importBundle({ profileId, bundle, conflict: 'rename' })
      if (!isCurrentBoundary(startedProfileId, startedClient)) return
      onCreated?.(imported.id)
      onOpen(imported.id)
    } catch (caught) {
      if (isCurrentBoundary(startedProfileId, startedClient)) {
        setImportError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
      }
    }
  }

  return (
    <div className="agent-defs" data-agent-library="" data-profile-id={profileId}>
      <header className="agent-defs__header">
        <h2>Agents</h2>
        {!loading && !empty && <span className="agent-defs__status">{visible.length} {visible.length === 1 ? 'agent' : 'agents'}</span>}
        <div className="agent-defs__actions">
          {activeRunsSlot}
          {onRefreshTools ? <RefreshToolsButton refreshing={refreshingTools} onRefresh={onRefreshTools} /> : null}
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} aria-label="Import agent">
            <Upload size={14} /> Import
          </button>
          <button
            type="button"
            className="btn"
            data-action="new-agent"
            disabled={creating}
            onClick={() => void createAgent()}
          >
            <Plus size={14} /> New agent
          </button>
        </div>
      </header>
      {empty ? null : (
        <div className="agent-library-toolbar">
          <SearchInput value={query.search} onChange={(search) => setQuery({ ...query, search })} placeholder="Search agents" />
          {tags.length > 0 || query.tag ? (
            <Select
              className="automation-filter"
              size="small"
              ariaLabel="Filter by tag"
              value={query.tag}
              onChange={(tag) => setQuery({ ...query, tag })}
              options={[{ value: '', label: 'All tags' }, ...withCurrent(tags, query.tag).map((tag) => ({ value: tag, label: tag }))]}
            />
          ) : null}
          {runtimes.length > 1 || query.runtime !== 'all' ? (
            <Select<AgentLibraryQuery['runtime']>
              className="automation-filter"
              size="small"
              ariaLabel="Filter by runtime"
              value={query.runtime}
              onChange={(runtime) => setQuery({ ...query, runtime })}
              options={[
                { value: 'all', label: 'All runtimes' },
                ...withCurrent(runtimes, query.runtime === 'all' ? '' : query.runtime).map((kind) => ({ value: kind, label: AGENT_RUNTIME_LABELS[kind] }))
              ]}
            />
          ) : null}
          {models.length > 1 || query.model ? (
            <Select
              className="automation-filter"
              size="small"
              ariaLabel="Filter by model"
              value={query.model}
              onChange={(model) => setQuery({ ...query, model })}
              options={[
                { value: '', label: 'All models' },
                ...models.map((model) => ({ value: model.id, label: model.label })),
                ...(query.model && !models.some((model) => model.id === query.model) ? [{ value: query.model, label: query.model }] : [])
              ]}
            />
          ) : null}
          {library.length > 1 ? (
            <Select<AgentLibraryQuery['sort']>
              className="automation-filter"
              size="small"
              ariaLabel="Sort agents"
              value={query.sort}
              onChange={(sort) => setQuery({ ...query, sort })}
              options={[
                { value: 'updated', label: 'Recently edited' },
                { value: 'name', label: 'Name' },
                { value: 'lastRun', label: 'Last run' }
              ]}
            />
          ) : null}
          {library.some((item) => item.favorite) || query.favoritesOnly ? (
            <button
              type="button"
              className={`btn btn-sm ${query.favoritesOnly ? 'active' : ''}`}
              aria-pressed={query.favoritesOnly}
              onClick={() => setQuery({ ...query, favoritesOnly: !query.favoritesOnly })}
            >
              <Star size={14} fill={query.favoritesOnly ? 'currentColor' : 'none'} /> Favorites
            </button>
          ) : null}
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json,.mousse-agent.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void onImportFile(file)
        }}
      />
      {importError ? (
        <div className="agent-banner agent-banner--error" role="alert">
          {importError}
        </div>
      ) : null}
      {loading ? (
        <div className="agent-defs--loading">
          <DelayedLoader label="Loading agents" />
        </div>
      ) : error ? (
        <div className="agent-defs--error" role="alert">
          {error}
        </div>
      ) : empty ? (
        // New agent and Import sit in the header; the empty library adds no second create button.
        <p className="automation-empty-line" data-library-empty="">No agents yet.</p>
      ) : visible.length === 0 ? (
        <p className="automation-empty-line" data-library-no-match="">
          No agents match.
          {filtered ? (
            <button type="button" className="btn btn-sm" data-action="clear-filters" onClick={() => setQuery({ ...EMPTY_LIBRARY_QUERY, sort: query.sort })}>
              Clear filters
            </button>
          ) : null}
        </p>
      ) : (
        <div className="agent-library-grid">
          {visible.map((item) => (
            <AgentCard key={item.id} item={item} selected={item.id === selectedId} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

/** A filter's choices plus its current value, when that value is no longer in the library. */
function withCurrent<T extends string>(choices: readonly T[], current: T | ''): T[] {
  return current && !choices.includes(current) ? [...choices, current] : [...choices]
}
