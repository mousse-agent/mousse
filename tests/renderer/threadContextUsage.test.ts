// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMinuteClock } from '../../src/renderer/lib/promptCache'
import { cachedContextUsage, contextUsageKey, forgetContextUsage, rememberContextUsage } from '../../src/renderer/lib/threadContextUsage'
import type { ContextUsageSnapshot } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const usage = (tokens: number, lastRequestAt?: number): ContextUsageSnapshot => ({
  percent: 10, used: tokens, limit: 1_000_000, modelName: 'opus', source: 'measured',
  categories: [{ label: 'Messages', color: '#fff', tokens }],
  ...(lastRequestAt ? { promptCache: { lastRequestAt, ttlMs: 5 * 60_000 } } : {})
})

afterEach(() => {
  forgetContextUsage()
  vi.useRealTimers()
})

describe('a thread\'s last context measurement', () => {
  it('is kept per thread and profile', () => {
    const a = usage(100, 1)
    rememberContextUsage(contextUsageKey('p1', 'a'), a, 'v1')
    expect(cachedContextUsage(contextUsageKey('p1', 'a'), 'v1')).toBe(a)
    expect(cachedContextUsage(contextUsageKey('p1', 'b'), 'v1')).toBeUndefined()
    expect(cachedContextUsage(contextUsageKey('p2', 'a'), 'v1')).toBeUndefined()
  })

  it('loses its cache record, not its ring, once the thread changed', () => {
    rememberContextUsage(contextUsageKey('p1', 'a'), usage(100, 1), 'v1')
    const changed = cachedContextUsage(contextUsageKey('p1', 'a'), 'v2')
    expect(changed?.used).toBe(100)
    expect(changed?.promptCache).toBeUndefined()
  })

  it('keeps the threads read last', () => {
    for (let i = 0; i < 70; i++) rememberContextUsage(contextUsageKey('p', `t${i}`), usage(i))
    expect(cachedContextUsage(contextUsageKey('p', 't0'))).toBeUndefined()
    expect(cachedContextUsage(contextUsageKey('p', 't69'))?.used).toBe(69)
  })
})

describe('the minute clock', () => {
  it('reads the time in the render that brings a new record, not a minute or an hour later', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000_000_000)
    const seen: number[] = []
    function Probe({ since }: { since?: number }) {
      seen.push(useMinuteClock(since !== undefined, since))
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(Probe, {})))
    // Two hours with no record shown (the clock stopped), then a thread with one.
    vi.setSystemTime(1_000_000_000_000 + 2 * 60 * 60_000)
    seen.length = 0
    act(() => root.render(createElement(Probe, { since: 1_000_000_000_000 })))
    expect(seen[0]).toBe(Date.now())
    act(() => root.unmount())
  })
})
