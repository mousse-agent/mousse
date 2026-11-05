import { describe, expect, it } from 'vitest'
import { formatDurationLong, formatWorkedFor, formatWorkingFor } from '../src/renderer/utils/responseTimeline'

describe('response duration labels', () => {
  it('formats a completed duration with only the units that apply', () => {
    expect(formatWorkedFor(4_000)).toBe('Worked for 4s')
    expect(formatWorkedFor(65_000)).toBe('Worked for 1m 5s')
    expect(formatWorkedFor(120_000)).toBe('Worked for 2m')
    expect(formatWorkedFor(-1)).toBe('Worked for 0s')
  })

  it('drops seconds above an hour', () => {
    expect(formatWorkedFor(3_725_000)).toBe('Worked for 1h 2m')
    expect(formatWorkingFor(3_725_000)).toBe('Working · 1h 2m')
    expect(formatWorkingFor(3_605_000)).toBe('Working · 1h')
  })

  it('formats the live label in the same short form', () => {
    expect(formatWorkingFor(3_000)).toBe('Working · 3s')
    expect(formatWorkingFor(252_000)).toBe('Working · 4m 12s')
  })

  it('spells the same parts out for the tooltip', () => {
    expect(formatDurationLong(1_000)).toBe('1 second')
    expect(formatDurationLong(252_000)).toBe('4 minutes and 12 seconds')
    expect(formatDurationLong(3_725_000)).toBe('1 hour and 2 minutes')
  })
})
