import { describe, expect, it } from 'vitest'
import { ownerTokensMatch } from '../src/mms/protocol/server'

describe('ownerTokensMatch (constant-time hello auth)', () => {
  it('accepts the exact token', () => {
    expect(ownerTokensMatch('abc123', 'abc123')).toBe(true)
  })

  it('rejects wrong tokens of equal length', () => {
    expect(ownerTokensMatch('abc124', 'abc123')).toBe(false)
  })

  it('rejects empty and prefix tokens', () => {
    expect(ownerTokensMatch('', 'abc123')).toBe(false)
    expect(ownerTokensMatch('abc123', '')).toBe(false)
    expect(ownerTokensMatch('abc', 'abc123')).toBe(false)
  })
})
