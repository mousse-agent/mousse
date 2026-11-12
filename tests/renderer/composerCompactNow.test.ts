// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setContextRingInComposer } from '../../src/renderer/lib/contextRingSetting'
import type { ContextUsageSnapshot } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer only.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', () => ({
  MousseAgentChatShell: ({ composer }: { composer: unknown }) => composer
}))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

let root: Root
let host: HTMLElement
let bridge: Record<string, Record<string, unknown>>

/** `window.mousse` with the given sections' methods; anything else stays pending, `on…` returns an unsubscribe. */
function stubBridge(): void {
  const pending = () => new Promise(() => undefined)
  const section = (overrides: Record<string, unknown>): unknown =>
    new Proxy(overrides, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined
        if (key in target) return target[key]
        return key.startsWith('on') ? () => () => undefined : (..._args: unknown[]) => pending()
      }
    })
  const sections: Record<string, unknown> = Object.fromEntries(Object.entries(bridge).map(([name, methods]) => [name, section(methods)]))
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section({})
      return target[key]
    }
  })
}

/** Lets pending reads, and the context meter's debounce, answer and render. */
async function settle(waitMs = 0): Promise<void> {
  if (waitMs) await act(async () => { await new Promise((resolve) => setTimeout(resolve, waitMs)) })
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** A thread last answered 2h 12m ago, its cache written for an hour: expired 1h 12m ago, 182K to re-read. */
const expired = (): ContextUsageSnapshot => ({
  percent: 18, used: 182_000, limit: 1_000_000, modelName: 'opus', source: 'measured',
  categories: [{ label: 'Prompt cache', color: '#22c55e', tokens: 182_000 }],
  promptCache: { lastRequestAt: Date.now() - (2 * 60 + 12) * 60_000, ttlMs: 60 * 60_000 }
})

beforeEach(async () => {
  // The ring is off by default (Settings › Appearance › Composer); these tests read it.
  setContextRingInComposer(true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const now = new Date().toISOString()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false,
    activeThreadId: 'thread-a',
    threads: [{ id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0 }] as never,
    messages: [{ id: 'm-1', role: 'user', content: 'First message', timestamp: now }] as never
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  setContextRingInComposer(false)
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('Compact now from the composer', () => {
  it('starts the thread\'s compaction at once, and the chip reads Compacting… until it ends', async () => {
    let finish!: () => void
    const compact = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    bridge = {
      orchestrator: { getContextUsage: vi.fn(async () => expired()), isTurnActive: vi.fn(async () => false) },
      threads: { compact },
      skills: { list: () => Promise.resolve({ skills: [] }) }
    }
    stubBridge()
    const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
    await act(async () => root.render(createElement(OrchestratorChat)))
    await settle(400)

    const chip = () => host.querySelector<HTMLElement>('.composer-idle-chip')
    expect(chip()?.textContent).toBe('Full · 182K')
    await act(async () => chip()!.click())
    const compactNow = [...document.querySelectorAll<HTMLElement>('.composer-idle-menu [role="menuitemradio"]')]
      .find((row) => row.textContent?.includes('Compact now'))!
    await act(async () => compactNow.click())

    expect(compact).toHaveBeenCalledWith('thread-a')
    expect(chip()?.textContent).toBe('Compacting…')
    await act(async () => finish())
    await settle()
    expect(chip()?.textContent).not.toBe('Compacting…')
  })
})

describe('the Full/Compact chip on a thread switch', () => {
  /** A thread answered a minute ago, its cache written for five minutes: warm, no chip. */
  const warm = (): ContextUsageSnapshot => ({ ...expired(), promptCache: { lastRequestAt: Date.now() - 60_000, ttlMs: 5 * 60_000 } })

  it('shows each thread\'s own chip in the same render as the switch, never the one of the thread before', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const now = new Date().toISOString()
    useAppStore.setState({
      threads: [
        { id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0 },
        { id: 'thread-b', name: 'B', createdAt: now, updatedAt: now, startedAt: now, order: 1 }
      ] as never
    })
    // Each thread answers for itself; `hold` keeps the next answers pending, like a slow service.
    let hold = false
    const asked: Array<string | undefined> = []
    const getContextUsage = vi.fn((request?: { threadId?: string }) => {
      asked.push(request?.threadId)
      if (hold) return new Promise<ContextUsageSnapshot>(() => undefined)
      return Promise.resolve(request?.threadId === 'thread-b' ? warm() : expired())
    })
    bridge = {
      orchestrator: { getContextUsage, isTurnActive: vi.fn(async () => false) },
      skills: { list: () => Promise.resolve({ skills: [] }) }
    }
    stubBridge()
    const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
    await act(async () => root.render(createElement(OrchestratorChat)))
    await settle()
    const chip = () => host.querySelector<HTMLElement>('.composer-idle-chip')
    const ring = () => host.querySelector('.composer-context-anchor')
    expect(chip()?.textContent).toBe('Full · 182K')
    expect(asked).toContain('thread-a')

    // B was never measured: until it is, it shows neither ring nor chip (A's chip never shows on B).
    hold = true
    act(() => useAppStore.getState().switchToThread('thread-b'))
    expect(chip()).toBeNull()
    expect(ring()).toBeNull()
    hold = false
    await settle()
    expect(asked.at(-1)).toBe('thread-b')
    expect(ring()).not.toBeNull()
    expect(chip()).toBeNull()

    // Back on A, its chip is there in the switch's own render, before A is measured again.
    hold = true
    act(() => useAppStore.getState().switchToThread('thread-a'))
    expect(chip()?.textContent).toBe('Full · 182K')
    // And B, opened again, has no chip at any point.
    act(() => useAppStore.getState().switchToThread('thread-b'))
    expect(ring()).not.toBeNull()
    expect(chip()).toBeNull()
  })

  it('keeps a changed thread\'s ring but holds its chip until the new measurement says where the cache stands', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const now = new Date().toISOString()
    useAppStore.setState({
      threads: [
        { id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0 },
        { id: 'thread-b', name: 'B', createdAt: now, updatedAt: now, startedAt: now, order: 1 }
      ] as never
    })
    let hold = false
    bridge = {
      orchestrator: {
        getContextUsage: vi.fn((request?: { threadId?: string }) => hold ? new Promise(() => undefined) : Promise.resolve(request?.threadId === 'thread-b' ? warm() : expired())),
        isTurnActive: vi.fn(async () => false)
      },
      skills: { list: () => Promise.resolve({ skills: [] }) }
    }
    stubBridge()
    const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
    await act(async () => root.render(createElement(OrchestratorChat)))
    await settle()
    expect(host.querySelector('.composer-idle-chip')).not.toBeNull()
    act(() => useAppStore.getState().switchToThread('thread-b'))
    await settle()

    // A turn ran on A meanwhile (elsewhere): its old record no longer says where its cache stands.
    hold = true
    const later = new Date(Date.now() + 1000).toISOString()
    useAppStore.setState((s) => ({ threads: s.threads.map((thread) => thread.id === 'thread-a' ? { ...thread, updatedAt: later } : thread) }))
    act(() => useAppStore.getState().switchToThread('thread-a'))
    expect(host.querySelector('.composer-context-anchor')).not.toBeNull()
    expect(host.querySelector('.composer-idle-chip')).toBeNull()
  })
})
