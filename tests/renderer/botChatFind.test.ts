// @vitest-environment jsdom
/**
 * Find in a bot's chat: "Find in chat" in the bot's menu and Ctrl+F under the Chats tab open the thread's find bar
 * over the chat; it counts matches, steps through them with Enter and Shift+Enter, closes with Escape, and searches
 * (and jumps to) messages older than the chat had loaded.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/chats/ChatResourcesPanel', () => ({ ChatResourcesPanel: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTranscript', () => ({ NetworkTranscript: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkChatActions', () => ({ NetworkChatActions: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTaskPicker', () => ({ NetworkTaskPicker: () => null }))
vi.mock('../../src/renderer/components/chats/ChatBrowserAccess', () => ({ ChatBrowserAccess: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { attachCommandShortcuts } = await import('../../src/renderer/commands/useCommandShortcuts')

let root: Root
let host: HTMLElement
let fake: FakeBots
let detachKeys: () => void
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()
const appInitial = useAppStore.getInitialState()
const inbox = summary('inbox', { name: 'Inbox helper' })

const transcript = () => host.querySelector<HTMLElement>('.chat-transcript')!
const box = () => host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea.composer-input')!
const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Find in chat"]')
const count = () => host.querySelector('.chat-find-count')?.textContent
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }
const wait = (ms = 10) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
async function until(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await wait()
  expect(condition(), label).toBe(true)
}
function press(target: Element, init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}
/** Types a query and searches it at once (Enter on a query not searched yet). */
async function search(query: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), query)
    field()!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  press(field()!, { key: 'Enter' })
}
async function open() {
  fake.bots = [inbox]
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(inbox.id))
}

beforeEach(() => {
  fake = fakeBots()
  installPreload(fake, { app: { setViewedBot: vi.fn(async () => undefined) } })
  setBotsClient(fake.client)
  // The Chats tab, with no thread open: Ctrl+F belongs to the bot's chat.
  useAppStore.setState({ sidebarMode: 'chats', activeThreadId: null })
  // jsdom has no layout: ranges measure as empty boxes.
  Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect
  detachKeys = attachCommandShortcuts(window)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  detachKeys()
  host.remove()
  setBotsClient(null)
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
  useAppStore.setState({ sidebarMode: appInitial.sidebarMode, activeThreadId: appInitial.activeThreadId })
})

describe('find in a bot chat', () => {
  it('opens from the bot menu, counts matches, steps with Enter and Shift+Enter, and Escape closes it', async () => {
    fake.chats.inbox = [
      message(1, { author: 'owner', text: 'Book the Lisbon flat.' }),
      message(2, { text: 'Booked. The Lisbon host says hello.' }),
      message(3, { text: 'Anything else?' })
    ]
    await open()
    await click(button('Bot menu'))
    await click(button('Find in chat'))
    expect(field()).not.toBeNull()
    await until(() => document.activeElement === field(), 'the field has focus')

    await search('lisbon')
    // Both messages count; the search starts at the reader's place, then Enter and Shift+Enter step (and wrap).
    await until(() => /^[12] of 2$/.test(count() ?? ''), 'both messages counted, one shown')
    const first = count()
    const other = first === '1 of 2' ? '2 of 2' : '1 of 2'
    press(field()!, { key: 'Enter' })
    await until(() => count() === other, 'Enter goes to the next')
    press(field()!, { key: 'Enter', shiftKey: true })
    await until(() => count() === first, 'Shift+Enter goes back')

    press(field()!, { key: 'Escape' })
    expect(field()).toBeNull()
    expect(document.activeElement).toBe(box())
  })

  it('opens with Ctrl+F from the composer under the Chats tab', async () => {
    fake.chats.inbox = [message(1, { text: 'Hello' })]
    await open()
    box().focus()
    const event = press(box(), { key: 'f', code: 'KeyF', ctrlKey: true })
    expect(event.defaultPrevented).toBe(true)
    await until(() => document.activeElement === field(), 'the field has focus')
  })

  it('searches messages older than the chat had loaded, and jumps to one', async () => {
    // 120 messages: the chat loads the newest 50; only the fifth says zanzibar.
    fake.chats.inbox = Array.from({ length: 120 }, (_, at) => message(at + 1, at === 4 ? { text: 'The ferry to Zanzibar leaves at nine.' } : {}))
    await open()
    expect(host.querySelector('[data-turn-key="m5"]')).toBeNull()

    box().focus()
    press(box(), { key: 'f', code: 'KeyF', ctrlKey: true })
    await until(() => field() !== null, 'the bar is open')
    // The old message, once drawn, sits far below the top of the view: the find scrolls to it.
    const view = transcript()
    view.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500 }) as DOMRect
    const scrolls: number[] = []
    let top = 0
    Object.defineProperty(view, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; scrolls.push(value) } })

    const measure = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.dataset.turnKey === 'm5' ? ({ top: 4000 - top, bottom: 4040 - top, left: 0, right: 500, width: 500, height: 40 }) as DOMRect : measure.call(this)
    }
    onTestFinished(() => { HTMLElement.prototype.getBoundingClientRect = measure })

    await search('zanzibar')
    await until(() => host.querySelector('[data-turn-key="m5"]') !== null, 'the older history was loaded')
    await until(() => count() === '1 of 1', 'the match in the old message is counted')
    await until(() => scrolls.includes(4000 - 16), 'the transcript scrolled to the old message')
    expect(fake.client.messages).toHaveBeenCalledWith('inbox', expect.objectContaining({ beforeSeq: expect.any(Number) }))
  })
})
