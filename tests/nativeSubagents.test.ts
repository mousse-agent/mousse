// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mousseToUIMessages, chatStatusFromTurn } from '../src/renderer/chat/adapters/mousseToUI'
import {
  collectNativeSubagentCards,
  nativeSubagentsOfMessages,
  readBackgroundNotice
} from '../src/renderer/chat/adapters/nativeSubagents'
import { MessageList } from '../src/renderer/chat/components/agent-elements/message-list'
import { SubagentCardsContext } from '../src/renderer/chat/components/agent-elements/tools/subagent-cards-context'
import { LINEAGE_CLOSED, LineageList } from '../src/renderer/components/sideCard/LineageSection'
import { lineageTitle, nativeLineageEntry } from '../src/renderer/components/sideCard/lineageLogic'
import { BACKGROUND_SUMMARY, type AgentActivityItem } from '../src/shared/agentActivity'
import type { ChatMessage } from '../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-11-10T20:21:41.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const RUN = 'run:thread:t1:ordinal:1'

const user = (id: string, seconds: number, content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'user', content, timestamp: at(seconds), turnId: RUN, ...extra }) as ChatMessage
const reply = (id: string, seconds: number, content: string): ChatMessage =>
  ({ id, role: 'assistant', content, timestamp: at(seconds), turnId: RUN }) as ChatMessage
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

/** A Claude agent launched in the background: its turn settled while it ran. */
const backgroundAgent = (id: string, seconds: number, description: string, patch: Partial<AgentActivityItem> = {}) =>
  row(id, seconds, { kind: 'subagent', agentType: 'Explore', description, nativeId: `task-${id}`, background: true, summary: BACKGROUND_SUMMARY, endedAt: at(seconds + 20), ...patch } as never)
/** A command the agent ran: nested under the agent with `parentId`. */
const nestedCommand = (id: string, seconds: number, parentId: string) =>
  row(id, seconds, { kind: 'command', toolName: 'Bash', command: `ls ${id}`, output: 'ok', parentId } as never)

describe('native subagent cards', () => {
  it('follow a background agent from working to its reported end', () => {
    const messages = [user('u1', 0, 'Map the app'), backgroundAgent('a1', 13, 'Map design language'), nestedCommand('c1', 20, 'a1')]
    const live = collectNativeSubagentCards(mousseToUIMessages(messages), true)
    expect([...live.keys()]).toEqual(['a1'])
    expect(live.get('a1')).toMatchObject({ title: 'Map design language', state: 'working', completedAt: null, native: { agentType: 'Explore', taskId: 'task-a1', result: null } })

    // Without background work the settled row reads done, as before: old threads never show a ghost agent.
    expect(collectNativeSubagentCards(mousseToUIMessages(messages), false).get('a1')?.state).toBe('done')

    // The daemon wrote the agent's report on its row.
    const ended = [messages[0]!, backgroundAgent('a1', 13, 'Map design language', { summary: 'Ideonite Design Language Report', durationMs: 106_000 }), messages[2]!]
    expect(collectNativeSubagentCards(mousseToUIMessages(ended), true).get('a1')).toMatchObject({
      state: 'done',
      completedAt: T0 + 13_000 + 106_000,
      native: { result: 'Ideonite Design Language Report' }
    })
  })

  it('read failed, stopped and running rows, and leave nested agents to their parent', () => {
    const messages = [
      user('u1', 0, 'go'),
      row('f', 1, { kind: 'subagent', description: 'Failing', status: 'failed', summary: 'It broke' } as never),
      row('s', 2, { kind: 'subagent', description: 'Stopped one', status: 'interrupted', interruptedBy: 'stop', summary: 'Stopped' } as never),
      row('r', 3, { kind: 'subagent', description: 'Running one', status: 'running' } as never),
      row('n', 4, { kind: 'subagent', description: 'Nested', parentId: 'r' } as never)
    ]
    const cards = collectNativeSubagentCards(mousseToUIMessages(messages), false)
    expect([...cards.keys()]).toEqual(['f', 's', 'r'])
    expect(cards.get('f')).toMatchObject({ state: 'failed', error: 'It broke' })
    expect(cards.get('s')?.state).toBe('stopped')
    expect(cards.get('r')?.state).toBe('working')
    // The saved messages give the same rows, for the side card.
    expect(nativeSubagentsOfMessages(messages, false).map((card) => [card.toolCallId, card.state])).toEqual([['f', 'failed'], ['s', 'stopped'], ['r', 'working']])
  })

  it('carry the continuation notice on the message metadata, never parsed from its text', () => {
    const [message] = mousseToUIMessages([user('w', 5, 'A background task finished: report', { backgroundNotice: [{ taskId: 'task-a1', description: 'Map design language' }] })])
    expect(readBackgroundNotice(message)).toEqual([{ taskId: 'task-a1', description: 'Map design language' }])
    const [plain] = mousseToUIMessages([user('p', 5, 'A background task finished: typed by hand')])
    expect(readBackgroundNotice(plain)).toBeNull()
  })
})

describe('a thread whose agent starts background agents', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 120_000)
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { mousse: unknown }).mousse = { orchestrator: { getMessages: async () => [] } }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  const show = async (messages: ChatMessage[], live: boolean) => {
    const ui = mousseToUIMessages(messages)
    await act(async () => {
      root.render(createElement(SubagentCardsContext.Provider, { value: collectNativeSubagentCards(ui, live) },
        createElement(MessageList, { messages: ui, status: chatStatusFromTurn({ phase: 'completed', turnId: RUN }) })))
    })
    return {
      turns: host.querySelectorAll('[data-turn-key]').length,
      cards: [...host.querySelectorAll('[data-native-subagent]')].map((node) => node.getAttribute('data-native-subagent')),
      notices: [...host.querySelectorAll('.subagent-notice-row')].map((node) => node.textContent),
      text: host.textContent ?? ''
    }
  }

  const launched: ChatMessage[] = [
    user('u1', 0, 'Make a mock-up of the app'),
    reply('r1', 12, 'Starting three agents to map the app.'),
    backgroundAgent('a1', 13, 'Map design language'),
    backgroundAgent('a2', 20, 'Map product surface'),
    nestedCommand('c1', 22, 'a1'),
    nestedCommand('c2', 23, 'a2'),
    reply('r2', 38, 'Three agents are mapping the app.')
  ]

  it('shows the agents as subagent cards, working while the thread has background work', async () => {
    const view = await show(launched, true)
    expect(view.cards).toEqual(['a1', 'a2'])
    expect(view.text).toContain('2 subagents')
    expect(view.text).toContain('2 working')
    expect(view.text).toContain('Map design language')
    expect(view.text).toContain('Explore')
    // The agents' own calls are inside their cards, not loose rows.
    expect(view.text).not.toContain('Agent completed')
  })

  it('opens a card on the calls its agent made', async () => {
    // The group of cards is open while its agents work.
    await show(launched, true)
    const card = host.querySelector<HTMLButtonElement>('[data-native-subagent="a1"] button.subagent-card')!
    expect(card.getAttribute('aria-expanded')).toBe('false')
    await act(async () => card.click())
    expect(card.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[data-native-subagent="a1"] .subagent-card-calls')?.textContent).toContain('ls c1')
  })

  it('keeps the line breaks of a Markdown report: the row shows one plain line, the opened card a heading and a list', async () => {
    const report = '## Progress kinds\n\n- tool_running\n- streaming\n- compacting\n\nThat is all.'
    const done = [user('u1', 0, 'List the kinds'), backgroundAgent('a1', 13, 'List the progress kinds', { summary: report, durationMs: 9_000 })]
    expect(collectNativeSubagentCards(mousseToUIMessages(done), false).get('a1')?.native?.result).toBe(report)
    await show(done, false)
    // A finished turn folds its work behind its Worked line.
    const worked = host.querySelector<HTMLButtonElement>('.turn-work-toggle')
    if (worked?.getAttribute('aria-expanded') === 'false') await act(async () => worked.click())
    const node = host.querySelector('[data-native-subagent="a1"]')!
    expect(node.querySelector('.subagent-card-result')?.textContent).toBe('Progress kinds tool_running streaming compacting That is all.')
    await act(async () => node.querySelector<HTMLButtonElement>('button.subagent-card')!.click())
    const full = node.querySelector('.subagent-card-full')!
    expect(full.querySelector('h2')?.textContent).toBe('Progress kinds')
    expect([...full.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['tool_running', 'streaming', 'compacting'])
    expect(full.querySelector('p')?.textContent).toBe('That is all.')
  })

  it('a finished agent\'s report continues the reply: no message from the user, no raw report, the card says done', async () => {
    const reported = [
      ...launched.map((message) => (message.id === 'a1' ? backgroundAgent('a1', 13, 'Map design language', { summary: 'Ideonite Design Language Report', durationMs: 106_000 }) : message)),
      user('w1', 120, 'A background task finished: Ideonite Design Language Report (read-only; all paths under the worktree root) ## 1. Stack', {
        backgroundNotice: [{ taskId: 'task-a1', description: 'Map design language' }]
      }),
      reply('r3', 124, 'The design-language report is in.')
    ]
    const view = await show(reported, true)
    expect(view.turns).toBe(1)
    expect(view.text).not.toContain('A background task finished')
    expect(view.text).not.toContain('## 1. Stack')
    // The card already shows this result, so the notice adds no line.
    expect(view.notices).toEqual([])
    expect(view.text).toContain('1 working · 1 done')
    expect(view.text).toContain('The design-language report is in.')
  })

  it('a background task with no card (a shell) gets one notice row inside the reply', async () => {
    const view = await show([
      ...launched,
      user('w2', 60, 'A background task finished: Background command "Install dependencies" completed (exit code 0)', {
        backgroundNotice: [{ taskId: 'shell-1', description: 'Install dependencies' }]
      }),
      reply('r4', 64, 'Dependencies are installed.')
    ], true)
    expect(view.turns).toBe(1)
    expect(view.notices).toEqual(['Install dependenciesfinished'])
    expect(view.text).not.toContain('A background task finished')
  })
})

describe('Lineage lists native subagents', () => {
  it('counts them, shows their kind, opens their card and offers no Stop of its own', () => {
    const cards = nativeSubagentsOfMessages([backgroundAgent('a1', 13, 'Map design language'), backgroundAgent('a2', 20, 'Find hosting', { summary: 'Done', durationMs: 5000 })], true)
    const entries = cards.map(nativeLineageEntry)
    expect(lineageTitle(entries)).toBe('Lineage · 1 running')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const onReveal = vi.fn()
    const onOpen = vi.fn()
    act(() => {
      root.render(createElement(LineageList, { subagents: entries, now: T0 + 60_000, open: { ...LINEAGE_CLOSED, finished: true }, onOpenPart: () => undefined, onOpen, onReveal, onStop: () => undefined }))
    })
    expect(host.textContent).toContain('Map design language')
    expect(host.textContent).toContain('Explore')
    expect(host.querySelector('.lineage-stop')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('.lineage-row.is-working')!.click())
    expect(onReveal).toHaveBeenCalledWith('a1')
    expect(onOpen).not.toHaveBeenCalled()
    act(() => root.unmount())
    host.remove()
  })
})
