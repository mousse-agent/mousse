/**
 * "What bots may do here" was removed: each bot's own permissions are the only gate. An installation whose
 * `mousse.conf` still holds the old top-level `bots` key loads without error, keeps the key as stored (an older build
 * still reads it), and shows no such setting; a settings write that still names it (an older window or script) saves
 * the rest of the update and ignores it.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import type { MousseSettingsUpdate } from '../../src/shared/settings'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function tempHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bots-here-retired-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  return home
}

const conf = (home: string) => join(home, 'mousse.conf')
const stored = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

// What older builds wrote: every shape they could leave behind, the malformed and "unreadable" ones included.
const OLD_VALUES: Array<[string, unknown]> = [
  ['all off', { here: { shell: false, browser: false, threads: false } }],
  ['with the older files switch', { here: { shell: true, files: false, browser: true, threads: true } }],
  ['marked unreadable', { here: { shell: false, browser: false, threads: false }, unreadable: '2026-11-13T00:00:00.000Z' }],
  ['malformed', 'on'],
  ['null', null]
]

describe('a stored "What bots may do here" after its removal', () => {
  it.each(OLD_VALUES)('stored as %s: loads, is kept as stored, and Settings has no such setting', (_name, bots) => {
    const home = tempHome()
    writeFileSync(conf(home), JSON.stringify({ version: 1, mms: { autostart: false, logLevel: 'info' }, features: {}, bots }))
    const installation = MousseConfigStore.loadInstallation(home)
    const root = join(home, 'profiles', 'p1')
    mkdirSync(root, { recursive: true })
    const settings = new SettingsStore(MousseConfigStore.loadProfile(root, installation))
    expect(settings.get()).not.toHaveProperty('bots')
    // A save anywhere leaves the installation's leftover as it was, and no profile's file takes it.
    const theme = settings.get().appearance.theme === 'dark' ? 'light' : 'dark'
    settings.set({ appearance: { theme } })
    expect(stored(conf(home)).bots).toEqual(bots)
    expect(stored(conf(root))).not.toHaveProperty('bots')
    expect(MousseConfigStore.loadInstallation(home).get('bots')).toEqual(bots)
  })

  it('a write that still names it saves the rest and ignores it', () => {
    const home = tempHome()
    const settings = new SettingsStore(MousseConfigStore.loadProfile(join(home, 'profiles', 'p1'), MousseConfigStore.loadInstallation(home)))
    const theme = settings.get().appearance.theme === 'dark' ? 'light' : 'dark'
    const saved = settings.set({ bots: { here: { shell: false } }, appearance: { theme } } as MousseSettingsUpdate)
    expect(saved.appearance.theme).toBe(theme)
    expect(saved).not.toHaveProperty('bots')
    expect(stored(conf(home))).not.toHaveProperty('bots')
    expect(stored(join(home, 'profiles', 'p1', 'mousse.conf')).settings).not.toHaveProperty('bots')
    // Naming it alone is accepted and changes nothing.
    expect(() => settings.set({ bots: { here: { shell: false } } } as MousseSettingsUpdate)).not.toThrow()
    expect(settings.get()).not.toHaveProperty('bots')
  })
})
