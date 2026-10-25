import { describe, expect, it } from 'vitest'
import { NotificationThreadIndex, resolveThreadNotification } from '../src/main/notifications/threadNotificationTarget'
import type { ThreadLineage } from '../src/shared/types'

const subagentOf = (parentThreadId: string, rootThreadId = parentThreadId): ThreadLineage => ({ parentThreadId, rootThreadId, relationship: 'subagent' })
const rows = (...entries: Array<{ id: string; name?: string; lineage?: ThreadLineage }>) =>
  new Map(entries.map((entry) => [entry.id, { name: 'Untitled', ...entry }]))

describe('resolveThreadNotification', () => {
  const threads = rows(
    { id: 'parent', name: 'Fix the build' },
    { id: 'child', name: 'API reviewer', lineage: subagentOf('parent') },
    { id: 'grandchild', name: 'Deep helper', lineage: subagentOf('child', 'parent') },
    { id: 'orphan', name: 'Left behind', lineage: subagentOf('trashed') }
  )

  it('notifies for a thread as itself', () => {
    expect(resolveThreadNotification('parent', 'completed', threads)).toEqual({ threadId: 'parent' })
    expect(resolveThreadNotification('parent', 'question', threads)).toEqual({ threadId: 'parent' })
  })

  it.each(['completed', 'idle'] as const)('stays quiet when a subagent is %s', (kind) => {
    expect(resolveThreadNotification('child', kind, threads)).toBeNull()
    expect(resolveThreadNotification('grandchild', kind, threads)).toBeNull()
  })

  it('announces a subagent question under the parent name', () => {
    expect(resolveThreadNotification('child', 'question', threads)).toEqual({ threadId: 'parent', parentName: 'Fix the build', viaThreadId: 'child' })
  })

  it('announces a nested subagent question under the nearest shown ancestor', () => {
    expect(resolveThreadNotification('grandchild', 'question', threads)).toEqual({ threadId: 'parent', parentName: 'Fix the build', viaThreadId: 'grandchild' })
  })

  it('treats a subagent whose parent is gone as a normal thread', () => {
    expect(resolveThreadNotification('orphan', 'completed', threads)).toEqual({ threadId: 'orphan' })
    expect(resolveThreadNotification('orphan', 'question', threads)).toEqual({ threadId: 'orphan' })
  })

  it('notifies as itself for a thread it has no row for', () => {
    expect(resolveThreadNotification('unknown', 'completed', threads)).toEqual({ threadId: 'unknown' })
  })
})

describe('NotificationThreadIndex', () => {
  const list = [{ id: 'parent', name: 'Parent' }, { id: 'child', name: 'Child', lineage: subagentOf('parent') }]

  it('learns lineage from a list, an event payload or a reply, per profile', () => {
    const index = new NotificationThreadIndex()
    index.note('a', list)
    index.note('b', { threads: list })
    expect(index.resolve('a', 'child', 'completed')).toBeNull()
    expect(index.resolve('b', 'child', 'completed')).toBeNull()
    expect(index.resolve('other-profile', 'child', 'completed')).toEqual({ threadId: 'child' })
  })

  it('replaces a profile’s rows with each new list and ignores payloads without one', () => {
    const index = new NotificationThreadIndex()
    index.note('a', list)
    index.note('a', { unrelated: true })
    expect(index.resolve('a', 'child', 'idle')).toBeNull()
    index.note('a', [{ id: 'parent', name: 'Parent' }])
    expect(index.resolve('a', 'child', 'idle')).toEqual({ threadId: 'child' })
  })
})
