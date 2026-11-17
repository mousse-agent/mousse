import { describe, expect, it } from 'vitest'
import { filterLog, formatFiltered } from '../.agents/skills/nightly-build-release/filter-log.mjs'

const stamp = (text: string) => `Test (linux)\tRun tests\t2026-11-17T10:00:00.0000000Z ${text}`

describe('nightly failed-log filter', () => {
  it('keeps the whole Unhandled Errors section outside the line limit, and the test summaries', () => {
    const noise = Array.from({ length: 300 }, (_, i) => stamp(`Error: noisy failure ${i}`))
    const unhandled = [
      stamp('⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯'),
      stamp('Vitest caught 1 unhandled error during the test run.'),
      stamp('TypeError: window is destroyed'),
      stamp(' ❯ tests/renderer/x.test.ts:12:3'),
      stamp('⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯')
    ]
    const tail = [stamp(' Test Files  1 failed | 40 passed (41)'), stamp('      Tests  2 failed | 400 passed (402)'), stamp('   Errors  1 error')]
    const result = filterLog([...noise, ...unhandled, ...tail].join('\n'), { context: 1, maxLines: 20 })
    expect(result.matches).toHaveLength(20)
    expect(result.omitted).toBeGreaterThan(0)
    expect(result.unhandled).toHaveLength(unhandled.length)
    expect(result.unhandled.join('\n')).toContain('window is destroyed')
    expect(result.matches.join('\n')).not.toContain('window is destroyed')
    expect(result.summary.map((line: string) => line.replace(/^.*Z /, '').trim())).toEqual([
      'Test Files  1 failed | 40 passed (41)', 'Tests  2 failed | 400 passed (402)', 'Errors  1 error'
    ])
    const text = formatFiltered(result, { logPath: '/tmp/nightly-1.log' })
    expect(text).toContain('full log: /tmp/nightly-1.log')
    expect(text).toContain('Unhandled Errors (full section)')
    expect(text).toContain('more matching line(s) omitted')
  })

  it('reports nothing found rather than an empty answer', () => {
    const text = formatFiltered(filterLog('all quiet\nnothing here'))
    expect(text).toContain('(none found)')
  })
})
