import { useMemo, useState } from 'react'
import { WORKFLOW_NODE_CATALOG, WORKFLOW_NODE_TYPES } from '../../../shared/workflows'
import { SearchInput } from '../ui/SearchInput'
import { CATEGORY_LABELS, CATEGORY_ORDER } from './defaultNode'
import type { WorkflowEditorCatalogs } from './client'

export function WorkflowPalette({
  catalogs,
  onAdd,
  disabled
}: {
  catalogs: WorkflowEditorCatalogs
  onAdd: (type: string, extra?: Record<string, unknown>) => void
  disabled?: boolean
}) {
  const [search, setSearch] = useState('')
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase()
    const groups = CATEGORY_ORDER.map((category) => ({
      category,
      label: CATEGORY_LABELS[category] ?? category,
      items: WORKFLOW_NODE_TYPES.filter((type) => WORKFLOW_NODE_CATALOG[type].category === category)
        .filter((type) => {
          if (!q) return true
          const entry = WORKFLOW_NODE_CATALOG[type]
          return `${entry.label} ${type} ${CATEGORY_LABELS[category]}`.toLowerCase().includes(q)
        })
        .map((type) => WORKFLOW_NODE_CATALOG[type])
    })).filter((group) => group.items.length > 0)
    return groups
  }, [search])

  const userAgents = catalogs.subworkflows.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()) || !search.trim())
  const tools = catalogs.builtinTools.filter((item) => item.label.toLowerCase().includes(search.trim().toLowerCase()) || !search.trim())
  const skills = catalogs.skills.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()) || !search.trim())

  return (
    <nav className="wf-palette" aria-label="Node palette" data-palette="">
      <SearchInput value={search} onChange={setSearch} placeholder="Search nodes" />
      {grouped.map((group) => (
        <section key={group.category}>
          <h2>{group.label}</h2>
          {group.items.map((item) => (
            <button
              key={item.type}
              type="button"
              className="wf-palette-item"
              data-palette-type={item.type}
              disabled={disabled}
              onClick={() => onAdd(item.type)}
            >
              {item.label}
            </button>
          ))}
        </section>
      ))}
      {tools.length > 0 ? (
        <section>
          <h2>Installed tools</h2>
          {tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="wf-palette-item"
              disabled={disabled}
              onClick={() => onAdd('tool', { tool: { id: tool.id } })}
            >
              {tool.label}
            </button>
          ))}
        </section>
      ) : null}
      {catalogs.mcpServers.length > 0 ? (
        <section>
          <h2>MCP tools</h2>
          {catalogs.mcpServers.flatMap((server) =>
            server.tools.map((tool) => (
              <button
                key={`${server.serverId}:${tool.toolName}`}
                type="button"
                className="wf-palette-item"
                disabled={disabled || !tool.available}
                title={tool.available ? undefined : 'MCP tool is unavailable'}
                onClick={() => onAdd('mcp-tool', { serverId: server.serverId, toolName: tool.toolName })}
              >
                {server.name} / {tool.toolName}
              </button>
            ))
          )}
        </section>
      ) : null}
      {skills.length > 0 ? (
        <section>
          <h2>Skills</h2>
          {skills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className="wf-palette-item"
              disabled={disabled || !skill.available}
              onClick={() => onAdd('load-skill', { skill: { id: skill.id, revision: skill.revision ?? '' } })}
            >
              {skill.name}
            </button>
          ))}
        </section>
      ) : null}
      {userAgents.length > 0 ? (
        <section>
          <h2>Subworkflows</h2>
          {userAgents.map((item) => (
            <button
              key={item.id}
              type="button"
              className="wf-palette-item"
              disabled={disabled}
              onClick={() => onAdd('subworkflow', { workflow: { id: item.id, revision: item.revision ?? '' } })}
            >
              {item.name}
            </button>
          ))}
        </section>
      ) : null}
    </nav>
  )
}
