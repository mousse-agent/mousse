import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IntegrationPlatformClient } from '../../../shared/integrationPlatform'
import { MOUSSE_BUILTIN_TOOL_GROUPS, MOUSSE_BUILTIN_TOOLS } from '../../../shared/integrations'
import type { AgentTypeId, MousseSettings, MousseSettingsUpdate, SettingsOptions } from '../../../shared/settings'
import { confirmNavigation } from '../../services/navigationGuards'
import { IntegrationsWorkspace, type IntegrationPolicy } from '../integrations/IntegrationsWorkspace'
import type { SkillModelBinding } from '../integrations/SkillModelPicker'
import { Check, CircleCheck, Globe, Loader2, Pencil, X } from '../../lib/icons'
import { ConfirmRemoveButton } from './IconButtons'
import { SettingsAdvanced, SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { Select } from '../ui/Select'

type WebService = 'exa' | 'parallel'
const WEB_SERVICES: Array<{ id: WebService; label: string }> = [{ id: 'exa', label: 'Exa' }, { id: 'parallel', label: 'Parallel' }]

/**
 * A nested integrations update. The settings store deep-merges objects, but
 * DeepPartial stops at interfaces, so a narrow patch needs this one cast.
 * Narrow patches keep values the daemon changed (selection lists) intact.
 */
type IntegrationsPatch = {
  tools?: { enabled?: boolean; enabledTools?: string[] }
  mcp?: { enableForMainAgent?: boolean; enableForAgents?: Partial<Record<AgentTypeId, boolean>> }
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
        <BuiltInTools settings={live} onUpdate={onUpdate} />
      </SettingsAdvanced>
    </section>
  )
}

function WebSearchKeys() {
  const [configured, setConfigured] = useState<Record<WebService, boolean>>({ exa: false, parallel: false })
  const [drafts, setDrafts] = useState<Record<WebService, string>>({ exa: '', parallel: '' })
  const [replacing, setReplacing] = useState<WebService | null>(null)
  const [saving, setSaving] = useState<WebService | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void window.mousse.webTools.getCredentialStatus().then((status) => { if (current) setConfigured(status) }).catch(() => {})
    return () => { current = false }
  }, [])

  const run = async (service: WebService, task: () => Promise<void>, nowConfigured: boolean) => {
    setSaving(service); setError(null)
    try {
      await task()
      setConfigured((value) => ({ ...value, [service]: nowConfigured }))
      setDrafts((value) => ({ ...value, [service]: '' }))
      setReplacing(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setSaving(null) }
  }

  return (
    <SettingsGroup title="Web search" icon={Globe} description="Optional API keys for the web_search tool, kept in the secure credential store.">
      {WEB_SERVICES.map(({ id, label }) => {
        const editing = !configured[id] || replacing === id
        const inputId = `web-search-key-${id}`
        const save = () => { if (drafts[id].trim()) void run(id, () => window.mousse.webTools.setApiKey(id, drafts[id].trim()), true) }
        return (
          <SettingsRow
            key={id}
            title={label}
            htmlFor={editing ? inputId : undefined}
            description={configured[id] ? <span className="settings-status-ok"><CircleCheck size={14} className="settings-status-glyph" />Connected</span> : 'Not connected'}
            control={editing ? <span className="settings-icon-actions">
              <input
                id={inputId}
                className="settings-input"
                type="password"
                autoComplete="off"
                value={drafts[id]}
                placeholder={configured[id] ? 'New API key' : 'API key'}
                disabled={saving !== null}
                onChange={(event) => setDrafts((value) => ({ ...value, [id]: event.target.value }))}
                onKeyDown={(event) => { if (event.key === 'Enter') save() }}
              />
              {replacing === id ? <button type="button" className="settings-icon-btn" title="Cancel" aria-label="Cancel" disabled={saving !== null} onClick={() => { setReplacing(null); setDrafts((value) => ({ ...value, [id]: '' })) }}><X size={14} /></button> : null}
              <button type="button" className="settings-icon-btn primary" title={saving === id ? 'Saving…' : 'Save key'} aria-label={saving === id ? 'Saving…' : 'Save'} disabled={saving !== null || !drafts[id].trim()} onClick={save}>
                {saving === id ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
              </button>
            </span> : <span className="settings-icon-actions">
              <button type="button" className="settings-icon-btn" title="Replace key" aria-label="Replace" disabled={saving !== null} onClick={() => setReplacing(id)}><Pencil size={14} /></button>
              <ConfirmRemoveButton label="Remove key" disabled={saving !== null} onRemove={() => void run(id, () => window.mousse.webTools.clearApiKey(id), false)} />
            </span>}
          />
        )
      })}
      {error ? <p className="skills-mcp-error" role="alert">{error}</p> : null}
    </SettingsGroup>
  )
}

function MainAgentAvailability({ settings, onUpdate }: { settings: MousseSettings; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const { skills, mcp } = settings.integrations
  return (
    <SettingsGroup title="Available to main agent">
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
  const chip = (kind: 'skills' | 'mcp', agentId: AgentTypeId, label: string, agentLabel: string) => {
    const on = (kind === 'skills' ? skills : mcp).enableForAgents[agentId] === true
    return (
      <button
        type="button"
        className={`settings-chip${on ? ' on' : ''}`}
        aria-pressed={on}
        aria-label={`${label} available to ${agentLabel}`}
        onClick={() => void onUpdate(patch({ [kind]: { enableForAgents: { [agentId]: !on } } }))}
      >{label}</button>
    )
  }
  return (
    <SettingsGroup title="Available to agents" description="Which agents can use the skills and MCP servers that are on.">
      {options.agentTypes.map((agent) => (
        <SettingsRow
          key={agent.id}
          title={agent.label}
          control={<div className="skills-mcp-chips" role="group" aria-label={`Available to ${agent.label}`}>
            {chip('skills', agent.id, 'Skills', agent.label)}
            {chip('mcp', agent.id, 'MCP', agent.label)}
          </div>}
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
