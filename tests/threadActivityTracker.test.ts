import { describe, expect, it } from 'vitest'
import { ThreadActivityTracker } from '../src/main/data/ThreadActivityTracker'

describe('ThreadActivityTracker', () => {
  it('restores completed status from runtime snapshots without a live event', () => {
    const tracker = new ThreadActivityTracker()
    tracker.reconcileSnapshot({ thread: 'completed' })
    expect(tracker.getState('thread')).toBe('completed')
    tracker.reconcileSnapshot({ thread: 'completed' })
    expect(tracker.getSnapshot()).toEqual({ thread: 'completed' })
  })

  it('replaces completion when a new turn starts or the runtime becomes idle', () => {
    const tracker = new ThreadActivityTracker()
    tracker.setState('thread', 'completed')
    tracker.reconcileSnapshot({ thread: 'processing' })
    expect(tracker.getState('thread')).toBe('processing')
    tracker.reconcileSnapshot({ thread: 'idle' })
    expect(tracker.getSnapshot()).toEqual({})
  })
})
