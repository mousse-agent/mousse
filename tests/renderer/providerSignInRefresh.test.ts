// @vitest-environment jsdom
/**
 * A sign-in finished in the browser (or a terminal) shows in Settings → Providers without pressing
 * refresh: the page reads the status again by itself while the sign-in is pending, for at most two
 * minutes, and stops once the entry is signed in; a reconnect to the service reads every scope again.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProvidersSettings } from '../../src/renderer/components/providers/ProvidersSettings'
import {
  DEVICE_SCOPE,
  LISTING_RELOAD_DELAY_MS,
  PENDING_SIGN_IN_POLL_MS,
  PENDING_SIGN_IN_RECHECK_EVERY,
  PENDING_SIGN_IN_WINDOW_MS,
  applyOperationEvent,
  loadProviderSnapshots,
  onProviderSignInChanged,
  operationOutcome,
  stopPendingSignIns,
  useProviderSnapshotsStore,
  watchPendingSignIn
} from '../../src/renderer/lib/providerSnapshots'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { InstanceSnapshot, ProviderSnapshotsEvent } from '../../src/shared/harness/status'
import type { ProviderOperationEvent } from '../../src/shared/harness/types'
import { getDefaultSettings } from '../../src/shared/settings'
import { snapshot } from '../providerSnapshotFixture'

const SIGNED_OUT = snapshot({ auth: { state: 'signed_out', canSignIn: true }, nextStep: { action: 'sign_in', label: 'Sign in' } })
const SIGNED_IN = snapshot({ auth: { state: 'signed_in', account: { id: 'acct-1', label: 'Connection 1' } } })

// The window bridge the module listens on once; each test swaps what answers behind it.
const bus = {
  snapshots: new Set<(event: ProviderSnapshotsEvent) => void>(),
  operations: new Set<(event: ProviderOperationEvent) => void>(),
  restarted: new Set<() => void>()
}
let current: InstanceSnapshot
let snapshotsCalls = 0
let recheckCalls = 0
let recheckResult: () => InstanceSnapshot

beforeAll(() => {
  const on = <T>(set: Set<T>) => (listener: T) => {
    set.add(listener)
    return () => { set.delete(listener) }
  }
  ;(window as unknown as { mousse: unknown }).mousse = {
    platform: 'linux',
    dialog: { pickExecutable: async () => null },
    providers: {
      snapshots: async () => {
        snapshotsCalls += 1
        return [current]
      },
      onSnapshots: on(bus.snapshots),
      onOperation: on(bus.operations),
      onServiceRestarted: on(bus.restarted),
      openLoginUrl: async () => ({ ok: true }),
      catalog: { addOptions: async () => [] },
      registry: { search: async () => [] },
      instances: {
        signIn: async (instanceId: string) => ({ operationId: 'op-1', instanceId, kind: 'sign_in' }),
        respondSignIn: async () => true,
        recheck: async () => {
          recheckCalls += 1
          return recheckResult()
        }
      }
    }
  }
})

beforeEach(() => {
  current = SIGNED_OUT
  snapshotsCalls = 0
  recheckCalls = 0
  recheckResult = () => current
  stopPendingSignIns()
  useProviderSnapshotsStore.setState({ profileId: useAppStore.getState().profileId, scopes: {}, operations: {}, prompts: {} })
  vi.useFakeTimers()
})
afterEach(() => {
  stopPendingSignIns()
  vi.useRealTimers()
})

const authOf = () => useProviderSnapshotsStore.getState().scopes.device?.snapshots?.[0]?.auth.state
const emitOperation = (event: ProviderOperationEvent) => { for (const listener of bus.operations) listener(event) }
const completed: ProviderOperationEvent = { operationId: 'op-1', instanceId: 'claude', kind: 'sign_in', phase: 'completed' }

describe('Settings → Providers after a sign-in', () => {
  let host: HTMLDivElement
  let root: Root
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  }
  const statusText = () => host.querySelector('.prov-status-text')?.textContent ?? ''

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('shows the new status without a refresh when the change after the sign-in never arrives, then stops checking', async () => {
    act(() => root.render(createElement(ProvidersSettings, {
      settings: getDefaultSettings(),
      refreshProviderData: async () => ({ opts: { themes: [], accentColors: [], llmProviders: [], agentTypes: [] } as never }),
      updateSettings: async () => {},
      ensureValidProviderSelection: async (next) => next
    })))
    await settle()
    expect(statusText()).not.toMatch(/Signed in/)
    const signIn = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Sign in')!
    await act(async () => { signIn.click() })
    await settle()
    // The browser sign-in ends: the service reports the operation, but its snapshots event is lost.
    current = SIGNED_IN
    await act(async () => { emitOperation(completed) })
    expect(statusText()).not.toMatch(/Signed in/)
    await act(async () => { await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_POLL_MS) })
    await settle()
    expect(statusText()).toMatch(/Signed in/)
    expect(recheckCalls).toBe(0)
    const reads = snapshotsCalls
    await act(async () => { await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_POLL_MS * 10) })
    expect(snapshotsCalls).toBe(reads)
  })
})

describe('a pending sign-in', () => {
  const loaded = async () => {
    await loadProviderSnapshots(DEVICE_SCOPE)
    snapshotsCalls = 0
  }

  it('is checked in full now and then when it runs outside Mousse, and stops once signed in', async () => {
    await loaded()
    watchPendingSignIn('claude')
    await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_POLL_MS * (PENDING_SIGN_IN_RECHECK_EVERY - 1))
    expect(snapshotsCalls).toBe(PENDING_SIGN_IN_RECHECK_EVERY - 1)
    expect(recheckCalls).toBe(0)
    // The terminal sign-in finished: the service only learns of it by checking.
    recheckResult = () => SIGNED_IN
    await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_POLL_MS)
    expect(recheckCalls).toBe(1)
    expect(authOf()).toBe('signed_in')
    await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_WINDOW_MS)
    expect(recheckCalls).toBe(1)
    expect(snapshotsCalls).toBe(PENDING_SIGN_IN_RECHECK_EVERY - 1)
  })

  it('never runs a full check while Mousse runs the sign-in itself', async () => {
    await loaded()
    watchPendingSignIn('claude')
    applyOperationEvent({ operationId: 'op-1', instanceId: 'claude', kind: 'sign_in', phase: 'prompt', prompt: { promptId: 'p', type: 'auth_url', url: 'https://example.test', usesCallbackServer: true } })
    await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_POLL_MS * PENDING_SIGN_IN_RECHECK_EVERY * 2)
    expect(recheckCalls).toBe(0)
    expect(snapshotsCalls).toBe(PENDING_SIGN_IN_RECHECK_EVERY * 2)
  })

  it('gives up after two minutes', async () => {
    await loaded()
    watchPendingSignIn('claude')
    await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_WINDOW_MS + PENDING_SIGN_IN_POLL_MS * 5)
    const total = snapshotsCalls + recheckCalls
    expect(total).toBeGreaterThan(0)
    expect(total).toBeLessThanOrEqual(PENDING_SIGN_IN_WINDOW_MS / PENDING_SIGN_IN_POLL_MS)
    await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_WINDOW_MS)
    expect(snapshotsCalls + recheckCalls).toBe(total)
  })

  it('stops when its sign-in fails, and when the page closes', async () => {
    await loaded()
    watchPendingSignIn('claude')
    applyOperationEvent({ operationId: 'op-2', instanceId: 'claude', kind: 'sign_in', phase: 'cancelled' })
    await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_POLL_MS * 5)
    expect(snapshotsCalls + recheckCalls).toBe(0)

    watchPendingSignIn('claude')
    await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_POLL_MS)
    expect(snapshotsCalls).toBe(1)
    stopPendingSignIns()
    await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_POLL_MS * 5)
    expect(snapshotsCalls).toBe(1)
  })

  it('keeps checking a signed-in entry that signs in again until its sign-in completes', async () => {
    current = SIGNED_IN
    await loaded()
    watchPendingSignIn('claude')
    await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_POLL_MS * 2)
    expect(snapshotsCalls).toBe(2)
    applyOperationEvent(completed)
    // One more reading after the sign-in completed (its account may be new), then none.
    await vi.advanceTimersByTimeAsync(PENDING_SIGN_IN_POLL_MS * 5)
    expect(snapshotsCalls + recheckCalls).toBe(3)
  })
})

describe('a reconnect to the service', () => {
  it('reads every scope on screen again', async () => {
    // Listening starts with the first use of the store's operations.
    await loadProviderSnapshots(DEVICE_SCOPE)
    const waiting = operationOutcome({ operationId: 'op-r', instanceId: 'claude', kind: 'sign_in' })
    expect(authOf()).toBe('signed_out')
    current = SIGNED_IN
    for (const listener of bus.restarted) listener()
    await vi.advanceTimersByTimeAsync(0)
    expect(authOf()).toBe('signed_in')
    await expect(waiting).resolves.toMatchObject({ phase: 'failed' })
  })
})

describe('sign-in changes for pages outside the store', () => {
  it('reports a sign-in, a sign-out or another account, once per burst, and nothing else', async () => {
    const changed = vi.fn()
    const stop = onProviderSignInChanged(changed)
    const emit = (entry: InstanceSnapshot) => { for (const listener of bus.snapshots) listener({ scope: { kind: 'device' }, snapshots: [entry] }) }
    emit(SIGNED_OUT)
    emit({ ...SIGNED_OUT, checkedAt: '2026-11-09T10:00:00.000Z' })
    await vi.advanceTimersByTimeAsync(LISTING_RELOAD_DELAY_MS)
    expect(changed).not.toHaveBeenCalled()
    emit(SIGNED_IN)
    emit({ ...SIGNED_IN, checkedAt: '2026-11-09T10:00:01.000Z' })
    await vi.advanceTimersByTimeAsync(LISTING_RELOAD_DELAY_MS)
    expect(changed).toHaveBeenCalledTimes(1)
    emit(snapshot({ auth: { state: 'signed_in', account: { id: 'acct-2', label: 'Connection 2' } } }))
    await vi.advanceTimersByTimeAsync(LISTING_RELOAD_DELAY_MS)
    expect(changed).toHaveBeenCalledTimes(2)
    stop()
    emit(SIGNED_OUT)
    await vi.advanceTimersByTimeAsync(LISTING_RELOAD_DELAY_MS)
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
