// @vitest-environment jsdom
/**
 * The Side chats panel and its tab: the list shows the open thread's side chats only, "New side chat" forks the
 * thread and opens the new chat in the panel, the tab then carries the chat's title behind a back chevron, and the
 * tab takes the panel back to the list.
 */
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainViewTabs } from '../../src/renderer/components/MainViewTabs'
import { SideChatsPanel } from '../../src/renderer/components/sideChats/SideChatsPanel'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useSideChatsStore } from '../../src/renderer/stores/sideChatsStore'
import type { Thread, ThreadLineage } from '../../src/shared/types'

// The transcript is not part of this check: the shell shows the composer.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return { MousseAgentChatShell: ({ composer }: { composer: never }) => create(ComposerNoticeProvider, null, composer) }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A bridge whose every call stays pending and every subscription is a no-op, with `overrides` on top. */
function bridge(overrides: Record<string, Record<string, unknown>>): unknown {
  const pending: Record<string, unknown> = {}
  pending.then = () => pending
  pending.catch = () => pending
  pending.finally = () => pending
  const node = (path: string[]): unknown => new Proxy(() => {}, {
    get: (_target, key) => {
      if (key === 'then') return undefined
      const own = path.length === 1 ? overrides[path[0]]?.[String(key)] : undefined
      return own ?? node([...path, String(key)])
    },
    apply: (_target, _this, args) => (path.at(-1)?.startsWith('on') ? () => {} : (void args, pending))
  })
  return node([])
}

let root: Root
let host: HTMLElement
const initialState = useAppStore.getState()

const thread = (id: string, name: string, lineage?: ThreadLineage, over: Partial<Thread> = {}): Thread => ({
  id, name, projectId: null, createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z', ...(lineage ? { lineage } : {}), ...over
}) as Thread
const sideOf = (parentThreadId: string): ThreadLineage => ({ parentThreadId, rootThreadId: parentThreadId, relationship: 'side' })
const text = (node: Element | null | undefined) => node?.textContent?.trim()

const newSideChat = vi.fn<(threadId: string) => Promise<{ threadId: string }>>()

const ASKED = { id: 'u1', role: 'user' as const, content: 'Fix the build', timestamp: '2026-11-18T10:00:00.000Z' }

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  newSideChat.mockReset()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  ;(window as unknown as { mousse: unknown }).mousse = bridge({ threads: { newSideChat } })
  useAppStore.setState({
    activeThreadId: 'parent',
    threads: [
      thread('parent', 'Fix the build'),
      thread('mine', 'Why is CI slow', sideOf('parent'), { lastReply: 'The cache misses.' } as Partial<Thread>),
      thread('ended', 'Old question', sideOf('parent'), { archivedAt: '2026-11-18T11:00:00.000Z' }),
      thread('theirs', 'Elsewhere', sideOf('other'))
    ],
    // The thread's first run has ended: there is something to fork.
    messages: [ASKED],
    openedSurfaceKinds: ['sideChats'],
    mainView: 'sideChats',
    mainAreaOpen: true,
    documentsTabVisible: false
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAppStore.setState(initialState, true)
  useSideChatsStore.setState({ openByParent: {}, transcripts: {} })
  vi.unstubAllGlobals()
})

const render = () => act(() => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(SideChatsPanel))))
const tab = () => [...host.querySelectorAll('.main-view-tab')].find((item) => item.querySelector('.main-view-tab-label'))!
const rowNames = () => [...host.querySelectorAll('.side-chats-list .lineage-name')].map(text)

describe('the Side chats panel', () => {
  it('lists the open thread\'s live side chats, forks a new one and opens it under a titled tab that goes back', async () => {
    render()
    expect(text(tab().querySelector('.main-view-tab-label'))).toBe('Side chats')
    expect(rowNames()).toEqual(['New side chat', 'Why is CI slow'])
    expect(text(host.querySelector('.side-chats-list .lineage-model'))).toBe('The cache misses.')

    newSideChat.mockResolvedValue({ threadId: 'fresh' })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.side-chats-new-row')!.click()
    })
    expect(newSideChat).toHaveBeenCalledWith('parent')
    // The new chat shows once the thread list carries it; until it is named it reads "New side chat".
    act(() => useAppStore.setState((state) => ({ threads: [...state.threads, thread('fresh', 'New chat', sideOf('parent'))] })))
    expect(host.querySelector('[data-side-chat]')).not.toBeNull()
    expect(host.querySelector('.side-chats-list')).toBeNull()
    expect(tab().classList.contains('is-side-chat')).toBe(true)
    expect(text(tab().querySelector('.main-view-tab-label'))).toBe('New side chat')
    expect(tab().querySelector('.main-view-tab-select')?.getAttribute('title')).toBe('New side chat (back to side chats)')

    act(() => tab().querySelector<HTMLButtonElement>('.main-view-tab-select')!.click())
    expect(host.querySelector('[data-side-chat]')).toBeNull()
    expect(text(tab().querySelector('.main-view-tab-label'))).toBe('Side chats')
  })

  it('keeps New side chat off until the thread has started and its first run ended', () => {
    useAppStore.setState({ threads: [thread('parent', 'Fix the build')], messages: [] })
    render()
    const button = () => host.querySelector<HTMLButtonElement>('.side-chats-new')!
    expect(button().disabled).toBe(true)
    expect(button().getAttribute('title')).toBe('Send this thread a message first')
    act(() => useAppStore.setState({ messages: [ASKED], turnStates: { parent: { threadId: 'parent', phase: 'thinking' } } as never }))
    expect(button().disabled).toBe(true)
    act(() => useAppStore.setState({ turnStates: {} }))
    expect(button().disabled).toBe(false)
    expect(button().getAttribute('title')).toBe('Fork this thread into a side chat')
  })

  it('shows the empty state, and says why a thread with nothing to fork has no side chat yet', async () => {
    useAppStore.setState({ threads: [thread('parent', 'Fix the build')] })
    render()
    expect(text(host.querySelector('.side-chats-empty > p'))).toBe('Ask on the side. Nothing here joins this thread.')

    newSideChat.mockRejectedValue(Object.assign(new Error('Nothing to fork'), { code: 'no_forkable_run' }))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.side-chats-new')!.click()
    })
    expect(text(host.querySelector('[role="alert"]'))).toBe('Nothing to fork yet: send this thread a message first.')
  })

  it('hides the permission chip while a side chat turn is running or awaiting input, and restores it when stopped', () => {
    useSideChatsStore.setState({ openByParent: { parent: 'mine' }, transcripts: { mine: [ASKED] } })
    render()
    expect(host.querySelector('.composer-permission-chip')).not.toBeNull()

    act(() => useAppStore.setState({ turnStates: { mine: { threadId: 'mine', turnId: 't1', phase: 'streaming', updatedAt: '' } } }))
    expect(host.querySelector('.composer-permission-chip')).toBeNull()
    expect(host.querySelector('button[aria-label="Stop run"]')).not.toBeNull()

    act(() => useAppStore.setState({ turnStates: { mine: { threadId: 'mine', turnId: 't1', phase: 'awaiting_input', updatedAt: '' } } }))
    expect(host.querySelector('.composer-permission-chip')).toBeNull()
    expect(host.querySelector('button[aria-label="Stop run"]')).not.toBeNull()

    act(() => useAppStore.setState({ turnStates: { mine: { threadId: 'mine', turnId: 't1', phase: 'stopped', updatedAt: '' } } }))
    expect(host.querySelector('.composer-permission-chip')).not.toBeNull()
  })
})
