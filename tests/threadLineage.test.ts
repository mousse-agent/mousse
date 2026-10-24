import { describe, expect, it } from 'vitest'
import { isSubagentThread, nearestVisibleAncestor, rollUpActivity, subagentDescendants } from '../src/shared/threadLineage'
import type { ThreadActivitySnapshot, ThreadLineage } from '../src/shared/types'

const sub = (id: string, parent: string, root = parent): { id: string; lineage: ThreadLineage } => ({
  id,
  lineage: { parentThreadId: parent, rootThreadId: root, relationship: 'subagent' }
})
const main = (id: string): { id: string; lineage?: ThreadLineage } => ({ id })

describe('isSubagentThread', () => {
  it.each([
    ['a thread without lineage', main('a'), false],
    ['a subagent thread', sub('b', 'a'), true]
  ])('%s', (_name, thread, expected) => {
    expect(isSubagentThread(thread)).toBe(expected)
  })
})

describe('nearestVisibleAncestor', () => {
  const list = [main('root'), sub('child', 'root'), sub('grandchild', 'child', 'root'), main('other')]

  it.each([
    ['a main thread stands for itself', 'root', 'root'],
    ['a subagent stands for its parent', 'child', 'root'],
    ['a deeper subagent climbs to the first main thread', 'grandchild', 'root'],
    ['an unknown thread has no ancestor', 'missing', undefined]
  ])('%s', (_name, id, expected) => {
    expect(nearestVisibleAncestor(id, list)).toBe(expected)
  })

  it('shows an orphan (parent not in the list) as itself', () => {
    expect(nearestVisibleAncestor('child', [sub('child', 'gone')])).toBe('child')
    // The chain stops at the last thread that is present.
    expect(nearestVisibleAncestor('grandchild', [sub('grandchild', 'child', 'root'), sub('child', 'gone')])).toBe('child')
  })

  it('terminates on a lineage cycle', () => {
    expect(nearestVisibleAncestor('a', [sub('a', 'b'), sub('b', 'a')])).toBeDefined()
  })
})

describe('subagentDescendants', () => {
  it('lists children and their children, nearest first, and ignores other trees', () => {
    const list = [main('root'), sub('c1', 'root'), sub('c2', 'root'), sub('g1', 'c1', 'root'), main('other'), sub('o1', 'other')]
    expect(subagentDescendants('root', list)).toEqual(['c1', 'c2', 'g1'])
    expect(subagentDescendants('c2', list)).toEqual([])
  })

  it('does not loop on a cycle', () => {
    expect(subagentDescendants('a', [sub('b', 'a'), sub('a', 'b')])).toEqual(['b'])
  })
})

describe('rollUpActivity', () => {
  const list = [main('parent'), sub('child', 'parent'), sub('grandchild', 'child', 'parent'), main('lone')]
  const roll = (activity: ThreadActivitySnapshot, id = 'parent') => rollUpActivity(id, list, activity)

  it.each<[string, ThreadActivitySnapshot, string]>([
    ['nothing running anywhere', {}, 'idle'],
    ['a running child', { child: 'processing' }, 'processing'],
    ['a running grandchild', { grandchild: 'processing' }, 'processing'],
    ['a child needing input', { child: 'awaiting_input' }, 'awaiting_input'],
    ['input needed below outranks the parent running', { parent: 'processing', grandchild: 'awaiting_input' }, 'awaiting_input'],
    ['the parent needing input stays that', { parent: 'awaiting_input', child: 'processing' }, 'awaiting_input'],
    ['a finished child adds nothing', { child: 'completed' }, 'idle'],
    ['the parent own completed state is kept', { parent: 'completed', child: 'idle' }, 'completed'],
    ['a running parent with an idle child', { parent: 'processing' }, 'processing']
  ])('%s', (_name, activity, expected) => {
    expect(roll(activity)).toBe(expected)
  })

  it('does not roll a child up into an unrelated thread', () => {
    expect(roll({ child: 'processing' }, 'lone')).toBe('idle')
  })
})
