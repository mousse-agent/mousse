// @vitest-environment jsdom
/**
 * Pictures in a bot's chat: the owner's attached images as thumbnails that open the chat's preview with Previous and
 * Next, `data:` images and image files in the bot's replies, and what stays out (SVG, web images, other files).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'
import { botChatImages, botImageSource, isImageFile } from '../../src/renderer/components/bots/imageSources'

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
const { resetBotFileImages } = await import('../../src/renderer/components/bots/BotImages')

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const SVG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')}`
const FOLDER = '/home/me/.mousse/bots/files/trip/attachments/2026-11-12'

let root: Root
let host: HTMLElement
let fake: FakeBots
let readAsset: ReturnType<typeof vi.fn>
let blobs = 0
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()
const appInitial = useAppStore.getInitialState()
const trip = summary('trip', { name: 'Trip planner' })
const transcript = () => host.querySelector<HTMLElement>('.chat-transcript')!
const overlay = () => document.querySelector<HTMLElement>('.image-preview-overlay')
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }
const key = async (name: string) => { await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) }) }
const shown = () => ({ label: overlay()?.getAttribute('aria-label'), counter: overlay()?.querySelector('.image-preview-counter')?.textContent })

async function open() {
  fake.bots = [trip]
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(trip.id))
  await settle()
}

beforeEach(() => {
  fake = fakeBots()
  blobs = 0
  // Image files come through the Files panel's preview read; the type is the one the file turned out to be.
  readAsset = vi.fn(async (name: string) => ({ data: new Uint8Array([1, 2, 3]), mimeType: name.endsWith('.svg') ? 'image/svg+xml' : 'image/png', size: 3 }))
  installPreload(fake, { fs: { readAsset } })
  URL.createObjectURL = vi.fn(() => `blob:image-${++blobs}`)
  URL.revokeObjectURL = vi.fn()
  resetBotFileImages()
  setBotsClient(fake.client)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setBotsClient(null)
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
  useAppStore.setState({ sidebarMode: appInitial.sidebarMode })
})

describe('the owner’s attached images', () => {
  it('show as thumbnails above the words, with other files as pills, and open the preview with Previous and Next', async () => {
    fake.chats.trip = [
      message(1, {
        author: 'owner', text: 'Plan three days like this?', attachments: [
          { name: 'beach.png', path: `${FOLDER}/beach.png` },
          { name: 'harbour.jpg', path: `${FOLDER}/harbour.jpg` },
          { name: 'tickets.pdf', path: `${FOLDER}/tickets.pdf` },
          { name: 'old-town.webp', path: `${FOLDER}/old-town.webp` }
        ]
      }),
      message(2, { text: `Here is day one:\n\n![Day 1](${PNG})` })
    ]
    await open()
    const owner = transcript().querySelector('.bot-you')!
    const tiles = [...owner.querySelectorAll<HTMLButtonElement>('.bot-images button.bot-image')]
    expect(tiles.map((tile) => tile.title)).toEqual(['beach.png', 'harbour.jpg', 'old-town.webp'])
    expect(owner.querySelector('.bot-images')?.getAttribute('data-count')).toBe('3')
    expect(tiles.map((tile) => tile.querySelector('img')!.getAttribute('src'))).toEqual(['blob:image-1', 'blob:image-2', 'blob:image-3'])
    // Each file is read by name from its own folder, as the Files panel reads a file outside a thread.
    expect(readAsset.mock.calls.map((call) => [call[0], call[3]])).toEqual([['beach.png', FOLDER], ['harbour.jpg', FOLDER], ['old-town.webp', FOLDER]])
    // Pictures first, then the words, then any other file.
    const content = owner.querySelector('.bot-you-content')!
    const parts = ['bot-images', 'bot-you-bubble', 'bot-you-files']
    expect([...content.children].map((child) => parts.find((name) => child.classList.contains(name)))).toEqual(parts)
    expect([...owner.querySelectorAll('.bot-file-pill')].map((pill) => pill.textContent)).toEqual(['tickets.pdf'])

    await click(tiles[1])
    expect(shown()).toEqual({ label: 'harbour.jpg', counter: '2 / 4' })
    await key('ArrowRight')
    expect(shown()).toEqual({ label: 'old-town.webp', counter: '3 / 4' })
    await key('ArrowRight')
    // The bot's reply image is in the same set.
    expect(shown()).toEqual({ label: 'Day 1', counter: '4 / 4' })
    expect(overlay()?.querySelector('[aria-label^="Next image"]')).toBeNull()
    await click(overlay()?.querySelector('[aria-label^="Previous image"]'))
    expect(shown()).toEqual({ label: 'old-town.webp', counter: '3 / 4' })
    await key('Escape')
    expect(overlay()).toBeNull()
  })

  it('keeps an image’s box while the message is on its way, so nothing moves when it arrives', async () => {
    await open()
    await act(async () => useBotsStore.setState({ pending: { trip: [message(Number.MAX_SAFE_INTEGER, { id: 'pending:r1', author: 'owner', text: '', attachments: [{ name: 'shot.png', path: '' }] })] } }))
    const box = transcript().querySelector('.bot-you .bot-images .bot-image')!
    expect(box.classList.contains('is-empty')).toBe(true)
    expect(box.getAttribute('title')).toBe('shot.png')
    expect(readAsset).not.toHaveBeenCalled()
  })

  it('shows a file that can’t be read as its name in the same box', async () => {
    readAsset.mockRejectedValueOnce(new Error('gone'))
    fake.chats.trip = [message(1, { author: 'owner', text: '', attachments: [{ name: 'lost.png', path: `${FOLDER}/lost.png` }] })]
    await open()
    const box = transcript().querySelector('.bot-you .bot-image.is-failed')!
    expect(box.textContent).toBe('lost.png')
    expect(box.querySelector('img')).toBeNull()
  })
})

describe('images in the bot’s replies', () => {
  it('shows a data:image/png and an image file from its work as the reply’s pictures, named by their alt text', async () => {
    fake.chats.trip = [message(1, { text: `Sketch:\n\n![Day 1 sketch](${PNG})\n\nRoute:\n\n![Route map](/home/me/.mousse/bots/files/trip/route.png)` })]
    await open()
    // Above the words, as a messenger's picture message: the name is the alt text and the label, never a tooltip.
    const tiles = [...transcript().querySelectorAll<HTMLButtonElement>('.from-agent .bot-reply-media button.bot-picture')]
    expect(tiles.map((tile) => [tile.querySelector('img')!.getAttribute('alt'), tile.querySelector('img')!.getAttribute('src')])).toEqual([['Day 1 sketch', PNG], ['Route map', 'blob:image-1']])
    await click(tiles[0])
    expect(shown()).toEqual({ label: 'Day 1 sketch', counter: '1 / 2' })
  })

  it('never shows an SVG, whether a data: URL or a file', async () => {
    fake.chats.trip = [message(1, { text: `![Badge](${SVG}) and ![Logo](/home/me/logo.svg)` })]
    await open()
    const reply = transcript().querySelector('.from-agent')!
    expect(reply.querySelector('img')).toBeNull()
    expect(reply.innerHTML).not.toContain('svg+xml')
    expect([...reply.querySelectorAll('.bot-image-link.is-blocked')].map((element) => element.textContent)).toEqual(['Badge', 'Logo'])
    expect(readAsset).not.toHaveBeenCalled()
  })

  it('keeps web images blocked: a link that opens in the browser, never loaded', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
    // In Chats a web link opens in the person's own browser.
    useAppStore.setState({ sidebarMode: 'chats' })
    fake.chats.trip = [message(1, { text: 'The ferry: ![Ferry](https://example.com/ferry.jpg) and ![](http://tracker.example/pixel.gif)' })]
    await open()
    const reply = transcript().querySelector('.from-agent')!
    expect(reply.querySelector('img')).toBeNull()
    const links = [...reply.querySelectorAll<HTMLAnchorElement>('a.bot-image-link')]
    expect(links.map((link) => [link.textContent, link.title])).toEqual([['Ferry', 'https://example.com/ferry.jpg'], ['tracker.example', 'http://tracker.example/pixel.gif']])
    await click(links[0])
    expect(opened).toHaveBeenCalledWith('https://example.com/ferry.jpg', '_blank', 'noopener,noreferrer')
    opened.mockRestore()
  })

  it('shows files the bot sends: images as its pictures, the rest as pills', async () => {
    fake.chats.trip = [message(1, { text: 'Done.', attachments: [{ name: 'plan.pdf', path: '/home/me/plan.pdf' }, { name: 'map.gif', path: '/home/me/map.gif' }] })]
    await open()
    const reply = transcript().querySelector('.from-agent')!
    expect([...reply.querySelectorAll('.bot-reply-media button.bot-picture')].map((tile) => tile.getAttribute('aria-label'))).toEqual(['Open picture: map.gif'])
    expect([...reply.querySelectorAll('.bot-file-pill')].map((pill) => pill.textContent)).toEqual(['plan.pdf'])
  })
})

describe('image sources', () => {
  it('allows only raster data: images and local image files', () => {
    expect(botImageSource(PNG)).toEqual({ kind: 'data', url: PNG })
    expect(botImageSource('data:image/jpeg;base64,/9j/4AAQ')).toEqual({ kind: 'data', url: 'data:image/jpeg;base64,/9j/4AAQ' })
    expect(botImageSource(SVG)).toEqual({ kind: 'blocked' })
    expect(botImageSource('data:text/html;base64,PGgxPg==')).toEqual({ kind: 'blocked' })
    expect(botImageSource('data:image/png,<svg onload=x>')).toEqual({ kind: 'blocked' })
    expect(botImageSource('javascript:alert(1)')).toEqual({ kind: 'blocked' })
    expect(botImageSource('https://example.com/a.png')).toEqual({ kind: 'link', url: 'https://example.com/a.png' })
    expect(botImageSource('/home/me/My%20photo.png')).toEqual({ kind: 'file', path: '/home/me/My photo.png' })
    expect(botImageSource('file:///home/me/a.jpg')).toEqual({ kind: 'file', path: '/home/me/a.jpg' })
    expect(botImageSource('file://server/share/a.jpg')).toEqual({ kind: 'blocked' })
    expect(botImageSource('\\\\server\\share\\a.png')).toEqual({ kind: 'blocked' })
    expect(botImageSource('C:\\Users\\me\\a.png')).toEqual({ kind: 'file', path: 'C:\\Users\\me\\a.png' })
    expect(botImageSource('relative/a.png')).toEqual({ kind: 'blocked' })
    expect(botImageSource('/home/me/notes.txt')).toEqual({ kind: 'blocked' })
    expect(isImageFile('x.SVG')).toBe(false)
    expect(isImageFile('x.JPEG')).toBe(true)
  })

  it('lists a chat’s images in display order, each once, leaving out files not read yet', () => {
    const images = botChatImages([
      message(1, { author: 'owner', text: `![again](${PNG})`, attachments: [{ name: 'a.png', path: '/f/a.png' }, { name: 'b.png', path: '/f/b.png' }, { name: 'c.txt', path: '/f/c.txt' }] }),
      message(2, { text: `![first](${PNG}) ![a](/f/a.png)`, attachments: [{ name: 'd.png', path: '/f/d.png' }] })
    ], (path) => (path === '/f/b.png' ? undefined : `blob:${path}`))
    expect(images.map((image) => [image.id, image.filename])).toEqual([['/f/a.png', 'a.png'], [PNG, 'again'], ['/f/d.png', 'd.png']])
  })
})
