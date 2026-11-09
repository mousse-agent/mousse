// @vitest-environment jsdom
/**
 * The Agents tab when there is little to show: each empty section says one line, Recent stays hidden until there is
 * a chat, and with nothing to talk to the pane offers to make the first bot. The Automations Library keeps Agents and
 * Workflows, without a Bots tab.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAgent, ChatSummary } from '../../src/shared/chats'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The open conversation's neighbours read the daemon or load an editor; the empty pane never shows them.
vi.mock('../../src/renderer/components/chats/ChatResourcesPanel', () => ({ ChatResourcesPanel: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTranscript', () => ({ NetworkTranscript: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkChatActions', () => ({ NetworkChatActions: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTaskPicker', () => ({ NetworkTaskPicker: () => null }))
vi.mock('../../src/renderer/components/chats/ChatBrowserAccess', () => ({ ChatBrowserAccess: () => null }))
// A bot's chat has the thread composer, whose microphone pulls in audio worklets jsdom does not have.
vi.mock('../../src/renderer/dictation/microphone', () => ({}))
vi.mock('../../src/renderer/components/editors/MarkdownPreview', () => ({ MarkdownPreview: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
// Automations' sections, reduced to a mark: the tests only check which one is showing.
vi.mock('../../src/renderer/components/agentDefinitions/AgentDefinitionsWorkspace', () => ({ AgentDefinitionsWorkspace: () => null }))
vi.mock('../../src/renderer/components/workflows/WorkflowsWorkspace', () => ({ WorkflowsWorkspace: () => null }))
vi.mock('../../src/renderer/components/chats/OpenNetworkChatDialog', async () => {
  const { createElement: h } = await import('react')
  return { OpenNetworkChatDialog: () => h('div', { 'data-testid': 'space-dialog' }) }
})

const { ChatsSidebar } = await import('../../src/renderer/components/chats/ChatsSidebar')
const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { fakeBots, summary } = await import('./fakeBotsClient')

const agent: ChatAgent = { id: 'a1', name: 'Reviewer', slug: 'reviewer', purpose: '', definitionRevision: 'r1', deviceId: 'd1', available: true }
const direct = { id: 'c1', kind: 'direct', name: 'Reviewer', participants: [{ id: 'p1', kind: 'agent', name: 'Reviewer', definitionId: 'a1' }] } as unknown as ChatSummary

let root: Root
let host: HTMLElement
const appInitial = useAppStore.getInitialState()
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

function show(component: () => unknown, agents: ChatAgent[], chats: ChatSummary[] = []) {
  act(() => useChatsStore.setState({ snapshot: { agents, chats, devices: [] } }))
  act(() => root.render(createElement(component as () => null)))
}
const text = (selector: string) => [...host.querySelectorAll(selector)].map((element) => element.textContent)
const button = (label: string) => [...host.querySelectorAll('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const click = (element: Element | undefined) => act(() => { (element as HTMLElement).click() })

beforeEach(() => {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => { throw new Error('offline') })
  const group = () => new Proxy({}, { get: (_target, key: string) => call(key) })
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy({}, { get: () => group() })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setBotsClient(fakeBots().client)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState({ scheduledOpen: appInitial.scheduledOpen })
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
  setBotsClient(null)
})

describe('the Agents tab sidebar', () => {
  it('says one line per empty section and hides Recent', () => {
    show(ChatsSidebar, [])
    expect(text('.chat-empty-hint')).toEqual(['No bots yet. Press + to make one.', 'No groups'])
    expect(text('.chat-section-heading h2')).toEqual(['Bots', 'Groups'])
    expect(host.textContent).not.toContain('Open a Space conversation')
  })

  it('makes a bot from the + next to Bots, not from Automations', () => {
    show(ChatsSidebar, [])
    expect(button('Create agent')).toBeUndefined()
    click(button('New bot'))
    expect(useBotsStore.getState().newBotOpen).toBe(true)
    expect(useAppStore.getState().scheduledOpen).toBe(false)
  })

  it('offers New group only once there is an agent, and lists no agents where the bots are', () => {
    show(ChatsSidebar, [])
    expect(button('New group')).toBeUndefined()
    show(ChatsSidebar, [agent])
    expect(button('New group')?.getAttribute('title')).toBe('New group')
    expect(button('Message Reviewer')).toBeUndefined()
  })

  it('keeps Spaces one click away from the Groups heading', () => {
    show(ChatsSidebar, [])
    click(button('Open a Space'))
    expect(host.querySelector('[data-testid="space-dialog"]')).not.toBeNull()
  })

  it('shows Recent once there is a chat with an agent or a bot', () => {
    show(ChatsSidebar, [agent], [direct])
    expect(text('.chat-section-heading h2')).toEqual(['Bots', 'Groups', 'Recent'])
    show(ChatsSidebar, [])
    expect(text('.chat-section-heading h2')).toEqual(['Bots', 'Groups'])
    act(() => useBotsStore.setState({ bots: [summary('b1')] }))
    expect(text('.chat-section-heading h2')).toEqual(['Bots', 'Groups', 'Recent'])
  })
})

describe('the Agents pane', () => {
  it('offers to make the first bot while there are no chats and no bots', () => {
    show(ChatWorkspace, [agent])
    expect(text('.chat-workspace-empty h1')).toEqual(['Make your first bot'])
    expect(host.querySelector('.chat-workspace-empty .bot-face')).not.toBeNull()
    expect(button('Create an agent')).toBeUndefined()
    click(button('New bot'))
    expect(useBotsStore.getState().newBotOpen).toBe(true)
    expect(useChatsStore.getState().newChatOpen).toBe(false)
  })

  it('offers a new bot, and a new chat once an agent exists, when there is something to open', () => {
    setBotsClient(fakeBots({ bots: [summary('b1')] }).client)
    act(() => useBotsStore.setState({ bots: [summary('b1')] }))
    show(ChatWorkspace, [])
    expect(text('.chat-workspace-empty h1')).toEqual(['Talk to your bots and agents'])
    expect(button('New bot')).toBeDefined()
    expect(button('New chat')).toBeUndefined()
    show(ChatWorkspace, [agent])
    expect(button('New chat')).toBeDefined()
  })
})
