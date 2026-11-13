import { describe, expect, it } from 'vitest'
import { isDefaultThreadName } from '../../src/shared/threadTitle'

describe('isDefaultThreadName', () => {
  it('knows the default names in any letter case, so a thread a phone named "New thread" still gets a title', () => {
    expect(isDefaultThreadName('New Thread')).toBe(true)
    expect(isDefaultThreadName('New thread')).toBe(true)
    expect(isDefaultThreadName(' new chat ')).toBe(true)
    expect(isDefaultThreadName('New thread for the relay')).toBe(false)
    expect(isDefaultThreadName('Fix login')).toBe(false)
  })
})
