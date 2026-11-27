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
const { useAppStore } = await import('../../src/renderer/stores/appStore')

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
const HOLD = { id: 'hold_1', lastSeq: 0, computer: 'Mac mini' }
/** The daemon's side of a hold: taking it hands the browser to this window, giving it back to the bot. */
function hold(op: string) {
  if (op === 'release') {
    browser = { ...browser, control: 'bot', holder: 'bot' }
    delete browser.hold
    return { browser }
  }
  browser = { ...browser, control: 'owner', holder: 'this-view', hold: HOLD }
  return { browser, hold: HOLD }
}
/** Each numbered input applied, in order. */
const applyAll = (params: BotsBrowserApi['bots.browser.send']['params']) => ({
  // A copy reads the page's selection.
  acks: params.inputs.map((sent) => ({ seq: sent.seq, status: 'applied' as const, ...('input' in sent && sent.input.kind === 'copy' ? { copied: 'the selected words' } : {}) })),
  lastSeq: params.inputs.at(-1)!.seq
})
/** What the window sent on its hold, in order. */
const sentInputs = () => calls.filter(([method]) => method === 'bots.browser.send').flatMap(([, params]) => (params as BotsBrowserApi['bots.browser.send']['params']).inputs)
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })

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
  // The view's zoom is kept across launches: each test starts at the default.
  localStorage.clear()
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
    if (method === 'bots.browser.hold') return hold((params as { request: { op: string } }).request.op)
    if (method === 'bots.browser.send') return applyAll(params as BotsBrowserApi['bots.browser.send']['params'])
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
    // On screen, the preview watches the browser at its own size and rate (as this window's view), and says it is live.
    expect(watches()).toEqual([{ botId: 'noobesh', watchId: expect.any(String), width: 480, fps: 5, viewId: expect.any(String) }])
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
    expect(host.querySelector('.watched-browser-pane')).toBeNull()
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
      // The followed tab closed: the daemon says so, and its renewals keep saying so.
      browser = { ...browser, stalled: 'The tab closed.' }
      await push({ stalled: 'The tab closed.' })
      expect(status()?.textContent).toMatch(/^Not updating · \d s$/)
      // Renewals go on (every 5 s) and answer that pictures still cannot arrive: never Live by themselves.
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(status()?.textContent).toMatch(/^Not updating · [5-9] s$/)
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(watches().length).toBeGreaterThanOrEqual(4)
      expect(status()?.textContent).toMatch(/^Not updating · 1[5-9] s$/)
      // An update with no picture (the tab's title) does not make it live either.
      await push({ tab: { url: 'https://bank.example.com/statements', title: 'Statements (1)' } })
      expect(status()?.textContent).toMatch(/^Not updating/)
      // The picture stays meanwhile.
      expect(host.querySelector('.bot-browser-preview img')).not.toBeNull()
      expect(host.querySelector('.bot-browser-preview')!.classList.contains('is-stale')).toBe(true)
      browser = { ...browser, stalled: undefined }
      await push({ live: true, frame: { data: '/9j/CCCC', mimeType: 'image/jpeg', width: 480, height: 270, at: Date.now() } })
      expect(status()?.textContent).toBe('Live')
      // The watch cannot be renewed (the service is away): not updating, and it tries again by itself.
      refuseWatch = Object.assign(new Error('connection lost'), { code: 'mms_unavailable' })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(status()?.textContent).toMatch(/^Not updating/)
      refuseWatch = undefined
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
      expect(status()?.textContent).toBe('Live')
      // A service that hangs (the renewal never answers) is not updating either, and recovers when it answers.
      let answer: (() => void) | undefined
      hangWatch = new Promise<void>((resolve) => { answer = resolve })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000 + 5_000) })
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

  it('ends its watches when the page goes (a reload), not when the daemon\'s lease runs out', async () => {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    await open()
    const watchId = watches().at(-1)!.watchId
    await act(async () => { window.dispatchEvent(new Event('pagehide')) })
    expect(unwatches()).toContainEqual({ botId: 'noobesh', watchId })
  })
})

describe('the view\'s line while the owner holds the browser', () => {
  it('never reads "On another tab" for the tab the owner holds', async () => {
    const { browserStatus } = await import('../../src/renderer/components/bots/BotBrowser')
    const held = { ...browser, control: 'owner' as const, behind: true }
    expect(browserStatus(held, { live: true }, 'Noobesh', Date.now())).toEqual({ text: 'You have it', live: true })
    expect(browserStatus({ ...held, control: 'bot' }, { live: true }, 'Noobesh', Date.now()).text).toBe('On another tab')
    // Not updating still outranks it: the owner is told when pictures stop.
    expect(browserStatus(held, { live: false, since: Date.now() - 3_000 }, 'Noobesh', Date.now()).text).toMatch(/^Not updating/)
  })
})

describe('what a page ran into', () => {
  it('says it in plain words, with Chromium\'s code only in the tooltip, and shows a page still loading', async () => {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    await open()
    const problem = { kind: 'unreachable' as const, code: 'net::ERR_NAME_NOT_RESOLVED', host: 'bank.example.com' }
    // The daemon's view has it too (a renewed watch answers it).
    browser = { ...browser, problem }
    await push({ problem })
    expect(status()?.textContent).toBe('Can\'t reach site')
    expect(status()?.getAttribute('title')).toBe('Can\'t reach bank.example.com. Check the address, or try again later (net::ERR_NAME_NOT_RESOLVED).')
    expect(host.querySelector('.bot-browser-preview')!.textContent).not.toContain('net::')
    await click(button('Expand Noobesh\'s browser'))
    const note = host.querySelector('.watched-browser-pane .watched-browser-note')!
    expect(note.textContent).toBe('Can\'t reach bank.example.com')
    expect(note.getAttribute('title')).toContain('net::ERR_NAME_NOT_RESOLVED')
    await push({ problem: { kind: 'needs-you', reason: 'human-check', host: 'shop.example.com' } })
    expect(host.querySelector('.watched-browser-pane .watched-browser-note')!.textContent).toBe('shop.example.com needs you: a human check')
    // A page loading again: no problem, a quiet moving line under the address, and no wait.
    browser = { ...browser, problem: undefined }
    await push({ problem: null, loading: true })
    expect(host.querySelector('.watched-browser-pane .watched-browser-address')!.classList.contains('is-loading')).toBe(true)
    await push({ loading: false })
    expect(host.querySelector('.watched-browser-pane .watched-browser-address')!.classList.contains('is-loading')).toBe(false)
  })

  it('the owner\'s own navigation that fails says why in their words, with the code in the tooltip', async () => {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    // This window holds the browser (a window that reloaded picks its hold up from the daemon's answer).
    browser = { ...browser, control: 'owner', holder: 'this-view', hold: HOLD }
    await open()
    await click(button('Expand Noobesh\'s browser'))
    // The host refuses the navigation and says why, with Chromium's code for the tooltip.
    setBotBrowserTransport((async (method: BotsBrowserMethod, params: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === 'bots.browser.send') {
        const inputs = (params as BotsBrowserApi['bots.browser.send']['params']).inputs
        return { acks: inputs.map((sent) => ({ seq: sent.seq, status: 'refused', reason: 'failed', text: 'shop.example.com refused this browser', detail: 'The site answered HTTP 403.' })), lastSeq: inputs.at(-1)!.seq }
      }
      if (method === 'bots.browser.unwatch') return { ok: true }
      return { browser }
    }) as never, (listener) => { pushes.add(listener); return () => pushes.delete(listener) })
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    const address = host.querySelector<HTMLInputElement>('.watched-browser-pane input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(address, 'shop.example.com')
      address.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { address.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await settle()
    expect(sentInputs()).toEqual([{ seq: 1, input: { kind: 'navigate', url: 'https://shop.example.com' } }])
    const note = host.querySelector('.watched-browser-pane .watched-browser-note')!
    expect(note.textContent).toBe('shop.example.com refused this browser')
    expect(note.getAttribute('title')).toContain('HTTP 403')
  })
})

describe('the split view', () => {
  it('Expand opens the bot\'s browser beside its chat; the control switch takes it over, a click reaches it, and the switch gives it back', async () => {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    await open()
    const expand = button('Expand Noobesh\'s browser')!
    expect(expand.closest('.bot-browser-preview')).not.toBeNull()
    await click(expand)
    const pane = host.querySelector<HTMLElement>('.watched-browser-pane')!
    expect(pane).not.toBeNull()
    // Beside the chat, in its side panel's Browser view, outside the chat pane.
    expect(pane.closest('.bot-side')?.getAttribute('data-view')).toBe('browser')
    expect(host.querySelector('.bot-chat-pane')!.contains(pane)).toBe(false)
    expect(pane.querySelector<HTMLInputElement>('input')!.value).toBe('https://bank.example.com/statements')
    expect(pane.querySelector('[data-agent-cursor]')).not.toBeNull()
    // The thread browser's bar, and no line under the picture while the bot has it.
    expect(pane.querySelector('.browser-toolbar .browser-url-form .browser-url-input')).not.toBeNull()
    expect(pane.querySelector('.watched-browser-note')).toBeNull()
    expect(button('Open in a window')).toBeUndefined()
    // The split view is watched at its width (up to 960) and 15 a second; the preview it covers is not.
    expect(watches().at(-1)).toMatchObject({ width: 960, fps: 15 })
    // The switch shows who has it: the bot's icon, then the owner's.
    expect(button('Take over')!.classList.contains('browser-access-agent')).toBe(true)
    await click(button('Take over'))
    expect(calls).toContainEqual(['bots.browser.hold', { botId: 'noobesh', viewId: expect.any(String), request: { op: 'take', platform: expect.any(String) } }])
    expect(button('Give back')!.classList.contains('browser-access-human')).toBe(true)
    // Faster while the owner holds the browser.
    expect(watches().at(-1)).toMatchObject({ width: 960, fps: 30 })
    // A press and release on the picture land at the page's point: the frame is 1280×720 wide whatever its size on screen.
    const frame = pane.querySelector<HTMLElement>('.watched-browser-frame')!
    frame.getBoundingClientRect = () => ({ left: 100, top: 50, width: 640, height: 360, right: 740, bottom: 410, x: 100, y: 50, toJSON: () => ({}) })
    await act(async () => {
      frame.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 420, clientY: 140, button: 0, buttons: 1 }))
      frame.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 420, clientY: 140, button: 0, buttons: 0 }))
    })
    await settle()
    expect(sentInputs()).toEqual([
      { seq: 1, input: { kind: 'pointer', type: 'down', x: 640, y: 180, button: 'left', buttons: 1, clicks: 1, modifiers: 0 } },
      { seq: 2, input: { kind: 'pointer', type: 'up', x: 640, y: 180, button: 'left', buttons: 0, clicks: 1, modifiers: 0 } }
    ])
    await click(button('Give back'))
    expect(calls).toContainEqual(['bots.browser.hold', { botId: 'noobesh', viewId: expect.any(String), request: { op: 'release', holdId: 'hold_1' } }])
    // Full screen: the side panel takes the chat pane's place at no width of its own; leaving it puts the panel back.
    const slide = host.querySelector<HTMLElement>('.bot-side-slide')!
    const width = slide.querySelector<HTMLElement>('.bot-side')!.style.width
    await click(button('Full screen'))
    expect(slide.classList.contains('is-fullscreen')).toBe(true)
    expect(slide.querySelector<HTMLElement>('.bot-side')!.style.width).toBe('')
    await click(button('Exit full screen'))
    expect(slide.classList.contains('is-fullscreen')).toBe(false)
    expect(slide.querySelector<HTMLElement>('.bot-side')!.style.width).toBe(width)
    await click(button('Close the browser view'))
    expect(host.querySelector('.watched-browser-pane')).toBeNull()
    // Back to the preview's own size and rate.
    expect(watches().at(-1)).toMatchObject({ width: 480, fps: 5 })
  })
})

describe('the split view\'s size', () => {
  /** The split view's stage as the window lays it out, told to its ResizeObserver; the screen's pixel ratio. */
  let stage = { width: 790, height: 1070 }
  const resized = new Set<() => void>()
  const measured = (element: HTMLElement, side: 'width' | 'height') => element.classList.contains('watched-browser-stage') ? stage[side] : 0
  const resize = async (next: { width: number; height: number }) => {
    stage = next
    await act(async () => { for (const callback of resized) callback() })
  }
  beforeEach(() => {
    stage = { width: 790, height: 1070 }
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(private readonly callback: () => void) { resized.add(callback) }
      observe() {}
      disconnect() { resized.delete(this.callback) }
    }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return measured(this, 'width') } })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return measured(this, 'height') } })
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.5 })
  })
  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    resized.clear()
    // Back to the element's own (none of the window's layout in this document).
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
  })

  it('asks for the page at its own size at the view zoom once it stays put; the chat then shows one line, no second picture, and asks for none; closed, the preview is back', async () => {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    await open()
    expect(host.querySelector('.bot-browser-preview img')).not.toBeNull()
    expect(watches().at(-1)).toMatchObject({ width: 480, fps: 5 })
    const before = watches().length
    await click(button('Expand Noobesh\'s browser'))
    // The tall, narrow split view: the page at its size over the default zoom (80%: a side panel is far narrower than a
    // browser window), drawn at no less than the screen's pixel ratio times it; the picture at the stage's size.
    expect(watches().slice(before)).toEqual([expect.objectContaining({ width: 1185, fps: 15, page: { width: 988, height: 1338, scale: 1.25 } })])
    // In the chat, one line in place of the preview: no picture, nothing watched for it.
    expect(host.querySelector('.bot-browser-preview')).toBeNull()
    expect(host.querySelector('.bot-browser-beside')!.textContent).toBe('Browser open beside the chat')
    expect([...host.querySelectorAll('img')].every((image) => image.closest('.watched-browser-pane'))).toBe(true)
    // The divider dragged: nothing asked until it stays put, then the size it settled at, once.
    const dragged = watches().length
    await resize({ width: 700, height: 1070 })
    await resize({ width: 640, height: 1070 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) })
    expect(watches().length).toBe(dragged)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
    expect(watches().slice(dragged)).toEqual([expect.objectContaining({ width: 960, page: { width: 800, height: 1338, scale: 1.25 } })])
    // Zoomed to 100% from the menu: the page is laid out at the view's own size, at the screen's pixel ratio.
    await click(button('Browser menu'))
    // The menu is drawn over the window, outside the view.
    await click(document.querySelector('[aria-label="Zoom in"]'))
    await click(document.querySelector('[aria-label="Zoom in"]'))
    expect(document.querySelector('.watched-browser-zoom-value')!.textContent).toBe('100%')
    expect(watches().at(-1)).toMatchObject({ width: 960, page: { width: 640, height: 1070, scale: 1.5 } })
    // Taken over: the person's press lands at the page's point of the tall picture, whatever the pixel ratio.
    browser = { ...browser, frame: { ...FRAME, id: 7, width: 960, height: 1605, viewport: { width: 640, height: 1070 } } }
    await click(button('Take over'))
    const frame = host.querySelector<HTMLElement>('.watched-browser-pane .watched-browser-frame')!
    frame.getBoundingClientRect = () => ({ left: 14, top: 60, width: 640, height: 1070, right: 654, bottom: 1130, x: 14, y: 60, toJSON: () => ({}) })
    await act(async () => {
      frame.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 334, clientY: 1090, button: 0, buttons: 1 }))
      frame.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 334, clientY: 1090, button: 0, buttons: 0 }))
    })
    await settle()
    expect(sentInputs().find((sent) => 'input' in sent && sent.input.kind === 'pointer' && sent.input.type === 'down')).toMatchObject({ picture: 7, input: { x: 320, y: 1030 } })
    // Closed: the preview and its picture are back, and the page is asked for at no size of its own.
    await click(button('Close the browser view'))
    expect(host.querySelector('.bot-browser-beside')).toBeNull()
    expect(host.querySelector('.bot-browser-preview img')).not.toBeNull()
    expect(watches().at(-1)).toMatchObject({ width: 480, fps: 5 })
    expect(watches().at(-1)).not.toHaveProperty('page')
  })
})

describe('the zoom of a narrow split view', () => {
  beforeEach(() => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} }
    const size = (element: HTMLElement, side: 'width' | 'height') => element.classList.contains('watched-browser-stage') ? { width: 380, height: 700 }[side] : 0
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return size(this, 'width') } })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return size(this, 'height') } })
  })
  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  })

  it('zooms in only as far as the narrowest page fills the view, and says the zoom it shows', async () => {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    await open()
    await click(button('Expand Noobesh\'s browser'))
    await click(button('Browser menu'))
    const zoomIn = () => document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!
    for (let step = 0; step < 6 && !zoomIn().disabled; step += 1) await click(zoomIn())
    // 380 px wide: the page is never under 320 px, so 119% is the most this view shows; the page keeps the view's shape.
    expect(zoomIn().disabled).toBe(true)
    expect(document.querySelector('.watched-browser-zoom-value')!.textContent).toBe('119%')
    expect(watches().at(-1)!.page).toEqual({ width: 320, height: 589, scale: 1.25 })
    // A step out goes from what is shown.
    await click(document.querySelector('[aria-label="Zoom out"]'))
    expect(document.querySelector('.watched-browser-zoom-value')!.textContent).toBe('109%')
  })
})

describe('the person\'s input in the split view', () => {
  /** The split view of a browser this window holds. */
  async function held(extra: Partial<BotBrowserView> = {}) {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    browser = { ...browser, control: 'owner', holder: 'this-view', hold: HOLD, ...extra }
    await open()
    await click(button('Expand Noobesh\'s browser'))
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    return host.querySelector<HTMLElement>('.watched-browser-pane')!
  }
  const keys = () => host.querySelector<HTMLTextAreaElement>('.watched-browser-keys')!
  const type = async (key: string, code: string, keyCode: number) => {
    await act(async () => {
      keys().dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode, bubbles: true, cancelable: true }))
      keys().dispatchEvent(new KeyboardEvent('keyup', { key, code, keyCode, bubbles: true, cancelable: true }))
    })
  }
  const note = () => host.querySelector('.watched-browser-pane .watched-browser-note')

  it('sends each key down and up in order, with the character it types, and Enter after the text', async () => {
    await held()
    await type('h', 'KeyH', 72)
    await type('i', 'KeyI', 73)
    await type('Enter', 'Enter', 13)
    await settle()
    expect(sentInputs().map((sent) => [sent.seq, sent.input])).toEqual([
      [1, { kind: 'keys', type: 'down', key: 'h', code: 'KeyH', keyCode: 72, modifiers: 0, text: 'h' }],
      [2, { kind: 'keys', type: 'up', key: 'h', code: 'KeyH', keyCode: 72, modifiers: 0 }],
      [3, { kind: 'keys', type: 'down', key: 'i', code: 'KeyI', keyCode: 73, modifiers: 0, text: 'i' }],
      [4, { kind: 'keys', type: 'up', key: 'i', code: 'KeyI', keyCode: 73, modifiers: 0 }],
      [5, { kind: 'keys', type: 'down', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 }],
      [6, { kind: 'keys', type: 'up', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 }]
    ])
    // Nothing is said while everything arrives.
    expect(note()).toBeNull()
  })

  it('on a Mac, a key pressed with Command goes up at once (the window never hears it go up)', async () => {
    const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform')
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    try {
      await held()
      await act(async () => { keys().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65, metaKey: true, bubbles: true, cancelable: true })) })
      await settle()
      expect(sentInputs().map((sent) => sent.input)).toEqual([
        { kind: 'keys', type: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 4 },
        { kind: 'keys', type: 'up', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 4 }
      ])
    } finally {
      delete (navigator as { platform?: string }).platform
      if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform)
    }
  })

  it('a press on the page\'s dialog is the dialog\'s, never the page\'s', async () => {
    const pane = await held({ dialog: { type: 'alert', message: 'Hello' } })
    const ok = [...pane.querySelectorAll('.watched-browser-dialog button')].find((entry) => entry.textContent === 'OK')!
    await act(async () => {
      ok.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0, buttons: 1 }))
      ok.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10, button: 0, buttons: 0 }))
      ;(ok as HTMLElement).click()
    })
    await settle()
    expect(sentInputs().map((sent) => sent.input)).toEqual([{ kind: 'dialog', accept: true }])
  })

  it('pastes the person\'s clipboard text only on their paste', async () => {
    await held()
    const paste = Object.assign(new Event('paste', { bubbles: true, cancelable: true }), { clipboardData: { getData: (type: string) => type === 'text/plain' ? 'from my clipboard' : '' } })
    await act(async () => { keys().dispatchEvent(paste) })
    await settle()
    expect(sentInputs().map((sent) => sent.input)).toEqual([{ kind: 'paste', text: 'from my clipboard' }])
  })

  it('says "Sending…", then "Not reaching" with Retry when nothing answers; Retry sends the same numbers again', async () => {
    let release: (() => void) | undefined
    const pane = await held()
    setBotBrowserTransport((async (method: BotsBrowserMethod, params: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === 'bots.browser.send') {
        await new Promise<void>((resolve) => { release = resolve })
        return applyAll(params as BotsBrowserApi['bots.browser.send']['params'])
      }
      if (method === 'bots.browser.unwatch') return { ok: true }
      return { browser }
    }) as never, (listener) => { pushes.add(listener); return () => pushes.delete(listener) })
    // The transport changed: this window picks its hold up again from the daemon's answer.
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    // The browser runs on this computer: it is named as the app names this computer, not by its network name.
    act(() => useAppStore.setState({ appInfo: { platform: 'darwin', repoRoot: '/', llmProvider: 'claude', deviceName: 'Studio Desk' } }))
    await type('a', 'KeyA', 65)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)) })
    expect(note()?.textContent).toBe('Sending…')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_600)) })
    expect(note()?.textContent).toContain('Not reaching Studio Desk')
    expect(note()?.textContent).not.toContain('Mac mini')
    await click(button('Retry'))
    const sends = calls.filter(([method]) => method === 'bots.browser.send').map(([, params]) => (params as BotsBrowserApi['bots.browser.send']['params']).inputs.map((sent) => sent.seq))
    expect(sends.at(-1)).toEqual(sends[0])
    // The service answers again: quiet.
    await act(async () => { release?.() })
    await settle()
    expect(pane.querySelector('.watched-browser-retry')).toBeNull()
  }, 10_000)

  it('says a refusal once, in a short line, and marks where the person pressed', async () => {
    const pane = await held()
    setBotBrowserTransport((async (method: BotsBrowserMethod, params: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === 'bots.browser.send') {
        const inputs = (params as BotsBrowserApi['bots.browser.send']['params']).inputs
        return { acks: inputs.map((sent) => ({ seq: sent.seq, status: 'refused', reason: 'page-changed', text: 'Page changed · click again' })), lastSeq: inputs.at(-1)!.seq }
      }
      return { browser }
    }) as never, (listener) => { pushes.add(listener); return () => pushes.delete(listener) })
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    const frame = pane.querySelector<HTMLElement>('.watched-browser-frame')!
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON: () => ({}) })
    await act(async () => {
      frame.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, button: 0, buttons: 1 }))
    })
    expect(pane.querySelector('.watched-browser-mark')).not.toBeNull()
    await settle()
    expect(note()?.textContent).toBe('Page changed · click again')
    expect(pane.querySelector('.watched-browser-mark.is-refused')).not.toBeNull()
  })

  it('names another window that holds it; Take over here takes it from that window on purpose', async () => {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    browser = { ...browser, control: 'owner', holder: 'another-view' }
    await open()
    await click(button('Expand Noobesh\'s browser'))
    expect(host.querySelector('.watched-browser-pane .watched-browser-note')!.textContent).toBe('Held in another window. Take over to use it here.')
    await click(button('Take over'))
    expect(calls).toContainEqual(['bots.browser.hold', { botId: 'noobesh', viewId: expect.any(String), request: { op: 'take', force: true, platform: expect.any(String) } }])
    expect(button('Give back')).toBeDefined()
  })

  it('shows the page\'s dialog over it, and the person\'s answer goes to the page', async () => {
    const pane = await held({ dialog: { type: 'confirm', message: 'Delete the draft?' } })
    const dialog = pane.querySelector('.watched-browser-dialog')!
    expect(dialog.textContent).toContain('Delete the draft?')
  })

  it('a page\'s file request names the site; only what this computer\'s own dialog answered goes, by its token, never a path', async () => {
    const choose = vi.fn(async () => ({ token: 'files_0123456789ab', count: 1 }))
    ;(fake.events as Record<string, unknown>).chooseBrowserFiles = choose
    const pane = await held({ chooser: { multiple: false, site: 'upload.example.com' } })
    const card = pane.querySelector('.watched-browser-dialog')!
    expect(card.textContent).toContain('upload.example.com asks for a file.')
    // Nothing goes to the page until the person chooses.
    expect(sentInputs()).toEqual([])
    await click([...card.querySelectorAll('button')].find((entry) => entry.textContent === 'Choose…'))
    await settle()
    expect(choose).toHaveBeenCalledWith({ botId: 'noobesh', viewId: expect.any(String), holdId: 'hold_1', multiple: false, site: 'upload.example.com' })
    expect(sentInputs().map((sent) => sent.input)).toEqual([{ kind: 'files', token: 'files_0123456789ab' }])
  })

  it('a page\'s request for several files says so; Cancel answers it with none', async () => {
    const pane = await held({ chooser: { multiple: true, site: 'upload.example.com' } })
    const card = pane.querySelector('.watched-browser-dialog')!
    expect(card.textContent).toContain('upload.example.com asks for files.')
    await click([...card.querySelectorAll('button')].find((entry) => entry.textContent === 'Cancel'))
    await settle()
    expect(sentInputs().map((sent) => sent.input)).toEqual([{ kind: 'files' }])
  })

  it('a window shown again asks at once whether it still holds the browser, and says so when it no longer does', async () => {
    await held()
    setBotBrowserTransport((async (method: BotsBrowserMethod, params: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === 'bots.browser.hold' && (params as { request: { op: string } }).request.op === 'renew') {
        // The hold ran out while the window was hidden: the bot has its browser back.
        browser = { ...browser, control: 'bot', holder: 'bot' }
        delete browser.hold
        throw { code: 'hold_ended', message: 'You don\'t hold this browser now.' }
      }
      if (method === 'bots.browser.unwatch') return { ok: true }
      return { browser }
    }) as never, (listener) => { pushes.add(listener); return () => pushes.delete(listener) })
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    const renews = () => calls.filter(([method, params]) => method === 'bots.browser.hold' && (params as { request: { op: string } }).request.op === 'renew').length
    const before = renews()
    // Shown again: no wait for the next beat.
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    expect(renews()).toBe(before + 1)
    expect(useBotBrowserStore.getState().holds.noobesh).toBeUndefined()
    expect(host.querySelector('.watched-browser-pane .watched-browser-note')!.textContent).toContain('You no longer hold this browser')
  })
})

describe('the bot\'s browser in a real window', () => {
  /** The split view, with the app able to open the browser in a window (`browserWindow`) answering as the daemon would. */
  async function pane(extra: Partial<BotBrowserView> = {}, answer?: (request: { op: string }) => { browser?: BotBrowserView; refused?: string }) {
    const asked: Array<Record<string, unknown>> = []
    ;(fake.events as Record<string, unknown>).browserWindow = vi.fn(async (request: Record<string, unknown>) => {
      asked.push(request)
      const said = answer?.(request as { op: string })
      if (said) return said
      if (request.op === 'open') browser = { ...browser, windowed: true }
      else {
        browser = { ...browser, control: 'bot', holder: 'bot' }
        delete browser.windowed
        delete browser.hold
      }
      return { browser }
    })
    browser = { ...browser, windowable: true, ...extra }
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    await open()
    await click(button('Expand Noobesh\'s browser'))
    return { asked, pane: () => host.querySelector<HTMLElement>('.watched-browser-pane')! }
  }
  const holds = () => calls.filter(([method]) => method === 'bots.browser.hold').map(([, params]) => (params as { request: { op: string } }).request.op)

  it('a browser held here in a window says so in one line, shows no pictures, and Give back gives it back', async () => {
    const { pane: view } = await pane()
    expect(button('Open in a window')).toBeUndefined()
    await act(async () => useBotBrowserStore.getState().inWindow('noobesh', 'open'))
    await settle()
    expect(holds()).toEqual(['take'])
    expect(view().textContent).toContain('Open in a window on this computer.')
    expect(view().textContent).toContain('Noobesh waits until you give it back.')
    expect(view().querySelector('.watched-browser-keys')).toBeNull()
    await click(button('Give back'))
    expect(holds()).toEqual(['take', 'release'])
  })

  it('the window closed by the person gives the browser back without an error, and the view shows pictures again', async () => {
    await pane()
    await act(async () => useBotBrowserStore.getState().inWindow('noobesh', 'open'))
    await settle()
    let ended = false
    setBotBrowserTransport((async (method: BotsBrowserMethod, params: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === 'bots.browser.hold' && (params as { request: { op: string } }).request.op === 'renew' && ended) throw { code: 'hold_ended', message: "You don't hold this browser now." }
      if (method === 'bots.browser.hold') return { browser, hold: HOLD }
      if (method === 'bots.browser.unwatch') return { ok: true }
      return { browser }
    }) as never, (listener) => { pushes.add(listener); return () => pushes.delete(listener) })
    // This window reads its view again (as after a reload): the browser is in a window, held here.
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    expect(useBotBrowserStore.getState().holds.noobesh).toBeDefined()
    // The person closes the window: the daemon gives the browser back, and the hold has ended.
    ended = true
    browser = { ...browser, control: 'bot', holder: 'bot' }
    delete browser.windowed
    delete browser.hold
    // The view is read again before the heartbeat hears the hold ended: it no longer says it is in a window.
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    expect(calls.some(([method, params]) => method === 'bots.browser.hold' && (params as { request: { op: string } }).request.op === 'renew')).toBe(true)
    expect(useBotBrowserStore.getState().holds.noobesh).toBeUndefined()
    expect(host.querySelector('.watched-browser-pane .watched-browser-note')?.textContent ?? '').not.toContain('You no longer hold this browser')
    expect(button('Take over')).toBeDefined()
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

describe('the split view used as the thread browser is', () => {
  const frameOf = () => {
    const frame = host.querySelector<HTMLElement>('.watched-browser-pane .watched-browser-frame')!
    frame.getBoundingClientRect = () => ({ left: 100, top: 50, width: 640, height: 360, right: 740, bottom: 410, x: 100, y: 50, toJSON: () => ({}) })
    return frame
  }
  const keys = () => host.querySelector<HTMLTextAreaElement>('.watched-browser-keys')
  async function expanded() {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    await open()
    await click(button('Expand Noobesh\'s browser'))
  }
  let clipboard: { writeText: ReturnType<typeof vi.fn>; readText: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    clipboard = { writeText: vi.fn(async () => undefined), readText: vi.fn(async () => 'from my clipboard') }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
  })
  afterEach(() => {
    delete (navigator as { clipboard?: unknown }).clipboard
  })

  it('a click on the page while the bot has it takes the browser over, and the click lands where it was made', async () => {
    await expanded()
    await act(async () => {
      frameOf().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 420, clientY: 140, button: 0, buttons: 1 }))
      frameOf().dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 420, clientY: 140, button: 0, buttons: 0 }))
    })
    await settle()
    expect(calls).toContainEqual(['bots.browser.hold', expect.objectContaining({ request: expect.objectContaining({ op: 'take' }) })])
    expect(button('Give back')).toBeDefined()
    expect(sentInputs().map((sent) => sent.input)).toEqual([
      { kind: 'pointer', type: 'move', x: 640, y: 180, button: 'none', buttons: 0 },
      { kind: 'pointer', type: 'down', x: 640, y: 180, button: 'left', buttons: 1, clicks: 1 },
      { kind: 'pointer', type: 'up', x: 640, y: 180, button: 'left', buttons: 0, clicks: 1 }
    ])
    // The page has the keyboard at once: typing needs no second click.
    expect(document.activeElement).toBe(keys())
  })

  it('the first press names the picture it was made on, even when a newer one arrives while the browser is taken over', async () => {
    browser = { ...browser, frame: { ...FRAME, id: 5 } }
    await expanded()
    // The bot's page moved on: taking the browser over answers with a new picture of another size.
    browser = { ...browser, frame: { ...FRAME, id: 9, viewport: { width: 640, height: 360 } } }
    await act(async () => {
      frameOf().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 420, clientY: 140, button: 0, buttons: 1 }))
      frameOf().dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 420, clientY: 140, button: 0, buttons: 0 }))
    })
    await settle()
    expect(useBotBrowserStore.getState().views.noobesh!.frame!.id).toBe(9)
    // At picture 5's point, on picture 5: the host refuses it if that picture is out of date.
    expect(sentInputs().filter((sent) => 'input' in sent && sent.input.kind === 'pointer').map((sent) => [sent.picture, (sent as { input: { x: number; y: number } }).input.x, (sent as { input: { x: number; y: number } }).input.y]))
      .toEqual([[5, 640, 180], [5, 640, 180], [5, 640, 180]])
  })

  it('a first press cancelled before the browser is taken over sends nothing to the page', async () => {
    await expanded()
    await act(async () => {
      frameOf().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 420, clientY: 140, button: 0, buttons: 1 }))
      frameOf().dispatchEvent(new MouseEvent('pointercancel', { bubbles: true, clientX: 420, clientY: 140, button: 0, buttons: 0 }))
    })
    await settle()
    expect(button('Give back')).toBeDefined()
    expect(sentInputs()).toEqual([])
  })

  it('a press still held once the browser is taken over stays down, so dragging selects text', async () => {
    await expanded()
    await act(async () => { frameOf().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 420, clientY: 140, button: 0, buttons: 1 })) })
    await settle()
    await act(async () => {
      frameOf().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 520, clientY: 140, button: -1, buttons: 1 }))
      frameOf().dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 520, clientY: 140, button: 0, buttons: 0 }))
    })
    await settle()
    expect(sentInputs().map((sent) => sent.input)).toEqual([
      expect.objectContaining({ kind: 'pointer', type: 'down', x: 640, y: 180, button: 'left', buttons: 1 }),
      expect.objectContaining({ kind: 'pointer', type: 'move', x: 840, y: 180, buttons: 1 }),
      expect.objectContaining({ kind: 'pointer', type: 'up', x: 840, y: 180, button: 'left', buttons: 0 })
    ])
  })

  it('Back while the bot has it takes the browser over and goes back', async () => {
    await expanded()
    expect(button('Back')!.disabled).toBe(false)
    await click(button('Back'))
    await settle()
    expect(calls.some(([method]) => method === 'bots.browser.hold')).toBe(true)
    expect(sentInputs().map((sent) => sent.input)).toEqual([{ kind: 'back' }])
  })

  it('a right click opens Cut, Copy, Paste and Select all; Copy puts the page\'s selection on the clipboard and Paste sends the clipboard\'s text', async () => {
    browser = { ...browser, control: 'owner', holder: 'this-view', hold: HOLD }
    await expanded()
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    const frame = frameOf()
    await act(async () => {
      frame.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 420, clientY: 140, button: 2, buttons: 2 }))
      frame.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 420, clientY: 140, button: 2, buttons: 0 }))
      frame.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 140, button: 2 }))
    })
    // The right click reached the page too (its own menu, if it has one).
    await settle()
    expect(sentInputs().map((sent) => sent.input)).toEqual([
      expect.objectContaining({ kind: 'pointer', type: 'down', button: 'right' }),
      expect.objectContaining({ kind: 'pointer', type: 'up', button: 'right' })
    ])
    const menu = document.querySelector('[role="menu"][aria-label="Page menu"]')!
    expect([...menu.querySelectorAll('[role="menuitem"] > span')].map((entry) => entry.textContent)).toEqual(['Cut', 'Copy', 'Paste', 'Select all'])
    const item = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.querySelector('span')?.textContent === name)
    await click(item('Copy'))
    await settle()
    expect(sentInputs().at(-1)!.input).toEqual({ kind: 'copy' })
    expect(clipboard.writeText).toHaveBeenCalledWith('the selected words')
    await act(async () => { frame.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 140, button: 2 })) })
    await click(item('Paste'))
    await settle()
    expect(sentInputs().at(-1)!.input).toEqual({ kind: 'paste', text: 'from my clipboard' })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('the page menu takes the keyboard: arrows move between its items, and Escape or Tab gives the keyboard back to the page', async () => {
    browser = { ...browser, control: 'owner', holder: 'this-view', hold: HOLD }
    await expanded()
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    const openMenu = async () => {
      await act(async () => { keys()!.focus() })
      await act(async () => { frameOf().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 140, button: 2 })) })
    }
    const label = () => (document.activeElement as HTMLElement | null)?.querySelector('span')?.textContent
    const key = async (name: string) => {
      await act(async () => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
    }
    await openMenu()
    expect(label()).toBe('Cut')
    await key('ArrowDown')
    expect(label()).toBe('Copy')
    await key('End')
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('Zoom in')
    await key('Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(keys())
    await openMenu()
    await key('Tab')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(keys())
    // None of it reached the page.
    await settle()
    expect(sentInputs()).toEqual([])
  })

  it('Paste from the menu sends nothing when its hold ends before the clipboard answers, even if a new one has begun', async () => {
    browser = { ...browser, control: 'owner', holder: 'this-view', hold: HOLD }
    await expanded()
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    let answer: (text: string) => void = () => {}
    clipboard.readText.mockImplementation(() => new Promise<string>((resolve) => { answer = resolve }))
    await act(async () => { frameOf().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 140, button: 2 })) })
    const paste = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.querySelector('span')?.textContent === 'Paste')
    await click(paste)
    await click(button('Give back'))
    // Taken over again, as a new hold.
    const first = HOLD.id
    HOLD.id = 'hold_2'
    try {
      await click(button('Take over'))
      expect(useBotBrowserStore.getState().holds.noobesh?.id).toBe('hold_2')
      await act(async () => { answer('from my clipboard') })
      await settle()
    } finally {
      HOLD.id = first
    }
    expect(sentInputs().map((sent) => sent.input)).not.toContainEqual(expect.objectContaining({ kind: 'paste' }))
  })

  it('Control with + and - zooms the page, not the app, and is never sent; the zoom is kept for the next view', async () => {
    const pageKeyboard = vi.fn(async () => undefined)
    installPreload(fake, { zoom: { pageKeyboard } })
    browser = { ...browser, control: 'owner', holder: 'this-view', hold: HOLD }
    await expanded()
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    // The page has the keyboard: the app's own zoom keys stand aside.
    await act(async () => { keys()!.focus() })
    expect(pageKeyboard).toHaveBeenLastCalledWith(true)
    const press = async (key: string, code: string) => {
      await act(async () => { keys()!.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: true, bubbles: true, cancelable: true })) })
    }
    await press('=', 'Equal')
    await press('=', 'Equal')
    await click(button('Browser menu'))
    expect(document.querySelector('.watched-browser-zoom-value')!.textContent).toBe('100%')
    await act(async () => { keys()!.focus() })
    await press('-', 'Minus')
    expect(document.querySelector('.watched-browser-zoom-value')!.textContent).toBe('90%')
    await settle()
    expect(sentInputs()).toEqual([])
    await act(async () => { keys()!.blur() })
    expect(pageKeyboard).toHaveBeenLastCalledWith(false)
    // Closed and opened again: the same zoom.
    await click(button('Close the browser view'))
    await click(button('Expand Noobesh\'s browser'))
    await click(button('Browser menu'))
    expect(document.querySelector('.watched-browser-zoom-value')!.textContent).toBe('90%')
  })
})

describe('the app\'s zoom keys', () => {
  it('come back to the app when the hold is taken in another window while the page has the keyboard', async () => {
    const pageKeyboard = vi.fn(async () => undefined)
    installPreload(fake, { zoom: { pageKeyboard } })
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    browser = { ...browser, control: 'owner', holder: 'this-view', hold: HOLD }
    await open()
    await click(button('Expand Noobesh\'s browser'))
    await act(async () => useBotBrowserStore.getState().load('noobesh', false))
    await act(async () => { host.querySelector<HTMLTextAreaElement>('.watched-browser-keys')!.focus() })
    expect(pageKeyboard).toHaveBeenLastCalledWith(true)
    // Taken in another window: the page's field goes, focused, with no blur of its own.
    browser = { ...browser, holder: 'another-view' }
    delete browser.hold
    await push({ control: 'owner', holder: 'another-view' })
    expect(host.querySelector('.watched-browser-keys')).toBeNull()
    expect(pageKeyboard).toHaveBeenLastCalledWith(false)
  })
})

describe('the side panel\'s width', () => {
  it('widens past half the window, as far as the chat keeps 240 px beside it', async () => {
    fake.chats.noobesh = [message(1, { text: 'Here it is.', activationId: 'act1' })]
    await open()
    await click(button('Expand Noobesh\'s browser'))
    const panel = host.querySelector<HTMLElement>('.bot-side')!
    const row = host.querySelector<HTMLElement>('.bot-side-slide')!.parentElement!
    row.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) })
    const handle = host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize side panel"]')!
    const widen = async (times: number) => {
      for (let index = 0; index < times; index += 1) {
        await act(async () => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })) })
      }
    }
    // From 380 to 1100: over 720 (the old cap) and over half of 1600.
    await widen(45)
    expect(panel.style.width).toBe('1100px')
    // Never past the chat's 240.
    await widen(30)
    expect(panel.style.width).toBe('1360px')
  })
})

describe('the chat while pictures arrive', () => {
  it('a new picture re-renders only the picture: the chat, which keeps the browser\'s state, stays still', async () => {
    const { useBotBrowser } = await import('../../src/renderer/stores/botBrowserStore')
    let renders = 0
    const Chat = () => {
      renders += 1
      useBotBrowser('noobesh')
      return null
    }
    await act(async () => root.render(createElement(Chat)))
    await act(async () => {})
    const element = { current: document.createElement('div') }
    const Picture = () => { useBotBrowserWatch('noobesh', element, { width: 480, fps: 5 }); return null }
    const pictures = createRoot(document.createElement('div'))
    await act(async () => pictures.render(createElement(Picture)))
    await act(async () => {})
    const before = renders
    await push({ frame: { ...FRAME, id: 2, at: Date.now() }, cursor: { x: 10, y: 10, action: 'move', at: Date.now(), viewport: { width: 1280, height: 720 } } })
    await push({ frame: { ...FRAME, id: 3, at: Date.now() } })
    expect(useBotBrowserStore.getState().views.noobesh!.frame!.id).toBe(3)
    expect(renders).toBe(before)
    // Something else changing (the tab) still reaches it.
    await push({ tab: { url: 'https://bank.example.com/other', title: 'Other' } })
    expect(renders).toBe(before + 1)
    act(() => pictures.unmount())
  })
})
