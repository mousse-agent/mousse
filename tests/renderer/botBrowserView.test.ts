// @vitest-environment jsdom
/**
 * A bot's own browser in its chat: a small live preview in the reply of the run that used it (or
 * under the working line until that reply comes), with the agent cursor drawn over the picture;
 * hovering shows Expand, which opens the split view beside the chat, where the owner can take the
 * browser over, click and type in it, and give it back.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotBrowserView, BotsBrowserApi, BotsBrowserMethod } from '../../src/shared/bots/personal/browser'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/chats/ChatResourcesPanel', () => ({ ChatResourcesPanel: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTranscript', () => ({ NetworkTranscript: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkChatActions', () => ({ NetworkChatActions: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTaskPicker', () => ({ NetworkTaskPicker: () => null }))
vi.mock('../../src/renderer/components/chats/ChatBrowserAccess', () => ({ ChatBrowserAccess: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
// The composer's microphone pulls in audio worklets jsdom does not have; these tests never record.
vi.mock('../../src/renderer/dictation/microphone', () => ({}))
vi.mock('../../src/renderer/components/editors/MarkdownPreview', async () => {
  const { createElement: h } = await import('react')
  return { MarkdownPreview: ({ value, className }: { value: string; className?: string }) => h('div', { className }, value) }
})

const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { setBotBrowserTransport, useBotBrowserStore } = await import('../../src/renderer/stores/botBrowserStore')

let root: Root
let host: HTMLElement
let fake: FakeBots
let browser: BotBrowserView
let calls: Array<[BotsBrowserMethod, unknown]>
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()
const browserInitial = useBotBrowserStore.getInitialState()

const noobesh = summary('noobesh', { name: 'Noobesh', description: 'Checks my bank pages.' })
const FRAME = { data: '/9j/AAAA', mimeType: 'image/jpeg' as const, width: 960, height: 540, viewport: { width: 1280, height: 720 }, at: Date.now() }
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }

async function open() {
  fake.bots = [noobesh]
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(noobesh.id))
  await act(async () => {})
}

beforeEach(() => {
  fake = fakeBots()
  installPreload(fake)
  setBotsClient(fake.client)
  calls = []
  browser = {
    open: true, control: 'bot', tab: { url: 'https://bank.example.com/statements', title: 'Statements' }, activations: ['act1'], activationId: 'act1',
    frame: FRAME, cursor: { x: 640, y: 180, action: 'click', at: Date.now(), viewport: { width: 1280, height: 720 } }
  }
  setBotBrowserTransport((async <M extends BotsBrowserMethod>(method: M, params: BotsBrowserApi[M]['params']) => {
    calls.push([method, params])
    if (method === 'bots.browser.control') browser = { ...browser, control: (params as { control: 'owner' | 'bot' }).control }
    return { browser }
  }) as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setBotsClient(null)
  setBotBrowserTransport(null)
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
  useBotBrowserStore.setState(browserInitial)
})

describe('the bot browser preview', () => {
  it('shows in the reply of the run that used the browser, with the picture, the page and the agent cursor', async () => {
    fake.chats.noobesh = [message(1, { text: 'Earlier.', activationId: 'act0' }), message(2, { author: 'owner', text: 'Check my statement' }), message(3, { text: 'Here it is.', activationId: 'act1', chips: [{ icon: 'web', text: 'used the browser', highlight: 'bank.example.com' }] })]
    await open()
    const previews = host.querySelectorAll('.bot-browser-preview')
    expect(previews).toHaveLength(1)
    expect(previews[0]!.closest('article')?.getAttribute('data-message-id')).toBe('m3')
    const image = previews[0]!.querySelector('img')!
    expect(image.getAttribute('src')).toBe(`data:image/jpeg;base64,${FRAME.data}`)
    expect(previews[0]!.querySelector('figcaption')?.textContent).toContain('Statements')
    expect(previews[0]!.querySelector('figcaption')?.textContent).toContain('bank.example.com')
    expect(previews[0]!.querySelector('figcaption')?.textContent).toContain('Live')
    // The cursor sits over the picture at the page's point, in a layer that takes no events.
    const layer = previews[0]!.querySelector<HTMLElement>('[data-agent-cursor]')!
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.classList.contains('agent-cursor-layer')).toBe(true)
    const cursor = layer.querySelector<HTMLElement>('.agent-cursor')!
    expect(cursor.style.left).toBe('50%')
    expect(cursor.style.top).toBe('25%')
    expect(calls.some(([method, params]) => method === 'bots.browser.get' && (params as { frame?: boolean }).frame === true)).toBe(true)
  })

  it('follows a run still working before its reply, under the working line', async () => {
    fake.bots = [{ ...noobesh, state: 'working', stateText: 'Working…' }]
    fake.chats.noobesh = [message(1, { author: 'owner', text: 'Check my statement' })]
    await open()
    expect(host.querySelector('.bot-browser-live .bot-browser-preview')).not.toBeNull()
  })

  it('shows nothing when the bot never used the browser', async () => {
    browser = { open: false, control: 'bot', activations: [] }
    fake.chats.noobesh = [message(1, { text: 'Hi.', activationId: 'act0' })]
    await open()
    expect(host.querySelector('.bot-browser-preview')).toBeNull()
    expect(host.querySelector('.bot-browser-pane')).toBeNull()
  })
})

describe('the split view', () => {
  it('Expand opens the bot\'s browser beside its chat; Take over, a click and Give back reach the bot\'s browser', async () => {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    await open()
    const expand = button('Expand Noobesh\'s browser')!
    expect(expand.closest('.bot-browser-preview')).not.toBeNull()
    await click(expand)
    const pane = host.querySelector<HTMLElement>('.bot-browser-pane')!
    expect(pane).not.toBeNull()
    // Beside the chat, not inside it.
    expect(pane.parentElement).toBe(host.querySelector('.chat-conversation')!.parentElement)
    expect(pane.querySelector<HTMLInputElement>('input')!.value).toBe('https://bank.example.com/statements')
    expect(pane.querySelector('[data-agent-cursor]')).not.toBeNull()
    expect(pane.textContent).toContain('Noobesh is using its own browser')
    await click(button('Take over'))
    expect(calls).toContainEqual(['bots.browser.control', { botId: 'noobesh', control: 'owner' }])
    expect(button('Give back')).toBeDefined()
    // A click on the picture lands at the page's point: the frame is 1280×720 wide whatever its size on screen.
    const frame = pane.querySelector<HTMLElement>('.bot-browser-frame')!
    frame.getBoundingClientRect = () => ({ left: 100, top: 50, width: 640, height: 360, right: 740, bottom: 410, x: 100, y: 50, toJSON: () => ({}) })
    await act(async () => { frame.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 420, clientY: 140 })) })
    expect(calls).toContainEqual(['bots.browser.input', { botId: 'noobesh', input: { kind: 'click', x: 640, y: 180 } }])
    await click(button('Give back'))
    expect(calls).toContainEqual(['bots.browser.control', { botId: 'noobesh', control: 'bot' }])
    await click(button('Close the browser view'))
    expect(host.querySelector('.bot-browser-pane')).toBeNull()
  })
})

describe('the agent cursor over a live in-app page', () => {
  it('sits at the page\'s CSS pixels at the tab\'s zoom, in a layer that takes no events', async () => {
    const { AgentCursor } = await import('../../src/renderer/components/browser/AgentCursor')
    await act(async () => root.render(createElement(AgentCursor, { cursor: { x: 50, y: 20, action: 'click', at: Date.now(), viewport: { width: 400, height: 300 } }, zoom: 1.5 })))
    const cursor = host.querySelector<HTMLElement>('[data-agent-cursor] .agent-cursor')!
    expect(cursor.style.left).toBe('75px')
    expect(cursor.style.top).toBe('30px')
    expect(host.querySelector('.agent-cursor-ripple')).not.toBeNull()
  })
})
