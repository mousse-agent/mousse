import { describe, expect, it } from 'vitest'
import type { RateLimitSnapshot } from '../src/mms/harness/vendors/codex/protocol'
import { isUsageLimitInfo, isUsageLimitText, resetFromSnapshot } from '../src/mms/harness/vendors/codex/rateLimits'

const NOW = Date.parse('2026-10-01T00:00:00Z')
const at = (hours: number) => NOW / 1000 + hours * 3600
const snapshot = (primary: Partial<RateLimitSnapshot['primary'] & object> | null, secondary: Partial<RateLimitSnapshot['secondary'] & object> | null = null): RateLimitSnapshot => ({
  primary: primary && { usedPercent: 0, windowDurationMins: 300, resetsAt: null, ...primary },
  secondary: secondary && { usedPercent: 0, windowDurationMins: 10_080, resetsAt: null, ...secondary }
})

describe('Codex rate-limit snapshots', () => {
  it('names the exhausted window and gives its reset', () => {
    expect(resetFromSnapshot(snapshot({ usedPercent: 100, resetsAt: at(2) }), NOW)).toEqual({ limitKind: 'five_hour', resetsAt: at(2) })
    expect(resetFromSnapshot(snapshot({ usedPercent: 40, resetsAt: at(2) }, { usedPercent: 100, resetsAt: at(48) }), NOW)).toEqual({ limitKind: 'seven_day', resetsAt: at(48) })
  })

  it('takes the latest reset when both windows are exhausted', () => {
    expect(resetFromSnapshot(snapshot({ usedPercent: 100, resetsAt: at(1) }, { usedPercent: 120, resetsAt: at(30) }), NOW)).toEqual({ limitKind: 'seven_day', resetsAt: at(30) })
    expect(resetFromSnapshot(snapshot({ usedPercent: 100, resetsAt: at(9) }, { usedPercent: 100, resetsAt: at(3) }), NOW)).toEqual({ limitKind: 'five_hour', resetsAt: at(9) })
  })

  it('says nothing when no window is exhausted', () => {
    expect(resetFromSnapshot(snapshot({ usedPercent: 99, resetsAt: at(1) }, { usedPercent: 10, resetsAt: at(5) }), NOW)).toBeUndefined()
    expect(resetFromSnapshot(snapshot(null, null), NOW)).toBeUndefined()
    expect(resetFromSnapshot(undefined, NOW)).toBeUndefined()
  })

  it('an exhausted window with no usable reset leaves the reset unknown', () => {
    expect(resetFromSnapshot(snapshot({ usedPercent: 100, resetsAt: null }), NOW)).toEqual({ limitKind: 'five_hour' })
    expect(resetFromSnapshot(snapshot({ usedPercent: 100, resetsAt: at(1) }, { usedPercent: 100, resetsAt: null }), NOW)).toEqual({ limitKind: 'seven_day' })
    // A reset already past belongs to a stale snapshot.
    expect(resetFromSnapshot(snapshot({ usedPercent: 100, resetsAt: at(-1) }), NOW)).toEqual({ limitKind: 'five_hour' })
  })

  it('names a window of any other length by its slot', () => {
    expect(resetFromSnapshot(snapshot({ usedPercent: 100, windowDurationMins: 60, resetsAt: at(1) }), NOW)).toEqual({ limitKind: 'primary', resetsAt: at(1) })
  })
})

describe('Codex usage-limit errors', () => {
  it('trusts the structured kind', () => {
    expect(isUsageLimitInfo('usageLimitExceeded')).toBe(true)
    expect(isUsageLimitInfo('rateLimitExceeded')).toBe(true)
    expect(isUsageLimitInfo({ responseTooManyFailedAttempts: { httpStatusCode: 429 } })).toBe(true)
    expect(isUsageLimitInfo({ responseTooManyFailedAttempts: { httpStatusCode: 500 } })).toBe(false)
    expect(isUsageLimitInfo({ responseTooManyFailedAttempts: { httpStatusCode: null } })).toBe(false)
    expect(isUsageLimitInfo('contextWindowExceeded')).toBe(false)
    expect(isUsageLimitInfo('other')).toBe(false)
    expect(isUsageLimitInfo({ unknownKind: {} })).toBe(false)
    expect(isUsageLimitInfo(null)).toBe(false)
  })

  it('reads the message only as a fallback', () => {
    expect(isUsageLimitText("You've hit your usage limit. Try again at 2:01 PM.")).toBe(true)
    expect(isUsageLimitText('Rate limit reached')).toBe(true)
    expect(isUsageLimitText('The context window is full')).toBe(false)
    expect(isUsageLimitText(undefined)).toBe(false)
  })
})
