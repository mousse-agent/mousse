// @vitest-environment jsdom
/**
 * The warm start, through the window itself: before the service answers, the window shows what its profile showed
 * last time (the sidebar's threads and the open thread's messages) from its first render; the service's own lists and
 * transcript then take their place without anything on screen changing that did not change (badges, icons, the
 * transcript's scroll position, a new chat's greeting and composer), a window bound to another profile drops it, and a
 * message sent meanwhile goes once when connected.
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

let extraAnswers: Record<string, (...args: unknown[]) => unknown> = {}

function stubBridge(view: WarmStartView | null): void {
  // Never settles; callable too, for the calls whose answer is an unsubscribe function.
  const never: Record<string, unknown> & (() => void) = Object.assign(() => undefined, {})
  never.then = () => never
  never.catch = () => never
  never.finally = () => never
  const pending = () => never
  const settings = { provider: { llmProvider: 'claude-subscription', model: 'opus' }, permissions: { defaultMode: 'accept_edits' }, integrations: { skills: { enabledSkills: [] } } }
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    // Main hands the warm start to the preload synchronously, before the window's first frame.
    'app.warmStartView': () => view,
    'profiles.list': () => profilesList.promise,
    'profiles.status': () => profilesStatus.promise,
    'threads.initialize': () => initialize.promise,
    'settings.get': () => Promise.resolve(settings),
    'settings.getOptions': () => Promise.resolve({ themes: [], accentColors: [], agentTypes: [], llmProviders: [{ id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5' }] }] }),
    'skills.list': () => Promise.resolve({ skills: [] }),
    'orchestrator.isTurnActive': () => Promise.resolve(false),
    'threads.get': (id) => Promise.resolve(thread(String(id), 'Release notes')),
    'threads.select': () => Promise.resolve(),
    'queue.list': () => Promise.resolve([]),
    ...extraAnswers
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

/** The window's code, fresh, as after a restart; nothing rendered yet. */
async function load(): Promise<typeof import('../../src/renderer/App').default> {
  vi.resetModules()
  const { default: App } = await import('../../src/renderer/App')
  ;({ useAppStore } = await import('../../src/renderer/stores/appStore'))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  return App
}

/** Opens a window: the app starts fresh, as after a restart. */
async function launch(): Promise<void> {
  const App = await load()
  await act(async () => root.render(createElement(App)))
  await settle()
}

/** The service answers: the window's trusted binding, then its lists and the open thread's view. */
async function bind(boundProfile: string): Promise<void> {
  profilesList.resolve({ defaultProfileId: WARM_PROFILE, profiles: [profile(WARM_PROFILE, 'Work'), profile(OTHER_PROFILE, 'Home')] })
  profilesStatus.resolve({ binding: { profileId: boundProfile, epoch: 1 } })
  await settle()
}

async function connect(boundProfile: string, fresh: { threads: unknown[]; messages: unknown[]; projects?: unknown[]; threadId?: string }): Promise<void> {
  await bind(boundProfile)
  const threadId = fresh.threadId ?? 't-release'
  await act(async () => {
    listeners['projects.onUpdated']!(fresh.projects ?? [])
    listeners['threads.onUpdated']!(fresh.threads, { epoch: 'service', seq: 1, generation: 1 })
    listeners['threads.onSelected']!({ id: threadId })
    listeners['threads.onView']!({ threadId, messages: fresh.messages, agents: [], tasks: [] })
  })
  initialize.resolve()
  await settle(20)
}

/** What the window showed at every change while `run` ran, as read by `read`. */
async function framesOf<T>(read: () => T, run: () => Promise<void>): Promise<T[]> {
  const frames: T[] = []
  const observer = new MutationObserver(() => frames.push(read()))
  observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true })
  await run()
  observer.disconnect()
  return frames
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
  extraAnswers = {}
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

  it('says Connecting… in its composer, with its controls out of reach, until the live chat takes its place', async () => {
    stubBridge(warmView)
    await launch()
    const reachable = () => [...host.querySelectorAll('[data-mousse="chat"] [data-mousse="composer"] button')]
      .filter((button) => !button.closest('[inert], [aria-hidden="true"]'))
      .map((button) => button.getAttribute('aria-label'))
    expect(composer().placeholder).toBe('Connecting…')
    expect(reachable()).not.toContain('Send message')
    expect(reachable()).not.toContain('Attach files')

    await connect(WARM_PROFILE, { threads: freshThreads, messages: freshMessages })
    expect(host.querySelector('[data-warm-start]')).toBeNull()
    await vi.waitFor(() => expect(composer().placeholder).not.toBe('Connecting…'))
    expect(reachable()).toContain('Send message')
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

  it('opens normally on a thread of an offline computer, which says it could not reach that computer, with Retry', async () => {
    const node = 'nod_0123456789abcdefghjkmnpqrs'
    const far = `${node}:thr_far`
    const farThread = { ...thread(far, 'Work on the laptop'), node, offline: true }
    stubBridge({ ...warmView, threads: [...warmView.threads, farThread] as never, activeThreadId: far, messages: [] })
    await launch()
    const { useComputersStore } = await import('../../src/renderer/lib/computers')
    useComputersStore.setState({ loaded: true, routed: true, byNode: { [node]: { node, name: 'Laptop', online: false } as never }, devices: [] })
    await bind(WARM_PROFILE)
    // As main does when the thread's computer is offline: it is selected, its read fails, and the load finishes.
    await act(async () => {
      listeners['projects.onUpdated']!([])
      listeners['threads.onUpdated']!([...freshThreads, farThread], { epoch: 'service', seq: 1, generation: 1 })
      listeners['threads.onSelected']!({ id: far })
      listeners['threads.onViewFailed']!({ threadId: far, reason: 'Laptop is offline.' })
    })
    initialize.resolve()
    await settle(20)

    expect(useAppStore.getState().workspaceReady).toBe(true)
    expect(host.textContent).not.toContain('Could not connect to workspace')
    const alert = host.querySelector('[data-mousse="chat"] [role="alert"]')
    expect(alert?.textContent).toContain("Couldn't reach Laptop")
    expect(host.querySelector('.chat--empty')).toBeNull()
    const retry = [...alert!.querySelectorAll('button')].find((button) => button.textContent?.includes('Retry'))!
    await act(async () => retry.click())
    await settle()
    expect(calls.some((call) => call.method === 'threads.select' && call.args[0] === far)).toBe(true)
  })

  it('shows the loading skeleton as before when nothing was kept', async () => {
    stubBridge(null)
    await launch()
    expect(host.querySelector('[data-mousse="chat"]')).toBeNull()
    expect(host.querySelector('[data-workspace-loading]')).not.toBeNull()
  })
})

describe('the first frame', () => {
  it('shows the warm start in the first render, before any read settles', async () => {
    stubBridge(warmView)
    const App = await load()
    // One synchronous render: no promise has settled, so nothing asked for asynchronously can be on screen.
    act(() => root.render(createElement(App)))
    expect(sidebarText()).toContain('Release notes')
    expect(chatText()).toContain('Ship the warm start')
    expect(host.querySelector('[data-workspace-loading]')).toBeNull()
  })
})

describe('the handover', () => {
  const ICON = 'data:image/png;base64,iVBORw0KGgo='
  const project = { id: 'p-app', name: 'app', path: 'C:/code/app', createdAt: T, order: 0, detectedIconPath: 'C:/code/app/favicon.png', iconDetectedAt: T }
  const inProject = (id: string, name: string) => ({ ...thread(id, name), projectId: 'p-app' })

  it('shows the threads\' badges and the projects\' icons as they were, and the live lists keep them', async () => {
    const threads = [inProject('t-release', 'Release notes'), inProject('t-login', 'Fix the login')]
    stubBridge({
      ...warmView,
      threads: threads as never,
      projects: [project] as never,
      // A finished thread shows Done; one that was still working shows nothing until the service says so.
      activity: { 't-login': 'completed', 't-release': 'processing' },
      projectIcons: { 'p-app': { dataUrl: ICON } as never }
    })
    extraAnswers = {
      'threads.getActivity': () => Promise.resolve({ 't-login': 'completed', 't-release': 'idle' }),
      'projects.icon': () => Promise.resolve({ dataUrl: ICON })
    }
    await launch()
    const icon = () => host.querySelector<HTMLImageElement>('[data-mousse="sidebar"] img[data-mousse="project-icon"]')?.getAttribute('src') ?? null
    const done = () => [...host.querySelectorAll('[data-mousse="sidebar"] .threads-sidebar-card-status-done')].map((mark) => mark.closest('[data-thread-id]')?.getAttribute('data-thread-id')).sort().join(',')
    const working = () => host.querySelectorAll('[data-mousse="sidebar"] .threads-sidebar-card-status-working').length
    const warmDone = done()
    expect(warmDone).toMatch(/^(t-login,?)+$/)
    expect(working()).toBe(0)
    expect(icon()).toBe(ICON)
    // Nothing is read for the projects and threads in the file (icons, branches) before the window's profile is known.
    expect([...callsNaming('p-app'), ...callsNaming('t-login'), ...callsNaming('t-release')]).toEqual([])

    const frames = await framesOf(() => ({ done: done(), icon: icon() }), () => connect(WARM_PROFILE, { threads, messages: freshMessages, projects: [project] }))
    expect(useAppStore.getState().workspaceReady).toBe(true)
    expect(frames.filter((frame) => frame.done !== warmDone || frame.icon !== ICON)).toEqual([])
    expect(done()).toBe(warmDone)
    expect(icon()).toBe(ICON)
  })

  it('shows Done and the project\'s finished count from the first frame with a file shaped like a real one', async () => {
    // As main writes it on a real profile (November 2026): projects with detected icons, the Projects tree, threads
    // with their last run, subagent threads that finished unseen, an archived one, and only settled states kept.
    const realProject = (id: string, name: string, order: number) => ({ id, name, path: `E:\\code\\${name}`, createdAt: T, order, detectedIconPath: 'favicon.svg', iconDetectedAt: T, iconDetector: 2 })
    const model = { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus', name: 'Claude Opus 5.5', effort: 'high' }
    const realThread = (id: string, name: string, projectId: string, order: number, extra: object = {}) => ({
      id, name, projectId, createdAt: T, updatedAt: T, startedAt: T, order, settingsRevision: 1, modelOverride: model, worktreeEnabled: false, titleSource: 'final', lastReply: `${name}: finished.`, ...extra
    })
    const subagent = (id: string, name: string, parent: string, order: number) => realThread(id, name, 'p-mousse', order, { lineage: { parentThreadId: parent, rootThreadId: parent, relationship: 'subagent' }, workspaceBinding: { policy: 'isolated' }, permissionMode: 'full' })
    const projects = [realProject('p-site', 'site', 0), realProject('p-mousse', 'mousse', 1)]
    const threads = [
      realThread('t-open', 'Measure turn checkpoint time', 'p-mousse', -9, { lastRun: 'done' }),
      realThread('t-steer', 'Why steering messages disappear', 'p-mousse', -8, { lastRun: 'done', worktreeEnabled: true, permissionMode: 'full' }),
      realThread('t-queue', 'Steer queued message fix', 'p-mousse', -7, { lastRun: 'done' }),
      realThread('t-lead', 'Limits review lead', 'p-mousse', -6),
      subagent('t-sub-1', 'Limits e2e tester', 't-lead', -5),
      subagent('t-sub-2', 'Worktree pause fixer', 't-lead', -4),
      realThread('t-old', 'Archived audit', 'p-mousse', -3, { archivedAt: T, lastRun: 'done' }),
      realThread('t-site', 'Pricing page copy', 'p-site', 0)
    ]
    // Main keeps only Done and Input: here every Done the service had, the subagents' included.
    const settled = { 't-steer': 'completed', 't-queue': 'completed', 't-sub-1': 'completed', 't-sub-2': 'completed' } as const
    window.localStorage.setItem(`mousse-profile-${WARM_PROFILE}-workspace`, JSON.stringify({ threadsSidebarView: 'projects', lastThreadListView: 'projects' }))
    stubBridge({ ...warmView, threads: threads as never, projects: projects as never, activeThreadId: 't-open', activity: settled })
    // The service's snapshot names every thread it has a runtime for, idle ones too.
    extraAnswers = { 'threads.getActivity': () => Promise.resolve({ ...settled, 't-open': 'idle', 't-lead': 'idle', 't-old': 'idle', 't-site': 'idle' }) }
    const App = await load()
    act(() => root.render(createElement(App)))

    const done = () => [...host.querySelectorAll('[data-mousse="sidebar"] .threads-sidebar-card-status-done')].map((mark) => mark.closest('[data-thread-id]')?.getAttribute('data-thread-id')).sort().join(',')
    const finished = () => [...host.querySelectorAll('[data-mousse="sidebar"] .threads-sidebar-project-finished')].map((count) => count.textContent).join(',')
    const shown = () => ({ done: done(), finished: finished() })
    // The first render, before anything settles.
    const first = shown()
    expect(first.done).toBe('t-queue,t-steer')
    expect(first.finished).toBe('2')
    await settle()
    expect(shown()).toEqual(first)

    const frames = await framesOf(shown, () => connect(WARM_PROFILE, { threads, messages: freshMessages, projects, threadId: 't-open' }))
    expect(useAppStore.getState().workspaceReady).toBe(true)
    expect(frames.filter((frame) => frame.done !== first.done || frame.finished !== first.finished)).toEqual([])
    expect(shown()).toEqual(first)
  })

  describe('the transcript\'s place', () => {
    // jsdom lays nothing out: each turn is 300px tall, one after another, in a 600px list.
    const TURN = 300
    const VIEW = 600
    const scrollTops = new WeakMap<Element, number>()
    const isList = (element: Element) => element.classList.contains('an-message-list')
    const turnsOf = (list: Element) => [...list.querySelectorAll<HTMLElement>('[data-turn-key]')]
    const listOf = (element: Element) => element.closest('.an-message-list')
    const originals = {
      scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!,
      scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!,
      clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!,
      rect: Element.prototype.getBoundingClientRect
    }
    beforeEach(() => {
      Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return isList(this) ? turnsOf(this).length * TURN : 0 } })
      Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isList(this) ? VIEW : 0 } })
      Object.defineProperty(Element.prototype, 'scrollTop', {
        configurable: true,
        get(this: Element) { return scrollTops.get(this) ?? 0 },
        set(this: Element, value: number) { scrollTops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))) }
      })
      Element.prototype.getBoundingClientRect = function (this: Element) {
        const list = isList(this) ? this : listOf(this)
        const index = list && this !== list ? turnsOf(list).indexOf(this as HTMLElement) : -1
        const top = list === this ? 0 : index >= 0 ? index * TURN - list!.scrollTop : 0
        const height = list === this ? VIEW : index >= 0 ? TURN : 0
        return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect
      }
    })
    afterEach(() => {
      Object.defineProperty(Element.prototype, 'scrollTop', originals.scrollTop)
      Object.defineProperty(Element.prototype, 'scrollHeight', originals.scrollHeight)
      Object.defineProperty(Element.prototype, 'clientHeight', originals.clientHeight)
      Element.prototype.getBoundingClientRect = originals.rect
    })

    // Four turns kept by the warm start; the service's transcript has an older one before them.
    const kept = [1, 2, 3, 4].flatMap((n) => [say(`u${n}`, 'user', `Question ${n}`), say(`a${n}`, 'assistant', `Answer ${n}`)])
    const full = [say('u0', 'user', 'Question 0'), say('a0', 'assistant', 'Answer 0'), ...kept]
    const list = () => host.querySelector<HTMLElement>('[data-mousse="chat"] .an-message-list')!
    const topOf = (turnKey: string) => turnsOf(list()).find((turn) => turn.dataset.turnKey === turnKey)!.getBoundingClientRect().top

    it('opens the live transcript with the turn the person was reading at the same place', async () => {
      stubBridge({ ...warmView, messages: kept as never })
      await launch()
      const warmList = list()
      // Read up from the end: the second turn's top is 50px above the list's top.
      await act(async () => {
        warmList.scrollTop = TURN + 50
        warmList.dispatchEvent(new Event('scroll'))
      })
      const reading = turnsOf(warmList)[1]!.dataset.turnKey!
      expect(topOf(reading)).toBe(-50)

      // The window learning its profile leaves the warm transcript where it is.
      await bind(WARM_PROFILE)
      expect(list()).toBe(warmList)
      expect(list().scrollTop).toBe(TURN + 50)

      await act(async () => {
        listeners['projects.onUpdated']!([])
        listeners['threads.onUpdated']!(freshThreads, { epoch: 'service', seq: 1, generation: 1 })
        listeners['threads.onSelected']!({ id: 't-release' })
        listeners['threads.onView']!({ threadId: 't-release', messages: full, agents: [], tasks: [] })
      })
      initialize.resolve()
      await settle(20)
      expect(host.querySelector('[data-warm-start]')).toBeNull()
      expect(turnsOf(list())).toHaveLength(5)
      expect(topOf(reading)).toBe(-50)
    })

    it('keeps a transcript read at its end at its end', async () => {
      stubBridge({ ...warmView, messages: kept as never })
      await launch()
      expect(list().scrollTop).toBe(list().scrollHeight - VIEW)
      await connect(WARM_PROFILE, { threads: freshThreads, messages: full })
      expect(host.querySelector('[data-warm-start]')).toBeNull()
      expect(list().scrollTop).toBe(list().scrollHeight - VIEW)
    })
  })

  it('shows a new chat with the greeting, rows and composer the live chat shows, and keeps them', async () => {
    const newChat = { id: 't-new', name: 'New thread', createdAt: T, updatedAt: T, order: -1, projectId: 'p-app' }
    const threads = [newChat, inProject('t-login', 'Fix the login')]
    stubBridge({ ...warmView, threads: threads as never, projects: [project] as never, activeThreadId: 't-new', messages: [] })
    await launch()
    const shown = () => ({
      greeting: host.querySelector('[data-mousse="chat"] .chat-empty-title')?.textContent ?? null,
      project: host.querySelector('[data-mousse="chat"] [aria-label="Project"]')?.textContent ?? null,
      settings: Boolean(host.querySelector('[data-mousse="chat"] [aria-label="New thread settings"]')),
      composer: Boolean(host.querySelector('[data-mousse="chat"] .composer-input'))
    })
    const warm = shown()
    expect(warm.greeting).toBeTruthy()
    expect(warm.project).toContain('app')
    expect(warm).toMatchObject({ settings: true, composer: true })
    // The project's Git state waits for the window's profile.
    expect(calls.filter((call) => call.method.startsWith('git.'))).toEqual([])

    const frames = await framesOf(shown, () => connect(WARM_PROFILE, { threads, messages: [], projects: [project], threadId: 't-new' }))
    expect(host.querySelector('[data-warm-start]')).toBeNull()
    expect(shown()).toEqual(warm)
    expect(frames.filter((frame) => frame.greeting !== warm.greeting || !frame.composer || !frame.settings || frame.project !== warm.project)).toEqual([])
  })
})
