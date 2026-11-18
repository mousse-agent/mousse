// @vitest-environment jsdom
/**
 * A bot's thread opened in the bot's chat pane, and the bot's hover card in the Chats sidebar: the sidebar stays on
 * Chats, the pane's header reads "<bot> / <thread>" with a way back, the thread's top line is only Show in sidebar (which
 * takes the sidebar to the thread list used last, the thread chosen), and the hover card lists the same threads the line
 * under the bot's name counts. Where things sit is checked in the real app (screenshots on the PR), not here.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotHoverCard } from '../../src/renderer/components/bots/BotHoverCard'
import { BotThreadHeader } from '../../src/renderer/components/bots/BotThreadHeader'
import { botRowLine } from '../../src/renderer/components/bots/botChatShape'
import { ThreadStartedByBar } from '../../src/renderer/components/ThreadStartedByBar'
import { openBotThread, useShownBotThread } from '../../src/renderer/lib/botThread'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useBotsStore } from '../../src/renderer/stores/botsStore'
import { useChatsStore } from '../../src/renderer/stores/chatsStore'
import type { BotLaunchedThread, BotSummary } from '../../src/shared/bots/personal/chat'
import type { Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = '2026-11-18T10:00:00.000Z'
const launched = (threadId: string, title: string, status: BotLaunchedThread['status'], hidden = false): BotLaunchedThread =>
  ({ threadId, title, project: 'mousse', status, startedAt: NOW, updatedAt: NOW, ...(hidden ? { hidden } : {}) })
const alpha = {
  id: 'b1', name: 'alpha', homeThreadId: 'bot-chat', state: 'idle', stateText: '', createdAt: NOW, look: { colour: 'green', accessory: 'beret' },
  threads: [launched('sfr', 'Sidebar filter row', 'running', true), launched('nightly', 'Mac nightly', 'needs_input'), launched('audit', 'Audit', 'done'), launched('hold', 'On hold', 'on_hold')]
} as unknown as BotSummary
const sfr = { id: 'sfr', name: 'Sidebar filter row', createdAt: NOW, updatedAt: NOW, createdByThreadId: 'bot-chat', startedByBot: { botId: 'b1', name: 'alpha' }, hidden: true } as Thread
const other = { id: 'other', name: 'Mine', createdAt: NOW, updatedAt: NOW } as Thread

function ShownProbe() {
  const shown = useShownBotThread()
  return createElement('output', null, shown ? `${shown.botId}:${shown.threadId}` : 'none')
}

describe('a bot\'s thread in the bot\'s chat pane', () => {
  let root: Root
  let host: HTMLElement
  const select = vi.fn(async () => undefined)
  const request = vi.fn(async (_method: string, input: { threadId: string; hidden: boolean }) => ({ thread: { ...sfr, hidden: input.hidden || undefined } }))

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    ;(window as unknown as { mousse: unknown }).mousse = { threads: { select }, platformRequest: { request } }
    select.mockClear()
    request.mockClear()
    useBotsStore.setState({ bots: [alpha], loaded: true, chats: { b1: { messages: [], hasMore: false } } as never })
    useAppStore.setState({ threads: [sfr, other], messages: [], activeThreadId: 'other', openingThreadId: null, threadsSidebarView: 'chats', sidebarMode: 'chats', lastThreadListView: 'threads', scheduledOpen: false, usageOpen: false })
    useChatsStore.setState({ activeBotId: 'b1', botThread: null, activeChatId: null })
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('opens there with the sidebar still on Chats and no thread path for the title bar; leaving Chats ends it', async () => {
    act(() => root.render(createElement(ShownProbe)))
    await act(async () => { await openBotThread('b1', 'sfr') })
    expect(select).toHaveBeenCalledWith('sfr')
    const app = useAppStore.getState()
    expect([app.threadsSidebarView, app.sidebarMode]).toEqual(['chats', 'chats'])
    expect(useChatsStore.getState().activeBotId).toBe('b1')
    // The thread is being opened; the pane shows it once it is the window's thread.
    act(() => useAppStore.getState().switchToThread('sfr', { keepWorkspace: true }))
    act(() => useAppStore.setState({ activeThreadId: 'sfr', openingThreadId: null }))
    expect(host.textContent).toBe('b1:sfr')
    expect(useAppStore.getState().sidebarMode).toBe('chats')
    // A tab click away from Chats ends it.
    act(() => useAppStore.getState().setThreadsSidebarView('projects'))
    expect(useChatsStore.getState().botThread).toBeNull()
    expect(host.textContent).toBe('none')
  })

  it('opening the bot again goes back to its chat', async () => {
    await act(async () => { await openBotThread('b1', 'sfr') })
    await act(async () => { await useChatsStore.getState().openBot('b1') })
    expect(useChatsStore.getState().botThread).toBeNull()
  })

  it('the header reads "<bot> / <thread>" with the thread\'s project and state; back and the bot\'s name return to its chat', async () => {
    useChatsStore.setState({ botThread: { botId: 'b1', threadId: 'sfr' } })
    await act(async () => root.render(createElement(BotThreadHeader, { botId: 'b1', threadId: 'sfr' })))
    expect(host.querySelector('h1')!.textContent).toBe('alpha/Sidebar filter row')
    expect(host.querySelector('.bot-presence')!.textContent).toBe('mousse · working')
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Back to alpha\'s chat"]')!.click() })
    expect(useChatsStore.getState().botThread).toBeNull()
    useChatsStore.setState({ botThread: { botId: 'b1', threadId: 'sfr' } })
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'alpha')!.click() })
    expect(useChatsStore.getState().botThread).toBeNull()
  })

  it('its top line is only Show in sidebar, which lists it again and takes the sidebar to the thread list used last with it chosen', async () => {
    useChatsStore.setState({ botThread: { botId: 'b1', threadId: 'sfr' } })
    useAppStore.setState({ activeThreadId: 'sfr' })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(host.textContent).toBe('Show in sidebar')
    await act(async () => { host.querySelector('button')!.click() })
    expect(request).toHaveBeenCalledWith('threads.setHidden', { threadId: 'sfr', hidden: false })
    const app = useAppStore.getState()
    expect([app.threadsSidebarView, app.sidebarMode, app.activeThreadId]).toEqual(['threads', 'projects', 'sfr'])
    expect(useChatsStore.getState().botThread).toBeNull()
    // Opened from the sidebar, the same thread says who started it again.
    expect(host.textContent).toBe('Started by alpha')
  })

  it('a thread the bot keeps in the sidebar has no top line in the pane', () => {
    useAppStore.setState({ threads: [{ ...sfr, hidden: undefined }, other], activeThreadId: 'sfr' })
    useChatsStore.setState({ botThread: { botId: 'b1', threadId: 'sfr' } })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(host.textContent).toBe('')
  })
})

describe('a bot\'s hover card in the Chats sidebar', () => {
  let root: Root
  let host: HTMLElement
  const card = () => document.querySelector('.bot-hover-card')
  const rest = async (element: Element) => {
    await act(async () => { element.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })) })
    await act(async () => { vi.advanceTimersByTime(400) })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    ;(window as unknown as { mousse: unknown }).mousse = { threads: { select: vi.fn(async () => undefined) } }
    useBotsStore.setState({ bots: [alpha], loaded: true })
    useAppStore.setState({ threads: [sfr, other], activeThreadId: 'other', openingThreadId: null, threadsSidebarView: 'chats', sidebarMode: 'chats' })
    useChatsStore.setState({ activeBotId: null, botThread: null })
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('shows its status and only the threads it works on now, the same ones the line under its name counts; one opens in its pane', async () => {
    act(() => root.render(createElement(BotHoverCard, { bot: alpha }, createElement('button', { className: 'bot-row' }, 'alpha'))))
    expect(card()).toBeNull()
    await rest(host.querySelector('.bot-row')!)
    expect(card()!.querySelector('.bot-hover-status')!.textContent).toBe('Free to chat · working on 2 threads')
    expect(botRowLine(alpha).text).toBe('Managing 2 threads')
    expect([...card()!.querySelectorAll('.bot-thread-title')].map((title) => title.textContent)).toEqual(['Sidebar filter row', 'Mac nightly'])
    await act(async () => { card()!.querySelector<HTMLButtonElement>('.bot-thread-line')!.click() })
    await act(async () => { await vi.runAllTimersAsync() })
    expect(card()).toBeNull()
    expect(useChatsStore.getState().botThread).toEqual({ botId: 'b1', threadId: 'sfr' })
    expect(useAppStore.getState().sidebarMode).toBe('chats')
  })

  it('does not open for a bot with no thread working', async () => {
    const free = { ...alpha, threads: [launched('audit', 'Audit', 'done')] } as BotSummary
    act(() => root.render(createElement(BotHoverCard, { bot: free }, createElement('button', { className: 'bot-row' }, 'alpha'))))
    await rest(host.querySelector('.bot-row')!)
    expect(card()).toBeNull()
  })
})
