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
import { StartedThreadsList } from '../../src/renderer/components/sideCard/StartedThreadsSection'
import { launchedThreadsOf } from '../../src/renderer/components/sideCard/lineageLogic'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useBotsStore } from '../../src/renderer/stores/botsStore'
import { NO_COMPUTERS, useComputersStore } from '../../src/renderer/lib/computers'
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

describe('a thread an agent keeps out of the sidebar', () => {
  it('says Hidden, and Show in sidebar lists it again', async () => {
    const request = vi.fn(async (_method: string, params: { threadId: string }) => ({ thread: thread(params.threadId, 'Audit the logs', { createdByThreadId: 'launcher' }) }))
    ;(window as unknown as { mousse: unknown }).mousse = { threads: { select }, platformRequest: { request } }
    useAppStore.setState({ threads: [thread('launcher', 'Plan the release'), thread('launched', 'Audit the logs', { createdByThreadId: 'launcher', hidden: true })], activeThreadId: 'launched' })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(text()).toBe('Started by an agent in «Plan the release» · HiddenShow in sidebar')
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Show in sidebar')!)
    expect(request).toHaveBeenCalledWith('threads.setHidden', { threadId: 'launched', hidden: false })
    expect(useAppStore.getState().threads.find((entry) => entry.id === 'launched')?.hidden).toBeUndefined()
    expect(text()).toBe('Started by an agent in «Plan the release»')
  })

  it('started from another computer, it names the agent\'s thread and that computer, with nothing to open here', () => {
    useAppStore.setState({ threads: [thread('far', 'Linux tests', { hidden: true, startedFrom: { node: 'n1', agent: { thread: 'x', title: 'Yo', mode: 'auto' } } })], activeThreadId: 'far' })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(text()).toBe('Started by an agent in «Yo» on another computer · HiddenShow in sidebar')
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Show in sidebar'])
  })
})

describe('above a subagent an agent on another computer started here', () => {
  const pc = 'nod_' + 'a'.repeat(26)
  const subagent = { node: pc, agent: { thread: 'x', title: 'Yo', mode: 'auto' as const, subagent: true as const } }

  it('shows no bar while its parent there is listed: the title bar\'s path names it, as for a subagent of this computer', () => {
    useAppStore.setState({ threads: [thread(`${pc}:x`, 'Yo', { node: pc }), thread('far', 'Linux tests', { hidden: true, startedFrom: subagent })], activeThreadId: 'far' })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(text()).toBe('')
  })

  it('still names the agent\'s thread and computer while that thread is not listed here', () => {
    useAppStore.setState({ threads: [thread('far', 'Linux tests', { startedFrom: subagent })], activeThreadId: 'far' })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(text()).toBe('Started by an agent in «Yo» on another computer')
  })
})

// #2004 T4: a thread an agent or a bot of one computer started on another, seen on each.
describe('a thread started from another computer', () => {
  const computers = (self: string) => useComputersStore.setState({ ...NO_COMPUTERS, loaded: true, routed: true, byNode: { n1: { node: 'n1', name: 'Laptop', online: true } } as never, devices: [{ node: self, self: true } as never] })
  afterEach(() => useComputersStore.setState(NO_COMPUTERS))

  it('on the computer that runs a bot\'s thread: "Started by <bot> on <computer>", with nothing to open, and Show in sidebar while hidden', () => {
    computers('n2')
    const started = { startedByBot: { botId: 'bot-pip', name: 'Pip', node: 'n1' }, startedFrom: { node: 'n1', agent: { thread: 'pip-chat', title: 'Pip', mode: 'auto' as const } } }
    useAppStore.setState({ threads: [thread('far', 'Build', started)], activeThreadId: 'far' })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(text()).toBe('Started by Pip on Laptop')
    expect(host.querySelector('button')).toBeNull()
    act(() => useAppStore.setState({ threads: [thread('far', 'Build', { ...started, hidden: true })] }))
    expect(text()).toBe('Started by Pip on Laptop · HiddenShow in sidebar')
  })

  it('on the computer whose agent started it there: "Started by an agent in «title»", which opens the launching thread here', async () => {
    computers('self')
    useAppStore.setState({
      threads: [thread('launcher', 'Plan the release'), thread('n1:far', 'Linux tests', { node: 'n1', startedFrom: { node: 'self', agent: { thread: 'launcher', title: 'Plan', mode: 'auto' } } })],
      activeThreadId: 'n1:far'
    })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(text()).toBe('Started by an agent in «Plan the release»')
    await click(host.querySelector('button')!)
    expect(select).toHaveBeenCalledWith('launcher')
  })
})

describe('the launching thread\'s side panel', () => {
  it('lists the threads its agent started, here and on another computer, newest first, marking the hidden ones; its remote subagents stay in Nest', () => {
    const later = '2026-11-15T11:00:00.000Z'
    const rows = launchedThreadsOf([
      thread('launcher', 'Plan the release'),
      thread('mine', 'My own work'),
      thread('l1', 'Audit the logs', { createdByThreadId: 'launcher', hidden: true }),
      thread('l2', 'Release notes', { createdByThreadId: 'launcher', updatedAt: later }),
      thread('n1:f1', 'Linux tests', { node: 'n1', startedFrom: { node: 'self', agent: { thread: 'launcher', title: 'Plan the release', mode: 'auto' } } }),
      thread('old', 'Archived run', { createdByThreadId: 'launcher', archivedAt: later }),
      thread('bot', 'Bot job', { createdByThreadId: 'launcher', startedByBot: { botId: 'b1', name: 'Alpha' } })
    ], 'launcher')
    expect(rows.map((row) => row.id)).toEqual(['l2', 'l1', 'n1:f1'])
    const opened: string[] = []
    act(() => root.render(createElement(StartedThreadsList, { threads: rows, computerOf: () => ({ name: 'Linux box', online: true }), onOpen: (id: string) => opened.push(id) })))
    expect([...host.querySelectorAll('.lineage-row')].map((row) => row.textContent)).toEqual(['Release notes', 'Audit the logsHidden', 'Linux testsLinux box'])
    act(() => (host.querySelectorAll('.lineage-row')[2] as HTMLElement).click())
    expect(opened).toEqual(['n1:f1'])
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
