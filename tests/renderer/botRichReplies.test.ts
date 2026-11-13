// @vitest-environment jsdom
/**
 * A bot's chat shows a reply as a thread's transcript does, through the same components: the thread's Markdown (a wide
 * table in its own scroller, code with Copy and Wrap), Read aloud and Copy, and the thread's applet card and panel, run
 * from the bot's thread. A reply shaped by a web page stays as inert as in a thread, and stricter about pictures: nothing
 * remote loads and nothing runs.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'
import type { AppletReference } from '../../src/shared/applets'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/chats/ChatResourcesPanel', () => ({ ChatResourcesPanel: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTranscript', () => ({ NetworkTranscript: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkChatActions', () => ({ NetworkChatActions: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTaskPicker', () => ({ NetworkTaskPicker: () => null }))
vi.mock('../../src/renderer/components/chats/ChatBrowserAccess', () => ({ ChatBrowserAccess: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { Markdown } = await import('../../src/renderer/chat/components/agent-elements/markdown')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

const budget: AppletReference = { appletId: 'applet_budget', revisionId: 'rev_1', sourceHash: 'hash-1', title: 'Budget', description: 'Monthly budget.' }
const HOME = 'bot-home-thread'

let root: Root
let host: HTMLElement
let fake: FakeBots
let applets: Record<string, ReturnType<typeof vi.fn>>
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()
const appInitial = useAppStore.getInitialState()
const trip = summary('trip', { name: 'Trip planner' })
const reply = () => host.querySelector<HTMLElement>('.chat-transcript .from-agent')!
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }); await settle() }

async function open() {
  fake.bots = [trip]
  await act(async () => useChatsStore.getState().activate('p1'))
  await act(async () => root.render(createElement(ChatWorkspace)))
  await act(async () => useChatsStore.getState().openBot(trip.id))
  await settle()
}

beforeEach(() => {
  fake = fakeBots()
  applets = {
    // The native guest never mounts here: these tests cover what is around it.
    mount: vi.fn(() => new Promise(() => {})),
    unmount: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    appearance: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({})),
    suspend: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
    get: vi.fn(async () => ({ source: { html: '<output></output>', css: '', js: '' } })),
    export: vi.fn(async () => {})
  }
  installPreload(fake, { applets, fs: { readAsset: vi.fn(async () => { throw new Error('no file') }) } })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
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
  vi.unstubAllGlobals()
  delete (window as { __botRan?: unknown }).__botRan
})

describe('a bot\'s reply, drawn as a thread\'s', () => {
  it('puts a wide table in its own scroller and gives code Copy and Wrap, with Read aloud and Copy under it', async () => {
    const columns = Array.from({ length: 9 }, (_, i) => `Day ${i + 1}`)
    const table = `| ${columns.join(' | ')} |\n|${columns.map(() => '---').join('|')}|\n| ${columns.map(() => 'Lisbon').join(' | ')} |`
    fake.chats.trip = [
      message(1, { author: 'owner', text: 'Plan it as a table.' }),
      message(2, { text: `Here:\n\n${table}\n\n\`\`\`ts\nconst trip = 'Lisbon'\n\`\`\`` })
    ]
    await open()
    expect(reply().querySelector('.an-md-table-wrap > table')?.querySelectorAll('th')).toHaveLength(9)
    const code = reply().querySelector<HTMLElement>('[data-streamdown="code-block"]')!
    expect(code.querySelector('button[aria-label="Copy Code"]')).not.toBeNull()
    expect(code.querySelector('.an-code-wrap')).not.toBeNull()
    const actions = [...reply().querySelectorAll('.bot-message-actions button')].map((button) => button.getAttribute('aria-label'))
    expect(actions).toEqual(['Read aloud', 'Copy'])
    // The owner's message can be copied too.
    expect(host.querySelector('.bot-you button[aria-label="Copy"]')).not.toBeNull()
  })

  it('shows an applet with the thread\'s card, whose name opens the thread\'s panel beside the chat, read from the bot\'s thread', async () => {
    fake.chats.trip = [message(1, { text: 'Your budget:', applets: [{ threadId: HOME, reference: budget }] })]
    await open()
    const card = reply().querySelector('section.mousse-applet[aria-label="Applet: Budget"]')!
    expect(card.querySelector('.mousse-applet-preview')).not.toBeNull()
    await click(card.querySelector('button.mousse-applet-name'))
    const pane = host.querySelector('aside.bot-applet-pane')!
    expect([...pane.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Restart', 'Source', 'Export HTML', 'Close']))
    await click(pane.querySelector('button[aria-label="Source"]'))
    expect(applets.get).toHaveBeenCalledWith({ threadId: HOME, appletId: budget.appletId, revisionId: budget.revisionId })
    // The thread's own side panel was not used: the chat stays on screen.
    expect(useAppStore.getState().documentTabs).toEqual([])
    await click(pane.querySelector('button[aria-label="Close"]'))
    expect(host.querySelector('aside.bot-applet-pane')).toBeNull()
  })
})

describe('a reply shaped by a web page', () => {
  it('loads nothing remote, runs nothing and links nothing unsafe', async () => {
    fake.chats.trip = [message(1, {
      text: [
        'Found it.',
        '<img src="https://tracker.example/a.gif" alt="pixel">',
        '<picture><source srcset="https://tracker.example/b.png"><img src="https://tracker.example/b.png" alt="b"></picture>',
        '<script>window.__botRan = true</script>',
        '<iframe src="https://tracker.example/frame"></iframe>',
        '<a href="javascript:window.__botRan = true">run</a> and [passwords](file:///etc/passwd)',
        '![chart](https://tracker.example/chart.png)'
      ].join('\n\n')
    })]
    await open()
    const shown = reply()
    for (const element of shown.querySelectorAll('[src], [srcset]')) {
      expect(element.getAttribute('src') ?? '').not.toMatch(/^(https?:)?\/\//)
      expect(element.getAttribute('srcset') ?? '').not.toMatch(/https?:/)
    }
    expect(shown.querySelector('script, iframe, source')).toBeNull()
    expect((window as { __botRan?: unknown }).__botRan).toBeUndefined()
    expect([...shown.querySelectorAll('a[href]')].some((link) => /^(javascript|file):/i.test(link.getAttribute('href')!))).toBe(false)
    // A web picture is a quiet link to it, never loaded.
    expect([...shown.querySelectorAll('a.bot-image-link')].map((link) => link.getAttribute('title'))).toEqual(expect.arrayContaining(['https://tracker.example/chart.png', 'https://tracker.example/a.gif']))
  })

  it('keeps the bot\'s rule for text a thread drew first', async () => {
    const text = 'The map: ![Map](https://example.com/map.png)'
    const thread = document.createElement('div')
    document.body.append(thread)
    const threadRoot = createRoot(thread)
    await act(async () => threadRoot.render(createElement(Markdown, { content: text })))
    expect(thread.querySelector('img')?.getAttribute('src')).toBe('https://example.com/map.png')
    fake.chats.trip = [message(1, { text })]
    await open()
    expect(reply().querySelector('img')).toBeNull()
    expect(reply().querySelector('a.bot-image-link')?.getAttribute('title')).toBe('https://example.com/map.png')
    act(() => threadRoot.unmount())
    thread.remove()
  })
})
