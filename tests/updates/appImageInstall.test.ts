import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appImageDestination, installAppImage, startAfterExit } from '../../src/main/updates/appImageInstall'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mousse-appimage-'))
  mkdirSync(join(root, 'apps'))
  mkdirSync(join(root, 'cache'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('appImageDestination', () => {
  it('keeps a name without a version and takes the release name otherwise', () => {
    expect(appImageDestination('/a/Mousse.AppImage', '/c/Mousse-0.1.3.AppImage')).toBe('/a/Mousse.AppImage')
    expect(appImageDestination('/a/Mousse-0.1.2.AppImage', '/c/Mousse-0.1.3.AppImage')).toBe('/a/Mousse-0.1.3.AppImage')
  })
})

describe('installAppImage', () => {
  it('puts the new release in place before removing the old one and reports both paths', () => {
    const current = join(root, 'apps', 'Mousse-0.1.2-nightly.20261025.15.AppImage')
    const downloaded = join(root, 'cache', 'Mousse-0.1.2-nightly.20261029.20.AppImage')
    writeFileSync(current, 'old')
    writeFileSync(downloaded, 'new')
    const seen: Array<[string, string, boolean]> = []

    const destination = installAppImage({
      current,
      downloaded,
      onReplaced: (next, previous) => seen.push([next, previous, existsSync(previous)])
    })

    expect(destination).toBe(join(root, 'apps', 'Mousse-0.1.2-nightly.20261029.20.AppImage'))
    expect(readFileSync(destination, 'utf8')).toBe('new')
    expect(statSync(destination).mode & 0o777).toBe(0o755)
    expect(existsSync(current)).toBe(false)
    expect(existsSync(downloaded)).toBe(false)
    expect(seen).toEqual([[destination, current, true]])
  })

  it('replaces a file named without a version in place', () => {
    const current = join(root, 'apps', 'Mousse.AppImage')
    const downloaded = join(root, 'cache', 'Mousse-0.1.3.AppImage')
    writeFileSync(current, 'old')
    writeFileSync(downloaded, 'new')
    expect(installAppImage({ current, downloaded })).toBe(current)
    expect(readFileSync(current, 'utf8')).toBe('new')
  })

  it('keeps the running file when the download is missing', () => {
    const current = join(root, 'apps', 'Mousse-0.1.2.AppImage')
    writeFileSync(current, 'old')
    expect(() => installAppImage({ current, downloaded: join(root, 'cache', 'Mousse-0.1.3.AppImage') })).toThrow()
    expect(readFileSync(current, 'utf8')).toBe('old')
  })
})

describe('startAfterExit', () => {
  it('starts the new file with the same arguments only after the old process is gone', async () => {
    const marker = join(root, 'started')
    const program = join(root, 'apps', 'fake.AppImage')
    writeFileSync(program, `#!/bin/sh\nprintf '%s|' "$@" > "${marker}"\nprintf '%s' "$APPIMAGE" >> "${marker}"\n`, { mode: 0o755 })
    const { spawn } = await import('node:child_process')
    const old = spawn('sleep', ['0.6'])

    startAfterExit(old.pid!, program, ['--ozone-platform=x11', 'a b'], { ...process.env, APPIMAGE: '/old.AppImage' })

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(existsSync(marker)).toBe(false)
    await new Promise((resolve) => old.on('exit', resolve))
    for (let i = 0; i < 40 && !existsSync(marker); i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(readFileSync(marker, 'utf8')).toBe('--ozone-platform=x11|a b|')
  })
})
