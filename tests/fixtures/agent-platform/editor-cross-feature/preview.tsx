import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentDefinitionsWorkspace } from '../../../../src/renderer/components/agentDefinitions/AgentDefinitionsWorkspace'
import { WorkflowsWorkspace } from '../../../../src/renderer/components/workflows/WorkflowsWorkspace'
import { createAgentDefinitionsClient } from '../../../../src/renderer/services/agentDefinitionsClient'
import { createWorkflowDefinitionsClient } from '../../../../src/renderer/services/workflowDefinitionsClient'
import { TryRunPanel } from '../../../../src/renderer/components/agentDefinitions/TryRunPanel'
import type { AgentDefinitionRecord } from '../../../../src/shared/agents/types'
import type { AgentEditorCatalogs } from '../../../../src/renderer/components/agentDefinitions/client'
import type { WorkflowEditorCatalogs } from '../../../../src/renderer/components/workflows/client'

declare global {
  interface Window {
    editorBridge: {
      config: { profileId: string; providerId: string; providerLabel: string; modelId: string; modelLabel: string; phase: 'edit' | 'run'; agentId?: string }
      request<T>(method: string, params?: unknown): Promise<T>
    }
  }
}

const style = document.createElement('style')
style.textContent = `*{box-sizing:border-box}html,body,#root{height:100%;margin:0}body{background:#101216;color:#eff0f6;font-family:Segoe UI,sans-serif}.btn{border:1px solid #ffffff22;background:#1f242f;color:#e1e8fa;border-radius:7px;padding:7px 14px}.btn-primary{background:#365abd}.btn-sm{padding:5px 10px}.fixture{height:100%;display:flex;flex-direction:column}.fixture-tabs{display:flex;gap:8px;padding:8px;border-bottom:1px solid #ffffff22}.fixture-main{flex:1;min-height:0}.modal-overlay{position:fixed;inset:0;background:#0008;display:grid;place-items:center;z-index:30}.modal{background:#1a1d24;padding:16px}`
document.head.appendChild(style)

const cfg = window.editorBridge.config
const transport = { request: <T,>(method: string, params?: unknown) => window.editorBridge.request<T>(method, params) }
const agents = createAgentDefinitionsClient(transport as never)
const workflows = createWorkflowDefinitionsClient(transport as never)
const agentCatalogs: AgentEditorCatalogs = {
  providers: [{ id: cfg.providerId, label: cfg.providerLabel, models: [{ id: cfg.modelId, label: cfg.modelLabel }] }],
  skills: [], mcpServers: [], builtinTools: [], childDefinitions: [], browserWorkspaces: []
}
const workflowCatalogs: WorkflowEditorCatalogs = { skills: [], mcpServers: [], builtinTools: [], subworkflows: [], browserWorkspaces: [] }

function Preview() {
  const [view, setView] = useState<'agents' | 'workflows'>(cfg.phase === 'run' ? 'agents' : 'agents')
  const ports = useMemo(() => ({ agents, workflows }), [])
  return <div className="fixture">
    <nav className="fixture-tabs">
      <button className="btn" data-fixture="agents" onClick={() => setView('agents')}>Agents</button>
      <button className="btn" data-fixture="workflows" onClick={() => setView('workflows')}>Workflows</button>
      <span data-fixture-profile={cfg.profileId}>{cfg.profileId}</span>
    </nav>
    <main className="fixture-main">
      {view === 'agents'
        ? <AgentDefinitionsWorkspace profileId={cfg.profileId} client={ports.agents} catalogs={agentCatalogs} active activeRunsSlot={<span data-active-runs="">Active runs</span>} />
        : <WorkflowsWorkspace profileId={cfg.profileId} client={ports.workflows} catalogs={workflowCatalogs} active activeRunsSlot={<span data-active-runs="">Active runs</span>} />}
    </main>
  </div>
}

function RunFixture() {
  const [record, setRecord] = useState<AgentDefinitionRecord | null>(null)
  useEffect(() => { void agents.get({ profileId: cfg.profileId, id: cfg.agentId! }).then(setRecord) }, [])
  if (!record) return <div role="status">Loading persisted agent…</div>
  return <main data-run-fixture="" style={{ padding: 20 }}>
    <h1 data-agent-summary={record.id}>{record.settings.identity.name}</h1>
    <p>{record.settings.primaryModel.ref.providerId}/{record.settings.primaryModel.ref.modelId}</p>
    <TryRunPanel profileId={cfg.profileId} id={record.id} expectedDraftHash={record.draftHash} client={agents} />
    <output id="appearance-value" hidden>{JSON.stringify(record.visual)}</output>
  </main>
}
createRoot(document.getElementById('root')!).render(cfg.phase === 'run' ? <RunFixture /> : <Preview />)
