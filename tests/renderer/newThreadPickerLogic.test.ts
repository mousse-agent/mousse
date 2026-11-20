import { describe, expect, it } from 'vitest'
import { gridMove, pickerSections, type GridDirection } from '../../src/renderer/components/newThreadPickerLogic'
import type { Project } from '../../src/shared/types'

describe('gridMove', () => {
  // Starred: 2 cards (index 0-1). Recent: 7 cards (index 2-8) in rows [2 3 4] [5 6 7] [8]. Three columns.
  const sizes = [2, 7]
  it.each<[string, readonly number[], number, GridDirection, number]>([
    ['down from Starred keeps the column into Recent', sizes, 1, 'down', 3],
    ['down from a short Starred row lands under it', sizes, 0, 'down', 2],
    ['up from Recent\'s first row returns to the column above', sizes, 3, 'up', 1],
    ['up from a column Starred lacks lands on its last card', sizes, 4, 'up', 1],
    ['down over a shorter last row lands on its last card', sizes, 6, 'down', 8],
    ['down from the last row stays', sizes, 8, 'down', 8],
    ['up from the first row stays', sizes, 0, 'up', 0],
    ['left crosses back into Starred', sizes, 2, 'left', 1],
    ['right at the end stays', sizes, 8, 'right', 8],
    ['an empty Starred is skipped going up', [0, 4], 0, 'up', 0],
    ['within one section down moves a row', [0, 4], 0, 'down', 3],
    ['an empty Recent below stays', [3, 0], 1, 'down', 1]
  ])('%s', (_name, sectionSizes, from, direction, to) => {
    expect(gridMove(sectionSizes, from, direction, 3)).toBe(to)
  })
})

describe('pickerSections', () => {
  const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id,
    name: id,
    path: `/work/${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    order: 0,
    ...extra
  })
  const projects = [
    project('old', { createdAt: '2026-09-01T00:00:00.000Z' }),
    project('starred', { pinnedAt: '2026-11-01T00:00:00.000Z' }),
    project('used', { node: 'mac' }),
    project('fresh', { createdAt: '2026-11-10T00:00:00.000Z' }),
    project('away', { node: 'box', offline: true })
  ]
  const lastUsed = new Map([['used', '2026-11-19T10:00:00.000Z'], ['starred', '2026-11-02T00:00:00.000Z'], ['away', '2026-11-18T00:00:00.000Z']])
  const names: Record<string, string> = { mac: 'Mac mini', box: 'Linux box' }
  const ids = (cards: { project: Project }[]) => cards.map((card) => card.project.id)

  it('puts starred projects first, then the rest by last use, never used newest added first', () => {
    const { starred, recent } = pickerSections(projects, lastUsed, (node) => names[node]!, '')
    expect(ids(starred)).toEqual(['starred'])
    expect(ids(recent)).toEqual(['used', 'away', 'fresh', 'old'])
  })

  it('names each project\'s computer and marks one that cannot start a thread now', () => {
    const { recent } = pickerSections(projects, lastUsed, (node) => names[node]!, '')
    expect(recent.find((card) => card.project.id === 'used')?.computer).toBe('Mac mini')
    expect(recent.find((card) => card.project.id === 'fresh')?.computer).toBe('This computer')
    expect(recent.find((card) => card.project.id === 'away')?.unavailable).toBe('Offline')
  })

  it.each([
    ['a computer name', 'mac', ['used']],
    ['a folder', '/work/fre', ['fresh']],
    ['every word, in any field', 'linux away', ['away']],
    ['nothing', 'nowhere', []]
  ])('matches %s', (_name, query, expected) => {
    const { starred, recent } = pickerSections(projects, lastUsed, (node) => names[node]!, query)
    expect([...ids(starred), ...ids(recent)]).toEqual(expected)
  })
})
