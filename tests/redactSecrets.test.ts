import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../src/shared/errors'

describe('redactSecrets', () => {
  const token = 'Q'.repeat(20) + '-_' + 'w'.repeat(21)

  it('removes known secrets, bearer and authorization values, JWTs and Mousse token shapes', () => {
    const text = `known=sekret-value-123 Authorization: Bearer abc.def ${token} jwt=eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig`
    const redacted = redactSecrets(text, ['sekret-value-123'])
    for (const secret of ['sekret-value-123', 'abc.def', token, 'eyJhbGciOiJIUzI1']) expect(redacted).not.toContain(secret)
  })

  it('is total: untrusted non-string values become bounded text and never throw', () => {
    expect(redactSecrets(undefined)).toBe('')
    expect(redactSecrets(null)).toBe('')
    expect(redactSecrets(42)).toBe('42')
    expect(redactSecrets({ toString: () => { throw new Error('boom') } })).toBe('')
    expect(redactSecrets({ toString: () => `Bearer ${token}` })).not.toContain(token)
    expect(redactSecrets('x'.repeat(10_000)).length).toBeLessThanOrEqual(4096)
  })
})
