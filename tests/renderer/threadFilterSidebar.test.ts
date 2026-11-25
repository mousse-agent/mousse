// @vitest-environment jsdom
/**
 * The sidebar's filter row, used as a person does: typing narrows the list and suggests projects and bots, a picked
 * suggestion or menu entry becomes a chip below the field, Show and Archived change what is listed, a bot's filter keeps
 * its hidden threads and its Archived, the Projects tab's menu unticks projects, and a bot's "See all" opens the Threads
 * tab filtered to it. The rules themselves are in threadFilter.test.ts.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'
import type { BotSummary } from '../../src/shared/bots/personal/chat'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/StartFromPullRequestDialog', () => ({ StartFromPullRequestDialog: () => null }))
vi.mock('../../src/renderer/components/profiles/ProfileSwitcher', () => ({ ProfileSwitcher: () => null }))
vi.mock('../../src/renderer/components/chats/ChatsSidebar', () => ({ ChatsSidebar: () => null }))

const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { useThreadFilterStore } = await import('../../src/renderer/stores/threadFilterStore')
const { NO_COMPUTERS, useComputersStore } = await import('../../src/renderer/lib/computers')
const { showBotThreads } = await import('../../src/renderer/lib/showBotThreads')

const at = '2026-11-18T10:00:00.000Z'
const projects: Project[] = [
  { id: 'p1', name: 'mousse', path: '/p/mousse', createdAt: at, order: 0 },
  { id: 'p2', name: 'smiletrack', path: '/p/smiletrack', createdAt: at, order: 1 }
]
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, projectId: 'p1', ...over })
const byBot = (id: string, name: string, over: Partial<Thread> = {}) =>
  thread(id, name, { createdByThreadId: 'bot-chat', startedByBot: { botId: 'b1', name: 'alpha' }, hidden: true, ...over })
const threads = [
  thread('t1', 'Fix steer after the answer'),
  thread('t2', 'Appointment reminders', { projectId: 'p2' }),
  thread('t3', 'Old export', { projectId: 'p2', archivedAt: at }),
  byBot('a1', 'Nightly build triage'),
  byBot('a2', 'Bump Expo SDK', { projectId: 'p2' }),
  byBot('a3', 'Notarize the nightly DMG', { archivedAt: at })
]

function preload(): unknown {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
  const group = () => new Proxy({}, { get: (_target, key: string) => call(key) })
  return new Proxy({ git: {} } as Record<string, unknown>, { get: (target, key: string) => target[key] ?? group() })
}

const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'sidebarMode'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getInitialState()[key]]))
const botsOriginal = useBotsStore.getInitialState()
const filterOriginal = useThreadFilterStore.getInitialState()

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = preload()
  useBotsStore.setState({ bots: [{ id: 'b1', name: 'alpha', look: { colour: 'blue', accessory: 'none' } } as BotSummary], loaded: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(appOriginal)
  useBotsStore.setState(botsOriginal)
  useThreadFilterStore.setState(filterOriginal, true)
  useComputersStore.setState(NO_COMPUTERS, true)
})

function show(view: 'projects' | 'threads' = 'threads', customThreads: Thread[] = threads, customProjects: Project[] = projects) {
  useAppStore.setState({ projects: customProjects, threads: customThreads, threadActivity: {}, activeThreadId: null, threadsSidebarView: view, sidebarMode: view === 'threads' ? 'threads' : 'projects' })
  act(() => root.render(createElement(ThreadsSidebar)))
}

const panel = () => host.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
const listed = () => [...panel().querySelectorAll<HTMLElement>('button[data-thread-id]')].map((row) => row.dataset.threadId)
const archivedListed = () => [...host.querySelectorAll<HTMLElement>('section[aria-label="Archived"] button[data-thread-id]')].map((row) => row.dataset.threadId)
const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Search threads"]')!
const chips = () => [...host.querySelectorAll('[aria-label="Filters"] [role="listitem"]')].map((chip) => chip.textContent)
const type = (text: string) => act(() => {
  const input = field()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const key = (element: Element, name: string) => act(() => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
const click = (element: Element | null | undefined) => act(() => { (element as HTMLElement).click() })
const openMenu = () => click(host.querySelector('button[aria-label="Filter threads"]'))
const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((entry) => entry.textContent?.includes(label))
const ticked = (label: string) => item(label)?.getAttribute('aria-checked')

describe('the sidebar filter', () => {
  it('typing narrows by title, project or bot; a suggested project becomes a chip below the field', () => {
    show()
    expect(listed()).toEqual(['t1', 't2'])
    type('steer')
    expect(listed()).toEqual(['t1'])

    type('smile')
    expect(listed()).toEqual(['t2'])
    const suggestions = [...host.querySelectorAll('[role="option"]')].map((option) => option.textContent)
    expect(suggestions).toEqual(['Project:smiletrack↵'])
    key(field(), 'Enter')
    expect(field().value).toBe('')
    expect(chips()).toEqual(['smiletrack'])
    expect(listed()).toEqual(['t2'])

    click(host.querySelector('button[aria-label="Clear project filter: smiletrack"]'))
    expect(chips()).toEqual([])
    expect(listed()).toEqual(['t1', 't2'])
  })

  it('typing also lists the threads whose messages hold it, as the service finds them', async () => {
    const search = vi.fn(async (query: string) => ({
      results: query === 'flaky retry'
        ? [{ threadId: 't2', threadName: 'Appointment reminders', matchType: 'message', messageId: 'm1', snippet: 'a flaky retry' }]
        : []
    }))
    ;(window as unknown as { mousse: { threads: Record<string, unknown> } }).mousse.threads = { search }
    show()
    type('flaky retry')
    // Nothing has the words in its title; the message match arrives once typing pauses.
    expect(listed()).toEqual([])
    await act(async () => { await new Promise((done) => setTimeout(done, 400)) })
    expect(search).toHaveBeenLastCalledWith('flaky retry', expect.any(Number), { perThread: true })
    expect(listed()).toEqual(['t2'])
    type('')
    expect(listed()).toEqual(['t1', 't2'])
  })

  it('Show lists bot threads, hidden ones too, and its chip puts My threads back', async () => {
    show()
    openMenu()
    // The menu takes focus once placed, so the arrow keys work straight away.
    await act(async () => { await new Promise((done) => requestAnimationFrame(() => done(undefined))) })
    expect(document.activeElement?.textContent).toContain('My threads')
    expect(ticked('My threads')).toBe('true')
    click(item('Bot threads'))
    expect(listed().sort()).toEqual(['a1', 'a2'])
    expect(chips()).toEqual(['Bot threads'])
    click(host.querySelector('button[aria-label^="Clear show filter"]'))
    expect(listed()).toEqual(['t1', 't2'])
    expect(document.activeElement).toBe(field())
  })

  it('Bot › searches the bots; the picked one lists its threads, hidden ones too, with its face on the chip', () => {
    show()
    openMenu()
    click(document.querySelector('[data-sub="bot"]'))
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search bots"]')!
    expect(document.activeElement).toBe(search)
    click(item('alpha'))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(chips()).toEqual(['alpha'])
    expect(host.querySelector('[aria-label="Filters"] .bot-face')).not.toBeNull()
    expect(listed().sort()).toEqual(['a1', 'a2'])
    expect(host.querySelector('.threads-sidebar-archived-count')?.textContent).toBe('1')
  })

  it('Archived lists the archived threads in place of the others, and the Archived footer goes', () => {
    show()
    openMenu()
    click(item('Archived'))
    // A bot's thread, once archived, is listed under Archived as it is today.
    expect(listed().sort()).toEqual(['a3', 't3'])
    expect(chips()).toEqual(['Archived'])
    expect(host.querySelector<HTMLElement>('.threads-sidebar-footer')!.hidden).toBe(true)
    // With no footer the list fills the sidebar, so the profile stays at the bottom.
    expect(host.querySelector<HTMLElement>('.threads-sidebar-scroll')!.dataset.fill).toBe('true')
  })

  it('in the Projects tab the menu lists the projects ticked; unticking one leaves it out until its chip is cleared', () => {
    show('projects')
    const groups = () => [...panel().querySelectorAll('.threads-sidebar-project-name')].map((name) => name.textContent)
    expect(groups()).toEqual(['mousse', 'smiletrack', 'No project'])
    openMenu()
    expect(document.querySelector('[data-sub="project"]')).toBeNull()
    expect(ticked('smiletrack')).toBe('true')
    click(item('smiletrack'))
    expect(groups()).toEqual(['mousse', 'No project'])
    expect(chips()).toEqual(['1 hidden'])
    click(host.querySelector('button[aria-label^="Clear hidden projects filter"]'))
    expect(groups()).toEqual(['mousse', 'smiletrack', 'No project'])
  })

  it('a bot\'s See all opens the Threads tab on its threads; Archived opened there keeps the filter', async () => {
    show('projects')
    useThreadFilterStore.getState().setComputer('mac')
    await act(async () => { await showBotThreads('b1') })
    expect(useAppStore.getState().threadsSidebarView).toBe('threads')
    expect(chips()).toEqual(['alpha'])
    expect(listed().sort()).toEqual(['a1', 'a2'])
    click(host.querySelector('section[aria-label="Archived"] .threads-sidebar-heading-toggle'))
    expect(archivedListed()).toEqual(['a3'])
  })

  it('Computer › is hidden when only this computer is in use', () => {
    show()
    openMenu()
    expect(document.querySelector('[data-sub="computer"]')).toBeNull()
  })

  it('Computer › filters threads by computer, narrows typing suggestions and Projects view, and clears from its chip', () => {
    useComputersStore.setState({
      loaded: true,
      routed: true,
      byNode: { mac: { node: 'mac', name: "Avarnic's Mac mini", online: true } },
      devices: []
    })
    const remoteProjects: Project[] = [
      ...projects,
      { id: 'mac:p1', name: 'mousse', path: '/Users/avarnic/mousse', createdAt: at, order: 2, node: 'mac', sameAs: 'p1' }
    ]
    const mixedThreads = [
      ...threads,
      thread('r1', 'Sidebar screenshot taker', { projectId: 'mac:p1', node: 'mac' }),
      thread('r2', 'Old Mac check', { projectId: 'mac:p1', node: 'mac', archivedAt: at })
    ]
    show('threads', mixedThreads, remoteProjects)
    expect(listed().sort()).toEqual(['r1', 't1', 't2'])

    openMenu()
    click(document.querySelector('[data-sub="computer"]'))
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search computers"]')!
    expect(document.activeElement).toBe(search)
    click(item("Avarnic's Mac mini"))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(chips()).toEqual(["Avarnic's Mac mini"])
    expect(listed()).toEqual(['r1'])
    expect(host.querySelector('.threads-sidebar-archived-count')?.textContent).toBe('1')

    // Switch to Projects view while filtered to the Mac mini: only the matching project stays listed.
    act(() => useAppStore.setState({ threadsSidebarView: 'projects', sidebarMode: 'projects' }))
    expect([...panel().querySelectorAll('.threads-sidebar-project-name')].map((name) => name.textContent)).toEqual(['mousse'])
    expect(listed()).toEqual(['r1'])

    // Pick This computer from the menu: only local threads remain.
    openMenu()
    click(document.querySelector('[data-sub="computer"]'))
    click(item('This computer'))
    expect(chips()).toEqual(['This computer'])
    expect(listed().sort()).toEqual(['t1', 't2'])

    // Clear the chip and pick the Mac mini from typing suggestions instead.
    click(host.querySelector('button[aria-label="Clear computer filter: This computer"]'))
    expect(chips()).toEqual([])
    act(() => useAppStore.setState({ threadsSidebarView: 'threads', sidebarMode: 'threads' }))
    type('mac mini')
    expect(listed()).toEqual(['r1'])
    expect([...host.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["Computer:Avarnic's Mac mini↵"])
    key(field(), 'Enter')
    expect(field().value).toBe('')
    expect(chips()).toEqual(["Avarnic's Mac mini"])
    expect(listed()).toEqual(['r1'])
  })
})
