import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IntegrationPlatformClient } from '../../../shared/integrationPlatform'
import { MCP_RELAY_RUNTIMES, MOUSSE_BUILTIN_TOOL_GROUPS, MOUSSE_BUILTIN_TOOLS, relayEnabledFor, type McpRelayRuntime } from '../../../shared/integrations'
import type { AgentTypeId, MousseSettings, MousseSettingsUpdate, SettingsOptions } from '../../../shared/settings'
import { confirmNavigation } from '../../services/navigationGuards'
import { IntegrationsWorkspace, type IntegrationPolicy } from '../integrations/IntegrationsWorkspace'
import type { SkillModelBinding } from '../integrations/SkillModelPicker'
import { CircleCheck, Globe } from '../../lib/icons'
import { ConfirmRemoveButton } from './IconButtons'
import { SecretRow } from './SecretRow'
import { MoreDetails, SettingsAdvanced, SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { Select } from '../ui/Select'

type WebService = 'exa' | 'parallel'
const WEB_SERVICES: Array<{ id: WebService; label: string }> = [{ id: 'exa', label: 'Exa' }, { id: 'parallel', label: 'Parallel' }]

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
      <WebSearchKeys />
      <SettingsAdvanced>
        <MainAgentAvailability settings={live} onUpdate={onUpdate} />
        <AgentAvailability settings={live} options={options} onUpdate={onUpdate} />
        <RelayAvailability settings={live} onUpdate={onUpdate} />
        <BuiltInTools settings={live} onUpdate={onUpdate} />
      </SettingsAdvanced>
    </section>
  )
}

function WebSearchKeys() {
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
      {WEB_SERVICES.map(({ id, label }) => (
        <SecretRow
          key={id}
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
      {error ? <p className="skills-mcp-error" role="alert">{error}</p> : null}
    </SettingsGroup>
  )
}

function MainAgentAvailability({ settings, onUpdate }: { settings: MousseSettings; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const { skills, mcp } = settings.integrations
  return (
    <SettingsGroup anchor="integrations-main-agent" title="Available to main agent">
      <SettingsRow
        title="Skills"
        htmlFor="main-agent-skills"
        description="Lets the main agent load the skills that are on."
        control={<Switch id="main-agent-skills" label="Skills available to main agent" checked={skills.enableForMainAgent}
          onChange={(enableForMainAgent) => void onUpdate(patch({ skills: { enableForMainAgent } }))} />}
      />
      <SettingsRow
        title="MCP servers"
        htmlFor="main-agent-mcp"
        description="Lets the main agent use tools from the servers that are on."
        control={<Switch id="main-agent-mcp" label="MCP servers available to main agent" checked={mcp.enableForMainAgent}
          onChange={(enableForMainAgent) => void onUpdate(patch({ mcp: { enableForMainAgent } }))} />}
      />
    </SettingsGroup>
  )
}

function AgentAvailability({ settings, options, onUpdate }: {
  settings: MousseSettings; options: SettingsOptions; onUpdate: (partial: MousseSettingsUpdate) => Promise<void>
}) {
  const { skills, mcp } = settings.integrations
  if (!options.agentTypes.length) return null
  // Matches the daemon: an agent gets skills or servers only when its flag is true.
  const row = (kind: 'skills' | 'mcp', agentId: AgentTypeId, label: string, agentLabel: string) => {
    const on = (kind === 'skills' ? skills : mcp).enableForAgents[agentId] === true
    const id = `agent-${kind}-${agentId}`
    return (
      <SettingsRow
        key={id}
        indent
        title={label}
        htmlFor={id}
        control={<Switch id={id} label={`${label} available to ${agentLabel}`} checked={on}
          onChange={(next) => void onUpdate(patch({ [kind]: { enableForAgents: { [agentId]: next } } }))} />}
      />
    )
  }
  return (
    <SettingsGroup title="Available to agents" description="Which agents can use the skills and MCP servers that are on.">
      {options.agentTypes.map((agent) => [
        <SettingsRow key={agent.id} title={agent.label} />,
        row('skills', agent.id, 'Skills', agent.label),
        row('mcp', agent.id, 'MCP servers', agent.label)
      ])}
    </SettingsGroup>
  )
}

/** Which runtimes reach the MCP servers through the MCP relay (`mousse-relay`). Exported for tests. */
export function RelayAvailability({ settings, onUpdate }: { settings: MousseSettings; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const { mcp } = settings.integrations
  // The hidden MCP gate shows every runtime as off; there is nothing to share until a server is turned on.
  const disabled = mcp.enabled === false
  return (
    <SettingsGroup
      anchor="integrations-share"
      title="Let other agents use your MCP servers"
      description={<MoreDetails>
        They reach the servers that are on through Mousse, as the mousse-relay server. Claude Code also keeps the servers Mousse
        adds to it directly, so their tools can appear twice.
      </MoreDetails>}
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

function BuiltInTools({ settings, onUpdate }: { settings: MousseSettings; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const tools = settings.integrations.tools
  const gateOn = tools.enabled !== false
  const enabled = new Set(tools.enabledTools)
  const toggle = (toolId: string, next: boolean) => {
    // The hidden tools gate shows every tool as off; turning one on turns the gate back on.
    const ids = new Set(enabled)
    if (next) ids.add(toolId); else ids.delete(toolId)
    void onUpdate(patch({
      tools: {
        enabled: next ? true : tools.enabled,
        enabledTools: MOUSSE_BUILTIN_TOOLS.map((tool) => tool.id).filter((id) => ids.has(id))
      }
    }))
  }
  const groups = MOUSSE_BUILTIN_TOOL_GROUPS.filter((group) => SHOW_DEV_TOOLS || group.id !== 'devgui')
  return <>
    {groups.map((group) => {
      const groupTools = MOUSSE_BUILTIN_TOOLS.filter((tool) => tool.group === group.id)
      if (!groupTools.length) return null
      return (
        <SettingsGroup key={group.id} title={group.label} description={group.description} className="skills-mcp-compact">
          {groupTools.map((tool) => (
            <SettingsRow
              key={tool.id}
              title={tool.label}
              htmlFor={`builtin-tool-${tool.id}`}
              description={tool.description}
              control={<Switch id={`builtin-tool-${tool.id}`} label={`${tool.label} tool`} checked={gateOn && enabled.has(tool.id)} onChange={(next) => toggle(tool.id, next)} />}
            />
          ))}
        </SettingsGroup>
      )
    })}
  </>
}
