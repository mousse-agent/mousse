/**
 * The places sweep removes what Grok's older single-request route left (`grok/legacyOneShots.ts`): a request folder
 * `<profile>/harness/<entry>/one-shot/<id>/` with that route's layout, once old enough. A fresh one, one that is not
 * clearly that route's, and anything a link or junction points at are left. The old route recorded no process, so age
 * is what tells a request ended.
 */
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GROK_LEFTOVER_AGE_MS, sweepLegacyGrokOneShots } from '../src/mms/harness/grok/legacyOneShots'
import { GROK_ONE_SHOT_CONFIG } from '../src/mms/harness/grok/oneShot'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

const NOW = Date.now()
const OLD = (NOW - GROK_LEFTOVER_AGE_MS - 60_000) / 1000
const FRESH = (NOW - 60_000) / 1000

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-grok-legacy-'))
  dirs.push(dir)
  return dir
}

/** A request folder as the old route wrote it (`writeGrokOneShotFiles`), aged `at` seconds since the epoch. */
function leftover(home: string, at: number, options: { entry?: string; id?: string; extra?: string; config?: string; link?: string } = {}): string {
  const folder = join(home, 'harness', options.entry ?? 'grok', 'one-shot', options.id ?? randomUUID())
  for (const name of ['home', 'user', 'cwd']) mkdirSync(join(folder, name), { recursive: true })
  writeFileSync(join(folder, 'home', 'config.toml'), options.config ?? GROK_ONE_SHOT_CONFIG)
  writeFileSync(join(folder, 'prompt.txt'), 'Name this chat')
  if (options.extra) writeFileSync(join(folder, options.extra), 'not the old route’s')
  if (options.link) symlinkSync(options.link, join(folder, 'cwd', 'outside'), 'junction')
  for (const name of ['home', 'user', 'cwd', 'prompt.txt', ...(options.extra ? [options.extra] : [])]) utimesSync(join(folder, name), at, at)
  utimesSync(folder, at, at)
  return folder
}

describe("the sweep of Grok's older single requests", () => {
  it('removes an old leftover of the old route, in any entry', () => {
    const home = profile()
    const builtIn = leftover(home, OLD)
    const added = leftover(home, OLD, { entry: 'grok_work' })
    sweepLegacyGrokOneShots(home, NOW)
    expect(existsSync(builtIn)).toBe(false)
    expect(existsSync(added)).toBe(false)
  })

  it('keeps a fresh one: its request may still run', () => {
    const home = profile()
    const fresh = leftover(home, FRESH)
    sweepLegacyGrokOneShots(home, NOW)
    expect(existsSync(fresh)).toBe(true)
  })

  it('never follows a junction inside a leftover: the link goes, its target stays', () => {
    const home = profile()
    const target = join(home, 'person-files')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'the person’s')
    const folder = leftover(home, OLD, { link: target })
    sweepLegacyGrokOneShots(home, NOW)
    expect(existsSync(folder)).toBe(false)
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('the person’s')
  })

  // Rows: a folder that is not clearly the old route's, however old: it is left.
  const kept: Array<[string, (home: string) => string]> = [
    ['a name that is not a request id', (home) => leftover(home, OLD, { id: 'notes' })],
    ['a file the old route never wrote', (home) => leftover(home, OLD, { extra: 'notes.txt' })],
    ['a config that is not the old route’s', (home) => leftover(home, OLD, { config: '[models]\ndefault = "grok-4.5"\n' })]
  ]
  for (const [name, make] of kept) {
    it(`leaves ${name}`, () => {
      const home = profile()
      const folder = make(home)
      sweepLegacyGrokOneShots(home, NOW)
      expect(existsSync(folder)).toBe(true)
    })
  }

  it('leaves a request folder that is itself a junction, and what it points at', () => {
    const home = profile()
    const elsewhere = leftover(profile(), OLD)
    const root = join(home, 'harness', 'grok', 'one-shot')
    mkdirSync(root, { recursive: true })
    const link = join(root, randomUUID())
    symlinkSync(elsewhere, link, 'junction')
    // As old as the folder it points at: only its being a link keeps it.
    lutimesSync(link, OLD, OLD)
    sweepLegacyGrokOneShots(home, NOW)
    expect(existsSync(join(elsewhere, 'prompt.txt'))).toBe(true)
    expect(existsSync(link)).toBe(true)
  })
})
