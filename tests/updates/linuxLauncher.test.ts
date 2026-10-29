import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LAUNCHER_ICON_SIZES,
  launcherIconName,
  syncLinuxLauncher,
  type LauncherChanges,
  type LauncherIcon
} from '../../src/main/updates/linuxLauncher'

let root: string
let home: string
let apps: string
let applications: string
let refreshed: LauncherChanges[]

function sync(options: { appImage: string; previousAppImage?: string; iconName?: string; icons?: LauncherIcon[] }) {
  return syncLinuxLauncher({ iconName: 'mousse', ...options, env: {}, home, refresh: (changes) => refreshed.push(changes) })
}

function icons(tag: string): LauncherIcon[] {
  return LAUNCHER_ICON_SIZES.map((size) => ({ size, png: Buffer.from(`${tag}-${size}`) }))
}

function themeIcon(size: string, name: string): string {
  return join(home, '.local', 'share', 'icons', 'hicolor', size, 'apps', name)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mousse-launcher-'))
  home = join(root, 'home')
  apps = join(home, 'Applications')
  applications = join(home, '.local', 'share', 'applications')
  mkdirSync(apps, { recursive: true })
  mkdirSync(applications, { recursive: true })
  refreshed = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('syncLinuxLauncher', () => {
  it('points a launcher at the new AppImage after an update removed the old one, keeping its arguments', () => {
    const current = join(apps, 'Mousse-0.1.2-nightly.20261029.20.AppImage')
    writeFileSync(current, '')
    const launcher = join(applications, 'mousse.desktop')
    writeFileSync(
      launcher,
      [
        '[Desktop Entry]',
        'Name=Mousse',
        `Exec=${join(apps, 'Mousse-0.1.2-nightly.20261025.15.AppImage')} --ozone-platform=x11`,
        `Icon=${join(home, 'old.png')}`,
        'StartupWMClass=Mousse',
        ''
      ].join('\n')
    )

    const changes = sync({ appImage: current })

    const text = readFileSync(launcher, 'utf8')
    expect(text).toContain(`Exec=${current} --ozone-platform=x11`)
    expect(text).toContain('Icon=mousse\n')
    expect(text).toContain('StartupWMClass=Mousse')
    expect(changes).toMatchObject({ launchers: [launcher], created: false })
    expect(refreshed).toHaveLength(1)
  })

  it('leaves launchers for other apps and for Mousse files that still exist elsewhere alone', () => {
    const current = join(apps, 'Mousse-0.1.3.AppImage')
    writeFileSync(current, '')
    const kept = join(apps, 'Mousse-0.1.1.AppImage')
    writeFileSync(kept, '')
    const other = `[Desktop Entry]\nName=T3\nExec=${join(apps, 'T3-Code.AppImage')}\n`
    const pinned = `[Desktop Entry]\nName=Mousse old\nExec=${kept}\n`
    writeFileSync(join(applications, 't3.desktop'), other)
    writeFileSync(join(applications, 'mousse-old.desktop'), pinned)
    writeFileSync(join(applications, 'mousse.desktop'), `[Desktop Entry]\nName=Mousse\nExec=${current}\nIcon=mousse\n`)

    const changes = sync({ appImage: current })

    expect(readFileSync(join(applications, 't3.desktop'), 'utf8')).toBe(other)
    expect(readFileSync(join(applications, 'mousse-old.desktop'), 'utf8')).toBe(pinned)
    expect(changes.launchers).toEqual([])
    expect(refreshed).toEqual([])
  })

  it('follows the file an update replaced, quoting paths with spaces, in every Exec line', () => {
    const previous = join(root, 'My Apps', 'Mousse-0.1.2.AppImage')
    const current = join(root, 'My Apps', 'Mousse-0.1.3.AppImage')
    const launcher = join(applications, 'appimagekit_abc-Mousse.desktop')
    writeFileSync(
      launcher,
      [
        '[Desktop Entry]',
        'Name=Mousse',
        `Exec="${previous}" %U`,
        `TryExec="${previous}"`,
        '',
        '[Desktop Action New]',
        `Exec="${previous}" --new-window`,
        ''
      ].join('\n')
    )

    sync({ appImage: current, previousAppImage: previous })

    const text = readFileSync(launcher, 'utf8')
    expect(text).not.toContain(previous)
    expect(text).toContain(`Exec="${current}" %U`)
    expect(text).toContain(`TryExec="${current}"`)
    expect(text).toContain(`Exec="${current}" --new-window`)
    // Icon goes into the main entry, not the action.
    expect(text.indexOf('Icon=mousse')).toBeLessThan(text.indexOf('[Desktop Action New]'))
  })

  it('creates a launcher and installs the icon when there is none, then changes nothing on the next start', () => {
    const current = join(apps, 'Mousse.AppImage')
    const first = sync({ appImage: current, icons: icons('png-1') })

    const launcher = join(applications, 'mousse.desktop')
    expect(first).toMatchObject({ created: true, iconChanged: true, launchers: [launcher] })
    expect(readFileSync(launcher, 'utf8')).toContain(`Exec=${current}\nIcon=mousse\n`)
    for (const size of LAUNCHER_ICON_SIZES) {
      expect(readFileSync(themeIcon(`${size}x${size}`, 'mousse.png'), 'utf8')).toBe(`png-1-${size}`)
    }
    const installed = themeIcon('512x512', 'mousse.png')

    const second = sync({ appImage: current, icons: icons('png-1') })
    expect(second).toMatchObject({ created: false, iconChanged: false, launchers: [] })
    expect(refreshed).toHaveLength(1)

    // A new build's icon replaces the installed one.
    expect(sync({ appImage: current, icons: icons('png-2') }).iconChanged).toBe(true)
    expect(readFileSync(installed, 'utf8')).toBe('png-2-512')
    expect(readFileSync(themeIcon('48x48', 'mousse.png'), 'utf8')).toBe('png-2-48')
    expect(existsSync(`${installed}.${process.pid}.tmp`)).toBe(false)
  })

  it('gives a nightly its own icon name and removes stale copies of that icon at other sizes', () => {
    const current = join(apps, 'Mousse-0.1.2-nightly.20261029.22.AppImage')
    writeFileSync(current, '')
    const launcher = join(applications, 'mousse.desktop')
    writeFileSync(launcher, ['[Desktop Entry]', 'Name=Mousse', `Exec=${current} --ozone-platform=x11`, 'Icon=mousse', 'StartupWMClass=Mousse', ''].join('\n'))
    // A stable icon under the shared name, and stale nightly copies at sizes or formats Mousse does not install.
    const stable = themeIcon('256x256', 'mousse.png')
    const staleSizes = [themeIcon('96x96', 'mousse-nightly.png'), themeIcon('scalable', 'mousse-nightly.svg'), themeIcon('256x256@2', 'mousse-nightly.png')]
    for (const path of [stable, ...staleSizes, themeIcon('48x48', 'mousse-nightly.png')]) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'old')
    }

    const changes = sync({ appImage: current, iconName: launcherIconName('nightly'), icons: icons('nightly') })

    expect(changes.iconChanged).toBe(true)
    expect(readFileSync(launcher, 'utf8')).toContain('Icon=mousse-nightly\n')
    expect(readFileSync(launcher, 'utf8')).toContain('StartupWMClass=Mousse')
    for (const size of LAUNCHER_ICON_SIZES) {
      expect(readFileSync(themeIcon(`${size}x${size}`, 'mousse-nightly.png'), 'utf8')).toBe(`nightly-${size}`)
    }
    for (const path of staleSizes) expect(existsSync(path)).toBe(false)
    // The stable icon belongs to the stable channel and stays.
    expect(readFileSync(stable, 'utf8')).toBe('old')
  })

  it('names the icons by channel', () => {
    expect(launcherIconName('nightly')).toBe('mousse-nightly')
    expect(launcherIconName('stable')).toBe('mousse')
  })

  it('uses XDG_DATA_HOME when set', () => {
    const data = join(root, 'data')
    const changes = syncLinuxLauncher({
      appImage: join(apps, 'Mousse.AppImage'),
      iconName: 'mousse',
      env: { XDG_DATA_HOME: data },
      home,
      refresh: () => undefined
    })
    expect(changes.launchers).toEqual([join(data, 'applications', 'mousse.desktop')])
  })
})
