// @vitest-environment jsdom
/**
 * PR 5a-2 review r1: snapshots events are frequent (every check, every download percent), so the
 * pickers read their listings again only when what a listing shows changed, once per burst; and a
 * sign-in the service can no longer finish (it restarted, the profile changed) stops being waited on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LISTING_RELOAD_DELAY_MS,
  applyOperationEvent,
  failRunningOperations,
  onProviderListingsChanged,
  operationOutcome
} from '../../src/renderer/lib/providerSnapshots'
import type { ProviderSnapshotsEvent } from '../../src/shared/harness/status'
import { snapshot } from '../providerSnapshotFixture'

let listeners: Array<(event: ProviderSnapshotsEvent) => void> = []
let restarted: Array<() => void> = []
beforeEach(() => {
  listeners = []
  restarted = []
  ;(window as unknown as { mousse: unknown }).mousse = {
    providers: {
      onSnapshots: (listener: (event: ProviderSnapshotsEvent) => void) => {
        listeners.push(listener)
        return () => { listeners = listeners.filter((entry) => entry !== listener) }
      },
      onOperation: () => () => {},
      onServiceRestarted: (listener: () => void) => {
        restarted.push(listener)
        return () => {}
      }
    }
  }
})
afterEach(() => vi.useRealTimers())

const event = (patch: Parameters<typeof snapshot>[0] = {}): ProviderSnapshotsEvent => ({ scope: { kind: 'device' }, snapshots: [snapshot(patch)] })
const emit = (value: ProviderSnapshotsEvent) => { for (const listener of listeners) listener(value) }

describe('listing reloads on snapshots events', () => {
  it('gathers a burst into one reload and skips events that change nothing a listing shows', () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    const stop = onProviderListingsChanged(reload)
    emit(event())
    emit(event({ auth: { state: 'signed_out' } }))
    emit(event({ auth: { state: 'signed_in' } }))
    vi.advanceTimersByTime(LISTING_RELOAD_DELAY_MS)
    expect(reload).toHaveBeenCalledTimes(1)
    // A new check time or an install tick changes no listing.
    for (let percent = 0; percent < 50; percent += 1) emit(event({ checkedAt: `2026-10-27T10:00:${String(percent).padStart(2, '0')}.000Z`, install: { state: 'installed', canInstall: false, progress: percent } as never }))
    vi.advanceTimersByTime(LISTING_RELOAD_DELAY_MS * 2)
    expect(reload).toHaveBeenCalledTimes(1)
    // A model appearing does.
    emit(event({ models: { entries: [{ id: 'new-model', label: 'New', source: 'live', capabilities: { efforts: [], images: false }, hidden: false, favorite: false }], source: 'live' } }))
    vi.advanceTimersByTime(LISTING_RELOAD_DELAY_MS)
    expect(reload).toHaveBeenCalledTimes(2)
    stop()
    emit(event({ displayName: 'Renamed' }))
    vi.advanceTimersByTime(LISTING_RELOAD_DELAY_MS)
    expect(reload).toHaveBeenCalledTimes(2)
  })
})

describe('a sign-in the service cannot finish', () => {
  it('ends as failed when the window reconnects, even before its first event arrived', async () => {
    const waiting = operationOutcome({ operationId: 'op-lost-1', instanceId: 'pi:openai', kind: 'sign_in' })
    applyOperationEvent({ operationId: 'op-lost-2', instanceId: 'pi:openrouter', kind: 'sign_in', phase: 'prompt', prompt: { promptId: 'p', type: 'auth_url', url: 'https://example.test', usesCallbackServer: true } })
    const prompted = operationOutcome({ operationId: 'op-lost-2', instanceId: 'pi:openrouter', kind: 'sign_in' })
    for (const listener of restarted) listener()
    await expect(waiting).resolves.toMatchObject({ phase: 'failed', error: { message: expect.stringContaining('connection to the Mousse service was lost') } })
    await expect(prompted).resolves.toMatchObject({ phase: 'failed' })
  })

  it('ends as failed when told directly (a profile switch)', async () => {
    const waiting = operationOutcome({ operationId: 'op-lost-3', instanceId: 'pi:openai', kind: 'sign_in' })
    failRunningOperations('The profile changed before the sign-in finished.')
    await expect(waiting).resolves.toMatchObject({ phase: 'failed', error: { message: 'The profile changed before the sign-in finished.' } })
  })
})
