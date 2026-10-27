import { describe, expect, it } from 'vitest'
import { isThreadActivityActive, turnPhaseActivity, type AgentStatus } from '../src/shared/types'
import {
  deriveThreadActivity,
  ThreadRuntimeManager
} from '../src/mms/runtime/ThreadRuntimeManager'

const busyStatuses: AgentStatus[] = ['starting', 'running', 'merging']
const restingStatuses: AgentStatus[] = [
  'ready',
  'conflict',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
]

describe('thread activity ownership', () => {
  it.each(busyStatuses)(
    'derives waiting after the turn while an owned agent is %s',
    (status) => {
      expect(deriveThreadActivity('completed', [{ status }])).toBe('waiting')
      expect(deriveThreadActivity('idle', [{ status }])).toBe('waiting')
    }
  )

  it.each(restingStatuses)(
    'preserves the turn state after an owned agent becomes %s',
    (status) => {
      expect(deriveThreadActivity('completed', [{ status }])).toBe('completed')
    }
  )

  it('keeps a live turn state while owned agents run', () => {
    const running = [{ status: 'running' as const }]
    expect(deriveThreadActivity('processing', running)).toBe('processing')
    expect(deriveThreadActivity('waiting', running)).toBe('waiting')
    // A question wins over background work.
    expect(deriveThreadActivity('awaiting_input', running, true)).toBe('awaiting_input')
  })

  it('derives waiting after the turn while delegated tasks run', () => {
    expect(deriveThreadActivity('completed', [], true)).toBe('waiting')
    expect(deriveThreadActivity('completed', [], false)).toBe('completed')
  })

  it('shows waiting, not done, until both the parent turn and background agents finish', () => {
    const manager = new ThreadRuntimeManager()
    const runtime = manager.getOrHydrate('thread-a')
    const states: string[] = []
    manager.on('activity', (event: { state: string }) => states.push(event.state))

    manager.setActivity('thread-a', 'processing')
    const firstAgent = runtime.agents.create({
      cliType: 'mousse',
      worktreePath: '/tmp/first',
      branch: 'first',
      executionMode: 'headless',
      status: 'running',
      task: 'first task'
    })
    expect(manager.getActivity('thread-a')).toBe('processing')

    // The worker can finish while its parent turn is still processing.
    runtime.agents.updateStatus(firstAgent.id, 'ready')
    expect(manager.getActivity('thread-a')).toBe('processing')

    const backgroundAgent = runtime.agents.create({
      cliType: 'mousse',
      worktreePath: '/tmp/background',
      branch: 'background',
      executionMode: 'headless',
      status: 'running',
      task: 'background task'
    })

    // Parent completion must not show Done while background work remains.
    manager.setActivity('thread-a', 'completed')
    expect(manager.getActivity('thread-a')).toBe('waiting')
    expect(manager.getActivitySnapshot()).toEqual({ 'thread-a': 'waiting' })

    runtime.agents.updateStatus(backgroundAgent.id, 'ready')
    expect(manager.getActivity('thread-a')).toBe('completed')
    expect(states[states.length - 1]).toBe('completed')
  })

  it('holds a finished turn in waiting while delegated tasks run', () => {
    const manager = new ThreadRuntimeManager()
    manager.getOrHydrate('thread-a')
    manager.setActivity('thread-a', 'completed')

    manager.setPendingDelegations('thread-a', true)
    expect(manager.getActivity('thread-a')).toBe('waiting')

    // A new turn (the wake) shows Working again.
    manager.setActivity('thread-a', 'processing')
    expect(manager.getActivity('thread-a')).toBe('processing')
    manager.setActivity('thread-a', 'completed')
    expect(manager.getActivity('thread-a')).toBe('waiting')

    manager.setPendingDelegations('thread-a', false)
    expect(manager.getActivity('thread-a')).toBe('completed')
  })

  it('holds a finished turn in waiting while the provider runs background work, and clears it when the work ends', () => {
    expect(deriveThreadActivity('completed', [], false, true)).toBe('waiting')
    expect(deriveThreadActivity('processing', [], false, true)).toBe('processing')
    const manager = new ThreadRuntimeManager()
    manager.getOrHydrate('thread-a')
    const states: string[] = []
    manager.on('activity', (event: { state: string }) => states.push(event.state))
    manager.setActivity('thread-a', 'completed')

    manager.setPendingBackgroundWork('thread-a', true)
    expect(manager.getActivity('thread-a')).toBe('waiting')
    // A turn that runs meanwhile shows Working, then Waiting again.
    manager.setActivity('thread-a', 'processing')
    expect(manager.getActivity('thread-a')).toBe('processing')
    manager.setActivity('thread-a', 'completed')
    expect(manager.getActivity('thread-a')).toBe('waiting')

    manager.setPendingBackgroundWork('thread-a', false)
    expect(manager.getActivity('thread-a')).toBe('completed')
    expect(states.at(-1)).toBe('completed')
  })

  it('keeps activity isolated to the thread that owns the running agent', () => {
    const manager = new ThreadRuntimeManager()
    const first = manager.getOrHydrate('thread-a')
    manager.getOrHydrate('thread-b')
    manager.setActivity('thread-b', 'completed')

    first.agents.create({
      cliType: 'mousse',
      worktreePath: '/tmp/owned',
      branch: 'owned',
      executionMode: 'headless',
      status: 'running',
      task: 'owned task'
    })

    expect(manager.getActivitySnapshot()).toEqual({
      'thread-a': 'waiting',
      'thread-b': 'completed'
    })
  })
})

describe('turn phase activity', () => {
  it('shows Waiting only for a tool phase blocked on wait tools', () => {
    expect(turnPhaseActivity('tool_running', true)).toBe('waiting')
    expect(turnPhaseActivity('tool_running')).toBe('processing')
    expect(turnPhaseActivity('thinking', true)).toBe('processing')
    expect(turnPhaseActivity('awaiting_input', true)).toBe('awaiting_input')
    expect(turnPhaseActivity('completed')).toBe('completed')
    expect(turnPhaseActivity('failed')).toBe('idle')
  })

  it('counts Working and Waiting as one active work cycle', () => {
    expect(isThreadActivityActive('processing')).toBe(true)
    expect(isThreadActivityActive('waiting')).toBe(true)
    expect(isThreadActivityActive('awaiting_input')).toBe(false)
    expect(isThreadActivityActive(undefined)).toBe(false)
  })
})

describe('a run paused by a usage limit', () => {
  it('has its own thread activity: not working, not finished, not idle', () => {
    expect(turnPhaseActivity('paused')).toBe('paused')
    expect(turnPhaseActivity('paused', true)).toBe('paused')
    expect(isThreadActivityActive('paused')).toBe(false)
  })

  it('stays Paused while owned agents or delegated tasks run, and an idle turn does not hide it', () => {
    expect(deriveThreadActivity('paused', [{ status: 'running' }], true, true)).toBe('paused')
    expect(deriveThreadActivity('paused', [])).toBe('paused')
  })

  it('is published to clients and replaced when the thread works again', () => {
    const manager = new ThreadRuntimeManager()
    manager.getOrHydrate('thread-a')
    const states: string[] = []
    manager.on('activity', (event: { state: string }) => states.push(event.state))

    manager.setActivity('thread-a', 'processing')
    manager.setActivity('thread-a', 'paused')
    expect(manager.getActivity('thread-a')).toBe('paused')
    expect(manager.getActivitySnapshot()).toEqual({ 'thread-a': 'paused' })
    manager.setActivity('thread-a', 'processing')
    manager.setActivity('thread-a', 'idle')

    expect(states).toEqual(['processing', 'paused', 'processing', 'idle'])
  })
})
