import { describe, expect, it } from 'vitest'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderCapabilities } from '../../src/mms/run/adapters/ProviderAdapter'
import {
  canUndoNatively,
  forkStrategy,
  handoffDelivery,
  mcpAttachable,
  restoreMode
} from '../../src/mms/run/policy/featureGates'

const caps = (patch: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  ...PI_LOOP_CAPABILITIES,
  ...patch
})

describe('feature gates', () => {
  it('canUndoNatively reads rollback', () => {
    expect(canUndoNatively(caps({ rollback: 'native' }))).toBe(true)
    expect(canUndoNatively(caps({ rollback: 'none' }))).toBe(false)
  })

  it('forkStrategy reads fork', () => {
    expect(forkStrategy(caps({ fork: 'native' }))).toBe('native')
    expect(forkStrategy(caps({ fork: 'portable' }))).toBe('portable')
  })

  it('restoreMode reads containment', () => {
    expect(restoreMode(caps({ containment: 'strong' }))).toBe('auto')
    expect(restoreMode(caps({ containment: 'weak' }))).toBe('review_diff')
  })

  it('handoffDelivery reads historyInjection', () => {
    expect(handoffDelivery(caps({ historyInjection: 'native' }))).toBe('native_history')
    expect(handoffDelivery(caps({ historyInjection: 'prompt' }))).toBe('prompt_preamble')
  })

  it('mcpAttachable reads mcp', () => {
    expect(mcpAttachable(caps({ mcp: true }))).toBe(true)
    expect(mcpAttachable(caps({ mcp: false }))).toBe(false)
  })
})
