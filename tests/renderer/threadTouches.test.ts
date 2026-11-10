import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { Thread } from '../../src/shared/types'

const thread = (id: string, updatedAt: string) => ({ id, name: id, createdAt: updatedAt, updatedAt, order: 0 }) as Thread

describe("a save that moved only a thread's time", () => {
  beforeEach(() => {
    useAppStore.setState({ threads: [thread('a', '2026-11-10T10:00:00.000Z'), thread('b', '2026-11-10T10:00:00.000Z')] })
  })

  it("moves the listed thread's time forward and leaves the others as they were", () => {
    const before = useAppStore.getState().threads
    useAppStore.getState().applyThreadTouches([{ id: 'a', updatedAt: '2026-11-10T10:05:00.000Z' }])
    const after = useAppStore.getState().threads
    expect(after.find((entry) => entry.id === 'a')?.updatedAt).toBe('2026-11-10T10:05:00.000Z')
    expect(after.find((entry) => entry.id === 'b')).toBe(before.find((entry) => entry.id === 'b'))
  })

  it('never moves a time back, and changes nothing for a thread the window does not list', () => {
    const before = useAppStore.getState().threads
    useAppStore.getState().applyThreadTouches([{ id: 'a', updatedAt: '2026-11-10T09:00:00.000Z' }, { id: 'unknown', updatedAt: '2026-11-10T11:00:00.000Z' }])
    expect(useAppStore.getState().threads).toBe(before)
  })
})
