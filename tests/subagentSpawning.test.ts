// @vitest-environment jsdom
import type { UIMessage } from 'ai'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatStatusFromTurn, mousseToUIMessages } from '../src/renderer/chat/adapters/mousseToUI'
import { collectNativeSubagentCards, nativeSubagentState, nativeSubagentsOfMessages } from '../src/renderer/chat/adapters/nativeSubagents'
import { collectSubagentCalls, joinSubagentCards, type SubagentCardModel } from '../src/renderer/chat/adapters/subagentCards'
import { MessageList } from '../src/renderer/chat/components/agent-elements/message-list'
import { SubagentCardView } from '../src/renderer/chat/components/agent-elements/tools/SubagentCard'
import { SubagentCardsContext } from '../src/renderer/chat/components/agent-elements/tools/subagent-cards-context'
import { describeTurnProgress } from '../src/renderer/chat/components/agent-elements/turn-progress'
import { useBackgroundLive } from '../src/renderer/hooks/useNativeSubagents'
import { useAppStore } from '../src/renderer/stores/appStore'
import { BACKGROUND_SUMMARY, type AgentActivityItem } from '../src/shared/agentActivity'
import type { SubagentSummary } from '../src/shared/subagents'
import type { ChatMessage, ThreadActivityState, TurnPhase } from '../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-11-12T08:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const RUN = 'run:thread:t1:ordinal:1'

const user = (id: string, seconds: number, content: string): ChatMessage =>
  ({ id, role: 'user', content, timestamp: at(seconds), turnId: RUN }) as ChatMessage
const reply = (id: string, seconds: number, content: string): ChatMessage =>
  ({ id, role: 'assistant', content, timestamp: at(seconds), turnId: RUN }) as ChatMessage
/** A Claude Code `Agent` call, as the daemon saves it while it runs or once it ended. */
const agent = (id: string, seconds: number, activity: Partial<AgentActivityItem>): ChatMessage =>
  ({
    id,
    role: 'system',
    kind: 'mcp_tool_call',
    content: '',
    timestamp: at(seconds),
    turnId: RUN,
    toolCall: { title: 'Agent', summary: 'Agent', details: [], status: activity.status === 'running' ? 'running' : 'complete' },
    activity: { id, callId: `toolu_${id}`, toolName: 'Agent', kind: 'subagent', status: 'running', startedAt: at(seconds), runId: RUN, ...activity }
  }) as ChatMessage
const nested = (id: string, seconds: number, parentId: string): ChatMessage =>
  ({
    id,
    role: 'system',
    kind: 'mcp_tool_call',
    content: '',
    timestamp: at(seconds),
    turnId: RUN,
    toolCall: { title: 'Bash', summary: 'Bash', details: [], status: 'running' },
    activity: { id, callId: `toolu_${id}`, toolName: 'Bash', kind: 'command', command: 'ls', status: 'running', startedAt: at(seconds), runId: RUN, parentId }
  }) as ChatMessage

/** Agent row ids are the card keys. */
const nativeCards = (messages: ChatMessage[], turnActive: boolean) => collectNativeSubagentCards(mousseToUIMessages(messages), turnActive, turnActive)

const named = { description: 'Map the scroll code', agentType: 'general-purpose' }

describe('a native subagent is spawning until it has a name and a task', () => {
  it('a call with no arguments yet is spawning', () => {
    expect(nativeCards([user('u1', 0, 'go'), agent('a1', 1, {})], true).get('a1')?.spawning).toBe(true)
  })

  it('a named call whose task has not started is still spawning', () => {
    expect(nativeCards([user('u1', 0, 'go'), agent('a1', 1, named)], true).get('a1')?.spawning).toBe(true)
  })

  it('a named call with a task id, or with a call of its own, has started', () => {
    const card = nativeCards([user('u1', 0, 'go'), agent('a1', 1, { ...named, nativeId: 'task-1' })], true).get('a1')
    expect(card).toMatchObject({ title: 'Map the scroll code' })
    expect(card?.spawning).toBeUndefined()
    expect(nativeCards([user('u1', 0, 'go'), agent('a1', 1, named), nested('c1', 2, 'a1')], true).get('a1')?.spawning).toBeUndefined()
  })

  it('a call that failed while starting is not spawning: its card shows the failure', () => {
    const card = nativeCards([user('u1', 0, 'go'), agent('a1', 1, { ...named, status: 'failed', summary: 'Agent type not found' })], true).get('a1')
    expect(card).toMatchObject({ state: 'failed', error: 'Agent type not found' })
    expect(card?.spawning).toBeUndefined()
  })

  it('a call in a finished turn, or in an earlier turn, is never spawning', () => {
    expect(nativeCards([user('u1', 0, 'go'), agent('a1', 1, {})], false).get('a1')?.spawning).toBeUndefined()
    expect(nativeCards([user('u1', 0, 'go'), agent('a1', 1, {}), user('u2', 9, 'next')], true).get('a1')?.spawning).toBeUndefined()
  })
})

const delegate = (id: string, state: string, input: Record<string, unknown>, output?: unknown): UIMessage =>
  ({ id: `m-${id}`, role: 'assistant', createdAt: at(1), parts: [{ type: 'tool-Subagent', toolCallId: id, state, input, output, subagentTool: 'delegate_task' }] }) as unknown as UIMessage
const prompt = { id: 'u1', role: 'user', createdAt: at(0), parts: [{ type: 'text', text: 'go' }] } as unknown as UIMessage
const listed: SubagentSummary = {
  childThreadId: 'child-1',
  title: 'Map the scroll code',
  state: 'working',
  provider: 'claude',
  model: 'opus',
  waitingOn: [],
  tasks: [{ delegationId: 'd1', createdAt: at(1.1), completedAt: null, outcome: 'running', continued: false }]
} as unknown as SubagentSummary

describe('a Mousse subagent is spawning until its call joins a task with a thread', () => {
  it('a call of the running turn that has not returned and has no task yet is spawning', () => {
    const streaming = joinSubagentCards(collectSubagentCalls([prompt, delegate('c1', 'input-streaming', {})]), [], { loaded: true, turnActive: true })
    expect(streaming.get('c1')).toMatchObject({ pending: true, spawning: true })
    const named = joinSubagentCards(collectSubagentCalls([prompt, delegate('c1', 'input-available', { title: 'Map the scroll code', recordVersion: 1 })]), [], { loaded: true, turnActive: true })
    expect(named.get('c1')?.spawning).toBe(true)
  })

  it('once the task is listed the card has its thread and is no longer spawning', () => {
    const card = joinSubagentCards(collectSubagentCalls([prompt, delegate('c1', 'input-available', { title: 'Map the scroll code', recordVersion: 1 })]), [listed], { loaded: true, turnActive: true }).get('c1')
    expect(card).toMatchObject({ pending: false, childThreadId: 'child-1', title: 'Map the scroll code' })
    expect(card?.spawning).toBeUndefined()
  })

  it('a failed call has no card, so its raw row shows the error', () => {
    const cards = joinSubagentCards(collectSubagentCalls([prompt, delegate('c1', 'output-error', { title: 'x' }, 'Refused')]), [], { loaded: true, turnActive: true })
    expect(cards.has('c1')).toBe(false)
  })

  it('a finished turn loaded before the list keeps a plain pending card, not a spawning one', () => {
    const card = joinSubagentCards(collectSubagentCalls([prompt, delegate('c1', 'output-available', { title: 'Map the scroll code' })]), [], { loaded: false, turnActive: false }).get('c1')
    expect(card).toMatchObject({ pending: true })
    expect(card?.spawning).toBeUndefined()
  })
})

describe('the progress line while subagents start', () => {
  const messages = [] as UIMessage[]
  it('says Starting subagent… for one and counts several', () => {
    expect(describeTurnProgress({ state: { phase: 'tool_running' }, messages, spawningSubagents: 1, now: T0 })).toMatchObject({ kind: 'preparing-tool', label: 'Starting subagent…' })
    expect(describeTurnProgress({ state: { phase: 'tool_running' }, messages, spawningSubagents: 3, now: T0 })?.label).toBe('Starting 3 subagents…')
  })

  it('gives way to Stopping… and to a waiting approval', () => {
    expect(describeTurnProgress({ state: { phase: 'tool_running', stopping: true }, messages, spawningSubagents: 1, now: T0 })?.label).toBe('Stopping…')
    expect(describeTurnProgress({ state: { phase: 'awaiting_input' }, messages, spawningSubagents: 1, now: T0 })).toBeNull()
  })
})

describe('a thread whose agent starts subagents', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 5000)
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

  const show = async (messages: ChatMessage[], live: boolean, cards?: ReadonlyMap<string, SubagentCardModel>) => {
    const ui = mousseToUIMessages(messages)
    await act(async () => {
      root.render(createElement(SubagentCardsContext.Provider, { value: cards ?? collectNativeSubagentCards(ui, live, live) },
        createElement(MessageList, { messages: ui, status: chatStatusFromTurn({ phase: live ? 'tool_running' : 'completed', turnId: RUN }) })))
    })
    // A finished turn folds its work, its finished cards with it, behind its line: open it.
    const toggle = host.querySelector<HTMLButtonElement>('.turn-work-toggle[aria-expanded="false"]')
    if (toggle) await act(async () => { toggle.click() })
    return {
      cards: [...host.querySelectorAll('.subagent-card')].map((node) => node.textContent),
      progress: [...host.querySelectorAll('[data-turn-progress]')].map((node) => node.textContent),
      text: host.textContent ?? ''
    }
  }

  const intro = [user('u1', 0, 'Look into the scroll code'), reply('r1', 1, 'I will hand this to a subagent.')]

  it('shows no card while the subagent has no name, only the progress line', async () => {
    const view = await show([...intro, agent('a1', 2, {})], true)
    expect(view.cards).toEqual([])
    expect(view.progress).toEqual(['Starting subagent…'])
    expect(view.text).not.toContain('Agent')
  })

  it('shows no card while a named subagent has not started its task', async () => {
    const view = await show([...intro, agent('a1', 2, named)], true)
    expect(view.cards).toEqual([])
    expect(view.progress).toEqual(['Starting subagent…'])
  })

  it('counts several subagents still starting', async () => {
    const view = await show([...intro, agent('a1', 2, named), agent('a2', 2, {}), agent('a3', 2, {})], true)
    expect(view.cards).toEqual([])
    expect(view.progress).toEqual(['Starting 3 subagents…'])
  })

  it('draws the card once the subagent is named and started, and the line names what runs', async () => {
    const view = await show([...intro, agent('a1', 2, { ...named, nativeId: 'task-1' })], true)
    expect(view.cards).toHaveLength(1)
    expect(view.cards[0]).toContain('Map the scroll code')
    expect(view.progress).toEqual(['Running subagent…Map the scroll code'])
  })

  it('draws started cards and counts only the ones still starting', async () => {
    const view = await show([...intro, agent('a1', 2, { ...named, nativeId: 'task-1' }), agent('a2', 3, {})], true)
    expect(view.cards).toHaveLength(1)
    expect(view.text).not.toContain('2 subagents')
    expect(view.progress).toEqual(['Starting subagent…'])
  })

  it('a subagent that failed to start shows its error, with no blank card', async () => {
    const view = await show([...intro, agent('a1', 2, { ...named, status: 'failed', summary: 'Agent type not found' })], true)
    expect(view.cards).toHaveLength(1)
    expect(view.cards[0]).toContain('Map the scroll code')
    expect(view.cards[0]).toContain('Agent type not found')
    expect(view.progress).not.toContain('Starting subagent…')
  })

  it('a Mousse subagent call with no thread yet shows no card, then its card once listed', async () => {
    const calls = [prompt, delegate('c1', 'input-available', { title: 'Map the scroll code', recordVersion: 1 })]
    const messages = [user('u1', 0, 'Look into the scroll code')]
    const starting = joinSubagentCards(collectSubagentCalls(calls), [], { loaded: true, turnActive: true })
    const ui = [...mousseToUIMessages(messages), calls[1]!]
    await act(async () => {
      root.render(createElement(SubagentCardsContext.Provider, { value: starting },
        createElement(MessageList, { messages: ui, status: chatStatusFromTurn({ phase: 'tool_running', turnId: RUN }) })))
    })
    expect(host.querySelectorAll('.subagent-card')).toHaveLength(0)
    expect([...host.querySelectorAll('[data-turn-progress]')].map((node) => node.textContent)).toEqual(['Starting subagent…'])
    const started = joinSubagentCards(collectSubagentCalls(calls), [listed], { loaded: true, turnActive: true })
    await act(async () => {
      root.render(createElement(SubagentCardsContext.Provider, { value: started },
        createElement(MessageList, { messages: ui, status: chatStatusFromTurn({ phase: 'tool_running', turnId: RUN }) })))
    })
    expect([...host.querySelectorAll('.subagent-card')].map((node) => node.textContent?.includes('Map the scroll code'))).toEqual([true])
    expect([...host.querySelectorAll('[data-turn-progress]')].map((node) => node.textContent)).toEqual(['Running subagent…'])
  })

  it('a finished turn loaded from history shows its subagent cards', async () => {
    const view = await show([...intro, agent('a1', 2, { ...named, nativeId: 'task-1', status: 'done', summary: 'All good.', durationMs: 3000 }), reply('r2', 9, 'Done.')], false)
    expect(view.cards).toHaveLength(1)
    expect(view.cards[0]).toContain('Map the scroll code')
    expect(view.progress).toEqual([])
  })

  it('a finished turn whose agent row never got its arguments still shows a card', async () => {
    const view = await show([...intro, agent('a1', 2, { status: 'done' }), reply('r2', 9, 'Done.')], false)
    expect(view.cards).toHaveLength(1)
    expect(view.progress).toEqual([])
  })

  const line = () => [...host.querySelectorAll('.subagent-card-line')].map((node) => node.textContent)

  it('a running row says Working on its one line', async () => {
    await show([...intro, agent('a1', 2, { ...named, nativeId: 'task-1' })], true)
    expect(line()).toEqual(['Working…'])
    expect(host.querySelector('.subagent-card')?.getAttribute('data-state')).toBe('working')
  })

  it('a finished row shows its result as one plain line, and opens on the whole result', async () => {
    const summary = '**All good.** The key is built in `src/cache.ts`.'
    await show([...intro, agent('a1', 2, { ...named, nativeId: 'task-1', status: 'done', summary, durationMs: 3000 }), reply('r2', 9, 'Done.')], false)
    expect(line()).toEqual(['All good. The key is built in src/cache.ts.'])
    expect(host.querySelector('.subagent-card')?.getAttribute('data-state')).toBe('done')
    const row = host.querySelector<HTMLButtonElement>('button.subagent-card')!
    expect(row.getAttribute('aria-expanded')).toBe('false')
    await act(async () => row.click())
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.subagent-card-full')?.textContent).toBe('All good. The key is built in src/cache.ts.')
  })

  it('a failed row says Failed, tinted, then why', async () => {
    await show([...intro, agent('a1', 2, { ...named, status: 'failed', summary: 'Agent type `nope` not found' })], true)
    expect(line()).toEqual(['Failed · Agent type nope not found'])
    expect(host.querySelector('.subagent-card-note')?.getAttribute('data-tone')).toBe('failed')
    expect(host.querySelector('.subagent-card')?.getAttribute('data-state')).toBe('failed')
  })

  it('clicking a Mousse subagent row opens its thread', async () => {
    const opened: string[] = []
    const [card] = joinSubagentCards(collectSubagentCalls([prompt, delegate('c1', 'output-available', { title: 'Map the scroll code', recordVersion: 1 }, { delegationId: 'd1' })]), [listed], { loaded: true, turnActive: false }).values()
    await act(async () => {
      root.render(createElement(SubagentCardView, { card: card!, now: T0 + 5000, result: 'Read `a.ts`.', onOpen: (id: string) => opened.push(id) }))
    })
    expect(line()).toEqual(['Read a.ts.'])
    await act(async () => host.querySelector<HTMLButtonElement>('button.subagent-card')!.click())
    expect(opened).toEqual(['child-1'])
  })
})

describe('Lineage leaves a native subagent out until it has started', () => {
  const lineage = (messages: ChatMessage[], turnActive: boolean) => nativeSubagentsOfMessages(messages, turnActive, turnActive).map((card) => card.title)

  it('lists no subagent of the running turn that has no name or has not started', () => {
    expect(lineage([user('u1', 0, 'go'), agent('a1', 1, {})], true)).toEqual([])
    expect(lineage([user('u1', 0, 'go'), agent('a1', 1, named)], true)).toEqual([])
  })

  it('lists it by name once it has a task id or a call of its own', () => {
    expect(lineage([user('u1', 0, 'go'), agent('a1', 1, { ...named, nativeId: 'task-1' })], true)).toEqual(['Map the scroll code'])
    expect(lineage([user('u1', 0, 'go'), agent('a1', 1, named), nested('c1', 2, 'a1')], true)).toEqual(['Map the scroll code'])
  })

  it('lists one that failed to start, and every subagent of a finished turn', () => {
    expect(lineage([user('u1', 0, 'go'), agent('a1', 1, { ...named, status: 'failed', summary: 'Agent type not found' })], true)).toEqual(['Map the scroll code'])
    expect(lineage([user('u1', 0, 'go'), agent('a1', 1, {})], false)).toEqual(['Subagent'])
  })
})

describe('a background subagent stays working through its turn\'s end', () => {
  let host: HTMLDivElement
  let root: Root
  const seen: string[] = []
  // The row a settled turn left for an agent still running in the background.
  const row = { state: 'output-available', output: { summary: BACKGROUND_SUMMARY } }
  function Probe() {
    seen.push(nativeSubagentState(row, useBackgroundLive('t1')))
    return null
  }
  const apply = (phase: TurnPhase, activity: ThreadActivityState) =>
    act(() => useAppStore.setState({ turnStates: { t1: { threadId: 't1', turnId: RUN, phase, updatedAt: at(9) } }, threadActivity: { t1: activity } }))

  beforeEach(() => {
    seen.length = 0
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useAppStore.setState({ turnStates: {}, threadActivity: {} })
  })

  it('never shows done while the turn has ended but the thread has not yet turned Waiting', () => {
    apply('tool_running', 'processing')
    act(() => root.render(createElement(Probe)))
    // The turn's end reaches the window first, the thread's Waiting just after.
    apply('completed', 'processing')
    apply('completed', 'waiting')
    expect(seen.every((state) => state === 'working')).toBe(true)
    // The background work ends: the thread is Done and the row with it.
    apply('completed', 'completed')
    expect(seen.at(-1)).toBe('done')
  })
})
