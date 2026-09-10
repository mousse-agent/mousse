import { useEffect, useState, type ReactNode } from 'react'
import { AgentEditor } from './AgentEditor'
import { AgentsLibrary } from './AgentsLibrary'
import type { AgentDefinitionsClient, AgentEditorCatalogs } from './client'
import { EMPTY_LIBRARY_QUERY, type AgentLibraryQuery } from './libraryFilter'
import './agentDefinitions.css'

export interface AgentDefinitionsWorkspaceProps {
  profileId: string
  client: AgentDefinitionsClient
  catalogs: AgentEditorCatalogs
  activeRunsSlot?: ReactNode
  active?: boolean
}

export function AgentDefinitionsWorkspace({
  profileId,
  client,
  catalogs,
  activeRunsSlot,
  active = true
}: AgentDefinitionsWorkspaceProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [query, setQuery] = useState<AgentLibraryQuery>(EMPTY_LIBRARY_QUERY)

  useEffect(() => {
    setOpenId(null)
    setQuery(EMPTY_LIBRARY_QUERY)
  }, [client, profileId])

  if (openId) {
    return (
      <AgentEditor
        key={`${profileId}:${openId}`}
        profileId={profileId}
        definitionId={openId}
        client={client}
        catalogs={catalogs}
        active={active}
        onBack={() => setOpenId(null)}
        onOpenDefinition={setOpenId}
      />
    )
  }

  return (
    <AgentsLibrary
      key={profileId}
      profileId={profileId}
      client={client}
      query={query}
      onQueryChange={setQuery}
      onOpen={setOpenId}
      onCreated={setOpenId}
      activeRunsSlot={activeRunsSlot}
    />
  )
}
