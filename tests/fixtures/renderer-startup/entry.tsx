import { useAppStore } from '../../../src/renderer/stores/appStore'
import { getDefaultSettings } from '../../../src/shared/settings'

// I hold the real profile switcher's bootstrap replies while the actual root
// mounts in StrictMode. The UI port is controlled; no daemon or credentials run.
const calls: Array<{ method: string; params?: unknown; input?: unknown }> = []
const errors: string[] = []
const profile = { id: 'prf_startup-bound', displayName: 'Startup profile', isDefault: true, revision: 1 }
let finishList!: (value: unknown) => void, finishStatus!: (value: unknown) => void
const list = new Promise(done => { finishList = done })
const status = new Promise(done => { finishStatus = done })
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))

function api(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      if (path.length === 0 && key === 'platform') return 'win32'
      return api([...path, String(key)])
    },
    apply(_target, _this, args) {
      const method = path.join('.')
      if (path.at(-1)?.startsWith('on')) return () => {}
      calls.push({ method, ...(args.length ? { params: args[0] } : {}), ...(args.length > 1 ? { input: args[1] } : {}) })
      if (method === 'profiles.list') return list
      if (method === 'profiles.status') return status
      if (method === 'window.isMaximized') return Promise.resolve(false)
      if (method === 'settings.get') return Promise.resolve(getDefaultSettings())
      if (method === 'app.getInfo') return Promise.resolve({ platform: 'win32' })
      if (method === 'threads.getActivity' || method === 'turn.getSnapshot') return Promise.resolve({})
      if (method === 'threads.listAll') return Promise.resolve([])
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
  bind: () => {
    finishList({ profiles: [profile], defaultProfileId: profile.id })
    finishStatus({ binding: { profileId: profile.id } })
  },
  ready: () => useAppStore.getState().profileReady,
  profile: () => useAppStore.getState().profileId
}
void import('../../../src/renderer/main')
