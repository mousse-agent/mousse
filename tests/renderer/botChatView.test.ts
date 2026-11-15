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
import { rollUpChips } from '../../src/shared/bots/personal/chips'
import { AT, fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'
import type { BotLaunchedThread } from '../../src/shared/bots/personal/chat'

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

// A thread opened from the bot's list is recorded, then opened as usual.
const opened = vi.hoisted(() => ({ ids: [] as string[] }))
vi.mock('../../src/renderer/lib/threadActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/lib/threadActions')>()
  return { ...actual, selectThread: (threadId: string, ...rest: unknown[]) => { opened.ids.push(threadId); return (actual.selectThread as (...args: unknown[]) => Promise<unknown>)(threadId, ...rest) } }
})

const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { useChatsStore, OPEN_BOT_HOLD_MS } = await import('../../src/renderer/stores/chatsStore')
const { ChatsSidebar } = await import('../../src/renderer/components/chats/ChatsSidebar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { SelectionReplyButton } = await import('../../src/renderer/components/SelectionReplyButton')
const { botMessageScroller } = await import('../../src/renderer/components/bots/BotChatView')

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

it('shows a permission switch notice as one quiet line', async () => {
  fake.chats[inbox.id] = [{ seq: 1, id: 'bm_permission_check', at: AT, author: 'bot', kind: 'notice', text: "I can't run commands for now.", chips: [], systemLine: true }]
  await open()
  const line = [...host.querySelectorAll('[role="note"]')].find((item) => item.textContent?.includes("I can't run commands"))
  expect(line).toBeTruthy()
  expect(host.querySelector('[data-message-id="bm_permission_check"] button')).toBeNull()
})

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
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
  vi.restoreAllMocks()
  setBotsClient(null)
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
  useAppStore.setState({ settingsOpen: appInitial.settingsOpen })
})

describe('the transcript', () => {
  it('shows put-away memory entries in the reply steps and keeps the saved-entry link focused', async () => {
    const chips = rollUpChips([{
      tool: 'memory_save', input: { text: 'Combined notes.' },
      result: { id: 'm3', absorbed: [{ ref: 'm1', text: 'First note.' }, { ref: 'm2', text: 'Second note.' }] }
    }])
    fake.chats.inbox = [message(1, { id: 'combined', text: 'Saved.', chips })]
    await open()
    await click(transcript().querySelector<HTMLButtonElement>('.bot-worked')!)
    const step = transcript().querySelector('.bot-steps li')!
    expect(step.textContent).toBe('Remembered · Combined notes. · put away 2')
    expect(step.getAttribute('title')).toBe('Put away:\nFirst note.\nSecond note.')
    await click(transcript().querySelector<HTMLButtonElement>('.bot-memory-tag')!)
    expect(useBotsStore.getState().memoryOpen?.focus).toBe('Combined notes.')
  })

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

  it('a second ask of a turn, posted on its own, shows as the ask alone, as on a reply; answered, only its quiet line stays', async () => {
    fake.chats.inbox = [
      message(1, { id: 'a1', text: 'I need two things.', ask: { askId: 'k1', title: 'use files on this computer', note: 'Any file or folder.', status: 'open' } }),
      message(2, { id: 'a2', kind: 'notice', text: 'Inbox helper wants to run commands.', ask: { askId: 'k2', title: 'run commands', note: 'Any command.', status: 'open' } })
    ]
    await open()
    const alone = transcript().querySelector('[data-message-id="a2"]')!
    // No words of its own beside the ask: the ask line and its replies, as on the reply above it.
    expect(alone.querySelector('.bot-markdown')).toBeNull()
    expect(alone.querySelector('.bot-bubble-ask')?.textContent).toBe('Wants to run commands')
    expect([...alone.querySelectorAll('.bot-ask-buttons button')].map((choice) => choice.textContent)).toEqual(['Allow', 'Not now', 'Details'])
    expect(alone.textContent).not.toContain('Inbox helper wants to run commands.')
    await click(button('Allow', alone))
    expect(fake.calls).toContainEqual(['answer', 'inbox', 'k2', 'allow'])
    // Answered: no bubble is left, only the line the answer leaves, as for the reply's ask once answered.
    expect(transcript().querySelector('article[data-message-id="a2"]')).toBeNull()
    const line = transcript().querySelector('[role="note"][data-message-id="a2"]')
    expect(line?.textContent).toBe('You let Inbox helper run commands')
    // The reply's own ask is untouched: its words stay, with the ask under them.
    expect(transcript().querySelector('[data-message-id="a1"] .bot-markdown')?.textContent).toBe('I need two things.')
  })

  it('work it started is a 👍 and a quiet line, a note a "Noted" receipt; a reply with words stays a message, never in a tooltip', async () => {
    const opus = 'Opus 5.5 on Claude Code, high reasoning, for this work only'
    fake.chats.inbox = [
      message(1, { id: 'o1', author: 'owner', text: 'run some command pls' }),
      message(2, { id: 'b1', text: 'On it, I’ll text you when it’s done.', replyTo: { id: 'o1', author: 'owner', text: 'run some command pls' }, chips: [{ icon: 'think', text: 'started', highlight: 'System check · Opus 5.5', title: opus }] }),
      message(3, { id: 'o2', author: 'owner', text: 'Use PC Part Picker' }),
      message(4, { id: 'b2', text: 'I’ll use PC Part Picker from here on.', chips: [{ icon: 'think', text: 'noted', title: 'For SSD search' }] }),
      message(5, { id: 'o3', author: 'owner', text: 'And the weather?' }),
      // A reply that says more stays a message, with the line for its work before it, and its chip in its steps.
      message(6, { id: 'b3', text: 'Rain at 4. I also started a forecast check:\n\nit runs hourly.', replyTo: { id: 'o3', author: 'owner', text: 'And the weather?' }, chips: [{ icon: 'think', text: 'started', highlight: 'Forecast' }] }),
      message(7, { id: 'o4', author: 'owner', text: 'Check the backups' }),
      // A start with no words at all leaves no empty bubble.
      message(8, { id: 'b4', text: '', chips: [{ icon: 'think', text: 'started', highlight: 'Backup check' }] })
    ]
    await open()
    const log = transcript()
    // The replies' words show as messages; the 👍 only says who reacted.
    expect(log.querySelector('[data-message-id="b1"]')?.textContent).toContain('On it, I’ll text you when it’s done.')
    expect(log.querySelector('[data-message-id="b2"]')?.textContent).toContain('I’ll use PC Part Picker from here on.')
    expect(log.querySelector('[data-message-id="b4"]')).toBeNull()
    expect(log.querySelector('[data-message-id="o1"] .bot-reaction')?.textContent).toBe('👍')
    expect(log.querySelector('[data-message-id="o1"] .bot-reaction')?.getAttribute('title')).toBe('Inbox helper reacted')
    expect(log.querySelector('[data-message-id="o4"] .bot-reaction')?.getAttribute('title')).toBe('Inbox helper reacted')
    // What the chips said (the model the work runs on, the job a note is for) stays on what stands in for them.
    expect(log.querySelector('[data-message-id="o2"] .bot-receipt')?.textContent).toBe('Noted')
    expect(log.querySelector('[data-message-id="o2"] .bot-receipt')?.getAttribute('title')).toBe('For SSD search')
    expect(log.querySelector('[data-message-id="o2"] .bot-reaction')).toBeNull()
    const lines = [...log.querySelectorAll('.bot-system-line')]
    expect(lines.map((line) => line.textContent)).toEqual(['Inbox helper started System check', 'Inbox helper started Forecast', 'Inbox helper started Backup check'])
    expect(lines[0]!.getAttribute('title')).toBe(opus)
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
    const openPath = vi.fn(async () => 'file' as const)
    installPreload(fake, { app: { setViewedBot }, fs: { readFile, readAsset: vi.fn(async () => { throw new Error('none') }) }, localFiles: { showInFolder, open: openPath } })
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
    showInFolder.mockRejectedValueOnce(new Error("Error invoking remote method 'localFiles:showInFolder': Error: Can't find plan.md. It may have been moved or deleted."))
    await click(button('Show in folder', pane))
    await settle()
    expect(composerError()?.textContent).toBe("Can't find plan.md. It may have been moved or deleted.")
    await click(button('Close file'))
    expect(host.querySelector('aside.bot-file-pane')).toBeNull()
  })

  it('a folder’s chip opens the folder in the file manager, not the Files pane; a path with nothing at it is said', async () => {
    const net = 'C:\\Users\\me\\.mousse\\net'
    fake.chats.inbox = [message(1, { id: 'b1', text: `Rename this folder: ${net}\\\n\nOld copy: C:\\Users\\me\\old-net` })]
    const readFile = vi.fn(async () => { throw new Error('EISDIR') })
    const openPath = vi.fn(async (path: string) => { if (path !== net) throw new Error("Error invoking remote method 'localFiles:open': Error: Can't find old-net. It may have been moved or deleted."); return 'folder' as const })
    installPreload(fake, { app: { setViewedBot }, fs: { readFile, readAsset: vi.fn(async () => { throw new Error('none') }) }, localFiles: { open: openPath } })
    await open()
    const chips = [...transcript().querySelectorAll<HTMLButtonElement>('.bot-path-open')]
    expect(chips.map((chip) => [chip.textContent, chip.title])).toEqual([['net', net], ['old-net', 'C:\\Users\\me\\old-net']])
    await click(chips[0])
    await settle()
    expect(openPath).toHaveBeenCalledWith(net)
    expect(host.querySelector('aside.bot-file-pane')).toBeNull()
    expect(readFile).not.toHaveBeenCalled()
    expect(composerError()).toBeNull()
    await click(chips[1])
    await settle()
    expect(host.querySelector('aside.bot-file-pane')).toBeNull()
    expect(composerError()?.textContent).toBe("Can't find old-net. It may have been moved or deleted.")
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

  it('the owner reacts to a bot message: one button opens six quick emoji and +, one reaction shown on the bubble, the same again or its badge removes it', async () => {
    fake.chats.inbox = [message(1, { id: 'b1', text: 'Here are three SSDs.' }), message(2, { id: 'o1', author: 'owner', text: 'Thanks' })]
    await open()
    const reply = () => transcript().querySelector<HTMLElement>('[data-message-id="b1"]')!
    const bar = () => reply().querySelector<HTMLElement>('[role="toolbar"]')!
    const menu = () => bar().querySelector<HTMLElement>('[role="menu"]')
    const add = () => button('Add reaction', bar())!
    const badge = () => reply().querySelector<HTMLButtonElement>('.bot-bubble > .bot-reaction')
    const react = async (label: string) => { await click(add()); await click(button(label, menu()!)) }
    expect(bar().getAttribute('aria-label')).toBe('React to this message')
    // The bar holds one button; the emoji are in its popup, closed until it is pressed.
    expect([...bar().querySelectorAll('button')].map((choice) => choice.getAttribute('aria-label'))).toEqual(['Add reaction'])
    expect(menu()).toBeNull()
    // The owner's own messages take none.
    expect(transcript().querySelector('[data-message-id="o1"] [role="toolbar"]')).toBeNull()

    await click(add())
    expect(add().getAttribute('aria-expanded')).toBe('true')
    expect(menu()?.getAttribute('aria-label')).toBe('Reactions')
    expect([...menu()!.querySelectorAll('button')].map((choice) => choice.getAttribute('aria-label'))).toEqual(['React 👍', 'React ❤️', 'React 😂', 'React 😮', 'React 😢', 'React 🙏', 'More reactions'])
    // By keyboard: the focus is on the first emoji, the arrows move it, Escape closes and puts it back on the button.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('React 👍')
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(document.activeElement?.getAttribute('aria-label')).toBe('React ❤️')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(add())
    expect(fake.calls.some((call) => call[0] === 'react')).toBe(false)
    // A press outside closes it too.
    await click(add())
    await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(menu()).toBeNull()
    expect(add().getAttribute('aria-expanded')).toBe('false')

    await react('React ❤️')
    expect(fake.calls).toContainEqual(['react', 'inbox', 'b1', '❤️'])
    expect(badge()?.textContent).toBe('❤️')
    expect(menu()).toBeNull()
    // A pick puts the bar away: the focus is on the bubble, not on a button that would hold the bar open, and the bar
    // stays away while the pointer stays; leaving the message, or tabbing back into the bar, brings it back.
    expect(document.activeElement).toBe(reply().querySelector('.bot-bubble'))
    expect(reply().classList.contains('is-react-quiet')).toBe(true)
    await act(async () => { reply().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
    expect(reply().classList.contains('is-react-quiet')).toBe(false)
    await react('React 😂')
    expect(reply().classList.contains('is-react-quiet')).toBe(true)
    await act(async () => { add().focus() })
    expect(reply().classList.contains('is-react-quiet')).toBe(false)
    await react('React ❤️')
    // Opened again, the reaction there now is marked and has the focus.
    await click(add())
    expect(button('Remove your reaction ❤️', menu()!)?.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove your reaction ❤️')
    // Another replaces it: one reaction.
    await click(button('React 👍', menu()!))
    expect(reply().querySelectorAll('.bot-reaction')).toHaveLength(1)
    expect(badge()?.textContent).toBe('👍')
    // The same one again removes it.
    await react('Remove your reaction 👍')
    expect(fake.calls.at(-1)).toEqual(['react', 'inbox', 'b1', null])
    expect(badge()).toBeNull()

    // + opens the composer's grid in its place; a pick sets it, and the badge takes it away again.
    await click(add())
    await click(button('More reactions', menu()!))
    expect(menu()?.querySelectorAll('button').length).toBeGreaterThan(7)
    await click(button('🔥', menu()!))
    expect(badge()?.textContent).toBe('🔥')
    expect(menu()).toBeNull()
    await click(badge())
    expect(fake.calls.at(-1)).toEqual(['react', 'inbox', 'b1', null])
    expect(badge()).toBeNull()

    // Refused by the service: shown at once, then put back as it was, with why above the composer.
    vi.mocked(fake.client.react).mockRejectedValueOnce(new Error('This bot has no such message.'))
    await react('React 😮')
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
    const react = async (label: string) => { await click(button('Add reaction', bar()!)); await click(button(label, bar()!.querySelector('[role="menu"]')!)) }
    await react('React 👍')
    await react('React 😂')
    expect(badge()?.textContent).toBe('😂')
    await act(async () => { refusals[0]!(new Error('Busy.')) })
    expect(badge()?.textContent).toBe('😂')
    await act(async () => { refusals[1]!(new Error('Busy.')) })
    expect(badge()?.textContent).toBe('❤️')

    // An older service has no reactions: the pick is put back, the bar goes, and nothing is shown as an error.
    await act(async () => { useBotsStore.setState({ error: null, errorBotId: null }) })
    vi.mocked(fake.client.react).mockRejectedValueOnce(Object.assign(new Error('Domain method is unavailable'), { code: 'method_not_available' }))
    await react('React 👍')
    await settle()
    expect(badge()?.textContent).toBe('❤️')
    expect(bar()).toBeNull()
    expect(composerError()).toBeNull()
  })

  it('a list of bold labels stays a plain list, its labels inline', async () => {
    fake.chats.inbox = [message(1, { id: 'b1', kind: 'run_report', text: 'Your PC looks healthy.\n\n- **CPU:** Ryzen 9 7900X\n- **RAM**: 19.7 GB free' })]
    await open()
    const items = [...transcript().querySelectorAll('ul li')]
    expect(items.map((item) => item.textContent)).toEqual(['CPU: Ryzen 9 7900X', 'RAM: 19.7 GB free'])
    expect(items.map((item) => item.querySelector('strong')?.textContent)).toEqual(['CPU:', 'RAM'])
    expect(transcript().querySelector('dl')).toBeNull()
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

describe('a long chat', () => {
  const drawn = () => [...transcript().querySelectorAll('article[data-message-id]')].map((row) => row.getAttribute('data-message-id'))
  const messageCalls = () => fake.calls.filter((call) => call[0] === 'messages').length
  /** The transcript scrolled to `top` of a 5,000px chat in a 500px view, with the scroll event the browser sends. */
  async function scrollTo(top: number) {
    const log = transcript()
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 5000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 500 })
    log.scrollTop = top
    await act(async () => { log.dispatchEvent(new Event('scroll')) })
    await settle()
  }

  it('draws only the newest rows when opened again; scrolling up draws older ones, and the end draws only the newest again', async () => {
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) { scrolled.push(this.getAttribute('data-message-id')!) })
    try {
      fake.chats.inbox = [
        ...Array.from({ length: 199 }, (_, index) => message(index + 1)),
        message(200, { text: 'As I said.', replyTo: { id: 'm10', author: 'bot', text: 'Message 10' } })
      ]
      await open()
      expect(drawn()).toHaveLength(50)
      // Reading back to the start: each page asked for at the top shows when it arrives.
      for (const rows of [100, 150, 200]) {
        await scrollTo(0)
        expect(drawn()).toHaveLength(rows)
      }
      expect(drawn()[0]).toBe('m1')

      // Away to the Threads tab and back: the chat is still loaded, and only its newest rows are drawn.
      await act(async () => root.render(null))
      await act(async () => root.render(createElement(ChatWorkspace)))
      expect(drawn()).toHaveLength(60)
      expect([drawn()[0], drawn().at(-1)]).toEqual(['m141', 'm200'])

      // At the top of what is drawn, the next loaded rows above join it, without asking the service.
      const calls = messageCalls()
      await scrollTo(0)
      expect(drawn()).toHaveLength(100)
      expect(drawn()[0]).toBe('m101')
      expect(messageCalls()).toBe(calls)

      // Go to latest goes to the end, where only the newest rows are drawn again; a new message keeps it so.
      await click(button('Go to latest'))
      await scrollTo(4500)
      expect(drawn()).toHaveLength(60)
      await act(async () => fake.emit.message('inbox', message(201)))
      await settle()
      expect(drawn()).toHaveLength(60)
      expect(drawn().at(-1)).toBe('m201')

      // A quote of a loaded message above the rows drawn draws it, then scrolls to it.
      await click(transcript().querySelector('[data-message-id="m200"] .bot-reply-quote'))
      await settle()
      expect(drawn()[0]).toBe('m10')
      expect(scrolled).toEqual(['m10'])
      expect(messageCalls()).toBe(calls)
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('lands on a message as find does: loaded and drawn when it is older than the rows drawn; a landing a newer one replaced does nothing', async () => {
    fake.chats.inbox = Array.from({ length: 200 }, (_, index) => message(index + 1))
    await open()
    expect(drawn()[0]).toBe('m151')
    const land = botMessageScroller('inbox')
    let current = 1
    const landing = (token: number) => ({ isCurrent: () => current === token, end: () => undefined })
    // Replaced before it was drawn: false, and the message is not drawn.
    const stale = land('m120', landing(1))
    current = 2
    expect(await stale).toBe(false)
    expect(drawn()).not.toContain('m120')
    // Not loaded yet: older pages load until it is held, then it is drawn with every row after it.
    let result: boolean | undefined
    void land('m3', landing(2)).then((value) => { result = value })
    for (let turn = 0; turn < 60 && result === undefined; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(result).toBe(true)
    expect(drawn()[0]).toBe('m3')
  })
})

describe('while it works', () => {
  const presence = () => host.querySelector('.chat-conversation-header .bot-presence')
  const sticker = () => host.querySelector('.bot-header-about .bot-sticker')

  it('types as a messenger does: dots in a bubble with "Working…" until it says more, "typing…" and a pen in the header, no spinner or chip; Stop and the mic stay', async () => {
    fake.chats.inbox = [message(1, { id: 'o1', author: 'owner', text: 'again' })]
    fake.live.inbox = { activationId: 'act1', chip: { icon: 'search', text: 'searching the web' } }
    await open({ ...inbox, state: 'working', stateText: 'Working…' })
    const typing = transcript().querySelector('.bot-typing')!
    expect(typing.getAttribute('aria-label')).toBe('Inbox helper: Working…')
    expect(typing.querySelector('.bot-typing-status')?.firstChild?.textContent).toBe('Working…')
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
      const words = () => transcript().querySelector('.bot-typing-status')!
      const running = () => started.filter((record) => !record.cancelled)
      const onDots = () => running().filter((record) => dots.includes(record.element))
      const shimmer = () => running().filter((record) => words().contains(record.element))
      expect(onDots().map((record) => [dots.indexOf(record.element), record.options.delay, record.options.iterations]))
        .toEqual([[0, 0, Infinity], [1, 150, Infinity], [2, 300, Infinity]])
      // "Working…" shimmers on the dots' cycle, its band reaching the words one dot step after the last dot peaks
      // (300 + 360 + 150 ms).
      expect(shimmer().map((record) => [record.options.duration, record.options.iterations, (record.options.delay as number) + 0.25 * 1200]))
        .toEqual([[1200, Infinity, 300 + 360 + 150], [1200, Infinity, 300 + 360 + 150]])
      act(() => setAnimationSpeed('off'))
      expect(running()).toEqual([])
      act(() => setAnimationSpeed('normal'))
      expect(onDots()).toHaveLength(3)
      expect(shimmer()).toHaveLength(2)
      // The bot's own line takes its place and shimmers the same way; nothing restarts as it comes.
      const before = running()
      await act(async () => fake.emit.activity('inbox', null, 'act1', 'Checking prices at Indian stores now'))
      expect(words().firstChild?.textContent).toBe('Checking prices at Indian stores now')
      expect(shimmer()).toHaveLength(2)
      expect(before.every((record) => !record.cancelled)).toBe(true)
      act(() => setAnimationSpeed('off'))
      expect(running()).toEqual([])
      expect(transcript().querySelector('.bot-typing-status')?.textContent).toBe('Checking prices at Indian stores now')
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
  it('is the thread composer with emoji, attach, dictation and send, and no model, context, permission, thread commands or skills', async () => {
    await open()
    const form = composer()
    expect(form.querySelectorAll('textarea')).toHaveLength(1)
    expect(box().placeholder).toBe('Message Inbox helper')
    expect([...form.querySelectorAll('input')].map((element) => element.type)).toEqual(['file'])
    expect([...form.querySelectorAll('button')].map((element) => element.getAttribute('aria-label'))).toEqual(['Emoji', 'Attach files', 'Dictate', 'Send message'])
    expect(form.querySelector('.composer-run-controls, .composer-model-btn, .composer-context-anchor, .composer-permission-chip')).toBeNull()
    expect(button('Send message')?.disabled).toBe(true)
    // A thread's `/` commands and `@` skills open no list; `/` opens the bot's own commands (below).
    for (const text of ['/skills', '/compact', '@']) {
      await type(box(), text)
      expect(host.querySelector('#composer-command-suggestions')).toBeNull()
    }
  })

  describe('/ commands', () => {
    const list = () => host.querySelector('#composer-command-suggestions')
    const rows = () => [...(list()?.querySelectorAll('[role="option"]') ?? [])].map((row) => row.textContent)
    const notes = () => [...transcript().querySelectorAll('.bot-system-line.is-note')].map((line) => line.textContent)
    const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')

    it('a slash opens the commands, each with what it does; typing narrows them, arrows move, Escape closes', async () => {
      await open()
      await type(box(), '/')
      expect(rows()).toContain('/clearWipe the chat')
      expect(rows()).toHaveLength(10)
      await type(box(), '/st')
      expect(rows()).toEqual(['/stopStop all running work', '/statusShow work, threads and schedules'])
      expect(list()!.querySelector('[aria-selected="true"]')?.textContent).toContain('/stop')
      await press('ArrowDown')
      expect(list()!.querySelector('[aria-selected="true"]')?.textContent).toContain('/status')
      // Tab fills the command in; it does not run it.
      await press('Tab')
      expect(box().value).toBe('/status')
      expect(fake.calls.some(([name]) => name === 'get')).toBe(false)
      await press('Escape')
      expect(list()).toBeNull()
    })

    it('runs /clear in Mousse: the bot is sent nothing, the chat empties and a line says so', async () => {
      fake.chats.inbox = [message(1, { author: 'owner', text: 'Hi' }), message(2, { text: 'Hello!' })]
      await open()
      await settle()
      await type(box(), '/cl')
      // Enter on a command not typed in full fills it in; a second Enter runs it.
      await press('Enter')
      expect(box().value).toBe('/clear')
      await press('Enter')
      await settle()
      expect(fake.client.send).not.toHaveBeenCalled()
      expect(fake.client.clearChat).toHaveBeenCalledWith('inbox')
      expect(transcript().querySelectorAll('.bot-you, .bot-message')).toHaveLength(0)
      expect(notes()).toEqual(['Chat cleared.'])
      expect(box().value).toBe('')
    })

    it('an unknown command shows a short error and is not sent; a path at the start of a message is sent as written', async () => {
      await open()
      await type(box(), '/xyz please')
      await press('Enter')
      await settle()
      expect(fake.client.send).not.toHaveBeenCalled()
      expect(transcript().querySelector('.bot-system-line.is-error')?.textContent).toBe("/xyz isn't a command. Type / to see them.")
      await type(box(), '/Users/me/notes.txt is broken')
      await press('Enter')
      await settle()
      expect(vi.mocked(fake.client.send).mock.calls.map((call) => call[1])).toEqual(['/Users/me/notes.txt is broken'])
    })

    it('/stop stops the chat turn, every piece of work and every background command', async () => {
      await open(summary('inbox', { name: 'Inbox helper', state: 'working', chat: { activationId: 'c1' }, work: [{ id: 'w1', title: 'Search', status: 'running', startedAt: AT }], watchers: [{ id: 'x1', title: 'Watch', command: 'tail', startedAt: AT, until: AT }] }))
      await type(box(), '/stop')
      await press('Enter')
      await settle()
      expect(fake.client.stop).toHaveBeenCalledWith('inbox')
      expect(vi.mocked(fake.client.stopWork).mock.calls.map((call) => call[1]).sort()).toEqual(['w1', 'x1'])
      expect(fake.client.send).not.toHaveBeenCalled()
      expect(notes()).toEqual(['Stopped 3 things.'])
    })

    it('/status shows the work and the schedules from the app, /pause and /resume switch the schedules', async () => {
      fake.details.inbox = { summary: inbox, permissions: [], runs: [{ id: 's1', label: 'every weekday · 09:00', kind: 'schedule' }] }
      await open()
      await type(box(), '/status')
      await press('Enter')
      await settle()
      expect(notes()).toEqual(['Work: none\nSchedules: every weekday · 09:00'])
      await type(box(), '/pause')
      await press('Enter')
      await settle()
      expect(fake.client.pause).toHaveBeenCalledWith('inbox')
      await type(box(), '/resume')
      await press('Enter')
      await settle()
      expect(fake.client.resume).toHaveBeenCalledWith('inbox')
      expect(notes().slice(1)).toEqual(['Paused: schedules and wake-ups are off.', 'Resumed.'])
      expect(fake.client.send).not.toHaveBeenCalled()
    })

    it.each([
      ['/forget', 'Wipe memory', ['inbox', undefined], 'Memory wiped: 0 entries.'],
      ['/forget history', 'Wipe history', ['inbox', 'saved'], 'Chat history and run notes wiped; memory kept.']
    ])('%s asks first: Cancel leaves everything, the confirm wipes', async (command, action, args, line) => {
      await open()
      await type(box(), command)
      await press('Enter')
      await settle()
      expect(dialog()).not.toBeNull()
      await click(button('Cancel', dialog()!))
      expect(dialog()).toBeNull()
      expect(fake.client.wipeMemory).not.toHaveBeenCalled()
      await type(box(), command)
      await press('Enter')
      await settle()
      await click(button(action, dialog()!))
      await settle()
      expect(fake.client.wipeMemory).toHaveBeenCalledWith(...args)
      expect(notes()).toEqual([line])
      expect(fake.client.send).not.toHaveBeenCalled()
    })

    it('/reset asks first, then starts the bot fresh', async () => {
      await open()
      await type(box(), '/reset')
      await press('Enter')
      await settle()
      await click(button('Reset', dialog()!))
      await settle()
      expect(fake.client.reset).toHaveBeenCalledWith('inbox')
      expect(notes()).toEqual(['Fresh start: chat, memory, schedules and reminders wiped.'])
    })

    it('/model offers the slots, then the models; a custom slot takes everything after the model as its description', async () => {
      const providers = [{ id: 'codex' as const, instanceId: 'openai-codex', label: 'Codex', models: [{ id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol' }] }]
      vi.mocked(fake.client.model).mockImplementation(async () => ({ model: null, models: [], computer: 'this_computer', computers: [], providers, slots: { talk: null, light: null, medium: null, hard: null }, custom: [] }))
      await open()
      await type(box(), '/model ')
      await settle()
      expect(rows().map((row) => row?.split(/[A-Z]/)[0])).toEqual(['talk', 'work', 'light', 'medium', 'hard', 'images'])
      await type(box(), '/model iosdev ')
      expect(rows()).toEqual(['openai-codex:gpt-6.1-solGPT 6.1 Sol · Codex'])
      await press('Enter')
      expect(box().value).toBe('/model iosdev openai-codex:gpt-6.1-sol ')
      await type(box(), `${box().value}iOS apps, Swift, Xcode`)
      await press('Enter')
      await settle()
      expect(fake.client.setCustomSlot).toHaveBeenCalledWith('inbox', 'iosdev', { instanceId: 'openai-codex', model: 'gpt-6.1-sol' }, 'iOS apps, Swift, Xcode')
      expect(notes()).toEqual(['iosdev now runs on GPT 6.1 Sol · Codex.'])
      expect(fake.client.send).not.toHaveBeenCalled()
    })
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
    expect(box().value).toMatch(/^Which gate\? \u2068\u2003\u00a0“gate\u00a012”\u2069 $/)
    // The pill goes like one character.
    box().setSelectionRange(box().value.length - 1, box().value.length - 1)
    await press('Backspace')
    expect(box().value).toBe('Which gate?  ')
    await select()
    await click(document.querySelector('.selection-reply-button'))
    await press('Enter')
    expect(vi.mocked(fake.client.send).mock.calls.at(-1)?.[1]).toBe('Which gate?\n\n"gate 12"')
    // The bubble shows the quote as a pill, not the quote marks and blank lines the bot got.
    await settle()
    const bubble = [...transcript().querySelectorAll('.bot-you-bubble')].at(-1)!
    expect(bubble.querySelector('.sent-quote-pill')?.textContent).toBe('Replying to: gate 12')
    expect(bubble.textContent).not.toContain('"gate 12"')
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

  it('sends a long text paste as a text file, which the composer names by its lines', async () => {
    await open()
    const log = Array.from({ length: 900 }, (_, i) => `line ${i} `.padEnd(60, '.')).join('\n')
    await fire(box(), 'paste', 'clipboardData', { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], files: [], getData: () => log })
    expect(box().value).toBe('')
    expect(composer().querySelector('.composer-attachments')?.textContent).toContain('Pasted text, 900 lines')
    await click(button('Send message'))
    await settle()
    const send = fake.calls.find(([name]) => name === 'send')!
    expect(send[4]).toEqual([{ name: expect.stringMatching(/^pasted-text-\d+\.txt$/), path: expect.stringMatching(/pasted-text-\d+\.txt$/) }])
    const [file] = vi.mocked(fake.events.attachmentPath!).mock.calls.at(-1)!
    expect(await file.text()).toBe(log)
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

  it('offers Resume on the newest usage-limit line only while paused; once the bot runs again every such line settles', async () => {
    const limit = (seq: number, id: string, text: string) => message(seq, { id, kind: 'error', text: '', error: { text, action: { kind: 'resume', label: 'Resume' } } })
    fake.chats.inbox = [limit(1, 'l1', 'Paused until 03:27 (your Claude usage limit)'), message(2, { id: 'o2', author: 'owner', text: 'hi' }), limit(3, 'l3', 'Paused until 03:28 (your Claude usage limit)')]
    await open({ ...inbox, state: 'paused', stateText: 'Paused until 03:28' })
    const line = (id: string) => transcript().querySelector(`[data-message-id="${id}"] .bot-error`)!
    expect(button('Resume', line('l1'))).toBeUndefined()
    expect(line('l1').classList.contains('is-settled')).toBe(true)
    expect(line('l3').classList.contains('is-settled')).toBe(false)
    await click(button('Resume', line('l3')))
    expect(fake.calls).toContainEqual(['resume', 'inbox'])
    // The bot is no longer paused: no line offers a Resume that would do nothing.
    await settle()
    expect(transcript().querySelectorAll('.bot-error button')).toHaveLength(0)
    expect(line('l3').classList.contains('is-settled')).toBe(true)
    expect(line('l3').textContent).toBe('Paused until 03:28 (your Claude usage limit)')
  })
})

describe('the menu', () => {
  it('offers About, Find in chat, Rename, Change look, Pause and Delete bot', async () => {
    await open()
    await click(button('Bot menu'))
    expect([...host.querySelectorAll('[role="menuitem"]')].map((element) => element.textContent)).toEqual(['About this bot', 'Find in chat', 'Rename', 'Change look', 'Pause', 'Delete bot'])
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

  it('lists its background commands under Background work, each with how long it has run, its last line and Stop; alone, the header says what it waits on', async () => {
    const watcher = { id: 'rem_w1', title: 'Nightly build', command: 'gh run watch 123', startedAt: new Date(Date.now() - 12 * 60_000).toISOString(), until: new Date(Date.now() + 48 * 60_000).toISOString(), lastLine: 'Waiting for build' }
    await open({ ...working, state: 'idle', stateText: '', work: undefined, watchers: [watcher] })
    expect(presence().textContent).toBe('Waiting on Nightly build')
    await click(presence())
    const list = host.querySelector('[aria-label="Background work"]')!
    expect([...list.querySelectorAll('.bot-work-line')].map((line) => line.textContent)).toEqual(['Nightly build12m'])
    expect(list.querySelector('.bot-work-line')!.getAttribute('title')).toBe('gh run watch 123\nWaiting for build')
    await click(button('Stop Nightly build'))
    expect(fake.calls).toContainEqual(['stopWork', 'inbox', 'rem_w1'])
  })

  it('work held for the owner’s answer to its question says it waits on them; other held work says held', async () => {
    const asked = { id: 'act_w3', title: 'Flat hunt', status: 'paused' as const, waitsFor: 'answer' as const, startedAt: new Date(Date.now() - 4 * 60_000).toISOString() }
    const held = { id: 'act_w4', title: 'Vacuums', status: 'paused' as const, startedAt: new Date(Date.now() - 4 * 60_000).toISOString() }
    await open({ ...working, state: 'needs_you', stateText: 'Asked: Which flat?', work: [asked, held] })
    await click(presence())
    expect([...host.querySelectorAll('.bot-work-line')].map((line) => line.textContent)).toEqual(['Flat huntwaiting on you · 4 min', 'Vacuumsheld · 4 min'])
    await click(button('Stop Flat hunt'))
    expect(fake.calls).toContainEqual(['stopWork', 'inbox', 'act_w3'])
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

  it("work with subagents running says how many in its row's details, each one's title, model and entry on hover, and keeps its Stop", async () => {
    const subagents = [{ title: 'Prices', model: 'Some Model on OpenRouter' }, { title: 'Reviews', model: 'Haiku 5.5 on Claude Code, low reasoning', lacks: ['run commands'] }]
    await open({ ...working, work: [{ ...working.work![0]!, subagents }] })
    await click(presence())
    const line = host.querySelector('.bot-work-line')!
    expect(line.textContent).toBe('Vacuum comparisonworking · 2 subagents · 4 min')
    expect(line.querySelector('.bot-work-subagents')!.getAttribute('title')).toBe("Prices · Some Model on OpenRouter\nReviews · Haiku 5.5 on Claude Code, low reasoning · can't run commands there")
    await click(button('Stop Vacuum comparison'))
    expect(fake.calls).toContainEqual(['stopWork', 'inbox', 'act_w1'])
  })

  it("says beside the chat turn's dots what the bot is doing now, in full, and only the chat turn's words", async () => {
    // A chat opened mid-turn shows what the bot already said.
    fake.live.inbox = { activationId: 'act_c1', status: 'Looking at your files' }
    await open({ ...working, chat: { activationId: 'act_c1' } })
    const typing = () => transcript().querySelector('.bot-typing')!
    // The words as shown and read: the shimmer's bright copy of them is hidden from assistive technology.
    const words = () => {
      const status = typing().querySelector('.bot-typing-status')
      if (!status) return null
      const read = status.cloneNode(true) as Element
      read.querySelectorAll('[aria-hidden]').forEach((copy) => copy.remove())
      return read
    }
    expect(words()?.textContent).toBe('Looking at your files')
    // Its work's words are not the chat's.
    await act(async () => fake.emit.activity('inbox', null, 'act_w1', 'Comparing vacuum prices'))
    expect(words()?.textContent).toBe('Looking at your files')
    await act(async () => fake.emit.activity('inbox', null, 'act_c1', 'Checking your shopping list now'))
    expect(words()?.textContent).toBe('Checking your shopping list now')
    expect(typing().querySelectorAll('.bot-typing-bubble i')).toHaveLength(3)
    expect(typing().getAttribute('aria-label')).toBe('Inbox helper: Checking your shopping list now')
    // A newer line replaces it, and a long one shows whole.
    const long = 'Reading the three store pages you sent and checking which of them still have the 2 TB drive in stock, with delivery to Pune before Friday'
    await act(async () => fake.emit.activity('inbox', { icon: 'web', text: 'reading a page' }, 'act_c1', long))
    expect(words()?.textContent).toBe(long)
    // An event without one: "Working…" again, never the dots alone.
    await act(async () => fake.emit.activity('inbox', null, 'act_c1'))
    expect(words()?.textContent).toBe('Working…')
    expect(typing().getAttribute('aria-label')).toBe('Inbox helper: Working…')
  })

  it("the chat's own turn types and has Stop; the header still opens the work", async () => {
    await open({ ...working, chat: { activationId: 'act_c1' } })
    expect(transcript().querySelector('.bot-typing')).not.toBeNull()
    expect(presence().textContent).toBe('typing…')
    expect(button('Stop run')).toBeDefined()
    await click(presence())
    expect(host.querySelectorAll('.bot-work-line')).toHaveLength(2)
  })

  describe('threads it started', () => {
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const thread = (threadId: string, title: string, status: BotLaunchedThread['status'], minutes: number): BotLaunchedThread => ({ threadId, title, project: 'Mousse', status, startedAt: ago(minutes), updatedAt: ago(minutes) })
    // Out of order on purpose: the list still puts working first, then waiting on you, then idle, then ended.
    const threads = [thread('t3', 'Old run', 'done', 90), thread('t2', 'Typing dots', 'needs_input', 3), thread('t1', 'Dictation', 'running', 1), thread('t4', 'Broken', 'failed', 30), thread('t5', 'Halted', 'stopped', 40), thread('t6', 'Never ran', 'idle', 5)]
    const rows = () => [...host.querySelectorAll('.bot-thread-line')].map((row) => [row.querySelector('.bot-thread-title')!.textContent, row.querySelector('.bot-thread-state')!.textContent, row.getAttribute('data-tone')])
    const keydown = async (key: string) => { await act(async () => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }); await act(async () => {}) }

    it('lists working threads first, then those waiting on you, each with its state, project and last update; the rest fold under Done', async () => {
      await open({ ...inbox, state: 'working', stateText: 'Managing 2 threads', threads })
      expect(presence().textContent).toBe('Managing 2 threads')
      await click(presence())
      expect(rows()).toEqual([['Dictation', 'working', 'working'], ['Typing dots', 'waiting on you', 'waiting']])
      expect(host.querySelector('.bot-thread-meta')!.textContent).toBe('Mousse · updated 1m ago')
      const fold = host.querySelector<HTMLButtonElement>('.bot-thread-fold')!
      expect([fold.textContent, fold.getAttribute('aria-expanded')]).toEqual(['Done4', 'false'])
      await click(fold)
      expect(rows().slice(2)).toEqual([['Never ran', 'idle', 'idle'], ['Broken', 'failed', 'failed'], ['Halted', 'stopped', 'failed'], ['Old run', 'done', 'done']])
    })

    it('opens a thread from its row, moves along the list with the arrow keys, and closes on Escape or a click away', async () => {
      opened.ids.length = 0
      await open({ ...inbox, state: 'working', stateText: 'Managing 2 threads', threads })
      // From the keyboard: the list opens on the first row.
      await act(async () => presence().focus())
      await keydown('ArrowDown')
      expect(document.activeElement?.textContent).toContain('Dictation')
      await keydown('ArrowDown')
      expect(document.activeElement?.textContent).toContain('Typing dots')
      await keydown('ArrowUp')
      expect(document.activeElement?.textContent).toContain('Dictation')
      await keydown('Escape')
      expect(host.querySelector('.bot-work')).toBeNull()
      expect(document.activeElement).toBe(presence())
      await click(presence())
      await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
      expect(host.querySelector('.bot-work')).toBeNull()
      await click(presence())
      await click(host.querySelector('.bot-thread-line[data-tone="waiting"]'))
      expect(opened.ids).toEqual(['t2'])
      expect(host.querySelector('.bot-work')).toBeNull()
    })

    it('a thread it keeps out of the sidebar says Hidden, still opens from its row, and Show in sidebar brings it back', async () => {
      opened.ids.length = 0
      const request = vi.fn(async () => ({ thread: { id: 't7', name: 'Quick check', createdAt: ago(2), updatedAt: ago(2) } }))
      ;(window as unknown as { mousse: { platformRequest: unknown } }).mousse.platformRequest = { request }
      await open({ ...inbox, state: 'working', stateText: 'Managing Quick check', threads: [{ ...thread('t7', 'Quick check', 'running', 2), hidden: true }, thread('t1', 'Dictation', 'running', 1)] })
      await click(presence())
      const metas = [...host.querySelectorAll('.bot-thread-meta')].map((meta) => meta.textContent)
      expect(metas).toEqual(['Hidden · Mousse · updated 2m ago', 'Mousse · updated 1m ago'])
      // Only the hidden one has Show in sidebar, named for the thread.
      expect(host.querySelectorAll('.bot-thread-show')).toHaveLength(1)
      await click(button('Show Quick check in sidebar'))
      expect(request).toHaveBeenCalledWith('threads.setHidden', { threadId: 't7', hidden: false })
      // The row itself opens the thread, as any row does.
      await click(host.querySelector('.bot-thread-line[data-hidden]'))
      expect(opened.ids).toEqual(['t7'])
    })

    it('a free bot whose threads all ended still opens their list, Done unfolded', async () => {
      await open({ ...inbox, threads: threads.filter((item) => item.status === 'done' || item.status === 'failed') })
      expect(presence().textContent).toBe('free')
      await click(presence())
      expect(rows().map(([title]) => title)).toEqual(['Broken', 'Old run'])
    })

    it('a thread it starts while the bot list is being read shows in the open chat without leaving it', async () => {
      const ended = threads.filter((item) => item.status === 'done')
      await open({ ...inbox, threads: ended })
      // A change (the bot's turn going on) asks for the list; the service reads it before the bot starts the thread.
      let release!: () => void
      vi.mocked(fake.client.list).mockImplementationOnce(() => {
        const before = fake.bots.map((bot) => ({ ...bot }))
        return new Promise((resolve) => { release = () => resolve(before) })
      })
      await act(async () => fake.emit.changed('inbox'))
      // The bot starts a thread, and the service says so while that list is still on its way.
      fake.bots = [{ ...fake.bots[0]!, state: 'working', stateText: 'Managing Fix login', threads: [thread('t9', 'Fix login', 'running', 0), ...ended] }]
      await act(async () => fake.emit.changed('inbox'))
      await act(async () => release())
      await settle()
      expect(presence().textContent).toBe('Managing Fix login')
      await click(presence())
      expect(rows()[0]).toEqual(['Fix login', 'working', 'working'])
    })
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

  it('offers Go to latest while scrolled up, and goes to the end when the owner sends from scrolled up', async () => {
    fake.chats.inbox = Array.from({ length: 20 }, (_, index) => message(index + 1))
    await open()
    const log = transcript()
    let height = 2000
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 500 })
    // At the end there is nothing to go to; scrolled up, Go to latest takes the reader back.
    log.scrollTop = 1500
    await act(async () => { log.dispatchEvent(new Event('scroll')) })
    expect(button('Go to latest')).toBeUndefined()
    log.scrollTop = 300
    await act(async () => { log.dispatchEvent(new Event('scroll')) })
    await click(button('Go to latest'))
    expect(log.scrollTop).toBe(2000)
    expect(button('Go to latest')).toBeUndefined()
    await act(async () => { log.dispatchEvent(new Event('scroll')) })

    // Scrolled up, the owner's own message goes to the end at once, while it is on its way.
    log.scrollTop = 300
    await act(async () => { log.dispatchEvent(new Event('scroll')) })
    expect(button('Go to latest')).toBeDefined()
    vi.mocked(fake.client.send).mockImplementationOnce(() => new Promise(() => {}))
    await type(box(), 'And the other one?')
    height = 2100
    await press('Enter')
    expect(transcript().querySelector('.bot-you.is-pending')).not.toBeNull()
    expect(log.scrollTop).toBe(2100)
    expect(button('Go to latest')).toBeUndefined()
  })
})

describe('loading and labels', () => {
  const loadState = () => host.querySelector('.bot-load-state')

  /** Bot faces beside the chat pane, as in the window; the first page of messages answers when `release` is called. */
  async function withSlowFirstPage(): Promise<() => void> {
    fake.chats.inbox = [message(1, { text: 'Hello.' })]
    let release!: () => void
    const original = fake.client.messages
    vi.mocked(fake.client.messages).mockImplementationOnce((...args) => new Promise((resolve) => { release = () => resolve(original(...args)) }))
    fake.bots = [inbox]
    await act(async () => useChatsStore.getState().activate('p1'))
    await act(async () => root.render(createElement('div', null, createElement(ChatsSidebar), createElement(ChatWorkspace))))
    await act(async () => { await useBotsStore.getState().refresh() })
    return () => release()
  }

  it('opens a bot with its messages: the click marks its face, and the pane changes once they are here', async () => {
    const release = await withSlowFirstPage()
    await click(button('Message Inbox helper'))
    expect(button('Message Inbox helper')!.className).toContain('bot-roster-active')
    // Nothing of the bot shows without its messages: no empty chat, no Loading line.
    expect(host.querySelector('.chat-transcript')).toBeNull()
    expect(loadState()).toBeNull()
    await act(async () => { release() })
    await settle()
    expect(loadState()).toBeNull()
    expect(transcript().querySelectorAll('article')).toHaveLength(1)
  })

  it('says Loading messages… when a bot’s messages take longer than the hold, then shows them', async () => {
    const release = await withSlowFirstPage()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let opening!: Promise<void>
      await act(async () => { opening = useChatsStore.getState().openBot('inbox') })
      expect(host.querySelector('.chat-transcript')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(OPEN_BOT_HOLD_MS) })
      expect(loadState()?.textContent).toBe('Loading messages…')
      expect(transcript().querySelectorAll('article')).toHaveLength(0)
      await act(async () => { release(); await opening })
    } finally {
      vi.useRealTimers()
    }
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

describe('memory', () => {
  const entry = (id: string, kind: 'owner' | 'note' | 'run_note', text: string, learnedAt = AT) => ({ id, version: 1, ref: id, kind, text, since: learnedAt, learnedAt, by: 'you said' as const, status: 'active' as const })
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
  const group = (label: string) => [...dialog()!.querySelectorAll<HTMLElement>('section')].find((element) => element.getAttribute('aria-label') === label)
  const texts = (scope: ParentNode | null | undefined) => [...(scope?.querySelectorAll('.bot-memory-text') ?? [])].map((element) => element.textContent)
  const entryOf = (text: string) => [...dialog()!.querySelectorAll<HTMLElement>('li')].find((element) => element.querySelector('.bot-memory-text')?.textContent === text)!
  beforeEach(() => {
    fake.memory.inbox = [
      entry('m1', 'owner', 'No em dashes in my messages.', '2026-11-01T09:00:00.000Z'),
      entry('m2', 'note', 'The owner reads mail at 8.', '2026-11-03T09:00:00.000Z'),
      entry('m3', 'owner', 'Call me Sam.', '2026-11-05T09:00:00.000Z'),
      entry('m4', 'run_note', 'The Lisbon host replied twice.', '2026-11-06T09:00:00.000Z')
    ]
  })

  it("About's one row opens Memory: the owner's wishes, then the bot's notes, newest first, each with its date", async () => {
    await open()
    await click(button('About Inbox helper'))
    const row = host.querySelector<HTMLButtonElement>('[data-testid="bot-about-memory"]')!
    expect(row.textContent).toBe('Memory · 42 wishes · 2 notes')
    await click(row)
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Memory')
    expect(texts(group('Your wishes'))).toEqual(['Call me Sam.', 'No em dashes in my messages.'])
    expect(texts(group("Inbox helper's notes"))).toEqual(['The Lisbon host replied twice.', 'The owner reads mail at 8.'])
    expect(entryOf('Call me Sam.').querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-05T09:00:00.000Z')
  })

  it('/memory in the composer opens Memory and sends nothing', async () => {
    await open()
    await type(box(), '/memory')
    await press('Enter')
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Memory')
    expect(fake.calls.some(([name]) => name === 'send')).toBe(false)
    expect(box().value).toBe('')
  })

  it('search narrows both groups', async () => {
    await open()
    await act(async () => useBotsStore.getState().openMemory('inbox'))
    await settle()
    await type(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Search memory"]')!, 'the')
    expect(texts(group('Your wishes'))).toEqual([])
    expect(texts(group("Inbox helper's notes"))).toEqual(['The Lisbon host replied twice.', 'The owner reads mail at 8.'])
    await type(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Search memory"]')!, 'zebra')
    expect(dialog()!.textContent).toContain('Nothing matches.')
  })

  it('Forget asks first, then forgets the entry', async () => {
    await open()
    await act(async () => useBotsStore.getState().openMemory('inbox'))
    await settle()
    await click(button('Forget', entryOf('Call me Sam.')))
    expect(fake.calls.some(([name]) => name === 'forgetMemory')).toBe(false)
    const confirm = entryOf('Call me Sam.').querySelector('[role="group"][aria-label="Forget this?"]')!
    await click(button('Cancel', confirm))
    expect(fake.calls.some(([name]) => name === 'forgetMemory')).toBe(false)
    await click(button('Forget', entryOf('Call me Sam.')))
    await click(button('Forget', entryOf('Call me Sam.').querySelector('[role="group"]')!))
    await settle()
    expect(fake.calls).toContainEqual(['forgetMemory', 'inbox', 'm3'])
    expect(texts(group('Your wishes'))).toEqual(['No em dashes in my messages.'])
  })

  it('Edit saves the new words as the version shown', async () => {
    await open()
    await act(async () => useBotsStore.getState().openMemory('inbox'))
    await settle()
    await click(button('Edit', entryOf('Call me Sam.')))
    const field = dialog()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Memory text"]')!
    await type(field, 'Call me Sam, never Samuel.')
    await click(button('Save', field.closest('li')!))
    await settle()
    expect(fake.calls).toContainEqual(['editMemory', 'inbox', 'm3', 'Call me Sam, never Samuel.'])
    expect(texts(group('Your wishes'))).toEqual(['Call me Sam, never Samuel.', 'No em dashes in my messages.'])
  })

  it('"Ask Inbox helper about this" quotes the entry in the composer, sends nothing, and closes Memory', async () => {
    await open()
    await type(box(), 'Why?')
    await act(async () => useBotsStore.getState().openMemory('inbox'))
    await settle()
    await click(button('Ask Inbox helper about this', entryOf('The owner reads mail at 8.')))
    expect(dialog()).toBeNull()
    expect(box().value).toMatch(/^Why\? \u2068\u2003\u00a0“The\u00a0owner\u00a0reads\u00a0mail\u00a0at\u00a08\.”\u2069 $/)
    expect(fake.calls.some(([name]) => name === 'send')).toBe(false)
    await press('Enter')
    expect(vi.mocked(fake.client.send).mock.calls.at(-1)?.[1]).toBe('Why?\n\n"The owner reads mail at 8."')
  })

  it('a reply whose turn saved a memory has a "Saved to memory" tag that opens Memory at that entry', async () => {
    fake.chats.inbox = [
      message(1, { id: 'b1', text: 'Noted.', chips: [{ icon: 'memory', text: 'remembered', highlight: 'The owner reads mail at 8.' }] }),
      message(2, { id: 'b2', text: 'Hello.' })
    ]
    await open()
    const tags = [...transcript().querySelectorAll('button')].filter((element) => element.textContent === 'Saved to memory')
    expect(tags).toHaveLength(1)
    expect(tags[0]!.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('b1')
    await click(tags[0])
    await settle()
    expect(dialog()?.querySelector('.is-focused .bot-memory-text')?.textContent).toBe('The owner reads mail at 8.')
  })
})

it.each(['unfocused', 'hidden'] as const)('keeps a mounted %s chat unread until visible and focused', async state => {
  const markRead = vi.mocked(fake.client.markRead).getMockImplementation()!
  vi.mocked(fake.client.markRead).mockImplementation((id, seq) => {
    fake.bots = fake.bots.map(bot => bot.id === id ? { ...bot, unread: 0 } : bot)
    return markRead(id, seq)
  })
  let focused = state !== 'unfocused'
  let visible = state !== 'hidden'
  vi.mocked(document.hasFocus).mockImplementation(() => focused)
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  fake.chats.inbox = [message(1)]
  await open({ ...inbox, unread: 1 })
  await act(async () => fake.emit.message('inbox', message(2)))
  expect(fake.calls.filter(call => call[0] === 'markRead')).toEqual([])
  expect(useBotsStore.getState().bots[0]?.unread).toBeGreaterThan(0)
  focused = true; visible = true
  await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  expect(fake.calls).toContainEqual(['markRead', 'inbox', 2])
  expect(useBotsStore.getState().bots[0]?.unread).toBe(0)
})

it('a reminder offers snooze replies and a tap leaves a quiet confirmation', async () => {
  fake.chats.inbox = [message(1, { text: 'Tea', reminder: {} })]
  fake.client.snoozeReminder = vi.fn(async () => ({ ...fake.chats.inbox![0]!, reminder: { snoozedUntil: '2026-11-07T09:10:00.000Z' } }))
  await open()
  expect(button('In 10 min')).toBeDefined()
  expect(button('In 1 hour')).toBeDefined()
  expect([...host.querySelectorAll('button')].some(b => b.textContent?.startsWith('Tomorrow '))).toBe(true)
  await click(button('In 10 min'))
  expect(fake.client.snoozeReminder).toHaveBeenCalledWith('inbox', 'm1', '10m')
  expect(button('In 10 min')).toBeUndefined()
  expect(host.textContent).toContain('Snoozed until')
})

it('a service without snooze support offers no snooze replies', async () => {
  fake.chats.inbox = [message(1, { text: 'Tea' })]
  await open()
  expect(button('In 10 min')).toBeUndefined()
})

it('removes snooze replies in an open chat when their day expires', async () => {
  vi.useFakeTimers()
  fake.chats.inbox = [message(1, { text: 'Tea', reminder: { expiresAt: new Date(Date.now() + 60_000).toISOString() } })]
  await open()
  expect(button('In 10 min')).toBeDefined()
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001) })
    expect(button('In 10 min')).toBeUndefined()
  } finally { vi.useRealTimers() }
})


it.each([
  ['en-US', '4:05 AM', '9:00 AM'],
  ['en-GB', '4:05', '9:00']
])('snooze replies use the bubble clock format in %s', async (locale, dueTime, morning) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 16, 3, 55))
  const nativeTime = Date.prototype.toLocaleTimeString
  const format = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (locales, options) {
    return nativeTime.call(this, locale, options)
  })
  try {
    const due = new Date(2026, 10, 16, 4, 5).toISOString()
    fake.chats.inbox = [message(1, { at: due, text: 'Tea', reminder: {} })]
    fake.client.snoozeReminder = vi.fn(async () => ({ ...fake.chats.inbox![0]!, reminder: { snoozedUntil: due } }))
    await open()
    expect(button(`Tomorrow ${morning}`)).toBeDefined()
    expect(host.querySelector('.bot-bubble-time')?.textContent).toBe(dueTime)
    await click(button('In 10 min'))
    expect(host.querySelector('.bot-question-settled')?.textContent).toBe(`Snoozed until ${dueTime}`)
  } finally { format.mockRestore(); vi.useRealTimers() }
})

it('a snooze on another day shows the chat date and time', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 16, 23, 55))
  try {
    const due = new Date(2026, 10, 17, 9).toISOString()
    const { botDayLabel, botGroupTime } = await import('../../src/renderer/components/bots/messageGroups')
    fake.chats.inbox = [message(1, { at: due, text: 'Tea', reminder: { snoozedUntil: due } })]
    await open()
    expect(host.querySelector('.bot-question-settled')?.textContent).toBe(`Snoozed until ${botDayLabel(due)} ${botGroupTime(due)}`)
  } finally { vi.useRealTimers() }
})
