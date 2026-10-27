import { describe, expect, it } from 'vitest'
import { PI_LEGACY_CAPS, PI_RPC_CAPS, piDriver } from '../../src/mms/harness/drivers/pi'
import { checkPolicy } from '../../src/mms/harness/policy'
import type { RunPolicy } from '../../src/shared/harness/types'

const policy = (budget: RunPolicy['budget']): RunPolicy => ({ mode: 'default', approvals: 'ask', budget })

describe('Pi budgets policy', () => {
  it('the legacy loop refuses count limits; both engines refuse token and cost limits', () => {
    expect(PI_LEGACY_CAPS.budgets).toBe('observed')
    expect(checkPolicy(PI_LEGACY_CAPS, policy({ maxTurns: 3 }))).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['budgets'] } })
    expect(checkPolicy(PI_LEGACY_CAPS, policy({ maxUsd: 1 }))).toMatchObject({ ok: false, error: { missing: ['budgets', 'spendLimits'] } })
    for (const caps of [PI_LEGACY_CAPS, PI_RPC_CAPS]) {
      expect(caps.spendLimits).toBe('unsupported')
      expect(checkPolicy(caps, policy({ maxWallMs: 60_000 }))).toEqual({ ok: true })
    }
    expect(checkPolicy(PI_RPC_CAPS, policy({ maxUsd: 1 }))).toMatchObject({ ok: false, error: { missing: ['spendLimits'] } })
  })

  it('the RPC engine holds turn and tool-call counts hard', () => {
    expect(PI_RPC_CAPS.budgets).toBe('hard')
    expect(checkPolicy(PI_RPC_CAPS, policy({ maxTurns: 3 }))).toEqual({ ok: true })
    expect(checkPolicy(PI_RPC_CAPS, policy({ maxToolCalls: 2 }))).toEqual({ ok: true })
  })

  it('declares the RPC caps only for an instance whose config asks for the RPC engine', () => {
    const unused = () => { throw new Error('unused') }
    const rpc = { runtime: unused, catalog: unused }
    const driver = piDriver({ client: unused, rpc })
    // A private home only for the RPC engine: legacy instances keep their home id (and bindings).
    const privateHome = driver.alwaysPrivateHome as (config: ReturnType<typeof driver.decodeConfig>) => boolean
    expect(privateHome(driver.decodeConfig({ engine: 'rpc' }))).toBe(true)
    expect(privateHome(driver.decodeConfig({}))).toBe(false)
    expect(driver.mcpTurnBinding).toBe('per_call')
    expect(driver.caps(driver.decodeConfig({ engine: 'rpc' }))).toBe(PI_RPC_CAPS)
    expect(driver.caps(driver.decodeConfig({}))).toBe(PI_LEGACY_CAPS)
    expect(driver.caps(driver.decodeConfig({ engine: 'nonsense' }))).toBe(PI_LEGACY_CAPS)
    // Without the profile's RPC options every instance stays on the legacy loop.
    const legacyOnly = piDriver({ client: unused })
    expect(legacyOnly.caps(legacyOnly.decodeConfig({ engine: 'rpc' }))).toBe(PI_LEGACY_CAPS)
  })
})
