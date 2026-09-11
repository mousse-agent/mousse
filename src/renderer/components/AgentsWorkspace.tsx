import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, RefreshCw, Workflow } from 'lucide-react'
import { MOUSSE_BUILTIN_TOOLS } from '../../shared/integrations'
import { createAgentDefinitionsClient } from '../services/agentDefinitionsClient'
import { createWorkflowDefinitionsClient } from '../services/workflowDefinitionsClient'
import { createIntegrationPlatformClient } from '../services/integrationPlatformClient'
import { confirmNavigation, registerNavigationGuard } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'
import { AgentDefinitionsWorkspace } from './agentDefinitions/AgentDefinitionsWorkspace'
import type { AgentEditorCatalogs } from './agentDefinitions/client'
import { WorkflowsWorkspace } from './workflows/WorkflowsWorkspace'
import type { WorkflowEditorCatalogs, WorkflowLeaveGuard } from './workflows/client'
import { AgentsPanel } from './AgentsPanel'
import './agentsWorkspace.css'

const emptyCatalogs = (): AgentEditorCatalogs => ({ providers: [], skills: [], mcpServers: [], builtinTools: [], childDefinitions: [], browserWorkspaces: [] })

/** The app's Agents destination: reusable definitions and editable workflows. */
export function AgentsWorkspace({ active = true }: { active?: boolean }) {
  const profileId = useAppStore((state) => state.profileId)
  return <ProfileAgentsWorkspace key={profileId} profileId={profileId} active={active} />
}

function ProfileAgentsWorkspace({ profileId, active }: { profileId: string; active: boolean }) {
  const [tab, setTab] = useState<'agents' | 'workflows'>('agents')
  const [catalogs, setCatalogs] = useState<AgentEditorCatalogs>(emptyCatalogs)
  const [subworkflows, setSubworkflows] = useState<WorkflowEditorCatalogs['subworkflows']>([])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const workflowGuard = useRef<WorkflowLeaveGuard | null>(null)
  const reveal = useCallback(() => {
    useAppStore.getState().setMainAreaOpen(true)
    useAppStore.getState().setMainView('agents')
  }, [])
  const agents = useAppStore((state) => state.agents)
  const clients = useMemo(() => ({
    agents: createAgentDefinitionsClient(window.mousse.platformRequest),
    workflows: createWorkflowDefinitionsClient(window.mousse.platformRequest),
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
      if (focus) document.getElementById(next === 'agents' ? 'agent-definitions-tab' : 'workflow-definitions-tab')?.focus()
    }
  }
  const workflowCatalogs: WorkflowEditorCatalogs = {
    ...catalogs, subworkflows,
    models: catalogs.providers.flatMap((provider) => provider.models.map((model) => ({ providerId: provider.id, modelId: model.id, label: model.label, available: true })))
  }
  return <section className="agents-workspace" aria-label="Agents and workflows" data-agents-workspace="" data-profile-id={profileId}>
    <header className="agents-workspace__header">
      <nav role="tablist" aria-label="Agents sections" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        void selectTab(event.key === 'Home' ? 'agents' : event.key === 'End' ? 'workflows' : tab === 'agents' ? 'workflows' : 'agents', true)
      }}>
        <button type="button" role="tab" id="agent-definitions-tab" tabIndex={tab === 'agents' ? 0 : -1} aria-controls="agent-definitions-pane" aria-selected={tab === 'agents'} onClick={() => void selectTab('agents')}><Bot size={15} /> Agents</button>
        <button type="button" role="tab" id="workflow-definitions-tab" tabIndex={tab === 'workflows' ? 0 : -1} aria-controls="workflow-definitions-pane" aria-selected={tab === 'workflows'} onClick={() => void selectTab('workflows')}><Workflow size={15} /> Workflows</button>
      </nav>
      <button type="button" className="btn btn-sm" disabled={refreshing} onClick={() => void load(true)} title="Refresh installed skills and connect configured MCP servers to discover tools"><RefreshCw size={13} /> {refreshing ? 'Refreshing…' : 'Refresh tools'}</button>
    </header>
    {error && <p className="agents-workspace__error" role="alert">{error}</p>}
    {tab === 'agents' ? <div className="agents-workspace__pane" role="tabpanel" id="agent-definitions-pane" aria-labelledby="agent-definitions-tab">
      <AgentDefinitionsWorkspace profileId={profileId} client={clients.agents} catalogs={catalogs} active={active} onRequestAttention={reveal} activeRunsSlot={agents.length > 0 ? <details className="agents-workspace__runs"><summary>Active agents and terminals ({agents.length})</summary><div><AgentsPanel /></div></details> : undefined} />
    </div> : <div className="agents-workspace__pane" role="tabpanel" id="workflow-definitions-pane" aria-labelledby="workflow-definitions-tab">
      <WorkflowsWorkspace profileId={profileId} client={clients.workflows} catalogs={workflowCatalogs} agentDefinitions={clients.agents} active={active} onRegisterLeaveGuard={registerWorkflowGuard} />
    </div>}
  </section>
}
