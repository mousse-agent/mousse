import { describe, expect, it } from 'vitest'
import { groupComputers, groupProjects } from '../../src/renderer/lib/projectGroups'
import type { Project } from '../../src/shared/types'

let sequence = 0
function project(id: string, over: Partial<Project> = {}): Project {
  sequence += 1
  return { id, name: id, path: `/p/${id}`, createdAt: '', order: sequence, ...over }
}

const B = 'nod_b'
const C = 'nod_c'

describe('groupProjects', () => {
  it('makes one group of a project and the other computers’ projects that match it', () => {
    const mine = project('p1')
    const onB = project(`${B}:b1`, { node: B, sameAs: 'p1', name: 'renamed on B' })
    const onC = project(`${C}:c1`, { node: C, sameAs: 'p1' })
    const { groups, groupOf } = groupProjects([mine, project('p2'), onB, onC])
    expect(groups.map((group) => [group.id, group.members.map((member) => member.id)])).toEqual([
      ['p1', ['p1', `${B}:b1`, `${C}:c1`]],
      ['p2', ['p2']]
    ])
    // The group is named, and acted on, by this computer's project.
    expect(groups[0]!.project).toBe(mine)
    expect(groupOf.get(`${B}:b1`)).toBe('p1')
    expect(groupOf.get(`${C}:c1`)).toBe('p1')
    expect(groupOf.get('p2')).toBe('p2')
  })

  it('keeps a project that exists on another computer only as its own group', () => {
    const remote = project(`${B}:b9`, { node: B })
    const { groups, groupOf } = groupProjects([project('p1'), remote])
    expect(groups.map((group) => group.id)).toEqual(['p1', `${B}:b9`])
    expect(groups[1]!.project).toBe(remote)
    expect(groupOf.get(`${B}:b9`)).toBe(`${B}:b9`)
  })

  it('does not group by a weak match', () => {
    const { groups } = groupProjects([project('p1'), project(`${B}:b1`, { node: B, similarTo: 'p1' })])
    expect(groups.map((group) => group.id)).toEqual(['p1', `${B}:b1`])
  })

  it('does not group projects of two other computers that this computer has no project for', () => {
    const { groups } = groupProjects([project(`${B}:b1`, { node: B }), project(`${C}:c1`, { node: C })])
    expect(groups.map((group) => group.id)).toEqual([`${B}:b1`, `${C}:c1`])
  })

  it('ignores a match that names no project of this computer', () => {
    // The project was removed here, or the match is out of date.
    const { groups, groupOf } = groupProjects([project('p1'), project(`${B}:b1`, { node: B, sameAs: 'gone' })])
    expect(groups.map((group) => group.id)).toEqual(['p1', `${B}:b1`])
    expect(groupOf.get(`${B}:b1`)).toBe(`${B}:b1`)
  })

  it('does not take another computer’s project for this computer’s because their ids look alike', () => {
    // `sameAs` can only name a project without a node.
    const other = project(`${B}:b1`, { node: B })
    const { groups } = groupProjects([other, project(`${C}:c1`, { node: C, sameAs: `${B}:b1` })])
    expect(groups.map((group) => group.id)).toEqual([`${B}:b1`, `${C}:c1`])
  })

  it('puts a group where its main project is in the list, even if a matching project of another computer comes first', () => {
    const { groups } = groupProjects([
      project(`${B}:b1`, { node: B, sameAs: 'p2' }),
      project('p1'),
      project(`${B}:b2`, { node: B }),
      project('p2')
    ])
    expect(groups.map((group) => group.id)).toEqual(['p1', `${B}:b2`, 'p2'])
    expect(groups[2]!.members.map((member) => member.id)).toEqual(['p2', `${B}:b1`])
  })

  it('keeps a group whose computer is offline, with its offline project', () => {
    const offline = project(`${B}:b1`, { node: B, sameAs: 'p1', offline: true })
    const { groups } = groupProjects([project('p1'), offline])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.members[1]).toBe(offline)
  })

  it('lists the other computers of a group once each', () => {
    const { groups } = groupProjects([
      project('p1'),
      project(`${B}:b1`, { node: B, sameAs: 'p1' }),
      project(`${B}:b2`, { node: B, sameAs: 'p1' }),
      project(`${C}:c1`, { node: C, sameAs: 'p1' })
    ])
    expect(groupComputers(groups[0]!)).toEqual([B, C])
  })

  it('is empty without projects', () => {
    expect(groupProjects([])).toEqual({ groups: [], groupOf: new Map() })
  })
})
