import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { IntegrationsWorkspace } from '../../../src/renderer/components/integrations'
import { IsolatedIntegrationPlatformClient } from './integration-editor-client'
import { confirmNavigation } from '../../../src/renderer/services/navigationGuards'

const style = document.createElement('style')
style.textContent = `*{box-sizing:border-box}html,body,#root{height:100%;margin:0}body{background:#101216;color:#eff0f6;font-family:'Segoe UI',sans-serif}.btn{border:1px solid #ffffff22;background:#1f242f;color:#e1e8fa;border-radius:7px;padding:7px 12px}.btn-primary{background:#365abd;border-color:#365abd}.btn-sm{padding:5px 10px;font-size:12px}.fixture-host{height:100%;display:flex;flex-direction:column}.fixture-bar{display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid #ffffff14;font-size:12px}.fixture-main{flex:1;min-height:0}.monaco-editor{min-height:250px}`
document.head.appendChild(style)
document.documentElement.style.colorScheme = 'dark'

function Preview() {
  const client = useMemo(() => {
    const value = new IsolatedIntegrationPlatformClient()
    Object.assign(window, { integrationFixture: value })
    return value
  }, [])
  const [profileId, setProfileId] = useState('profile-a')
  const switchProfile = async (next: string) => { if (await confirmNavigation('profile')) setProfileId(next) }
  return <div className="fixture-host"><div className="fixture-bar"><span>Integration editor fixture</span><button type="button" data-fixture="profile-a" onClick={() => void switchProfile('profile-a')}>Profile A</button><button type="button" data-fixture="profile-b" onClick={() => void switchProfile('profile-b')}>Profile B</button><span id="fixture-profile">{profileId}</span></div><div className="fixture-main"><IntegrationsWorkspace profileId={profileId} client={client} initialTab="skills" /></div></div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
