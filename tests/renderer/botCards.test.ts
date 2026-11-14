// @vitest-environment jsdom
/**
 * Cards on a bot's message (#1123), in the chat the owner uses: facts drawn as the same key-value card a reply's list of
 * bold keys is, a checklist, progress and a gallery of pictures (once, in the card, with the chat's preview), each from
 * the app's own components with the bot's words as text; and a message from a service with no cards shows its text.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'
import type { BotChatCard, BotChatMessage } from '../../src/shared/bots/personal/chat'
import { plainCards } from '../../src/shared/bots/personal/cards'

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
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { resetBotFileImages } = await import('../../src/renderer/components/bots/BotImages')

const FOLDER = '/home/me/.mousse/bots/files/shop/images/2026-11-14'
const shop = summary('shop', { name: 'Shopper' })

let root: Root
let host: HTMLElement
let fake: FakeBots
let readAsset: ReturnType<typeof vi.fn>
let blobs = 0
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

const transcript = () => host.querySelector<HTMLElement>('.chat-transcript')!
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const bubbleOf = (id: string) => transcript().querySelector<HTMLElement>(`[data-message-id="${id}"] .bot-bubble`)!
/** A key-value card's rows, as label and value text. */
const rowsOf = (card: Element) => [...card.querySelectorAll('dt')].map((label) => [label.textContent, label.nextElementSibling?.textContent])

/** A message with cards as the service sends it: its words, then the cards as text from `plainFrom`. */
function carded(seq: number, words: string, cards: BotChatCard[], over: Partial<BotChatMessage> = {}): BotChatMessage {
  const plain = plainCards(cards)
  return message(seq, { id: `c${seq}`, text: words ? `${words}\n\n${plain}` : plain, plainFrom: words.length, cards, ...over })
}

async function open(rows: BotChatMessage[]) {
  fake.bots = [shop]
  fake.chats.shop = rows
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(shop.id))
  await settle()
}

beforeEach(() => {
  fake = fakeBots()
  blobs = 0
  readAsset = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', size: 3 }))
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
})

describe('cards in the bot chat', () => {
  it('draws facts as the same key-value card a reply\'s list of bold keys is, with only links, bold and code drawn', async () => {
    await open([
      message(1, { id: 'md', text: '- **CPU:** Ryzen 9\n- **RAM:** 32 GB' }),
      carded(2, 'Here it is.', [{ type: 'facts', title: 'Roborock Q7', rows: [{ label: 'Suction', value: '**8,000 Pa**' }, { label: 'Note', value: '<img src=x onerror="alert(1)"> `x` [shop](https://example.com)' }] }])
    ])
    const fromList = bubbleOf('md').querySelector('dl')!
    const fromCard = bubbleOf('c2').querySelector('dl')!
    expect(rowsOf(fromList)).toEqual([['CPU', 'Ryzen 9'], ['RAM', '32 GB']])
    // One component draws both: the same element and look.
    expect(fromCard.className).toBe(fromList.className)
    expect(fromCard.getAttribute('aria-label')).toBe('Roborock Q7')
    expect(rowsOf(fromCard)).toEqual([['Suction', '8,000 Pa'], ['Note', '<img src=x onerror="alert(1)"> x shop']])
    expect(fromCard.querySelector('strong')?.textContent).toBe('8,000 Pa')
    expect(fromCard.querySelector('code')?.textContent).toBe('x')
    expect(fromCard.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    // The bot's markup is text, never an element.
    expect(fromCard.querySelector('img')).toBeNull()
    // The words stop where the plain copy starts: the card is not said twice.
    expect(bubbleOf('c2').textContent).toContain('Here it is.')
    expect(bubbleOf('c2').textContent).not.toContain('Suction: ')
  })

  it('draws a checklist with where each item stands, and progress as a bar with its count', async () => {
    await open([
      carded(1, '', [
        { type: 'checklist', title: 'Steps', items: [{ text: 'Find prices', state: 'done' }, { text: 'Read reviews', state: 'doing' }, { text: 'Order', state: 'todo' }, { text: 'Coupon', state: 'skipped' }] },
        { type: 'progress', label: 'Shops checked', done: 3, total: 5, note: 'Two left.' }
      ])
    ])
    const checklist = bubbleOf('c1').querySelector('[aria-label="Steps"]')!
    expect([...checklist.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Done: Find prices', 'In progress: Read reviews', 'To do: Order', 'Skipped: Coupon'])
    const bar = bubbleOf('c1').querySelector('[role="progressbar"]')!
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['3', '5'])
    expect(bubbleOf('c1').textContent).toContain('3 of 5')
    expect(bubbleOf('c1').textContent).toContain('Two left.')
  })

  it('shows a gallery\'s pictures once, in the card, opening the chat\'s preview; the same files are not shown again above the words', async () => {
    const files = [{ path: `${FOLDER}/a.png`, name: 'a.png', caption: 'Flat A' }, { path: `${FOLDER}/b.png`, name: 'b.png' }]
    await open([carded(1, 'Two flats.', [{ type: 'gallery', title: 'Flats', files }], { attachments: files.map((file) => ({ name: file.name, path: file.path })) })])
    const gallery = bubbleOf('c1').querySelector('[aria-label="Flats"]')!
    expect([...gallery.querySelectorAll('button[aria-label^="Open picture"]')].map((picture) => picture.getAttribute('aria-label'))).toEqual(['Open picture: Flat A', 'Open picture: b.png'])
    expect(bubbleOf('c1').querySelectorAll('img')).toHaveLength(2)
    await act(async () => { gallery.querySelector<HTMLButtonElement>('button[aria-label="Open picture: Flat A"]')!.click() })
    await settle()
    expect(document.querySelector('.image-preview-overlay')?.getAttribute('aria-label')).toContain('Flat A')
  })

  it('a message from a service with no cards shows all its text', async () => {
    const plain = 'Here it is.\n\nRoborock Q7\nSuction: 8,000 Pa'
    await open([message(1, { id: 'old', text: plain })])
    expect(bubbleOf('old').querySelector('dl')).toBeNull()
    expect(bubbleOf('old').textContent).toContain('Suction: 8,000 Pa')
  })
})
