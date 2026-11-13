// @vitest-environment jsdom
/**
 * What the owner sees of "use your threads": a step under a reply's "Worked for" for a thread it started ("Started
 * thread: <title>") whose Open shows that thread, and one line above a thread a bot started, "Started by <bot>", whose name opens the bot's
 * chat. How they look is checked in the real app (screenshots on the PR), not here.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotSteps } from '../../src/renderer/components/bots/BotSteps'
import { ThreadStartedByBar } from '../../src/renderer/components/ThreadStartedByBar'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useBotsStore } from '../../src/renderer/stores/botsStore'
import { useChatsStore } from '../../src/renderer/stores/chatsStore'
import { actedChip, rollUpChips } from '../../src/shared/bots/personal/chips'
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

  it('a thread the bot started is a step with its title; Open shows the thread', async () => {
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
    act(() => root.render(createElement(BotSteps, { chips })))
    expect(host.textContent).toContain('Started thread: Fix the login page')
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

  it('a thread a deleted bot started keeps its line with the bot\'s name, marked deleted, with nothing to open', () => {
    const started = { id: 'started', name: 'started', createdAt: NOW, updatedAt: NOW, createdByThreadId: 'bot-chat', startedByBot: { botId: 'b1', name: 'Alpha' } } as Thread
    useAppStore.setState({ threads: [started], activeThreadId: 'started' })
    // Before the bots are read, its name as it was.
    useBotsStore.setState({ bots: [], loaded: false })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(host.textContent).toBe('Started by Alpha')
    // Once they are, and the bot is not among them.
    act(() => useBotsStore.setState({ bots: [], loaded: true }))
    expect(host.textContent).toBe('Started by Alpha (deleted)')
    expect(host.querySelector('button')).toBeNull()
    // A bot that is there, renamed since, is named as it is now and opens.
    act(() => useBotsStore.setState({ bots: [{ id: 'b1', name: 'Alpha 2', homeThreadId: 'bot-chat' } as BotSummary], loaded: true }))
    expect(host.textContent).toBe('Started by Alpha 2')
  })

  it('a thread of another computer whose bot this device may not reach says "Started by a bot", never deleted, with nothing to open', () => {
    // As the other computer sends it to a device left out of the bot's Devices: no id, no launcher, no name.
    const hidden = { id: 'nod_desk:started', name: 'started', node: 'nod_desk', createdAt: NOW, updatedAt: NOW, startedByBot: { botId: '', name: 'a bot' } } as Thread
    // One it may reach: the bot is the other computer's, so it is not this one's list, and not deleted.
    const shown = { id: 'nod_desk:other', name: 'other', node: 'nod_desk', createdAt: NOW, updatedAt: NOW, startedByBot: { botId: 'b9', name: 'Keeper' } } as Thread
    useBotsStore.setState({ bots: [{ id: 'b1', name: 'Alpha', homeThreadId: 'bot-chat' } as BotSummary], loaded: true })
    useAppStore.setState({ threads: [hidden, shown], activeThreadId: hidden.id })
    act(() => root.render(createElement(ThreadStartedByBar)))
    expect(host.textContent).toBe('Started by a bot')
    expect(host.querySelector('button')).toBeNull()
    act(() => useAppStore.setState({ activeThreadId: shown.id }))
    expect(host.textContent).toBe('Started by Keeper')
  })

  it('a start or a message shows what the bot sent there on the chip\'s hover, at once', () => {
    const chips = rollUpChips([
      { tool: 'thread_send', input: { threadId: 't-old' }, result: { threadId: 't-old', title: 'Signup', sent: 'Please also check the signup page.' } }
    ])
    expect(actedChip('thread_send', { threadId: 't-old' }, { threadId: 't-old', title: 'Signup', sent: 'Please also check the signup page.' })).toEqual(chips[0])
    act(() => root.render(createElement(BotSteps, { chips })))
    expect(host.querySelector('.bot-steps li')!.getAttribute('title')).toBe('Sent: Please also check the signup page.')
  })
})
