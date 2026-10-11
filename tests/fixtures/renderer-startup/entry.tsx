import { useAppStore } from '../../../src/renderer/stores/appStore'
import { getDefaultSettings } from '../../../src/shared/settings'
import { applyAppearance } from '../../../src/renderer/hooks/useTheme'
import '../../../src/renderer/styles/settings.css'
import '../../../src/renderer/styles/scheduled-panel.css'

// I hold the real profile switcher's bootstrap replies while the actual root
// mounts in StrictMode. The UI port is controlled; no daemon or credentials run.
const calls: Array<{ method: string; params?: unknown; input?: unknown }> = []
const errors: string[] = []
const profile = { id: 'prf_startup-bound', displayName: 'Startup profile', isDefault: true, revision: 1 }
const appearance = { ...getDefaultSettings().appearance, theme: 'dark-modern' as const, acrylic: false }
let finishList!: (value: unknown) => void, finishStatus!: (value: unknown) => void
let failList!: (reason: Error) => void, failStatus!: (reason: Error) => void
let list: Promise<unknown>, status: Promise<unknown>
const resetBootstrap = () => {
  list = new Promise((done, fail) => { finishList = done; failList = fail })
  status = new Promise((done, fail) => { finishStatus = done; failStatus = fail })
}
resetBootstrap()
const listeners = new Map<string, Set<(...args: any[]) => void>>()
let finishHydration!: () => void
const hydration = new Promise<void>(done => { finishHydration = done })
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))

function api(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      if (path.length === 0 && key === 'platform') return 'win32'
      if (path.length === 0 && key === 'startupAppearance') return appearance
      return api([...path, String(key)])
    },
    apply(_target, _this, args) {
      const method = path.join('.')
      if (path.at(-1)?.startsWith('on')) {
        const subscriptions = listeners.get(method) ?? new Set()
        listeners.set(method, subscriptions)
        subscriptions.add(args[0])
        return () => subscriptions.delete(args[0])
      }
      calls.push({ method, ...(args.length ? { params: args[0] } : {}), ...(args.length > 1 ? { input: args[1] } : {}) })
      if (method === 'profiles.list') return list
      if (method === 'profiles.status') return status
      if (method === 'window.isMaximized') return Promise.resolve(false)
      if (method === 'settings.get') return Promise.resolve({ ...getDefaultSettings(), appearance })
      if (method === 'app.getInfo') return Promise.resolve({ platform: 'win32' })
      if (method === 'threads.getActivity' || method === 'turn.getSnapshot') return Promise.resolve({})
      if (method === 'threads.listAll') return Promise.resolve([])
      if (method === 'threads.initialize') return hydration
      if (method === 'channels.getSnapshot') return Promise.reject(new Error('Controlled channels unavailable'))
      if (method === 'channels.listPairingRequests' || method === 'channels.getActivity') return Promise.resolve([])
      if (method === 'platformRequest.request') {
        const [name, params] = args
        if (name === 'chats.snapshot') return Promise.resolve({ chats: [], agents: [], devices: [] })
        if (name === 'browser.access.status') {
          if (params.profileId !== profile.id) return Promise.reject(new Error('profile_mismatch'))
          return Promise.resolve({ allowed: false, pending: [] })
        }
        return Promise.reject(new Error(`Unexpected platform method: ${name}`))
      }
      return Promise.resolve(undefined)
    }
  })
}
;(window as any).mousse = api()
;(window as any).qa = {
  calls, errors,
  fail: () => {
    failList(new Error('Controlled workspace service unavailable'))
    failStatus(new Error('Controlled workspace service unavailable'))
    resetBootstrap()
  },
  bind: () => {
    finishList({ profiles: [profile], defaultProfileId: profile.id })
    finishStatus({ binding: { profileId: profile.id } })
  },
  ready: () => useAppStore.getState().profileReady,
  openBrowser: () => {
    useAppStore.getState().addBrowserTab(null)
    useAppStore.getState().openSurfaceKind('browser')
  },
  profile: () => useAppStore.getState().profileId,
  workspaceReady: () => useAppStore.getState().workspaceReady,
  acrylic: (theme: 'blacksphere-plus' | 'dark-modern' | 'light', intensity: number) => {
    applyAppearance({ ...appearance, theme, acrylic: true, acrylicIntensity: intensity })
  },
  overlay: (page: 'settings' | 'scheduled' | 'channels', open: boolean) => {
    const store = useAppStore.getState()
    if (page === 'settings') store.setSettingsOpen(open)
    else if (page === 'scheduled') store.setScheduledOpen(open)
    else store.setChannelsOpen(open)
  },
  hydrate: () => {
    for (const listener of listeners.get('orchestrator.onThreadMessages') ?? []) {
      listener({ threadId: '__unbound__', messages: [] })
    }
    finishHydration()
  }
}
void import('../../../src/renderer/main')
