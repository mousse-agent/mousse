import { describe, expect, it } from 'vitest'
import { exactDirectory } from '../../src/mms/run/approvalFingerprint'

describe('exactDirectory: the folder a command starts in, or nothing', () => {
  it('uses the path the provider names, as given, and the turn\'s folder when it names none', () => {
    expect(exactDirectory('/work/app', '/work/app/packages/a')).toBe('/work/app/packages/a')
    expect(exactDirectory('/work/app', undefined)).toBe('/work/app')
    expect(exactDirectory('/work/app', null)).toBe('/work/app')
    expect(exactDirectory('/work/app', '  ')).toBe('/work/app')
  })

  it('puts a relative path under the turn\'s folder, not the daemon\'s', () => {
    expect(exactDirectory('/work/app', 'packages/a')).toMatch(/[\\/]work[\\/]app[\\/]packages[\\/]a$/)
    expect(exactDirectory(undefined, 'packages/a')).toBeUndefined()
    expect(exactDirectory('relative/turn', 'packages/a')).toBeUndefined()
  })

  it('never pins down a path with dot segments, which a link would send somewhere else', () => {
    for (const named of ['/work/app/link/..', '/work/app/./x', '../app', 'packages/../..', '/work/app\\..\\x'])
      expect(exactDirectory('/work/app', named), named).toBeUndefined()
    expect(exactDirectory('/work/app/../other', undefined)).toBeUndefined()
    expect(exactDirectory('/work/app/../other', 'packages')).toBeUndefined()
  })
})
