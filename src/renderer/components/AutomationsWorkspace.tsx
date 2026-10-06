import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Clock, RefreshCw, Workflow } from '../lib/icons'
import { MOUSSE_BUILTIN_TOOLS } from '../../shared/integrations'
import { createAgentDefinitionsClient } from '../services/agentDefinitionsClient'
import { createWorkflowDefinitionsClient } from '../services/workflowDefinitionsClient'
import { createWorkflowExecutionClient } from '../services/workflowExecutionClient'
import { createIntegrationPlatformClient } from '../services/integrationPlatformClient'
import { confirmNavigation, registerNavigationGuard } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'
import { AgentDefinitionsWorkspace } from './agentDefinitions/AgentDefinitionsWorkspace'
import type { AgentEditorCatalogs } from './agentDefinitions/client'
import { WorkflowsWorkspace } from './workflows/WorkflowsWorkspace'
import type { WorkflowEditorCatalogs, WorkflowLeaveGuard } from './workflows/client'
import { ScheduledPanel } from './ScheduledPanel'
import './agentsWorkspace.css'

const emptyCatalogs = (): AgentEditorCatalogs => ({ providers: [], skills: [], mcpServers: [], builtinTools: [], childDefinitions: [], browserWorkspaces: [] })
const workflowProjectToolIds = new Set(MOUSSE_BUILTIN_TOOLS.filter((tool) => tool.group === 'project').map((tool) => tool.id))

const automationTabs = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'workflows', label: 'Workflows', icon: Workflow },
  { id: 'scheduled', label: 'Scheduled', icon: Clock }
] as const

/** Reusable agents, editable workflows, and scheduled jobs in Automations. */
export function AutomationsWorkspace({ active = true }: { active?: boolean }) {
  const profileId = useAppStore((state) => state.profileId)
  return <ProfileAutomationsWorkspace key={profileId} profileId={profileId} active={active} />
}

function ProfileAutomationsWorkspace({ profileId, active }: { profileId: string; active: boolean }) {
  const [tab, setTab] = useState<(typeof automationTabs)[number]['id']>('agents')
  const [catalogs, setCatalogs] = useState<AgentEditorCatalogs>(emptyCatalogs)
  const [subworkflows, setSubworkflows] = useState<WorkflowEditorCatalogs['subworkflows']>([])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const workflowGuard = useRef<WorkflowLeaveGuard | null>(null)
  const reveal = useCallback(() => {
    useAppStore.getState().setScheduledOpen(true)
  }, [])
  const clients = useMemo(() => ({
    agents: createAgentDefinitionsClient(window.mousse.platformRequest),
    workflows: createWorkflowDefinitionsClient(window.mousse.platformRequest),
    execution: createWorkflowExecutionClient(window.mousse.platformRequest),
    integrations: createIntegrationPlatformClient(window.mousse.platformRequest)
  }), [])
  const load = useCallback(async (discoverTools = false) => {
    const ticket = ++generation.current
    setRefreshing(true); setError(null)
    try {
      const [options, settings, snapshot, definitions, workflows] = await Promise.all([
        window.mousse.settings.getOptions(), window.mousse.settings.get(),
        clients.integrations.snapshot({ profileId, refresh: discoverTools }),
        clients.agents.list({ profileId }), clients.workflows.list({ profileId })
      ])
      if (ticket !== generation.current) return
      const mcpServers = await Promise.all(snapshot.mcp.servers.filter((server) => server.enabled !== false && server.status !== 'disabled').map(async (server) => {
        const serverId = server.installationId ?? server.id
        // Connecting a stdio server is explicit: opening the library only reads
        // catalogs. Refresh tools performs the user's requested discovery.
        const tools = discoverTools ? await window.mousse.mcp.listTools(serverId) : []
        return { serverId, name: server.name, tools: tools.map((tool) => ({ toolName: tool.toolName, available: !tool.schemaError && !server.deniedTools?.includes(tool.toolName) && (!server.enabledTools?.length || server.enabledTools.includes(tool.toolName)) })) }
      }))
      if (ticket !== generation.current) return
      setCatalogs({
        providers: options.llmProviders,
        skills: snapshot.skills.skills.map((skill) => ({ id: skill.installationId ?? skill.id, name: skill.name, revision: skill.revision, available: !skill.archived && skill.enabled !== false && skill.isActive !== false })),
        mcpServers,
        builtinTools: MOUSSE_BUILTIN_TOOLS.filter((tool) => tool.group !== 'devgui' && settings.integrations.tools.enabled && settings.integrations.tools.enabledTools.includes(tool.id)).map((tool) => ({ id: tool.id, label: tool.label })),
        childDefinitions: definitions.filter((definition) => !definition.archived).map((definition) => ({ id: definition.id, name: definition.name })),
        browserWorkspaces: []
      })
      setSubworkflows(workflows.map((workflow) => ({ id: workflow.id, name: workflow.name, slug: workflow.slug, revision: workflow.headRevisionId ?? undefined })))
    } catch (cause) {
      if (ticket === generation.current) setError(cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : String(cause))
    } finally { if (ticket === generation.current) setRefreshing(false) }
  }, [clients, profileId])
  useEffect(() => { void load(); return () => { generation.current += 1 } }, [load])
  useEffect(() => registerNavigationGuard((reason) => {
    if (!workflowGuard.current) return true
    reveal()
    return workflowGuard.current(reason)
  }), [reveal])
  const registerWorkflowGuard = useCallback((guard: WorkflowLeaveGuard | null) => { workflowGuard.current = guard }, [])
  const selectTab = async (next: typeof tab, focus = false) => {
    if (next === tab) return
    if (await confirmNavigation()) {
      setTab(next)
      if (focus) requestAnimationFrame(() => document.getElementById(`automations-${next}-tab`)?.focus())
    }
  }
  const workflowCatalogs: WorkflowEditorCatalogs = {
    ...catalogs, subworkflows,
    builtinTools: catalogs.builtinTools.filter((tool) => workflowProjectToolIds.has(tool.id)),
    models: catalogs.providers.flatMap((provider) => provider.models.map((model) => ({ providerId: provider.id, modelId: model.id, label: model.label, available: true })))
  }
  return <section className="agents-workspace" aria-label="Automations" data-automations-workspace="" data-profile-id={profileId}>
    <header className="agents-workspace__header">
      <nav role="tablist" aria-label="Automation sections" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = automationTabs.findIndex((item) => item.id === tab)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? automationTabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + automationTabs.length) % automationTabs.length
        void selectTab(automationTabs[next].id, true)
      }}>
        {automationTabs.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" role="tab" id={`automations-${id}-tab`} tabIndex={tab === id ? 0 : -1} aria-controls={`automations-${id}-pane`} aria-selected={tab === id} onClick={() => void selectTab(id)}><Icon size={15} /> {label}</button>
        ))}
      </nav>
      <button type="button" className="btn btn-sm" disabled={refreshing} onClick={() => void load(true)} title="Refresh installed skills and connect configured MCP servers to discover tools"><RefreshCw size={13} /> {refreshing ? 'Refreshing…' : 'Refresh tools'}</button>
    </header>
    {error && <p className="agents-workspace__error" role="alert">{error}</p>}
    {tab === 'agents' ? <div className="agents-workspace__pane" role="tabpanel" id="automations-agents-pane" aria-labelledby="automations-agents-tab">
      <AgentDefinitionsWorkspace profileId={profileId} client={clients.agents} catalogs={catalogs} active={active} onRequestAttention={reveal} />
    </div> : tab === 'workflows' ? <div className="agents-workspace__pane" role="tabpanel" id="automations-workflows-pane" aria-labelledby="automations-workflows-tab">
      <WorkflowsWorkspace profileId={profileId} client={clients.workflows} execution={clients.execution} catalogs={workflowCatalogs} agentDefinitions={clients.agents} active={active} onRegisterLeaveGuard={registerWorkflowGuard} />
    </div> : <div className="agents-workspace__pane automations-scheduled-pane" role="tabpanel" id="automations-scheduled-pane" aria-labelledby="automations-scheduled-tab">
      <ScheduledPanel />
    </div>}
  </section>
}
