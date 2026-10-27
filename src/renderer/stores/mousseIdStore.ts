import { useEffect } from 'react'
import { create } from 'zustand'
import type { PlusConfiguration, PlusStatus } from '../../shared/net/local'
import type { NetStatus } from '../../shared/net'
import type { PlatformRequestMethod } from '../../shared/platform'
import {
  createWakeableSleep,
  mousseIdPreparation,
  mousseIdSetupStep,
  signInErrorMessage,
  DEFAULT_MOUSSE_ID_ORIGIN,
  pollPlusSignIn,
  PlusSignInError,
  resolvePlusOrigin,
  withSignInCallback
} from '../lib/plusSignIn'
import { useAppStore } from './appStore'

export interface PendingSignIn {
  id: string
  userCode: string
  verificationUri: string
  expiresAt: number
  pollIntervalMs?: number
}

export type SignInStart = 'started' | 'needs-setup' | 'no-service' | 'failed'

interface MousseIdState {
  /** Mousse profile the status below belongs to. */
  profileId: string | null
  loaded: boolean
  plus?: PlusStatus
  net?: NetStatus
  /** Runtime `MOUSSE_ID_ORIGIN` from the main process. */
  runtimeOrigin: string
  pending?: PendingSignIn
  busy: boolean
  error: string
  refresh: () => Promise<void>
  /** Reads the account's device count from Mousse ID; the status itself does not carry it. */
  loadDevices: () => Promise<void>
  signIn: () => Promise<SignInStart>
  cancelSignIn: () => void
  signOut: () => Promise<void>
}

const request = <T,>(method: PlatformRequestMethod, params: unknown = {}) =>
  window.mousse.platformRequest.request<T>(method, params)
const message = (cause: unknown) => String((cause as Error | null)?.message ?? cause)
const errorCode = (cause: unknown) => (cause as { code?: unknown } | null)?.code

export { mousseIdPreparation, mousseIdSetupStep, signInErrorMessage }

/** The service this window signs in to: runtime `MOUSSE_ID_ORIGIN`, then the build value. */
export const mousseIdOrigin = (state: Pick<MousseIdState, 'runtimeOrigin'>): string =>
  resolvePlusOrigin(state.runtimeOrigin, DEFAULT_MOUSSE_ID_ORIGIN)

/**
 * Mousse ID exists in this window only when a service address is set, at build time or with
 * `MOUSSE_ID_ORIGIN` at launch. Without one, no account UI is shown and no account status is read.
 */
export const mousseIdAvailable = (state: Pick<MousseIdState, 'runtimeOrigin'>): boolean =>
  mousseIdOrigin(state) !== ''

/** Name shown for a signed-in account. Mousse ID has no display name yet, so it comes from the email. */
export function mousseIdName(plus?: PlusStatus): string {
  const local = plus?.email?.split('@')[0]?.trim()
  return local || 'Mousse ID'
}

/** "3 of 5 devices", or nothing until Mousse ID has reported the count. */
export function devicesLine(plus?: PlusStatus): string | undefined {
  const devices = plus?.devices
  if (!plus?.connected || !devices) return undefined
  return `${devices.used} of ${devices.limit} ${devices.limit === 1 ? 'device' : 'devices'}`
}

let current: { controller: AbortController; callbackId?: string } | undefined
let refreshing: { profileId: string; promise: Promise<void> } | undefined
let runtimeOriginLoad: Promise<void> | undefined

/** Reads the launch-time `MOUSSE_ID_ORIGIN` from the main process once per window. */
function loadRuntimeOrigin(): Promise<void> {
  return (runtimeOriginLoad ??= (async () => {
    const config = await window.mousse.mousseId?.config().catch(() => undefined)
    if (config?.origin) useMousseIdStore.setState({ runtimeOrigin: config.origin })
  })())
}

/** Creates the network identity, turns networking on and protects keys with the OS keychain as needed. */
async function prepareNetworking(net: NetStatus | undefined, name: string): Promise<NetStatus> {
  let status = net
  if (!status?.self || !status.enabled) status = await request<NetStatus>('net.init', status?.self ? {} : { name })
  if (!status.protected) status = await request<NetStatus>('net.protect', {})
  return status
}

const stopCallback = (id?: string) => {
  if (id) void window.mousse.mousseId?.cancelCallback(id).catch(() => undefined)
}

export const useMousseIdStore = create<MousseIdState>((set, get) => ({
  profileId: null,
  loaded: false,
  runtimeOrigin: '',
  busy: false,
  error: '',

  refresh: () => {
    const profileId = useAppStore.getState().profileId
    if (refreshing?.profileId === profileId) return refreshing.promise
    if (get().profileId !== profileId) {
      // Account state never crosses a Mousse profile boundary.
      current?.controller.abort()
      stopCallback(current?.callbackId)
      current = undefined
      set({ profileId, loaded: false, plus: undefined, net: undefined, pending: undefined, error: '', busy: false })
    }
    const entry = { profileId, promise: Promise.resolve() }
    refreshing = entry
    entry.promise = (async () => {
      await Promise.resolve()
      try {
        await loadRuntimeOrigin()
        const [net, plus] = await Promise.all([
          request<NetStatus>('net.status'),
          mousseIdAvailable(get()) ? request<PlusStatus>('net.plus.status') : undefined
        ])
        if (useAppStore.getState().profileId === profileId) {
          // The device count comes from loadDevices; keep it for the same account until it is read again.
          const before = get().plus
          const keep = plus?.connected && before?.devices && before.accountId === plus.accountId
          set({ net, plus: keep ? { ...plus, devices: before.devices } : plus, loaded: true })
        }
      } catch {
        if (useAppStore.getState().profileId === profileId) set({ loaded: true })
      } finally {
        if (refreshing === entry) refreshing = undefined
      }
    })()
    return entry.promise
  },

  loadDevices: async () => {
    const profileId = useAppStore.getState().profileId
    if (!get().plus?.connected) return
    try {
      const { devices } = await request<PlusStatus>('net.plus.inventory')
      const plus = get().plus
      if (devices && plus?.connected && get().profileId === profileId) set({ plus: { ...plus, devices } })
    } catch {
      // The count is a nicety: an unreachable or older service just leaves the line out.
    }
  },

  signIn: async () => {
    if (current) return 'started'
    const origin = mousseIdOrigin(get())
    if (!origin) return 'no-service'
    if (!get().loaded) await get().refresh()
    if (mousseIdPreparation(get().net) === 'manual') return 'needs-setup'
    const profileId = get().profileId
    const controller = new AbortController()
    current = { controller }
    set({ busy: true, error: '' })
    const deviceName = (await window.mousse.app?.getInfo().catch(() => undefined))?.deviceName?.trim() || 'My device'
    let net = get().net
    if (mousseIdPreparation(net) === 'automatic') {
      try {
        net = await prepareNetworking(net, deviceName)
      } catch (cause) {
        if (current?.controller === controller) current = undefined
        const conflict = errorCode(cause) === 'conflict'
        set({
          busy: false,
          error: conflict ? ''
            : errorCode(cause) === 'keystore_locked'
              ? 'This computer has no system keychain to protect network keys. Set a passphrase under Devices, then sign in.'
              : `Couldn’t turn on networking: ${message(cause)}`
        })
        await get().refresh()
        // A profile waiting to join another device's network is set up under Devices.
        return conflict ? 'needs-setup' : 'failed'
      }
      if (get().profileId === profileId) set({ net })
    }
    void (async () => {
      let callbackId: string | undefined
      try {
        const configuration = await request<Omit<PlusConfiguration, 'accountId'>>('net.plus.discover', { apiOrigin: origin })
        const begin = {
          configuration,
          deviceName,
          bindRoot: !!net?.self?.isAuthority
        }
        const pending = await request<PendingSignIn>('net.plus.login.begin', begin).catch(async (cause: unknown) => {
          // An earlier sign-in that was never finished blocks a new one; replace it.
          if (errorCode(cause) !== 'conflict') throw cause
          await request('net.plus.login.cancel')
          return request<PendingSignIn>('net.plus.login.begin', begin)
        })
        if (controller.signal.aborted) throw new PlusSignInError('cancelled', 'Sign-in cancelled.')
        // The approval page sends the browser back here; polling still covers browsers that can't.
        const callback = await window.mousse.mousseId?.startCallback().catch(() => undefined)
        callbackId = callback?.id
        current = { controller, callbackId }
        const { sleep, wake } = createWakeableSleep()
        if (callback) {
          void window.mousse.mousseId!.waitCallback(callback.id)
            .then((result) => { if (result === 'approved' || result === 'denied') wake() })
            .catch(() => undefined)
        }
        set({ pending })
        // The main process opens new windows in the system browser.
        window.open(withSignInCallback(pending.verificationUri, callback?.url), '_blank', 'noopener,noreferrer')
        await pollPlusSignIn(() => request<PlusStatus>('net.plus.login.finish', { id: pending.id }), {
          intervalMs: pending.pollIntervalMs ?? 2000,
          expiresAt: pending.expiresAt,
          signal: controller.signal,
          sleep
        })
      } catch (cause) {
        if (!(cause instanceof PlusSignInError && cause.code === 'cancelled') && get().profileId === profileId)
          set({ error: signInErrorMessage(cause, origin, get().net) })
      } finally {
        stopCallback(callbackId)
        if (current?.controller === controller) current = undefined
        if (get().profileId === profileId) {
          set({ pending: undefined, busy: false })
          await get().refresh()
        }
      }
    })()
    return 'started'
  },

  cancelSignIn: () => {
    const active = current
    current = undefined
    active?.controller.abort()
    stopCallback(active?.callbackId)
    set({ pending: undefined, busy: false })
    void request('net.plus.login.cancel').catch(() => undefined)
  },

  signOut: async () => {
    set({ busy: true, error: '' })
    try {
      await request('net.plus.disconnect')
    } catch (cause) {
      set({ error: message(cause) })
    } finally {
      set({ busy: false })
      await get().refresh()
    }
  }
}))

/** True when this window has a Mousse ID service; see {@link mousseIdAvailable}. */
export function useMousseIdAvailable(): boolean {
  const available = useMousseIdStore(mousseIdAvailable)
  useEffect(() => {
    void loadRuntimeOrigin()
  }, [])
  return available
}

/** Keeps the Mousse ID status fresh while a component that shows it is mounted. */
export function useMousseId(enabled = true): MousseIdState {
  const state = useMousseIdStore()
  const profileId = useAppStore((s) => s.profileId)
  useEffect(() => {
    if (!enabled) return
    const refresh = () => void useMousseIdStore.getState().refresh()
    refresh()
    window.addEventListener('focus', refresh)
    const timer = setInterval(refresh, 60_000)
    return () => {
      window.removeEventListener('focus', refresh)
      clearInterval(timer)
    }
  }, [profileId, enabled])
  return state
}
