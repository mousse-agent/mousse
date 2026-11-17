// @vitest-environment jsdom
/**
 * The image preview steps through a conversation's images: Previous and Next at the edges, the arrow
 * keys and a sideways two-finger swipe, a "3 / 12" counter, no wrap at the ends, and nothing of it for
 * a single image. One preview serves the whole thread (prompt attachments and reply images, in display
 * order) and the composer's attachments.
 */
import type { UIMessage } from 'ai'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageLightbox, type LightboxImage } from '../../src/renderer/chat/components/agent-elements/image-lightbox'
import { collectThreadImages, markdownImages } from '../../src/renderer/chat/components/agent-elements/image-sources'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { resetBotFileImages } from '../../src/renderer/components/bots/BotImages'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const loaded: string[] = []

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  // Each background load (a neighbour being preloaded) is recorded.
  vi.stubGlobal('Image', class { decoding = ''; set src(value: string) { loaded.push(value) } })
  loaded.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const shownSrc = () => dialog()!.querySelector('img')!.getAttribute('src')
const counter = () => dialog()!.querySelector('.image-preview-counter')?.textContent ?? null
const previous = () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Previous image (←)"]')
const next = () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Next image (→)"]')
const press = (key: string) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
const click = (element: Element | null | undefined) => act(() => { (element as HTMLElement).click() })
const images = (count: number): LightboxImage[] => Array.from({ length: count }, (_, i) => ({ id: `i${i}`, url: `https://example.com/${i}.png`, filename: `Image ${i}` }))

function renderLightbox(set: LightboxImage[], initialIndex = 0, onClose = () => {}) {
  act(() => root.render(createElement(ImageLightbox, { open: true, onClose, images: set, initialIndex })))
}

describe('the image preview', () => {
  it('goes next and previous with the edge buttons and the arrow keys, with a counter', () => {
    renderLightbox(images(4), 1)
    expect(shownSrc()).toBe('https://example.com/1.png')
    expect(counter()).toBe('2 / 4')
    click(next())
    expect(shownSrc()).toBe('https://example.com/2.png')
    expect(counter()).toBe('3 / 4')
    click(previous())
    click(previous())
    expect(counter()).toBe('1 / 4')
    press('ArrowRight')
    press('ArrowRight')
    expect(shownSrc()).toBe('https://example.com/2.png')
    press('ArrowLeft')
    expect(counter()).toBe('2 / 4')
  })

  it('stops at the ends without wrapping, with no arrow past them', () => {
    renderLightbox(images(3), 0)
    expect(previous()).toBeNull()
    expect(next()).not.toBeNull()
    press('ArrowLeft')
    expect(counter()).toBe('1 / 3')
    press('ArrowRight')
    press('ArrowRight')
    expect(counter()).toBe('3 / 3')
    expect(next()).toBeNull()
    expect(previous()).not.toBeNull()
    press('ArrowRight')
    expect(counter()).toBe('3 / 3')
    expect(shownSrc()).toBe('https://example.com/2.png')
  })

  it('keeps the focus in the preview when the arrow it was on goes away at the end', () => {
    renderLightbox(images(2), 0)
    next()!.focus()
    click(next())
    expect(next()).toBeNull()
    expect(dialog()!.contains(document.activeElement)).toBe(true)
  })

  it('shows no arrows or counter for a single image', () => {
    renderLightbox(images(1))
    expect(previous()).toBeNull()
    expect(next()).toBeNull()
    expect(counter()).toBeNull()
    press('ArrowRight')
    expect(shownSrc()).toBe('https://example.com/0.png')
  })

  it('still closes with Escape', () => {
    const onClose = vi.fn()
    renderLightbox(images(3), 1, onClose)
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('loads the images either side in the background', () => {
    renderLightbox(images(5), 2)
    expect(loaded).toEqual(expect.arrayContaining(['https://example.com/1.png', 'https://example.com/3.png']))
    loaded.length = 0
    click(next())
    expect(loaded).toEqual(expect.arrayContaining(['https://example.com/2.png', 'https://example.com/4.png']))
  })

  it('turns one image per sideways two-finger swipe, and ignores pinches and up-down scrolls', () => {
    vi.useFakeTimers()
    renderLightbox(images(4), 1)
    const wheel = (deltaX: number, deltaY = 0, ctrlKey = false) => act(() => { dialog()!.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY, ctrlKey, bubbles: true })) })
    // One swipe with its momentum: one image.
    for (let i = 0; i < 10; i++) wheel(30)
    expect(counter()).toBe('3 / 4')
    act(() => { vi.advanceTimersByTime(300) })
    for (let i = 0; i < 4; i++) wheel(-30)
    expect(counter()).toBe('2 / 4')
    act(() => { vi.advanceTimersByTime(300) })
    for (let i = 0; i < 10; i++) wheel(5, 40)
    for (let i = 0; i < 10; i++) wheel(40, 0, true)
    expect(counter()).toBe('2 / 4')
  })
})

describe('the set of images', () => {
  it('reads Markdown images in order and leaves out examples in code', () => {
    const text = 'First ![a](https://x/a.png) then `![no](https://x/no.png)`\n\n```md\n![no](https://x/no2.png)\n```\n\n![b](<https://x/b c.png> "title")'
    expect(markdownImages(text)).toEqual([{ src: 'https://x/a.png', alt: 'a' }, { src: 'https://x/b c.png', alt: 'b' }])
  })

  it('is every attachment and reply image of a thread, in display order', () => {
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Look' }, { type: 'file', mediaType: 'image/png', filename: 'one.png', url: 'data:image/png;base64,AAAA' }, { type: 'image', url: 'data:image/png;base64,BBBB' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Here: ![chart](https://x/chart.png)' }, { type: 'tool-Bash', toolCallId: 't' }, { type: 'text', text: '![bad](javascript:alert(1)) ![two](https://x/two.png)' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'file', mediaType: 'image/jpeg', filename: 'three.jpg', url: 'data:image/jpeg;base64,CCCC' }] },
      // Shown again: in the set once, where it first shows.
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Same chart: ![chart](https://x/chart.png)' }] }
    ] as unknown as UIMessage[]
    const set = collectThreadImages(messages, (src) => (src.startsWith('javascript:') ? '' : src))
    expect(set.map((image) => image.filename)).toEqual(['one.png', 'Image 2', 'chart', 'two', 'three.jpg'])
    expect(set[0]!.id).toBe('u1-img-0')
  })
})

describe('in a thread', () => {
  const thread = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Two screenshots' }, { type: 'file', mediaType: 'image/png', filename: 'first.png', url: 'data:image/png;base64,AAAA' }, { type: 'file', mediaType: 'image/png', filename: 'second.png', url: 'data:image/png;base64,BBBB' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Compare with ![third](https://example.com/third.png) and ![fourth](https://example.com/fourth.png).' }] }
  ] as unknown as UIMessage[]

  it('an attachment opens a preview that steps on into the reply images', async () => {
    await act(async () => root.render(createElement(MessageList, { messages: thread, status: 'ready' })))
    click(host.querySelector('button[aria-label="Open second.png"]'))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(counter()).toBe('2 / 4')
    press('ArrowRight')
    expect(shownSrc()).toBe('https://example.com/third.png')
    click(next())
    expect(counter()).toBe('4 / 4')
    expect(next()).toBeNull()
    press('Escape')
    expect(dialog()).toBeNull()
  })

  it('a reply image opens at its place in the thread', async () => {
    await act(async () => root.render(createElement(MessageList, { messages: thread, status: 'ready' })))
    click(host.querySelector('button[aria-label="Open image: fourth"]'))
    expect(counter()).toBe('4 / 4')
    click(previous())
    click(previous())
    click(previous())
    expect(shownSrc()).toBe('data:image/png;base64,AAAA')
    expect(previous()).toBeNull()
  })
})

describe("an image file outside the thread's folder", () => {
  const FOLDER = 'C:/Users/me/.mousse/bots/files/bot-1/mockups'
  const reply = (text: string) => [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text }] }] as unknown as UIMessage[]
  let readAsset: ReturnType<typeof vi.fn>

  beforeEach(() => {
    readAsset = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', size: 3 }))
    ;(window as unknown as { mousse: unknown }).mousse = { fs: { readAsset } }
    URL.createObjectURL = vi.fn(() => 'blob:mockup')
    URL.revokeObjectURL = vi.fn()
    resetBotFileImages()
  })

  afterEach(() => { delete (window as unknown as { mousse?: unknown }).mousse })

  it('shows in a reply, read from its own folder, and opens in the preview', async () => {
    await act(async () => root.render(createElement(MessageList, { messages: reply(`Here: ![before](${FOLDER}/before.png)`), status: 'ready' })))
    expect(readAsset.mock.calls.map((call) => [call[0], String(call[3]).replace(/\\/g, '/')])).toEqual([['before.png', FOLDER]])
    expect(host.textContent).not.toContain('Image blocked')
    click(host.querySelector('button[aria-label="Open image: before"]'))
    expect(shownSrc()).toBe('blob:mockup')
  })

  it('shows only its name when it is not a picture type Mousse shows', async () => {
    await act(async () => root.render(createElement(MessageList, { messages: reply(`![diagram](${FOLDER}/diagram.svg)`), status: 'ready' })))
    expect(readAsset).not.toHaveBeenCalled()
    expect(host.querySelector(`[aria-label="diagram (can't be shown)"]`)).not.toBeNull()
    expect(host.querySelector('img')).toBeNull()
  })
})
