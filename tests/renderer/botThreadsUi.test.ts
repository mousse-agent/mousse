// @vitest-environment jsdom
/**
 * What the owner sees of "use your threads": a chip in the bot's chat for a thread it started ("started thread · <title>")
 * whose Open shows that thread, and one line above a thread a bot started, "Started by <bot>", whose name opens the bot's
 * chat. How they look is checked in the real app (screenshots on the PR), not here.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotChips } from '../../src/renderer/components/bots/BotChips'
import { ThreadStartedByBar } from '../../src/renderer/components/ThreadStartedByBar'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useBotsStore } from '../../src/renderer/stores/botsStore'
import { useChatsStore } from '../../src/renderer/stores/chatsStore'
import { rollUpChips } from '../../src/shared/bots/personal/chips'
import type { BotSummary } from '../../src/shared/bots/personal/chat'
import type { Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = '2026-11-13T10:00:00.000Z'

describe('a bot\'s threads, as the owner sees them', () => {
  let root: Root
  let host: HTMLElement
  const select = vi.fn(async () => undefined)

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    ;(window as unknown as { mousse: unknown }).mousse = { threads: { select } }
    select.mockClear()
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('a thread the bot started is a chip with its title; Open shows the thread', async () => {
    // The chips of a dispatch, as Mousse rolls them up from the calls its authority allowed and their results.
    const chips = rollUpChips([
      { tool: 'thread_list', input: {} },
      { tool: 'thread_create', input: { title: 'Fix the login page' }, result: { threadId: 't-new', title: 'Fix the login page' } },
      { tool: 'thread_send', input: { threadId: 't-old' }, result: { threadId: 't-old', title: 'Signup' } },
      // A start that failed shows no chip.
      { tool: 'thread_create', input: { title: 'Nope' }, result: { error: 'refused' } }
    ])
    expect(chips.map((chip) => [chip.text, chip.highlight, chip.thread])).toEqual([
      ['read your threads', undefined, undefined],
      ['started thread', 'Fix the login page', 't-new'],
      ['messaged', 'Signup', 't-old']
    ])
    act(() => root.render(createElement(BotChips, { chips })))
    expect(host.textContent).toContain('started thread · Fix the login page')
    const open = [...host.querySelectorAll('button')].filter((button) => button.textContent === 'Open')
    expect(open).toHaveLength(2)
    useAppStore.setState({ threadsSidebarView: 'chats' })
    await act(async () => { open[0]!.click() })
    expect(select).toHaveBeenCalledWith('t-new')
    // The sidebar shows the projects, where the thread is listed.
    expect(useAppStore.getState().threadsSidebarView).toBe('projects')
  })

  it('above a thread a bot started: "Started by" and the bot\'s name, which opens its chat; nothing above any other thread', () => {
    const bot = { id: 'b1', name: 'Alpha', homeThreadId: 'bot-chat' } as BotSummary
    const thread = (id: string, createdByThreadId?: string) => ({ id, name: id, createdAt: NOW, updatedAt: NOW, ...(createdByThreadId ? { createdByThreadId } : {}) }) as Thread
    useBotsStore.setState({ bots: [bot] })
    useAppStore.setState({ threads: [thread('started', 'bot-chat'), thread('mine'), thread('by-agent', 'other-thread')], activeThreadId: 'started' })
    const openBot = vi.spyOn(useChatsStore.getState(), 'openBot').mockResolvedValue(undefined)
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(host.textContent).toBe('Started by Alpha')
    act(() => host.querySelector('button')!.click())
    expect(openBot).toHaveBeenCalledWith('b1')
    for (const other of ['mine', 'by-agent']) {
      act(() => useAppStore.setState({ activeThreadId: other }))
      expect(host.textContent, other).toBe('')
    }
  })
})
