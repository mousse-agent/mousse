import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderCapabilities } from '../../src/mms/run/adapters/ProviderAdapter'

// SPEC §13.2: every capability flag has a reader outside the adapters, and that reader is called
// somewhere. A flag nobody reads, or a reader nobody calls, is a promise nothing keeps.
const repoRoot = resolve(__dirname, '..', '..')
const runRoot = join(repoRoot, 'src', 'mms', 'run')
const srcRoot = join(repoRoot, 'src')

/** Each key of `ProviderCapabilities` and the reader functions that read it; `satisfies` keeps it exact. */
const READERS = {
  steer: ['steerStrategy'],
  interrupt: ['stopStrategy'],
  rollback: ['canUndoNatively'],
  fork: ['forkStrategy'],
  events: ['heartbeatToleranceMs'],
  containment: ['restoreMode'],
  historyInjection: ['handoffDelivery'],
  mcp: ['mcpAttachable'],
  childPolicy: ['subagentTargetRefusal']
} satisfies Record<keyof ProviderCapabilities, string[]>
const CAPABILITY_KEYS = Object.keys(READERS) as Array<keyof ProviderCapabilities>

function sources(root: string): Array<{ path: string; source: string }> {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !path.startsWith('src/mms/run/adapters/'))
    .map((path) => ({ path, source: readFileSync(join(repoRoot, path), 'utf8') }))
}

/** Code lines only: comment lines are not call sites. */
function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim()
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
  })
}

describe('capability readers', () => {
  const runSources = sources(runRoot)
  const allSources = sources(srcRoot)

  it('scans the run engine sources outside the adapters', () => {
    expect(runSources.some(({ path }) => path === 'src/mms/run/CommandPolicy.ts')).toBe(true)
    expect(allSources.some(({ path }) => path.startsWith('src/mms/run/adapters/'))).toBe(false)
  })

  it('covers every key the pi adapter declares', () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual(Object.keys(PI_LOOP_CAPABILITIES).sort())
  })

  it.each(CAPABILITY_KEYS)('%s is read by its reader function outside src/mms/run/adapters/', (key) => {
    for (const name of READERS[key]) {
      const definition = new RegExp(`export function ${name}\\(([^)]*)\\)[^{]*\\{([\\s\\S]*?)\\n\\}`)
      const defined = runSources.map(({ source }) => definition.exec(source)).find(Boolean)
      expect(defined, `no definition of ${name}`).toBeTruthy()
      expect(defined![2], `${name} does not read capabilities.${key}`).toMatch(new RegExp(`\\bcaps\\.${key}\\b`))
    }
  })

  it.each(CAPABILITY_KEYS)('%s has a call site of its reader', (key) => {
    for (const name of READERS[key]) {
      const call = new RegExp(`\\b${name}\\(`)
      const definition = new RegExp(`function ${name}\\(`)
      const callers = allSources
        .filter(({ source }) => codeLines(source).some((line) => call.test(line) && !definition.test(line)))
        .map(({ path }) => path)
      expect(callers, `nothing calls ${name}`).not.toEqual([])
    }
  })
})
