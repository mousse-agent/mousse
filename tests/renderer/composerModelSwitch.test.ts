// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmProviderOption, MousseSettings } from '../../src/shared/settings'
import type { Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer and its notices.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return { MousseAgentChatShell: ({ composer }: { composer: never }) => create(ComposerNoticeProvider, null, composer) }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const catalog = (): LlmProviderOption[] => [
  { id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5' }, { id: 'sonnet', label: 'Sonnet 5' }, { id: 'haiku', label: 'Haiku 5' }] }
]
const settings = (): MousseSettings => ({
  provider: { llmProvider: 'claude-subscription', model: 'opus' },
  permissions: { defaultMode: 'accept_edits' },
  integrations: { skills: { enabledSkills: [] } }
} as unknown as MousseSettings)

const now = new Date().toISOString()
const withModel = (model: string): Thread => ({ id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0, modelOverride: { llmProvider: 'claude-subscription', model } }) as unknown as Thread

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let root: Root
let host: HTMLElement
let settingsListeners: Array<(value: MousseSettings) => void>
let settingsReads: Array<Deferred<MousseSettings> | undefined>
let setModel: ReturnType<typeof vi.fn>

/** `window.mousse` for the composer: settings (each read can be held), the model catalogue, `threads.setModel`; any other call stays pending. */
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
  const sections: Record<string, unknown> = {
    settings: section({
      get: () => {
        const held = settingsReads.shift()
        return held ? held.promise : Promise.resolve(settings())
      },
      getOptions: () => Promise.resolve({ themes: [], accentColors: [], llmProviders: catalog(), agentTypes: [] }),
      onChanged: (listener: (value: MousseSettings) => void) => {
        settingsListeners.push(listener)
        return () => { settingsListeners = settingsListeners.filter((entry) => entry !== listener) }
      }
    }),
    skills: section({ list: () => Promise.resolve({ skills: [] }) }),
    threads: section({ setModel: (...args: unknown[]) => setModel(...args) })
  }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section({})
      return target[key]
    }
  })
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const shownModel = () => host.querySelector('.composer-model-btn')?.getAttribute('aria-label')
/** Opens the model menu and picks a model by its name. */
async function pick(name: string): Promise<void> {
  await act(async () => { host.querySelector<HTMLButtonElement>('.composer-model-btn')!.click() })
  const row = [...document.querySelectorAll<HTMLElement>('.model-picker-row')].find((entry) => entry.querySelector('.model-picker-row-title')!.textContent === name)!
  await act(async () => { row.querySelector<HTMLButtonElement>('.model-picker-row-main')!.click() })
  await settle(3)
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  settingsListeners = []
  settingsReads = []
  setModel = vi.fn()
  stubBridge()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false,
    activeThreadId: 'thread-a', threads: [withModel('opus')] as never,
    messages: [{ id: 'm-1', role: 'user', content: 'First message', timestamp: now }] as never
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the model picker keeps the model that was picked', () => {
  it('starts on the thread\'s model', () => {
    expect(shownModel()).toBe('Model: Opus 5.5')
  })

  it('a thread list pushed while the pick is being saved does not put the previous model back', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const saved = deferred<Thread>()
    setModel.mockReturnValue(saved.promise)
    await pick('Sonnet 5')
    expect(shownModel()).toBe('Model: Sonnet 5')

    // The list the window got just before the pick, arriving after it (as a `threads:updated` push does).
    await act(async () => { useAppStore.getState().setThreads([withModel('opus')]) })
    await settle()
    expect(shownModel()).toBe('Model: Sonnet 5')

    await act(async () => { saved.resolve(withModel('sonnet')) })
    await settle()
    expect(shownModel()).toBe('Model: Sonnet 5')
    expect(useAppStore.getState().threads[0].modelOverride?.model).toBe('sonnet')
  })

  it('a settings read that began before the pick does not put the previous model back', async () => {
    const stale = deferred<MousseSettings>()
    settingsReads.push(stale)
    await act(async () => { for (const listener of settingsListeners) listener(settings()) })
    setModel.mockResolvedValue(withModel('sonnet'))
    await pick('Sonnet 5')
    expect(shownModel()).toBe('Model: Sonnet 5')

    await act(async () => { stale.resolve(settings()) })
    await settle()
    expect(shownModel()).toBe('Model: Sonnet 5')
  })

  it('a refused pick goes back to the thread\'s model and says why', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    setModel.mockRejectedValue(new Error('This thread cannot change model'))
    await pick('Sonnet 5')
    await settle()
    expect(shownModel()).toBe('Model: Opus 5.5')
    expect(useAppStore.getState().threads[0].modelOverride?.model).toBe('opus')
    expect(document.body.textContent).toContain('This thread cannot change model')
  })

  it('picks made one after another are saved in that order, and the last one is shown whichever answers first', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const first = deferred<Thread>()
    setModel.mockReturnValueOnce(first.promise).mockResolvedValueOnce(withModel('haiku'))
    await pick('Sonnet 5')
    await pick('Haiku 5')
    expect(shownModel()).toBe('Model: Haiku 5')
    // The second is not sent before the first is answered.
    expect(setModel).toHaveBeenCalledTimes(1)

    await act(async () => { first.resolve(withModel('sonnet')) })
    await settle()
    expect(setModel.mock.calls.map((call) => (call[1] as { model: string }).model)).toEqual(['sonnet', 'haiku'])
    expect(shownModel()).toBe('Model: Haiku 5')
    expect(useAppStore.getState().threads[0].modelOverride?.model).toBe('haiku')
  })
})
