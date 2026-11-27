/**
 * Project colors on threads are off for a new profile. An existing profile keeps its choice: loading a profile writes
 * every setting down, so a profile from before the default changed has its fill (or other choice) stored.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'mousse-project-colors-'))
  try { run(home) } finally { rmSync(home, { recursive: true, force: true }) }
}

const projectColors = (home: string) => new SettingsStore(MousseConfigStore.load(home)).get().appearance.threadProjectColors
const stored = (home: string) => (JSON.parse(readFileSync(join(home, 'mousse.conf'), 'utf-8')) as { settings: { appearance: { threadProjectColors: unknown } } }).settings.appearance.threadProjectColors

it('turns project colors off for a new profile, and writes that down', () => {
  withHome((home) => {
    expect(projectColors(home)).toBe('off')
    expect(stored(home)).toBe('off')
  })
})

it('keeps the choice an existing profile has stored', () => {
  for (const [choice, read] of [['fill', 'fill'], ['outline', 'outline'], ['gradient', 'gradient'], ['off', 'off'], [true, 'fill']] as const) {
    withHome((home) => {
      writeFileSync(join(home, 'mousse.conf'), JSON.stringify({ version: 1, settings: { profile: { username: 'river-otter' }, appearance: { threadProjectColors: choice } } }), 'utf-8')
      expect(projectColors(home)).toBe(read)
    })
  }
})
