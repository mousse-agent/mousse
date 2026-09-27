import { execFileSync } from 'node:child_process'
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureWindowsBrowserSandboxAccess } from '../src/shared/browser/windowsSandboxPermissions.mjs'

describe.skipIf(process.platform !== 'win32')('managed Chromium sandbox permissions', () => {
  it('grants install capabilities RX while retaining parent and profile ACLs', () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-browser-acl-'))
    try {
      const binary = join(root, 'binaries', 'certified', 'chrome-win64')
      const profile = join(root, 'user-data')
      mkdirSync(binary, { recursive: true }); mkdirSync(profile)
      writeFileSync(join(binary, 'chrome.exe'), 'synthetic executable')
      const acl = (path: string) => execFileSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true })
      const parentBefore = acl(root); const profileBefore = acl(profile)
      const originalPath = process.env.PATH
      try {
        process.env.PATH = ''
        ensureWindowsBrowserSandboxAccess(root, binary)
      } finally {
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
      }
      const granted = acl(join(binary, 'chrome.exe'))
      expect(granted).toContain('S-1-15-3-1024-3424233489-972189580-2057154623-747635277-1604371224-316187997-3786583170-1043257646')
      expect(granted).toContain('S-1-15-3-1024-2302894289-466761758-1166120688-1039016420-2430351297-4240214049-4028510897-3317428798')
      expect(granted).toContain('(RX)')
      expect(acl(root)).toBe(parentBefore); expect(acl(profile)).toBe(profileBefore)
      ensureWindowsBrowserSandboxAccess(root, binary)
      expect(acl(join(binary, 'chrome.exe'))).toBe(granted)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rejects roots, escapes, and linked descendants before granting access', () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-browser-acl-'))
    const outside = mkdtempSync(join(tmpdir(), 'mousse-browser-outside-'))
    try {
      const binary = join(root, 'binaries', 'certified', 'chrome-win64'); mkdirSync(binary, { recursive: true })
      symlinkSync(outside, join(binary, 'linked'), 'junction')
      expect(() => ensureWindowsBrowserSandboxAccess(root, root)).toThrow('below its managed root')
      expect(() => ensureWindowsBrowserSandboxAccess(root, outside)).toThrow('below its managed root')
      expect(() => ensureWindowsBrowserSandboxAccess(root, binary)).toThrow('contains a link')
      rmSync(join(binary, 'linked'))
      writeFileSync(join(outside, 'secret'), 'synthetic')
      linkSync(join(outside, 'secret'), join(binary, 'hardlink'))
      expect(() => ensureWindowsBrowserSandboxAccess(root, binary)).toThrow('contains a hard link')
      expect(() => ensureWindowsBrowserSandboxAccess(root, join(root, 'user-data'))).toThrow('recognized managed binary')
    } finally {
      rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true })
    }
  })
})
