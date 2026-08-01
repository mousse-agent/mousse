import { describe, expect, it, vi } from 'vitest'
import { detectThreadRuntime } from '../src/mms/channels/threadRuntime'

describe('detectThreadRuntime', () => {
  it('falls back to channel turn controls', () => {
    const host = {
      isChannelTurnActive: vi.fn((id: string) => id === 't1'),
      abortChannelTurn: vi.fn(() => true),
      steerChannelTurn: vi.fn(() => true)
    }
    const controls = detectThreadRuntime(host)
    expect(controls.isActive('t1')).toBe(true)
    expect(controls.isActive('t2')).toBe(false)
    expect(controls.abort('t1')).toBe(true)
    expect(controls.steer('t1', 'go')).toBe(true)
    expect(controls.hasMmsQueue).toBe(false)
  })

  it('prefers threadRuntime queue APIs when present', () => {
    const enqueue = vi.fn(async () => ({ id: 'q1' }))
    const list = vi.fn(() => [])
    const host = {
      threadRuntime: {
        isThreadTurnActive: (id: string) => id === 'x',
        enqueueThreadMessage: enqueue,
        listThreadQueue: list
      }
    }
    const controls = detectThreadRuntime(host)
    expect(controls.hasMmsQueue).toBe(true)
    expect(controls.isActive('x')).toBe(true)
    void controls.enqueue?.('x', 'hello')
    expect(enqueue).toHaveBeenCalled()
  })

  it('tolerates empty hosts', () => {
    const controls = detectThreadRuntime(undefined)
    expect(controls.isActive('a')).toBe(false)
    expect(controls.abort('a')).toBe(false)
    expect(controls.steer('a', 'x')).toBe(false)
    expect(controls.hasMmsQueue).toBe(false)
  })
})
