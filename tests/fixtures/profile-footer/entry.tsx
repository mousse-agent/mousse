import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ProfileSwitcher } from '../../../src/renderer/components/profiles/ProfileSwitcher'
import { ChatsSidebar } from '../../../src/renderer/components/chats/ChatsSidebar'
import { useAppStore } from '../../../src/renderer/stores/appStore'
import '../../../src/renderer/styles/app.css'
import '../../../src/renderer/styles/sentence-case.css'
import '../../../src/renderer/styles/geist-fonts.css'
import { XTERM_FONT } from '../../../src/renderer/lib/xtermTheme'

// ?scenario=switching holds the profile list back so stale replies can be checked; any other scenario answers at once.
// ?account=none is a build without MOUSSE_ID_ORIGIN, in is signed in to Mousse ID, out is signed out.
// ?profiles=1|2|3 sets how many profiles exist (the switching scenario always has two).
const query = new URLSearchParams(location.search)
const scenario = query.get('scenario') ?? 'switching'
const account = query.get('account') ?? 'none'
const profileCount = scenario === 'switching' ? 2 : Number(query.get('profiles') ?? 2)

const alpha = { id: 'prf_alpha', displayName: 'Adithya', status: 'active', isDefault: true, revision: 1, color: '#4d6088' }
const beta = { id: 'prf_beta', displayName: 'Studio', status: 'active', isDefault: false, revision: 1, color: '#604880', avatar: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24"%3E%3Crect width="24" height="24" fill="purple"/%3E%3C/svg%3E' }
const gamma = { id: 'prf_gamma', displayName: 'Design', status: 'active', isDefault: false, revision: 1, color: '#2f7a6a' }
const roster: Array<typeof alpha & { avatar?: string }> = [alpha, beta, gamma].slice(0, profileCount)
let bound = alpha.id
const requests: Array<{ profile: string; resolve: (value: unknown) => void }> = []
const errors: string[] = []
const binds: string[] = []
const updates: Array<{ id: string; displayName?: string; color?: string | null }> = []
const creates: Array<{ displayName: string; color?: string }> = []
const archives: string[] = []
const confirms: string[] = []
const requestLog: string[] = []
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
window.confirm = (message?: string) => { confirms.push(String(message)); return true }
const find = (id: string) => roster.find(profile => profile.id === id) ?? alpha

const plus = account === 'in'
  ? { configured: true, connected: true, accountId: 'acct_ada', email: 'ada.lovelace@example.com', plan: 'plus' }
  : { configured: false, connected: false }
;(window as any).mousse = {
  ...(account === 'none' ? {} : { mousseId: { config: async () => ({ origin: 'https://id.example' }), startCallback: async () => undefined, cancelCallback: async () => undefined } }),
  platformRequest: {
    request: async (method: string) => {
      requestLog.push(method)
      if (method === 'net.status') return { enabled: false, routes: [], peers: [] }
      if (method === 'net.plus.status') return plus
      if (method === 'net.plus.inventory') return { ...plus, devices: { used: 3, limit: 5 } }
      throw new Error(`unexpected ${method}`)
    }
  },
  profiles: {
    list: () => scenario === 'switching'
      ? new Promise(done => requests.push({ profile: bound, resolve: done }))
      : Promise.resolve({ defaultProfileId: alpha.id, profiles: roster.map(profile => ({ ...profile })) }),
    status: async () => ({ binding: { profileId: bound, epoch: 1 } }),
    bind: async (id: string) => { bound = id; binds.push(id); return { profile: find(id), epoch: 2 } },
    update: async (id: string, _revision: number, patch: { displayName?: string; color?: string | null }) => {
      updates.push({ id, ...patch })
      const next = { ...find(id), ...patch, revision: find(id).revision + 1 } as typeof alpha
      roster[roster.findIndex(profile => profile.id === id)] = next
      return { profile: next }
    },
    create: async (input: { displayName: string; color?: string }) => {
      creates.push(input)
      const next = { id: `prf_new${creates.length}`, status: 'active', isDefault: false, revision: 1, ...input } as typeof alpha
      roster.push(next)
      return { profile: next }
    },
    archive: async (id: string) => {
      archives.push(id)
      const next = { ...find(id), status: 'archived' } as typeof alpha
      roster[roster.findIndex(profile => profile.id === id)] = next
      return { profile: next }
    }
  }
}
useAppStore.getState().activateProfile(alpha.id)
;(window as any).footerQa = {
  requests, binds, updates, creates, archives, confirms, errors, requestLog,
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
  <ProfileSwitcher onSwitched={profile => useAppStore.getState().activateProfile(profile.id)} />
  <pre><code data-font-sample>let answer = 42</code></pre>
</div></StrictMode>)
