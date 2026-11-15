// @vitest-environment jsdom
/**
 * A thread an agent started with `thread_create`: the new thread says "Started by an agent in «title»" at its top, and
 * the title opens the launching thread; the launcher's transcript shows the new thread as a chip with its live status,
 * whose click switches the main view to it, and Back returns. How the bar and the chip look is checked in the real app
 * (screenshots on the PR), not here.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))

import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { chatStatusFromPhase, mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { ThreadStartedByBar } from '../../src/renderer/components/ThreadStartedByBar'
import { EMPTY_THREAD_HISTORY, stepHistory, trackThreadHistory, useThreadHistoryStore } from '../../src/renderer/lib/threadHistory'
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
let stopHistory: (() => void) | undefined
// Like the main process, a select sends the thread's view, which shows the thread.
const select = vi.fn(async (threadId: string) => useAppStore.getState().applyThreadView({ threadId, messages: [], agents: [], tasks: [] }))
const text = () => host.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  ;(window as unknown as { mousse: unknown }).mousse = { threads: { select } }
  select.mockClear()
  useThreadHistoryStore.setState(EMPTY_THREAD_HISTORY)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  stopHistory?.()
  stopHistory = undefined
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

describe('the launching thread\'s note', () => {
  const prompt: ChatMessage = { id: 'u1', role: 'user', content: 'Split this into a new thread', timestamp: AT }
  const note: ChatMessage = {
    id: 'n1',
    role: 'system',
    content: 'Created thread «Audit the logs» (launched) in project p1: claude / sonnet, ask mode, the project folder.',
    timestamp: AT,
    launchedThread: { threadId: 'launched', summary: 'claude / sonnet, ask mode, the project folder' }
  }
  const reply: ChatMessage = { id: 'a1', role: 'assistant', content: 'Started it.', timestamp: AT }
  const show = (messages: ChatMessage[]) =>
    act(() => root.render(createElement(MessageList, { messages: mousseToUIMessages(messages), status: chatStatusFromPhase('idle') })))
  const chip = () => host.querySelector<HTMLAnchorElement>('a.thread-chip')

  it('shows the new thread as a link with its title and live status, beside what was chosen for it', () => {
    useAppStore.setState({ threads: [thread('launcher', 'Plan the release'), thread('launched', 'Audit the logs')], activeThreadId: 'launcher', threadActivity: { launched: 'processing' } })
    show([prompt, note, reply])
    const row = chip()!.closest('[role="note"]')!
    expect(row.textContent).toBe('Started Audit the logs · claude / sonnet, ask mode, the project folder')
    expect(chip()!.getAttribute('aria-label')).toBe('Open thread Audit the logs, Working')
    act(() => useAppStore.setState({ threadActivity: { launched: 'awaiting_input' } }))
    expect(chip()!.getAttribute('title')).toBe('Needs you · Open Audit the logs')
    act(() => useAppStore.setState({ threadActivity: { launched: 'completed' } }))
    expect(chip()!.getAttribute('title')).toBe('Done · Open Audit the logs')
    // A rename shows at once too.
    act(() => useAppStore.setState({ threads: [thread('launcher', 'Plan the release'), thread('launched', 'Audit the server logs')] }))
    expect(chip()!.textContent).toBe('Audit the server logs')
  })

  it('a click switches the main view to the new thread, and Back returns to the thread with the chip', async () => {
    useAppStore.setState({ threads: [thread('launcher', 'Plan the release'), thread('launched', 'Audit the logs')], activeThreadId: 'launcher', sidebarMode: 'projects' })
    stopHistory = trackThreadHistory()
    show([prompt, note, reply])
    await click(chip()!)
    expect(select).toHaveBeenCalledWith('launched')
    expect(useAppStore.getState().activeThreadId).toBe('launched')
    await act(async () => { await stepHistory(-1) })
    expect(useAppStore.getState().activeThreadId).toBe('launcher')
  })

  it('a note stored before the field shows no chip, whatever its text names', () => {
    useAppStore.setState({ threads: [thread('launcher', 'Plan the release'), thread('launched', 'Audit the logs')], activeThreadId: 'launcher' })
    const { launchedThread: _launched, ...older } = note
    show([prompt, older, reply])
    expect(chip()).toBeNull()
    expect(text()).toContain('Started it.')
  })
})
