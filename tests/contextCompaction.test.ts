import { describe, expect, it } from 'vitest'
import { compactionThreshold, contextCompactionPoint } from '../src/shared/contextCompaction'
import { shouldCompactNativeContext } from '../src/mms/orchestrator/nativeContext'

const on = (compactionTokens: number | 'model-max') => ({ compactionEnabled: true, compactionTokens })

describe('context compaction point', () => {
  it('compacts at a size inside the window', () => {
    expect(contextCompactionPoint(on(300_000), 1_000_000)).toBe(300_000)
  })

  it('takes any whole number, not only the preset sizes', () => {
    expect(contextCompactionPoint(on(150_000), 1_000_000)).toBe(150_000)
  })

  it('caps a size at the window, less the room kept for the reply', () => {
    // 200K window: 95% is 190K, the reply reserve leaves 183,616.
    expect(contextCompactionPoint(on(300_000), 200_000)).toBe(183_616)
  })

  it('compacts a size before the window is known as the daemon does', () => {
    // `prepareNativeContext` uses the size as the window: less the room kept for the reply.
    expect(contextCompactionPoint(on(300_000))).toBe(283_616)
  })

  it('compacts Model maximum near a known window and not before one is known', () => {
    expect(contextCompactionPoint(on('model-max'), 1_000_000)).toBe(950_000)
    expect(contextCompactionPoint(on('model-max'), 128_000)).toBe(111_616)
    expect(contextCompactionPoint(on('model-max'))).toBeUndefined()
  })

  it('never compacts when compaction is off', () => {
    expect(contextCompactionPoint({ compactionEnabled: false, compactionTokens: 300_000 }, 1_000_000)).toBeUndefined()
  })

  it('is the threshold shouldCompactNativeContext checks against', () => {
    for (const [window, configured] of [[128_000, undefined], [100, undefined], [200_000, 300_000], [1_000_000, 300_000]] as const) {
      const threshold = compactionThreshold(window, configured)!
      expect(shouldCompactNativeContext(threshold - 1, window, undefined, configured)).toBe(false)
      expect(shouldCompactNativeContext(threshold, window, undefined, configured)).toBe(true)
    }
    expect(compactionThreshold(0)).toBeUndefined()
  })
})
