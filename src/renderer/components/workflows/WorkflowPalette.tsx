import { useMemo, useState } from 'react'
import { WORKFLOW_NODE_CATALOG, WORKFLOW_NODE_TYPES } from '../../../shared/workflows'
import { SearchInput } from '../ui/SearchInput'
import { CATEGORY_LABELS, CATEGORY_ORDER } from './defaultNode'
import type { WorkflowEditorCatalogs } from './client'
import { WorkflowNodeIcon } from './WorkflowNodeIcon'

/** The steps most workflows use; the palette shows these until a search finds the rest. */
export const COMMON_NODE_TYPES = ['agent', 'instruction', 'script', 'condition', 'for-each', 'ask-user', 'approval', 'write-artifact'] as const satisfies ReadonlyArray<(typeof WORKFLOW_NODE_TYPES)[number]>

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
  const q = search.trim().toLowerCase()
  // Without a search the palette shows the common steps; a search finds every step, tool, skill and subworkflow.
  const grouped = useMemo(() => {
    if (!q) return [{ category: 'common', label: 'Common steps', items: COMMON_NODE_TYPES.map((type) => WORKFLOW_NODE_CATALOG[type]) }]
    return CATEGORY_ORDER.map((category) => ({
      category,
      label: CATEGORY_LABELS[category] ?? category,
      items: WORKFLOW_NODE_TYPES.filter((type) => WORKFLOW_NODE_CATALOG[type].category === category)
        .filter((type) => {
          const entry = WORKFLOW_NODE_CATALOG[type]
          return `${entry.label} ${type} ${CATEGORY_LABELS[category]}`.toLowerCase().includes(q)
        })
        .map((type) => WORKFLOW_NODE_CATALOG[type])
    })).filter((group) => group.items.length > 0)
  }, [q])

  const userAgents = q ? catalogs.subworkflows.filter((item) => item.name.toLowerCase().includes(q)) : []
  const tools = q ? catalogs.builtinTools.filter((item) => item.label.toLowerCase().includes(q)) : []
  const skills = q ? catalogs.skills.filter((item) => item.name.toLowerCase().includes(q)) : []
  const mcpTools = q ? catalogs.mcpServers.flatMap((server) => server.tools.filter((tool) => `${server.name} ${tool.toolName}`.toLowerCase().includes(q)).map((tool) => ({ server, tool }))) : []

  return (
    <nav className="wf-palette" aria-label="Node palette" data-palette="">
      <h2 className="wf-palette-title">Add a step</h2>
      <SearchInput value={search} onChange={setSearch} placeholder="Search all steps, tools and skills" />
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
              title={`Add ${item.label}`}
              onClick={() => onAdd(item.type)}
            >
              <WorkflowNodeIcon type={item.type} /><span>{item.label}</span>
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
              <WorkflowNodeIcon type="tool" /><span>{tool.label}</span>
            </button>
          ))}
        </section>
      ) : null}
      {mcpTools.length > 0 ? (
        <section>
          <h2>MCP tools</h2>
          {mcpTools.map(({ server, tool }) => (
            <button
              key={`${server.serverId}:${tool.toolName}`}
              type="button"
              className="wf-palette-item"
              disabled={disabled || !tool.available}
              title={tool.available ? undefined : 'MCP tool is unavailable'}
              onClick={() => onAdd('mcp-tool', { serverId: server.serverId, toolName: tool.toolName })}
            >
              <WorkflowNodeIcon type="mcp-tool" /><span>{tool.toolName}<small>{server.name}</small></span>
            </button>
          ))}
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
              <WorkflowNodeIcon type="load-skill" /><span>{skill.name}</span>
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
              <WorkflowNodeIcon type="subworkflow" /><span>{item.name}</span>
            </button>
          ))}
        </section>
      ) : null}
    </nav>
  )
}
