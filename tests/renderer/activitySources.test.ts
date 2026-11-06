// @vitest-environment jsdom
/**
 * Activity's two sources, edit history and token usage, load on their own: one pending or failing
 * never hides the other, nothing reads as zero or empty before it is known, and a pending source
 * shows its loader only after a short delay.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivitySection } from '../../src/renderer/components/ActivitySection'
import { PENDING_DELAY_MS } from '../../src/renderer/components/LineEditHeatmap'
import { buildLineEditSnapshot, buildUsageStatsSnapshot, type LineEditStatsSnapshot, type UsageStatsSnapshot } from '../../src/shared/lineEditStats'

vi.mock('../../src/renderer/components/ui/Select', () => import('../support/selectStub'))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const EDITS = buildLineEditSnapshot({ '2025-03-04': { orchestrator: 12, manual: 0 } })
const USAGE = buildUsageStatsSnapshot([{ timestamp: '2026-08-25T10:00:00.000Z', provider: 'openai', model: 'gpt-test', input: 1_000, output: 250, cacheRead: 0, cacheWrite: 0 }])

let root: Root
let host: HTMLElement

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function mount(edits: Promise<LineEditStatsSnapshot>, usage: Promise<UsageStatsSnapshot>) {
  ;(window as unknown as { mousse: unknown }).mousse = {
    lineEdits: { getStats: () => edits, onUpdated: () => () => {} },
    usageStats: { getStats: () => usage }
  }
  await act(async () => root.render(createElement(ActivitySection)))
}

const text = () => host.textContent ?? ''
const loaders = () => [...host.querySelectorAll('[role="status"][aria-label]')].map((node) => node.getAttribute('aria-label'))
const settle = async () => { await act(async () => { await Promise.resolve() }) }

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Activity sources', () => {
  it('shows token usage while edits are still loading, and the edit loader only after the delay', async () => {
    const edits = deferred<LineEditStatsSnapshot>()
    await mount(edits.promise, Promise.resolve(USAGE))
    expect(text()).toContain('Tokens in')
    expect(text()).not.toContain('Loading activity…')
    expect(text()).not.toContain('No edits recorded yet')
    expect(loaders()).toEqual([])
    await act(async () => { vi.advanceTimersByTime(PENDING_DELAY_MS) })
    expect(loaders()).toEqual(['Loading activity'])
    edits.resolve(EDITS)
    await settle()
    expect(text()).toContain('lines edited')
    expect(loaders()).toEqual([])
  })

  it('keeps token usage when edits fail, and says the edits could not load', async () => {
    await mount(Promise.reject(new Error('disk')), Promise.resolve(USAGE))
    await settle()
    expect(text()).toContain('Couldn’t load activity.')
    expect(text()).toContain('Tokens in')
    expect(text()).not.toContain('No edits recorded yet')
  })

  it('keeps the edit history when token usage fails, and says usage is unavailable rather than zero', async () => {
    await mount(Promise.resolve(EDITS), Promise.reject(new Error('disk')))
    await settle()
    expect(text()).toContain('lines edited')
    expect(text()).toContain('Token usage unavailable')
    expect(text()).not.toContain('Tokens in')
  })

  it('holds a Token usage group with a delayed loader while usage loads, never a zero', async () => {
    const usage = deferred<UsageStatsSnapshot>()
    await mount(Promise.resolve(EDITS), usage.promise)
    expect(text()).toContain('Token usage')
    expect(text()).not.toContain('Tokens in')
    expect(text()).not.toContain('No token usage')
    await act(async () => { vi.advanceTimersByTime(PENDING_DELAY_MS) })
    expect(loaders()).toEqual(['Loading token usage'])
    usage.resolve(USAGE)
    await settle()
    expect(text()).toContain('Tokens in')
    expect(loaders()).toEqual([])
  })
})
