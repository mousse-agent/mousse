import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isDiagDebugEnabled,
  logDebug,
  logWarn,
  redactFields,
  resetDiagDebugCache
} from '../src/mms/log/diag'

describe('diag logger', () => {
  afterEach(() => {
    resetDiagDebugCache()
    vi.restoreAllMocks()
  })

  it('gates debug output behind MOUSSE_LOG=debug', () => {
    delete process.env.MOUSSE_LOG
    resetDiagDebugCache()
    expect(isDiagDebugEnabled()).toBe(process.env.NODE_ENV === 'test')

    process.env.MOUSSE_LOG = 'debug'
    resetDiagDebugCache()
    expect(isDiagDebugEnabled()).toBe(true)
    delete process.env.MOUSSE_LOG
    resetDiagDebugCache()
  })

  it('suppresses debug but not warn when disabled', () => {
    const previousEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    process.env.MOUSSE_LOG = 'info'
    resetDiagDebugCache()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      logDebug('lease', 'quiet')
      expect(spy).not.toHaveBeenCalled()

      logWarn('lease', 'loud', new Error('boom'))
      expect(spy).toHaveBeenCalledTimes(1)
      const [line] = spy.mock.calls[0] as string[]
      expect(line).toContain('[warn:lease]')
      expect(line).toContain('boom')
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousEnv
      resetDiagDebugCache()
    }
  })

  it('includes errno code in formatted errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = Object.assign(new Error('nope'), { code: 'EBUSY' })
    logWarn('atomicfs', 'rename failed', err)
    expect(spy.mock.calls[0][0]).toContain('(EBUSY)')
  })

  describe('redactFields', () => {
    it('redacts credential-shaped keys', () => {
      const out = redactFields({
        ownerToken: 'abcdef1234567890',
        apiKey: 'sk-123',
        path: '/tmp/auth.json'
      })
      expect(out.ownerToken).toBe('<redacted>')
      expect(out.apiKey).toBe('<redacted>')
      expect(out.path).toBe('/tmp/auth.json')
    })

    it('redacts long unkeyed secret-looking strings', () => {
      const out = redactFields({
        blob: 'a'.repeat(80),
        normal: 'short value'
      })
      expect(out.blob).toBe('<redacted>')
      expect(out.normal).toBe('short value')
    })
  })
})
