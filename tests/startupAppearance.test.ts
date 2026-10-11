import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readStartupAppearance } from '../src/main/startupAppearance'
import { getDefaultSettings } from '../src/shared/settings'
import { readStartupAppearanceArgument, startupAppearanceArgument } from '../src/shared/startupAppearance'
import { appearanceSurfaceBase } from '../src/shared/themeSurfaces'

const temporaryRoot = realpathSync(tmpdir())
const homes: string[] = []
const profileId = 'd9d018ad-5de0-43be-9cb5-90253e174c2c'
const fallback = getDefaultSettings().appearance

function home(): string {
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, 'mousse-startup-appearance-')))
  homes.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of homes.splice(0)) {
    if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('mousse-startup-appearance-')) {
      throw new Error('Unexpected startup appearance fixture path')
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

it('reads saved appearance from the active default profile without rewriting either config', () => {
  const directory = home()
  const manifest = { defaultProfileId: profileId, profiles: [{ id: profileId, status: 'active' }] }
  writeFileSync(join(directory, 'installation.json'), JSON.stringify(manifest))
  const profileRoot = join(directory, 'profiles', profileId)
  mkdirSync(profileRoot, { recursive: true })
  const saved = { theme: 'dark-modern', accentColor: '#3b82f6', acrylic: false, acrylicIntensity: 73 }
  const config = JSON.stringify({ settings: { appearance: saved }, providers: { keep: 'unchanged' } })
  writeFileSync(join(profileRoot, 'mousse.conf'), config)
  const shared = JSON.stringify({ settings: { appearance: fallback } })
  writeFileSync(join(directory, 'mousse.conf'), shared)
  expect(readStartupAppearance(directory, fallback)).toEqual(saved)
  expect(readFileSync(join(profileRoot, 'mousse.conf'), 'utf8')).toBe(config)
  expect(readFileSync(join(directory, 'mousse.conf'), 'utf8')).toBe(shared)
})

it('uses legacy appearance when no profile manifest exists', () => {
  const appearance = { ...fallback, theme: 'one-dark' as const }
  expect(readStartupAppearance(home(), appearance)).toEqual(appearance)
})

it.each(['../outside', profileId])('falls back for an invalid or archived default profile (%s)', (id) => {
  const directory = home()
  writeFileSync(join(directory, 'installation.json'), JSON.stringify({ defaultProfileId: id, profiles: [{ id, status: 'archived' }] }))
  expect(readStartupAppearance(directory, fallback)).toEqual(fallback)
})

it('keeps a damaged manifest untouched and still opens with a fallback theme', () => {
  const directory = home()
  writeFileSync(join(directory, 'installation.json'), '{damaged')
  expect(readStartupAppearance(directory, fallback)).toEqual(fallback)
  expect(readFileSync(join(directory, 'installation.json'), 'utf8')).toBe('{damaged')
})

it('uses the same fixed surface as the renderer instead of tinting a fixed theme with its accent', () => {
  expect(appearanceSurfaceBase(fallback)).toBe('#000000')
  expect(appearanceSurfaceBase({ ...fallback, theme: 'dark-modern' })).toBe('#1f1f1f')
  expect(appearanceSurfaceBase({ ...fallback, theme: 'system' }, false))
    .toBe(appearanceSurfaceBase({ ...fallback, theme: 'light' }))
})

it('passes only appearance to preload and ignores absent or damaged launch arguments', () => {
  const saved = { ...fallback, theme: 'monokai' as const, acrylicIntensity: 80 }
  expect(readStartupAppearanceArgument(['--other', startupAppearanceArgument(saved)])).toEqual(saved)
  expect(readStartupAppearanceArgument([])).toBeNull()
  expect(readStartupAppearanceArgument(['--mousse-startup-appearance=%broken'])).toBeNull()
})
