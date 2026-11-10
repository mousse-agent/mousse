// @vitest-environment jsdom
/**
 * Stop shows the thread stopped at the click (`lib/optimisticStop`, the app store's `markStopRequested`): the daemon's
 * late states of the stopped turn do not bring it back, its end or a new turn takes over, and a Stop that stopped
 * nothing shows the daemon's state again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnState } from '../../src/shared/types'
import { STOP_RECONCILE_MS } from '../../src/renderer/lib/optimisticStop'

const turn = (phase: TurnState['phase'], turnId: string | null = 'turn-1'): TurnState => ({ threadId: 't1', turnId, phase, updatedAt: new Date().toISOString() })

describe('optimistic Stop', () => {
  let store: typeof import('../../src/renderer/stores/appStore')['useAppStore']
  let abort: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    abort = vi.fn(async () => true)
    ;(window as unknown as { mousse: unknown }).mousse = { orchestrator: { abort } }
    store = (await import('../../src/renderer/stores/appStore')).useAppStore
    store.getState().setTurnState(turn('streaming'))
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { mousse?: unknown }).mousse
  })

  const phase = () => store.getState().turnStates.t1?.phase

  it('shows stopped at the click, before the daemon answers', async () => {
    let answer: (value: boolean) => void = () => {}
    abort.mockImplementation(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const { stopThreadNow } = await import('../../src/renderer/lib/stopThread')
    const stopping = stopThreadNow('t1')
    // Nothing was awaited yet: the click alone changed what is shown.
    expect(phase()).toBe('stopped')
    expect(abort).toHaveBeenCalledWith('t1')
    answer(true)
    await expect(stopping).resolves.toBe(true)
    expect(phase()).toBe('stopped')
  })

  it('keeps showing stopped while the daemon still reports the stopped turn, until it ends', () => {
    expect(store.getState().markStopRequested('t1')).toBeTypeOf('number')
    store.getState().setTurnState(turn('tool_running'))
    expect(phase()).toBe('stopped')
    store.getState().setTurnState(turn('stopped'))
    expect(phase()).toBe('stopped')
    expect(store.getState().stopRequests.t1).toBeUndefined()
    // Confirmed: a later state of the thread is shown as it comes.
    store.getState().setTurnState(turn('queued', 'turn-2'))
    expect(phase()).toBe('queued')
  })

  it('shows a new turn at once', () => {
    store.getState().markStopRequested('t1')
    store.getState().setTurnState(turn('thinking', 'turn-2'))
    expect(phase()).toBe('thinking')
    expect(store.getState().stopRequests.t1).toBeUndefined()
  })

  it('shows the daemon state again when the Stop stopped nothing', async () => {
    abort.mockResolvedValue(false)
    store.getState().setTurnState(turn('tool_running'))
    const { stopThreadNow } = await import('../../src/renderer/lib/stopThread')
    await expect(stopThreadNow('t1')).resolves.toBe(false)
    expect(phase()).toBe('tool_running')
  })

  it('shows the daemon state again when the turn is still reported running after the reconcile time', async () => {
    vi.useFakeTimers()
    const { stopThreadNow } = await import('../../src/renderer/lib/stopThread')
    await stopThreadNow('t1')
    store.getState().setTurnState(turn('tool_running'))
    expect(phase()).toBe('stopped')
    vi.advanceTimersByTime(STOP_RECONCILE_MS)
    expect(phase()).toBe('tool_running')
  })

  it('does nothing for a thread with no running turn', () => {
    store.getState().setTurnState(turn('completed'))
    expect(store.getState().markStopRequested('t1')).toBeUndefined()
    expect(phase()).toBe('completed')
  })

  it('a resync snapshot keeps a pending Stop and applies the rest', () => {
    store.getState().markStopRequested('t1')
    store.getState().setTurnSnapshot({ t1: turn('streaming'), t2: { ...turn('thinking'), threadId: 't2' } })
    expect(phase()).toBe('stopped')
    expect(store.getState().turnStates.t2?.phase).toBe('thinking')
  })
})
