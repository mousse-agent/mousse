import { describe, expect, it } from 'vitest'
import {
  formatThreadList,
  resolveThreadSelection
} from '../src/shared/threadSelection'

const threads = [
  { id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'Alpha plan' },
  { id: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'Beta work' },
  { id: 'cccccccc-1111-2222-3333-444444444444', name: 'Alpha notes' }
]

describe('resolveThreadSelection', () => {
  it('selects by exact id', () => {
    const result = resolveThreadSelection(threads, threads[0]!.id)
    expect(result).toEqual({ ok: true, thread: threads[0] })
  })

  it('selects by short id prefix', () => {
    const result = resolveThreadSelection(threads, 'bbbbbbbb')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.thread.id).toBe(threads[1]!.id)
  })

  it('selects by 1-based index', () => {
    const result = resolveThreadSelection(threads, '2')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.thread.id).toBe(threads[1]!.id)
  })

  it('selects by unambiguous name substring', () => {
    const result = resolveThreadSelection(threads, 'Beta')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.thread.name).toBe('Beta work')
  })

  it('rejects ambiguous names', () => {
    const result = resolveThreadSelection(threads, 'Alpha')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Ambiguous/i)
  })

  it('rejects out-of-range index', () => {
    const result = resolveThreadSelection(threads, '99')
    expect(result.ok).toBe(false)
  })
})

describe('formatThreadList', () => {
  it('marks the current thread', () => {
    const text = formatThreadList(threads, threads[1]!.id)
    expect(text).toContain('bbbbbbbb')
    expect(text).toContain(' *')
    expect(text).toContain('Usage: /threads')
  })
})
