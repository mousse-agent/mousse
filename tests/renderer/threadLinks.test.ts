// @vitest-environment jsdom
/**
 * A link to a thread (`mousse://thread/<id>`) in a thread's reply or a bot's message: it reads as the thread's title
 * when its text is the address, and a click opens that thread in the app, out of the bot's chat. A thread this window
 * does not list gets a short toast. How the link looks is checked in the real app (screenshot on the PR), not here.
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

const NOW = '2026-11-15T10:00:00.000Z'
const thread = (id: string, name: string): Thread => ({ id, name, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1' }) as Thread

let root: Root
let host: HTMLElement
let fake: FakeBots
const select = vi.fn(async () => undefined)
const appInitial = useAppStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()
const links = () => [...host.querySelectorAll<HTMLAnchorElement>('a.an-md-link')]
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
    expect(links().map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
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

  it('a thread that is not here keeps its address, and a click says so without opening anything', async () => {
    await show('See <mousse://thread/t-gone>.')
    const [link] = links()
    expect(link!.textContent).toBe('mousse://thread/t-gone')
    await click(link!)
    expect(select).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('That thread is no longer here.')
  })
})

describe('a thread link in a thread\'s reply', () => {
  it('reads as the thread\'s title, and a click opens the thread', async () => {
    act(() => root.render(createElement(Markdown, { content: 'Done, see mousse://thread/t-docs.' })))
    const [link] = links()
    expect(link!.textContent).toBe('Write the docs')
    await click(link!)
    expect(select).toHaveBeenCalledWith('t-docs')
  })
})
