import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { resolveWithinRoot } from '../src/mms/files/pathGuard'

const isWindows = process.platform === 'win32'
const ROOT = isWindows ? 'C:\\repo' : '/repo'

describe('resolveWithinRoot', () => {
  it('resolves paths inside the root', () => {
    expect(resolveWithinRoot(ROOT)).toBe(ROOT)
    expect(resolveWithinRoot(ROOT, 'src/a.ts')).toBe(join(ROOT, 'src', 'a.ts'))
    expect(resolveWithinRoot(ROOT, 'src/../b.ts')).toBe(join(ROOT, 'b.ts'))
  })

  it('refuses parent traversal and absolute paths elsewhere on the same disk', () => {
    expect(() => resolveWithinRoot(ROOT, '../secret')).toThrow('outside the project root')
    expect(() => resolveWithinRoot(ROOT, 'src/../../secret')).toThrow('outside the project root')
    const sibling = isWindows ? 'C:\\other\\secret' : '/other/secret'
    expect(() => resolveWithinRoot(ROOT, sibling)).toThrow('outside the project root')
  })

  it.runIf(isWindows)('refuses a path on another drive or share', () => {
    expect(() => resolveWithinRoot(ROOT, 'D:\\secret.txt')).toThrow('outside the project root')
    expect(() => resolveWithinRoot(ROOT, 'D:secret.txt')).toThrow('outside the project root')
    expect(() => resolveWithinRoot(ROOT, '\\\\server\\share\\secret.txt')).toThrow('outside the project root')
  })
})
