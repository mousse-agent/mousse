// @vitest-environment jsdom
/**
 * A bot's own browser in its chat: a small live preview in the reply of the run that used it (or
 * under the working line until that reply comes), with the agent cursor drawn over the picture;
 * hovering shows Expand, which opens the split view beside the chat, where the owner can take the
 * browser over, click and type in it, and give it back. Pictures are pushed while the preview or the
 * split view is seen, and the view says when they stop.
 */
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotBrowserFrameEvent, BotBrowserView, BotsBrowserApi, BotsBrowserMethod } from '../../src/shared/bots/personal/browser'
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
const { setBotBrowserTransport, useBotBrowserStore, useBotBrowserWatch, BOT_BROWSER_FRAME_MS, STOP_GRACE_MS } = await import('../../src/renderer/stores/botBrowserStore')

let root: Root
let host: HTMLElement
let fake: FakeBots
let browser: BotBrowserView
let calls: Array<[BotsBrowserMethod, Record<string, unknown>]>
let pushes: Set<(event: BotBrowserFrameEvent) => void>
let refuseWatch: unknown
let hangWatch: Promise<void> | undefined
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()
const browserInitial = useBotBrowserStore.getInitialState()

const noobesh = summary('noobesh', { name: 'Noobesh', description: 'Checks my bank pages.' })
const FRAME = { data: '/9j/AAAA', mimeType: 'image/jpeg' as const, width: 960, height: 540, viewport: { width: 1280, height: 720 }, at: Date.now() }
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }
const watches = () => calls.filter(([method]) => method === 'bots.browser.watch').map(([, params]) => params)
const unwatches = () => calls.filter(([method]) => method === 'bots.browser.unwatch').map(([, params]) => params)
/** A picture or change the daemon pushes to the window's watch. */
const push = async (event: Omit<BotBrowserFrameEvent, 'botId' | 'watchId'>) => {
  const watchId = watches().at(-1)!.watchId as string
  await act(async () => { for (const listener of pushes) listener({ botId: 'noobesh', watchId, ...event }) })
}
const status = () => host.querySelector('.bot-browser-preview .bot-browser-status')

async function open() {
  fake.bots = [noobesh]
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(noobesh.id))
  await act(async () => {})
}

/** A stand-in for the browser's IntersectionObserver whose entries the test decides. */
class FakeIntersection {
  static all = new Set<FakeIntersection>()
  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) { FakeIntersection.all.add(this) }
  observe() {}
  disconnect() { FakeIntersection.all.delete(this) }
  static async set(isIntersecting: boolean) { await act(async () => { for (const observer of FakeIntersection.all) observer.callback([{ isIntersecting }]) }) }
}

beforeEach(() => {
  fake = fakeBots()
  installPreload(fake)
  setBotsClient(fake.client)
  calls = []
  pushes = new Set()
  refuseWatch = undefined
  hangWatch = undefined
  browser = {
    open: true, control: 'bot', tab: { url: 'https://bank.example.com/statements', title: 'Statements' }, activations: ['act1'], activationId: 'act1',
    frame: FRAME, cursor: { x: 640, y: 180, action: 'click', at: Date.now(), viewport: { width: 1280, height: 720 } }
  }
  setBotBrowserTransport((async <M extends BotsBrowserMethod>(method: M, params: BotsBrowserApi[M]['params']) => {
    calls.push([method, params as Record<string, unknown>])
    if (method === 'bots.browser.watch' && refuseWatch) throw refuseWatch
    if (method === 'bots.browser.watch' && hangWatch) await hangWatch
    if (method === 'bots.browser.unwatch') return { ok: true }
    if (method === 'bots.browser.control') browser = { ...browser, control: (params as { control: 'owner' | 'bot' }).control }
    return { browser }
  }) as never, (listener) => { pushes.add(listener); return () => pushes.delete(listener) })
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
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  FakeIntersection.all.clear()
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
    // The cursor sits over the picture at the page's point, in a layer that takes no events.
    const layer = previews[0]!.querySelector<HTMLElement>('[data-agent-cursor]')!
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.classList.contains('agent-cursor-layer')).toBe(true)
    const cursor = layer.querySelector<HTMLElement>('.agent-cursor')!
    expect(cursor.style.left).toBe('50%')
    expect(cursor.style.top).toBe('25%')
    // On screen, the preview watches the browser at its own size and rate, and says it is live.
    expect(watches()).toEqual([{ botId: 'noobesh', watchId: expect.any(String), width: 480, fps: 5 }])
    expect(status()?.textContent).toBe('Live')
    // It never asks for pictures itself.
    expect(calls.some(([method, params]) => method === 'bots.browser.get' && params.frame === true)).toBe(false)
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
    expect(watches()).toEqual([])
  })
})

describe('the pictures pushed to the view', () => {
  it('shows each pushed picture, the cursor moving and clearing, and the tab behind', async () => {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    await open()
    await push({ frame: { data: '/9j/BBBB', mimeType: 'image/jpeg', width: 480, height: 270, at: Date.now() }, tab: { url: 'https://bank.example.com/next', title: 'Next' } })
    expect(host.querySelector('.bot-browser-preview img')!.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/BBBB')
    expect(host.querySelector('.bot-browser-preview figcaption')!.textContent).toContain('Next')
    await push({ cursor: null })
    expect(host.querySelector('.bot-browser-preview .agent-cursor')).toBeNull()
    await push({ behind: true })
    expect(status()?.textContent).toBe('On another tab')
    expect(status()?.getAttribute('title')).toMatch(/Noobesh is using another of its tabs/)
    await push({ behind: false })
    expect(status()?.textContent).toBe('Live')
  })

  it('says it is not updating, and for how long, when pictures stop; and recovers by itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    try {
      fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
      await open()
      expect(status()?.textContent).toBe('Live')
      await push({ stalled: 'The browser could not be reached.' })
      expect(status()?.textContent).toMatch(/^Not updating · \d s$/)
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(status()?.textContent).toMatch(/^Not updating · [5-9] s$/)
      // The picture stays meanwhile.
      expect(host.querySelector('.bot-browser-preview img')).not.toBeNull()
      expect(host.querySelector('.bot-browser-preview')!.classList.contains('is-stale')).toBe(true)
      await push({ live: true, frame: { data: '/9j/CCCC', mimeType: 'image/jpeg', width: 480, height: 270, at: Date.now() } })
      expect(status()?.textContent).toBe('Live')
      // The watch cannot be renewed (the service is away): not updating, and it tries again by itself.
      refuseWatch = Object.assign(new Error('connection lost'), { code: 'mms_unavailable' })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(status()?.textContent).toMatch(/^Not updating/)
      refuseWatch = undefined
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
      expect(status()?.textContent).toBe('Live')
      // A service that hangs (the renewal never answers) is not updating either, and recovers when it answers.
      let answer: (() => void) | undefined
      hangWatch = new Promise<void>((resolve) => { answer = resolve })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000 + 5_000) })
      expect(status()?.textContent).toMatch(/^Not updating/)
      hangWatch = undefined
      await act(async () => { answer!(); await vi.advanceTimersByTimeAsync(0) })
      expect(status()?.textContent).toBe('Live')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops watching when the preview leaves the screen or the window is hidden, and watches again when seen', async () => {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersection
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    await open()
    // Not reported on screen yet: nothing is watched.
    expect(watches()).toEqual([])
    await FakeIntersection.set(true)
    expect(watches()).toHaveLength(1)
    const watchId = watches()[0]!.watchId
    // Scrolled out of sight (after a moment's grace, for a view that only moves).
    await FakeIntersection.set(false)
    expect(unwatches()).toEqual([])
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS + 50)) })
    expect(unwatches()).toEqual([{ botId: 'noobesh', watchId }])
    await FakeIntersection.set(true)
    expect(watches()).toHaveLength(2)
    // The window is hidden (minimised): no watch.
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS + 50)) })
    expect(unwatches()).toHaveLength(2)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(watches()).toHaveLength(3)
    visibility.mockRestore()
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
    // The split view is watched at its width (up to 960) and 15 a second; the preview it covers is not.
    expect(watches().at(-1)).toMatchObject({ width: 960, fps: 15 })
    await click(button('Take over'))
    expect(calls).toContainEqual(['bots.browser.control', { botId: 'noobesh', control: 'owner' }])
    expect(button('Give back')).toBeDefined()
    // Faster while the owner holds the browser.
    expect(watches().at(-1)).toMatchObject({ width: 960, fps: 30 })
    // A click on the picture lands at the page's point: the frame is 1280×720 wide whatever its size on screen.
    const frame = pane.querySelector<HTMLElement>('.bot-browser-frame')!
    frame.getBoundingClientRect = () => ({ left: 100, top: 50, width: 640, height: 360, right: 740, bottom: 410, x: 100, y: 50, toJSON: () => ({}) })
    await act(async () => { frame.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 420, clientY: 140 })) })
    expect(calls).toContainEqual(['bots.browser.input', { botId: 'noobesh', input: { kind: 'click', x: 640, y: 180 } }])
    await click(button('Give back'))
    expect(calls).toContainEqual(['bots.browser.control', { botId: 'noobesh', control: 'bot' }])
    await click(button('Close the browser view'))
    expect(host.querySelector('.bot-browser-pane')).toBeNull()
    // Back to the preview's own size and rate.
    expect(watches().at(-1)).toMatchObject({ width: 480, fps: 5 })
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

describe('the bot browser\'s pictures', () => {
  it('an unchanged picture read again changes nothing, so nothing re-renders; a new one replaces it', async () => {
    let views = 0
    const stop = useBotBrowserStore.subscribe(() => { views += 1 })
    const read = () => act(async () => { await useBotBrowserStore.getState().load('noobesh', true) })
    await read()
    const first = useBotBrowserStore.getState().views.noobesh
    // The read, and the stream marked live.
    expect(views).toBe(2)
    // The same page read again (a fresh copy, read later): the state stays as it was.
    browser = JSON.parse(JSON.stringify({ ...browser, frame: { ...FRAME, at: FRAME.at + 40 } })) as BotBrowserView
    await read()
    expect(views).toBe(2)
    expect(useBotBrowserStore.getState().views.noobesh).toBe(first)
    // The page painted something new: it shows.
    browser = { ...browser, frame: { ...FRAME, data: '/9j/BBBB', at: FRAME.at + 80 } }
    await read()
    expect(views).toBe(3)
    expect(useBotBrowserStore.getState().views.noobesh!.frame!.data).toBe('/9j/BBBB')
    stop()
  })

  it('with a service that cannot push pictures, asks for one at a steady pace, only while seen', async () => {
    vi.useFakeTimers()
    try {
      refuseWatch = Object.assign(new Error('Domain method is unavailable'), { code: 'method_not_available' })
      const reads: number[] = []
      setBotBrowserTransport((async (method: BotsBrowserMethod, params: Record<string, unknown>) => {
        calls.push([method, params])
        if (method === 'bots.browser.watch') throw refuseWatch
        if (method === 'bots.browser.get' && params.frame) {
          reads.push(Date.now())
          // A read that takes 30 ms of the interval.
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        return { browser }
      }) as never, () => () => undefined)
      useBotBrowserStore.setState({ views: { noobesh: browser } })
      const Probe = ({ seen }: { seen: boolean }) => {
        const element = useRef<HTMLDivElement>(null)
        useBotBrowserWatch('noobesh', element, seen ? { width: 480, fps: 5 } : undefined)
        return createElement('div', { ref: element })
      }
      await act(async () => root.render(createElement(Probe, { seen: true })))
      await act(async () => { await vi.advanceTimersByTimeAsync(BOT_BROWSER_FRAME_MS * 10) })
      const gaps = reads.slice(1).map((at, index) => at - reads[index]!)
      expect(gaps.length).toBeGreaterThanOrEqual(8)
      expect(gaps.every((gap) => gap === BOT_BROWSER_FRAME_MS)).toBe(true)
      expect(BOT_BROWSER_FRAME_MS).toBeLessThanOrEqual(50)
      // Not seen: it stops asking (after a moment's grace).
      await act(async () => root.render(createElement(Probe, { seen: false })))
      await act(async () => { await vi.advanceTimersByTimeAsync(STOP_GRACE_MS) })
      const asked = reads.length
      await act(async () => { await vi.advanceTimersByTimeAsync(BOT_BROWSER_FRAME_MS * 10) })
      expect(reads.length).toBeLessThanOrEqual(asked + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})
