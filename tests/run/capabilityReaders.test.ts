import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLAUDE_CODE_CAPS } from '../../src/mms/harness/drivers/claudeCode'
import { PI_LEGACY_CAPS } from '../../src/mms/harness/drivers/pi'
import { HARNESS_CAP_KEYS, type HarnessCaps } from '../../src/shared/harness/types'

// SPEC §13.2: every capability key has a reader outside the drivers, and that reader is called
// somewhere. A key nobody reads, or a reader nobody calls, is a promise nothing keeps. Readers live
// in the run engine and the harness gateway; drivers (and the adapters they wrap) only declare.
const repoRoot = resolve(__dirname, '..', '..')
const readerRoots = [join(repoRoot, 'src', 'mms', 'run'), join(repoRoot, 'src', 'mms', 'harness')]
const srcRoot = join(repoRoot, 'src')
const DECLARATION_DIRS = ['src/mms/run/adapters/', 'src/mms/harness/drivers/']

/** Each key of `HarnessCaps` and the reader functions that read it; `satisfies` keeps it exact. */
const READERS = {
  steer: ['steerStrategy'],
  interrupt: ['stopStrategy'],
  rollback: ['canUndoNatively'],
  fork: ['forkStrategy'],
  events: ['heartbeatToleranceMs'],
  containment: ['restoreMode'],
  historyInjection: ['handoffDelivery'],
  mcp: ['mcpAttachable'],
  childPolicy: ['subagentTargetRefusal'],
  planMode: ['planModeAvailable'],
  contextUsage: ['contextGauge'],
  toolControl: ['toolControlLevel'],
  budgets: ['budgetsLevel'],
  spendLimits: ['spendLimitLevel']
} satisfies Record<keyof HarnessCaps, string[]>
const CAPABILITY_KEYS = Object.keys(READERS) as Array<keyof HarnessCaps>

function sources(root: string): Array<{ path: string; source: string }> {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !DECLARATION_DIRS.some((dir) => path.startsWith(dir)))
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
  const runSources = readerRoots.flatMap(sources)
  const allSources = sources(srcRoot)

  it('scans the run engine and gateway sources outside the drivers', () => {
    expect(runSources.some(({ path }) => path === 'src/mms/run/CommandPolicy.ts')).toBe(true)
    expect(runSources.some(({ path }) => path === 'src/mms/harness/policy.ts')).toBe(true)
    expect(allSources.some(({ path }) => DECLARATION_DIRS.some((dir) => path.startsWith(dir)))).toBe(false)
  })

  it('covers every key the default drivers declare', () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual([...HARNESS_CAP_KEYS].sort())
    expect([...CAPABILITY_KEYS].sort()).toEqual(Object.keys(CLAUDE_CODE_CAPS).sort())
    expect([...CAPABILITY_KEYS].sort()).toEqual(Object.keys(PI_LEGACY_CAPS).sort())
  })

  it.each(CAPABILITY_KEYS)('%s is read by its reader function outside the drivers', (key) => {
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
