import { describe, expect, it, vi } from 'vitest'
import { openExternalSafely, toSafeExternalUrl } from '../src/main/safeExternalUrl'

describe('toSafeExternalUrl', () => {
  it.each([
    ['https://mousse.plus', 'https://mousse.plus/'],
    ['http://127.0.0.1:3000/a?b=1', 'http://127.0.0.1:3000/a?b=1'],
    ['  https://example.com/x  ', 'https://example.com/x']
  ])('allows %s', (input, expected) => {
    expect(toSafeExternalUrl(input)).toBe(expected)
  })

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'ms-msdt:/id',
    'mousse://pair?x=1',
    'data:text/html,hi',
    'not a url',
    '',
    undefined,
    42
  ])('rejects %s', (input) => {
    expect(toSafeExternalUrl(input)).toBeNull()
  })
})

describe('openExternalSafely', () => {
  it('opens http(s) and denies others without throwing', async () => {
    const open = vi.fn(async () => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await openExternalSafely(open, 'https://example.com', 't')).toBe(true)
    expect(await openExternalSafely(open, 'file:///etc/passwd', 't')).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('swallows open failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const open = vi.fn(async () => {
      throw new Error('boom')
    })
    expect(await openExternalSafely(open, 'https://example.com', 't')).toBe(false)
    warn.mockRestore()
  })
})
