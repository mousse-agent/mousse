import { clearPrivateBotDrafts } from '../../src/renderer/components/bots/privateBotDrafts'
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
import { MOUSSE_REFERENCE_MIME } from '../../src/shared/chatReferences'

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
  return {
    ...actual,
    selectThread: (threadId: string, ...rest: unknown[]) => { opened.ids.push(threadId); return (actual.selectThread as (...args: unknown[]) => Promise<unknown>)(threadId, ...rest) },
    // A thread opened in the bot's chat pane (lib/botThread.ts).
    openAndSelect: (threadId: string, ...rest: unknown[]) => { opened.ids.push(threadId); return (actual.openAndSelect as (...args: unknown[]) => Promise<unknown>)(threadId, ...rest) }
  }
})

const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { useChatsStore, OPEN_BOT_HOLD_MS } = await import('../../src/renderer/stores/chatsStore')
const { ChatsSidebar } = await import('../../src/renderer/components/chats/ChatsSidebar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useThreadFilterStore } = await import('../../src/renderer/stores/threadFilterStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { botMessageScroller, DOING_HOLD_MS, BOT_HANDOFF_MS } = await import('../../src/renderer/components/bots/BotChatView')
const { SETTLE_MS, clearBotLiveReplies } = await import('../../src/renderer/stores/botLiveReplies')
const { FLOW_CATCH_UP_MS } = await import('../../src/renderer/chat/components/agent-elements/reply-flow')

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
  vi.unstubAllGlobals()
  setBotsClient(null)
  clearBotLiveReplies()
  clearPrivateBotDrafts()
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

  it('the side panel docks outside the chat pane and opens on the picker: each pick is a tab, + opens the picker again', async () => {
    const folder = 'C:\\Users\\me\\.mousse\\profiles\\d9d018ad-5de0\\bots\\files\\inbox'
    fake.chats.inbox = [message(1, { id: 'b1', text: `Saved \`${folder}\\plan.md\`.` })]
    const listDir = vi.fn(async () => [{ name: 'plan.md', path: 'plan.md', kind: 'file' as const }])
    const readFile = vi.fn(async () => '# Plan')
    installPreload(fake, { app: { setViewedBot }, fs: { listDir, readFile, readAsset: vi.fn(async () => { throw new Error('none') }) }, localFiles: { open: vi.fn(async () => 'file' as const) } })
    await open()
    const panel = () => host.querySelector<HTMLElement>('aside.bot-side')
    const tabs = () => [...panel()!.querySelectorAll<HTMLButtonElement>('.main-view-tab-select')].map((element) => element.textContent)
    const tab = (label: string) => [...panel()!.querySelectorAll<HTMLButtonElement>('.main-view-tab-select')].find((element) => element.textContent === label)
    const pick = (label: string) => [...panel()!.querySelectorAll<HTMLButtonElement>('.surface-picker .surface-menu-row')].find((element) => element.textContent === label)
    expect(panel()).toBeNull()
    await click(button('Show side panel'))
    await settle()
    // Not inside the chat pane; nothing open in it yet, only the picker, with no tab.
    expect(host.querySelector('.bot-chat-pane')!.contains(panel())).toBe(false)
    expect(panel()!.getAttribute('data-view')).toBe('picker')
    expect([...panel()!.querySelectorAll('.surface-picker .surface-menu-row')].map((row) => row.textContent)).toEqual(['Browser', 'Files', 'Agent settings'])
    expect(tabs()).toEqual([])
    expect(useBotsStore.getState().aboutOpen).toBe(false)
    await click(pick('Files'))
    await settle()
    expect(panel()!.getAttribute('data-view')).toBe('files')
    expect(tabs()).toEqual(['Files'])
    // Its files folder, read from the paths its chat named; a file there opens in the view.
    expect(listDir).toHaveBeenCalledWith('', undefined, null, folder)
    await click([...panel()!.querySelectorAll<HTMLElement>('.file-tree-row')].find((row) => row.textContent?.includes('plan.md')))
    await settle()
    expect(readFile).toHaveBeenCalledWith('plan.md', undefined, null, folder)
    expect(panel()!.querySelector('.bot-file-name')?.textContent).toBe('plan.md')
    // + opens the picker as a new tab; Agent settings is the About content.
    await click(button('New tab', panel()!))
    expect(panel()!.getAttribute('data-view')).toBe('picker')
    expect(tabs()).toEqual(['Files', 'New tab'])
    await click(pick('Agent settings'))
    expect(tabs()).toEqual(['Files', 'Agent settings'])
    expect(panel()!.querySelector('aside.bot-about')?.getAttribute('aria-label')).toBe('About Inbox helper')
    expect(useBotsStore.getState().aboutOpen).toBe(true)
    await click(button('New tab', panel()!))
    await click(pick('Browser'))
    expect(tabs()).toEqual(['Files', 'Agent settings', 'Browser'])
    expect(panel()!.querySelector('.bot-about')).toBeNull()
    expect(useBotsStore.getState().aboutOpen).toBe(false)
    expect(panel()!.textContent).toContain('Inbox helper hasn’t used its browser yet.')
    // A view already open is brought to the front, not opened twice.
    await click(button('New tab', panel()!))
    await click(pick('Files'))
    expect(tabs()).toEqual(['Files', 'Agent settings', 'Browser', 'New tab'])
    expect(panel()!.getAttribute('data-view')).toBe('files')
    await click(tab('Agent settings'))
    await click(button('Close Agent settings', panel()!))
    expect(tabs()).toEqual(['Files', 'Browser', 'New tab'])
    expect(useBotsStore.getState().aboutOpen).toBe(false)
    await click(button('Close side panel'))
    expect(button('Show side panel')?.getAttribute('aria-expanded')).toBe('false')
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
      localFiles = { showInFolder: vi.fn(async () => undefined), saveCopy: vi.fn(async () => '/home/me/Downloads/a.png') }
      writeImage = vi.fn(async () => undefined)
      let made = 0
      URL.createObjectURL = vi.fn(() => `blob:picture-${++made}`)
      installPreload(fake, { app: { setViewedBot }, fs: { readAsset: vi.fn(async () => ({ mimeType: 'image/png', data: [137, 80, 78, 71] })) }, localFiles, clipboard: { writeImage } })
    }
    let writeImage: ReturnType<typeof vi.fn>
    /**
     * jsdom draws nothing: a picture "loads" at 3 by 2 unless its address is `blob:broken`, and the canvas encodes
     * PNG bytes that name the picture drawn on it, so a test can tell which picture reached the clipboard.
     */
    const drawing = () => {
      const PNG = [137, 80, 78, 71, 13, 10, 26, 10]
      class LoadingImage {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        naturalWidth = 3
        naturalHeight = 2
        width = 3
        height = 2
        private address = ''
        get src() { return this.address }
        set src(value: string) { this.address = value; queueMicrotask(() => (value === 'blob:broken' ? this.onerror?.() : this.onload?.())) }
      }
      vi.stubGlobal('Image', LoadingImage)
      let drawn = ''
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: (image: LoadingImage) => { drawn = image.src } }) as never)
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => done(new Blob([new Uint8Array([...PNG, ...new TextEncoder().encode(drawn)])], { type: 'image/png' })))
      return (bytes: Uint8Array) => ({ png: [...bytes.slice(0, 8)].join() === PNG.join(), picture: new TextDecoder().decode(bytes.slice(8)) })
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
      const copied = drawing()
      fake.chats.inbox = [message(1, { id: 'b1', text: `![a](${picture('a.png')}) ![b](${picture('b.png')})` })]
      await open()
      await settle()
      const second = button('Open picture: b', article('b1'))!
      const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('.bot-picture-menu [role="menuitem"]')]
      for (const label of ['Save as…', 'Show in folder', 'Copy image']) {
        await contextMenu(second)
        expect(menuItems().map((item) => item.textContent)).toEqual(['Open', 'Save as…', 'Show in folder', 'Copy image'])
        // The tools beside the bubble (reactions, Read aloud, Copy, Reply) step aside while the menu is open.
        expect(article('b1').classList.contains('is-menu-open')).toBe(true)
        await click(menuItems().find((item) => item.textContent === label))
        await settle()
        expect(document.querySelector('.bot-picture-menu')).toBeNull()
        expect(article('b1').classList.contains('is-menu-open')).toBe(false)
      }
      expect(localFiles.saveCopy).toHaveBeenCalledWith(picture('b.png'))
      expect(localFiles.showInFolder).toHaveBeenCalledWith(picture('b.png'))
      // Copy image puts the picture itself on the clipboard, as PNG bytes: the second picture, not its path.
      expect(writeImage).toHaveBeenCalledTimes(1)
      const shown = second.querySelector('img')!.getAttribute('src')!
      expect(copied(writeImage.mock.calls[0][0] as Uint8Array)).toEqual({ png: true, picture: shown })
      expect(composerError()).toBeNull()
      await contextMenu(second)
      await click(menuItems()[0])
      expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('b')
      await click(button('Close fullscreen (Esc)', document.querySelector('[role="dialog"]')!))
      // Escape closes the menu with nothing done.
      await contextMenu(second)
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      expect(document.querySelector('.bot-picture-menu')).toBeNull()
    })

    // A picture with no file (a `data:` image, a GIF or WebP drawn by the window) is copied as the window shows it.
    it('a picture with no file offers Open and Copy image, and Copy image puts that picture on the clipboard', async () => {
      install()
      const copied = drawing()
      const gif = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
      fake.chats.inbox = [message(1, { id: 'b1', text: `![dance](${gif})` })]
      await open()
      await settle()
      await contextMenu(button('Open picture: dance', article('b1'))!)
      const items = [...document.querySelectorAll<HTMLButtonElement>('.bot-picture-menu [role="menuitem"]')]
      expect(items.map((item) => item.textContent)).toEqual(['Open', 'Copy image'])
      await click(items[1])
      await settle()
      expect(copied(writeImage.mock.calls[0][0] as Uint8Array)).toEqual({ png: true, picture: gif })
      expect(localFiles.saveCopy).not.toHaveBeenCalled()
    })

    it("a picture that can't be drawn is said above the composer, and the clipboard is left alone", async () => {
      install()
      drawing()
      fake.chats.inbox = [message(1, { id: 'b1', text: `![x](${picture('unreadable.png')})` })]
      URL.createObjectURL = vi.fn(() => 'blob:broken')
      await open()
      await settle()
      await contextMenu(button('Open picture: x', article('b1'))!)
      await click([...document.querySelectorAll<HTMLButtonElement>('.bot-picture-menu [role="menuitem"]')].find((item) => item.textContent === 'Copy image'))
      await settle()
      expect(writeImage).not.toHaveBeenCalled()
      expect(composerError()?.textContent).toBe("This picture can't be copied.")
    })

    it('a clipboard that refuses the picture is said in its own words above the composer', async () => {
      install()
      drawing()
      writeImage.mockRejectedValue(new Error("Error invoking remote method 'clipboard:writeImage': Error: This picture can't be copied."))
      fake.chats.inbox = [message(1, { id: 'b1', text: '![y](data:image/png;base64,iVBORw0KGgo=)' })]
      await open()
      await settle()
      await contextMenu(button('Open picture: y', article('b1'))!)
      await click([...document.querySelectorAll<HTMLButtonElement>('.bot-picture-menu [role="menuitem"]')].find((item) => item.textContent === 'Copy image'))
      await settle()
      expect(composerError()?.textContent).toBe("This picture can't be copied.")
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

  it('groups one sender’s messages within ten minutes, with one time per run in a minute and a day line per day', async () => {
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
    // One sender's messages in a row in one minute show one time, on the last: o1 and o2 share 11:27, so only o2
    // shows it; b1 (11:27) and b2 (11:28) are in other minutes, so each shows its own. No time on hover.
    const time = (id: string) => article(id).querySelector('time.bot-bubble-time')
    expect(['y1', 'o1', 'o2', 'b1', 'b2', 'o3'].map((id) => time(id)?.getAttribute('dateTime') ?? null)).toEqual([at(0, 1), null, at(0), at(0), at(1), at(20)])
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
    // The message above has no other time to lean on until this one is sent: it keeps its own.
    expect(transcript().querySelector('[data-message-id="o1"] time.bot-bubble-time')).not.toBeNull()
  })

  it('a quiet line between two of the bot’s messages in one minute keeps both times', async () => {
    const minute = new Date()
    minute.setHours(11, 27, 0, 0)
    const at = (seconds: number) => new Date(minute.getTime() + seconds * 1000).toISOString()
    fake.chats.inbox = [
      message(1, { id: 'b1', at: at(10), text: 'Starting.' }),
      message(2, { id: 'b2', at: at(30), text: 'Done.' }),
      message(3, { id: 'b3', at: at(40), text: 'Anything else?' })
    ]
    await open()
    await act(async () => useBotsStore.setState({ notes: { inbox: [{ id: 'n1', text: 'Checked mail', at: at(20) }] } }))
    const log = transcript()
    expect(log.textContent).toContain('Checked mail')
    const hasTime = (id: string) => log.querySelector(`[data-message-id="${id}"] time.bot-bubble-time`) !== null
    // b1, then the quiet line, then b2 and b3 in the same minute: b1 keeps its time, b2 gives its time to b3.
    expect(['b1', 'b2', 'b3'].map(hasTime)).toEqual([true, false, true])
  })

  it('Pick a model opens About with Runs on open, though the owner had it closed', async () => {
    window.localStorage.removeItem('mousse-profile-default-mousse:bot-about-open')
    fake.chats.inbox = [message(1, { kind: 'error', text: 'Pick a model so I can work.', error: { text: 'Pick a model so I can work.', action: { kind: 'pick_model', label: 'Pick a model' } } })]
    await open()
    await click(button('Pick a model', transcript().querySelector('article')!))
    await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null))) })
    const setup = [...document.querySelectorAll('.bot-about-fold-head')].find((head) => head.textContent?.includes('Runs on'))
    expect(setup?.getAttribute('aria-expanded')).toBe('true')
    expect(useBotsStore.getState().aboutFocus).toBeNull()
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
      expect(fake.calls).toContainEqual(['messages', 'inbox', { beforeSeq: 151, limit: 50 }])
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

  it('types as a messenger does: dots in a bubble, "typing…" and a pen in the header, no spinner or chip; Stop and the mic stay', async () => {
    fake.chats.inbox = [message(1, { id: 'o1', author: 'owner', text: 'again' })]
    fake.live.inbox = { activationId: 'act1', chip: { icon: 'search', text: 'searching the web' } }
    await open({ ...inbox, state: 'working', stateText: 'Working…' })
    const typing = transcript().querySelector('.bot-typing')!
    // A chat opened mid-turn shows the dots alone: Mousse never names the step itself.
    expect(typing.getAttribute('aria-label')).toBe('Inbox helper is typing')
    expect(typing.querySelector('.bot-typing-status')).toBeNull()
    expect(typing.querySelectorAll('.bot-typing-row i')).toHaveLength(3)
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
      // Words beside the dots only when the bot writes its own line.
      await act(async () => fake.emit.activity('inbox', null, 'act1', 'Looking at your inbox'))
      const dots = [...transcript().querySelectorAll('.bot-typing-row i')]
      const words = () => transcript().querySelector('.bot-typing-status')!
      const running = () => started.filter((record) => !record.cancelled)
      const onDots = () => running().filter((record) => dots.includes(record.element))
      const shimmer = () => running().filter((record) => words().contains(record.element))
      expect(onDots().map((record) => [dots.indexOf(record.element), record.options.delay, record.options.iterations]))
        .toEqual([[0, 0, Infinity], [1, 150, Infinity], [2, 300, Infinity]])
      // The words shimmer on the dots' cycle, the band reaching them one dot step after the last dot peaks
      // (300 + 360 + 150 ms).
      expect(shimmer().map((record) => [record.options.duration, record.options.iterations, (record.options.delay as number) + 0.25 * 1200]))
        .toEqual([[1200, Infinity, 300 + 360 + 150], [1200, Infinity, 300 + 360 + 150]])
      act(() => setAnimationSpeed('off'))
      expect(running()).toEqual([])
      act(() => setAnimationSpeed('normal'))
      expect(onDots()).toHaveLength(3)
      expect(shimmer()).toHaveLength(2)
      act(() => useAppStore.setState({ shimmerAnimations: false }))
      expect(onDots()).toHaveLength(3)
      expect(shimmer()).toHaveLength(0)
      expect(words().textContent).toBe('Looking at your inbox')
      act(() => useAppStore.setState({ shimmerAnimations: true }))
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
      useAppStore.setState({ shimmerAnimations: true })
    }
  })

  it('pauses the typing dots and the shimmer together while the window is hidden, and plays them when it shows', async () => {
    // jsdom has no Web Animations: animate and getAnimations are recorded here. Out of view counts the same as a hidden
    // window (lib/offscreenMotion.ts, tested in offscreenMotion.test.ts).
    const started: Array<{ element: Element; calls: string[] }> = []
    const prototype = HTMLElement.prototype as { animate?: unknown; getAnimations?: unknown }
    prototype.animate = function (this: Element) {
      const record = { element: this, calls: [] as string[] }
      started.push(record)
      return { cancel: () => record.calls.push('cancel'), pause: () => record.calls.push('pause'), play: () => record.calls.push('play') }
    }
    prototype.getAnimations = function (this: Element) {
      return started.filter((record) => this.contains(record.element) && !record.calls.includes('cancel'))
        .map((record) => ({ pause: () => record.calls.push('pause'), play: () => record.calls.push('play') }))
    }
    let visibility: DocumentVisibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    const windowShown = (shown: boolean) => act(() => {
      visibility = shown ? 'visible' : 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
    })
    try {
      await open({ ...inbox, state: 'working', stateText: 'Working…' })
      await act(async () => fake.emit.activity('inbox', null, 'act1', 'Looking at your inbox'))
      expect(started).toHaveLength(5)
      const last = () => started.map((record) => record.calls.at(-1))
      windowShown(false)
      expect(last()).toEqual(['pause', 'pause', 'pause', 'pause', 'pause'])
      windowShown(true)
      expect(last()).toEqual(['play', 'play', 'play', 'play', 'play'])
    } finally {
      delete prototype.animate
      delete prototype.getAnimations
      delete (document as { visibilityState?: unknown }).visibilityState
    }
  })

  it('says Waiting for internet where it would type, with nothing moving, and still offers Stop', async () => {
    await open({ ...inbox, state: 'working', stateText: 'Waiting for internet', waiting: 'internet' })
    expect(transcript().querySelector('.bot-typing')?.textContent).toBe('Waiting for internet')
    expect(transcript().querySelector('.bot-typing-row, .chat-spin')).toBeNull()
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

describe('a reply as it is written', () => {
  // The bot's chat turns run in its home thread, whose messages reach the window as a thread's do.
  const thread = { added: [] as Array<(event: { threadId: string; message: unknown }) => void>, updated: [] as Array<(event: { threadId: string; message: unknown }) => void> }
  const writer = summary('inbox', { name: 'Inbox helper', state: 'working', stateText: 'Working…', homeThreadId: 'home1', chat: { activationId: 'act_c1' } })
  const frame = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  const add = async (message: object, threadId = 'home1') => { await act(async () => { for (const cb of thread.added) cb({ threadId, message }) }); await frame() }
  const write = async (content: string, over: object = {}) => {
    await act(async () => { for (const cb of thread.updated) cb({ threadId: 'home1', message: { id: 'r1', role: 'assistant', content, timestamp: AT, streaming: true, ...over } }) })
    await frame()
  }
  // The reply's words; the typing row it took over from stays in its bubble, unseen.
  const live = () => transcript().querySelector('.bot-live-reply .bot-turn-reply')
  const stopped = () => transcript().querySelector('.bot-cut-reply')
  // With Animation speed Off (as with reduced motion) the reply's whole words show as they come, with no flow: the tests
  // about what shows and when it goes read it at once. The flow itself has its own test, at normal speed.
  beforeEach(() => { act(() => setAnimationSpeed('off')) })
  afterEach(() => { act(() => setAnimationSpeed('normal')) })
  async function openWriting(bot = writer) {
    thread.added.length = 0
    thread.updated.length = 0
    installPreload(fake, { app: { setViewedBot }, orchestrator: { onThreadMessage: (cb: never) => { thread.added.push(cb); return () => {} }, onThreadMessageUpdated: (cb: never) => { thread.updated.push(cb); return () => {} } } })
    fake.chats.inbox = [message(1, { id: 'o1', author: 'owner', text: 'Compare the two drives.' })]
    await open(bot)
    await add({ id: 'u1', role: 'user', content: 'Compare the two drives.', timestamp: AT })
  }

  it('shows nothing of a turn the chat does not show (a wake-up or a thread\'s notice): no typing, no streaming words', async () => {
    await openWriting(summary('inbox', { name: 'Inbox helper', state: 'idle', homeThreadId: 'home1' }))
    await write('Checking the job that just finished.\n\n')
    expect(live()).toBeNull()
    expect(transcript().querySelector('.bot-typing')).toBeNull()
    expect(transcript().textContent).not.toContain('Checking the job')
  })

  it('keeps a stored action card single while another chat reply streams and the card settles', async () => {
    await openWriting()
    await write('The comparison is ready.\n\n')
    const cardMessage = message(2, { id: 'held-stream', activationId: 'act_work', text: 'Mail · send_email fallback', action: action() })
    await act(async () => fake.emit.message('inbox', cardMessage))
    await frame()
    expect(live()?.textContent).toBe('The comparison is ready.')
    expect(transcript().querySelectorAll('[aria-label="Action to review"]')).toHaveLength(1)
    expect(transcript().textContent).not.toContain('send_email fallback')
    // A reread/push of the same row updates it; it must not append a second review or end the chat's live reply.
    await act(async () => fake.emit.message('inbox', { ...cardMessage, action: { ...cardMessage.action!, status: 'done', at: AT } }))
    await frame()
    expect(transcript().querySelectorAll('[aria-label="Action to review"]')).toHaveLength(1)
    expect(live()?.textContent).toBe('The comparison is ready.')
    expect(transcript().querySelector('[aria-label="Action to review"] [role="status"]')?.textContent).toContain('Sent')
    await act(async () => fake.emit.message('inbox', message(3, { text: 'The comparison is ready.', activationId: 'act_c1' })))
    expect(live()).toBeNull()
    expect(transcript().textContent?.match(/The comparison is ready\./g)).toHaveLength(1)
    expect(transcript().querySelectorAll('[aria-label="Action to review"]')).toHaveLength(1)
    expect(stopped()).toBeNull()
  })

  it('keeps the card and both posted replies single across warm turns on the same home thread', async () => {
    await openWriting()
    await write('First warm reply.\n\n')
    await act(async () => fake.emit.message('inbox', message(2, { id: 'first-posted', text: 'First warm reply.', activationId: 'act_c1' })))
    fake.bots = [{ ...writer, chat: { activationId: 'act_c2' } }]
    await act(async () => { await useBotsStore.getState().refresh() })
    await add({ id: 'u2', role: 'user', content: 'What about the email?', timestamp: AT })
    await write('Second warm reply.\n\n', { id: 'r2' })
    const cardMessage = message(3, { id: 'warm-card', activationId: 'act_work', text: 'Mail · send_email fallback', action: action() })
    await act(async () => fake.emit.message('inbox', cardMessage))
    await act(async () => fake.emit.message('inbox', message(2, { id: 'first-posted', text: 'First warm reply.', activationId: 'act_c1' })))
    await frame()
    expect(live()?.textContent).toBe('Second warm reply.')
    expect(transcript().textContent?.match(/First warm reply\./g)).toHaveLength(1)
    expect(transcript().querySelectorAll('[aria-label="Action to review"]')).toHaveLength(1)
    await act(async () => fake.emit.message('inbox', message(4, { id: 'second-posted', text: 'Second warm reply.', activationId: 'act_c2' })))
    expect(live()).toBeNull()
    expect(transcript().textContent?.match(/Second warm reply\./g)).toHaveLength(1)
    expect(transcript().querySelectorAll('[aria-label="Action to review"]')).toHaveLength(1)
    expect(stopped()).toBeNull()
  })

  it('shows the turn whole words at a time before it ends, each word drawn once, then only its posted message', async () => {
    act(() => setAnimationSpeed('normal'))
    await openWriting()
    expect(transcript().querySelector('.bot-typing')).not.toBeNull()
    const bubble = transcript().querySelector('.bot-typing')?.closest('.bot-bubble')
    expect(bubble).toBeTruthy()
    // A word still being written is not shown: the dots stay until one is whole.
    await write('The')
    expect(live()).toBeNull()
    expect(transcript().querySelector('.bot-typing')).not.toBeNull()
    await write('The first drive')
    // Its first whole word at once, the rest a step at a time.
    expect(live()?.textContent).toBe('The')
    expect(transcript().querySelector('.bot-typing')).toBeNull()
    // The same bubble takes the words: the typing row fades out over them, then stays unseen, holding the bubble's size.
    expect(live()?.closest('.bot-bubble')).toBe(bubble)
    expect(transcript().querySelector('.bot-turn-typing.is-leaving')?.getAttribute('aria-hidden')).toBe('true')
    expect(live()?.classList.contains('is-arriving')).toBe(true)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, BOT_HANDOFF_MS + 20)) })
    expect(transcript().querySelector('.bot-turn-typing.is-held')).not.toBeNull()
    expect(live()?.classList.contains('is-arriving')).toBe(false)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, FLOW_CATCH_UP_MS)) })
    expect(live()?.textContent).toBe('The first')
    const first = live()!.querySelector('.an-word')
    expect(first?.textContent).toBe('The')
    await write('The first drive is faster.\n\nThe second one is')
    // What has come shows within the flow's catch-up time.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, FLOW_CATCH_UP_MS + 200)) })
    expect(live()?.textContent).toBe('The first drive is faster.The second one')
    // Words already shown keep their element, so only the new ones fade in.
    expect(live()!.querySelector('.an-word')).toBe(first)
    // Another chat's thread is not this bot's.
    await act(async () => { for (const cb of thread.updated) cb({ threadId: 'other', message: { id: 'x', role: 'assistant', content: 'Not mine.\n\n', timestamp: AT, streaming: true } }) })
    await frame()
    expect(transcript().textContent).not.toContain('Not mine.')
    // Its message posted: the live bubble goes, and the words show once, as the message.
    await act(async () => fake.emit.message('inbox', message(2, { text: 'The first drive is faster.\n\nThe second one is cheaper.', activationId: 'act_c1' })))
    expect(live()).toBeNull()
    expect(transcript().querySelectorAll('.bot-message:not(.bot-typing)')).toHaveLength(1)
    // It is drawn in the bubble that was typing and writing it: nothing new mounts.
    expect(transcript().querySelector('.bot-message .bot-bubble')).toBe(bubble)
    expect(stopped()).toBeNull()
  })

  it('a reply whose message is posted before its first frame never shows beside it', async () => {
    await openWriting()
    // Its words and its posted message arrive within one frame.
    await act(async () => { for (const cb of thread.updated) cb({ threadId: 'home1', message: { id: 'r1', role: 'assistant', content: 'The first drive is faster.\n\n', timestamp: AT, streaming: true } }) })
    await act(async () => fake.emit.message('inbox', message(2, { text: 'The first drive is faster.', activationId: 'act_c1' })))
    await frame()
    expect(live()).toBeNull()
    expect(transcript().textContent?.match(/The first drive is faster\./g)).toHaveLength(1)
  })

  it('a late update of a reply already posted never brings its bubble back; the next reply still streams', async () => {
    await openWriting()
    await write('The first drive is faster.\n\n')
    await act(async () => fake.emit.message('inbox', message(2, { text: 'The first drive is faster.', activationId: 'act_c1' })))
    expect(live()).toBeNull()
    await write('The first drive is faster.\n\n', { streaming: false })
    expect(live()).toBeNull()
    expect(transcript().textContent?.match(/The first drive is faster\./g)).toHaveLength(1)
    // Another reply of the home thread is a new one.
    await write('One more thing.\n\n', { id: 'r2' })
    expect(live()?.textContent).toBe('One more thing.')
  })

  it('shows the dots alone until the bot says what it does; Mousse adds no words of its own; the bot’s words then stay', async () => {
    await openWriting()
    const status = () => transcript().querySelector('.bot-typing .bot-typing-status')
    const step = (chip: Parameters<typeof fake.emit.activity>[1], line?: string) => act(async () => fake.emit.activity('inbox', chip, 'act_c1', line))
    const pass = (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })
    // Nothing of the turn yet: the dots, with no words beside them.
    expect(transcript().querySelector('.bot-typing .bot-typing-dots')).not.toBeNull()
    expect(status()).toBeNull()
    expect(transcript().querySelector('.bot-typing')?.getAttribute('aria-label')).toBe('Inbox helper is typing')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    try {
      // A call of its own with no line from the bot: still no words.
      await step({ icon: 'search', text: 'searching the web', highlight: 'ssd prices', live: true })
      await pass(DOING_HOLD_MS)
      expect(status()).toBeNull()
      // Its words stream, none whole yet: still none.
      await act(async () => { for (const cb of thread.updated) cb({ threadId: 'home1', message: { id: 'r1', role: 'assistant', content: 'The', timestamp: AT, streaming: true } }) })
      await pass(DOING_HOLD_MS)
      expect(live()).toBeNull()
      expect(status()).toBeNull()
      // A step after those words makes them the bot's own line: it shows at once, and stays after the step ends.
      await act(async () => { for (const cb of thread.added) cb({ threadId: 'home1', message: { id: 't1', role: 'assistant', kind: 'tool_call', content: '', timestamp: AT } }) })
      await step({ icon: 'web', text: 'reading a page', live: true }, 'Comparing the two drives now')
      expect(status()?.firstChild?.textContent).toBe('Comparing the two drives now')
      await step(null)
      await pass(DOING_HOLD_MS)
      expect(status()?.firstChild?.textContent).toBe('Comparing the two drives now')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a step after its words makes them the status beside the dots: the bubble goes until the reply after it', async () => {
    await openWriting()
    await write('Let me check the prices.\n\n')
    expect(live()?.textContent).toBe('Let me check the prices.')
    await add({ id: 't1', role: 'assistant', kind: 'tool_call', content: '', timestamp: AT })
    expect(live()).toBeNull()
    expect(transcript().querySelector('.bot-typing')).not.toBeNull()
  })

  it('never shows an applet’s source or the runtime’s placeholder, and draws nothing for words that finish no block', async () => {
    await openWriting()
    await write('Here it is.\n\n```mousse-applet\n{"schemaVersion":1,\n')
    expect(live()?.textContent).toBe('Here it is.')
    markdown.renders = 0
    await write('Here it is.\n\n```mousse-applet\n{"schemaVersion":1,"title":"Budget",\n')
    expect(markdown.renders).toBe(0)
    await act(async () => { for (const cb of thread.updated) cb({ threadId: 'home1', message: { id: 'r2', role: 'assistant', content: 'No response requested.\n\n', timestamp: AT, streaming: true } }) })
    await frame()
    expect(transcript().textContent).not.toContain('No response requested')
  })

  /** The chat's turn ends (the service's summary no longer names it), and its settle wait passes. */
  async function endTurn(before: () => void = () => {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await act(async () => before())
      fake.bots = [{ ...writer, state: 'idle', stateText: '', chat: undefined }]
      await act(async () => { await useBotsStore.getState().refresh() })
      expect(stopped()).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_MS + 50) })
    } finally {
      vi.useRealTimers()
    }
  }

  it('a quiet turn’s silent marker never shows, and a turn that ends with no message leaves nothing behind', async () => {
    await openWriting()
    await write('[SIL')
    await write('[SILENT]')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1000)) })
    expect(live()).toBeNull()
    expect(transcript().textContent).not.toContain('SIL')
    // Words it showed, then a turn that ends with nothing posted and no Stop or failure: no "Stopped" reply.
    await write('Checked the build.\n\n')
    expect(live()?.textContent).toBe('Checked the build.')
    await endTurn()
    expect(live()).toBeNull()
    expect(stopped()).toBeNull()
  })

  it('a turn that fails before its message keeps its words marked Stopped beside the error', async () => {
    await openWriting()
    await write('The first drive is faster.\n\n')
    await endTurn(() => fake.emit.message('inbox', message(2, { kind: 'error', text: '', error: { text: 'Claude stopped answering.' }, activationId: 'act_c1' })))
    expect(live()).toBeNull()
    expect(stopped()?.querySelector('.bot-markdown')?.textContent).toBe('The first drive is faster.')
    expect(stopped()?.querySelector('.bot-cut-mark')?.textContent).toBe('Stopped')
    expect(transcript().textContent).toContain('Claude stopped answering.')
  })

  it('a turn the owner stops before its message leaves its words muted and marked Stopped, never as a sent message', async () => {
    await openWriting()
    await write('The first drive is faster.\n\nThe second')
    await act(async () => { await useBotsStore.getState().stop('inbox') })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fake.bots = [{ ...writer, state: 'idle', stateText: '', chat: undefined }]
      await act(async () => { await useBotsStore.getState().refresh() })
      // It waits a moment for its message first.
      expect(live()).not.toBeNull()
      expect(stopped()).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_MS + 50) })
    } finally {
      vi.useRealTimers()
    }
    expect(live()).toBeNull()
    // All it had written, the sentence it was in the middle of too, as a thread keeps a stopped reply.
    expect(stopped()?.querySelector('.bot-markdown')?.textContent).toBe('The first drive is faster.The second')
    expect(stopped()?.querySelector('.bot-cut-mark')?.textContent).toBe('Stopped')
    // Not a message: nothing to reply to, react to or quote.
    expect(stopped()?.querySelector('button')).toBeNull()
    expect(stopped()?.hasAttribute('data-message-id')).toBe(false)
    // A message of that turn that still comes takes its place.
    await act(async () => fake.emit.message('inbox', message(2, { at: new Date(Date.now() + 1000).toISOString(), text: 'Late reply.', activationId: 'act_c1' })))
    expect(stopped()).toBeNull()
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
    // A new message renders itself only (the one above may lose its time to it, but not draw its words again).
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
      if (command.startsWith('/forget')) expect(dialog()!.textContent).toContain('what automations do without asking')
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
      { name: 'image-1.png', path: '/tmp/mousse-bot-attachments/1/image-1.png' }
    ])
    expect(vi.mocked(fake.events.attachmentPath!).mock.calls.map(([file]) => file)).toEqual([picked, dropped, expect.objectContaining({ type: 'image/png' })])
    expect(composer().querySelector('.composer-attachments')).toBeNull()
    const sent = transcript().querySelector('.bot-you')!
    expect([...sent.querySelectorAll('.bot-file-pill')].map((pill) => pill.getAttribute('title'))).toEqual([
      '/home/me/.mousse/bots/files/inbox/attachments/2026-11-08/march.pdf',
      '/home/me/.mousse/bots/files/inbox/attachments/2026-11-08/sheet.csv'
    ])
    // The pasted screenshot shows as a picture, named on hover.
    expect([...sent.querySelectorAll('.bot-images .bot-image')].map((tile) => tile.getAttribute('title'))).toEqual(['image-1.png'])
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

  it('a pasted thread reference shows as its chip and is sent as its link where it was written; a private thread is refused, a subagent is not', async () => {
    const pasted: Event[] = []
    const pasteText = async (text: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], files: [], getData: () => text } })
      pasted.push(event)
      await act(async () => { box().dispatchEvent(event) })
    }
    const pills = () => [...composer().querySelectorAll('.composer-reference-pill')].map((pill) => pill.textContent?.trim())
    const at = AT
    useAppStore.setState({ threads: [
      { id: 'thread-b', name: 'Design notes', createdAt: at, updatedAt: at, startedAt: at, order: 0 },
      { id: 'thread-p', name: 'Secret plans', localOnly: true, createdAt: at, updatedAt: at, startedAt: at, order: 1 },
      { id: 'thread-s', name: 'Reviewer', lineage: { relationship: 'subagent', parentThreadId: 'thread-b', rootThreadId: 'thread-b' }, createdAt: at, updatedAt: at, startedAt: at, order: 2 }
    ] as never })
    await open()
    await pasteText('see mousse://thread/thread-p')
    await settle()
    expect(pasted.at(-1)!.defaultPrevented).toBe(true)
    expect(composerError()?.textContent).toContain('“Secret plans” is private')
    expect(box().value).toBe('')

    // A subagent is read through the thread that started it, as far as the bot reaches that one. Each shows as its
    // thread's chip in the line, and goes as its link.
    await pasteText('mousse://thread/thread-b mousse://thread/thread-s')
    await settle()
    expect(pasted.at(-1)!.defaultPrevented).toBe(true)
    expect(pills()).toEqual([])
    expect(composer().querySelectorAll('.composer-thread-chip')).toHaveLength(2)
    await click(button('Send message'))
    await settle()
    expect(fake.calls.filter(([name]) => name === 'send').at(-1)?.[2]).toBe('mousse://thread/thread-b mousse://thread/thread-s')
  })

  it('a send that fails gives its thread pills back, beside one dropped while it was sending', async () => {
    const dropThread = (threadId: string, title: string) => {
      const data = JSON.stringify({ id: `thread:${threadId}`, kind: 'thread', title, threadId })
      return fire(composer(), 'drop', 'dataTransfer', { types: [MOUSSE_REFERENCE_MIME], files: [], getData: (type: string) => (type === MOUSSE_REFERENCE_MIME ? data : '') })
    }
    const pills = () => [...composer().querySelectorAll('.composer-reference-pill')].map((pill) => pill.textContent?.trim())
    useAppStore.setState({ threads: [
      { id: 'thread-a', name: 'Design notes', createdAt: AT, updatedAt: AT, startedAt: AT, order: 0 },
      { id: 'thread-b', name: 'Release plan', createdAt: AT, updatedAt: AT, startedAt: AT, order: 1 }
    ] as never })
    let fail: (cause: Error) => void = () => undefined
    vi.mocked(fake.client.send).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    await open()
    await type(box(), 'Review these')
    await dropThread('thread-a', 'Design notes')
    await settle()
    await click(button('Send message'))
    expect(pills()).toEqual([])
    await dropThread('thread-b', 'Release plan')
    await settle()
    await act(async () => fail(new Error('The bot is offline.')))
    await settle()
    expect(box().value).toBe('Review these')
    expect(pills()).toEqual(['Design notes', 'Release plan'])
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

  it('says a usage pause once, above the composer, while it holds; once the bot runs again its chat line shows settled', async () => {
    const limit = (seq: number, id: string, text: string) => message(seq, { id, kind: 'error', text: '', error: { text, action: { kind: 'resume', label: 'Resume' } } })
    fake.chats.inbox = [limit(1, 'l1', 'Paused until 03:27 (your Claude usage limit)'), message(2, { id: 'o2', author: 'owner', text: 'hi' }), limit(3, 'l3', 'Paused until 03:28 (your Claude usage limit)')]
    const error = { text: 'Paused until 03:28 (your Claude usage limit)', action: { kind: 'resume' as const, label: 'Resume' } }
    await open({ ...inbox, state: 'paused', stateText: 'Paused until 03:28', error })
    const line = (id: string) => transcript().querySelector(`[data-message-id="${id}"] .bot-error`)
    expect(button('Resume', line('l1')!)).toBeUndefined()
    expect(line('l1')!.classList.contains('is-settled')).toBe(true)
    expect(line('l3')).toBeNull()
    expect(document.querySelector('.bot-pinned[data-kind="error"]')).toBeNull()
    expect(transcript().querySelector('.bot-paused-line')?.textContent).toBe('Paused until 03:28 (your Claude usage limit). Resume')
    await click(button('Resume', transcript().querySelector('.bot-paused-line')!))
    expect(fake.calls).toContainEqual(['resume', 'inbox'])
    // The bot is no longer paused: no line offers a Resume that would do nothing.
    await settle()
    expect(transcript().querySelectorAll('.bot-error button')).toHaveLength(0)
    expect(line('l3')!.classList.contains('is-settled')).toBe(true)
    expect(line('l3')!.textContent).toBe('Paused until 03:28 (your Claude usage limit)')
  })
})

describe('the menu', () => {
  it('offers About, Find in chat, Hide checklist, Rename, Change look, Pause and Delete bot', async () => {
    await open()
    await click(button('Bot menu'))
    expect([...host.querySelectorAll('[role="menuitem"]')].map((element) => element.textContent)).toEqual(['About this bot', 'Find in chat', 'Hide checklist', 'Rename', 'Change look', 'Pause', 'Delete bot'])
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

  it('the face opens Agent settings in the side panel and closes it; the panel button hides the panel and brings it back as it was', async () => {
    act(() => setAnimationSpeed('off'))
    try {
      await open()
      const panel = () => host.querySelector<HTMLElement>('aside.bot-side')
      expect(button('Show side panel')?.getAttribute('aria-expanded')).toBe('false')
      await click(button('About Inbox helper'))
      expect(panel()?.getAttribute('data-view')).toBe('settings')
      expect(panel()!.querySelector('aside.bot-about')?.getAttribute('aria-label')).toBe('About Inbox helper')
      expect(button('Hide side panel')?.getAttribute('aria-expanded')).toBe('true')
      await click(button('Hide side panel'))
      expect(panel()).toBeNull()
      expect(useBotsStore.getState().aboutOpen).toBe(false)
      await click(button('Show side panel'))
      expect(panel()?.getAttribute('data-view')).toBe('settings')
      await click(button('About Inbox helper'))
      expect(panel()).toBeNull()
      expect(button('Show side panel')?.getAttribute('aria-expanded')).toBe('false')
    } finally {
      act(() => setAnimationSpeed('normal'))
    }
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

  it('loading older messages of a turn draws the messages already shown in the same elements', async () => {
    fake.chats.inbox = Array.from({ length: 80 }, (_, index) => message(index + 1, { activationId: 'act_long' }))
    await open()
    const shownFirst = transcript().querySelector<HTMLElement>('article[data-message-id]')!
    const id = shownFirst.getAttribute('data-message-id')!
    await act(async () => { await useBotsStore.getState().loadOlder('inbox') })
    expect(transcript().querySelectorAll('article[data-message-id]').length).toBeGreaterThan(50)
    expect(transcript().querySelector(`article[data-message-id="${id}"]`)).toBe(shownFirst)
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
    expect(typing().querySelectorAll('.bot-typing-row i')).toHaveLength(3)
    expect(typing().getAttribute('aria-label')).toBe('Inbox helper: Checking your shopping list now')
    // A newer line replaces it, and a long one shows whole.
    const long = 'Reading the three store pages you sent and checking which of them still have the 2 TB drive in stock, with delivery to Pune before Friday'
    await act(async () => fake.emit.activity('inbox', { icon: 'web', text: 'reading a page' }, 'act_c1', long))
    expect(words()?.textContent).toBe(long)
    // An event without one (its step ended): the line keeps its words, never the dots alone or a step back to "Working".
    await act(async () => fake.emit.activity('inbox', null, 'act_c1'))
    expect(words()?.textContent).toBe(long)
    expect(typing().getAttribute('aria-label')).toBe(`Inbox helper: ${long}`)
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

    const recent = () => host.querySelector('.bot-thread-recent')?.textContent

    it('lists working threads first, then those waiting on you, each with its state, project and last update; the rest under Recent', async () => {
      await open({ ...inbox, state: 'working', stateText: 'Managing 2 threads', threads })
      expect(presence().textContent).toBe('Managing 2 threads')
      await click(presence())
      expect(rows().slice(0, 2)).toEqual([['Dictation', 'working', 'working'], ['Typing dots', 'waiting on you', 'waiting']])
      expect(host.querySelector('.bot-thread-meta')!.textContent).toBe('Mousse · updated 1m ago')
      expect(recent()).toBe('Recent4')
      expect(rows().slice(2)).toEqual([['Never ran', 'idle', 'idle'], ['Broken', 'failed', 'failed'], ['Halted', 'stopped', 'failed'], ['Old run', 'done', 'done']])
    })

    it('while something runs, Recent opens folded: Show more unfolds it, Show less folds it, and every opening starts folded', async () => {
      await open({ ...inbox, state: 'working', stateText: 'Managing 2 threads', threads })
      const fold = () => host.querySelector('.bot-work-fold')!
      const more = () => host.querySelector<HTMLButtonElement>('.bot-work-more')!
      await click(presence())
      expect(fold().hasAttribute('inert')).toBe(true)
      expect(more().textContent).toBe('Show more4')
      await click(more())
      expect(fold().hasAttribute('inert')).toBe(false)
      expect([more().textContent, more().getAttribute('aria-expanded')]).toEqual(['Show less', 'true'])
      await click(more())
      expect(fold().hasAttribute('inert')).toBe(true)
      // Unfolded, closed by a click away and opened again: folded.
      await click(more())
      await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
      await click(presence())
      expect(fold().hasAttribute('inert')).toBe(true)
      // The arrow keys pass over the folded rows: from the last working row to Show more.
      await act(async () => host.querySelector<HTMLElement>('.bot-thread-line[data-tone="waiting"]')!.focus())
      await keydown('ArrowDown')
      expect(document.activeElement).toBe(more())
    })

    it('a thread on hold for the owner is listed as waiting on you while the bot reads free, and the rest under Recent', async () => {
      await open({ ...inbox, state: 'idle', stateText: 'Done.', threads: [thread('t8', 'Fix login', 'on_hold', 20), thread('t3', 'Old run', 'done', 90)] })
      expect(presence().textContent).toBe('free')
      await click(presence())
      expect(rows()).toEqual([['Fix login', 'waiting on you', 'waiting'], ['Old run', 'done', 'done']])
      expect(recent()).toBe('Recent1')
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
      // In the bot's chat pane: the sidebar stays on Chats.
      expect(useChatsStore.getState().botThread).toEqual({ botId: inbox.id, threadId: 't2' })
      expect(useAppStore.getState().sidebarMode).toBe('chats')
      expect(host.querySelector('.bot-work')).toBeNull()
    })

    it('a right-click on a row copies the thread\'s reference; the list stays open through the menu, and Escape closes only the menu', async () => {
      opened.ids.length = 0
      const writeText = vi.fn(async () => undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      await open({ ...inbox, state: 'working', stateText: 'Managing 2 threads', threads })
      await click(presence())
      const row = host.querySelector('.bot-thread-line[data-tone="working"]')!
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })) })
      const item = () => document.querySelector<HTMLElement>('.thread-ref-menu [role="menuitem"]')
      await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      expect(item()).toBeNull()
      expect(host.querySelector('.bot-work')).not.toBeNull()
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })) })
      // A press on the menu, as a pointer makes it, then the click.
      await act(async () => { item()!.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
      await click(item())
      expect(writeText).toHaveBeenCalledWith('mousse://thread/t1')
      expect(opened.ids).toEqual([])
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

    it('a free bot whose threads all ended still opens their list', async () => {
      await open({ ...inbox, threads: threads.filter((item) => item.status === 'done' || item.status === 'failed') })
      expect(presence().textContent).toBe('free')
      await click(presence())
      expect(rows().map(([title]) => title)).toEqual(['Broken', 'Old run'])
      // Nothing runs, so Recent shows unfolded with no Show more.
      expect(host.querySelector('.bot-work-fold')!.hasAttribute('inert')).toBe(false)
      expect(host.querySelector('.bot-work-more')).toBeNull()
    })

    it('Recent lists only threads updated in the last six hours, counts just those, and one drops off while the list is open', async () => {
      const hours = 6 * 60
      await open({ ...inbox, threads: [thread('t1', 'Fresh', 'done', 10), thread('t2', 'Turning stale', 'failed', hours - 1), thread('t3', 'This morning', 'done', hours + 5)] })
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      try {
        await click(presence())
        expect(recent()).toBe('Recent2')
        expect(rows().map(([title]) => title)).toEqual(['Fresh', 'Turning stale'])
        // Two minutes on, the list's clock ticks and the thread that turned six hours old leaves; the count follows.
        await act(async () => { vi.advanceTimersByTime(120_000) })
        expect(recent()).toBe('Recent1')
        expect(rows().map(([title]) => title)).toEqual(['Fresh'])
      } finally {
        vi.useRealTimers()
      }
    })

    it("See all counts the threads it started that are not archived, and opens the sidebar's Threads tab filtered to it", async () => {
      const started = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, createdAt: ago(600), updatedAt: ago(600), startedByBot: { botId: inbox.id, name: inbox.name }, hidden: true as const, ...over })
      useAppStore.setState({ threads: [started('s1'), started('s2'), started('s3', { archivedAt: ago(500) }), started('s4', { lineage: { parentThreadId: 's1' } })] as never, threadsSidebarView: 'projects', sidebarMode: 'threads' })
      try {
        // Nothing works and nothing is recent, yet the line opens: See all is there.
        await open({ ...inbox, threads: [] })
        await click(presence())
        const all = host.querySelector<HTMLButtonElement>('.bot-thread-all')!
        expect(all.textContent).toBe('See all 2 threads')
        await click(all)
        expect(host.querySelector('.bot-work')).toBeNull()
        expect(useThreadFilterStore.getState().botId).toBe(inbox.id)
        expect(useAppStore.getState().threadsSidebarView).toBe('threads')
      } finally {
        useAppStore.setState({ threads: appInitial.threads, threadsSidebarView: appInitial.threadsSidebarView, sidebarMode: appInitial.sidebarMode })
        useThreadFilterStore.setState(useThreadFilterStore.getInitialState(), true)
      }
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
    expect(button('Message Inbox helper')!.getAttribute('aria-current')).toBe('true')
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
    expect(row.textContent).toBe('Memory2 wishes · 2 notes')
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
    expect(vi.mocked(fake.client.send).mock.calls.at(-1)?.[1]).toBe('Why?\n\n> The owner reads mail at 8.')
    // The bubble shows the quote as a pill, not the Markdown quote the bot got.
    await settle()
    const bubble = [...transcript().querySelectorAll('.bot-you-bubble')].at(-1)!
    expect(bubble.querySelector('.sent-quote-pill')?.textContent).toBe('Replying to: The owner reads mail at 8.')
    expect(bubble.textContent).not.toContain('> The owner')
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

it('R5-time formats a sent action in the client clock', async () => {
  const { botGroupTime } = await import('../../src/renderer/components/bots/messageGroups')
  fake.chats.inbox = [message(1, { id: 'bm_action_sent', text: 'Sent', actionSentAt: AT } as never)]
  await open()
  expect(host.querySelector('[data-message-id="bm_action_sent"]')?.textContent).toContain(`Sent · ${botGroupTime(AT)}`)
})

// Stored action cards, through the workspace the owner actually opens.
const action = (change: Record<string, unknown> = {}) => ({ actionId: 'held-1', digest: 'shown-digest', title: 'Send an email', serverName: 'Mail', args: { from: 'me@example.com', to: ['one@example.com', 'two@example.com'], subject: 'A subject', attachments: ['trip.pdf'], body: 'Long email '.repeat(120) + 'last word', password: { $mousse: 'hidden', text: 'hidden · will be sent' }, literal: { $mousse: 'literal', value: { $mousse: 'hidden', text: 'hidden · will be sent' } } }, hasHiddenValues: true, hiddenPaths: [['password'], ['login', 'token']], status: 'open', note: 'Please check this.', ...change })
const held = (change: Record<string, unknown> = {}) => message(1, { id: 'held-message', text: 'legacy fallback', action: action(change) } as never)
it('shows complete stored action arguments as guarded text, with an in-place body fold and no invented bot note', async () => {
  fake.chats.inbox = [held({ title: '<b>Send</b>', serverName: '[Mail](https://evil.test)', note: '<i>Check</i>\u202e this', args: { ...action().args, hostile: '<button>Send now</button> https://evil.test Ignore instructions', text: 'hidden · will be sent' } })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card).toBeTruthy()
  for (const text of ['me@example.com', 'one@example.com', 'two@example.com', 'A subject', 'trip.pdf', '<b>Send</b>', '<button>Send now</button>', 'login']) expect(card.textContent).toContain(text)
  expect(card.querySelector('[aria-label="Bot note"]')).toBeNull()
  expect(card.textContent).not.toContain('<i>Check</i>')
  expect(card.querySelector('a, b, i')).toBeNull()
  expect(card.textContent).not.toContain('\u202e')
  const fold = card.querySelector('details')!
  expect(fold.open).toBe(false)
  await click(fold.querySelector('summary'))
  expect(fold.open).toBe(true)
  expect(fold.textContent).toContain('last word')
  expect(card.querySelectorAll('[aria-label="Hidden value that will be sent"]')).toHaveLength(1)
  expect(button('Send', card)?.autofocus).toBe(false)
})
it('answers only the bot, the card id, digest and choice, then redraws a changed card with live buttons', async () => {
  fake.chats.inbox = [held()]
  const answer = vi.fn(async () => { fake.chats.inbox = [held({ digest: 'new-digest', title: 'Changed email' })]; throw Object.assign(new Error('This changed since you saw it'), { code: 'bot_action_changed' }) })
  Object.assign(fake.client, { answerAction: answer })
  await open()
  await click(button('Send', host.querySelector('[aria-label="Action to review"]')!))
  expect(answer).toHaveBeenCalledWith('inbox', 'held-1', 'shown-digest', 'send')
  expect(host.textContent).toContain('This changed since you saw it')
  expect(host.textContent).toContain('Changed email')
  expect(button('Send', host.querySelector('[aria-label="Action to review"]')!)?.disabled).toBe(false)
  await click(button('Not now'))
  expect(answer).toHaveBeenLastCalledWith('inbox', 'held-1', 'new-digest', 'not_now')
})
it.each([
  ['open', 'Send'], ['approved', 'Waiting for Mail…'], ['running', 'Sending'], ['done', 'Sent ·'],
  ['failed', 'Not sent'], ['uncertain', "Couldn't tell if it went through"], ['declined', 'Not sent'],
  ['expired', 'Expired · not sent'], ['withdrawn', 'Not sent']
])('keeps the complete card readable in %s', async (status, label) => {
  fake.chats.inbox = [held({ status, at: AT })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.textContent).toContain(label)
  expect(card.textContent).toContain('trip.pdf')
  expect(button('Send', card)?.disabled ?? true).toBe(status !== 'open')
})
it.each(['done', 'failed', 'uncertain'])('warns about the previous %s call and shows masked tool errors', async (status) => {
  fake.chats.inbox = [held({ previous: { status, at: AT }, result: { text: '<error>hidden · will be sent</error>', toolReportedError: true } })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.textContent).toContain(status === 'done' ? 'already sent exactly this' : status === 'failed' ? 'already tried exactly this' : "couldn't tell if it went through")
  expect(card.querySelector('[role="note"][aria-label="Tool result"]')?.textContent).toContain('<error>hidden · will be sent</error>')
})
it('keeps Not now available when a card is too large to send here', async () => {
  fake.chats.inbox = [held({ tooLarge: true })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.textContent).toContain('Use the computer')
  expect(button('Send', card)?.disabled).toBe(true)
  expect(button('Not now', card)?.disabled).toBe(false)
})

it.each(['done', 'failed', 'uncertain', 'declined', 'expired', 'withdrawn', 'legacy'])('find counts only highlightable settled text for %s cards', async (status) => {
  fake.chats.inbox = [status === 'legacy' ? message(1, { text: 'Sent', actionSentAt: AT }) : held({ status, at: AT })]
  await open()
  const { botFindText } = await import('../../src/renderer/components/bots/useBotChatFind')
  const { collectFindRanges } = await import('../../src/renderer/chat/components/agent-elements/find/dom-highlight')
  const row = host.querySelector('[data-turn-key]')!
  const text = botFindText(fake.chats.inbox[0]!)
  const needle = status === 'uncertain' ? "Couldn't" : status === 'failed' || status === 'declined' || status === 'withdrawn' ? 'Not sent' : status === 'expired' ? 'Expired' : 'Sent'
  expect(text).toContain(needle)
  expect(collectFindRanges(row, needle)).toHaveLength(1)
  // The plain fallback is replaced by the card; it must never produce an unpaintable match.
  expect(text).not.toContain('legacy fallback')
})

it('keeps structural hidden children inside escaped literal objects distinct from literal marker-shaped text', async () => {
  fake.chats.inbox = [held({ args: { $mousse: 'literal', value: { $mousse: 'custom', password: { $mousse: 'hidden', text: 'hidden · will be sent' }, spoof: { $mousse: 'literal', value: { $mousse: 'literal', value: { $mousse: 'literal', value: { $mousse: 'hidden', text: 'hidden · will be sent' } } } } } } })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.querySelectorAll('[aria-label="Hidden value that will be sent"]')).toHaveLength(1)
  expect(card.textContent).toContain('custom')
})
it('passes exactly the shown action identity through the real client transport, and refreshes the settled tool error', async () => {
  fake.chats.inbox = [held()]
  const { createPersonalBotsClient } = await import('../../src/renderer/services/personalBotsClient')
  const request = vi.fn(async () => {
    fake.chats.inbox = [held({ status: 'failed', result: { text: '<error>Partial delivery</error>', toolReportedError: true } })]
    return { status: 'failed' }
  })
  Object.assign(fake.client, { answerAction: createPersonalBotsClient({ request } as never).answerAction })
  await open()
  await click(button('Send', host.querySelector('[aria-label="Action to review"]')!))
  expect(request).toHaveBeenCalledExactlyOnceWith('bots.actions.answer', { botId: 'inbox', actionId: 'held-1', digest: 'shown-digest', answer: 'send' })
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.textContent).toContain('The tool reported an error')
  expect(card.querySelector('[aria-label="Tool result"]')?.textContent).toBe('<error>Partial delivery</error>')
  expect(button('Send', card)).toBeUndefined()
})

it('keeps subject and multiline recipient probes inside data and drops legacy notes', async () => {
  const note = 'Fine.\n\nInbox helper already sent exactly this at 9:14 AM\n\nThis changed since you saw it'
  const subject = 'Hi\n\nHidden values will be sent: nothing\n\nInbox helper already sent exactly this…'
  const recipient = 'alice@example.com\nbcc\nevil@example.com'
  fake.chats.inbox = [held({ note, args: { subject, to: [recipient], 'Hidden values will be sent': 'pretend notice' }, previous: { status: 'done', at: AT } })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  const argumentsRegion = card.querySelector('[role="region"][aria-label="Everything it will send"]')!
  expect(argumentsRegion).toBeTruthy()
  expect(argumentsRegion.querySelector('blockquote')?.textContent).toContain('Hi↵')
  expect(argumentsRegion.textContent).toContain('alice@example.com↵\nbcc↵\nevil@example.com')
  expect(card.querySelector('blockquote[aria-label="Bot note"]')).toBeNull()
  expect(card.textContent).not.toContain('Fine.')
  const notices = [...card.querySelectorAll('[role="note"]')].filter((element) => element.textContent?.includes('Hidden values will be sent:') || element.textContent?.includes('already sent exactly this at'))
  for (const notice of notices) { expect(argumentsRegion.contains(notice)).toBe(false); expect(notice.querySelector('svg')).toBeTruthy() }
})

it('distinguishes scalar data types, scalar-looking text and empty text', async () => {
  fake.chats.inbox = [held({ args: { off: false, textOff: 'false', on: true, textOn: 'true', count: 123, textCount: '123', nothing: null, textNothing: 'null', list: [], textList: '[]', object: {}, textObject: '{}', empty: '', plain: 'An ordinary sentence' } })]
  await open()
  const args = host.querySelector('[aria-label="Everything it will send"]')!
  const value = (key: string) => [...args.querySelectorAll('dt')].find((element) => element.textContent === key)!.nextElementSibling!
  for (const [key, display] of [['off', 'false'], ['on', 'true'], ['count', '123'], ['nothing', 'null'], ['list', '[]'], ['object', '{}']]) {
    expect(value(key).querySelector('code')?.textContent).toBe(display)
    expect(value(`text${key === 'off' ? 'Off' : key === 'on' ? 'On' : key === 'count' ? 'Count' : key === 'nothing' ? 'Nothing' : key === 'list' ? 'List' : 'Object'}`).textContent).toBe(`"${display}"`)
  }
  expect(value('empty').textContent).toBe('(empty text)')
  expect(value('plain').textContent).toBe('An ordinary sentence')
  expect(value('plain').querySelector('code')).toBeNull()
})

it.each(['approved', 'running', 'done', 'failed', 'uncertain', 'declined', 'expired', 'withdrawn'])('keeps %s cards compact with arguments readable in place and a timed outcome', async (status) => {
  fake.chats.inbox = [held({ status, at: AT, result: status === 'failed' ? { text: 'Partly delivered', toolReportedError: true } : undefined })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.querySelector('[aria-label="Action summary"]')?.textContent).toBe('Send an email · Mail')
  const fold = card.querySelector<HTMLDetailsElement>('details')!
  expect(fold?.open).toBe(false)
  expect(fold.querySelector('[aria-label="Everything it will send"]')).toBeTruthy()
  expect(card.querySelector('[role="status"]')?.textContent).toContain(' · ')
  if (status === 'failed') expect(card.querySelector('[aria-label="Tool result"]')?.textContent).toBe('Partly delivered')
  await click(fold.querySelector('summary'))
  expect(fold.open).toBe(true)
  expect(fold.textContent).toContain('trip.pdf')
})

it('folds long list values and names when more arguments remain below', async () => {
  fake.chats.inbox = [held({ args: { subject: 'S'.repeat(300), to: ['alice@example.com\n'.repeat(40)], final: 'Last field' } })]
  await open()
  const args = host.querySelector<HTMLElement>('[aria-label="Everything it will send"]')!
  const subject = [...args.querySelectorAll('dt')].find((item) => item.textContent === 'subject')!.nextElementSibling!
  expect(subject.querySelector('details')?.open).toBe(false)
  expect(args.querySelector('li details')?.textContent).toContain('alice@example.com')
  expect(args.textContent).toContain('Last field')
  Object.defineProperties(args, { scrollHeight: { configurable: true, value: 900 }, clientHeight: { configurable: true, value: 360 }, scrollTop: { configurable: true, writable: true, value: 0 } })
  await act(async () => args.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(host.textContent).toContain('More below')
  args.scrollTop = 540
  await act(async () => args.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(host.textContent).not.toContain('More below')
})

it('shows a too-large device stub without null arguments or an empty hidden-field list', async () => {
  fake.chats.inbox = [held({ tooLarge: true, args: null, hiddenPaths: [] })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.querySelector('[aria-label="Everything it will send"]')).toBeNull()
  expect(card.textContent).toContain('too large to review on this device')
  expect(card.textContent).toContain('Hidden values will be sent')
  expect(card.textContent).not.toContain('Hidden values will be sent:')
  expect(card.textContent).not.toContain('null')
  expect(button('Send', card)?.disabled).toBe(true)
  expect(button('Not now', card)?.disabled).toBe(false)
})

it('quotes actual hidden path segments without interpreting dots or arrows and folds long segments', async () => {
  const long = 'harmless preview (not sent)_token'.repeat(20)
  fake.chats.inbox = [held({ hiddenPaths: [['a.b', 'c → d'], ['meta', long]] })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  const warning = [...card.querySelectorAll('[role="note"]')].find((item) => item.textContent?.includes('Hidden values will be sent'))!
  const path = warning.querySelector('[aria-label="Hidden field path"]')!
  expect([...path.querySelectorAll('[aria-label="Field name"]')].map((item) => item.textContent)).toEqual(['a.b', 'c → d'])
  const fold = warning.querySelector('details')!
  expect(fold.open).toBe(false)
  await click(fold.querySelector('summary'))
  expect(fold.open).toBe(true)
  expect(fold.textContent).toContain(long)
})

it('guards hidden characters consistently while preserving ordinary script and emoji joiners', async () => {
  const hidden = '\u2028\u2029\u034f\u115f\u1160\u3164\uffa0\u200b\u202e\u2067\ufeff'
  fake.chats.inbox = [held({ args: { subject: `before${hidden}after`, to: ['bob@exa\u200dmple.com', 'https://exa\u200cmple.com', 'bоb@example.com'], 'tо': 'lookalike name', ordinary: 'می‌روم 👩‍💻 Ελληνικά Русский' } })]
  await open()
  const args = host.querySelector('[aria-label="Everything it will send"]')!
  expect(args.textContent).not.toContain(hidden)
  expect(args.textContent).toContain(`before${'�'.repeat([...hidden].length)}after`)
  expect(args.textContent).toContain('bob@exa�mple.com')
  expect(args.textContent).toContain('https://exa�mple.com')
  expect(args.textContent).toContain('می‌روم 👩‍💻 Ελληνικά Русский')
  expect(args.querySelectorAll('[aria-label="Non-ASCII letters or digits"]')).toHaveLength(1)
  const { plainLabel } = await import('../../src/shared/bots/personal/modelSlots')
  expect(plainLabel('one\u200ctwo\u2029three')).toBe('one two three')
})

it('gives an earlier repeated action its calendar day as well as its time', async () => {
  fake.chats.inbox = [held({ previous: { status: 'done', at: '2020-02-03T09:14:00.000Z' } })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  const warning = [...card.querySelectorAll('[role="note"]')].find((item) => item.textContent?.includes('already sent exactly this'))!
  expect(warning.textContent).toContain('2020')
  expect(warning.textContent).toContain('Feb')
})

it.each([
  ['bot_action_changed', 'The service changed. Ask your bot to prepare this again.', 'open', 'This changed since you saw it. Check it again before sending.'],
  ['bot_action_paused', 'Resume this bot before sending.', 'open', 'Resume Inbox helper to send this.'],
  ['bot_action_expired', 'This action has expired and was not sent.', 'expired', 'This expired, so nothing was sent.'],
  ['bot_action_closed', 'This action can no longer be sent.', 'withdrawn', 'This action can no longer be sent.']
])('shows the locally mapped refusal for %s and refreshes the actual row', async (code, text, status, expected) => {
  fake.chats.inbox = [held()]
  Object.assign(fake.client, { answerAction: vi.fn(async () => {
    fake.chats.inbox = [held({ status })]
    const refusal = code === 'bot_action_closed' ? { code } : { code: 'conflict', details: { reason: code } }
    throw Object.assign(new Error(text), refusal)
  }) })
  await open()
  await click(button('Send', host.querySelector('[aria-label="Action to review"]')!))
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.textContent).toContain(status === 'expired' ? 'Expired · not sent' : expected)
  expect(button('Send', card) !== undefined).toBe(status === 'open')
  expect(button('Not now', card) !== undefined).toBe(status === 'open')
  const { botsClient } = await import('../../src/renderer/stores/botsStore')
  const result = await useBotsStore.getState().answerAction('inbox', 'held-1', 'shown-digest', 'send')
  expect(result).toEqual({ reason: code, text: expected })
  expect(botsClient().messages).toHaveBeenCalled()
})

it.each(['open', 'done'])('finds literal title and visible status with matching paintable parts for %s', async (status) => {
  fake.chats.inbox = [held({ title: '*Sent* <b>[Mail](https://x.test) &copy;', status, at: AT })]
  await open()
  const { botFindTurns } = await import('../../src/renderer/components/bots/useBotChatFind')
  const { buildFindIndex } = await import('../../src/renderer/chat/components/agent-elements/find/find-index')
  const { collectFindRanges } = await import('../../src/renderer/chat/components/agent-elements/find/dom-highlight')
  const turns = botFindTurns([{ kind: 'message', message: fake.chats.inbox[0]! }] as never)
  const row = host.querySelector('[data-turn-key]')!
  for (const query of ['*Sent*', '[Mail]', '&copy;', 'Sent']) {
    const indexed = buildFindIndex(turns, query)
    const painted = collectFindRanges(row, query)
    expect(indexed.length).toBeGreaterThan(0)
    expect(painted.map(({ partIndex, ordinal }) => ({ partIndex, ordinal }))).toEqual(indexed.map(({ partIndex, ordinal }) => ({ partIndex, ordinal })))
  }
  expect(buildFindIndex(turns, 'trip.pdf')).toHaveLength(0)
})

it('updates the more-arguments cue when a nested fold opens without scrolling', async () => {
  fake.chats.inbox = [held()]
  await open()
  const region = host.querySelector<HTMLElement>('[aria-label="Everything it will send"]')!
  Object.defineProperties(region, { scrollHeight: { configurable: true, value: 900 }, clientHeight: { configurable: true, value: 360 }, scrollTop: { configurable: true, value: 0 } })
  const fold = region.querySelector('details')!
  await act(async () => { fold.open = true; fold.dispatchEvent(new Event('toggle')) })
  expect(host.textContent).toContain('More below')
})

it.each([
  ['done', false, 'What it sent'], ['failed', true, 'What it sent'],
  ['uncertain', false, 'What it tried to send'], ['approved', false, 'What it will send'],
  ['running', false, 'What it is sending'], ['declined', false, 'What it would have sent'],
  ['expired', false, 'What it would have sent'], ['withdrawn', false, 'What it would have sent'],
  ['failed', false, 'What it would have sent']
])('names the %s review by what happened, tool error=%s', async (status, toolReportedError, label) => {
  fake.chats.inbox = [held({ status, at: AT, result: toolReportedError ? { text: 'Service error', toolReportedError } : undefined })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.querySelector('details > summary')?.textContent).toBe(label)
  expect(card.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Everything it will send')
  expect(card.textContent).not.toContain('arguments')
})

it('puts the identifying data under the title, then the outcome before the tool answer and review', async () => {
  fake.chats.inbox = [held({ status: 'failed', at: AT, result: { text: 'Partly delivered', toolReportedError: true } })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  const status = card.querySelector('[role="status"]')!
  const identity = card.querySelector('[aria-label="Request identification"]')!
  expect(card.querySelector('[aria-label="Action summary"]')?.nextElementSibling).toBe(identity)
  expect(identity.nextElementSibling).toBe(status)
  expect(status.nextElementSibling).toBe(card.querySelector('[aria-label="Tool result"]'))
  expect(status.nextElementSibling?.nextElementSibling).toBe(card.querySelector('details'))
})

it('distinguishes quoted text, backslashes and the literal empty-text label', async () => {
  const values = ['false', '"false"', '"a\\b"', '(empty text)', '']
  fake.chats.inbox = [held({ args: Object.fromEntries(values.map((value, index) => [String(index), value])) })]
  await open()
  const blocks = [...host.querySelectorAll('[aria-label="Everything it will send"] > dl > div > dd')].map(block => block.textContent)
  expect(blocks).toEqual(['"false"', JSON.stringify('"false"'), JSON.stringify('"a\\b"'), '"(empty text)"', '(empty text)'])
  expect(new Set(blocks).size).toBe(values.length)
})

it('notes non-ASCII address and phone letters or digits without warning on ordinary prose', async () => {
  const values = ['bob@ｅxample.com', 'bob@exօmple.com', 'раураӏ.рф', '+1 ８００ 555 0100', 'Мария Иванова']
  fake.chats.inbox = [held({ args: Object.fromEntries(values.map((value, index) => [String(index), value])) })]
  await open()
  const blocks = [...host.querySelectorAll('[aria-label="Everything it will send"] > dl > div > dd')]
  for (const block of blocks.slice(0, 4)) expect(block.textContent).toContain('Contains letters or digits outside A–Z and 0–9')
  expect(blocks[4].textContent).toBe('Мария Иванова')
})

it('shows field-name line breaks as marks and gives an empty field a name', async () => {
  fake.chats.inbox = [held({ args: { 'to\nalice@example.com': 'evil@example.com', '': 'value' } })]
  await open()
  const names = [...host.querySelectorAll('[aria-label="Everything it will send"] dt')].map(item => item.textContent)
  expect(names).toEqual([JSON.stringify('to\nalice@example.com'), '(no name)'])
})

it('keeps a curly-quoted arrow name in one unquoted hidden-path segment', async () => {
  fake.chats.inbox = [held({ hiddenPaths: [['a” → “b', 'token']] })]
  await open()
  const path = host.querySelector('[aria-label="Hidden field path"]')!
  expect(path.querySelector('q')).toBeNull()
  expect([...path.querySelectorAll('[aria-label="Field name"]')].map(item => item.textContent)).toEqual(['a” → “b', 'token'])
})

it.each(['approved', 'running', 'unreachable'])('C4 integration waiting distinguishes %s from an actual send', async (state) => {
  const sentence = "Stored Mail couldn't be reached. Nothing was sent. Try again when it is available."
  fake.chats.inbox = [held({ status: state === 'unreachable' ? 'failed' : state, serverName: 'Stored Mail', at: AT, result: state === 'unreachable' ? { text: sentence, notSentInTime: true } : undefined })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  const status = card.querySelector('[role="status"]')!
  expect(status.textContent).toContain(state === 'approved' ? 'Waiting for Stored Mail…' : state === 'running' ? 'Sending…' : sentence.slice(0, -1))
  expect(status.textContent).toContain(' · ')
  expect(button('Send', card)).toBeUndefined()
  expect(button('Not now', card)).toBeUndefined()
  if (state === 'unreachable') {
    expect(card.querySelector('summary')?.textContent).toBe('What it would have sent')
    expect(card.querySelector('[aria-label="Tool result"]')).toBeNull()
    expect(card.textContent).not.toContain('The tool reported an error')
  }
})

it.each(['done', 'failed', 'uncertain', 'withdrawn'])('C4 integration forgotten %s cards hide all content but retain the outcome', async (status) => {
  fake.chats.inbox = [held({ forgotten: true, digest: '[forgotten]', title: 'Send email', serverName: 'Your service', args: '[forgotten]', note: '[forgotten]', status, at: AT, result: { text: '[forgotten]', toolReportedError: status === 'failed' } })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.textContent).toContain('Forgotten')
  expect(card.querySelector('[aria-label="Action summary"]')?.textContent).toBe('Send email')
  expect(card.querySelector('[role="status"]')?.textContent).toContain(status === 'failed' ? 'The tool reported an error' : status === 'done' ? 'Sent' : status === 'uncertain' ? "Couldn't tell" : 'Not sent')
  expect(card.querySelector('[role="status"]')?.textContent).toContain(' · ')
  expect(card.querySelector('details, [role="region"], [aria-label="Bot note"], [aria-label="Tool result"]')).toBeNull()
  expect(card.textContent).not.toContain('[forgotten]')
  expect(card.textContent).not.toContain('Your service')
  expect(button('Send', card)).toBeUndefined()
})

it.each([
  ['changed', 'This changed since you saw it. Check it again before sending.', 'open'],
  ['paused', 'Resume Inbox helper to send this.', 'open'],
  ['expired', 'This expired, so nothing was sent.', 'expired'],
  ['withdrawn', 'No longer needed, so nothing was sent.', 'withdrawn'],
  ['work_ended', 'This work ended. Nothing was sent.', 'withdrawn'],
  ['owner_paused', 'This bot was paused, so nothing was sent.', 'withdrawn'],
  ['permission_changed', 'This tool or its permission changed, so nothing was sent.', 'withdrawn'],
  ['disabled', 'Withdrawn when asks first was turned off. Nothing was sent.', 'withdrawn'],
  ['owner_removed', 'You removed this request, so nothing was sent.', 'withdrawn'],
  ['binding_changed', 'This changed since you saw it. Nothing was sent.', 'withdrawn'],
  ['settled', 'This was already answered.', 'done'],
  ['gone', "This can't be sent any more.", 'gone'],
  ['unreachable', "Mail couldn't be reached. Nothing was sent. Try again when it is available.", 'open']
])('C4 integration renderer preserves the exact %s service refusal through the real client', async (reason, text, status) => {
  fake.chats.inbox = [held()]
  const { createPersonalBotsClient } = await import('../../src/renderer/services/personalBotsClient')
  const request = vi.fn(async () => {
    fake.chats.inbox = [status === 'gone' ? message(1, { id: 'held-message', text: 'Earlier request' }) : held({ status })]
    throw Object.assign(new Error(text), { code: `bot_action_${reason}` })
  })
  Object.assign(fake.client, { answerAction: createPersonalBotsClient({ request } as never).answerAction })
  await open()
  await click(button('Send', host.querySelector('[aria-label="Action to review"]')!))
  expect(request).toHaveBeenCalledExactlyOnceWith('bots.actions.answer', { botId: 'inbox', actionId: 'held-1', digest: 'shown-digest', answer: 'send' })
  expect(host.textContent).toContain(reason === 'expired' ? 'Expired · not sent' : text)
  const card = host.querySelector('[aria-label="Action to review"]')
  if (reason === 'gone') expect(card).toBeNull()
  else {
    expect(button('Send', card!) !== undefined).toBe(status === 'open')
    expect(button('Not now', card!) !== undefined).toBe(status === 'open')
  }
})

it('C4 integration bridge timeout stub has its outcome and computer explanation without an empty review fold', async () => {
  const text = "Mail couldn't be reached. Nothing was sent. Try again when it is available."
  fake.chats.inbox = [held({ status: 'failed', at: AT, tooLarge: true, args: null, hiddenPaths: [], result: { text, notSentInTime: true } })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.querySelector('[role="status"]')?.textContent).toContain(text.slice(0, -1))
  expect(card.querySelector('details, [role="region"]')).toBeNull()
  expect(card.textContent).toContain('Use the computer')
  expect(button('Send', card)).toBeUndefined()
})

it('C4 integration approved review names what it will send while waiting for the service', async () => {
  fake.chats.inbox = [held({ status: 'approved', at: AT })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.querySelector('summary')?.textContent).toBe('What it will send')
  expect(card.querySelector('[role="status"]')?.textContent).toContain('Waiting for Mail…')
  expect(card.textContent).not.toContain('What it is sending')
})

it.each(['Send', 'Not now'])('keeps the stored review intact when the device bot level refuses %s', async label => {
  fake.chats.inbox = [held()]
  const text = "Home doesn't let this device reach its bots."
  Object.assign(fake.client, { answerAction: vi.fn(async () => { throw Object.assign(new Error(text), { code: 'forbidden', details: { reason: 'bots_off' } }) }) })
  await open()
  await click(button(label, host.querySelector('[aria-label="Action to review"]')!))
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.textContent).toContain(text)
  expect(card.textContent).toContain('trip.pdf')
  expect(button('Send', card)?.disabled).toBe(false)
  expect(button('Not now', card)?.disabled).toBe(false)
  expect(card.querySelector('[aria-label="Tool result"]')).toBeNull()
  expect(fake.client.answerAction).toHaveBeenCalledExactlyOnceWith('inbox', 'held-1', 'shown-digest', label === 'Send' ? 'send' : 'not_now')
})

it('six adjacent expired schedule cards fold to one quiet line, keeping the waiting row', async () => {
  fake.chats[inbox.id] = [
    ...Array.from({ length: 6 }, (_, n) => message(n + 1, { id: 'expired-' + n, kind: 'notice', text: 'Expired · not sent', expiredActionSchedule: 'mail' })),
    message(7, { id: 'waiting', text: 'Waiting for your answer' })
  ]
  await open()
  expect(transcript().textContent).toContain('6 expired · not sent')
  expect(transcript().textContent).toContain('Waiting for your answer')
  expect([...host.querySelectorAll('[role="note"]')].filter(el => el.textContent?.includes('expired · not sent'))).toHaveLength(1)
})

it('a chat digest line separates expired-card folds and leaves the waiting row visible', async () => {
  fake.chats[inbox.id] = [
    message(1, { text: 'Expired · not sent', expiredActionSchedule: 'mail' }),
    message(2, { text: 'Older chat summarised', systemLine: true }),
    message(3, { text: 'Expired · not sent', expiredActionSchedule: 'mail' }),
    message(4, { text: 'Expired · not sent', expiredActionSchedule: 'mail' }),
    message(5, { text: 'Waiting for your answer' })
  ]
  await open()
  expect(transcript().textContent).toContain('Older chat summarised')
  expect(transcript().textContent).toContain('2 expired · not sent')
  expect(transcript().textContent).not.toContain('3 expired · not sent')
  expect(transcript().textContent).toContain('Waiting for your answer')
})

it('keeps only the newest review after two nudges, with earlier copies reduced to named asked-time lines', async () => {
  const copies = ['bm_action_one', 'bm_action_one_n1', 'bm_action_one_n2'].map((id, n) => message(n + 1, { id, at: new Date(Date.parse(AT) + n * 3600_000).toISOString(), text: 'Legacy review', action: action(), ...(n ? { replyTo: { id: 'bm_action_one', author: 'bot' as const, text: 'Original review' } } : {}) }))
  fake.chats.inbox = copies
  await open()
  expect(transcript().querySelectorAll('[aria-label="Action to review"]')).toHaveLength(1)
  const latest = transcript().querySelector('[data-message-id="bm_action_one_n2"]')!
  expect(latest.querySelector('[aria-label="Everything it will send"]')).toBeTruthy()
  expect(button('Send', latest)).toBeTruthy()
  const earlier = [...transcript().querySelectorAll('[role="note"]')].filter(item => item.textContent?.includes('Asked'))
  expect(earlier).toHaveLength(1)
  expect(transcript().textContent).toContain('Reminded')
  expect(latest.querySelector('time')?.getAttribute('datetime')).toBe(copies[0]!.at)
  for (const line of earlier) { expect(line.textContent).toContain('Send an email'); expect(line.querySelector('button, details, dl')).toBeNull() }
  await act(async () => fake.emit.message('inbox', { ...copies[2]!, action: { ...copies[2]!.action!, status: 'done', at: AT } }))
  expect(transcript().querySelectorAll('[aria-label="Action to review"]')).toHaveLength(1)
  expect(button('Send', transcript())).toBeUndefined()
})

it('keeps empty and unusual field names injective and reserves the non-ASCII note for address-shaped values', async () => {
  fake.chats.inbox = [held({ args: { '': 'empty key', '(no name)': 'literal label', '\n\n': 'newlines', '↵↵': 'literal arrows', '   ': 'spaces', 'имя': 'Анна', '名前': '太郎', 'tо': 'mixed key', to: 'аlice@example.test', wide: '＂false＂', french: '«false»', german: '„false„', blank: '   ' } })]
  await open()
  const region = host.querySelector('[aria-label="Everything it will send"]')!
  const label = (value: string) => [...region.querySelectorAll('dd')].find(item => item.textContent === value)!.previousElementSibling!
  expect(label('empty key').querySelector('[aria-label="Empty field name"]')).toBeTruthy()
  expect(label('literal label').textContent).toBe('"(no name)"')
  expect(label('newlines').textContent).toBe('"\\n\\n"')
  expect(label('literal arrows').textContent).toBe('"↵↵"')
  expect(label('spaces').textContent).toBe('"   "')
  for (const key of ['имя', '名前', 'tо']) {
    const name = [...region.querySelectorAll('dt')].find(item => item.textContent === key)!
    expect(name).toBeTruthy()
    expect(name.querySelector('[aria-label="Non-ASCII letters or digits"]')).toBeNull()
  }
  expect(region.querySelectorAll('[aria-label="Non-ASCII letters or digits"]')).toHaveLength(1)
  for (const text of ['＂false＂', '«false»', '„false„', '   ']) expect([...region.querySelectorAll('dd')].some(item => item.textContent === JSON.stringify(text))).toBe(true)
})

it('shows a settled card time once, trims timeout punctuation and avoids repeating an expired refusal', async () => {
  const sentence = "Mail couldn't be reached. Nothing was sent. Try again when it is available."
  fake.chats.inbox = [held({ status: 'failed', at: '2026-11-07T10:24:00.000Z', result: { text: sentence, notSentInTime: true } })]
  await open()
  const row = host.querySelector('[data-message-id="held-message"]')!
  expect(row.querySelectorAll('time')).toHaveLength(1)
  expect(row.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-07T10:24:00.000Z')
  expect(row.querySelector('[role="status"]')?.textContent).not.toContain('. ·')
  // Redraw to an open row, then let the service expire it during Send.
  await act(async () => fake.emit.message('inbox', held()))
  Object.assign(fake.client, { answerAction: vi.fn(async () => { fake.chats.inbox = [held({ status: 'expired', at: AT })]; throw Object.assign(new Error('This expired, so nothing was sent.'), { code: 'bot_action_expired' }) }) })
  await click(button('Send', host.querySelector('[aria-label="Action to review"]')!))
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.querySelectorAll('[role="status"]')).toHaveLength(1)
  expect(card.textContent).toContain('Expired · not sent')
  expect(card.textContent).not.toContain('This expired, so nothing was sent.')
})

it('expands adjacent expired schedule reviews inline without counting nudges or crossing a digest', async () => {
  const expired = (seq: number, id: string) => message(seq, { id: `bm_${id}`, text: 'Expired · not sent', expiredActionSchedule: 'mail', action: action({ actionId: id, title: 'Send an email', status: 'expired', at: AT }) })
  const first = expired(1, 'action_exp1')
  const nudge = (seq: number, suffix: number) => ({ ...first, seq, id: `${first.id}_n${suffix}`, expiredActionSchedule: undefined, replyTo: { id: first.id, author: 'bot' as const, text: 'Send an email' } })
  fake.chats.inbox = [first, nudge(2, 1), expired(3, 'action_exp2'), nudge(4, 2), expired(5, 'action_exp3'), message(6, { text: 'Older chat summarised', systemLine: true }), expired(7, 'action_exp4'), message(8, { id: 'waiting', text: 'Please review', action: action({ actionId: 'action_waiting' }) })]
  await open()
  const folds = [...transcript().querySelectorAll<HTMLDetailsElement>('details[aria-label="Expired action reviews"]')]
  expect(folds).toHaveLength(2)
  expect(folds[0]!.querySelector('summary')?.textContent).toBe('3 expired · not sent: Send an email')
  expect(folds[1]!.querySelector('summary')?.textContent).toBe('Expired · not sent: Send an email')
  expect(folds[0]!.open).toBe(false)
  expect(folds[0]!.querySelectorAll('[role=note]')).toHaveLength(1)
  await click(folds[0]!.querySelector('summary'))
  expect(folds[0]!.open).toBe(true)
  const cards = [...folds[0]!.querySelectorAll('[aria-label="Action to review"]')]
  expect(cards).toHaveLength(3)
  for (const card of cards) expect(card.querySelector('[aria-label="Asked time"] time')).toBeTruthy()
  expect(folds[0]!.querySelectorAll('.bot-system-line')).toHaveLength(0)
  for (const card of cards) { expect(card.querySelector('summary')?.textContent).toBe('What it would have sent'); expect(card.querySelector('[role="status"]')?.textContent).toContain('Expired · not sent'); expect(button('Send', card)).toBeUndefined() }
  expect(folds[0]!.querySelectorAll('[data-message-id="bm_action_exp1_n2"] [aria-label="Action to review"]')).toHaveLength(1)
  expect(transcript().querySelectorAll('[aria-label="Action to review"]')).toHaveLength(5)
  expect(transcript().textContent).not.toContain('4 expired · not sent')
  expect(button('Send', transcript().querySelector('[data-message-id="waiting"]')!)).toBeTruthy()
})

it('keeps a tool-error outcome readable when a device receives its category without answer text', async () => {
  fake.chats.inbox = [held({ status: 'failed', at: AT, tooLarge: true, args: null, hiddenPaths: [], result: { toolReportedError: true } })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  expect(card.querySelector('[role="status"]')?.textContent).toContain('The tool reported an error')
  expect(card.querySelector('[aria-label="Tool result"]')).toBeNull()
  expect(card.querySelectorAll('time')).toHaveLength(1)
})

it('omits a common action name when the expired schedule reviews describe different actions', async () => {
  fake.chats.inbox = ['Send an email', 'Delete a draft'].map((title, index) => message(index + 1, { expiredActionSchedule: 'mail', action: action({ actionId: `different-${index}`, title, status: 'expired', at: AT }) }))
  await open()
  const fold = host.querySelector<HTMLDetailsElement>('details[aria-label="Expired action reviews"]')!
  expect(fold.querySelector('summary')?.textContent).toBe('2 expired · not sent')
  await click(fold.querySelector('summary'))
  expect([...fold.querySelectorAll('[aria-label="Action summary"]')].map(item => item.textContent)).toEqual(['Send an email · Mail', 'Delete a draft · Mail'])
})

it('keeps an expiry fold closed to Send while a newer nudge still has its pre-expiry snapshot', async () => {
  const original = message(1, { id: 'bm_action_race', expiredActionSchedule: 'mail', action: action({ actionId: 'action_race', status: 'expired', at: AT }) })
  fake.chats.inbox = [original, message(2, { id: 'bm_action_race_n1', action: action({ actionId: 'action_race', status: 'open' }), replyTo: { id: original.id, author: 'bot', text: 'Review' } })]
  await open()
  const fold = host.querySelector<HTMLDetailsElement>('details[aria-label="Expired action reviews"]')!
  await click(fold.querySelector('summary'))
  const card = fold.querySelector('[aria-label="Action to review"]')!
  expect(card.querySelector('[role="status"]')?.textContent).toContain('Expired · not sent')
  expect(button('Send', card)).toBeUndefined()
  expect(card.querySelector('summary')?.textContent).toBe('What it would have sent')
  expect(fold.querySelectorAll('[aria-label="Action to review"]')).toHaveLength(1)
})

it('keeps one labelled asked time on an open review and replaces it with the settled outcome time', async () => {
  fake.chats.inbox = [held()]
  await open()
  const times = () => [...host.querySelectorAll('[data-message-id="held-message"] time')]
  expect(times()).toHaveLength(1)
  expect(times()[0]?.textContent).toContain('Asked')
  await act(async () => fake.emit.message('inbox', { ...held(), action: action({ status: 'done', at: AT }) } as never))
  expect(times()).toHaveLength(1)
  expect(times()[0]?.textContent).not.toContain('Asked')
  expect(host.querySelector('[data-message-id="held-message"] [role="status"]')?.textContent).toContain('Sent')
})

it.each([
  ['bot_action_paused', 'Resume Inbox helper to send this.'],
  [undefined, 'This could not be sent from here. Open it on the computer to see what happened.']
])('maps a device conflict %s locally instead of displaying its wire words', async (reason, expected) => {
  fake.chats.inbox = [held()]
  Object.assign(fake.client, { answerAction: vi.fn(async () => {
    throw Object.assign(new Error('WIRE WORDS MUST NOT APPEAR'), { code: 'conflict', ...(reason ? { details: { reason } } : {}) })
  }) })
  await open()
  await click(button('Send', host.querySelector('[aria-label="Action to review"]')!))
  expect(transcript().textContent).toContain(expected)
  expect(host.textContent).not.toContain('WIRE WORDS MUST NOT APPEAR')
  expect(button('Send', transcript())).toBeTruthy()
})

it('keeps the cached service name for a device refusal after its card disappears on reload', async () => {
  fake.chats.inbox = [held()]
  Object.assign(fake.client, { answerAction: vi.fn(async () => {
    fake.chats.inbox = [message(1, { id: 'held-message', text: 'Removed review', action: undefined } as never)]
    throw Object.assign(new Error('WIRE SERVICE MUST NOT APPEAR'), { code: 'conflict', details: { reason: 'bot_action_unreachable' } })
  }) })
  await open()
  await click(button('Send', host.querySelector('[aria-label="Action to review"]')!))
  expect(host.textContent).toContain("Mail couldn't be reached. Nothing was sent. Try again when it is available.")
  expect(host.textContent).not.toContain('WIRE SERVICE MUST NOT APPEAR')
  expect(host.querySelector('[aria-label="Action to review"]')).toBeNull()
})

it.each(['local', 'device'])('keeps the changed-schedule sentence and closes buttons on %s', async route => {
  fake.chats.inbox = [held()]
  Object.assign(fake.client, { answerAction: vi.fn(async () => {
    fake.chats.inbox = [held({ status: 'withdrawn' })]
    throw Object.assign(new Error('wire prose must not appear'), route === 'local' ? { code: 'bot_action_schedule_changed' } : { code: 'conflict', details: { reason: 'bot_action_schedule_changed' } })
  }) })
  await open()
  await click(button('Send', host.querySelector('[aria-label="Action to review"]')!))
  expect(host.textContent).toContain('This changed since you saw it. Nothing was sent.')
  expect(button('Send', transcript())).toBeUndefined()
})

describe('tagging another of the owner\'s bots with @', () => {
  const coxy = summary('coxy', { name: 'Coxy', description: 'Reviews pull requests.', look: { colour: 'teal', accessory: 'cap' } })
  const cobalt = summary('cobalt', { name: 'Cobalt', look: { colour: 'blue', accessory: 'beret' } })
  // A bot of another computer: this bot can't message it, so it is not offered.
  const far = summary('far', { name: 'Comet', lives: { node: 'node-b', name: 'Laptop' } })
  const list = () => host.querySelector('#composer-command-suggestions')
  /** The words a person reads: the faces' drawings (and their titles) left out. */
  const words = (element: Element | null | undefined) => {
    const copy = element?.cloneNode(true) as Element | undefined
    copy?.querySelectorAll('svg, canvas').forEach((drawing) => drawing.remove())
    return copy?.textContent
  }
  const rows = () => [...(list()?.querySelectorAll('[role="option"]') ?? [])].map(words)
  // A chip's words without the invisible marks and slots its token is made of.
  const chips = () => [...composer().querySelectorAll('.composer-bot-chip')].map((chip) => words(chip)?.replace(/[^\w]/g, ''))

  async function openWithBots() {
    fake.bots = [inbox, coxy, cobalt, far]
    await act(async () => useChatsStore.getState().activate('p1'))
    await act(async () => root.render(createElement(ChatWorkspace)))
    await act(async () => useChatsStore.getState().openBot(inbox.id))
  }

  it('@ lists the owner\'s other bots here, typing narrows them, and a pick leaves the bot\'s chip among the words', async () => {
    await openWithBots()
    await type(box(), 'ask @')
    expect(list()?.getAttribute('aria-label')).toBe('Bots to tag')
    // Not the bot this chat is with, nor one on another computer.
    expect(rows()).toEqual(['CoxyReviews pull requests.', 'CobaltWhat cobalt does.'])
    await type(box(), 'ask @cox')
    expect(rows()).toEqual(['CoxyReviews pull requests.'])
    await press('Enter')
    expect(list()).toBeNull()
    expect(chips()).toEqual(['Coxy'])
    expect(box().value.startsWith('ask ')).toBe(true)
    expect(box().value.endsWith(' ')).toBe(true)
  })

  it('sends the tag, which names the bot exactly; the sent message shows its face and name, which open its chat', async () => {
    await openWithBots()
    await type(box(), 'ask @Co')
    await press('Enter')
    await type(box(), `${box().value}for a second opinion`)
    await press('Enter')
    await settle()
    expect(fake.client.send).toHaveBeenCalledWith('inbox', 'ask [@Coxy](mousse://bot/coxy) for a second opinion', expect.any(String), [], undefined)
    const tag = transcript().querySelector<HTMLButtonElement>('.bot-you .bot-tag')
    expect(words(tag)).toBe('Coxy')
    expect(tag?.title).toBe("Open Coxy's chat")
    await click(tag)
    await settle()
    expect(useChatsStore.getState().activeBotId).toBe('coxy')
  })

  it('brings a sent tag back as its chip with Up; a tag of a bot that is gone reads as its name', async () => {
    fake.chats.inbox = [
      message(1, { author: 'owner', text: 'and [@Old](mousse://bot/gone) too' }),
      message(2, { author: 'owner', text: 'ask [@Coxy](mousse://bot/coxy) about it' })
    ]
    await openWithBots()
    await settle()
    expect(transcript().querySelector('.bot-you .bot-tag.is-gone')?.textContent).toBe('@Old')
    await press('ArrowUp')
    await settle()
    expect(chips()).toEqual(['Coxy'])
    expect(box().value).not.toContain('mousse://bot/')
  })
})

describe('a message from another of the owner\'s bots', () => {
  const alpha = summary('bot-alpha', { name: 'Alpha', look: { colour: 'green', accessory: 'beret' } })
  const text = '**Message from your bot Alpha**\n\n> The Mac nightly passed.\n>\n> The DMG is in `nightly/`.'
  async function openWith(row: { id: string; text: string }, sender = alpha) {
    fake.bots = [inbox, sender]
    fake.chats[inbox.id] = [
      message(1, { author: 'owner', text: 'Ask Alpha about the nightly.' }),
      message(2, { id: row.id, kind: 'notice', text: row.text }),
      message(3, { text: 'Alpha says the nightly passed.' })
    ]
    await act(async () => useChatsStore.getState().activate('p1'))
    await act(async () => root.render(createElement(ChatWorkspace)))
    await act(async () => useChatsStore.getState().openBot(inbox.id))
  }
  const sent = (id: string) => host.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!

  it('reads as that bot\'s own message: its name on top and its words, with no header or quote, and Copy takes the words alone', async () => {
    const id = 'bm_botmsg_bot-alpha_6f1c2a3b-0d4e-4f5a-9b6c-7d8e9f0a1b2c'
    await openWith({ id, text })
    expect(sent(id).textContent).toContain('Alpha')
    expect(sent(id).textContent).toContain('The Mac nightly passed.')
    expect(sent(id).textContent).not.toContain('Message from your bot')
    expect(sent(id).querySelector('blockquote')).toBeNull()
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await click(button('Copy', sent(id)))
    expect(writeText).toHaveBeenCalledWith('The Mac nightly passed.\n\nThe DMG is in `nightly/`.')
  })

  it('names the sender as it is called now', async () => {
    const id = 'bm_botmsg_bot-alpha_6f1c2a3b-0d4e-4f5a-9b6c-7d8e9f0a1b2c'
    await openWith({ id, text }, { ...alpha, name: 'Alpha Two' })
    expect(sent(id).textContent).toContain('Alpha Two')
  })

  it('draws a message kept before the sender\'s id was, by the name it holds', async () => {
    const id = 'bm_botmsg_6f1c2a3b-0d4e-4f5a-9b6c-7d8e9f0a1b2c'
    await openWith({ id, text })
    expect(sent(id).textContent).toContain('Alpha')
    expect(sent(id).textContent).toContain('The DMG is in')
    expect(sent(id).textContent).not.toContain('Message from your bot')
  })
})

// Settled identifiers use the first visible recipient/subject field, never hidden content.
it.each([
  [{ to: 'alex@example.test', subject: 'Later subject' }, 'alex@example.test'],
  [{ recipient: ['a@example.test', 'b@example.test'] }, 'a@example.test, b@example.test'],
  [{ email: 'a@example.test' }, 'a@example.test'],
  [{ channel: '#team' }, '#team'],
  [{ subject: 'One\nline' }, 'One line'],
  [{ title: 'A title' }, 'A title'],
  [{ to: { $mousse: 'hidden', text: 'hidden · will be sent' }, subject: 'Visible subject' }, 'Visible subject'],
  [{ nested: { subject: '<b>Plain</b>' } }, '<b>Plain</b>'],
  [{ body: 'No identifying field' }, undefined]
])('C10 settled cards identify their stored call: %j', async (args, expected) => {
  fake.chats.inbox = [held({ status: 'done', args })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  const identity = card.querySelector('[aria-label="Request identification"]')
  if (expected === undefined) expect(identity).toBeNull()
  else {
    expect(identity?.textContent).toBe(expected)
    expect(identity?.closest('details')).toBeNull()
    expect(identity?.querySelector('b, a')).toBeNull()
  }
})
it.each(['open', 'approved', 'running', 'forgotten'])('C10 no compact identifier for %s cards', async state => {
  fake.chats.inbox = [held(state === 'forgotten' ? { status: 'done', forgotten: true, args: null } : { status: state })]
  await open()
  expect(host.querySelector('[aria-label="Request identification"]')).toBeNull()
})

// Short body-like fields and any other short strings stay in place; either length bound folds.
it.each([
  ['body', 'See you at noon.', false], ['text', 'Short text', false],
  ['content', 'Short content', false], ['message', 'Short message', false],
  ['body', 'x'.repeat(280), false], ['body', 'x'.repeat(281), true],
  ['body', 'a\nb\nc\nd', false], ['body', 'a\nb\nc\nd\ne', true],
  ['subject', 'x'.repeat(281), true]
])('C10 folds %s only when its value is long (%s)', async (name, value, folds) => {
  fake.chats.inbox = [held({ args: { [name]: value } })]
  await open()
  const region = host.querySelector('[aria-label="Everything it will send"]')!
  expect(region.querySelector('details') !== null).toBe(folds)
  expect(region.textContent).toContain(value.replaceAll('\n', '↵\n'))
})

it('C10 review cold Send gives a local retry sentence and leaves both buttons live', async () => {
  fake.chats.inbox = [held()]
  Object.assign(fake.client, { answerAction: async () => { throw Object.assign(new Error('not owner-facing'), { code: 'bot_action_unreachable' }) } })
  await open()
  await click(button('Send'))
  expect(host.textContent).toContain("Mail couldn't be reached. Nothing was sent. Try again when it is available.")
  expect(button('Send')?.disabled).toBe(false)
  expect(button('Not now')?.disabled).toBe(false)
})
it('C10 review compact recipient carries the full review look-alike warning', async () => {
  fake.chats.inbox = [held({ status: 'done', args: { to: 'аlex@example.test' } })]
  await open()
  const card = host.querySelector('[aria-label="Action to review"]')!
  const warning = [...card.querySelectorAll('[aria-label="Non-ASCII letters or digits"]')].find(el => !el.closest('details'))
  expect(warning?.textContent).toContain('Contains letters or digits outside A–Z and 0–9')
})

it('R2 a timed-out Send is terminal while the card retains its stored timeout outcome', async () => {
  fake.chats.inbox = [held()]
  Object.assign(fake.client, { answerAction: async () => {
    fake.chats.inbox = [held({ status: 'failed', at: AT, result: { text: "Mail couldn't be reached, so nothing was sent.", notSentInTime: true } })]
    throw Object.assign(new Error('not owner-facing'), { code: 'bot_action_gone' })
  } })
  await open(); await click(button('Send'))
  expect(host.textContent).toContain("This can't be sent any more.")
  expect(host.textContent).not.toContain('Try again when it is available.')
  expect(button('Send')).toBeUndefined()
  expect(button('Not now')).toBeUndefined()
  expect(host.textContent).toContain("Mail couldn't be reached, so nothing was sent")
})

// Pasted credentials must remain in the composer's own state until the owner chooses.
describe('keeping a pasted key private', () => {
  const key = 'sk-E5SyntheticKeyForTestsOnly123456AAAAAAAAAAAAAAAA'
  const field = () => host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
  it.each([key, 'ghp_'+ 'A'.repeat(40), 'https://me:password@example.com'
  ])('offers to keep an unmistakable key: %s', async value => {
    await open(); await type(field(), value)
    expect(button('Keep as secret')).toBeTruthy()
    expect(fake.client.send).not.toHaveBeenCalled()
    expect(JSON.stringify(useBotsStore.getState())).not.toContain(value)
    expect(transcript().textContent).not.toContain(value)
  })
  it.each(['a'.repeat(64), '4fad019e-422c-4a1b-8f54-284951a51f37', 'a'.repeat(40), 'Please check the release'])('does not warn for IDs or prose: %s', async value => {
    await open(); await type(field(), value)
    expect(button('Keep as secret')).toBeUndefined()
  })
  it('replaces only the matched span before sending and uses the shared keep picker', async () => {
    const request = vi.fn(async () => ({ name: 'OPENAI_API_KEY_2' }))
    window.mousse.platformRequest = { request } as never
    await open(); await type(field(), `Use ${key} please`)
    await click(button('This thread only'))
    await click(button('Keep as secret'))
    expect(request).toHaveBeenCalledWith('secrets.keepPasted', { botId: 'inbox', value: key, keep: 'thread' })
    expect(field().value).toBe('Use the secret OPENAI_API_KEY_2 please')
    expect(fake.client.send).not.toHaveBeenCalled()
    await click(button('Send message'))
    expect(fake.client.send).toHaveBeenCalledWith('inbox', 'Use the secret OPENAI_API_KEY_2 please', expect.any(String), [], undefined)
  })
  it.each(['explicit', 'second send'])('sends unchanged only after %s consent', async choice => {
    await open(); await type(field(), key)
    if (choice === 'explicit') await click(button('Send as text'))
    else {
      await click(button('Send message'))
      expect(fake.client.send).not.toHaveBeenCalled()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('looks like a key')
    }
    await click(button('Send message'))
    expect(vi.mocked(fake.client.send).mock.calls[0]?.[1]).toBe(key)
  })
  it('a forbidden save explains it without sending; removing the key cancels the offer', async () => {
    window.mousse.platformRequest = { request: vi.fn(async () => { throw Object.assign(new Error("This bot is not set up yet, so it can't keep a key."), {code:'forbidden'}) }) } as never
    await open(); await type(field(), key); await click(button('Keep as secret'))
    expect(host.textContent).toContain("Inbox helper can't keep secrets")
    expect(host.querySelector('[role="status"]')?.textContent).not.toContain(key)
    expect(transcript().textContent).not.toContain(key)
    await click(button('Send message'))
    expect(fake.client.send).not.toHaveBeenCalled()
    await type(field(), '')
    expect(button('Keep as secret')).toBeUndefined()
    expect(JSON.stringify(useBotsStore.getState())).not.toContain(key)
  })
})

it('holds Send while a key is being kept and does not overwrite edits with a late answer', async () => {
  let answer!: (value: { name: string }) => void
  window.mousse.platformRequest = { request: vi.fn(() => new Promise(resolve => { answer = resolve })) } as never
  await open()
  const field = host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
  await type(field, 'sk-E5SyntheticKeyForTestsOnly123456AAAAAAAAAAAAAAAA')
  await click(button('Keep as secret'))
  await click(button('Send message'))
  expect(fake.client.send).not.toHaveBeenCalled()
  await type(field, 'Changed my mind')
  await act(async () => answer({ name: 'OPENAI_API_KEY' }))
  expect(field.value).toBe('Changed my mind')
  expect(fake.client.send).not.toHaveBeenCalled()
})

it.each([
 'Use AKIAIOSFODNN7EXAMPLE SECRET please',
 'Access key ID,Secret access key\nAKIAIOSFODNN7EXAMPLE,SECRET',
 '{"AccessKeyId":"AKIAIOSFODNN7EXAMPLE","SecretAccessKey":"SECRET"}',
 'AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"\nAWS_SECRET_ACCESS_KEY="SECRET"',
 'AWS Access Key ID [None]: AKIAIOSFODNN7EXAMPLE\nAWS Secret Access Key [None]: SECRET',
 'id is AKIAIOSFODNN7EXAMPLE and secret is SECRET',
 'SECRET  \n  AKIAIOSFODNN7EXAMPLE',
 'aws_secret_access_key = SECRET\nAKIAIOSFODNN7EXAMPLE'
])('keeping an AWS format removes its secret and permits Send: %s', async format => {
  const secret='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  window.mousse.platformRequest={request:vi.fn(async()=>({name:'AWS_SECRET_ACCESS_KEY'}))} as never
  await open()
  const field=host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
  await type(field, format.replace(/(?<!_)SECRET(?!_)/,secret))
  await click(button('Keep as secret'))
  expect(field.value).toContain('AKIAIOSFODNN7EXAMPLE')
  expect(field.value).toContain('the secret AWS_SECRET_ACCESS_KEY')
  expect(field.value).not.toContain(secret)
  await click(button('Send message'))
  expect(fake.client.send).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(fake.client.send.mock.calls)).not.toContain(secret)
})

it.each(['edit', 'switch'])('announces a late save after an %s and replaces a retained key', async action => {
  const key='sk-'+ 'L'.repeat(48)
  let answer!: (value:{name:string})=>void
  const request=vi.fn((method:string)=>method==='secrets.keepPasted'?new Promise(resolve=>{answer=resolve}):Promise.resolve({requests:[]}))
  window.mousse.platformRequest={request} as never
  await open()
  const field=()=>host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
  await type(field(), `Use ${key} please`)
  await click(button('Keep as secret'))
  if(action==='edit') await type(field(), `Actually use ${key} tomorrow`)
  else {
    fake.bots.push(summary('other'))
    await act(async()=>useBotsStore.setState({bots:[...fake.bots]}))
    await act(async()=>useChatsStore.getState().openBot('other'))
  }
  await act(async()=>answer({name:'OPENAI_API_KEY'}))
  if(action==='switch') await act(async()=>useChatsStore.getState().openBot('inbox'))
  expect(host.textContent).toContain('Kept as OPENAI_API_KEY')
  expect(field().value).toContain('the secret OPENAI_API_KEY')
  expect(field().value).not.toContain(key)
  expect(button('Keep as secret')).toBeUndefined()
  await type(field(), `Again ${key}`)
  expect(field().value).not.toContain(key)
  expect(request.mock.calls.filter(([method])=>method==='secrets.keepPasted')).toHaveLength(1)
  await click(button('Send message'))
  expect(JSON.stringify(fake.client.send.mock.calls)).not.toContain(key)
})
it('keeps a private draft across bot switches and merges applet text and memory quotes', async()=>{
  const key='sk-'+'D'.repeat(48)
  await open()
  const field=()=>host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
  await type(field(), `Please use ${key} tomorrow`)
  const {botAppletConversation}=await import('../../src/renderer/components/bots/BotApplets')
  await act(async()=>{botAppletConversation('inbox',{threadId:'home'}).addToDraft('Add the report');useBotsStore.getState().askAboutMemory('inbox','A remembered preference')})
  expect(field().value).toContain('Add the report')
  fake.bots.push(summary('other'))
  await act(async()=>useBotsStore.setState({bots:[...fake.bots]}))
  await act(async()=>useChatsStore.getState().openBot('other'))
  await act(async()=>useChatsStore.getState().openBot('inbox'))
  expect(field().value).toContain(key)
  expect(field().value).toContain('Add the report')
  expect(JSON.stringify(useBotsStore.getState())).not.toContain(key)
  window.mousse.platformRequest={request:vi.fn(async()=>({name:'OPENAI_API_KEY'}))} as never
  await click(button('Keep as secret'));await click(button('Send message'))
  const sent=vi.mocked(fake.client.send).mock.calls[0]![1]
  expect(sent).toContain('Add the report');expect(sent).toContain('A remembered preference');expect(sent).not.toContain(key)
})
it('keeps a late successful save visible even when the key was removed', async()=>{
  let answer!:(v:{name:string})=>void
  window.mousse.platformRequest={request:vi.fn(()=>new Promise(r=>{answer=r}))} as never
  await open();const field=host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
  await type(field,'sk-'+'N'.repeat(48));await click(button('Keep as secret'));await type(field,'Changed my mind')
  await act(async()=>answer({name:'OPENAI_API_KEY'}))
  expect(field.value).toBe('Changed my mind');expect(host.textContent).toContain('Kept as OPENAI_API_KEY')
})

it.each([
  ['secret_store_failed','The secret could not be saved. Nothing was stored.'],
  ['method_not_available','This method is unavailable.'],
  ['invalid_params','A secret holds at most 16 KB.']
])('shows the value-free %s failure instead of a permission instruction',async(code,message)=>{
  window.mousse.platformRequest={request:vi.fn(async()=>{throw Object.assign(new Error(message),{code})})} as never
  await open();const field=host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
  await type(field,'sk-'+'F'.repeat(48));await click(button('Keep as secret'))
  expect(host.textContent).toContain(message);expect(host.textContent).not.toContain("can't keep secrets")
  expect(fake.client.send).not.toHaveBeenCalled()
})
it('uses a fixed message for an error that echoes the secret',async()=>{
  const key='sk-'+'E'.repeat(48)
  window.mousse.platformRequest={request:vi.fn(async()=>{throw new Error(key)})} as never
  await open();const field=host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
  await type(field,key);await click(button('Keep as secret'))
  expect(host.textContent).toContain("Couldn't keep it. Nothing was saved.")
  expect(host.querySelector('[role="status"]')?.textContent).not.toContain(key)
})

it('explains the selected keep time beside the private paste offer',async()=>{
  const {secretKeepLine}=await import('../../src/shared/secretRequests')
  await open();await type(host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!,'sk-'+'K'.repeat(48))
  expect(host.textContent).toContain(secretKeepLine('day'))
  await click(button('This thread only'))
  expect(host.textContent).toContain(secretKeepLine('thread'))
})

it('keeps two different keys one at a time before the message is sent',async()=>{
  const first='sk-'+'M'.repeat(48),second='ghp_'+'G'.repeat(40)
  let n=0
  window.mousse.platformRequest={request:vi.fn(async(method:string)=>method==='secrets.keepPasted'?{name:++n===1?'OPENAI_API_KEY':'GITHUB_TOKEN'}:{requests:[]})} as never
  await open();const field=host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
  await type(field,first+' and '+second)
  await click(button('Keep as secret'))
  expect(field.value).toContain(second);expect(field.value).not.toContain(first)
  expect(button('Keep as secret')).toBeTruthy()
  await click(button('Keep as secret'))
  expect(field.value).toBe('the secret OPENAI_API_KEY and the secret GITHUB_TOKEN')
  await click(button('Send message'))
  expect(JSON.stringify(fake.client.send.mock.calls)).not.toContain(first)
  expect(JSON.stringify(fake.client.send.mock.calls)).not.toContain(second)
})

it('checks a key added directly to the store before Send in the same event',async()=>{
  await open();const field=host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
  await type(field,'Hello')
  const key='sk-'+'S'.repeat(48)
  await act(async()=>{useBotsStore.getState().setDraft('inbox',key);button('Send message')!.click()})
  expect(fake.client.send).not.toHaveBeenCalled()
  expect(JSON.stringify(useBotsStore.getState())).not.toContain(key)
})

it('asks for the AWS secret half without offering to keep a public ID',async()=>{
 await open();await type(host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!,'AKIAIOSFODNN7EXAMPLE')
 expect(button('Keep as secret')).toBeUndefined();expect(host.textContent).toContain('paste its secret access key too')
})
it.each(['edit','send'])('clears the kept notice on the next %s',async action=>{
 const key='sk-'+'T'.repeat(48)
 window.mousse.platformRequest={request:vi.fn(async()=>({name:'OPENAI_API_KEY'}))} as never
 await open();const field=host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
 await type(field,key);await click(button('Keep as secret'))
 expect(host.textContent).toContain('Kept as OPENAI_API_KEY')
 if(action==='edit') await type(field,'A different message')
 else await click(button('Send message'))
 expect(host.textContent).not.toContain('Kept as OPENAI_API_KEY')
 if(action==='send') {await type(field,key);expect(button('Keep as secret')).toBeTruthy()}
})
it('forgets the kept value after its day expires',async()=>{
 const key='sk-'+'V'.repeat(48)
 const clock=vi.spyOn(Date,'now');const start=Date.now();clock.mockReturnValue(start)
 try {
 window.mousse.platformRequest={request:vi.fn(async()=>({name:'OPENAI_API_KEY'}))} as never
 await open();const field=host.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')!
 await type(field,key);await click(button('Keep as secret'))
 clock.mockReturnValue(start+24*60*60*1000+1)
 await type(field,key);expect(field.value).toBe(key);expect(button('Keep as secret')).toBeTruthy()
 } finally {clock.mockRestore()}
})

it.each([
  [{ service: 'OpenAI', host: 'api.openai.com', readOnly: true }, 'OpenAI', false],
  [{ host: 'api.example.com', readOnly: true }, 'api.example.com', true]
] as const)('names the service on a private bound card above the bot composer: %s', async (binding, name, warning) => {
  const calls: string[] = []
  installPreload(fake, { platformRequest: { request: async (method: string) => {
    calls.push(method)
    if (method === 'secrets.requests.list') return { requests: [{ requestId: 'bound', threadId: 'home-key', label: 'API key', reason: 'Read updates', name: 'KEY', binding, savedExists: false }] }
    return {}
  } } })
  await open(summary('inbox', { name: 'Kai', homeThreadId: 'home-key' }))
  await settle()
  const card = host.querySelector('.bot-secret-requests .secret-request-card')!
  expect(card?.textContent).toContain(`For ${name}, read only. Kai can't see it or send it anywhere else.`)
  expect(card.textContent?.includes("Mousse can't tell what this service's reads do.")).toBe(warning)
  expect(card.textContent).toContain('Kai never sees it.')
  expect(card.textContent).not.toContain('The agent')
  expect(calls).toContain('secrets.requests.list')
})

it.each([
  ['thread', 'for this thread only, and deleted with the thread.'],
  ['day', 'for 24 hours, then deleted.'],
  ['saved', 'until you remove it in Settings → Agents → Secrets.']
] as const)('builds the bound keep sentence for %s without changing the ordinary agent line', async (keep, duration) => {
  const {secretKeepLine}=await import('../../src/shared/secretRequests')
  const bound=secretKeepLine(keep,{bound:'Kai'})
  expect(bound).toContain(duration)
  expect(bound).toContain('Kai never sees it.')
  expect(bound).not.toContain('The agent')
  expect(secretKeepLine(keep)).toContain('The agent can use it but never shows it in the chat.')
})

it('draws a let-alone consent and a natural answered line in the bot chat', async () => {
  const title = 'let ‘Sort new scans’ upload to Scans in Trial drive without asking'
  fake.chats.inbox = [
    message(1, { id: 'alone-open', text: 'May I?', ask: { askId: 'alone', title, note: 'Only this automation.', status: 'open' } }),
    message(2, { id: 'alone-answered', text: 'May I?', ask: { askId: 'answered', title, note: 'Only this automation.', status: 'allowed' } }),
    message(3, { id: 'alone-changed', text: 'May I?', ask: { askId: 'changed', title, note: 'This automation or tool changed. Nothing was allowed. Ask again.', status: 'withdrawn' } })
  ]
  await open()
  expect(transcript().querySelector('[data-message-id="alone-open"] .bot-bubble-ask')?.textContent).toBe('Wants to let ‘Sort new scans’ upload to Scans in Trial drive without asking')
  const answered = transcript().querySelector('[data-message-id="alone-answered"]')!
  expect(answered.nextElementSibling?.textContent).toBe('You let Inbox helper’s automation ‘Sort new scans’ upload to Scans in Trial drive without asking')
  expect(transcript().querySelector('[data-message-id="alone-changed"]')?.nextElementSibling?.textContent).toBe('This automation or tool changed. Nothing was allowed. Ask again.')
})

it('draws a non-upload automation consent and its answered line naturally', async () => {
  const title = 'let ‘Organise notes’ use Create page in Projects in Notion without asking'
  fake.chats.inbox = [
    message(1, { id: 'page-open', text: 'May I?', ask: { askId: 'page', title, status: 'open' } }),
    message(2, { id: 'page-answered', text: 'May I?', ask: { askId: 'page-done', title, status: 'allowed' } })
  ]
  await open()
  expect(transcript().querySelector('[data-message-id="page-open"] .bot-bubble-ask')?.textContent).toBe('Wants to let ‘Organise notes’ use Create page in Projects in Notion without asking')
  expect(transcript().querySelector('[data-message-id="page-answered"]')?.nextElementSibling?.textContent).toBe('You let Inbox helper’s automation ‘Organise notes’ use Create page in Projects in Notion without asking')
})
