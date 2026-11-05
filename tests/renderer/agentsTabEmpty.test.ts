// @vitest-environment jsdom
/**
 * The Agents tab when there is little to show: each empty section says one line, Recent stays hidden until there is
 * a chat, and with no agents both the sidebar and the pane offer to create one in Automations › Agents.
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
vi.mock('../../src/renderer/components/editors/MarkdownPreview', () => ({ MarkdownPreview: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
// Automations' sections, reduced to a mark: the tests only check which one is showing.
vi.mock('../../src/renderer/components/agentDefinitions/AgentDefinitionsWorkspace', () => ({ AgentDefinitionsWorkspace: () => null }))
vi.mock('../../src/renderer/components/workflows/WorkflowsWorkspace', () => ({ WorkflowsWorkspace: () => null }))
vi.mock('../../src/renderer/components/bots/BotsWorkspace', () => ({ BotsWorkspace: () => null }))
vi.mock('../../src/renderer/components/ScheduledPanel', () => ({ ScheduledPanel: () => null }))
vi.mock('../../src/renderer/components/chats/OpenNetworkChatDialog', async () => {
  const { createElement: h } = await import('react')
  return { OpenNetworkChatDialog: () => h('div', { 'data-testid': 'space-dialog' }) }
})

const { ChatsSidebar } = await import('../../src/renderer/components/chats/ChatsSidebar')
const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
const { AutomationsWorkspace } = await import('../../src/renderer/components/AutomationsWorkspace')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')

const agent: ChatAgent = { id: 'a1', name: 'Reviewer', slug: 'reviewer', purpose: '', definitionRevision: 'r1', deviceId: 'd1', available: true }
const direct = { id: 'c1', kind: 'direct', name: 'Reviewer', participants: [{ id: 'p1', kind: 'agent', name: 'Reviewer', definitionId: 'a1' }] } as unknown as ChatSummary

let root: Root
let host: HTMLElement
const appInitial = useAppStore.getInitialState()
const chatsInitial = useChatsStore.getInitialState()

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
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState({ scheduledOpen: appInitial.scheduledOpen, automationsSectionRequest: null })
  useChatsStore.setState(chatsInitial)
})

describe('the Agents tab sidebar', () => {
  it('says one line per empty section and hides Recent', () => {
    show(ChatsSidebar, [])
    expect(text('.chat-empty-hint')).toEqual(['No agents · Create one in Automations', 'No groups'])
    expect(text('.chat-section-heading h2')).toEqual(['Roster', 'Groups'])
    expect(host.textContent).not.toContain('Open a Space conversation')
  })

  it('opens Automations at Agents from the empty roster', () => {
    show(ChatsSidebar, [])
    click(button('Create one in Automations'))
    expect(useAppStore.getState().scheduledOpen).toBe(true)
    expect(useAppStore.getState().automationsSectionRequest).toEqual({ section: 'agents' })
  })

  it('offers New group only once there is an agent', () => {
    show(ChatsSidebar, [])
    expect(button('New group')).toBeUndefined()
    show(ChatsSidebar, [agent])
    expect(button('New group')?.getAttribute('title')).toBe('New group')
  })

  it('keeps Spaces one click away from the Groups heading', () => {
    show(ChatsSidebar, [])
    click(button('Open a Space'))
    expect(host.querySelector('[data-testid="space-dialog"]')).not.toBeNull()
  })

  it('shows Recent once there is a chat with an agent', () => {
    show(ChatsSidebar, [agent], [direct])
    expect(text('.chat-section-heading h2')).toEqual(['Roster', 'Groups', 'Recent'])
  })
})

describe('the Agents pane', () => {
  it('offers to create an agent while the roster is empty', () => {
    show(ChatWorkspace, [])
    expect(host.querySelector('.chat-workspace-empty p')).toBeNull()
    click(button('Create an agent'))
    expect(useAppStore.getState().automationsSectionRequest).toEqual({ section: 'agents' })
    expect(useChatsStore.getState().newChatOpen).toBe(false)
  })

  it('offers a new chat once an agent exists', () => {
    show(ChatWorkspace, [agent])
    expect(button('Create an agent')).toBeUndefined()
    expect(button('New chat')).toBeDefined()
  })
})

describe('Automations', () => {
  it('switches to the section another surface asks for', async () => {
    act(() => root.render(createElement(AutomationsWorkspace)))
    click(host.querySelector('#automations-bots-tab') ?? undefined)
    await act(async () => {})
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe('automations-bots-tab')
    act(() => useAppStore.getState().openAutomations('agents'))
    await act(async () => {})
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe('automations-agents-tab')
  })
})
