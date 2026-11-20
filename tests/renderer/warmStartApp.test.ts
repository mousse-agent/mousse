// @vitest-environment jsdom
/**
 * The warm start, through the window itself: before the service answers, the window shows what its profile showed
 * last time (the sidebar's threads and the open thread's messages); the service's own lists and transcript then take
 * their place, a window bound to another profile drops it, and a message sent meanwhile goes once when connected.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WarmStartView } from '../../src/shared/warmStart'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))
vi.mock('../../src/renderer/components/downloads/DownloadsIndicator', () => ({ DownloadsIndicator: () => null }))
vi.mock('../../src/renderer/components/TitleBar', () => ({ TitleBar: () => null }))
vi.mock('../../src/renderer/components/LinuxWindowResizeHandles', () => ({ LinuxWindowResizeHandles: () => null }))
vi.mock('../../src/renderer/components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('../../src/renderer/components/ThreadRenameDialog', () => ({ ThreadRenameDialog: () => null }))
vi.mock('../../src/renderer/components/ui/Toast', async (importOriginal) => ({ ...(await importOriginal<object>()), ToastHost: () => null }))
vi.mock('../../src/renderer/components/AutomationsPage', () => ({ AutomationsPage: () => null }))
vi.mock('../../src/renderer/components/chats/ChatWorkspace', () => ({ ChatWorkspace: () => null }))
vi.mock('../../src/renderer/components/MainViewTabs', () => ({ MainViewTabs: () => null }))
vi.mock('../../src/renderer/components/MainViewPanel', () => ({ MainViewPanel: () => null }))
vi.mock('../../src/renderer/components/sideCard/ThreadSideCard', () => ({ ThreadSideCard: () => null }))
vi.mock('../../src/renderer/components/QuickActionEditor', () => ({ QuickActionEditorHost: () => null }))
vi.mock('../../src/renderer/commands/useAppCommands', () => ({ useAppCommands: () => {} }))
vi.mock('../../src/renderer/commands/useCommandShortcuts', () => ({ useCommandShortcuts: () => {} }))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const WARM_PROFILE = 'prf_warm'
const OTHER_PROFILE = 'prf_other'
const T = '2026-11-20T10:00:00.000Z'
const thread = (id: string, name: string) => ({ id, name, createdAt: T, updatedAt: T, startedAt: T, order: 0 })
const say = (id: string, role: 'user' | 'assistant', content: string, extra: object = {}) => ({ id, role, content, timestamp: T, ...extra })
const profile = (id: string, displayName: string) => ({ id, displayName, color: '#336699', status: 'active', revision: 1, isDefault: id === WARM_PROFILE })

const warmView: WarmStartView = {
  profileId: WARM_PROFILE,
  profile: profile(WARM_PROFILE, 'Work') as never,
  threads: [thread('t-release', 'Release notes'), thread('t-login', 'Fix the login')] as never,
  projects: [],
  activeThreadId: 't-release',
  // The reply was still being written when the window closed.
  messages: [say('m1', 'user', 'Ship the warm start'), say('m2', 'assistant', 'Writing the cache now', { streaming: true })] as never
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** Every call the window made, with its arguments, in order. */
let calls: Array<{ method: string; args: unknown[] }>
/** The main process's events the window listens to, by `section.onName`. */
let listeners: Record<string, (...args: unknown[]) => void>
let profilesList: ReturnType<typeof deferred<unknown>>
let profilesStatus: ReturnType<typeof deferred<unknown>>
let initialize: ReturnType<typeof deferred<void>>

function stubBridge(view: WarmStartView | null): void {
  // Never settles; callable too, for the calls whose answer is an unsubscribe function.
  const never: Record<string, unknown> & (() => void) = Object.assign(() => undefined, {})
  never.then = () => never
  never.catch = () => never
  never.finally = () => never
  const pending = () => never
  const settings = { provider: { llmProvider: 'claude-subscription', model: 'opus' }, permissions: { defaultMode: 'accept_edits' }, integrations: { skills: { enabledSkills: [] } } }
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    'app.warmStart': () => Promise.resolve(view),
    'profiles.list': () => profilesList.promise,
    'profiles.status': () => profilesStatus.promise,
    'threads.initialize': () => initialize.promise,
    'settings.get': () => Promise.resolve(settings),
    'settings.getOptions': () => Promise.resolve({ themes: [], accentColors: [], agentTypes: [], llmProviders: [{ id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5' }] }] }),
    'skills.list': () => Promise.resolve({ skills: [] }),
    'orchestrator.isTurnActive': () => Promise.resolve(false),
    'threads.get': (id) => Promise.resolve(thread(String(id), 'Release notes')),
    'threads.select': () => Promise.resolve(),
    'queue.list': () => Promise.resolve([])
  }
  const section = (name: string): unknown => new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== 'string' || key === 'then') return undefined
      const method = `${name}.${key}`
      if (key.startsWith('on')) return (listener: (...args: unknown[]) => void) => { listeners[method] = listener; return () => undefined }
      return (...args: unknown[]) => {
        calls.push({ method, args })
        return (answers[method] ?? pending)(...args)
      }
    }
  })
  const sections: Record<string, unknown> = { platform: 'win32' }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section(key)
      return target[key]
    }
  })
}

let host: HTMLDivElement
let root: Root
let useAppStore: typeof import('../../src/renderer/stores/appStore').useAppStore

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** Opens a window: the app starts fresh, as after a restart. */
async function launch(): Promise<void> {
  vi.resetModules()
  const { default: App } = await import('../../src/renderer/App')
  ;({ useAppStore } = await import('../../src/renderer/stores/appStore'))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(App)))
  await settle()
}

/** The service answers: the window's trusted binding, then its lists and the open thread's view. */
async function connect(boundProfile: string, fresh: { threads: unknown[]; messages: unknown[] }): Promise<void> {
  profilesList.resolve({ defaultProfileId: WARM_PROFILE, profiles: [profile(WARM_PROFILE, 'Work'), profile(OTHER_PROFILE, 'Home')] })
  profilesStatus.resolve({ binding: { profileId: boundProfile, epoch: 1 } })
  await settle()
  await act(async () => {
    listeners['projects.onUpdated']!([])
    listeners['threads.onUpdated']!(fresh.threads, { epoch: 'service', seq: 1, generation: 1 })
    listeners['threads.onSelected']!({ id: 't-release' })
    listeners['threads.onView']!({ threadId: 't-release', messages: fresh.messages, agents: [], tasks: [] })
  })
  initialize.resolve()
  await settle(20)
}

const sidebarText = () => host.querySelector('[data-mousse="sidebar"]')?.textContent ?? ''
const chatText = () => host.querySelector('[data-mousse="chat"]')?.textContent ?? ''
const composer = () => host.querySelector<HTMLTextAreaElement>('[data-mousse="chat"] .composer-input')!
const callsNaming = (id: string) => calls.filter((call) => JSON.stringify(call.args).includes(id))
const sends = () => calls.filter((call) => call.method === 'orchestrator.sendToThread' || call.method === 'orchestrator.send')

async function typeAndSend(text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), text)
    composer().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle()
}

const freshThreads = [thread('t-release', 'Release notes, final'), thread('t-login', 'Fix the login')]
const freshMessages = [say('m1', 'user', 'Ship the warm start'), say('m2', 'assistant', 'The cache is written and read at launch')]

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  window.localStorage.clear()
  // The person's flat thread list for that profile, as saved on this computer.
  window.localStorage.setItem(`mousse-profile-${WARM_PROFILE}-workspace`, JSON.stringify({ threadsSidebarView: 'threads', lastThreadListView: 'threads' }))
  calls = []
  listeners = {}
  profilesList = deferred()
  profilesStatus = deferred()
  initialize = deferred()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('the window before the service answers', () => {
  it('shows the last thread list and the open thread\'s messages, and asks nothing with the profile it came from', async () => {
    stubBridge(warmView)
    await launch()
    expect(sidebarText()).toContain('Release notes')
    expect(sidebarText()).toContain('Fix the login')
    expect(chatText()).toContain('Ship the warm start')
    expect(chatText()).toContain('Writing the cache now')
    expect(callsNaming(WARM_PROFILE)).toEqual([])
    expect(calls.map((call) => call.method)).toContain('profiles.status')
  })

  it('takes the service\'s lists and transcript in place, never showing the thread without messages', async () => {
    stubBridge(warmView)
    await launch()
    const frames: string[] = []
    const observer = new MutationObserver(() => frames.push(chatText()))
    observer.observe(host, { subtree: true, childList: true, characterData: true })
    await connect(WARM_PROFILE, { threads: freshThreads, messages: freshMessages })
    observer.disconnect()

    expect(useAppStore.getState().workspaceReady).toBe(true)
    expect(sidebarText()).toContain('Release notes, final')
    expect(chatText()).toContain('The cache is written and read at launch')
    expect(chatText()).not.toContain('Writing the cache now')
    expect(frames.filter((frame) => !frame.includes('Ship the warm start'))).toEqual([])
  })

  it('drops what it showed when the window is bound to another profile', async () => {
    stubBridge(warmView)
    await launch()
    profilesList.resolve({ defaultProfileId: WARM_PROFILE, profiles: [profile(WARM_PROFILE, 'Work'), profile(OTHER_PROFILE, 'Home')] })
    profilesStatus.resolve({ binding: { profileId: OTHER_PROFILE, epoch: 1 } })
    await settle()
    expect(useAppStore.getState().profileId).toBe(OTHER_PROFILE)
    expect(sidebarText()).not.toContain('Release notes')
    expect(host.textContent).not.toContain('Ship the warm start')
    expect(callsNaming(WARM_PROFILE)).toEqual([])
  })

  it('sends a message typed before the window connected once, when it connects', async () => {
    stubBridge(warmView)
    await launch()
    await typeAndSend('Also cover the quit')
    expect(sends()).toEqual([])
    expect(chatText()).toContain('Sends when connected')

    await connect(WARM_PROFILE, { threads: freshThreads, messages: freshMessages })
    expect(sends()).toHaveLength(1)
    expect(JSON.stringify(sends()[0]!.args)).toContain('Also cover the quit')
    await settle(20)
    expect(sends()).toHaveLength(1)
  })

  it('keeps showing it behind the error when the service never answers, and Retry asks again', async () => {
    stubBridge(warmView)
    await launch()
    profilesList.reject(new Error('MMS reconnect timed out after 30000ms'))
    await settle()
    expect(chatText()).toContain('Ship the warm start')
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Retry'))
    expect(host.textContent).toContain('Could not connect to workspace')
    expect(retry).toBeDefined()
    const asked = calls.filter((call) => call.method === 'profiles.list').length
    profilesList = deferred()
    await act(async () => retry!.click())
    await settle()
    expect(calls.filter((call) => call.method === 'profiles.list').length).toBe(asked + 1)
    expect(chatText()).toContain('Ship the warm start')
  })

  it('shows the loading skeleton as before when nothing was kept', async () => {
    stubBridge(null)
    await launch()
    expect(host.querySelector('[data-mousse="chat"]')).toBeNull()
    expect(host.querySelector('[data-workspace-loading]')).not.toBeNull()
  })
})
