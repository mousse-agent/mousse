// @vitest-environment jsdom
/**
 * A link to a thread (`mousse://thread/<id>`, or `<node>:<id>` for a thread of another computer) in a thread's reply or
 * a bot's message: a chip that reads as the thread's title when its text is the address, with the thread's live status,
 * and a click opens that thread in the app, out of the bot's chat. A thread this window cannot open says why in the chip
 * (deleted, its computer offline or not sharing), and a click says it in a toast. Only links become chips: an id in
 * prose stays text. How the chip looks is checked in the real app (screenshots on the PR), not here.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../src/shared/types'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/editors/MarkdownPreview', async () => {
  const { createElement: h } = await import('react')
  return { MarkdownPreview: ({ value, className }: { value: string; className?: string }) => h('div', { className }, value) }
})
// The chat's composer pulls in the microphone's audio worklets, which jsdom does not have.
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const { BotChatView } = await import('../../src/renderer/components/bots/BotChatView')
const { Markdown } = await import('../../src/renderer/chat/components/agent-elements/markdown')
const { ToastHost, dismissToast } = await import('../../src/renderer/components/ui/Toast')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useComputersStore, NO_COMPUTERS } = await import('../../src/renderer/lib/computers')
const { parseThreadLink } = await import('../../src/shared/threadLink')

const NOW = '2026-11-15T10:00:00.000Z'
const thread = (id: string, name: string): Thread => ({ id, name, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1' }) as Thread

let root: Root
let host: HTMLElement
let fake: FakeBots
const select = vi.fn(async () => undefined)
const appInitial = useAppStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()
const links = () => [...host.querySelectorAll<HTMLAnchorElement>('a.thread-chip')]
/** A link's text, then its tooltip: the status shows in the tooltip, not beside the title. */
const said = (link: HTMLAnchorElement) => [link.textContent, link.getAttribute('title')]
const DESK = 'nod_desk0000000000000000000000'
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }

beforeEach(() => {
  fake = fakeBots()
  installPreload(fake, { threads: { select } })
  setBotsClient(fake.client)
  select.mockClear()
  useAppStore.setState({ threads: [thread('t-fix', 'Fix the login page'), thread('t-docs', 'Write the docs')] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  dismissToast()
  setBotsClient(null)
  useBotsStore.setState(botsInitial)
  useComputersStore.setState(NO_COMPUTERS)
  useAppStore.setState(appInitial)
})

describe('a thread link in a bot\'s message', () => {
  const bot = summary('b1', { name: 'Kai' })
  async function show(text: string) {
    fake.bots = [bot]
    fake.chats.b1 = [message(1, { text })]
    await act(async () => { await useBotsStore.getState().loadChat('b1') })
    act(() => root.render(createElement('div', null, createElement(BotChatView, { bot }), createElement(ToastHost))))
  }

  it('reads as the thread\'s title, and a click opens the thread out of the bot\'s chat', async () => {
    await show('I started mousse://thread/t-fix and [the docs one](mousse://thread/t-docs). Not `mousse://thread/t-fix` in code.')
    expect(links().map((link) => [link.querySelector('.thread-chip-title')!.textContent, link.getAttribute('href')])).toEqual([
      ['Fix the login page', 'mousse://thread/t-fix'],
      ['the docs one', 'mousse://thread/t-docs']
    ])
    expect(host.querySelector('code')?.textContent).toBe('mousse://thread/t-fix')
    useAppStore.setState({ sidebarMode: 'chats', threadsSidebarView: 'chats' })
    const open = vi.spyOn(window, 'open')
    await click(links()[0]!)
    expect(select).toHaveBeenCalledWith('t-fix')
    expect(useAppStore.getState().sidebarMode).toBe('projects')
    expect(useAppStore.getState().threadsSidebarView).toBe('projects')
    expect(open).not.toHaveBeenCalled()
  })

  it('a deleted thread says so in its link, and a click says it again without opening anything', async () => {
    await show('See <mousse://thread/t-gone>.')
    const [link] = links()
    expect(said(link!)).toEqual(['A thread', 'That thread is no longer here.'])
    expect(link!.getAttribute('aria-label')).toBe('Thread, Deleted')
    expect(link!.getAttribute('aria-disabled')).toBe('true')
    await click(link!)
    expect(select).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('That thread is no longer here.')
  })
})

describe('a thread link in a thread\'s reply', () => {
  const render = (content: string) => act(() => root.render(createElement('div', null, createElement(Markdown, { content }), createElement(ToastHost))))

  it('is a link with the thread\'s title and live status, and a click opens the thread', async () => {
    useAppStore.setState({ threadActivity: { 't-docs': 'processing' } })
    render('Done, see mousse://thread/t-docs.')
    const [link] = links()
    expect(said(link!)).toEqual(['Write the docs', 'Working · Open Write the docs'])
    expect(link!.getAttribute('aria-label')).toBe('Open thread Write the docs, Working')
    act(() => useAppStore.setState({ threadActivity: { 't-docs': 'paused' } }))
    expect(said(link!)).toEqual(['Write the docs', 'Paused · Open Write the docs'])
    // An archived thread says so, and still opens.
    act(() => useAppStore.setState({ threads: [thread('t-docs', 'Write the docs'), { ...thread('t-fix', 'Fix the login page'), settledAt: NOW }] }))
    render('Archived: mousse://thread/t-fix')
    expect(said(links()[0]!)).toEqual(['Fix the login page', 'Archived · Open Fix the login page'])
    await click(links()[0]!)
    expect(select).toHaveBeenCalledWith('t-fix')
  })

  it('a right-click offers Copy reference, which copies the thread\'s link and opens nothing', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render('Done, see mousse://thread/t-docs.')
    const [link] = links()
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    act(() => { link!.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.map((item) => item.textContent)).toEqual(['Copy reference'])
    expect(document.activeElement).toBe(items[0])
    await click(items[0]!)
    expect(writeText).toHaveBeenCalledWith('mousse://thread/t-docs')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(select).not.toHaveBeenCalled()
  })

  it('Shift+F10 opens the menu from the keyboard, and Escape closes it with focus back on the link', () => {
    render('Done, see mousse://thread/t-docs.')
    const [link] = links()
    act(() => link!.focus())
    act(() => { link!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) })
    const item = document.querySelector<HTMLElement>('[role="menuitem"]')!
    expect(document.activeElement).toBe(item)
    act(() => { item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(link)
  })

  it('only a link becomes a thread link: a thread id written in prose stays text', () => {
    render('The thread t-docs is done, and so is thread/t-fix. Its link: [docs](mousse://thread/t-docs).')
    expect(links()).toHaveLength(1)
    expect(links()[0]!.textContent).toBe('docs')
    expect(host.textContent).toContain('The thread t-docs is done, and so is thread/t-fix.')
  })

  describe('to a thread of another computer', () => {
    const remote = `${DESK}:t-plan`
    const device = (state: 'open' | 'closed') => ({ node: DESK, name: 'Desk', caps: [], keyEpoch: 1, expiresAt: 0, kind: 'computer', self: false, revoked: false, state })
    function computers(state: 'open' | 'closed') {
      const request = vi.fn(async (method: string) => method === 'net.status'
        ? { enabled: true, self: { node: 'nod_self' }, keystore: 'unlocked', features: { netBridge: true, netBridgeThreads: true } }
        : { nodes: [device(state)] })
      installPreload(fake, { threads: { select }, platformRequest: { request } })
    }

    it('survives in the reply, and opens when the window lists it', async () => {
      computers('open')
      useAppStore.setState({ threads: [{ ...thread(remote, 'Plan the trip'), node: DESK }] })
      render(`On the desk: mousse://thread/${remote}`)
      await act(async () => {})
      expect(links()[0]!.getAttribute('href')).toBe(`mousse://thread/${remote}`)
      expect(links()[0]!.textContent).toBe('Plan the trip')
      await click(links()[0]!)
      expect(select).toHaveBeenCalledWith(remote)
    })

    it('says its computer is offline, or not sharing, from what the window already holds', async () => {
      computers('closed')
      // Listed, but its computer is not connected: the row says so.
      useAppStore.setState({ threads: [{ ...thread(remote, 'Plan the trip'), node: DESK, offline: true }] })
      render(`mousse://thread/${remote}`)
      await act(async () => {})
      expect(said(links()[0]!)).toEqual(['Plan the trip', 'Desk is offline · Open Plan the trip'])
      // Not listed: the device list says the computer is not connected; a click says so instead of failing.
      act(() => useAppStore.setState({ threads: [] }))
      expect(said(links()[0]!)).toEqual(['A thread on another computer', 'Desk is not connected, so this thread cannot be opened now.'])
    expect(links()[0]!.getAttribute('aria-label')).toBe('Thread on another computer, Desk is offline')
      await click(links()[0]!)
      expect(select).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('Desk is not connected, so this thread cannot be opened now.')
      // Its computer's other rows say it stopped sharing.
      act(() => useAppStore.setState({ threads: [{ ...thread(`${DESK}:other`, 'Other'), node: DESK, notShared: true }] }))
      expect(said(links()[0]!)).toEqual(['A thread on another computer', 'Desk no longer shares its threads with this computer.'])
    expect(links()[0]!.getAttribute('aria-label')).toBe('Thread on another computer, Desk is not sharing')
    })
  })
})

describe('the thread link scheme', () => {
  it.each([
    ['mousse://thread/t-1', 't-1'],
    ['MOUSSE://thread/t-1/', 't-1'],
    [`mousse://thread/${DESK}:t-1`, `${DESK}:t-1`],
    // A colon joins only a real node id and one thread id.
    ['mousse://thread/desk:t-1', null],
    [`mousse://thread/${DESK}:t-1:t-2`, null],
    ['mousse://thread/', null],
    ['mousse://thread/t 1', null]
  ])('%s names %s', (href, id) => {
    expect(parseThreadLink(href)).toBe(id)
  })
})
