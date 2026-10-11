import { Plus, Star, Upload } from '../../lib/icons'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AGENT_RUNTIME_KINDS } from '../../../shared/agents/types'
import { EmptyState } from '../ui/EmptyState'
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
  uniqueLibraryModels,
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
}

export function AgentsLibrary({
  profileId,
  client,
  query: controlledQuery,
  onQueryChange,
  onOpen,
  onCreated,
  activeRunsSlot,
  selectedId
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
  const tags = uniqueLibraryTags(items)
  const models = uniqueLibraryModels(items)

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
        <h1>Agents</h1>
        {!loading && <span className="agent-defs__status">{visible.length} {visible.length === 1 ? 'agent' : 'agents'}</span>}
        <div className="agent-defs__actions">
          {activeRunsSlot}
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} aria-label="Import agent">
            <Upload size={14} /> Import
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-action="new-agent"
            disabled={creating}
            onClick={() => void createAgent()}
          >
            <Plus size={14} /> New agent
          </button>
        </div>
      </header>
      <div className="agent-library-toolbar">
        <SearchInput value={query.search} onChange={(search) => setQuery({ ...query, search })} placeholder="Search agents" />
        <select aria-label="Filter by tag" value={query.tag} onChange={(event) => setQuery({ ...query, tag: event.target.value })}>
          <option value="">All tags</option>
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by runtime"
          value={query.runtime}
          onChange={(event) => setQuery({ ...query, runtime: event.target.value as AgentLibraryQuery['runtime'] })}
        >
          <option value="all">All runtimes</option>
          {AGENT_RUNTIME_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {AGENT_RUNTIME_LABELS[kind]}
            </option>
          ))}
        </select>
        <select aria-label="Filter by model" value={query.model} onChange={(event) => setQuery({ ...query, model: event.target.value })}>
          <option value="">All models</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort agents"
          value={query.sort}
          onChange={(event) => setQuery({ ...query, sort: event.target.value as AgentLibraryQuery['sort'] })}
        >
          <option value="updated">Recently edited</option>
          <option value="name">Name</option>
          <option value="lastRun">Last run</option>
        </select>
        <button
          type="button"
          className={`btn btn-sm ${query.favoritesOnly ? 'active' : ''}`}
          aria-pressed={query.favoritesOnly}
          onClick={() => setQuery({ ...query, favoritesOnly: !query.favoritesOnly })}
        >
          <Star size={14} /> Favorites
        </button>
      </div>
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
        <div className="agent-defs--loading" role="status">
          Loading agents…
        </div>
      ) : error ? (
        <div className="agent-defs--error" role="alert">
          {error}
        </div>
      ) : visible.length === 0 ? (
        <div className="agent-defs--empty">
          <EmptyState
            title={items.length === 0 ? 'No agents yet' : 'No agents match these filters'}
            description={items.length === 0 ? 'Create an agent to give it a prompt, model, and tools.' : 'Try clearing search or filters.'}
            action={
              <button type="button" className="btn btn-primary" onClick={() => items.length === 0 ? void createAgent() : setQuery({ ...EMPTY_LIBRARY_QUERY })}>
                {items.length === 0 ? 'New agent' : 'Clear filters'}
              </button>
            }
          />
        </div>
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
