import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { piNormalizePath, piResolvePath, piResolveReadPath } from '../../src/mms/harness/pi/paths'

// The gate resolves a path argument exactly as Pi's file tools do (`resolveToCwd`, pinned 0.85.1).

describe('Pi path resolution', () => {
  const cwd = resolve('/work/project')
  const home = resolve('/home/me')

  it('drops a leading @, expands ~, reads file:// URLs and normalizes', () => {
    expect(piResolvePath('@notes.md', cwd, { home })).toBe(join(cwd, 'notes.md'))
    expect(piResolvePath('~/.aws/credentials', cwd, { home })).toBe(join(home, '.aws', 'credentials'))
    expect(piResolvePath('~', cwd, { home })).toBe(home)
    expect(piResolvePath(pathToFileURL(join(home, 'x.txt')).href, cwd, { home })).toBe(join(home, 'x.txt'))
    expect(piResolvePath('a/../../b', cwd, { home })).toBe(resolve(cwd, '..', 'b'))
    expect(piNormalizePath('a\u00A0b', { home })).toBe('a b')
  })

  it('turns Git Bash, MSYS, Cygwin and WSL drive paths into Windows paths on Windows only', () => {
    expect(piNormalizePath('/c/Users/me/x', { platform: 'win32', home })).toBe('C:\\Users\\me\\x')
    expect(piNormalizePath('/mnt/d/data', { platform: 'win32', home })).toBe('D:\\data')
    expect(piNormalizePath('/cygdrive/e/', { platform: 'win32', home })).toBe('E:\\')
    expect(piNormalizePath('~\\x', { platform: 'win32', home })).toBe(join(home, 'x'))
    expect(piNormalizePath('/c/Users/me/x', { platform: 'linux', home })).toBe('/c/Users/me/x')
    expect(piNormalizePath('~\\x', { platform: 'linux', home })).toBe('~\\x')
  })
})

describe('Pi read path variants', () => {
  it('checks the variant Pi’s read would open when the resolved path is missing, in Pi’s order', () => {
    const cwd = resolve('/w/proj')
    const files = new Set<string>()
    const exists = (path: string) => files.has(path)
    const plain = join(cwd, "O'Neil.txt")
    expect(piResolveReadPath("O'Neil.txt", cwd, { exists })).toBe(plain)
    files.add(join(cwd, 'O’Neil.txt'))
    expect(piResolveReadPath("O'Neil.txt", cwd, { exists })).toBe(join(cwd, 'O’Neil.txt'))
    files.add(plain)
    expect(piResolveReadPath("O'Neil.txt", cwd, { exists })).toBe(plain)
    files.add(join(cwd, 'shot 1 PM.\u0000').replace('\u0000', 'png').replace(' PM.', ' PM.'))
    expect(piResolveReadPath('shot 1 PM.png', cwd, { exists })).toBe(join(cwd, 'shot 1 PM.png'))
  })
})
