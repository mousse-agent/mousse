import { describe, expect, it } from 'vitest'
import { PROJECT_HUE_COUNT, projectHues } from '../../src/renderer/lib/projectHues'

const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`
// Both ids hash to hue 3: two projects that would share a color without the next-free rule.
const billing = { id: '80ebc204-361b-4d23-8e34-87cc7b4fad77', createdAt: at(2) }
const mobile = { id: 'f815d3a9-0073-485a-a0e1-4faa7861e4fe', createdAt: at(4) }
const atlas = { id: 'eca8e5cd-6982-452c-9c82-21cbecb74186', createdAt: at(1) }
const docs = { id: 'c0abb190-f7d7-4927-81ac-b2e8cd51efe1', createdAt: at(3) }

describe('projectHues', () => {
  it('gives the same hue to a project every time, whatever order the list is in', () => {
    const first = projectHues([atlas, billing, docs, mobile])
    const again = projectHues([mobile, docs, billing, atlas])
    expect([...again.entries()].sort()).toEqual([...first.entries()].sort())
  })

  it('gives two projects whose ids hash alike different hues, the older keeping its own', () => {
    expect(projectHues([billing]).get(billing.id)).toBe(3)
    expect(projectHues([mobile]).get(mobile.id)).toBe(3)
    const hues = projectHues([billing, mobile])
    expect(hues.get(billing.id)).toBe(3)
    expect(hues.get(mobile.id)).not.toBe(3)
  })

  it('gives up to six projects six different hues', () => {
    const projects = Array.from({ length: PROJECT_HUE_COUNT }, (_, index) => ({ id: `project-${index}`, createdAt: at(index + 1) }))
    const hues = [...projectHues(projects).values()]
    expect(new Set(hues).size).toBe(PROJECT_HUE_COUNT)
    expect(hues.every((hue) => hue >= 1 && hue <= PROJECT_HUE_COUNT)).toBe(true)
  })

  it('does not change existing projects’ hues when a newer project is added', () => {
    const before = projectHues([atlas, billing, docs])
    const after = projectHues([atlas, billing, docs, mobile])
    for (const [id, hue] of before) expect(after.get(id)).toBe(hue)
  })

  it('shares hues evenly past six projects', () => {
    const projects = Array.from({ length: PROJECT_HUE_COUNT * 2 }, (_, index) => ({ id: `p${index}`, createdAt: at(index + 1) }))
    const counts = new Map<number, number>()
    for (const hue of projectHues(projects).values()) counts.set(hue, (counts.get(hue) ?? 0) + 1)
    expect([...counts.values()]).toEqual(Array(PROJECT_HUE_COUNT).fill(2))
  })
})
