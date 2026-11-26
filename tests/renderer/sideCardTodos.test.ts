// @vitest-environment jsdom
/**
 * The thread side card's To-dos: the list the thread's runtime keeps (Claude's TodoWrite, Codex's plan), the latest one
 * set, updated as the turn rewrites it, and absent while the thread has none. It starts collapsed to how far it is.
 *
 * Which messages set the list:
 * | message                                   | sets the list |
 * | Claude TodoWrite (kind todo)              | yes           |
 * | Codex plan update with steps              | yes           |
 * | Codex/Claude plan with text only          | no            |
 * | a subagent's TodoWrite (parentId)         | no            |
 * | a failed TodoWrite                        | no            |
 * | TodoWrite with an empty list (cleared)    | yes, to none  |
 *
 * Claude Code turns TodoWrite off by default and keeps its list with TaskCreate and TaskUpdate instead; the tasks an
 * agent keeps with Mousse's create_task follow the runtime's list.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivityItem } from '../../src/shared/agentActivity'
import type { ChatMessage, Task } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The card's other sections read git, devices and quick actions; only To-dos is under test.
vi.mock('../../src/renderer/components/sideCard/DeviceSection', () => ({ DeviceSection: () => null }))
vi.mock('../../src/renderer/components/sideCard/GitSection', () => ({ GitSection: () => null }))
vi.mock('../../src/renderer/components/sideCard/ActionsSection', () => ({ ActionsSection: () => null }))
vi.mock('../../src/renderer/components/sideCard/LineageSection', () => ({ LineageSection: () => null }))
vi.mock('../../src/renderer/components/sideCard/StartedThreadsSection', () => ({ StartedThreadsSection: () => null }))

const { SideCardSections } = await import('../../src/renderer/components/sideCard/ThreadSideCard')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { latestTodoMessage, todoEntriesOf, todoStatus } = await import('../../src/renderer/lib/todoList')

const AT = '2026-11-19T09:00:00.000Z'
let n = 0
function activityMessage(activity: Partial<AgentActivityItem> & Pick<AgentActivityItem, 'kind'>): ChatMessage {
  const id = `m${++n}`
  return {
    id, role: 'assistant', content: '', timestamp: AT,
    activity: { id, callId: id, toolName: 'TodoWrite', status: 'done', startedAt: AT, ...activity } as AgentActivityItem
  } as ChatMessage
}
const todo = (items: Array<[string, 'pending' | 'in_progress' | 'completed']>, extra: Partial<AgentActivityItem> = {}) =>
  activityMessage({ kind: 'todo', items: items.map(([content, status]) => ({ content, status })), ...extra } as AgentActivityItem)
const plan = (steps: Array<[string, string]>) => activityMessage({ kind: 'plan', toolName: 'update_plan', steps: steps.map(([step, status]) => ({ step, status })) } as AgentActivityItem)

const claudeCall = (toolName: string, input: Record<string, unknown>, output?: string) =>
  activityMessage({ kind: 'generic', toolName, input, ...(output ? { output } : {}) } as AgentActivityItem)
const keptTask = (id: string, description: string, status: Task['status'], progressMessage?: string): Task =>
  ({ id, description, status, createdAt: AT, ...(progressMessage ? { progressMessage } : {}) }) as Task

let root: Root
let host: HTMLElement
const appInitial = useAppStore.getInitialState()

const section = () => [...host.querySelectorAll('.side-card-section')].find((item) => item.textContent?.startsWith('To-dos'))
const rows = () => [...(section()?.querySelectorAll('li') ?? [])].map((row) => `${row.querySelector('svg')?.getAttribute('aria-label')}: ${row.textContent}`)
async function show(messages: ChatMessage[]) {
  await act(async () => useAppStore.setState({ messages }))
}
const toggle = () => section()!.querySelector<HTMLButtonElement>('.side-card-section-toggle')!

beforeEach(async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(SideCardSections, { threadId: 't1', projectId: null })))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState({ messages: appInitial.messages, tasks: appInitial.tasks, sideCardCollapsed: appInitial.sideCardCollapsed })
})

describe('the side card To-dos', () => {
  it('starts collapsed to how far the list is, opens on click, and the choice holds', async () => {
    await show([todo([['One', 'completed'], ['Two', 'pending']])])
    expect(toggle().textContent).toBe('To-dos1 of 2 done')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(section()!.querySelector('li')).toBeNull()
    await act(async () => toggle().click())
    expect(rows()).toEqual(['Done: One', 'To do: Two'])
    expect(useAppStore.getState().sideCardCollapsed['To-dos']).toBe(false)
  })

  it('shows the latest list and follows it as the turn rewrites it', async () => {
    await show([{ id: 'u1', role: 'user', content: 'Fix the login', timestamp: AT } as ChatMessage])
    expect(section()).toBeUndefined()

    const first = todo([['Read the login form', 'in_progress'], ['Fix the bug', 'pending']])
    await show([first])
    await act(async () => toggle().click())
    expect(rows()).toEqual(['In progress: Read the login form', 'To do: Fix the bug'])

    // The same call's list streams in updated, then a later call replaces it.
    await show([{ ...first, activity: { ...first.activity!, items: [{ content: 'Read the login form', status: 'completed' }, { content: 'Fix the bug', status: 'in_progress' }] } as AgentActivityItem }])
    expect(rows()).toEqual(['Done: Read the login form', 'In progress: Fix the bug'])
    await show([first, todo([['Run the tests', 'pending']])])
    expect(rows()).toEqual(['To do: Run the tests'])
  })

  it('shows Codex plan steps', async () => {
    await show([plan([['Find the cause', 'completed'], ['Patch it', 'inProgress'], ['Verify', 'pending']])])
    await act(async () => toggle().click())
    expect(rows()).toEqual(['Done: Find the cause', 'In progress: Patch it', 'To do: Verify'])
  })

  it('follows Claude Code’s TaskCreate and TaskUpdate', async () => {
    await show([
      claudeCall('TaskCreate', { subject: 'Read the form' }, 'Task #1 created successfully: Read the form'),
      claudeCall('TaskCreate', { subject: 'Fix the bug' }, 'Task #2 created successfully: Fix the bug'),
      claudeCall('TaskCreate', { subject: 'Drop me' }, 'Task #3 created successfully: Drop me'),
      claudeCall('TaskUpdate', { taskId: '1', status: 'completed' }),
      claudeCall('TaskUpdate', { taskId: '2', status: 'in_progress', subject: 'Fix the login bug' }),
      claudeCall('TaskUpdate', { taskId: '3', status: 'deleted' }),
      // Still running: its id is not known yet, so it shows as to do.
      claudeCall('TaskCreate', { subject: 'Run the tests' })
    ])
    await act(async () => toggle().click())
    expect(rows()).toEqual(['Done: Read the form', 'In progress: Fix the login bug', 'To do: Run the tests'])
  })

  it('shows the tasks the agent keeps on the thread with create_task, after the runtime’s list', async () => {
    await act(async () => useAppStore.setState({ tasks: [keptTask('a', 'Ship the fix', 'in_progress', 'Tests running'), keptTask('b', 'Tell the owner', 'pending')] }))
    expect(toggle().textContent).toBe('To-dos0 of 2 done')
    await show([todo([['Plan it', 'completed']])])
    await act(async () => toggle().click())
    expect(rows()).toEqual(['Done: Plan it', 'In progress: Ship the fix', 'To do: Tell the owner'])
    expect(section()!.querySelectorAll('li')[1]!.getAttribute('title')).toContain('Tests running')
  })

  it('goes once the list is cleared', async () => {
    await show([todo([['One', 'pending']])])
    expect(section()).toBeDefined()
    await show([todo([['One', 'pending']]), todo([])])
    expect(section()).toBeUndefined()
  })
})

describe('which message sets the list', () => {
  const base = todo([['Kept', 'pending']])
  it.each([
    ['a plan with text only', activityMessage({ kind: 'plan', text: '1. Do it' } as AgentActivityItem), 'Kept'],
    ['a subagent’s TodoWrite', todo([['Inner', 'pending']], { parentId: 'm-parent' }), 'Kept'],
    ['a failed TodoWrite', todo([['Failed', 'pending']], { status: 'failed' }), 'Kept'],
    ['a later TodoWrite', todo([['Later', 'pending']]), 'Later'],
    ['a later plan with steps', plan([['Step', 'pending']]), 'Step']
  ])('after %s', (_label, later, expected) => {
    expect(todoEntriesOf(latestTodoMessage([base, later])).map((entry) => entry.text)).toEqual([expected])
  })

  it.each([
    ['in_progress', 'in_progress'], ['inProgress', 'in_progress'], ['completed', 'completed'], ['pending', 'pending'],
    ['failed', 'failed'], ['interrupted', 'cancelled'], ['cancelled', 'cancelled'], [undefined, 'pending']
  ])('reads the status %s as %s', (raw, expected) => {
    expect(todoStatus(raw)).toBe(expected)
  })
})
