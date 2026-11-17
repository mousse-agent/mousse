import { describe, expect, it } from 'vitest'
import { nextSteerableQueueItem } from '../../src/renderer/lib/queuedContent'
import type { QueuedMessage } from '../../src/shared/types'

const item = (id: string, patch: Partial<QueuedMessage> = {}): QueuedMessage =>
  ({ id, threadId: 't1', content: id, enqueuedAt: '2026-11-13T10:00:00Z', order: 1, intent: 'normal', state: 'pending', source: 'gui', ...patch }) as QueuedMessage

describe('the queued message the steer chord sends from an empty composer', () => {
  it('is the first waiting one', () => {
    expect(nextSteerableQueueItem([item('a'), item('b')], {})?.id).toBe('a')
  })

  it('skips one on its way, one being sent, one already steering, and a fixed steer item', () => {
    const items = [
      item('optimistic:1'),
      item('busy'),
      item('steering', { state: 'steering' }),
      item('notice', { intent: 'steer' }),
      item('next')
    ]
    expect(nextSteerableQueueItem(items, { busy: true })?.id).toBe('next')
  })

  it('is none when nothing can be sent now', () => {
    expect(nextSteerableQueueItem([], {})).toBeUndefined()
    expect(nextSteerableQueueItem([item('notice', { intent: 'steer' })], {})).toBeUndefined()
  })
})
