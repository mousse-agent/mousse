import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { syncLinuxLauncher, type LauncherChanges } from '../../src/main/updates/linuxLauncher'

let root: string
let home: string
let apps: string
let applications: string
let refreshed: LauncherChanges[]

function sync(options: { appImage: string; previousAppImage?: string; iconSource?: string }) {
  return syncLinuxLauncher({ ...options, env: {}, home, refresh: (changes) => refreshed.push(changes) })
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
    const icon = join(root, 'icon.png')
    writeFileSync(icon, 'png-1')

    const first = sync({ appImage: current, iconSource: icon })

    const launcher = join(applications, 'mousse.desktop')
    expect(first).toMatchObject({ created: true, iconChanged: true, launchers: [launcher] })
    expect(readFileSync(launcher, 'utf8')).toContain(`Exec=${current}\nIcon=mousse\n`)
    const installed = join(home, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'mousse.png')
    expect(readFileSync(installed, 'utf8')).toBe('png-1')

    const second = sync({ appImage: current, iconSource: icon })
    expect(second).toMatchObject({ created: false, iconChanged: false, launchers: [] })
    expect(refreshed).toHaveLength(1)

    // A new build's icon replaces the installed one.
    writeFileSync(icon, 'png-2')
    expect(sync({ appImage: current, iconSource: icon }).iconChanged).toBe(true)
    expect(readFileSync(installed, 'utf8')).toBe('png-2')
    expect(existsSync(`${installed}.${process.pid}.tmp`)).toBe(false)
  })

  it('uses XDG_DATA_HOME when set', () => {
    const data = join(root, 'data')
    const changes = syncLinuxLauncher({ appImage: join(apps, 'Mousse.AppImage'), env: { XDG_DATA_HOME: data }, home, refresh: () => undefined })
    expect(changes.launchers).toEqual([join(data, 'applications', 'mousse.desktop')])
  })
})
