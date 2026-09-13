import { describe, expect, it, vi } from 'vitest'
import type { Thread } from '../src/shared/types'
import { createComposerThread } from '../src/renderer/lib/createComposerThread'

describe('blank composer thread creation', () => {
  const thread = { id: 'created-thread' } as Thread
  it('creates and activates the exact thread before selecting it for the send', async () => {
    const calls: string[] = []
    const id = await createComposerThread({
      create: async () => { calls.push('create'); return thread },
      stillVisible: () => true,
      activate: (created) => { calls.push(`activate:${created.id}`) },
      select: async (selected) => { calls.push(`select:${selected}`) }
    })
    expect(id).toBe(thread.id)
    expect(calls).toEqual(['create', 'activate:created-thread', 'select:created-thread'])
  })

  it('does not activate or send after the user navigates while creation is pending', async () => {
    const activate = vi.fn()
    const select = vi.fn()
    const id = await createComposerThread({ create: async () => thread, stillVisible: () => false, activate, select })
    expect(id).toBeNull()
    expect(activate).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })

  it('does not send if selection completes after another navigation', async () => {
    let visible = true
    const id = await createComposerThread({
      create: async () => thread,
      stillVisible: () => visible,
      activate: vi.fn(),
      select: async () => { visible = false }
    })
    expect(id).toBeNull()
  })

  it('propagates creation failure without changing selection', async () => {
    const activate = vi.fn()
    const select = vi.fn()
    await expect(createComposerThread({
      create: async () => { throw new Error('Disk full') },
      stillVisible: () => true, activate, select
    })).rejects.toThrow('Disk full')
    expect(activate).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })
})
