import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentDefinitionsWorkspace } from '../../../src/renderer/components/agentDefinitions/AgentDefinitionsWorkspace'
import type { AgentEditorCatalogs } from '../../../src/renderer/components/agentDefinitions/client'
import { IsolatedAgentDefinitionsClient } from './agent-editor-client'
import { confirmNavigation } from '../../../src/renderer/services/navigationGuards'

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
  .modal-overlay { position: fixed; inset: 0; background: #0008; display: grid; place-items: center; }
  .modal { background: #1a1d24; border: 1px solid #ffffff22; border-radius: 12px; min-width: 360px; padding: 16px; }
  .fixture-host { height: 100%; display: flex; flex-direction: column; }
  .fixture-bar { flex: 0 0 auto; display: flex; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #ffffff14; font-size: 12px; }
  .fixture-bar button { font: inherit; }
  .fixture-main { flex: 1; min-height: 0; }
`
document.head.appendChild(style)

const CATALOGS: AgentEditorCatalogs = {
  providers: [
    {
      id: 'xai',
      label: 'xAI',
      models: [{ id: 'grok-4', label: 'Grok 4', efforts: ['low', 'high'] }]
    }
  ],
  skills: [{ id: 'review', name: 'Review', available: true, revision: '1' }],
  mcpServers: [{ serverId: 'docs', name: 'Docs', tools: [{ toolName: 'lookup', available: true }] }],
  builtinTools: [
    { id: 'read', label: 'read' },
    { id: 'grep', label: 'grep' }
  ],
  childDefinitions: [],
  browserWorkspaces: [{ id: 'ws-1', name: 'Research' }]
}

function Preview() {
  const client = useMemo(() => new IsolatedAgentDefinitionsClient(), [])
  const [profileId, setProfileId] = useState('profile-a')
  const [ready, setReady] = useState(false)
  const [active, setActive] = useState(true)

  useEffect(() => {
    void (async () => {
      const missing = await client.create({
        profileId: 'profile-a',
        settings: {
          identity: { name: 'Unavailable model', slug: 'unavailable-model', purpose: 'Broken catalog ref', tags: ['broken'] },
          primaryModel: { ref: { providerId: 'xai', modelId: 'removed-model' }, capabilityOverrides: {} }
        },
        systemPrompt: 'Keep this prompt.'
      })
      ;(window as unknown as { __missingId: string }).__missingId = missing.id
      await client.create({
        profileId: 'profile-b',
        settings: { identity: { name: 'Other profile agent', slug: 'other-profile', purpose: '', tags: [] } }
      })
      setReady(true)
    })()
  }, [client])

  if (!ready) return <div>Seeding fixture…</div>
  return (
    <div className="fixture-host">
      <div className="fixture-bar">
        <span>Agent editor fixture</span>
        <button type="button" data-fixture="profile-a" onClick={() => { void confirmNavigation('profile').then((allowed) => { if (allowed) setProfileId('profile-a') }) }}>
          Profile A
        </button>
        <button type="button" data-fixture="profile-b" onClick={() => { void confirmNavigation('profile').then((allowed) => { if (allowed) setProfileId('profile-b') }) }}>
          Profile B
        </button>
        <button type="button" data-fixture="toggle-active" onClick={() => setActive((value) => !value)}>
          Toggle hidden
        </button>
        <span id="fixture-profile">{profileId}</span>
      </div>
      <div className="fixture-main">
        <AgentDefinitionsWorkspace
          profileId={profileId}
          client={client}
          catalogs={CATALOGS}
          active={active}
          activeRunsSlot={<span data-active-runs="">Active runs slot</span>}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
