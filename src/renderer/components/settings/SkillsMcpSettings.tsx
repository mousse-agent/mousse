import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { IntegrationPlatformClient } from '../../../shared/integrationPlatform'
import { MCP_RELAY_RUNTIMES, MOUSSE_BUILTIN_TOOL_GROUPS, MOUSSE_BUILTIN_TOOLS, relayEnabledFor, type McpRelayRuntime, type MousseBuiltInToolGroupId, type MousseBuiltInToolInfo } from '../../../shared/integrations'
import type { AgentTypeId, MousseSettings, MousseSettingsUpdate, SettingsOptions } from '../../../shared/settings'
import { confirmNavigation } from '../../services/navigationGuards'
import { IntegrationsWorkspace, type IntegrationPolicy } from '../integrations/IntegrationsWorkspace'
import type { SkillModelBinding } from '../integrations/SkillModelPicker'
import { ChevronRight, CircleCheck, Globe } from '../../lib/icons'
import { COLLAPSE_DETAILS_CLASS } from '../ui/Collapse'
import { ConfirmRemoveButton } from './IconButtons'
import { SecretRow } from './SecretRow'
import { MoreDetails, SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { Select } from '../ui/Select'

type WebService = 'exa' | 'parallel'
/** `anchor`: where a settings search result lands (lib/settingsSearch.ts), here and in the tables below. */
const WEB_SERVICES: Array<{ id: WebService; label: string; anchor: string }> = [
  { id: 'exa', label: 'Exa', anchor: 'integrations-web-exa' },
  { id: 'parallel', label: 'Parallel', anchor: 'integrations-web-parallel' }
]

/** The web tools sit with their keys under Web search; Built-in tools lists the other groups. */
const WEB_TOOLS: Array<{ id: string; anchor: string }> = [
  { id: 'web_search', anchor: 'integrations-tool-web-search' },
  { id: 'web_fetch', anchor: 'integrations-tool-web-fetch' }
]

/** Built-in tool groups in their folds. The development-only group has no search entry. */
const TOOL_GROUP_FOLDS: Array<{ id: MousseBuiltInToolGroupId; anchor?: string }> = [
  { id: 'project', anchor: 'integrations-tools-project' },
  { id: 'interaction', anchor: 'integrations-tools-interaction' },
  { id: 'tasks', anchor: 'integrations-tools-tasks' },
  { id: 'actions', anchor: 'integrations-tools-actions' },
  { id: 'skills', anchor: 'integrations-tools-skills' },
  { id: 'browser', anchor: 'integrations-tools-browser' },
  { id: 'devgui' }
]

/** How the providers page names each runtime that can reach the MCP relay. */
const RELAY_RUNTIME_LABELS: Record<McpRelayRuntime, string> = {
  claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', acp: 'ACP agents', antigravity: 'Antigravity', grok: 'Grok'
}

/**
 * A nested integrations update. The settings store deep-merges objects, but
 * DeepPartial stops at interfaces, so a narrow patch needs this one cast.
 * Narrow patches keep values the daemon changed (selection lists) intact.
 */
type IntegrationsPatch = {
  tools?: { enabled?: boolean; enabledTools?: string[] }
  mcp?: { enableForMainAgent?: boolean; enableForAgents?: Partial<Record<AgentTypeId, boolean>>; relay?: { runtimes?: Partial<Record<McpRelayRuntime, boolean>> } }
  skills?: { enableForMainAgent?: boolean; enableForAgents?: Partial<Record<AgentTypeId, boolean>>; model?: Record<string, { instanceId?: string; llmProvider: string; model: string }> }
}
const patch = (integrations: IntegrationsPatch) => ({ integrations }) as unknown as MousseSettingsUpdate

/** Development builds also offer the tools that let an agent inspect this window. */
const SHOW_DEV_TOOLS = import.meta.env.DEV

/**
 * Settings > Skills & MCP. Replaces the old Tools, Skill defaults and
 * Integrations pages. The registry and tools master switches are no longer
 * shown; their stored values still apply, and turning an item on turns its
 * gate back on, so a row never reads "on" while something hidden is off.
 */
export function SkillsMcpSettings({
  client,
  profileId,
  projectId,
  projects,
  onProjectChange,
  settings,
  options,
  onUpdate
}: {
  client: IntegrationPlatformClient
  profileId: string
  projectId?: string
  projects: Array<{ id: string; name: string }>
  onProjectChange: (projectId: string) => void
  settings: MousseSettings
  options: SettingsOptions
  onUpdate: (partial: MousseSettingsUpdate) => Promise<void>
}) {
  // The daemon updates the selection when an item is switched; read it back here.
  const [live, setLive] = useState(settings)
  useEffect(() => setLive(settings), [settings])
  const refresh = useCallback(async () => {
    try { setLive(await window.mousse.settings.get()) } catch { /* keep the last known values */ }
  }, [])
  const integrations = live.integrations

  const policy = useMemo<IntegrationPolicy>(() => ({ integrations, refresh }), [integrations, refresh])
  const skillModel = useMemo<SkillModelBinding>(() => ({
    providers: options.llmProviders,
    get: (skillId) => {
      const value = integrations.skills.model[skillId]
      return value?.llmProvider && value.model ? value : undefined
    },
    // Empty values mean "default model" (see resolveSkillModelSettings).
    set: (skillId, value) => onUpdate(patch({ skills: { model: { [skillId]: value ?? { llmProvider: '', model: '' } } } }))
  }), [integrations.skills.model, options.llmProviders, onUpdate])

  const changeScope = (next: string) => {
    void confirmNavigation('navigate', 'integrations').then((allowed) => { if (allowed) onProjectChange(next) })
  }

  return (
    <section id="integrations" className="settings-section skills-mcp-page">
      <SettingsGroup action={
        <Select
          ariaLabel="Show skills and servers for"
          value={projectId ?? ''}
          onChange={changeScope}
          options={[{ value: '', label: 'This profile' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
        />
      } />
      <IntegrationsWorkspace client={client} profileId={profileId} projectId={projectId} policy={policy} skillModel={skillModel} />
      <WebSearchKeys settings={live} onUpdate={onUpdate} />
      <SettingsFold anchor="integrations-access" title="Who can use them">
        <AgentAvailability settings={live} options={options} onUpdate={onUpdate} />
      </SettingsFold>
      <SettingsFold anchor="integrations-share" title="Share MCP servers">
        <RelayAvailability settings={live} onUpdate={onUpdate} />
      </SettingsFold>
      <SettingsFold anchor="integrations-tools" title="Built-in tools">
        <BuiltInTools settings={live} onUpdate={onUpdate} />
      </SettingsFold>
    </section>
  )
}

type SettingsProps = { settings: MousseSettings; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }

/**
 * A fold on this page: a heading that opens its rows. Settings search opens it (and any fold around it)
 * when a result lands inside. `count` shows next to the title while it is closed.
 */
function SettingsFold({ title, anchor, count, sub, children }: { title: string; anchor?: string; count?: string; sub?: boolean; children: ReactNode }) {
  return (
    <details className={`settings-fold${sub ? ' sub' : ''} ${COLLAPSE_DETAILS_CLASS}`}>
      <summary data-settings-anchor={anchor}>
        <ChevronRight size={14} aria-hidden="true" className="settings-advanced-chevron" />
        <span className="settings-fold-title">{title}</span>
        {count ? <span className="settings-fold-count">{count}</span> : null}
      </summary>
      <div className="settings-fold-body">{children}</div>
    </details>
  )
}

/** Built-in tool switches. A tool reads on only while the hidden tools gate is on; turning one on turns the gate back on. */
function useBuiltInTools({ settings, onUpdate }: SettingsProps) {
  const tools = settings.integrations.tools
  const gateOn = tools.enabled !== false
  const enabled = new Set(tools.enabledTools)
  const isOn = (toolId: string) => gateOn && enabled.has(toolId)
  const toggle = (toolId: string, next: boolean) => {
    const ids = new Set(enabled)
    if (next) ids.add(toolId); else ids.delete(toolId)
    void onUpdate(patch({
      tools: {
        enabled: next ? true : tools.enabled,
        enabledTools: MOUSSE_BUILTIN_TOOLS.map((tool) => tool.id).filter((id) => ids.has(id))
      }
    }))
  }
  return { isOn, toggle }
}

function ToolRow({ tool, anchor, isOn, toggle }: { tool: MousseBuiltInToolInfo; anchor?: string } & ReturnType<typeof useBuiltInTools>) {
  return (
    <SettingsRow
      anchor={anchor}
      title={tool.label}
      htmlFor={`builtin-tool-${tool.id}`}
      description={tool.description}
      control={<Switch id={`builtin-tool-${tool.id}`} label={`${tool.label} tool`} checked={isOn(tool.id)} onChange={(next) => toggle(tool.id, next)} />}
    />
  )
}

function WebSearchKeys(props: SettingsProps) {
  const tools = useBuiltInTools(props)
  const [configured, setConfigured] = useState<Record<WebService, boolean>>({ exa: false, parallel: false })
  const [removing, setRemoving] = useState<WebService | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void window.mousse.webTools.getCredentialStatus().then((status) => { if (current) setConfigured(status) }).catch(() => {})
    return () => { current = false }
  }, [])

  const remove = async (service: WebService) => {
    setRemoving(service); setError(null)
    try {
      await window.mousse.webTools.clearApiKey(service)
      setConfigured((value) => ({ ...value, [service]: false }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setRemoving(null) }
  }

  return (
    <SettingsGroup anchor="integrations-web-search" title="Web search" icon={Globe} description="Optional API keys that let agents search the web, kept in the secure credential store.">
      {WEB_SERVICES.map(({ id, label, anchor }) => (
        <SecretRow
          key={id}
          anchor={anchor}
          title={label}
          inputId={`web-search-key-${id}`}
          fieldLabel={`${label} API key`}
          placeholder={configured[id] ? 'New API key' : 'API key'}
          configured={configured[id]}
          description={configured[id] ? <span className="settings-status-ok"><CircleCheck size={14} className="settings-status-glyph" />Connected</span> : 'Not connected'}
          onSave={async (key) => {
            await window.mousse.webTools.setApiKey(id, key)
            setConfigured((value) => ({ ...value, [id]: true }))
          }}
          busy={removing !== null}
          actions={<ConfirmRemoveButton label="Remove key" disabled={removing !== null} onRemove={() => void remove(id)} />}
        />
      ))}
      {WEB_TOOLS.map(({ id, anchor }) => {
        const tool = MOUSSE_BUILTIN_TOOLS.find((item) => item.id === id)
        return tool ? <ToolRow key={id} tool={tool} anchor={anchor} {...tools} /> : null
      })}
      {error ? <p className="skills-mcp-error" role="alert">{error}</p> : null}
    </SettingsGroup>
  )
}

/**
 * Who can use the skills and MCP servers that are on: one row per agent, with a Skills and an MCP
 * switch under column labels, like the notification channels. An agent gets them only when its flag
 * is true (as the daemon reads it).
 */
function AgentAvailability({ settings, options, onUpdate }: SettingsProps & { options: SettingsOptions }) {
  const { skills, mcp } = settings.integrations
  const row = (key: string, label: string, ids: { skills: string; mcp: string }, on: { skills: boolean; mcp: boolean },
    set: (kind: 'skills' | 'mcp', next: boolean) => void, ariaName: string) => (
    <SettingsRow
      key={key}
      title={label}
      control={
        <span className="skills-mcp-access" role="group" aria-label={`What ${label} can use`}>
          <Switch id={ids.skills} label={`Skills available to ${ariaName}`} checked={on.skills} onChange={(next) => set('skills', next)} />
          <Switch id={ids.mcp} label={`MCP servers available to ${ariaName}`} checked={on.mcp} onChange={(next) => set('mcp', next)} />
        </span>
      }
    />
  )
  return (
    <SettingsGroup
      description="Which agents can use the skills and MCP servers that are on."
      className="skills-mcp-access-group"
      action={
        <span className="skills-mcp-access skills-mcp-access-labels" aria-hidden="true">
          <span>Skills</span><span>MCP</span>
        </span>
      }
    >
      {row('main', 'Main agent', { skills: 'main-agent-skills', mcp: 'main-agent-mcp' },
        { skills: skills.enableForMainAgent, mcp: mcp.enableForMainAgent },
        (kind, enableForMainAgent) => void onUpdate(patch({ [kind]: { enableForMainAgent } })), 'main agent')}
      {options.agentTypes.map((agent) => row(agent.id, agent.label,
        { skills: `agent-skills-${agent.id}`, mcp: `agent-mcp-${agent.id}` },
        { skills: skills.enableForAgents[agent.id] === true, mcp: mcp.enableForAgents[agent.id] === true },
        (kind, next) => void onUpdate(patch({ [kind]: { enableForAgents: { [agent.id]: next } } })), agent.label))}
    </SettingsGroup>
  )
}

/** Which runtimes reach the MCP servers through the MCP relay (`mousse-relay`). Exported for tests. */
export function RelayAvailability({ settings, onUpdate }: SettingsProps) {
  const { mcp } = settings.integrations
  // The hidden MCP gate shows every runtime as off; there is nothing to share until a server is turned on.
  const disabled = mcp.enabled === false
  return (
    <SettingsGroup
      description={<>
        Other agents reach the servers that are on through Mousse.
        <MoreDetails>
          They connect to it as the mousse-relay server. Claude Code also keeps the servers Mousse adds to it directly, so their
          tools can appear twice.
        </MoreDetails>
      </>}
      className="skills-mcp-compact"
    >
      {MCP_RELAY_RUNTIMES.map((runtime) => (
        <SettingsRow
          key={runtime}
          title={RELAY_RUNTIME_LABELS[runtime]}
          htmlFor={`mcp-relay-${runtime}`}
          disabled={disabled}
          control={<Switch id={`mcp-relay-${runtime}`} label={`Share MCP servers with ${RELAY_RUNTIME_LABELS[runtime]}`} disabled={disabled}
            checked={relayEnabledFor(mcp, runtime)}
            onChange={(next) => void onUpdate(patch({ mcp: { relay: { runtimes: { [runtime]: next } } } }))} />}
        />
      ))}
    </SettingsGroup>
  )
}

/** One fold per tool group, with how many of its tools are on. */
function BuiltInTools(props: SettingsProps) {
  const tools = useBuiltInTools(props)
  const groups = TOOL_GROUP_FOLDS.filter(({ id }) => SHOW_DEV_TOOLS || id !== 'devgui')
  return <>
    {groups.map(({ id, anchor }) => {
      const group = MOUSSE_BUILTIN_TOOL_GROUPS.find((item) => item.id === id)
      if (!group) return null
      const groupTools = MOUSSE_BUILTIN_TOOLS.filter((tool) => tool.group === group.id)
      if (!groupTools.length) return null
      const on = groupTools.filter((tool) => tools.isOn(tool.id)).length
      return (
        <SettingsFold key={group.id} sub anchor={anchor} title={group.label} count={`${on} of ${groupTools.length} on`}>
          <SettingsGroup description={group.description} className="skills-mcp-compact">
            {groupTools.map((tool) => <ToolRow key={tool.id} tool={tool} {...tools} />)}
          </SettingsGroup>
        </SettingsFold>
      )
    })}
  </>
}
