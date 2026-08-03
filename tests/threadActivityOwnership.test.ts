import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '../src/shared/types'
import {
  deriveThreadActivity,
  ThreadRuntimeManager
} from '../src/mms/runtime/ThreadRuntimeManager'

const processingStatuses: AgentStatus[] = ['starting', 'running', 'merging']
const restingStatuses: AgentStatus[] = [
  'ready',
  'conflict',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
]

describe('thread activity ownership', () => {
  it.each(processingStatuses)(
    'derives processing while an owned agent is %s',
    (status) => {
      expect(deriveThreadActivity('completed', [{ status }])).toBe('processing')
    }
  )

  it.each(restingStatuses)(
    'preserves the turn state after an owned agent becomes %s',
    (status) => {
      expect(deriveThreadActivity('completed', [{ status }])).toBe('completed')
    }
  )

  it('stays processing until both the parent turn and background agents finish', () => {
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

    // Parent completion must not replace the spinner while background work remains.
    manager.setActivity('thread-a', 'completed')
    expect(manager.getActivity('thread-a')).toBe('processing')
    expect(manager.getActivitySnapshot()).toEqual({ 'thread-a': 'processing' })

    runtime.agents.updateStatus(backgroundAgent.id, 'ready')
    expect(manager.getActivity('thread-a')).toBe('completed')
    expect(states[states.length - 1]).toBe('completed')
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
      'thread-a': 'processing',
      'thread-b': 'completed'
    })
  })
})
