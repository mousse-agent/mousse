import { describe, expect, it } from 'vitest'
import { NotificationThreadIndex, resolveThreadNotification } from '../src/main/notifications/threadNotificationTarget'
import type { ThreadLineage } from '../src/shared/types'
import { bodyWithProject } from '../src/main/notifications/threadNotification'

const subagentOf = (parentThreadId: string, rootThreadId = parentThreadId): ThreadLineage => ({ parentThreadId, rootThreadId, relationship: 'subagent' })
const rows = (...entries: Array<{ id: string; name?: string; lineage?: ThreadLineage }>) =>
  new Map(entries.map((entry) => [entry.id, { name: 'Untitled', ...entry }]))

describe('resolveThreadNotification', () => {
  const threads = rows(
    { id: 'parent', name: 'Fix the build' },
    { id: 'child', name: 'API reviewer', lineage: subagentOf('parent') },
    { id: 'grandchild', name: 'Deep helper', lineage: subagentOf('child', 'parent') },
    { id: 'orphan', name: 'Left behind', lineage: subagentOf('trashed') },
    { id: 'aside', name: 'Quick question', lineage: { parentThreadId: 'child', rootThreadId: 'parent', relationship: 'side' } },
    { id: 'stray-aside', lineage: { parentThreadId: 'trashed', rootThreadId: 'trashed', relationship: 'side' } }
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

  it("announces only a side chat's question, under the thread shown for its parent, and nothing once that is gone", () => {
    expect(resolveThreadNotification('aside', 'completed', threads)).toBeNull()
    expect(resolveThreadNotification('aside', 'question', threads)).toEqual({ threadId: 'parent', parentName: 'Fix the build', viaThreadId: 'aside', sideChat: true })
    expect(resolveThreadNotification('stray-aside', 'question', threads)).toBeNull()
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

describe('NotificationThreadIndex and threads a bot keeps out of the sidebar', () => {
  const list = [
    { id: 'job', name: 'Quick check', hidden: true, startedByBot: { botId: 'pip', name: 'Pip' } },
    { id: 'helper', name: 'Helper', lineage: subagentOf('job') },
    { id: 'deep', name: 'Deep helper', lineage: subagentOf('helper', 'job') },
    { id: 'mine', name: 'Fix tests' },
    { id: 'launched', name: 'Started by an agent', hidden: true }
  ]
  const kinds = ['completed', 'question', 'idle'] as const

  it('says nothing for the thread or any subagent below it, whatever happened', () => {
    const index = new NotificationThreadIndex()
    index.note('a', list)
    for (const kind of kinds) {
      for (const id of ['job', 'helper', 'deep']) expect(index.resolve('a', id, kind), `${id} ${kind}`).toBeNull()
      expect(index.resolve('a', 'mine', kind)).toEqual(expect.objectContaining({ threadId: 'mine' }))
    }
  })

  it('still notifies for a thread an agent, not a bot, keeps out of the sidebar', () => {
    const index = new NotificationThreadIndex()
    index.note('a', list)
    for (const kind of kinds) expect(index.resolve('a', 'launched', kind), kind).toEqual(expect.objectContaining({ threadId: 'launched' }))
  })

  it('notifies like any thread when the person chose to hear about bot threads', () => {
    const index = new NotificationThreadIndex()
    index.note('a', list)
    expect(index.resolve('a', 'job', 'completed', true)).toEqual(expect.objectContaining({ threadId: 'job' }))
    expect(index.resolve('a', 'deep', 'question', true)).toEqual(expect.objectContaining({ threadId: 'job', viaThreadId: 'deep' }))
  })

  it('notifies again once the thread is shown in the sidebar', () => {
    const index = new NotificationThreadIndex()
    index.note('a', list)
    index.note('a', list.map(({ hidden: _hidden, ...row }) => row))
    expect(index.resolve('a', 'job', 'completed')).toEqual(expect.objectContaining({ threadId: 'job' }))
    expect(index.resolve('a', 'helper', 'question')).toEqual(expect.objectContaining({ threadId: 'job', viaThreadId: 'helper' }))
  })
})

describe('NotificationThreadIndex names for the banner', () => {
  const list = [
    { id: 'fix-a', name: 'Fix tests', projectId: 'p-a' },
    { id: 'fix-b', name: 'Fix tests', projectId: 'p-b' },
    { id: 'child', name: 'Reviewer', lineage: subagentOf('fix-a'), projectId: 'p-a' },
    { id: 'loose', name: 'Loose thread' }
  ]
  const projects = [{ id: 'p-a', name: 'Mousse' }, { id: 'p-b', name: 'Website' }]

  it('names the thread and its project, so two threads with one title read apart', () => {
    const index = new NotificationThreadIndex()
    index.note('a', list)
    index.noteProjects('a', projects)
    expect(index.resolve('a', 'fix-a', 'completed')).toEqual({ threadId: 'fix-a', threadName: 'Fix tests', projectName: 'Mousse' })
    expect(index.resolve('a', 'fix-b', 'completed')).toEqual({ threadId: 'fix-b', threadName: 'Fix tests', projectName: 'Website' })
  })

  it('names the parent and its project for a subagent question', () => {
    const index = new NotificationThreadIndex()
    index.note('a', list)
    index.noteProjects('a', { projects })
    expect(index.resolve('a', 'child', 'question')).toEqual({
      threadId: 'fix-a', parentName: 'Fix tests', viaThreadId: 'child', threadName: 'Fix tests', projectName: 'Mousse'
    })
  })

  it('leaves the project out for a thread without one or a project it has not seen', () => {
    const index = new NotificationThreadIndex()
    index.note('a', list)
    expect(index.resolve('a', 'loose', 'completed')).toEqual({ threadId: 'loose', threadName: 'Loose thread' })
    expect(index.resolve('a', 'fix-a', 'completed')).toEqual({ threadId: 'fix-a', threadName: 'Fix tests' })
  })
})

describe('bodyWithProject', () => {
  it('adds the project after the body when there is one', () => {
    expect(bodyWithProject('Agent finished', 'Mousse')).toBe('Agent finished · Mousse')
    expect(bodyWithProject('Agent finished')).toBe('Agent finished')
  })
})
