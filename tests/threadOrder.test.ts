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

  it('steps through a project that is on several computers as one group, in one sidebar order', () => {
    const remote = (id: string, over: Partial<Thread> = {}) => thread(id, { node: 'nod_other', ...over })
    const grouped = [
      { id: 'p1' },
      { id: 'p2' },
      { id: 'nod_other:rp', node: 'nod_other', sameAs: 'p1' },
      { id: 'nod_other:solo', node: 'nod_other' }
    ]
    const threads = [
      thread('p2-a', { projectId: 'p2', order: 0 }),
      remote('nod_other:r1', { projectId: 'nod_other:rp', order: 1 }),
      thread('p1-a', { projectId: 'p1', order: 2 }),
      remote('nod_other:r2', { projectId: 'nod_other:rp', order: 3 }),
      thread('p1-b', { projectId: 'p1', order: 4 }),
      remote('nod_other:s1', { projectId: 'nod_other:solo', order: 5 }),
      thread('orphan', { order: 6 })
    ]
    // The first project's group holds the other computer's rows among its own; the project only the other
    // computer has comes after this computer's projects; threads without a project come last.
    expect(orderedThreadIds({ projects: grouped, threads, view: 'projects' })).toEqual([
      'nod_other:r1',
      'p1-a',
      'nod_other:r2',
      'p1-b',
      'p2-a',
      'nod_other:s1',
      'orphan'
    ])
    // Without the match, the other computer's project is a group of its own.
    expect(
      orderedThreadIds({
        projects: grouped.map(({ sameAs: _sameAs, ...project }) => project),
        threads,
        view: 'projects'
      })
    ).toEqual(['p1-a', 'p1-b', 'p2-a', 'nod_other:r1', 'nod_other:r2', 'nod_other:s1', 'orphan'])
  })

  it('keeps the steps of a group whose computer is offline', () => {
    const threads = [
      thread('p1-a', { projectId: 'p1', order: 1 }),
      thread('nod_other:r1', { projectId: 'nod_other:rp', node: 'nod_other', offline: true, order: 0 })
    ]
    const projects = [{ id: 'p1' }, { id: 'nod_other:rp', node: 'nod_other', sameAs: 'p1' }]
    expect(orderedThreadIds({ projects, threads, view: 'projects' })).toEqual(['nod_other:r1', 'p1-a'])
  })

  it('is empty without threads', () => {
    expect(orderedThreadIds({ projects, threads: [], view: 'projects' })).toEqual([])
  })
})
