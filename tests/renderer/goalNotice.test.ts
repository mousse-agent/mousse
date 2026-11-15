// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoalNotice, type GoalClient } from '../../src/renderer/chat/components/GoalNotice'
import { ComposerNoticeProvider, ComposerNoticeSlot } from '../../src/renderer/components/ComposerNotice'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { ThreadGoal } from '../../src/shared/threadGoal'
import type { Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The goal marker, mounted in the composer's dock as the chat mounts it, reading the thread list: one line with the
 * state and the goal, the details in the tooltip, and the one action each state needs.
 */
const goal = (patch: Partial<ThreadGoal> = {}): ThreadGoal => ({
  text: 'Make the five failing tests pass',
  state: 'working',
  turns: 3,
  turnLimit: 20,
  silentTurns: 0,
  setAt: '2026-11-15T10:00:00.000Z',
  updatedAt: '2026-11-15T10:05:00.000Z',
  lastReport: { status: 'continue', reason: 'Fixed four of five.', at: '2026-11-15T10:05:00.000Z' },
  ...patch
})
const thread = (g?: ThreadGoal): Thread => ({ id: 't1', name: 'Tests', createdAt: '', updatedAt: '', order: 0, ...(g ? { goal: g } : {}) })

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState({ threads: [] })
})

const line = () => host.querySelector<HTMLElement>('.composer-notice-text')
const notice = () => host.querySelector<HTMLElement>('.composer-notice')
const names = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).map((button) => button.getAttribute('aria-label') ?? button.textContent)
const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((entry) => (entry.getAttribute('aria-label') ?? entry.textContent)?.startsWith(label))!
const inSlot = (child: ReactNode) => createElement(ComposerNoticeProvider, null, createElement(Fragment, null, createElement(ComposerNoticeSlot), child))
const show = (client: GoalClient) => act(() => root.render(inSlot(createElement(GoalNotice, { threadId: 't1', client }))))
const setGoal = (g?: ThreadGoal) => act(() => { useAppStore.setState({ threads: [thread(g)] }) })

describe('the goal marker', () => {
  it('shows nothing for a thread without a goal, and appears when one is set', () => {
    const client: GoalClient = { act: vi.fn(async () => undefined) }
    setGoal(undefined)
    show(client)
    expect(notice()).toBeNull()
    setGoal(goal())
    expect(line()!.textContent).toContain('Goal · Working · turn 3/20')
    expect(line()!.textContent).toContain('Make the five failing tests pass')
    expect(line()!.title).toContain('Latest: Fixed four of five.')
  })

  it.each([
    { state: 'working' as const, actions: ['Stop'], press: 'Stop', action: 'stop', line: 'Goal · Working' },
    { state: 'met' as const, actions: ['Clear'], press: 'Clear', action: 'clear', line: 'Goal · Met' },
    { state: 'stopped' as const, actions: ['Continue'], press: 'Continue', action: 'continue', line: 'Goal · Stopped' },
    { state: 'stuck' as const, actions: ['Continue'], press: 'Continue', action: 'continue', line: 'Goal · Stuck' }
  ])('$state: one action, $press, sends $action', async ({ state, actions, press, action, line: text }) => {
    const client: GoalClient = { act: vi.fn(async () => undefined) }
    setGoal(goal({ state, ...(state === 'stopped' ? { stoppedBy: 'turn_limit' } : {}), ...(state === 'stuck' ? { lastReport: { status: 'blocked', reason: 'Need the staging password.', at: '' } } : {}) }))
    show(client)
    expect(line()!.textContent).toContain(text)
    expect(names().filter((name) => name !== 'Dismiss')).toEqual(actions)
    await act(async () => { button(press).click() })
    expect(client.act).toHaveBeenCalledWith('t1', action)
  })

  it('a stuck goal shows the agent\'s reason on the line; a stopped one says why in the tooltip', () => {
    const client: GoalClient = { act: vi.fn(async () => undefined) }
    setGoal(goal({ state: 'stuck', lastReport: { status: 'blocked', reason: 'Need the staging password.', at: '' } }))
    show(client)
    expect(line()!.textContent).toContain('Need the staging password.')
    setGoal(goal({ state: 'stopped', stoppedBy: 'turn_limit' }))
    expect(line()!.title).toContain('Reached the 20-turn limit.')
  })

  it('a refused press shows its error in place of the line', async () => {
    const client: GoalClient = { act: vi.fn(async () => { throw new Error('This thread has no goal.') }) }
    setGoal(goal({ state: 'stopped', stoppedBy: 'user' }))
    show(client)
    await act(async () => { button('Continue').click() })
    expect(line()!.textContent).toContain('This thread has no goal.')
    expect(notice()!.dataset.tone).toBe('error')
  })
})
