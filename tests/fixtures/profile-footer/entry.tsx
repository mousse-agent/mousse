import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ProfileSwitcher } from '../../../src/renderer/components/profiles/ProfileSwitcher'
import { ChatsSidebar } from '../../../src/renderer/components/chats/ChatsSidebar'
import { useAppStore } from '../../../src/renderer/stores/appStore'
import '../../../src/renderer/styles/app.css'
import '../../../src/renderer/styles/sentence-case.css'
import '../../../src/renderer/styles/geist-fonts.css'
import { XTERM_FONT } from '../../../src/renderer/lib/xtermTheme'

const alpha = { id: 'prf_alpha', displayName: 'Adithya', status: 'active', isDefault: true, revision: 1, color: '#4d6088' }
const beta = { id: 'prf_beta', displayName: 'Studio', status: 'active', isDefault: false, revision: 1, color: '#604880', avatar: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24"%3E%3Crect width="24" height="24" fill="purple"/%3E%3C/svg%3E' }
let bound = alpha.id
const requests: Array<{ profile: string; resolve: (value: unknown) => void }> = []
const errors: string[] = []
const binds: string[] = []
const updates: Array<{ id: string; displayName: string }> = []
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
;(window as any).mousse = {
  profiles: {
    list: () => new Promise(done => requests.push({ profile: bound, resolve: done })),
    status: async () => ({ binding: { profileId: bound, epoch: 1 } }),
    bind: async (id: string) => { bound = id; binds.push(id); return { profile: id === beta.id ? beta : alpha, epoch: 2 } },
    update: async (id: string, _revision: number, patch: { displayName: string }) => {
      updates.push({ id, displayName: patch.displayName })
      return { profile: { ...(id === beta.id ? beta : alpha), ...patch, revision: 2 } }
    }
  }
}
useAppStore.getState().activateProfile(alpha.id)
;(window as any).footerQa = {
  requests, binds, updates, errors,
  release: (id: string, stale = false) => {
    const selected = requests.filter(request => request.profile === id)
    for (const request of selected) {
      requests.splice(requests.indexOf(request), 1)
      request.resolve({ defaultProfileId: alpha.id, profiles: stale ? [{ ...alpha, displayName: 'Old profile' }, { ...beta, displayName: 'Stale studio' }] : [alpha, beta] })
    }
  },
  refresh: () => window.dispatchEvent(new Event('mousse:profiles-changed')),
  profile: () => useAppStore.getState().profileId,
  externalSwitch: () => { bound = alpha.id; useAppStore.getState().activateProfile(alpha.id) },
  terminalFont: XTERM_FONT
}
createRoot(document.getElementById('root')!).render(<StrictMode><div className="app">
  <ChatsSidebar />
  <ProfileSwitcher variant="sidebar" onSwitched={profile => useAppStore.getState().activateProfile(profile.id)} />
  <pre><code data-font-sample>let answer = 42</code></pre>
</div></StrictMode>)
