/**
 * `scripts/net-engine-package-smoke.mjs` (Phase 1b `phase1b.desktop-builds`, M14): which targets this computer
 * packages and runs, and the electron-builder config it packages with: the helper under test as
 * `resources/net-helper`, its own output folder, and only the extra resources this computer has built.
 */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { homeParent, runsHere, smokeConfig } from '../../scripts/net-engine-package-smoke.mjs'

describe('the package smoke', () => {
  it.each([
    ['windows-x64', 'win32', 'x64', true],
    ['windows-arm64', 'win32', 'x64', false],
    ['macos-arm64', 'darwin', 'arm64', true],
    ['macos-x64', 'darwin', 'arm64', true],
    ['macos-arm64', 'darwin', 'x64', false],
    ['linux-arm64', 'darwin', 'arm64', false],
    ['linux-x64', 'linux', 'x64', true]
  ])('%s on %s %s: %s', (target, platform, arch, here) => {
    expect(runsHere(target, platform, arch)).toBe(here)
  })

  it('packages the helper under test, in its own folder, without resources this computer has not built', () => {
    const build = {
      afterPack: 'scripts/after-pack.mjs',
      electronDist: 'node_modules/electron/dist',
      directories: { output: 'release', buildResources: 'resources' },
      extraResources: [
        { from: 'resources/icon.png', to: 'icon.png' },
        { from: 'native/voice-engine/target/package', to: 'voice-engine' },
        { from: 'native/net-helper/target/package', to: 'net-helper' }
      ],
      win: { extraResources: [{ from: 'native/sshd-helper/target/release/sshd.exe', to: 'editor-ssh/sshd.exe' }] }
    }
    const built = new Set([resolve('/app', 'resources/icon.png')])
    const config = smokeConfig(build, {
      out: '/smoke',
      helperDir: '/smoke/helper-package',
      sameArch: true,
      root: '/app',
      exists: (path: string) => built.has(path)
    })
    expect(config.directories).toEqual({ output: join('/smoke', 'release'), buildResources: 'resources' })
    expect(config.extraResources).toEqual([
      { from: 'resources/icon.png', to: 'icon.png' },
      { from: '/smoke/helper-package', to: 'net-helper' }
    ])
    expect(config.win.extraResources).toEqual([])
    expect(config.electronDist).toBe('node_modules/electron/dist')
    expect(config.publish).toBeNull()
    // Another architecture's Electron is not the one in node_modules.
    expect(smokeConfig(build, { out: '/smoke', helperDir: '/h', sameArch: false, root: '/app', exists: () => true }).electronDist).toBeUndefined()
  })

  it("keeps the packaged daemon's socket within the Unix socket path limit", () => {
    const deep = '/Users/someone/' + 'a-deep-run-folder/'.repeat(5)
    // macOS takes 104 bytes, Linux 108: a deep temporary folder gives way to /tmp.
    expect(homeParent('darwin', deep)).toBe('/tmp')
    expect(homeParent('linux', deep)).toBe('/tmp')
    expect(homeParent('darwin', '/var/folders/ab/cdefgh/T')).toBe('/var/folders/ab/cdefgh/T')
    // Windows listens on a named pipe: any folder will do.
    expect(homeParent('win32', deep)).toBe(deep)
  })
})
