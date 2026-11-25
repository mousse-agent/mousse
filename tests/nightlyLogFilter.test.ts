import { describe, expect, it } from 'vitest'
import { filterLog, formatFiltered } from '../moostack/skills/nightly-build-release/filter-log.mjs'

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
    expect(text).toContain('Unhandled Errors (full section 1 of 1)')
    expect(text).toContain('more matching line(s) omitted')
  })

  it('prints every Unhandled Errors section in full, however long, and stops a section at the next job', () => {
    const body = Array.from({ length: 500 }, (_, i) => stamp(`  at frame ${i}`))
    const text = [
      stamp('⎯⎯ Unhandled Errors ⎯⎯'), ...body, stamp(' Test Files  1 failed (1)'),
      'Other job\tOther step\t2026-11-17T10:01:00.0000000Z ⎯⎯ Unhandled Errors ⎯⎯',
      'Other job\tOther step\t2026-11-17T10:01:00.0000000Z TypeError: second',
      'Third job\tStep\t2026-11-17T10:02:00.0000000Z unrelated line'
    ].join('\n')
    const result = filterLog(text)
    expect(result.unhandledSections).toHaveLength(2)
    expect(result.unhandledSections[0]).toHaveLength(501)
    expect(result.unhandledSections[1]).toHaveLength(2)
    expect(result.unhandledSections[1].join('\n')).not.toContain('unrelated line')
    const printed = formatFiltered(result)
    expect(printed).toContain('full section 1 of 2')
    expect(printed).toContain('at frame 499')
    expect(printed).not.toContain('section continues')
  })

  it('reports nothing found rather than an empty answer', () => {
    const text = formatFiltered(filterLog('all quiet\nnothing here'))
    expect(text).toContain('(none found)')
  })
})
