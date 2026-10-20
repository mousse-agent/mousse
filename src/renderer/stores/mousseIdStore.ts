import { useEffect } from 'react'
import { create } from 'zustand'
import type { PlusConfiguration, PlusStatus } from '../../mms/net/plus/contracts'
import type { NetStatus } from '../../shared/net'
import type { PlatformRequestMethod } from '../../shared/platform'
import {
  createWakeableSleep,
  DEFAULT_MOUSSE_ID_ORIGIN,
  PLUS_ORIGIN_OVERRIDE_KEY,
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

export type SignInStart = 'started' | 'needs-setup' | 'no-service'

interface MousseIdState {
  /** Mousse profile the status below belongs to. */
  profileId: string | null
  loaded: boolean
  plus?: PlusStatus
  net?: NetStatus
  /** Runtime `MOUSSE_ID_ORIGIN` from the main process. */
  runtimeOrigin: string
  /** Service address set under Advanced in Account settings. */
  override: string
  pending?: PendingSignIn
  busy: boolean
  error: string
  refresh: () => Promise<void>
  signIn: () => Promise<SignInStart>
  cancelSignIn: () => void
  signOut: () => Promise<void>
  setOverride: (value: string) => void
}

const request = <T,>(method: PlatformRequestMethod, params: unknown = {}) =>
  window.mousse.platformRequest.request<T>(method, params)
const message = (cause: unknown) => String((cause as Error | null)?.message ?? cause)
const readOverride = () => {
  try {
    return localStorage.getItem(PLUS_ORIGIN_OVERRIDE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Networking must be on, unlocked and passphrase-protected before Mousse ID can bind it. */
export const mousseIdReady = (net?: NetStatus): boolean =>
  !!net?.enabled && !!net.self && net.keystore === 'unlocked' && !!net.protected

/** What to do first when Mousse ID is not ready yet. */
export function mousseIdSetupStep(net?: NetStatus): string {
  if (!net?.self) return 'Create a network identity under Devices first.'
  if (!net.enabled) return 'Enable networking for this profile under Devices first.'
  if (net.keystore !== 'unlocked') return 'Unlock this profile under Devices first.'
  return 'Protect network keys with a passphrase under Devices first.'
}

/** The service this window signs in to: Advanced override, then runtime env, then build default. */
export const mousseIdOrigin = (state: Pick<MousseIdState, 'override' | 'runtimeOrigin'>): string =>
  resolvePlusOrigin(state.override, resolvePlusOrigin(state.runtimeOrigin, DEFAULT_MOUSSE_ID_ORIGIN))

/** Name shown for a signed-in account. Mousse ID has no display name yet, so it comes from the email. */
export function mousseIdName(plus?: PlusStatus): string {
  const local = plus?.email?.split('@')[0]?.trim()
  return local || 'Mousse ID'
}

let current: { controller: AbortController; callbackId?: string } | undefined
let refreshing: { profileId: string; promise: Promise<void> } | undefined
let runtimeOriginLoaded = false

const stopCallback = (id?: string) => {
  if (id) void window.mousse.mousseId?.cancelCallback(id).catch(() => undefined)
}

export const useMousseIdStore = create<MousseIdState>((set, get) => ({
  profileId: null,
  loaded: false,
  runtimeOrigin: '',
  override: readOverride(),
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
        if (!runtimeOriginLoaded) {
          runtimeOriginLoaded = true
          const config = await window.mousse.mousseId?.config().catch(() => undefined)
          if (config?.origin) set({ runtimeOrigin: config.origin })
        }
        const [net, plus] = await Promise.all([
          request<NetStatus>('net.status'),
          request<PlusStatus>('net.plus.status')
        ])
        if (useAppStore.getState().profileId === profileId) set({ net, plus, loaded: true })
      } catch {
        if (useAppStore.getState().profileId === profileId) set({ loaded: true })
      } finally {
        if (refreshing === entry) refreshing = undefined
      }
    })()
    return entry.promise
  },

  signIn: async () => {
    if (current) return 'started'
    const origin = mousseIdOrigin(get())
    if (!origin) return 'no-service'
    if (!get().loaded) await get().refresh()
    const { net } = get()
    if (!mousseIdReady(net)) return 'needs-setup'
    const profileId = get().profileId
    const controller = new AbortController()
    current = { controller }
    set({ busy: true, error: '' })
    void (async () => {
      let callbackId: string | undefined
      try {
        const configuration = await request<Omit<PlusConfiguration, 'accountId'>>('net.plus.discover', { apiOrigin: origin })
        const pending = await request<PendingSignIn>('net.plus.login.begin', {
          configuration,
          deviceName: (await window.mousse.app?.getInfo().catch(() => undefined))?.deviceName?.trim() || 'My device',
          bindRoot: !!net?.self?.isAuthority
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
          set({ error: message(cause) })
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
  },

  setOverride: (value) => {
    set({ override: value })
    try {
      if (value.trim()) localStorage.setItem(PLUS_ORIGIN_OVERRIDE_KEY, value.trim())
      else localStorage.removeItem(PLUS_ORIGIN_OVERRIDE_KEY)
    } catch {
      // Storage can be unavailable; the value still applies to this window.
    }
  }
}))

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
