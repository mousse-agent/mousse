// @vitest-environment jsdom
import type { UIMessage } from 'ai'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../src/renderer/chat/components/agent-elements/message-list'
import { SubagentCardsContext } from '../src/renderer/chat/components/agent-elements/tools/subagent-cards-context'
import { chatStatusFromTurn } from '../src/renderer/chat/adapters/mousseToUI'
import type { SubagentCardModel } from '../src/renderer/chat/adapters/subagentCards'
import { collectSubagentCalls, joinSubagentCards } from '../src/renderer/chat/adapters/subagentCards'
import type { SubagentState, SubagentSummary } from '../src/shared/subagents'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-10-29T10:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

const NAMES = ['Test Subagent One', 'Test Subagent Two', 'Test Subagent Three']

const user = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], createdAt: at(seconds) }) as unknown as UIMessage
const reply = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'text', text }] }) as unknown as UIMessage
const thought = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'tool-Thinking', toolCallId: id, state: 'output-available', input: { thought: text }, output: text }] }) as unknown as UIMessage
const launch = (index: number, seconds: number): UIMessage =>
  ({
    id: `launch-${index}`,
    role: 'assistant',
    createdAt: at(seconds),
    parts: [{ type: 'tool-Subagent', toolCallId: `call-${index}`, state: 'output-available', input: {}, subagentTool: 'delegate_task' }]
  }) as unknown as UIMessage
/** The message the daemon adds when a subagent's result reaches the parent (the text is for the model). */
const result = (index: number, seconds: number, childThreadId = `child-${index}`): UIMessage =>
  ({
    id: `wake-${index}`,
    role: 'user',
    createdAt: at(seconds),
    parts: [{ type: 'text', text: `Subagent "${NAMES[index]}" finished task d${index}.\nMODEL-ONLY RESULT ${index}` }],
    metadata: { subagentNotice: [{ delegationId: `d${index}`, childThreadId, title: NAMES[index], runStatus: 'completed', fullyShown: true }] }
  }) as unknown as UIMessage

const cards = (states: SubagentState[]): Map<string, SubagentCardModel> =>
  new Map(states.map((state, index) => [`call-${index}`, {
    toolCallId: `call-${index}`,
    pending: false,
    childThreadId: `child-${index}`,
    delegationId: `d${index}`,
    title: NAMES[index]!,
    state,
    provider: 'claude',
    model: 'opus',
    continued: false,
    latest: true,
    waitingOn: [],
    exact: true,
    createdAt: T0 + 3000,
    completedAt: state === 'done' ? T0 + 3000 + (index + 1) * 5000 : null
  }]))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // A finished card reads its subagent's last reply.
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

/** Renders the list `seconds` after the message was sent, with the thread in `phase` and the subagents in `states`. */
async function show(seconds: number, messages: UIMessage[], phase: string, states: SubagentState[]) {
  await act(async () => {
    vi.advanceTimersByTime(Math.max(0, T0 + seconds * 1000 - Date.now()))
  })
  await act(async () => {
    root.render(createElement(SubagentCardsContext.Provider, { value: cards(states) },
      createElement(MessageList, { messages, status: chatStatusFromTurn({ phase, turnId: 'run:1' }) })))
  })
  const text = host.textContent ?? ''
  return {
    turns: host.querySelectorAll('[data-turn-key]').length,
    indicators: [...host.querySelectorAll('.turn-work-label')].map((node) => node.textContent),
    notices: host.querySelectorAll('.subagent-notice').length,
    text
  }
}

const u = user('u1', 0, 'Launch three test subagents')
const intro = reply('a1', 2, 'I launched three subagents. Mousse will send me their results when they finish.')
const launched = [u, intro, launch(0, 3), launch(1, 3), launch(2, 3)]

describe('a reply that launches subagents whose results arrive one by one', () => {
  it('stays one turn with one working indicator, and the card shows each result', async () => {
    let view = await show(3, launched, 'streaming', ['working', 'working', 'working'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Working · 3s'], notices: 0 })
    // The group is open: it counts the subagents and lists each one.
    expect(view.text).toContain('3 subagents')
    expect(host.querySelectorAll('.subagent-card-title')).toHaveLength(3)

    // The parent's run ends while its subagents work: the reply goes on.
    view = await show(5, launched, 'completed', ['working', 'working', 'working'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Working · 5s'], notices: 0 })

    // The first result wakes the parent: still the same turn, and the card counts it as done.
    const first = [...launched, result(0, 8), thought('t1', 9, 'One replied; two are still running.'), reply('a2', 10, 'Test Subagent One finished. Two and Three are still running.')]
    view = await show(10, first, 'streaming', ['done', 'working', 'working'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Working · 10s'], notices: 0 })
    expect(view.text).toContain('2 working · 1 done')
    expect(view.text).not.toContain('finished task')

    view = await show(11, first, 'completed', ['done', 'working', 'working'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Working · 11s'], notices: 0 })

    const all = [...first, result(1, 13), result(2, 18), reply('a3', 20, 'All three test subagents have now reported back.')]
    view = await show(20, all, 'streaming', ['done', 'done', 'done'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Working · 20s'], notices: 0 })

    view = await show(21, all, 'completed', ['done', 'done', 'done'])
    expect(view).toMatchObject({ turns: 1, indicators: ['Worked for 21s·2, 2 replies inside'], notices: 0 })
    // The turn ended in view: its work is still drawn as its fold starts to close, then is gone.
    expect(view.text).toContain('One replied; two are still running.')
    await act(async () => { vi.advanceTimersByTime(500) })
    view = { ...view, text: host.textContent ?? '' }
    // The finished turn folds its work behind its line, but the cards stay where the subagents were started.
    expect(view.text).not.toContain('One replied; two are still running.')
    expect(view.text).toContain('All three test subagents')
    expect([...host.querySelectorAll('.subagent-card-title')].map((node) => node.textContent)).toEqual(NAMES)
    // The line opens the rest of the work in place.
    await act(async () => { host.querySelector<HTMLButtonElement>('.turn-work-toggle')!.click() })
    view = { ...view, text: host.textContent ?? '' }
    expect(view.text).toContain('3 done')
    expect(view.text).not.toMatch(/finished task|MODEL-ONLY RESULT/)
    // Every part of the reply is in the one turn, in order.
    const order = ['I launched three subagents', '3 subagents', 'Test Subagent One finished.', 'All three test subagents'].map((s) => view.text.indexOf(s))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('starts a new turn for a real new message', async () => {
    const all = [...launched, result(0, 8), result(1, 9), result(2, 10), reply('a2', 12, 'All done.'), user('u2', 30, 'Thanks, now summarize')]
    const view = await show(31, all, 'streaming', ['done', 'done', 'done'])
    expect(view.turns).toBe(2)
    expect(view.indicators).toEqual(['Worked for 12s·1, 1 reply inside', 'Working · 1s'])
  })

  it('keeps a result line in the turn for a subagent with no card', async () => {
    const all = [...launched, result(0, 8, 'other-thread'), reply('a2', 10, 'Noted.')]
    const view = await show(11, all, 'completed', [])
    expect(view.turns).toBe(1)
    expect(view.notices).toBe(1)
    expect(view.text).toContain('Test Subagent One')
    expect(view.text).not.toContain('MODEL-ONLY RESULT')
  })
})

describe('a saved thread split by subagent results', () => {
  it('reads as one turn per message the user wrote', async () => {
    const saved = [
      ...launched,
      result(0, 8), reply('a2', 10, 'One finished.'),
      result(1, 13), result(2, 18), reply('a3', 20, 'All three reported back.'),
      user('u2', 60, 'Next'), reply('a4', 62, 'Okay.')
    ]
    const view = await show(100, saved, 'completed', ['done', 'done', 'done'])
    expect(view).toMatchObject({ turns: 2, indicators: ['Worked for 20s·2, 2 replies inside', 'Worked for 2s'], notices: 0 })
    expect(view.text).not.toMatch(/finished task|MODEL-ONLY RESULT/)
  })
})

describe('a thread whose turns start several subagents', () => {
  /** A recorded start-a-task call, as the daemon keeps it: what it named and the task it started. */
  const start = (id: string, seconds: number, tool: 'delegate_task' | 'continue_subagent', title: string, delegationId: string): UIMessage =>
    ({
      id,
      role: 'assistant',
      createdAt: at(seconds),
      parts: [{
        type: 'tool-Subagent',
        toolCallId: `call-${id}`,
        state: 'output-available',
        subagentTool: tool,
        input: tool === 'delegate_task' ? { recordVersion: 1, title } : { recordVersion: 1, subagent: title },
        output: JSON.stringify({ delegationId, childThreadId: `child-${title}`, title })
      }]
    }) as unknown as UIMessage
  /** One subagent as `subagents.list` reports it: a task per delegation, the last one in `state`. */
  const subagent = (title: string, tasks: Array<[delegationId: string, seconds: number]>, state: SubagentState): SubagentSummary =>
    ({
      childThreadId: `child-${title}`,
      title,
      activity: state === 'working' ? 'working' : 'idle',
      state,
      latestDelegationId: tasks[tasks.length - 1]![0],
      unread: false,
      provider: 'claude',
      model: 'opus',
      workspace: 'isolated',
      role: null,
      createdAt: at(tasks[0]![1]),
      updatedAt: at(tasks[tasks.length - 1]![1]),
      waitingOn: [],
      tasks: tasks.map(([delegationId, seconds], index) => {
        const live = index === tasks.length - 1 && state === 'working'
        return {
          delegationId,
          childRunId: `run-${delegationId}`,
          outcome: live ? 'running' : 'done',
          unread: false,
          continued: index < tasks.length - 1,
          createdAt: at(seconds),
          completedAt: live ? null : at(seconds + 5)
        }
      })
    }) as SubagentSummary

  // Turn 1 starts the Archive builder, turn 2 sends it more work, turn 3 starts two more subagents in one run.
  const messages = [
    user('u1', 0, 'Build the archive tool'),
    thought('t1', 1, 'Handing the archive tool to a subagent.'),
    start('d1', 2, 'delegate_task', 'Archive builder', 'd-archive-1'),
    reply('a1', 3, 'Archive builder is on it.'),
    user('u2', 100, 'Rebase the archive PR'),
    start('c1', 101, 'continue_subagent', 'Archive builder', 'd-archive-2'),
    reply('a2', 102, 'Sent the rebase back to Archive builder.'),
    user('u3', 200, 'Lower the schedule minimum and add thread links'),
    thought('t3', 201, 'Two separate changes, one subagent each.'),
    start('d2', 202, 'delegate_task', 'Schedule builder', 'd-schedule-1'),
    thought('t4', 203, 'Now the links.'),
    start('d3', 204, 'delegate_task', 'Link builder', 'd-link-1'),
    reply('a3', 205, 'Schedule builder and Link builder are on it.')
  ]

  /** The thread after its last turn, through the same join the chat uses; the card titles each turn shows, in order. */
  async function showThread(states: { archive: SubagentState; schedule: SubagentState; link: SubagentState }) {
    const subagents = [
      subagent('Archive builder', [['d-archive-1', 2.1], ['d-archive-2', 101.1]], states.archive),
      subagent('Schedule builder', [['d-schedule-1', 202.1]], states.schedule),
      subagent('Link builder', [['d-link-1', 204.1]], states.link)
    ]
    const cards = joinSubagentCards(collectSubagentCalls(messages), subagents, { loaded: true, turnActive: false })
    await act(async () => {
      vi.advanceTimersByTime(Math.max(0, T0 + 300_000 - Date.now()))
    })
    await act(async () => {
      root.render(createElement(SubagentCardsContext.Provider, { value: cards },
        createElement(MessageList, { messages, status: chatStatusFromTurn({ phase: 'completed', turnId: 'run:3' }) })))
    })
    return [...host.querySelectorAll('[data-turn-key]')].map((turn) => [...turn.querySelectorAll('.subagent-card-title')].map((node) => node.textContent))
  }

  it('shows the card of every start in the turn that made it, finished or still working', async () => {
    const everyStart = [['Archive builder'], ['Archive builder'], ['Schedule builder', 'Link builder']]
    expect(await showThread({ archive: 'done', schedule: 'done', link: 'done' })).toEqual(everyStart)
    expect(await showThread({ archive: 'working', schedule: 'done', link: 'working' })).toEqual(everyStart)
  })

  it('still folds the rest of a finished turn behind its line', async () => {
    await showThread({ archive: 'done', schedule: 'done', link: 'done' })
    const text = host.textContent ?? ''
    expect(text).not.toContain('Two separate changes')
    expect(text).toContain('Schedule builder and Link builder are on it.')
  })

  /** A command the agent ran: tool work, which separates two starts. */
  const command = (id: string, seconds: number): UIMessage =>
    ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'tool-Bash', toolCallId: id, state: 'output-available', input: { command: 'gh pr list' }, output: '' }] }) as unknown as UIMessage

  /** A finished turn that started `titles` with `between` rows after each start; each card list as the chat shows it. */
  async function showStarts(rows: UIMessage[], titles: string[]) {
    const subagents = titles.map((title, index) => subagent(title, [[`d-${index}`, 0]], 'done'))
    const cards = joinSubagentCards(collectSubagentCalls(rows), subagents, { loaded: true, turnActive: false })
    await act(async () => {
      vi.advanceTimersByTime(Math.max(0, T0 + 600_000 - Date.now()))
    })
    await act(async () => {
      root.render(createElement(SubagentCardsContext.Provider, { value: cards },
        createElement(MessageList, { messages: rows, status: chatStatusFromTurn({ phase: 'completed', turnId: 'run:9' }) })))
    })
    return readCards()
  }

  function readCards() {
    return [...host.querySelectorAll('.subagent-cards')].map((list) => ({
      head: list.querySelector('.subagent-group-title')?.textContent ?? null,
      // Each row opens its subagent's thread.
      rows: [...list.querySelectorAll<HTMLButtonElement>('button.subagent-card')].filter((row) => !row.disabled).map((row) => row.textContent?.match(/^[A-Z][a-z]+ builder/)?.[0])
    }))
  }

  it('shows a quick burst of starts as one open card that lists them, folded to the first name when closed', async () => {
    const titles = ['Archive builder', 'Schedule builder', 'Link builder']
    const rows = [
      user('u9', 0, 'Three changes, in parallel'),
      thought('b0', 1, 'One subagent per change.'),
      start('b1', 2, 'delegate_task', titles[0]!, 'd-0'),
      thought('b2', 13, 'Next, the schedule.'),
      start('b3', 14, 'delegate_task', titles[1]!, 'd-1'),
      start('b4', 25, 'delegate_task', titles[2]!, 'd-2'),
      reply('b5', 36, 'All three are on it.')
    ]
    expect(await showStarts(rows, titles)).toEqual([{ head: '3 subagents', rows: titles }])
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button.subagent-group-head')!.click()
    })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(readCards()).toEqual([{ head: 'Archive builder + 2', rows: [] }])
  })

  it('gives starts far apart cards of their own', async () => {
    const titles = ['Archive builder', 'Schedule builder']
    // Tool work between the starts.
    const worked = [
      user('u9', 0, 'Two changes'),
      start('w1', 2, 'delegate_task', titles[0]!, 'd-0'),
      command('w2', 4),
      start('w3', 6, 'delegate_task', titles[1]!, 'd-1'),
      reply('w4', 20, 'Both are on it.')
    ]
    expect(await showStarts(worked, titles)).toEqual([{ head: null, rows: [titles[0]] }, { head: null, rows: [titles[1]] }])
    // Only thinking between them, but minutes apart.
    const later = [
      user('u9', 0, 'Two changes'),
      start('l1', 2, 'delegate_task', titles[0]!, 'd-0'),
      thought('l2', 100, 'Now the schedule, after reading the code.'),
      start('l3', 200, 'delegate_task', titles[1]!, 'd-1'),
      reply('l4', 210, 'Both are on it.')
    ]
    expect(await showStarts(later, titles)).toEqual([{ head: null, rows: [titles[0]] }, { head: null, rows: [titles[1]] }])
  })
})
