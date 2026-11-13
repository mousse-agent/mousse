// @vitest-environment jsdom
/**
 * A bot's chat (bot-ui §4.4, §4.8, §4.9), as a one-to-one messenger: the owner's bubbles on the right and the bot's on
 * the left, each with its time; asks as quick replies and error lines; work folded behind "Worked for"; a typing
 * bubble while its chat turn runs and its presence in the header; the thread composer without a thread's run settings
 * (text, emoji, attach by button, drop or paste, dictation, and send or Stop); and the one menu with About, Rename,
 * Change look, Pause and Delete.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/chats/ChatResourcesPanel', () => ({ ChatResourcesPanel: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTranscript', () => ({ NetworkTranscript: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkChatActions', () => ({ NetworkChatActions: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTaskPicker', () => ({ NetworkTaskPicker: () => null }))
vi.mock('../../src/renderer/components/chats/ChatBrowserAccess', () => ({ ChatBrowserAccess: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
// The composer's microphone pulls in audio worklets jsdom does not have; these tests never record.
vi.mock('../../src/renderer/dictation/microphone', () => ({}))
const markdown = vi.hoisted(() => ({ renders: 0 }))
// The bot chat draws its messages with the thread's Markdown: each draw is counted.
vi.mock('../../src/renderer/chat/components/agent-elements/markdown', async (importOriginal) => {
  const { createElement: h } = await import('react')
  return { ...(await importOriginal<object>()), Markdown: ({ content, className }: { content: string; className?: string }) => { markdown.renders++; return h('div', { className }, content) } }
})
// The bot's messages are drawn by the thread's Markdown, counted here as it draws.
vi.mock('../../src/renderer/chat/components/agent-elements/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/chat/components/agent-elements/markdown')>()
  const { createElement: h } = await import('react')
  return { ...actual, Markdown: (props: Parameters<typeof actual.Markdown>[0]) => { markdown.renders++; return h(actual.Markdown, props) } }
})

const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { SelectionReplyButton } = await import('../../src/renderer/components/SelectionReplyButton')

let root: Root
let host: HTMLElement
let fake: FakeBots
let setViewedBot: ReturnType<typeof vi.fn>
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()
const appInitial = useAppStore.getInitialState()

const inbox = summary('inbox', { name: 'Inbox helper', description: 'Tells me which emails need a reply.' })
const transcript = () => host.querySelector<HTMLElement>('.chat-transcript')!
const composer = () => host.querySelector<HTMLElement>('.bot-input-area .composer')!
const box = () => composer().querySelector<HTMLTextAreaElement>('textarea.composer-input')!
const composerError = () => host.querySelector('.bot-input-area .composer-notice[data-tone="error"] .composer-notice-title')
const press = async (key: string) => { await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }); await act(async () => {}) }
/** Fires `type` on `target` with `field` (`dataTransfer`, `clipboardData`) set, as jsdom has neither. */
async function fire(target: Element, type: string, field: string, value: unknown) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, field, { value })
  await act(async () => { target.dispatchEvent(event) })
}
/** Lets the store read the files (FileReader) and the fake answer. */
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function open(bot = inbox) {
  fake.bots = [bot]
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(bot.id))
}

beforeEach(() => {
  fake = fakeBots()
  setViewedBot = vi.fn(async () => undefined)
  installPreload(fake, { app: { setViewedBot } })
  // An image's preview is an object URL, which jsdom cannot make.
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
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
  useAppStore.setState({ settingsOpen: appInitial.settingsOpen })
})

describe('the transcript', () => {
  it('shows the owner’s messages and the bot’s as bubbles, with no face or name on the bot’s; its work folds behind Worked for', async () => {
    const at = (seconds: number) => new Date(Date.UTC(2026, 10, 13, 9, 0, seconds)).toISOString()
    fake.chats.inbox = [
      message(1, { id: 'o1', at: at(0), author: 'owner', text: 'Send the one to the Lisbon host.' }),
      message(2, { id: 'b1', at: at(32), text: 'Sent.', replyTo: { id: 'o1', author: 'owner', text: 'Send the one to the Lisbon host.' }, chips: [{ icon: 'web', text: 'read 2 pages', highlight: 'example.com' }, { icon: 'memory', text: 'remembered', highlight: 'vegetarian' }] }),
      message(3, { kind: 'error', text: 'I couldn’t do this morning’s check.', error: { text: 'Set up a provider so I can work.', action: { kind: 'open_providers', label: 'Set up' } } })
    ]
    await open()
    const [owner, reply, error] = [...transcript().querySelectorAll('article')]
    expect(owner!.classList.contains('bot-you')).toBe(true)
    expect(owner!.querySelector('.bot-you-bubble .bot-markdown')?.textContent).toBe('Send the one to the Lisbon host.')
    // A one-to-one chat: the header says who it is, so the bot's bubbles carry no face or name.
    expect(transcript().querySelector('.bot-face, .chat-message-meta')).toBeNull()
    expect(reply!.querySelector('.bot-bubble .bot-markdown')?.textContent).toBe('Sent.')
    // No chips under the text: one quiet line, which opens the steps in plain words.
    expect(reply!.querySelector('.bot-chip, .bot-steps')).toBeNull()
    const worked = reply!.querySelector<HTMLButtonElement>('.bot-worked')!
    expect(worked.textContent).toBe('Worked for 32s')
    await click(worked)
    expect([...reply!.querySelectorAll('.bot-steps li')].map((step) => step.textContent)).toEqual(['Read 2 pages · example.com', 'Remembered · vegetarian'])
    // A message with no work has no such line.
    expect(error!.querySelector('.bot-worked')).toBeNull()
    // Work whose time isn't known (a reply to no message): "Steps", never a bare "Worked", and its steps still open.
    await act(async () => fake.emit.message('inbox', message(9, { id: 'b9', text: 'Here are four takes.', chips: [{ icon: 'think', text: 'made 4 pictures' }] })))
    const steps = transcript().querySelector<HTMLButtonElement>('[data-message-id="b9"] .bot-worked')!
    expect(steps.textContent).toBe('Steps')
    await click(steps)
    expect(transcript().querySelector('[data-message-id="b9"] .bot-steps')?.textContent).toBe('Made 4 pictures')
    expect(error!.querySelector('.bot-error span')?.textContent).toBe('Set up a provider so I can work.')
    await click(button('Set up', error!))
    expect(useAppStore.getState().settingsOpen).toBe(true)
  })

  it('an ask is quick replies under the bubble, Details shows what it is for, and an answered ask is a quiet line', async () => {
    fake.chats.inbox = [
      message(1, { id: 'a1', text: 'I need one thing.', ask: { askId: 'k1', title: 'use files on this computer', note: "Read and change any file or folder, except Mousse's own data.", status: 'open' } }),
      message(2, { id: 'a0', text: 'Can I use my own browser for this?', ask: { askId: 'k0', title: 'use the browser', note: 'Its own browser.', status: 'allowed' } })
    ]
    await open()
    const ask = transcript().querySelector('[data-message-id="a1"]')!
    expect(ask.querySelector('.bot-bubble-ask')?.textContent).toBe('Wants to use files on this computer')
    expect([...ask.querySelectorAll('.bot-ask-buttons button')].map((choice) => choice.textContent)).toEqual(['Allow', 'Not now', 'Details'])
    expect(ask.querySelector('.bot-ask-details')).toBeNull()
    await click(button('Details', ask))
    expect(ask.querySelector('.bot-ask-details')?.textContent).toBe("Read and change any file or folder, except Mousse's own data.")
    await click(button('Not now', ask))
    expect(fake.calls).toContainEqual(['answer', 'inbox', 'k1', 'not_now'])
    // The answered one has no buttons; a centred line after it says what was answered.
    const answered = transcript().querySelector('[data-message-id="a0"]')!
    expect(answered.querySelector('.bot-ask-buttons, .bot-bubble-ask')).toBeNull()
    expect(answered.nextElementSibling?.textContent).toBe('You let Inbox helper use the browser')
  })

  it('work it started is a 👍 and a quiet line, a note a "Noted" receipt; what their chips said stays on them, and in the steps', async () => {
    const opus = 'Opus 5.5 on Claude Code, high reasoning, for this work only'
    fake.chats.inbox = [
      message(1, { id: 'o1', author: 'owner', text: 'run some command pls' }),
      message(2, { id: 'b1', text: 'On it, I’ll text you when it’s done.', replyTo: { id: 'o1', author: 'owner', text: 'run some command pls' }, chips: [{ icon: 'think', text: 'started', highlight: 'System check · Opus 5.5', title: opus }] }),
      message(3, { id: 'o2', author: 'owner', text: 'Use PC Part Picker' }),
      message(4, { id: 'b2', text: 'I’ll use PC Part Picker from here on.', chips: [{ icon: 'think', text: 'noted', title: 'For SSD search' }] }),
      message(5, { id: 'o3', author: 'owner', text: 'And the weather?' }),
      // A reply that says more stays a message, with the line for its work before it, and its chip in its steps.
      message(6, { id: 'b3', text: 'Rain at 4. I also started a forecast check:\n\nit runs hourly.', replyTo: { id: 'o3', author: 'owner', text: 'And the weather?' }, chips: [{ icon: 'think', text: 'started', highlight: 'Forecast' }] })
    ]
    await open()
    const log = transcript()
    expect(log.querySelector('[data-message-id="b1"], [data-message-id="b2"]')).toBeNull()
    expect(log.querySelector('[data-message-id="o1"] .bot-reaction')?.textContent).toBe('👍')
    // The reply's words and the model the work runs on stay on the mark and the line, on hover.
    expect(log.querySelector('[data-message-id="o1"] .bot-reaction')?.getAttribute('title')).toBe(`On it, I’ll text you when it’s done.\n${opus}`)
    expect(log.querySelector('[data-message-id="o2"] .bot-receipt')?.textContent).toBe('Noted')
    expect(log.querySelector('[data-message-id="o2"] .bot-receipt')?.getAttribute('title')).toBe('I’ll use PC Part Picker from here on.\nFor SSD search')
    expect(log.querySelector('[data-message-id="o2"] .bot-reaction')).toBeNull()
    const lines = [...log.querySelectorAll('.bot-system-line')]
    expect(lines.map((line) => line.textContent)).toEqual(['Inbox helper started System check', 'Inbox helper started Forecast'])
    expect(lines[0]!.getAttribute('title')).toBe(`On it, I’ll text you when it’s done.\n${opus}`)
    // No plumbing words on what stands in for the chips.
    expect(log.textContent).not.toMatch(/passed to work|the run|Passed on/)
    expect(log.querySelector('[data-message-id="o3"] .bot-reaction')?.textContent).toBe('👍')
    await click(log.querySelector('[data-message-id="b3"] .bot-worked'))
    expect(log.querySelector('[data-message-id="b3"] .bot-steps')?.textContent).toBe('Started · Forecast')
  })

  it('a path in a reply is a chip with the file’s name: a click opens it in the Files pane, and Show in folder selects it', async () => {
    const folder = 'C:\\Users\\me\\.mousse\\profiles\\d9d018ad-5de0\\bots\\files\\inbox'
    fake.chats.inbox = [message(1, { id: 'b1', text: `Picture: ${folder}\\chip-clouds-boy.png\n\nNotes in \`${folder}\\notes\\plan.md\`.` })]
    const readFile = vi.fn(async () => '# Plan\n\nThree steps.')
    const showInFolder = vi.fn(async () => undefined)
    installPreload(fake, { app: { setViewedBot }, fs: { readFile, readAsset: vi.fn(async () => { throw new Error('none') }) }, localFiles: { showInFolder } })
    await open()
    const chips = [...transcript().querySelectorAll<HTMLButtonElement>('.bot-path-open')]
    // The name only (inside the bot's files folder, the path there), never the profile's folders; the full path on hover.
    expect(chips.map((chip) => [chip.textContent, chip.title])).toEqual([
      ['chip-clouds-boy.png', `${folder}\\chip-clouds-boy.png`],
      ['notes/plan.md', `${folder}\\notes\\plan.md`]
    ])
    expect(transcript().textContent).not.toContain('d9d018ad')
    await click(chips[1])
    await settle()
    const pane = host.querySelector('aside.bot-file-pane')!
    expect(pane.querySelector('.bot-file-name')?.textContent).toBe('notes/plan.md')
    expect(readFile).toHaveBeenCalledWith('plan.md', undefined, null, `${folder}\\notes`)
    expect(pane.querySelector('.bot-file-body h1')?.textContent).toBe('Plan')
    // The file itself, selected in its folder; a refusal is said above the composer.
    await click(button('Show notes/plan.md in folder'))
    expect(showInFolder).toHaveBeenCalledWith(`${folder}\\notes\\plan.md`)
    showInFolder.mockRejectedValueOnce(new Error("Error invoking remote method 'localFiles:showInFolder': Error: That file does not exist."))
    await click(button('Show in folder', pane))
    await settle()
    expect(composerError()?.textContent).toBe('That file does not exist.')
    await click(button('Close file'))
    expect(host.querySelector('aside.bot-file-pane')).toBeNull()
  })

  describe('pictures', () => {
    const FILES = '/home/me/.mousse/bots/files/inbox'
    const picture = (name: string) => `${FILES}/${name}`
    let localFiles: Record<string, ReturnType<typeof vi.fn>>
    /** Every picture file reads as a PNG, each with its own preview address. */
    const install = () => {
      localFiles = { showInFolder: vi.fn(async () => undefined), saveCopy: vi.fn(async () => '/home/me/Downloads/a.png'), copyImage: vi.fn(async () => undefined) }
      let made = 0
      URL.createObjectURL = vi.fn(() => `blob:picture-${++made}`)
      installPreload(fake, { app: { setViewedBot }, fs: { readAsset: vi.fn(async () => ({ mimeType: 'image/png', data: [137, 80, 78, 71] })) }, localFiles })
    }
    const article = (id: string) => transcript().querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
    const contextMenu = async (target: Element) => {
      await act(async () => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })) })
    }

    it('one picture is a message of its own above the words, never a preview above its chip; a picture alone is a bubble with no words', async () => {
      install()
      fake.chats.inbox = [
        message(1, { id: 'b1', text: `Here it is: ${picture('boy.png')}` }),
        message(2, { id: 'b2', text: `![a boy on a chip](file://${picture('made.png')})` })
      ]
      await open()
      await settle()
      const one = article('b1')
      expect(one.querySelectorAll('.bot-reply-media .bot-picture.is-single img')).toHaveLength(1)
      expect(one.querySelector('.bot-carousel')).toBeNull()
      // The picture comes before the words, whose path stays a plain chip.
      const bubble = one.querySelector('.bot-bubble')!
      expect(bubble.querySelector('.bot-reply-media')!.compareDocumentPosition(bubble.querySelector('.bot-markdown')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(one.querySelector('.bot-path img')).toBeNull()
      expect(one.querySelector('.bot-path-open')?.textContent).toBe('boy.png')
      // A picture it made, with nothing else to say: the picture alone, its time under it.
      const alone = article('b2')
      expect(alone.querySelector('.bot-bubble')!.classList.contains('is-media-only')).toBe(true)
      expect(alone.querySelector('.bot-markdown')).toBeNull()
      expect(alone.querySelector('.bot-picture img')?.getAttribute('alt')).toBe('a boy on a chip')
    })

    it('several pictures in one reply are one carousel; Left and Right step through it once it overflows, with a count', async () => {
      install()
      const names = ['a.png', 'b.png', 'c.png', 'd.png']
      fake.chats.inbox = [message(1, { id: 'b1', text: `Four takes:\n\n${names.map((name) => `![${name}](${picture(name)})`).join(' ')}` })]
      // The track is wider than the bubble: the pictures don't all fit.
      const widths = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('bot-carousel-track') ? 1000 : 0 })
      const clients = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('bot-carousel-track') ? 400 : 0 })
      try {
        await open()
        await settle()
        const carousel = article('b1').querySelector<HTMLElement>('.bot-carousel')!
        expect(carousel.getAttribute('aria-label')).toBe('4 pictures')
        expect([...carousel.querySelectorAll('.bot-picture img')].map((image) => image.getAttribute('alt'))).toEqual(names)
        expect(carousel.querySelector('.bot-carousel-count')?.textContent).toBe('1/4')
        expect(button('Previous picture', carousel)).toBeUndefined()
        await act(async () => { carousel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
        await act(async () => { carousel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
        expect(carousel.querySelector('.bot-carousel-count')?.textContent).toBe('3/4')
        await click(button('Previous picture', carousel))
        expect(carousel.querySelector('.bot-carousel-count')?.textContent).toBe('2/4')
      } finally {
        widths.mockRestore()
        clients.mockRestore()
      }
    })

    it('pictures that all fit show no count and no arrows', async () => {
      install()
      fake.chats.inbox = [message(1, { id: 'b1', text: `![a](${picture('a.png')}) ![b](${picture('b.png')})` })]
      await open()
      await settle()
      const carousel = article('b1').querySelector('.bot-carousel')!
      expect(carousel.querySelectorAll('.bot-picture')).toHaveLength(2)
      expect(carousel.querySelector('.bot-carousel-count, .bot-carousel-arrow')).toBeNull()
    })

    it('a picture that can’t be read never shows: the reply keeps its chip, or gets one under its words', async () => {
      install()
      // Only `gone.png` can't be read.
      installPreload(fake, { app: { setViewedBot }, fs: { readAsset: vi.fn(async (name: string) => { if (name === 'gone.png') throw new Error('ENOENT'); return { mimeType: 'image/png', data: [137, 80, 78, 71] } }) }, localFiles })
      fake.chats.inbox = [
        message(1, { id: 'b1', text: `Picture: ${picture('gone.png')}` }),
        message(2, { id: 'b2', text: `![made](${picture('gone.png')})` }),
        message(3, { id: 'b3', text: `![a](${picture('a.png')}) ![gone](${picture('gone.png')})` })
      ]
      await open()
      await settle()
      // Named in the words: its chip there, no picture and no box.
      expect(article('b1').querySelector('.bot-reply-media, .bot-picture')).toBeNull()
      expect(article('b1').querySelector('.bot-bubble')!.classList.contains('has-media')).toBe(false)
      expect([...article('b1').querySelectorAll('.bot-path-open')].map((chip) => chip.textContent)).toEqual(['gone.png'])
      // A picture alone that can't be read: its chip, as the message.
      expect(article('b2').querySelector('.bot-picture')).toBeNull()
      expect(article('b2').querySelector('.bot-bubble')!.classList.contains('is-media-only')).toBe(false)
      expect(article('b2').querySelector('.bot-picture-chips .bot-path-open')?.textContent).toBe('gone.png')
      // With a picture that can: that one alone, as a single picture, and the other's chip.
      expect([...article('b3').querySelectorAll('.bot-picture')].map((tile) => tile.getAttribute('aria-label'))).toEqual(['Open picture: a'])
      expect(article('b3').querySelector('.bot-picture.is-single, .bot-carousel')?.classList.contains('is-single')).toBe(true)
      expect(article('b3').querySelector('.bot-picture-chips .bot-path-open')?.textContent).toBe('gone.png')
    })

    it('a click opens the preview on the reply’s own pictures, with Previous and Next, Save and Show in folder', async () => {
      install()
      fake.chats.inbox = [
        message(1, { id: 'b0', text: `An older one: ![old](${picture('old.png')})` }),
        message(2, { id: 'b1', text: `![a](${picture('a.png')}) ![b](${picture('b.png')}) ![c](${picture('c.png')})` })
      ]
      await open()
      await settle()
      // A picture's name is its label and alt text, never a tooltip that could cover what is above it.
      expect(article('b1').querySelector('.bot-picture[title], .bot-picture img[title]')).toBeNull()
      await click(button('Open picture: b', article('b1')))
      const preview = document.querySelector<HTMLElement>('[role="dialog"]')!
      expect(preview.getAttribute('aria-label')).toBe('b')
      // The reply's three pictures, not the chat's four; in the middle, both arrows, as for a thread's pictures.
      expect(preview.textContent).toContain('2 / 3')
      expect(button('Previous image (←)', preview)).toBeDefined()
      expect(button('Next image (→)', preview)).toBeDefined()
      await click(button('Save', preview))
      expect(localFiles.saveCopy).toHaveBeenCalledWith(picture('b.png'))
      await click(button('Previous image (←)', preview))
      await click(button('Show in folder', preview))
      expect(localFiles.showInFolder).toHaveBeenCalledWith(picture('a.png'))
      // The actions are not the backdrop: the preview stays open.
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
      await click(button('Close fullscreen (Esc)', preview))
    })

    it('a right-click offers Open, Save as…, Show in folder and Copy image, each on that picture', async () => {
      install()
      fake.chats.inbox = [message(1, { id: 'b1', text: `![a](${picture('a.png')}) ![b](${picture('b.png')})` })]
      await open()
      await settle()
      const second = button('Open picture: b', article('b1'))!
      const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('.bot-picture-menu [role="menuitem"]')]
      for (const [label, action] of [['Save as…', 'saveCopy'], ['Show in folder', 'showInFolder'], ['Copy image', 'copyImage']] as const) {
        await contextMenu(second)
        expect(menuItems().map((item) => item.textContent)).toEqual(['Open', 'Save as…', 'Show in folder', 'Copy image'])
        // The tools beside the bubble (reactions, Read aloud, Copy, Reply) step aside while the menu is open.
        expect(article('b1').classList.contains('is-menu-open')).toBe(true)
        await click(menuItems().find((item) => item.textContent === label))
        expect(localFiles[action]).toHaveBeenCalledWith(picture('b.png'))
        expect(document.querySelector('.bot-picture-menu')).toBeNull()
        expect(article('b1').classList.contains('is-menu-open')).toBe(false)
      }
      await contextMenu(second)
      await click(menuItems()[0])
      expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('b')
      await click(button('Close fullscreen (Esc)', document.querySelector('[role="dialog"]')!))
      // Escape closes the menu with nothing done.
      await contextMenu(second)
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      expect(document.querySelector('.bot-picture-menu')).toBeNull()
    })
  })

  it('short inline code never breaks inside, and the punctuation after it stays with it; longer code may wrap', async () => {
    fake.chats.inbox = [message(1, { id: 'b1', text: 'The shortlist is saved in `ssd-shortlist.md`: run `Get-PhysicalDisk | Select-Object FriendlyName, MediaType, Size` to see it.' })]
    await open()
    const codes = [...transcript().querySelectorAll<HTMLElement>('[data-message-id="b1"] code.an-md-code')]
    // Which pieces keep whole is decided here; how a line wraps is checked in screenshots.
    expect(codes.map((code) => [code.textContent, code.classList.contains('is-whole')])).toEqual([['ssd-shortlist.md', true], ['Get-PhysicalDisk | Select-Object FriendlyName, MediaType, Size', false]])
  })

  it('the owner reacts to a bot message: six quick emoji and +, one reaction shown on the bubble, the same again or its badge removes it', async () => {
    fake.chats.inbox = [message(1, { id: 'b1', text: 'Here are three SSDs.' }), message(2, { id: 'o1', author: 'owner', text: 'Thanks' })]
    await open()
    const reply = () => transcript().querySelector<HTMLElement>('[data-message-id="b1"]')!
    const bar = () => reply().querySelector<HTMLElement>('[role="toolbar"]')!
    const badge = () => reply().querySelector<HTMLButtonElement>('.bot-bubble > .bot-reaction')
    expect(bar().getAttribute('aria-label')).toBe('React to this message')
    expect([...bar().querySelectorAll('button')].map((choice) => choice.getAttribute('aria-label'))).toEqual(['React 👍', 'React ❤️', 'React 😂', 'React 😮', 'React 😢', 'React 🙏', 'More reactions'])
    // The owner's own messages take none.
    expect(transcript().querySelector('[data-message-id="o1"] [role="toolbar"]')).toBeNull()

    await click(button('React ❤️', bar()))
    expect(fake.calls).toContainEqual(['react', 'inbox', 'b1', '❤️'])
    expect(badge()?.textContent).toBe('❤️')
    // A pick puts the bar away: the focus is on the bubble, not on a button that would hold the bar open, and the bar
    // stays away while the pointer stays; leaving the message, or tabbing back into the bar, brings it back.
    expect(document.activeElement).toBe(reply().querySelector('.bot-bubble'))
    expect(reply().classList.contains('is-react-quiet')).toBe(true)
    await act(async () => { reply().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
    expect(reply().classList.contains('is-react-quiet')).toBe(false)
    await click(button('React 😂', bar()))
    expect(reply().classList.contains('is-react-quiet')).toBe(true)
    await act(async () => { button('React 👍', bar())!.focus() })
    expect(reply().classList.contains('is-react-quiet')).toBe(false)
    await click(button('React ❤️', bar()))
    expect(button('Remove your reaction ❤️', bar())?.getAttribute('aria-pressed')).toBe('true')
    // Another replaces it: one reaction.
    await click(button('React 👍', bar()))
    expect(reply().querySelectorAll('.bot-reaction')).toHaveLength(1)
    expect(badge()?.textContent).toBe('👍')
    // The same one again removes it.
    await click(button('Remove your reaction 👍', bar()))
    expect(fake.calls.at(-1)).toEqual(['react', 'inbox', 'b1', null])
    expect(badge()).toBeNull()

    // + opens the composer's grid; a pick sets it, and the badge takes it away again.
    await click(button('More reactions', bar()))
    await click(button('🔥', reply().querySelector('.bot-react-grid')!))
    expect(badge()?.textContent).toBe('🔥')
    expect(reply().querySelector('.bot-react-grid')).toBeNull()
    await click(badge())
    expect(fake.calls.at(-1)).toEqual(['react', 'inbox', 'b1', null])
    expect(badge()).toBeNull()

    // Refused by the service: shown at once, then put back as it was, with why above the composer.
    vi.mocked(fake.client.react).mockRejectedValueOnce(new Error('This bot has no such message.'))
    await click(button('React 😮', bar()))
    await settle()
    expect(badge()).toBeNull()
    expect(composerError()?.textContent).toBe('This bot has no such message.')
  })

  it('two quick picks the service refuses end where they started, and a service without reactions shows no bar', async () => {
    fake.chats.inbox = [message(1, { id: 'b1', text: 'Here are three SSDs.', reaction: '❤️' })]
    await open()
    const reply = () => transcript().querySelector<HTMLElement>('[data-message-id="b1"]')!
    const bar = () => reply().querySelector<HTMLElement>('[role="toolbar"]')
    const badge = () => reply().querySelector<HTMLButtonElement>('.bot-bubble > .bot-reaction')
    expect(badge()?.textContent).toBe('❤️')

    // Two picks on their way at once, each refused in turn: the first refusal leaves the newest pick shown, the
    // second puts back the reaction the service last confirmed, not the first pick.
    const refusals: Array<(error: Error) => void> = []
    const onTheWay = () => new Promise<never>((_, reject) => { refusals.push(reject) })
    vi.mocked(fake.client.react).mockImplementationOnce(onTheWay).mockImplementationOnce(onTheWay)
    await click(button('React 👍', bar()!))
    await click(button('React 😂', bar()!))
    expect(badge()?.textContent).toBe('😂')
    await act(async () => { refusals[0]!(new Error('Busy.')) })
    expect(badge()?.textContent).toBe('😂')
    await act(async () => { refusals[1]!(new Error('Busy.')) })
    expect(badge()?.textContent).toBe('❤️')

    // An older service has no reactions: the pick is put back, the bar goes, and nothing is shown as an error.
    await act(async () => { useBotsStore.setState({ error: null, errorBotId: null }) })
    vi.mocked(fake.client.react).mockRejectedValueOnce(Object.assign(new Error('Domain method is unavailable'), { code: 'method_not_available' }))
    await click(button('React 👍', bar()!))
    await settle()
    expect(badge()?.textContent).toBe('❤️')
    expect(bar()).toBeNull()
    expect(composerError()).toBeNull()
  })

  it('a list of keys and values reads as a small card', async () => {
    fake.chats.inbox = [message(1, { id: 'b1', kind: 'run_report', text: 'Your PC looks healthy.\n\n- **CPU:** Ryzen 9 7900X\n- **RAM**: 19.7 GB free\n\nAnd a list:\n\n- one\n- two' })]
    await open()
    const card = transcript().querySelector('.bot-kv')!
    expect([...card.querySelectorAll('.bot-kv-row')].map((row) => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])).toEqual([['CPU', 'Ryzen 9 7900X'], ['RAM', '19.7 GB free']])
    expect([...transcript().querySelectorAll('ul li')].map((item) => item.textContent)).toEqual(['one', 'two'])
  })

  it('groups one sender’s messages within ten minutes, with a time on every message and a day line per day', async () => {
    const today = new Date()
    today.setHours(11, 27, 0, 0)
    const at = (minutes: number, days = 0) => new Date(today.getTime() + minutes * 60_000 - days * 86_400_000).toISOString()
    fake.chats.inbox = [
      message(1, { id: 'y1', at: at(0, 1), text: 'Yesterday’s note.' }),
      message(2, { id: 'o1', author: 'owner', at: at(0), text: 'what functions do u hav e' }),
      message(3, { id: 'o2', author: 'owner', at: at(0), text: 'tool calls' }),
      message(4, { id: 'b1', at: at(0), text: 'I use memory and search.', replyTo: { id: 'o1', author: 'owner', text: 'what functions do u hav e' } }),
      message(5, { id: 'b2', at: at(1), text: 'No topic yet.', replyTo: { id: 'o2', author: 'owner', text: 'tool calls' } }),
      message(6, { id: 'o3', author: 'owner', at: at(20), text: 'Spanish verbs' })
    ]
    await open()
    const log = transcript()
    const article = (id: string) => log.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
    // Two days, each with its line before its first message.
    expect([...log.querySelectorAll('.bot-day')].map((line) => [line.textContent, line.nextElementSibling?.getAttribute('data-message-id')])).toEqual([['Yesterday', 'y1'], ['Today', 'o1']])
    // Owner o1+o2, bot b1+b2 (a quote does not break a group), then o3 twenty minutes later.
    expect(['y1', 'o1', 'o2', 'b1', 'b2', 'o3'].map((id) => article(id).classList.contains('is-group-start'))).toEqual([true, true, false, true, false, true])
    expect(article('b2').querySelector('.bot-reply-quote')?.textContent).toBe('tool calls')
    // Every message has its own time in its bubble, grouped or not, and no time on hover.
    const time = (id: string) => article(id).querySelector('time.bot-bubble-time')
    expect(['y1', 'o1', 'o2', 'b1', 'b2', 'o3'].map((id) => time(id)?.getAttribute('dateTime'))).toEqual([at(0, 1), at(0), at(0), at(0), at(1), at(20)])
    expect(time('b2')?.closest('.bot-bubble')).not.toBeNull()
    expect(time('o2')?.closest('.bot-you-bubble')).not.toBeNull()
    expect(log.querySelector('[title*="2026"], article[title]')).toBeNull()
  })

  it('a message on its way joins its group, and says Sending… where its time goes', async () => {
    fake.chats.inbox = [message(1, { id: 'o1', author: 'owner', at: new Date().toISOString(), text: 'First' })]
    await open()
    vi.mocked(fake.client.send).mockImplementationOnce(() => new Promise(() => {}))
    await type(box(), 'Second')
    await press('Enter')
    const sending = transcript().querySelector<HTMLElement>('.bot-you.is-pending')!
    expect(sending.classList.contains('is-group-start')).toBe(false)
    expect(sending.querySelector('.bot-bubble-time')?.textContent).toBe('Sending…')
  })

  it('Sign in opens Settings, Providers on the entry to sign in to (the bot runner\'s card)', async () => {
    const { takePendingProvider } = await import('../../src/renderer/lib/settingsNavigation')
    const requested: string[] = []
    const listen = (event: Event) => requested.push(String((event as CustomEvent).detail))
    window.addEventListener('mousse:settings-provider', listen)
    try {
      fake.chats.inbox = [message(1, { kind: 'error', text: 'Sign in so I can work.', error: { text: 'Sign in so I can work.', action: { kind: 'sign_in', label: 'Sign in', instanceId: 'claude:bots' } } })]
      await open()
      await click(button('Sign in', transcript().querySelector('article')!))
      expect(useAppStore.getState().settingsOpen).toBe(true)
      expect(requested).toEqual(['claude:bots'])
      expect(takePendingProvider()).toBe('claude:bots')
    } finally {
      window.removeEventListener('mousse:settings-provider', listen)
    }
  })

  it('reports the bot it shows, and reads up to the last message', async () => {
    fake.bots = [{ ...inbox, unread: 2 }]
    fake.chats.inbox = [message(5), message(6)]
    await open({ ...inbox, unread: 2 })
    expect(setViewedBot).toHaveBeenCalledWith('inbox')
    expect(fake.calls).toContainEqual(['markRead', 'inbox', 6])
    expect(useBotsStore.getState().bots[0]?.unread).toBe(0)
    act(() => root.unmount())
    expect(setViewedBot).toHaveBeenLastCalledWith(null)
    root = createRoot(host)
  })

  it('pages back with beforeSeq when scrolled to the top', async () => {
    fake.chats.inbox = Array.from({ length: 70 }, (_, index) => message(index + 1))
    await open()
    expect(transcript().querySelectorAll('article')).toHaveLength(50)
    await act(async () => { transcript().dispatchEvent(new Event('scroll')) })
    await act(async () => {})
    expect(fake.calls).toContainEqual(['messages', 'inbox', { beforeSeq: 21, limit: 50 }])
    expect(transcript().querySelectorAll('article')).toHaveLength(70)
  })

  it('a quote of a message not loaded yet loads older pages until it is there, then scrolls to it and lights it', async () => {
    const scrolled: string[] = []
    const scrollIntoView = vi.fn(function (this: HTMLElement) { scrolled.push(this.getAttribute('data-message-id')!) })
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      fake.chats.inbox = [
        message(1, { id: 'o-old', author: 'owner', text: 'Research vacuums' }),
        ...Array.from({ length: 118 }, (_, index) => message(index + 2)),
        message(120, { id: 'b-late', text: 'The Q7 is the pick.', replyTo: { id: 'o-old', author: 'owner', text: 'Research vacuums' } })
      ]
      await open()
      expect(transcript().querySelector('[data-message-id="o-old"]')).toBeNull()
      await click(transcript().querySelector('[data-message-id="b-late"] .bot-reply-quote'))
      await settle()
      // Two pages back: 71–120 is held, then 21–70, then 1–20 with the quoted message.
      expect(fake.calls.filter((call) => call[0] === 'messages').slice(1)).toEqual([['messages', 'inbox', { beforeSeq: 71, limit: 50 }], ['messages', 'inbox', { beforeSeq: 21, limit: 50 }]])
      expect(scrolled).toEqual(['o-old'])
      expect(transcript().querySelector('[data-message-id="o-old"]')!.classList.contains('is-shown')).toBe(true)
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('a quote of a message the chat no longer has loads what there is and does nothing else', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      fake.chats.inbox = [
        ...Array.from({ length: 69 }, (_, index) => message(index + 1)),
        message(70, { id: 'b-late', text: 'Done.', replyTo: { id: 'deleted', author: 'owner', text: 'Research vacuums' } })
      ]
      await open()
      await click(transcript().querySelector('[data-message-id="b-late"] .bot-reply-quote'))
      await settle()
      expect(fake.calls).toContainEqual(['messages', 'inbox', { beforeSeq: 21, limit: 50 }])
      expect(useBotsStore.getState().chats.inbox?.hasMore).toBe(false)
      expect(scrollIntoView).not.toHaveBeenCalled()
      expect(transcript().querySelector('.is-shown')).toBeNull()
      expect(useBotsStore.getState().error).toBeNull()
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})

describe('while it works', () => {
  const presence = () => host.querySelector('.chat-conversation-header .bot-presence')
  const sticker = () => host.querySelector('.bot-header-about .bot-sticker')

  it('types as a messenger does: dots in a bubble, "typing…" and a pen in the header, no spinner or chip; Stop and the mic stay', async () => {
    fake.chats.inbox = [message(1, { id: 'o1', author: 'owner', text: 'again' })]
    fake.live.inbox = { activationId: 'act1', chip: { icon: 'search', text: 'searching the web' } }
    await open({ ...inbox, state: 'working', stateText: 'Working…' })
    const typing = transcript().querySelector('.bot-typing')!
    expect(typing.getAttribute('aria-label')).toBe('Inbox helper is typing')
    expect(typing.querySelectorAll('.bot-typing-bubble i')).toHaveLength(3)
    expect(transcript().querySelector('.chat-spin, .bot-chip, .chat-run-status')).toBeNull()
    expect(transcript().textContent).not.toContain('is working')
    expect(presence()?.textContent).toBe('typing…')
    expect(sticker()?.getAttribute('data-kind')).toBe('typing')
    await click(button('Stop run'))
    expect(fake.calls).toContainEqual(['stop', 'inbox'])
    // You can always talk to a bot: the mic stays beside Stop while it works.
    expect(button('Dictate')).toBeDefined()
    // With words in the box, Stop moves left of Send, as in a thread: sending does not wait for the run.
    await type(box(), 'Also check the spam folder.')
    expect(button('Stop run')).toBeDefined()
    expect(button('Send message')?.disabled).toBe(false)
  })

  it('moves the typing dots one after another while motion is on, and holds them still with Animation speed Off', async () => {
    // jsdom has no Web Animations, so element.animate is recorded here; that the dots run on the compositor with no
    // main-thread frames is checked in a trace of the app.
    const started: Array<{ element: Element; options: KeyframeAnimationOptions; cancelled: boolean }> = []
    ;(HTMLElement.prototype as { animate?: unknown }).animate = function (this: Element, _keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const record = { element: this, options, cancelled: false }
      started.push(record)
      return { cancel: () => { record.cancelled = true } }
    }
    try {
      await open({ ...inbox, state: 'working', stateText: 'Working…' })
      const dots = [...transcript().querySelectorAll('.bot-typing-bubble i')]
      const running = () => started.filter((record) => !record.cancelled)
      expect(running().map((record) => [dots.indexOf(record.element), record.options.delay, record.options.iterations]))
        .toEqual([[0, 0, Infinity], [1, 150, Infinity], [2, 300, Infinity]])
      act(() => setAnimationSpeed('off'))
      expect(running()).toEqual([])
      act(() => setAnimationSpeed('normal'))
      expect(running()).toHaveLength(3)
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate
      setAnimationSpeed('normal')
    }
  })

  it('says Waiting for internet where it would type, with nothing moving, and still offers Stop', async () => {
    await open({ ...inbox, state: 'working', stateText: 'Waiting for internet', waiting: 'internet' })
    expect(transcript().querySelector('.bot-typing')?.textContent).toBe('Waiting for internet')
    expect(transcript().querySelector('.bot-typing-bubble, .chat-spin')).toBeNull()
    expect(presence()?.textContent).toBe('waiting for internet')
    expect(sticker()).toBeNull()
    await click(button('Stop run'))
    expect(fake.calls).toContainEqual(['stop', 'inbox'])
  })

  it('a free bot says free, with no sticker; a paused one says paused, with a pause sticker', async () => {
    await open()
    expect(presence()?.textContent).toBe('free')
    expect(sticker()).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await open({ ...inbox, state: 'paused', stateText: 'Paused until 14:00' })
    expect(presence()?.textContent).toBe('paused')
    expect(sticker()?.getAttribute('data-kind')).toBe('paused')
  })
})

describe('what renders again', () => {
  it('leaves the messages alone for a poll that changed nothing, a live chip, the bot starting work and the chats list', async () => {
    fake.chats.inbox = [message(1, { author: 'owner', text: 'Find me a PSU.' }), message(2, { text: 'Here are three.' }), message(3, { text: 'And a fourth.' })]
    await open()
    markdown.renders = 0
    await act(async () => { await useBotsStore.getState().refresh() })
    await act(async () => fake.emit.activity('inbox', { icon: 'web', text: 'reading a page', highlight: 'example.com' }))
    fake.bots = [{ ...inbox, state: 'working', stateText: 'Working…' }]
    await act(async () => { await useBotsStore.getState().refresh() })
    await act(async () => useChatsStore.setState({ snapshot: { ...useChatsStore.getState().snapshot } }))
    expect(markdown.renders).toBe(0)
    expect(transcript().querySelector('.bot-typing')).not.toBeNull()
    // A new message renders itself only.
    await act(async () => fake.emit.message('inbox', message(4, { text: 'Done.' })))
    expect(markdown.renders).toBe(1)
  })
})

describe('the composer', () => {
  it('is the thread composer with emoji, attach, dictation and send, and no model, context, permission, commands or skills', async () => {
    await open()
    const form = composer()
    expect(form.querySelectorAll('textarea')).toHaveLength(1)
    expect(box().placeholder).toBe('Message Inbox helper')
    expect([...form.querySelectorAll('input')].map((element) => element.type)).toEqual(['file'])
    expect([...form.querySelectorAll('button')].map((element) => element.getAttribute('aria-label'))).toEqual(['Emoji', 'Attach files', 'Dictate', 'Send message'])
    expect(form.querySelector('.composer-run-controls, .composer-model-btn, .composer-context-anchor, .composer-permission-chip')).toBeNull()
    expect(button('Send message')?.disabled).toBe(true)
    // Neither `/` commands nor `@` skills open a list.
    for (const text of ['/', '/c', '/skills', '@']) {
      await type(box(), text)
      expect(host.querySelector('#composer-command-suggestions')).toBeNull()
    }
  })

  it('Emoji opens a small grid; a pick goes in at the caret and the grid closes', async () => {
    await open()
    await type(box(), 'sounds good')
    box().setSelectionRange(6, 6)
    await click(button('Emoji'))
    const grid = host.querySelector('.bot-emoji-grid')!
    await click(button('👍', grid))
    expect(box().value).toBe('sounds👍 good')
    expect(host.querySelector('.bot-emoji-grid')).toBeNull()
  })

  it('sends the words with Enter, shows them at once and empties the box', async () => {
    await open()
    let release!: () => void
    vi.mocked(fake.client.send).mockImplementationOnce((botId, text) => new Promise((resolve) => {
      release = () => resolve(message(9, { id: 'sent', author: 'owner', text }))
    }))
    await type(box(), 'Do this every weekday at 9.')
    await press('Enter')
    expect(transcript().querySelector('.bot-you.is-pending')?.textContent).toContain('Do this every weekday at 9.')
    expect(box().value).toBe('')
    await act(async () => release())
    expect(transcript().querySelector('.is-pending')).toBeNull()
    expect(transcript().querySelectorAll('.bot-you')).toHaveLength(1)
    // Up in the empty box brings the message back, as in a thread.
    await press('ArrowUp')
    expect(box().value).toBe('Do this every weekday at 9.')
  })

  it('Reply on text selected in a bot message puts a pill in the box at the caret; the bot gets it in quotes in its own paragraph', async () => {
    fake.chats.inbox = [message(1, { id: 'b1', text: 'Your flight leaves at 9:40 from gate 12.' })]
    await act(async () => { createRoot(document.body.appendChild(document.createElement('div'))).render(createElement(SelectionReplyButton)) })
    await open()
    // jsdom has no layout: the selection is given a place on screen.
    Range.prototype.getClientRects = () => [{ top: 10, bottom: 30, left: 10, right: 80 }] as unknown as DOMRectList
    transcript().getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 500 }) as DOMRect
    await type(box(), 'Which gate? ')
    // Selects "gate 12" in the bot's message, as a drag would, and lets the button find it.
    const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))) })
    const select = async () => {
      // The box takes the focus a frame after an edit, which would end a selection made before it.
      await frame()
      const walker = document.createTreeWalker(transcript().querySelector('.bot-bubble')!, NodeFilter.SHOW_TEXT)
      let textNode = walker.nextNode()
      while (textNode && !textNode.textContent!.includes('gate 12')) textNode = walker.nextNode()
      const at = textNode!.textContent!.indexOf('gate 12')
      const range = document.createRange()
      range.setStart(textNode!, at)
      range.setEnd(textNode!, at + 'gate 12'.length)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      await frame()
    }
    await select()
    await click(document.querySelector('.selection-reply-button'))
    expect(box().value).toMatch(/^Which gate\? \u2068Reply\u00a0“gate\u00a012”\u2069 $/)
    // The pill goes like one character.
    box().setSelectionRange(box().value.length - 1, box().value.length - 1)
    await press('Backspace')
    expect(box().value).toBe('Which gate?  ')
    await select()
    await click(document.querySelector('.selection-reply-button'))
    await press('Enter')
    expect(vi.mocked(fake.client.send).mock.calls.at(-1)?.[1]).toBe('Which gate?\n\n"gate 12"')
  })

  it('two identical messages on their way are two bubbles, and each confirmation clears only its own', async () => {
    await open()
    const releases: Array<() => void> = []
    vi.mocked(fake.client.send).mockImplementation((botId, text, clientRequestId) => new Promise((resolve) => {
      releases.push(() => resolve(message(releases.length + 9, { id: `sent:${clientRequestId}`, author: 'owner', text, clientRequestId })))
    }))
    for (let n = 0; n < 2; n += 1) {
      await type(box(), 'ok')
      await press('Enter')
    }
    const ids = vi.mocked(fake.client.send).mock.calls.map((call) => call[2])
    expect(new Set(ids).size).toBe(2)
    expect(transcript().querySelectorAll('.bot-you.is-pending')).toHaveLength(2)
    // The second message's confirmation comes first (an event can beat the first send's answer).
    await act(async () => fake.emit.message('inbox', message(20, { id: 'sent-2', author: 'owner', text: 'ok', clientRequestId: ids[1] as string })))
    expect([...transcript().querySelectorAll('.bot-you.is-pending')].map((bubble) => bubble.getAttribute('data-message-id'))).toEqual([`pending:${ids[0]}`])
    await act(async () => releases[0]!())
    await settle()
    expect(transcript().querySelector('.is-pending')).toBeNull()
    expect(transcript().querySelectorAll('.bot-you')).toHaveLength(2)
  })

  it('puts the words back when sending fails, and says why above the composer', async () => {
    await open()
    vi.mocked(fake.client.send).mockRejectedValueOnce(new Error('The bot is not there'))
    await type(box(), 'Hello')
    await click(button('Send message'))
    await settle()
    expect(box().value).toBe('Hello')
    expect(composerError()?.textContent).toBe('The bot is not there')
    expect(transcript().querySelector('.bot-you')).toBeNull()
    await click(button('Dismiss'))
    expect(composerError()).toBeNull()
  })

  it('sends picked, dropped and pasted files with the message, and shows the copies the bot got', async () => {
    await open()
    const picked = new File(['Invoice total: 120 EUR'], 'march.pdf', { type: 'application/pdf' })
    const dropped = new File(['a,b\n1,2'], 'sheet.csv', { type: 'text/csv' })
    const pasted = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' })
    const input = composer().querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [picked], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await fire(composer(), 'drop', 'dataTransfer', { types: ['Files'], files: [dropped], getData: () => '' })
    await fire(box(), 'paste', 'clipboardData', { items: [{ kind: 'file', type: 'image/png', getAsFile: () => pasted }], files: [] })
    expect(composer().querySelector('.composer-attachments')?.textContent).toContain('march.pdf')
    expect(composer().querySelector('.composer-attachments')?.textContent).toContain('sheet.csv')
    expect(button('Send message')?.disabled).toBe(false)
    await click(button('Send message'))
    await settle()
    // Each file goes by its path: a picked or dropped one's own, a temporary copy of a pasted one.
    const send = fake.calls.find(([name]) => name === 'send')!
    expect(send[4]).toEqual([
      { name: 'march.pdf', path: '/home/me/Desktop/march.pdf' },
      { name: 'sheet.csv', path: '/home/me/Desktop/sheet.csv' },
      { name: expect.stringMatching(/^paste-.*\.png$/), path: expect.stringMatching(/^\/tmp\/mousse-bot-attachments\/1\/paste-.*\.png$/) }
    ])
    expect(vi.mocked(fake.events.attachmentPath!).mock.calls.map(([file]) => file)).toEqual([picked, dropped, expect.objectContaining({ type: 'image/png' })])
    expect(composer().querySelector('.composer-attachments')).toBeNull()
    const sent = transcript().querySelector('.bot-you')!
    expect([...sent.querySelectorAll('.bot-file-pill')].map((pill) => pill.getAttribute('title'))).toEqual([
      '/home/me/.mousse/bots/files/inbox/attachments/2026-11-08/march.pdf',
      '/home/me/.mousse/bots/files/inbox/attachments/2026-11-08/sheet.csv'
    ])
    // The pasted screenshot shows as a picture, named on hover.
    expect([...sent.querySelectorAll('.bot-images .bot-image')].map((tile) => tile.getAttribute('title'))).toEqual([expect.stringMatching(/^paste-.*\.png$/)])
  })

  it('sends files alone, and refuses a file over the limit before sending anything', async () => {
    await open()
    const huge = new File(['x'], 'film.mov', { type: 'video/quicktime' })
    Object.defineProperty(huge, 'size', { value: 51 * 1024 * 1024 })
    await act(async () => useBotsStore.getState().setAttachments('inbox', [{ id: 'f1', file: huge }]))
    await click(button('Send message'))
    await settle()
    expect(composerError()?.textContent).toBe('film.mov is larger than 50 MB.')
    expect(fake.calls.some(([name]) => name === 'send')).toBe(false)
    await act(async () => useBotsStore.getState().setAttachments('inbox', [{ id: 'f2', file: new File(['hi'], 'note.txt', { type: 'text/plain' }) }]))
    await click(button('Send message'))
    await settle()
    expect(fake.calls.find(([name]) => name === 'send')?.slice(2, 3)).toEqual([''])
  })

  it('says Paused with Resume while the bot is paused', async () => {
    await open({ ...inbox, state: 'paused', stateText: 'Paused until 14:00' })
    expect(transcript().querySelector('.bot-paused-line')?.textContent).toBe('Paused until 14:00. Resume')
    await click(button('Resume', transcript()))
    expect(fake.calls).toContainEqual(['resume', 'inbox'])
  })
})

describe('the menu', () => {
  it('offers About, Rename, Change look, Pause and Delete bot', async () => {
    await open()
    await click(button('Bot menu'))
    expect([...host.querySelectorAll('[role="menuitem"]')].map((element) => element.textContent)).toEqual(['About this bot', 'Rename', 'Change look', 'Pause', 'Delete bot'])
    await click(button('About this bot'))
    expect(host.querySelector('.bot-about')).not.toBeNull()
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })

  it('shows the name and its presence in the header, and opens About from the face', async () => {
    await open()
    // What the bot does is in About, not under the name: under it is only its presence.
    expect(host.querySelector('.bot-header-who')?.textContent).toBe('Inbox helperfree')
    expect(host.querySelector('.chat-conversation-header')?.textContent).not.toContain('Tells me which emails need a reply.')
    await click(button('About Inbox helper'))
    expect(host.querySelector('aside.bot-about')?.getAttribute('aria-label')).toBe('About Inbox helper')
  })

  it('renames the bot', async () => {
    await open()
    await click(button('Bot menu'))
    await click(button('Rename'))
    await type(host.querySelector<HTMLInputElement>('#bot-rename')!, 'Mail helper')
    await click(button('Save'))
    expect(fake.calls).toContainEqual(['update', 'inbox', { name: 'Mail helper' }])
    expect(host.querySelector('.chat-conversation-header h1')?.textContent).toBe('Mail helper')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('changes the look', async () => {
    await open()
    await click(button('Bot menu'))
    await click(button('Change look'))
    await click(button('Pink'))
    await click(button('Chef hat'))
    await click(button('Save'))
    expect(fake.calls).toContainEqual(['update', 'inbox', { look: { colour: 'pink', accessory: 'chef_hat' } }])
    expect(host.querySelector('.chat-conversation-header .bot-face')?.getAttribute('data-accessory')).toBe('chef_hat')
  })

  it('pauses and resumes', async () => {
    await open()
    await click(button('Bot menu'))
    await click(button('Pause'))
    expect(fake.calls).toContainEqual(['pause', 'inbox'])
    await click(button('Bot menu'))
    expect(button('Resume')?.getAttribute('role')).toBe('menuitem')
  })

  it('deletes after a confirm that says what is kept', async () => {
    await open()
    await click(button('Bot menu'))
    await click(button('Delete bot'))
    const confirm = host.querySelector('[role="dialog"]')!
    expect(confirm.querySelector('h2')?.textContent).toBe('Delete Inbox helper?')
    expect(confirm.textContent).toContain('Its chat and memory are kept for 30 days, then erased.')
    expect(fake.calls.some(([name]) => name === 'remove')).toBe(false)
    await click(button('Delete bot', confirm))
    expect(fake.calls).toContainEqual(['remove', 'inbox'])
    expect(useChatsStore.getState().activeBotId).toBeNull()
    expect(host.querySelector('.bot-conversation')).toBeNull()
  })
})

describe('the store behind the chats', () => {
  it('never brings back a deleted bot from a list that was on its way, and keeps a bot’s error in its own chat', async () => {
    const other = summary('garden', { name: 'Garden' })
    await open(inbox)
    fake.bots = [inbox, other]
    // A list asked for before the delete answers after it, with the bot still in it.
    let answer: (list: typeof fake.bots) => void = () => {}
    vi.mocked(fake.client.list).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const listed = [...fake.bots]
    let refreshing!: Promise<void>
    await act(async () => { refreshing = useBotsStore.getState().refresh() })
    await act(async () => { await useBotsStore.getState().remove('inbox') })
    await act(async () => { answer(listed); await refreshing })
    expect(useBotsStore.getState().bots.map((bot) => bot.id)).toEqual(['garden'])
    await act(async () => { await useBotsStore.getState().loadDetail('inbox').catch(() => undefined) })
    expect(useBotsStore.getState().bots.map((bot) => bot.id)).toEqual(['garden'])
    // A pause of Garden that fails while Mail's chat is open is Garden's error: Mail's composer does not show it.
    fake.bots = [other, summary('mail', { name: 'Mail' })]
    await act(async () => { await useBotsStore.getState().refresh() })
    await act(async () => useChatsStore.getState().openBot('mail'))
    vi.mocked(fake.client.pause).mockRejectedValueOnce(new Error('Garden could not pause'))
    await act(async () => { await useBotsStore.getState().pause('garden') })
    expect(useBotsStore.getState()).toMatchObject({ error: 'Garden could not pause', errorBotId: 'garden' })
    expect(composerError()).toBeNull()
    vi.mocked(fake.client.pause).mockRejectedValueOnce(new Error('Mail could not pause'))
    await act(async () => { await useBotsStore.getState().pause('mail') })
    expect(composerError()?.textContent).toBe('Mail could not pause')
  })

  it('starts the chat over when more rows arrived than a page while events were missed', async () => {
    fake.chats.inbox = Array.from({ length: 10 }, (_, index) => message(index + 1))
    await open()
    expect(transcript().querySelectorAll('article')).toHaveLength(10)
    fake.chats.inbox = Array.from({ length: 80 }, (_, index) => message(index + 1))
    await act(async () => { await useBotsStore.getState().loadChat('inbox') })
    const held = useBotsStore.getState().chats.inbox!
    expect(held.messages.map((row) => row.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 31))
    expect(held.hasMore).toBe(true)
    await act(async () => { await useBotsStore.getState().loadOlder('inbox') })
    expect(useBotsStore.getState().chats.inbox!.messages.map((row) => row.seq)).toEqual(Array.from({ length: 80 }, (_, index) => index + 1))
  })
})

describe('free while it works (docs/plans/bot-always-free.md)', () => {
  const working = summary('inbox', {
    name: 'Inbox helper', state: 'working', stateText: 'Working on Vacuum comparison',
    work: [
      { id: 'act_w1', title: 'Vacuum comparison', status: 'running', startedAt: new Date(Date.now() - 4 * 60_000).toISOString() },
      { id: 'act_w2', title: 'Train times', status: 'queued', startedAt: new Date().toISOString() }
    ]
  })

  const presence = () => host.querySelector<HTMLElement>('.chat-conversation-header .bot-presence')!
  const sticker = () => host.querySelector('.bot-header-about .bot-sticker')

  it('names its work in the header ("Vacuum comparison +1"), whose list has each piece with Stop; the chat stays free', async () => {
    await open(working)
    // The work running longest, and how many more; the sticker says what that work does now.
    expect(presence().textContent).toBe('Vacuum comparison +1')
    expect(sticker()?.getAttribute('data-kind')).toBe('working')
    await act(async () => fake.emit.activity('inbox', { icon: 'search', text: 'searching the web', highlight: 'vacuum', live: true }, 'act_w1'))
    expect(sticker()?.getAttribute('data-kind')).toBe('search')
    // No strip above the composer: the list opens from the header.
    expect(host.querySelector('.bot-work')).toBeNull()
    await click(presence())
    expect([...host.querySelectorAll('.bot-work-line')].map((line) => line.textContent)).toEqual(['Vacuum comparisonsearching the web vacuum · 4 min', 'Train timesqueued'])
    // The chat is free: nothing typing, and the composer sends.
    expect(transcript().querySelector('.bot-typing')).toBeNull()
    expect(button('Stop run')).toBeUndefined()
    await click(button('Stop Vacuum comparison'))
    expect(fake.calls).toContainEqual(['stopWork', 'inbox', 'act_w1'])
  })

  it('one piece of work is named alone, never "+0", and the browser shows as its sticker', async () => {
    await open({ ...working, work: [working.work![0]!] })
    expect(presence().textContent).toBe('Vacuum comparison')
    await act(async () => fake.emit.activity('inbox', { icon: 'web', text: 'using the browser', highlight: 'example.com', live: true }, 'act_w1'))
    expect(sticker()?.getAttribute('data-kind')).toBe('browser')
  })

  it('work on a model the owner named says which in its line, with the details on hover', async () => {
    const detail = 'Opus 5.5 on Claude Code, high reasoning, for this work only'
    await open({ ...working, work: [{ ...working.work![0]!, model: { name: 'Opus 5.5', detail } }] })
    await click(presence())
    const line = host.querySelector('.bot-work-line')!
    expect(line.textContent).toBe('Vacuum comparisonworking · Opus 5.5 · 4 min')
    expect(line.querySelector('[title]')!.getAttribute('title')).toBe(detail)
  })

  it("the chat's own turn types and has Stop; the header still opens the work", async () => {
    await open({ ...working, chat: { activationId: 'act_c1' } })
    expect(transcript().querySelector('.bot-typing')).not.toBeNull()
    expect(presence().textContent).toBe('typing…')
    expect(button('Stop run')).toBeDefined()
    await click(presence())
    expect(host.querySelectorAll('.bot-work-line')).toHaveLength(2)
  })

  it('a reply shows what it answers only when that is not right above it; Reply quotes a message and sends with it', async () => {
    fake.chats.inbox = [
      message(1, { id: 'o1', author: 'owner', text: 'Research vacuums' }),
      message(2, { id: 'b1', text: 'On it.', replyTo: { id: 'o1', author: 'owner', text: 'Research vacuums' } }),
      message(3, { id: 'o2', author: 'owner', text: 'Add batteries' }),
      message(4, { id: 'b2', text: 'Added.', replyTo: { id: 'o2', author: 'owner', text: 'Add batteries' } }),
      message(5, { id: 'b3', kind: 'run_report', text: 'The Q7 is the pick.', replyTo: { id: 'o1', author: 'owner', text: 'Research vacuums' } })
    ]
    await open(inbox)
    // The owner's own message carries no name: its tint (data-author) says whose it is.
    const quotes = [...transcript().querySelectorAll('.bot-reply-quote')]
    expect(quotes.map((quote) => [quote.getAttribute('data-author'), quote.textContent, quote.getAttribute('aria-label')])).toEqual([['owner', 'Research vacuums', 'Replying to your message: Research vacuums']])
    expect(transcript().querySelector('[data-message-id="b3"] .bot-reply-quote')).not.toBeNull()

    // Replying to an older message: the sent message shows what it answers.
    await click(transcript().querySelector('[data-message-id="b2"] .bot-reply-button'))
    const replying = host.querySelector('.bot-replying')!
    expect([replying.getAttribute('data-author'), replying.textContent, replying.getAttribute('aria-label')]).toEqual(['bot', 'Inbox helperAdded.', "Replying to Inbox helper's message: Added."])
    await click(button("Don't reply to this message"))
    expect(host.querySelector('.bot-replying')).toBeNull()
    await click(transcript().querySelector('[data-message-id="b1"] .bot-reply-button'))
    await type(box(), 'Make it under £200')
    await press('Enter')
    await settle()
    expect(fake.calls.find((call) => call[0] === 'send')).toEqual(['send', 'inbox', 'Make it under £200', expect.any(String), [], 'b1'])
    expect(host.querySelector('.bot-replying')).toBeNull()
    expect(transcript().querySelector('[data-message-id^="sent:"] .bot-reply-quote')!.textContent).toBe('Inbox helperOn it.')
  })
})

describe('pinned above the composer, and New message', () => {
  const pins = () => [...host.querySelectorAll<HTMLButtonElement>('.bot-pins .bot-pinned')]
  const fileAsk = { askId: 'k1', title: 'use files on this computer', note: 'Any file or folder.', status: 'open' as const }

  it('pins the open ask and the current error, shows the full message on click, and drops each once it is answered or cleared', async () => {
    const shown = vi.spyOn(Element.prototype, 'scrollIntoView')
    const stuck = { ...inbox, state: 'stuck' as const, error: { text: 'Set up a provider so I can work.', action: { kind: 'open_providers' as const, label: 'Set up' } } }
    fake.chats.inbox = [
      message(1, { id: 'e0', kind: 'error', text: 'Old.', error: { text: 'An old error.' } }),
      message(2, { id: 'a1', text: 'I need one thing.', ask: fileAsk }),
      message(3, { id: 'e1', kind: 'error', text: 'I couldn’t check.', error: stuck.error }),
      ...Array.from({ length: 10 }, (_, index) => message(index + 4))
    ]
    await open(stuck)
    expect(pins().map((pin) => [pin.dataset.kind, pin.textContent])).toEqual([['ask', 'Inbox helper wants to use files on this computer'], ['error', 'Set up a provider so I can work.']])

    await click(pins()[1])
    expect(shown.mock.contexts.at(-1)).toBe(transcript().querySelector('[data-message-id="e1"]'))
    await click(pins()[0])
    expect(shown.mock.contexts.at(-1)).toBe(transcript().querySelector('[data-message-id="a1"]'))

    // While the full error is on screen its pinned line hides; scrolled away, it is back.
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    const errorRow = transcript().querySelector<HTMLElement>('[data-message-id="e1"]')!
    transcript().getBoundingClientRect = () => rect(0, 800)
    errorRow.getBoundingClientRect = () => rect(300, 400)
    await act(async () => { transcript().dispatchEvent(new Event('scroll')) })
    expect(pins().map((pin) => pin.dataset.kind)).toEqual(['ask'])
    errorRow.getBoundingClientRect = () => rect(-400, -300)
    await act(async () => { transcript().dispatchEvent(new Event('scroll')) })
    expect(pins().map((pin) => pin.dataset.kind)).toEqual(['ask', 'error'])

    await click(button('Allow', transcript().querySelector('[data-message-id="a1"]')!))
    await settle()
    expect(pins().map((pin) => pin.dataset.kind)).toEqual(['error'])
    fake.bots = [inbox]
    await act(async () => fake.emit.changed('inbox'))
    await settle()
    expect(host.querySelector('.bot-pins')).toBeNull()
    shown.mockRestore()
  })

  it('pins nothing for answered asks and past errors', async () => {
    fake.chats.inbox = [message(1, { ask: { ...fileAsk, status: 'allowed' } }), message(2, { kind: 'error', error: { text: 'Gone now.' } })]
    await open()
    expect(host.querySelector('.bot-pins')).toBeNull()
  })

  it('offers New message when a reply arrives while scrolled up, and goes to the end on click', async () => {
    fake.chats.inbox = Array.from({ length: 20 }, (_, index) => message(index + 1))
    await open()
    const log = transcript()
    let height = 2000
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 500 })
    // Scrolled up right after opening: the first reply offers New message.
    log.scrollTop = 300
    await act(async () => { log.dispatchEvent(new Event('scroll')) })
    await act(async () => { height = 2100; fake.emit.message('inbox', message(21)) })
    expect(log.scrollTop).toBe(300)
    expect(button('New message')).toBeDefined()
    // At the end, a new reply just shows.
    log.scrollTop = 1600
    await act(async () => { log.dispatchEvent(new Event('scroll')) })
    expect(button('New message')).toBeUndefined()
    await act(async () => { height = 2150; fake.emit.message('inbox', message(22)) })
    expect(button('New message')).toBeUndefined()
    // Scrolled up: the reader stays put, the owner's own message offers nothing, the bot's offers New message.
    log.scrollTop = 300
    await act(async () => { log.dispatchEvent(new Event('scroll')) })
    await act(async () => { height = 2200; fake.emit.message('inbox', message(23, { author: 'owner' })) })
    expect(button('New message')).toBeUndefined()
    await act(async () => { height = 2300; fake.emit.message('inbox', message(24)) })
    expect(log.scrollTop).toBe(300)
    expect(button('New message')).toBeDefined()
    await click(button('New message'))
    expect(log.scrollTop).toBe(2300)
    expect(button('New message')).toBeUndefined()

    // Scrolling down to the end by hand dismisses it too.
    log.scrollTop = 300
    await act(async () => { log.dispatchEvent(new Event('scroll')) })
    await act(async () => { height = 2400; fake.emit.message('inbox', message(25)) })
    expect(button('New message')).toBeDefined()
    log.scrollTop = 1900
    await act(async () => { log.dispatchEvent(new Event('scroll')) })
    expect(button('New message')).toBeUndefined()
  })
})

describe('loading and labels', () => {
  const loadState = () => host.querySelector('.bot-load-state')

  it('says Loading messages… while the chat first loads, then shows it', async () => {
    fake.chats.inbox = [message(1, { text: 'Hello.' })]
    let release!: () => void
    const original = fake.client.messages
    vi.mocked(fake.client.messages).mockImplementationOnce((...args) => new Promise((resolve) => { release = () => resolve(original(...args)) }))
    fake.bots = [inbox]
    await act(async () => useChatsStore.getState().activate('p1'))
    await act(async () => root.render(createElement(ChatWorkspace)))
    let opening!: Promise<void>
    await act(async () => { opening = useChatsStore.getState().openBot('inbox') })
    expect(loadState()?.textContent).toBe('Loading messages…')
    expect(transcript().querySelectorAll('article')).toHaveLength(0)
    await act(async () => { release(); await opening })
    expect(loadState()).toBeNull()
    expect(transcript().querySelectorAll('article')).toHaveLength(1)
  })

  it('says it couldn’t load with Retry, and Retry loads the chat', async () => {
    fake.chats.inbox = [message(1, { text: 'Hello.' })]
    vi.mocked(fake.client.messages).mockImplementationOnce(() => Promise.reject(new Error('offline')))
    await open()
    expect(loadState()?.textContent).toBe('Couldn’t load messages.Retry')
    // Said once, in the transcript: not again above the composer.
    expect(composerError()).toBeNull()
    await click(button('Retry'))
    await settle()
    expect(loadState()).toBeNull()
    expect(transcript().querySelector('[data-message-id="m1"]')).not.toBeNull()
  })

  it('a chat already shown keeps its messages when a later load fails, and says why above the composer', async () => {
    fake.chats.inbox = [message(1, { text: 'Hello.' })]
    await open()
    vi.mocked(fake.client.messages).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('The service is offline.'), { code: 'offline' })))
    await act(async () => useBotsStore.getState().loadChat('inbox'))
    expect(loadState()).toBeNull()
    expect(transcript().querySelector('[data-message-id="m1"]')).not.toBeNull()
    expect(composerError()).not.toBeNull()
  })

  it('a report reads as an ordinary reply that quotes the request, with no tag', async () => {
    fake.chats.inbox = [
      message(1, { id: 'o1', author: 'owner', text: 'run some command pls' }),
      message(2, { id: 'm2', text: 'Plain reply.' }),
      message(3, { id: 'bm_act_1', kind: 'run_report', activationId: 'act_1', text: 'Done. Nothing changed.', replyTo: { id: 'o1', author: 'owner', text: 'run some command pls' } })
    ]
    await open()
    const report = transcript().querySelector('[data-message-id="bm_act_1"]')!
    expect(report.querySelector('.bot-bubble > .bot-reply-quote')?.textContent).toBe('run some command pls')
    expect(report.textContent).not.toContain('Work report')
    expect(report.querySelector('.bot-message-label')).toBeNull()
  })
})
