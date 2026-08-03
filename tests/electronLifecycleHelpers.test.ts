/**
 * Pure helpers for Electron shell lifecycle decisions (no Electron runtime required).
 */
import { describe, expect, it } from 'vitest'
import {
  collectBackgroundActivity,
  shouldRetainProcessForBackground
} from '../src/mms/lifecycle/backgroundActivity'

describe('electron lifecycle helpers (pure)', () => {
  it('duplicate bootstrap guard model: second call is no-op when complete', async () => {
    let bootstraps = 0
    let complete = false
    let inflight: Promise<void> | null = null

    async function bootstrap(): Promise<void> {
      if (complete) return
      if (inflight) {
        await inflight
        return
      }
      inflight = (async () => {
        bootstraps += 1
        await Promise.resolve()
        complete = true
      })()
      try {
        await inflight
      } finally {
        inflight = null
      }
    }

    await Promise.all([bootstrap(), bootstrap(), bootstrap()])
    expect(bootstraps).toBe(1)
    await bootstrap()
    expect(bootstraps).toBe(1)
  })

  it('shutdown is idempotent and awaited before relaunch ordering', async () => {
    const order: string[] = []
    let shutdownPromise: Promise<void> | null = null

    async function coordinatedShutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        order.push('stop-start')
        await Promise.resolve()
        order.push('stop-done')
      })()
      await shutdownPromise
    }

    async function coordinatedRestart(): Promise<void> {
      await coordinatedShutdown()
      order.push('relaunch')
    }

    await Promise.all([coordinatedShutdown(), coordinatedRestart(), coordinatedShutdown()])
    expect(order.filter((x) => x === 'stop-start')).toHaveLength(1)
    expect(order).toEqual(['stop-start', 'stop-done', 'relaunch'])
  })

  it('close/hide predicate uses real activity not job configuration count', () => {
    const onlyPausedJobs = collectBackgroundActivity({
      listScheduledJobs: () => [{ state: 'paused' }, { state: 'completed' }],
      listAgentStatuses: () => [],
      listLivePtys: () => [],
      listChannelStatuses: () => [{ state: 'disconnected' }]
    })
    expect(shouldRetainProcessForBackground(onlyPausedJobs)).toBe(false)

    const activeTurn = collectBackgroundActivity({
      isOrchestratorTurnRunning: () => true,
      listScheduledJobs: () => [{ state: 'paused' }]
    })
    expect(shouldRetainProcessForBackground(activeTurn)).toBe(true)
  })
})
