// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmProviderOption, MousseSettings } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer only.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', () => ({
  MousseAgentChatShell: ({ composer }: { composer: unknown }) => composer
}))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const catalog = (): LlmProviderOption[] => [
  { id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5' }] }
]
const settings = (): MousseSettings => ({
  provider: { llmProvider: 'claude-subscription', model: 'opus' },
  permissions: { defaultMode: 'accept_edits' },
  integrations: { skills: { enabledSkills: [] } }
} as unknown as MousseSettings)

let root: Root
let host: HTMLElement
let reads: { get: number; getOptions: number }
let settingsListeners: Array<(value: MousseSettings) => void>

/**
 * `window.mousse` for the composer: settings, options and skills answer (a new object on every call, as
 * over IPC); `on…` subscriptions return an unsubscribe; any other call stays pending.
 */
function stubBridge(): void {
  const pending = () => new Promise(() => undefined)
  // A read loop stops being answered after a few rounds, so the test ends on the read count, not a hang.
  const answer = <T>(value: T): Promise<T> => (reads.get > 10 ? (pending() as Promise<T>) : Promise.resolve(value))
  const section = (overrides: Record<string, unknown>): unknown =>
    new Proxy(overrides, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined
        if (key in target) return target[key]
        return key.startsWith('on') ? () => () => undefined : (..._args: unknown[]) => pending()
      }
    })
  const sections: Record<string, unknown> = {
    settings: section({
      get: () => { reads.get++; return answer(settings()) },
      getOptions: () => { reads.getOptions++; return answer({ themes: [], accentColors: [], llmProviders: catalog(), agentTypes: [] }) },
      onChanged: (listener: (value: MousseSettings) => void) => {
        settingsListeners.push(listener)
        return () => { settingsListeners = settingsListeners.filter((entry) => entry !== listener) }
      }
    }),
    skills: section({ list: () => Promise.resolve({ skills: [] }) })
  }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section({})
      return target[key]
    }
  })
}

/** Lets pending reads answer and their renders run. */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  reads = { get: 0, getOptions: 0 }
  settingsListeners = []
  stubBridge()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({ profileId: 'prf_test', profileReady: true, workspaceReady: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('composer settings reads', () => {
  it('reads settings once on mount, again only when settings change, and keeps the model shown', async () => {
    const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
    await act(async () => root.render(createElement(OrchestratorChat)))
    await settle()
    const modelButton = () => host.querySelector('.composer-model-btn')?.getAttribute('aria-label')
    expect(modelButton()).toBe('Model: Opus 5.5')
    // Each answer is a new catalogue object with the same content: it must not start another read.
    expect(reads).toEqual({ get: 1, getOptions: 1 })

    // Renders for unrelated reasons read nothing.
    for (let i = 0; i < 5; i++) {
      await act(async () => root.render(createElement(OrchestratorChat)))
      await settle(2)
    }
    expect(reads).toEqual({ get: 1, getOptions: 1 })

    // A settings change reads once more, and only once.
    await act(async () => { for (const listener of settingsListeners) listener(settings()) })
    await settle()
    expect(reads).toEqual({ get: 2, getOptions: 2 })
    expect(modelButton()).toBe('Model: Opus 5.5')
  })
})
