import { describe, expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import { orderedThreadIds } from '../src/renderer/lib/threadOrder'

let sequence = 0
function thread(id: string, over: Partial<Thread> = {}): Thread {
  sequence += 1
  return {
    id,
    name: `Thread ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    order: sequence,
    startedAt: '2026-01-01T00:00:01.000Z',
    ...over
  }
}

const projects = [{ id: 'p1' }, { id: 'p2' }]

describe('orderedThreadIds', () => {
  it('lists projects in their order, each with its threads by sidebar order, then threads without a project', () => {
    const threads = [
      thread('orphan-a', { order: 1 }),
      thread('p2-a', { projectId: 'p2', order: 2 }),
      thread('p1-b', { projectId: 'p1', order: 4 }),
      thread('p1-a', { projectId: 'p1', order: 3 }),
      thread('orphan-b', { order: 0 })
    ]
    expect(orderedThreadIds({ projects, threads, view: 'projects' })).toEqual(['p1-a', 'p1-b', 'p2-a', 'orphan-b', 'orphan-a'])
  })

  it('lists one flat sidebar order in the threads view', () => {
    const threads = [
      thread('c', { projectId: 'p2', order: 3 }),
      thread('a', { order: 1 }),
      thread('b', { projectId: 'p1', order: 2 })
    ]
    expect(orderedThreadIds({ projects, threads, view: 'threads' })).toEqual(['a', 'b', 'c'])
    expect(orderedThreadIds({ projects, threads, view: 'chats' })).toEqual(['a', 'b', 'c'])
  })

  it('does not depend on which projects are expanded, and leaves out what the sidebar leaves out', () => {
    const threads = [
      thread('shown', { projectId: 'p1', order: 1 }),
      thread('settled', { projectId: 'p1', order: 2, settledAt: '2026-01-02T00:00:00.000Z' }),
      thread('draft', { projectId: 'p1', order: 3, startedAt: undefined, name: 'New Thread' }),
      thread('child', {
        projectId: 'p1',
        order: 4,
        lineage: { parentThreadId: 'shown', rootThreadId: 'shown', relationship: 'subagent' }
      }),
      thread('agent-chat', { order: 5 })
    ]
    expect(orderedThreadIds({ projects, threads, view: 'projects', excluded: new Set(['agent-chat']) })).toEqual(['shown'])
  })

  it('keeps a subagent thread whose parent is not loaded', () => {
    const threads = [
      thread('lonely', { order: 1, lineage: { parentThreadId: 'gone', rootThreadId: 'gone', relationship: 'subagent' } })
    ]
    expect(orderedThreadIds({ projects, threads, view: 'threads' })).toEqual(['lonely'])
  })

  it('steps through the threads of other computers too, by their place among this computer’s', () => {
    const remote = (id: string, over: Partial<Thread> = {}) => thread(id, { node: 'nod_other', ...over })
    const threads = [
      thread('mine-b', { order: 2 }),
      remote('nod_other:r1', { order: 0.5 }),
      remote('nod_other:r2', { projectId: 'nod_other:rp', order: 0 }),
      remote('nod_other:child', {
        order: 1,
        lineage: { parentThreadId: 'nod_other:r1', rootThreadId: 'nod_other:r1', relationship: 'subagent' }
      }),
      thread('mine-a', { order: 0 })
    ]
    expect(orderedThreadIds({ projects, threads, view: 'threads' })).toEqual(['mine-a', 'nod_other:r2', 'nod_other:r1', 'mine-b'])
    // Under a project of the other computer, they follow that project in the projects view.
    expect(orderedThreadIds({ projects: [{ id: 'p1' }, { id: 'nod_other:rp' }], threads, view: 'projects' })).toEqual([
      'nod_other:r2',
      'mine-a',
      'nod_other:r1',
      'mine-b'
    ])
  })

  it('is empty without threads', () => {
    expect(orderedThreadIds({ projects, threads: [], view: 'projects' })).toEqual([])
  })
})
