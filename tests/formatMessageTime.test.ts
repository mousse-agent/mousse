import { describe, expect, it } from 'vitest'
import {
  formatMessageTime,
  formatMessageTimeTitle
} from '../src/renderer/utils/formatMessageTime'

describe('formatMessageTime', () => {
  const now = new Date('2026-08-01T15:30:00')

  it('shows clock only for today (no seconds)', () => {
    const result = formatMessageTime('2026-08-01T23:00:45', now)
    expect(result).not.toMatch(/:\d{2}$/)
    expect(result).not.toContain('Yesterday')
    expect(result.length).toBeGreaterThan(0)
  })

  it('prefixes yesterday', () => {
    const result = formatMessageTime('2026-07-31T23:00:45', now)
    expect(result.startsWith('Yesterday, ')).toBe(true)
  })

  it('uses short date for earlier days in the same year', () => {
    const result = formatMessageTime('2026-03-15T14:05:00', now)
    expect(result).toMatch(/Mar/)
    expect(result).toMatch(/15/)
    expect(result).not.toMatch(/2026/)
  })

  it('includes year for prior years', () => {
    const result = formatMessageTime('2025-03-15T14:05:00', now)
    expect(result).toMatch(/2025/)
  })

  it('returns empty string for invalid input', () => {
    expect(formatMessageTime('not-a-date', now)).toBe('')
  })
})

describe('formatMessageTimeTitle', () => {
  it('returns a non-empty absolute string', () => {
    const title = formatMessageTimeTitle('2026-08-01T23:00:45')
    expect(title.length).toBeGreaterThan(0)
    expect(title).not.toMatch(/:\d{2}:\d{2}/) // no seconds in tooltip either
  })
})
