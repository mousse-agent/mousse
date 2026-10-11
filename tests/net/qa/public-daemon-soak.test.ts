import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  evaluateGrowth,
  growthPolicy,
  MEMBER_NAMES,
  OBSERVER_INDEX
} from '../../../scripts/net/qa/observer-growth.mjs'

const harness = readFileSync('scripts/net/qa/public-daemon-soak.mjs', 'utf8')

describe('public daemon soak observer', () => {
  it('includes a fourth member in replica validation and sampling without adding it to fault rotation', () => {
    expect(MEMBER_NAMES).toEqual(['a', 'b', 'c', 'observer'])
    expect(OBSERVER_INDEX).toBe(3)
    expect(harness).toContain('index < homes.length')
    expect(harness).toContain('for (const index of [1, 2, observerIndex])')
    expect(harness).toContain('metrics(false, true)')
    expect(harness).toContain('clearInterval(observerTimer)')
    expect(harness).toContain('report.steps % 3')
    expect(harness).toContain('faultIndex++ % 4')
  })
})

const hour = 3600000
const samples = (change = {}) =>
  Array.from({ length: 24 * 60 + 1 }, (_, minute) => ({
    elapsedMs: minute * 60000,
    rssKiB: 100000,
    fd: 40,
    diskKiB: 2000,
    queue: 0,
    ...(minute >= 23 * 60 ? change : {})
  }))

describe('observer growth qualification', () => {
  const policy = growthPolicy(24 * hour)

  it('passes stable samples and ignores startup warm-up', () => {
    const rows = samples()
    rows[0].rssKiB = 900000
    expect(evaluateGrowth(rows, policy, 24 * hour).passed).toBe(true)
  })

  it.each([
    [{ rssKiB: 200000 }, 'RSS slope exceeded'],
    [{ rssKiB: 240000 }, 'rssKiB median growth exceeded'],
    [{ fd: 73 }, 'fd median growth exceeded'],
    [{ diskKiB: 68000 }, 'diskKiB median growth exceeded'],
    [{ queue: 9 }, 'queue median growth exceeded']
  ])('rejects sustained growth %j', (change, failure) => {
    expect(evaluateGrowth(samples(change), policy, 24 * hour).failures).toContain(failure)
  })

  it.each(['rssKiB', 'fd', 'diskKiB', 'queue'])(
    'rejects a single absolute %s ceiling breach',
    (key) => {
      const rows = samples()
      rows[600][key] = policy.limits[key] + 1
      expect(evaluateGrowth(rows, policy, 24 * hour).failures).toContain(key + ' ceiling exceeded')
    }
  )

  it('fails without enough samples or with overlapping windows', () => {
    expect(evaluateGrowth([], policy, 24 * hour).passed).toBe(false)
    expect(evaluateGrowth(samples(), policy, 2 * hour).passed).toBe(false)
  })

  it('uses fast smoke windows without extrapolating seconds into an hourly RSS claim', () => {
    const smokePolicy = growthPolicy(150000)
    const rows = Array.from({ length: 31 }, (_, index) => ({
      elapsedMs: index * 5000,
      rssKiB: 100000 + index * 100,
      fd: 40,
      diskKiB: 2000,
      queue: 0
    }))
    const result = evaluateGrowth(rows, smokePolicy, 150000)
    expect(result.passed).toBe(true)
    expect(result.rssSlopeEnforced).toBe(false)
  })
})
