// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmProviderOption, MousseSettings } from '../../src/shared/settings'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import { model, snapshot } from '../providerSnapshotFixture'
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
function stubBridge({ freshSnapshots }: { freshSnapshots?: InstanceSnapshot[] } = {}): void {
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
        return held ? held.promise : Promise.resolve(freshSnapshots ? { ...settings(), provider: { llmProvider: '', model: '' } } : settings())
      },
      getOptions: () => Promise.resolve({ themes: [], accentColors: [], llmProviders: freshSnapshots ? [] : catalog(), agentTypes: [] }),
      onChanged: (listener: (value: MousseSettings) => void) => {
        settingsListeners.push(listener)
        return () => { settingsListeners = settingsListeners.filter((entry) => entry !== listener) }
      }
    }),
    ...(freshSnapshots ? { providers: section({ snapshots: async () => freshSnapshots }) } : {}),
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
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

async function renderComposer(threads: Thread[]): Promise<void> {
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: threads.length ? 'prf_test' : 'prf_fresh', profileReady: true, workspaceReady: true, loading: false,
    settingsOpen: false, activeThreadId: threads[0]?.id ?? null, threads,
    messages: threads.length ? [{ id: 'm-1', role: 'user', content: 'First message', timestamp: now }] : []
  })
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
}

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

it('offers only Add provider when the default providers are not set up', async () => {
  stubBridge({ freshSnapshots: [
    snapshot({ install: { state: 'not_installed' }, auth: { state: 'unknown' }, models: { entries: [model('opus', { label: 'Opus 5.5' })], source: 'cached' } }),
    snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex', auth: { state: 'signed_out' }, models: { entries: [model('gpt-5', { label: 'GPT-5' })], source: 'cached' } })
  ] })
  await renderComposer([])

  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  const { takePendingSettingsSection } = await import('../../src/renderer/lib/settingsNavigation')
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label^="Model:"]')!
  await act(async () => { trigger.click() })
  expect(document.body.textContent).not.toMatch(/Opus 5\.5|GPT-5|Claude Code|Codex/)
  expect(document.querySelector('[role="option"]')).toBeNull()

  const addProvider = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Add provider')
  expect(addProvider).toBeDefined()
  expect(document.activeElement).toBe(addProvider)
  await act(async () => { addProvider!.click() })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(useAppStore.getState().settingsOpen).toBe(true)
  expect(takePendingSettingsSection()).toBe('providers')
})

describe('the model picker keeps the model that was picked', () => {
  beforeEach(async () => {
    stubBridge()
    await renderComposer([withModel('opus')])
  })
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

describe('a pick on a thread of another computer', () => {
  const remote = (model: string): Thread => ({ ...withModel(model), id: 'node-studio:thread-a', node: 'node-studio', order: 7 }) as Thread

  it('keeps the thread on that computer in the side card when the reply does not name the computer', async () => {
    stubBridge()
    // That computer's models, which the composer of its thread offers.
    const bridge = window.mousse as unknown as Record<string, unknown>
    bridge.platformRequest = {
      request: (method: string) => method === 'bridge.hub.composerOptions'
        ? Promise.resolve({ providers: catalog(), defaultModel: null })
        : new Promise(() => undefined)
    }
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    useAppStore.setState({
      profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false, settingsOpen: false,
      activeThreadId: 'node-studio:thread-a', threads: [remote('opus')],
      messages: [{ id: 'm-1', role: 'user', content: 'First message', timestamp: now }]
    })
    const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
    const { DeviceSection } = await import('../../src/renderer/components/sideCard/DeviceSection')
    await act(async () => root.render(createElement('div', null,
      createElement(OrchestratorChat),
      createElement(DeviceSection, { threadId: 'node-studio:thread-a', projectId: null })
    )))
    await settle()
    const header = () => host.querySelector('section[aria-label="Computer"] .side-card-header-name')?.textContent
    expect(header()).toBe('Another computer')

    // The owner's copy of the thread: its model and revision, and nothing of where this computer lists it.
    setModel.mockResolvedValue({ ...withModel('sonnet'), id: 'node-studio:thread-a', order: 0, settingsRevision: 4 })
    await pick('Sonnet 5')
    await settle()

    const row = useAppStore.getState().threads[0]
    expect(row.node).toBe('node-studio')
    expect(row.order).toBe(7)
    expect(row.modelOverride?.model).toBe('sonnet')
    expect(row.settingsRevision).toBe(4)
    expect(header()).toBe('Another computer')
  })
})
