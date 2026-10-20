import { describe, expect, it } from 'vitest'
import { formatWorkedFor, formatWorkingFor } from '../src/renderer/utils/responseTimeline'

describe('response duration labels', () => {
  it('formats a completed duration with only the units that apply', () => {
    expect(formatWorkedFor(4_000)).toBe('Worked for 4s')
    expect(formatWorkedFor(65_000)).toBe('Worked for 1m 5s')
    expect(formatWorkedFor(3_725_000)).toBe('Worked for 1hrs 2m 5s')
    expect(formatWorkedFor(-1)).toBe('Worked for 0s')
  })

  it('formats a live elapsed label', () => {
    expect(formatWorkingFor(65_000)).toBe('Working · 1m 5s elapsed')
  })
})
