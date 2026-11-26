// @vitest-environment jsdom
/**
 * Subagent cards stay findable in the parent's chat: through the same path the chat shell takes (the daemon's
 * list fetched into the store, joined with the transcript by `useSubagentCardModels`, drawn by the message list).
 */
import type { UIMessage } from 'ai'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { SubagentCardsContext } from '../../src/renderer/chat/components/agent-elements/tools/subagent-cards-context'
import { chatStatusFromTurn } from '../../src/renderer/chat/adapters/mousseToUI'
import { useSubagentCardModels } from '../../src/renderer/hooks/useSubagentCards'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { SubagentNoticeItem, SubagentSummary, SubagentTaskSummary } from '../../src/shared/subagents'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-11-18T10:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const PARENT = 'parent-thread'
const CHILD = 'child-reviewer'

const user = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], createdAt: at(seconds) }) as unknown as UIMessage
const reply = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'text', text }] }) as unknown as UIMessage
/** A recorded `delegate_task` call, as the daemon keeps it. */
const delegate = (id: string, seconds: number, title: string, delegationId: string, childThreadId: string): UIMessage =>
  ({
    id,
    role: 'assistant',
    createdAt: at(seconds),
    parts: [{
      type: 'tool-Subagent',
      toolCallId: `call-${id}`,
      state: 'output-available',
      subagentTool: 'delegate_task',
      input: { recordVersion: 1, title },
      output: JSON.stringify({ delegationId, childThreadId, title, status: 'running' })
    }]
  }) as unknown as UIMessage
/** A Mousse thread tool call (`thread_send`, `thread_update`) with the result it returned. */
const threadTool = (id: string, seconds: number, tool: string, result: Record<string, unknown>): UIMessage =>
  ({
    id,
    role: 'assistant',
    createdAt: at(seconds),
    parts: [{ type: `tool-mcp__mousse__${tool}`, toolCallId: `call-${id}`, state: 'output-available', input: { threadId: CHILD }, output: JSON.stringify(result) }]
  }) as unknown as UIMessage
/** The message the daemon adds when a task's result reaches the parent. */
const notice = (id: string, seconds: number, item: SubagentNoticeItem): UIMessage =>
  ({ id, role: 'user', createdAt: at(seconds), parts: [{ type: 'text', text: 'MODEL-ONLY' }], metadata: { subagentNotice: [item] } }) as unknown as UIMessage

const task = (delegationId: string, seconds: number, extra: Partial<SubagentTaskSummary> = {}): SubagentTaskSummary => ({
  delegationId, childRunId: `run-${delegationId}`, outcome: 'done', unread: false, continued: false, createdAt: at(seconds), completedAt: at(seconds + 5), ...extra
})
const row = (childThreadId: string, title: string, tasks: SubagentTaskSummary[], extra: Partial<SubagentSummary> = {}): SubagentSummary => ({
  childThreadId, title, activity: 'idle', state: 'done', latestDelegationId: tasks[tasks.length - 1]!.delegationId, unread: false,
  provider: null, model: null, workspace: 'isolated', role: null, createdAt: tasks[0]!.createdAt, updatedAt: tasks[0]!.createdAt, waitingOn: [], tasks, ...extra
})

/** The chat shell's wiring: the cards come from the transcript and the store's lists. */
function Chat({ messages }: { messages: UIMessage[] }) {
  const cards = useSubagentCardModels(PARENT, messages)
  return createElement(SubagentCardsContext.Provider, { value: cards },
    createElement(MessageList, { messages, status: chatStatusFromTurn({ phase: 'completed', turnId: 'run:1' }) }))
}

let host: HTMLDivElement
let root: Root
let listed: SubagentSummary[]

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  listed = []
  ;(window as unknown as { mousse: unknown }).mousse = {
    orchestrator: { getMessages: async () => [] },
    // What the app's IPC answers: the live subagents, then the removed ones, each marked.
    subagents: { list: async () => listed, onUpdated: () => () => undefined }
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(useAppStore.getInitialState())
})

/** A cold open of the thread: the list loads, then the chat shows. */
async function open(messages: UIMessage[]) {
  await act(async () => root.render(createElement(Chat, { messages })))
  await vi.waitFor(() => expect(useAppStore.getState().subagentsByParent[PARENT]).toBeDefined())
  await act(async () => {})
}

/** Opens every folded "Worked for" section in the list so settled subagent cards inside can be inspected. */
async function openFolds() {
  for (const toggle of host.querySelectorAll<HTMLButtonElement>('.turn-work-toggle[aria-expanded="false"]')) {
    await act(async () => toggle.click())
  }
}

const cardRows = () =>
  [...host.querySelectorAll<HTMLButtonElement>('button.subagent-card')].map((button) => ({
    title: button.querySelector('.subagent-card-title')?.textContent,
    line: button.querySelector('.subagent-card-line')?.textContent,
    opens: !button.disabled
  }))

describe('a subagent whose thread was deleted', () => {
  it('keeps its card inside Worked for after a reload, with its name, outcome and the start of its result, and opens nothing', async () => {
    listed = [row(CHILD, '', [task('d1', 2, { summary: 'Found two bugs: the retry loop and the cache key.' })], { removed: true })]
    await open([user('u1', 0, 'Review the module'), delegate('a1', 2, 'API reviewer', 'd1', CHILD), reply('a2', 3, 'The reviewer is on it.')])
    expect(cardRows()).toEqual([])
    expect(host.querySelector('.turn-work-toggle [title="1 subagent inside"]')).not.toBeNull()
    await openFolds()
    expect(cardRows()).toEqual([{ title: 'API reviewer', line: 'Found two bugs: the retry loop and the cache key.', opens: false }])
    // Nest and the other lists never see it.
    expect(useAppStore.getState().subagentsByParent[PARENT]).toEqual([])
  })

  it('shows a failed task outside Worked for as failed, with why', async () => {
    listed = [row(CHILD, '', [task('d1', 2, { outcome: 'failed', error: 'The provider refused the request.' })], { removed: true, state: 'failed' })]
    await open([user('u1', 0, 'Review the module'), delegate('a1', 2, 'API reviewer', 'd1', CHILD)])
    const [card] = cardRows()
    expect(card).toMatchObject({ title: 'API reviewer', opens: false })
    expect(card!.line).toContain('Failed')
    expect(card!.line).toContain('The provider refused the request.')
  })

  it('is found by an older call that recorded only its title, through the name its result notice kept', async () => {
    listed = [row(CHILD, '', [task('d1', 2, { summary: 'Found two bugs.' })], { removed: true })]
    // Recorded before calls kept the task they started: the row names the subagent only.
    const titleOnly = {
      id: 'a1', role: 'assistant', createdAt: at(2),
      parts: [{ type: 'tool-Subagent', toolCallId: 'call-a1', state: 'output-available', subagentTool: 'delegate_task', input: { recordVersion: 1, title: 'Tests reviewer' }, output: 'Started.' }]
    } as unknown as UIMessage
    await open([
      user('u1', 0, 'Review the module'),
      titleOnly,
      notice('w1', 10, { delegationId: 'd1', childThreadId: CHILD, title: 'Tests  reviewer', runStatus: 'completed', fullyShown: true }),
      reply('a2', 11, 'It finished.')
    ])
    expect(host.querySelectorAll('.subagent-notice')).toHaveLength(0)
    await openFolds()
    expect(cardRows()).toEqual([{ title: 'Tests reviewer', line: 'Found two bugs.', opens: false }])
  })

  it('keeps a notice that names no task out of sight, as the card shows that subagent', async () => {
    listed = [row(CHILD, '', [task('d1', 2, { outcome: 'stopped' })], { removed: true, state: 'stopped' })]
    await open([
      user('u1', 0, 'Review the module'),
      delegate('a1', 2, 'API reviewer', 'd1', CHILD),
      // An older stop notice, written before notices named their task.
      notice('w1', 10, { delegationId: '', childThreadId: CHILD, title: 'API reviewer', runStatus: 'cancelled', fullyShown: true, event: 'stopped' }),
      reply('a2', 11, 'It was stopped.')
    ])
    expect(host.querySelectorAll('.subagent-notice')).toHaveLength(0)
    await openFolds()
    expect(cardRows()).toHaveLength(1)
  })
})

describe('a follow-up task given with a thread tool', () => {
  const first = [user('u1', 0, 'Review the module'), delegate('a1', 2, 'API reviewer', 'd1', CHILD), reply('a2', 3, 'The reviewer is on it.')]
  const reviewer = (tasks: SubagentTaskSummary[]) => [row(CHILD, 'API reviewer', tasks)]

  it('thread_send to the caller’s own subagent shows as that task’s card inside Worked for', async () => {
    listed = reviewer([task('d1', 2, { continued: true }), task('d2', 101)])
    await open([
      ...first,
      user('u2', 100, 'Also check the tests'),
      threadTool('s1', 101, 'thread_send', { threadId: CHILD, runId: 'run-d2', queued: false, delivery: 'started', delegationId: 'd2', title: 'API reviewer', subagent: true }),
      reply('a3', 102, 'Sent.')
    ])
    await openFolds()
    expect(cardRows().map((card) => card.title)).toEqual(['API reviewer', 'API reviewer'])
    expect(cardRows().every((card) => card.opens)).toBe(true)
  })

  it('thread_update that restarted the subagent now shows as the new task’s card inside Worked for', async () => {
    listed = reviewer([task('d1', 2, { continued: true, outcome: 'interrupted' }), task('d2', 101)])
    await open([
      ...first,
      user('u2', 100, 'Let it edit'),
      threadTool('s1', 101, 'thread_update', { threadId: CHILD, title: 'API reviewer', access: { readOnly: false }, changed: true, applied: 'now', stoppedRunId: 'run-d1', runId: 'run-d2', delegationId: 'd2' }),
      reply('a3', 102, 'Lifted.')
    ])
    await openFolds()
    expect(cardRows().map((card) => card.title)).toEqual(['API reviewer', 'API reviewer'])
  })

  it('a thread_send to any other thread keeps its plain row', async () => {
    listed = reviewer([task('d1', 2)])
    await open([...first, user('u2', 100, 'Tell the other thread'), threadTool('s1', 101, 'thread_send', { threadId: 'someone-else', runId: 'r', queued: false, delivery: 'started' })])
    await openFolds()
    expect(cardRows()).toHaveLength(1)
  })

  it('a later task with no card of its own keeps its result line, though the subagent has an older card', async () => {
    listed = reviewer([task('d1', 2, { continued: true }), task('d2', 101)])
    await open([
      ...first,
      notice('w1', 110, { delegationId: 'd2', childThreadId: CHILD, title: 'API reviewer', runStatus: 'completed', fullyShown: true }),
      reply('a3', 111, 'It finished the second task.')
    ])
    const lines = host.querySelectorAll('.subagent-notice')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.textContent).toMatch(/API reviewers*finished/)
    // The first task's own result is the card's state: no line of its own.
    await open([
      ...first,
      notice('w0', 10, { delegationId: 'd1', childThreadId: CHILD, title: 'API reviewer', runStatus: 'completed', fullyShown: true }),
      reply('a3', 11, 'It finished.')
    ])
    expect(host.querySelectorAll('.subagent-notice')).toHaveLength(0)
  })
})
