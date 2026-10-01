import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkflowsWorkspace } from '../../../src/renderer/components/workflows/WorkflowsWorkspace'
import type { WorkflowEditorCatalogs, WorkflowStartRequest } from '../../../src/renderer/components/workflows/client'
import { IsolatedWorkflowDefinitionsClient, IsolatedWorkflowExecutionClient } from './workflow-editor-client'
import { createBlankWorkflowBundle } from '../../../src/renderer/components/workflows/templates'

const style = document.createElement('style')
style.textContent = `
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; }
  body { background: #101216; color: #eff0f6; font-family: 'Segoe UI', sans-serif; }
  .btn { border: 1px solid #ffffff22; background: #1f242f; color: #e1e8fa; border-radius: 7px; padding: 7px 14px; }
  .btn-primary { background: #365abd; border-color: #365abd; }
  .btn-sm { padding: 5px 10px; font-size: 12px; }
  .btn-danger { background: #7a303c; }
  .search-input-row { display: flex; gap: 6px; align-items: center; }
  .modal-overlay { position: fixed; inset: 0; background: #0008; display: grid; place-items: center; z-index: 20; }
  .modal { background: #1a1d24; border: 1px solid #ffffff22; border-radius: 12px; min-width: 360px; padding: 16px; max-height: 90vh; overflow: auto; }
  .fixture-host { height: 100%; display: flex; flex-direction: column; }
  .fixture-bar { flex: 0 0 auto; display: flex; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #ffffff14; font-size: 12px; }
  .fixture-bar button { font: inherit; }
  .fixture-main { flex: 1; min-height: 0; }
`
document.head.appendChild(style)

const CATALOGS: WorkflowEditorCatalogs = {
  skills: [{ id: 'review', name: 'Review', available: true, revision: '1' }],
  mcpServers: [{ serverId: 'docs', name: 'Docs', tools: [{ toolName: 'lookup', available: true }] }],
  builtinTools: [
    { id: 'read', label: 'read' },
    { id: 'grep', label: 'grep' }
  ],
  subworkflows: [],
  browserWorkspaces: [{ id: 'ws-1', name: 'Research' }]
}

// Explicit fixture-only observations; this page never starts a host workflow.
const starts: WorkflowStartRequest[] = []
Object.assign(window, { workflowFixtureStarts: starts })
class ObservedExecution extends IsolatedWorkflowExecutionClient {
  async start(query: WorkflowStartRequest) {
    starts.push(structuredClone(query))
    await new Promise((resolve) => setTimeout(resolve, 250))
    return super.start(query)
  }
}

function Preview() {
  const definitions = useMemo(() => {
    const client = new IsolatedWorkflowDefinitionsClient()
    client.catalogs = CATALOGS
    return client
  }, [])
  const execution = useMemo(() => new ObservedExecution(), [])
  const [profileId, setProfileId] = useState('profile-a')
  const [ready, setReady] = useState(false)
  const [active, setActive] = useState(true)

  useEffect(() => {
    const unsupported = createBlankWorkflowBundle('Unsupported node')
    unsupported.manifest.nodes.push({
      id: 'future',
      type: 'quantum-gate',
      version: 1,
      config: { preserve: true, original: { vendor: 'future' } }
    })
    definitions.seed('profile-a', unsupported, { tags: ['broken'] })
    const other = createBlankWorkflowBundle('Other profile workflow')
    definitions.seed('profile-b', other, { tags: ['other'] })
    setReady(true)
  }, [definitions])

  if (!ready) return <div>Seeding fixture…</div>
  return (
    <div className="fixture-host">
      <div className="fixture-bar">
        <span>Workflow editor fixture</span>
        <button type="button" data-fixture="profile-a" onClick={() => setProfileId('profile-a')}>
          Profile A
        </button>
        <button type="button" data-fixture="profile-b" onClick={() => setProfileId('profile-b')}>
          Profile B
        </button>
        <button type="button" data-fixture="toggle-active" onClick={() => setActive((value) => !value)}>
          Toggle hidden
        </button>
        <span id="fixture-profile">{profileId}</span>
      </div>
      <div className="fixture-main">
        <WorkflowsWorkspace
          profileId={profileId}
          client={definitions}
          catalogs={CATALOGS}
          execution={execution}
          active={active}
          activeRunsSlot={<span data-active-runs="">Active runs slot</span>}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
