import { useEffect, useMemo, useState } from 'react'
import { SearchInput } from '../ui/SearchInput'
import { LiquidGlassOrb } from '../orb/LiquidGlassOrb'
import {
  AGENT_RUNTIME_LABELS,
  isAgentDefinitionClientError,
  type AgentDefinitionsClient,
  type AgentLibraryItem
} from './client'
import { filterAgentLibrary, EMPTY_LIBRARY_QUERY } from './libraryFilter'

/** Read-only picker for workflow Agent nodes and other host surfaces. */
export function AgentDefinitionPicker({
  profileId,
  client,
  value,
  onChange,
  disabled
}: {
  profileId: string
  client: AgentDefinitionsClient
  value?: string
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const [items, setItems] = useState<AgentLibraryItem[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void client
      .list({ profileId })
      .then((result) => {
        if (!cancelled) setItems(result)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [client, profileId])
  const visible = useMemo(
    () => filterAgentLibrary(items, { ...EMPTY_LIBRARY_QUERY, search, sort: 'name' }),
    [items, search]
  )
  return (
    <div className="agent-defs" data-agent-picker="">
      <SearchInput value={search} onChange={setSearch} placeholder="Find an agent" />
      {error ? (
        <p className="agent-field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="agent-library-grid">
        {visible.map((item) => (
          <button
            key={item.id}
            type="button"
            className="agent-card"
            disabled={disabled}
            aria-pressed={item.id === value}
            onClick={() => onChange(item.id)}
          >
            <LiquidGlassOrb compact appearance={item.visual} />
            <div className="agent-card__body">
              <h3>{item.name}</h3>
              <p>
                {AGENT_RUNTIME_LABELS[item.runtimeKind]}
                {item.publishedRevision ? ' · Published' : ' · Draft only'}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
