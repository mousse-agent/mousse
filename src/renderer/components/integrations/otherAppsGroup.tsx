import { useState } from 'react'
import type { McpServerConfig, SkillDescriptor } from '../../../shared/integrations'
import { ChevronDown, ChevronUp } from '../../lib/icons'
import { SettingsGroup, SettingsRow } from '../settings/SettingsRow'
import { isManagedSource } from './integrationUi'
import { itemId, type IntegrationKind } from './itemState'

const SOURCE_LABELS: Record<string, string> = {
  cursor: 'Cursor', claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', agents: 'Agents folder'
}
export function sourceLabel(source: string): string {
  // Only unmanaged copies get here, so a Mousse source means the project's own files.
  if (source === 'generated-agent' || source.startsWith('mousse')) return 'Project files'
  return SOURCE_LABELS[source.split('-')[0]] ?? source
}

/** One name found in other apps' config: the copy in effect plus every app it is in. */
export interface OtherAppRow {
  id: string
  name: string
  /** Distinct app labels, the app whose copy is in effect first. */
  sources: string[]
  /** Short detail after the app list: a problem, the description, or the command/URL. */
  detail: string
}

/**
 * Splits a list for display. Mousse's own items stay as they are. Items from
 * other apps collapse to one row per name (case-insensitive), showing the copy
 * in effect; a name Mousse already has is dropped, since Mousse's copy wins.
 * Display only: what agents can use is decided by the daemon.
 */
function splitOtherApps<T extends SkillDescriptor | McpServerConfig>(items: T[], inEffect: (copies: T[]) => T, detail: (item: T) => string): { own: T[]; otherApps: OtherAppRow[] } {
  const own = items.filter((item) => isManagedSource(item.source, item.managed))
  const ownNames = new Set(own.map((item) => item.name.toLowerCase()))
  const byName = new Map<string, T[]>()
  for (const item of items) {
    if (isManagedSource(item.source, item.managed)) continue
    const key = item.name.toLowerCase()
    if (ownNames.has(key)) continue
    const copies = byName.get(key)
    if (copies) copies.push(item); else byName.set(key, [item])
  }
  const otherApps = [...byName.values()].map((copies) => {
    const item = inEffect(copies)
    const sources = [...new Set([item, ...copies].map((copy) => sourceLabel(copy.source)))]
    return { id: itemId(item), name: item.name, sources, detail: detail(item) }
  })
  otherApps.sort((a, b) => a.name.localeCompare(b.name))
  return { own, otherApps }
}

/** The registry marks shadowed skill copies `isActive: false`. */
export function groupSkills(skills: SkillDescriptor[]) {
  return splitOtherApps(
    skills.filter((skill) => !skill.archived),
    (copies) => copies.find((copy) => copy.isActive !== false) ?? copies[0],
    (skill) => skill.diagnostics?.[0]?.message ?? (skill.description || 'No description.')
  )
}

/** The daemon lists servers in rank order (McpRegistry `compareMcpServers`), so the first copy of a name is in effect. */
export function groupMcpServers(servers: McpServerConfig[]) {
  return splitOtherApps(servers, (copies) => copies[0], (server) => server.diagnostics?.[0]?.message ?? mcpEndpoint(server))
}

export function mcpEndpoint(server: McpServerConfig): string {
  if (server.transport !== 'stdio') return server.url ?? 'Remote'
  return server.command ? [server.command, ...(server.args ?? [])].join(' ') : 'Local'
}

const GROUP_DESCRIPTIONS: Record<IntegrationKind, string> = {
  skills: 'Found in Claude Code, Cursor and Codex folders. Change them in those apps.',
  mcp: 'Found in Claude Code, Cursor and Codex settings. Change them in those apps.'
}

/** "From other apps · N": collapsed by default, one row per name with the source apps in the description. */
export function OtherAppsGroup({ kind, rows, defaultOpen = false }: { kind: IntegrationKind; rows: OtherAppRow[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!rows.length) return null
  const cardAttr = kind === 'skills' ? 'data-skill-card' : 'data-mcp-card'
  return (
    <SettingsGroup
      title={`From other apps · ${rows.length}`}
      description={GROUP_DESCRIPTIONS[kind]}
      className="skills-mcp-other-apps"
      action={<button type="button" className="settings-icon-btn" title={open ? 'Hide' : 'Show'} aria-label={open ? 'Hide' : 'Show'} aria-expanded={open} data-action={`toggle-other-apps-${kind}`} onClick={() => setOpen(!open)}>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>}
    >
      {open ? rows.map((row) => {
        const description = `${row.sources.join(', ')} · ${row.detail}`
        return <SettingsRow
          key={row.id}
          className="skills-mcp-row"
          {...{ [cardAttr]: row.id }}
          title={row.name}
          description={<span className="skills-mcp-line" title={description}>{description}</span>}
        />
      }) : null}
    </SettingsGroup>
  )
}
