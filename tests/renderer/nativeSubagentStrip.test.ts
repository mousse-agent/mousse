// @vitest-environment jsdom
/**
 * Native subagents (Claude Code's own `Agent` calls) in the composer's background strip: each running one is listed by
 * name with its provider's circle, counts as a subagent rather than an anonymous command, and opens a live page of
 * its calls where a pill stands in for the composer.
 */
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundWorkRow, backgroundLines, stripCounts } from '../../src/renderer/components/BackgroundWorkRow'
import { NativeSubagentPage } from '../../src/renderer/components/NativeSubagentPage'
import { TitleBarNav } from '../../src/renderer/components/TitleBarNav'
import { setThreadPathInTitleBar } from '../../src/renderer/lib/threadPathSetting'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useNativeSubagentViewStore } from '../../src/renderer/stores/nativeSubagentViewStore'
import { backgroundHeadline, type ThreadBackgroundWork } from '../../src/shared/backgroundWork'
import type { SubagentCardModel } from '../../src/renderer/chat/adapters/subagentCards'
import type { AgentActivityItem } from '../../src/shared/agentActivity'
import type { ChatMessage, Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-11-26T09:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const RUN = 'run:thread:t1:ordinal:1'

const user = (id: string, seconds: number, content: string): ChatMessage =>
  ({ id, role: 'user', content, timestamp: at(seconds), turnId: RUN }) as ChatMessage
const row = (id: string, seconds: number, activity: Partial<AgentActivityItem> & { kind: AgentActivityItem['kind'] }): ChatMessage =>
  ({
    id,
    role: 'system',
    kind: 'mcp_tool_call',
    content: '',
    timestamp: at(seconds),
    turnId: RUN,
    toolCall: { title: activity.toolName ?? 'Agent', summary: activity.toolName ?? 'Agent', details: [], status: 'complete' },
    activity: { id, callId: `toolu_${id}`, toolName: 'Agent', status: 'done', startedAt: at(seconds), runId: RUN, ...activity }
  }) as ChatMessage

const explore = (id: string, description: string, status: 'running' | 'done' = 'running') =>
  row(id, 1, { kind: 'subagent', agentType: 'Explore', description, status, prompt: `Find ${description}`, ...(status === 'done' ? { summary: 'Found it', endedAt: at(9) } : {}) } as never)
const call = (id: string, seconds: number, parentId: string, status: 'running' | 'done' = 'done') =>
  row(id, seconds, { kind: 'command', toolName: 'Bash', command: `rg ${id}`, output: 'ok', parentId, status } as never)

const nativeCard = (toolCallId: string, state: 'working' | 'done'): SubagentCardModel => ({
  toolCallId, pending: false, childThreadId: null, delegationId: null, title: `Agent ${toolCallId}`, state, provider: null, model: null,
  continued: false, latest: true, waitingOn: [], exact: true, createdAt: T0, completedAt: state === 'done' ? T0 + 1000 : null,
  native: { agentType: 'Explore', model: null, taskId: null, result: null }
})
const providerWork = (on: boolean): ThreadBackgroundWork => ({ threadId: 't1', items: [], providerWork: on })
const actions = { stopSubagent: vi.fn(), stopItem: vi.fn(), openNative: vi.fn() }

describe('native subagents in the strip', () => {
  it.each([
    // [running native, provider work, headline, lines]
    [0, true, 'Waiting on 1 command', ['Agent background work']],
    [1, true, 'Waiting on 1 subagent', ['Agent n1']],
    [2, true, 'Waiting on 2 subagents', ['Agent n1', 'Agent n2']],
    // An agent of the turn running now: there is no provider background work, it still shows.
    [1, false, 'Waiting on 1 subagent', ['Agent n1']]
  ])('%i running, provider work %s → %s', (running, provider, headline, titles) => {
    const cards = [nativeCard('n1', 'working'), nativeCard('n2', 'working')].slice(0, running).concat(nativeCard('old', 'done'))
    expect(backgroundHeadline(stripCounts(providerWork(provider), 0, running))).toBe(headline)
    const lines = backgroundLines([], providerWork(provider), actions, { native: cards, inheritedProvider: 'claude' })
    expect(lines.map((line) => line.title)).toEqual(titles)
  })

  it('draws a native subagent with its provider circle, opens its page and has no Stop of its own', () => {
    const [line] = backgroundLines([], providerWork(true), actions, { native: [nativeCard('n1', 'working')], inheritedProvider: 'claude' })
    expect(line!.mark).toEqual({ kind: 'avatar', providerId: 'claude', tone: 'running' })
    expect(line!.stop).toBeUndefined()
    line!.open!()
    expect(actions.openNative).toHaveBeenCalledWith('n1')
  })
})

describe('the native subagent page', () => {
  let host: HTMLDivElement
  let root: Root
  const messages = [
    user('u1', 0, 'Look into the picker'),
    explore('a1', 'picker code'),
    call('c1', 2, 'a1'),
    call('c2', 3, 'c1', 'running'),
    call('other', 4, 'zz')
  ]

  beforeEach(() => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { mousse: unknown }).mousse = {
      orchestrator: { abort: vi.fn(), getMessages: async () => [] },
      threads: { stopBackground: vi.fn() }
    }
    useAppStore.setState({
      activeThreadId: 't1',
      messages,
      turnStates: { t1: { phase: 'streaming', turnId: RUN } } as never,
      sidebarMode: 'projects',
      threads: [{ id: 't1', name: 'Fix the picker', projectId: 'p1', createdAt: at(0), updatedAt: at(0), order: 0, startedAt: at(0) } as Thread],
      projects: [{ id: 'p1', name: 'acme-web', path: '/work/acme-web', createdAt: at(0) } as Project]
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useAppStore.setState(useAppStore.getInitialState())
    useNativeSubagentViewStore.setState({ open: null })
    setThreadPathInTitleBar(true)
  })

  const click = (element: Element | null | undefined) => act(() => { (element as HTMLElement).click() })

  const pathNames = () => [...host.querySelectorAll('nav[aria-label="Thread path"] .titlebar-path-name')].map((name) => name.textContent)

  it('opens from the strip on its task and calls, streams new calls, and goes back to the chat from its path', async () => {
    await act(async () => root.render(createElement(Fragment, null,
      createElement(TitleBarNav),
      createElement(BackgroundWorkRow, { threadId: 't1', subagents: [], work: providerWork(true), onStopAll: () => undefined }),
      createElement(NativeSubagentPage, { threadId: 't1' }))))
    expect(host.textContent).toContain('Waiting on 1 subagent')
    expect(pathNames()).toEqual(['acme-web', 'Fix the picker'])
    // The closed row names the subagent too; its line is in the list Details opens.
    expect(host.querySelector('.background-work-summary')!.textContent).toContain('Waiting on 1 subagent · picker code')
    click(host.querySelector('.background-work-summary[aria-expanded="false"]'))
    click([...host.querySelectorAll('ul[aria-label="What runs in the background"] button')].find((button) => button.textContent?.includes('picker code')))

    const page = () => host.querySelector('section[aria-label="picker code, native subagent"]')
    expect(page()).not.toBeNull()
    expect(page()!.textContent).toContain('Find picker code')
    // Its own calls at every depth, not another agent's.
    expect(page()!.textContent).toContain('rg c1')
    expect(page()!.textContent).toContain('rg c2')
    expect(page()!.textContent).not.toContain('rg other')
    expect(page()!.querySelector('[role="note"]')!.textContent).toContain('only its agent can direct it')
    // The title bar's path goes one step down to the subagent; the page has no back button or breadcrumb of its own.
    expect(pathNames()).toEqual(['acme-web', 'Fix the picker', 'picker code'])
    expect(host.querySelector('[data-segment="current"] [aria-current="page"]')!.textContent).toBe('picker code')
    expect(page()!.querySelector('.native-subagent-breadcrumb')).toBeNull()
    expect(page()!.querySelector('button[aria-label="Back to chat"]')).toBeNull()

    // A call the subagent makes next shows on the open page.
    act(() => useAppStore.setState({ messages: [...messages, call('c3', 5, 'a1')] }))
    expect(page()!.textContent).toContain('rg c3')

    // Its thread, one step up the path, is the way back to the chat.
    click([...host.querySelectorAll('nav[aria-label="Thread path"] button')].find((button) => button.textContent === 'Fix the picker'))
    expect(page()).toBeNull()
    expect(pathNames()).toEqual(['acme-web', 'Fix the picker'])
    expect(useAppStore.getState().activeThreadId).toBe('t1')
  })

  it('shows project / thread / subagent on the page when the title bar path is off, and Escape goes back', async () => {
    setThreadPathInTitleBar(false)
    useNativeSubagentViewStore.setState({ open: { threadId: 't1', toolCallId: 'a1' } })
    await act(async () => root.render(createElement(NativeSubagentPage, { threadId: 't1' })))
    const crumbs = host.querySelector('nav[aria-label="Subagent location"]')!
    expect(crumbs.textContent).toBe('acme-web/Fix the picker/picker code')
    expect(crumbs.querySelector('[aria-current="page"]')!.textContent).toBe('picker code')
    click(crumbs.querySelector('button[title="Open Fix the picker"]'))
    expect(host.querySelector('.native-subagent-page')).toBeNull()

    act(() => useNativeSubagentViewStore.setState({ open: { threadId: 't1', toolCallId: 'a1' } }))
    const page = host.querySelector<HTMLElement>('.native-subagent-page')!
    expect(document.activeElement).toBe(page)
    act(() => { page.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(host.querySelector('.native-subagent-page')).toBeNull()
  })

  it('closes when another thread is opened', async () => {
    useNativeSubagentViewStore.setState({ open: { threadId: 't1', toolCallId: 'a1' } })
    await act(async () => root.render(createElement(NativeSubagentPage, { threadId: 't1' })))
    expect(host.querySelector('.native-subagent-page')).not.toBeNull()
    await act(async () => root.render(createElement(NativeSubagentPage, { threadId: 't2' })))
    expect(host.querySelector('.native-subagent-page')).toBeNull()
    expect(useNativeSubagentViewStore.getState().open).toBeNull()
  })
})
