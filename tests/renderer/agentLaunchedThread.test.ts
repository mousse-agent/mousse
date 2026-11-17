// @vitest-environment jsdom
/**
 * A thread an agent started with `thread_create`: the new thread says "Started by an agent in «title»" at its top, and
 * the title opens the launching thread. The launcher's chat adds no line of Mousse's own for it: the agent's reply names
 * the new thread. How the bar looks is checked in the real app (screenshots on the PR), not here.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))

import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { chatStatusFromPhase, mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { ThreadStartedByBar } from '../../src/renderer/components/ThreadStartedByBar'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useBotsStore } from '../../src/renderer/stores/botsStore'
import type { BotSummary } from '../../src/shared/bots/personal/chat'
import type { ChatMessage, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AT = '2026-11-15T10:00:00.000Z'
const thread = (id: string, name: string, extra: Partial<Thread> = {}): Thread => ({ id, name, createdAt: AT, updatedAt: AT, startedAt: AT, projectId: 'p1', ...extra }) as Thread
const appInitial = useAppStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

let root: Root
let host: HTMLElement
// Like the main process, a select sends the thread's view, which shows the thread.
const select = vi.fn(async (threadId: string) => useAppStore.getState().applyThreadView({ threadId, messages: [], agents: [], tasks: [] }))
const text = () => host.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  ;(window as unknown as { mousse: unknown }).mousse = { threads: { select } }
  select.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(appInitial)
  useBotsStore.setState(botsInitial)
  vi.unstubAllGlobals()
})

describe('above a thread an agent started', () => {
  it('"Started by an agent in «title»"; the title is a button that opens the launching thread', async () => {
    useAppStore.setState({ threads: [thread('launcher', 'Plan the release'), thread('launched', 'Audit the logs', { createdByThreadId: 'launcher' })], activeThreadId: 'launched' })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(text()).toBe('Started by an agent in «Plan the release»')
    const button = host.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('Open Plan the release, the thread that started this one')
    await click(button)
    expect(select).toHaveBeenCalledWith('launcher')
    expect(useAppStore.getState().activeThreadId).toBe('launcher')
  })

  it('a launcher that is no longer listed is named as gone, with nothing to open, once the bots say it is not one of theirs', () => {
    useAppStore.setState({ threads: [thread('launched', 'Audit the logs', { createdByThreadId: 'deleted-launcher' })], activeThreadId: 'launched' })
    // A bot's chat thread is not listed either: until the bots are read, the bar says nothing rather than something wrong.
    useBotsStore.setState({ bots: [], loaded: false, refresh: vi.fn(async () => undefined) })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(text()).toBe('')
    expect(useBotsStore.getState().refresh).toHaveBeenCalled()
    act(() => useBotsStore.setState({ bots: [], loaded: true }))
    expect(text()).toBe('Started by an agent in a thread that is no longer here')
    expect(host.querySelector('button')).toBeNull()
    // The same unlisted launcher, when it is a bot's chat, is that bot's line.
    act(() => useBotsStore.setState({ bots: [{ id: 'b1', name: 'Alpha', homeThreadId: 'deleted-launcher' } as BotSummary], loaded: true }))
    expect(text()).toBe('Started by Alpha')
  })
})

describe('the launching thread\'s chat', () => {
  it('shows the agent\'s reply and no line of Mousse\'s own for the thread it started', () => {
    useAppStore.setState({ threads: [thread('launcher', 'Plan the release'), thread('launched', 'Audit the logs')], activeThreadId: 'launcher' })
    // The note Mousse keeps in the launcher's record, as `thread_create` writes it.
    const note: ChatMessage = {
      id: 'n1',
      role: 'system',
      content: 'Created thread «Audit the logs» (launched) in project p1: claude / sonnet, ask mode, the project folder, first message sent.',
      timestamp: AT,
      launchedThread: { threadId: 'launched', summary: 'claude / sonnet, ask mode, the project folder, first message sent' }
    }
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'Split this into a new thread', timestamp: AT },
      note,
      { id: 'a1', role: 'assistant', content: 'Started it.', timestamp: AT }
    ]
    act(() => root.render(createElement(MessageList, { messages: mousseToUIMessages(messages), status: chatStatusFromPhase('idle') })))
    expect(text()).toContain('Started it.')
    expect(text()).not.toContain('Audit the logs')
    expect(text()).not.toContain('claude / sonnet')
    expect(host.querySelector('[role="note"]')).toBeNull()
  })
})
