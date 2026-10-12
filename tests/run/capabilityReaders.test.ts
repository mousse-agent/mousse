import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderCapabilities } from '../../src/mms/run/adapters/ProviderAdapter'

// SPEC §13.2: every capability flag has a reader outside the adapters. A flag nobody reads is a
// promise nothing keeps.
const repoRoot = resolve(__dirname, '..', '..')
const runRoot = join(repoRoot, 'src', 'mms', 'run')

/** Every key of `ProviderCapabilities`; `satisfies` keeps this list complete and exact. */
const CAPABILITY_KEYS = Object.keys({
  steer: true,
  interrupt: true,
  rollback: true,
  fork: true,
  nativeSubagents: true,
  events: true,
  containment: true,
  historyInjection: true,
  mcp: true
} satisfies Record<keyof ProviderCapabilities, true>) as Array<keyof ProviderCapabilities>

function readerSources(): Array<{ path: string; source: string }> {
  return readdirSync(runRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !path.startsWith('src/mms/run/adapters/'))
    .map((path) => ({ path, source: readFileSync(join(repoRoot, path), 'utf8') }))
}

describe('capability readers', () => {
  const sources = readerSources()

  it('scans the run engine sources outside the adapters', () => {
    expect(sources.some(({ path }) => path === 'src/mms/run/CommandPolicy.ts')).toBe(true)
    expect(sources.some(({ path }) => path.startsWith('src/mms/run/adapters/'))).toBe(false)
  })

  it('covers every key the pi adapter declares', () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual(Object.keys(PI_LOOP_CAPABILITIES).sort())
  })

  it.each(CAPABILITY_KEYS)('%s has a reader outside src/mms/run/adapters/', (key) => {
    const reader = new RegExp(`\\b(caps|capabilities)\\.${key}\\b`)
    const readers = sources.filter(({ source }) => reader.test(source)).map(({ path }) => path)
    expect(readers, `no reader of capabilities.${key}`).not.toEqual([])
  })
})
